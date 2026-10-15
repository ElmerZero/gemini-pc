'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { run } = require('./process.cjs');

const UI_ROOT = path.join(__dirname, '..', 'ui');
const FILES = Object.freeze({
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8']
});
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

function httpError(message, status = 400) {
  const error = new Error(message); error.status = status; return error;
}

async function readJson(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] || '')) {
    throw httpError('La solicitud debe usar JSON.', 415);
  }
  if (Number(request.headers['content-length']) > 16384) throw httpError('La solicitud es demasiado grande.', 413);
  const parts = []; let length = 0;
  for await (const part of request) {
    length += part.length;
    if (length > 16384) throw httpError('La solicitud es demasiado grande.', 413);
    parts.push(part);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(parts).toString('utf8') || '{}'); }
  catch { throw httpError('No se pudo leer la solicitud.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw httpError('La solicitud debe ser un objeto.');
  return value;
}

async function chooseFolder({ signal } = {}) {
  let result;
  if (process.platform === 'win32') {
    // Fixed script: paths and other browser input are never interpolated into PowerShell.
    const script = "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); Add-Type -AssemblyName System.Windows.Forms; $picker = New-Object System.Windows.Forms.FolderBrowserDialog; $picker.Description = 'Elige la carpeta que quieres compartir con Gemini'; $picker.ShowNewFolderButton = $true; try { if ($picker.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Write($picker.SelectedPath) } } finally { $picker.Dispose() }";
    result = await run(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-STA', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { timeout: 120000, signal });
  } else if (process.platform === 'darwin') {
    result = await run('osascript', ['-e', 'try', '-e', 'POSIX path of (choose folder with prompt "Elige la carpeta para Gemini")', '-e', 'on error number -128', '-e', 'return ""', '-e', 'end try'], { timeout: 120000, signal });
  } else {
    try { result = await run('zenity', ['--file-selection', '--directory', '--title=Carpeta para Gemini'], { timeout: 120000, signal }); }
    catch (error) { if (error.code === 1 || error.name === 'AbortError') return { cancelled: true, path: '' }; throw new Error('Pega la ruta de tu carpeta en el campo. El selector necesita zenity en este equipo.'); }
  }
  return { path: result.stdout, cancelled: !result.stdout };
}

function openBrowser(url) {
  const command = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/rundll32.exe') : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: 'ignore', detached: true });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

function createGuiServer({ engine, uiRoot = UI_ROOT, folderPicker = chooseFolder, instanceId = 'mcp-gemini' } = {}) {
  if (!engine) throw new Error('Falta el motor de la aplicación.');
  const token = crypto.randomBytes(32).toString('hex');
  let folderBusy = false;
  let folderController;
  let folderPromise;
  let shuttingDown = false;
  let shutdown;
  let stoppingWork;
  const stopOwnedWork = () => {
    if (!stoppingWork) {
      shuttingDown = true;
      folderController?.abort();
      stoppingWork = Promise.allSettled([engine.dispose(), folderPromise]).then(results => {
        if (results[0].status === 'rejected') throw results[0].reason;
      }).catch(error => { stoppingWork = null; throw error; });
    }
    return stoppingWork;
  };
  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', CSP);
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    const json = (status, data) => {
      if (response.destroyed) return;
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(data));
    };
    try {
      const host = `127.0.0.1:${server.address().port}`;
      if (request.headers.host !== host) throw httpError('Abre el panel con su dirección local.', 403);
      const origin = `http://${host}`;
      if (request.headers.origin && request.headers.origin !== origin) throw httpError('Esta solicitud no pertenece al panel local.', 403);
      if (request.headers['sec-fetch-site'] === 'cross-site') throw httpError('Abre el panel directamente en este equipo.', 403);
      const route = new URL(request.url, origin).pathname;
      if (request.method === 'GET' && route === '/api/ping') return json(200, { app: 'mcp-gemini-panel', instanceId });
      if (route.startsWith('/api/')) {
        const provided = request.headers['x-mcp-token'];
        if (typeof provided !== 'string' || provided.length !== token.length || !crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(token))) {
          throw httpError('Vuelve a abrir el panel para continuar.', 403);
        }
        if (request.method === 'GET' && route === '/api/state') return json(200, { ok: true, state: engine.getState() });
        if (request.method !== 'POST') throw httpError('Método no permitido.', 405);
        const closeRequested = route === '/api/shutdown' || route === '/api/panic';
        if (shuttingDown && !closeRequested) throw httpError('La aplicación se está cerrando.', 409);
        const actions = {
          '/api/setup': data => engine.setup(data), '/api/start': () => engine.start(),
          '/api/stop': () => engine.stop(), '/api/doctor': () => engine.doctor(),
          '/api/cancel': () => engine.cancel(), '/api/cli/install': () => engine.installCli(),
          '/api/approvals/approve': data => engine.approve(data.id),
          '/api/approvals/reject': data => engine.reject(data.id)
        };
        if (route !== '/api/folder' && !closeRequested && !Object.hasOwn(actions, route)) throw httpError('No se encontró esta acción.', 404);
        const data = await readJson(request);
        if (shuttingDown && !closeRequested) throw httpError('La aplicación se está cerrando.', 409);
        if (closeRequested) {
          // Stop processes before acknowledging success, then close HTTP after the response is delivered.
          await stopOwnedWork();
          json(200, { ok: true });
          setImmediate(() => shutdown().catch(() => {}));
          return;
        }
        if (route === '/api/folder') {
          if (folderBusy) throw httpError('Ya hay una ventana para elegir carpeta abierta.', 409);
          folderBusy = true;
          folderController = new AbortController();
          folderPromise = Promise.resolve().then(() => folderPicker({ signal: folderController.signal }));
          try { return json(200, { ok: true, ...await folderPromise }); }
          finally { folderBusy = false; folderController = null; folderPromise = null; }
        }
        await actions[route](data);
        return json(200, { ok: true, state: engine.getState() });
      }
      if (!['GET', 'HEAD'].includes(request.method)) throw httpError('Método no permitido.', 405);
      const file = Object.hasOwn(FILES, route) && FILES[route];
      if (!file) throw httpError('No se encontró esta página.', 404);
      let contents = fs.readFileSync(path.join(uiRoot, file[0]), 'utf8');
      if (route === '/') contents = contents.replace('__APP_TOKEN__', token);
      response.writeHead(200, { 'Content-Type': file[1] });
      response.end(request.method === 'HEAD' ? undefined : contents);
    } catch (error) {
      // Engine errors are written for users and redacted by AppEngine; never serialize objects or request bodies.
      const { redact } = require('./process.cjs');
      json(error.status || (error.code === 'EBUSY' ? 409 : 400), { ok: false, error: redact(error.message || 'No se pudo completar la acción.') });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  let closePromise;
  const app = {
    server,
    async listen(port = 3210) {
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Puerto del panel inválido.');
      await new Promise((resolve, reject) => {
        const onError = error => { server.off('listening', onListen); reject(error); };
        const onListen = () => { server.off('error', onError); resolve(); };
        server.once('error', onError); server.once('listening', onListen); server.listen(port, '127.0.0.1');
      });
      return `http://127.0.0.1:${server.address().port}`;
    },
    async close() {
      if (!closePromise) closePromise = (async () => {
        await stopOwnedWork();
        server.closeIdleConnections();
        await new Promise((resolve, reject) => server.close(error => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve()));
      })().catch(error => { closePromise = null; throw error; });
      return closePromise;
    }
  };
  shutdown = () => app.close();
  return app;
}

module.exports = { createGuiServer, chooseFolder, openBrowser };

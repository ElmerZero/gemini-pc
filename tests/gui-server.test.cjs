'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createGuiServer } = require('../lib/gui-server.cjs');

function fakeEngine() {
  const calls = [];
  const state = { configured: false, running: false, lastAction: null };
  const engine = { calls, getState: () => ({ ...state }) };
  for (const action of ['setup', 'start', 'stop', 'doctor', 'cancel', 'installCli', 'approve', 'reject', 'dispose']) {
    engine[action] = async (...args) => {
      calls.push({ action, args });
      state.lastAction = action;
      if (action === 'setup') state.configured = true;
      if (action === 'start') state.running = true;
      if (action === 'stop') state.running = false;
    };
  }
  return engine;
}

function request(url, route, { method = 'GET', headers = {}, body, chunks } = {}) {
  return new Promise((resolve, reject) => {
    const endpoint = new URL(url);
    const outgoing = http.request({ hostname: endpoint.hostname, port: endpoint.port, path: route, method, headers, agent: false }, response => {
      const parts = [];
      response.on('data', part => parts.push(part));
      response.once('error', reject);
      response.once('end', () => {
        const text = Buffer.concat(parts).toString('utf8');
        resolve({ status: response.statusCode, headers: response.headers, text, json: () => JSON.parse(text) });
      });
    });
    outgoing.setTimeout(5000, () => outgoing.destroy(new Error('La solicitud de prueba agotó su tiempo.')));
    outgoing.once('error', reject);
    if (chunks) for (const chunk of chunks) outgoing.write(chunk);
    outgoing.end(body);
  });
}

async function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-gui-test-'));
  const uiRoot = path.join(root, 'ui');
  fs.mkdirSync(uiRoot);
  fs.writeFileSync(path.join(uiRoot, 'index.html'), '<!doctype html><meta name="test-token" content="__APP_TOKEN__"><main>Panel de prueba</main>');
  fs.writeFileSync(path.join(uiRoot, 'app.js'), 'globalThis.testPanel = true;');
  fs.writeFileSync(path.join(uiRoot, 'styles.css'), 'body { color: black; }');
  fs.writeFileSync(path.join(uiRoot, '.env'), 'password=UI-SECRET');
  fs.writeFileSync(path.join(root, '.env'), 'password=PARENT-SECRET');
  const engine = options.engine || fakeEngine();
  const gui = createGuiServer({ engine, uiRoot, folderPicker: async () => ({ cancelled: true, path: '' }), ...options });
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await gui.close(); } };
  t.after(async () => {
    try { await close(); }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  const url = await gui.listen(0);
  const index = await request(url, '/');
  assert.equal(index.status, 200);
  const token = /name="test-token" content="([a-f0-9]{64})"/.exec(index.text)?.[1];
  assert.ok(token, 'el HTML inicial incluye el token del panel');
  const auth = { 'x-mcp-token': token };
  const post = (route, data = {}, extra = {}) => request(url, route, {
    method: 'POST', body: JSON.stringify(data), ...extra,
    headers: { ...auth, 'Content-Type': 'application/json', ...extra.headers }
  });
  return { gui, engine, url, token, auth, index, close, post };
}

test('el panel escucha solo en loopback y protege el estado con un token por instancia', async t => {
  const first = await fixture(t);
  const second = await fixture(t);
  assert.equal(first.gui.server.address().address, '127.0.0.1');
  assert.notEqual(first.token, second.token);
  assert.equal(first.index.headers['cache-control'], 'no-store');
  assert.equal(first.index.headers['x-content-type-options'], 'nosniff');
  assert.match(first.index.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.match(first.index.headers['content-security-policy'], /default-src 'none'/);

  for (const headers of [{}, { 'x-mcp-token': 'wrong' }, { 'x-mcp-token': '0'.repeat(64) }, { 'x-mcp-token': second.token }]) {
    const denied = await request(first.url, '/api/state', { headers });
    assert.equal(denied.status, 403);
    assert.equal(denied.json().ok, false);
    assert.doesNotMatch(denied.text, new RegExp(first.token));
  }
  const state = await request(first.url, '/api/state', { headers: first.auth });
  assert.equal(state.status, 200);
  assert.deepEqual(state.json(), { ok: true, state: first.engine.getState() });
  const ping = await request(first.url, '/api/ping');
  assert.equal(ping.status, 200);
  assert.deepEqual(ping.json(), { app: 'mcp-gemini-panel', instanceId: 'mcp-gemini' });
  assert.equal(first.engine.calls.length, 0);
});

test('Host, Origin y solicitudes cross-site no pueden evitar la protección local', async t => {
  const panel = await fixture(t);
  const port = new URL(panel.url).port;
  const deniedHeaders = [
    { Host: `localhost:${port}` },
    { Host: 'attacker.example' },
    { Host: '127.0.0.1:1' },
    { Origin: 'https://attacker.example' },
    { Origin: 'null' },
    { Origin: `http://localhost:${port}` },
    { Origin: `https://127.0.0.1:${port}` },
    { 'Sec-Fetch-Site': 'cross-site' }
  ];
  for (const headers of deniedHeaders) {
    const response = await panel.post('/api/start', {}, { headers });
    assert.equal(response.status, 403, JSON.stringify(headers));
    assert.equal(response.json().ok, false);
  }
  const page = await request(panel.url, '/', { headers: { Host: 'attacker.example' } });
  assert.equal(page.status, 403);
  assert.ok(!page.text.includes(panel.token));
  const accepted = await panel.post('/api/start', {}, { headers: { Origin: panel.url, 'Sec-Fetch-Site': 'same-origin' } });
  assert.equal(accepted.status, 200);
  assert.deepEqual(panel.engine.calls, [{ action: 'start', args: [] }]);
});

test('rechaza cuerpos inválidos, demasiado grandes, tipos de contenido y métodos antes de ejecutar acciones', async t => {
  const panel = await fixture(t);
  const cases = [
    { body: '{"password":"DO-NOT-ECHO",', status: 400 },
    { body: 'null', status: 400 },
    { body: '[]', status: 400 },
    { body: '"texto"', status: 400 },
    { body: '{}', headers: { 'Content-Type': 'text/plain' }, status: 415 },
    { body: '{}', headers: { 'Content-Type': '' }, status: 415 },
    { body: JSON.stringify({ value: 'x'.repeat(16384) }), status: 413 },
    { chunks: ['{"value":"', 'x'.repeat(16384), '"}'], status: 413 }
  ];
  for (const item of cases) {
    const headers = { ...panel.auth, 'Content-Type': 'application/json', ...item.headers };
    if (item.body !== undefined) headers['Content-Length'] = Buffer.byteLength(item.body);
    const response = await request(panel.url, '/api/setup', { method: 'POST', headers, body: item.body, chunks: item.chunks });
    assert.equal(response.status, item.status);
    assert.equal(response.json().ok, false);
    assert.ok(!response.text.includes('DO-NOT-ECHO'));
  }
  for (const [method, route] of [['GET', '/api/start'], ['DELETE', '/api/state'], ['PUT', '/api/setup'], ['POST', '/styles.css']]) {
    const response = await request(panel.url, route, { method, headers: panel.auth });
    assert.equal(response.status, 405, `${method} ${route}`);
  }
  assert.equal((await panel.post('/api/missing')).status, 404);
  assert.equal(panel.engine.calls.length, 0);
});

test('solo sirve los archivos públicos permitidos y nunca expone .env o rutas arbitrarias', async t => {
  const panel = await fixture(t);
  for (const route of ['/.env', '/../.env', '/%2e%2e/.env', '/..%2f.env', '/%2eenv', '/ui/.env', '/lib/gui-server.cjs', '/app.js/../.env']) {
    const response = await request(panel.url, route);
    assert.equal(response.status, 404, route);
    assert.doesNotMatch(response.text, /UI-SECRET|PARENT-SECRET/);
  }
  const script = await request(panel.url, '/app.js');
  assert.equal(script.status, 200);
  assert.match(script.headers['content-type'], /^text\/javascript/);
  assert.equal(script.text, 'globalThis.testPanel = true;');
  const stylesheet = await request(panel.url, '/styles.css');
  assert.equal(stylesheet.status, 200);
  assert.match(stylesheet.headers['content-type'], /^text\/css/);
  const head = await request(panel.url, '/', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.text, '');
});

test('las acciones llaman al motor y devuelven su nuevo estado sin reflejar secretos de la solicitud', async t => {
  const panel = await fixture(t);
  const setupData = { folder: 'C:\\Carpeta de prueba', authtoken: 'PRIVATE-AUTHTOKEN', password: 'PRIVATE-PASSWORD' };
  const setup = await panel.post('/api/setup', setupData);
  assert.equal(setup.status, 200);
  assert.equal(setup.json().state.configured, true);
  assert.doesNotMatch(setup.text, /PRIVATE-AUTHTOKEN|PRIVATE-PASSWORD/);
  assert.deepEqual(panel.engine.calls[0], { action: 'setup', args: [setupData] });
  for (const [route, action, data, args] of [
    ['/api/start', 'start', {}, []],
    ['/api/stop', 'stop', {}, []],
    ['/api/doctor', 'doctor', {}, []],
    ['/api/cancel', 'cancel', {}, []],
    ['/api/cli/install', 'installCli', {}, []],
    ['/api/approvals/approve', 'approve', { id: 'request-1' }, ['request-1']],
    ['/api/approvals/reject', 'reject', { id: 'request-2' }, ['request-2']]
  ]) {
    const response = await panel.post(route, data);
    assert.equal(response.status, 200, route);
    assert.deepEqual(response.json(), { ok: true, state: panel.engine.getState() });
    assert.deepEqual(panel.engine.calls.at(-1), { action, args });
    if (action === 'start') assert.equal(response.json().state.running, true);
    if (action === 'stop') assert.equal(response.json().state.running, false);
  }
});

test('los errores del motor se redactan y el conflicto de operación tiene estado 409', async t => {
  const engine = fakeEngine();
  engine.setup = async data => {
    const error = new Error(`Fallo: authtoken=${data.authtoken} password="${data.password}"`);
    error.details = data;
    throw error;
  };
  engine.start = async () => { const error = new Error('Hay otra operación en curso.'); error.code = 'EBUSY'; throw error; };
  const panel = await fixture(t, { engine });
  const response = await panel.post('/api/setup', { authtoken: 'HIDDEN-TOKEN', password: 'HIDDEN PASSWORD', privateField: 'HIDDEN-EXTRA' });
  assert.equal(response.status, 400);
  assert.deepEqual(Object.keys(response.json()).sort(), ['error', 'ok']);
  assert.doesNotMatch(response.text, /HIDDEN-TOKEN|HIDDEN PASSWORD|HIDDEN-EXTRA/);
  assert.match(response.json().error, /\[oculto\]/);
  assert.equal((await panel.post('/api/start')).status, 409);
});

test('el selector permite cancelar, evita ventanas simultáneas y vuelve a estar disponible', async t => {
  let releasePicker;
  let pickerEntered;
  const entered = new Promise(resolve => { pickerEntered = resolve; });
  let attempts = 0;
  const panel = await fixture(t, { folderPicker: async () => {
    attempts++;
    if (attempts === 1) {
      pickerEntered();
      return new Promise(resolve => { releasePicker = resolve; });
    }
    if (attempts === 2) throw new Error('No se pudo abrir el selector.');
    return { cancelled: false, path: 'C:\\Mis archivos' };
  } });
  const first = panel.post('/api/folder');
  await entered;
  try {
    const busy = await panel.post('/api/folder');
    assert.equal(busy.status, 409);
    assert.equal(attempts, 1);
  } finally { releasePicker({ cancelled: true, path: '' }); }
  const cancelled = await first;
  assert.equal(cancelled.status, 200);
  assert.deepEqual(cancelled.json(), { ok: true, cancelled: true, path: '' });
  assert.equal((await panel.post('/api/folder')).status, 400);
  const chosen = await panel.post('/api/folder');
  assert.deepEqual(chosen.json(), { ok: true, cancelled: false, path: 'C:\\Mis archivos' });
  assert.equal(panel.engine.calls.length, 0);
});

test('cerrar el panel espera a dispose y cierra el servidor HTTP', async t => {
  const engine = fakeEngine();
  let releaseDispose;
  let disposeCalls = 0;
  const panel = await fixture(t, { engine });
  engine.dispose = () => { disposeCalls++; return new Promise(resolve => { releaseDispose = resolve; }); };
  let finished = false;
  const closing = panel.close().then(() => { finished = true; });
  assert.equal(disposeCalls, 1);
  await Promise.resolve();
  assert.equal(finished, false);
  releaseDispose();
  await closing;
  assert.equal(panel.gui.server.listening, false);
  await assert.rejects(request(panel.url, '/api/ping'), { code: 'ECONNREFUSED' });
});

test('el botón Cerrar aplicación bloquea nuevas acciones mientras detiene el motor', async t => {
  const engine = fakeEngine();
  const panel = await fixture(t, { engine });
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  let disposed = false;
  engine.dispose = async () => {
    if (disposed) return;
    entered();
    await new Promise(resolve => { release = resolve; });
    disposed = true;
  };
  const closing = panel.post('/api/shutdown');
  await waiting;
  try {
    assert.equal((await panel.post('/api/start')).status, 409);
    assert.equal(engine.calls.some(call => call.action === 'start'), false);
  } finally { release(); }
  assert.equal((await closing).json().ok, true);
  await panel.close();
  assert.equal(panel.gui.server.listening, false);
});

test('el cierre externo bloquea selectores nuevos y un POST recibido parcialmente antes del cierre', async t => {
  let picked = 0, releaseDispose;
  const engine = fakeEngine();
  const panel = await fixture(t, { engine, folderPicker: async () => { picked++; return { cancelled: true }; } });
  engine.dispose = () => new Promise(resolve => { releaseDispose = resolve; });
  const seen = new Promise(resolve => panel.gui.server.once('request', resolve));
  let outgoing;
  const delayed = new Promise((resolve, reject) => {
    outgoing = http.request(`${panel.url}/api/folder`, { method: 'POST', agent: false,
      headers: { ...panel.auth, 'Content-Type': 'application/json', 'Content-Length': 2 } }, response => {
      response.resume(); response.once('end', () => resolve(response.statusCode));
    });
    outgoing.once('error', reject); outgoing.write('{');
  });
  await seen;
  const closing = panel.close();
  try {
    outgoing.end('}');
    assert.equal(await delayed, 409);
    assert.equal((await panel.post('/api/folder')).status, 409);
    assert.equal(picked, 0);
  } finally { releaseDispose(); await closing; }
});

test('el pánico verifica seguridad, aborta selector y comparte el cierre de solicitudes concurrentes', async t => {
  let pickerEntered, pickerAborted = false, releaseDispose, disposed = 0;
  const entered = new Promise(resolve => { pickerEntered = resolve; });
  const engine = fakeEngine();
  const panel = await fixture(t, { engine, folderPicker: ({ signal }) => new Promise(resolve => {
    pickerEntered();
    signal.addEventListener('abort', () => { pickerAborted = true; resolve({ cancelled: true, path: '' }); }, { once: true });
  }) });
  engine.dispose = async () => { disposed++; await new Promise(resolve => { releaseDispose = resolve; }); };
  assert.equal((await request(panel.url, '/api/panic', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await panel.post('/api/panic', {}, { headers: { Origin: 'https://untrusted.example' } })).status, 403);
  assert.equal(disposed, 0);
  const choosing = panel.post('/api/folder');
  await entered;
  let acknowledged = false;
  const first = panel.post('/api/panic').then(value => { acknowledged = true; return value; });
  while (!releaseDispose) await new Promise(resolve => setImmediate(resolve));
  const second = panel.post('/api/panic');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(pickerAborted, true);
  assert.equal(acknowledged, false);
  assert.equal(disposed, 1);
  assert.equal((await panel.post('/api/start')).status, 409);
  releaseDispose();
  const results = await Promise.all([first, second, choosing]);
  assert.ok(results.every(result => result.status === 200));
  await panel.close();
  assert.equal(disposed, 1);
  assert.equal(panel.gui.server.listening, false);
});

test('un pánico fallido deja el panel disponible para reintentar y no confirma el cierre', async t => {
  let attempts = 0;
  const engine = fakeEngine();
  const panel = await fixture(t, { engine });
  engine.dispose = async () => { if (++attempts === 1) throw new Error('El proceso sigue activo.'); };
  const failed = await panel.post('/api/panic');
  assert.equal(failed.status, 400);
  assert.equal(failed.json().ok, false);
  assert.equal(panel.gui.server.listening, true);
  assert.equal((await panel.post('/api/start')).status, 409);
  const retried = await panel.post('/api/panic');
  assert.equal(retried.json().ok, true);
  await panel.close();
  assert.equal(attempts, 2);
  assert.equal(panel.gui.server.listening, false);
});

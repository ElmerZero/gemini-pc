#!/usr/bin/env node
'use strict';
// Comprueba un cliente MCP simulado con callback de Google. No inicia sesión en Google.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { ROOT, SERVER, buildConfig } = require('../gemini-pc.cjs');
const { applyServerPatches } = require('../lib/server-patches.cjs');

async function main() {
  const { configureOAuthAdmin } = require(path.join(SERVER, 'lib/oauth-provider.js'));
  const temporary = fs.mkdtempSync(path.join(ROOT, '.test-oauth-'));
  const staged = path.join(temporary, 'server');
  fs.mkdirSync(staged);
  for (const name of ['mcp-server.js', 'package.json']) fs.copyFileSync(path.join(SERVER, name), path.join(staged, name));
  fs.cpSync(path.join(SERVER, 'lib'), path.join(staged, 'lib'), { recursive: true });
  applyServerPatches(staged);
  const workspace = path.join(temporary, 'proyectos');
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'hola.txt'), 'MCP para Gemini\n');
  fs.writeFileSync(path.join(temporary, 'privado.txt'), 'NO COMPARTIR');
  const privateDir = path.join(temporary, 'private');
  const store = path.join(privateDir, 'oauth.json');
  const password = crypto.randomBytes(24).toString('base64url');
  configureOAuthAdmin(store, 'prueba', password);
  const port = await new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => { const p = socket.address().port; socket.close(() => resolve(p)); });
  });
  const base = `http://127.0.0.1:${port}`;
  const config = buildConfig({ workspace, mode: 'local', port });
  const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(?:MCP_|NGROK_|GIT_|ALLOWED_PATHS$|WORKING_DIR$|PUBLIC_BASE_URL$|ACTIVITY_LOG$|NODE_OPTIONS$|NODE_PATH$)/i.test(key)));
  const child = spawn(process.execPath, [path.join(staged, 'mcp-server.js'), '--http'], {
    cwd: staged, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...baseEnv, ...config, NODE_PATH: path.join(SERVER, 'node_modules'), MCP_CONFIG_SOURCE: 'env', MCP_AUTH_MODE: 'oauth',
      MCP_AUTH_TOKEN: '', MCP_AUTH_TOKEN_FILE: path.join(privateDir, 'absent-token.txt'),
      MCP_PUBLIC_BASE_URL: base, PUBLIC_BASE_URL: base, MCP_OAUTH_ALLOW_HTTP_LOCALHOST: '1',
      MCP_OAUTH_STORE: store, MCP_CLIENT_POLICIES_STORE: path.join(privateDir, 'clients.json'),
      MCP_MFA_STORE: path.join(privateDir, 'mfa.json'), MCP_PAUSE_FILE: path.join(privateDir, 'paused'),
      MCP_RUNTIME_DIR: path.join(temporary, 'runtime'), MCP_DISABLE_IPC: '1', MCP_REQUIRE_IPC: '0',
      MCP_HUMAN_LOG: path.join(temporary, 'events.log'), ACTIVITY_LOG: path.join(temporary, 'activity.ndjson'),
      MCP_ERROR_LOG: path.join(temporary, 'errors.log'), MCP_APPROVALS_STORE: path.join(privateDir, 'approvals.json')
    }
  });
  child.stdout.resume();
  let diagnostics = '';
  child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-5000); });
  const request = (route, options = {}) => fetch(base + route, { ...options, signal: AbortSignal.timeout(8000) });
  const post = (route, payload, token = '') => request(route, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(payload)
  });
  const rpc = async (method, params, token = '') => {
    const response = await post('/mcp', { jsonrpc: '2.0', id: crypto.randomUUID(), method, params }, token);
    return { status: response.status, body: await response.json() };
  };
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error('El motor no inició: ' + diagnostics);
      try { if ((await request('/health')).ok) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, 'el servidor debe iniciar');
    const unauthed = await rpc('initialize', { clientInfo: { name: 'gemini-prueba', version: '1' } });
    assert.equal(unauthed.status, 401, 'Gemini debe recibir el desafío OAuth');
    assert.equal((await request('/.well-known/oauth-protected-resource/mcp')).status, 200);

    const callback = 'https://oauth-redirect.googleusercontent.com/r/test-mcp-gemini';
    const registered = await post('/oauth/register', {
      client_name: 'Gemini simulado', redirect_uris: [callback], application_type: 'web',
      token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code']
    });
    assert.equal(registered.status, 201);
    const { client_id } = await registered.json();
    const verifier = crypto.randomBytes(48).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const params = new URLSearchParams({
      response_type: 'code', client_id, redirect_uri: callback, scope: 'mcp:tools', state: 'prueba-gemini',
      code_challenge: challenge, code_challenge_method: 'S256', resource: base + '/mcp'
    });
    const consent = await request('/oauth/authorize?' + params, { headers: { referer: 'https://gemini.google.com/' } });
    assert.equal(consent.status, 200);
    const csp = consent.headers.get('content-security-policy') || '';
    assert.match(csp, /frame-ancestors[^;]*https:\/\/gemini\.google\.com/);
    assert.match(csp, /form-action[^;]*https:\/\/\*\.googleusercontent\.com/);
    assert.match(csp, /form-action[^;]*https:\/\/\*\.google\.com/);
    assert.equal(consent.headers.get('x-frame-options'), null);
    const html = await consent.text();
    const transaction = html.match(/name="transaction" value="([^"]+)"/)?.[1];
    assert.ok(transaction);
    const allowed = await request('/oauth/authorize', {
      method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base },
      body: new URLSearchParams({ transaction, username: 'prueba', password, decision: 'allow' })
    });
    assert.equal(allowed.status, 302);
    const redirect = new URL(allowed.headers.get('location'));
    assert.equal(redirect.origin, new URL(callback).origin);
    assert.equal(redirect.searchParams.get('state'), 'prueba-gemini');
    const tokenResponse = await request('/oauth/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id, code: redirect.searchParams.get('code'),
        redirect_uri: callback, code_verifier: verifier, resource: base + '/mcp' })
    });
    assert.equal(tokenResponse.status, 200);
    const { access_token } = await tokenResponse.json();
    assert.ok(access_token);
    const initialized = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'gemini-prueba', version: '1' } }, access_token);
    assert.ok(initialized.body.result?.serverInfo);
    const tools = (await rpc('tools/list', {}, access_token)).body.result.tools;
    assert.ok(tools.some(tool => tool.name === 'read_file'));
    assert.ok(!tools.some(tool => tool.name === 'run_command'));
    const read = await rpc('tools/call', { name: 'read_file', arguments: { path: path.join(workspace, 'hola.txt') } }, access_token);
    assert.match(JSON.stringify(read.body.result), /MCP para Gemini/);
    const destination = path.join(workspace, 'creado.txt');
    const write = await rpc('tools/call', { name: 'write_file', arguments: { path: destination, content: 'Creado mediante MCP\n' } }, access_token);
    assert.ok(!write.body.error && !write.body.result?.isError, 'la escritura autorizada debe funcionar: ' + JSON.stringify(write.body));
    assert.equal(fs.readFileSync(destination, 'utf8'), 'Creado mediante MCP\n');
    const escape = await rpc('tools/call', { name: 'read_file', arguments: { path: path.join(temporary, 'privado.txt') } }, access_token);
    assert.doesNotMatch(JSON.stringify(escape.body), /NO COMPARTIR/);
    assert.ok(escape.body.error || escape.body.result?.isError, 'la lectura fuera de la carpeta debe rechazarse');
    console.log('OK: OAuth DCR + PKCE, callback de Google, descubrimiento MCP, lectura, escritura y rechazo de rutas externas.');
    console.log('Esta prueba usa un cliente simulado; falta autorizar la conexión real desde la cuenta de Gemini.');
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 3000))]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });

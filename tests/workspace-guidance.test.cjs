'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { spawn, spawnSync } = require('node:child_process');
const { SERVER, buildConfig } = require('../gemini-pc.cjs');
const { applyServerPatches } = require('../lib/server-patches.cjs');

const installed = fs.existsSync(path.join(SERVER, 'mcp-server.js'))
  && fs.existsSync(path.join(SERVER, 'node_modules/@simplewebauthn/server/package.json'));

function client(server, env) {
  const child = spawn(process.execPath, [path.join(server, 'mcp-server.js'), '--stdio'], {
    cwd: server, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
  });
  let sequence = 0, diagnostics = '', failure;
  const pending = new Map();
  const fail = error => {
    failure = error;
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
    pending.clear();
  };
  child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-6000); });
  child.once('error', fail);
  child.once('close', code => fail(new Error(`El servidor de prueba terminó (${code}). ${diagnostics}`)));
  child.stdin.on('error', fail);
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', line => {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); }
    catch { fail(new Error(`El transporte stdio devolvió una línea que no es JSON: ${line.slice(0, 200)}`)); return; }
    const item = pending.get(message.id);
    if (item) { pending.delete(message.id); clearTimeout(item.timer); item.resolve(message); }
  });
  return {
    rpc(method, params = {}) {
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Sin respuesta a ${method}. ${diagnostics}`));
        }, 15000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    },
    async close() {
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise(resolve => {
          const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
          child.once('close', () => { clearTimeout(timer); resolve(); });
          child.kill('SIGTERM');
        });
      }
      lines.close();
    }
  };
}

function normalResult(response) {
  assert.equal(response.error, undefined, JSON.stringify(response));
  assert.ok(response.result && !response.result.isError, JSON.stringify(response));
  return response.result;
}
function responseText(response) {
  return [response.error?.message, ...(response.result?.content || []).map(item => item.text || '')].filter(Boolean).join('\n');
}

test('el MCP explica la carpeta compartida y distingue una carpeta normal de un repositorio Git', {
  skip: installed ? false : 'El servidor MCP y sus dependencias no están instalados.', timeout: 60000
}, async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-workspace-guidance-'));
  const staged = path.join(temporary, 'server');
  const workspace = path.join(temporary, 'compartido');
  const privateDir = path.join(temporary, 'private');
  const clients = [];
  t.after(async () => {
    try { for (const connection of clients) await connection.close(); }
    finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  });
  fs.mkdirSync(staged);
  fs.mkdirSync(workspace);
  fs.mkdirSync(privateDir);
  // Copy only application source. loadDotEnv() must never inspect the user's real .env.
  for (const name of ['mcp-server.js', 'package.json']) fs.copyFileSync(path.join(SERVER, name), path.join(staged, name));
  fs.cpSync(path.join(SERVER, 'lib'), path.join(staged, 'lib'), { recursive: true });
  applyServerPatches(staged);
  fs.writeFileSync(path.join(workspace, 'hola.txt'), 'Contenido compartido de prueba.');
  fs.writeFileSync(path.join(temporary, 'privado.txt'), 'PRIVATE-OUTSIDE-WORKSPACE');

  const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(?:MCP_|NGROK_|GIT_|ALLOWED_PATHS$|WORKING_DIR$|PUBLIC_BASE_URL$|ACTIVITY_LOG$|NODE_OPTIONS$|NODE_PATH$)/i.test(key)));
  const env = {
    ...baseEnv, ...buildConfig({ workspace, mode: 'local', profile: 'lectura' }),
    NODE_PATH: path.join(SERVER, 'node_modules'), MCP_CONFIG_SOURCE: 'env',
    MCP_AUTH_TOKEN: '', MCP_AUTH_TOKEN_FILE: path.join(privateDir, 'absent-token.txt'),
    MCP_OAUTH_STORE: path.join(privateDir, 'oauth.json'), MCP_MFA_STORE: path.join(privateDir, 'mfa.json'),
    MCP_CLIENT_POLICIES_STORE: path.join(privateDir, 'clients.json'),
    MCP_APPROVALS_STORE: path.join(privateDir, 'approvals.json'),
    MCP_RUNTIME_DIR: path.join(temporary, 'runtime'), MCP_PAUSE_FILE: path.join(privateDir, 'paused'),
    MCP_HUMAN_LOG: path.join(temporary, 'events.log'), MCP_ERROR_LOG: path.join(temporary, 'errors.log'),
    ACTIVITY_LOG: path.join(temporary, 'activity.ndjson'), MCP_DISABLE_IPC: '1', MCP_REQUIRE_IPC: '0',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(privateDir, 'absent-gitconfig'),
    GIT_CEILING_DIRECTORIES: temporary, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C'
  };
  const connection = client(staged, env);
  clients.push(connection);
  const call = (name, args) => connection.rpc('tools/call', { name, arguments: args });

  await t.test('initialize enseña la raíz y evita inventar un repositorio o inicializar Git', async () => {
    const result = normalResult(await connection.rpc('initialize', {
      protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'gemini-regression-test', version: '1' }
    }));
    assert.equal(typeof result.instructions, 'string');
    assert.match(result.instructions, /list_files/i);
    assert.match(result.instructions, /path["']?\s*[:=]\s*["']\.["']/);
    assert.match(result.instructions, /(?:ra[ií]z|carpeta compartida)/i);
    assert.match(result.instructions, /\.\./);
    assert.match(result.instructions, /(?:nunca|no (?:uses|utilices))/i);
    assert.match(result.instructions, /no (?:asumas|supongas)[\s\S]{0,120}(?:git|repositorio)/i);
    assert.match(result.instructions, /git init/i);
    assert.match(result.instructions, /(?:petici[oó]n|solicitud|pida|autoriza|permiso|expresa)/i);
  });

  await t.test('list_files con punto lista la carpeta compartida', async () => {
    const result = normalResult(await call('list_files', { path: '.' }));
    assert.match(JSON.stringify(result.structuredContent), /hola\.txt/);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE-OUTSIDE-WORKSPACE/);
  });

  await t.test('list_files con dos puntos conserva el límite y ofrece una alternativa en español', async () => {
    const response = await call('list_files', { path: '..' });
    assert.ok(response.error || response.result?.isError, 'salir de la raíz debe seguir rechazado');
    const message = responseText(response);
    assert.match(message, /path["']?\s*[:=]\s*["']\.["']/);
    assert.match(message, /(?:carpeta|compartid|permitid|ra[ií]z)/i);
    assert.doesNotMatch(JSON.stringify(response), /PRIVATE-OUTSIDE-WORKSPACE/);
  });

  const gitAvailable = spawnSync('git', ['--version'], { env, windowsHide: true, encoding: 'utf8' }).status === 0;
  await t.test('git_status en una carpeta normal devuelve isRepository false sin crear .git', {
    skip: gitAvailable ? false : 'Git no está instalado.'
  }, async () => {
    assert.equal(fs.existsSync(path.join(workspace, '.git')), false);
    const result = normalResult(await call('git_status', { repo: '.' }));
    assert.equal(result.structuredContent?.isRepository, false);
    assert.match(result.structuredContent.message, /(?:no es|no contiene|no tiene)[\s\S]{0,100}(?:repositorio|git)/i);
    assert.equal(fs.existsSync(path.join(workspace, '.git')), false, 'consultar el estado nunca inicializa Git');
  });

  await t.test('git_status en un repositorio real mantiene el estado de sus archivos', {
    skip: gitAvailable ? false : 'Git no está instalado.'
  }, async () => {
    const repo = path.join(workspace, 'repo-real');
    fs.mkdirSync(repo);
    const initialized = spawnSync('git', ['init', '--quiet', repo], { cwd: temporary, env, windowsHide: true, encoding: 'utf8' });
    assert.equal(initialized.status, 0, initialized.stderr);
    fs.writeFileSync(path.join(repo, 'pendiente.txt'), 'Cambio sin commit.');
    const result = normalResult(await call('git_status', { repo: 'repo-real' }));
    assert.equal(result.structuredContent?.isRepository, true);
    assert.match(result.structuredContent.stdout, /pendiente\.txt/);
    assert.equal(fs.existsSync(path.join(workspace, '.git')), false);
  });

  await t.test('Git no disponible sigue siendo un error, no una carpeta sin repositorio', async () => {
    const noGitEnv = Object.fromEntries(Object.entries(env).filter(([key]) => key.toLowerCase() !== 'path'));
    noGitEnv.PATH = '';
    const noGitClient = client(staged, noGitEnv);
    clients.push(noGitClient);
    const response = await noGitClient.rpc('tools/call', { name: 'git_status', arguments: { repo: '.' } });
    assert.ok(response.error || response.result?.isError, JSON.stringify(response));
    assert.notEqual(response.result?.structuredContent?.isRepository, false);
    assert.equal(fs.existsSync(path.join(workspace, '.git')), false);
  });

  await t.test('Git no descubre un repositorio padre fuera de la carpeta compartida', {
    skip: gitAvailable ? false : 'Git no está instalado.'
  }, async () => {
    const initialized = spawnSync('git', ['init', '--quiet', temporary], { cwd: temporary, env, windowsHide: true, encoding: 'utf8' });
    assert.equal(initialized.status, 0, initialized.stderr);
    const parentEnv = { ...env, GIT_CEILING_DIRECTORIES: '' };
    const parentClient = client(staged, parentEnv);
    clients.push(parentClient);
    const response = await parentClient.rpc('tools/call', { name: 'git_status', arguments: { repo: '.' } });
    assert.doesNotMatch(JSON.stringify(response), /privado\.txt|private\/|server\//);
    assert.equal(normalResult(response).structuredContent?.isRepository, false);
    assert.equal(fs.existsSync(path.join(workspace, '.git')), false);

    const inheritedClient = client(staged, { ...parentEnv, GIT_DIR: path.join(temporary, '.git'), GIT_WORK_TREE: temporary });
    clients.push(inheritedClient);
    const inherited = await inheritedClient.rpc('tools/call', { name: 'git_status', arguments: { repo: '.' } });
    assert.equal(normalResult(inherited).structuredContent?.isRepository, false);
    assert.doesNotMatch(JSON.stringify(inherited), /privado\.txt|private\/|server\//);
  });
});

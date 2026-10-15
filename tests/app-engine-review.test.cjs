'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { AppEngine } = require('../lib/app-engine.cjs');
const api = require('../gemini-pc.cjs');

function fakeChild(pid) {
  return Object.assign(new EventEmitter(), {
    pid, exitCode: null, signalCode: null, stdout: new PassThrough(), stderr: new PassThrough()
  });
}
function closeChild(child) { child.exitCode = 0; child.emit('close', 0); }
function writeReady(directory, child) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'status.json'), JSON.stringify({
    supervisorPid: child.pid, updatedAt: new Date().toISOString(), serverHealthy: true,
    serverRunning: true, publicUrl: 'https://example.test'
  }));
}
function fixture(t, options, config = {}) {
  const root = fs.mkdtempSync(path.join(api.ROOT, '.test-engine-review-'));
  const server = path.join(root, 'servidor');
  let engine;
  t.after(async () => { try { await engine?.dispose(); } finally { fs.rmSync(root, { recursive: true, force: true }); } });
  fs.mkdirSync(server);
  api.writeEnv({ ...api.buildConfig({ workspace: path.join(root, 'workspace'), mode: 'direct', baseUrl: 'https://example.test' }), ...config }, server);
  engine = new AppEngine({ root, server, home: path.join(root, 'home'), installer: async () => {},
    ngrok: { findAuthConfig: () => '' }, readinessTimeout: 150, pollInterval: 10,
    terminateTree: async child => closeChild(child), ...options });
  return { root, server, engine };
}

test('el inicio lee el estado en MCP_RUNTIME_DIR relativo al directorio del supervisor', async t => {
  let spawned;
  const f = fixture(t, { spawn: (command, args, options) => {
    spawned = fakeChild(45101);
    writeReady(path.resolve(options.cwd, options.env.MCP_RUNTIME_DIR), spawned);
    return spawned;
  } }, { MCP_RUNTIME_DIR: '.private/custom-runtime' });
  await f.engine.start();
  assert.equal(f.engine.getState().runtime.state, 'running');
  assert.equal(f.engine.getState().runtime.endpoint, 'https://example.test/mcp');
  assert.equal(spawned.exitCode, null, 'una conexión saludable no debe terminar por leer otra carpeta');
});

test('dispose rechaza nuevas conexiones mientras espera el cierre del hijo anterior', async t => {
  let releaseTermination;
  let terminationEntered;
  const entered = new Promise(resolve => { terminationEntered = resolve; });
  const children = [];
  let terminationCalls = 0;
  const f = fixture(t, {
    spawn: (command, args, options) => {
      const child = fakeChild(45200 + children.length);
      children.push(child);
      writeReady(path.join(options.cwd, '.runtime'), child);
      return child;
    },
    terminateTree: async child => {
      if (++terminationCalls === 1) {
        terminationEntered();
        await new Promise(resolve => { releaseTermination = resolve; });
      }
      closeChild(child);
    }
  });
  await f.engine.start();
  const closing = f.engine.dispose();
  await entered;
  try {
    await assert.rejects(f.engine.start(), /cerrad|cerrando|cierre/i);
    assert.equal(children.length, 1, 'el cierre no debe permitir reemplazar el proceso que está terminando');
  } finally {
    releaseTermination();
    await closing;
  }
  assert.ok(children.every(child => child.exitCode !== null));
  assert.equal(f.engine.disposed, true);
});

test('el pánico corta la conexión antes de esperar a que una operación termine de cancelarse', async t => {
  const children = [];
  let stopped = false;
  const f = fixture(t, { spawn: (command, args, options) => {
    const child = fakeChild(45301); children.push(child);
    writeReady(path.join(options.cwd, '.runtime'), child); return child;
  }, terminateTree: async child => { stopped = true; closeChild(child); } });
  await f.engine.start();
  let releaseOperation;
  const active = f.engine._perform('Preparando componentes', () => new Promise(resolve => { releaseOperation = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  let finished = false;
  const closing = f.engine.dispose().then(() => { finished = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopped, true, 'no espera la operación para cortar la conexión existente');
  assert.equal(children[0].exitCode, 0);
  assert.equal(finished, false, 'no afirma cierre completo hasta que acaba la operación');
  releaseOperation();
  await active;
  await closing;
  assert.equal(f.engine.disposed, true);
});

test('el pánico y la cancelación del inicio comparten un cierre fallido sin perder el hijo', async t => {
  let spawned;
  let releaseFailure, enteredTermination;
  const entered = new Promise(resolve => { enteredTermination = resolve; });
  let attempts = 0;
  const f = fixture(t, { readinessTimeout: 1000, spawn: () => { spawned = fakeChild(45401); return spawned; },
    terminateTree: async child => {
      if (++attempts === 1) {
        enteredTermination();
        await new Promise((resolve, reject) => { releaseFailure = () => reject(new Error('No se pudo detener el proceso de prueba.')); });
      }
      closeChild(child);
    } });
  const starting = f.engine.start();
  const startResult = starting.then(() => 'success', () => 'failed');
  await new Promise(resolve => setTimeout(resolve, 20));
  let closed = false;
  const panic = f.engine.dispose().then(() => { closed = true; return 'success'; }, () => 'failed');
  await entered;
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(closed, false);
  assert.equal(attempts, 1, 'la cancelación de start no inicia otra detención');
  assert.equal(f.engine.child, spawned);
  releaseFailure();
  assert.equal(await panic, 'failed');
  assert.equal(await startResult, 'failed');
  assert.equal(f.engine.disposed, false);
  assert.equal(f.engine.child, spawned);
  assert.equal(spawned.exitCode, null);
  await f.engine.dispose();
  assert.equal(attempts, 2);
  assert.equal(f.engine.disposed, true);
  assert.equal(spawned.exitCode, 0);
});

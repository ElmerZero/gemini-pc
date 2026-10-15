'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { AppEngine } = require('../lib/app-engine.cjs');
const api = require('../gemini-pc.cjs');

function fixture(extra = {}) {
  const root = fs.mkdtempSync(path.join(api.ROOT, '.test-engine-'));
  const server = path.join(root, 'servidor'), home = path.join(root, 'home');
  fs.mkdirSync(server); fs.mkdirSync(home);
  const engine = new AppEngine({ root, server, home, installer: async () => {},
    ngrok: { findAuthConfig: () => '' }, ...extra });
  return { root, server, home, engine, cleanup: async () => { await engine.dispose(); fs.rmSync(root, { recursive: true, force: true }); } };
}
function writeConfig(f, overrides = {}) {
  api.writeEnv({ ...api.buildConfig({ workspace: path.join(f.root, 'workspace'), mode: 'direct', baseUrl: 'https://example.test' }), ...overrides }, f.server);
}
function fakeChild(pid = 12345) {
  const child = new EventEmitter();
  Object.assign(child, { pid, exitCode: null, signalCode: null, stdout: new PassThrough(), stderr: new PassThrough() });
  return child;
}

test('el estado público excluye secretos de configuración y conserva sólo la identidad de la cuenta', async () => {
  const f = fixture();
  try {
    writeConfig(f, { MCP_AUTH_TOKEN: 'SECRET-AUTH', NGROK_AUTHTOKEN: 'SECRET-NGROK', UNKNOWN_SETTING: 'PRIVATE' });
    fs.mkdirSync(path.join(f.server, '.private'));
    fs.writeFileSync(path.join(f.server, '.private/oauth-state.json'), JSON.stringify({ admin: { username: 'ana', passwordHash: 'HASH-PRIVATE' }, tokens: ['SECRET-TOKEN'] }));
    const state = f.engine.getState();
    assert.equal(state.account.configured, true);
    assert.equal(state.account.username, 'ana');
    assert.doesNotMatch(JSON.stringify(state), /SECRET|HASH-PRIVATE|UNKNOWN_SETTING|MCP_AUTH_TOKEN/);
    state.events.push({ message: 'alterado' });
    assert.equal(f.engine.getState().events.length, 0);
  } finally { await f.cleanup(); }
});

test('guardar la configuración local crea la carpeta sugerida sin habilitar comandos', async () => {
  const f = fixture();
  try {
    assert.equal(fs.existsSync(path.join(f.root, 'workspace')), false);
    f.engine.getState();
    assert.equal(fs.existsSync(path.join(f.root, 'workspace')), false);
    await f.engine.setup({ target: 'cli', profile: 'lectura' });
    assert.equal(fs.existsSync(path.join(f.root, 'workspace')), true);
    const state = f.engine.getState();
    assert.equal(state.configured, true);
    assert.equal(state.config.profile, 'lectura');
    assert.equal(state.config.mode, 'local');
    assert.equal(state.operation.busy, false);
    assert.match(fs.readFileSync(path.join(f.server, '.env'), 'utf8'), /MCP_AUTH_MODE=none/);
    await assert.rejects(f.engine.setup({ target: 'cli', profile: 'proyecto' }), /Confirma/);
  } finally { await f.cleanup(); }
});

test('editar una conexión conserva la cuenta OAuth y los permisos personalizados existentes', async () => {
  const f = fixture({ configureOAuthAdmin: () => { throw new Error('No debe reconfigurar la cuenta'); } });
  try {
    fs.mkdirSync(path.join(f.root, 'workspace'));
    writeConfig(f, { MCP_ACCESS_GROUPS: 'diagnostics,files_read', MCP_TOOL_DENYLIST: 'example' });
    fs.mkdirSync(path.join(f.server, '.private'));
    const accountFile = path.join(f.server, '.private/oauth-state.json');
    const original = JSON.stringify({ admin: { username: 'original', passwordHash: 'hash' } });
    fs.writeFileSync(accountFile, original);
    await f.engine.setup({ target: 'web', port: 3210 });
    const config = fs.readFileSync(path.join(f.server, '.env'), 'utf8');
    assert.match(config, /MCP_ACCESS_GROUPS=diagnostics,files_read/);
    assert.match(config, /MCP_TOOL_DENYLIST=example/);
    assert.equal(fs.readFileSync(accountFile, 'utf8'), original);
  } finally { await f.cleanup(); }
});

test('Gemini CLI conserva ajustes ajenos, crea una copia y evita sobrescribir JSON inválido', async () => {
  const f = fixture();
  try {
    await f.engine.setup({ target: 'cli' });
    fs.mkdirSync(path.join(f.home, '.gemini'));
    const file = path.join(f.home, '.gemini/settings.json');
    const existing = { theme: 'light', mcpServers: { existing: { command: 'other' } } };
    fs.writeFileSync(file, JSON.stringify(existing));
    await f.engine.installCli();
    const merged = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(merged.theme, 'light');
    assert.deepEqual(merged.mcpServers.existing, existing.mcpServers.existing);
    assert.equal(merged.mcpServers['mi-pc'].args.at(-1), 'stdio');
    assert.equal(merged.mcpServers['mi-pc'].trust, false);
    const backup = fs.readdirSync(path.dirname(file)).find(name => name.startsWith('settings.json.backup-'));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(path.dirname(file), backup), 'utf8')), existing);
    fs.writeFileSync(file, 'broken json');
    await assert.rejects(f.engine.installCli(), /JSON válido/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'broken json');
  } finally { await f.cleanup(); }
});

test('serializa las operaciones y permite cancelar sin escribir configuración incompleta', async () => {
  const f = fixture({ installer: signal => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('cancelada', 'AbortError')), { once: true });
  }) });
  try {
    const setup = f.engine.setup({ target: 'cli' });
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(f.engine.installCli(), /operación actual/);
    f.engine.cancel();
    await assert.rejects(setup, { name: 'AbortError' });
    assert.equal(f.engine.getState().operation.busy, false);
    assert.equal(fs.existsSync(path.join(f.server, '.env')), false);
  } finally { await f.cleanup(); }
});

test('el inicio ignora el estado de otro proceso y publica sólo un endpoint saludable propio', async () => {
  const child = fakeChild();
  let terminated = 0;
  const f = fixture({ spawn: () => child, pollInterval: 10, readinessTimeout: 1000,
    terminateTree: async process => { terminated++; process.exitCode = 0; process.emit('close', 0); } });
  try {
    writeConfig(f);
    fs.mkdirSync(path.join(f.server, '.runtime'));
    const file = path.join(f.server, '.runtime/status.json');
    const status = { supervisorPid: 99999, updatedAt: new Date().toISOString(), serverHealthy: true, serverRunning: true, publicUrl: 'https://example.test' };
    fs.writeFileSync(file, JSON.stringify(status));
    const starting = f.engine.start();
    await new Promise(resolve => setTimeout(resolve, 35));
    assert.equal(f.engine.getState().runtime.state, 'starting');
    fs.writeFileSync(file, JSON.stringify({ ...status, supervisorPid: child.pid, updatedAt: new Date().toISOString() }));
    await starting;
    assert.equal(f.engine.getState().runtime.state, 'running');
    assert.equal(f.engine.getState().runtime.endpoint, 'https://example.test/mcp');
    await f.engine.stop();
    assert.equal(terminated, 1);
    assert.equal(f.engine.getState().runtime.state, 'stopped');
  } finally { await f.cleanup(); }
});

test('cancelar el inicio espera el cierre del proceso y permite conectar de nuevo', async () => {
  const child = fakeChild();
  const f = fixture({ spawn: () => child, pollInterval: 10, readinessTimeout: 1000,
    terminateTree: async process => { process.exitCode = 0; process.emit('close', 0); } });
  try {
    writeConfig(f);
    const starting = f.engine.start();
    const rejected = assert.rejects(starting, { name: 'AbortError' });
    await new Promise(resolve => setTimeout(resolve, 25));
    await f.engine.stop();
    await rejected;
    assert.equal(child.exitCode, 0);
    assert.equal(f.engine.getState().operation.busy, false);
    assert.equal(f.engine.getState().runtime.state, 'stopped');
  } finally { await f.cleanup(); }
});

test('las aprobaciones usan IDs concretos y no revelan los argumentos originales', async () => {
  const decisions = [], pending = [{ id: 'req_1', tool: 'run_command', clientId: 'gemini', argsSummary: 'run_command command=tests password=SECRET', args: { token: 'RAW-SECRET' }, expiresAt: Date.now() + 10000 }];
  const f = fixture({ approvalsFactory: file => ({
    listPending: () => pending,
    approve: id => { decisions.push(['approve', id, file]); pending.length = 0; },
    reject: id => decisions.push(['reject', id, file])
  }) });
  try {
    await f.engine.listApprovals();
    assert.doesNotMatch(JSON.stringify(f.engine.getState()), /RAW-SECRET|password=SECRET/);
    await assert.rejects(f.engine.approve('../req_1'), /solicitud válida/);
    assert.equal(decisions.length, 0);
    await f.engine.approve('req_1');
    assert.equal(decisions[0][1], 'req_1');
    assert.equal(decisions[0][2], path.join(f.server, '.runtime/approvals.json'));
  } finally { await f.cleanup(); }
});

test('el estado recoge solicitudes nuevas del disco sin emitir cambios ni crear un almacén', {
  skip: ['approvals.js', 'private-owner.js'].every(file => fs.existsSync(path.join(api.SERVER, 'lib', file)))
    ? false : 'El servidor MCP no está instalado; esta prueba integra su almacén de aprobaciones.'
}, async () => {
  const f = fixture();
  try {
    fs.mkdirSync(path.join(f.server, 'lib'));
    fs.copyFileSync(path.join(api.SERVER, 'lib/approvals.js'), path.join(f.server, 'lib/approvals.js'));
    fs.copyFileSync(path.join(api.SERVER, 'lib/private-owner.js'), path.join(f.server, 'lib/private-owner.js'));
    let emitted = 0;
    f.engine.on('change', () => { emitted++; });
    assert.deepEqual(f.engine.getState().approvals, []);
    assert.equal(fs.existsSync(path.join(f.server, '.runtime')), false);
    fs.mkdirSync(path.join(f.server, '.runtime'));
    const file = path.join(f.server, '.runtime/approvals.json');
    const request = { id: 'req_new', status: 'pending', tool: 'run_command', clientId: 'gemini',
      argsSummary: 'run_command(command="npm test")', args: { token: 'NEVER-SHARE' }, expiresAt: Date.now() + 60000 };
    fs.writeFileSync(file, JSON.stringify({ version: 1, pending: { req_new: request }, history: [] }));
    const state = f.engine.getState();
    assert.equal(state.approvals[0].id, 'req_new');
    assert.doesNotMatch(JSON.stringify(state.approvals), /NEVER-SHARE/);
    assert.equal(emitted, 0);
    fs.writeFileSync(file, JSON.stringify({ version: 1, pending: {}, history: [] }));
    assert.deepEqual(f.engine.getState().approvals, []);
    assert.equal(emitted, 0);
  } finally { await f.cleanup(); }
});

test('el diagnóstico de un dominio propio no descarga ni exige ngrok', { skip: process.getuid?.() === 0 }, async () => {
  let ngrokChecks = 0;
  const f = fixture({ ngrok: { findAuthConfig: () => '', ensureNgrok: async () => { ngrokChecks++; return {}; } } });
  try {
    writeConfig(f);
    await f.engine.doctor();
    assert.equal(ngrokChecks, 0);
  } finally { await f.cleanup(); }
});

test('el motor rechaza una instalación incompatible antes de ejecutar sus componentes', { skip: process.getuid?.() === 0 }, async () => {
  let commands = 0;
  const f = fixture({ installer: null, run: async () => { commands++; return { stdout: '' }; } });
  try {
    writeConfig(f);
    fs.writeFileSync(path.join(f.server, 'mcp-server.js'), '// installed server');
    fs.writeFileSync(path.join(f.server, 'mcp-supervisor.js'), '// installed supervisor');
    fs.writeFileSync(path.join(f.server, 'package.json'), JSON.stringify({ name: 'mcp-server-local', version: '9.0.0' }));
    await assert.rejects(f.engine.doctor(), /versión compatible 4\.6\.1/);
    assert.equal(commands, 0);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.server, 'package.json'), 'utf8')).version, '9.0.0');
  } finally { await f.cleanup(); }
});

test('el cierre es idempotente y permite reintentar cuando no logra terminar el proceso', async () => {
  const child = fakeChild();
  let attempts = 0;
  const f = fixture({ terminateTree: async process => {
    if (++attempts === 1) throw new Error('El sistema no permitió cerrar el proceso.');
    process.exitCode = 0; process.emit('close', 0);
  } });
  try {
    f.engine.child = child;
    const first = f.engine.dispose();
    assert.equal(f.engine.dispose(), first, 'las llamadas concurrentes comparten el cierre');
    await assert.rejects(first, /no permitió/);
    assert.equal(f.engine.child, child, 'el hijo sigue bajo control después de un fallo');
    assert.equal(f.engine.disposed, false);
    await assert.rejects(f.engine.start(), /cerrándose|cerrado/);
    await f.engine.dispose();
    await f.engine.dispose();
    assert.equal(attempts, 2);
    assert.equal(child.exitCode, 0);
    assert.equal(f.engine.disposed, true);
  } finally { await f.cleanup(); }
});

test('las aprobaciones muestran el comando y argumentos completos con secretos ocultos', async () => {
  const command = `node ${'a'.repeat(2400)} --check`;
  const pending = [{ id: 'req_detail', tool: 'run_command', clientId: 'gemini', argsSummary: 'node aaaaa...',
    args: { command, args: ['--password', 'HIDDEN-PASSWORD', '--mode', 'inspect'], cwd: '/proyecto', shell: true, token: 'HIDDEN-TOKEN' },
    consequences: 'Ejecutar una acción', affectedPaths: ['/proyecto'], expiresAt: Date.now() + 10000 }];
  const f = fixture({ approvalsFactory: () => ({ listPending: () => pending }) });
  try {
    const item = f.engine.getState().approvals[0];
    assert.ok(item.details.includes(command));
    assert.match(item.details, /--mode.*inspect/);
    assert.match(item.details, /cwd: \/proyecto/);
    assert.match(item.details, /shell: true/);
    assert.equal(item.consequences, 'Ejecutar una acción');
    assert.deepEqual(item.affectedPaths, ['/proyecto']);
    assert.equal(item.reviewTruncated, false);
    assert.doesNotMatch(JSON.stringify(item), /HIDDEN-PASSWORD|HIDDEN-TOKEN/);
  } finally { await f.cleanup(); }
});

test('no se puede aprobar una solicitud cuyos detalles no caben completos en el panel', async () => {
  let approved = false;
  const pending = [{ id: 'req_long', tool: 'run_command', clientId: 'gemini', argsSummary: 'comando corto',
    args: { command: 'x'.repeat(17000) }, expiresAt: Date.now() + 10000 }];
  const f = fixture({ approvalsFactory: () => ({ listPending: () => pending, approve: () => { approved = true; } }) });
  try {
    const item = f.engine.getState().approvals[0];
    assert.equal(item.reviewTruncated, true);
    assert.ok(Buffer.byteLength(item.details) <= 16 * 1024);
    await assert.rejects(f.engine.approve('req_long'), /demasiado extensa/);
    assert.equal(approved, false);
  } finally { await f.cleanup(); }
});

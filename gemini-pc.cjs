#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { TerminalUI, Cancelled } = require('./lib/terminal-ui.cjs');
const { run, redact, terminateTree } = require('./lib/process.cjs');
const ngrok = require('./lib/ngrok.cjs');
const { applyServerPatches } = require('./lib/server-patches.cjs');

const ROOT = __dirname, SERVER = path.join(ROOT, 'servidor');
const REPOSITORY = 'https://github.com/vicktorgabriel/mcp-server.git';
const COMMIT = 'fe1a8e679579796a2c2236ce444da52ae9ddf93b';
const VERSION = require('./package.json').version;
const PROFILES = Object.freeze({
  archivos: 'diagnostics,files_read,files_write,git_read',
  lectura: 'diagnostics,files_read,git_read',
  proyecto: 'diagnostics,files_read,files_write,command_execution,git_read,git_write'
});
const COMMANDS = ['/configurar-web', '/configurar-cli', '/iniciar', '/detener', '/dependencias', '/estado', '/pendientes', '/aprobar', '/ayuda', '/salir'];
let ui, operation, service, statusTimer;
const signal = () => operation?.signal;

function checkNode() {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Instala Node.js 22 o posterior; se recomienda Node.js 24 LTS.');
}
function normalUser() {
  if (process.getuid?.() === 0) throw new Error('Ejecuta el MCP con tu usuario normal, sin sudo ni sesión root.');
}
function inside(parent, target) {
  const relative = path.relative(parent, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
function unquote(value) {
  const text = String(value).trim();
  return /^(["']).*\1$/.test(text) ? text.slice(1, -1) : text;
}
function validateWorkspace(value, serverDir = SERVER) {
  if (typeof value !== 'string' || !value.trim() || /[\r\n,]/.test(value)) throw new Error('Elige una carpeta sin comas ni saltos de línea en su ruta.');
  let workspace;
  try { workspace = fs.realpathSync(path.resolve(unquote(value))); }
  catch { throw new Error('La carpeta no existe. Pega una ruta existente o acepta workspace.'); }
  if (!fs.statSync(workspace).isDirectory()) throw new Error('La ruta debe ser una carpeta.');
  const serverPath = fs.realpathSync(serverDir);
  if (inside(workspace, serverPath) || inside(serverPath, workspace)) throw new Error('Elige una carpeta separada de servidor/ y de sus archivos de autenticación.');
  return workspace;
}
function normalizeUrl(value) {
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error('Introduce una URL completa, por ejemplo https://tu-dominio.ngrok-free.dev.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !['', '/', '/mcp', '/mcp/'].includes(url.pathname)) throw new Error('Usa HTTPS sin credenciales, parámetros ni rutas adicionales.');
  if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Gemini web necesita una URL pública.');
  return url.origin;
}
function buildConfig({ workspace, profile = 'archivos', mode = 'ngrok', baseUrl = '', port = 3000, ngrokBin = 'ngrok', ngrokConfig = '' }) {
  if (!Object.hasOwn(PROFILES, profile)) throw new Error('Perfil desconocido.');
  if (!['ngrok', 'direct', 'local'].includes(mode)) throw new Error('Modo desconocido.');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Usa un puerto entre 1024 y 65535.');
  const base = mode === 'local' ? '' : normalizeUrl(baseUrl);
  return {
    MCP_SETUP_COMPLETE: '1', MCP_SETUP_VERSION: '6', HOST: '127.0.0.1', PORT: String(port),
    ALLOWED_PATHS: workspace, WORKING_DIR: workspace, MCP_FULL_ACCESS: '0',
    MCP_ACCESS_PROFILE: 'custom', MCP_ACCESS_GROUPS: PROFILES[profile],
    MCP_TOOL_ALLOWLIST: '', MCP_TOOL_DENYLIST: '', MCP_RUN_AS_ROOT: '0',
    MCP_CRITICAL_CONFIRMATIONS: '1', MCP_TOOL_APPROVALS: 'run_command,job_start,project_test_runner',
    MCP_EXPOSURE_MODE: mode, MCP_PUBLIC_BASE_URL: base, PUBLIC_BASE_URL: base,
    NGROK_URL: mode === 'ngrok' ? base : '', NGROK_BIN: ngrokBin, NGROK_CONFIG: ngrokConfig,
    MCP_AUTH_MODE: mode === 'local' ? 'none' : 'oauth',
    MCP_ALLOW_UNSAFE_NO_AUTH: '0', MCP_ALLOW_INSECURE_HTTP_AUTH: '0',
    MCP_OAUTH_STORE: '.private/oauth-state.json', MCP_OAUTH_CIMD: '0',
    MCP_OAUTH_DYNAMIC_REGISTRATION: '1', MCP_OAUTH_PRIVATE_KEY_JWT: '0',
    MCP_OAUTH_CHALLENGE_CLIENTS: 'gemini,claude', MCP_DESKTOP_ENABLED: '0', MCP_INPUT_ENABLED: '0',
    MCP_UPDATE_CHECK: '0', MCP_HUMAN_LOG: '.runtime/events.log', ACTIVITY_LOG: '.runtime/activity.ndjson',
    MCP_ERROR_LOG: '.runtime/errors.log', MCP_RUNTIME_LOG_MAX_BYTES: '10485760', MCP_FAST_MODE: '1',
    SEARCH_MAX_FILE_BYTES: '524288', SEARCH_MAX_TOTAL_BYTES: '16777216', READ_BATCH_LIMIT: '10'
  };
}
function atomicWrite(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, contents, { mode: 0o600 }); fs.renameSync(temporary, file); fs.chmodSync(file, 0o600);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
function writeEnv(config, directory = SERVER) {
  for (const [key, value] of Object.entries(config)) {
    if (!/^[A-Z0-9_]+$/.test(key) || /[\r\n]/.test(String(value))) throw new Error('Configuración inválida.');
  }
  atomicWrite(path.join(directory, '.env'), Object.entries(config).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
}
function readConfig(required = true) {
  const file = path.join(SERVER, '.env');
  if (!fs.existsSync(file)) { if (required) throw new Error('Primero usa /configurar-web o /configurar-cli.'); return {}; }
  const config = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const index = line.indexOf('=');
    if (index > 0 && !line.trimStart().startsWith('#')) config[line.slice(0, index).trim()] = unquote(line.slice(index + 1));
  }
  return config;
}
const DRAFT_FIELDS = new Set(['workspace', 'profile', 'port', 'mode', 'baseUrl', 'username']);
function saveDraft(draft, file = path.join(ROOT, '.local/setup-draft.json')) {
  const clean = Object.fromEntries(Object.entries(draft).filter(([key]) => DRAFT_FIELDS.has(key)));
  atomicWrite(file, JSON.stringify(clean, null, 2) + '\n');
}
function readDraft() { try { return JSON.parse(fs.readFileSync(path.join(ROOT, '.local/setup-draft.json'), 'utf8')); } catch { return {}; } }
const valid = work => value => { try { work(value); return ''; } catch (error) { return error.message; } };

async function npmInstall(directory) {
  const command = process.platform === 'win32' ? 'cmd.exe' : 'npm';
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', 'npm.cmd', 'ci', '--ignore-scripts', '--no-fund', '--no-audit'] : ['ci', '--ignore-scripts', '--no-fund', '--no-audit'];
  await run(command, args, { cwd: directory, signal: signal(), timeout: 180000 });
}
async function install() {
  checkNode();
  try { await run('git', ['--version'], { cwd: ROOT, signal: signal(), timeout: 10000 }); }
  catch (error) { if (error.code === 'ENOENT') throw new Error('Falta Git. Instálalo desde https://git-scm.com/downloads y vuelve a abrir PowerShell.'); throw error; }
  if (fs.existsSync(SERVER)) {
    const current = (await run('git', ['rev-parse', 'HEAD'], { cwd: SERVER, signal: signal() })).stdout;
    if (current !== COMMIT) throw new Error('servidor/ contiene otra revisión. Instala este paquete en una carpeta nueva para conservarla.');
    if (!fs.existsSync(path.join(SERVER, 'node_modules/@simplewebauthn/server'))) await ui.task('motor', 'Reparando las dependencias del motor', () => npmInstall(SERVER));
    applyServerPatches(SERVER);
    ui.event('motor', '4.6.1 instalado · tu configuración se conserva', 'done'); return;
  }
  await ui.task('motor', 'Descargando el motor MCP 4.6.1', async update => {
    const staging = fs.mkdtempSync(path.join(ROOT, '.instalacion-'));
    try {
      const options = { cwd: staging, signal: signal() };
      await run('git', ['init', '-q'], options);
      await run('git', ['remote', 'add', 'origin', REPOSITORY], options);
      await run('git', ['fetch', '--quiet', '--depth=1', 'origin', COMMIT], options);
      await run('git', ['checkout', '--quiet', '--detach', 'FETCH_HEAD'], options);
      if ((await run('git', ['rev-parse', 'HEAD'], options)).stdout !== COMMIT) throw new Error('La revisión descargada no coincide.');
      update('Instalando las dependencias del motor…'); await npmInstall(staging);
      applyServerPatches(staging);
      signal()?.throwIfAborted(); fs.renameSync(staging, SERVER); update('4.6.1 instalado · revisión comprobada');
    } finally { if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true }); }
  });
}
async function ensureNgrok(config = {}) {
  return ui.task('ngrok', 'Buscando ngrok en tu PC', async update => {
    const result = await ngrok.ensureNgrok(ROOT, { configured: config.NGROK_BIN, signal: signal(),
      onProgress: (bytes, total) => update(`Descargando ngrok oficial · ${(bytes / 1048576).toFixed(1)} MB${total ? ` / ${(total / 1048576).toFixed(1)} MB` : ''}`) });
    update(`${result.version} · ${result.installed ? 'instalado automáticamente' : 'disponible'}`); return result;
  });
}
async function authNgrok(binary, config = {}) {
  const found = ngrok.findAuthConfig(SERVER, config.NGROK_CONFIG);
  if (found) { ui.event('ngrok', 'Usando tu configuración de ngrok existente', 'done'); return found; }
  if (process.env.NGROK_AUTHTOKEN) { ui.event('ngrok', 'Authtoken disponible en el entorno', 'done'); return ''; }
  ui.event('cuenta', 'Obtén tu authtoken en dashboard.ngrok.com/get-started/your-authtoken');
  const token = await ui.inputValue('Authtoken de ngrok', { secret: true, hint: 'Entrada oculta · se guarda en tu PC, sin pasarlo como argumento de un comando.',
    validate: value => value.length < 16 || value.length > 4096 || /\s/.test(value) ? 'Pega el authtoken completo, sin espacios.' : '' });
  const file = ngrok.saveAuthtoken(SERVER, token);
  await run(binary, ['config', 'check', '--config', file], { signal: signal(), timeout: 10000 });
  ui.event('ngrok', 'Configuración de cuenta guardada', 'done'); return file;
}
async function setup(local) {
  checkNode(); normalUser();
  if (service) throw new Error('Detén primero el servidor con /detener para cambiar la configuración.');
  if (!process.stdin.isTTY) throw new Error('Abre una terminal para completar el asistente.');
  await install();
  const previous = readConfig(false), draft = readDraft();
  ui.status = local ? 'Configurar Gemini CLI' : 'Configurar Gemini web';
  if (!local) ui.event('Gemini web', 'Conectores → + → Agregar conector personalizado · consulta LEEME.md');
  const field = async (key, label, fallback, options = {}) => {
    const value = await ui.inputValue(label, { fallback: draft[key] ?? fallback, ...options });
    draft[key] = value; saveDraft(draft); return value;
  };
  const suggested = path.join(ROOT, 'workspace');
  const workspace = await field('workspace', '01 / Carpeta de proyectos', previous.ALLOWED_PATHS || suggested, {
    hint: 'Puedes pegar una ruta de Windows con espacios. No se comparte el resto de tu PC.',
    validate: valid(value => { if (path.resolve(unquote(value)) === suggested) fs.mkdirSync(suggested, { recursive: true }); validateWorkspace(value); })
  });
  ui.cwd = validateWorkspace(workspace); ui.event('carpeta', ui.cwd, 'done');
  const previousProfile = Object.keys(PROFILES).find(key => PROFILES[key] === previous.MCP_ACCESS_GROUPS) || 'archivos';
  const profile = await field('profile', '02 / Permisos', previousProfile, { options: [
    { value: 'archivos', label: 'Leer y editar archivos', description: 'Proyectos y consultas de Git. Sin comandos ni escritorio.' },
    { value: 'lectura', label: 'Sólo lectura', description: 'Consultar archivos sin modificarlos.' },
    { value: 'proyecto', label: 'Archivos y comandos de proyecto', description: 'Los comandos actúan con los permisos de tu usuario y requieren aprobación local.' }
  ] });
  if (profile === 'proyecto') await ui.inputValue('Escribe COMANDOS para habilitar la ejecución de procesos', {
    hint: 'La carpeta de trabajo no aísla los comandos del resto del sistema.', validate: value => value === 'COMANDOS' ? '' : 'Escribe COMANDOS o pulsa Esc para volver.'
  });
  const port = Number(await field('port', '03 / Puerto local', previous.PORT || '3000', {
    validate: value => Number.isInteger(Number(value)) && Number(value) >= 1024 && Number(value) <= 65535 ? '' : 'Usa un puerto entre 1024 y 65535.'
  }));
  let mode = 'local', baseUrl = '', ngrokBin = previous.NGROK_BIN || 'ngrok', ngrokConfig = previous.NGROK_CONFIG || '';
  if (!local) {
    mode = await field('mode', '04 / Cómo conectar tu PC', previous.MCP_EXPOSURE_MODE === 'direct' ? 'direct' : 'ngrok', { options: [
      { value: 'ngrok', label: 'ngrok · instalación automática', description: 'Si no lo tienes, se descarga y se usa sin reiniciar la terminal.' },
      { value: 'direct', label: 'Mi proxy HTTPS ya está configurado', description: 'Tu dominio debe reenviar /mcp, /oauth y /.well-known a esta PC.' }
    ], fallback: ['ngrok', 'direct'].includes(draft.mode) ? draft.mode : previous.MCP_EXPOSURE_MODE === 'direct' ? 'direct' : 'ngrok' });
    if (mode === 'ngrok') {
      const found = await ensureNgrok(previous); ngrokBin = found.binary;
      ngrokConfig = await authNgrok(ngrokBin, previous);
    }
    baseUrl = await field('baseUrl', '05 / URL HTTPS pública', previous.MCP_PUBLIC_BASE_URL || '', {
      hint: mode === 'ngrok' ? 'Enter sin URL: detectar automáticamente. Escribe auto para cambiar una URL guardada.' : 'Ejemplo: https://tu-dominio.example/mcp',
      validate: value => (!value || value === 'auto') && mode === 'ngrok' ? '' : valid(normalizeUrl)(value)
    });
    if (!baseUrl || baseUrl === 'auto') baseUrl = await ui.task('túnel', 'Detectando tu dirección HTTPS', async update => {
      const url = await ngrok.discoverUrl(ngrokBin, { port, configFile: ngrokConfig, signal: signal() }); update(url); return url;
    });
    baseUrl = normalizeUrl(baseUrl); draft.baseUrl = baseUrl; saveDraft(draft);
  }
  const config = buildConfig({ workspace: ui.cwd, profile, mode, baseUrl, port, ngrokBin, ngrokConfig });
  if (!local) {
    let existingAccount = false;
    try { const state = JSON.parse(fs.readFileSync(path.resolve(SERVER, previous.MCP_OAUTH_STORE || '.private/oauth-state.json'), 'utf8')); existingAccount = Boolean(state.admin?.username && state.admin?.passwordHash); } catch {}
    const account = existingAccount ? await ui.inputValue('06 / Autorización de este MCP', { fallback: 'keep', options: [
      { value: 'keep', label: 'Conservar mi usuario y contraseña' }, { value: 'new', label: 'Definir una cuenta nueva' }
    ] }) : 'new';
    if (account === 'keep') config.MCP_OAUTH_STORE = previous.MCP_OAUTH_STORE || '.private/oauth-state.json';
    else {
      const username = await field('username', '06 / Usuario para autorizar el MCP', 'mi-pc', { validate: value => /^[A-Za-z0-9._@-]{2,80}$/.test(value) ? '' : 'Usa de 2 a 80 letras, números, puntos, guiones o @.' });
      const password = await ui.inputValue('Contraseña nueva para este MCP', { secret: true, hint: 'Mínimo 12 caracteres. Usa una contraseña distinta de tu cuenta de Google.', validate: value => value.length >= 12 ? '' : 'Usa al menos 12 caracteres.' });
      await ui.inputValue('Repite la contraseña', { secret: true, validate: value => value === password ? '' : 'Las contraseñas no coinciden.' });
      const { configureOAuthAdmin } = require(path.join(SERVER, 'lib/oauth-provider.js'));
      configureOAuthAdmin(path.join(SERVER, '.private/oauth-state.json'), username, password);
    }
  }
  writeEnv(config); writeCliConfig();
  fs.rmSync(path.join(ROOT, '.local/setup-draft.json'), { force: true });
  ui.event('guardado', 'Carpeta, permisos y conexión guardados', 'done'); info();
}
function cliConfig() {
  return { mcpServers: { 'mi-pc': { command: process.execPath, args: [path.join(ROOT, 'gemini-pc.cjs'), 'stdio'], cwd: ROOT, timeout: 60000, trust: false } } };
}
function writeCliConfig() {
  const file = path.join(ROOT, 'gemini-settings.fragment.json'); atomicWrite(file, JSON.stringify(cliConfig(), null, 2) + '\n'); return file;
}
function info() {
  const config = readConfig(); ui.cwd = config.ALLOWED_PATHS || ROOT; ui.event('carpeta', config.ALLOWED_PATHS);
  if (config.MCP_EXPOSURE_MODE === 'local') ui.event('Gemini CLI', 'Combina gemini-settings.fragment.json con .gemini/settings.json y comprueba /mcp');
  else {
    ui.event('URL MCP', `${config.MCP_PUBLIC_BASE_URL}/mcp`);
    ui.event('conectar', 'Gemini → Conectores → + → Agregar conector personalizado → pega la URL');
    ui.event('siguiente', 'Usa /iniciar para abrir el servidor y autorízalo desde Gemini');
  }
}
async function dependencies() {
  ui.event('Node.js', process.version, 'done');
  for (const [label, command, args] of [['Git', 'git', ['--version']], ['npm', process.platform === 'win32' ? 'cmd.exe' : 'npm', process.platform === 'win32' ? ['/d', '/s', '/c', 'npm.cmd', '--version'] : ['--version']]]) {
    const result = await run(command, args, { signal: signal(), timeout: 10000 }); ui.event(label, result.stdout, 'done');
  }
  const found = await ensureNgrok(readConfig(false)), config = readConfig(false);
  if (config.NGROK_BIN && config.NGROK_BIN !== found.binary) { config.NGROK_BIN = found.binary; writeEnv(config); }
}
async function startService() {
  normalUser();
  if (service) { ui.event('servidor', 'Ya está activo en esta sesión'); return; }
  const config = readConfig();
  if (config.MCP_EXPOSURE_MODE === 'local') throw new Error('Gemini CLI inicia este MCP por stdio. No necesita /iniciar.');
  if (config.MCP_AUTH_MODE !== 'oauth') throw new Error('Configura OAuth con /configurar-web antes de abrir la conexión web.');
  applyServerPatches(SERVER);
  if (config.MCP_EXPOSURE_MODE === 'ngrok') {
    config.NGROK_BIN = (await ensureNgrok(config)).binary;
    config.NGROK_CONFIG = await authNgrok(config.NGROK_BIN, config); writeEnv(config);
  }
  const child = spawn(process.execPath, [path.join(SERVER, 'mcp-supervisor.js')], {
    cwd: SERVER, env: { ...process.env, ...config, MCP_CONFIG_SOURCE: 'env' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  service = child; ui.status = 'Iniciando servidor';
  for (const stream of [child.stdout, child.stderr]) {
    let pending = '';
    stream.on('data', buffer => {
      pending += buffer.toString(); const lines = pending.split(/\r?\n/); pending = lines.pop().slice(-8192);
      for (const line of lines) if (line.trim()) ui.event('servidor', redact(line));
    });
  }
  child.once('error', error => { ui.event('servidor', error.message, 'error'); service = null; });
  child.once('close', (code, exitSignal) => {
    if (service === child) service = null;
    clearInterval(statusTimer); ui.status = 'Servidor detenido';
    ui.event('servidor', `Detenido${code ? ` · estado ${code}` : exitSignal ? ` · ${exitSignal}` : ''}`, code ? 'error' : 'info');
  });
  statusTimer = setInterval(() => {
    try {
      const status = JSON.parse(fs.readFileSync(path.join(SERVER, '.runtime/status.json'), 'utf8'));
      if (status.supervisorPid !== child.pid) return;
      ui.status = status.serverHealthy ? (status.mode !== 'ngrok' || status.ngrokApiReachable ? 'MCP disponible' : 'Esperando túnel') : 'Iniciando servidor'; ui.render();
    } catch {}
  }, 1000);
  ui.event('URL MCP', `${config.MCP_PUBLIC_BASE_URL}/mcp`); ui.event('control', 'Usa /estado para consultar o /detener para cerrar el servidor');
}
async function stopService() {
  const child = service; if (!child) { ui.event('servidor', 'No hay un proceso iniciado desde este panel'); return; }
  await ui.task('servidor', 'Cerrando el servidor y su túnel', async update => {
    await terminateTree(child);
    if (child.exitCode === null && child.signalCode === null) await Promise.race([new Promise(resolve => child.once('close', resolve)), new Promise(resolve => { const timer = setTimeout(() => { terminateTree(child, true).finally(resolve); }, 8000); timer.unref(); })]);
    if (service === child) service = null; clearInterval(statusTimer); ui.status = 'Preparado'; update('Servidor detenido');
  });
}
async function stdio() {
  checkNode(); normalUser(); const config = readConfig();
  applyServerPatches(SERVER);
  const env = { ...process.env, ...config, MCP_CONFIG_SOURCE: 'env', MCP_AUTH_MODE: 'none', MCP_EXPOSURE_MODE: 'local', MCP_PUBLIC_BASE_URL: '', PUBLIC_BASE_URL: '', NGROK_URL: '' };
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(SERVER, 'mcp-server.js'), '--stdio'], { cwd: SERVER, env, stdio: 'inherit' });
    const stop = () => { terminateTree(child).catch(error => console.error(redact(error.message))); }; process.on('SIGINT', stop); process.on('SIGTERM', stop);
    child.once('error', reject); child.once('close', (code, exitSignal) => {
      process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); process.exitCode = code ?? (exitSignal ? 1 : 0); resolve();
    });
  });
}
function help() {
  ui.event('MCP Gemini', 'Instalación y configuración de tu servidor local');
  for (const [command, description] of [
    ['/configurar-web', 'Carpeta, permisos, ngrok automático y OAuth'], ['/configurar-cli', 'Conexión local para Gemini CLI'],
    ['/iniciar · /detener', 'Controlar el servidor y su túnel'], ['/dependencias', 'Comprobar requisitos e instalar ngrok si falta'],
    ['/estado', 'Ver carpeta compartida y URL MCP'], ['/pendientes', 'Revisar solicitudes de acciones'],
    ['/aprobar ID', 'Aprobar una solicitud concreta'], ['/salir', 'Cerrar el panel']
  ]) ui.event('comando', `${command}  ${description}`);
}
async function dispatch(text) {
  const [raw, ...args] = text.trim().split(/\s+/), command = raw.replace(/^\//, '');
  if (['salir', 'exit', 'quit'].includes(command)) return false;
  operation = new AbortController(); ui.busy = true; ui.cancelAction = () => operation.abort();
  try {
    if (command === 'instalar') { await install(); await ensureNgrok(readConfig(false)); }
    else if (command === 'configurar-web' || command === 'web') await setup(false);
    else if (command === 'configurar-cli' || command === 'cli') await setup(true);
    else if (command === 'iniciar') await startService();
    else if (command === 'detener') await stopService();
    else if (['dependencias', 'doctor'].includes(command)) await dependencies();
    else if (['info', 'estado'].includes(command)) info();
    else if (command === 'cli-config') { readConfig(); ui.event('Gemini CLI', writeCliConfig(), 'done'); }
    else if (command === 'pendientes' || command === 'aprobar') {
      normalUser(); const config = readConfig(), id = args[0];
      if (command === 'aprobar' && (!id || !/^[a-zA-Z0-9_-]+$/.test(id))) throw new Error('Indica el ID exacto de la solicitud pendiente.');
      const result = await run(process.execPath, [path.join(SERVER, 'mcpctl-admin.js'), command === 'pendientes' ? 'pending' : 'approve', ...(id ? [id] : [])], { cwd: SERVER, env: { ...process.env, ...config }, signal: signal() });
      for (const line of result.stdout.split(/\r?\n/)) if (line.trim()) ui.event('acción', line);
    } else if (['ayuda', '--help', '-h', 'help', ''].includes(command)) help();
    else throw new Error('Comando desconocido. Escribe /ayuda para ver las opciones.');
  } finally { ui.busy = false; ui.cancelAction = null; operation = null; if (!service) ui.status = 'Preparado'; ui.render(); }
  return true;
}
async function main() {
  checkNode();
  const args = process.argv.slice(2), plainMode = args.includes('--sin-ui') || args.includes('--no-ui');
  if ((!args.length || args[0] === 'gui') && !plainMode) return require('./gemini-gui.cjs').main(args.slice(args[0] === 'gui' ? 1 : 0));
  if (args[0] === '--terminal') args.shift();
  const command = args.filter(x => !['--sin-ui', '--no-ui'].includes(x)).join(' ');
  if (command === 'stdio') return stdio();
  ui = new TerminalUI({ cwd: readConfig(false).ALLOWED_PATHS || ROOT, fullscreen: !plainMode && !['--help', '-h'].includes(command), version: VERSION });
  ui.commands = COMMANDS; ui.mount();
  const onTerm = () => { operation?.abort(); if (service) terminateTree(service).catch(() => {}); ui.close(); process.exitCode = 130; };
  process.once('SIGTERM', onTerm);
  try {
    if (command) {
      try { if (!await dispatch(command)) return; }
      catch (error) {
        if (!ui.active) throw error;
        ui.event(error.name === 'Cancelled' || error.name === 'AbortError' ? 'cancelado' : 'error', redact(error.message), error.name === 'Cancelled' || error.name === 'AbortError' ? 'info' : 'error');
      }
    } else help();
    if (ui.active) {
      while (true) {
        let text;
        try { text = await ui.inputValue('Tu PC · MCP Gemini', { command: true, hint: '/configurar-web  /iniciar  /dependencias  /estado  /ayuda' }); }
        catch (error) { if (error instanceof Cancelled) break; throw error; }
        if (!text) continue;
        ui.event('❯', text);
        try { if (!await dispatch(text)) break; }
        catch (error) { ui.event(error.name === 'Cancelled' || error.name === 'AbortError' ? 'cancelado' : 'error', redact(error.message), error.name === 'Cancelled' || error.name === 'AbortError' ? 'info' : 'error'); }
      }
    } else if (service) {
      const stop = () => { if (service) terminateTree(service).catch(() => {}); }; process.once('SIGINT', stop);
      await new Promise(resolve => service.once('close', resolve)); process.removeListener('SIGINT', stop);
    }
  } finally { process.removeListener('SIGTERM', onTerm); if (service) await stopService(); clearInterval(statusTimer); ui.close(); }
}

module.exports = { ROOT, SERVER, REPOSITORY, COMMIT, PROFILES, inside, validateWorkspace, normalizeUrl, buildConfig, writeEnv, readConfig, saveDraft, cliConfig };
if (require.main === module) main().catch(error => { console.error(`Error: ${redact(error.message)}`); process.exitCode = 1; });

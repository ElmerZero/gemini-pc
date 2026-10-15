'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const api = require('../gemini-pc.cjs');
const processes = require('./process.cjs');
const ngrok = require('./ngrok.cjs');
const { applyServerPatches } = require('./server-patches.cjs');
const VERSION = require('../package.json').version;
const ENGINE_VERSION = '4.6.1';
const APPROVAL_REVIEW_LIMIT = 16 * 1024;

function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, text, { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function alive(child) { return Boolean(child && child.exitCode === null && child.signalCode === null); }
function abortError() { return new DOMException('Operación cancelada.', 'AbortError'); }

class AppEngine extends EventEmitter {
  constructor({ root = api.ROOT, server = path.join(root, 'servidor'), home = os.homedir(),
    run = processes.run, spawn: spawnProcess = spawn, terminateTree = processes.terminateTree,
    ngrok: ngrokApi = ngrok, installer, configureOAuthAdmin, approvalsFactory,
    clock = Date.now, readinessTimeout = 45000, pollInterval = 500 } = {}) {
    super();
    Object.assign(this, { root, server, home, run, spawnProcess, terminateTree, ngrokApi,
      installer, configureOAuthAdmin, approvalsFactory, clock, readinessTimeout, pollInterval });
    this.events = [];
    this.runtime = { state: 'stopped', message: 'Tu PC está desconectada.', endpoint: '' };
    this.operation = { busy: false, label: '' };
    this.child = null;
    this.controller = null;
    this.activeOperation = null;
    this.statusTimer = null;
    this.sequence = 0;
    this.approvals = [];
    this.secrets = new Set();
    this.disposed = false;
    this.closing = false;
    this.disposePromise = null;
    this.stopChildPromise = null;
    this.stoppingChild = null;
  }

  _config() {
    const file = path.join(this.server, '.env');
    if (!fs.existsSync(file)) return {};
    const result = {};
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (line.trimStart().startsWith('#')) continue;
      const index = line.indexOf('=');
      if (index < 1) continue;
      let value = line.slice(index + 1).trim();
      if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
      result[line.slice(0, index).trim()] = value;
    }
    return result;
  }

  _account(config) {
    const account = readJson(path.resolve(this.server, config.MCP_OAUTH_STORE || '.private/oauth-state.json'))?.admin;
    return { configured: Boolean(account?.username && account?.passwordHash), username: typeof account?.username === 'string' ? account.username : '' };
  }

  _safe(text, limit = 2000) {
    let value = processes.redact(String(text)).replace(/((?:["']?)(?:authtoken|password|access_token|refresh_token|authorization|client_secret|passwordHash)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,}\]]+)/gi, '$1[oculto]');
    value = value.replace(/(--(?:password|token|authtoken|secret|api[-_]key|client[-_]secret)(?:\s+|=))(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,}\]]+)/gi, '$1[oculto]');
    for (const secret of this.secrets) if (secret) value = value.split(secret).join('[oculto]');
    return Buffer.byteLength(value, 'utf8') > limit
      ? Buffer.from(value, 'utf8').subarray(0, limit).toString('utf8').replace(/\uFFFD$/, '') : value;
  }

  getState() {
    const config = this._config();
    this._refreshApprovals(config);
    return {
      version: VERSION,
      configured: config.MCP_SETUP_COMPLETE === '1',
      config: {
        workspace: config.ALLOWED_PATHS || path.join(this.root, 'workspace'),
        profile: Object.keys(api.PROFILES).find(key => api.PROFILES[key] === config.MCP_ACCESS_GROUPS) || 'archivos',
        target: config.MCP_EXPOSURE_MODE === 'local' ? 'cli' : 'web',
        mode: config.MCP_EXPOSURE_MODE || 'ngrok',
        baseUrl: config.MCP_PUBLIC_BASE_URL || '',
        port: Number(config.PORT) || 3000
      },
      account: this._account(config),
      ngrok: { configured: Boolean(this.ngrokApi.findAuthConfig(this.server, config.NGROK_CONFIG) || process.env.NGROK_AUTHTOKEN) },
      runtime: { ...this.runtime },
      operation: { ...this.operation },
      events: this.events.map(event => ({ ...event })),
      approvals: this.approvals.map(item => ({ ...item }))
    };
  }

  _emit() { this.emit('change', this.getState()); }
  _event(kind, message) {
    this.events.push({ id: ++this.sequence, time: new Date(this.clock()).toISOString(), kind, message: this._safe(message) });
    this.events = this.events.slice(-80);
    this._emit();
  }
  _progress(label) { this.operation.label = label; this._emit(); }
  _signal() { return this.controller?.signal; }

  async _perform(label, work) {
    if (this.disposed || this.closing) throw new Error('El panel está cerrándose o ya está cerrado. Vuelve a abrir la aplicación.');
    if (this.operation.busy) throw new Error('Espera a que termine la operación actual o pulsa Cancelar.');
    this.controller = new AbortController();
    this.operation = { busy: true, label };
    this._emit();
    const promise = Promise.resolve().then(work);
    this.activeOperation = promise;
    try { await promise; }
    catch (error) {
      const cancelled = error.name === 'AbortError' || this._signal()?.aborted;
      const message = cancelled ? 'Operación cancelada. Puedes volver a intentarlo.' : this._safe(error.message || error);
      this._event(cancelled ? 'info' : 'error', message);
      if (cancelled) throw abortError();
      throw new Error(message);
    } finally {
      this.operation = { busy: false, label: '' };
      this.controller = null;
      this.activeOperation = null;
      this.secrets.clear();
      this._emit();
    }
    return this.getState();
  }

  _checkNode() {
    if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Instala Node.js 22 o posterior para abrir la conexión.');
    if (process.getuid?.() === 0) throw new Error('Abre la aplicación con tu usuario normal, sin sudo.');
  }

  async _install() {
    if (this.installer) return this.installer(this._signal());
    this._checkNode();
    if (!fs.existsSync(path.join(this.server, 'mcp-server.js'))) {
      if (fs.existsSync(this.server)) throw new Error('La carpeta del motor está incompleta. Conserva sus archivos y reinstala la aplicación en otra carpeta.');
      this._progress('Preparando el motor de conexión…');
      const staging = fs.mkdtempSync(path.join(this.root, '.instalacion-'));
      try {
        const options = { cwd: staging, signal: this._signal() };
        await this.run('git', ['init', '-q'], options);
        await this.run('git', ['remote', 'add', 'origin', api.REPOSITORY], options);
        await this.run('git', ['fetch', '--quiet', '--depth=1', 'origin', api.COMMIT], options);
        await this.run('git', ['checkout', '--quiet', '--detach', 'FETCH_HEAD'], options);
        if ((await this.run('git', ['rev-parse', 'HEAD'], options)).stdout.trim() !== api.COMMIT) throw new Error('No se pudo verificar la descarga del motor. Vuelve a intentarlo.');
        this._signal()?.throwIfAborted();
        fs.renameSync(staging, this.server);
      } finally { if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true }); }
    }
    const installed = readJson(path.join(this.server, 'package.json'));
    if (installed?.name !== 'mcp-server-local' || installed?.version !== ENGINE_VERSION || !fs.existsSync(path.join(this.server, 'mcp-supervisor.js'))) {
      throw new Error(`La carpeta del motor no corresponde a la versión compatible ${ENGINE_VERSION}. Conserva tus archivos y reinstala la aplicación en otra carpeta.`);
    }
    if (!fs.existsSync(path.join(this.server, 'node_modules/@simplewebauthn/server'))) {
      this._progress('Instalando los componentes necesarios…');
      const windows = process.platform === 'win32';
      await this.run(windows ? 'cmd.exe' : 'npm', windows
        ? ['/d', '/s', '/c', 'npm.cmd', 'ci', '--ignore-scripts', '--no-fund', '--no-audit']
        : ['ci', '--ignore-scripts', '--no-fund', '--no-audit'], { cwd: this.server, signal: this._signal(), timeout: 180000 });
    }
    applyServerPatches(this.server);
  }

  async setup(data = {}) {
    return this._perform('Guardando tu conexión…', async () => {
      if (alive(this.child)) throw new Error('Desconecta tu PC antes de cambiar la configuración.');
      const previous = this._config(), state = this.getState();
      const target = data.target ?? state.config.target;
      if (!['web', 'cli'].includes(target)) throw new Error('Elige Gemini web o Gemini CLI.');
      const profile = data.profile ?? state.config.profile;
      if (!Object.hasOwn(api.PROFILES, profile)) throw new Error('Elige uno de los permisos disponibles.');
      if (profile === 'proyecto' && data.allowCommands !== true && previous.MCP_ACCESS_GROUPS !== api.PROFILES.proyecto) {
        throw new Error('Confirma que deseas permitir comandos de proyecto.');
      }
      const port = Number(data.port ?? state.config.port);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('El puerto debe estar entre 1024 y 65535.');
      const mode = target === 'cli' ? 'local' : (data.mode ?? (state.config.mode === 'local' ? 'ngrok' : state.config.mode));
      if (!['local', 'ngrok', 'direct'].includes(mode) || (target === 'web' && mode === 'local')) throw new Error('Elige una conexión automática o tu propio dominio HTTPS.');
      let baseUrl = mode === 'local' ? '' : String(data.baseUrl ?? previous.MCP_PUBLIC_BASE_URL ?? '').trim();
      if (baseUrl === 'auto') baseUrl = '';
      if (baseUrl || mode === 'direct') baseUrl = api.normalizeUrl(baseUrl);
      const password = typeof data.password === 'string' ? data.password : '';
      const authtoken = typeof data.authtoken === 'string' ? data.authtoken.trim() : '';
      if (password) this.secrets.add(password);
      if (authtoken) this.secrets.add(authtoken);
      const username = String(data.username || state.account.username || 'mi-pc').trim();
      const newAccount = target === 'web' && (!state.account.configured || Boolean(password));
      if (newAccount && !/^[A-Za-z0-9._@-]{2,80}$/.test(username)) throw new Error('El usuario debe tener entre 2 y 80 letras, números, puntos, guiones o @.');
      if (newAccount && password.length < 12) throw new Error('Crea una contraseña de al menos 12 caracteres para autorizar esta conexión.');
      await this._install();
      const suggested = path.join(this.root, 'workspace');
      const requestedWorkspace = String(data.workspace || previous.ALLOWED_PATHS || suggested).trim().replace(/^(["'])(.*)\1$/, '$2');
      if (path.resolve(requestedWorkspace) === suggested) fs.mkdirSync(suggested, { recursive: true });
      const workspace = api.validateWorkspace(requestedWorkspace, this.server);
      let ngrokBin = previous.NGROK_BIN || 'ngrok', ngrokConfig = previous.NGROK_CONFIG || '';
      if (mode === 'ngrok') {
        this._progress('Preparando la conexión segura…');
        const found = await this.ngrokApi.ensureNgrok(this.root, { configured: ngrokBin, signal: this._signal() });
        ngrokBin = found.binary;
        ngrokConfig = authtoken ? this.ngrokApi.saveAuthtoken(this.server, authtoken) : this.ngrokApi.findAuthConfig(this.server, ngrokConfig);
        if (!ngrokConfig && !process.env.NGROK_AUTHTOKEN) throw new Error('Pega tu token de ngrok para conectar este equipo a Gemini web.');
        if (!baseUrl) {
          this._progress('Obteniendo la dirección de tu PC…');
          baseUrl = api.normalizeUrl(await this.ngrokApi.discoverUrl(ngrokBin, { port, configFile: ngrokConfig, signal: this._signal() }));
        }
      }
      this._signal()?.throwIfAborted();
      const config = api.buildConfig({ workspace, profile, mode, baseUrl, port, ngrokBin, ngrokConfig });
      if (previous.MCP_OAUTH_STORE) config.MCP_OAUTH_STORE = previous.MCP_OAUTH_STORE;
      if (data.profile === undefined && previous.MCP_ACCESS_GROUPS) {
        for (const key of ['MCP_ACCESS_PROFILE', 'MCP_ACCESS_GROUPS', 'MCP_TOOL_ALLOWLIST', 'MCP_TOOL_DENYLIST']) {
          if (previous[key] !== undefined) config[key] = previous[key];
        }
      }
      if (newAccount) {
        const configure = this.configureOAuthAdmin || require(path.join(this.server, 'lib/oauth-provider.js')).configureOAuthAdmin;
        configure(path.resolve(this.server, config.MCP_OAUTH_STORE), username, password);
      }
      api.writeEnv(config, this.server);
      this._writeCliFragment();
      this.runtime = { state: 'stopped', message: target === 'cli' ? 'Lista para conectar con Gemini CLI.' : 'Lista para conectar tu PC.', endpoint: '' };
      this._event('success', 'Tu carpeta, permisos y conexión están guardados.');
    });
  }

  _cliConfig() {
    return { command: process.execPath, args: [path.join(this.root, 'gemini-pc.cjs'), 'stdio'], cwd: this.root, timeout: 60000, trust: false };
  }
  _writeCliFragment() {
    atomicWrite(path.join(this.root, 'gemini-settings.fragment.json'), JSON.stringify({ mcpServers: { 'mi-pc': this._cliConfig() } }, null, 2) + '\n');
  }
  async installCli() {
    return this._perform('Conectando Gemini CLI…', async () => {
      if (this._config().MCP_SETUP_COMPLETE !== '1') throw new Error('Guarda primero la carpeta que deseas compartir.');
      const file = path.join(this.home, '.gemini/settings.json');
      const existed = fs.existsSync(file);
      let settings = {};
      if (existed) {
        try { settings = JSON.parse(fs.readFileSync(file, 'utf8')); }
        catch { throw new Error('La configuración de Gemini CLI no contiene JSON válido. No se modificó el archivo.'); }
        if (!settings || typeof settings !== 'object' || Array.isArray(settings) || (settings.mcpServers !== undefined && (!settings.mcpServers || typeof settings.mcpServers !== 'object' || Array.isArray(settings.mcpServers)))) {
          throw new Error('El formato de la configuración de Gemini CLI no es compatible. No se modificó el archivo.');
        }
        fs.copyFileSync(file, `${file}.backup-${this.clock()}-${crypto.randomUUID().slice(0, 8)}`);
      }
      settings.mcpServers = { ...settings.mcpServers, 'mi-pc': this._cliConfig() };
      atomicWrite(file, JSON.stringify(settings, null, 2) + '\n');
      this._event('success', 'Gemini CLI está configurado. Vuelve a abrirlo para ver la conexión mi-pc.');
    });
  }

  async start() {
    return this._perform('Conectando tu PC…', async () => {
      if (alive(this.child)) return;
      const config = this._config();
      if (config.MCP_SETUP_COMPLETE !== '1') throw new Error('Guarda primero tu configuración.');
      if (config.MCP_EXPOSURE_MODE === 'local') {
        this._event('info', 'Gemini CLI abre esta conexión automáticamente cuando lo utilizas.'); return;
      }
      if (config.MCP_AUTH_MODE !== 'oauth') throw new Error('Guarda de nuevo la configuración web para activar su autorización segura.');
      await this._install();
      if (config.MCP_EXPOSURE_MODE === 'ngrok') {
        config.NGROK_BIN = (await this.ngrokApi.ensureNgrok(this.root, { configured: config.NGROK_BIN, signal: this._signal() })).binary;
        config.NGROK_CONFIG = this.ngrokApi.findAuthConfig(this.server, config.NGROK_CONFIG);
        if (!config.NGROK_CONFIG && !process.env.NGROK_AUTHTOKEN) throw new Error('Añade tu token de ngrok en Configuración.');
      }
      this._signal()?.throwIfAborted();
      const startedAt = this.clock();
      const environment = { ...process.env, ...config, MCP_CONFIG_SOURCE: 'env' };
      const ownProcessGroup = process.platform !== 'win32';
      const child = this.spawnProcess(process.execPath, [path.join(this.server, 'mcp-supervisor.js')], {
        cwd: this.server, env: environment, windowsHide: true, detached: ownProcessGroup, stdio: ['ignore', 'pipe', 'pipe']
      });
      child.mcpOwnProcessGroup = ownProcessGroup;
      this.child = child;
      this.runtime = { state: 'starting', message: 'Estamos abriendo la conexión segura…', endpoint: '' };
      let spawnError = null;
      for (const stream of [child.stdout, child.stderr]) {
        let pending = '';
        stream?.on('data', chunk => {
          const lines = (pending + chunk.toString()).split(/\r?\n/); pending = lines.pop().slice(-8192);
          for (const line of lines) if (/error|fatal|ERR_NGROK_/i.test(line)) this._event('error', line);
        });
      }
      child.once('error', error => { spawnError = error; });
      child.once('close', code => {
        if (this.child !== child) return;
        this.child = null;
        clearInterval(this.statusTimer);
        if (this.stoppingChild !== child && this.runtime.state !== 'stopped') {
          this.runtime = { state: 'error', message: 'Se cerró la conexión. Puedes volver a conectar tu PC.', endpoint: '' };
          this._event('error', `La conexión se detuvo${code ? ` (estado ${code})` : ''}.`);
        }
      });
      const update = () => this._readRuntime(child, startedAt, environment);
      this.statusTimer = setInterval(update, this.pollInterval);
      this.statusTimer.unref?.();
      this._emit();
      try {
        while (this.clock() - startedAt < this.readinessTimeout) {
          this._signal()?.throwIfAborted();
          if (spawnError) throw spawnError;
          if (!alive(child)) throw new Error('No se pudo abrir la conexión. Revisa la actividad e inténtalo de nuevo.');
          update();
          if (this.runtime.state === 'running') { this._event('success', 'Tu PC está lista para conectarse desde Gemini.'); return; }
          await new Promise(resolve => setTimeout(resolve, Math.min(this.pollInterval, 200)));
        }
        throw new Error('La conexión tardó demasiado. Revisa tu conexión a Internet y el token de ngrok.');
      } catch (error) {
        await this._stopChild();
        this.runtime = { state: error.name === 'AbortError' ? 'stopped' : 'error', message: this._safe(error.message), endpoint: '' };
        throw error;
      }
    });
  }

  _readRuntime(child, startedAt, config) {
    if (this.child !== child || !alive(child)) return;
    const runtimeDirectory = path.resolve(this.server, config.MCP_RUNTIME_DIR || process.env.MCP_RUNTIME_DIR || '.runtime');
    const status = readJson(path.join(runtimeDirectory, 'status.json'));
    const updated = Date.parse(status?.updatedAt);
    if (!status || status.supervisorPid !== child.pid || !Number.isFinite(updated) || updated < startedAt - 1000 || this.clock() - updated > 15000) {
      if (this.runtime.state === 'running') {
        this.runtime = { state: 'starting', message: 'Esperando una actualización de la conexión…', endpoint: '' };
        this._emit();
      }
      return;
    }
    let endpoint = '';
    try { if (status.publicUrl) endpoint = `${api.normalizeUrl(status.publicUrl)}/mcp`; } catch {}
    const ready = status.serverHealthy === true && status.serverRunning === true && Boolean(endpoint)
      && (config.MCP_EXPOSURE_MODE !== 'ngrok' || (status.ngrokRunning === true && status.ngrokApiReachable === true));
    const next = ready
      ? { state: 'running', message: 'Tu PC está conectada y disponible para Gemini.', endpoint }
      : { state: 'starting', message: status.lastError ? this._safe(status.lastError) : 'Esperando la conexión segura…', endpoint: '' };
    if (JSON.stringify(next) !== JSON.stringify(this.runtime)) { this.runtime = next; this._emit(); }
  }

  _stopChild() {
    if (this.stopChildPromise) return this.stopChildPromise;
    clearInterval(this.statusTimer);
    this.statusTimer = null;
    const child = this.child;
    if (!alive(child)) { this.child = null; return Promise.resolve(); }
    this.stoppingChild = child;
    const waitForExit = timeout => new Promise(resolve => {
      if (!alive(child)) { resolve(); return; }
      const closed = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => { child.removeListener('close', closed); resolve(); }, timeout);
      child.once('close', closed);
    });
    this.stopChildPromise = (async () => {
      // Stop the complete owned tree in one operation, including descendants
      // that would otherwise outlive a supervisor terminated by SIGTERM.
      await this.terminateTree(child, true);
      await waitForExit(8000);
      if (alive(child)) { await this.terminateTree(child, true); await waitForExit(3000); }
      if (alive(child)) throw new Error('No se pudo cerrar la conexión. Vuelve a pulsar Desconectar.');
      if (this.child === child) this.child = null;
    })().finally(() => {
      this.stopChildPromise = null;
      if (this.stoppingChild === child) this.stoppingChild = null;
    });
    return this.stopChildPromise;
  }

  async stop() {
    if (this.operation.busy) {
      this.cancel();
      try { await this.activeOperation; } catch {}
      // Let the operation's finally block release the exclusive operation slot.
      await Promise.resolve();
    }
    return this._perform('Desconectando tu PC…', async () => {
      await this._stopChild();
      this.runtime = { state: 'stopped', message: 'Tu PC está desconectada.', endpoint: '' };
      this._event('info', 'Conexión cerrada.');
    });
  }

  cancel() {
    this.controller?.abort();
    return this.getState();
  }

  async doctor() {
    return this._perform('Comprobando tu equipo…', async () => {
      this._checkNode();
      this._event('success', `Node.js ${process.version} está disponible.`);
      await this._install();
      if ((this._config().MCP_EXPOSURE_MODE || 'ngrok') === 'ngrok') {
        const result = await this.ngrokApi.ensureNgrok(this.root, { configured: this._config().NGROK_BIN, signal: this._signal() });
        this._event('success', `${result.version || 'ngrok'} está disponible.`);
      }
      this._event('success', 'Los componentes de la conexión están preparados.');
    });
  }

  _approvalsManager(config = this._config()) {
    const file = path.resolve(this.server, config.MCP_APPROVALS_STORE || '.runtime/approvals.json');
    if (this.approvalsFactory) return this.approvalsFactory(file);
    const { ApprovalsManager } = require(path.join(this.server, 'lib/approvals.js'));
    return new ApprovalsManager(file);
  }
  _publicApproval(item) {
    const args = item.args && typeof item.args === 'object' && !Array.isArray(item.args) ? item.args : {};
    const lines = [];
    // These fields describe the executable, its arguments and its target; other
    // fields may contain credentials or file contents and stay out of the UI.
    for (const key of ['command', 'cmd', 'runner', 'script', 'cwd', 'path', 'source', 'destination', 'target']) {
      if (typeof args[key] === 'string') lines.push(`${key}: ${args[key]}`);
    }
    if (Array.isArray(args.args)) {
      let hideNext = false;
      const argv = args.args.filter(value => typeof value === 'string').map(value => {
        if (hideNext) { hideNext = false; return '[oculto]'; }
        hideNext = /^(?:--?)?(?:password|pass|token|secret|api[-_]key|authtoken|authorization|client[-_]secret)$/i.test(value);
        return value;
      });
      lines.push(`args: ${JSON.stringify(argv)}`);
    }
    if (typeof args.shell === 'boolean') lines.push(`shell: ${args.shell}`);
    if (Number.isFinite(args.timeoutMs)) lines.push(`timeoutMs: ${args.timeoutMs}`);
    const detailsFull = this._safe(lines.join('\n'), Infinity);
    const consequencesFull = typeof item.consequences === 'string' ? this._safe(item.consequences, Infinity) : '';
    const pathsFull = Array.isArray(item.affectedPaths)
      ? item.affectedPaths.filter(value => typeof value === 'string').map(value => this._safe(value, Infinity)) : [];
    const reviewTruncated = [detailsFull, consequencesFull, ...pathsFull].reduce((size, value) => size + Buffer.byteLength(value, 'utf8'), 0) > APPROVAL_REVIEW_LIMIT;
    let remaining = APPROVAL_REVIEW_LIMIT;
    const visible = value => {
      const text = this._safe(value, remaining);
      remaining -= Buffer.byteLength(text, 'utf8');
      return text;
    };
    const details = visible(detailsFull);
    const consequences = visible(consequencesFull);
    const affectedPaths = pathsFull.map(visible).filter(Boolean);
    return {
      id: String(item.id), tool: this._safe(item.tool), clientId: this._safe(item.clientId),
      summary: this._safe(item.argsSummary || item.tool), expiresAt: item.expiresAt,
      details, consequences, affectedPaths, reviewTruncated
    };
  }
  _refreshApprovals(config = this._config()) {
    // Polling is read-only: the upstream manager creates its store on construction,
    // so do not construct it until both the module and the store exist.
    const file = path.resolve(this.server, config.MCP_APPROVALS_STORE || '.runtime/approvals.json');
    if (!this.approvalsFactory && (!fs.existsSync(file) || !fs.existsSync(path.join(this.server, 'lib/approvals.js')))) {
      this.approvals = []; return;
    }
    try {
      this.approvals = this._approvalsManager(config).listPending().map(item => this._publicApproval(item));
    } catch {
      // A temporarily unavailable store must not break the dashboard or retain
      // stale requests that the user could mistake for current authorizations.
      this.approvals = [];
    }
  }
  async listApprovals() {
    this._refreshApprovals();
    this._emit();
    return this.approvals.map(item => ({ ...item }));
  }
  _approvalId(id) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error('Elige una solicitud válida de la lista.');
    return id;
  }
  async approve(id) {
    return this._perform('Autorizando la solicitud…', async () => {
      const validId = this._approvalId(id), manager = this._approvalsManager();
      const pending = manager.listPending().find(item => item.id === validId);
      if (!pending) throw new Error('La solicitud ya no está pendiente. Actualiza la lista e inténtalo de nuevo.');
      if (this._publicApproval(pending).reviewTruncated) {
        throw new Error('La solicitud es demasiado extensa para revisarla completa. Recházala y pide a Gemini una acción más pequeña.');
      }
      manager.approve(validId);
      await this.listApprovals();
      this._event('success', 'Solicitud autorizada. Gemini puede volver a intentar la acción.');
    });
  }
  async reject(id) {
    return this._perform('Rechazando la solicitud…', async () => {
      this._approvalsManager().reject(this._approvalId(id), 'Rechazada desde el panel local.');
      await this.listApprovals();
      this._event('info', 'Solicitud rechazada.');
    });
  }
  dispose() {
    if (this.disposed) return Promise.resolve();
    if (this.disposePromise) return this.disposePromise;
    // Close the operation gate before any await so no new child can replace the
    // one being stopped. A failed close remains closed to work, but is retryable.
    this.closing = true;
    this.controller?.abort();
    this.disposePromise = (async () => {
      // Cut an existing public connection immediately, even while installation
      // or another action is still acknowledging its cancellation.
      const results = await Promise.allSettled([this.activeOperation, this._stopChild()]);
      if (results[1].status === 'rejected') throw results[1].reason;
      // A starting action must have stopped too before the panel can close.
      await this._stopChild();
      this.disposed = true;
      this.runtime = { state: 'stopped', message: 'Tu PC está desconectada.', endpoint: '' };
      this.removeAllListeners();
    })().finally(() => { this.disposePromise = null; });
    return this.disposePromise;
  }
}

module.exports = { AppEngine };

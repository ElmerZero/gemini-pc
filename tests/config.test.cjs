'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const api = require('../gemini-pc.cjs');

test('la carpeta compartida no puede incluir el código ni el estado OAuth', () => {
  const temporary = fs.mkdtempSync(path.join(api.ROOT, '.test-path-'));
  try {
    const server = path.join(temporary, 'servidor');
    const workspace = path.join(temporary, 'proyectos');
    fs.mkdirSync(server); fs.mkdirSync(workspace);
    assert.equal(api.validateWorkspace(workspace, server), fs.realpathSync(workspace));
    assert.throws(() => api.validateWorkspace(temporary, server), /separada/);
    assert.throws(() => api.validateWorkspace(server, server), /separada/);
    if (process.platform !== 'win32') {
      const link = path.join(temporary, 'alias');
      fs.symlinkSync(server, link);
      assert.throws(() => api.validateWorkspace(link, server), /separada/);
    }
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

test('la configuración web exige HTTPS y el modo predeterminado excluye comandos y escritorio', () => {
  const config = api.buildConfig({ workspace: '/proyectos', baseUrl: 'https://ejemplo.ngrok-free.dev/mcp' });
  assert.equal(config.MCP_PUBLIC_BASE_URL, 'https://ejemplo.ngrok-free.dev');
  assert.equal(config.MCP_AUTH_MODE, 'oauth');
  assert.equal(config.HOST, '127.0.0.1');
  assert.equal(config.MCP_FULL_ACCESS, '0');
  assert.equal(config.MCP_RUN_AS_ROOT, '0');
  assert.ok(!config.MCP_ACCESS_GROUPS.split(',').includes('command_execution'));
  assert.equal(config.MCP_DESKTOP_ENABLED, '0');
  for (const value of ['http://ejemplo.com', 'https://user:password@ejemplo.com', 'https://ejemplo.com/?token=abc', 'https://localhost', 'https://ejemplo.com/otra-ruta']) {
    assert.throws(() => api.normalizeUrl(value));
  }
});

test('la escritura de configuración rechaza inyección de nuevas variables', () => {
  const temporary = fs.mkdtempSync(path.join(api.ROOT, '.test-env-'));
  try {
    assert.throws(() => api.writeEnv({ ALLOWED_PATHS: '/proyectos\nMCP_FULL_ACCESS=1' }, temporary));
    assert.equal(fs.existsSync(path.join(temporary, '.env')), false);
    api.writeEnv({ ALLOWED_PATHS: 'C:\\Mis proyectos', MCP_FULL_ACCESS: '0' }, temporary);
    assert.match(fs.readFileSync(path.join(temporary, '.env'), 'utf8'), /C:\\Mis proyectos/);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

test('Gemini CLI se inicia por stdio sin incluir contraseñas en su configuración', () => {
  const config = api.cliConfig();
  assert.equal(config.mcpServers['mi-pc'].args.at(-1), 'stdio');
  assert.equal(config.mcpServers['mi-pc'].trust, false);
  assert.equal(config.mcpServers['mi-pc'].env, undefined);
});

test('el borrador recupera las respuestas sin conservar contraseñas ni authtokens', () => {
  const temporary = fs.mkdtempSync(path.join(api.ROOT, '.test-draft-'));
  try {
    const file = path.join(temporary, 'draft.json');
    api.saveDraft({ workspace: 'E:\\Proyectos de ejemplo\\Mi app', profile: 'archivos', port: '3000', mode: 'ngrok', password: 'SECRETO-QUE-NO-DEBE-GUARDARSE', authtoken: 'TOKEN-QUE-NO-DEBE-GUARDARSE' }, file);
    const data = fs.readFileSync(file, 'utf8');
    assert.equal(JSON.parse(data).workspace, 'E:\\Proyectos de ejemplo\\Mi app');
    assert.doesNotMatch(data, /SECRETO|TOKEN|password|authtoken/);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

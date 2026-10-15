'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const api = require('../gemini-pc.cjs');
const { applyServerPatches } = require('../lib/server-patches.cjs');

const sourceFiles = ['package.json', 'mcp-server.js', 'lib/full-control-tools.js'];
const sources = new Map();
let missingUpstream = '';
for (const file of sourceFiles) {
  const result = spawnSync('git', ['-C', api.SERVER, 'show', `${api.COMMIT}:${file}`], {
    encoding: 'utf8', windowsHide: true, maxBuffer: 2 * 1024 * 1024
  });
  if (result.error || result.status !== 0) {
    missingUpstream = `No está disponible el código upstream fijado ${api.COMMIT}; se necesitan Git y el checkout de servidor para probar sus parches.`;
    break;
  }
  sources.set(file, result.stdout);
}
const requiresUpstream = { skip: missingUpstream || false };

function fixture(t, { eol = '\n' } = {}) {
  const directory = fs.mkdtempSync(path.join(api.ROOT, '.test-server-patches-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const [file, source] of sources) {
    const target = path.join(directory, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source.replace(/\r?\n/g, eol));
  }
  return directory;
}
function snapshot(directory) {
  return Object.fromEntries(sourceFiles.map(file => [file, fs.readFileSync(path.join(directory, file), 'utf8')]));
}

test('aplica las mejoras a una instalación limpia del commit fijado y conserva JavaScript válido', requiresUpstream, t => {
  const directory = fixture(t);
  const result = applyServerPatches(directory);
  assert.equal(result.id, 'workspace-guidance-v1');
  assert.deepEqual(result.changed.map(file => file.split(path.sep).join('/')), ['mcp-server.js', 'lib/full-control-tools.js']);
  const patched = snapshot(directory);
  assert.equal(patched['package.json'], sources.get('package.json'));
  assert.match(patched['mcp-server.js'], /instructions:\s*\[/);
  assert.match(patched['mcp-server.js'], /list_files\(\{"path":"\."\}\)/);
  assert.match(patched['mcp-server.js'], /Path is outside allowed roots or escapes through a symbolic link/);
  assert.match(patched['lib/full-control-tools.js'], /isRepository: false/);
  for (const file of sourceFiles.filter(file => file.endsWith('.js'))) {
    assert.doesNotThrow(() => new vm.Script(patched[file], { filename: file }));
  }
});

test('volver a aplicar conserva ediciones ajenas y finales de línea de Windows sin duplicar instrucciones', requiresUpstream, t => {
  const directory = fixture(t, { eol: '\r\n' });
  const serverFile = path.join(directory, 'mcp-server.js');
  const toolsFile = path.join(directory, 'lib/full-control-tools.js');
  fs.appendFileSync(serverFile, '\r\n// Ajuste local anterior al parche.\r\n');
  applyServerPatches(directory);
  fs.appendFileSync(toolsFile, '\r\n// Ajuste local posterior al parche.\r\n');
  const first = snapshot(directory);
  assert.deepEqual(applyServerPatches(directory).changed, []);
  assert.deepEqual(snapshot(directory), first);
  assert.match(first['mcp-server.js'], /Ajuste local anterior al parche/);
  assert.match(first['lib/full-control-tools.js'], /Ajuste local posterior al parche/);
  assert.doesNotMatch(first['mcp-server.js'], /(?<!\r)\n/);
  assert.equal(first['mcp-server.js'].split('// Gemini PC: workspace-guidance-v1').length - 1, 1);
});

test('un cambio incompatible en el segundo archivo impide modificar el primero', requiresUpstream, t => {
  const directory = fixture(t);
  const toolsFile = path.join(directory, 'lib/full-control-tools.js');
  const original = fs.readFileSync(toolsFile, 'utf8');
  fs.writeFileSync(toolsFile, original.replace("'Shows branch and working tree status for a repository.'", "'Descripción personalizada que requiere revisión.'"));
  const before = snapshot(directory);
  assert.throws(() => applyServerPatches(directory), /cambios incompatibles.*full-control-tools/);
  assert.deepEqual(snapshot(directory), before);
  assert.deepEqual(fs.readdirSync(directory).filter(file => file.endsWith('.tmp')), []);
});

test('un ancla duplicada se rechaza antes de escribir los archivos', requiresUpstream, t => {
  const directory = fixture(t);
  const toolsFile = path.join(directory, 'lib/full-control-tools.js');
  fs.appendFileSync(toolsFile, "\n// 'Shows branch and working tree status for a repository.'\n");
  const before = snapshot(directory);
  assert.throws(() => applyServerPatches(directory), /cambios incompatibles/);
  assert.deepEqual(snapshot(directory), before);
});

test('una versión upstream no compatible se rechaza sin cambiar código', requiresUpstream, t => {
  const directory = fixture(t);
  const packageFile = path.join(directory, 'package.json');
  const metadata = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
  metadata.version = '4.7.0';
  fs.writeFileSync(packageFile, JSON.stringify(metadata));
  const before = snapshot(directory);
  assert.throws(() => applyServerPatches(directory), /Se requiere MCP 4\.6\.1/);
  assert.deepEqual(snapshot(directory), before);
});

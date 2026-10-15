'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ngrok = require('../lib/ngrok.cjs');
const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures', name));
const temporary = () => fs.mkdtempSync(path.join(__dirname, '.ngrok-test-'));

test('el paquete oficial seleccionado corresponde a Windows x64 y no necesita PowerShell para extraerse', () => {
  const spec = ngrok.source('win32', 'x64');
  assert.equal(new URL(spec.url).hostname, 'bin.equinox.io');
  assert.match(spec.url, /windows-amd64\.zip$/);
  assert.equal(ngrok.extractZip(fixture('windows.zip'), spec.binary).toString(), 'MZ-test-executable');
});

test('un ZIP con traversal, un enlace o un CRC incorrecto no puede instalar un ejecutable', () => {
  assert.throws(() => ngrok.extractZip(fixture('traversal.zip'), 'ngrok.exe'), /no contiene/);
  assert.throws(() => ngrok.extractZip(fixture('symlink.zip'), 'ngrok.exe'), /regular/);
  const damaged = fixture('windows.zip');
  const central = damaged.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  damaged.writeUInt32LE(123, central + 16);
  assert.throws(() => ngrok.extractZip(damaged, 'ngrok.exe'), /integridad/);
});

test('extrae un TAR estándar y rechaza archivos dañados', () => {
  assert.match(ngrok.extractTar(fixture('linux.tgz'), 'ngrok').toString(), /ngrok version 3\.99/);
  assert.throws(() => ngrok.extractTar(Buffer.from('incompleto'), 'ngrok'));
});

test('si falta ngrok en PATH lo instala en una ruta con espacios y lo reutiliza inmediatamente', async () => {
  const root = path.join(temporary(), 'Mi app & proyectos con espacios');
  fs.mkdirSync(root);
  let downloads = 0;
  const checkVersion = async binary => fs.existsSync(binary) ? 'ngrok version 3.99.0-fixture' : '';
  const options = { platform: 'win32', arch: 'x64', checkVersion, fetchArchive: async () => { downloads++; return fixture('windows.zip'); } };
  try {
    const result = await ngrok.ensureNgrok(root, options);
    assert.equal(result.installed, true);
    assert.equal(result.binary, path.join(root, '.tools', 'ngrok.exe'));
    assert.equal(fs.readFileSync(result.binary, 'utf8'), 'MZ-test-executable');
    const again = await ngrok.ensureNgrok(root, options);
    assert.equal(again.installed, false); assert.equal(again.binary, result.binary); assert.equal(downloads, 1);
  } finally { fs.rmSync(path.dirname(root), { recursive: true, force: true }); }
});

test('un fallo de descarga permite reintentar sin conservar un ejecutable parcial', async () => {
  const root = temporary();
  const checkVersion = async binary => fs.existsSync(binary) ? 'ngrok version 3.99.0-fixture' : '';
  try {
    await assert.rejects(ngrok.ensureNgrok(root, { platform: 'win32', arch: 'x64', checkVersion, fetchArchive: async () => { throw new Error('sin conexión'); } }), /sin conexión/);
    assert.deepEqual(fs.readdirSync(path.join(root, '.tools')), []);
    const result = await ngrok.ensureNgrok(root, { platform: 'win32', arch: 'x64', checkVersion, fetchArchive: async () => fixture('windows.zip') });
    assert.equal(result.installed, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('una instalación existente no se vuelve a descargar', async () => {
  const root = temporary();
  try {
    const result = await ngrok.ensureNgrok(root, { configured: 'agente-existente', checkVersion: async binary => binary === 'agente-existente' ? 'ngrok version 3.99' : '', fetchArchive: async () => { throw new Error('no debe descargarse'); } });
    assert.equal(result.binary, 'agente-existente'); assert.equal(result.installed, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('el agente extraído se ejecuta desde una ruta con espacios sin modificar PATH', { skip: process.platform === 'win32' }, async () => {
  const root = path.join(temporary(), 'ruta con espacios & proyecto'); fs.mkdirSync(root);
  const pathBefore = process.env.PATH;
  try {
    const result = await ngrok.ensureNgrok(root, { platform: 'linux', arch: 'x64', fetchArchive: async () => fixture('linux.tgz'),
      checkVersion: async binary => fs.existsSync(binary) ? ngrok.version(binary) : '' });
    assert.match(result.version, /3\.99\.0-fixture/); assert.equal(process.env.PATH, pathBefore);
  } finally { fs.rmSync(path.dirname(root), { recursive: true, force: true }); }
});

test('guarda el authtoken en un archivo local y rechaza nuevas líneas', () => {
  const root = temporary();
  try {
    const file = ngrok.saveAuthtoken(root, 'SOLO-PRUEBA-ESTE-NO-ES-UN-TOKEN-REAL');
    assert.ok(ngrok.findAuthConfig(root)); assert.equal(ngrok.findAuthConfig(root), file);
    assert.throws(() => ngrok.saveAuthtoken(root, 'token\ninject: yes'));
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

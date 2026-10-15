'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { preparePublic, PUBLIC_FILES, OPTIONAL_FILES } = require('../scripts/prepare-public.cjs');

function write(root, relative, data) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-public-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const file of PUBLIC_FILES) write(root, file, `Public fixture for ${file}\n`);
  return root;
}
function tree(root, prefix = '') {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(item => item.isDirectory()
    ? tree(path.join(root, item.name), prefix + item.name + '/') : [prefix + item.name]).sort();
}
function verifyManifest(destination, expectedFiles) {
  const manifest = fs.readFileSync(path.join(destination, 'SHA256SUMS.txt'), 'utf8').trimEnd().split('\n');
  assert.equal(manifest.length, expectedFiles.length);
  const listed = [];
  for (const line of manifest) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    assert.ok(match, `Entrada SHA256 inválida: ${line}`);
    listed.push(match[2]);
    const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(destination, match[2]))).digest('hex');
    assert.equal(match[1], actual, match[2]);
  }
  assert.deepEqual(listed, [...expectedFiles].sort());
  assert.deepEqual(tree(destination), [...expectedFiles, 'SHA256SUMS.txt'].sort());
}

test('la copia pública incluye solo la allowlist y genera un manifiesto nuevo de los bytes copiados', t => {
  const root = fixture(t);
  const privateFiles = [
    '.env', '.private/account.json', '.runtime/status.json', '.local/setup.json', '.tools/ngrok',
    'servidor/mcp-server.js', 'servidor/.env', 'workspace/private.txt', 'gemini-settings.fragment.json',
    'VISTA-GRAFICA.jpg', 'VISTA-PREVIA.png', '.git/config', '.git/objects/history', 'SHA256SUMS.txt',
    'lib/unreviewed.cjs', 'tests/fixture-secret.txt', 'docs/old-screenshot.jpg'
  ];
  for (const file of privateFiles) write(root, file, 'SYNTHETIC-PRIVATE-CONTENT');
  write(root, OPTIONAL_FILES[0], Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  const result = preparePublic({ root });
  assert.equal(result.destination, path.join(root, 'para-github', 'gemini-pc'));
  assert.ok(result.files.includes('scripts/prepare-public.cjs'));
  assert.ok(result.files.includes('tests/public-package.test.cjs'));
  assert.ok(result.files.includes('README.md'));
  assert.ok(result.files.includes('docs/interfaz.jpg'));
  verifyManifest(result.destination, [...PUBLIC_FILES, ...OPTIONAL_FILES]);
  for (const file of tree(result.destination)) {
    assert.ok(!fs.readFileSync(path.join(result.destination, file)).includes(Buffer.from('SYNTHETIC-PRIVATE-CONTENT')), file);
  }
  assert.equal(fs.existsSync(path.join(result.destination, '.git')), false);
});

test('regenerar es idempotente y actualiza archivos permitidos y sus hashes', t => {
  const root = fixture(t);
  const destination = path.join(root, 'para-github', 'custom-fixture');
  preparePublic({ root, destination });
  const original = fs.readFileSync(path.join(destination, 'SHA256SUMS.txt'), 'utf8');
  preparePublic({ root, destination });
  assert.equal(fs.readFileSync(path.join(destination, 'SHA256SUMS.txt'), 'utf8'), original);
  write(root, 'LEEME.md', 'Updated public documentation\n');
  preparePublic({ root, destination });
  assert.equal(fs.readFileSync(path.join(destination, 'LEEME.md'), 'utf8'), 'Updated public documentation\n');
  assert.notEqual(fs.readFileSync(path.join(destination, 'SHA256SUMS.txt'), 'utf8'), original);
  verifyManifest(destination, PUBLIC_FILES);
});

test('los residuos en un destino existente bloquean toda escritura y no se eliminan', t => {
  const root = fixture(t);
  const { destination } = preparePublic({ root });
  const oldReadme = fs.readFileSync(path.join(destination, 'README.md'), 'utf8');
  const oldManifest = fs.readFileSync(path.join(destination, 'SHA256SUMS.txt'), 'utf8');
  write(root, 'README.md', 'This source update must not be copied.');
  write(destination, '.env', 'SYNTHETIC-DESTINATION-SECRET');
  assert.throws(() => preparePublic({ root }), /inesperad/i);
  assert.equal(fs.readFileSync(path.join(destination, '.env'), 'utf8'), 'SYNTHETIC-DESTINATION-SECRET');
  assert.equal(fs.readFileSync(path.join(destination, 'README.md'), 'utf8'), oldReadme);
  assert.equal(fs.readFileSync(path.join(destination, 'SHA256SUMS.txt'), 'utf8'), oldManifest);
});

test('las carpetas vacías inesperadas del destino también se rechazan sin borrarlas', t => {
  const root = fixture(t);
  const { destination } = preparePublic({ root });
  fs.mkdirSync(path.join(destination, 'workspace'));
  assert.throws(() => preparePublic({ root }), /carpeta inesperada/);
  assert.equal(fs.statSync(path.join(destination, 'workspace')).isDirectory(), true);
});

test('un hardlink en destino no permite sobrescribir un archivo ajeno al paquete', t => {
  const root = fixture(t);
  const { destination } = preparePublic({ root });
  const external = path.join(root, 'private-note.txt');
  fs.writeFileSync(external, 'PRIVATE-CONTENT-MUST-NOT-CHANGE');
  const target = path.join(destination, 'README.md');
  fs.unlinkSync(target);
  fs.linkSync(external, target);
  assert.throws(() => preparePublic({ root }), /enlace|hardlink/i);
  assert.equal(fs.readFileSync(external, 'utf8'), 'PRIVATE-CONTENT-MUST-NOT-CHANGE');
});

test('un destino fuera de para-github y una fuente faltante se rechazan antes de crear archivos', t => {
  const root = fixture(t);
  for (const destination of [root, path.join(root, 'workspace'), path.join(root, 'para-github'), path.join(root, 'para-github', '..', 'outside')]) {
    assert.throws(() => preparePublic({ root, destination }), /subcarpeta/);
  }
  fs.unlinkSync(path.join(root, 'ui/app.js'));
  assert.throws(() => preparePublic({ root }), /ENOENT/);
  assert.equal(fs.existsSync(path.join(root, 'para-github')), false);
});

test('los enlaces de fuente, destino y sus carpetas se rechazan sin seguirlos', t => {
  const root = fixture(t);
  const outside = path.join(root, 'private-target');
  fs.mkdirSync(outside);
  const probe = path.join(root, 'link-probe');
  try { fs.symlinkSync(outside, probe, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) { t.skip('Este sistema no permite crear enlaces para la prueba.'); return; }
    throw error;
  }
  fs.unlinkSync(probe);

  fs.renameSync(path.join(root, 'lib'), path.join(root, 'saved-lib'));
  fs.symlinkSync(path.join(root, 'saved-lib'), path.join(root, 'lib'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => preparePublic({ root }), /enlace/i);
  assert.equal(fs.existsSync(path.join(root, 'para-github')), false);
  fs.unlinkSync(path.join(root, 'lib'));
  fs.renameSync(path.join(root, 'saved-lib'), path.join(root, 'lib'));

  fs.symlinkSync(outside, path.join(root, 'para-github'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => preparePublic({ root }), /enlace/i);
  assert.deepEqual(fs.readdirSync(outside), []);
  fs.unlinkSync(path.join(root, 'para-github'));

  const { destination } = preparePublic({ root });
  fs.renameSync(path.join(destination, 'ui'), path.join(root, 'saved-ui'));
  fs.symlinkSync(outside, path.join(destination, 'ui'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => preparePublic({ root }), /enlace/i);
  assert.deepEqual(fs.readdirSync(outside), []);
  fs.unlinkSync(path.join(destination, 'ui'));
});

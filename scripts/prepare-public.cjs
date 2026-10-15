#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Only these reviewed files may enter a public copy. Never discover source files
// recursively: an added credential, workspace or screenshot must stay private.
const PUBLIC_FILES = Object.freeze([
  '.gitignore',
  'Abrir Gemini.vbs',
  'LEEME.md',
  'LICENSE',
  'README.md',
  'UPSTREAM.json',
  'VALIDACION.md',
  'gemini-gui.cjs',
  'gemini-pc.cjs',
  'iniciar-gemini.cmd',
  'iniciar-gemini.sh',
  'package.json',
  'lib/app-engine.cjs',
  'lib/gui-server.cjs',
  'lib/ngrok.cjs',
  'lib/process.cjs',
  'lib/server-patches.cjs',
  'lib/terminal-ui.cjs',
  'scripts/prepare-public.cjs',
  'tests/app-engine-review.test.cjs',
  'tests/app-engine.test.cjs',
  'tests/config.test.cjs',
  'tests/fixtures/linux.tgz',
  'tests/fixtures/symlink.zip',
  'tests/fixtures/traversal.zip',
  'tests/fixtures/windows.zip',
  'tests/gemini-oauth.cjs',
  'tests/gui-server.test.cjs',
  'tests/ngrok.test.cjs',
  'tests/process.test.cjs',
  'tests/public-package.test.cjs',
  'tests/server-patches.test.cjs',
  'tests/terminal-ui.test.cjs',
  'tests/ui-client.test.cjs',
  'tests/workspace-guidance.test.cjs',
  'ui/app.js',
  'ui/index.html',
  'ui/styles.css'
]);
const OPTIONAL_FILES = Object.freeze(['docs/interfaz.jpg']);
const MANIFEST = 'SHA256SUMS.txt';

function within(parent, target) {
  const relative = path.relative(parent, target);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function inspectPath(root, target, { missing = false, file = false, rejectHardlinks = false } = {}) {
  const relative = path.relative(root, target);
  if (!within(root, target)) throw new Error('La ruta debe permanecer dentro del directorio de preparación.');
  let current = root;
  const segments = relative.split(path.sep);
  for (let i = 0; i < segments.length; i++) {
    current = path.join(current, segments[i]);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) {
      if (missing && error.code === 'ENOENT') return null;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`No se permiten enlaces simbólicos: ${relative}`);
    const last = i === segments.length - 1;
    if ((!last || !file) && !stat.isDirectory()) throw new Error(`Se esperaba una carpeta: ${relative}`);
    if (last && file && !stat.isFile()) throw new Error(`Se esperaba un archivo regular: ${relative}`);
    if (last && file && rejectHardlinks && stat.nlink > 1) throw new Error(`El destino contiene un enlace duro (hardlink): ${relative}`);
    if (last) return stat;
  }
}

function inspectDestination(destination, files) {
  if (!fs.existsSync(destination)) return;
  const allowedFiles = new Set([...files, MANIFEST]);
  const allowedDirectories = new Set();
  for (const file of files) {
    const pieces = file.split('/');
    for (let i = 1; i < pieces.length; i++) allowedDirectories.add(pieces.slice(0, i).join('/'));
  }
  const visit = (directory, prefix = '') => {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix + item.name;
      const fullPath = path.join(directory, item.name);
      const stat = fs.lstatSync(fullPath);
      if (stat.isSymbolicLink()) throw new Error(`El destino contiene un enlace simbólico: ${relative}`);
      if (stat.isDirectory()) {
        if (!allowedDirectories.has(relative)) throw new Error(`El destino contiene una carpeta inesperada: ${relative}`);
        visit(fullPath, relative + '/');
      } else if (!stat.isFile() || !allowedFiles.has(relative)) {
        throw new Error(`El destino contiene un archivo inesperado: ${relative}`);
      } else if (stat.nlink > 1) {
        throw new Error(`El destino contiene un enlace duro (hardlink): ${relative}`);
      }
    }
  };
  visit(destination);
}

function preparePublic({ root = path.resolve(__dirname, '..'), destination } = {}) {
  root = path.resolve(root);
  const rootStat = fs.lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('La raíz debe ser una carpeta real, sin enlaces simbólicos.');
  root = fs.realpathSync(root);
  const outputRoot = path.join(root, 'para-github');
  destination = destination === undefined ? path.join(outputRoot, 'gemini-pc') : path.resolve(destination);
  if (!within(outputRoot, destination)) throw new Error('El destino debe ser una subcarpeta de root/para-github.');
  inspectPath(root, destination, { missing: true });

  // Finish every safety check before creating or overwriting anything.
  const files = [...PUBLIC_FILES];
  for (const name of PUBLIC_FILES) inspectPath(root, path.join(root, name), { file: true });
  for (const name of OPTIONAL_FILES) {
    if (inspectPath(root, path.join(root, name), { missing: true, file: true })) files.push(name);
  }
  files.sort();
  inspectDestination(destination, files);

  fs.mkdirSync(destination, { recursive: true });
  const checksums = [];
  for (const name of files) {
    const source = path.join(root, name);
    const target = path.join(destination, name);
    inspectPath(root, source, { file: true });
    inspectPath(root, target, { missing: true, file: true, rejectHardlinks: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    checksums.push(`${crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex')}  ${name}`);
  }
  inspectPath(root, path.join(destination, MANIFEST), { missing: true, file: true, rejectHardlinks: true });
  fs.writeFileSync(path.join(destination, MANIFEST), checksums.join('\n') + '\n');
  return { destination, files, manifest: MANIFEST };
}

module.exports = { preparePublic, PUBLIC_FILES, OPTIONAL_FILES };
if (require.main === module) {
  if (process.argv.length > 2) {
    console.error('Uso: node scripts/prepare-public.cjs');
    process.exitCode = 1;
  } else {
    try {
      const result = preparePublic();
      console.log(`Copia pública preparada en para-github/gemini-pc (${result.files.length} archivos y SHA256SUMS.txt).`);
    } catch (error) {
      console.error(`No se pudo preparar la copia pública: ${error.message}`);
      process.exitCode = 1;
    }
  }
}

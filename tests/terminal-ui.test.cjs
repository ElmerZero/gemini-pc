'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { TerminalUI, Cancelled, plain } = require('../lib/terminal-ui.cjs');

function terminal() {
  const input = new EventEmitter(), output = new EventEmitter();
  input.isTTY = true; input.isRaw = false; input.setRawMode = value => { input.isRaw = value; };
  input.resume = () => {}; input.pause = () => {};
  output.isTTY = true; output.columns = 100; output.rows = 30; output.write = () => {};
  const ui = new TerminalUI({ input, output, cwd: 'E:\\Proyectos de ejemplo\\Mi app' });
  ui.active = true; ui.color = true;
  return ui;
}

test('los menús responden a flechas y confirman el valor elegido', async () => {
  const ui = terminal();
  const promise = ui.inputValue('Permisos', { fallback: 'lectura', options: [
    { value: 'lectura', label: 'Sólo lectura' }, { value: 'archivos', label: 'Leer y editar' }
  ] });
  ui.onKey('', { name: 'down' }); ui.onKey('', { name: 'return' });
  assert.equal(await promise, 'archivos');
});

test('no muestra secretos ni los incluye en el historial y conserva sus espacios', async () => {
  const ui = terminal(), secret = ' Contraseña secreta con espacios ';
  const promise = ui.inputValue('Contraseña', { secret: true });
  ui.onKey(secret, {});
  assert.doesNotMatch(ui.frame().map(plain).join('\n'), /Contraseña secreta con espacios/);
  ui.onKey('', { name: 'return' }); assert.equal(await promise, secret); assert.deepEqual(ui.history, []);
});

test('la entrada mantiene rutas con espacios y permite volver al panel con Escape', async () => {
  const ui = terminal(), workspace = 'E:\\Proyectos de ejemplo\\Mi app';
  const promise = ui.inputValue('Carpeta'); ui.onKey(workspace, {}); ui.onKey('', { name: 'return' });
  assert.equal(await promise, workspace);
  const cancel = ui.inputValue('Puerto'); ui.onKey('', { name: 'escape' });
  await assert.rejects(cancel, Cancelled);
});

test('la interfaz se mantiene dentro de la terminal y conserva la entrada al reducir el tamaño', async () => {
  const ui = terminal();
  for (let i = 0; i < 12; i++) ui.event('dependencia', 'Ruta larga con espacios y estado comprobado ' + i, 'done');
  const promise = ui.inputValue('Conexión', { fallback: 'ngrok', options: [
    { value: 'ngrok', label: 'ngrok · instalación automática', description: 'Descarga el agente y continúa.' },
    { value: 'direct', label: 'Mi proxy HTTPS ya está configurado', description: 'Usar un dominio propio.' }
  ] });
  for (const [columns, rows] of [[120, 32], [80, 24], [60, 18], [40, 14]]) {
    const frame = ui.frame(columns, rows).map(plain);
    assert.equal(frame.length, rows - 1);
    assert.ok(frame.every(line => line.length <= columns - 4), `${columns}×${rows} debe evitar saltos de línea`);
    assert.ok(frame.some(line => line.startsWith('❯ ')), 'el campo de entrada debe permanecer visible');
  }
  ui.onKey('', { name: 'return' }); await promise;
});

test('la ayuda por tubería no contiene secuencias de terminal y conserva todos los comandos', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'gemini-pc.cjs'), '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0); assert.doesNotMatch(result.stdout, /\x1b/);
  assert.match(result.stdout, /\/configurar-web/); assert.match(result.stdout, /\/dependencias/);
});

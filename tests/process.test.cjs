'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { run, redact } = require('../lib/process.cjs');

test('cancelar espera a que termine el proceso antes de devolver el control', async () => {
  const controller = new AbortController(); let pid;
  await assert.rejects(run(process.execPath, ['-e', 'console.log(process.pid);setInterval(()=>{},1000)'], {
    signal: controller.signal, onLine: line => { pid = Number(line); controller.abort(); }
  }), { name: 'AbortError' });
  assert.ok(pid);
  assert.throws(() => process.kill(pid, 0), /ESRCH|not found|no such process/i);
});

test('los mensajes de error redactan los campos de autenticación', () => {
  const value = redact('authtoken=TEST-TOKEN password="TEST PASSWORD" access_token: ABC123');
  assert.doesNotMatch(value, /TEST-TOKEN|TEST PASSWORD|ABC123/);
});

test('oculta credenciales completas de encabezados Bearer y campos JSON', () => {
  const value = redact('Authorization: Bearer SAMPLE-BEARER\nAuthorization=Basic SAMPLE-BASIC\n{"password":"SAMPLE-PASSWORD","client_secret":"SAMPLE-CLIENT-SECRET"}');
  assert.doesNotMatch(value, /SAMPLE-BEARER|SAMPLE-BASIC|SAMPLE-PASSWORD|SAMPLE-CLIENT-SECRET/);
  assert.equal((value.match(/\[oculto\]/g) || []).length, 4);
});

test('la cancelación termina el árbol real aunque un descendiente ignore SIGTERM', async () => {
  const controller = new AbortController();
  let descendant;
  const script = "const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','process.on(\"SIGTERM\",()=>{}); console.log(\"ready\"); setInterval(()=>{},1000)'],{stdio:['ignore','pipe','ignore']}); child.stdout.once('data',()=>console.log(child.pid)); setInterval(()=>{},1000);";
  await assert.rejects(run(process.execPath, ['-e', script], { signal: controller.signal,
    onLine: line => { descendant = Number(line); controller.abort(); } }), { name: 'AbortError' });
  assert.ok(descendant);
  // On Windows this verifies taskkill /T /F; on POSIX it verifies the dedicated
  // group is force-terminated even when a descendant ignores SIGTERM.
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.throws(() => process.kill(descendant, 0), /ESRCH|not found|no such process/i);
});

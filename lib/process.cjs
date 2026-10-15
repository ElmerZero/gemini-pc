'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');

function redact(value) {
  return String(value).replace(/(["']?(?:authtoken|password|access_token|refresh_token|authorization|client_secret|passwordHash)["']?\s*[=:]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(?:Bearer|Basic)\s+[^\s,;}\]]+|[^\s,;}\]]+)/gi, '$1[oculto]');
}

function run(command, args, { cwd, env = process.env, signal, timeout = 120000, onLine } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('Operación cancelada', 'AbortError')); return; }
    const ownProcessGroup = process.platform !== 'win32';
    const child = spawn(command, args, { cwd, env, windowsHide: true, detached: ownProcessGroup, stdio: ['ignore', 'pipe', 'pipe'] });
    child.mcpOwnProcessGroup = ownProcessGroup;
    let stdout = '', stderr = '', settled = false, timedOut = false, forceTimer;
    const stop = () => {
      // Cancellation must also stop descendants that ignore SIGTERM after their
      // parent exits. The group belongs only to this spawned operation.
      terminateTree(child, true).catch(() => child.kill('SIGKILL'));
      forceTimer = setTimeout(() => { if (!settled) terminateTree(child, true).catch(() => {}); }, 2000); forceTimer.unref();
    };
    signal?.addEventListener('abort', stop, { once: true });
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeout);
    timer.unref();
    function finish(error, result) {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(forceTimer); signal?.removeEventListener('abort', stop);
      error ? reject(error) : resolve(result);
    }
    for (const [stream, isError] of [[child.stdout, false], [child.stderr, true]]) {
      let pending = '';
      stream.on('data', buffer => {
        const text = buffer.toString();
        if (isError) stderr = (stderr + text).slice(-65536);
        else stdout = (stdout + text).slice(-65536);
        pending += text;
        const lines = pending.split(/\r?\n/); pending = lines.pop().slice(-8192);
        if (onLine) for (const line of lines) onLine(redact(line));
      });
    }
    child.once('error', error => finish(error));
    child.once('close', (code, exitSignal) => {
      if (signal?.aborted) return finish(new DOMException('Operación cancelada', 'AbortError'));
      if (timedOut) return finish(new Error(`${command} superó el tiempo de espera. Puedes reintentar.`));
      if (code !== 0) {
        const error = new Error(redact(stderr.trim() || stdout.trim() || `${command}: ${exitSignal || `estado ${code}`}`));
        error.code = code; return finish(error);
      }
      finish(null, { stdout: stdout.trim(), stderr: redact(stderr.trim()), code });
    });
  });
}

async function terminateTree(child, force = false) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
    try { await run(taskkill, ['/PID', String(child.pid), '/T', '/F'], { timeout: 10000 }); }
    catch (error) { if (child.exitCode === null && child.signalCode === null) throw error; }
  } else if (child.mcpOwnProcessGroup) {
    // Only children explicitly started in their own group may use a negative PID.
    // Never signal the app's inherited group or an unrelated process tree.
    try { process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  } else child.kill(force ? 'SIGKILL' : 'SIGTERM');
}

module.exports = { run, redact, terminateTree };

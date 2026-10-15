'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { run, redact } = require('./process.cjs');

const MAX_ARCHIVE = 64 * 1024 * 1024;
const MAX_BINARY = 128 * 1024 * 1024;

function source(platform = process.platform, arch = process.arch) {
  const system = { win32: 'windows', darwin: 'darwin', linux: 'linux' }[platform];
  const cpu = { x64: 'amd64', arm64: 'arm64', ia32: '386', arm: 'arm' }[arch];
  if (!system || !cpu) throw new Error(`No hay instalación automática de ngrok para ${platform}/${arch}. Usa https://ngrok.com/download.`);
  const format = platform === 'win32' ? 'zip' : 'tgz';
  return { url: `https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-${system}-${cpu}.${format}`, format, binary: platform === 'win32' ? 'ngrok.exe' : 'ngrok' };
}

async function download(url, { signal, onProgress = () => {} } = {}) {
  const abort = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(120000)]);
  let target = new URL(url);
  for (let redirects = 0; redirects <= 5; redirects++) {
    if (target.protocol !== 'https:' || !(target.hostname === 'bin.equinox.io' || target.hostname.endsWith('.equinox.io') || target.hostname.endsWith('.amazonaws.com') || target.hostname.endsWith('.cloudfront.net') || target.hostname.endsWith('.ngrok.com'))) {
      throw new Error('La descarga de ngrok salió de los distribuidores HTTPS permitidos.');
    }
    const response = await fetch(target, { redirect: 'manual', signal: abort });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location'); await response.body?.cancel();
      if (!location) throw new Error('La descarga de ngrok devolvió una redirección vacía.');
      target = new URL(location, target); continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`No se pudo descargar ngrok (HTTP ${response.status}). Reintenta o consulta https://ngrok.com/download.`); }
    const total = Number(response.headers.get('content-length')) || 0;
    if (total > MAX_ARCHIVE) { await response.body?.cancel(); throw new Error('El archivo de ngrok supera el límite de descarga.'); }
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > MAX_ARCHIVE) throw new Error('La descarga de ngrok supera el límite permitido.');
      chunks.push(chunk); onProgress(size, total);
    }
    return Buffer.concat(chunks);
  }
  throw new Error('La descarga de ngrok tuvo demasiadas redirecciones.');
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function extractZip(archive, binary) {
  let eocd = -1;
  for (let i = archive.length - 22; i >= Math.max(0, archive.length - 65557); i--) {
    if (archive.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('La descarga de ngrok no es un ZIP válido.');
  if (archive.readUInt16LE(eocd + 4) || archive.readUInt16LE(eocd + 6)) throw new Error('ZIP multipart no admitido.');
  const count = archive.readUInt16LE(eocd + 10);
  let offset = archive.readUInt32LE(eocd + 16);
  for (let entry = 0; entry < count; entry++) {
    if (offset + 46 > archive.length || archive.readUInt32LE(offset) !== 0x02014b50) throw new Error('El directorio ZIP está dañado.');
    const flags = archive.readUInt16LE(offset + 8), method = archive.readUInt16LE(offset + 10);
    const crc = archive.readUInt32LE(offset + 16), compressed = archive.readUInt32LE(offset + 20), size = archive.readUInt32LE(offset + 24);
    const nameSize = archive.readUInt16LE(offset + 28), extraSize = archive.readUInt16LE(offset + 30), commentSize = archive.readUInt16LE(offset + 32);
    const local = archive.readUInt32LE(offset + 42);
    const fileType = (archive.readUInt32LE(offset + 38) >>> 16) & 0o170000;
    const name = archive.subarray(offset + 46, offset + 46 + nameSize).toString('utf8');
    offset += 46 + nameSize + extraSize + commentSize;
    if (name !== binary && name !== `./${binary}`) continue;
    if (fileType && fileType !== 0o100000) throw new Error('El ejecutable de ngrok no es un archivo regular.');
    if ((flags & 1) || size <= 0 || size > MAX_BINARY || local + 30 > archive.length || archive.readUInt32LE(local) !== 0x04034b50) throw new Error('El ejecutable de ngrok no es válido.');
    const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
    if (start + compressed > archive.length) throw new Error('El archivo ZIP está incompleto.');
    const content = archive.subarray(start, start + compressed);
    const binaryBytes = method === 0 ? Buffer.from(content) : method === 8 ? zlib.inflateRawSync(content, { maxOutputLength: MAX_BINARY }) : null;
    if (!binaryBytes || binaryBytes.length !== size || crc32(binaryBytes) !== crc) throw new Error('Falló la comprobación de integridad del ZIP de ngrok.');
    return binaryBytes;
  }
  throw new Error(`El ZIP no contiene ${binary}.`);
}

function extractTar(archive, binary) {
  const tar = zlib.gunzipSync(archive, { maxOutputLength: MAX_BINARY + 1024 * 1024 });
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const text = (a, b) => header.subarray(a, b).toString().replace(/\0.*$/, '').trim();
    const size = parseInt(text(124, 136) || '0', 8);
    const expected = parseInt(text(148, 156), 8);
    const actual = [...header].reduce((sum, value, index) => sum + (index >= 148 && index < 156 ? 32 : value), 0);
    if (!Number.isSafeInteger(size) || size < 0 || expected !== actual || offset + 512 + size > tar.length) throw new Error('El archivo TAR de ngrok está dañado.');
    const name = text(0, 100), prefix = text(345, 500), type = header[156];
    if ((name === binary || name === `./${binary}`) && !prefix) {
      if (![0, 48].includes(type) || size <= 0 || size > MAX_BINARY) throw new Error('El ejecutable de ngrok no es un archivo regular.');
      return Buffer.from(tar.subarray(offset + 512, offset + 512 + size));
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error(`El archivo no contiene ${binary}.`);
}

async function version(binary) {
  try {
    const result = await run(binary, ['version'], { timeout: 10000 });
    return /^ngrok version 3\./im.test(result.stdout) ? result.stdout.split(/\r?\n/)[0] : '';
  } catch { return ''; }
}

async function ensureNgrok(root, { configured = '', signal, onProgress = () => {}, platform = process.platform, arch = process.arch, fetchArchive = download, checkVersion = version } = {}) {
  const spec = source(platform, arch), directory = path.join(root, '.tools'), destination = path.join(directory, spec.binary);
  for (const candidate of [...new Set([configured, destination, 'ngrok'].filter(Boolean))]) {
    const found = await checkVersion(candidate);
    if (found) return { binary: candidate, version: found, installed: false };
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const staging = fs.mkdtempSync(path.join(directory, '.ngrok-'));
  try {
    const bytes = await fetchArchive(spec.url, { signal, onProgress });
    const content = spec.format === 'zip' ? extractZip(bytes, spec.binary) : extractTar(bytes, spec.binary);
    signal?.throwIfAborted();
    const temporaryBinary = path.join(staging, spec.binary);
    fs.writeFileSync(temporaryBinary, content, { mode: 0o755 }); fs.chmodSync(temporaryBinary, 0o755);
    const installedVersion = await checkVersion(temporaryBinary);
    if (!installedVersion) throw new Error('ngrok se descargó pero no pudo ejecutarse. Revisa el antivirus o las restricciones del equipo.');
    signal?.throwIfAborted();
    fs.renameSync(temporaryBinary, destination);
    return { binary: destination, version: installedVersion, installed: true };
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}

function hasAuthtoken(file) {
  try {
    let value = fs.readFileSync(file, 'utf8').match(/^\s*authtoken\s*:\s*(.*?)\s*$/m)?.[1]?.trim() || '';
    if (value.startsWith('"')) value = JSON.parse(value);
    else if (value.startsWith("'")) value = value.replace(/^'|'$/g, '');
    else value = value.split('#')[0].trim();
    return value.length >= 16 && !/\s/.test(value);
  } catch { return false; }
}

function findAuthConfig(server, configured = '') {
  const home = os.homedir();
  const candidates = [configured, path.join(server, '.private/ngrok.yml'),
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'ngrok/ngrok.yml') : '',
    path.join(home, 'AppData/Local/ngrok/ngrok.yml'), path.join(home, 'Library/Application Support/ngrok/ngrok.yml'),
    path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'ngrok/ngrok.yml'), path.join(home, '.ngrok2/ngrok.yml')];
  return candidates.find(file => file && hasAuthtoken(file)) || '';
}

function saveAuthtoken(server, token) {
  if (!token || token.length < 16 || token.length > 4096 || /\s|[\x00-\x1f]/.test(token)) throw new Error('Introduce el authtoken completo de ngrok, sin espacios.');
  const directory = path.join(server, '.private'); fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const destination = path.join(directory, 'ngrok.yml'), temporary = path.join(directory, `.ngrok-${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, `version: 3\nagent:\n  authtoken: ${JSON.stringify(token)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, destination); fs.chmodSync(destination, 0o600);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  return destination;
}

function friendlyError(text) {
  const code = text.match(/ERR_NGROK_\d+/)?.[0];
  if (/authtoken|ERR_NGROK_(?:105|106|107|4018)/i.test(text)) return `Revisa el authtoken de ngrok en https://dashboard.ngrok.com/get-started/your-authtoken${code ? ` (${code})` : ''}.`;
  if (/ERR_NGROK_(?:334|108)/.test(text)) return `Hay otro agente o endpoint de ngrok activo${code ? ` (${code})` : ''}. Deténlo y vuelve a intentar.`;
  return `ngrok no pudo abrir el túnel${code ? ` (${code})` : ''}. Revisa tu conexión y tu cuenta de ngrok.`;
}

async function discoverUrl(binary, { port, configFile = '', signal, timeout = 25000 } = {}) {
  const args = ['http', `http://127.0.0.1:${port}`, '--log=stdout', '--log-format=json'];
  if (configFile) args.push('--config', configFile);
  const child = spawn(binary, args, { signal, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let tail = '', pending = '';
  try {
    return await new Promise((resolve, reject) => {
      let done = false;
      const finish = (error, result) => { if (done) return; done = true; clearTimeout(timer); error ? reject(error) : resolve(result); };
      const timer = setTimeout(() => finish(new Error(friendlyError(tail))), timeout);
      for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => {
        const text = bytes.toString(); tail = redact((tail + text).slice(-8192)); pending += text;
        const lines = pending.split(/\r?\n/); pending = lines.pop().slice(-8192);
        for (const line of lines) {
          try {
            const message = JSON.parse(line);
            if (message.url?.startsWith('https://') && /started tunnel|endpoint.*started/i.test(message.msg || '')) {
              const url = new URL(message.url);
              if (!url.username && !url.password && url.pathname === '/') finish(null, url.origin);
            }
          } catch {}
        }
      });
      child.once('error', error => finish(error));
      child.once('close', () => finish(signal?.aborted ? new DOMException('Operación cancelada', 'AbortError') : new Error(friendlyError(tail))));
    });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await Promise.race([new Promise(resolve => child.once('close', resolve)), new Promise(resolve => { const t = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 2000); t.unref(); })]);
    }
  }
}

module.exports = { source, download, crc32, extractZip, extractTar, version, ensureNgrok, findAuthConfig, saveAuthtoken, discoverUrl, friendlyError };

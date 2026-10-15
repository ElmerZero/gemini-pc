#!/usr/bin/env node
'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const { createGuiServer, openBrowser } = require('./lib/gui-server.cjs');

async function main(args = process.argv.slice(2)) {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Instala Node.js 22 o posterior para abrir la app.');
  if (process.getuid?.() === 0) throw new Error('Abre la app con tu usuario normal, sin sudo.');
  const portIndex = args.indexOf('--port');
  const port = portIndex >= 0 ? Number(args[portIndex + 1]) : 3210;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('El puerto del panel debe estar entre 1024 y 65535.');
  const { AppEngine } = require('./lib/app-engine.cjs');
  const instanceId = crypto.createHash('sha256').update(path.resolve(__dirname)).digest('hex').slice(0, 24);
  const app = createGuiServer({ engine: new AppEngine(), instanceId });
  let url;
  try { url = await app.listen(port); }
  catch (error) {
    await app.close();
    if (error.code !== 'EADDRINUSE') throw error;
    let existing;
    try { existing = await (await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(1500) })).json(); } catch {}
    if (existing?.app !== 'mcp-gemini-panel' || existing.instanceId !== instanceId) throw new Error(`El puerto ${port} está ocupado. Abre la app con --port 3211 para usar otro.`);
    url = `http://127.0.0.1:${port}`;
    console.log(`El panel ya está abierto: ${url}`);
    if (!args.includes('--no-open')) await openBrowser(url).catch(() => console.log('Abre esta dirección en tu navegador.'));
    return;
  }
  console.log(`MCP Gemini · Panel local\n${url}\n\nDeja esta ventana abierta mientras usas la app. Ctrl+C cierra el panel y su conexión.`);
  if (!args.includes('--no-open')) await openBrowser(url).catch(() => console.log('Abre la dirección anterior en tu navegador.'));
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    try { await app.close(); }
    catch (error) { console.error('No se pudo cerrar la app: ' + error.message); process.exitCode = 1; }
    finally { process.removeListener('SIGINT', close); process.removeListener('SIGTERM', close); }
  };
  process.once('SIGINT', close); process.once('SIGTERM', close);
  return app;
}

module.exports = { main };
if (require.main === module) main().catch(error => { console.error(`No se pudo abrir la app: ${error.message}`); process.exitCode = 1; });

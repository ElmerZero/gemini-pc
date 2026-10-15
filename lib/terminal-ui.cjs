'use strict';
const readline = require('node:readline');

const RGB = { text: '232;229;225', muted: '145;140;133', blue: '142;166;255', green: '147;192;117', red: '242;132;132', border: '53;53;53' };
const ESC = '\x1b[';
const plain = value => String(value).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x1f\x7f]/g, '');
const crop = (value, width) => {
  const text = plain(value); return text.length <= width ? text : text.slice(0, Math.max(0, width - 1)) + '…';
};
function clipAnsi(value, width) {
  const tokens = String(value).match(/\x1b\[[0-?]*[ -/]*[@-~]|[^\x1b]/gu) || [];
  let count = 0, result = '';
  for (const token of tokens) {
    if (token.startsWith('\x1b')) result += token;
    else { if (count >= width) break; result += token; count++; }
  }
  return result;
}
class Cancelled extends Error { constructor() { super('Operación cancelada. Tus respuestas se conservan.'); this.name = 'Cancelled'; } }

class TerminalUI {
  constructor({ input = process.stdin, output = process.stdout, fullscreen = true, cwd = process.cwd(), version = '1.1.0' } = {}) {
    this.input = input; this.output = output; this.version = version; this.cwd = cwd;
    this.active = Boolean(fullscreen && input.isTTY && output.isTTY && process.env.TERM !== 'dumb');
    this.color = !process.env.NO_COLOR; this.events = []; this.history = []; this.status = 'Preparado';
    this.started = Date.now(); this.pending = null; this.busy = false; this.scroll = 0;
    this.onKey = this.onKey.bind(this); this.render = this.render.bind(this);
  }
  paint(text, color = 'text', bold = false) {
    return this.active && this.color ? `${ESC}${bold ? '1;' : ''}38;2;${RGB[color]}m${text}${ESC}0m${ESC}48;2;15;15;15m` : String(text);
  }
  mount() {
    if (!this.active) return;
    readline.emitKeypressEvents(this.input);
    this.wasRaw = Boolean(this.input.isRaw); this.input.setRawMode(true); this.input.resume();
    this.output.write(`${ESC}?1049h${ESC}?25l${ESC}48;2;15;15;15m${ESC}2J`);
    this.input.on('keypress', this.onKey); this.output.on('resize', this.render);
    this.timer = setInterval(this.render, 160); this.timer.unref(); this.render();
  }
  close() {
    if (!this.active) return;
    clearInterval(this.timer); this.input.removeListener('keypress', this.onKey);
    this.output.removeListener('resize', this.render); this.input.setRawMode(this.wasRaw); this.input.pause();
    this.output.write(`${ESC}0m${ESC}?25h${ESC}?1049l`); this.active = false;
  }
  event(label, message, status = 'info') {
    const event = { label: plain(label), message: plain(message), status, time: Date.now() };
    this.events.push(event); if (this.events.length > 500) this.events.shift(); this.scroll = 0;
    if (!this.active) this.output.write(`${status === 'done' ? '✓' : status === 'error' ? '×' : '·'} ${event.label}  ${event.message}\n`);
    this.render(); return event;
  }
  async task(label, message, work) {
    const event = this.event(label, message, 'running');
    try {
      const result = await work(detail => { event.message = plain(detail); this.render(); });
      event.status = 'done'; this.render();
      if (!this.active) this.output.write(`✓ ${label}  Listo\n`);
      return result;
    } catch (error) { event.status = error.name === 'AbortError' ? 'info' : 'error'; this.render(); throw error; }
  }
  async inputValue(label, { fallback = '', secret = false, options, hint = '', command = false, validate } = {}) {
    if (!this.active) {
      for (;;) {
        const value = await this.lineInput(label, { fallback, secret, options });
        const error = validate?.(value);
        if (!error) return value;
        this.event('revisar', error, 'error');
      }
    }
    return new Promise((resolve, reject) => {
      this.pending = { label, fallback: String(fallback), secret, options, hint, command, validate,
        text: '', cursor: 0, selected: Math.max(0, options?.findIndex(x => x.value === fallback) ?? 0),
        history: this.history.length, resolve, reject, error: '' };
      this.scroll = 0; this.render();
    });
  }
  async lineInput(label, { fallback, secret, options }) {
    if (!this.input.isTTY) throw new Error('Este asistente necesita una terminal interactiva. Usa --help para ver comandos.');
    if (options) this.output.write(options.map((option, index) => `  ${index + 1}) ${option.label}`).join('\n') + '\n');
    if (secret) {
      this.output.write(`${label}: `);
      const wasRaw = Boolean(this.input.isRaw); this.input.setRawMode(true); this.input.resume();
      return new Promise((resolve, reject) => {
        let text = '';
        const done = (error, value) => {
          this.input.removeListener('data', data); this.input.setRawMode(wasRaw); this.input.pause();
          this.output.write('\n'); error ? reject(error) : resolve(value);
        };
        const data = buffer => {
          for (const char of buffer.toString()) {
            if (char === '\u0003' || char === '\u001b') { done(new Cancelled()); return; }
            if (char === '\r' || char === '\n') { done(null, text); return; }
            if (char === '\u007f' || char === '\b') text = text.slice(0, -1);
            else if (char >= ' ') text += char;
          }
        };
        this.input.on('data', data);
      });
    }
    const interface_ = readline.createInterface({ input: this.input, output: this.output });
    const defaultLabel = options ? String(Math.max(0, options.findIndex(x => x.value === fallback)) + 1) : fallback;
    try {
      const value = await new Promise(resolve => interface_.question(`${label}${defaultLabel ? ` [${defaultLabel}]` : ''}: `, resolve));
      if (options) return options[Number(value || defaultLabel) - 1]?.value || '';
      return value.trim() || fallback;
    } finally { interface_.close(); }
  }
  onKey(text, key = {}) {
    const p = this.pending;
    if (key.ctrl && key.name === 'c') {
      if (p) { this.pending = null; p.reject(new Cancelled()); }
      else this.cancelAction?.();
      return;
    }
    if (!p) return;
    if (key.name === 'escape') { this.pending = null; p.reject(new Cancelled()); this.render(); return; }
    if (key.name === 'pageup') { this.scroll += 5; this.render(); return; }
    if (key.name === 'pagedown') { this.scroll = Math.max(0, this.scroll - 5); this.render(); return; }
    if (p.options && ['up', 'down'].includes(key.name)) {
      p.selected = (p.selected + (key.name === 'up' ? -1 : 1) + p.options.length) % p.options.length; this.render(); return;
    }
    if (p.options && /^[1-9]$/.test(text || '')) { p.selected = Math.min(Number(text) - 1, p.options.length - 1); this.render(); return; }
    if (key.name === 'return') {
      const value = p.options ? p.options[p.selected]?.value : p.secret ? p.text : p.text.trim() || p.fallback;
      const error = p.validate?.(value);
      if (error) { p.error = error; this.render(); return; }
      if (p.command && value && this.history.at(-1) !== value) this.history.push(value);
      this.pending = null; p.resolve(value); this.render(); return;
    }
    if (p.options) return;
    if (p.command && ['up', 'down'].includes(key.name)) {
      p.history = Math.max(0, Math.min(this.history.length, p.history + (key.name === 'up' ? -1 : 1)));
      p.text = this.history[p.history] || ''; p.cursor = p.text.length;
    } else if (key.name === 'left') p.cursor = Math.max(0, p.cursor - 1);
    else if (key.name === 'right') p.cursor = Math.min(p.text.length, p.cursor + 1);
    else if (key.name === 'home' || (key.ctrl && key.name === 'a')) p.cursor = 0;
    else if (key.name === 'end' || (key.ctrl && key.name === 'e')) p.cursor = p.text.length;
    else if (key.ctrl && key.name === 'u') { p.text = ''; p.cursor = 0; }
    else if (key.name === 'backspace') { if (p.cursor) { p.text = p.text.slice(0, p.cursor - 1) + p.text.slice(p.cursor); p.cursor--; } }
    else if (key.name === 'delete') p.text = p.text.slice(0, p.cursor) + p.text.slice(p.cursor + 1);
    else if (key.name === 'tab' && p.command) {
      const matching = (this.commands || []).filter(x => x.startsWith(p.text));
      if (matching.length) { p.text = matching[0]; p.cursor = p.text.length; }
    } else if (!key.ctrl && !key.meta && text && !/[\x00-\x1f\x7f]/.test(text)) {
      p.text = p.text.slice(0, p.cursor) + text + p.text.slice(p.cursor); p.cursor += text.length;
    }
    p.error = ''; this.render();
  }
  frame(columns = 100, rows = 30) {
    const width = Math.max(12, columns - 4), height = Math.max(9, rows - 1);
    const color = (text, name, bold = false) => this.paint(text, name, bold);
    const fit = text => crop(text, width);
    const lines = [];
    lines.push(color('MCP GEMINI', 'text', true) + color(`  /  tu PC · servidor MCP`, 'muted'));
    lines.push(color(fit(this.cwd), 'muted'));
    lines.push(color(`v${this.version}  ·  ${this.status}  ·  ${Math.floor((Date.now() - this.started) / 1000)}s`, 'muted'));
    lines.push('');
    const p = this.pending;
    const tail = [];
    if (p) {
      tail.push(color(fit(p.label), 'text', true));
      if (p.options) {
        p.options.forEach((option, index) => {
          const prefix = index === p.selected ? '❯' : ' ';
          tail.push(color(fit(`${prefix} ${index + 1}  ${option.label}`), index === p.selected ? 'blue' : 'muted', index === p.selected));
          if (index === p.selected && option.description) tail.push(color(fit(`     ${option.description}`), 'muted'));
        });
      }
      if (p.hint) tail.push(color(fit(p.hint), 'muted'));
      if (p.error) tail.push(color(fit(p.error), 'red'));
      tail.push(color('─'.repeat(width), 'border'));
      const visible = p.secret ? '•'.repeat(p.text.length) : p.options ? p.options[p.selected]?.label || '' : p.text || p.fallback || (p.command ? 'Escribe / para ver los comandos…' : 'Escribe aquí…');
      const offset = Math.max(0, (p.text ? p.cursor : 0) - (width - 6));
      tail.push(color('❯ ', 'blue', true) + color(crop(visible.slice(offset), width - 2), p.text || p.options ? 'text' : 'muted'));
      tail.push(color('─'.repeat(width), 'border'));
      tail.push(color(p.options ? '↑↓ elegir  ·  1–9 acceso rápido  ·  Enter confirmar  ·  Esc volver' : p.command ? 'Enter ejecutar  ·  ↑↓ historial  ·  Tab completar  ·  Ctrl+C salir' : 'Enter continuar  ·  Esc volver  ·  Ctrl+C cancelar', 'muted'));
    } else {
      tail.push(color('─'.repeat(width), 'border'));
      tail.push(color(this.busy ? '❯ Trabajando…' : '❯ Preparado', 'blue'));
      tail.push(color('─'.repeat(width), 'border'));
      tail.push(color('Ctrl+C cancelar la operación', 'muted'));
    }
    tail.push(color(`local  ·  ${this.events.filter(x => x.status === 'done').length} pasos completados`, 'muted'));
    while (lines.length + tail.length > height && lines.length > 1) lines.pop();
    while (tail.length > height - 1) tail.splice(1, 1);
    const available = Math.max(0, height - lines.length - tail.length);
    const visibleEvents = available ? this.events.slice(0, Math.max(0, this.events.length - this.scroll)).slice(-available) : [];
    for (const event of visibleEvents) {
      const state = event.status === 'done' ? '[listo]' : event.status === 'error' ? '[error]' : event.status === 'running' ? ['[·  ]', '[ · ]', '[  ·]'][Math.floor(Date.now() / 250) % 3] : '';
      const label = crop(event.label, Math.max(7, Math.min(13, Math.floor(width / 6))));
      const detailWidth = Math.max(4, width - label.length - state.length - 6);
      const detail = crop(event.message, detailWidth);
      const pad = ' '.repeat(Math.max(1, width - label.length - detail.length - state.length - 5));
      lines.push(color('∙ ' + label, event.status === 'error' ? 'red' : 'blue', true) + '  ' + color(detail, event.status === 'done' ? 'muted' : 'text') + pad + color(state, event.status === 'error' ? 'red' : event.status === 'done' ? 'green' : 'blue'));
    }
    while (lines.length < height - tail.length) lines.push('');
    return [...lines, ...tail].slice(0, height).map(line => clipAnsi(line, width));
  }
  render() {
    if (!this.active) return;
    const columns = this.output.columns || 100, rows = this.output.rows || 30;
    const frame = this.frame(columns, rows);
    const background = this.color ? `${ESC}48;2;15;15;15m` : '';
    this.output.write(`${ESC}?25l${ESC}H${background}` + frame.map(line => '  ' + line + `${ESC}0m${background}${ESC}K`).join('\r\n') + `${ESC}J`);
    const p = this.pending;
    if (p && !p.options) {
      const inputRow = frame.length - 3;
      const width = Math.max(12, columns - 4);
      const cursor = Math.min(p.cursor, width - 6);
      this.output.write(`${ESC}${inputRow};${5 + cursor}H${ESC}?25h`);
    }
  }
}

module.exports = { TerminalUI, Cancelled, plain, crop, clipAnsi };

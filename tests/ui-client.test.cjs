'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// A small DOM model exercises the actual client functions without a browser,
// external dependencies, network calls, or changes to the user's configuration.
function createDocument(html) {
  const document = { activeElement: null, hidden: false };
  class Element {
    constructor(tag) {
      this.tagName = tag.toUpperCase();
      this.childNodes = [];
      this.parentNode = null;
      this.dataset = {};
      this.attributes = {};
      this.className = '';
      this.value = '';
      this.hidden = false;
      this.disabled = false;
      this.open = false;
      this._text = '';
      this.classList = {
        add: value => { if (!this.className.split(/\s+/).includes(value)) this.className += ` ${value}`; },
        toggle: (value, enabled) => {
          const classes = new Set(this.className.split(/\s+/).filter(Boolean));
          if (enabled) classes.add(value); else classes.delete(value);
          this.className = [...classes].join(' ');
        },
      };
    }
    get children() { return this.childNodes.filter(node => node.tagName !== '#TEXT'); }
    set textContent(value) { this.replaceChildren(); this._text = String(value); }
    get textContent() { return this._text + this.childNodes.map(node => node.textContent).join(''); }
    set checked(value) {
      this._checked = Boolean(value);
      if (value && this.name) {
        for (const input of document.querySelectorAll(`input[name="${this.name}"]`)) if (input !== this) input._checked = false;
      }
    }
    get checked() { return Boolean(this._checked); }
    setAttribute(key, value) {
      this.attributes[key] = String(value);
      if (key.startsWith('data-')) this.dataset[key.slice(5).replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = String(value);
      else if (key === 'class') this.className = String(value);
      else if (['hidden', 'checked', 'disabled', 'open'].includes(key)) this[key] = true;
      else this[key] = String(value);
    }
    removeAttribute(key) { delete this.attributes[key]; }
    matches(selector) {
      const checked = selector.includes(':checked');
      if (checked && !this.checked) return false;
      const tag = selector.match(/^[a-z][\w-]*/i)?.[0];
      if (tag && this.tagName !== tag.toUpperCase()) return false;
      const id = selector.match(/#([\w-]+)/)?.[1];
      if (id && this.id !== id) return false;
      const className = selector.match(/\.([\w-]+)/)?.[1];
      if (className && !this.className.split(/\s+/).includes(className)) return false;
      for (const [, name, value] of selector.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)) {
        const actual = name.startsWith('data-') ? this.dataset[name.slice(5).replace(/-([a-z])/g, (_, char) => char.toUpperCase())] : this[name] ?? this.attributes[name];
        if (actual === undefined || (value !== undefined && String(actual) !== value)) return false;
      }
      return true;
    }
    querySelectorAll(selector) {
      const alternatives = selector.split(',').map(value => value.trim().split(/\s+/));
      const nodes = [];
      const walk = parent => {
        for (const child of parent.children) {
          if (alternatives.some(parts => {
            if (!child.matches(parts.at(-1))) return false;
            let ancestor = child.parentNode;
            for (let index = parts.length - 2; index >= 0; index--) {
              while (ancestor && !ancestor.matches(parts[index])) ancestor = ancestor.parentNode;
              if (!ancestor) return false;
              ancestor = ancestor.parentNode;
            }
            return true;
          })) nodes.push(child);
          walk(child);
        }
      };
      walk(this);
      return nodes;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    closest(selector) { return this.matches(selector) ? this : this.parentNode?.closest(selector) || null; }
    contains(node) { return node === this || this.childNodes.some(child => child.contains(node)); }
    append(...nodes) { for (const node of nodes) this.insertBefore(node, null); }
    insertBefore(node, before) {
      if (node.parentNode) node.remove();
      const index = before ? this.childNodes.indexOf(before) : this.childNodes.length;
      this.childNodes.splice(index, 0, node);
      node.parentNode = this;
    }
    replaceChildren(...nodes) { for (const node of [...this.childNodes]) node.remove(); this._text = ''; this.append(...nodes); }
    remove() {
      if (this.contains(document.activeElement)) document.activeElement = document.body;
      if (this.parentNode) this.parentNode.childNodes.splice(this.parentNode.childNodes.indexOf(this), 1);
      this.parentNode = null;
    }
    focus() { if (!this.disabled) document.activeElement = this; }
    showModal() { this.open = true; }
    close() { this.open = false; }
    addEventListener() {}
  }
  const root = new Element('document');
  document.querySelector = selector => root.querySelector(selector);
  document.querySelectorAll = selector => root.querySelectorAll(selector);
  document.createElement = tag => new Element(tag);
  document.createElementNS = (_, tag) => new Element(tag);
  document.createTextNode = text => { const node = new Element('#text'); node.textContent = text; return node; };
  const stack = [root];
  for (const match of html.matchAll(/<\/?[a-z][^>]*>/gi)) {
    const token = match[0];
    if (token.startsWith('</')) {
      const tag = token.match(/^<\/([\w-]+)/)[1].toUpperCase();
      while (stack.length > 1 && stack.pop().tagName !== tag) {}
      continue;
    }
    const tag = token.match(/^<([\w-]+)/)[1];
    const node = new Element(tag);
    stack.at(-1).append(node);
    for (const [, name, value] of token.slice(tag.length + 1, -1).matchAll(/([\w-]+)(?:="([^"]*)")?/g)) node.setAttribute(name, value ?? '');
    if (tag === 'body') document.body = node;
    if (!['meta', 'link', 'input', 'br'].includes(tag) && !token.endsWith('/>')) stack.push(node);
  }
  document.activeElement = document.body;
  return document;
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function state(overrides = {}) {
  return {
    version: '1.0.0', configured: true,
    config: { workspace: 'test-workspace', profile: 'archivos', target: 'web', mode: 'ngrok', port: 3000, baseUrl: 'https://example.test' },
    account: { configured: true, username: 'test-user' }, ngrok: { configured: true },
    runtime: { state: 'stopped', endpoint: '', message: 'Desconectado' },
    operation: { busy: false, label: '' }, events: [], approvals: [], ...overrides,
  };
}

function client() {
  const document = createDocument(fs.readFileSync(path.join(__dirname, '../ui/index.html'), 'utf8'));
  const requests = [];
  const timers = new Map();
  let timerId = 0;
  const context = {
    document, location: { hash: '#inicio' }, URL, AbortSignal, Date,
    setTimeout(fn) { timers.set(++timerId, fn); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    fetch(url, options) {
      const pending = deferred();
      requests.push({ url, options, complete(body, ok = true) { pending.resolve({ ok, json: async () => body }); } });
      return pending.promise;
    },
  };
  const source = fs.readFileSync(path.join(__dirname, '../ui/app.js'), 'utf8');
  const end = source.indexOf('  form.addEventListener');
  vm.runInNewContext(source.slice(0, end) + '\n  globalThis.client = { poll, act, panic, applyState, paintApprovals, submitForm, setStep, configureFields, navigate, getState: () => state };\n})();', context);
  context.client.applyState(state());
  return { ...context.client, document, requests, timers, location: context.location, node: id => document.querySelector(`#${id}`) };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

test('the skip-to-content link preserves the currently selected page', () => {
  const app = client();
  app.location.hash = '#ayuda';
  app.navigate();
  app.location.hash = '#main';
  app.navigate();
  assert.equal(app.node('page-ayuda').hidden, false);
  assert.equal(app.node('page-inicio').hidden, true);
});

test('an old poll cannot undo a completed start or report an obsolete failure', async () => {
  const app = client();
  const polling = app.poll();
  const starting = app.act('/api/start');
  app.requests[1].complete({ ok: true, state: state({ runtime: { state: 'running', endpoint: 'https://example.test/mcp' } }) });
  await starting;
  app.requests[0].complete({ ok: false, error: 'Old request failed' }, false);
  await polling;
  assert.equal(app.node('global-status-text').textContent, 'Conexión activa');
  assert.equal(app.node('connection-error').hidden, true);
  assert.equal(app.getState().runtime.state, 'running');
  const second = client();
  const oldPoll = second.poll();
  const newStart = second.act('/api/start');
  second.requests[1].complete({ ok: true, state: state({ runtime: { state: 'running', endpoint: 'https://example.test/mcp' } }) });
  await newStart;
  second.requests[0].complete({ ok: true, state: state() });
  await oldPoll;
  assert.equal(second.getState().runtime.state, 'running');
  assert.equal(second.node('endpoint').value, 'https://example.test/mcp');
});

test('failed action does not mark a known offline app as online using cached state', async () => {
  const app = client();
  const polling = app.poll();
  app.requests[0].complete({ ok: false, error: 'Offline' }, false);
  await polling;
  const acting = app.act('/api/start');
  app.requests[1].complete({ ok: false, error: 'Still offline' }, false);
  await acting;
  assert.equal(app.node('connection-error').hidden, false);
  assert.equal(app.node('start-button').disabled, true);
  assert.equal(app.node('panic-button').disabled, false);
});

test('panic runs during pending setup, keeps closure visible, and ignores the late response', async () => {
  const app = client();
  const saving = app.act('/api/setup', { workspace: 'test-workspace' });
  app.applyState(state({ operation: { busy: true, label: 'Preparando' } }));
  assert.equal(app.node('panic-button').disabled, false);
  const stopping = app.panic();
  assert.equal(app.requests[1].url, '/api/panic');
  assert.equal(app.requests[1].options.method, 'POST');
  app.requests[1].complete({ ok: true });
  await stopping;
  app.requests[0].complete({ ok: true, state: state({ runtime: { state: 'running' } }) });
  await saving;
  await app.poll();
  assert.equal(app.requests.length, 2, 'no polling resumes after confirmed closure');
  assert.equal(app.node('closed-dialog').open, true);
  assert.match(app.node('closed-title').textContent, /Conexión cortada/);
  assert.equal(app.node('global-status-text').textContent, 'Aplicación cerrada');
  assert.equal(app.node('toast').hidden, true);
  assert.equal(app.timers.size, 0);
});

test('panic failure does not claim closure and permits a retry during background polling', async () => {
  const app = client();
  const first = app.panic();
  app.requests[0].complete({ ok: false, error: 'No se pudo detener el proceso' }, false);
  await first;
  assert.equal(app.node('closed-dialog').open, false);
  assert.equal(app.node('panic-button').disabled, false);
  assert.match(app.node('panic-help').textContent, /Reintenta/);
  const second = app.panic();
  app.requests[2].complete({ ok: true });
  await second;
  app.requests[1].complete({ ok: true, state: state({ runtime: { state: 'running' } }) });
  await tick();
  assert.equal(app.node('closed-dialog').open, true);
  assert.equal(app.node('global-status-text').textContent, 'Aplicación cerrada');
  assert.equal(app.requests.length, 3);
});

test('another approval does not close details or steal keyboard focus from the existing action', () => {
  const app = client();
  const first = { id: 'first', tool: 'write_file', details: 'file contents', reviewTruncated: false };
  app.paintApprovals([first]);
  const list = app.node('approvals-list');
  const card = list.children[0];
  const details = card.querySelector('details');
  const button = card.querySelector('[data-decision="approve"]');
  details.open = true;
  button.focus();
  app.paintApprovals([first, { id: 'second', tool: 'delete_file', details: 'another file' }]);
  assert.equal(list.children[0], card);
  assert.equal(details.open, true);
  assert.equal(app.document.activeElement, button);
  app.paintApprovals([]);
  assert.equal(app.document.activeElement, app.node('activity-title'));
});

test('CLI setup omits web credentials while editing preserves fields across polling', async () => {
  const app = client();
  app.node('workspace').value = 'chosen-workspace';
  app.document.querySelector('input[name="target"][value="cli"]').checked = true;
  app.configureFields(true);
  app.node('password').value = 'do-not-send-this';
  app.node('authtoken').value = 'do-not-send-token';
  app.applyState(state({ account: { configured: false, username: '' } }));
  assert.equal(app.node('workspace').value, 'chosen-workspace');
  app.setStep(3, false);
  const saving = app.submitForm({ preventDefault() {} });
  const payload = JSON.parse(app.requests[0].options.body);
  assert.equal(payload.target, 'cli');
  assert.equal(payload.mode, 'local');
  assert.equal(payload.workspace, 'chosen-workspace');
  assert.equal('password' in payload, false);
  assert.equal('authtoken' in payload, false);
  app.requests[0].complete({ ok: true, state: state({ config: { ...state().config, target: 'cli', mode: 'local' } }) });
  await saving;
  assert.equal(app.node('password').value, '');
  assert.equal(app.node('authtoken').value, '');
});

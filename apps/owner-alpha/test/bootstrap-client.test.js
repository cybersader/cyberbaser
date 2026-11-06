import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../public/bootstrap.js', import.meta.url), 'utf8');
const CANARY = Buffer.alloc(32, 3).toString('base64url');
const FAILURE = 'Sign-in could not be confirmed. Close this session.';
function harness({ token = CANARY, status = 200, value = { ok: true }, failure = null, deferred = false } = {}) {
  const listeners = new Map(); const requests = []; const forbiddenCalls = [];
  const element = (name) => ({ value: '', disabled: false, textContent: '',
    addEventListener(type, callback) { listeners.set(`${name}:${type}`, callback); },
    fire(type) { return listeners.get(`${name}:${type}`)?.(); } });
  const input = Object.assign(element('input'), { value: token });
  const button = element('button'); const message = element('status'); const heading = element('heading');
  const nodes = { '#owner-bootstrap-token': input, '#owner-bootstrap-submit': button,
    '#owner-bootstrap-status': message, '#owner-bootstrap-heading': heading };
  const document = { title: 'Sign in', querySelector: (selector) => nodes[selector] ?? null };
  let resolve; const gate = new Promise((yes) => { resolve = yes; });
  const forbidden = (name) => { forbiddenCalls.push(name); throw new Error('forbidden-side-effect'); };
  const globals = { document,
    fetch: async (url, options) => {
      expect(input.value).toBe('');
      expect(input.disabled).toBe(true); expect(button.disabled).toBe(true);
      requests.push({ url, options: { ...options }, titleAtSend: document.title });
      if (deferred) await gate;
      if (failure === 'network') throw new Error(`sensitive synthetic failure ${CANARY}`);
      return { status, json: async () => {
        if (failure === 'json') throw new Error(`sensitive synthetic response ${CANARY}`);
        return value;
      } };
    },
    console: { log: () => forbidden('log'), error: () => forbidden('error'), warn: () => forbidden('warn') },
    setTimeout: () => forbidden('timer'), setInterval: () => forbidden('interval'),
  };
  for (const name of ['window', 'location', 'localStorage', 'sessionStorage', 'indexedDB', 'navigator']) {
    Object.defineProperty(globals, name, { get() { return forbidden(name); } });
  }
  Object.defineProperty(document, 'cookie', { get() { return forbidden('cookie-read'); }, set() { forbidden('cookie-write'); } });
  vm.runInNewContext(source, globals);
  return { input, button, message, heading, document, requests, forbiddenCalls, resolve };
}

test('code is cleared before a single same-origin body-only POST, with no navigation or storage', async () => {
  const ui = harness({ deferred: true });
  const pending = ui.button.fire('click');
  await ui.button.fire('click');
  expect(ui.requests).toHaveLength(1);
  expect(ui.message.textContent).toBe('Signing in');
  const { url, options } = ui.requests[0];
  expect(url).toBe('/owner/bootstrap'); expect(url).not.toContain(CANARY);
  expect(options).toEqual({ method: 'POST', credentials: 'same-origin', mode: 'same-origin',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: CANARY }),
    cache: 'no-store', redirect: 'error' });
  ui.resolve(); await pending;
  expect(ui.input.value).toBe(''); expect(ui.input.disabled).toBe(true); expect(ui.button.disabled).toBe(true);
  expect(ui.heading.textContent).toBe('Signed in'); expect(ui.document.title).toBe('Signed in');
  expect(ui.message.textContent).toBe('Signed in');
  await ui.button.fire('click'); expect(ui.requests).toHaveLength(1);
  expect(ui.forbiddenCalls).toEqual([]);
});

for (const [name, options] of [
  ['network error', { failure: 'network' }],
  ['response parse error', { failure: 'json' }],
  ['redirect status', { status: 303 }],
  ['refusal status', { status: 403 }],
  ['different success status', { status: 201 }],
  ['missing result', { value: {} }],
  ['false result', { value: { ok: false } }],
  ['extra result', { value: { ok: true, token: CANARY } }],
  ['array result', { value: [{ ok: true }] }],
  ['null result', { value: null }],
]) {
  test(`${name} gives a fixed terminal failure without retry or secret echo`, async () => {
    const ui = harness(options); await ui.button.fire('click');
    expect(ui.message.textContent).toBe(FAILURE);
    expect(ui.message.textContent).not.toContain(CANARY);
    expect(ui.document.title).toBe('Sign in'); expect(ui.heading.textContent).not.toBe('Signed in');
    expect(ui.input.value).toBe(''); expect(ui.button.disabled).toBe(true);
    await ui.button.fire('click'); expect(ui.requests).toHaveLength(1);
    expect(ui.forbiddenCalls).toEqual([]);
  });
}

test('invalid input is cleared with zero requests and cannot auto-rearm', async () => {
  const ui = harness({ token: 'not-a-code' }); await ui.button.fire('click');
  expect(ui.input.value).toBe(''); expect(ui.message.textContent).toBe(FAILURE);
  ui.input.value = CANARY; await ui.button.fire('click');
  expect(ui.requests).toHaveLength(0); expect(ui.forbiddenCalls).toEqual([]);
});

test('script has no persistence, logging, navigation, native-submit or secret attribute sink', () => {
  expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB|console\.|location|\.submit\(|setAttribute|innerHTML|outerHTML|document\.cookie|sendBeacon|URLSearchParams/u);
  expect(source).toContain("redirect: 'error'");
  expect(source).toContain("input.value = '';");
});

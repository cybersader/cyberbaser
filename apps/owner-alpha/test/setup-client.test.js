import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { READY_SCRIPT } from '../src/setup-ready.js';

const scripts = Object.fromEntries(await Promise.all(['setup', 'github', 'devices'].map(async (name) =>
  [name, await readFile(new URL(`../public/${name}.js`, import.meta.url), 'utf8')])));
const SESSION_ENDED = 'Your setup sign-in ended. Ask for a fresh setup link to carry on; your progress is saved.';
const ended = () => Response.json({ error: { code: 'invalid-session', message: SESSION_ENDED } }, { status: 403 });
const settle = async () => new Promise((resolve) => setTimeout(resolve, 0));

function browser({ step = 'phone', configured = '', replies = [], elapsed = 0 } = {}) {
  const requests = [];
  const navigations = [];
  const timers = new Map();
  let timerId = 0;
  let focus;
  function node(tag = 'div') {
    const listeners = new Map();
    const self = {
      tag, attributes: {}, dataset: {}, children: [], selectors: {}, value: '', textContent: '', hidden: false, disabled: false,
      setAttribute(name, value) { this.attributes[name] = value; },
      removeAttribute(name) { delete this.attributes[name]; },
      append(...children) { for (const child of children) { if (typeof child === 'object') child.parent = this; this.children.push(child); } },
      replaceChildren(...children) { this.children = []; this.append(...children); },
      querySelector(selector) { return this.selectors[selector] ?? null; },
      querySelectorAll() { return []; },
      closest(selector) { return this.selectors[selector] ?? null; },
      focus() { focus = this; },
      scrollIntoView() {},
      classList: { toggle() {}, contains(name) { return self.className?.split(' ').includes(name); } },
      addEventListener(type, handler) { listeners.set(type, handler); },
      dispatchEvent(event) { listeners.get(event.type)?.(event); if (event.bubbles) this.parent?.dispatchEvent(event); },
      fire(type, props = {}) { return listeners.get(type)?.({ target: this, preventDefault() {}, ...props }); },
      *walk() { yield this; for (const child of this.children) if (typeof child === 'object') yield* child.walk(); },
    };
    return self;
  }
  const nodes = Object.fromEntries(['setup', 'setup-status', 'setup-starting', 'setup-ready-actions', 'forge', 'forge-panel', 'devices', 'pair-form', 'pair-live', 'pair-status'].map((id) => [id, node()]));
  nodes.setup.dataset = { csrf: 'fixture-csrf', step, notesPhase: 'cloning', sessionEnded: SESSION_ENDED };
  const section = nodes.setup.selectors['.setup-step'] = node('section');
  const trigger = node('button');
  trigger.dataset.action = 'skip';
  trigger.selectors['[data-action]'] = trigger;
  nodes.setup.append(section);
  section.append(trigger, nodes.forge, nodes.devices);
  nodes.forge.append(nodes['forge-panel']);
  nodes.forge.dataset = { mode: 'setup', csrf: 'fixture-csrf', configured, provider: 'github-app' };
  nodes.devices.className = 'setup-devices';
  nodes.devices.dataset.csrf = 'fixture-csrf';
  nodes['pair-form'].elements = { kind: { value: 'agent' }, access: { value: 'propose' }, label: { value: 'My agent' } };
  nodes['pair-form'].selectors['button[type="submit"]'] = node('button');
  nodes['setup-starting'].textContent = 'Starting Cyberbaser…';
  nodes['setup-ready-actions'].hidden = true;
  const timer = (callback) => { timers.set(++timerId, callback); return timerId; };
  const context = vm.createContext({
    document: { getElementById: (id) => nodes[id] ?? null, createElement: node },
    Event, CustomEvent, AbortSignal, Date: { now: () => elapsed, parse: Date.parse },
    setTimeout: timer, clearTimeout: (id) => timers.delete(id), setInterval: timer, clearInterval: (id) => timers.delete(id),
    location: { assign: (url) => navigations.push(url), reload: () => navigations.push('reload') },
    fetch: async (route, options) => {
      requests.push({ route, options });
      const reply = replies.shift();
      if (reply instanceof Error) throw reply;
      return reply;
    },
  });
  return {
    nodes, trigger, section, requests, navigations, timers, focus: () => focus,
    run: (name) => vm.runInContext(scripts[name] ?? READY_SCRIPT, context),
    async tick(milliseconds = 1500) {
      elapsed += milliseconds;
      const [id, callback] = timers.entries().next().value;
      timers.delete(id);
      await callback();
      await settle();
    },
  };
}

const text = (node) => [node.textContent, ...node.children.map((child) => typeof child === 'string' ? child : text(child))].join('');
const find = (node, test) => [...node.walk()].find(test);
function expectEnded(ui) {
  expect(ui.section.children.map(text)).toEqual(['Setup sign-in ended', SESSION_ENDED]);
  expect(ui.focus()).toBe(ui.section.children[0]);
  expect(ui.navigations).toEqual([]);
}

test('a refused setup action replaces stale buttons with the saved-progress message', async () => {
  const ui = browser({ replies: [ended()] });
  ui.run('setup');
  await ui.nodes.setup.fire('click', { target: ui.trigger });
  expect(ui.requests[0]).toMatchObject({ route: '/setup/step', options: { method: 'POST' } });
  expectEnded(ui);
});

test('an expired notes poll shows the message instead of reloading or polling again', async () => {
  const ui = browser({ step: 'notes', replies: [ended()] });
  ui.run('setup');
  await ui.tick();
  expect(ui.requests.map(({ route }) => route)).toEqual(['/setup/state']);
  expect(ui.timers.size).toBe(0);
  expectEnded(ui);
});

for (const [name, check, assertions] of [
  ['create', { state: 'no-app' }, (sheet) => {
    expect(text(sheet.children[0])).toContain('passkey or password. Then click the green Create GitHub App button.');
    expect(sheet.children[1].children[0].attributes.href).toBe('/setup/github/create');
  }],
  ['install and sign in', { state: 'not-connected', app: { signIn: 'web' } }, (sheet) => {
    expect(text(sheet.children[0])).toContain('choose “Only select repositories” and pick owner/vault. Click Install, then click Authorize');
    expect(sheet.children[1].children[0].attributes.href).toBe('/setup/github/install');
    expect(text(sheet.children[2])).toContain('sign in or use a passkey. Click Authorize to return to Cyberbaser.');
    expect(sheet.children[3].children[0].attributes.href).toBe('/setup/github/sign-in');
  }],
  ['connected', { state: 'connected', repository: 'owner/vault' }, (sheet) => {
    expect(text(find(sheet, (node) => node.tag === 'strong'))).toBe('Connected to GitHub');
    expect(text(sheet)).toContain('owner/vault');
  }],
]) {
  test(`GitHub setup gives clear ${name} copy`, async () => {
    const ui = browser({ step: 'github', configured: 'owner/vault', replies: [Response.json({ ok: true, ...check })] });
    ui.run('setup');
    ui.run('github');
    await settle();
    assertions(ui.nodes['forge-panel'].children[0]);
  });
}

test('an expired GitHub selection shows the setup message instead of a generic error', async () => {
  const ui = browser({ step: 'github', replies: [Response.json({ ok: true, state: 'pick-repository' }),
    Response.json({ ok: true, repositories: [{ fullName: 'owner/vault', problem: null }] }), ended()] });
  ui.run('setup');
  ui.run('github');
  await settle();
  const panel = ui.nodes['forge-panel'];
  expect(text(find(panel, (node) => node.tag === 'h3'))).toBe('Connected to GitHub');
  find(panel, (node) => node.attributes.role === 'option').fire('click');
  expect(text(panel)).toContain('private copy of owner/vault on the computer running Cyberbaser');
  await find(panel, (node) => node.textContent === 'Use this repository').fire('click');
  expect(ui.requests.at(-1)).toMatchObject({ route: '/owner/github/select', options: { method: 'POST' } });
  expectEnded(ui);
});

test('an expired pairing action shows the setup message rather than asking to try pairing again', async () => {
  const ui = browser({ step: 'agent', replies: [ended()] });
  ui.run('setup');
  ui.run('devices');
  await ui.nodes['pair-form'].fire('submit');
  expect(ui.requests[0]).toMatchObject({ route: '/owner/devices/pair', options: { method: 'POST' } });
  expectEnded(ui);
});

test('the ready page waits through setup, the listener gap and a long start, then shows its links', async () => {
  const ui = browser({ step: 'done', replies: [new Response(null, { status: 404 }), new Error('no listener'),
    new Error('still no listener'), { type: 'opaqueredirect', status: 0 }] });
  ui.run('ready');
  await settle();
  expect(ui.nodes['setup-ready-actions'].hidden).toBe(true);
  expect(ui.nodes['setup-starting'].textContent).toBe('Starting Cyberbaser…');
  await ui.tick();
  await ui.tick(60_000);
  expect(ui.nodes['setup-starting'].textContent).toBe('Still starting. This can take a minute the first time.');
  expect(ui.nodes['setup-ready-actions'].hidden).toBe(true);
  await ui.tick();
  expect(ui.nodes['setup-ready-actions'].hidden).toBe(false);
  expect(ui.nodes['setup-starting'].textContent).toBe('Cyberbaser is ready to open.');
  expect(ui.timers.size).toBe(0);
  expect(ui.requests.map(({ route }) => route)).toEqual(['/', '/', '/', '/']);
  expect(ui.requests[0].options).toMatchObject({ method: 'HEAD', mode: 'same-origin', redirect: 'manual' });
  expect(ui.navigations).toEqual([]);
});

test('if the normal server restarted without the session, the ready page explains the next step', async () => {
  const ui = browser({ step: 'done', replies: [new Response(null, { status: 403 }),
    new Response(null, { status: 403 }), new Response(null, { status: 403 }), new Response(null, { status: 200 })] });
  ui.run('ready');
  await settle();
  expect(ui.nodes['setup-starting'].textContent).toBe('Starting Cyberbaser…');
  await ui.tick();
  expect(ui.nodes['setup-ready-actions'].hidden).toBe(true);
  expect(ui.nodes['setup-starting'].textContent).toBe('Cyberbaser is running. Ask for a fresh sign-in link to open it.');
  expect(ui.requests.map(({ route }) => route)).toEqual(['/', '/owner/sign-in', '/', '/owner/sign-in']);
  expect(ui.timers.size).toBe(0);
});

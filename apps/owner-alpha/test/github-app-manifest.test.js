import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFirstRunHandler, createNotesPreparer, createSetupForgeRelay, createSetupLinks, openSetupState, ownerConfigFromSetup } from '../src/first-run.js';
import { createGithubAppAccess, createGithubHttp } from '../src/publisher/forge-access.js';
import { forgeRequest } from '../src/publisher/forge-control.js';
import {
  AUTHORIZE_STATE_TTL_MS, CALLBACK_PATHS, MANIFEST_STATE_TTL_MS, REGISTRATION_FILE, buildManifest, createFlowStates, defaultAppName,
  reduceConversion, validCallbackOrigin,
} from '../src/publisher/github-app-manifest.js';
import { ownerHttpTools } from '../src/server.js';
import { startFakeGithub } from './fake-github-process.js';

// The GitHub App manifest flow: the manifest, the one-use states, the
// conversion (private key and webhook secret dropped, bytes zeroed), the web
// sign-in with the client secret and PKCE, and the setup pages, against the
// fake GitHub's create, install and authorize pages.

const APP = path.resolve(import.meta.dir, '..');
const cleanup = [];
let fake;
let root;
beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'oa-manifest-'));
  fake = await startFakeGithub(root);
});
afterAll(async () => {
  for (const action of cleanup.reverse()) await action();
  await fake?.stop();
  await rm(root, { recursive: true, force: true });
});

const ORIGIN = 'http://127.0.0.1:47555';
const PEM = /BEGIN|FAKEPEMCANARY|whsCANARY/u;

async function filesUnder(directory) {
  const out = [];
  for (const entry of await readdir(directory, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) out.push(path.join(entry.parentPath ?? entry.path, entry.name));
  }
  return out;
}

// The owner's browser on GitHub's pages: post a page's one form, return where GitHub sends it.
async function clickThrough(response) {
  const text = await response.text();
  const action = /<form method="post" action="([^"]+)"/u.exec(text)?.[1];
  const page = /name="page" value="([^"]+)"/u.exec(text)?.[1];
  if (!action || !page) throw new Error(`no form: ${response.status} ${text.slice(0, 200)}`);
  const clicked = await fetch(new URL(action, fake.origin), { method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ page }).toString() });
  expect(clicked.status).toBe(302);
  return new URL(clicked.headers.get('location'));
}

async function postManifest({ action, manifest }) {
  return fetch(action, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ manifest }).toString() });
}

let counter = 0;
function access(overrides = {}) {
  counter += 1;
  const stateDirectory = path.join(root, `forge-${counter}`);
  return { stateDirectory, access: createGithubAppAccess({ clientId: null, stateDirectory, remoteUrl: null,
    http: createGithubHttp({ apiBaseUrl: fake.origin, webBaseUrl: fake.origin }), secondMs: 1, ...overrides }) };
}

describe('manifest and states', () => {
  test('the manifest asks for contents write and metadata read only, no webhook, private, loopback returns', () => {
    const manifest = buildManifest({ origin: ORIGIN, name: 'Cyberbaser test 1a2b' });
    expect(manifest).toMatchObject({
      name: 'Cyberbaser test 1a2b', public: false, hook_attributes: { active: false }, default_events: [],
      default_permissions: { contents: 'write', metadata: 'read' }, request_oauth_on_install: false,
      redirect_url: `${ORIGIN}${CALLBACK_PATHS.created}`, setup_url: `${ORIGIN}${CALLBACK_PATHS.installed}`,
      callback_urls: [`${ORIGIN}${CALLBACK_PATHS.authorized}`],
    });
    expect(Object.keys(manifest.default_permissions).sort()).toEqual(['contents', 'metadata']);
    for (const bad of ['http://localhost:4317', 'https://127.0.0.1:4317', 'http://127.0.0.1', 'http://127.0.0.1:4317/', 'http://10.0.0.2:4317', 'http://127.0.0.1:99999']) {
      expect(validCallbackOrigin(bad)).toBe(false);
      expect(() => buildManifest({ origin: bad })).toThrow();
    }
  });

  test('default names fit GitHub\'s 34 characters and carry a random suffix', () => {
    expect(defaultAppName('a-very-long-host-name-that-goes-on', 'beef')).toBe('Cyberbaser a-very-long-host beef');
    expect(defaultAppName('my host!', 'beef')).toBe('Cyberbaser my-host beef');
    expect(defaultAppName('', 'beef')).toBe('Cyberbaser beef');
    expect(defaultAppName().length).toBeLessThanOrEqual(34);
  });

  test('states are one-use, short-lived, and replaced by a new start', () => {
    let clock = 1000;
    const flows = createFlowStates({ now: () => clock });
    const first = flows.open('manifest', ORIGIN, MANIFEST_STATE_TTL_MS);
    const second = flows.open('manifest', ORIGIN, MANIFEST_STATE_TTL_MS);
    expect(flows.take('manifest', first.state)).toBeNull();
    expect(flows.take('manifest', 'x'.repeat(43))).toBeNull();
    expect(flows.take('manifest', 'short')).toBeNull();
    expect(flows.take('manifest', second.state)?.origin).toBe(ORIGIN);
    expect(flows.take('manifest', second.state)).toBeNull();
    const late = flows.open('authorize', ORIGIN, AUTHORIZE_STATE_TTL_MS);
    clock += AUTHORIZE_STATE_TTL_MS + 1;
    expect(flows.take('authorize', late.state)).toBeNull();
    flows.open('install', ORIGIN, 10);
    expect(flows.takeWindow('install')).not.toBeNull();
    expect(flows.takeWindow('install')).toBeNull();
  });
});

describe('conversion', () => {
  const answer = (extra = {}) => new TextEncoder().encode(JSON.stringify({
    id: 77, slug: 'cyberbaser-test', name: 'Cyberbaser test', owner: { login: 'cybersader', id: 4242 },
    client_id: 'Iv23liabcdef12', client_secret: 'cbsCANARY0123456789abcdef', webhook_secret: 'whsCANARYsecret',
    pem: '-----BEGIN RSA PRIVATE KEY-----\nFAKEPEMCANARY\n-----END RSA PRIVATE KEY-----\n',
    permissions: { contents: 'write', metadata: 'read' }, ...extra }));

  test('keeps id, slug, client ID and secret, drops the private key and webhook secret, zeroes the bytes', () => {
    const bytes = answer();
    const kept = reduceConversion(bytes);
    expect(kept).toEqual({ createdBy: 'manifest', id: 77, slug: 'cyberbaser-test', name: 'Cyberbaser test', clientId: 'Iv23liabcdef12',
      clientSecret: 'cbsCANARY0123456789abcdef', owner: { login: 'cybersader', id: 4242 } });
    expect(JSON.stringify(kept)).not.toMatch(PEM);
    expect(bytes.every((byte) => byte === 0)).toBe(true);
  });

  test('refuses an answer that is not an app, or an app with more than contents, and still zeroes it', () => {
    for (const bytes of [answer({ client_id: 'not-a-client' }), answer({ id: 'x' }), answer({ permissions: { contents: 'write', administration: 'write' } }),
      new TextEncoder().encode('not json'), new Uint8Array(0)]) {
      expect(() => reduceConversion(bytes)).toThrow();
      expect(bytes.every((byte) => byte === 0)).toBe(true);
    }
  });
});

describe('the publisher against the fake GitHub', () => {
  test('create, install, authorize: one-use states, secret kept owner-only, no private key anywhere', async () => {
    await fake.scenario({ installations: 'exact', repository: 'cybersader/cyberchief', requireInstall: true });
    const { access: app, stateDirectory } = access();
    expect(await app.status()).toEqual({ provider: 'github-app', state: 'no-app' });
    await expect(app.startSignIn()).rejects.toMatchObject({ code: 'no-app' });
    await expect(app.newApp('http://192.168.1.5:4317')).rejects.toMatchObject({ code: 'app-state-invalid' });

    const form = await app.newApp(ORIGIN);
    expect(new URL(form.action).pathname).toBe('/settings/apps/new');
    const created = await clickThrough(await postManifest(form));
    expect(created.origin + created.pathname).toBe(`${ORIGIN}${CALLBACK_PATHS.created}`);
    const code = created.searchParams.get('code');
    const state = created.searchParams.get('state');
    await expect(app.appCreated(code, 'A'.repeat(43))).rejects.toMatchObject({ code: 'app-state-invalid' });
    // A wrong state consumed the outstanding one: the owner starts again.
    const form2 = await app.newApp(ORIGIN);
    const created2 = await clickThrough(await postManifest(form2));
    const result = await app.appCreated(created2.searchParams.get('code'), created2.searchParams.get('state'));
    expect(result.app).toMatchObject({ createdBy: 'manifest', signIn: 'web' });
    expect(result.app.clientId).toMatch(/^Iv23li/u);
    expect(JSON.stringify(result)).not.toMatch(/cbsCANARY|clientSecret/u);
    await expect(app.appCreated(created2.searchParams.get('code'), created2.searchParams.get('state'))).rejects.toMatchObject({ code: 'app-state-invalid' });
    await expect(app.newApp(ORIGIN)).rejects.toMatchObject({ code: 'app-exists' });
    expect(code).not.toBe(created2.searchParams.get('code'));
    expect(state).not.toBe(created2.searchParams.get('state'));

    const registration = path.join(stateDirectory, REGISTRATION_FILE);
    expect((await stat(registration)).mode & 0o777).toBe(0o600);
    const saved = JSON.parse(await readFile(registration, 'utf8'));
    expect(saved).toMatchObject({ createdBy: 'manifest', clientSecret: expect.stringMatching(/^cbsCANARY/u) });
    for (const file of await filesUnder(stateDirectory)) expect(await readFile(file, 'utf8')).not.toMatch(PEM);

    const status = await app.status();
    expect(status).toMatchObject({ state: 'not-connected', app: { signIn: 'web', clientId: result.app.clientId } });
    expect(JSON.stringify(status)).not.toMatch(/cbsCANARY/u);
    await expect(app.startSignIn()).rejects.toMatchObject({ code: 'web-sign-in-only' });

    // Back from GitHub's setup URL without an install click: refused.
    await expect(app.appInstalled(ORIGIN)).rejects.toMatchObject({ code: 'app-state-invalid' });
    const install = await app.installApp(ORIGIN);
    const back = await clickThrough(await fetch(install.url, { redirect: 'manual' }));
    expect(back.origin + back.pathname).toBe(`${ORIGIN}${CALLBACK_PATHS.installed}`);
    await expect(app.appInstalled('http://127.0.0.1:1234')).rejects.toMatchObject({ code: 'app-state-invalid' });
    await app.installApp(ORIGIN);
    const authorize = await app.appInstalled(ORIGIN);
    await expect(app.appInstalled(ORIGIN)).rejects.toMatchObject({ code: 'app-state-invalid' });
    const authorizeUrl = new URL(authorize.url);
    expect(authorizeUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorizeUrl.searchParams.get('redirect_uri')).toBe(`${ORIGIN}${CALLBACK_PATHS.authorized}`);
    expect(authorize.url).not.toMatch(/cbsCANARY/u);
    const authorized = await clickThrough(await fetch(authorize.url, { redirect: 'manual' }));
    await expect(app.appAuthorized(authorized.searchParams.get('code'), 'B'.repeat(43))).rejects.toMatchObject({ code: 'app-state-invalid' });
    // That consumed the state too; sign in again.
    const again = await app.webSignIn(ORIGIN);
    const authorized2 = await clickThrough(await fetch(again.url, { redirect: 'manual' }));
    await app.appAuthorized(authorized2.searchParams.get('code'), authorized2.searchParams.get('state'));
    expect(await app.status()).toMatchObject({ state: 'pick-repository', app: { signIn: 'web' } });
    const listing = await app.listRepositories();
    expect(listing.repositories.map((row) => [row.fullName, row.problem])).toEqual([['cybersader/cyberchief', null]]);

    // Refresh uses the client secret (the fake refuses a manifest app's refresh without it).
    await fake.expireAccess();
    expect((await app.listRepositories()).repositories).toHaveLength(1);
    const report = await fake.report();
    expect(report.manifest).toMatchObject({ created: 2, converted: 1, installs: 1, authorizations: 2, webExchanges: 1 });
    expect(report.refreshes).toBeGreaterThan(0);
    for (const file of await filesUnder(stateDirectory)) expect(await readFile(file, 'utf8')).not.toMatch(PEM);
    app.close();
  });

  test('a conversion GitHub refuses, or a replayed code, leaves no app', async () => {
    const { access: app, stateDirectory } = access();
    const form = await app.newApp(ORIGIN);
    const created = await clickThrough(await postManifest(form));
    const code = created.searchParams.get('code');
    // Someone else converts the code first (GitHub codes are one-use).
    expect((await fetch(`${fake.origin}/app-manifests/${code}/conversions`, { method: 'POST' })).status).toBe(201);
    await expect(app.appCreated(code, created.searchParams.get('state'))).rejects.toMatchObject({ code: 'app-conversion-failed' });
    expect(await app.status()).toEqual({ provider: 'github-app', state: 'no-app' });
    await expect(readFile(path.join(stateDirectory, REGISTRATION_FILE))).rejects.toMatchObject({ code: 'ENOENT' });
    app.close();
  });

  test('a configured device-flow client keeps the device flow and has no web sign-in', async () => {
    const { access: app } = access({ clientId: 'Iv23liFAKEcyberbaser' });
    expect(await app.status()).toMatchObject({ state: 'not-connected', app: { signIn: 'device' } });
    await expect(app.webSignIn(ORIGIN)).rejects.toMatchObject({ code: 'device-flow-only' });
    await expect(app.newApp(ORIGIN)).rejects.toMatchObject({ code: 'app-exists' });
    app.close();
  });

  test('the control socket refuses a non-loopback origin or a malformed code before sending', async () => {
    await expect(forgeRequest({ socketPath: '/tmp/none.sock', op: 'new-app', origin: 'https://evil.example' })).rejects.toMatchObject({ code: 'forge-invalid-request' });
    await expect(forgeRequest({ socketPath: '/tmp/none.sock', op: 'app-created', code: '../../x', state: 'A'.repeat(43) })).rejects.toMatchObject({ code: 'forge-invalid-request' });
    await expect(forgeRequest({ socketPath: '/tmp/none.sock', op: 'app-authorized', code: 'abcdefgh1234', state: 'short' })).rejects.toMatchObject({ code: 'forge-invalid-request' });
  });
});

// ---------------------------------------------------------------- setup pages

async function startForge(directory) {
  const ipc = path.join(directory, 'ipc');
  await mkdir(ipc, { mode: 0o700 });
  await chmod(ipc, 0o700);
  const socketPath = path.join(ipc, 'p.sock');
  const runner = path.join(directory, 'forge.mjs');
  const moduleUrl = (name) => JSON.stringify(pathToFileURL(path.join(APP, 'src', name)).href);
  await writeFile(runner, `import { createGithubAppAccess, createGithubHttp } from ${moduleUrl('publisher/forge-access.js')};
import { startForgeControl } from ${moduleUrl('publisher/forge-control.js')};
const [socketPath, stateDirectory, origin] = process.argv.slice(2);
const access = createGithubAppAccess({ clientId: null, stateDirectory, remoteUrl: null, http: createGithubHttp({ apiBaseUrl: origin, webBaseUrl: origin }) });
const control = await startForgeControl({ socketPath, forgeAccess: access });
process.stdout.write('forge ready\\n');
process.once('SIGTERM', async () => { access.close(); await control.close(); process.exit(0); });
`);
  const output = [];
  const forge = spawn(process.execPath, [runner, socketPath, path.join(directory, 'forge'), fake.origin], { stdio: ['ignore', 'pipe', 'pipe'] });
  forge.stdout.on('data', (chunk) => output.push(String(chunk)));
  forge.stderr.on('data', (chunk) => output.push(String(chunk)));
  cleanup.push(() => forge.kill('SIGTERM'));
  await new Promise((resolve, reject) => {
    forge.stdout.on('data', (chunk) => { if (String(chunk).includes('forge ready')) resolve(); });
    forge.once('exit', (code) => reject(new Error(`forge exited ${code}`)));
  });
  return { socketPath, output };
}

let nextPort = 47560;
async function setupHarness({ directory, relay }) {
  const state = await openSetupState(path.join(directory, 'state'));
  const tools = ownerHttpTools();
  const links = createSetupLinks({ createToken: tools.token, sameSecret: tools.sameSecret });
  const notes = createNotesPreparer({ state, directory: path.join(directory, 'state') });
  const port = nextPort++;
  const handler = createFirstRunHandler({ listen: { host: '127.0.0.1', port }, state, links, relay: relay?.(state) ?? null, notes });
  const origin = `http://127.0.0.1:${port}`;
  let cookie = null;
  async function call(route, { body, withCookie = true } = {}) {
    const response = await handler(new Request(new URL(route, origin), {
      method: body === undefined ? 'GET' : 'POST', redirect: 'manual',
      headers: { Host: `127.0.0.1:${port}`, Origin: origin, ...(cookie && withCookie ? { Cookie: cookie } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
    const text = await response.text();
    return { status: response.status, text, headers: response.headers, value: text.startsWith('{') ? JSON.parse(text) : null };
  }
  const opened = await call(`/setup/start?token=${links.issue()}`);
  cookie = opened.headers.get('set-cookie').split(';', 1)[0];
  const csrf = /data-csrf="([^"]+)"/u.exec((await call('/setup')).text)[1];
  const step = async (action, value = null) => call('/setup/step', { body: { csrf, step: state.read().step, action, value } });
  return { state, call, step, origin, csrf };
}

describe('setup pages', () => {
  test('the owner clicks only GitHub\'s buttons: create, install, authorize, back in setup connected', async () => {
    await fake.scenario({ installations: 'exact', repository: 'cybersader/cyberchief', requireInstall: true });
    const directory = await mkdtemp(path.join(os.tmpdir(), 'oa-manifest-setup-'));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const forge = await startForge(directory);
    const h = await setupHarness({ directory, relay: (state) => createSetupForgeRelay({ socketPath: forge.socketPath, state }) });
    expect((await h.step('start')).value.step).toBe('github');
    expect((await h.call('/owner/github/state')).value).toMatchObject({ ok: true, state: 'no-app' });

    // Cross-site arrivals carry no cookie: the create page needs the session.
    expect((await h.call('/setup/github/create', { withCookie: false })).status).toBe(403);
    const page = await h.call('/setup/github/create');
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain(`form-action 'self' ${fake.origin}`);
    const action = /<form id="github-create" method="post" action="([^"]+)"/u.exec(page.text)[1].replaceAll('&amp;', '&');
    const manifest = /name="manifest" value="([^"]+)"/u.exec(page.text)[1].replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&amp;', '&');
    expect(JSON.parse(manifest).redirect_url).toBe(`${h.origin}${CALLBACK_PATHS.created}`);
    const created = await clickThrough(await postManifest({ action, manifest }));
    const back = await h.call(created.pathname + created.search, { withCookie: false });
    expect(back.status).toBe(200);
    expect(back.headers.get('refresh')).toBe('0; url=/setup');
    expect(h.state.read().forgeApp.clientId).toMatch(/^Iv23li/u);
    // The same return again is refused: the state was used.
    expect((await h.call(created.pathname + created.search, { withCookie: false })).status).toBe(409);

    expect((await h.call('/owner/github/state')).value).toMatchObject({ state: 'not-connected', app: { signIn: 'web' } });
    const install = await h.call('/setup/github/install');
    expect(install.status).toBe(303);
    const installed = await clickThrough(await fetch(install.headers.get('location'), { redirect: 'manual' }));
    const toAuthorize = await h.call(installed.pathname + installed.search, { withCookie: false });
    expect(toAuthorize.status).toBe(303);
    const authorized = await clickThrough(await fetch(toAuthorize.headers.get('location'), { redirect: 'manual' }));
    const done = await h.call(authorized.pathname + authorized.search, { withCookie: false });
    expect(done.status).toBe(200);
    // The one repository the app is on was picked for the owner.
    expect((await h.call('/owner/github/state')).value).toMatchObject({ state: 'connected', repository: 'cybersader/cyberchief' });
    expect((await h.step('continue')).value.step).toBe('notes');
    const finished = h.state.read();
    const { config } = ownerConfigFromSetup({ ...finished, website: { source: 'private', url: null } }, {
      listen: { host: '127.0.0.1', port: 47999 }, checkout: path.join(directory, 'notes'), publisherSocket: forge.socketPath,
      reviewSocket: path.join(directory, 'review.sock'), irohStateDirectory: path.join(directory, 'iroh'),
      forgeStateDirectory: path.join(directory, 'forge'), clientId: null,
    });
    expect(config.forgeAccess.clientId).toBe(finished.forgeApp.clientId);

    // Nothing secret on the node side, and no private key on either side.
    const nodeText = (await Promise.all((await filesUnder(path.join(directory, 'state'))).map((file) => readFile(file, 'utf8')))).join('\n');
    expect(nodeText).not.toMatch(/cbsCANARY|gh[ur]_CANARY/u);
    expect(nodeText).not.toMatch(PEM);
    for (const file of await filesUnder(path.join(directory, 'forge'))) expect(await readFile(file, 'utf8')).not.toMatch(PEM);
    expect(forge.output.join('')).not.toMatch(/cbsCANARY|gh[ur]_CANARY|BEGIN|FAKEPEMCANARY|whsCANARY/u);
  }, 30000);

  test('GitHub returns are refused when forged, malformed, without a publisher or after setup', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'oa-manifest-refuse-'));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const asked = [];
    const stub = () => ({ provider: 'github-app', configuredRepository: '', restartFor: null,
      ask: async () => ({ state: 'no-app' }),
      askWith: async (op, fields) => { asked.push([op, fields]); throw Object.assign(new Error('x'), { code: 'app-state-invalid' }); },
      pick: async () => ({}) });
    const h = await setupHarness({ directory, relay: stub });
    const good = `code=abcdef0123456789&state=${'C'.repeat(43)}`;
    expect((await h.call(`${CALLBACK_PATHS.created}?code=abcdef0123456789`, { withCookie: false })).status).toBe(403);
    expect((await h.call(`${CALLBACK_PATHS.created}?${good}&extra=1`, { withCookie: false })).status).toBe(403);
    expect((await h.call(`${CALLBACK_PATHS.created}?${good}&code=again`, { withCookie: false })).status).toBe(400);
    expect((await h.call(`${CALLBACK_PATHS.created}?code=..%2F..%2Fx&state=${'C'.repeat(43)}`, { withCookie: false })).status).toBe(403);
    expect((await h.call(`${CALLBACK_PATHS.installed}?installation_id=1&evil=1`, { withCookie: false })).status).toBe(403);
    expect(asked).toEqual([]);
    // Well-formed but unknown to the publisher.
    expect((await h.call(`${CALLBACK_PATHS.created}?${good}`, { withCookie: false })).status).toBe(409);
    expect((await h.call(`${CALLBACK_PATHS.authorized}?${good}`, { withCookie: false })).status).toBe(409);
    expect((await h.call(`${CALLBACK_PATHS.installed}?installation_id=1&setup_action=install`, { withCookie: false })).status).toBe(409);
    expect(asked.map(([op]) => op)).toEqual(['app-created', 'app-authorized', 'app-installed']);
    expect(asked[2][1]).toEqual({ origin: h.origin });
    // A denied authorization is shown plainly, nothing asked.
    const denied = await h.call(`${CALLBACK_PATHS.authorized}?error=access_denied&state=${'C'.repeat(43)}`, { withCookie: false });
    expect(denied.text).toContain('Sign-in was cancelled');
    expect(asked).toHaveLength(3);
    // POST is not a GitHub return.
    expect((await h.call(`${CALLBACK_PATHS.created}?${good}`, { body: {} })).status).toBe(405);
    // The create, install and sign-in pages only open on the GitHub step.
    expect((await h.call('/setup/github/create')).status).toBe(303);

    const noRelay = await setupHarness({ directory: await mkdtemp(path.join(os.tmpdir(), 'oa-manifest-norelay-')), relay: () => null });
    expect((await noRelay.call(`${CALLBACK_PATHS.created}?${good}`, { withCookie: false })).status).toBe(503);

    await h.state.update((now) => ({ ...now, step: 'done', completedAt: new Date().toISOString() }));
    expect((await h.call(`${CALLBACK_PATHS.created}?${good}`, { withCookie: false })).status).toBe(410);
    expect(asked).toHaveLength(3);
  });
});

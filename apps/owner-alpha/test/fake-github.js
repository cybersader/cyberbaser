#!/usr/bin/env bun
// A local stand-in for the parts of GitHub that ForgeAccess uses. Run it as its
// own process so the tokens it mints never enter the test (node) process:
//
//   bun test/fake-github.js <repositories-root>   -> prints "fake-github ready <port>"
//
// Device flow (/login/device/code, /login/oauth/access_token with pending,
// slow_down, expired, denied), refresh-token rotation, installations and their
// repositories with pagination, /repos/:owner/:name for pasted tokens, and Git
// smart HTTP backed by real bare repositories through `git http-backend`.
// Controls under /_control report counts and booleans only, never a token.
//
// The GitHub App manifest flow, with GitHub's buttons as plain pages a test
// "clicks" by posting their one form: the new-app page (POST
// /settings/apps/new?state=, then Create), POST /app-manifests/:code/conversions
// (answering with a canary private key and webhook secret the publisher must
// drop), the install page (then Install, back to the app's setup URL), and the
// authorize page (then Authorize, back to the callback with code and state),
// whose code is exchanged with the client secret and the PKCE verifier.
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';

const reposRoot = path.resolve(process.argv[2] ?? '.');
const CLIENT_ID = 'Iv23liFAKEcyberbaser';
const random = (n = 18) => randomBytes(n).toString('hex');

const state = {
  scenario: { polls: ['authorization_pending', 'ok'], deviceFlowDisabled: false, installations: 'mixed' },
  devices: new Map(),
  access: new Map(), // token -> { generation, expiresAt, revoked }
  refresh: new Map(), // token -> { used }
  pats: new Map(), // token -> { repository }
  generation: 0,
  pushes: [],
  fetches: [],
  denied: [],
  pollLog: [],
  refreshes: 0,
  apiCalls: 0,
  // Every request path that is not Git transport or a control (no query, so no
  // token): proves what the node and publisher asked GitHub for.
  routes: new Set(),
  apps: new Map(), // client id -> manifest-created app (with its secret)
  manifestPages: new Map(), // page -> { manifest, state }
  conversions: new Map(), // code -> client id, one use
  installPages: new Map(), // page -> { app, state }
  authorizePages: new Map(), // page -> { app, redirectUri, state, challenge }
  oauthCodes: new Map(), // code -> { clientId, redirectUri, challenge }
  installed: false,
  manifestReport: { created: 0, converted: 0, refusedConversions: 0, installs: 0, authorizations: 0, webExchanges: 0, refusedExchanges: 0,
    lastManifest: null },
};

function html(body, status = 200) {
  return new Response(`<!doctype html><meta charset="utf-8">${body}`, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
const attr = (value) => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
const redirect = (location) => new Response(null, { status: 302, headers: { Location: location } });

// What GitHub would check on its new-app page, plus what Cyberbaser promises.
function manifestProblem(manifest) {
  if (!manifest || typeof manifest !== 'object') return 'not an object';
  const loopback = (value) => typeof value === 'string' && value.startsWith('http://127.0.0.1:');
  if (typeof manifest.url !== 'string' || typeof manifest.hook_attributes?.url !== 'string') return 'url and hook_attributes.url are required';
  if (manifest.hook_attributes.active !== false) return 'webhook must be off';
  if (manifest.public !== false) return 'must be private';
  if (JSON.stringify(manifest.default_permissions) !== JSON.stringify({ contents: 'write', metadata: 'read' })) return 'permissions';
  if (!Array.isArray(manifest.default_events) || manifest.default_events.length !== 0) return 'events';
  if (!loopback(manifest.redirect_url) || !loopback(manifest.setup_url) || !Array.isArray(manifest.callback_urls)
    || manifest.callback_urls.length !== 1 || !loopback(manifest.callback_urls[0])) return 'urls';
  if (manifest.request_oauth_on_install !== false) return 'install-time OAuth must be off';
  if (typeof manifest.name !== 'string' || manifest.name.length === 0 || manifest.name.length > 34) return 'name';
  return null;
}

function repo(fullName, { isPrivate = true, pushed = '2026-11-20T10:00:00Z', push = true } = {}) {
  const [owner, name] = fullName.split('/');
  return { id: Math.abs([...fullName].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7)), name, full_name: fullName,
    owner: { login: owner }, private: isPrivate, pushed_at: pushed, updated_at: pushed, permissions: { admin: false, push, pull: true } };
}

const RIGHT = { contents: 'write', metadata: 'read' };
function installations() {
  const many = Array.from({ length: 205 }, (_, i) => repo(`big-org/repo-${String(i + 1).padStart(3, '0')}`, { isPrivate: i % 3 === 0, pushed: '2025-01-05T00:00:00Z' }));
  const sets = {
    mixed: [
      { id: 11, account: { login: 'cybersader' }, repository_selection: 'selected', permissions: RIGHT, repos: [repo('cybersader/cyberbase', { pushed: '2026-11-22T18:00:00Z' })] },
      { id: 12, account: { login: 'cybersader-lab' }, repository_selection: 'selected', permissions: RIGHT, repos: [repo('cybersader-lab/field-notes', { isPrivate: false, pushed: '2026-10-02T09:00:00Z' })] },
      { id: 13, account: { login: 'wide-co' }, repository_selection: 'selected', permissions: { ...RIGHT, workflows: 'write' }, repos: [repo('wide-co/handbook', { pushed: '2026-09-14T09:00:00Z' })] },
      { id: 14, account: { login: 'big-org' }, repository_selection: 'all', permissions: RIGHT, repos: many },
    ],
    'over-broad': [
      { id: 11, account: { login: 'cybersader' }, repository_selection: 'selected', permissions: { contents: 'write', metadata: 'read', administration: 'write' }, repos: [repo('cybersader/cyberbase')] },
    ],
    // The app installed on exactly one repository (scenario.repository, by default cybersader/cyberbase).
    exact: [
      { id: 11, account: { login: 'cybersader' }, repository_selection: 'selected', permissions: RIGHT,
        repos: [repo(state.scenario.repository ?? 'cybersader/cyberbase')] },
    ],
  };
  // Manifest scenarios: nothing is installed until the install page is clicked.
  if (state.scenario.requireInstall && !state.installed) return [];
  return sets[state.scenario.installations] ?? sets.mixed;
}

function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function issue() {
  state.generation += 1;
  const access = `ghu_CANARY${random()}`;
  const refresh = `ghr_CANARY${random()}`;
  state.access.set(access, { generation: state.generation, expiresAt: Date.now() + 8 * 3600_000, revoked: false });
  state.refresh.set(refresh, { used: false });
  return { access_token: access, expires_in: 28800, refresh_token: refresh, refresh_token_expires_in: 15897600, scope: '', token_type: 'bearer' };
}

function bearer(request) {
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer (\S+)$/u.exec(header);
  if (!match) return null;
  const token = match[1];
  const access = state.access.get(token);
  if (access && !access.revoked && access.expiresAt > Date.now()) return { kind: 'app', ...access };
  if (state.pats.has(token)) return { kind: 'pat', ...state.pats.get(token) };
  return null;
}

async function form(request) {
  return Object.fromEntries(new URLSearchParams(await request.text()));
}

function paginate(url, items) {
  const perPage = Math.min(100, Number(url.searchParams.get('per_page') ?? 30));
  const page = Math.max(1, Number(url.searchParams.get('page') ?? 1));
  return items.slice((page - 1) * perPage, page * perPage);
}

function gitAuth(request, fullName) {
  const header = request.headers.get('authorization') ?? '';
  const match = /^Basic (\S+)$/u.exec(header);
  if (!match) return null;
  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  const password = decoded.slice(decoded.indexOf(':') + 1);
  const access = state.access.get(password);
  if (access && !access.revoked && access.expiresAt > Date.now()) {
    const fit = installations().find((entry) => entry.repos.some((r) => r.full_name === fullName));
    if (!fit || fit.permissions.contents !== 'write') return null;
    return { kind: 'app', generation: access.generation };
  }
  const pat = state.pats.get(password);
  if (pat && pat.repository === fullName) return { kind: 'pat', generation: 0 };
  return null;
}

async function gitBackend(request, url, pathInfo, fullName) {
  const receive = url.searchParams.get('service') === 'git-receive-pack' || pathInfo.endsWith('/git-receive-pack');
  // Reads may be anonymous when a scenario says so (the owner's own checkout
  // reads with its own Git setup); writes always need the publisher's token.
  const auth = gitAuth(request, fullName) ?? (!receive && state.scenario.anonymousRead ? { kind: 'anonymous', generation: 0 } : null);
  if (auth === null) {
    state.denied.push({ receive, hadAuthorization: request.headers.has('authorization') });
    return new Response('auth required', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="fake-github"' } });
  }
  const latest = state.generation;
  if (auth.kind === 'anonymous') return backend(request, url, pathInfo);
  if (request.method === "POST") (receive ? state.pushes : state.fetches).push({ kind: auth.kind, generation: auth.generation, current: auth.kind === 'pat' || auth.generation === latest });
  return backend(request, url, pathInfo);
}

async function backend(request, url, pathInfo) {
  const body = request.body ? Buffer.from(await request.arrayBuffer()) : Buffer.alloc(0);
  const child = spawn('git', ['http-backend'], {
    env: {
      PATH: process.env.PATH, GIT_PROJECT_ROOT: reposRoot, GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: pathInfo,
      REQUEST_METHOD: request.method, QUERY_STRING: url.search.slice(1), CONTENT_TYPE: request.headers.get('content-type') ?? '',
      CONTENT_LENGTH: String(body.length), REMOTE_USER: 'owner', REMOTE_ADDR: '127.0.0.1',
      HTTP_CONTENT_ENCODING: request.headers.get('content-encoding') ?? '', GIT_CONFIG_NOSYSTEM: '1', HOME: reposRoot,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.end(body);
  const chunks = [];
  for await (const chunk of child.stdout) chunks.push(chunk);
  await new Promise((resolve) => child.once('close', resolve));
  const output = Buffer.concat(chunks);
  const split = output.indexOf('\r\n\r\n');
  const head = output.subarray(0, split).toString('latin1');
  const headers = {};
  let status = 200;
  for (const line of head.split('\r\n')) {
    const at = line.indexOf(':');
    const name = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();
    if (name.toLowerCase() === 'status') status = Number(value.split(' ')[0]);
    else headers[name] = value;
  }
  return new Response(output.subarray(split + 4), { status, headers });
}

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: Number(process.env.FAKE_GITHUB_PORT ?? 0),
  async fetch(request) {
    const url = new URL(request.url);
    const route = url.pathname;
    if (!route.startsWith('/git/') && !route.startsWith('/_control/')) state.routes.add(`${request.method} ${route.replace(/\/[0-9a-f]{40}\b/gu, '/<sha>')}`);

    if (route === '/login/device') {
      return new Response('<!doctype html><title>Device activation</title><h1>Device activation</h1><p>Fake GitHub: enter the code.</p>', { headers: { 'Content-Type': 'text/html' } });
    }
    // ---- the GitHub App manifest flow
    if (route === '/settings/apps/new' && request.method === 'POST') {
      const fields = await form(request);
      let manifest = null;
      try { manifest = JSON.parse(fields.manifest ?? ''); } catch { manifest = null; }
      const wrong = manifestProblem(manifest);
      if (wrong) return html(`<h1>Invalid manifest</h1><p>${attr(wrong)}</p>`, 422);
      const page = random(12);
      state.manifestPages.set(page, { manifest, state: url.searchParams.get('state') });
      state.manifestReport.lastManifest = manifest;
      return html(`<h1>Create GitHub App for cybersader</h1><form method="post" action="/settings/apps/new/create"><input type="hidden" name="page" value="${page}">`
        + `<label>GitHub App name <input name="name" value="${attr(manifest.name)}"></label><button>Create GitHub App for cybersader</button></form>`);
    }
    if (route === '/settings/apps/new/create' && request.method === 'POST') {
      const fields = await form(request);
      const pending = state.manifestPages.get(fields.page);
      if (!pending) return html('<h1>Expired</h1>', 404);
      state.manifestPages.delete(fields.page);
      const clientId = `Iv23li${random(5)}`;
      const slug = (fields.name || pending.manifest.name).toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '');
      const app = { id: 900000 + state.apps.size + 1, slug, name: fields.name || pending.manifest.name, clientId,
        clientSecret: `cbsCANARY${random(16)}`, callbackUrls: pending.manifest.callback_urls, setupUrl: pending.manifest.setup_url };
      state.apps.set(clientId, app);
      const code = random(20);
      state.conversions.set(code, clientId);
      state.manifestReport.created += 1;
      const back = new URL(pending.manifest.redirect_url);
      back.searchParams.set('code', code);
      if (pending.state !== null) back.searchParams.set('state', pending.state);
      return redirect(back.toString());
    }
    const conversion = /^\/app-manifests\/([^/]+)\/conversions$/u.exec(route);
    if (conversion && request.method === 'POST') {
      const clientId = state.conversions.get(conversion[1]);
      if (!clientId) { state.manifestReport.refusedConversions += 1; return json({ message: 'Not Found' }, 404); }
      state.conversions.delete(conversion[1]);
      const app = state.apps.get(clientId);
      state.manifestReport.converted += 1;
      return json({ id: app.id, slug: app.slug, node_id: `A_${random(6)}`, name: app.name, description: '', external_url: 'https://github.com/cybersader/cyberbaser',
        html_url: `${url.origin}/apps/${app.slug}`, owner: { login: 'cybersader', id: 4242, type: 'User' },
        permissions: { contents: 'write', metadata: 'read' }, events: [], client_id: app.clientId, client_secret: app.clientSecret,
        webhook_secret: `whsCANARY${random(16)}`,
        pem: `-----BEGIN RSA PRIVATE KEY-----\nFAKEPEMCANARY${random(32)}\n-----END RSA PRIVATE KEY-----\n` }, 201);
    }
    const installPage = /^\/apps\/([a-z0-9-]+)\/installations\/new$/u.exec(route);
    if (installPage && request.method === 'GET') {
      const app = [...state.apps.values()].find((entry) => entry.slug === installPage[1]);
      if (!app) return html('<h1>Not Found</h1>', 404);
      const page = random(12);
      state.installPages.set(page, { app, state: url.searchParams.get('state') });
      return html(`<h1>Install ${attr(app.name)}</h1><form method="post" action="/apps/${app.slug}/installations/new/confirm"><input type="hidden" name="page" value="${page}">`
        + '<label><input type="radio" name="selection" value="selected" checked> Only select repositories</label><button>Install</button></form>');
    }
    if (/^\/apps\/[a-z0-9-]+\/installations\/new\/confirm$/u.test(route) && request.method === 'POST') {
      const fields = await form(request);
      const pending = state.installPages.get(fields.page);
      if (!pending) return html('<h1>Expired</h1>', 404);
      state.installPages.delete(fields.page);
      state.installed = true;
      state.manifestReport.installs += 1;
      const back = new URL(pending.app.setupUrl);
      back.searchParams.set('installation_id', '11');
      back.searchParams.set('setup_action', 'install');
      if (pending.state !== null) back.searchParams.set('state', pending.state);
      return redirect(back.toString());
    }
    if (route === '/login/oauth/authorize' && request.method === 'GET') {
      const app = state.apps.get(url.searchParams.get('client_id'));
      const redirectUri = url.searchParams.get('redirect_uri');
      if (!app || !app.callbackUrls.includes(redirectUri)) return html('<h1>The redirect_uri is not associated with this application.</h1>', 400);
      if (url.searchParams.get('code_challenge_method') !== 'S256' || !url.searchParams.get('code_challenge')) return html('<h1>PKCE required in this fake</h1>', 400);
      const page = random(12);
      state.authorizePages.set(page, { app, redirectUri, state: url.searchParams.get('state'), challenge: url.searchParams.get('code_challenge') });
      return html(`<h1>Authorize ${attr(app.name)}</h1><form method="post" action="/login/oauth/authorize/confirm"><input type="hidden" name="page" value="${page}"><button>Authorize ${attr(app.name)}</button></form>`);
    }
    if (route === '/login/oauth/authorize/confirm' && request.method === 'POST') {
      const fields = await form(request);
      const pending = state.authorizePages.get(fields.page);
      if (!pending) return html('<h1>Expired</h1>', 404);
      state.authorizePages.delete(fields.page);
      const code = random(10);
      state.oauthCodes.set(code, { clientId: pending.app.clientId, redirectUri: pending.redirectUri, challenge: pending.challenge });
      state.manifestReport.authorizations += 1;
      const back = new URL(pending.redirectUri);
      back.searchParams.set('code', code);
      if (pending.state !== null) back.searchParams.set('state', pending.state);
      return redirect(back.toString());
    }

    if (route === '/login/device/code' && request.method === 'POST') {
      const fields = await form(request);
      if (state.apps.has(fields.client_id)) return json({ error: 'device_flow_disabled' }, 400);
      if (fields.client_id !== CLIENT_ID) return json({ error: 'Not Found' }, 404);
      if (state.scenario.deviceFlowDisabled) return json({ error: 'device_flow_disabled' }, 400);
      if (fields.client_secret !== undefined) return json({ error: 'unexpected_client_secret' }, 400);
      const deviceCode = random(20);
      const letters = 'BCDFGHJKLMNPQRSTVWXZ0123456789';
      const userCode = Array.from({ length: 8 }, () => letters[randomBytes(1)[0] % letters.length]).join('').replace(/^(.{4})/u, '$1-');
      state.devices.set(deviceCode, { polls: [...state.scenario.polls], interval: 5, lastPoll: 0 });
      return json({ device_code: deviceCode, user_code: userCode, verification_uri: `${url.origin}/login/device`, expires_in: 900, interval: 5 });
    }
    if (route === '/login/oauth/access_token' && request.method === 'POST') {
      const fields = await form(request);
      const manifestApp = state.apps.get(fields.client_id);
      if (manifestApp) {
        if (fields.client_secret !== manifestApp.clientSecret) { state.manifestReport.refusedExchanges += 1; return json({ error: 'incorrect_client_credentials' }); }
      } else {
        if (fields.client_id !== CLIENT_ID) return json({ error: 'incorrect_client_credentials' });
        if (fields.client_secret !== undefined) return json({ error: 'unexpected_client_secret' });
      }
      if (fields.code !== undefined && fields.grant_type === undefined) {
        const entry = state.oauthCodes.get(fields.code);
        state.oauthCodes.delete(fields.code);
        const verified = entry && manifestApp && entry.clientId === manifestApp.clientId && entry.redirectUri === fields.redirect_uri
          && createHash('sha256').update(fields.code_verifier ?? '').digest('base64url') === entry.challenge;
        if (!verified) { state.manifestReport.refusedExchanges += 1; return json({ error: 'bad_verification_code' }); }
        state.manifestReport.webExchanges += 1;
        return json(issue());
      }
      if (fields.grant_type === 'urn:ietf:params:oauth:grant-type:device_code') {
        if (manifestApp) return json({ error: 'device_flow_disabled' });
        const device = state.devices.get(fields.device_code);
        if (!device) return json({ error: 'incorrect_device_code' });
        const next = device.polls.length > 1 ? device.polls.shift() : device.polls[0];
        state.pollLog.push(next);
        if (next === 'slow_down') { device.interval += 5; return json({ error: 'slow_down', interval: device.interval }); }
        if (next === 'ok') { state.devices.delete(fields.device_code); return json(issue()); }
        if (['expired_token', 'access_denied'].includes(next)) state.devices.delete(fields.device_code);
        return json({ error: next });
      }
      if (fields.grant_type === 'refresh_token') {
        const entry = state.refresh.get(fields.refresh_token);
        if (!entry || entry.used) return json({ error: 'bad_refresh_token' });
        entry.used = true;
        for (const access of state.access.values()) access.revoked = true; // old access stops working too
        state.refreshes += 1;
        return json(issue());
      }
      return json({ error: 'unsupported_grant_type' });
    }

    if (route === '/user/installations') {
      state.apiCalls += 1;
      const who = bearer(request);
      if (who?.kind !== 'app') return json({ message: 'Bad credentials' }, 401);
      const list = installations().map(({ repos, ...rest }) => rest);
      return json({ total_count: list.length, installations: paginate(url, list) });
    }
    const repositories = /^\/user\/installations\/(\d+)\/repositories$/u.exec(route);
    if (repositories) {
      state.apiCalls += 1;
      const who = bearer(request);
      if (who?.kind !== 'app') return json({ message: 'Bad credentials' }, 401);
      const installation = installations().find((entry) => entry.id === Number(repositories[1]));
      if (!installation) return json({ message: 'Not Found' }, 404);
      return json({ total_count: installation.repos.length, repository_selection: installation.repository_selection, repositories: paginate(url, installation.repos) });
    }
    const single = /^\/repos\/([^/]+)\/([^/]+)$/u.exec(route);
    if (single) {
      const who = bearer(request);
      if (who === null) return json({ message: 'Bad credentials' }, 401);
      const fullName = `${single[1]}/${single[2]}`;
      if (who.kind === 'pat' && who.repository !== fullName) return json({ message: 'Not Found' }, 404);
      return json(repo(fullName, { push: true }));
    }

    const git = /^\/git(\/([^/]+\/[^/]+)\.git\/.*)$/u.exec(route);
    if (git) return gitBackend(request, url, git[1], git[2]);

    if (route === '/_control/scenario' && request.method === 'POST') {
      state.scenario = { ...state.scenario, ...(await request.json()) };
      return json({ ok: true });
    }
    if (route === '/_control/pat' && request.method === 'POST') {
      const { token, repository } = await request.json();
      state.pats.set(token, { repository });
      return json({ ok: true });
    }
    if (route === '/_control/expire-access' && request.method === 'POST') {
      for (const access of state.access.values()) access.revoked = true;
      return json({ ok: true });
    }
    if (route === '/_control/revoke' && request.method === 'POST') {
      for (const access of state.access.values()) access.revoked = true;
      for (const entry of state.refresh.values()) entry.used = true;
      return json({ ok: true });
    }
    if (route === '/_control/report') {
      return json({ generation: state.generation, refreshes: state.refreshes, pushes: state.pushes, fetches: state.fetches,
        denied: state.denied, polls: state.pollLog, apiCalls: state.apiCalls, routes: [...state.routes].sort(), manifest: state.manifestReport });
    }
    return json({ message: 'Not Found' }, 404);
  },
});

process.stdout.write(`fake-github ready ${server.port}\n`);
process.on('SIGTERM', () => { server.stop(true); process.exit(0); });

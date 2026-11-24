import { afterAll, describe, expect, test } from 'bun:test';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  createFirstRunHandler, createNotesPreparer, createSetupForgeRelay, createSetupLinks, createStarterPublisher, detectWebsite, inspectPublishYml,
  openSetupState, ownerConfigFromSetup, SETUP_STATE_FILE, starterPublishYml,
} from '../src/first-run.js';
import { createMemoryEditSessionStore, createOwnerAlphaHandler, ownerHttpTools } from '../src/server.js';
import { validateOwnerAlphaConfig } from '../src/config.js';
import { FAKE_CLIENT_ID, startFakeGithub } from './fake-github-process.js';

// First-run setup: one-time loopback link, durable steps, CSRF, step order,
// no publishing, the missing publish.yml path, skip paths, and the whole flow
// against the fake GitHub with a real Git smart-HTTP clone.

const APP = path.resolve(import.meta.dir, '..');
const REAL_GIT = Bun.which('git');
const run = promisify(execFile);
const cleanup = [];
afterAll(async () => { for (const action of cleanup.reverse()) await action(); });

async function scratch(prefix) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

function git(cwd, ...args) {
  const result = spawnSync(REAL_GIT, ['-C', cwd, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

// A synthetic notes repository: two folders, one hostile folder name, a Pages
// workflow, and optionally a publish.yml. Pushed to a bare repository.
async function notesRepository(root, { publishYml = null, workflow = true, hostile = true } = {}) {
  const work = path.join(root, 'work');
  await mkdir(path.join(work, 'Garden'), { recursive: true });
  await mkdir(path.join(work, 'Journal'), { recursive: true });
  await writeFile(path.join(work, 'Garden', 'Roses.md'), '# Roses\n\nPrune in March.\n');
  await writeFile(path.join(work, 'Journal', '2026-11-01.md'), '# Private\n');
  await writeFile(path.join(work, 'Home.md'), '# Home\n');
  if (hostile) {
    await mkdir(path.join(work, '<img src=x onerror=alert(1)>'));
    await writeFile(path.join(work, '<img src=x onerror=alert(1)>', 'x.md'), 'x\n');
  }
  if (publishYml !== null) await writeFile(path.join(work, 'publish.yml'), publishYml);
  if (workflow) {
    await mkdir(path.join(work, '.github', 'workflows'), { recursive: true });
    await writeFile(path.join(work, '.github', 'workflows', 'pages.yml'), `name: Publish vault site
on:
  push:
    branches: [main]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
  deploy:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/deploy-pages@v4
`);
  }
  git(root, 'init', '-q', '--initial-branch=main', work);
  git(work, 'config', 'user.name', 'Setup Fixture');
  git(work, 'config', 'user.email', 'setup@example.invalid');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'synthetic notes');
  const bare = path.join(root, 'gh', 'cybersader', 'cyberbase.git');
  await mkdir(path.dirname(bare), { recursive: true });
  git(root, 'init', '--bare', '-q', '--initial-branch=main', bare);
  git(work, 'push', '-q', bare, 'main');
  return { bare, reposRoot: path.join(root, 'gh'), head: git(work, 'rev-parse', 'HEAD') };
}

// Local clones for unit tests: the default runner refuses the file transport.
const localGit = async (cwd, args) => String((await run(REAL_GIT, ['-c', 'protocol.file.allow=always', ...args], { cwd, encoding: 'utf8' })).stdout).trim();

function fakeRelay(state, { connected = true } = {}) {
  let bound = null;
  const relay = createSetupForgeRelay({ socketPath: '/unused/p.sock', state, request: async ({ op, repository }) => {
    if (op === 'select') { bound = repository; return { repository: { fullName: repository } }; }
    if (op === 'status' || op === 'check') return connected && bound ? { state: 'connected', repository: bound } : { state: 'pick-repository' };
    if (op === 'repositories') return { truncated: false, repositories: [{ fullName: 'cybersader/cyberbase', private: true, updatedAt: null, problem: null }] };
    return {};
  } });
  return relay;
}

function fakeReach() {
  const devices = [];
  const value = {
    store: { list: () => devices.map((entry) => ({ ...entry })), revoke: async () => {} },
    pairing: { available: () => true, list: () => [], start: () => ({ enrollmentId: 'e', code: 'c', expiresAt: Date.now() + 1000 }), cancel() {}, confirm: async () => ({}) },
  };
  return { devices, reach: async () => value };
}

let nextPort = 47410;
async function harness({ root, relay = 'fake', links = null, clock, reach, git = localGit, fetchUrlFor, buildSite, state: given, starter: withStarter = false, enrolPort = null } = {}) {
  const directory = path.join(root, 'state');
  const state = given ?? await openSetupState(directory);
  const tools = ownerHttpTools();
  let now = clock ?? (() => Date.now());
  const setupLinks = links ?? createSetupLinks({ createToken: tools.token, sameSecret: tools.sameSecret, clock: () => now(), isComplete: () => state.read().completedAt !== null });
  const notes = createNotesPreparer({ state, directory, git, fetchUrlFor, buildSite });
  const starter = withStarter ? createStarterPublisher({ checkout: notes.checkout, git }) : null;
  const completions = [];
  const port = nextPort++;
  const handler = createFirstRunHandler({ listen: { host: '127.0.0.1', port }, state, links: setupLinks,
    relay: relay === 'fake' ? fakeRelay(state) : relay, notes, starter, reach: reach ?? (async () => null), onComplete: (result) => completions.push(result), enrolPort });
  const origin = `http://127.0.0.1:${port}`;
  let cookie = null;
  let csrf = null;
  async function call(route, body, { headers = {}, server } = {}) {
    const response = await handler(new Request(`${origin}${route}`, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'manual',
      headers: { Host: `127.0.0.1:${port}`, Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), server);
    const text = await response.text();
    return { status: response.status, text, headers: response.headers, value: text.startsWith('{') ? JSON.parse(text) : null };
  }
  async function signIn() {
    const opened = await call(`/setup/start?token=${setupLinks.issue()}`);
    expect(opened.status).toBe(303);
    cookie = opened.headers.get('set-cookie').split(';', 1)[0];
    const page = await call('/setup');
    csrf = /data-csrf="([^"]+)"/u.exec(page.text)[1];
    return page;
  }
  const step = async (action, value = null) => {
    const current = /data-step="([^"]+)"/u.exec((await call('/setup')).text)[1];
    return call('/setup/step', { csrf, step: current, action, value });
  };
  const waitNotes = async () => {
    for (let i = 0; i < 500; i++) {
      const phase = state.read().notes.phase;
      if (phase === 'ready' || phase === 'failed') return phase;
      await Bun.sleep(20);
    }
    throw new Error('notes never settled');
  };
  return { state, handler, call, signIn, step, waitNotes, completions, links: setupLinks, directory, origin, port,
    setClock: (fn) => { now = fn; }, get csrf() { return csrf; }, setCookie: (value) => { cookie = value; } };
}

describe('setup link', () => {
  test('is single use, short lived, replaced by a newer one, and refused once setup is finished', async () => {
    const root = await scratch('oa-setup-link-');
    let now = 1_000_000;
    const h = await harness({ root, clock: () => now });
    const first = h.links.issue();
    const second = h.links.issue();
    expect((await h.call(`/setup/start?token=${first}`)).status).toBe(403); // replaced
    const opened = await h.call(`/setup/start?token=${second}`);
    expect(opened.status).toBe(303);
    expect(opened.headers.get('location')).toBe('/setup');
    expect(opened.headers.get('set-cookie')).toMatch(/HttpOnly; SameSite=Strict$/u);
    expect((await h.call(`/setup/start?token=${second}`)).status).toBe(403); // used
    const third = h.links.issue();
    now += 15 * 60_000;
    const late = await h.call(`/setup/start?token=${third}`);
    expect(late.status).toBe(403);
    expect(late.text).toContain('works once, for 15 minutes');
    expect((await h.call(`/setup/start?token=${h.links.issue()}&next=x`)).status).toBe(403);
  });

  test('loopback only: wrong host, other origins and non-loopback peers are refused', async () => {
    const root = await scratch('oa-setup-host-');
    const h = await harness({ root });
    expect((await h.call('/setup', undefined, { headers: { Host: 'evil.example:80' } })).status).toBe(421);
    const peer = { requestIP: () => ({ address: '192.168.1.20' }) };
    expect((await h.call(`/setup/start?token=${h.links.issue()}`, undefined, { server: peer })).status).toBe(403);
    expect((await h.call(`/setup/start?token=${h.links.issue()}`, undefined, { server: { requestIP: () => ({ address: '127.0.0.1' }) } })).status).toBe(303);
    expect(() => createFirstRunHandler({ listen: { host: '0.0.0.0', port: 1 }, state: h.state, links: h.links, notes: {} })).toThrow();
  });
});

describe('setup steps', () => {
  test('need the session and its CSRF token, and act only on the step on screen', async () => {
    const root = await scratch('oa-setup-csrf-');
    const h = await harness({ root });
    expect((await h.call('/setup')).status).toBe(403);
    expect((await h.call('/setup/step', { csrf: 'A'.repeat(43), step: 'welcome', action: 'start', value: null })).status).toBe(403);
    const page = await h.signIn();
    expect(page.status).toBe(200);
    expect(page.text).toContain('Set up Cyberbaser');
    expect(page.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect((await h.call('/owner/assets/owner.css')).status).toBe(200);
    expect((await h.call('/owner/assets/setup.js')).status).toBe(200);
    expect((await h.call('/owner/assets/github.js')).status).toBe(200);
    expect((await h.call('/setup/step', { csrf: 'A'.repeat(43), step: 'welcome', action: 'start', value: null })).status).toBe(403);
    expect((await h.call('/setup/step', { csrf: h.csrf, step: 'welcome', action: 'start', value: null }, { headers: { Origin: 'http://evil.example' } })).status).toBe(403);
    expect((await h.call('/setup/step', { csrf: h.csrf, step: 'welcome', action: 'start' })).status).toBe(400);
    // A click from a stale page does nothing.
    expect((await h.call('/setup/step', { csrf: h.csrf, step: 'notes', action: 'continue', value: null })).value).toEqual({ ok: false, code: 'step-changed' });
    expect(h.state.read().step).toBe('welcome');
    expect((await h.step('continue')).value.code).toBe('invalid');
    expect((await h.step('back')).value.code).toBe('invalid');
    expect((await h.step('start')).value).toEqual({ ok: true, step: 'github' });
    // GitHub must be connected and a repository picked before Continue.
    expect((await h.step('continue')).value.code).toBe('not-ready');
    expect((await h.step('back')).value.step).toBe('welcome');
  });

  test('missing publish.yml, skip paths, completion, and a restart resuming at the same step', async () => {
    const root = await scratch('oa-setup-flow-');
    const repo = await notesRepository(root, { workflow: false });
    const fixture = fakeReach();
    let h = await harness({ root, fetchUrlFor: () => repo.bare, reach: fixture.reach,
      buildSite: async () => ({ state: 'unavailable' }) });
    await h.signIn();
    await h.step('start');
    const githubPage = (await h.call('/setup')).text;
    expect(githubPage).toContain('data-mode="setup"');
    expect(githubPage).toContain('/owner/assets/github.js');
    // Pick through the same /owner/github routes the owner app uses.
    expect((await h.call('/owner/github/select', { csrf: h.csrf, repository: 'cybersader/cyberbase' })).value).toMatchObject({ ok: true, restartNeeded: false });
    expect(h.state.read().repository).toBe('cybersader/cyberbase');
    expect((await h.step('continue')).value.step).toBe('notes');
    expect(await h.waitNotes()).toBe('ready');

    // Restart: a new process opens the same state and a new link; the step is kept.
    // Setup prepares the starter commit; nothing is pushed until the owner's phone signs it (job-approvals.js).
    h = await harness({ root, fetchUrlFor: () => repo.bare, reach: fixture.reach, state: await openSetupState(path.join(root, 'state')), starter: true });
    const resumed = await h.signIn();
    expect(resumed.text).toContain('data-step="notes"');
    expect(resumed.text).toContain('Copied 4 notes from <strong>cybersader/cyberbase</strong>');
    expect(resumed.text).toContain('cannot build the private preview');
    expect(resumed.text).toContain('Nothing is marked public yet');
    // A multi-select list of checkboxes, none checked, and the file behind a disclosure.
    expect(resumed.text).toContain('<input type="checkbox" name="folder" value="Garden">');
    expect(resumed.text).not.toContain(' checked');
    expect(resumed.text).toContain('<summary>Show the file</summary>');
    // Folder names come from the repository and are escaped.
    expect(resumed.text).toContain('&lt;img src=x onerror=alert(1)&gt;/');
    expect(resumed.text).not.toContain('<img src=x');
    expect((await h.step('continue')).value.code).toBe('not-ready');

    // The starter file lists only folders that exist, and never on the owner's behalf.
    expect((await h.step('starter', ['../etc'])).value.code).toBe('invalid');
    expect((await h.step('starter', ['Garden', 'Garden'])).value.code).toBe('invalid');
    const checkout = path.join(h.directory, 'notes');
    // Local changes in the copy: refused, nothing prepared.
    await writeFile(path.join(checkout, 'stray.md'), 'x\n');
    expect((await h.step('starter', ['Garden'])).value.code).toBe('starter-refused');
    await rm(path.join(checkout, 'stray.md'));
    expect((await h.step('starter', ['Journal', 'Garden'])).value.ok).toBe(true);
    // One commit, one added file, exactly the starter text for the sorted folders.
    // It is only prepared: the copy and GitHub stay where they were until the owner signs it.
    const prepared = h.state.read().notes.starterCommit;
    expect(prepared).toMatch(/^[0-9a-f]{40}$/u);
    expect(h.state.read().notes.publishYml).toBe('awaiting-approval');
    expect(git(checkout, 'rev-parse', 'HEAD')).toBe(repo.head);
    expect(git(repo.bare, 'rev-parse', 'main')).toBe(repo.head);
    expect(git(checkout, 'rev-parse', `${prepared}^`)).toBe(repo.head);
    expect(git(checkout, 'diff-tree', '--no-commit-id', '--name-status', '-r', prepared)).toBe('A\tpublish.yml');
    expect(git(checkout, 'log', '-1', '--format=%s', prepared)).toBe('cyberbaser: add publish.yml');
    expect(git(checkout, 'show', `${prepared}:publish.yml`) + '\n').toBe(starterPublishYml(['Garden', 'Journal']));
    expect(git(checkout, 'status', '--porcelain')).toBe('');
    const after = (await h.call('/setup')).text;
    expect(after).toContain('It lists 2 entries');
    expect(after).toContain('when you approve it on your phone');
    expect((await h.step('continue')).value.step).toBe('website');
  });

  test('once a phone is paired, setup shows the publisher\'s own enrolment page in a frame it cannot read', async () => {
    const root = await scratch('oa-setup-enrol-');
    const fixture = fakeReach();
    const state = await openSetupState(path.join(root, 'state'));
    await state.update((now) => ({ ...now, step: 'phone', repository: 'cybersader/cyberbase',
      notes: { ...now.notes, phase: 'ready', publishYml: 'awaiting-approval', allowCount: 1, choice: 'starter', starterCommit: 'a'.repeat(40) } }));
    const h = await harness({ root, state, reach: fixture.reach, enrolPort: 4319 });
    await h.signIn();
    // No phone yet: nothing to enrol with.
    let page = await h.call('/setup');
    expect(page.text).not.toContain('setup-enrol-frame');
    // The phone paired here approves publishing, which only full access allows.
    expect(page.text).toContain('<input type="radio" name="access" value="full" checked>');
    fixture.devices.push({ keyId: 'k1', kind: 'owner-device', label: 'Pixel', grants: ['publish'], revoked: false });
    page = await h.call('/setup');
    expect(page.text).toContain('<iframe class="setup-enrol-frame" src="http://127.0.0.1:4319/enroll"');
    expect(page.text).toContain('sandbox=""');
    expect(page.text).toContain('Approvals waiting');
    // Only that one loopback origin may be framed; nothing else changes in the policy.
    const csp = page.headers.get('content-security-policy');
    expect(csp).toContain('frame-src http://127.0.0.1:4319');
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    // The code itself never passes through this app.
    expect(page.text).not.toMatch(/cyberbaser-enroll:v1/u);
    // Done says the starter file still waits for the phone.
    await state.update((now) => ({ ...now, step: 'done' }));
    expect((await h.call('/setup')).text).toContain('Waiting for your approval on your phone');
    expect((await h.call('/setup')).headers.get('content-security-policy')).not.toContain('frame-src');
  });

  test('publish nothing yet is a choice the owner can change', async () => {
    const root = await scratch('oa-setup-nothing-');
    const repo = await notesRepository(root, { workflow: false });
    const fixture = fakeReach();
    const h = await harness({ root, fetchUrlFor: () => repo.bare, reach: fixture.reach, buildSite: async () => ({ state: 'unavailable' }) });
    await h.signIn();
    await h.step('start');
    await h.call('/owner/github/select', { csrf: h.csrf, repository: 'cybersader/cyberbase' });
    await h.step('continue');
    expect(await h.waitNotes()).toBe('ready');
    expect((await h.step('reopen-publish')).value.code).toBe('invalid');
    expect((await h.step('nothing-yet')).value.ok).toBe(true);
    expect((await h.step('reopen-publish')).value.ok).toBe(true);
    expect((await h.call('/setup')).text).toContain('Nothing is marked public yet');
    // No publisher on this harness: the starter cannot be published, and says so.
    expect((await h.step('starter', ['Garden'])).value.code).toBe('not-ready');
    expect((await h.step('nothing-yet')).value.ok).toBe(true);
    expect((await h.call('/setup')).text).toContain('Nothing will be published for now');
    expect((await h.step('continue')).value.step).toBe('website');

    // No workflow, no CNAME: one field and Skip.
    const website = (await h.call('/setup')).text;
    expect(website).toContain('Where do people read your notes?');
    expect((await h.step('save-url', 'javascript:alert(1)')).status).toBe(400);
    expect((await h.step('save-url', 'https://user:pw@notes.example.com/')).status).toBe(400);
    expect((await h.step('skip')).value.step).toBe('phone');
    expect(h.state.read().website).toEqual({ url: null, source: 'skipped' });

    expect((await h.call('/setup')).text).toContain('Show QR code');
    expect((await h.step('continue')).value.code).toBe('not-ready');
    expect((await h.step('back')).value.step).toBe('website');
    expect((await h.step('save-url', 'https://notes.example.com')).value.step).toBe('phone');
    expect(h.state.read().website.url).toBe('https://notes.example.com/');
    expect((await h.step('skip')).value.step).toBe('agent');
    const agentPage = (await h.call('/setup')).text;
    expect(agentPage).toContain('data-pair-command="cyberbaser pair"');
    expect(agentPage).toContain('<input type="hidden" name="access" value="propose">');
    fixture.devices.push({ keyId: 'k1', kind: 'agent', label: '<b>Bot</b>', grants: ['propose'], revoked: false });
    const pairedPage = (await h.call('/setup')).text;
    expect(pairedPage).toContain('&lt;b&gt;Bot&lt;/b&gt;');
    expect((await h.step('continue')).value).toEqual({ ok: true, step: 'done' });
    await Bun.sleep(0);
    expect(h.completions).toHaveLength(1);
    expect(h.completions[0].state.agent).toBe('paired');
    expect(h.completions[0].session.sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);

    const done = await h.call('/setup');
    expect(done.text).toContain('Changes your agents and visitors suggest will appear in Proposals');
    expect(done.text).toContain('href="/owner/review"');
    expect(done.text).not.toContain('data-action="back"');
    expect((await h.step('back')).value.code).toBe('setup-complete');
    expect(() => h.links.issue()).toThrow();
    expect((await h.call('/setup/start?token=x')).status).toBe(410);
    expect((await h.call('/owner/github/state')).status).toBe(404);
    const saved = JSON.parse(await readFile(path.join(h.directory, SETUP_STATE_FILE), 'utf8'));
    expect(saved.step).toBe('done');
    expect(((await stat(path.join(h.directory, SETUP_STATE_FILE))).mode & 0o777)).toBe(0o600);
    // Nothing reached the hosted repository during setup.
    expect(git(repo.bare, 'rev-parse', 'main')).toBe(repo.head);

    // The node adopts the finished session: the owner stays signed in.
    const { config } = ownerConfigFromSetup(saved, layout(root));
    const node = createOwnerAlphaHandler({ config, editSessions: createMemoryEditSessionStore(), lookupJob: async () => null,
      createEditSession: async () => { throw new Error('unused'); }, saveEdit: async () => { throw new Error('unused'); },
      proposalReview: stubReview(), adoptSession: h.completions[0].session });
    const host = `${config.listen.host}:${config.listen.port}`;
    const adopted = await node(new Request(`http://${host}/`, { headers: { Host: host, Cookie: `owner_alpha_session=${h.completions[0].session.sessionToken}` } }));
    expect(adopted.status).toBe(302);
    const stranger = await node(new Request(`http://${host}/`, { headers: { Host: host, Cookie: `owner_alpha_session=${'B'.repeat(43)}` } }));
    expect(stranger.status).toBe(403);
  });

  test('state file must be private and recognized', async () => {
    const root = await scratch('oa-setup-state-');
    const directory = path.join(root, 'state');
    const state = await openSetupState(directory);
    await state.update((now) => ({ ...now, step: 'github' }));
    expect((await openSetupState(directory)).read().step).toBe('github');
    await chmod(path.join(directory, SETUP_STATE_FILE), 0o644);
    await expect(openSetupState(directory)).rejects.toMatchObject({ code: 'setup-state-invalid' });
    await chmod(path.join(directory, SETUP_STATE_FILE), 0o600);
    await writeFile(path.join(directory, SETUP_STATE_FILE), '{"v":1,"step":"publish-everything"}', { mode: 0o600 });
    await expect(openSetupState(directory)).rejects.toMatchObject({ code: 'setup-state-invalid' });
    await chmod(directory, 0o755);
    await expect(openSetupState(directory)).rejects.toMatchObject({ code: 'setup-state-invalid' });
  });
});

function layout(root) {
  return {
    listen: { host: '127.0.0.1', port: 47490 }, checkout: path.join(root, 'state', 'notes'), publisherSocket: path.join(root, 'ipc', 'p.sock'),
    reviewSocket: path.join(root, 'ipc', 'review.sock'), irohStateDirectory: path.join(root, 'iroh'),
    forgeStateDirectory: path.join(root, 'forge'), clientId: FAKE_CLIENT_ID,
  };
}

function stubReview() {
  return { list: async () => ({ entries: [], nextCursor: null }), load: async () => null, loadDecision: async () => null, record: async () => null,
    overlay: async () => ({ entries: [] }) };
}

describe('what the repository says', () => {
  test('publish.yml is read fail-closed', () => {
    expect(inspectPublishYml(null)).toEqual({ publishYml: 'missing', allowCount: null });
    expect(inspectPublishYml('allow:\n  - Garden\n  - Notes/**\n')).toEqual({ publishYml: 'present', allowCount: 2 });
    expect(inspectPublishYml('allow: Garden\n')).toEqual({ publishYml: 'invalid', allowCount: null });
    expect(inspectPublishYml(': : :\n')).toEqual({ publishYml: 'invalid', allowCount: null });
    expect(starterPublishYml([])).toContain('allow: []');
  });

  test('the website comes from a Pages workflow or CNAME, never guessed', async () => {
    const root = await scratch('oa-setup-site-');
    await mkdir(path.join(root, '.github', 'workflows'), { recursive: true });
    expect(await detectWebsite(root, 'Owner/notes')).toBeNull();
    await writeFile(path.join(root, '.github', 'workflows', 'ci.yml'), 'name: CI\non: push\njobs:\n  test:\n    steps:\n      - run: echo\n');
    expect(await detectWebsite(root, 'Owner/notes')).toBeNull();
    await writeFile(path.join(root, '.github', 'workflows', 'site.yml'), 'name: Site\non:\n  push:\n    branches: [trunk]\njobs:\n  build: {steps: [{uses: actions/checkout@v4}]}\n  deploy: {steps: [{uses: actions/deploy-pages@v4}]}\n');
    expect(await detectWebsite(root, 'Owner/notes')).toEqual({ url: 'https://owner.github.io/notes/', pagesUrl: 'https://owner.github.io/notes/',
      foundIn: '.github/workflows/site.yml', workflow: { path: '.github/workflows/site.yml', name: 'Site', jobs: ['build', 'deploy'], branch: 'trunk' } });
    await writeFile(path.join(root, 'CNAME'), 'Notes.Example.com\n');
    expect((await detectWebsite(root, 'Owner/notes')).url).toBe('https://notes.example.com/');
    await writeFile(path.join(root, 'CNAME'), '<script>\n');
    expect((await detectWebsite(root, 'Owner/notes')).url).toBe('https://owner.github.io/notes/');
  });

  test('the node config built from setup validates and keeps the canonical remote', async () => {
    const root = await scratch('oa-setup-config-');
    const setup = { ...(await openSetupState(path.join(root, 's'))).read(), repository: 'cybersader/cyberbase' };
    setup.notes.branch = 'main';
    const { config, workflowDetected } = ownerConfigFromSetup(setup, layout(root));
    expect(workflowDetected).toBe(false);
    expect(config.repository.remote.url).toBe('https://github.com/cybersader/cyberbase.git');
    expect(config.live.baseUrl).toBe('https://cybersader.github.io/cyberbase/');
    expect(() => validateOwnerAlphaConfig(config)).not.toThrow();
  });
});

// ------------------------------------------------------------------ end to end

test('the whole setup against the fake GitHub: sign in, pick, copy, website, skip pairing, nothing pushed', async () => {
  const root = await scratch('oa-setup-e2e-');
  const repo = await notesRepository(root, { publishYml: 'allow:\n  - Garden\n' });
  const fake = await startFakeGithub(repo.reposRoot);
  cleanup.push(() => fake.stop());
  await fake.scenario({ polls: ['authorization_pending', 'ok'], installations: 'mixed', deviceFlowDisabled: false, anonymousRead: true });
  const ipc = path.join(root, 'ipc');
  await mkdir(ipc, { mode: 0o700 });
  await chmod(ipc, 0o700);
  const socketPath = path.join(ipc, 'p.sock');
  const runner = path.join(root, 'forge.mjs');
  const moduleUrl = (name) => JSON.stringify(pathToFileURL(path.join(APP, 'src', name)).href);
  await writeFile(runner, `import { createGithubAppAccess, createGithubHttp } from ${moduleUrl('publisher/forge-access.js')};
import { startForgeControl } from ${moduleUrl('publisher/forge-control.js')};
const [socketPath, stateDirectory, origin, clientId] = process.argv.slice(2);
const access = createGithubAppAccess({ clientId, stateDirectory, remoteUrl: null, http: createGithubHttp({ apiBaseUrl: origin, webBaseUrl: origin }), secondMs: 10 });
const control = await startForgeControl({ socketPath, forgeAccess: access });
process.stdout.write('forge ready\\n');
process.once('SIGTERM', async () => { access.close(); await control.close(); process.exit(0); });
`);
  const forge = spawn(process.execPath, [runner, socketPath, path.join(root, 'forge'), fake.origin, FAKE_CLIENT_ID], { stdio: ['ignore', 'pipe', 'pipe'] });
  cleanup.push(() => forge.kill('SIGTERM'));
  await new Promise((resolve, reject) => {
    forge.stdout.on('data', (chunk) => { if (String(chunk).includes('forge ready')) resolve(); });
    forge.once('exit', (code) => reject(new Error(`forge exited ${code}`)));
  });

  const state = await openSetupState(path.join(root, 'state'));
  const h = await harness({ root, state, relay: createSetupForgeRelay({ socketPath, state }), git: undefined,
    fetchUrlFor: (fullName) => `${fake.origin}/git/${fullName}.git`, buildSite: async ({ checkout }) => ({ state: (await stat(path.join(checkout, 'Home.md'))).isFile() ? 'built' : 'failed' }) });
  await h.signIn();
  await h.step('start');
  expect((await h.call('/owner/github/check')).value.state).toBe('not-connected');
  const started = await h.call('/owner/github/start', { csrf: h.csrf });
  expect(started.value.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/u);
  let status;
  for (let i = 0; i < 400; i++) {
    status = (await h.call('/owner/github/state')).value;
    if (status.state !== 'waiting-for-code') break;
    await Bun.sleep(10);
  }
  expect(status.state).toBe('pick-repository');
  expect((await h.step('continue')).value.code).toBe('not-ready');
  const listing = (await h.call('/owner/github/repositories')).value;
  expect(listing.repositories.some((row) => row.fullName === 'cybersader/cyberbase' && row.problem === null)).toBe(true);
  expect((await h.call('/owner/github/select', { csrf: h.csrf, repository: 'cybersader/cyberbase' })).value.ok).toBe(true);
  expect((await h.call('/owner/github/state')).value).toMatchObject({ state: 'connected', repository: 'cybersader/cyberbase' });
  expect((await h.step('continue')).value.step).toBe('notes');
  expect((await h.call('/setup/state')).value.notes.phase).toMatch(/idle|cloning|building|ready/u);
  expect(await h.waitNotes()).toBe('ready');
  const notesPage = (await h.call('/setup')).text;
  expect(notesPage).toContain('Copied 4 notes');
  expect(notesPage).toContain('Built a private preview of your site');
  expect(notesPage).toContain('It lists 1 entry');
  const checkout = path.join(h.directory, 'notes');
  expect(git(checkout, 'remote', 'get-url', 'origin')).toBe('https://github.com/cybersader/cyberbase.git');
  expect(git(checkout, 'rev-parse', 'HEAD')).toBe(repo.head);
  expect((await h.step('continue')).value.step).toBe('website');
  const site = (await h.call('/setup')).text;
  expect(site).toContain('https://cybersader.github.io/cyberbase/');
  expect(site).toContain('.github/workflows/pages.yml');
  expect((await h.step('confirm-detected')).value.step).toBe('phone');
  // No Iroh in this test: pairing says so and offers later.
  expect((await h.call('/setup')).text).toContain('Pairing needs Cyberbaser');
  expect((await h.call('/owner/devices/state')).status).toBe(404);
  expect((await h.step('skip')).value.step).toBe('agent');
  expect((await h.step('skip')).value.step).toBe('done');
  const report = await fake.report();
  expect(report.pushes).toEqual([]);
  expect(git(repo.bare, 'rev-parse', 'main')).toBe(repo.head);
  const finished = h.state.read();
  expect(finished).toMatchObject({ step: 'done', phone: 'later', agent: 'skipped', website: { url: 'https://cybersader.github.io/cyberbase/', source: 'detected' } });
  const { config, workflowDetected } = ownerConfigFromSetup(finished, layout(root));
  expect(workflowDetected).toBe(true);
  expect(config.workflow).toMatchObject({ name: 'Publish vault site', path: '.github/workflows/pages.yml', jobs: ['build', 'deploy'], branch: 'main' });
}, 30000);

import { afterAll, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { computePolicyRevision, validateOwnerAlphaConfig } from '../src/config.js';
import { createForgeSetup } from '../src/forge-setup.js';
import { createMemoryEditSessionStore, createOwnerAlphaHandler } from '../src/server.js';
import { prepareStore, storeContextFromConfig } from '../src/store.js';
import { FAKE_CLIENT_ID, startFakeGithub } from './fake-github-process.js';

// The whole owner journey against a fake GitHub with a real Git smart-HTTP
// server: connect (device code), pick, push, token refresh, push, disconnect,
// refused push. Three processes: the fake GitHub, the publisher, and this test
// as the web-facing node. Tokens exist only in the first two.

const APP = path.resolve(import.meta.dir, '..');
const REAL_GIT = Bun.which('git');
const children = new Set();
const cleanup = [];
afterAll(async () => {
  for (const child of children) child.kill('SIGKILL');
  for (const action of cleanup.reverse()) await action();
});

function launch(args, { env, cwd } = {}) {
  const child = spawn(args[0], args.slice(1), { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  const record = { child, stdout: '', stderr: '' };
  children.add(child);
  child.stdout.on('data', (chunk) => { record.stdout += chunk; });
  child.stderr.on('data', (chunk) => { record.stderr += chunk; });
  record.exited = new Promise((resolve) => child.once('close', (code) => { children.delete(child); resolve(code); }));
  return record;
}

function git(cwd, ...args) {
  const result = spawnSync(REAL_GIT, ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_ALLOW_PROTOCOL: 'file' } });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

async function files(directory) {
  const out = [];
  for (const entry of await readdir(directory, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) out.push(path.join(entry.parentPath ?? entry.path, entry.name));
  }
  return out;
}

// Counts only: the test process must not read a token into its own memory.
// The fake mints gh[ur]_CANARY<36 hex>. This pattern cannot match its own text.
const TOKEN = /gh[ur]_CANARY[0-9a-f]{36}/u;
function canaryCount(target) {
  const result = spawnSync('grep', ['-rcE', '--', TOKEN.source, target], { encoding: 'utf8' });
  return result.stdout.split('\n').filter(Boolean).reduce((sum, line) => sum + Number(line.split(':').pop()), 0);
}

test('connect, pick, push, refresh, push, disconnect, refuse: the node never holds a token', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oa-forge-flow-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const checkout = path.join(root, 'src');
  const reposRoot = path.join(root, 'gh');
  const hosted = path.join(reposRoot, 'cybersader', 'cyberbase.git');
  const ipc = path.join(root, 'ipc');
  const socketPath = path.join(ipc, 'publisher.sock');
  const forgeState = path.join(root, 'publisher-state');
  const shim = path.join(root, 'shim');
  await mkdir(ipc, { mode: 0o700 });
  await chmod(ipc, 0o700);
  await mkdir(shim);
  await mkdir(path.join(checkout, 'docs'), { recursive: true });
  git(root, 'init', '-q');
  await writeFile(path.join(root, '.gitignore'), '.workspace/\n');
  git(checkout, 'init', '-q', '--initial-branch=main');
  git(checkout, 'config', 'user.name', 'Forge Flow Fixture');
  git(checkout, 'config', 'user.email', 'forge@example.invalid');
  await writeFile(path.join(checkout, 'docs', 'page.md'), '# Page\n\nFixture old sentence.\n');
  git(checkout, 'add', '--', 'docs/page.md');
  git(checkout, 'commit', '-q', '-m', 'fixture base');
  await mkdir(path.dirname(hosted), { recursive: true });
  git(root, 'init', '--bare', '-q', '--initial-branch=main', hosted);
  git(checkout, 'remote', 'add', 'origin', hosted);
  git(checkout, 'push', '-q', 'origin', 'main');

  const fake = await startFakeGithub(reposRoot);
  cleanup.push(() => fake.stop());
  await fake.scenario({ polls: ['authorization_pending', 'slow_down', 'ok'], installations: 'mixed', deviceFlowDisabled: false, anonymousRead: true });

  const raw = JSON.parse(await readFile(path.join(APP, 'owner-alpha.example.json'), 'utf8'));
  raw.repository.checkout = checkout;
  raw.publisher = { socketPath };
  raw.forgeAccess = { provider: 'github-app', clientId: FAKE_CLIENT_ID, stateDirectory: forgeState };
  git(checkout, 'remote', 'set-url', 'origin', raw.repository.remote.url);
  const configFile = path.join(root, 'owner.json');
  await writeFile(configFile, JSON.stringify(raw), { mode: 0o600 });
  const config = validateOwnerAlphaConfig(raw);
  const revision = computePolicyRevision(config);
  await prepareStore(storeContextFromConfig(config, root));

  // Only transport commands are rewritten: the policy URL becomes the fake's
  // smart-HTTP path. Git still asks the publisher's credential helper.
  await writeFile(path.join(shim, 'git'), `#!/usr/bin/env bash
set -eu
globals=()
while [[ "$1" == -C || "$1" == --git-dir || "$1" == -c || "$1" == --no-pager ]]; do
  if [[ "$1" == --no-pager ]]; then globals+=("$1"); shift; else globals+=("$1" "$2"); shift 2; fi
done
if [[ "$1" == push || "$1" == ls-remote || "$1" == fetch ]]; then
  exec "$REAL_GIT" "\${globals[@]}" -c "url.$FAKE_GIT_ORIGIN/git/.insteadOf=https://github.com/" -c protocol.http.allow=always "$@"
fi
exec "$REAL_GIT" "\${globals[@]}" "$@"
`, { mode: 0o700 });
  const env = { ...process.env, PATH: `${shim}:${process.env.PATH}`, REAL_GIT, FAKE_GIT_ORIGIN: fake.origin, GIT_TERMINAL_PROMPT: '0' };

  const moduleUrl = (name) => JSON.stringify(pathToFileURL(path.join(APP, 'src', name)).href);
  const publisherRunner = path.join(root, 'publisher.mjs');
  await writeFile(publisherRunner, `import { loadOwnerAlphaConfig } from ${moduleUrl('config.js')};
import { startPublisher } from ${moduleUrl('publisher/server.js')};
import { createGithubHttp } from ${moduleUrl('publisher/forge-access.js')};
import { storeContextFromConfig } from ${moduleUrl('store.js')};
const [configFile, repository, origin] = process.argv.slice(2);
const config = await loadOwnerAlphaConfig(configFile);
const publisher = await startPublisher({ config, context: storeContextFromConfig(config, import.meta.dir), socketPath: config.publisher.socketPath,
  repository, forgeOptions: { http: createGithubHttp({ apiBaseUrl: origin, webBaseUrl: origin }), secondMs: 10 } });
process.stdout.write('publisher ready\\n');
process.once('SIGTERM', async () => { await publisher.close(); process.exit(0); });
`);
  const appRunner = path.join(root, 'app.mjs');
  await writeFile(appRunner, `import { loadOwnerAlphaConfig } from ${moduleUrl('config.js')};
import { createSaveHandler } from ${moduleUrl('pipeline.js')};
const [configFile, jobId, from, to] = process.argv.slice(2);
const config = await loadOwnerAlphaConfig(configFile);
const save = createSaveHandler({ config, projectRoot: import.meta.dir, dependencies: {
  async runPreApplyChecks() { return { ok: true, rendered: { witnesses: { old: from, new: to } } }; },
  async discoverDeploymentRun({ applicationSha }) { return { binding: { headSha: applicationSha } }; },
  async monitorDeploymentRun() { return { state: 'success' }; },
  async confirmLivePage() { return { confirmed: true }; },
  async rebuildLocal() { return { status: 'local-rebuilt' }; },
} });
const { readFile } = await import('node:fs/promises');
const text = await readFile(config.repository.checkout + '/docs/page.md', 'utf8');
try {
  const result = await save.startEdit({ jobId, renderer: { relativePath: 'docs/page.md', slug: 'docs/page' }, editedText: text.replace(from, to) }).completion;
  process.stdout.write(JSON.stringify({ state: result?.state ?? result?.status ?? 'done', failure: result?.failure?.code }) + '\\n');
} catch (error) { process.stdout.write(JSON.stringify({ failed: error?.code ?? 'error' }) + '\\n'); }
`);

  const publisher = launch([process.execPath, publisherRunner, configFile, path.join(root, 'publisher.git'), fake.origin], { env, cwd: root });
  for (let i = 0; i < 300 && !publisher.stdout.includes('publisher ready'); i++) {
    if (publisher.child.exitCode !== null) throw new Error(publisher.stderr);
    await Bun.sleep(20);
  }
  expect(publisher.stdout).toContain('publisher ready');
  async function save(jobId, from, to) {
    const run = launch([process.execPath, appRunner, configFile, jobId, from, to], { env, cwd: root });
    await run.exited;
    return { ...JSON.parse(run.stdout.trim().split('\n').pop() || '{}'), stderr: run.stderr, stdout: run.stdout };
  }

  // The web-facing node: the real owner handler, in this process.
  const origin = `http://${config.listen.host}:${config.listen.port}`;
  const forgeSetup = createForgeSetup({ config, configFile });
  const handler = createOwnerAlphaHandler({
    config, editSessions: createMemoryEditSessionStore(),
    createEditSession: async () => { throw new Error('unused'); }, saveEdit: async () => { throw new Error('unused'); },
    lookupJob: async () => null, forgeSetup,
  });
  const bodies = [];
  const boot = await handler(new Request(`${origin}/owner/bootstrap?token=${handler.issueBootstrap()}`, { headers: { Host: `${config.listen.host}:${config.listen.port}` } }));
  const cookie = boot.headers.get('set-cookie').split(';', 1)[0];
  async function call(route, body) {
    const response = await handler(new Request(`${origin}${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Host: `${config.listen.host}:${config.listen.port}`, Cookie: cookie, Origin: origin, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
    const text = await response.text();
    bodies.push(text);
    return { status: response.status, text, value: text.startsWith('{') ? JSON.parse(text) : null };
  }
  const page = await call('/owner/github');
  expect(page.status).toBe(200);
  const csrf = /data-csrf="([^"]+)"/u.exec(page.text)[1];

  // Connect.
  expect((await call('/owner/github/start', {})).status).toBe(400);
  expect((await call('/owner/github/start', { csrf: 'A'.repeat(43) })).status).toBe(403);
  const started = await call('/owner/github/start', { csrf });
  expect(started.value).toMatchObject({ ok: true });
  expect(started.value.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/u);
  let state;
  for (let i = 0; i < 400; i++) {
    state = (await call('/owner/github/state')).value;
    if (state.state !== 'waiting-for-code') break;
    await Bun.sleep(10);
  }
  expect(state).toMatchObject({ ok: true, state: 'pick-repository' });

  // Pick.
  const listing = (await call('/owner/github/repositories')).value;
  expect(listing.repositories).toHaveLength(208);
  expect(listing.repositories.filter((row) => row.problem === null).map((row) => row.fullName)).toEqual(['cybersader/cyberbase', 'cybersader-lab/field-notes']);
  expect((await call('/owner/github/select', { repository: 'wide-co/handbook', csrf })).value).toMatchObject({ ok: false, code: 'permissions-too-broad' });
  expect((await call('/owner/github/select', { repository: 'cybersader/cyberbase', csrf })).value).toEqual({ ok: true, repository: 'cybersader/cyberbase', restartNeeded: false });
  expect((await call('/owner/github/check')).value).toMatchObject({ state: 'connected', repository: 'cybersader/cyberbase', renewsAutomatically: true });
  expect(canaryCount(forgeState)).toBeGreaterThan(0); // positive control: the publisher does hold it

  // Push with the short-lived token.
  const first = await save('OA-FORGE-1', 'old sentence.', 'new sentence.');
  expect(first).toMatchObject({ state: 'completed' });
  let report = await fake.report();
  expect(report.pushes).toEqual([{ kind: 'app', generation: 1, current: true }]);
  expect(report.denied.filter((entry) => entry.hadAuthorization)).toEqual([]);
  expect(git(hosted, 'show', 'main:docs/page.md')).toContain('Fixture new sentence.');

  // GitHub stops accepting the token: the publisher refreshes and pushes again.
  await fake.expireAccess();
  const second = await save('OA-FORGE-2', 'new sentence.', 'newer sentence.');
  expect(second).toMatchObject({ state: 'completed' });
  report = await fake.report();
  expect(report.refreshes).toBe(1);
  expect(report.pushes.at(-1)).toEqual({ kind: 'app', generation: 2, current: true });
  expect(git(hosted, 'show', 'main:docs/page.md')).toContain('Fixture newer sentence.');

  // Disconnect: the credential is gone and the next push is refused.
  expect((await call('/owner/github/disconnect', { csrf })).value).toEqual({ ok: true });
  expect(await readdir(forgeState)).toEqual([]);
  expect((await call('/owner/github/state')).value).toMatchObject({ state: 'not-connected' });
  const third = await save('OA-FORGE-3', 'newer sentence.', 'newest sentence.');
  expect(third).toMatchObject({ state: 'manual-intervention', failure: 'forge-access-unavailable' });
  expect((await fake.report()).pushes).toHaveLength(2);

  // Picking another repository records it in policy (a new policy revision).
  await fake.scenario({ polls: ['ok'] });
  await call('/owner/github/start', { csrf });
  for (let i = 0; i < 400 && (await call('/owner/github/state')).value.state === 'waiting-for-code'; i++) await Bun.sleep(10);
  const moved = (await call('/owner/github/select', { repository: 'cybersader-lab/field-notes', csrf })).value;
  expect(moved).toEqual({ ok: true, repository: 'cybersader-lab/field-notes', restartNeeded: true });
  const rewritten = JSON.parse(await readFile(configFile, 'utf8'));
  expect(rewritten.repository.remote.url).toBe('https://github.com/cybersader-lab/field-notes.git');
  expect(computePolicyRevision(rewritten)).not.toBe(revision);
  expect(((await stat(configFile)).mode & 0o777)).toBe(0o600);
  expect((await call('/owner/github/state')).value).toMatchObject({ state: 'restart-needed', repository: 'cybersader-lab/field-notes' });

  // Canary: nothing the node saw, kept or wrote holds a token.
  expect(TOKEN.test(bodies.join('\n'))).toBe(false);
  expect(TOKEN.test(Bun.generateHeapSnapshot('v8'))).toBe(false);
  expect(canaryCount(path.join(root, '.workspace'))).toBe(0);
  expect(canaryCount(configFile)).toBe(0);
  expect(canaryCount(checkout)).toBe(0);
  expect(`${publisher.stdout}${publisher.stderr}${first.stdout}${first.stderr}${second.stdout}${second.stderr}${third.stdout}${third.stderr}`).not.toMatch(TOKEN);
  expect((await files(path.join(root, '.workspace'))).length).toBeGreaterThan(0);

  publisher.child.kill('SIGTERM');
  await publisher.exited;
}, 60_000);

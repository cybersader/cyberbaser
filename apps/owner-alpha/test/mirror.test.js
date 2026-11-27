import { afterAll, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertCheckoutReady } from '../src/source.js';
import { createNotesPreparer, createSetupForgeRelay, createStarterPublisher, openSetupState } from '../src/first-run.js';
import { forgeRequest } from '../src/publisher/forge-control.js';
import { STARTER_COMMIT_MESSAGE, starterPublishYml } from '../src/starter-publish.js';
import { createUpstream, syncCheckoutFromMirror } from '../src/upstream.js';
import { FAKE_CLIENT_ID, startFakeGithub } from './fake-github-process.js';

// A private repository through the setup-mode publisher: the fake GitHub
// refuses it without the token; the publisher (its own process) fetches it into
// its mirror; the node (this process) copies from the mirror with no
// credential anywhere; the publisher pushes one exact starter publish.yml and
// refuses anything else; with GitHub gone the node still reads its remote
// branch from the mirror.

const APP = path.resolve(import.meta.dir, '..');
const REAL_GIT = Bun.which('git');
const cleanup = [];
afterAll(async () => { for (const action of cleanup.reverse()) await action(); });

function git(cwd, ...args) {
  const result = spawnSync(REAL_GIT, ['-C', cwd, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

const TOKEN = /gh[ur]_CANARY[0-9a-f]{36}/u;
function canaryCount(target) {
  const result = spawnSync('grep', ['-rcaE', '--', TOKEN.source, target], { encoding: 'utf8' });
  return result.stdout.split('\n').filter(Boolean).reduce((sum, line) => sum + Number(line.split(':').pop()), 0);
}

const localGit = async (cwd, args) => {
  const result = spawnSync(REAL_GIT, args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  if (result.status !== 0) throw new Error(`git ${args[0]}: ${result.stderr}`);
  return result.stdout.trim();
};

test('private repository: the publisher mirrors it, the node copies it credential-free, one starter file is pushed', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oa-mirror-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const reposRoot = path.join(root, 'gh');
  const hosted = path.join(reposRoot, 'cybersader', 'cyberbase.git');
  const work = path.join(root, 'work');
  await mkdir(path.join(work, 'Garden'), { recursive: true });
  await mkdir(path.join(work, 'Journal'), { recursive: true });
  await writeFile(path.join(work, 'Garden', 'Roses.md'), '# Roses\n');
  await writeFile(path.join(work, 'Journal', 'Private.md'), '# Private\n');
  git(root, 'init', '-q', '--initial-branch=main', work);
  git(work, 'config', 'user.name', 'Fixture');
  git(work, 'config', 'user.email', 'fixture@example.invalid');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'private notes');
  await mkdir(path.dirname(hosted), { recursive: true });
  git(root, 'init', '--bare', '-q', '--initial-branch=main', hosted);
  git(work, 'push', '-q', hosted, 'main');
  const base = git(hosted, 'rev-parse', 'main');

  const fake = await startFakeGithub(reposRoot);
  cleanup.push(() => fake.stop());
  // Private: no anonymous reads.
  await fake.scenario({ polls: ['ok'], installations: 'mixed', anonymousRead: false });
  const shim = path.join(root, 'shim');
  await mkdir(shim);
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

  // Refused without the token.
  const anonymous = spawnSync(REAL_GIT, ['-c', 'credential.helper=', 'ls-remote', `${fake.origin}/git/cybersader/cyberbase.git`],
    { encoding: 'utf8', timeout: 15_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ASKPASS: '/bin/false' } });
  expect(anonymous.status).not.toBe(0);

  const ipc = path.join(root, 'ipc');
  await mkdir(ipc, { mode: 0o700 });
  await chmod(ipc, 0o700);
  const socketPath = path.join(ipc, 'p.sock');
  const mirrorParent = path.join(root, 'shared');
  await mkdir(mirrorParent, { mode: 0o750 });
  const mirror = path.join(mirrorParent, 'notes.git');
  const stateDirectory = path.join(root, 'setup');
  const checkout = path.join(root, 'notes-copy', 'notes');
  await mkdir(path.dirname(checkout));
  const forgeState = path.join(root, 'forge');
  const moduleUrl = (name) => JSON.stringify(pathToFileURL(path.join(APP, name)).href);
  const runner = path.join(root, 'publisher.mjs');
  await writeFile(runner, `import { runSetupForgeCli } from ${moduleUrl('bin/owner-alpha-publisher.js')};
import { createGithubHttp } from ${moduleUrl('src/publisher/forge-access.js')};
const [socketPath, stateDirectory, origin, clientId, mirror, checkout] = process.argv.slice(2);
await runSetupForgeCli({ socketPath, stateDirectory, clientId, mirror, checkout, http: createGithubHttp({ apiBaseUrl: origin, webBaseUrl: origin }) });
`);
  const env = { ...process.env, PATH: `${shim}:${process.env.PATH}`, REAL_GIT, FAKE_GIT_ORIGIN: fake.origin, GIT_TERMINAL_PROMPT: '0' };
  const publisher = spawn(process.execPath, [runner, socketPath, forgeState, fake.origin, FAKE_CLIENT_ID, mirror, checkout],
    { env, cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let publisherOutput = '';
  publisher.stdout.on('data', (chunk) => { publisherOutput += chunk; });
  publisher.stderr.on('data', (chunk) => { publisherOutput += chunk; });
  cleanup.push(() => publisher.kill('SIGKILL'));
  for (let i = 0; i < 300 && !publisherOutput.includes('ready for setup'); i++) await Bun.sleep(20);
  expect(publisherOutput).toContain('ready for setup');

  // Sign in and pick, as the setup page does.
  const ask = (op, extra = {}) => forgeRequest({ socketPath, op, ...extra });
  await expect(ask('fetch')).rejects.toMatchObject({ code: 'revoked' });
  await ask('start');
  let status;
  for (let i = 0; i < 600; i++) {
    status = await ask('status');
    if (status.state !== 'waiting-for-code') break;
    await Bun.sleep(20);
  }
  expect(status.state).toBe('pick-repository');
  await ask('select', { repository: 'cybersader/cyberbase' });

  // The node copies the notes from the mirror.
  const state = await openSetupState(stateDirectory);
  const relay = createSetupForgeRelay({ socketPath, state });
  await state.update((current) => ({ ...current, repository: 'cybersader/cyberbase' }));
  const notes = createNotesPreparer({ state, directory: stateDirectory, checkout, mirror, refresh: () => relay.ask('fetch'), git: localGit });
  await notes.start('cybersader/cyberbase');
  expect(state.read().notes).toMatchObject({ phase: 'ready', count: 2, publishYml: 'missing', folders: ['Garden', 'Journal'] });
  expect(git(checkout, 'rev-parse', 'HEAD')).toBe(base);
  expect(git(checkout, 'remote', 'get-url', 'origin')).toBe('https://github.com/cybersader/cyberbase.git');
  expect(git(checkout, 'remote', 'get-url', '--push', 'origin')).toBe('https://github.com/cybersader/cyberbase.git');
  expect(git(checkout, 'config', 'user.name')).toBe('cybersader');
  let report = await fake.report();
  expect(report.fetches.length).toBeGreaterThan(0);
  expect(report.denied.some((entry) => entry.hadAuthorization)).toBe(false);
  // The mirror names no remote, URL or helper; nothing in it or the copy holds a token.
  expect(git(mirror, 'config', '--list', '--local')).not.toMatch(/remote\.|url|credential|helper/u);
  expect((await readdir(mirror)).every((name) => ['HEAD', 'config', 'objects', 'refs', 'packed-refs'].includes(name))).toBe(true);
  expect(canaryCount(mirror)).toBe(0);
  expect(canaryCount(checkout)).toBe(0);
  expect(canaryCount(forgeState)).toBeGreaterThan(0); // positive control: the publisher holds it

  // The one change setup may publish: exactly the starter file, approved on screen.
  // Setup only prepares it; here the publisher has no owner services, so the
  // unsigned forge request stands in for the signed one (job-approvals.test.js).
  const prepareStarter = createStarterPublisher({ checkout, git: localGit });
  const starter = { async publish(input) {
    const prepared = await prepareStarter.prepare(input);
    await relay.publishStarter(prepared.commit);
    git(checkout, 'merge', '--ff-only', '--quiet', prepared.commit);
    return prepared;
  } };
  // Anything else is refused by the publisher, whatever the node asks.
  const tamper = async (name, mutate) => {
    const head = git(checkout, 'rev-parse', 'HEAD');
    const scratch = path.join(root, `tamper-${name}`);
    git(root, 'clone', '-q', '--no-local', checkout, scratch);
    git(scratch, 'config', 'user.name', 'x');
    git(scratch, 'config', 'user.email', 'x@example.invalid');
    await mutate(scratch);
    git(scratch, 'add', '-A');
    git(scratch, 'commit', '-q', '-m', STARTER_COMMIT_MESSAGE);
    const commit = git(scratch, 'rev-parse', 'HEAD');
    git(scratch, 'push', '-q', checkout, `${commit}:refs/heads/tamper`);
    await expect(relay.publishStarter(commit)).rejects.toMatchObject({ code: 'starter-refused' });
    git(checkout, 'branch', '-D', 'tamper');
    expect(git(checkout, 'rev-parse', 'HEAD')).toBe(head);
  };
  await tamper('everything', async (dir) => { await writeFile(path.join(dir, 'publish.yml'), 'allow:\n  - "**"\n'); });
  await tamper('extra-file', async (dir) => {
    await writeFile(path.join(dir, 'publish.yml'), starterPublishYml(['Garden']));
    await writeFile(path.join(dir, 'Garden', 'Roses.md'), '# Changed\n');
  });
  await tamper('unsorted', async (dir) => { await writeFile(path.join(dir, 'publish.yml'), starterPublishYml(['Journal', 'Garden'])); });
  expect(git(hosted, 'rev-parse', 'main')).toBe(base);

  const published = await starter.publish({ repository: 'cybersader/cyberbase', folders: ['Garden'] });
  expect(git(hosted, 'rev-parse', 'main')).toBe(published.commit);
  expect(`${git(hosted, 'show', 'main:publish.yml')}\n`).toBe(starterPublishYml(['Garden']));
  expect(git(checkout, 'rev-parse', 'HEAD')).toBe(published.commit);
  // The mirror moved to the pushed commit without another fetch.
  expect(git(mirror, 'rev-parse', 'main')).toBe(published.commit);
  report = await fake.report();
  expect(report.pushes).toHaveLength(1);
  // A second starter is refused: the repository now has one.
  await expect(starter.publish({ repository: 'cybersader/cyberbase', folders: ['Journal'] })).rejects.toMatchObject({ code: 'starter-refused' });

  // The node's checkout is ready against the mirror, with no network question.
  const raw = JSON.parse(await readFile(path.join(APP, 'owner-alpha.example.json'), 'utf8'));
  raw.repository.checkout = checkout;
  raw.publisher = { socketPath, mirror };
  const ready = await assertCheckoutReady(raw);
  expect(ready.head).toBe(published.commit);

  // Someone pushes to GitHub; the publisher fetches, the node fast-forwards.
  git(work, 'pull', '-q', '--ff-only', hosted, 'main');
  await writeFile(path.join(work, 'Garden', 'Tulips.md'), '# Tulips\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'tulips');
  git(work, 'push', '-q', hosted, 'main');
  const upstream = createUpstream({ config: raw });
  expect(await upstream.refresh()).toMatchObject({ state: 'reachable', checkout: 'updated' });
  expect(git(checkout, 'rev-parse', 'HEAD')).toBe(git(hosted, 'rev-parse', 'main'));
  expect(await syncCheckoutFromMirror(raw)).toMatchObject({ state: 'current' });

  // GitHub goes away: the node still knows where it stands.
  await fake.stop();
  expect(await upstream.refresh()).toMatchObject({ state: 'unreachable', checkout: 'current' });
  expect((await assertCheckoutReady(raw)).head).toBe(git(hosted, 'rev-parse', 'main'));

  expect(canaryCount(mirror)).toBe(0);
  expect(canaryCount(checkout)).toBe(0);
  expect(canaryCount(stateDirectory)).toBe(0);
  expect(publisherOutput).not.toMatch(TOKEN);
  expect(TOKEN.test(Bun.generateHeapSnapshot('v8'))).toBe(false);
  publisher.kill('SIGTERM');
}, 90_000);

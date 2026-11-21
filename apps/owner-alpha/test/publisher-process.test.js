import { afterEach, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { computePolicyRevision, validateOwnerAlphaConfig } from '../src/config.js';
import { OwnerAlphaError } from '../src/errors.js';
import { initializeDurableJob, loadDurableJob, transitionDurableJob } from '../src/job-state.js';
import { pipelineArtifactPaths } from '../src/pipeline.js';
import { requestPublication } from '../src/publisher/client.js';
import { startPublisher } from '../src/publisher/server.js';
import { prepareStore, storeContextFromConfig } from '../src/store.js';

const APP = path.resolve(import.meta.dir, '..');
const EXAMPLE = path.join(APP, 'owner-alpha.example.json');
const CLI = path.join(APP, 'bin', 'owner-alpha-publisher.js');
const REAL_GIT = Bun.which('git');
const LEGACY_REVISION = 'sha256:e740f0cf94abb24d230a56b7290a808ddad81d7836d8a5eefaa7aee3d83a2c22';
const SECRET_KEY = 'OWNER_ALPHA_TEST_PUBLISHER_SECRET';
const paths = [];
const children = new Set();

function launch(args, { cwd, env } = {}) {
  const process = spawn(args[0], args.slice(1), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const child = { process, stdout: '', stderr: '', exit: null };
  children.add(child);
  process.stdout.on('data', (bytes) => { child.stdout += bytes; });
  process.stderr.on('data', (bytes) => { child.stderr += bytes; });
  child.exited = new Promise((resolve, reject) => {
    process.once('error', reject);
    process.once('close', (code, signal) => {
      child.exit = { code, signal };
      children.delete(child);
      resolve(child.exit);
    });
  });
  return child;
}

async function waitUntil(predicate) {
  for (let i = 0; i < 200; i++) {
    const value = await predicate();
    if (value) return value;
    await delay(20);
  }
  throw new Error('fixture condition did not occur before its deadline');
}

async function git(cwd, ...args) {
  if (['push', 'ls-remote', 'fetch', 'clone', 'pull'].includes(args[0])) {
    const root = paths.find((candidate) => cwd === candidate || cwd.startsWith(`${candidate}/`));
    const destination = args.slice(1).find((arg) => !arg.startsWith('-'));
    if (!root || !destination || !path.isAbsolute(destination) || !(await realpath(destination)).startsWith(`${root}/`)) {
      throw new Error('fixture Git transport requires a destination inside its temporary directory');
    }
  }
  const child = launch([REAL_GIT, '-C', cwd, ...args], {
    env: { ...process.env, GIT_ALLOW_PROTOCOL: 'file', GIT_TERMINAL_PROMPT: '0' },
  });
  if ((await child.exited).code !== 0) throw new Error(`fixture Git failed: ${child.stderr}`);
  return child.stdout.trim();
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oa-pub-'));
  paths.push(root);
  const checkout = path.join(root, 'src');
  const remote = path.join(root, 'bare.git');
  const repository = path.join(root, 'publisher.git');
  const socketPath = path.join(root, 'ipc', 'publisher.sock');
  const gitLog = path.join(root, 'git.log');
  const shim = path.join(root, 'shim');
  await mkdir(path.dirname(socketPath), { mode: 0o700 });
  await chmod(path.dirname(socketPath), 0o700);
  await mkdir(shim);
  await mkdir(path.join(checkout, 'docs'), { recursive: true });
  await git(root, 'init', '-q');
  await writeFile(path.join(root, '.gitignore'), '.workspace/\n');
  await git(checkout, 'init', '-q', '--initial-branch=main');
  await git(checkout, 'config', 'user.name', 'Owner Alpha Publisher Fixture');
  await git(checkout, 'config', 'user.email', 'publisher@example.invalid');
  await writeFile(path.join(checkout, 'docs', 'page.md'), '# Page\n\nFixture old sentence.\n');
  await git(checkout, 'add', '--', 'docs/page.md');
  await git(checkout, 'commit', '-q', '-m', 'fixture base');
  const baseCommit = await git(checkout, 'rev-parse', 'HEAD');
  await git(root, 'init', '--bare', '-q', '--initial-branch=main', remote);
  await git(checkout, 'remote', 'add', 'origin', remote);
  await git(checkout, 'push', '-q', remote, 'main');

  const raw = JSON.parse(await readFile(EXAMPLE, 'utf8'));
  raw.repository.checkout = checkout;
  raw.publisher = { socketPath };
  await git(checkout, 'remote', 'set-url', 'origin', raw.repository.remote.url);
  const config = validateOwnerAlphaConfig(raw);
  const context = storeContextFromConfig(config, root);
  await prepareStore(context);
  const configFile = path.join(root, 'owner.json');
  await writeFile(configFile, JSON.stringify(raw), { mode: 0o600 });
  await writeFile(gitLog, '');
  // Only transport operations are translated. Production policy checks still
  // inspect the real configured URL; Git cannot use any non-file protocol here.
  await writeFile(path.join(shim, 'git'), `#!/usr/bin/env bash
set -eu
present=no
if [[ -v ${SECRET_KEY} ]]; then present=yes; fi
globals=()
while [[ "$1" == -C || "$1" == --git-dir || "$1" == -c || "$1" == --no-pager ]]; do
  if [[ "$1" == --no-pager ]]; then globals+=("$1"); shift; else globals+=("$1" "$2"); shift 2; fi
done
printf '%s|%s|%s|%s\n' "$PPID" "$1" "$present" "\${globals[*]} $*" >> "$OA_GIT_LOG"
if [[ "$1" == push && -n "\${OA_TEST_PUSH_GATE:-}" ]]; then
  for ((i=0; i<150; i++)); do
    if [[ -e "$OA_TEST_PUSH_GATE" ]]; then break; fi
    sleep 0.02
  done
  [[ -e "$OA_TEST_PUSH_GATE" ]]
fi
export GIT_ALLOW_PROTOCOL=file
if [[ "$1" == push || "$1" == ls-remote || "$1" == fetch || "$1" == clone || "$1" == pull ]]; then
  args=("$@"); destination=0
  for ((i=1; i<\${#args[@]}; i++)); do
    if [[ "\${args[i]}" != -* ]]; then destination=$i; break; fi
  done
  if ((destination > 0)); then
    if [[ "\${globals[0]}" == --git-dir && "\${args[destination]}" == "$OA_POLICY_URL" ]] ||
      [[ "\${globals[0]}" == -C && "\${args[destination]}" == origin ]]; then
      args[destination]="$OA_LOCAL_BARE"
    fi
    if [[ "\${args[destination]}" == /* ]] && target=$(realpath -e -- "\${args[destination]}") && [[ "$target" == "$OA_TMP_ROOT/"* ]]; then
      exec "$OA_REAL_GIT" "\${globals[@]}" -c protocol.file.allow=always "\${args[@]}"
    fi
  fi
  printf 'unsafe Git transport\n' >> "$OA_GIT_LOG.violation"
  exit 99
fi
exec "$OA_REAL_GIT" "\${globals[@]}" "$@"
`, { mode: 0o700 });
  const env = {
    ...process.env, PATH: `${shim}:${process.env.PATH}`, GIT_ALLOW_PROTOCOL: 'file',
    GIT_TERMINAL_PROMPT: '0', OA_GIT_LOG: gitLog, OA_REAL_GIT: REAL_GIT,
    OA_TMP_ROOT: root, OA_LOCAL_BARE: remote, OA_POLICY_URL: raw.repository.remote.url,
  };
  delete env[SECRET_KEY];
  const publisherRunner = path.join(root, 'start-publisher.mjs');
  await writeFile(publisherRunner, `import { runPublisherCli } from ${JSON.stringify(pathToFileURL(CLI).href)};
await runPublisherCli({ configFile: process.argv[2], socketPath: process.argv[3], repository: process.argv[4], projectRoot: import.meta.dir });
`);
  const appRunner = path.join(root, 'start-app.mjs');
  const moduleUrl = (name) => JSON.stringify(pathToFileURL(path.join(APP, 'src', `${name}.js`)).href);
  await writeFile(appRunner, `import { loadOwnerAlphaConfig } from ${moduleUrl('config')};
import { createSaveHandler } from ${moduleUrl('pipeline')};
const [configFile, jobId, action] = process.argv.slice(2);
const config = await loadOwnerAlphaConfig(configFile);
const save = createSaveHandler({ config, projectRoot: import.meta.dir, dependencies: {
  async runPreApplyChecks() { return { ok: true, rendered: { witnesses: { old: 'old sentence.', new: 'new sentence.' } } }; },
  async discoverDeploymentRun({ applicationSha }) { return { binding: { headSha: applicationSha } }; },
  async monitorDeploymentRun() { return { state: 'success' }; },
  async confirmLivePage() { return { confirmed: true }; },
  async rebuildLocal() { return { status: 'local-rebuilt' }; },
} });
const result = action === 'resume' ? await save.resumeJob({ jobId }) : await save.startEdit({
  jobId, renderer: { relativePath: 'docs/page.md', slug: 'docs/page' }, editedText: '# Page\\n\\nFixture new sentence.\\n',
}).completion;
process.stdout.write(JSON.stringify({ result, credentialPresent: Object.hasOwn(process.env, ${JSON.stringify(SECRET_KEY)}) }) + '\\n');
`);
  return { root, checkout, remote, repository, socketPath, gitLog, baseCommit, config, raw, configFile, context, env, publisherRunner, appRunner,
    secret: `fixture-credential-${randomUUID()}` };
}

async function runPublisher(fx, { pushGate } = {}) {
  const env = { ...fx.env, [SECRET_KEY]: fx.secret, ...(pushGate ? { OA_TEST_PUSH_GATE: pushGate } : {}) };
  const child = launch([process.execPath, fx.publisherRunner, fx.configFile, fx.socketPath, fx.repository], { cwd: fx.root, env });
  await waitUntil(() => {
    if (child.exit) throw new Error(`publisher exited before reporting readiness: ${child.stderr}`);
    return child.stdout === 'owner-alpha publisher ready\n';
  });
  return child;
}

function runApp(fx, jobId, { configFile = fx.configFile, action = 'save' } = {}) {
  return launch([process.execPath, fx.appRunner, configFile, jobId, action], { cwd: fx.root, env: fx.env });
}

async function appResult(child) {
  const { code } = await child.exited;
  if (code !== 0) throw new Error(`fixture app failed: ${child.stderr}`);
  return JSON.parse(child.stdout);
}

async function stopChild(child, signal = 'SIGTERM') {
  child.process.kill(signal);
  return child.exited;
}

function line(jobId) { return `${JSON.stringify({ v: 1, jobId })}\n`; }

function rawExchange(address, raw, onConnected) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: address });
    const timer = setTimeout(() => socket.destroy(new Error('no publisher reply')), 3_000);
    let reply = '';
    socket.once('connect', () => {
      if (raw !== null) socket.write(raw);
      onConnected?.(socket);
    });
    socket.on('data', (chunk) => { reply += chunk.toString('utf8'); });
    socket.once('error', reject);
    socket.once('close', () => { clearTimeout(timer); resolve(reply); });
  });
}

async function fakeServer(address, onConnection, action) {
  const clients = new Set();
  const server = net.createServer((socket) => {
    clients.add(socket);
    socket.on('error', () => socket.destroy());
    socket.once('close', () => clients.delete(socket));
    onConnection(socket);
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(address, resolve);
    });
    return await action();
  } finally {
    for (const client of clients) client.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function withAppHoldingPush(fx, jobId, action) {
  const address = path.join(path.dirname(fx.socketPath), 'hold.sock');
  const configFile = path.join(fx.root, 'hold.json');
  await writeFile(configFile, JSON.stringify({ ...fx.raw, publisher: { socketPath: address } }), { mode: 0o600 });
  let received = '';
  return fakeServer(address, (socket) => { socket.on('data', (chunk) => { received += chunk.toString(); }); }, async () => {
    const app = runApp(fx, jobId, { configFile });
    try {
      await waitUntil(() => {
        if (app.exit) throw new Error('fixture app exited before holding the push');
        return received.endsWith('\n');
      });
      expect(received).toBe(line(jobId));
      expect((await loadDurableJob(fx.context, jobId)).state).toBe('pushing');
      await action(app);
    } finally {
      if (!app.exit) await stopChild(app, 'SIGKILL');
    }
  });
}

async function pushes(fx) {
  return (await readFile(fx.gitLog, 'utf8')).split('\n').filter((row) => row.split('|')[1] === 'push');
}

async function receipt(fx, jobId) {
  return JSON.parse(await readFile(path.join(fx.context.storeRoot, pipelineArtifactPaths(jobId).pushed), 'utf8'));
}

async function containsInArtifacts(directory, needle) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory() ? await containsInArtifacts(target, needle)
      : entry.isFile() && (await readFile(target)).includes(needle)) return true;
  }
  return false;
}

async function expectCode(promise, code) {
  try { await promise; } catch (error) {
    expect(error).toBeInstanceOf(OwnerAlphaError);
    expect(error.code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

afterEach(async () => {
  await Promise.all([...children].map((child) => stopChild(child, 'SIGKILL')));
  const roots = paths.splice(0);
  try {
    for (const root of roots) await expect(lstat(path.join(root, 'git.log.violation'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await Promise.all(roots.map((target) => rm(target, { recursive: true, force: true })));
  }
});

test('Save invokes Git push only in the publisher process and leaves a bound receipt', async () => {
  const fx = await fixture();
  const publisher = await runPublisher(fx);
  expect((await lstat(fx.socketPath)).mode & 0o777).toBe(0o600);
  const app = runApp(fx, 'OA-CHILD');
  const { result, credentialPresent } = await appResult(app);
  expect(result.state).toBe('completed');
  expect(credentialPresent).toBe(false);
  const bound = (await receipt(fx, 'OA-CHILD')).result;
  expect(bound.status).toBe('pushed');
  expect(bound.commit).not.toBe(fx.baseCommit);
  expect(await git(fx.remote, 'rev-parse', 'refs/heads/main')).toBe(bound.commit);
  const commands = await pushes(fx);
  expect(commands).toHaveLength(1);
  expect(commands[0].split('|').slice(0, 3)).toEqual([String(publisher.process.pid), 'push', 'yes']);
  expect((await readFile(fx.gitLog, 'utf8')).includes(`${app.process.pid}|commit|no|`)).toBe(true);
  const response = await rawExchange(fx.socketPath, line('OA-CHILD'));
  expect(response).toBe('{"ok":false,"code":"publisher-job-not-admitted"}\n');
  expect(await containsInArtifacts(fx.context.storeRoot, fx.secret)).toBe(false);
  expect([response, app.stdout, app.stderr, publisher.stdout, publisher.stderr].some((text) => text.includes(fx.secret))).toBe(false);
  expect(await stopChild(publisher)).toEqual({ code: 0, signal: null });
  await expect(lstat(fx.socketPath)).rejects.toMatchObject({ code: 'ENOENT' });
}, 15_000);

test('refuses malformed, unauthorized, buffered extra data and slow requests without a push', async () => {
  const fx = await fixture();
  const jobId = 'OA-REQUEST';
  await runPublisher(fx);
  const revision = computePolicyRevision(fx.config);
  const at = new Date().toISOString();
  await initializeDurableJob(fx.context, { jobId: 'OA-NOT-PUSHING', at, policyRevision: revision });
  await initializeDurableJob(fx.context, { jobId: 'OA-STALE', at, policyRevision: `sha256:${'f'.repeat(64)}` });
  for (const state of ['preflighting', 'checking', 'rendering', 'ready-to-apply', 'applying', 'source-applied', 'committing', 'committed', 'pushing']) {
    await transitionDurableJob(fx.context, 'OA-STALE', state, { at, reason: 'fixture' });
  }
  await withAppHoldingPush(fx, jobId, async () => {
    const badRequests = [
      [`{"v":1,"jobId":"${jobId}","remote":"never"}\n`, 'publisher-invalid-request'],
      [`{"v":2,"jobId":"${jobId}"}\n`, 'publisher-invalid-request'],
      [`{"v":1,"v":1,"jobId":"${jobId}"}\n`, 'publisher-invalid-request'],
      [`{"v":1,"jobId":"${jobId}"}${' '.repeat(1024)}\n`, 'publisher-invalid-request'],
      [' '.repeat(1024), 'publisher-invalid-request'],
      [`${line(jobId)}${line(jobId)}`, 'publisher-invalid-request'],
      [`${line(jobId)} `, 'publisher-invalid-request'],
      ['{"v":1,\n', 'publisher-invalid-request'],
      [Buffer.from([0xc3, 0x0a]), 'publisher-invalid-request'],
      [line('OA-UNKNOWN'), 'publisher-job-not-found'],
      [line('OA-NOT-PUSHING'), 'publisher-job-not-admitted'],
      [line('OA-STALE'), 'publisher-job-not-admitted'],
      ['{"v":', 'publisher-request-timeout'],
    ];
    for (const [payload, code] of badRequests) {
      expect(await rawExchange(fx.socketPath, payload)).toBe(`${JSON.stringify({ ok: false, code })}\n`);
    }
    expect(await pushes(fx)).toEqual([]);
    expect(await git(fx.remote, 'rev-parse', 'refs/heads/main')).toBe(fx.baseCommit);
  });
}, 15_000);

test('a second request sent after acceptance gets no second response or push', async () => {
  const fx = await fixture();
  const jobId = 'OA-LATE';
  const pushGate = path.join(fx.root, 'release-push');
  await runPublisher(fx, { pushGate });
  await withAppHoldingPush(fx, jobId, async () => {
    let socket;
    const pending = rawExchange(fx.socketPath, line(jobId), (connected) => { socket = connected; });
    await waitUntil(async () => (await pushes(fx)).length === 1);
    expect(await rawExchange(fx.socketPath, line(jobId))).toBe('{"ok":false,"code":"publisher-busy"}\n');
    await new Promise((resolve, reject) => socket.write(line(jobId), (error) => error ? reject(error) : resolve()));
    await writeFile(pushGate, 'release');
    const response = await pending;
    expect(response).toBe('{"ok":true,"status":"pushed"}\n');
    expect(response.includes(fx.secret)).toBe(false);
    expect(await pushes(fx)).toHaveLength(1);
  });
}, 15_000);

test('an unavailable publisher leaves manual intervention with no in-process push or retry', async () => {
  const fx = await fixture();
  const id = 'OA-PUBLISHER-DOWN';
  for (const action of ['save', 'resume']) {
    const { result } = await appResult(runApp(fx, id, { action }));
    expect(result.state).toBe('manual-intervention');
    expect(result.failure.code).toBe('publisher-unavailable');
    expect(result.failure.retryable).toBe(false);
  }
  expect(await pushes(fx)).toEqual([]);
  expect(await git(fx.remote, 'rev-parse', 'refs/heads/main')).toBe(fx.baseCommit);
}, 15_000);

test('a successful reply without durable push evidence never advances the app', async () => {
  const fx = await fixture();
  await fakeServer(fx.socketPath, (socket) => {
    socket.once('data', () => socket.end('{"ok":true,"status":"pushed"}\n'));
  }, async () => {
    const { result } = await appResult(runApp(fx, 'OA-MISSING-RECEIPT'));
    expect(result.state).toBe('manual-intervention');
    expect(result.failure.code).toBe('pushed-evidence-missing');
  });
  expect(await pushes(fx)).toEqual([]);
}, 15_000);

test('timeout and a truncated response both fail ambiguously', async () => {
  const fx = await fixture();
  for (const reply of [null, '{"ok":true']) {
    await fakeServer(fx.socketPath, (socket) => {
      if (reply !== null) socket.once('data', () => socket.end(reply));
    }, () => expectCode(requestPublication({ socketPath: fx.socketPath, jobId: 'OA-IPC-FAIL', timeoutMs: 50 }), 'publisher-unavailable'));
  }
});

test('after publisher SIGKILL, a durable receipt proves idempotent replay and app recovery', async () => {
  const fx = await fixture();
  const jobId = 'OA-PUBLISHER-RESTART';
  const first = await runPublisher(fx);
  await withAppHoldingPush(fx, jobId, async () => {
    expect(await requestPublication({ socketPath: fx.socketPath, jobId })).toEqual({ ok: true, status: 'pushed' });
    expect(await stopChild(first, 'SIGKILL')).toEqual({ code: null, signal: 'SIGKILL' });
    expect((await lstat(fx.socketPath)).isSocket()).toBe(true);
    expect((await receipt(fx, jobId)).result.status).toBe('pushed');
    expect((await loadDurableJob(fx.context, jobId)).state).toBe('pushing');
  });
  const second = await runPublisher(fx);
  expect(second.process.pid).not.toBe(first.process.pid);
  expect(await requestPublication({ socketPath: fx.socketPath, jobId })).toEqual({ ok: true, status: 'already-pushed' });
  const { result } = await appResult(runApp(fx, jobId, { action: 'resume' }));
  expect(result.state).toBe('completed');
  expect(await pushes(fx)).toHaveLength(1);
  expect(await git(fx.remote, 'rev-parse', 'refs/heads/main')).toBe((await receipt(fx, jobId)).result.commit);
  expect(await stopChild(second, 'SIGINT')).toEqual({ code: 0, signal: null });
  await expect(lstat(fx.socketPath)).rejects.toMatchObject({ code: 'ENOENT' });
}, 15_000);

test('refuses open or symlinked parents and occupied non-stale socket paths', async () => {
  const fx = await fixture();
  const directory = path.dirname(fx.socketPath);
  const opts = { config: fx.config, context: fx.context, socketPath: fx.socketPath, repository: fx.repository };
  await chmod(directory, 0o755);
  await expectCode(startPublisher(opts), 'publisher-unsafe-socket');
  const cli = launch([process.execPath, CLI, fx.configFile, fx.socketPath, fx.repository], { cwd: fx.root, env: fx.env });
  expect(await cli.exited).toEqual({ code: 1, signal: null });
  expect(cli.stderr).toBe('owner-alpha publisher failed\n');
  await chmod(directory, 0o700);
  const alias = path.join(fx.root, 'alias');
  await symlink(directory, alias);
  await expectCode(startPublisher({ ...opts, socketPath: path.join(alias, 'publisher.sock') }), 'publisher-unsafe-socket');
  await writeFile(fx.socketPath, 'not a socket');
  await expectCode(startPublisher(opts), 'publisher-socket-in-use');
  expect(await readFile(fx.socketPath, 'utf8')).toBe('not a socket');
  await rm(fx.socketPath);
  await runPublisher(fx);
  await expectCode(startPublisher(opts), 'publisher-socket-in-use');
  await expectCode(requestPublication({ socketPath: fx.socketPath, jobId: 'OA-UNKNOWN' }), 'publisher-job-not-found');
}, 15_000);

test('no publisher setting retains the exact policy revision; routing is policy-neutral', async () => {
  const raw = JSON.parse(await readFile(EXAMPLE, 'utf8'));
  expect(Object.hasOwn(validateOwnerAlphaConfig(raw), 'publisher')).toBe(false);
  expect(computePolicyRevision(raw)).toBe(LEGACY_REVISION);
  expect(computePolicyRevision({ ...raw, publisher: { socketPath: '/run/owner-alpha/publisher.sock' } })).toBe(LEGACY_REVISION);
});

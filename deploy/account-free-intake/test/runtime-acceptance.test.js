import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ACCOUNT_FREE_INTENT_ARTIFACT_TYPE,
  prepareSourceBindingManifest,
  retainedManifestFilename,
  serializeSourceBindingManifest,
  sourceBindingDigest,
} from '../../../packages/account-free-intake/src/index.js';

const ROOT = path.resolve(import.meta.dir, '../../..');
const IMAGE = process.env.ACCOUNT_FREE_INTAKE_CONTAINER_IMAGE ?? '';
const dockerAvailable = Bun.spawnSync({ cmd: ['bash', '-lc', 'command -v docker >/dev/null && docker info >/dev/null 2>&1'] }).exitCode === 0;
const imageTest = IMAGE !== '' && dockerAvailable ? test : test.skip;
const cleanupPaths = [];
const cleanupContainers = new Set();
const cleanupNetworks = new Set();
const cleanupVolumes = new Set();

function run(command, { expected = 0, env = process.env } = {}) {
  const result = Bun.spawnSync({ cmd: command, cwd: ROOT, env, stdout: 'pipe', stderr: 'pipe' });
  const output = `${result.stdout.toString()}${result.stderr.toString()}`;
  expect(result.exitCode, output).toBe(expected);
  return { ...result, output };
}

function docker(args, options) {
  return run(['docker', ...args], options);
}

function unique(prefix) {
  return `${prefix}-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
}

function digest(bytes) {
  return `sha-256=:${createHash('sha256').update(bytes).digest('base64')}:`;
}

async function git(cwd, args) {
  return run(['git', '-C', cwd, ...args]).stdout.toString().trim();
}

async function makeReadOnlyTree(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await makeReadOnlyTree(target);
      await chmod(target, 0o555);
    } else await chmod(target, 0o444);
  }
  await chmod(root, 0o555);
}

async function restoreWritableTree(root) {
  try {
    await chmod(root, 0o700);
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const target = path.join(root, entry.name);
      if (entry.isDirectory()) await restoreWritableTree(target);
      else await chmod(target, 0o600);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'account-free-intake-container-'));
  cleanupPaths.push(root);
  const checkout = path.join(root, 'checkout');
  const bare = path.join(root, 'objects.git');
  const bindings = path.join(root, 'bindings');
  const configFile = path.join(root, 'account-free-intake.json');
  await mkdir(checkout, { mode: 0o700 });
  await mkdir(bare, { mode: 0o700 });
  await mkdir(bindings, { mode: 0o700 });
  await git(checkout, ['init', '--initial-branch=main']);
  await git(checkout, ['config', 'user.name', 'Container Acceptance']);
  await git(checkout, ['config', 'user.email', 'acceptance@example.invalid']);
  await mkdir(path.join(checkout, 'docs'), { recursive: true });
  await mkdir(path.join(checkout, '.cyberbaser'), { recursive: true });
  const sourcePath = 'docs/notes.md';
  const baseText = '# Notes\n\nCorrect teh typo.\n';
  const policyText = 'trusted: []\nagents: []\n';
  await writeFile(path.join(checkout, sourcePath), baseText);
  await writeFile(path.join(checkout, '.cyberbaser', 'trust.yml'), policyText);
  await git(checkout, ['add', '--all']);
  await git(checkout, ['commit', '-m', 'Published source']);
  const revision = await git(checkout, ['rev-parse', 'HEAD']);
  await git(bare, ['init', '--bare', '--initial-branch=main']);
  await git(checkout, ['remote', 'add', 'origin', bare]);
  await git(checkout, ['push', 'origin', 'HEAD:refs/heads/main']);

  const repository = 'https://forge.example.invalid/owner/wiki.git';
  const baseBytes = Buffer.from(baseText, 'utf8');
  const manifest = prepareSourceBindingManifest({
    source: { repository, revision },
    publication: {
      publishPolicyDigest: digest(Buffer.from('publish-policy-v1\n')),
      selectedTreeDigest: digest(Buffer.from(`${sourcePath}\0${baseBytes.length}\0${digest(baseBytes)}\n`)),
    },
    renderer: { name: 'quartz-cyberbase', revision: 'a'.repeat(40) },
    trustPolicy: { status: 'valid', digest: digest(Buffer.from(policyText)) },
    pages: [{ path: sourcePath, byteLength: baseBytes.length, digest: digest(baseBytes) }],
  });
  const bindingDigest = sourceBindingDigest(manifest);
  await writeFile(
    path.join(bindings, retainedManifestFilename(bindingDigest)),
    serializeSourceBindingManifest(manifest),
    { mode: 0o444 },
  );

  const config = {
    schemaVersion: 1,
    enabled: true,
    publicOrigin: 'https://intake.example.invalid',
    listen: { host: '0.0.0.0', port: 8080 },
    allowedFormOrigins: ['https://wiki.example.invalid'],
    repository,
    bindingsRoot: '/srv/cyberbaser/source-bindings',
    gitDir: '/srv/cyberbaser/source-objects.git',
    queue: {
      root: '/var/lib/cyberbaser/proposal-queue',
      maxPendingEntries: 1000,
      maxRetainedBytes: 268435456,
      maxPendingPerSource: 25,
      pendingRetentionMs: 2592000000,
      expiredGraceMs: 604800000,
    },
    limits: {
      maxBodyBytes: 98304,
      requestTimeoutMs: 5000,
      maxConcurrentRequests: 4,
      tokenBucketCapacity: 20,
      tokenBucketRefillPerSecond: 1,
    },
  };
  await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o444 });
  await chmod(configFile, 0o444);
  await makeReadOnlyTree(bindings);
  await makeReadOnlyTree(bare);

  const intent = {
    schemaVersion: 1,
    artifactType: ACCOUNT_FREE_INTENT_ARTIFACT_TYPE,
    bindingDigest,
    pageId: manifest.pages[0].pageId,
    selection: { quote: 'teh', prefix: 'Correct ', suffix: ' typo.' },
    replacement: 'the',
    rationale: 'Correct the misspelling.',
    evidence: ['https://reference.example.invalid/fact'],
    idempotencyKey: null,
  };
  return { root, checkout, bare, bindings, configFile, intent };
}

async function waitForHealth(container) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const result = Bun.spawnSync({
      cmd: ['docker', 'inspect', '--format', '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}', container],
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const status = result.stdout.toString().trim();
    if (status === 'healthy') return;
    if (['unhealthy', 'exited', 'dead'].includes(status)) {
      const inspected = docker(['inspect', container]).stdout.toString();
      throw new Error(`container entered ${status}: ${inspected}`);
    }
    await Bun.sleep(250);
  }
  throw new Error('container did not become healthy');
}

afterEach(async () => {
  for (const container of cleanupContainers) {
    Bun.spawnSync({ cmd: ['docker', 'rm', '--force', container], stdout: 'ignore', stderr: 'ignore' });
  }
  cleanupContainers.clear();
  for (const network of cleanupNetworks) {
    Bun.spawnSync({ cmd: ['docker', 'network', 'rm', network], stdout: 'ignore', stderr: 'ignore' });
  }
  cleanupNetworks.clear();
  for (const volume of cleanupVolumes) {
    Bun.spawnSync({ cmd: ['docker', 'volume', 'rm', '--force', volume], stdout: 'ignore', stderr: 'ignore' });
  }
  cleanupVolumes.clear();
  for (const target of cleanupPaths.splice(0)) {
    await restoreWritableTree(target);
    await rm(target, { recursive: true, force: true });
  }
});

describe('account-free intake local OCI runtime acceptance', () => {
  imageTest('runs one isolated internal-only service and durably enqueues one exact proposal', async () => {
    expect(IMAGE).toMatch(/^sha256:[a-f0-9]{64}$/u);
    const item = await fixture();
    const container = unique('account-free-intake');
    const network = unique('account-free-intake-internal');
    const volume = unique('account-free-intake-queue');
    cleanupContainers.add(container);
    cleanupNetworks.add(network);
    cleanupVolumes.add(volume);

    const metadata = docker(['image', 'inspect', '--format', '{{.Id}}|{{.Os}}|{{.Architecture}}|{{.Config.User}}|{{json .Config.Entrypoint}}|{{json .Config.Healthcheck.Test}}', IMAGE]);
    const [id, platform, architecture, user, entrypoint, health] = metadata.stdout.toString().trim().split('|');
    expect(id).toBe(IMAGE);
    expect(platform).toBe('linux');
    expect(architecture).toBe('amd64');
    expect(user).toBe('65532:65532');
    expect(JSON.parse(entrypoint)).toEqual(['/usr/local/bin/account-free-intake-entrypoint']);
    expect(JSON.parse(health)).toEqual(['CMD', 'bun', '/opt/cyberbaser/deploy/account-free-intake/healthcheck.js']);

    docker(['volume', 'create', volume]);
    docker(['network', 'create', '--internal', network]);
    docker([
      'run', '--rm', '--network', 'none', '--read-only', '--user', '0:0',
      '--cap-drop', 'ALL', '--cap-add', 'CHOWN', '--security-opt', 'no-new-privileges',
      '--mount', `type=volume,source=${volume},target=/var/lib/cyberbaser,volume-nocopy`,
      '--entrypoint', '/usr/local/bin/account-free-intake-queue-init',
      IMAGE,
    ]);

    docker([
      'run', '--detach', '--name', container,
      '--user', '65532:65532', '--network', network, '--read-only', '--init',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--mount', `type=bind,source=${item.configFile},target=/config/account-free-intake.json,readonly`,
      '--mount', `type=bind,source=${item.bindings},target=/srv/cyberbaser/source-bindings,readonly`,
      '--mount', `type=bind,source=${item.bare},target=/srv/cyberbaser/source-objects.git,readonly`,
      '--mount', `type=volume,source=${volume},target=/var/lib/cyberbaser,volume-nocopy`,
      '--tmpfs', '/run/account-free-intake:rw,nosuid,nodev,noexec,mode=0700,uid=65532,gid=65532,size=8m',
      '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,mode=0700,uid=65532,gid=65532,size=16m',
      '--health-cmd', 'bun /opt/cyberbaser/deploy/account-free-intake/healthcheck.js',
      '--health-interval', '1s', '--health-timeout', '2s', '--health-retries', '20', '--health-start-period', '1s',
      IMAGE,
    ]);
    await waitForHealth(container);

    const inspect = JSON.parse(docker(['inspect', container]).stdout.toString())[0];
    expect(inspect.Config.User).toBe('65532:65532');
    expect(inspect.HostConfig.ReadonlyRootfs).toBe(true);
    expect(inspect.HostConfig.NetworkMode).toBe(network);
    expect(inspect.HostConfig.PortBindings ?? {}).toEqual({});
    expect(inspect.HostConfig.CapDrop).toContain('ALL');
    expect(inspect.HostConfig.SecurityOpt).toContain('no-new-privileges');
    expect(inspect.NetworkSettings.Ports ?? {}).toEqual({});
    const mounted = Object.fromEntries(inspect.Mounts.map((mount) => [mount.Destination, mount.RW]));
    expect(mounted).toEqual({
      '/config/account-free-intake.json': false,
      '/srv/cyberbaser/source-bindings': false,
      '/srv/cyberbaser/source-objects.git': false,
      '/var/lib/cyberbaser': true,
    });
    const networkInspect = JSON.parse(docker(['network', 'inspect', network]).stdout.toString())[0];
    expect(networkInspect.Internal).toBe(true);

    docker(['exec', container, 'bun', '/opt/cyberbaser/deploy/account-free-intake/healthcheck.js']);
    docker(['exec', container, 'bash', '-c', 'set -euo pipefail; test ! -e /vault; test ! -e /run/owner-alpha; test ! -e /run/owner-alpha-credentials; test ! -e /var/run/docker.sock; test ! -e /run/podman/podman.sock; test ! -e /root/.ssh; test ! -e /source-worktree; test ! -e /publication-output']);

    const encodedIntent = Buffer.from(JSON.stringify(item.intent), 'utf8').toString('base64');
    const submitScript = `
const intent = Buffer.from(process.env.INTENT_B64, 'base64').toString('utf8');
const response = await fetch('http://127.0.0.1:8080/v1/corrections', {
  method: 'POST',
  headers: { Host: 'intake.example.invalid', Origin: 'https://wiki.example.invalid', 'Content-Type': 'application/json' },
  body: intent,
});
const body = await response.text();
if (response.status !== 202) throw new Error(response.status + ': ' + body);
const parsed = JSON.parse(body);
if (parsed.receipt?.state !== 'pending-review') throw new Error('missing pending receipt');
process.stdout.write(body);
`;
    const submitted = docker(['exec', '--env', `INTENT_B64=${encodedIntent}`, container, 'bun', '-e', submitScript]);
    const receipt = JSON.parse(submitted.stdout.toString());
    expect(receipt.receipt.queueId).toMatch(/^Q-[0-9a-f-]{36}$/u);
    expect(receipt.receipt.state).toBe('pending-review');

    expect(run(['git', '-C', item.checkout, 'status', '--short']).stdout.toString()).toBe('');
    expect((await stat(item.configFile)).mode & 0o222).toBe(0);
    expect((await stat(item.bindings)).mode & 0o222).toBe(0);
    expect((await stat(item.bare)).mode & 0o222).toBe(0);
    expect(docker(['diff', container]).stdout.toString().trim()).toBe('');

    docker(['rm', '--force', container]);
    cleanupContainers.delete(container);
    docker([
      'run', '--rm', '--network', 'none', '--read-only',
      '--mount', `type=volume,source=${volume},target=/queue,readonly,volume-nocopy`,
      '--entrypoint', 'bash', IMAGE, '-c',
      `set -euo pipefail; test -f /queue/proposal-queue/pending/${receipt.receipt.queueId}/proposal.json; test "$(find /queue/proposal-queue/pending/${receipt.receipt.queueId} -maxdepth 1 -type f | wc -l)" = 5`,
    ]);
    expect(await readFile(item.configFile, 'utf8')).toContain('"enabled": true');
  }, 120_000);
});

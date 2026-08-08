import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '../../..');
const DEPLOY = path.join(ROOT, 'deploy', 'owner-alpha');
const COMPOSE = path.join(DEPLOY, 'compose.yaml');
const ENV_EXAMPLE = path.join(DEPLOY, 'operator.env.example');
const MANAGER = path.join(DEPLOY, 'owner-alpha-compose.sh');
const cleanup = [];
const cleanupServers = [];

async function text(relative) {
  return readFile(path.join(ROOT, relative), 'utf8');
}

async function tempRoot(prefix) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanup.push(root);
  return root;
}

async function managerFixture({ profile = 'rootless', rootlessDaemon = true } = {}) {
  const root = await tempRoot('owner-alpha-manager-');
  const bin = path.join(root, 'bin');
  const log = path.join(root, 'docker.log');
  const vault = path.join(root, 'vault');
  const credentials = path.join(root, 'credentials');
  const config = path.join(root, 'owner-alpha.local.json');
  const composeFile = path.join(root, 'compose.yaml');
  const envFile = path.join(root, 'operator.env');
  await mkdir(bin);
  await mkdir(vault, { mode: 0o700 });
  await mkdir(credentials, { mode: 0o700 });
  await writeFile(config, '{}\n', { mode: 0o600 });
  await chmod(config, 0o600);
  await writeFile(composeFile, await readFile(COMPOSE), { mode: 0o644 });
  await chmod(composeFile, 0o644);
  const broker = createNetServer();
  const socket = path.join(credentials, 'helper.sock');
  await new Promise((resolve, reject) => broker.listen(socket, resolve).once('error', reject));
  cleanupServers.push(broker);
  await chmod(socket, 0o600);

  const image = `sha256:${'a'.repeat(64)}`;
  const lines = [
    `OWNER_ALPHA_PROFILE=${profile}`,
    `OWNER_ALPHA_IMAGE=${image}`,
    `OWNER_ALPHA_VAULT_PATH=${vault}`,
    `OWNER_ALPHA_CONFIG_PATH=${config}`,
    `OWNER_ALPHA_CREDENTIAL_SOCKET_DIR=${credentials}`,
    'OWNER_ALPHA_STATE_VOLUME=owner-alpha-test-state',
    `${profile === 'rootful' ? 'OWNER_ALPHA_STATE_PROFILE=rootful-test-v1' : 'OWNER_ALPHA_STATE_PROFILE=rootless-test-v1'}`,
    `OWNER_ALPHA_UID=${process.getuid() || 1000}`,
    `OWNER_ALPHA_GID=${process.getgid()}`,
    'OWNER_ALPHA_TMPFS_SIZE=4g',
    'OWNER_ALPHA_RUNTIME_TMPFS_SIZE=16m',
  ];
  await writeFile(envFile, `${lines.join('\n')}\n`, { mode: 0o600 });
  await chmod(envFile, 0o600);

  const fakeDocker = path.join(bin, 'docker');
  await writeFile(fakeDocker, `#!/usr/bin/env bash
set -euo pipefail
{ printf 'CALL\\n'; printf 'ARG=%s\\n' "$@"; } >> "$FAKE_DOCKER_LOG"
if [[ "\${1:-}" == context && "\${2:-}" == show ]]; then printf 'default\\n'; exit 0; fi
if [[ "\${1:-}" == context && "\${2:-}" == inspect ]]; then printf '%s\\n' "\${FAKE_DOCKER_ENDPOINT:-unix:///run/docker.sock}"; exit 0; fi
if [[ "\${1:-}" == info && "\${3:-}" == '{{.OSType}}' ]]; then printf 'linux\\n'; exit 0; fi
if [[ "\${1:-}" == info && "\${3:-}" == '{{json .SecurityOptions}}' ]]; then
  if [[ "\${FAKE_DOCKER_ROOTLESS:-1}" == 1 ]]; then printf '["name=rootless"]\\n'; else printf '["name=seccomp"]\\n'; fi
  exit 0
fi
exit 0
`, { mode: 0o755 });
  await chmod(fakeDocker, 0o755);

  return {
    root,
    log,
    vault,
    credentials,
    config,
    envFile,
    image,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_DOCKER_LOG: log,
      FAKE_DOCKER_ROOTLESS: rootlessDaemon ? '1' : '0',
      OWNER_ALPHA_ENV_FILE: envFile,
      OWNER_ALPHA_COMPOSE_FILE: composeFile,
    },
  };
}

function run(command, { env = process.env } = {}) {
  return Bun.spawnSync({
    cmd: command,
    cwd: ROOT,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

function failure(result) {
  return `${result.stdout.toString()}\n${result.stderr.toString()}`;
}

function composeConfig(profile, envFile = ENV_EXAMPLE) {
  const result = run([
    'docker', 'compose',
    '--file', COMPOSE,
    '--env-file', envFile,
    '--profile', profile,
    'config', '--format', 'json',
  ]);
  expect(result.exitCode, failure(result)).toBe(0);
  return JSON.parse(result.stdout.toString());
}

function expectRuntimeContract(service, { user, initService }) {
  expect(service.image).toMatch(/(?:^sha256:[a-f0-9]{64}$|@sha256:[a-f0-9]{64}$)/u);
  expect(service.pull_policy).toBe('never');
  expect(service.build).toBeUndefined();
  expect(service.network_mode).toBe('host');
  expect(service.ports).toBeUndefined();
  expect(service.read_only).toBe(true);
  expect(service.init).toBe(true);
  expect(service.stdin_open).toBe(true);
  expect(service.tty).toBe(true);
  expect(service.attach).toBe(false);
  expect(service.logging).toEqual({ driver: 'none' });
  expect(service.cap_drop).toEqual(['ALL']);
  expect(service.security_opt).toContain('no-new-privileges:true');
  expect(service.restart).toBe('on-failure:3');
  expect(service.user).toBe(user);
  expect(service.depends_on[initService].condition).toBe('service_completed_successfully');
  expect(Object.keys(service.environment).sort()).toEqual([
    'HOME',
    'OWNER_ALPHA_CREDENTIAL_SOCKET',
    'OWNER_ALPHA_READY_FILE',
    'OWNER_ALPHA_STATE_PROFILE',
    'TMPDIR',
    'XDG_CACHE_HOME',
  ]);
  expect(service.environment.CI).toBeUndefined();
  expect(Object.keys(service.environment).join('\n')).not.toMatch(/TOKEN|PASSWORD|SECRET|AUTHORIZATION/iu);

  const mounts = new Map(service.volumes.map((mount) => [mount.target, mount]));
  expect([...mounts.keys()].sort()).toEqual([
    '/config/owner-alpha.local.json',
    '/opt/cyberbaser/.workspace',
    '/run/owner-alpha-credentials',
    '/vault',
  ]);
  expect(mounts.get('/vault')).toMatchObject({ type: 'bind' });
  expect(mounts.get('/vault').read_only ?? false).toBe(false);
  expect(mounts.get('/config/owner-alpha.local.json')).toMatchObject({ type: 'bind', read_only: true });
  expect(mounts.get('/run/owner-alpha-credentials')).toMatchObject({ type: 'bind', read_only: true });
  expect(mounts.get('/opt/cyberbaser/.workspace')).toMatchObject({ type: 'volume' });
  expect(service.volumes.filter((mount) => mount.type === 'bind' && !mount.read_only).map((mount) => mount.target)).toEqual(['/vault']);
  expect(service.tmpfs.some((mount) => mount.startsWith('/run/owner-alpha:') && mount.includes('noexec'))).toBe(true);
  expect(service.tmpfs.some((mount) => mount.startsWith('/tmp:') && mount.includes('exec'))).toBe(true);
  expect(service.healthcheck.test).toEqual([
    'CMD',
    'bun',
    '/opt/cyberbaser/deploy/owner-alpha/healthcheck.js',
  ]);
}

afterEach(async () => {
  await Promise.all(cleanupServers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  await Promise.all(cleanup.splice(0).map((target) => rm(target, { recursive: true, force: true })));
});

describe('Compose operator contract', () => {
  test('expands the rootless profile with host networking, hardened mounts, and no retained logs', () => {
    const model = composeConfig('rootless');
    expect(Object.keys(model.services).sort()).toEqual([
      'owner-alpha-rootless',
      'owner-alpha-state-init-rootless',
    ]);
    expectRuntimeContract(model.services['owner-alpha-rootless'], {
      user: '0:0',
      initService: 'owner-alpha-state-init-rootless',
    });
    const init = model.services['owner-alpha-state-init-rootless'];
    expect(init.network_mode).toBe('none');
    expect(init.user).toBe('0:0');
    expect(init.logging).toEqual({ driver: 'none' });
    expect(init.volumes.map((mount) => mount.target)).toEqual(['/opt/cyberbaser/.workspace']);
    expect(init.environment).toMatchObject({ OWNER_ALPHA_RUNTIME_UID: '0', OWNER_ALPHA_RUNTIME_GID: '0' });
  });

  test('expands the rootful profile with the exact vault-owner identity and a networkless one-shot initializer', async () => {
    const root = await tempRoot('owner-alpha-rootful-env-');
    const envFile = path.join(root, 'operator.env');
    const example = await readFile(ENV_EXAMPLE, 'utf8');
    await writeFile(envFile, example
      .replace('OWNER_ALPHA_PROFILE=rootless', 'OWNER_ALPHA_PROFILE=rootful')
      .replace('OWNER_ALPHA_STATE_VOLUME=cyberbaser-owner-alpha-state-rootless', 'OWNER_ALPHA_STATE_VOLUME=cyberbaser-owner-alpha-state-rootful')
      .replace('OWNER_ALPHA_STATE_PROFILE=rootless-v1', 'OWNER_ALPHA_STATE_PROFILE=rootful-1000-1000-v1'));
    const model = composeConfig('rootful', envFile);
    expect(Object.keys(model.services).sort()).toEqual([
      'owner-alpha-rootful',
      'owner-alpha-state-init-rootful',
    ]);
    expectRuntimeContract(model.services['owner-alpha-rootful'], {
      user: '1000:1000',
      initService: 'owner-alpha-state-init-rootful',
    });
    const init = model.services['owner-alpha-state-init-rootful'];
    expect(init.network_mode).toBe('none');
    expect(init.user).toBe('0:0');
    expect(init.cap_drop).toEqual(['ALL']);
    expect(init.cap_add).toEqual(['CHOWN']);
    expect(init.volumes.map((mount) => mount.target)).toEqual(['/opt/cyberbaser/.workspace']);
    expect(init.environment).toMatchObject({ OWNER_ALPHA_RUNTIME_UID: '1000', OWNER_ALPHA_RUNTIME_GID: '1000' });
  });

  test('forbids bridge publishing, broad host access, mutable builds, and transport coupling', async () => {
    const compose = await text('deploy/owner-alpha/compose.yaml');
    const envExample = await text('deploy/owner-alpha/operator.env.example');
    const allOperatorFiles = `${compose}\n${envExample}\n${await text('deploy/owner-alpha/owner-alpha-compose.sh')}`;

    expect(compose).toContain('network_mode: host');
    expect(compose).not.toMatch(/^\s*ports:/mu);
    expect(compose).not.toMatch(/^\s*build:/mu);
    expect(compose).not.toMatch(/privileged:|pid:\s*host|ipc:\s*host|docker\.sock/iu);
    expect(compose).not.toMatch(/0\.0\.0\.0|\[?::\]?/u);
    expect(allOperatorFiles).not.toMatch(/tailscale/iu);
    expect(allOperatorFiles).not.toMatch(/SSH_AUTH_SOCK|\.ssh\/|id_(?:rsa|ed25519)/u);
    expect(envExample).not.toMatch(/^(?:[A-Z0-9_]*(?:TOKEN|PASSWORD|SECRET|AUTHORIZATION)[A-Z0-9_]*)=/mu);
    expect(envExample).toMatch(/OWNER_ALPHA_IMAGE=.*@sha256:[a-f0-9]{64}/u);
  });
});

describe('operator configuration examples', () => {
  test('keeps the container config credential-free and bound to /vault on one exact numeric private address', async () => {
    const config = JSON.parse(await text('deploy/owner-alpha/owner-alpha.container.example.json'));
    expect(config.repository.checkout).toBe('/vault');
    expect(config.listen.host).toMatch(/^(?:127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2[0-9]|3[01])(?:\.\d{1,3}){2})$/u);
    expect(config.listen.port).toBe(4317);
    expect(config.workspace).toEqual({
      root: '.workspace/owner-alpha',
      store: '.workspace/owner-alpha/store',
      site: '.workspace/owner-alpha/site',
      cache: '.workspace/owner-alpha/cache',
    });
    expect(JSON.stringify(config)).not.toMatch(/password|token|secret|authorization|credential/iu);
  });
});

describe('management and systemd surfaces', () => {
  test('uses detached lifecycle commands and reserves attachment for explicit bootstrap output', async () => {
    const manager = await text('deploy/owner-alpha/owner-alpha-compose.sh');
    expect(manager).toContain('config --quiet');
    expect(manager).toContain('up --detach --no-build --pull never --wait');
    expect(manager).toContain('up --detach --no-build --pull never --force-recreate --wait');
    expect(manager).toContain('attach --sig-proxy=false');
    expect(manager).not.toMatch(/\bdocker\s+logs\b/u);
    expect(manager).not.toMatch(/(?:^|\s)(?:source|\.)\s+["$]/mu);

    const fixture = await managerFixture();
    const started = run(['bash', MANAGER, 'start'], { env: fixture.env });
    expect(started.exitCode, failure(started)).toBe(0);
    const startLog = await readFile(fixture.log, 'utf8');
    expect(startLog).toContain('ARG=--profile\nARG=rootless');
    expect(startLog).toContain('ARG=config\nARG=--quiet');
    expect(startLog).toContain('ARG=up\nARG=--detach\nARG=--no-build\nARG=--pull\nARG=never\nARG=--wait\nARG=owner-alpha-rootless');

    await writeFile(fixture.log, '');
    const bootstrapped = run(['bash', MANAGER, 'bootstrap'], { env: fixture.env });
    expect(bootstrapped.exitCode, failure(bootstrapped)).toBe(0);
    expect(bootstrapped.stderr.toString()).toContain('Enter b and press Enter');
    expect(await readFile(fixture.log, 'utf8')).toContain('ARG=attach\nARG=--sig-proxy=false\nARG=owner-alpha-rootless');

    const mismatch = run(['bash', MANAGER, 'validate'], {
      env: { ...fixture.env, OWNER_ALPHA_EXPECTED_PROFILE: 'rootful' },
    });
    expect(mismatch.exitCode).toBe(1);
    expect(mismatch.stderr.toString()).toContain('selected profile does not match');
  });

  test('rejects profile/daemon mismatch, remote engine overrides, symlinked binds, and env-file injection', async () => {
    const fixture = await managerFixture();

    const wrongDaemon = run(['bash', MANAGER, 'validate'], {
      env: { ...fixture.env, FAKE_DOCKER_ROOTLESS: '0' },
    });
    expect(wrongDaemon.exitCode).toBe(1);
    expect(wrongDaemon.stderr.toString()).toContain('rootless profile requires a rootless Docker daemon');

    const remoteEngine = run(['bash', MANAGER, 'validate'], {
      env: { ...fixture.env, DOCKER_HOST: 'tcp://example.invalid:2376' },
    });
    expect(remoteEngine.exitCode).toBe(1);
    expect(remoteEngine.stderr.toString()).toContain('DOCKER_HOST must not override');

    await writeFile(fixture.log, '');
    const remoteContextBootstrap = run(['bash', MANAGER, 'bootstrap'], {
      env: { ...fixture.env, FAKE_DOCKER_ENDPOINT: 'tcp://example.invalid:2376' },
    });
    expect(remoteContextBootstrap.exitCode).toBe(1);
    expect(remoteContextBootstrap.stderr.toString()).toContain('local Unix-socket engine endpoint');
    expect(await readFile(fixture.log, 'utf8')).not.toContain('ARG=attach');

    const ambientOverride = run(['bash', MANAGER, 'validate'], {
      env: { ...fixture.env, OWNER_ALPHA_VAULT_PATH: '/tmp/ambient-override' },
    });
    expect(ambientOverride.exitCode).toBe(1);
    expect(ambientOverride.stderr.toString()).toContain('OWNER_ALPHA_VAULT_PATH must be defined only');

    const realVault = path.join(fixture.root, 'real-vault');
    const linkedVault = path.join(fixture.root, 'linked-vault');
    await mkdir(realVault, { mode: 0o700 });
    await symlink(realVault, linkedVault);
    const originalEnv = await readFile(fixture.envFile, 'utf8');
    await writeFile(fixture.envFile, originalEnv.replace(
      `OWNER_ALPHA_VAULT_PATH=${fixture.vault}`,
      `OWNER_ALPHA_VAULT_PATH=${linkedVault}`,
    ), { mode: 0o600 });
    await chmod(fixture.envFile, 0o600);
    const symlinked = run(['bash', MANAGER, 'validate'], { env: fixture.env });
    expect(symlinked.exitCode).toBe(1);
    expect(symlinked.stderr.toString()).toMatch(/vault path must (?:be one real directory|not use symlink aliases)/u);

    await writeFile(fixture.envFile, `${originalEnv}DOCKER_CONTEXT=attacker\n`, { mode: 0o600 });
    await chmod(fixture.envFile, 0o600);
    const injected = run(['bash', MANAGER, 'validate'], { env: fixture.env });
    expect(injected.exitCode).toBe(1);
    expect(injected.stderr.toString()).toContain('unsupported key DOCKER_CONTEXT');
  });

  test('validates both systemd examples and never attaches container output to journald', async () => {
    const userUnit = await text('deploy/owner-alpha/systemd/user/cyberbaser-owner-alpha.service');
    const systemUnit = await text('deploy/owner-alpha/systemd/system/cyberbaser-owner-alpha.service');
    expect(userUnit).toContain('OWNER_ALPHA_EXPECTED_PROFILE=rootless');
    expect(systemUnit).toContain('OWNER_ALPHA_EXPECTED_PROFILE=rootful');
    for (const unit of [userUnit, systemUnit]) {
      expect(unit).toContain('Type=oneshot');
      expect(unit).toContain('RemainAfterExit=yes');
      expect(unit).toContain('StandardInput=null');
      expect(unit).toContain('owner-alpha-compose.sh start');
      expect(unit).toContain('owner-alpha-compose.sh restart');
      expect(unit).toContain('owner-alpha-compose.sh stop');
      expect(unit).not.toMatch(/docker\s+compose\s+(?:attach|logs)|journalctl/iu);
    }

    const root = await tempRoot('owner-alpha-systemd-');
    const userFile = path.join(root, 'cyberbaser-owner-alpha-user.service');
    const systemFile = path.join(root, 'cyberbaser-owner-alpha-system.service');
    await writeFile(userFile, userUnit, { mode: 0o644 });
    await writeFile(systemFile, systemUnit, { mode: 0o644 });
    const verified = run(['systemd-analyze', 'verify', userFile, systemFile]);
    expect(verified.exitCode, failure(verified)).toBe(0);
  });
});

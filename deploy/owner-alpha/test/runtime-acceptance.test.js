import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { createServer } from 'node:net';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '../../..');
const IMAGE = process.env.OWNER_ALPHA_CONTAINER_IMAGE ?? '';
const imageTest = IMAGE === '' ? test.skip : test;

function dockerDaemonIsRootless() {
  if (IMAGE === '') return false;
  const result = Bun.spawnSync({
    cmd: ['docker', 'info', '--format', '{{json .SecurityOptions}}'],
    stdout: 'pipe',
    stderr: 'ignore',
  });
  return result.exitCode === 0 && result.stdout.toString().includes('name=rootless');
}

const ROOTLESS_DAEMON = dockerDaemonIsRootless();
const RUNTIME_UID = ROOTLESS_DAEMON ? 0 : (process.getuid?.() ?? 0);
const RUNTIME_GID = ROOTLESS_DAEMON ? 0 : (process.getgid?.() ?? 0);
const rootlessImageTest = IMAGE !== '' && ROOTLESS_DAEMON ? test : test.skip;
const rootfulImageTest = IMAGE !== ''
  && !ROOTLESS_DAEMON
  && typeof process.getuid === 'function'
  && process.getuid() > 0
  ? test
  : test.skip;
const cleanupPaths = [];
const cleanupContainers = new Set();
const cleanupVolumes = new Set();

function run(command, { cwd = ROOT, env = process.env, input, expected = 0 } = {}) {
  const result = Bun.spawnSync({
    cmd: command,
    cwd,
    env,
    stdin: input === undefined ? 'ignore' : Buffer.from(input),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const output = `${result.stdout.toString()}${result.stderr.toString()}`;
  expect(result.exitCode, output).toBe(expected);
  return { ...result, output };
}

function docker(args, options) {
  return run(['docker', ...args], options);
}

async function tempRoot(prefix) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanupPaths.push(root);
  return root;
}

function unique(prefix) {
  return `${prefix}-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

async function git(cwd, args) {
  return run(['git', '-C', cwd, ...args]).stdout.toString().trim();
}

async function availablePortPair() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const first = createServer();
    await new Promise((resolve, reject) => first.listen(0, '127.0.0.1', resolve).once('error', reject));
    const port = first.address().port;
    await new Promise((resolve) => first.close(resolve));
    if (port >= 65535) continue;
    const second = createServer();
    try {
      await new Promise((resolve, reject) => second.listen(port + 1, '127.0.0.1', resolve).once('error', reject));
      await new Promise((resolve) => second.close(resolve));
      return port;
    } catch {
      second.close();
    }
  }
  throw new Error('could not reserve an adjacent loopback port pair');
}

function request(port, pathname, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method,
      headers: { Host: `127.0.0.1:${port}`, ...headers },
      agent: false,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.once('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.once('error', reject);
    req.setTimeout(5_000, () => req.destroy(new Error('HTTP fixture timeout')));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function waitForHealth(container, expected = 'healthy') {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const inspected = docker(['inspect', '--format', '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}', container]);
    const status = inspected.stdout.toString().trim();
    if (status === expected) return;
    if (['unhealthy', 'exited', 'dead'].includes(status)) throw new Error(`container entered ${status}`);
    await Bun.sleep(250);
  }
  throw new Error(`container did not become ${expected}`);
}

async function attachAndIssue(container) {
  const child = Bun.spawn([
    'script', '-qefc', `docker attach --sig-proxy=false ${container}`, '/dev/null',
  ], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  await Bun.sleep(150);
  child.stdin.write('b\n');
  await child.stdin.flush();
  const reader = child.stdout.getReader();
  const deadline = Date.now() + 10_000;
  let output = '';
  try {
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const item = await Promise.race([
        reader.read(),
        Bun.sleep(Math.min(remaining, 250)).then(() => null),
      ]);
      if (item === null) continue;
      if (item.done) break;
      output += Buffer.from(item.value).toString('utf8');
      const match = output.match(/Owner alpha bootstrap: http:\/\/127\.0\.0\.1:\d+\/owner\/bootstrap\?token=([A-Za-z0-9_-]{43})/u);
      if (match) return match[1];
    }
    throw new Error(`bootstrap capability was not emitted through the attachment: ${output}`);
  } finally {
    reader.releaseLock();
    child.kill();
    await child.exited;
  }
}

async function initializeVolume(volume, profile, uid = 0, gid = 0) {
  docker(['volume', 'create', volume]);
  cleanupVolumes.add(volume);
  const capability = uid === 0 && gid === 0 ? [] : ['--cap-add', 'CHOWN'];
  docker([
    'run', '--rm',
    '--user', '0:0',
    '--network', 'none',
    '--read-only',
    '--cap-drop', 'ALL',
    ...capability,
    '--security-opt', 'no-new-privileges',
    '--mount', `type=volume,source=${volume},target=/opt/cyberbaser/.workspace,volume-nocopy`,
    '--env', `OWNER_ALPHA_STATE_PROFILE=${profile}`,
    '--env', `OWNER_ALPHA_RUNTIME_UID=${uid}`,
    '--env', `OWNER_ALPHA_RUNTIME_GID=${gid}`,
    '--entrypoint', '/usr/local/bin/owner-alpha-state-init',
    IMAGE,
    'init',
  ]);
}

async function startFixtureContainer({ name, volume, vault, config, script, port }) {
  cleanupContainers.add(name);
  docker([
    'run', '--detach', '--tty', '--interactive',
    '--name', name,
    '--user', `${RUNTIME_UID}:${RUNTIME_GID}`,
    '--network', 'host',
    '--read-only',
    '--log-driver', 'none',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--mount', `type=bind,source=${vault},target=/vault`,
    '--mount', `type=bind,source=${config},target=/config/owner-alpha.local.json,readonly`,
    '--mount', `type=bind,source=${script},target=/tmp/owner-alpha-runtime-fixture.js,readonly`,
    '--mount', `type=volume,source=${volume},target=/opt/cyberbaser/.workspace,volume-nocopy`,
    '--tmpfs', `/run/owner-alpha:rw,nosuid,nodev,noexec,mode=0700,uid=${RUNTIME_UID},gid=${RUNTIME_GID},size=16m`,
    '--tmpfs', `/tmp:rw,nosuid,nodev,exec,mode=0700,uid=${RUNTIME_UID},gid=${RUNTIME_GID},size=64m`,
    '--env', 'HOME=/opt/cyberbaser/.workspace/owner-alpha/home',
    '--env', 'XDG_CACHE_HOME=/opt/cyberbaser/.workspace/owner-alpha/cache/xdg',
    '--env', 'TMPDIR=/tmp',
    '--env', 'OWNER_ALPHA_READY_FILE=/run/owner-alpha/ready',
    '--health-cmd', 'bun /opt/cyberbaser/deploy/owner-alpha/healthcheck.js',
    '--health-interval', '1s',
    '--health-timeout', '2s',
    '--health-retries', '20',
    '--health-start-period', '1s',
    '--entrypoint', 'bun',
    IMAGE,
    '/tmp/owner-alpha-runtime-fixture.js',
    '/config/owner-alpha.local.json',
  ]);
  await waitForHealth(name);
  const reader = await request(port + 1, '/cyberbase/');
  expect(reader.status).toBe(200);
}

afterEach(async () => {
  for (const container of cleanupContainers) {
    Bun.spawnSync({ cmd: ['docker', 'rm', '--force', container], stdout: 'ignore', stderr: 'ignore' });
  }
  cleanupContainers.clear();
  for (const volume of cleanupVolumes) {
    Bun.spawnSync({ cmd: ['docker', 'volume', 'rm', '--force', volume], stdout: 'ignore', stderr: 'ignore' });
  }
  cleanupVolumes.clear();
  await Promise.all(cleanupPaths.splice(0).map((target) => rm(target, { recursive: true, force: true })));
});

afterAll(() => {
  if (IMAGE !== '') expect(IMAGE).toMatch(/^sha256:[a-f0-9]{64}$/u);
});

describe('WP2 local image content', () => {
  imageTest('contains only the pinned runtime, inert application Git metadata, and verified Quartz seed', () => {
    const metadata = docker(['image', 'inspect', '--format', '{{.Id}}|{{.Os}}|{{.Architecture}}|{{.Config.User}}|{{json .Config.Entrypoint}}|{{json .Config.Healthcheck.Test}}', IMAGE]);
    const [id, platform, architecture, user, entrypoint, health] = metadata.stdout.toString().trim().split('|');
    expect(id).toBe(IMAGE);
    expect(platform).toBe('linux');
    expect(architecture).toBe('amd64');
    expect(user).toBe('65532:65532');
    expect(JSON.parse(entrypoint)).toEqual(['/usr/local/bin/owner-alpha-entrypoint']);
    expect(JSON.parse(health)).toEqual(['CMD', 'bun', '/opt/cyberbaser/deploy/owner-alpha/healthcheck.js']);

    const script = String.raw`
set -euo pipefail
test "$(bun --version)" = 1.3.11
test "$(node --version)" = v22.23.2
npm --version >/dev/null
for command in git bash rsync flock sha256sum find stat realpath; do command -v "$command" >/dev/null; done
for package in correction linkcheck ofm projection publish trust; do test -d "/opt/cyberbaser/packages/$package"; done
test -d /opt/cyberbaser/renderers/quartz-cyberbase
test -z "$(git -C /opt/cyberbaser remote)"
test -z "$(git -C /opt/cyberbaser rev-list --all)"
test "$(git -C /opt/cyberbaser/vendor/quartz remote get-url origin)" = https://github.com/jackyzha0/quartz.git
test "$(git -C /opt/cyberbaser/vendor/quartz describe --tags --exact-match)" = v4.5.2
test "$(git -C /opt/cyberbaser/vendor/quartz rev-parse HEAD)" = 4923affa7722dfc751f1074348e6dad214fe0c08
test "$(sha256sum /opt/cyberbaser/vendor/quartz/package-lock.json | cut -d' ' -f1)" = 9ea5873a2bb495054f23b16f96d1d41f44348863e655f4c6d86b107f372b09b9
test "$(< /opt/cyberbaser/vendor/quartz/node_modules/.cyberbaser-install-sha256)" = 38bc51071b55a4444abdea3e0620747882e2be3a8610da5715a9c0b40b320850
test "$(git config --system --get credential.useHttpPath)" = true
test "$(git config --system --get-all credential.helper | tail -n 1)" = owner-alpha-socket
test "$(command -v git)" = /usr/local/bin/git
mkdir /tmp/helper-repo
git -C /tmp/helper-repo init -q
git -C /tmp/helper-repo config --local credential.helper ''
git -C /tmp/helper-repo config --local --add credential.helper '!f() { touch /tmp/local-helper-ran; printf "username=attacker\npassword=attacker\n"; }; f'
if printf 'protocol=https\nhost=github.com\npath=cybersader/cyberbase.git\n\n' | git -C /tmp/helper-repo credential fill >/dev/null 2>&1; then
  printf '%s\n' 'local credential helper bypassed the image policy' >&2
  exit 1
fi
test ! -e /tmp/local-helper-ran
test "$(find /opt/cyberbaser -type d -name .git | wc -l)" = 2
test -z "$(find /opt/cyberbaser -type f \( -name '*.local.json' -o -name '.env' -o -name '.env.*' \) -print -quit)"
test -z "$(find / -xdev -type f -perm /6000 -print -quit)"
test -z "$(find /vault /config /opt/cyberbaser/.workspace -mindepth 1 -print -quit)"
`;
    docker([
      'run', '--rm',
      '--tmpfs', '/tmp:rw,nosuid,nodev,exec,mode=0700,uid=65532,gid=65532,size=16m',
      '--entrypoint', 'bash', IMAGE, '-c', script,
    ]);
  });

  imageTest('materializes Quartz offline and fails closed on every seed identity mismatch', () => {
    const script = String.raw`
set -euo pipefail
setup=/opt/cyberbaser/renderers/quartz-cyberbase/setup.sh
seed=/opt/cyberbaser/vendor/quartz
expect_failure() {
  target="$1"
  shift
  rm -rf "$target"
  if env QUARTZ_OFFLINE=1 QUARTZ_SEED_DIR="$seed" "$@" bash "$setup" "$target" >/tmp/setup.out 2>/tmp/setup.err; then
    echo 'mismatched Quartz seed unexpectedly passed' >&2
    exit 1
  fi
}
expect_failure /tmp/bad-origin QUARTZ_REPO=https://github.com/example/not-quartz.git
expect_failure /tmp/bad-tag QUARTZ_REF=v0.0.0
expect_failure /tmp/bad-commit QUARTZ_COMMIT=0000000000000000000000000000000000000000
expect_failure /tmp/bad-lock QUARTZ_LOCK_SHA256=0000000000000000000000000000000000000000000000000000000000000000
expect_failure /tmp/bad-install QUARTZ_INSTALL_SHA256=0000000000000000000000000000000000000000000000000000000000000000
rm -rf /tmp/quartz
QUARTZ_OFFLINE=1 QUARTZ_SEED_DIR="$seed" bash "$setup" /tmp/quartz >/tmp/setup.out 2>/tmp/setup.err
test "$(git -C /tmp/quartz rev-parse HEAD)" = 4923affa7722dfc751f1074348e6dad214fe0c08
test "$(< /tmp/quartz/node_modules/.cyberbaser-install-sha256)" = 38bc51071b55a4444abdea3e0620747882e2be3a8610da5715a9c0b40b320850
`;
    docker([
      'run', '--rm', '--user', '0:0', '--network', 'none', '--read-only',
      '--tmpfs', '/tmp:rw,nosuid,nodev,exec,mode=0700,size=2g',
      '--entrypoint', 'bash', IMAGE, '-c', script,
    ]);
  }, 120_000);
});

describe('WP2 container identity and state volume', () => {
  rootlessImageTest('maps rootless container zero to the host owner and rejects an unrelated numeric identity', async () => {
    const root = await tempRoot('owner-alpha-rootless-');
    const vault = path.join(root, 'vault');
    await mkdir(vault, { mode: 0o700 });
    await chmod(vault, 0o700);
    const before = await stat(vault);

    docker([
      'run', '--rm', '--user', '0:0', '--read-only', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '--mount', `type=bind,source=${vault},target=/vault`,
      '--entrypoint', 'bash', IMAGE, '-c',
      'set -euo pipefail; test "$(id -u):$(id -g)" = 0:0; printf rootless > /vault/rootless-write',
    ]);
    const written = await lstat(path.join(vault, 'rootless-write'));
    expect(written.uid).toBe(process.getuid());
    expect(written.gid).toBe(process.getgid());

    const denied = Bun.spawnSync({
      cmd: [
        'docker', 'run', '--rm', '--user', '65532:65532', '--read-only', '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges',
        '--mount', `type=bind,source=${vault},target=/vault`,
        '--entrypoint', 'bash', IMAGE, '-c', 'printf denied > /vault/denied',
      ],
      stdout: 'pipe', stderr: 'pipe',
    });
    expect(denied.exitCode).not.toBe(0);
    await expect(lstat(path.join(vault, 'denied'))).rejects.toMatchObject({ code: 'ENOENT' });
    const after = await stat(vault);
    expect({ uid: after.uid, gid: after.gid, mode: after.mode & 0o777 })
      .toEqual({ uid: before.uid, gid: before.gid, mode: before.mode & 0o777 });
  });

  rootfulImageTest('runs the main process as the exact nonzero vault owner and rejects a different UID', async () => {
    const root = await tempRoot('owner-alpha-rootful-vault-');
    const vault = path.join(root, 'vault');
    const uid = process.getuid();
    const gid = process.getgid();
    await mkdir(vault, { mode: 0o700 });
    await chmod(vault, 0o700);
    const before = await stat(vault);

    docker([
      'run', '--rm', `--user=${uid}:${gid}`, '--read-only', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '--mount', `type=bind,source=${vault},target=/vault`,
      '--entrypoint', 'bash', IMAGE, '-c',
      `set -euo pipefail; test "$(id -u):$(id -g)" = ${uid}:${gid}; printf rootful > /vault/rootful-write`,
    ]);
    const written = await lstat(path.join(vault, 'rootful-write'));
    expect(written.uid).toBe(uid);
    expect(written.gid).toBe(gid);

    const denied = Bun.spawnSync({
      cmd: [
        'docker', 'run', '--rm', `--user=${uid + 1}:${gid}`, '--read-only', '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges',
        '--mount', `type=bind,source=${vault},target=/vault`,
        '--entrypoint', 'bash', IMAGE, '-c', 'printf denied > /vault/denied',
      ],
      stdout: 'pipe', stderr: 'pipe',
    });
    expect(denied.exitCode).not.toBe(0);
    await expect(lstat(path.join(vault, 'denied'))).rejects.toMatchObject({ code: 'ENOENT' });
    const after = await stat(vault);
    expect({ uid: after.uid, gid: after.gid, mode: after.mode & 0o777 })
      .toEqual({ uid: before.uid, gid: before.gid, mode: before.mode & 0o777 });
  });

  imageTest('enforces the TTY and exact mount contract before executing the server', async () => {
    const noTty = Bun.spawnSync({
      cmd: ['docker', 'run', '--rm', IMAGE],
      stdout: 'pipe', stderr: 'pipe',
    });
    expect(noTty.exitCode).not.toBe(0);
    expect(noTty.stderr.toString()).toContain('stdin and stdout must be attached to a TTY');

    const root = await tempRoot('owner-alpha-entrypoint-');
    const vault = path.join(root, 'vault');
    const configFile = path.join(root, 'owner-alpha.local.json');
    const credentials = path.join(root, 'credentials');
    const socketPath = path.join(credentials, 'helper.sock');
    await mkdir(vault, { mode: 0o700 });
    await mkdir(credentials, { mode: 0o700 });
    await git(vault, ['init', '-q', '--initial-branch=main']);
    await writeFile(path.join(vault, 'page.md'), '# Entrypoint fixture\n');
    await git(vault, ['add', '--', 'page.md']);
    run(['git', '-C', vault, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', 'fixture base']);
    const config = JSON.parse(await readFile(path.join(ROOT, 'deploy/owner-alpha/owner-alpha.container.example.json'), 'utf8'));
    config.listen.port = await availablePortPair();
    await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await chmod(configFile, 0o600);

    const broker = createServer((socket) => socket.end('username=fake\npassword=fake\n\n'));
    await new Promise((resolve, reject) => broker.listen(socketPath, resolve).once('error', reject));
    const volume = unique('owner-alpha-entrypoint-state');
    const profile = `${ROOTLESS_DAEMON ? 'rootless' : 'rootful'}-entrypoint-v1`;
    initializeVolume(volume, profile, RUNTIME_UID, RUNTIME_GID);
    const dockerArgs = [
      'docker', 'run', '--rm', '--interactive', '--tty',
      '--user', `${RUNTIME_UID}:${RUNTIME_GID}`, '--network', 'host', '--read-only', '--log-driver', 'none',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--mount', `type=bind,source=${vault},target=/vault`,
      '--mount', `type=bind,source=${configFile},target=/config/owner-alpha.local.json,readonly`,
      '--mount', `type=bind,source=${credentials},target=/run/owner-alpha-credentials,readonly`,
      '--mount', `type=volume,source=${volume},target=/opt/cyberbaser/.workspace,volume-nocopy`,
      '--tmpfs', `/run/owner-alpha:rw,nosuid,nodev,noexec,mode=0700,uid=${RUNTIME_UID},gid=${RUNTIME_GID},size=16m`,
      '--tmpfs', `/tmp:rw,nosuid,nodev,exec,mode=0700,uid=${RUNTIME_UID},gid=${RUNTIME_GID},size=2g`,
      '--env', 'HOME=/opt/cyberbaser/.workspace/owner-alpha/home',
      '--env', 'XDG_CACHE_HOME=/opt/cyberbaser/.workspace/owner-alpha/cache/xdg',
      '--env', 'TMPDIR=/tmp',
      '--env', 'OWNER_ALPHA_READY_FILE=/run/owner-alpha/ready',
      '--env', 'OWNER_ALPHA_CREDENTIAL_SOCKET=/run/owner-alpha-credentials/helper.sock',
      '--env', `OWNER_ALPHA_STATE_PROFILE=${profile}`,
      IMAGE,
    ];
    const command = dockerArgs.map(shellQuote).join(' ');
    try {
      const mounted = run(['script', '-qefc', command, '/dev/null'], { expected: 1 });
      expect(mounted.output).toContain('vault Git author name is missing');
      expect(mounted.output).not.toMatch(/dedicated mount|must use tmpfs|must be read-only|ownership mismatch|socket is missing/u);

      await writeFile(path.join(credentials, 'unexpected-file'), 'must not be mounted\n', { mode: 0o600 });
      const broadCredentials = run(['script', '-qefc', command, '/dev/null'], { expected: 1 });
      expect(broadCredentials.output).toContain('credential socket directory must contain only helper.sock');
      await rm(path.join(credentials, 'unexpected-file'));
    } finally {
      await new Promise((resolve) => broker.close(resolve));
    }
  });

  imageTest('initializes a profile-bound volume once and rejects ownership, profile, and symlink substitutions', () => {
    const foreignVolume = unique('owner-alpha-state-foreign');
    docker(['volume', 'create', foreignVolume]);
    cleanupVolumes.add(foreignVolume);
    docker([
      'run', '--rm', '--user', '0:0', '--network', 'none',
      '--mount', `type=volume,source=${foreignVolume},target=/opt/cyberbaser/.workspace,volume-nocopy`,
      '--entrypoint', 'bash', IMAGE, '-c', 'printf preserve-me > /opt/cyberbaser/.workspace/foreign-file',
    ]);
    const foreignInit = Bun.spawnSync({
      cmd: [
        'docker', 'run', '--rm', '--user', '0:0', '--network', 'none', '--read-only',
        '--cap-drop', 'ALL', '--cap-add', 'CHOWN', '--security-opt', 'no-new-privileges',
        '--mount', `type=volume,source=${foreignVolume},target=/opt/cyberbaser/.workspace,volume-nocopy`,
        '--env', 'OWNER_ALPHA_STATE_PROFILE=foreign-v1',
        '--env', 'OWNER_ALPHA_RUNTIME_UID=0', '--env', 'OWNER_ALPHA_RUNTIME_GID=0',
        '--entrypoint', '/usr/local/bin/owner-alpha-state-init', IMAGE, 'init',
      ], stdout: 'pipe', stderr: 'pipe',
    });
    expect(foreignInit.exitCode).not.toBe(0);
    expect(foreignInit.stderr.toString()).toContain('unmarked non-empty');
    docker([
      'run', '--rm', '--user', '0:0', '--network', 'none', '--read-only',
      '--mount', `type=volume,source=${foreignVolume},target=/opt/cyberbaser/.workspace,volume-nocopy`,
      '--entrypoint', 'bash', IMAGE, '-c',
      'test "$(< /opt/cyberbaser/.workspace/foreign-file)" = preserve-me',
    ]);

    const volume = unique('owner-alpha-state');
    const profile = 'rootless-acceptance-v1';
    initializeVolume(volume, profile, 0, 0);

    docker([
      'run', '--rm', '--user', '0:0', '--network', 'none', '--read-only',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--mount', `type=volume,source=${volume},target=/opt/cyberbaser/.workspace,volume-nocopy`,
      '--env', `OWNER_ALPHA_STATE_PROFILE=${profile}`,
      '--env', 'OWNER_ALPHA_RUNTIME_UID=0', '--env', 'OWNER_ALPHA_RUNTIME_GID=0',
      '--entrypoint', '/usr/local/bin/owner-alpha-state-init', IMAGE, 'verify',
    ]);

    for (const [wrongProfile, wrongUid, wrongGid] of [
      ['other-profile', '0', '0'],
      [profile, '1', '0'],
      [profile, '0', '1'],
    ]) {
      const rejected = Bun.spawnSync({
        cmd: [
          'docker', 'run', '--rm', '--user', '0:0', '--network', 'none', '--read-only',
          '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
          '--mount', `type=volume,source=${volume},target=/opt/cyberbaser/.workspace,volume-nocopy`,
          '--env', `OWNER_ALPHA_STATE_PROFILE=${wrongProfile}`,
          '--env', `OWNER_ALPHA_RUNTIME_UID=${wrongUid}`,
          '--env', `OWNER_ALPHA_RUNTIME_GID=${wrongGid}`,
          '--entrypoint', '/usr/local/bin/owner-alpha-state-init', IMAGE, 'verify',
        ], stdout: 'pipe', stderr: 'pipe',
      });
      expect(rejected.exitCode).not.toBe(0);
    }

    docker([
      'run', '--rm', '--user', '0:0', '--network', 'none',
      '--mount', `type=volume,source=${volume},target=/opt/cyberbaser/.workspace,volume-nocopy`,
      '--entrypoint', 'bash', IMAGE, '-c',
      'rm -rf /opt/cyberbaser/.workspace/owner-alpha/site && ln -s /tmp /opt/cyberbaser/.workspace/owner-alpha/site',
    ]);
    const substituted = Bun.spawnSync({
      cmd: [
        'docker', 'run', '--rm', '--user', '0:0', '--network', 'none', '--read-only',
        '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
        '--mount', `type=volume,source=${volume},target=/opt/cyberbaser/.workspace,volume-nocopy`,
        '--env', `OWNER_ALPHA_STATE_PROFILE=${profile}`,
        '--env', 'OWNER_ALPHA_RUNTIME_UID=0', '--env', 'OWNER_ALPHA_RUNTIME_GID=0',
        '--entrypoint', '/usr/local/bin/owner-alpha-state-init', IMAGE, 'verify',
      ], stdout: 'pipe', stderr: 'pipe',
    });
    expect(substituted.exitCode).not.toBe(0);
    expect(substituted.stderr.toString()).toContain('substituted');
  }, 30_000);

  imageTest('prepares the named volume for an exact nonzero rootful runtime identity', () => {
    const volume = unique('owner-alpha-state-rootful');
    const profile = 'rootful-12345-12346-v1';
    initializeVolume(volume, profile, 12345, 12346);
    docker([
      'run', '--rm', '--user', '0:0', '--network', 'none', '--read-only',
      '--cap-drop', 'ALL', '--cap-add', 'CHOWN', '--security-opt', 'no-new-privileges',
      '--mount', `type=volume,source=${volume},target=/opt/cyberbaser/.workspace,volume-nocopy`,
      '--env', `OWNER_ALPHA_STATE_PROFILE=${profile}`,
      '--env', 'OWNER_ALPHA_RUNTIME_UID=12345', '--env', 'OWNER_ALPHA_RUNTIME_GID=12346',
      '--entrypoint', '/usr/local/bin/owner-alpha-state-init', IMAGE, 'init',
    ]);
    docker([
      'run', '--rm', '--user', '12345:12346', '--network', 'none', '--read-only',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--mount', `type=volume,source=${volume},target=/opt/cyberbaser/.workspace,volume-nocopy`,
      '--env', `OWNER_ALPHA_STATE_PROFILE=${profile}`,
      '--env', 'OWNER_ALPHA_RUNTIME_UID=12345', '--env', 'OWNER_ALPHA_RUNTIME_GID=12346',
      '--entrypoint', 'bash', IMAGE, '-c',
      '/usr/local/bin/owner-alpha-state-init verify && printf owned > /opt/cyberbaser/.workspace/owner-alpha/store/numeric-owner',
    ]);
    const wrongProfile = Bun.spawnSync({
      cmd: [
        'docker', 'run', '--rm', '--user', '12345:12346', '--network', 'none', '--read-only',
        '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
        '--mount', `type=volume,source=${volume},target=/opt/cyberbaser/.workspace,volume-nocopy`,
        '--env', 'OWNER_ALPHA_STATE_PROFILE=wrong-rootful-profile',
        '--env', 'OWNER_ALPHA_RUNTIME_UID=12345', '--env', 'OWNER_ALPHA_RUNTIME_GID=12346',
        '--entrypoint', '/usr/local/bin/owner-alpha-state-init', IMAGE, 'verify',
      ],
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(wrongProfile.exitCode).not.toBe(0);
    expect(wrongProfile.stderr.toString()).toContain('another profile');

    docker([
      'run', '--rm', '--user', '0:0', '--network', 'none', '--read-only',
      '--mount', `type=volume,source=${volume},target=/opt/cyberbaser/.workspace,volume-nocopy`,
      '--entrypoint', 'bash', IMAGE, '-c',
      'test "$(stat -c %u:%g /opt/cyberbaser/.workspace/owner-alpha/store/numeric-owner)" = 12345:12346',
    ]);
  }, 30_000);
});

describe('WP2 process-memory bootstrap and replacement behavior', () => {
  imageTest('uses exact host networking, retains no capability logs, and revokes sessions on replacement', async () => {
    const root = await tempRoot('owner-alpha-image-runtime-');
    const vault = path.join(root, 'vault');
    const configFile = path.join(root, 'owner-alpha.local.json');
    const scriptFile = path.join(root, 'runtime-fixture.js');
    await mkdir(vault, { mode: 0o700 });
    await git(vault, ['init', '-q', '--initial-branch=main']);
    await git(vault, ['config', 'user.name', 'Owner Alpha Container Acceptance']);
    await git(vault, ['config', 'user.email', 'owner-alpha-container@example.invalid']);
    await writeFile(path.join(vault, 'page.md'), '# Fixture\n\nUnchanged vault content.\n');
    await git(vault, ['add', '--', 'page.md']);
    await git(vault, ['commit', '-q', '-m', 'fixture base']);

    const config = JSON.parse(await readFile(path.join(ROOT, 'deploy/owner-alpha/owner-alpha.container.example.json'), 'utf8'));
    const port = await availablePortPair();
    config.listen.port = port;
    await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await chmod(configFile, 0o600);

    await writeFile(scriptFile, `
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadOwnerAlphaConfig } from '/opt/cyberbaser/apps/owner-alpha/src/config.js';
import { startBootstrapConsole, formatBootstrapUrl } from '/opt/cyberbaser/apps/owner-alpha/src/bootstrap-console.js';
import { ACTIVE_CONFIG, stageOwnerAlphaConfig } from '/opt/cyberbaser/deploy/owner-alpha/stage-config.js';
import {
  createOwnerAlphaHandler,
  createReaderHandler,
  startOwnerAlphaServers,
  writeOwnerAlphaReadyMarker,
} from '/opt/cyberbaser/apps/owner-alpha/src/server.js';
await stageOwnerAlphaConfig({ requireContainerContract: true });
const config = await loadOwnerAlphaConfig(ACTIVE_CONFIG);
const siteRoot = '/opt/cyberbaser/.workspace/owner-alpha/site';
await mkdir(siteRoot, { recursive: true });
await writeFile(path.join(siteRoot, 'index.html'), '<!doctype html><h1>Container reader fixture</h1>');
const ownerFetch = createOwnerAlphaHandler({
  config,
  siteRoot,
  createEditSession: async () => ({ source: { text: '# Fixture\\n' } }),
  saveEdit: async ({ jobId }) => ({ jobId, state: 'accepted' }),
  lookupJob: async () => null,
});
const readerFetch = createReaderHandler({ config, siteRoot });
const runtime = startOwnerAlphaServers({ config, ownerFetch, readerFetch });
await writeOwnerAlphaReadyMarker(process.env.OWNER_ALPHA_READY_FILE);
console.log('Owner alpha reader: ' + runtime.readerOrigin + '/cyberbase/');
console.log('Owner alpha bootstrap: ' + formatBootstrapUrl(runtime.ownerOrigin, runtime.bootstrapToken));
const dispose = startBootstrapConsole({ input: process.stdin, output: process.stdout, ownerOrigin: runtime.ownerOrigin, issueBootstrap: runtime.issueBootstrap });
const stop = async () => { dispose(); runtime.stop(true); await rm(process.env.OWNER_ALPHA_READY_FILE, { force: true }); process.exit(0); };
process.once('SIGTERM', () => { void stop(); });
process.once('SIGINT', () => { void stop(); });
await new Promise(() => {});
`, { mode: 0o600 });

    const volume = unique('owner-alpha-runtime-state');
    const profile = `${ROOTLESS_DAEMON ? 'rootless' : 'rootful'}-runtime-v1`;
    initializeVolume(volume, profile, RUNTIME_UID, RUNTIME_GID);
    docker([
      'run', '--rm', '--user', `${RUNTIME_UID}:${RUNTIME_GID}`, '--network', 'none', '--read-only',
      '--mount', `type=volume,source=${volume},target=/opt/cyberbaser/.workspace,volume-nocopy`,
      '--entrypoint', 'bash', IMAGE, '-c',
      "printf durable-jobs-survive > /opt/cyberbaser/.workspace/owner-alpha/store/replacement-marker",
    ]);

    const firstContainer = unique('owner-alpha-runtime');
    await startFixtureContainer({ name: firstContainer, volume, vault, config: configFile, script: scriptFile, port });
    const listeners = docker(['exec', firstContainer, 'ss', '-ltnH']).stdout.toString();
    expect(listeners).toContain(`127.0.0.1:${port}`);
    expect(listeners).toContain(`127.0.0.1:${port + 1}`);
    expect(listeners).not.toMatch(new RegExp(`(?:0\\.0\\.0\\.0|\\[::\\]|\\*):(?:${port}|${port + 1})`, 'u'));
    const staleCapability = await attachAndIssue(firstContainer);
    const liveCapability = await attachAndIssue(firstContainer);
    expect(staleCapability).not.toBe(liveCapability);

    const stale = await request(port, `/owner/bootstrap?token=${staleCapability}`);
    expect(stale.status).toBe(403);
    const bootstrapped = await request(port, `/owner/bootstrap?token=${liveCapability}`);
    expect(bootstrapped.status).toBe(303);
    const cookie = bootstrapped.headers['set-cookie'][0].split(';', 1)[0];
    const validSession = await request(port, '/api/jobs/missing', { headers: { Cookie: cookie } });
    expect(validSession.status).toBe(404);
    const badHost = await request(port, '/api/jobs/missing', { headers: { Host: `localhost:${port}`, Cookie: cookie } });
    expect(badHost.status).toBe(421);
    const badOrigin = await request(port, '/api/edits', {
      method: 'POST',
      headers: { Cookie: cookie, Origin: `http://localhost:${port}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(badOrigin.status).toBe(403);
    const readerOwnerRoute = await request(port + 1, '/owner/bootstrap?token=x');
    expect(readerOwnerRoute.status).toBe(404);

    const logs = Bun.spawnSync({ cmd: ['docker', 'logs', firstContainer], stdout: 'pipe', stderr: 'pipe' });
    expect(logs.exitCode).not.toBe(0);
    expect(`${logs.stdout}${logs.stderr}`).not.toContain(staleCapability);
    expect(`${logs.stdout}${logs.stderr}`).not.toContain(liveCapability);
    const changedRootPaths = docker(['diff', firstContainer]).stdout.toString().trim().split('\n').filter(Boolean);
    expect(changedRootPaths.every((line) => /^.[ ]\/config(?:\/|$)/u.test(line))).toBe(true);
    expect(changedRootPaths.join('\n')).not.toMatch(/\/opt\/cyberbaser\/(?!\.workspace)|\/usr\/|\/etc\//u);

    for (const token of [staleCapability, liveCapability]) {
      expect(await readFile(configFile, 'utf8')).not.toContain(token);
      expect(await readFile(path.join(vault, 'page.md'), 'utf8')).not.toContain(token);
      docker([
        'run', '--rm', '--user', '0:0', '--network', 'none', '--read-only',
        '--mount', `type=volume,source=${volume},target=/opt/cyberbaser/.workspace,volume-nocopy`,
        '--entrypoint', 'bash', IMAGE, '-c',
        `! grep -R -F -- ${JSON.stringify(token)} /opt/cyberbaser/.workspace`,
      ]);
      docker(['run', '--rm', '--entrypoint', 'bash', IMAGE, '-c', `! grep -R -F -- ${JSON.stringify(token)} /opt/cyberbaser 2>/dev/null`]);
    }

    docker(['rm', '--force', firstContainer]);
    cleanupContainers.delete(firstContainer);
    const replacement = unique('owner-alpha-runtime-replacement');
    await startFixtureContainer({ name: replacement, volume, vault, config: configFile, script: scriptFile, port });
    const revoked = await request(port, '/api/jobs/missing', { headers: { Cookie: cookie } });
    expect(revoked.status).toBe(403);
    docker([
      'run', '--rm', '--user', '0:0', '--network', 'none', '--read-only',
      '--mount', `type=volume,source=${volume},target=/opt/cyberbaser/.workspace,volume-nocopy`,
      '--entrypoint', 'bash', IMAGE, '-c',
      'test "$(< /opt/cyberbaser/.workspace/owner-alpha/store/replacement-marker)" = durable-jobs-survive',
    ]);
    expect(docker(['image', 'inspect', '--format', '{{.Id}}', IMAGE]).stdout.toString().trim()).toBe(IMAGE);
  }, 120_000);
});

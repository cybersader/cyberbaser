import { describe, expect, test } from 'bun:test';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '../../..');
const DEPLOY = path.join(ROOT, 'deploy', 'account-free-intake');

async function text(relative) {
  return readFile(path.join(ROOT, relative), 'utf8');
}

describe('account-free intake deployment structure', () => {
  test('contains the complete local-only deployment bundle', async () => {
    for (const file of [
      'README.md',
      'package.json',
      'Containerfile',
      'Containerfile.dockerignore',
      'debian-packages.lock',
      'compose.yaml',
      'entrypoint.sh',
      'queue-init.sh',
      'stage-config.js',
      'healthcheck.js',
      'account-free-intake.container.example.json',
      'operator.env.example',
      'test/structure.test.js',
      'test/stage-config.test.js',
      'test/runtime-acceptance.test.js',
    ]) await access(path.join(DEPLOY, file));
    await access(path.join(ROOT, '.github/workflows/account-free-intake-container.yml'));
  });

  test('pins the OCI bases, package snapshot, and production dependency closure', async () => {
    const containerfile = await text('deploy/account-free-intake/Containerfile');
    const packages = await text('deploy/account-free-intake/debian-packages.lock');

    expect(containerfile).toContain('docker.io/oven/bun:1.3.11@sha256:38919894db4e117a37f74e3dca503e84f24d97f19cabc5f499a289c2a5d0db7c');
    expect(containerfile).toContain('docker.io/library/node:22.23.2-bookworm-slim@sha256:0f65470961851f2354dc8e560853e2f428ea928436135fc7e35780ab100c7e00');
    expect(containerfile).toContain('bun install --cwd "/opt/cyberbaser/packages/$package" --frozen-lockfile --production --ignore-scripts');
    expect(containerfile).toContain('bun install --cwd /opt/cyberbaser/apps/account-free-intake --frozen-lockfile --production --ignore-scripts');
    expect(containerfile).not.toMatch(/^FROM\s+[^\n]*:(?:latest|[A-Za-z0-9._-]+)\s*$/mu);
    expect(packages).toContain('DEBIAN_SNAPSHOT=20260803T000000Z');
    for (const line of packages.split('\n').filter((line) => /^[a-z]/u.test(line))) {
      expect(line).toMatch(/^[a-z0-9+.-]+=[^=\s]+$/u);
    }
  });

  test('keeps the build context allowlisted and omits unrelated applications and private state', async () => {
    const containerfile = await text('deploy/account-free-intake/Containerfile');
    const ignore = await text('deploy/account-free-intake/Containerfile.dockerignore');

    expect(ignore.startsWith('**\n')).toBe(true);
    expect(containerfile).not.toMatch(/\bCOPY\s+\.\s/u);
    expect(containerfile).not.toMatch(/apps\/owner-alpha|deploy\/owner-alpha|renderers\//u);
    expect(containerfile).not.toContain('EXPOSE');
    for (const pattern of ['.git', '.workspace', '**/node_modules', '**/*.local.json', '**/.env']) {
      expect(ignore).toContain(pattern);
    }
    for (const runtimePackage of ['correction', 'ofm', 'trust', 'proposal', 'account-free-intake', 'proposal-queue']) {
      expect(containerfile).toContain(`/packages/${runtimePackage}`);
    }
  });

  test('defines an off-by-default main service on an internal network with no published port', async () => {
    const compose = await text('deploy/account-free-intake/compose.yaml');
    const main = compose.slice(compose.indexOf('  account-free-intake:\n'), compose.indexOf('\nnetworks:\n'));

    expect(main).toContain('profiles:\n      - account-free-intake');
    expect(main).toContain('read_only: true');
    expect(main).toContain('user: "65532:65532"');
    expect(main).toContain('cap_drop:\n      - ALL');
    expect(main).toContain('no-new-privileges:true');
    expect(main).toContain('networks:\n      - account-free-intake-internal');
    expect(main).not.toMatch(/\bports\s*:/u);
    expect(main).not.toMatch(/network_mode:\s*host/u);
    expect(compose).toContain('internal: true');
    expect(compose).toContain('pull_policy: never');
    expect(compose).not.toMatch(/^\s*build\s*:/mu);
  });

  test('mounts only read-only inputs and one dedicated queue volume', async () => {
    const compose = await text('deploy/account-free-intake/compose.yaml');
    const main = compose.slice(compose.indexOf('  account-free-intake:\n'), compose.indexOf('\nnetworks:\n'));

    for (const target of [
      '/config/account-free-intake.json',
      '/srv/cyberbaser/source-bindings',
      '/srv/cyberbaser/source-objects.git',
    ]) {
      const start = main.indexOf(`target: ${target}`);
      expect(start).toBeGreaterThan(0);
      expect(main.slice(start, start + 180)).toContain('read_only: true');
    }
    expect(main).toContain('source: account-free-intake-queue');
    expect(main).toContain('target: /var/lib/cyberbaser');
    expect(main).toContain('/run/account-free-intake:rw,nosuid,nodev,noexec');
    expect(main).toContain('/tmp:rw,nosuid,nodev,noexec');

    for (const forbidden of [
      'target: /vault',
      'target: /run/owner-alpha',
      'target: /run/owner-alpha-credentials',
      'docker.sock',
      'podman.sock',
      'target: /root/.ssh',
      'target: /source-worktree',
      'target: /publication-output',
    ]) expect(compose).not.toContain(forbidden);
  });

  test('locks strict entrypoint, config staging, queue initialization, and health behavior', async () => {
    const entrypoint = await text('deploy/account-free-intake/entrypoint.sh');
    const staging = await text('deploy/account-free-intake/stage-config.js');
    const init = await text('deploy/account-free-intake/queue-init.sh');
    const health = await text('deploy/account-free-intake/healthcheck.js');

    for (const exact of [
      'require_mount "$SOURCE_CONFIG" "$SOURCE_CONFIG" ro',
      'require_mount "$BINDINGS_ROOT" "$BINDINGS_ROOT" ro',
      'require_mount "$GIT_ROOT" "$GIT_ROOT" ro',
      'require_mount "$VOLUME_ROOT" "$VOLUME_ROOT" rw',
      'require_mount "$RUN_ROOT" "$RUN_ROOT" rw tmpfs',
      "require_mount '/tmp' '/tmp' rw tmpfs",
      "[[ \"$(id -u):$(id -g)\" == '65532:65532' ]]",
      'rev-parse --is-bare-repository',
      'exec bun "$APP_ROOT/apps/account-free-intake/bin/server.js" --config "$ACTIVE_CONFIG"',
    ]) expect(entrypoint).toContain(exact);
    for (const forbidden of ['/vault', '/run/owner-alpha', '/var/run/docker.sock', '/run/podman/podman.sock', '/root/.ssh']) {
      expect(entrypoint).toContain(forbidden);
    }
    expect(entrypoint).toContain('FORGEJO_TOKEN');
    expect(entrypoint).toContain('SSH_AUTH_SOCK');

    expect(staging).toContain("bindingsRoot: '/srv/cyberbaser/source-bindings'");
    expect(staging).toContain("gitDir: '/srv/cyberbaser/source-objects.git'");
    expect(staging).toContain("queueRoot: '/var/lib/cyberbaser/proposal-queue'");
    expect(staging).toContain('handle.stat({ bigint: true })');
    expect(staging).toContain('after.ctimeNs !== before.ctimeNs');
    expect(staging).toContain('constants.O_NOFOLLOW');
    expect(staging).toContain('active config must have mode 0600');

    expect(init).toContain("[[ \"$(id -u):$(id -g)\" == '0:0' ]]");
    expect(init).toContain("chown \"$RUNTIME_UID:$RUNTIME_GID\" \"$QUEUE_ROOT\"");
    expect(init).not.toMatch(/chown\s+-R|chmod\s+-R/u);

    expect(health).toContain("hostname: '127.0.0.1'");
    expect(health).toContain("path: '/healthz'");
    expect(health).toContain('headers: { Host: `127.0.0.1:${port}` }');
    expect(health).toContain("body !== '{\"status\":\"ok\"}\\n'");
  });

  test('defines a pinned read-only local image CI workflow with structural enforcement', async () => {
    const workflow = await text('.github/workflows/account-free-intake-container.yml');
    const actionLines = workflow.split('\n').filter((line) => /^\s*uses:/u.test(line));

    expect(workflow).toContain('runs-on: ubuntu-24.04');
    expect(workflow).toContain('permissions:\n  contents: read');
    expect(workflow).toContain("bun-version: '1.3.11'");
    expect(workflow).toContain('persist-credentials: false');
    expect(workflow).toContain('bun install --cwd apps/account-free-intake --frozen-lockfile');
    expect(workflow).toContain('bun test deploy/account-free-intake/test');
    expect(workflow).toContain('docker build --progress=plain --file deploy/account-free-intake/Containerfile');
    expect(workflow).toContain("image_id=\"$(docker image inspect --format '{{.Id}}' cyberbaser-account-free-intake:ci)\"");
    expect(workflow).toContain('bun test deploy/account-free-intake/test/runtime-acceptance.test.js');
    expect(actionLines).toHaveLength(2);
    for (const line of actionLines) expect(line).toMatch(/@[a-f0-9]{40}(?:\s+#.*)?$/u);
    expect(workflow).not.toMatch(/pull_request_target|permissions:\s*write-all|contents:\s*write|packages:\s*write|id-token:\s*write|secrets\.|upload-artifact|deploy-pages|build-push-action|docker\s+(?:push|login)|create-release/iu);
    expect(workflow).not.toContain('ubuntu-latest');
  });

  test('documents local-only evidence and operational exclusions', async () => {
    const readme = await text('deploy/account-free-intake/README.md');
    for (const phrase of [
      'local-only Linux/amd64 OCI image',
      'plain `docker compose up` starts nothing',
      'There is intentionally no documented host URL',
      'review CLI is unavailable concurrently with the running service',
      'performs no recovery, expiration, purge, state replacement',
      'does not expose a real public endpoint',
      'does not contact a forge',
      'does not contact a forge, fetch evidence, expose a host port',
      'If Docker is unavailable',
    ]) expect(readme).toContain(phrase);
    expect(readme).not.toMatch(/docker\s+(?:push|login)|systemctl\s+(?:enable|start)|https:\/\/intake\.example(?:\s|\/)/u);
  });
});

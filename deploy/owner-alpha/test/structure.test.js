import { describe, expect, test } from 'bun:test';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '../../..');
const DEPLOY = path.join(ROOT, 'deploy', 'owner-alpha');

async function text(relative) {
  return readFile(path.join(ROOT, relative), 'utf8');
}

describe('owner-alpha container structure', () => {
  test('contains the WP2 image, runtime, operator, and documentation artifacts', async () => {
    for (const relative of [
      'deploy/owner-alpha/README.md',
      'docs/src/content/docs/development/owner-alpha-container-deployment.mdx',
      'deploy/owner-alpha/Containerfile',
      'deploy/owner-alpha/Containerfile.dockerignore',
      'deploy/owner-alpha/debian-packages.lock',
      'deploy/owner-alpha/entrypoint.sh',
      'deploy/owner-alpha/stage-config.js',
      'deploy/owner-alpha/state-init.sh',
      'deploy/owner-alpha/git-credential-owner-alpha-socket.js',
      'deploy/owner-alpha/healthcheck.js',
      'deploy/owner-alpha/compose.yaml',
      'deploy/owner-alpha/operator.env.example',
      'deploy/owner-alpha/owner-alpha.container.example.json',
      'deploy/owner-alpha/owner-alpha-compose.sh',
      'deploy/owner-alpha/systemd/user/cyberbaser-owner-alpha.service',
      'deploy/owner-alpha/systemd/system/cyberbaser-owner-alpha.service',
      'apps/owner-alpha/bun.lock',
      '.github/workflows/owner-alpha-container.yml',
    ]) await access(path.join(ROOT, relative));
  });

  test('documents the Linux-only operator contract and evidence boundary', async () => {
    const operator = await text('deploy/owner-alpha/README.md');
    const canonical = await text('docs/src/content/docs/development/owner-alpha-container-deployment.mdx');
    const plan = await text('docs/src/content/docs/design/v2-architecture-plan.mdx');

    for (const document of [operator, canonical]) {
      expect(document).toContain('Linux/amd64');
      expect(document).toContain('host networking');
      expect(document).toContain('Docker Desktop');
      expect(document).toContain('physical-device Save');
      expect(document).toContain('registry publication');
      expect(document).toContain('credential broker');
      expect(document).not.toContain('host networking or an explicit port publish');
      expect(document).not.toContain('credential helper or SSH agent');
    }

    expect(plan).toContain('WP2 — Container packaging (implementation and mechanical acceptance complete)');
    expect(plan).toContain('WP3 phase one is complete');
  });

  test('pins both OCI bases, Debian packages, Bun closure, and Quartz closure', async () => {
    const containerfile = await text('deploy/owner-alpha/Containerfile');
    const packages = await text('deploy/owner-alpha/debian-packages.lock');
    const packageJson = JSON.parse(await text('apps/owner-alpha/package.json'));
    const lock = await text('apps/owner-alpha/bun.lock');

    expect(containerfile).toContain('oven/bun:1.3.11@sha256:38919894db4e117a37f74e3dca503e84f24d97f19cabc5f499a289c2a5d0db7c');
    expect(containerfile).toContain('node:22.23.2-bookworm-slim@sha256:0f65470961851f2354dc8e560853e2f428ea928436135fc7e35780ab100c7e00');
    expect(containerfile).toContain('bun install --frozen-lockfile --production --ignore-scripts');
    expect(containerfile).toContain('npm --prefix /seed/quartz ci --no-audit --no-fund');
    expect(containerfile).toContain('4923affa7722dfc751f1074348e6dad214fe0c08');
    expect(containerfile).toContain('9ea5873a2bb495054f23b16f96d1d41f44348863e655f4c6d86b107f372b09b9');
    expect(containerfile).not.toMatch(/^FROM\s+[^\n]*:(?:latest|[A-Za-z0-9._-]+)\s*$/mu);
    expect(containerfile).not.toMatch(/^#\s*syntax=.*:[^@\s]+\s*$/mu);
    expect(containerfile).not.toMatch(/^ARG\s+QUARTZ_/mu);
    expect(packages).toContain('DEBIAN_SNAPSHOT=20260803T000000Z');
    for (const line of packages.split('\n').filter((line) => /^[a-z]/u.test(line))) {
      expect(line).toMatch(/^[a-z0-9+.-]+=[^=\s]+$/u);
    }
    expect(packageJson.packageManager).toBe('bun@1.3.11');
    expect(lock).toContain('"lockfileVersion": 1');
    expect(lock.match(/sha512-/gu)?.length ?? 0).toBeGreaterThan(80);
  });

  test('keeps the build context allowlisted and excludes mutable or private host state', async () => {
    const containerfile = await text('deploy/owner-alpha/Containerfile');
    const ignore = await text('deploy/owner-alpha/Containerfile.dockerignore');

    expect(containerfile).not.toMatch(/\bCOPY\s+\.\s/u);
    expect(ignore.startsWith('**\n')).toBe(true);
    for (const pattern of [
      '.git',
      '.workspace',
      '**/node_modules',
      '**/*.local.json',
      '**/.env',
      '**/test-results',
    ]) expect(ignore).toContain(pattern);
    expect(ignore).toContain('!deploy/owner-alpha/git-credential-owner-alpha-socket.js');
    expect(containerfile).not.toContain('owner-alpha.container.example.json');
    expect(containerfile).not.toMatch(/(?:TOKEN|PASSWORD|SECRET|AUTHORIZATION)=/u);
  });

  test('uses a non-root default, an inert Git repository, and the direct fail-closed entrypoint', async () => {
    const containerfile = await text('deploy/owner-alpha/Containerfile');
    const entrypoint = await text('deploy/owner-alpha/entrypoint.sh');
    const server = await text('apps/owner-alpha/src/server.js');

    expect(containerfile).toContain('USER 65532:65532');
    expect(containerfile).toContain('ln -s apps/owner-alpha/node_modules /opt/cyberbaser/node_modules');
    expect(containerfile).toContain('git init -q /opt/cyberbaser');
    expect(containerfile).toContain("test -z \"$(git -C /opt/cyberbaser remote)\"");
    expect(containerfile).toContain("credential.helper owner-alpha-socket");
    expect(containerfile).toContain('credential.useHttpPath true');
    expect(containerfile).toContain("exec /usr/bin/git -c credential.helper= -c credential.helper=owner-alpha-socket");
    expect(entrypoint).toContain("[[ \"$(command -v git)\" == '/usr/local/bin/git' ]]");
    expect(entrypoint).toContain('[[ -t 0 && -t 1 ]]');
    expect(entrypoint).toContain("require_mount '/vault' '/vault' '' 'rw'");
    expect(entrypoint).toContain("require_mount '/tmp' '/tmp' 'tmpfs' 'rw'");
    expect(entrypoint).toContain("forbid_mount_option '/tmp' 'noexec'");
    expect(entrypoint).toContain("exec bun \"$APP_ROOT/apps/owner-alpha/src/server.js\" \"$ACTIVE_CONFIG\"");
    expect(entrypoint).not.toContain('bin/start.sh');
    expect(entrypoint).not.toContain('bin/launch.sh');
    expect(entrypoint).not.toMatch(/0\.0\.0\.0|::|tailscale/iu);
    const recovery = server.indexOf('await runtime.recovery;');
    const marker = server.indexOf('writeOwnerAlphaReadyMarker(readyFile)');
    const bootstrap = server.indexOf('Owner alpha bootstrap:');
    expect(recovery).toBeGreaterThan(0);
    expect(marker).toBeGreaterThan(recovery);
    expect(bootstrap).toBeGreaterThan(marker);
  });

  test('pre-seeds Quartz and selects verified offline materialization in the image', async () => {
    const containerfile = await text('deploy/owner-alpha/Containerfile');
    const renderer = await text('apps/owner-alpha/src/quartz-renderer.js');
    const setup = await text('renderers/quartz-cyberbase/setup.sh');
    const build = await text('renderers/quartz-cyberbase/build.sh');

    expect(containerfile).toContain('COPY --from=quartz-seed /seed/quartz ./vendor/quartz');
    expect(containerfile).toContain('chmod -R a-w /opt/cyberbaser/vendor/quartz');
    expect(renderer).toContain("PINNED_QUARTZ_SEED_DIR = '/opt/cyberbaser/vendor/quartz'");
    expect(renderer).toContain("QUARTZ_OFFLINE: '1'");
    expect(setup).toContain('rsync -a --delete --chmod=u+rwX');
    expect(setup).toContain('verify_checkout "$QUARTZ_SEED_DIR"');
    expect(setup).toContain('verify_checkout "$QUARTZ_DIR"');
    const offlineBranch = setup.slice(setup.indexOf('  1)'), setup.indexOf('  *)'));
    expect(offlineBranch).not.toMatch(/git\s+(?:clone|fetch)|npm\s+ci/u);
    expect(build).toContain('node ./quartz/bootstrap-cli.mjs build');
    expect(build).not.toContain('npx quartz');
  });

  test('locks the complete runtime mount, identity, and credential contracts in the entrypoint', async () => {
    const entrypoint = await text('deploy/owner-alpha/entrypoint.sh');
    const stateInit = await text('deploy/owner-alpha/state-init.sh');
    const stageConfig = await text('deploy/owner-alpha/stage-config.js');
    const credential = await text('deploy/owner-alpha/git-credential-owner-alpha-socket.js');
    const health = await text('deploy/owner-alpha/healthcheck.js');

    for (const exact of [
      "require_mount '/vault' '/vault' '' 'rw'",
      'require_mount "$SOURCE_CONFIG" "$SOURCE_CONFIG" \'\' \'ro\'',
      'require_mount "$STATE_ROOT" "$STATE_ROOT" \'\' \'rw\'',
      "require_mount '/tmp' '/tmp' 'tmpfs' 'rw'",
      "require_mount \"$RUN_ROOT\" \"$RUN_ROOT\" 'tmpfs' 'rw'",
      'require_mount "$CREDENTIAL_ROOT" "$CREDENTIAL_ROOT" \'\' \'ro\'',
    ]) expect(entrypoint).toContain(exact);
    expect(entrypoint).toContain("[[ \"$(stat -c '%u:%g' /vault)\" == \"$(id -u):$(id -g)\" ]]");
    expect(entrypoint).toContain("[[ \"$(git -C /vault rev-parse --show-toplevel 2>/dev/null)\" == '/vault' ]]");
    expect(entrypoint).toContain('OWNER_ALPHA_RUNTIME_UID="$(id -u)"');
    expect(entrypoint).toContain('export OWNER_ALPHA_RUNTIME_UID OWNER_ALPHA_RUNTIME_GID');
    expect(entrypoint).toContain('owner-alpha-state-init verify');
    expect(entrypoint).toContain('[[ -S "$EXPECTED_SOCKET" && ! -L "$EXPECTED_SOCKET" ]]');
    expect(entrypoint).toContain("credential socket directory must contain only helper.sock");
    expect(entrypoint).toContain('MIN_TMP_KIB=2097152');
    expect(entrypoint).not.toMatch(/SSH_AUTH_SOCK|\.ssh\/|docker\.sock|podman\.sock|CI=true/iu);

    expect(stateInit).toContain("[[ \"$(findmnt -T \"$STATE_ROOT\" -n -o TARGET)\" == \"$STATE_ROOT\" ]]");
    expect(stateInit).toContain("fail 'unmarked non-empty state volume will not be modified'");
    expect(stateInit).toContain("\"$MODE\" == 'init' && \"$(id -u)\" == '0' && \"$RUNTIME_UID\" != '0'");
    expect(stateInit).not.toMatch(/chown\s+-R|chmod\s+-R/u);
    expect(stageConfig).toContain('handle.stat({ bigint: true })');
    expect(stageConfig).toContain('after.ctimeNs !== before.ctimeNs');
    expect(credential).toContain("if (operation !== 'get') return;");
    expect(credential).toContain("fields.get('protocol') !== 'https'");
    expect(credential).toContain("fields.get('path') !== expectedPath");
    expect(credential).toContain('SOCKET_TIMEOUT_MS = 2_000');
    expect(credential).not.toMatch(/console\.(?:log|error)|writeFile|appendFile/gu);
    expect(health).toContain("headers: { Host: expectedHost }");
    expect(health).toContain("path: '/cyberbase/'");
  });

  test('keeps all production storage native to Linux except the exact vault and narrow input binds', async () => {
    const compose = await text('deploy/owner-alpha/compose.yaml');
    const envExample = await text('deploy/owner-alpha/operator.env.example');
    const containerfile = await text('deploy/owner-alpha/Containerfile');
    const combined = `${compose}\n${envExample}\n${containerfile}`;

    expect(compose).toContain('source: owner-alpha-state');
    expect(compose).toContain('target: /opt/cyberbaser/.workspace');
    expect(compose).toMatch(/- \/tmp:rw,nosuid,nodev,exec,[^\n]+size=/u);
    expect(compose).toMatch(/- \/run\/owner-alpha:rw,nosuid,nodev,noexec,[^\n]+size=/u);
    expect(envExample).toContain('Exact native-Linux paths');
    expect(combined).not.toMatch(/\/mnt\/(?:c|wsl)|[A-Za-z]:\\|Docker Desktop|network_mode:\s*(?:bridge|default)/iu);
    expect(combined).not.toMatch(/tailscale|zerotier|headscale/iu);
  });

  test('defines a pinned local-only CI build and image acceptance workflow', async () => {
    const workflow = await text('.github/workflows/owner-alpha-container.yml');
    const actionLines = workflow.split('\n').filter((line) => /^\s*uses:/u.test(line));

    expect(workflow).toContain('runs-on: ubuntu-24.04');
    expect(workflow).toContain('permissions:\n  contents: read');
    expect(workflow).toContain('bun-version: \'1.3.11\'');
    for (const packagePath of [
      'packages/ofm',
      'packages/publish',
      'packages/trust',
      'packages/projection',
      'apps/owner-alpha',
    ]) expect(workflow).toContain(`bun install --cwd ${packagePath} --frozen-lockfile`);
    expect(workflow).toContain('bunx playwright install --with-deps chromium');
    expect(workflow).toContain('OWNER_ALPHA_ACCEPTANCE=1 bun test apps/owner-alpha/test/acceptance.test.js');
    expect(workflow).toContain('docker build --progress=plain --file deploy/owner-alpha/Containerfile');
    expect(workflow).toContain("image_id=\"$(docker image inspect --format '{{.Id}}' cyberbaser-owner-alpha:ci)\"");
    expect(workflow).toContain('bun test deploy/owner-alpha/test/runtime-acceptance.test.js');
    expect(actionLines.length).toBeGreaterThan(0);
    for (const line of actionLines) expect(line).toMatch(/@[a-f0-9]{40}\s*$/u);
    expect(workflow).not.toMatch(/docker\s+(?:push|login)|build-push-action|packages:\s*write|id-token:\s*write|registry/iu);
    expect(workflow).not.toContain('ubuntu-latest');
  });
});

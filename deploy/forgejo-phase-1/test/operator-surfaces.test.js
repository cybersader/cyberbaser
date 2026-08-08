import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  assertRunnerIsolation,
  cleanupFromManifest,
  createRunRoot,
  dockerRecordMatches,
  pidRecordMatches,
  privateCheckoutToolSource,
  readManifest,
  runnerExecutionContract,
  stageRunnerBinary,
  validateGateEnvironment,
  WP3_STORAGE_LIMIT_BYTES,
  WP3_STORAGE_STOP_BYTES,
  writeManifestAtomic,
} from '../src/harness.js';

const SAMPLE_UUID = '00000000-0000-4000-8000-000000000000';

function sampleContract(overrides = {}) {
  return runnerExecutionContract({
    runUuid: SAMPLE_UUID,
    jobImageTag: `wp3-job-${SAMPLE_UUID}`,
    composeProject: `cyberbaser-wp3-${SAMPLE_UUID}`,
    toolRoot: `/home/cybersader/.cache/cyberbaser/wp3/${SAMPLE_UUID}/tools`,
    publicationRoot: `/home/cybersader/.cache/cyberbaser/wp3/${SAMPLE_UUID}/publication`,
    forgeInternalOrigin: 'https://forgejo-wp3:3000',
    hostHome: '/home/cybersader',
    ...overrides,
  });
}

const ROOT = path.resolve(import.meta.dir, '../../..');
const DEPLOY = path.join(ROOT, 'deploy', 'forgejo-phase-1');
const cleanup = [];

async function text(relative) {
  return readFile(path.join(DEPLOY, relative), 'utf8');
}

function run(command, { cwd, env = process.env } = {}) {
  const result = Bun.spawnSync({ cmd: command, cwd, env, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    throw new Error(`${command[0]} failed: ${result.stderr.toString()}`);
  }
  return result.stdout.toString().trim();
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((target) => rm(target, { recursive: true, force: true })));
});

describe('WP3 Forgejo Compose boundary', () => {
  test('pins an operator-supplied immutable image and never pulls or builds', async () => {
    const compose = await text('compose.yaml');
    expect(compose).toContain('WP3_FORGEJO_IMAGE');
    expect(compose).toContain('pull_policy: never');
    expect(compose).not.toMatch(/^\s*build:/mu);
    expect(compose).toContain('read_only: true');
    expect(compose).toContain('cap_drop:\n      - ALL');
    expect(compose).toContain('no-new-privileges:true');
    expect(compose).not.toMatch(/privileged:\s*true|docker\.sock|podman\.sock/iu);
  });

  test('uses one labelled server on loopback-only standard HTTPS with SSH and unrelated units disabled', async () => {
    const compose = await text('compose.yaml');
    expect(compose.match(/^  forgejo:$/gmu)).toHaveLength(1);
    expect(compose).toContain('"127.0.0.1:8443:3000"');
    expect(compose).not.toMatch(/0\.0\.0\.0:\d+:3000/u);
    expect(compose).toContain('FORGEJO__server__PROTOCOL: https');
    expect(compose).toContain('FORGEJO__server__DISABLE_SSH: "true"');
    expect(compose).toContain('FORGEJO__service__DISABLE_REGISTRATION: "true"');
    expect(compose).toContain('FORGEJO__security__INSTALL_LOCK: "true"');
    expect(compose).toContain('FORGEJO__packages__ENABLED: "false"');
    expect(compose).toContain('FORGEJO__lfs__START_SERVER: "false"');
    expect(compose).toContain('FORGEJO__mailer__ENABLED: "false"');
    expect(compose.match(/io\.cyberbaser\.fixture: wp3/gu).length).toBeGreaterThanOrEqual(3);
    expect(compose.match(/io\.cyberbaser\.wp3\.run:/gu).length).toBeGreaterThanOrEqual(3);
  });
});

describe('tracked fixture workflow constraints', () => {
  test('uses only shell run steps and no action, container, package install, or network download', async () => {
    const files = [
      'fixtures/repository/.forgejo/workflows/ofm-check.yml',
      'fixtures/repository/.forgejo/workflows/trust-gate.yml',
      'fixtures/repository/.forgejo/workflows/publish-site.yml',
    ];
    for (const file of files) {
      const workflow = await text(file);
      expect(workflow).toContain('run: |');
      expect(workflow).not.toMatch(/^\s*uses:/mu);
      expect(workflow).not.toMatch(/^\s*(?:container|services):/mu);
      expect(workflow).not.toMatch(/continue-on-error|allow_failure|npm install|bun install|apt-get|apk add|curl\s|wget\s/iu);
      expect(workflow).toContain('${GITHUB_SHA}');
      expect(workflow).toContain('CYBERBASER_TOOL_ROOT');
      expect(workflow).toContain('${FORGEJO_TOKEN:-}');
      expect(workflow).toContain('/private-checkout');
    }
  });

  test('authenticates a private checkout with the automatic token while ignoring ambient Git helpers', async () => {
    const runRoot = await createRunRoot();
    cleanup.push(runRoot);
    const work = path.join(runRoot, 'auth-source');
    const bare = path.join(runRoot, 'private.git');
    const checkout = path.join(runRoot, 'checkout');
    const runnerTemp = path.join(runRoot, 'runner-temp');
    const hostileHome = path.join(runRoot, 'hostile-home');
    await mkdir(work, { mode: 0o700 });
    await mkdir(runnerTemp, { mode: 0o700 });
    await mkdir(hostileHome, { mode: 0o700 });
    run(['git', 'init', '--bare', '--quiet', '--initial-branch=main', bare]);
    run(['git', 'init', '--quiet', '--initial-branch=main'], { cwd: work });
    run(['git', 'config', 'user.name', 'WP3 Test'], { cwd: work });
    run(['git', 'config', 'user.email', 'wp3@example.invalid'], { cwd: work });
    await writeFile(path.join(work, 'page.md'), 'private fixture\n');
    run(['git', 'add', 'page.md'], { cwd: work });
    run(['git', 'commit', '--quiet', '-m', 'private fixture'], { cwd: work });
    run(['git', 'remote', 'add', 'origin', bare], { cwd: work });
    run(['git', 'push', '--quiet', 'origin', 'main'], { cwd: work });
    run(['git', '--git-dir', bare, 'update-server-info']);
    const commit = run(['git', '--git-dir', bare, 'rev-parse', 'refs/heads/main']);
    const hostileMarker = path.join(runRoot, 'ambient-helper-used');
    const hostileHelper = path.join(hostileHome, 'hostile-helper');
    await writeFile(hostileHelper, `#!/usr/bin/env bash\nprintf 'used\\n' > ${JSON.stringify(hostileMarker)}\nexit 1\n`, { mode: 0o700 });
    await writeFile(path.join(hostileHome, '.gitconfig'), `[credential]\n\thelper = !${hostileHelper}\n`, { mode: 0o600 });
    const token = 'workflow-private-token';
    const expectedAuthorization = `Basic ${Buffer.from(`wp3-token:${token}`).toString('base64')}`;
    let authenticatedRequests = 0;
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        if (request.headers.get('authorization') !== expectedAuthorization) {
          return new Response('', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="wp3"' } });
        }
        authenticatedRequests += 1;
        const url = new URL(request.url);
        const input = Buffer.from(await request.arrayBuffer());
        const child = Bun.spawn({
          cmd: ['git', 'http-backend'],
          env: {
            ...process.env,
            GIT_PROJECT_ROOT: runRoot,
            GIT_HTTP_EXPORT_ALL: '1',
            PATH_INFO: url.pathname,
            QUERY_STRING: url.search.slice(1),
            REQUEST_METHOD: request.method,
            CONTENT_TYPE: request.headers.get('content-type') ?? '',
            CONTENT_LENGTH: String(input.length),
            HTTP_GIT_PROTOCOL: request.headers.get('git-protocol') ?? '',
            REMOTE_USER: 'wp3-token',
          },
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'pipe',
        });
        child.stdin.write(input);
        child.stdin.end();
        const output = Buffer.from(await new Response(child.stdout).arrayBuffer());
        const stderr = await new Response(child.stderr).text();
        if (await child.exited !== 0) return new Response(stderr, { status: 500 });
        const separator = output.indexOf('\r\n\r\n');
        if (separator < 0) return new Response('invalid CGI response', { status: 500 });
        const headerLines = output.subarray(0, separator).toString('utf8').split('\r\n');
        const headers = new Headers();
        let status = 200;
        for (const line of headerLines) {
          const index = line.indexOf(':');
          if (index < 1) continue;
          const name = line.slice(0, index);
          const value = line.slice(index + 1).trim();
          if (name.toLowerCase() === 'status') status = Number(value.split(' ')[0]);
          else headers.append(name, value);
        }
        return new Response(output.subarray(separator + 4), { status, headers });
      },
    });
    try {
      const tool = path.join(runRoot, 'private-checkout');
      await writeFile(tool, privateCheckoutToolSource(), { mode: 0o500 });
      const child = Bun.spawn({
        cmd: [tool, checkout, `http://127.0.0.1:${server.port}/private.git`, commit, 'main'],
        env: {
          ...process.env,
          HOME: hostileHome,
          RUNNER_TEMP: runnerTemp,
          FORGEJO_TOKEN: token,
          GITHUB_RUN_ID: 'auth-test',
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'credential.helper',
          GIT_CONFIG_VALUE_0: `!${hostileHelper}`,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const exitCode = await child.exited;
      const stderr = await new Response(child.stderr).text();
      expect(exitCode, stderr).toBe(0);
      expect(run(['git', '-C', checkout, 'rev-parse', 'HEAD'])).toBe(commit);
      expect(await Bun.file(hostileMarker).exists()).toBe(false);
      expect(authenticatedRequests).toBeGreaterThan(0);
      const retainedHelper = Bun.spawnSync({ cmd: ['git', '-C', checkout, 'config', '--local', '--get-all', 'credential.helper'], stdout: 'pipe', stderr: 'pipe' });
      expect(retainedHelper.exitCode).toBe(1);
      expect(retainedHelper.stdout.toString()).toBe('');
    } finally {
      server.stop(true);
    }
  });

  test('protects workflows and fixture tooling and makes deploy depend on every configured gate job', async () => {
    const ofm = await text('fixtures/repository/.forgejo/workflows/ofm-check.yml');
    const trust = await text('fixtures/repository/.forgejo/workflows/trust-gate.yml');
    const publish = await text('fixtures/repository/.forgejo/workflows/publish-site.yml');
    for (const workflow of [ofm, trust]) {
      expect(workflow).toContain('^(\\.forgejo/workflows/|fixture-tools/)');
      expect(workflow).toContain('refs/remotes/origin/main');
    }
    expect(publish).toContain('deploy:\n    needs: [build]');
    expect(publish).toContain('mv -Tf');
    expect(publish).toContain('${WP3_PUBLICATION_ROOT}/${GITHUB_RUN_ID}');
  });
});

describe('harness preflight, storage, evidence, and cleanup guards', () => {
  test('is opt-in only and requires all exact immutable inputs', async () => {
    expect(await validateGateEnvironment({})).toEqual({
      enabled: false,
      reason: 'OWNER_ALPHA_REAL_FORGEJO is not 1',
    });
    await expect(validateGateEnvironment({ OWNER_ALPHA_REAL_FORGEJO: '1' }))
      .rejects.toThrow('WP3_FORGEJO_IMAGE');
    expect(WP3_STORAGE_STOP_BYTES).toBe(3_758_096_384);
    expect(WP3_STORAGE_LIMIT_BYTES).toBe(4_294_967_296);
  });

  test('enforces container-mode job execution and rejects host authority before resource creation', async () => {
    const contract = assertRunnerIsolation(sampleContract());
    expect(contract.executionMode).toBe('container');
    expect(contract.registrationLabel).toBe(`wp3-${SAMPLE_UUID}:docker://wp3-job-${SAMPLE_UUID}`);
    expect(contract.network).toBe(`cyberbaser-wp3-${SAMPLE_UUID}_default`);
    expect(contract.options).toContain('/tools:/wp3/tools:ro');
    expect(contract.options).toContain('io.cyberbaser.wp3.role=job');
    expect(contract.privileged).toBe(false);

    // Every authority-granting mutation of the contract must fail closed.
    expect(() => assertRunnerIsolation({ ...contract, executionMode: 'host' })).toThrow('host-mode execution is permanently rejected');
    expect(() => assertRunnerIsolation({ ...contract, registrationLabel: `wp3-${SAMPLE_UUID}:host` })).toThrow('run-scoped job container image');
    expect(() => assertRunnerIsolation({ ...contract, privileged: true })).toThrow('unprivileged');
    expect(() => assertRunnerIsolation({ ...contract, network: 'host' })).toThrow('run-scoped compose network');
    expect(() => assertRunnerIsolation({ ...contract, options: `${contract.options} --volume /var/run/docker.sock:/var/run/docker.sock` })).toThrow();

    const harness = await text('src/harness.js');
    const main = harness.slice(harness.indexOf('async function main'));
    expect(main.indexOf('assertRunnerIsolation(')).toBeLessThan(main.indexOf('acquireGlobalLock();'));
    expect(main.indexOf('assertRunnerIsolation(')).toBeLessThan(main.indexOf('createRunRoot(runUuid)'));
    // The job image and daemon must carry the reviewed contract, not host mode.
    const acceptance = await text('src/acceptance-child.js');
    expect(acceptance).toContain('assertRunnerIsolation(runnerExecutionContract(');
    expect(acceptance).not.toMatch(/:host\\n`\)/u);
    expect(acceptance).toContain('DOCKER_HOST: dockerHost');
  });

  test('executes a run-root copy bound to the verified runner bytes, not the mutable source pathname', async () => {
    const runRoot = await createRunRoot();
    cleanup.push(runRoot);
    const source = path.join(runRoot, 'operator-supplied-runner');
    const original = '#!/usr/bin/env bash\nprintf \'verified-runner\\n\'\n';
    await writeFile(source, original, { mode: 0o700 });
    await chmod(source, 0o700);
    const expected = createHash('sha256').update(original).digest('hex');
    const staged = await stageRunnerBinary(runRoot, source, expected);
    await writeFile(source, '#!/usr/bin/env bash\nprintf \'replaced-runner\\n\'\n', { mode: 0o700 });
    const result = Bun.spawnSync({ cmd: [staged], stdout: 'pipe', stderr: 'pipe' });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe('verified-runner\n');
    expect(staged).not.toBe(source);
    expect((await stat(staged)).mode & 0o777).toBe(0o500);
  });

  test('records an atomic mode-0600 manifest and removes only matching PIDs and exact double-labelled resources', async () => {
    const runRoot = await createRunRoot();
    cleanup.push(runRoot);
    const runUuid = path.basename(runRoot);
    const manifest = {
      schemaVersion: 1,
      runUuid,
      runRoot,
      composeProject: `wp3-${runUuid}`,
      markerPath: path.join(runRoot, '.wp3-run-uuid'),
      processes: [
        { pid: 101, startTime: '10', executable: '/usr/bin/runner', runRoot },
        { pid: 102, startTime: '20', executable: '/usr/bin/server', runRoot },
      ],
      docker: {
        containers: [{ id: 'good-container' }, { id: 'wrong-label-container' }],
        volumes: [{ id: 'good-volume' }],
        networks: [{ id: 'good-network' }],
      },
      secretFiles: [path.join(runRoot, 'secrets', 'observer.token')],
      storage: { baseline: 0, peak: 0, measurements: [] },
      repositories: {},
    };
    const file = await writeManifestAtomic(runRoot, manifest);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const killed = [];
    const removed = [];
    const removedIds = new Set();
    const result = await cleanupFromManifest(runRoot, {
      observePid: async (pid) => pid === 101
        ? { pid, startTime: '10', executable: '/usr/bin/runner', cwd: `${runRoot}/runner` }
        : { pid, startTime: 'mismatch', executable: '/usr/bin/server', cwd: `${runRoot}/server` },
      kill: (pid) => killed.push(pid),
      waitForPidExit: async () => true,
      listDocker: (kind) => {
        const ids = kind === 'container' ? ['good-container']
          : kind === 'volume' ? ['good-volume']
            : kind === 'network' ? ['good-network'] : [];
        return ids.filter((id) => !removedIds.has(id));
      },
      inspectDocker: (kind, id) => ({
        id,
        labels: id === 'wrong-label-container'
          ? { 'io.cyberbaser.fixture': 'wp3', 'io.cyberbaser.wp3.run': 'another-run' }
          : { 'io.cyberbaser.fixture': 'wp3', 'io.cyberbaser.wp3.run': runUuid },
      }),
      removeDocker: (kind, id) => {
        removed.push(`${kind}:${id}`);
        removedIds.add(id);
      },
    });
    expect(killed).toEqual([101]);
    expect(result.skippedPids).toEqual([102]);
    expect(removed.sort()).toEqual([
      'container:good-container',
      'network:good-network',
      'volume:good-volume',
    ]);
    expect(result.skippedDocker).toEqual(['container:wrong-label-container']);
  });

  test('refuses to remove a correctly labelled resource absent from the atomic manifest', async () => {
    const runRoot = await createRunRoot();
    cleanup.push(runRoot);
    const runUuid = path.basename(runRoot);
    await writeManifestAtomic(runRoot, {
      schemaVersion: 1,
      runUuid,
      runRoot,
      composeProject: `wp3-${runUuid}`,
      markerPath: path.join(runRoot, '.wp3-run-uuid'),
      processes: [],
      docker: { containers: [], volumes: [], networks: [] },
      secretFiles: [],
      storage: { baseline: 0, peak: 0, measurements: [] },
      repositories: {},
    });
    const removed = [];
    await expect(cleanupFromManifest(runRoot, {
      listDocker: (kind) => kind === 'container' ? ['unrecorded'] : [],
      inspectDocker: (kind, id) => ({
        id,
        labels: { 'io.cyberbaser.fixture': 'wp3', 'io.cyberbaser.wp3.run': runUuid },
      }),
      removeDocker: (kind, id) => removed.push(`${kind}:${id}`),
    })).rejects.toThrow('absent from the atomic run manifest');
    expect(removed).toEqual([]);
  });

  test('reconciles a compose-created resource into the manifest before removing it after a persistence fault', async () => {
    const runRoot = await createRunRoot();
    cleanup.push(runRoot);
    const runUuid = path.basename(runRoot);
    const composeProject = `wp3-${runUuid}`;
    await writeManifestAtomic(runRoot, {
      schemaVersion: 1,
      runUuid,
      runRoot,
      composeProject,
      markerPath: path.join(runRoot, '.wp3-run-uuid'),
      processes: [],
      docker: { creationAuthorized: true, containers: [], volumes: [], networks: [] },
      secretFiles: [],
      storage: { baseline: 0, peak: 0, measurements: [] },
      repositories: {},
    });
    let present = true;
    const removed = [];
    const result = await cleanupFromManifest(runRoot, {
      listDocker: (kind) => kind === 'container' && present ? ['created-before-record'] : [],
      inspectDocker: (kind, id) => present ? {
        id,
        labels: {
          'io.cyberbaser.fixture': 'wp3',
          'io.cyberbaser.wp3.run': runUuid,
          'com.docker.compose.project': composeProject,
        },
      } : null,
      removeDocker: (kind, id) => {
        removed.push(`${kind}:${id}`);
        present = false;
      },
    });
    expect(result.reconciledDocker).toEqual(['container:created-before-record']);
    expect(removed).toEqual(['container:created-before-record']);
    expect((await readManifest(runRoot)).docker.containers).toEqual([{ id: 'created-before-record' }]);
  });

  test('pure identity predicates reject a mismatched process and either missing resource label', () => {
    const record = { pid: 123, startTime: '1', executable: '/runner', runRoot: '/run' };
    expect(pidRecordMatches(record, { pid: 123, startTime: '1', executable: '/runner', cwd: '/run' })).toBe(true);
    expect(pidRecordMatches(record, { pid: 123, startTime: '2', executable: '/runner', cwd: '/run/work' })).toBe(false);
    expect(pidRecordMatches(record, { pid: 123, startTime: '1', executable: '/runner', cwd: '/other' })).toBe(false);
    expect(dockerRecordMatches({ id: 'x' }, { id: 'x', labels: { 'io.cyberbaser.fixture': 'wp3' } }, 'uuid')).toBe(false);
    expect(dockerRecordMatches({ id: 'x' }, { id: 'x', labels: { 'io.cyberbaser.fixture': 'other', 'io.cyberbaser.wp3.run': 'uuid' } }, 'uuid')).toBe(false);
  });

  test('contains manifest-bound cleanup, storage checkpoints, credential assertions, and no broad prune', async () => {
    const harness = await text('src/harness.js');
    const acceptance = await text('src/acceptance-child.js');
    const combined = `${harness}\n${acceptance}`;
    expect(combined).toContain('assertCredentialFree');
    expect(combined).toContain('measureStorage');
    for (const phase of [
      'preflight', 'after-forgejo-initialization', 'after-pr-checks', 'after-merge',
      'after-owner-alpha-save', 'after-deployment-live-confirmation', 'before-teardown',
    ]) expect(acceptance).toContain(`'${phase}'`);
    expect(harness).toContain('after-teardown measurement');
    expect(harness).toContain('listDockerByLabels');
    expect(harness).toContain("['SIGINT', 'SIGTERM', 'SIGHUP']");
    expect(acceptance).toContain("[['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]");
    expect(acceptance.indexOf('manifest.docker.creationAuthorized = true')).toBeLessThan(acceptance.indexOf("'up', '--detach'"));
    expect(harness).not.toContain('cleanupFromManifest(runRoot, { removeRunRoot: true }).catch(() => {})');
    expect(combined).not.toMatch(/docker\s+(?:system|image|builder|volume)\s+prune|docker\s+prune/iu);
    expect(acceptance).toContain('pull\', \'never');
    expect(acceptance).toContain('PINNED_FORGEJO_FIXTURE_VERSION');
    expect(acceptance).toContain('16\\.0\\.2');
    expect(acceptance).toContain('run-scoped jobs endpoint');
  });
});

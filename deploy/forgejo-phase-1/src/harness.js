import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

export const WP3_RUN_PARENT = '/home/cybersader/.cache/cyberbaser/wp3';
export const WP3_STORAGE_LIMIT_BYTES = 4_294_967_296;
export const WP3_STORAGE_STOP_BYTES = 3_758_096_384;
export const WP3_RESULT_MAX_BYTES = 8 * 1024 * 1024;
export const WP3_FIXTURE_LABEL = 'io.cyberbaser.fixture=wp3';
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const NATIVE_RUN_ROOT_FILESYSTEMS = new Set([
  0xEF53, // ext4
  0x9123683E, // btrfs
]);
const CREDENTIAL_RE = /(?:authorization|bearer|password|private.?key|secret|token|bootstrap|credential)/iu;

function exact(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || /\p{Cc}/u.test(value)) {
    throw new Error(`${name} must be one exact non-empty string`);
  }
  return value;
}

export function forgejoRunOutcome(run) {
  const status = run?.status;
  if (['unknown', 'waiting', 'running', 'blocked'].includes(status)) return null;
  if (status === 'completed') return typeof run.conclusion === 'string' ? run.conclusion : 'unknown';
  if (['success', 'failure', 'cancelled', 'skipped'].includes(status)) return status;
  throw new Error('Forgejo fixture run returned an unsupported status');
}

function spawn(command, { cwd, env, stdin = 'ignore' } = {}) {
  const result = Bun.spawnSync({ cmd: command, cwd, env, stdin, stdout: 'pipe', stderr: 'pipe' });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

export function assertCredentialFree(value, materials = [], location = '$') {
  if (typeof value === 'string') {
    for (const material of materials) {
      if (material && value.includes(material)) throw new Error(`credential material retained at ${location}`);
    }
    if (/^https?:\/\//u.test(value)) {
      const url = new URL(value);
      if (url.username || url.password) throw new Error(`credential-bearing URL retained at ${location}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertCredentialFree(entry, materials, `${location}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      if (CREDENTIAL_RE.test(key) && key !== 'secretFiles') {
        throw new Error(`credential-shaped key retained at ${location}.${key}`);
      }
      assertCredentialFree(entry, materials, `${location}.${key}`);
    }
  }
}

async function assertNoSymlinkComponents(target) {
  const absolute = path.resolve(target);
  const parts = absolute.split(path.sep).filter(Boolean);
  let current = path.parse(absolute).root;
  for (const part of parts) {
    current = path.join(current, part);
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) throw new Error(`symlink path component rejected: ${current}`);
  }
}

export async function validateRunRoot(input) {
  const candidate = exact(input, 'run root');
  if (!path.isAbsolute(candidate)
    || path.normalize(candidate) !== candidate
    || candidate.startsWith('/mnt/c/')
    || candidate.startsWith('/mnt/wsl/')
    || path.dirname(candidate) !== WP3_RUN_PARENT
    || !UUID_RE.test(path.basename(candidate))) {
    throw new Error('WP3 run root must be one exact UUID directory below the native run parent');
  }
  await assertNoSymlinkComponents(candidate);
  const resolved = await realpath(candidate);
  if (resolved !== candidate) throw new Error('WP3 run root must not use an alias path');
  const metadata = await stat(candidate);
  if (!metadata.isDirectory()
    || (metadata.mode & 0o777) !== 0o700
    || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())) {
    throw new Error('WP3 run root must be a mode-0700 directory owned by the current user');
  }
  const filesystem = await statfs(candidate);
  const filesystemMagic = Number(filesystem.type) >>> 0;
  if (!NATIVE_RUN_ROOT_FILESYSTEMS.has(filesystemMagic)) {
    throw new Error('WP3 run root must use native ext4 or btrfs storage');
  }
  const marker = path.join(candidate, '.wp3-run-uuid');
  const markerMetadata = await lstat(marker);
  if (!markerMetadata.isFile()
    || markerMetadata.nlink !== 1
    || (markerMetadata.mode & 0o077) !== 0
    || (await readFile(marker, 'utf8')) !== `${path.basename(candidate)}\n`) {
    throw new Error('WP3 run marker is invalid');
  }
  return candidate;
}

async function checksum(file) {
  const hash = createHash('sha256');
  hash.update(await readFile(file));
  return hash.digest('hex');
}

export function privateCheckoutToolSource() {
  return [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'workspace="${1:?workspace path required}"',
    'remote="${2:?remote URL required}"',
    'commit="${3:?triggering commit required}"',
    'base_branch="${4:-}"',
    'test -n "${FORGEJO_TOKEN:-}"',
    'export RUNNER_TEMP="${RUNNER_TEMP:-/tmp}"',
    'test -n "${RUNNER_TEMP:-}"',
    'export GIT_TERMINAL_PROMPT=0',
    'export GIT_CONFIG_NOSYSTEM=1',
    'export GIT_CONFIG_GLOBAL=/dev/null',
    'unset GIT_CONFIG_COUNT GIT_ASKPASS SSH_ASKPASS',
    'export HOME="${RUNNER_TEMP}/wp3-empty-home"',
    'umask 077',
    'mkdir -p -- "$HOME"',
    'helper="${RUNNER_TEMP}/wp3-git-credential-${GITHUB_RUN_ID:-local}-$$"',
    'cleanup() {',
    '  git -C "$workspace" config --unset-all credential.helper >/dev/null 2>&1 || true',
    '  rm -f -- "$helper"',
    '}',
    'trap cleanup EXIT HUP INT TERM',
    'printf \'%s\\n\' \'#!/usr/bin/env bash\' \'set -euo pipefail\' \'case "${1:-}" in\' \'  get) printf "username=wp3-token\\npassword=%s\\n" "${FORGEJO_TOKEN:?}" ;;\' \'  store|erase) exit 0 ;;\' \'  *) exit 1 ;;\' \'esac\' > "$helper"',
    'chmod 0700 "$helper"',
    'git init --quiet "$workspace"',
    'git -C "$workspace" config credential.helper ""',
    'git -C "$workspace" config --add credential.helper "!$helper"',
    'git -C "$workspace" remote add origin "$remote"',
    'if [[ -n "$base_branch" ]]; then',
    '  git -C "$workspace" fetch --quiet --depth=1 origin "+refs/heads/${base_branch}:refs/remotes/origin/${base_branch}" "$commit"',
    '  git -C "$workspace" checkout --quiet --detach "$commit"',
    '  test -n "$(git -C "$workspace" rev-parse "refs/remotes/origin/${base_branch}")"',
    'else',
    '  git -C "$workspace" fetch --quiet --depth=1 origin "$commit"',
    '  git -C "$workspace" checkout --quiet --detach FETCH_HEAD',
    'fi',
    'test "$(git -C "$workspace" rev-parse HEAD)" = "$commit"',
  ].join('\n').concat('\n');
}

export async function writePrivateCheckoutTool(directory) {
  const target = path.join(directory, 'private-checkout');
  await writeFile(target, privateCheckoutToolSource(), { mode: 0o500, flag: 'wx' });
  await chmod(target, 0o500);
  return target;
}

export async function stageRunnerBinary(runRoot, source, expectedSha256) {
  await validateRunRoot(runRoot);
  const sourcePath = await realpath(exact(source, 'runner source'));
  const expected = exact(expectedSha256, 'runner checksum');
  if (!/^[a-f0-9]{64}$/u.test(expected)) throw new Error('runner checksum must be lowercase SHA-256');
  const directory = path.join(runRoot, 'operator');
  const target = path.join(directory, 'forgejo-runner');
  await mkdir(directory, { mode: 0o700 });
  const bytes = await readFile(sourcePath);
  const handle = await open(target, 'wx', 0o500);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(target, 0o500);
  if (await checksum(target) !== expected) {
    await rm(target, { force: true });
    throw new Error('staged WP3 Forgejo Runner checksum mismatch');
  }
  return target;
}

export const WP3_JOB_TOOL_MOUNT = '/wp3/tools';
export const WP3_JOB_PUBLICATION_MOUNT = '/wp3/publication';

/**
 * Reviewed WP3 runner-isolation boundary: the checksum-pinned runner daemon is
 * trusted harness infrastructure, but every workflow job must execute inside a
 * labelled container with exactly two run-root mounts (read-only tools and the
 * publication handoff), an isolated compose network, no privilege, and no
 * container-engine socket. Host-mode execution is permanently rejected.
 */
export function runnerExecutionContract({
  runUuid,
  jobImageTag,
  composeProject,
  toolRoot,
  publicationRoot,
  forgeInternalOrigin,
  hostHome,
}) {
  if (!UUID_RE.test(runUuid)) throw new Error('runner contract requires the canonical run UUID');
  exact(jobImageTag, 'job image tag');
  exact(composeProject, 'compose project');
  exact(forgeInternalOrigin, 'forge internal origin');
  if (!/^wp3-job-[0-9a-f-]{36}$/u.test(jobImageTag)) {
    throw new Error('job image tag must be the run-scoped wp3-job image');
  }
  if (!path.isAbsolute(toolRoot) || !path.isAbsolute(publicationRoot)
    || path.dirname(toolRoot) !== path.dirname(publicationRoot)
    || !UUID_RE.test(path.basename(path.dirname(toolRoot)))) {
    throw new Error('runner contract mounts must live directly below one run root');
  }
  const labelName = `wp3-${runUuid}`;
  return Object.freeze({
    executionMode: 'container',
    labelName,
    registrationLabel: `${labelName}:docker://${jobImageTag}`,
    network: `${composeProject}_default`,
    privileged: false,
    validVolumes: Object.freeze([
      toolRoot,
      publicationRoot,
    ]),
    forcePull: false,
    options: [
      `--volume ${toolRoot}:${WP3_JOB_TOOL_MOUNT}:ro`,
      `--volume ${publicationRoot}:${WP3_JOB_PUBLICATION_MOUNT}`,
      '--label io.cyberbaser.fixture=wp3',
      `--label io.cyberbaser.wp3.run=${runUuid}`,
      '--label io.cyberbaser.wp3.role=job',
    ].join(' '),
    envs: Object.freeze({
      CYBERBASER_TOOL_ROOT: WP3_JOB_TOOL_MOUNT,
      WP3_PUBLICATION_ROOT: WP3_JOB_PUBLICATION_MOUNT,
      WP3_FORGE_INTERNAL_ORIGIN: forgeInternalOrigin,
      GIT_SSL_CAINFO: `${WP3_JOB_TOOL_MOUNT}/ca.crt`,
      SSL_CERT_FILE: `${WP3_JOB_TOOL_MOUNT}/ca.crt`,
      WP3_HOST_RUN_PARENT: WP3_RUN_PARENT,
      WP3_HOST_HOME: exact(hostHome, 'host home'),
    }),
  });
}

export function assertRunnerIsolation(contract) {
  if (!contract || contract.executionMode !== 'container') {
    throw new Error('WP3 jobs must execute in containers; host-mode execution is permanently rejected');
  }
  if (!/^wp3-[0-9a-f-]{36}:docker:\/\/wp3-job-[0-9a-f-]{36}$/u.test(contract.registrationLabel)
    || contract.registrationLabel.includes(':host')
    || contract.registrationLabel.includes(':lxc')) {
    throw new Error('WP3 runner registration must bind the label to the run-scoped job container image');
  }
  if (contract.privileged !== false || contract.forcePull !== false
    || !Array.isArray(contract.validVolumes)) {
    throw new Error('WP3 job containers must be unprivileged with an exact run-scoped volume allowlist');
  }
  if (typeof contract.network !== 'string'
    || !contract.network.endsWith('_default')
    || ['host', 'bridge', 'none', ''].includes(contract.network)) {
    throw new Error('WP3 job containers must join only the labelled run-scoped compose network');
  }
  const options = exact(contract.options, 'runner container options');
  const volumeMounts = options.match(/--volume[= ][^\s]+/gu) ?? [];
  if (volumeMounts.length !== 2
    || !volumeMounts[0].endsWith(`:${WP3_JOB_TOOL_MOUNT}:ro`)
    || !volumeMounts[1].endsWith(`:${WP3_JOB_PUBLICATION_MOUNT}`)) {
    throw new Error('WP3 job containers may mount exactly the read-only tools and the publication handoff');
  }
  const configuredSources = volumeMounts.map((mount) => (
    mount.replace(/^--volume[= ]/u, '').split(':', 1)[0]
  ));
  if (contract.validVolumes.length !== 2
    || contract.validVolumes.some((source, index) => source !== configuredSources[index])) {
    throw new Error('WP3 runner volume allowlist must contain only the two configured run-scoped sources');
  }
  if (/docker\.sock|podman\.sock|--privileged|--pid[= ]host|--network[= ]host|--cap-add|--security-opt[= ]seccomp=unconfined/iu.test(options)) {
    throw new Error('WP3 job container options must not grant host or engine authority');
  }
  if (!options.includes('--label io.cyberbaser.fixture=wp3')
    || !options.includes('--label io.cyberbaser.wp3.run=')
    || !options.includes('--label io.cyberbaser.wp3.role=job')) {
    throw new Error('WP3 job containers must carry the exact fixture cleanup labels');
  }
  for (const [name, value] of Object.entries(contract.envs ?? {})) {
    if (CREDENTIAL_RE.test(name)) throw new Error('runner job environment must not carry credential-shaped names');
    exact(value, `runner env ${name}`);
  }
  return contract;
}

export async function validateGateEnvironment(env = process.env) {
  if (env.OWNER_ALPHA_REAL_FORGEJO !== '1') return { enabled: false, reason: 'OWNER_ALPHA_REAL_FORGEJO is not 1' };
  const image = exact(env.WP3_FORGEJO_IMAGE, 'WP3_FORGEJO_IMAGE');
  if (!/^(?:sha256:[a-f0-9]{64}|[^\s@]+@sha256:[a-f0-9]{64})$/u.test(image)) {
    throw new Error('WP3_FORGEJO_IMAGE must be an immutable image ID or repository digest');
  }
  const runnerInput = exact(env.WP3_FORGEJO_RUNNER, 'WP3_FORGEJO_RUNNER');
  if (!path.isAbsolute(runnerInput) || runnerInput.startsWith('/mnt/')) {
    throw new Error('WP3_FORGEJO_RUNNER must be an absolute native-Linux path');
  }
  await assertNoSymlinkComponents(runnerInput);
  const runner = await realpath(runnerInput);
  if (runner !== runnerInput) throw new Error('WP3_FORGEJO_RUNNER must not use an alias path');
  const metadata = await stat(runner);
  if (!metadata.isFile() || (metadata.mode & 0o111) === 0) {
    throw new Error('WP3_FORGEJO_RUNNER must be one executable regular file');
  }
  const expectedSha256 = exact(env.WP3_FORGEJO_RUNNER_SHA256, 'WP3_FORGEJO_RUNNER_SHA256');
  if (!/^[a-f0-9]{64}$/u.test(expectedSha256) || await checksum(runner) !== expectedSha256) {
    throw new Error('WP3 Forgejo Runner checksum mismatch');
  }
  return { enabled: true, image, runner, runnerSha256: expectedSha256 };
}

export async function createRunRoot(uuid = randomUUID()) {
  if (!UUID_RE.test(uuid)) throw new Error('run UUID must be canonical version 4');
  await mkdir(WP3_RUN_PARENT, { recursive: true, mode: 0o700 });
  await assertNoSymlinkComponents(WP3_RUN_PARENT);
  await chmod(WP3_RUN_PARENT, 0o700);
  const runRoot = path.join(WP3_RUN_PARENT, uuid);
  await mkdir(runRoot, { mode: 0o700 });
  await writeFile(path.join(runRoot, '.wp3-run-uuid'), `${uuid}\n`, { mode: 0o600, flag: 'wx' });
  await validateRunRoot(runRoot);
  return runRoot;
}

export async function writeManifestAtomic(runRoot, manifest) {
  await validateRunRoot(runRoot);
  assertCredentialFree(manifest);
  const target = path.join(runRoot, 'manifest.json');
  const temporary = path.join(runRoot, `.manifest-${process.pid}-${randomUUID()}.tmp`);
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(serialized);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, target);
  await chmod(target, 0o600);
  return target;
}

export async function readManifest(runRoot) {
  await validateRunRoot(runRoot);
  const file = path.join(runRoot, 'manifest.json');
  const metadata = await lstat(file);
  if (!metadata.isFile() || metadata.nlink !== 1 || (metadata.mode & 0o077) !== 0) {
    throw new Error('WP3 cleanup manifest must be one mode-0600 regular file');
  }
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  assertCredentialFree(manifest);
  if (manifest.runUuid !== path.basename(runRoot) || manifest.runRoot !== runRoot) {
    throw new Error('WP3 cleanup manifest is bound to another run');
  }
  return manifest;
}

function directoryBytes(directory) {
  // du still prints the summary total on stdout when it exits non-zero because
  // some entries were unreadable (rootless overlay work dirs are owned by
  // sub-UIDs). Trust the printed total and fail only when none was produced.
  const result = spawn(['du', '-sb', '--', directory]);
  const bytes = Number(result.stdout.trim().split(/\s+/u)[0]);
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('could not measure storage for the WP3 gate');
  return bytes;
}

export function dockerDataRootBytes(dataRoot) {
  if (!dataRoot) return 0;
  return directoryBytes(dataRoot);
}

export function measureStorage({ runRoot, dockerDataRoot, dockerBaselineBytes }) {
  const dockerCurrentBytes = dockerDataRootBytes(dockerDataRoot);
  const measurement = {
    dockerGrowthBytes: Math.max(0, dockerCurrentBytes - dockerBaselineBytes),
    runRootBytes: directoryBytes(runRoot),
  };
  measurement.combinedBytes = measurement.dockerGrowthBytes + measurement.runRootBytes;
  measurement.stopBeforeNextPhase = measurement.combinedBytes >= WP3_STORAGE_STOP_BYTES;
  measurement.exceeded = measurement.combinedBytes > WP3_STORAGE_LIMIT_BYTES;
  return measurement;
}

export function pidRecordMatches(record, observed) {
  return record
    && observed
    && Number.isSafeInteger(record.pid)
    && record.pid > 1
    && record.pid === observed.pid
    && record.startTime === observed.startTime
    && record.executable === observed.executable
    && (observed.cwd === record.runRoot || observed.cwd.startsWith(`${record.runRoot}/`));
}

export function dockerRecordMatches(record, observed, runUuid) {
  return record
    && observed
    && record.id === observed.id
    && observed.labels?.['io.cyberbaser.fixture'] === 'wp3'
    && observed.labels?.['io.cyberbaser.wp3.run'] === runUuid;
}

async function observedPid(pid) {
  try {
    const statLine = await readFile(`/proc/${pid}/stat`, 'utf8');
    const endName = statLine.lastIndexOf(')');
    const fields = statLine.slice(endName + 2).split(' ');
    return {
      pid,
      startTime: fields[19],
      executable: await realpath(`/proc/${pid}/exe`),
      cwd: await realpath(`/proc/${pid}/cwd`),
    };
  } catch {
    return null;
  }
}

function inspectDocker(kind, id) {
  const format = '{{json .}}';
  const command = kind === 'container'
    ? ['docker', 'container', 'inspect', '--format', format, id]
    : kind === 'volume'
      ? ['docker', 'volume', 'inspect', '--format', format, id]
      : kind === 'image'
        ? ['docker', 'image', 'inspect', '--format', format, id]
        : ['docker', 'network', 'inspect', '--format', format, id];
  const result = spawn(command);
  if (result.exitCode !== 0) return null;
  const value = JSON.parse(result.stdout);
  return {
    id: value.Id ?? value.ID ?? value.Name,
    labels: value.Config?.Labels ?? value.Labels ?? {},
  };
}

function listDockerByLabels(kind, runUuid) {
  const noun = kind === 'container' ? ['container', 'ls', '--all', '--quiet', '--no-trunc']
    : kind === 'volume' ? ['volume', 'ls', '--quiet']
      : kind === 'image' ? ['image', 'ls', '--all', '--quiet', '--no-trunc']
        : ['network', 'ls', '--quiet', '--no-trunc'];
  const result = spawn([
    'docker',
    ...noun,
    '--filter',
    'label=io.cyberbaser.fixture=wp3',
    '--filter',
    `label=io.cyberbaser.wp3.run=${runUuid}`,
  ]);
  if (result.exitCode !== 0) throw new Error(`could not query labelled WP3 ${kind} resources`);
  return [...new Set(result.stdout.trim().split('\n').filter(Boolean))];
}

export async function cleanupFromManifest(runRoot, dependencies = {}) {
  const manifest = await readManifest(runRoot);
  const kill = dependencies.kill ?? process.kill;
  const observePid = dependencies.observePid ?? observedPid;
  const waitForPidExit = dependencies.waitForPidExit ?? (async (record) => {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const observed = await observePid(record.pid);
      if (!pidRecordMatches(record, observed)) return true;
      await Bun.sleep(50);
    }
    return false;
  });
  const inspect = dependencies.inspectDocker ?? inspectDocker;
  const listDocker = dependencies.listDocker ?? listDockerByLabels;
  const removeDocker = dependencies.removeDocker ?? ((kind, id) => {
    const noun = kind === 'container' ? ['container', 'rm', '--force']
      : kind === 'volume' ? ['volume', 'rm', '--force']
        : kind === 'image' ? ['image', 'rm', '--force']
          : ['network', 'rm'];
    const result = spawn(['docker', ...noun, id]);
    if (result.exitCode !== 0) throw new Error(`could not remove recorded ${kind}`);
  });
  const result = {
    stoppedPids: [],
    skippedPids: [],
    reconciledDocker: [],
    removedDocker: [],
    skippedDocker: [],
  };
  for (const record of manifest.processes ?? []) {
    const observed = await observePid(record.pid);
    if (pidRecordMatches(record, observed)) {
      await kill(record.pid, 'SIGTERM');
      if (!await waitForPidExit(record)) {
        throw new Error('recorded WP3 process did not stop before cleanup continued');
      }
      result.stoppedPids.push(record.pid);
    } else {
      result.skippedPids.push(record.pid);
    }
  }
  // Images are removed last so no recorded container still references them.
  const dockerKinds = ['container', 'volume', 'network', 'image'];
  let manifestReconciled = false;
  for (const kind of dockerKinds) {
    const key = `${kind}s`;
    const records = manifest.docker?.[key] ?? (kind === 'image' ? (manifest.docker.images = []) : null);
    if (!manifest.docker || !Array.isArray(records)) {
      throw new Error('WP3 cleanup manifest Docker records are invalid');
    }
    const recordedIds = new Set(records.map((record) => record.id));
    const candidates = await listDocker(kind, manifest.runUuid);
    for (const id of candidates) {
      const observed = await inspect(kind, id);
      // Compose-created resources carry the project label. Runner-created job
      // containers and the run-scoped job image instead carry the exact
      // io.cyberbaser.wp3.role label injected by the reviewed runner contract.
      const roleLabel = observed?.labels?.['io.cyberbaser.wp3.role'];
      const provenanceMatches = observed?.labels?.['com.docker.compose.project'] === manifest.composeProject
        || roleLabel === 'job'
        || roleLabel === 'job-image';
      if (!recordedIds.has(id)) {
        if (manifest.docker.creationAuthorized !== true
          || observed?.labels?.['io.cyberbaser.fixture'] !== 'wp3'
          || observed?.labels?.['io.cyberbaser.wp3.run'] !== manifest.runUuid
          || !provenanceMatches) {
          throw new Error(`labelled WP3 ${kind} is absent from the atomic run manifest`);
        }
        records.push({ id });
        recordedIds.add(id);
        result.reconciledDocker.push(`${kind}:${id}`);
        manifestReconciled = true;
      }
      const record = records.find((entry) => entry.id === id);
      if (!dockerRecordMatches(record, observed, manifest.runUuid)) {
        throw new Error(`labelled WP3 ${kind} identity does not match the atomic run manifest`);
      }
    }
  }
  if (manifestReconciled) await writeManifestAtomic(runRoot, manifest);
  for (const kind of dockerKinds) {
    const records = manifest.docker?.[`${kind}s`] ?? [];
    for (const record of records) {
      const observed = await inspect(kind, record.id);
      if (dockerRecordMatches(record, observed, manifest.runUuid)) {
        await removeDocker(kind, record.id);
        result.removedDocker.push(`${kind}:${record.id}`);
      } else {
        result.skippedDocker.push(`${kind}:${record.id}`);
      }
    }
    const remaining = await listDocker(kind, manifest.runUuid);
    if (remaining.length > 0) {
      throw new Error(`labelled WP3 ${kind} resources remain after manifest-bound cleanup`);
    }
  }
  if (typeof dependencies.beforeRunRootRemoval === 'function') {
    result.beforeRunRootRemoval = await dependencies.beforeRunRootRemoval(manifest);
  }
  if (dependencies.removeRunRoot === true) {
    await validateRunRoot(runRoot);
    // The tool allowlist is deliberately made read-only (chmod -R a-w), which
    // also strips directory write bits and would block recursive removal.
    // Restore owner write across the run root before deleting it.
    spawn(['chmod', '-R', 'u+rwX', '--', runRoot]);
    await rm(runRoot, { recursive: true });
  }
  return result;
}

async function writeLockOwner(lock, owner) {
  assertCredentialFree(owner);
  const target = path.join(lock, 'owner.json');
  const temporary = path.join(lock, `.owner-${process.pid}-${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(owner)}\n`, { mode: 0o600, flag: 'wx' });
  await rename(temporary, target);
  await chmod(target, 0o600);
}

function sameProcessIdentity(record, observed) {
  return record
    && observed
    && record.pid === observed.pid
    && record.startTime === observed.startTime
    && record.executable === observed.executable;
}

async function acquireGlobalLock() {
  const lock = path.join(WP3_RUN_PARENT, '.fixture-lock');
  await mkdir(WP3_RUN_PARENT, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir(lock, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let stale;
      try {
        stale = JSON.parse(await readFile(path.join(lock, 'owner.json'), 'utf8'));
      } catch {
        throw new Error('WP3 fixture lock exists without a valid atomic owner record');
      }
      const observed = await observedPid(stale.pid);
      if (sameProcessIdentity(stale, observed)) throw new Error('another WP3 Forgejo fixture is active');
      if (stale.runRoot !== null) {
        try {
          await stat(stale.runRoot);
          await cleanupFromManifest(stale.runRoot, { removeRunRoot: true });
        } catch (cleanupError) {
          if (cleanupError?.code !== 'ENOENT') {
            throw new Error(`stale WP3 fixture cleanup failed: ${cleanupError.message}`);
          }
        }
      }
      await rm(lock, { recursive: true });
      continue;
    }
    const observed = await observedPid(process.pid);
    if (!observed) throw new Error('could not bind the WP3 fixture lock to this process');
    const owner = {
      pid: process.pid,
      startTime: observed.startTime,
      executable: observed.executable,
      runRoot: null,
    };
    await writeLockOwner(lock, owner);
    return {
      async setRunRoot(runRoot) {
        owner.runRoot = exact(runRoot, 'lock run root');
        await writeLockOwner(lock, owner);
      },
      async release() {
        const current = JSON.parse(await readFile(path.join(lock, 'owner.json'), 'utf8'));
        const currentProcess = await observedPid(process.pid);
        if (!sameProcessIdentity(current, currentProcess)) {
          throw new Error('WP3 fixture lock ownership changed before release');
        }
        await rm(lock, { recursive: true });
      },
    };
  }
  throw new Error('could not recover the stale WP3 fixture lock');
}

async function main() {
  const gate = await validateGateEnvironment();
  if (!gate.enabled) {
    console.log(JSON.stringify({ status: 'skipped', reason: gate.reason }));
    return;
  }
  // Structural isolation gate: the contract builder can only express
  // container-mode execution, and the assertion rejects any host-mode or
  // authority-granting variation before a lock, run root, or resource exists.
  const sampleUuid = '00000000-0000-4000-8000-000000000000';
  assertRunnerIsolation(runnerExecutionContract({
    runUuid: sampleUuid,
    jobImageTag: `wp3-job-${sampleUuid}`,
    composeProject: `cyberbaser-wp3-${sampleUuid}`,
    toolRoot: path.join(WP3_RUN_PARENT, sampleUuid, 'tools'),
    publicationRoot: path.join(WP3_RUN_PARENT, sampleUuid, 'publication'),
    forgeInternalOrigin: 'https://forgejo-wp3:3000',
    hostHome: process.env.HOME ?? '/root',
  }));
  // The reviewed boundary runs the Forgejo container and job containers as
  // container 0:0 so they own their fresh rootless volumes and mounts. That
  // maps to the unprivileged host user only on a rootless daemon; on a rootful
  // daemon it would be real root, so the gate fails closed there.
  const security = spawn(['docker', 'info', '--format', '{{json .SecurityOptions}}']);
  if (security.exitCode !== 0 || !security.stdout.includes('name=rootless')) {
    throw new Error('WP3 real gate requires a rootless Docker daemon');
  }
  const imagePresent = spawn(['docker', 'image', 'inspect', '--format', '{{.Id}}', gate.image]);
  if (imagePresent.exitCode !== 0) {
    throw new Error('WP3_FORGEJO_IMAGE is not present in the local engine; stage it explicitly before the gate');
  }
  const fixtureLock = await acquireGlobalLock();
  let runRoot = null;
  let runRootRemoved = false;
  let child = null;
  let interruptedBy = null;
  let result = { status: 'failed', reason: 'acceptance did not start' };
  const signalHandlers = new Map();
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    const handler = () => {
      if (interruptedBy === null) interruptedBy = signal;
      try { child?.kill(signal); } catch {}
    };
    signalHandlers.set(signal, handler);
    process.once(signal, handler);
  }
  try {
    const runUuid = randomUUID();
    runRoot = path.join(WP3_RUN_PARENT, runUuid);
    await fixtureLock.setRunRoot(runRoot);
    runRoot = await createRunRoot(runUuid);
    const manifest = {
      schemaVersion: 1,
      runUuid,
      runRoot,
      composeProject: `cyberbaser-wp3-${runUuid}`,
      markerPath: path.join(runRoot, '.wp3-run-uuid'),
      processes: [],
      docker: { creationAuthorized: false, containers: [], volumes: [], networks: [] },
      secretFiles: [],
      storage: { dataRoot: null, baseline: null, peak: 0, measurements: [] },
      repositories: {},
    };
    await writeManifestAtomic(runRoot, manifest);
    const stagedRunner = await stageRunnerBinary(runRoot, gate.runner, gate.runnerSha256);
    if (interruptedBy !== null) throw new Error(`WP3 fixture interrupted by ${interruptedBy}`);
    child = Bun.spawn([
      process.execPath,
      path.join(import.meta.dir, 'acceptance-child.js'),
      runRoot,
      gate.image,
      stagedRunner,
      gate.runnerSha256,
      String(process.pid),
    ], {
      cwd: path.resolve(import.meta.dir, '../../..'),
      stdin: 'ignore',
      stdout: process.env.WP3_DIAG === '1' ? 'inherit' : 'ignore',
      stderr: process.env.WP3_DIAG === '1' ? 'inherit' : 'ignore',
    });
    if (interruptedBy !== null) child.kill(interruptedBy);
    const exitCode = await child.exited;
    const resultFile = path.join(runRoot, 'result.json');
    try {
      const metadata = await stat(resultFile);
      if (metadata.size > WP3_RESULT_MAX_BYTES) throw new Error('sanitized integration result exceeded 8 MiB');
      result = JSON.parse(await readFile(resultFile, 'utf8'));
      assertCredentialFree(result);
    } catch (error) {
      result = { status: 'failed', reason: error.message, childExitCode: exitCode };
    }
    if (exitCode !== 0) result = { ...result, status: 'failed', childExitCode: exitCode };
    const cleanup = await cleanupFromManifest(runRoot, {
      removeRunRoot: true,
      beforeRunRootRemoval: async (currentManifest) => {
        // An early child failure never records a storage baseline. Skip the
        // after-teardown measurement in that case rather than masking the real
        // child reason with a storage error.
        if (typeof currentManifest.storage?.dataRoot !== 'string'
          || !Number.isSafeInteger(currentManifest.storage?.baseline)) {
          return null;
        }
        const measurement = measureStorage({
          runRoot,
          dockerDataRoot: currentManifest.storage.dataRoot,
          dockerBaselineBytes: currentManifest.storage.baseline,
        });
        if (measurement.exceeded) throw new Error(`WP3 storage exceeded ${WP3_STORAGE_LIMIT_BYTES} bytes after teardown`);
        return measurement;
      },
    });
    runRootRemoved = true;
    const afterTeardown = cleanup.beforeRunRootRemoval;
    const previousPeak = Number.isSafeInteger(result.storage?.peakBytes) ? result.storage.peakBytes : 0;
    result = {
      ...result,
      storage: {
        ...(result.storage ?? {}),
        peakBytes: Math.max(previousPeak, afterTeardown?.combinedBytes ?? 0),
        limitBytes: WP3_STORAGE_LIMIT_BYTES,
        afterTeardownBytes: afterTeardown?.combinedBytes ?? null,
      },
      cleanup: {
        complete: true,
        stoppedProcesses: cleanup.stoppedPids.length,
        removedResources: cleanup.removedDocker.length,
        skippedProcesses: cleanup.skippedPids.length,
        skippedResources: cleanup.skippedDocker.length,
      },
    };
    assertCredentialFree(result);
  } catch (error) {
    result = { ...result, status: 'failed', reason: error.message };
    assertCredentialFree(result);
  } finally {
    if (runRoot !== null && !runRootRemoved) {
      let runRootExists = true;
      try {
        await stat(path.join(runRoot, 'manifest.json'));
      } catch (error) {
        if (error?.code === 'ENOENT') runRootExists = false;
      }
      if (!runRootExists) {
        // A prior cleanup pass already removed the manifest and run root; treat
        // teardown as complete rather than failing on the missing manifest.
        runRootRemoved = true;
        await rm(runRoot, { recursive: true, force: true });
      } else {
        try {
          await cleanupFromManifest(runRoot, { removeRunRoot: true });
          runRootRemoved = true;
        } catch (error) {
          result = {
            ...result,
            status: 'failed',
            reason: `WP3 cleanup failed: ${error.message}`,
            cleanup: { complete: false },
          };
        }
      }
    }
    try {
      await fixtureLock.release();
    } catch (error) {
      result = {
        ...result,
        status: 'failed',
        reason: `WP3 fixture lock release failed: ${error.message}`,
        cleanup: { complete: false },
      };
    }
    for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
  }
  if (interruptedBy !== null && result.status !== 'passed') {
    result = { ...result, reason: `WP3 fixture interrupted by ${interruptedBy}: ${result.reason}` };
  }
  console.log(JSON.stringify(result));
  if (result.status !== 'passed' && result.status !== 'skipped') process.exitCode = 1;
}

if (import.meta.main) {
  await main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

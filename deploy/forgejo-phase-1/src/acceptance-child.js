import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  chmod,
  cp,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import https from 'node:https';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  assertCredentialFree,
  assertRunnerIsolation,
  forgejoRunOutcome,
  measureStorage,
  readManifest,
  runnerExecutionContract,
  validateRunRoot,
  WP3_STORAGE_LIMIT_BYTES,
  writeManifestAtomic,
  writePrivateCheckoutTool,
} from './harness.js';
import {
  assertCheckoutReady,
  computePolicyRevision,
  defineStoreContext,
  deriveEditorOperation,
  pipelineArtifactPaths,
  readJsonArtifact,
  runOwnerAlphaPipeline,
  validateOwnerAlphaConfig,
} from '../../../apps/owner-alpha/src/index.js';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(import.meta.dir, '../../..');
const COMPOSE = path.join(ROOT, 'deploy', 'forgejo-phase-1', 'compose.yaml');
const FIXTURE = path.join(ROOT, 'deploy', 'forgejo-phase-1', 'fixtures', 'repository');
const runRoot = await validateRunRoot(process.argv[2]);
const image = process.argv[3];
const runnerBinary = await realpath(process.argv[4]);
const expectedRunnerSha = process.argv[5];
const expectedParentPid = Number(process.argv[6]);
if (!Number.isSafeInteger(expectedParentPid) || expectedParentPid < 2 || process.ppid !== expectedParentPid) {
  throw new Error('WP3 acceptance child is not bound to the harness process');
}
const runUuid = path.basename(runRoot);
const forgeOrigin = 'https://127.0.0.1:8443';
const forgeInternalOrigin = 'https://forgejo-wp3:3000';
const liveOrigin = 'https://127.0.0.3:8443';
const owner = 'wp3-owner';
const repository = `fixture-${runUuid.slice(0, 8)}`;
const slug = `${owner}/${repository}`;
const oldWitness = 'The owner-controlled publication still contains the old fixture wording.';
const prWitness = 'The owner-controlled publication passed the controlled Forgejo PR gate.';
const saveWitness = 'The owner-controlled publication passed the exact owner-alpha Forgejo Save.';
const PINNED_FORGEJO_FIXTURE_VERSION = /^16\.0\.2(?:[-+][0-9A-Za-z.-]+)?$/u;
let manifest = await readManifest(runRoot);
let secretMaterials = [];
const liveChildren = new Set();
let shutdownSignal = null;

function trackChild(child) {
  liveChildren.add(child);
  void child.exited.finally(() => liveChildren.delete(child));
  return child;
}

async function stopLiveChildren() {
  const children = [...liveChildren];
  for (const child of children) {
    try { child.kill('SIGTERM'); } catch {}
  }
  await Promise.all(children.map(async (child) => {
    await Promise.race([child.exited.catch(() => null), Bun.sleep(5_000)]);
    if (liveChildren.has(child)) {
      try { child.kill('SIGKILL'); } catch {}
      await child.exited.catch(() => null);
    }
  }));
}

function releaseLiveChildrenToHarness() {
  for (const child of liveChildren) child.unref();
}

for (const [signal, exitCode] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
  process.once(signal, () => {
    if (shutdownSignal !== null) return;
    shutdownSignal = signal;
    void stopLiveChildren().finally(() => process.exit(exitCode));
  });
}
const parentWatchdog = setInterval(() => {
  if (process.ppid === expectedParentPid || shutdownSignal !== null) return;
  shutdownSignal = 'parent-exit';
  void stopLiveChildren().finally(() => process.exit(143));
}, 250);
parentWatchdog.unref();

function safeResult(value) {
  assertCredentialFree(value, secretMaterials);
  return value;
}

async function persistManifest() {
  await writeManifestAtomic(runRoot, manifest);
}

async function command(args, { cwd = ROOT, env = process.env, input } = {}) {
  try {
    const result = await execFileAsync(args[0], args.slice(1), {
      cwd,
      env,
      input,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    if (process.env.WP3_DIAG === '1') {
      const detail = `${error.stderr ?? ''}${error.stdout ?? ''}`.trim().slice(-1200);
      process.stderr.write(`WP3 command diag [${args.join(' ')}]:\n${detail}\n`);
    }
    throw new Error(`${args[0]} ${args[1] ?? ''} failed (${error.code ?? 'unknown'})`);
  }
}

async function sha256(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

function duBytes(directory) {
  const result = Bun.spawnSync({ cmd: ['du', '-sb', '--', directory], stdout: 'pipe', stderr: 'ignore' });
  const total = Number(result.stdout.toString().trim().split(/\s+/u)[0]);
  if (!Number.isSafeInteger(total) || total < 0) throw new Error('could not measure Docker data-root storage');
  return total;
}

async function secretFile(name, value) {
  const directory = path.join(runRoot, 'secrets');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, name);
  await writeFile(file, `${value}\n`, { mode: 0o600, flag: 'wx' });
  await chmod(file, 0o600);
  secretMaterials.push(value);
  manifest.secretFiles.push(file);
  await persistManifest();
  return file;
}

async function readSecret(file) {
  const metadata = await stat(file);
  if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) throw new Error('secret file permission mismatch');
  return (await readFile(file, 'utf8')).trimEnd();
}

async function reserve(address) {
  const { createServer } = await import('node:net');
  const server = createServer();
  await new Promise((resolve, reject) => server.listen(8443, address, resolve).once('error', reject));
  await new Promise((resolve) => server.close(resolve));
}

async function makeCertificates() {
  const tls = path.join(runRoot, 'tls');
  await mkdir(path.join(tls, 'forgejo'), { recursive: true, mode: 0o700 });
  await mkdir(path.join(tls, 'published'), { recursive: true, mode: 0o700 });
  const caKey = path.join(tls, 'ca.key');
  const caCert = path.join(tls, 'ca.crt');
  // ECDSA P-256, not Ed25519: Bun's TLS stack (used by the owner-alpha deployment
  // observer's fetch) rejects an Ed25519 certificate chain that OpenSSL accepts.
  const ecKey = (out) => ['openssl', 'genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', out];
  await command(ecKey(caKey));
  await chmod(caKey, 0o600);
  await command(['openssl', 'req', '-x509', '-new', '-key', caKey, '-out', caCert, '-days', '2', '-subj', `/CN=cyberbaser-wp3-${runUuid}`]);
  for (const [name, address] of [['forgejo', '127.0.0.1'], ['published', '127.0.0.3']]) {
    const directory = path.join(tls, name);
    const key = path.join(directory, 'server.key');
    const csr = path.join(directory, 'server.csr');
    const cert = path.join(directory, 'server.crt');
    const extensions = path.join(directory, 'extensions.cnf');
    // Job containers reach the Forgejo server through the labelled-network DNS
    // alias forgejo-wp3, so its certificate must also attest that name.
    const san = name === 'forgejo' ? `IP:${address},DNS:forgejo-wp3` : `IP:${address}`;
    await writeFile(extensions, `subjectAltName=${san}\nextendedKeyUsage=serverAuth\n`, { mode: 0o600 });
    await command(ecKey(key));
    // The Forgejo key is mounted read-only into a foreign-UID rootless
    // container, so it must be world-readable. It is a throwaway two-day
    // loopback certificate. The published key stays 0600 for the host reader.
    await chmod(key, name === 'forgejo' ? 0o644 : 0o600);
    await command(['openssl', 'req', '-new', '-key', key, '-out', csr, '-subj', `/CN=${address}`]);
    await command(['openssl', 'x509', '-req', '-in', csr, '-CA', caCert, '-CAkey', caKey, '-CAcreateserial', '-out', cert, '-days', '2', '-extfile', extensions]);
    await rm(csr, { force: true });
    if (name === 'forgejo') {
      // The bind mount exposes this directory to the foreign-UID container with
      // its host permissions, so the directory and both throwaway loopback
      // certificate files must be traversable and readable by that UID.
      await chmod(cert, 0o644);
      await chmod(directory, 0o755);
    }
  }
  return { tls, caCert };
}

async function apiRequest({ method = 'GET', pathname, tokenFile = null, basic = null, body = null, ca }) {
  const payload = body === null ? null : Buffer.from(JSON.stringify(body));
  const headers = { Accept: 'application/json', 'User-Agent': 'cyberbaser-wp3-fixture' };
  if (payload) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = String(payload.length);
  }
  if (tokenFile) headers.Authorization = `token ${await readSecret(tokenFile)}`;
  if (basic) headers.Authorization = `Basic ${Buffer.from(`${basic.username}:${await readSecret(basic.passwordFile)}`).toString('base64')}`;
  return new Promise((resolve, reject) => {
    const request = https.request({
      hostname: '127.0.0.1',
      port: 8443,
      path: pathname,
      method,
      headers,
      ca,
      rejectUnauthorized: true,
      servername: '',
    }, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) request.destroy(new Error('Forgejo setup response exceeded 2 MiB'));
        else chunks.push(Buffer.from(chunk));
      });
      response.once('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let value = null;
        if (text) {
          try { value = JSON.parse(text); } catch { reject(new Error('Forgejo setup returned invalid JSON')); return; }
        }
        resolve({ status: response.statusCode, value });
      });
    });
    request.once('error', reject);
    request.setTimeout(15_000, () => request.destroy(new Error('Forgejo setup request timed out')));
    if (payload) request.write(payload);
    request.end();
  });
}

async function requireApi(options, allowed = [200, 201]) {
  const response = await apiRequest(options);
  if (!allowed.includes(response.status)) throw new Error(`Forgejo setup API returned HTTP ${response.status}`);
  return response.value;
}

async function waitForForgejo(ca) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const response = await apiRequest({ pathname: '/api/v1/version', ca });
      if (response.status === 200 && PINNED_FORGEJO_FIXTURE_VERSION.test(response.value?.version)) return response.value.version;
      if (response.status === 200 && typeof response.value?.version === 'string') {
        throw new Error('WP3 fixture requires the explicitly reviewed Forgejo 16.0.2 release');
      }
    } catch (error) {
      if (error?.message === 'WP3 fixture requires the explicitly reviewed Forgejo 16.0.2 release') throw error;
    }
    await Bun.sleep(500);
  }
  throw new Error('Forgejo did not become ready');
}

async function processRecord(child, executable) {
  const statLine = await readFile(`/proc/${child.pid}/stat`, 'utf8');
  const fields = statLine.slice(statLine.lastIndexOf(')') + 2).split(' ');
  return {
    pid: child.pid,
    startTime: fields[19],
    executable: await realpath(executable),
    runRoot,
  };
}

async function recordComposeResources(composeProject) {
  const kinds = [
    ['containers', ['docker', 'container', 'ls', '--all', '--quiet', '--no-trunc', '--filter', 'label=io.cyberbaser.fixture=wp3', '--filter', `label=io.cyberbaser.wp3.run=${runUuid}`]],
    ['volumes', ['docker', 'volume', 'ls', '--quiet', '--filter', 'label=io.cyberbaser.fixture=wp3', '--filter', `label=io.cyberbaser.wp3.run=${runUuid}`]],
    ['networks', ['docker', 'network', 'ls', '--quiet', '--no-trunc', '--filter', 'label=io.cyberbaser.fixture=wp3', '--filter', `label=io.cyberbaser.wp3.run=${runUuid}`]],
  ];
  manifest.composeProject = composeProject;
  for (const [key, args] of kinds) {
    const ids = (await command(args)).stdout.trim().split('\n').filter(Boolean);
    manifest.docker[key] = ids.map((id) => ({ id }));
  }
  await persistManifest();
}

async function measure(phase, dockerDataRoot) {
  const measurement = measureStorage({
    runRoot,
    dockerDataRoot,
    dockerBaselineBytes: manifest.storage.baseline,
  });
  manifest.storage.measurements.push({ phase, ...measurement });
  manifest.storage.peak = Math.max(manifest.storage.peak, measurement.combinedBytes);
  await persistManifest();
  if (measurement.exceeded) throw new Error(`WP3 storage exceeded ${WP3_STORAGE_LIMIT_BYTES} bytes`);
  if (measurement.stopBeforeNextPhase) throw new Error('WP3 storage reached the 3.5 GiB stop threshold');
}

async function repositorySnapshot(bare) {
  const refs = (await command(['git', '-C', bare, 'show-ref'])).stdout;
  const objects = (await command(['git', '-C', bare, 'rev-list', '--objects', '--all'])).stdout;
  return createHash('sha256').update(refs).update('\0').update(objects).digest('hex');
}

async function prepareAuthoritativeRepository() {
  const repositories = path.join(runRoot, 'repositories');
  const bare = path.join(repositories, 'authoritative.git');
  const work = path.join(repositories, 'seed-work');
  await mkdir(repositories, { recursive: true, mode: 0o700 });
  await command(['git', 'init', '--bare', '--quiet', '--initial-branch=main', bare]);
  await mkdir(work, { mode: 0o700 });
  await cp(FIXTURE, work, { recursive: true });
  await command(['git', 'init', '--quiet', '--initial-branch=main'], { cwd: work });
  await command(['git', 'config', 'user.name', 'Cyberbaser WP3 Fixture'], { cwd: work });
  await command(['git', 'config', 'user.email', 'wp3@example.invalid'], { cwd: work });
  await command(['git', 'add', '--all'], { cwd: work });
  await command(['git', 'commit', '--quiet', '-m', 'WP3 fixture seed'], { cwd: work });
  await command(['git', 'remote', 'add', 'origin', bare], { cwd: work });
  await command(['git', 'push', '--quiet', 'origin', 'main'], { cwd: work });
  const baseCommit = (await command(['git', '-C', bare, 'rev-parse', 'refs/heads/main'])).stdout.trim();
  const snapshot = await repositorySnapshot(bare);
  manifest.repositories.authoritative = { path: bare, baseCommit, snapshot };
  await persistManifest();
  return { bare, work, baseCommit, snapshot };
}

async function createToken({ ca, adminPasswordFile, name, scopes }) {
  const value = await requireApi({
    method: 'POST',
    pathname: `/api/v1/users/${owner}/tokens`,
    basic: { username: owner, passwordFile: adminPasswordFile },
    body: { name, scopes },
    ca,
  });
  if (typeof value?.sha1 !== 'string' || value.sha1.length < 20) throw new Error('Forgejo did not return a bounded token');
  return secretFile(`${name}.token`, value.sha1);
}

async function writeCredentialHelper(tokenFile) {
  const helper = path.join(runRoot, 'git-credential-wp3');
  await writeFile(helper, `#!/usr/bin/env bash\nset -euo pipefail\ncase "\${1:-}" in\n  get) printf 'username=%s\\npassword=%s\\n' '${owner}' "$(< ${JSON.stringify(tokenFile)})" ;;\n  store|erase) exit 0 ;;\n  *) exit 1 ;;\nesac\n`, { mode: 0o700 });
  await chmod(helper, 0o700);
  return helper;
}

function gitCredentialEnvironment(helper, caCert) {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: `!${helper}`,
    GIT_CONFIG_KEY_1: 'http.sslCAInfo',
    GIT_CONFIG_VALUE_1: caCert,
  };
}

async function createToolAllowlist(caCert) {
  const root = path.join(runRoot, 'tools');
  await mkdir(root, { mode: 0o700 });
  await cp(path.join(ROOT, 'packages', 'ofm'), path.join(root, 'ofm'), { recursive: true });
  await cp(path.join(ROOT, 'packages', 'trust'), path.join(root, 'trust'), { recursive: true });
  // Bun's file dependency install uses absolute links back to the source package.
  // Replace only that copied dependency with a relative link inside the allowlist
  // so the trust package resolves the exact staged OFM bytes in the container.
  const stagedTrustOfm = path.join(root, 'trust', 'node_modules', '@cyberbaser', 'ofm');
  await rm(stagedTrustOfm, { recursive: true, force: true });
  await symlink('../../../ofm', stagedTrustOfm, 'dir');
  // The job container mounts this allowlist read-only, so the CA it needs to
  // trust the in-network Forgejo TLS endpoint travels with the tools.
  await cp(caCert, path.join(root, 'ca.crt'));
  // Job containers run the pinned Bun base, so the tool wrappers invoke bun
  // against the mounted paths inside the container namespace.
  await writeFile(path.join(root, 'ofm-check'), `#!/usr/bin/env bash\nexec bun ${JSON.stringify(path.join('/wp3/tools', 'ofm', 'bin', 'ofm-check.js'))} "$@"\n`, { mode: 0o500 });
  await writeFile(path.join(root, 'cb-trust'), `#!/usr/bin/env bash\nexec bun ${JSON.stringify(path.join('/wp3/tools', 'trust', 'bin', 'cb-trust.js'))} "$@"\n`, { mode: 0o500 });
  await writePrivateCheckoutTool(root);
  await command(['chmod', '-R', 'a-w', '--', root]);
  return root;
}

async function buildJobImage(jobImageTag) {
  const context = path.join(runRoot, 'job-image-context');
  await mkdir(context, { mode: 0o700 });
  await cp(path.join(ROOT, 'deploy', 'forgejo-phase-1', 'job-image', 'Containerfile'), path.join(context, 'Containerfile'));
  await command([
    'docker', 'build',
    '--file', path.join(context, 'Containerfile'),
    '--tag', jobImageTag,
    '--label', 'io.cyberbaser.fixture=wp3',
    '--label', `io.cyberbaser.wp3.run=${runUuid}`,
    '--label', 'io.cyberbaser.wp3.role=job-image',
    '--',
    context,
  ]);
  const imageId = (await command(['docker', 'image', 'inspect', '--format', '{{.Id}}', jobImageTag])).stdout.trim();
  manifest.docker.images = [{ id: imageId }];
  await persistManifest();
  return jobImageTag;
}

async function startStaticServer() {
  const child = trackChild(Bun.spawn([process.execPath, path.join(import.meta.dir, 'static-server.js'), runRoot], {
    cwd: runRoot,
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
  }));
  manifest.processes.push(await processRecord(child, process.execPath));
  await persistManifest();
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await Bun.file(path.join(runRoot, 'static-server.ready')).exists()) return child;
    if (await Promise.race([child.exited.then(() => true), Bun.sleep(100).then(() => false)])) throw new Error('static server exited early');
  }
  throw new Error('static server readiness timed out');
}

async function waitForPullRequestRuns({ ca, adminTokenFile, commit }) {
  const expectedWorkflows = ['ofm-check.yml', 'trust-gate.yml'];
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const runs = await requireApi({ pathname: `/api/v1/repos/${slug}/actions/runs?head_sha=${commit}&limit=20`, tokenFile: adminTokenFile, ca });
    const matching = (runs?.workflow_runs ?? []).filter((run) => (
      run.commit_sha === commit
      && run.event === 'pull_request'
      && run.trigger_event === 'pull_request'
      && run.repository?.full_name === slug
      && expectedWorkflows.includes(run.workflow_id)
    ));
    if (new Set(matching.map((run) => run.workflow_id)).size !== matching.length) {
      throw new Error('controlled PR produced duplicate workflow runs');
    }
    const outcomes = new Map(matching.map((run) => [run.workflow_id, forgejoRunOutcome(run)]));
    for (const workflow of expectedWorkflows) {
      const outcome = outcomes.get(workflow);
      if (outcome !== undefined && outcome !== null && outcome !== 'success') {
        throw new Error(`controlled PR workflow ${workflow} concluded ${outcome}`);
      }
    }
    if (expectedWorkflows.every((workflow) => outcomes.get(workflow) === 'success')) return;
    await Bun.sleep(500);
  }
  throw new Error('controlled PR workflows timed out');
}

async function waitForBranchRun({ ca, adminTokenFile, branch, headSha }) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const runs = await requireApi({ pathname: `/api/v1/repos/${slug}/actions/runs?branch=${encodeURIComponent(branch)}&limit=20`, tokenFile: adminTokenFile, ca });
    const match = (runs?.workflow_runs ?? []).find((run) => run.commit_sha === headSha);
    if (match) {
      const outcome = forgejoRunOutcome(match);
      if (outcome !== null) {
        if (outcome !== 'success') throw new Error(`${branch} run concluded ${outcome}`);
        return match;
      }
    }
    await Bun.sleep(500);
  }
  throw new Error(`${branch} run did not complete`);
}

async function runIsolationProbe({ gitEnv, adminTokenFile, ca }) {
  const probe = path.join(runRoot, 'repositories', 'isolation-probe');
  await command(['git', 'clone', '--quiet', `${forgeOrigin}/${slug}.git`, probe], { env: gitEnv });
  await command(['git', 'config', 'user.name', 'Cyberbaser WP3 Fixture'], { cwd: probe });
  await command(['git', 'config', 'user.email', 'wp3@example.invalid'], { cwd: probe });
  await command(['git', 'checkout', '--quiet', '-b', 'isolation-probe'], { cwd: probe });
  // An empty commit is enough to trigger the push-scoped probe workflow without
  // altering tracked content.
  await command(['git', 'commit', '--quiet', '--allow-empty', '-m', 'WP3 isolation probe'], { cwd: probe });
  const headSha = (await command(['git', 'rev-parse', 'HEAD'], { cwd: probe })).stdout.trim();
  await command(['git', 'push', '--quiet', '--set-upstream', 'origin', 'isolation-probe'], { cwd: probe, env: gitEnv });
  await waitForBranchRun({ ca, adminTokenFile, branch: 'isolation-probe', headSha });
}

async function liveText(ca) {
  return new Promise((resolve, reject) => {
    https.get({ hostname: '127.0.0.3', port: 8443, path: '/', ca, rejectUnauthorized: true, servername: '' }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    }).once('error', reject);
  });
}

async function waitForLive(ca, oldText, newText) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    try {
      const html = await liveText(ca);
      if (!html.includes(oldText) && html.split(newText).length === 2) return true;
    } catch {}
    await Bun.sleep(500);
  }
  throw new Error('live witness did not transition exactly');
}

function digest(bytes) {
  return `sha-256=:${createHash('sha256').update(bytes).digest('base64')}:`;
}

async function ownerAlphaSave({ checkout, observerTokenFile, helper, caCert }) {
  const sourcePath = 'content/page.md';
  const baseCommit = (await command(['git', '-C', checkout, 'rev-parse', 'HEAD'])).stdout.trim();
  const baseBytes = await readFile(path.join(checkout, sourcePath));
  const editedText = baseBytes.toString('utf8').replace(prWitness, saveWitness);
  const rawConfig = {
    schemaVersion: 1,
    listen: { host: '127.0.0.1', port: 4317 },
    repository: { checkout, remote: { name: 'origin', url: `${forgeOrigin}/${slug}.git` }, branch: 'main' },
    owner: { identity: owner, allowedTrustRoutes: ['auto-merge'] },
    live: { baseUrl: `${liveOrigin}/` },
    workflow: {
      provider: 'forgejo-actions', apiBaseUrl: `${forgeOrigin}/api/v1`, repository: slug,
      path: '.forgejo/workflows/publish-site.yml', event: 'push', branch: 'main', jobs: ['build', 'deploy'], deploymentJob: 'deploy',
    },
    workspace: { root: '.workspace/owner-alpha', store: '.workspace/owner-alpha/store', site: '.workspace/owner-alpha/site', cache: '.workspace/owner-alpha/cache' },
    paths: { include: ['content/**/*.md'], exclude: ['.git/**', '.workspace/**'] },
    limits: { maxSourceBytes: 2097152, maxReplacementBytes: 65536, maxChangedBytes: 65536, maxChangedLines: 60, maxArtifactBytes: 8388608, requestTimeoutMs: 250, networkTimeoutMs: 180000 },
    checks: { allowedOfmVerdicts: ['clean'], requirePublishedSource: true, requireProjectionVerification: true, requireNoNewBrokenLinks: true, requireRenderedWitness: true },
    git: { autoCommit: true, autoPush: true, useHooks: false, commitMessagePrefix: 'owner-alpha:' },
  };
  const config = validateOwnerAlphaConfig(rawConfig);
  const object = (await command(['git', '-C', checkout, 'ls-tree', 'HEAD', '--', sourcePath])).stdout.trim().match(/^([0-7]{6}) blob ([0-9a-f]{40})\t/u);
  const session = {
    schemaVersion: 1,
    artifactType: 'owner-alpha-edit-session',
    relativePath: sourcePath,
    slug: 'content/page',
    liveUrl: `${liveOrigin}/`,
    baseCommit,
    policyRevision: computePolicyRevision(config),
    source: {
      text: baseBytes.toString('utf8'), bytesBase64: baseBytes.toString('base64'), byteLength: baseBytes.length,
      digest: digest(baseBytes), gitMode: object[1], gitObjectId: object[2], frontmatter: null,
    },
  };
  const operation = deriveEditorOperation({ session, editedText, config });
  const context = defineStoreContext({
    projectRoot: checkout,
    workspaceRoot: path.join(checkout, config.workspace.root),
    storeRoot: path.join(checkout, config.workspace.store),
  });
  const gitEnv = gitCredentialEnvironment(helper, caCert);
  const git = async (directory, args, options = {}) => {
    const result = await command(['git', '-C', directory, ...args], { env: { ...gitEnv, ...(options.env ?? {}) } });
    const encoding = options.encoding ?? 'buffer';
    return encoding === 'buffer' ? Buffer.from(result.stdout) : result.stdout.trim();
  };
  const inspectGit = (directory, args, options = {}) => git(directory, args, {
    ...options,
    encoding: options.encoding ?? 'utf8',
  });
  const jobId = `WP3-${runUuid}`;
  const observerCa = await readFile(caCert);
  const result = await runOwnerAlphaPipeline({
    config, context, jobId, session, operation, throwOnFailure: true,
    gitDependencies: { git, mutateGit: git },
    deploymentDependencies: {
      fetch: (url, options) => fetch(url, { ...options, tls: { ca: observerCa } }),
      getForgejoObserverToken: async () => readSecret(observerTokenFile),
    },
  }, {
    assertCheckoutReady: (configInput) => assertCheckoutReady(configInput, { git: inspectGit }),
    runPreApplyChecks: async () => ({ ok: true, rendered: { witnesses: { old: prWitness, new: saveWitness } } }),
    confirmLivePage: async () => {
      await waitForLive(await readFile(caCert), prWitness, saveWitness);
      return { pageUrl: `${liveOrigin}/`, oldWitnessAbsent: true, newWitnessUnique: true };
    },
    rebuildLocal: async () => ({ status: 'local-rebuilt', commit: (await command(['git', '-C', checkout, 'rev-parse', 'HEAD'])).stdout.trim() }),
  });
  if (result.state !== 'completed') throw new Error(`owner-alpha fixture ended in ${result.state}`);
  const commit = (await command(['git', '-C', checkout, 'rev-parse', 'HEAD'])).stdout.trim();
  const parent = (await command(['git', '-C', checkout, 'rev-parse', 'HEAD^'])).stdout.trim();
  const changed = (await command(['git', '-C', checkout, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'])).stdout.trim().split('\n').filter(Boolean);
  const appliedBytes = await readFile(path.join(checkout, sourcePath));
  if (parent !== baseCommit
    || changed.length !== 1
    || changed[0] !== sourcePath
    || !appliedBytes.equals(Buffer.from(editedText))) {
    throw new Error('owner-alpha exact source and commit binding mismatch');
  }
  const paths = pipelineArtifactPaths(jobId);
  const options = { maxBytes: config.limits.maxArtifactBytes };
  const runRecord = await readJsonArtifact(context, paths.runBound, options);
  const deploymentRecord = await readJsonArtifact(context, paths.deployment, options);
  const binding = runRecord?.result?.binding ?? runRecord?.result;
  const deployment = deploymentRecord?.result;
  if (binding?.provider !== 'forgejo-actions'
    || binding.headSha !== commit
    || deployment?.provider !== 'forgejo-actions'
    || deployment.run?.headSha !== commit
    || deployment.publication?.state !== 'success') {
    throw new Error('owner-alpha Forgejo run and deployment evidence mismatch');
  }
  return {
    commit,
    parent,
    changedPath: sourcePath,
    exactSourceSplice: true,
    run: {
      id: binding.runId,
      number: binding.runNumber,
      workflowId: binding.workflowId,
      headSha: binding.headSha,
    },
    jobs: binding.jobs,
    publication: deployment.publication,
  };
}

async function main() {
  if (await sha256(runnerBinary) !== expectedRunnerSha) throw new Error('runner checksum changed after harness preflight');
  await reserve('127.0.0.1');
  await reserve('127.0.0.3');
  const dockerRoot = (await command(['docker', 'info', '--format', '{{.DockerRootDir}}'])).stdout.trim();
  manifest.storage.dataRoot = dockerRoot;
  // Rootless overlay upperdirs are owned by sub-UIDs the harness user cannot
  // stat, so du reports the total on stdout while exiting non-zero. Read the
  // printed total directly, matching the tolerant harness measurement.
  manifest.storage.baseline = duBytes(dockerRoot);
  await persistManifest();
  await measure('preflight', dockerRoot);
  const { caCert, tls } = await makeCertificates();
  const ca = await readFile(caCert);
  const authoritative = await prepareAuthoritativeRepository();
  const composeEnv = {
    ...process.env,
    WP3_COMPOSE_PROJECT: manifest.composeProject,
    WP3_FORGEJO_IMAGE: image,
    WP3_UID: String(process.getuid()),
    WP3_GID: String(process.getgid()),
    WP3_RUN_UUID: runUuid,
    WP3_TLS_DIR: path.join(tls, 'forgejo'),
  };
  manifest.docker.creationAuthorized = true;
  await persistManifest();
  await command(['docker', 'compose', '--file', COMPOSE, '--project-name', manifest.composeProject, 'up', '--detach', '--no-build', '--pull', 'never', '--wait'], { env: composeEnv });
  await recordComposeResources(manifest.composeProject);
  const instanceVersion = await waitForForgejo(ca);
  const swagger = await requireApi({ pathname: '/swagger.v1.json', ca });
  if (!Object.hasOwn(swagger?.paths ?? {}, '/repos/{owner}/{repo}/actions/runs/{run_id}/jobs')) {
    throw new Error('pinned Forgejo Swagger lacks the run-scoped jobs endpoint');
  }
  await measure('after-forgejo-initialization', dockerRoot);

  const admin = await command(['docker', 'compose', '--file', COMPOSE, '--project-name', manifest.composeProject, 'exec', '-T', 'forgejo', 'forgejo', 'admin', 'user', 'create', '--username', owner, '--email', 'wp3@example.invalid', '--admin', '--random-password', '--random-password-length', '48'], { env: composeEnv });
  const passwordMatch = admin.stdout.match(/^generated random password is '([A-Za-z0-9_-]{48})'$/mu);
  if (!passwordMatch) throw new Error('could not capture generated Forgejo setup password safely');
  const adminPasswordFile = await secretFile('setup-admin.password', passwordMatch[1]);
  const adminTokenFile = await createToken({ ca, adminPasswordFile, name: 'fixture-admin', scopes: ['all'] });
  const pushTokenFile = await createToken({ ca, adminPasswordFile, name: 'repository-push', scopes: ['write:repository', 'read:repository'] });
  const observerTokenFile = await createToken({ ca, adminPasswordFile, name: 'actions-observer', scopes: ['read:repository'] });
  await requireApi({ method: 'POST', pathname: '/api/v1/user/repos', tokenFile: adminTokenFile, body: { name: repository, private: true, auto_init: false }, ca });
  const helper = await writeCredentialHelper(pushTokenFile);
  const gitEnv = gitCredentialEnvironment(helper, caCert);
  const seed = path.join(runRoot, 'repositories', 'forgejo-seed');
  await command(['git', 'clone', '--quiet', authoritative.bare, seed]);
  await command(['git', 'remote', 'set-url', 'origin', `${forgeOrigin}/${slug}.git`], { cwd: seed });
  await command(['git', 'push', '--quiet', '--set-upstream', 'origin', 'main'], { cwd: seed, env: gitEnv });
  if (await repositorySnapshot(authoritative.bare) !== authoritative.snapshot) throw new Error('authoritative bare repository changed during one-time seed');

  const toolRoot = await createToolAllowlist(caCert);
  const publicationRoot = path.join(runRoot, 'publication');
  await mkdir(publicationRoot, { recursive: true, mode: 0o700 });

  // Reviewed runner-isolation boundary: workflow jobs run inside unprivileged
  // run-scoped containers with only the read-only tool mount and the
  // publication handoff. The checksum-pinned runner daemon is trusted harness
  // infrastructure and is the only component with container-engine access.
  const jobImageTag = `wp3-job-${runUuid}`;
  await buildJobImage(jobImageTag);
  const contract = assertRunnerIsolation(runnerExecutionContract({
    runUuid,
    jobImageTag,
    composeProject: manifest.composeProject,
    toolRoot,
    publicationRoot,
    forgeInternalOrigin,
    hostHome: process.env.HOME ?? '/root',
  }));

  const registration = await requireApi({ method: 'GET', pathname: `/api/v1/repos/${slug}/actions/runners/registration-token`, tokenFile: adminTokenFile, ca });
  if (typeof registration?.token !== 'string' || registration.token.length < 20) throw new Error('runner registration token missing');
  const runnerRegistrationFile = await secretFile('runner-registration.token', registration.token);
  const runnerRoot = path.join(runRoot, 'runner');
  await mkdir(path.join(runnerRoot, 'cache'), { recursive: true, mode: 0o700 });
  const label = contract.labelName;
  const dockerHost = (await command(['docker', 'context', 'inspect', '--format', '{{(index .Endpoints "docker").Host}}'])).stdout.trim();
  if (!dockerHost.startsWith('unix://')) throw new Error('WP3 runner requires a local Unix-socket Docker engine');
  // The daemon reaches the engine to launch job containers; the job containers
  // themselves never receive DOCKER_HOST or the socket.
  const runnerEnv = { ...process.env, SSL_CERT_FILE: caCert, DOCKER_HOST: dockerHost };
  const register = trackChild(Bun.spawn([runnerBinary, 'register'], { cwd: runnerRoot, env: runnerEnv, stdin: 'pipe', stdout: 'ignore', stderr: 'ignore' }));
  register.stdin.write(`${forgeOrigin}\n${await readSecret(runnerRegistrationFile)}\nwp3-${runUuid}\n${contract.registrationLabel}\n`);
  register.stdin.end();
  if (await register.exited !== 0) throw new Error('Forgejo Runner registration failed');
  const runnerConfig = path.join(runnerRoot, 'config.yml');
  const runnerEnvYaml = Object.entries(contract.envs).map(([name, value]) => `    ${name}: ${JSON.stringify(value)}`).join('\n');
  const runnerVolumeYaml = contract.validVolumes.map((source) => `    - ${JSON.stringify(source)}`).join('\n');
  const runnerLogLevel = process.env.WP3_DIAG === '1' ? 'debug' : 'warn';
  await writeFile(runnerConfig, `log:\n  level: ${runnerLogLevel}\nrunner:\n  file: ${JSON.stringify(path.join(runnerRoot, '.runner'))}\n  capacity: 1\n  timeout: 3h\n  fetch_timeout: 5s\n  fetch_interval: 2s\n  envs:\n${runnerEnvYaml}\ncache:\n  enabled: false\ncontainer:\n  network: ${JSON.stringify(contract.network)}\n  privileged: false\n  force_pull: false\n  options: ${JSON.stringify(contract.options)}\n  valid_volumes:\n${runnerVolumeYaml}\nhost:\n  workdir_parent: ${JSON.stringify(path.join(runnerRoot, 'work'))}\n`, { mode: 0o600 });
  // Forgejo takes the variable name in the path; the body carries only value.
  await requireApi({ method: 'POST', pathname: `/api/v1/repos/${slug}/actions/variables/WP3_RUNNER_LABEL`, tokenFile: adminTokenFile, body: { value: label }, ca }, [201, 204]);
  // Runner daemon logs are captured to a private run-root file so job-dispatch
  // failures are diagnosable without exposing them on the harness stdio.
  const runnerLog = process.env.WP3_DIAG === '1' ? Bun.file(path.join(runnerRoot, 'daemon.log')) : 'ignore';
  const runner = trackChild(Bun.spawn([runnerBinary, 'daemon', '--config', runnerConfig], { cwd: runnerRoot, env: runnerEnv, stdin: 'ignore', stdout: runnerLog, stderr: runnerLog }));
  manifest.processes.push(await processRecord(runner, runnerBinary));
  await persistManifest();
  await startStaticServer();

  // Prove the isolation boundary before trusting any downstream gate: a probe
  // push on a dedicated branch must report that no host authority is reachable.
  await runIsolationProbe({ gitEnv, adminTokenFile, ca });

  const prCheckout = path.join(runRoot, 'repositories', 'controlled-pr');
  await command(['git', 'clone', '--quiet', `${forgeOrigin}/${slug}.git`, prCheckout], { env: gitEnv });
  await command(['git', 'config', 'user.name', 'Cyberbaser WP3 Fixture'], { cwd: prCheckout });
  await command(['git', 'config', 'user.email', 'wp3@example.invalid'], { cwd: prCheckout });
  await command(['git', 'checkout', '--quiet', '-b', 'controlled-pr'], { cwd: prCheckout });
  const page = path.join(prCheckout, 'content', 'page.md');
  await writeFile(page, (await readFile(page, 'utf8')).replace(oldWitness, prWitness));
  await command(['git', 'add', '--', 'content/page.md'], { cwd: prCheckout });
  await command(['git', 'commit', '--quiet', '-m', 'Controlled Forgejo PR'], { cwd: prCheckout });
  const prCommit = (await command(['git', 'rev-parse', 'HEAD'], { cwd: prCheckout })).stdout.trim();
  const prChanged = (await command(['git', 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'], { cwd: prCheckout })).stdout.trim().split('\n').filter(Boolean);
  if (prChanged.length !== 1 || prChanged[0] !== 'content/page.md') {
    throw new Error('controlled PR must change exactly content/page.md');
  }
  await command(['git', 'push', '--quiet', '--set-upstream', 'origin', 'controlled-pr'], { cwd: prCheckout, env: gitEnv });
  const pull = await requireApi({ method: 'POST', pathname: `/api/v1/repos/${slug}/pulls`, tokenFile: adminTokenFile, body: { title: 'Controlled WP3 PR', head: 'controlled-pr', base: 'main', body: 'Hermetic WP3 acceptance.' }, ca });
  await waitForPullRequestRuns({ ca, adminTokenFile, commit: prCommit });
  await measure('after-pr-checks', dockerRoot);
  await requireApi({ method: 'POST', pathname: `/api/v1/repos/${slug}/pulls/${pull.number}/merge`, tokenFile: adminTokenFile, body: { Do: 'merge', merge_message_field: 'Controlled WP3 merge' }, ca }, [200]);
  await waitForLive(ca, oldWitness, prWitness);
  await measure('after-merge', dockerRoot);

  const ownerCheckout = path.join(runRoot, 'repositories', 'owner-alpha-checkout');
  await command(['git', 'clone', '--quiet', `${forgeOrigin}/${slug}.git`, ownerCheckout], { env: gitEnv });
  await command(['git', 'config', 'user.name', 'Cyberbaser WP3 Owner'], { cwd: ownerCheckout });
  await command(['git', 'config', 'user.email', 'wp3-owner@example.invalid'], { cwd: ownerCheckout });
  const save = await ownerAlphaSave({ checkout: ownerCheckout, observerTokenFile, helper, caCert });
  await measure('after-owner-alpha-save', dockerRoot);
  await waitForLive(ca, prWitness, saveWitness);
  await measure('after-deployment-live-confirmation', dockerRoot);
  const remoteRef = (await command(['git', 'ls-remote', `${forgeOrigin}/${slug}.git`, 'refs/heads/main'], { env: gitEnv })).stdout.split(/\s+/u)[0];
  if (remoteRef !== save.commit) throw new Error('Forgejo remote ref does not equal owner-alpha commit');
  if (await repositorySnapshot(authoritative.bare) !== authoritative.snapshot) throw new Error('authoritative bare repository changed after owner-alpha Save');
  await measure('before-teardown', dockerRoot);

  const result = safeResult({
    status: 'passed',
    provider: 'forgejo-actions',
    instanceVersion,
    repository: slug,
    authoritativeRepositoryUnchanged: true,
    pr: { commit: prCommit, checks: ['ofm-check', 'trust-gate'], merged: true },
    save,
    remoteRef,
    liveWitness: { oldAbsent: true, newUnique: true },
    storage: { peakBytes: manifest.storage.peak, limitBytes: WP3_STORAGE_LIMIT_BYTES },
    cleanup: { pending: true },
  });
  await writeFile(path.join(runRoot, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  // The harness owns final PID verification and teardown. Release the child
  // handles so this process can exit while those exact recorded processes stay
  // alive for manifest-bound cleanup.
  releaseLiveChildrenToHarness();
}

try {
  await main();
} catch (error) {
  await stopLiveChildren().catch(() => {});
  if (process.env.WP3_DIAG === '1') {
    process.stderr.write(`WP3 child failure: ${error.stack ?? error.message}\n`);
    try {
      const log = await readFile(path.join(runRoot, 'runner', 'daemon.log'), 'utf8');
      if (typeof process.env.WP3_DIAG_LOG === 'string') await writeFile(process.env.WP3_DIAG_LOG, log);
    } catch {}
  }
  const result = safeResult({ status: 'failed', reason: error.message, storage: { peakBytes: manifest.storage.peak } });
  await writeFile(path.join(runRoot, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 }).catch(() => {});
  process.exitCode = 1;
}

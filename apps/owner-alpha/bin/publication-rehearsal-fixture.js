import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { applyAcceptedOperation } from '../src/apply.js';
import { validateOwnerAlphaConfig } from '../src/config.js';
import { commitAppliedCandidate, pushExactCommit, verifyExactCommit } from '../src/git-publish.js';
import { createOwnerPublicationRuntime, createPublicationSourceGuard } from '../src/owner-publication-runtime.js';
import { createSaveHandler } from '../src/pipeline.js';
import { createOwnerAlphaHandler, startOwnerAlphaServers } from '../src/server.js';
import { assertCheckoutReady, createEditSession } from '../src/source.js';
import { defineStoreContext, prepareStore } from '../src/store.js';
import { publicationRehearsalCorpus, PUBLICATION_REHEARSAL_BASE, PUBLICATION_REHEARSAL_CANDIDATES } from './publication-rehearsal-corpus.js';

const execFileAsync = promisify(execFile);
export const REHEARSAL_SOURCE_PATH = 'rehearsal/synthetic-only.md';
export const REHEARSAL_BASE = PUBLICATION_REHEARSAL_BASE;
export const REHEARSAL_CANDIDATE = PUBLICATION_REHEARSAL_CANDIDATES.dispersed;
export const REHEARSAL_LABEL = 'Synthetic rehearsal only. Exact application, commit, and push affect a disposable local repository and local bare remote. Rendering, deployment, live confirmation, and local rebuild are simulated.';
const MAPPING = Object.freeze({ id: 'synthetic-page', source: Object.freeze({ identity: 'synthetic-authoring-memory', path: 'drafts/rehearsal.md' }),
  relativePath: REHEARSAL_SOURCE_PATH, slug: 'rehearsal/synthetic-only' });

function configFor(checkout, port) {
  return validateOwnerAlphaConfig({
    schemaVersion: 1, listen: { host: '127.0.0.1', port, readerPort: port + 1 },
    proposalReview: { enabled: false, socketPath: null, requestTimeoutMs: 5000, maxListEntries: 100 },
    repository: { checkout, remote: { name: 'origin', url: 'https://github.com/rehearsal/synthetic-fixture.git' }, branch: 'main' },
    owner: { identity: 'rehearsal', allowedTrustRoutes: ['auto-merge', 'quick-review'] },
    live: { baseUrl: 'https://rehearsal.github.io/synthetic-fixture/' },
    workflow: { provider: 'github-actions', repository: 'rehearsal/synthetic-fixture', name: 'Synthetic only',
      path: '.github/workflows/synthetic.yml', event: 'push', branch: 'main', jobs: ['build', 'deploy'], environment: 'github-pages' },
    workspace: { root: '.workspace/owner-alpha', store: '.workspace/owner-alpha/store', site: '.workspace/owner-alpha/site', cache: '.workspace/owner-alpha/cache' },
    paths: { include: ['rehearsal/*.md'], exclude: ['.git/**', '.workspace/**'] },
    limits: { maxSourceBytes: 65536, maxReplacementBytes: 65536, maxChangedBytes: 65536, maxChangedLines: 3200,
      maxArtifactBytes: 1048576, requestTimeoutMs: 5000, networkTimeoutMs: 30000 },
    checks: { allowedOfmVerdicts: ['clean'], requirePublishedSource: true, requireProjectionVerification: true,
      requireNoNewBrokenLinks: true, requireRenderedWitness: true },
    git: { autoCommit: true, autoPush: true, useHooks: true, commitMessagePrefix: 'synthetic-rehearsal:' },
    ownerPublication: { enabled: true, mappings: [MAPPING] },
  });
}

function isolatedEnvironment() {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return { ...environment, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
    GIT_EDITOR: ':', GIT_SEQUENCE_EDITOR: ':', GIT_MERGE_AUTOEDIT: 'no' };
}

/** Import-safe fixture construction. It never reads a local owner configuration,
 * real checkout, authoring workspace, browser profile, credential, or live API. */
export async function createPublicationRehearsal({ port = 46327, serve = Bun.serve, variation = 'dispersed' } = {}) {
  const corpus = publicationRehearsalCorpus(variation);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65534) throw new TypeError('rehearsal port must be 1024 through 65534');
  if (typeof serve !== 'function') throw new TypeError('rehearsal requires a server factory');
  const root = await mkdtemp(path.join(os.tmpdir(), 'owner-publication-rehearsal-'));
  const projectRoot = path.join(root, 'owner-runtime');
  const checkout = path.join(root, 'delivery');
  const remote = path.join(root, 'local-only.git');
  const active = new Set();
  let servers; let cleanupPromise; let closed = false;
  // The Git runner is fixture-local. It rejects every cwd outside this freshly
  // owned root and disables all non-file transports, global config and hooks.
  const git = async (cwd, args, { encoding = 'buffer', maxBytes = 1024 * 1024 } = {}) => {
    if (closed || (cwd !== root && !cwd.startsWith(`${root}${path.sep}`)) || await realpath(cwd) !== cwd) throw new Error('rehearsal Git containment refused');
    const { stdout } = await execFileAsync('git', ['-C', cwd, '-c', 'protocol.allow=never', '-c', 'protocol.file.allow=always',
      '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', '-c', 'tag.gpgSign=false', ...args], {
      encoding: 'buffer', env: isolatedEnvironment(), timeout: 10000, maxBuffer: maxBytes,
    });
    return encoding === 'buffer' ? Buffer.from(stdout) : Buffer.from(stdout).toString('utf8').trim();
  };
  const gitDependencies = { git, mutateGit: git };
  async function cleanup() {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      servers?.stop(true);
      // Do not delete a delivery checkout while its real local Git job is active.
      let timer;
      try {
        await Promise.race([Promise.allSettled([...active]), new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('rehearsal cleanup waiting for owned local job')), 30000);
        })]);
      } finally { clearTimeout(timer); }
      closed = true;
      try {
        const metadata = await lstat(root);
        if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.getuid()
          || await realpath(root) !== root) throw new Error('rehearsal cleanup ownership refused');
        await rm(root, { recursive: true });
      } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    })().catch((error) => { cleanupPromise = null; throw error; });
    return cleanupPromise;
  }
  try {
    await mkdir(projectRoot, { mode: 0o700 }); await mkdir(checkout, { mode: 0o700 });
    await git(projectRoot, ['init', '-q', '--initial-branch=main']);
    await writeFile(path.join(projectRoot, '.gitignore'), '.workspace/\n', { mode: 0o600 });
    await git(checkout, ['init', '-q', '--initial-branch=main']);
    await git(checkout, ['config', 'user.name', 'Synthetic Rehearsal']);
    await git(checkout, ['config', 'user.email', 'synthetic@example.invalid']);
    await mkdir(path.join(checkout, 'rehearsal')); await mkdir(path.join(checkout, '.cyberbaser'));
    await writeFile(path.join(checkout, REHEARSAL_SOURCE_PATH), corpus.base);
    await writeFile(path.join(checkout, '.cyberbaser/trust.yml'), 'trusted: [rehearsal]\n');
    await git(checkout, ['add', '--', REHEARSAL_SOURCE_PATH, '.cyberbaser/trust.yml']);
    await git(checkout, ['commit', '-q', '-m', 'Synthetic rehearsal base']);
    await git(root, ['init', '--bare', '-q', '--initial-branch=main', remote]);
    await git(checkout, ['remote', 'add', 'origin', remote]);
    await git(checkout, ['push', '-q', '-u', 'origin', 'main']);
    const initialCommit = await git(checkout, ['rev-parse', 'HEAD'], { encoding: 'utf8' });
    const config = configFor(checkout, port);
    const context = defineStoreContext({ projectRoot, workspaceRoot: path.join(projectRoot, config.workspace.root), storeRoot: path.join(projectRoot, config.workspace.store) });
    await prepareStore(context);
    const text = corpus.candidate; let version = 1;
    const readNote = async () => {
      if (closed) throw new Error('synthetic source closed');
      const bytes = Buffer.from(text);
      return { ...MAPPING.source, version, text, bytesBase64: bytes.toString('base64'), byteLength: bytes.length,
        digest: `sha-256=:${createHash('sha256').update(bytes).digest('base64')}:` };
    };
    // Same seam as the existing isolated acceptance fixture. The actual remote
    // must still be exactly this owned local bare repo before displaying policy.
    const policyGit = async (cwd, args, options) => {
      if (args.join(' ') === 'remote get-url origin' || args.join(' ') === 'remote get-url --push origin') {
        if (await git(cwd, args, { encoding: 'utf8' }) !== remote) throw new Error('synthetic local remote changed');
        return config.repository.remote.url;
      }
      return git(cwd, args, { encoding: 'utf8', ...options });
    };
    const ready = () => assertCheckoutReady(config, { git: policyGit });
    const sourceSession = (input) => createEditSession({ ...input, git: policyGit });
    const simulated = (stage, value) => ({ ...value, synthetic: true, evidence: `fixture-injected-${stage}; not external verification` });
    const effectCounts = { apply: 0, commit: 0, push: 0 };
    const dependencies = {
      assertCheckoutReady: ready,
      revalidateSource: createPublicationSourceGuard({ config, context, readNote }),
      runPreApplyChecks: async ({ operation }) => simulated('render-and-preapply', { ok: true,
        rendered: { witnesses: { old: Buffer.from(operation.expectedOldBytesBase64, 'base64').toString('utf8'),
          new: Buffer.from(operation.replacementBytesBase64, 'base64').toString('utf8') } } }),
      applyAcceptedOperation: (input) => { effectCounts.apply += 1; return applyAcceptedOperation(input, { git }); },
      commitAppliedCandidate: (input) => { effectCounts.commit += 1; return commitAppliedCandidate(input, gitDependencies); },
      verifyExactCommit: (input) => verifyExactCommit(input, gitDependencies),
      pushExactCommit: async (input) => {
        if (await git(checkout, ['remote', 'get-url', '--push', 'origin'], { encoding: 'utf8' }) !== remote) throw new Error('synthetic push destination changed');
        effectCounts.push += 1;
        return { ...await pushExactCommit({ ...input, remoteUrl: remote }, gitDependencies), syntheticLocalRemote: true };
      },
      getHead: (cwd) => git(cwd, ['rev-parse', 'HEAD'], { encoding: 'utf8' }),
      discoverDeploymentRun: async ({ applicationSha }) => simulated('deployment-discovery', {
        binding: { provider: 'github-actions', runId: 'synthetic-local-only', headSha: applicationSha, runAttempt: 1 } }),
      monitorDeploymentRun: async ({ applicationSha, boundRun }) => simulated('deployment-monitor', {
        provider: 'github-actions', run: { ...boundRun, headSha: applicationSha }, environment: { state: 'success' } }),
      confirmLivePage: async () => simulated('live-confirmation', { oldWitnessAbsent: true, newWitnessUnique: true }),
      rebuildLocal: async ({ commit }) => simulated('local-rebuild', { status: 'local-rebuilt', commit }),
    };
    const pipeline = createSaveHandler({ config, context, projectRoot, dependencies });
    const trackedPipeline = { ...pipeline, startEdit(input) {
      const handle = pipeline.startEdit(input);
      active.add(handle.completion);
      handle.completion.then(() => active.delete(handle.completion), () => active.delete(handle.completion));
      return handle;
    } };
    const publication = createOwnerPublicationRuntime({ config, context, readNote, pipeline: trackedPipeline,
      sourceSession, checkoutReady: ready, git });
    const authenticated = createOwnerAlphaHandler({ config, projectRoot, ownerPublication: publication,
      createEditSession: async () => { throw new Error('synthetic rehearsal has no editor'); },
      saveEdit: async () => { throw new Error('use synthetic publication panel'); }, lookupJob: pipeline.getJob });
    const labelled = async (request) => {
      const result = await authenticated(request);
      if (request.method === 'HEAD') return result;
      const type = result.headers.get('content-type') ?? '';
      if (!type.startsWith('text/html') && !type.startsWith('text/css')) return result;
      const headers = new Headers(result.headers); headers.delete('content-length');
      if (type.startsWith('text/css')) return new Response(`${await result.text()}\n.rehearsal-notice { background: var(--review-attention-soft, #fbf1dc); color: var(--review-attention, #8a5a12); border-top: 3px solid currentColor; font: 0.8125rem/1.5 system-ui, sans-serif; }\n.rehearsal-notice details { width: min(76rem, calc(100% - 2rem)); margin: auto; }\n.rehearsal-notice summary { padding: 0.65rem 0; min-height: 44px; cursor: pointer; }\n.rehearsal-notice p { max-width: 85ch; padding-bottom: 1rem; margin: 0; }\n.rehearsal-notice summary:focus-visible { outline: 3px solid currentColor; outline-offset: 2px; }`, { status: result.status, headers });
      let content = await result.text();
      // Fixture-only presentation: production has no simulation flag or bypass.
      // Replacements also cover the escaped data-stages read by the job client.
      for (const [before, after] of [
        ['Published and confirmed.', 'Rehearsal complete'],
        ['Publishing this version', 'Running the local rehearsal'],
        ['The reviewed version completed its publication checks.', 'Exact application, commit and push completed locally. No public site changed.'],
        ['Waiting for the site to build', 'Simulating the site build'],
        ['Checking the live page', 'Simulating live confirmation'],
        ['Refreshing your local copy', 'Simulating local rebuild'],
        ['Checking the page', 'Checking the page (render simulated)'],
        ['Pushing to your repository', 'Pushing to the disposable local remote'],
        ['This runs checks, applies the exact reviewed change, commits and pushes it, then checks the deployment. Later authoring edits are not included.', 'This applies the exact change, commits and pushes only to the disposable local repository. Rendering, deployment and live confirmation are simulated. No public site changes.'],
      ]) content = content.replaceAll(before, after);
      const notice = `<aside class="rehearsal-notice" aria-label="Synthetic fixture"><details><summary><strong>Synthetic rehearsal</strong> · Disposable local Git only. No public-site effects.</summary><p>${REHEARSAL_LABEL}</p></details></aside>`;
      return new Response(content.replace(/(<body[^>]*>)/u, `$1${notice}`), { status: result.status, headers });
    };
    Object.defineProperties(labelled, { bootstrapToken: { value: authenticated.bootstrapToken }, issueBootstrap: { value: authenticated.issueBootstrap } });
    const readerFetch = (request) => {
      if (request.headers.get('host') !== `127.0.0.1:${port + 1}`) return new Response('invalid host', { status: 421 });
      return new Response(REHEARSAL_LABEL, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
    };
    servers = startOwnerAlphaServers({ config, ownerFetch: labelled, readerFetch, serve });
    return Object.freeze({ root, projectRoot, checkout, remote, config, context, initialCommit,
      ownerOrigin: servers.ownerOrigin, readerOrigin: servers.readerOrigin,
      panelUrl: `${servers.ownerOrigin}/owner/publication`, label: REHEARSAL_LABEL,
      // Call only in the test driver/browser launcher; never print or persist.
      issueSignInUrl() { if (closed) throw new Error('synthetic source closed'); return `${servers.ownerOrigin}/owner/bootstrap?token=${authenticated.issueBootstrap()}`; },
      // Test-driver-only memory control, deliberately no HTTP route or editing UI.
      advanceSourceVersion() { if (closed) throw new Error('synthetic source closed'); version += 1; return version; },
      inspectDelivery: () => readFile(path.join(checkout, REHEARSAL_SOURCE_PATH), 'utf8'),
      readLocalHead: () => git(checkout, ['rev-parse', 'HEAD'], { encoding: 'utf8' }),
      readBareHead: () => git(remote, ['rev-parse', 'refs/heads/main'], { encoding: 'utf8' }),
      readStatus: () => git(checkout, ['status', '--porcelain=v1', '--untracked-files=all'], { encoding: 'utf8' }),
      readPublicationCommitCount: () => git(checkout, ['rev-list', '--count', `${initialCommit}..HEAD`], { encoding: 'utf8' }),
      readEffectCounts: () => ({ ...effectCounts }),
      cleanup,
    });
  } catch (error) {
    await cleanup();
    throw error;
  }
}

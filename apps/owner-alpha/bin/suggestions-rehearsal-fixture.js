import { execFile } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { copyCommittedFolder, DEFAULT_MAX_PAGES, validateCopyOptions } from './suggestions-rehearsal-source.js';
import { validatePrivateNetworkIpv4Host } from '../src/network.js';

const exec = promisify(execFile);
export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const RENDERER_SEED = path.join(PROJECT_ROOT, '.workspace/suggestions-rehearsal-renderer');
export const PREPARE_COMMAND = 'bun run --cwd docs try:suggestions --prepare';
export const REPOSITORY = 'https://github.com/rehearsal/suggestions-fixture.git';
export const QUOTE = 'SMS codes are phishing-resistant.';
export const REPLACEMENT = 'SMS codes are not phishing-resistant.';
export const PAGES = Object.freeze({
  'index.md': '# Security field notes\n\nDisposable notes for trying suggestions. Nothing here is a real vault.\n\n- [[mfa-methods|MFA methods]]\n- [[recovery-codes|Recovery codes]]\n',
  'mfa-methods.md': `# MFA methods\n\nChoose a second factor that matches the risks of the account.\n\n${QUOTE}\n\nSecurity keys resist phishing by binding authentication to the real site.\n`,
  'recovery-codes.md': '# Recovery codes\n\nStore recovery codes offline in a safe place.\n\nReplace used recovery codes after signing in.\n',
});
const TEST_KEYS = Object.freeze({
  pass: ['1x00000000000000000000AA', '1x0000000000000000000000000000000AA'],
  fail: ['2x00000000000000000000AB', '2x0000000000000000000000000000000AA'],
  spent: ['1x00000000000000000000AA', '3x0000000000000000000000000000000AA'],
});

export function optionsFromArgs(args) {
  const result = { keep: false, challenge: null, prepare: false, port: 46437, host: '127.0.0.1' };
  const copy = { from: null, folder: null, ref: 'origin/main', maxPages: DEFAULT_MAX_PAGES };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--keep') result.keep = true;
    else if (arg === '--prepare') result.prepare = true;
    else if (arg === '--challenge' && Object.hasOwn(TEST_KEYS, args[i + 1])) result.challenge = args[++i];
    else if (arg === '--port' && /^\d+$/u.test(args[i + 1] ?? '')) result.port = Number(args[++i]);
    // One private IPv4 address (loopback, RFC 1918 or a Tailscale 100.64.0.0/10 address) so a phone on the tailnet can reach it.
    else if (arg === '--host' && args[i + 1] && !args[i + 1].startsWith('--')) result.host = validatePrivateNetworkIpv4Host(args[++i], '--host');
    else if (['--from', '--folder', '--ref'].includes(arg) && args[i + 1] && !args[i + 1].startsWith('--')) copy[{ '--from': 'from', '--folder': 'folder', '--ref': 'ref' }[arg]] = args[++i];
    else if (arg === '--max-pages' && /^\d+$/u.test(args[i + 1] ?? '')) copy.maxPages = Number(args[++i]);
    else throw new Error('Use --keep, --port NUMBER, --host PRIVATE_IPV4, --prepare, --challenge pass|fail|spent, or --from VAULT --folder FOLDER [--ref origin/main] [--max-pages 400].');
  }
  if (!Number.isSafeInteger(result.port) || result.port < 1024 || result.port > 65533) throw new Error('Choose an owner port from 1024 through 65533; this rehearsal uses three consecutive ports.');
  if (copy.from === null && args.some((arg) => ['--folder', '--ref', '--max-pages'].includes(arg))) throw new Error('--folder, --ref and --max-pages require --from.');
  validateCopyOptions(copy);
  if (result.prepare && (result.keep || result.challenge || copy.from !== null)) throw new Error('--prepare runs preparation only; do not combine it with --keep, --challenge or --from.');
  return copy.from === null ? result : { ...result, ...copy };
}

function environment() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_') && !name.startsWith('CYBERBASER_')));
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0' };
}

async function command(program, args, options = {}) {
  return exec(program, args, { cwd: PROJECT_ROOT, env: environment(), timeout: 180_000, maxBuffer: 16 * 1024 * 1024, ...options });
}

export async function assertPrerequisites({ seed = RENDERER_SEED } = {}) {
  for (const program of ['bun', 'git', 'node', 'rsync', 'flock', 'sha256sum']) {
    try { await command('which', [program], { timeout: 5000 }); }
    catch { throw new Error(`Install ${program} before trying suggestions. Then run: ${PREPARE_COMMAND}`); }
  }
  try {
    await import('../src/index.js');
    await import('../../account-free-intake/src/index.js');
  } catch {
    throw new Error(`The local owner/intake dependencies are missing. Prepare the frozen dependencies and pinned Quartz renderer: ${PREPARE_COMMAND}`);
  }
  try {
    const { PINNED_QUARTZ_COMMIT, PINNED_QUARTZ_LOCK_SHA256, PINNED_QUARTZ_INSTALL_SHA256 } = await import('../src/quartz-renderer.js');
    const { createHash } = await import('node:crypto');
    if (!(await lstat(seed)).isDirectory() || await realpath(seed) !== seed) throw new Error('seed path');
    const { stdout } = await command('git', ['-C', seed, 'rev-parse', 'HEAD'], { timeout: 5000 });
    if (stdout.trim() !== PINNED_QUARTZ_COMMIT
      || createHash('sha256').update(await readFile(path.join(seed, 'package-lock.json'))).digest('hex') !== PINNED_QUARTZ_LOCK_SHA256
      || (await readFile(path.join(seed, 'node_modules/.cyberbaser-install-sha256'), 'utf8')).trim() !== PINNED_QUARTZ_INSTALL_SHA256) throw new Error('seed pin');
  } catch {
    throw new Error(`The pinned Quartz renderer and its npm dependencies are not ready. Preparation downloads Quartz and installs dependencies once: ${PREPARE_COMMAND}`);
  }
}

/** Only fresh fixture-owned files are written. The real owner config is never read. */
export const AGENT_REHEARSAL_DELIVERY_PATH = 'workspace-note.md';

export async function createSuggestionsFixture({ port = 46437, host = '127.0.0.1', keep = false, challenge = null, from = null, folder = null, ref = 'origin/main', maxPages = DEFAULT_MAX_PAGES, agentBase = null, siteTitle = null } = {}) {
  optionsFromArgs(['--port', String(port), '--host', host, ...(challenge === null ? [] : ['--challenge', challenge])]);
  validateCopyOptions({ from, folder, ref, maxPages });
  if (agentBase !== null && (host !== '127.0.0.1' || from !== null || keep || challenge !== null || typeof agentBase !== 'string')) {
    throw new Error('The agent rehearsal uses only disposable loopback state.');
  }
  const parent = agentBase === null ? path.join(PROJECT_ROOT, '.workspace') : await realpath(os.tmpdir());
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(path.join(parent, agentBase === null ? 'try-suggestions-' : 'agent-proposal-'));
  const checkout = path.join(root, 'vault');
  const remote = path.join(root, 'local-only.git');
  const configFile = path.join(root, 'owner.json');
  const projectRoot = path.join(root, 'owner-runtime');
  let runtime; let closed = false; let closing; const active = new Set();
  const git = async (cwd, args, { encoding = 'utf8', maxBytes = 16 * 1024 * 1024 } = {}) => {
    if (closed || (cwd !== root && !cwd.startsWith(`${root}${path.sep}`)) || await realpath(cwd) !== cwd) throw new Error('Rehearsal Git containment refused.');
    const { stdout } = await command('git', ['-C', cwd, '-c', 'protocol.allow=never', '-c', 'protocol.file.allow=always',
      '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', '-c', 'tag.gpgSign=false', ...args],
    { encoding: 'buffer', maxBuffer: maxBytes, timeout: 15_000 });
    return encoding === 'buffer' ? Buffer.from(stdout) : Buffer.from(stdout).toString('utf8').trim();
  };
  async function cleanup() {
    if (closing) return closing;
    closing = (async () => {
      await runtime?.stop(true);
      // A source-writing job must settle before its checkout can be removed.
      let timer;
      try {
        await Promise.race([Promise.allSettled([...active]), new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`An owned job is still active. State retained at ${root}`)), 120_000);
        })]);
      } finally { clearTimeout(timer); }
      closed = true;
      const metadata = await lstat(root);
      if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.getuid() || await realpath(root) !== root) throw new Error(`Cleanup ownership check failed. State retained at ${root}`);
      if (!keep) await rm(root, { recursive: true });
    })();
    return closing;
  }
  try {
    await mkdir(projectRoot, { mode: 0o700 });
    await git(projectRoot, ['init', '-q', '--initial-branch=main']);
    await writeFile(path.join(projectRoot, '.gitignore'), '.workspace/\n', { mode: 0o600 });
    await mkdir(checkout, { mode: 0o700 });
    await mkdir(path.join(checkout, '.cyberbaser'), { mode: 0o700 });
    const copied = from === null ? null : await copyCommittedFolder({ from, folder, ref, maxPages, checkout, root, projectRoot: PROJECT_ROOT, command });
    if (agentBase !== null) {
      await writeFile(path.join(checkout, AGENT_REHEARSAL_DELIVERY_PATH), agentBase, { mode: 0o600 });
      await writeFile(path.join(checkout, 'index.md'), '# Agent proposal rehearsal\n', { mode: 0o600 });
    } else if (copied === null) for (const [name, text] of Object.entries(PAGES)) await writeFile(path.join(checkout, name), text, { mode: 0o600 });
    const allow = copied === null ? ['*.md'] : ['index.md', folder];
    await writeFile(path.join(checkout, 'publish.yml'), copied === null ? 'allow:\n  - "*.md"\n' : `${JSON.stringify({ allow })}\n`, { mode: 0o600 });
    await writeFile(path.join(checkout, '.cyberbaser/trust.yml'), 'trusted: [rehearsal]\nagents: []\n', { mode: 0o600 });
    // Optional synthetic site settings, so the private site carries a title.
    if (siteTitle !== null) {
      if (typeof siteTitle !== 'string' || !/^[\w .-]{1,40}$/u.test(siteTitle)) throw new Error('The rehearsal site title must be short plain text.');
      await writeFile(path.join(checkout, '.cyberbaser/site.yml'), `site:\n  title: ${siteTitle}\nappearance:\n  colorScheme: light\n`, { mode: 0o600 });
    }
    await git(checkout, ['init', '-q', '--initial-branch=main']);
    await git(checkout, ['config', 'user.name', 'Suggestions Rehearsal']);
    await git(checkout, ['config', 'user.email', 'rehearsal@example.invalid']);
    await git(checkout, ['add', '-A']);
    await git(checkout, ['commit', '-q', '-m', 'Disposable suggestions pages']);
    await git(root, ['init', '--bare', '-q', '--initial-branch=main', remote]);
    await git(checkout, ['remote', 'add', 'origin', remote]);
    await git(checkout, ['push', '-q', '-u', 'origin', 'main']);
    const config = {
      schemaVersion: 1, listen: { host, port, readerPort: port + 1 },
      repository: { checkout, remote: { name: 'origin', url: REPOSITORY }, branch: 'main' },
      owner: { identity: 'rehearsal', allowedTrustRoutes: ['auto-merge', 'quick-review'] },
      live: { baseUrl: 'https://rehearsal.github.io/suggestions-fixture/' },
      workflow: { provider: 'github-actions', repository: 'rehearsal/suggestions-fixture', name: 'Local rehearsal only',
        path: '.github/workflows/local-only.yml', event: 'push', branch: 'main', jobs: ['build', 'deploy'], environment: 'github-pages' },
      proposalReview: { enabled: true, socketPath: path.join(root, 'review.sock'), requestTimeoutMs: 5000, maxListEntries: 100 },
      workspace: { root: '.workspace/owner-alpha', store: '.workspace/owner-alpha/store', site: '.workspace/owner-alpha/site', cache: '.workspace/owner-alpha/cache' },
      paths: { include: copied === null ? ['*.md'] : ['**/*.md'], exclude: ['.git/**', '.workspace/**', '.cyberbaser/**'] },
      limits: { maxSourceBytes: 65536, maxReplacementBytes: 65536, maxChangedBytes: 65536, maxChangedLines: 60,
        maxArtifactBytes: 8388608, requestTimeoutMs: 30000, networkTimeoutMs: 900000 },
      checks: { allowedOfmVerdicts: ['clean'], requirePublishedSource: true, requireProjectionVerification: true,
        requireNoNewBrokenLinks: true, requireRenderedWitness: true },
      git: { autoCommit: true, autoPush: true, useHooks: true, commitMessagePrefix: 'suggestions-rehearsal:' },
      suggestions: { form: { enabled: true }, forge: { enabled: false } },
    };
    if (challenge !== null) {
      const secretFile = path.join(root, 'turnstile-test-secret');
      await writeFile(secretFile, `${TEST_KEYS[challenge][1]}\n`, { mode: 0o600 });
      config.suggestions.form.challenge = { provider: 'turnstile', siteKey: TEST_KEYS[challenge][0], secretFile, expectedHostnames: ['example.com'] };
    }
    await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    return { root, checkout, remote, config, configFile, projectRoot, challenge, keep, copied, git, cleanup,
      ownerOrigin: `http://${host}:${port}`, readerOrigin: `http://${host}:${port + 1}`, intakeOrigin: `http://${host}:${port + 2}`,
      track(promise) { active.add(promise); promise.then(() => active.delete(promise), () => active.delete(promise)); return promise; },
      attachRuntime(value) { runtime = value; },
    };
  } catch (error) { await cleanup(); throw error; }
}

/** A fixture-local renderer seam reuses the pinned setup/build scripts offline. */
export function createRehearsalRenderer({ seed = RENDERER_SEED } = {}) {
  return async ({ contentDir, outputDir, workspaceDir, ownerOrigin, suggestions = null, siteConfigPath = null, sourceCheckout = null }) => {
    const { PINNED_QUARTZ_COMMIT, PINNED_QUARTZ_REF, suggestionEnvironment, provenanceReportEnvironment, readProvenanceReport } = await import('../src/quartz-renderer.js');
    const { BUNDLED_RENDERER_NAME } = await import('../src/renderer-slot.js');
    const quartz = path.join(workspaceDir, 'quartz');
    const renderer = path.join(PROJECT_ROOT, 'renderers/quartz-cyberbase');
    await mkdir(workspaceDir, { recursive: true });
    // Same build inputs as the real owner renderer (form, challenge, provenance).
    const form = suggestionEnvironment(suggestions);
    const report = await provenanceReportEnvironment(workspaceDir, form);
    const env = { ...environment(), QUARTZ_OFFLINE: '1', QUARTZ_SEED_DIR: seed,
      ...(form.CYBERBASER_SOURCE_PROVENANCE ? { CYBERBASER_SOURCE_PROVENANCE: form.CYBERBASER_SOURCE_PROVENANCE } : {}) };
    await command('bash', [path.join(renderer, 'setup.sh'), quartz], { env });
    await command('bash', [path.join(renderer, 'build.sh'), contentDir, quartz], { env: { ...env, COPY_CONTENT: '1', OUTPUT_DIR: outputDir,
      CYBERBASER_EDIT_LINK_MODE: 'owner', CYBERBASER_OWNER_ORIGIN: ownerOrigin, ...form, ...report,
      // The vault's own site settings and read-only note dates, as the real renderer passes them.
      ...(siteConfigPath ? { CYBERBASER_SITE_CONFIG: siteConfigPath } : {}),
      ...(sourceCheckout ? { CYBERBASER_SOURCE_CHECKOUT: sourceCheckout } : {}) } });
    return { renderer: BUNDLED_RENDERER_NAME, revision: PINNED_QUARTZ_COMMIT, tag: PINNED_QUARTZ_REF, outputDir, suggestionForm: suggestions !== null,
      provenanceSkipped: await readProvenanceReport(report) };
  };
}

async function assertLocalAgentConfiguration(fixture) {
  const { root, remote, checkout, git } = fixture;
  const config = JSON.parse(await readFile(fixture.configFile, 'utf8'));
  const inside = (value) => typeof value === 'string' && path.normalize(value) === value && value.startsWith(`${root}${path.sep}`);
  if (!inside(remote) || await realpath(remote) !== remote || config.repository.checkout !== checkout
    || config.repository.remote.url !== REPOSITORY || config.repository.remote.name !== 'origin' || config.publisher !== undefined
    || config.listen.host !== '127.0.0.1' || config.suggestions.forge.enabled || config.suggestions.form.challenge
    || await git(checkout, ['remote']) !== 'origin') throw new Error('Agent rehearsal remote containment refused.');
  for (const option of [['origin'], ['--push', 'origin']]) {
    if (await git(checkout, ['remote', 'get-url', '--all', ...option]) !== remote) throw new Error('Agent rehearsal remote containment refused.');
  }
  for (const socketPath of [config.proposalReview.socketPath, config.signedRequestSocket]) {
    if (!inside(socketPath) || await realpath(path.dirname(socketPath)) !== path.dirname(socketPath)) {
      throw new Error('Agent rehearsal socket containment refused.');
    }
  }
}

// renderer: null builds through the renderer the fixture config selects (the owner's slot).
export async function startSuggestionsRehearsal(fixture, { renderer = createRehearsalRenderer(), simulatedRender = false, readAuthoringNote, publisherSigning = null } = {}) {
  if (simulatedRender) await assertLocalAgentConfiguration(fixture);
  // The site manifest hashes actual runtime resources. Copy, never symlink,
  // this small code/resource closure into the owned runtime project.
  for (const relative of ['apps/owner-alpha/src', 'apps/owner-alpha/public', 'renderers/quartz-cyberbase',
    ...['correction', 'linkcheck', 'ofm', 'projection', 'proposal', 'proposal-queue', 'proposal-review', 'publish', 'trust'].map((name) => `packages/${name}/src`)]) {
    const target = path.join(fixture.projectRoot, relative);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await cp(path.join(PROJECT_ROOT, relative), target, { recursive: true });
  }
  const { assertCheckoutReady, createEditSession } = await import('../src/source.js');
  const { runOwnerAlphaServer, createOwnerAlphaHandler, createOwnerProposalReviewService } = await import('../src/server.js');
  const { createOwnerProposalReviewSource } = await import('../src/proposal-review.js');
  const { rebuildOwnerSite } = await import('../src/site.js');
  const { createSaveHandler } = await import('../src/pipeline.js');
  const { runPreApplyChecks } = await import('../src/checks.js');
  const { applyAcceptedOperation } = await import('../src/apply.js');
  const { commitAppliedCandidate, pushExactCommit, verifyExactCommit } = await import('../src/git-publish.js');
  const { startSuggestionIntake } = await import('../src/suggestions.js');
  const { createOwnerPublicationRuntime } = await import('../src/owner-publication-runtime.js');
  const { createBundlePreview } = await import('../src/bundle-preview.js');
  const { witnessDigest } = await import('../src/live-confirm.js');
  // The policy's HTTPS identity is not a destination. Verify both real remote
  // directions before mapping identity for the normal fail-closed policy checks.
  const policyGit = async (cwd, args, options) => {
    if (args.join(' ') === 'remote get-url origin' || args.join(' ') === 'remote get-url --push origin') {
      if (await fixture.git(cwd, args) !== fixture.remote) throw new Error('Disposable local remote changed.');
      return options?.encoding === 'buffer' ? Buffer.from(`${REPOSITORY}\n`) : REPOSITORY;
    }
    return fixture.git(cwd, args, options);
  };
  const reviewGit = (cwd, args, options) => policyGit(cwd, args, { ...options, encoding: 'buffer' });
  const ready = (config) => assertCheckoutReady(config, { git: policyGit });
  const rebuild = ({ config }) => rebuildOwnerSite({ config, projectRoot: fixture.projectRoot, renderer }, { assertCheckoutReady: ready });
  const simulated = (stage, value) => ({ ...value, synthetic: true, evidence: `local-rehearsal-simulated-${stage}; no deployment or live verification` });
  const runtime = await runOwnerAlphaServer({ configFile: fixture.configFile, projectRoot: fixture.projectRoot, publisherSigning,
    ...(readAuthoringNote === undefined ? {} : { readAuthoringNote,
      // Publication reads the same disposable checkout through the policy seam.
      createPublication: (input) => createOwnerPublicationRuntime({ ...input, git: reviewGit, checkoutReady: ready,
        sourceSession: (session) => createEditSession({ ...session, git: policyGit }) }) }),
    rebuildSite: rebuild,
    // New pages on the site design (route C, and the address check before a
    // bundle is offered) read the same disposable checkout through the policy seam.
    createPreview: (input) => createBundlePreview({ ...input, dependencies: { ...input.dependencies, assertCheckoutReady: ready } }),
    startSuggestions: (input) => startSuggestionIntake({ ...input, intakeEntry: path.join(PROJECT_ROOT, 'apps/account-free-intake/bin/server.js') }),
    createReviewSource: (input) => createOwnerProposalReviewSource({ ...input, git: reviewGit }),
    createReviewService: (input) => createOwnerProposalReviewService({ ...input,
      application: { ...input.application, git: reviewGit, checkoutReady: ready } }),
    loadPipeline: async ({ config, context, dependencies }) => {
      const effectGit = (cwd, args, options) => fixture.git(cwd, args, { encoding: 'buffer', ...options });
      const gitDependencies = { git: effectGit, mutateGit: effectGit };
      const pipeline = createSaveHandler({ config, context, projectRoot: fixture.projectRoot, dependencies: {
        ...dependencies, assertCheckoutReady: ready,
        createEditSession: (input) => createEditSession({ ...input, git: policyGit }),
        runPreApplyChecks: (input) => runPreApplyChecks({ ...input, ...(renderer === null ? {} : { renderer }) }, simulatedRender ? {
          createTemporaryRoot: () => mkdtemp(path.join(fixture.root, 'checks-')),
        } : undefined),
        applyAcceptedOperation: (input) => applyAcceptedOperation(input, { git: effectGit }),
        commitAppliedCandidate: (input) => commitAppliedCandidate(input, gitDependencies),
        verifyExactCommit: (input) => verifyExactCommit(input, gitDependencies),
        pushExactCommit: async (input) => {
          if (await fixture.git(fixture.checkout, ['remote', 'get-url', '--push', 'origin']) !== fixture.remote) throw new Error('Local push destination changed.');
          return { ...await pushExactCommit({ ...input, remoteUrl: fixture.remote }, gitDependencies), syntheticLocalRemote: true };
        },
        getHead: (cwd) => fixture.git(cwd, ['rev-parse', 'HEAD']),
        // Shaped as a successful bound run so the node's own deployment checks
        // (live verification, note status) accept it; still marked synthetic.
        discoverDeploymentRun: async ({ applicationSha }) => simulated('discovery', { binding: { provider: 'github-actions', runId: '1', headSha: applicationSha, runAttempt: 1 } }),
        monitorDeploymentRun: async ({ boundRun }) => simulated('deployment', { provider: 'github-actions',
          run: { ...boundRun, status: 'completed', conclusion: 'success' }, environment: { state: 'success' } }),
        confirmLivePage: async () => simulated('live-confirmation', { oldWitnessAbsent: true, newWitnessUnique: true }),
        // New pages from a bundle: the same simulation, shaped as the new-page proof.
        confirmNewPages: async ({ pages, images }) => simulated('live-confirmation', { kind: 'new-page-live',
          pages: pages.map((page) => ({ pageUrl: page.pageUrl, witnessPresent: true, witnessDigest: witnessDigest(page.witness) })),
          images: images.map(({ url, byteLength, sha256 }) => ({ url, byteLength, sha256 })) }),
        rebuildLocal: async ({ commit, jobId, sourcePath }) => {
          const built = await rebuild({ config });
          if (built.manifest.source.head !== commit) throw new Error('Local rebuild commit mismatch.');
          return { status: 'local-rebuilt', commit, jobId, sourcePath, renderer: built.manifest.renderer.name, rendererRevision: built.manifest.renderer.revision };
        },
      } });
      return { ...pipeline, saveEdit(input) {
        const job = pipeline.startEdit(input); fixture.track(job.completion); return job.accepted;
      } };
    },
    createHandler(input) {
      // Edit this page is the owner's direct route; it binds the same disposable checkout.
      const handler = createOwnerAlphaHandler({ ...input,
        createEditSession: (session) => createEditSession({ ...session, git: policyGit }) });
      const labelled = async (request) => {
        const result = await handler(request);
        if (request.method === 'HEAD' || !(result.headers.get('content-type') ?? '').startsWith('text/html')) return result;
        // The sandboxed page frame is the site's look; the label belongs to the owner page around it.
        if (/(^|; )sandbox(;|$)/u.test(result.headers.get('content-security-policy') ?? '')) return result;
        let body = await result.text();
        for (const [before, after] of [
          ['Published and confirmed.', 'Local rehearsal complete'],
          ['Live on the page.', 'Local rehearsal complete'],
          ['Pushing to your repository', 'Pushing to the disposable local remote'],
          ['Refreshing your local copy', simulatedRender ? 'Simulating the private site rebuild' : 'Rebuilding the private rehearsal site'],
          ...(simulatedRender ? [['Checking the page', 'Checking the page (render simulated)']] : []),
          ['Waiting for the site to build', 'Simulating deployment (local rehearsal)'],
          ['Checking the live page', 'Simulating live confirmation (local rehearsal)'],
        ]) body = body.replaceAll(before, after);
        const proposalPage = body.includes('class="rv-doc');
        const notice = proposalPage
          ? `<aside class="rehearsal-notice proposal-rehearsal-notice" aria-label="Synthetic rehearsal"><span>Rehearsal · ${simulatedRender ? 'Build and publication simulated' : 'Deployment and live checks simulated'}. No public changes.</span><button type="button" data-dismiss-rehearsal aria-label="Dismiss rehearsal notice">×</button></aside>`
          : simulatedRender
            ? '<aside class="owner-shell rehearsal-notice"><strong>Disposable agent proposal rehearsal.</strong> Real signed submission, review, exact change, commit and push to a local bare remote. Build, deployment, live confirmation and rebuild are simulated. No public site changes.</aside>'
            : '<aside class="owner-shell rehearsal-notice"><strong>Disposable suggestions rehearsal.</strong> Real local render, review, exact change, commit and push to a local bare remote. Deployment and live confirmation are simulated. No public site changes.</aside>';
        const headers = new Headers(result.headers); headers.delete('content-length');
        const labelledBody = body.includes('id="job-rehearsal-details"')
          ? body.replace('<div id="job-rehearsal-details"></div>', `<div id="job-rehearsal-details">${notice}</div>`)
          : proposalPage && /<div class="rv-app"[^>]*>/u.test(body)
            // Inside the full-height review layout, as its own row, so it never covers the page.
            ? body.replace(/(<div class="rv-app"[^>]*>)/u, `$1${notice}`)
            : body.replace(/(<body[^>]*>)/u, `$1${notice}`);
        return new Response(labelledBody, { status: result.status, headers });
      };
      Object.defineProperties(labelled, { bootstrapToken: { value: handler.bootstrapToken }, issueBootstrap: { value: handler.issueBootstrap } });
      return labelled;
    },
  });
  fixture.attachRuntime(runtime);
  await runtime.recovery;
  return runtime;
}

import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  applyEditorOperation,
  assertCheckoutReady,
  computePolicyRevision,
  createEditSession,
  createJsonArtifactOnce,
  createOwnerAlphaHandler,
  createSaveHandler,
  defaultGitRunner,
  defineStoreContext,
  deriveEditorOperation,
  initializeDurableJob,
  pipelineArtifactPaths,
  prepareStore,
  pushExactCommit,
  runOwnerAlphaServer,
  validateOwnerAlphaConfig,
} from '../src/index.js';

const PROJECT_ROOT = path.resolve(import.meta.dir, '../../..');
const PLAYWRIGHT = path.join(PROJECT_ROOT, 'docs', 'node_modules', 'playwright', 'index.js');
const cleanup = [];

async function git(cwd, args) {
  const child = Bun.spawn(['git', '-C', cwd, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${stderr || stdout}`);
  return stdout.trim();
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'owner-alpha-acceptance-'));
  cleanup.push(root);
  const projectRoot = path.join(root, 'runtime');
  const checkout = path.join(root, 'checkout');
  const remote = path.join(root, 'remote.git');
  await mkdir(projectRoot, { recursive: true });
  await git(projectRoot, ['init', '-q']);
  await writeFile(path.join(projectRoot, '.gitignore'), '.workspace/\n', 'utf8');
  await mkdir(path.join(checkout, 'docs'), { recursive: true });
  await git(checkout, ['init', '-q', '--initial-branch=main']);
  await git(checkout, ['config', 'user.name', 'Owner Alpha Acceptance']);
  await git(checkout, ['config', 'user.email', 'owner-alpha@example.invalid']);
  await writeFile(path.join(checkout, 'docs', 'page.md'), '# Page\n\nBrowser old value.\n', 'utf8');
  await writeFile(path.join(checkout, 'docs', 'recovery.md'), '# Recovery\n\nRecovery old value.\n', 'utf8');
  await git(checkout, ['add', '--', 'docs/page.md', 'docs/recovery.md']);
  await git(checkout, ['commit', '-q', '-m', 'fixture base']);
  await git(root, ['init', '--bare', '-q', '--initial-branch=main', remote]);
  await git(checkout, ['remote', 'add', 'origin', remote]);
  await git(checkout, ['push', '-q', '-u', 'origin', 'main']);

  const config = validateOwnerAlphaConfig({
    schemaVersion: 1,
    listen: { host: '127.0.0.1', port: 46317 },
    repository: {
      checkout,
      remote: { name: 'origin', url: 'https://github.com/cybersader/cyberbase.git' },
      branch: 'main',
    },
    owner: { identity: 'cybersader', allowedTrustRoutes: ['auto-merge', 'quick-review'] },
    live: { baseUrl: 'https://cybersader.github.io/cyberbase/' },
    workflow: {
      provider: 'github-actions',
      repository: 'cybersader/cyberbase',
      name: 'Publish vault site',
      path: '.github/workflows/publish-site.yml',
      event: 'push',
      branch: 'main',
      jobs: ['build', 'deploy'],
      environment: 'github-pages',
    },
    workspace: {
      root: '.workspace/owner-alpha',
      store: '.workspace/owner-alpha/store',
      site: '.workspace/owner-alpha/site',
      cache: '.workspace/owner-alpha/cache',
    },
    paths: { include: ['**/*.md'], exclude: ['.git/**', '.workspace/**'] },
    limits: {
      maxSourceBytes: 2_097_152,
      maxReplacementBytes: 65_536,
      maxChangedBytes: 65_536,
      maxChangedLines: 60,
      maxArtifactBytes: 8_388_608,
      requestTimeoutMs: 30_000,
      networkTimeoutMs: 900_000,
    },
    checks: {
      allowedOfmVerdicts: ['clean'],
      requirePublishedSource: true,
      requireProjectionVerification: true,
      requireNoNewBrokenLinks: true,
      requireRenderedWitness: true,
    },
    git: { autoCommit: true, autoPush: true, useHooks: true, commitMessagePrefix: 'owner-alpha:' },
  });
  const configFile = path.join(projectRoot, 'owner-alpha.local.json');
  await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  const context = defineStoreContext({
    projectRoot,
    workspaceRoot: path.join(projectRoot, config.workspace.root),
    storeRoot: path.join(projectRoot, config.workspace.store),
  });
  await prepareStore(context);

  const policyGit = async (rootPath, args, options) => {
    if (args.join(' ') === 'remote get-url origin'
      || args.join(' ') === 'remote get-url --push origin') {
      return config.repository.remote.url;
    }
    return defaultGitRunner(rootPath, args, options);
  };
  const ready = () => assertCheckoutReady(config, { git: policyGit });
  const sourceSession = (relativePath, slug) => createEditSession({
    config,
    renderer: { relativePath, slug },
    git: policyGit,
  });

  const rebuilds = [];
  const dependencies = {
    assertCheckoutReady: ready,
    async runPreApplyChecks({ operation }) {
      return {
        ok: true,
        rendered: {
          witnesses: {
            old: Buffer.from(operation.expectedOldBytesBase64, 'base64').toString('utf8'),
            new: Buffer.from(operation.replacementBytesBase64, 'base64').toString('utf8'),
          },
        },
      };
    },
    async pushExactCommit(input) {
      return pushExactCommit({ ...input, remoteUrl: remote });
    },
    async discoverDeploymentRun({ applicationSha }) {
      return { binding: { provider: 'github-actions', runId: applicationSha.slice(0, 12), headSha: applicationSha, runAttempt: 1 } };
    },
    async monitorDeploymentRun({ applicationSha, boundRun }) {
      return { provider: 'github-actions', run: { ...boundRun, headSha: applicationSha }, environment: { state: 'success' } };
    },
    async confirmLivePage({ pageUrl, oldWitness, newWitness }) {
      return { pageUrl, oldWitness, newWitness, oldWitnessAbsent: true, newWitnessUnique: true };
    },
    async rebuildLocal({ commit, sourcePath }) {
      rebuilds.push({ commit, sourcePath });
      await writeFile(path.join(projectRoot, 'local-rebuild.txt'), `${commit} ${sourcePath}\n`, 'utf8');
      return { status: 'local-rebuilt', commit, sourcePath };
    },
  };
  const saveHandler = createSaveHandler({ config, projectRoot, context, dependencies });
  return {
    root,
    projectRoot,
    checkout,
    remote,
    config,
    configFile,
    context,
    sourceSession,
    saveHandler,
    rebuilds,
  };
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((target) => rm(target, { recursive: true, force: true })));
});

const acceptanceTest = process.env.OWNER_ALPHA_ACCEPTANCE === '1' ? test : test.skip;

acceptanceTest('browser Save and startup recovery compose through exact local Git effects', async () => {
  const fx = await fixture();
  const recoverySession = await fx.sourceSession('docs/recovery.md', 'docs/recovery');
  const recoveryOperation = deriveEditorOperation({
    session: recoverySession,
    editedText: recoverySession.source.text.replace('Recovery old value.', 'Recovery new value.'),
    config: fx.config,
  });
  expect(applyEditorOperation(recoverySession, recoveryOperation).toString('utf8'))
    .toContain('Recovery new value.');
  const recoveryJobId = 'OA-RECOVERY-ACCEPTANCE';
  const recoveryPaths = pipelineArtifactPaths(recoveryJobId);
  await createJsonArtifactOnce(fx.context, recoveryPaths.session, recoverySession);
  await createJsonArtifactOnce(fx.context, recoveryPaths.operation, recoveryOperation);
  await initializeDurableJob(fx.context, {
    jobId: recoveryJobId,
    policyRevision: computePolicyRevision(fx.config),
    at: new Date().toISOString(),
  });

  const siteRoot = path.join(fx.projectRoot, fx.config.workspace.site);
  const ownerOrigin = `http://${fx.config.listen.host}:${fx.config.listen.port}`;
  let runtime;
  let browser;
  try {
    runtime = await runOwnerAlphaServer({
      configFile: fx.configFile,
      projectRoot: fx.projectRoot,
      rebuildSite: async () => {
        await mkdir(siteRoot, { recursive: true });
        await writeFile(path.join(siteRoot, 'index.html'), `<!doctype html><html><body>
<a id="edit-page" href="${ownerOrigin}/owner/edit?relativePath=docs%2Fpage.md&slug=docs%2Fpage">Edit page</a>
</body></html>`);
      },
      loadPipeline: async () => fx.saveHandler,
      createHandler: (options) => createOwnerAlphaHandler({
        ...options,
        createEditSession: async ({ renderer }) => fx.sourceSession(
          renderer.relativePath,
          renderer.slug,
        ),
      }),
    });

    const recovered = await runtime.recovery;
    expect(recovered).toHaveLength(1);
    expect(recovered[0].jobId).toBe(recoveryJobId);
    expect(recovered[0].state).toBe('completed');
    expect(await readFile(path.join(fx.checkout, 'docs', 'recovery.md'), 'utf8'))
      .toContain('Recovery new value.');

    const { chromium } = await import(pathToFileURL(PLAYWRIGHT).href);
    browser = await chromium.launch({ headless: true });
    const firstContext = await browser.newContext();
    const firstPage = await firstContext.newPage();
    await firstPage.goto(`${runtime.ownerOrigin}/owner/bootstrap?token=${runtime.bootstrapToken}`);
    await firstPage.waitForURL(`${runtime.readerOrigin}/cyberbase/`);

    const staleSecondCapability = runtime.issueBootstrap();
    const liveSecondCapability = runtime.issueBootstrap();
    const secondContext = await browser.newContext();
    const secondPage = await secondContext.newPage();
    const staleResponse = await secondPage.goto(`${runtime.ownerOrigin}/owner/bootstrap?token=${staleSecondCapability}`);
    expect(staleResponse.status()).toBe(403);
    await secondPage.goto(`${runtime.ownerOrigin}/owner/bootstrap?token=${liveSecondCapability}`);
    await secondPage.waitForURL(`${runtime.readerOrigin}/cyberbase/`);
    await secondPage.click('#edit-page');
    await secondPage.waitForURL(`${runtime.ownerOrigin}/owner/edit?**`);
    expect(await secondPage.locator('#edited-text').inputValue()).toContain('Browser old value.');

    await firstPage.click('#edit-page');
    await firstPage.waitForURL(`${runtime.ownerOrigin}/owner/edit?**`);
    const edited = (await firstPage.locator('#edited-text').inputValue())
      .replace('Browser old value.', 'Browser new value.');
    await firstPage.locator('#edited-text').fill(edited);
    await firstPage.click('#save-button');
    await firstPage.waitForURL(`${runtime.ownerOrigin}/owner/jobs/**`);
    await firstPage.waitForFunction(
      () => document.querySelector('#job-state')?.textContent === 'completed',
      { timeout: 30_000 },
    );
    expect(await firstPage.locator('#job-state').textContent()).toBe('completed');

    expect(await readFile(path.join(fx.checkout, 'docs', 'page.md'), 'utf8'))
      .toContain('Browser new value.');
    const localHead = await git(fx.checkout, ['rev-parse', 'HEAD']);
    const remoteHead = await git(fx.remote, ['rev-parse', 'refs/heads/main']);
    expect(remoteHead).toBe(localHead);
    expect(await git(fx.checkout, ['show', '--format=', '--name-only', 'HEAD']))
      .toBe('docs/page.md');
    expect(await git(fx.checkout, ['rev-list', '--parents', '-n', '1', 'HEAD']))
      .toMatch(new RegExp(`^${localHead} [0-9a-f]{40}$`, 'u'));
    expect(fx.rebuilds.map((entry) => entry.sourcePath))
      .toEqual(['docs/recovery.md', 'docs/page.md']);
    expect(await readFile(path.join(fx.projectRoot, 'local-rebuild.txt'), 'utf8'))
      .toContain('docs/page.md');
  } finally {
    await browser?.close();
    runtime?.stop(true);
  }
}, 120_000);

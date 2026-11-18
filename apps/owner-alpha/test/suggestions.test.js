import { afterEach, describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  computePageId,
  createBareGitObjectResolver,
  createRetainedSourceBindingResolver,
  parseSourceBindingManifest,
} from '@cyberbaser/account-free-intake';
import { validateConfig as validateIntakeConfig } from '../../account-free-intake/src/config.js';
import { makeIntent } from '../../../packages/account-free-intake/test/fixtures.js';
import { OwnerAlphaError, PINNED_QUARTZ_COMMIT, validateOwnerAlphaConfig } from '../src/index.js';
import {
  SUGGESTION_PUBLICATION_REF_PREFIX,
  deriveIntakeConfig,
  retainPublication,
  startSuggestionIntake,
  suggestionFormOrigin,
  suggestionPaths,
  verifyRetainedPublication,
} from '../src/suggestions.js';

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(import.meta.dir, '..', '..', '..');
const INTAKE_ENTRY = path.join(REPO_ROOT, 'apps', 'account-free-intake', 'bin', 'server.js');
const REMOTE = 'https://github.com/cybersader/cyberbase.git';
const FORGE = 'https://forge.home.arpa:8443/cybersader/cyberbase.git';
const PAGE_TEXT = '# Public page\n\nCorrect teh typo.\n';
const OTHER_TEXT = '# Other\n\nMore words.\n';
const TRUST_TEXT = 'trusted: []\nagents: []\n';
const cleanup = [];

afterEach(async () => {
  for (const item of cleanup.splice(0).reverse()) await item();
});

function digest(bytes) {
  return `sha-256=:${createHash('sha256').update(bytes).digest('base64')}:`;
}

async function git(cwd, args) {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
  });
  return stdout.trim();
}

async function temporary(name) {
  const root = await mkdtemp(path.join(os.tmpdir(), `oa-suggest-${name}-`));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

function ownerConfig({ checkout, socketPath, port = 4317, form = true, forge = false }) {
  return validateOwnerAlphaConfig({
    schemaVersion: 1,
    listen: { host: '127.0.0.1', port },
    proposalReview: { enabled: true, socketPath, requestTimeoutMs: 5000, maxListEntries: 100 },
    repository: {
      checkout,
      remote: { name: 'origin', url: REMOTE },
      branch: 'main',
      ...(forge ? { aliases: [FORGE] } : {}),
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
    suggestions: {
      form: { enabled: form },
      forge: forge
        ? { enabled: true, repository: FORGE, tokenFile: null, pollIntervalMs: 60_000 }
        : { enabled: false },
    },
  });
}

async function checkoutFixture(root) {
  const checkout = path.join(root, 'cyberbase');
  await mkdir(path.join(checkout, 'pub'), { recursive: true });
  await mkdir(path.join(checkout, '.cyberbaser'), { recursive: true });
  await writeFile(path.join(checkout, 'publish.yml'), 'allow:\n  - "pub/**"\n');
  await writeFile(path.join(checkout, 'pub', 'Page.md'), PAGE_TEXT);
  await writeFile(path.join(checkout, 'pub', 'Other.md'), OTHER_TEXT);
  await writeFile(path.join(checkout, 'pub', 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await writeFile(path.join(checkout, '.cyberbaser', 'trust.yml'), TRUST_TEXT);
  await git(checkout, ['init', '-q', '-b', 'main']);
  await git(checkout, ['config', 'user.email', 'owner@example.invalid']);
  await git(checkout, ['config', 'user.name', 'Owner']);
  await git(checkout, ['add', '-A']);
  await git(checkout, ['commit', '-q', '-m', 'publication']);
  const head = await git(checkout, ['rev-parse', 'HEAD']);
  return { checkout, head };
}

describe('derived intake settings', () => {
  test('come from the owner config alone and validate as one complete intake config', async () => {
    const root = await temporary('derive');
    const socketPath = path.join(root, 'review.sock');
    const checkout = path.join(root, 'cyberbase');
    const project = path.join(root, 'cyberbaser');
    const paths = suggestionPaths(ownerConfig({ checkout, socketPath }), project);
    expect(paths.root).toBe(path.join(project, '.workspace', 'owner-alpha', 'suggestions'));

    const formOnly = deriveIntakeConfig(ownerConfig({ checkout, socketPath }), project);
    expect(formOnly).toEqual({
      schemaVersion: 1,
      enabled: true,
      publicOrigin: 'http://127.0.0.1:4319',
      listen: { host: '127.0.0.1', port: 4319 },
      allowedFormOrigins: ['http://127.0.0.1:4318'],
      repository: REMOTE,
      bindingsRoot: paths.bindingsRoot,
      gitDir: paths.gitDir,
      queue: {
        root: paths.queueRoot,
        maxPendingEntries: 1000,
        maxRetainedBytes: 268_435_456,
        maxPendingPerSource: 25,
        pendingRetentionMs: 2_592_000_000,
        expiredGraceMs: 604_800_000,
      },
      reviewIpc: { enabled: true, socketPath, requestTimeoutMs: 5000, maxConcurrentRequests: 4, maxListEntries: 100 },
      limits: {
        maxBodyBytes: 98_304,
        requestTimeoutMs: 5_000,
        maxConcurrentRequests: 4,
        tokenBucketCapacity: 20,
        tokenBucketRefillPerSecond: 1,
      },
    });
    expect(suggestionFormOrigin(ownerConfig({ checkout, socketPath }))).toBe('http://127.0.0.1:4319');
    const validated = validateIntakeConfig(structuredClone(formOnly));
    expect(validated.publicHost).toBe('127.0.0.1:4319');
    expect(validated.forgejo).toBeNull();

    const forgeOnly = deriveIntakeConfig(ownerConfig({ checkout, socketPath, form: false, forge: true }), project);
    expect(forgeOnly.listen).toBeNull();
    expect(forgeOnly.publicOrigin).toBeNull();
    expect(forgeOnly.allowedFormOrigins).toEqual([]);
    expect(forgeOnly.forgejo).toEqual({
      enabled: true,
      apiBaseUrl: 'https://forge.home.arpa:8443/api/v1',
      repository: { url: FORGE, owner: 'cybersader', name: 'cyberbase', baseBranch: 'main' },
      cloneDir: paths.cloneDir,
      pollIntervalMs: 60_000,
      tokenFile: null,
    });
    expect(validateIntakeConfig(structuredClone(forgeOnly)).forgejo.enabled).toBe(true);
    expect(suggestionFormOrigin(ownerConfig({ checkout, socketPath, form: false, forge: true }))).toBeNull();

    const both = deriveIntakeConfig(ownerConfig({ checkout, socketPath, forge: true }), project);
    expect(both.listen).toEqual({ host: '127.0.0.1', port: 4319 });
    expect(both.forgejo.enabled).toBe(true);
    expect(validateIntakeConfig(structuredClone(both)).forgejo.repository.url).toBe(FORGE);

    expect(deriveIntakeConfig(ownerConfig({ checkout, socketPath, form: false }), project)).toBeNull();
  });
});

describe('retained publication', () => {
  test('fetches HEAD into a bare store and writes the exact binding the intake resolves', async () => {
    const root = await temporary('retain');
    const { checkout, head } = await checkoutFixture(root);
    const project = path.join(root, 'cyberbaser');
    await mkdir(project, { recursive: true });
    const socketPath = path.join(root, 'review.sock');
    const config = ownerConfig({ checkout, socketPath });
    const treeDigest = `sha256:${'ab'.repeat(32)}`;

    const retained = await retainPublication({
      config,
      projectRoot: project,
      checkout: { root: checkout, head },
      publishedPaths: ['pub/Page.md', 'pub/image.png', 'pub/Other.md', 'pub/Page.md'],
      selectedTreeDigest: treeDigest,
    });
    const paths = suggestionPaths(config, project);
    expect(retained.gitDir).toBe(paths.gitDir);
    expect(retained.pages).toBe(2);
    expect(retained.trustPolicy).toEqual({ status: 'valid', digest: digest(Buffer.from(TRUST_TEXT)) });
    expect((await lstat(paths.root)).mode & 0o777).toBe(0o700);
    expect(await git(paths.gitDir, ['rev-parse', '--is-bare-repository'])).toBe('true');
    expect(await git(paths.gitDir, ['rev-parse', `${SUGGESTION_PUBLICATION_REF_PREFIX}${head}`])).toBe(head);
    expect(await git(paths.gitDir, ['config', 'gc.auto'])).toBe('0');

    const manifest = parseSourceBindingManifest(await readFile(retained.file));
    expect(manifest.source).toEqual({ repository: REMOTE, revision: head });
    expect(manifest.renderer).toEqual({ name: 'quartz-cyberbase', revision: PINNED_QUARTZ_COMMIT });
    expect(manifest.publication).toEqual({
      publishPolicyDigest: digest(Buffer.from('allow:\n  - "pub/**"\n')),
      selectedTreeDigest: `sha-256=:${Buffer.from('ab'.repeat(32), 'hex').toString('base64')}:`,
    });
    expect(manifest.pages.map((page) => page.path)).toEqual(['pub/Other.md', 'pub/Page.md']);
    expect(manifest.pages[1]).toEqual({
      pageId: computePageId({ repository: REMOTE, revision: head, path: 'pub/Page.md' }),
      path: 'pub/Page.md',
      byteLength: Buffer.byteLength(PAGE_TEXT),
      digest: digest(Buffer.from(PAGE_TEXT)),
    });

    // Exactly what the intake does with a form submission: resolve the retained
    // binding, then read the page bytes from the bare store at the pinned revision.
    const bindings = createRetainedSourceBindingResolver({ manifestRoot: paths.bindingsRoot });
    const binding = await bindings.resolve(retained.bindingDigest, manifest.pages[1].pageId);
    const resolver = createBareGitObjectResolver({ gitDirectory: paths.gitDir, repository: REMOTE });
    const evidence = await resolver.resolve(binding);
    expect(evidence.baseBytes.toString('utf8')).toBe(PAGE_TEXT);
    expect(evidence.policy.status).toBe('valid');

    // Idempotent for the same HEAD; the second run keeps the same file.
    const again = await retainPublication({
      config,
      projectRoot: project,
      checkout: { root: checkout, head },
      publishedPaths: ['pub/Page.md', 'pub/Other.md'],
      selectedTreeDigest: treeDigest,
    });
    expect(again.bindingDigest).toBe(retained.bindingDigest);
    expect(await readdir(paths.bindingsRoot)).toHaveLength(1);
    expect(await verifyRetainedPublication({ config, projectRoot: project, head, bindingDigest: retained.bindingDigest })).toBe(true);
    expect(await verifyRetainedPublication({ config, projectRoot: project, head, bindingDigest: digest(Buffer.from('x')) })).toBe(false);
    expect(await verifyRetainedPublication({ config, projectRoot: project, head: 'f'.repeat(40), bindingDigest: retained.bindingDigest })).toBe(false);

    // A new commit gives a new binding while the old one stays retained and resolvable.
    await writeFile(path.join(checkout, 'pub', 'Page.md'), `${PAGE_TEXT}\nMore.\n`);
    await git(checkout, ['commit', '-q', '-am', 'edit']);
    const nextHead = await git(checkout, ['rev-parse', 'HEAD']);
    const next = await retainPublication({
      config,
      projectRoot: project,
      checkout: { root: checkout, head: nextHead },
      publishedPaths: ['pub/Page.md', 'pub/Other.md'],
      selectedTreeDigest: treeDigest,
    });
    expect(next.bindingDigest).not.toBe(retained.bindingDigest);
    expect(await readdir(paths.bindingsRoot)).toHaveLength(2);
    expect(await verifyRetainedPublication({ config, projectRoot: project, head, bindingDigest: retained.bindingDigest })).toBe(true);
    expect((await resolver.resolve(binding)).baseBytes.toString('utf8')).toBe(PAGE_TEXT);

    // A HEAD that is not the branch tip fails closed and leaves no dangling ref.
    let failure = null;
    try {
      await retainPublication({
        config,
        projectRoot: project,
        checkout: { root: checkout, head: 'a'.repeat(40) },
        publishedPaths: ['pub/Page.md'],
        selectedTreeDigest: treeDigest,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(OwnerAlphaError);
    expect(failure.code).toBe('suggestion-store-head-mismatch');
    expect(await git(paths.gitDir, ['for-each-ref', '--format=%(refname)', SUGGESTION_PUBLICATION_REF_PREFIX]))
      .toBe([head, nextHead].map((sha) => `${SUGGESTION_PUBLICATION_REF_PREFIX}${sha}`).sort().join('\n'));

    // Form off means nothing to retain.
    let disabled = null;
    try {
      await retainPublication({
        config: ownerConfig({ checkout, socketPath, form: false }),
        projectRoot: project,
        checkout: { root: checkout, head: nextHead },
        publishedPaths: ['pub/Page.md'],
        selectedTreeDigest: treeDigest,
      });
    } catch (error) {
      disabled = error;
    }
    expect(disabled?.code).toBe('suggestion-form-disabled');
  });
});

describe('intake beside the owner app', () => {
  test('starts from the derived settings, takes one form suggestion from the private site, and stops', async () => {
    const root = await temporary('runtime');
    const { checkout, head } = await checkoutFixture(root);
    const project = path.join(root, 'cyberbaser');
    await mkdir(project, { recursive: true });
    const socketPath = path.join(root, 'run', 'review.sock');
    const config = ownerConfig({ checkout, socketPath, port: 4617 });
    const retained = await retainPublication({
      config,
      projectRoot: project,
      checkout: { root: checkout, head },
      publishedPaths: ['pub/Page.md', 'pub/Other.md'],
      selectedTreeDigest: `sha256:${'cd'.repeat(32)}`,
    });

    const intake = await startSuggestionIntake({ config, projectRoot: project, intakeEntry: INTAKE_ENTRY });
    cleanup.push(() => intake.close());
    expect(intake.formOrigin).toBe('http://127.0.0.1:4619');
    expect(intake.forge).toBeNull();
    expect(intake.ready).toContain('public form on 127.0.0.1:4619');
    expect(intake.ready).toContain('no forge watcher');
    const paths = suggestionPaths(config, project);
    expect(JSON.parse(await readFile(paths.configFile, 'utf8'))).toEqual(deriveIntakeConfig(config, project));
    expect((await lstat(paths.configFile)).mode & 0o777).toBe(0o600);
    expect((await lstat(socketPath)).isSocket()).toBe(true);

    const pageId = computePageId({ repository: REMOTE, revision: head, path: 'pub/Page.md' });
    const intent = makeIntent({ bindingDigest: retained.bindingDigest, pageId });
    const preflight = await fetch('http://127.0.0.1:4619/v1/corrections', {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://127.0.0.1:4618',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:4618');
    const submitted = await fetch('http://127.0.0.1:4619/v1/corrections', {
      method: 'POST',
      headers: { Origin: 'http://127.0.0.1:4618', 'Content-Type': 'application/json' },
      body: JSON.stringify(intent),
    });
    expect(submitted.status).toBe(202);
    const receipt = await submitted.json();
    expect(receipt.receipt.state).toBe('pending-review');
    const pending = await readdir(path.join(paths.queueRoot, 'pending'));
    expect(pending).toHaveLength(1);

    // Any other origin is refused: the form belongs to the owner's private site only.
    const foreign = await fetch('http://127.0.0.1:4619/v1/corrections', {
      method: 'POST',
      headers: { Origin: 'http://127.0.0.1:4700', 'Content-Type': 'application/json' },
      body: JSON.stringify(intent),
    });
    expect(foreign.status).toBe(403);

    expect(await intake.close()).toBe(0);
    expect(intake.exitCode()).toBe(0);
    let refused = null;
    try {
      await fetch('http://127.0.0.1:4619/v1/corrections', { method: 'OPTIONS' });
    } catch (error) {
      refused = error;
    }
    expect(refused).not.toBeNull();
  }, 30_000);

  test('fails closed when the intake exits before it is ready, and is absent when every lane is off', async () => {
    const root = await temporary('startfail');
    const checkout = path.join(root, 'cyberbase');
    const project = path.join(root, 'cyberbaser');
    await mkdir(project, { recursive: true });
    const socketPath = path.join(root, 'review.sock');
    const broken = path.join(root, 'broken.js');
    await writeFile(broken, "process.stderr.write('account-free intake failed: fixture\\n'); process.exit(1);\n");
    let failure = null;
    try {
      await startSuggestionIntake({ config: ownerConfig({ checkout, socketPath, port: 4627 }), projectRoot: project, intakeEntry: broken });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(OwnerAlphaError);
    expect(failure.code).toBe('suggestion-intake-start-failed');
    expect(failure.details.stderr).toContain('fixture');

    expect(await startSuggestionIntake({ config: ownerConfig({ checkout, socketPath, form: false }), projectRoot: project })).toBeNull();
  });
});

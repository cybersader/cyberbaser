import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import {
  inspectProposalQueue,
} from '@cyberbaser/proposal-queue';
import {
  openIntakeService,
  startReviewIpcServer,
  validateConfig as validateIntakeConfig,
} from '../../account-free-intake/src/index.js';
import {
  FORM_ORIGIN,
  configInput,
  createFixture,
  request as intakeRequest,
} from '../../account-free-intake/test/helpers.js';
import {
  OwnerAlphaError,
  createOwnerAlphaHandler,
  createOwnerProposalReviewService,
  createOwnerProposalReviewSource,
  createProposalReviewClient,
  defaultProposalReviewGit,
  defineStoreContext,
  prepareStore,
  recoverProposalDecisions,
  validateOwnerAlphaConfig,
} from '../src/index.js';

const acceptanceTest = process.env.OWNER_ALPHA_ACCEPTANCE === '1' ? test : test.skip;
const cleanup = [];
const runtimes = [];
const INTAKE_REPOSITORY = 'https://forge.example:8443/owner/wiki.git';
const OWNER_ORIGIN = 'http://127.0.0.1:4317';
const OWNER_HOST = '127.0.0.1:4317';

// These are read-only observations of the checkout and remote. Opening the
// proposal queue in this process raises the umask, and a racy `git status`
// would otherwise rewrite `.git/index` with that umask; optional locks stay off
// so the observation itself can never mutate the tree it is measuring.
async function git(cwd, args) {
  const child = Bun.spawn(['git', '-C', cwd, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${stderr || stdout}`);
  return stdout.trim();
}

function ownerConfig({ checkout, socketPath }) {
  return validateOwnerAlphaConfig({
    schemaVersion: 1,
    listen: { host: '127.0.0.1', port: 4317 },
    proposalReview: {
      enabled: true,
      socketPath,
      requestTimeoutMs: 5000,
      maxListEntries: 100,
    },
    repository: {
      checkout,
      remote: { name: 'origin', url: INTAKE_REPOSITORY },
      branch: 'main',
    },
    owner: { identity: 'owner', allowedTrustRoutes: ['auto-merge', 'quick-review'] },
    live: { baseUrl: 'https://published.example/' },
    workflow: {
      provider: 'forgejo-actions',
      apiBaseUrl: 'https://forge.example:8443/api/v1',
      repository: 'owner/wiki',
      path: '.forgejo/workflows/publish-site.yml',
      event: 'push',
      branch: 'main',
      jobs: ['build', 'deploy'],
      deploymentJob: 'deploy',
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
    git: {
      autoCommit: true,
      autoPush: true,
      useHooks: true,
      commitMessagePrefix: 'owner-alpha:',
    },
  });
}

async function snapshotTree(root, { exclude = [], identity = true } = {}) {
  const result = {};
  async function visit(directory, prefix = '') {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (exclude.some((candidate) => relative === candidate || relative.startsWith(`${candidate}/`))) continue;
      const absolute = path.join(directory, entry.name);
      const metadata = await lstat(absolute, { bigint: true });
      const common = {
        mode: Number(metadata.mode & 0o777n),
        nlink: Number(metadata.nlink),
        ...(identity ? {
          dev: metadata.dev.toString(),
          ino: metadata.ino.toString(),
        } : {}),
      };
      if (metadata.isDirectory()) {
        result[relative] = { type: 'directory', ...common };
        await visit(absolute, relative);
      } else if (metadata.isFile()) {
        const bytes = await readFile(absolute);
        result[relative] = {
          type: 'file',
          ...common,
          size: bytes.length,
          digest: createHash('sha256').update(bytes).digest('hex'),
        };
      } else {
        result[relative] = { type: 'other', ...common };
      }
    }
  }
  await visit(root);
  return result;
}

function ownerRequest(pathname, { method = 'GET', cookie = null, body = null } = {}) {
  const headers = new Headers({ Host: OWNER_HOST });
  if (cookie !== null) headers.set('Cookie', cookie);
  if (method === 'POST') {
    headers.set('Origin', OWNER_ORIGIN);
    headers.set('Content-Type', 'application/json');
  }
  return new Request(`${OWNER_ORIGIN}${pathname}`, { method, headers, body });
}

async function signIn(handler) {
  const bootstrap = await handler(ownerRequest(`/owner/bootstrap?token=${handler.bootstrapToken}`));
  expect(bootstrap.status).toBe(303);
  return bootstrap.headers.get('set-cookie').split(';', 1)[0];
}

async function submit(service, fixture, overrides) {
  const response = await service.fetch(intakeRequest('/v1/corrections', {
    method: 'POST',
    origin: FORM_ORIGIN,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fixture.intent(overrides)),
  }));
  expect(response.status).toBe(202);
  return (await response.json()).receipt;
}

async function recordDecision(handler, cookie, queueId, action, reason) {
  const detail = await handler(ownerRequest(`/owner/review/${queueId}`, { cookie }));
  expect(detail.status).toBe(200);
  const html = await detail.text();
  const digest = html.match(/data-review-evidence-digest="([^"]+)"/u)?.[1];
  const csrf = html.match(/data-csrf="([^"]+)"/u)?.[1];
  expect(digest).toMatch(/^sha-256=:/u);
  expect(csrf).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  const response = await handler(ownerRequest(`/api/review/${queueId}/decision`, {
    method: 'POST',
    cookie,
    body: JSON.stringify({ queueId, reviewEvidenceDigest: digest, action, reason, csrf }),
  }));
  expect(response.status).toBe(201);
  return response.json();
}

function createOwnerRuntime({ config, context, source, decisionClock, effects }) {
  const proposalReview = createOwnerProposalReviewService({
    config,
    context,
    source,
    decisionClock,
  });
  const handler = createOwnerAlphaHandler({
    config,
    proposalReview,
    createEditSession: async () => {
      effects.editSessions += 1;
      return { source: { text: 'must not be reached\n' } };
    },
    saveEdit: async () => {
      effects.saves += 1;
      throw new Error('proposal decisions must not invoke Save');
    },
    lookupJob: async () => {
      effects.jobLookups += 1;
      return null;
    },
  });
  return { proposalReview, handler };
}

async function expectQueueLockBusy(queueConfig) {
  try {
    await inspectProposalQueue({
      config: queueConfig,
      resolveEvidence: async () => {
        throw new Error('live writer lock must fail before offline evidence resolution');
      },
    });
  } catch (error) {
    expect(error.code).toBe('lock-busy');
    return;
  }
  throw new Error('offline queue inspection unexpectedly acquired the live writer lock');
}

afterEach(async () => {
  for (const runtime of runtimes.splice(0).reverse()) {
    await runtime.review?.close().catch(() => {});
    await runtime.service?.close().catch(() => {});
  }
  for (const item of cleanup.splice(0).reverse()) await item();
});

acceptanceTest('live same-host intake, owner decisions, restart recovery, and purge preserve the exact no-effect boundary', async () => {
  const fixture = await createFixture();
  cleanup.push(() => fixture.cleanup());
  const reviewRuntime = path.join(fixture.root, 'review-runtime');
  await mkdir(reviewRuntime, { mode: 0o700 });
  await chmod(reviewRuntime, 0o700);
  const socketPath = path.join(reviewRuntime, 'review.sock');
  const intakeConfig = validateIntakeConfig(configInput(fixture.root, {
    reviewIpc: {
      enabled: true,
      socketPath,
      requestTimeoutMs: 5000,
      maxConcurrentRequests: 4,
      maxListEntries: 100,
    },
  }));
  let intakeNow = new Date('2026-08-20T12:00:00Z');
  let queueSequence = 1;
  let proposalSequence = 1;
  const intake = await openIntakeService({
    config: intakeConfig,
    clock: () => intakeNow,
    queueIdFactory: () => `00000000-0000-4000-8000-${String(queueSequence++).padStart(12, '0')}`,
    proposalIdFactory: () => `00000000-0000-4000-8000-${String(proposalSequence++).padStart(12, '0')}`,
  });
  const review = await startReviewIpcServer({ config: intakeConfig, review: intake.review });
  runtimes.push({ service: intake, review });

  await expectQueueLockBusy(intakeConfig.queue);
  const first = await submit(intake, fixture, {
    rationale: 'Reject this first bounded correction for the acceptance proof.',
  });
  intakeNow = new Date('2026-08-21T12:00:00Z');
  const second = await submit(intake, fixture, {
    rationale: 'Approve intent for this second bounded correction.',
  });
  expect(first.queueId).not.toBe(second.queueId);

  const ownerProject = path.join(fixture.root, 'owner-runtime');
  await mkdir(ownerProject);
  await git(ownerProject, ['init', '-q', '--initial-branch=main']);
  await writeFile(path.join(ownerProject, '.gitignore'), '.workspace/\n');
  const checkout = path.join(fixture.root, 'checkout');
  const config = ownerConfig({ checkout, socketPath });
  const workspaceRoot = path.join(ownerProject, config.workspace.root);
  const storeRoot = path.join(ownerProject, config.workspace.store);
  const context = defineStoreContext({ projectRoot: ownerProject, workspaceRoot, storeRoot });
  await prepareStore(context);
  await recoverProposalDecisions(context);

  let ownerNow = new Date('2026-08-21T12:00:01Z');
  const reviewGit = async (root, args, options) => {
    const command = args.join(' ');
    if (command === 'remote get-url origin' || command === 'remote get-url --push origin') {
      return Buffer.from(`${INTAKE_REPOSITORY}\n`, 'utf8');
    }
    return defaultProposalReviewGit(root, args, options);
  };
  const createSource = () => createOwnerProposalReviewSource({
    config,
    client: createProposalReviewClient({ socketPath, requestTimeoutMs: 5000 }),
    clock: () => ownerNow,
    git: reviewGit,
  });
  const effects = { editSessions: 0, saves: 0, jobLookups: 0 };
  const firstOwner = createOwnerRuntime({
    config,
    context,
    source: createSource(),
    decisionClock: () => ownerNow,
    effects,
  });
  const cookie = await signIn(firstOwner.handler);

  const liveList = await firstOwner.handler(ownerRequest('/api/review', { cookie }));
  expect(liveList.status).toBe(200);
  expect((await liveList.json()).actionable.map((entry) => entry.summary.queueId)).toEqual([
    first.queueId,
    second.queueId,
  ]);

  const queueBefore = await snapshotTree(intakeConfig.queue.root);
  const checkoutBefore = await snapshotTree(checkout, { identity: false });
  const remoteBefore = await snapshotTree(intakeConfig.gitDir, { identity: false });
  const ownerOutsideReviewBefore = await snapshotTree(storeRoot, { exclude: ['proposal-review'], identity: false });
  const gitBefore = {
    head: await git(checkout, ['rev-parse', 'HEAD']),
    refs: await git(checkout, ['for-each-ref', '--format=%(refname) %(objectname)']),
    index: await git(checkout, ['ls-files', '--stage']),
    status: await git(checkout, ['status', '--porcelain=v1', '--untracked-files=all']),
    remoteHead: await git(intakeConfig.gitDir, ['rev-parse', 'refs/heads/main']),
  };
  const sourceBefore = await readFile(path.join(checkout, 'docs', 'notes.md'));

  const rejected = await recordDecision(
    firstOwner.handler,
    cookie,
    first.queueId,
    'reject',
    'The first proposal is intentionally rejected in the owner decision layer.',
  );
  expect(rejected.action).toBe('reject');
  const approved = await recordDecision(
    firstOwner.handler,
    cookie,
    second.queueId,
    'approve',
    'The second exact correction is appropriate for later owner-authorized application.',
  );
  expect(approved.action).toBe('approve');

  expect(await snapshotTree(intakeConfig.queue.root)).toEqual(queueBefore);
  expect(await snapshotTree(checkout, { identity: false })).toEqual(checkoutBefore);
  expect(await snapshotTree(intakeConfig.gitDir, { identity: false })).toEqual(remoteBefore);
  expect(await snapshotTree(storeRoot, { exclude: ['proposal-review'], identity: false })).toEqual(ownerOutsideReviewBefore);
  expect(await readFile(path.join(checkout, 'docs', 'notes.md'))).toEqual(sourceBefore);
  expect({
    head: await git(checkout, ['rev-parse', 'HEAD']),
    refs: await git(checkout, ['for-each-ref', '--format=%(refname) %(objectname)']),
    index: await git(checkout, ['ls-files', '--stage']),
    status: await git(checkout, ['status', '--porcelain=v1', '--untracked-files=all']),
    remoteHead: await git(intakeConfig.gitDir, ['rev-parse', 'refs/heads/main']),
  }).toEqual(gitBefore);
  expect(effects).toEqual({ editSessions: 0, saves: 0, jobLookups: 0 });

  const recovered = await recoverProposalDecisions(context);
  expect(recovered.decisions).toHaveLength(2);
  expect(recovered.index.decisions).toHaveLength(2);
  const decisionFiles = await readdir(path.join(storeRoot, 'proposal-review', 'decisions'));
  expect(decisionFiles.sort()).toEqual([`${first.queueId}.json`, `${second.queueId}.json`].sort());

  const restartedOwner = createOwnerRuntime({
    config,
    context,
    source: createSource(),
    decisionClock: () => ownerNow,
    effects,
  });
  const restartedCookie = await signIn(restartedOwner.handler);
  const restartedList = await restartedOwner.handler(ownerRequest('/api/review', {
    cookie: restartedCookie,
  }));
  const restartedBody = await restartedList.json();
  expect(restartedBody.actionable).toEqual([]);
  expect(restartedBody.history.map((entry) => entry.summary.queueId).sort()).toEqual([
    first.queueId,
    second.queueId,
  ].sort());
  await expectQueueLockBusy(intakeConfig.queue);

  intakeNow = new Date('2026-09-26T12:00:00Z');
  ownerNow = new Date('2026-09-26T12:00:01Z');
  const retention = await intake.queue.expireDue();
  expect(retention.purged).toEqual([first.queueId]);
  expect(retention.expired).toContain(second.queueId);

  const purgedHistory = await restartedOwner.handler(ownerRequest(
    `/owner/decisions/${first.queueId}`,
    { cookie: restartedCookie },
  ));
  const purgedHistoryBody = await purgedHistory.text();
  expect(purgedHistory.status, purgedHistoryBody).toBe(200);
  expect(purgedHistoryBody).toContain('No longer retained; exact reviewed evidence is embedded here.');

  const third = await submit(intake, fixture, {
    rationale: 'A third proposal proves intake continued after owner decisions and retention work.',
  });
  expect(third.state).toBe('pending-review');
  const finalList = await restartedOwner.handler(ownerRequest('/api/review', {
    cookie: restartedCookie,
  }));
  const finalBody = await finalList.json();
  expect(finalBody.actionable.map((entry) => entry.summary.queueId)).toEqual([third.queueId]);
  expect(finalBody.history).toHaveLength(2);
  expect(effects).toEqual({ editSessions: 0, saves: 0, jobLookups: 0 });
  await expectQueueLockBusy(intakeConfig.queue);
});

import { afterEach, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { createReviewEvidence } from '@cyberbaser/proposal-review';
import { openIntakeService } from '../../account-free-intake/src/index.js';
import {
  FORM_ORIGIN,
  createFixture,
  request as intakeRequest,
} from '../../account-free-intake/test/helpers.js';
import {
  CHECKPOINT_PAGES,
  CHECKPOINT_PROPOSALS,
  CHECKPOINT_REPOSITORY,
  checkpointIntent,
  checkpointOwnerConfig,
} from '../bin/review-checkpoint-corpus.js';
import {
  OwnerAlphaError,
  applyApprovedProposal,
  assertCheckoutReady,
  assessProposalApplication,
  createOwnerProposalReviewSource,
  createSaveHandler,
  defaultGitRunner,
  defaultProposalReviewGit,
  defineStoreContext,
  getOwnerAlphaJob,
  listApprovedProposalInputs,
  listProposalApplicationEvents,
  listProposalApplicationProgress,
  loadDurableJob,
  prepareStore,
  proposalApplicationEventPath,
  pushExactCommit,
  readJsonArtifact,
  recordProposalDecision,
  resolveRenderedPageSlug,
  validateProposalApplicationEvent,
} from '../src/index.js';
import { pipelineArtifactPaths } from '../src/pipeline.js';

const execFileAsync = promisify(execFile);
const cleanup = [];

afterEach(async () => {
  for (const item of cleanup.splice(0).reverse()) await item();
});

async function git(cwd, args) {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
  });
  return stdout.trim();
}

async function gitState(checkout) {
  return {
    head: await git(checkout, ['rev-parse', 'HEAD']),
    refs: await git(checkout, ['for-each-ref', '--format=%(refname) %(objectname)']),
    index: await git(checkout, ['ls-files', '--stage']),
    status: await git(checkout, ['status', '--porcelain=v1', '--untracked-files=all']),
  };
}

async function expectCode(action, code) {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(OwnerAlphaError);
    expect(error.code).toBe(code);
    return error;
  }
  throw new Error(`expected OwnerAlphaError(${code})`);
}

// The intake fixture's checkout pushes to a local bare repository while the
// owner policy names the forge URL; the same interception the acceptance
// fixture uses answers the policy URL for `remote get-url` only.
function policyGitFor(config) {
  return async (checkout, args, options) => {
    const joined = args.join(' ');
    if (joined === `remote get-url ${config.repository.remote.name}`
      || joined === `remote get-url --push ${config.repository.remote.name}`) {
      return `${config.repository.remote.url}\n`;
    }
    return defaultProposalReviewGit(checkout, args, options);
  };
}

async function ownerRuntime(fixture) {
  await git(fixture.checkout, ['remote', 'set-url', 'origin', fixture.bare]);
  await git(fixture.checkout, ['push', '-q', 'origin', 'main']);
  const ownerProject = path.join(fixture.root, 'owner-runtime');
  await mkdir(ownerProject, { mode: 0o700 });
  await git(ownerProject, ['init', '-q', '--initial-branch=main']);
  await writeFile(path.join(ownerProject, '.gitignore'), '.workspace/\n');
  const config = checkpointOwnerConfig({ checkout: fixture.checkout, socketPath: '/run/user/1000/cyberbaser/review.sock' });
  const context = defineStoreContext({
    projectRoot: ownerProject,
    workspaceRoot: path.join(ownerProject, config.workspace.root),
    storeRoot: path.join(ownerProject, config.workspace.store),
  });
  await prepareStore(context);
  const policyGit = policyGitFor(config);
  const policyRunner = async (rootPath, args, options) => {
    const joined = args.join(' ');
    if (joined === 'remote get-url origin' || joined === 'remote get-url --push origin') return config.repository.remote.url;
    return defaultGitRunner(rootPath, args, options);
  };
  const checkoutReady = () => assertCheckoutReady(config, { git: policyRunner });
  const completions = new Map();
  const dependencies = {
    assertCheckoutReady: checkoutReady,
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
      return pushExactCommit({ ...input, remoteUrl: fixture.bare });
    },
    async discoverDeploymentRun({ applicationSha }) {
      return { binding: { provider: 'forgejo-actions', runId: applicationSha.slice(0, 12), headSha: applicationSha, runAttempt: 1 } };
    },
    async monitorDeploymentRun({ applicationSha, boundRun }) {
      return { provider: 'forgejo-actions', run: { ...boundRun, headSha: applicationSha }, environment: { state: 'success' } };
    },
    async confirmLivePage({ pageUrl, oldWitness, newWitness }) {
      return { pageUrl, oldWitness, newWitness, oldWitnessAbsent: true, newWitnessUnique: true };
    },
    async rebuildLocal({ commit, sourcePath }) {
      return { status: 'local-rebuilt', commit, sourcePath };
    },
  };
  const handler = createSaveHandler({ config, projectRoot: ownerProject, context, dependencies });
  const saveEdit = async (input) => {
    const started = handler.startEdit(input);
    completions.set(input.jobId, started.completion);
    return started.accepted;
  };
  return { config, context, policyGit, checkoutReady, saveEdit, completions, ownerProject };
}

test('an approved suggestion reaches the page only through the separate apply act, once, through the owner pipeline', async () => {
  const fixture = await createFixture({ pages: CHECKPOINT_PAGES });
  cleanup.push(() => fixture.cleanup());
  fixture.bare = path.join(fixture.root, 'objects.git');
  const intake = await openIntakeService({ config: fixture.config });
  cleanup.push(() => intake.close());
  const submit = async (id) => {
    const proposal = CHECKPOINT_PROPOSALS.find((item) => item.id === id);
    const response = await intake.fetch(intakeRequest('/v1/corrections', {
      method: 'POST',
      origin: FORM_ORIGIN,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(checkpointIntent(fixture, proposal)),
    }));
    expect(response.status).toBe(202);
    return { proposal, queueId: (await response.json()).receipt.queueId };
  };
  const retention = await submit('retention-paragraph');
  const survey = await submit('survey-numbers');
  const checklist = await submit('checklist-link');
  const frontmatter = await submit('frontmatter-review-date');
  const rota = await submit('rota-handover-sentence');

  const runtime = await ownerRuntime(fixture);
  const { config, context, policyGit, checkoutReady, saveEdit, completions } = runtime;
  const source = createOwnerProposalReviewSource({
    config,
    git: policyGit,
    client: {
      async list() { return { entries: [], nextCursor: null }; },
      async load(queueId) {
        const entry = await intake.review.load(queueId);
        return createReviewEvidence({
          queueId: entry.queueId,
          proposalText: entry.proposalText,
          receipt: entry.receipt,
          carrier: entry.carrier,
          classification: entry.classification,
          state: entry.state,
        });
      },
    },
  });
  const decide = async (queueId, action) => {
    const validated = await source.load(queueId);
    return recordProposalDecision({
      context,
      source,
      ownerIdentity: 'owner',
      intent: { queueId, reviewEvidenceDigest: validated.summary.reviewEvidenceDigest, action, reason: `${action} for the application test.` },
    });
  };
  await decide(retention.queueId, 'approve');
  await decide(survey.queueId, 'reject');
  await decide(checklist.queueId, 'approve');
  await decide(frontmatter.queueId, 'approve');
  await decide(rota.queueId, 'approve');

  const resolveSlug = async (relativePath) => relativePath.replace(/\.md$/u, '');
  const assess = (queueId) => assessProposalApplication({ context, config, queueId, git: policyGit, resolveSlug });
  const before = await gitState(fixture.checkout);

  // Where each suggestion stands before anyone applies anything. Nothing is written.
  expect(await assess(retention.queueId)).toMatchObject({ state: 'eligible', branchTip: before.head, attempts: [], latest: null, input: null });
  expect(await assess(survey.queueId)).toMatchObject({ state: 'rejected' });
  expect(await assess('Q-00000000-0000-4000-8000-0000000000ff')).toMatchObject({ state: 'not-decided' });
  expect(await assess(frontmatter.queueId)).toMatchObject({ state: 'unapplicable', reason: 'frontmatter-change' });
  expect(await gitState(fixture.checkout)).toEqual(before);
  expect(await listApprovedProposalInputs(context)).toEqual([]);
  expect(await listProposalApplicationEvents(context)).toEqual([]);

  // Applying the frontmatter suggestion refuses before any event exists.
  const blocked = await applyApprovedProposal({ context, config, queueId: frontmatter.queueId, saveEdit, createJobId: () => 'OA-never', checkoutReady, git: policyGit, resolveSlug });
  expect(blocked).toMatchObject({ applied: false, status: { state: 'unapplicable', reason: 'frontmatter-change' }, event: null, job: null });
  expect(await listProposalApplicationEvents(context)).toEqual([]);
  expect(completions.size).toBe(0);

  // The owner edits and pushes the checklist page after approving it: stale, refused, nothing written.
  const checklistFile = path.join(fixture.checkout, checklist.proposal.path);
  await writeFile(checklistFile, `${await readFile(checklistFile, 'utf8')}4. Celebrate.\n`);
  await git(fixture.checkout, ['add', '--all']);
  await git(fixture.checkout, ['commit', '-q', '-m', 'Owner edits the checklist']);
  await git(fixture.checkout, ['push', '-q', 'origin', 'main']);
  const moved = await gitState(fixture.checkout);
  const stale = await applyApprovedProposal({ context, config, queueId: checklist.queueId, saveEdit, createJobId: () => 'OA-never', checkoutReady, git: policyGit, resolveSlug });
  expect(stale).toMatchObject({ applied: false, status: { state: 'stale', reason: 'source-changed', branchTip: moved.head }, event: null, job: null });
  expect(await assess(checklist.queueId)).toMatchObject({ state: 'stale', reason: 'source-changed' });
  expect(await gitState(fixture.checkout)).toEqual(moved);
  expect(await listProposalApplicationEvents(context)).toEqual([]);

  // The real act: one event, one ordinary Save job, exact bytes on the page, one commit, one push.
  const page = CHECKPOINT_PAGES.find((item) => item.path === retention.proposal.path);
  const expectedText = page.text.replace(retention.proposal.selection.quote, retention.proposal.replacement);
  const clock = () => new Date('2026-09-27T12:00:00Z');
  const applied = await applyApprovedProposal({ context, config, queueId: retention.queueId, saveEdit, createJobId: () => 'OA-retention-1', checkoutReady, git: policyGit, resolveSlug, clock });
  expect(applied.applied).toBe(true);
  expect(applied.job).toEqual({ jobId: 'OA-retention-1', state: 'accepted' });
  expect(applied.event).toMatchObject({
    queueId: retention.queueId,
    attempt: 1,
    appliedAt: '2026-09-27T12:00:00Z',
    authority: { type: 'owner-alpha-local', identity: 'owner' },
    source: { path: retention.proposal.path, revision: fixture.revision, branchTip: moved.head, slug: retention.proposal.path.replace(/\.md$/u, ''), liveUrl: `https://published.example/${retention.proposal.path.replace(/\.md$/u, '')}` },
    job: { jobId: 'OA-retention-1' },
  });
  const eventFile = proposalApplicationEventPath(context, retention.queueId, 1);
  const metadata = await lstat(eventFile);
  expect(metadata.isFile()).toBe(true);
  expect(metadata.mode & 0o777).toBe(0o600);
  expect(validateProposalApplicationEvent(JSON.parse(await readFile(eventFile, 'utf8')))).toEqual(applied.event);
  // Inputs are prepared for the frontmatter attempt too (its blob was eligible;
  // the pipeline rule refused later). They stay decision-only records.
  const inputs = await listApprovedProposalInputs(context);
  expect(inputs.map((input) => input.queueId).sort()).toEqual([frontmatter.queueId, retention.queueId].sort());
  expect(inputs.every((input) => input.applicationGate.state === 'not-authorized')).toBe(true);
  const retentionInput = inputs.find((input) => input.queueId === retention.queueId);

  const summary = await completions.get('OA-retention-1');
  expect(summary.state).toBe('completed');
  expect((await loadDurableJob(context, 'OA-retention-1')).state).toBe('completed');
  const session = await readJsonArtifact(context, pipelineArtifactPaths('OA-retention-1').session);
  expect(session.origin).toEqual({ type: 'approved-proposal', queueId: retention.queueId, proposalId: retentionInput.proposal.proposalId, inputDigest: applied.event.input.digest });
  expect(await readFile(path.join(fixture.checkout, retention.proposal.path), 'utf8')).toBe(expectedText);
  const after = await gitState(fixture.checkout);
  expect(after.status).toBe('');
  expect(after.head).not.toBe(moved.head);
  expect(await git(fixture.checkout, ['rev-parse', 'HEAD^'])).toBe(moved.head);
  expect(await git(fixture.checkout, ['log', '-1', '--format=%s'])).toBe(`owner-alpha: ${retention.proposal.path}`);
  expect(await git(fixture.checkout, ['diff', '--name-only', 'HEAD^', 'HEAD'])).toBe(retention.proposal.path);
  expect(await git(fixture.bare, ['rev-parse', 'refs/heads/main'])).toBe(after.head);

  // The cheap list view: applied and completed reads Live; nothing else is listed.
  const progress = await listProposalApplicationProgress(context, config);
  expect([...progress.keys()]).toEqual([retention.queueId]);
  expect(progress.get(retention.queueId)).toMatchObject({ state: 'live', jobId: 'OA-retention-1', jobState: 'completed', appliedAt: '2026-09-27T12:00:00Z' });
  const job = await getOwnerAlphaJob({ config, context, jobId: 'OA-retention-1' });
  expect(job.origin).toEqual({ type: 'approved-proposal', queueId: retention.queueId, relativePath: retention.proposal.path });

  // Exactly once: a second act on the same suggestion is refused, with nothing written.
  const twice = await applyApprovedProposal({ context, config, queueId: retention.queueId, saveEdit, createJobId: () => 'OA-retention-2', checkoutReady, git: policyGit, resolveSlug });
  expect(twice).toMatchObject({ applied: false, status: { state: 'applied', latest: { attempt: 1, jobId: 'OA-retention-1', jobState: 'completed', retryable: false } }, event: null, job: null });
  expect(await assess(retention.queueId)).toMatchObject({ state: 'applied', latest: { jobId: 'OA-retention-1', jobState: 'completed' } });
  expect((await listProposalApplicationEvents(context, { queueId: retention.queueId })).map((event) => event.attempt)).toEqual([1]);
  expect(await gitState(fixture.checkout)).toEqual(after);
  expect(completions.size).toBe(1);

  // A job that never started leaves a retryable attempt; the next act is attempt 2.
  const failingSave = async () => { throw new OwnerAlphaError('lock-busy', 'another owner action holds the store'); };
  await expectCode(() => applyApprovedProposal({ context, config, queueId: rota.queueId, saveEdit: failingSave, createJobId: () => 'OA-rota-1', checkoutReady, git: policyGit, resolveSlug, clock }), 'lock-busy');
  expect(await assess(rota.queueId)).toMatchObject({ state: 'eligible', attempts: [{ attempt: 1, jobId: 'OA-rota-1', jobState: null, retryable: true }] });
  expect((await listProposalApplicationProgress(context, config)).has(rota.queueId)).toBe(false);
  expect(await gitState(fixture.checkout)).toEqual(after);
  const retried = await applyApprovedProposal({ context, config, queueId: rota.queueId, saveEdit, createJobId: () => 'OA-rota-2', checkoutReady, git: policyGit, resolveSlug, clock });
  expect(retried.applied).toBe(true);
  expect(retried.event.attempt).toBe(2);
  expect((await completions.get('OA-rota-2')).state).toBe('completed');
  const rotaPage = CHECKPOINT_PAGES.find((item) => item.path === rota.proposal.path);
  expect(await readFile(path.join(fixture.checkout, rota.proposal.path), 'utf8')).toBe(rotaPage.text.replace(rota.proposal.selection.quote, rota.proposal.replacement));
  expect(await assess(rota.queueId)).toMatchObject({ state: 'applied', latest: { attempt: 2, jobId: 'OA-rota-2', jobState: 'completed' } });
  expect((await readdir(path.join(context.storeRoot, 'proposal-applications'))).filter((name) => name.endsWith('.json')).sort()).toEqual([
    `${retention.queueId}.1.json`,
    `${rota.queueId}.1.json`,
    `${rota.queueId}.2.json`,
  ].sort());
  expect(await git(fixture.bare, ['rev-parse', 'refs/heads/main'])).toBe((await gitState(fixture.checkout)).head);
}, 60_000);

test('the rendered owner site is the only source of a page slug, and a page it does not carry cannot be applied', async () => {
  const fixture = await createFixture({ pages: CHECKPOINT_PAGES });
  cleanup.push(() => fixture.cleanup());
  const siteRoot = path.join(fixture.root, 'site');
  const ownerOrigin = 'http://127.0.0.1:4317';
  await mkdir(path.join(siteRoot, 'handbook'), { recursive: true });
  const link = (relativePath, slug) => `<a href="${ownerOrigin}/owner/edit?relativePath=${encodeURIComponent(relativePath)}&amp;slug=${encodeURIComponent(slug)}">Edit</a>`;
  await writeFile(path.join(siteRoot, 'index.html'), `<html><body>${link('index.md', 'index')}</body></html>`);
  await writeFile(path.join(siteRoot, 'handbook', 'backup-retention.html'), `<html><body>${link('handbook/backup-retention.md', 'handbook/backup-retention')}</body></html>`);
  await writeFile(path.join(siteRoot, 'handbook', 'on-call-rota.html'), `<html><body>${link('handbook/on-call-rota.md', 'handbook/on-call-rota')} ${link('handbook/on-call-rota.md', 'handbook/on-call-rota')}</body></html>`);
  expect(await resolveRenderedPageSlug({ siteRoot, ownerOrigin, relativePath: 'handbook/backup-retention.md' })).toBe('handbook/backup-retention');
  expect(await resolveRenderedPageSlug({ siteRoot, ownerOrigin, relativePath: 'handbook/on-call-rota.md' })).toBe('handbook/on-call-rota');
  expect(await resolveRenderedPageSlug({ siteRoot, ownerOrigin, relativePath: 'handbook/incident-response.md' })).toBe(null);
  expect(await resolveRenderedPageSlug({ siteRoot: path.join(fixture.root, 'missing-site'), ownerOrigin, relativePath: 'index.md' })).toBe(null);
  await writeFile(path.join(siteRoot, 'conflict.html'), `<html><body>${link('handbook/backup-retention.md', 'elsewhere/backup-retention')}</body></html>`);
  await expectCode(() => resolveRenderedPageSlug({ siteRoot, ownerOrigin, relativePath: 'handbook/backup-retention.md' }), 'page-slug-ambiguous');
});

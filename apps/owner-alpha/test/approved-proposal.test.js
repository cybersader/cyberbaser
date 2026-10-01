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
  APPROVED_INPUT_AUTHORIZATION_STATE,
  OwnerAlphaError,
  applyAcceptedOperation,
  approvedProposalInputPath,
  createOwnerProposalReviewSource,
  defineStoreContext,
  listApprovedProposalInputs,
  prepareApprovedProposalInput,
  prepareStore,
  recordProposalDecision,
  recoverProposalDecisions,
  validateApprovedProposalInput,
} from '../src/index.js';

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

test('an approved decision prepares one create-once, never-consumable input and a stale source refuses', async () => {
  const fixture = await createFixture({ pages: CHECKPOINT_PAGES });
  cleanup.push(() => fixture.cleanup());
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

  await git(fixture.checkout, ['remote', 'set-url', 'origin', CHECKPOINT_REPOSITORY]);
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

  const source = createOwnerProposalReviewSource({
    config,
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
      intent: { queueId, reviewEvidenceDigest: validated.summary.reviewEvidenceDigest, action, reason: `${action} for the adapter test.` },
    });
  };
  await decide(retention.queueId, 'approve');
  await decide(survey.queueId, 'reject');
  await decide(checklist.queueId, 'approve');
  const decisionsBefore = (await readdir(path.join(context.storeRoot, 'proposal-review', 'decisions'))).sort();
  const before = await gitState(fixture.checkout);
  const sourceBefore = await readFile(path.join(fixture.checkout, retention.proposal.path));

  // Eligible: the reviewed blob is still the blob at the branch tip.
  const clock = () => new Date('2026-09-26T10:00:00Z');
  const first = await prepareApprovedProposalInput({ context, config, queueId: retention.queueId, clock });
  expect(first).toMatchObject({ prepared: true, replayed: false, eligibility: { eligible: true, reason: null, branchTip: before.head } });
  expect(first.input).toMatchObject({
    queueId: retention.queueId,
    preparedAt: '2026-09-26T10:00:00Z',
    source: { path: retention.proposal.path, revision: fixture.revision, branch: 'main', branchTip: before.head },
    applicationGate: { state: APPROVED_INPUT_AUTHORIZATION_STATE, event: null },
    effectBoundary: { appliesSource: false, writesSource: false, commits: false, pushes: false, deploys: false, publishes: false, rebuilds: false },
  });
  expect(first.input.candidate.byteLength).toBe(Buffer.byteLength(
    CHECKPOINT_PAGES.find((page) => page.path === retention.proposal.path).text.replace(retention.proposal.selection.quote, retention.proposal.replacement),
  ));
  const file = approvedProposalInputPath(context, retention.queueId);
  const metadata = await lstat(file);
  expect(metadata.isFile()).toBe(true);
  expect(metadata.mode & 0o777).toBe(0o600);
  expect(validateApprovedProposalInput(JSON.parse(await readFile(file, 'utf8')))).toEqual(first.input);

  // The artifact is not an accepted operation: the source applier refuses it outright.
  await expectCode(() => applyAcceptedOperation({ checkout: fixture.checkout, operation: first.input }), 'accepted-operation-required');
  const storedInput = JSON.parse(await readFile(file, 'utf8'));
  await expectCode(() => applyAcceptedOperation({ checkout: fixture.checkout, operation: storedInput }), 'accepted-operation-required');

  // Replay returns the same artifact with a fresh eligibility check.
  const replay = await prepareApprovedProposalInput({ context, config, queueId: retention.queueId, clock: () => new Date('2026-09-27T10:00:00Z') });
  expect(replay).toMatchObject({ prepared: true, replayed: true, eligibility: { eligible: true, reason: null } });
  expect(replay.input).toEqual(first.input);

  // Only Approve decisions, only recorded decisions.
  await expectCode(() => prepareApprovedProposalInput({ context, config, queueId: survey.queueId }), 'decision-not-approval');
  await expectCode(() => prepareApprovedProposalInput({ context, config, queueId: 'Q-00000000-0000-4000-8000-0000000000ff' }), 'decision-not-found');
  await expectCode(() => prepareApprovedProposalInput({ context, config, queueId: '../etc' }), 'invalid-input-queue-id');
  expect((await listApprovedProposalInputs(context)).map((input) => input.queueId)).toEqual([retention.queueId]);

  // Nothing outside the private input directory changed.
  expect(await gitState(fixture.checkout)).toEqual(before);
  expect(await readFile(path.join(fixture.checkout, retention.proposal.path))).toEqual(sourceBefore);
  expect((await readdir(path.join(context.storeRoot, 'proposal-review', 'decisions'))).sort()).toEqual(decisionsBefore);
  expect((await recoverProposalDecisions(context)).decisions).toHaveLength(3);

  // The owner edits the checklist page after approving: strict eligibility refuses, nothing is written.
  const checklistFile = path.join(fixture.checkout, checklist.proposal.path);
  await writeFile(checklistFile, `${await readFile(checklistFile, 'utf8')}4. Celebrate.\n`);
  await git(fixture.checkout, ['add', '--all']);
  await git(fixture.checkout, ['commit', '-q', '-m', 'Owner edits the checklist']);
  const moved = await gitState(fixture.checkout);
  const staleResult = await prepareApprovedProposalInput({ context, config, queueId: checklist.queueId });
  expect(staleResult).toEqual({ prepared: false, replayed: false, input: null, eligibility: { eligible: false, reason: 'source-changed', branchTip: moved.head } });
  await expect(lstat(approvedProposalInputPath(context, checklist.queueId))).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await listApprovedProposalInputs(context)).map((input) => input.queueId)).toEqual([retention.queueId]);

  // The untouched page stays eligible at the new tip; the prepared input is not rewritten.
  const stillEligible = await prepareApprovedProposalInput({ context, config, queueId: retention.queueId });
  expect(stillEligible).toMatchObject({ prepared: true, replayed: true, eligibility: { eligible: true, branchTip: moved.head } });
  expect(stillEligible.input.source.branchTip).toBe(before.head);

  // A trust-policy change makes even an untouched page stale.
  await writeFile(path.join(fixture.checkout, '.cyberbaser', 'trust.yml'), 'trusted: []\nagents: []\nnote: changed\n');
  await git(fixture.checkout, ['add', '--all']);
  await git(fixture.checkout, ['commit', '-q', '-m', 'Owner changes trust policy']);
  const afterPolicy = await gitState(fixture.checkout);
  const policyMoved = await prepareApprovedProposalInput({ context, config, queueId: retention.queueId });
  expect(policyMoved).toMatchObject({ prepared: true, replayed: true, eligibility: { eligible: false, reason: 'trust-policy-changed' } });
  expect(await gitState(fixture.checkout)).toEqual(afterPolicy);
});

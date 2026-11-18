import { afterEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import {
  prepareProposal,
  serializeProposal,
} from '@cyberbaser/proposal';
import {
  createOwnerDecision,
  createReviewEvidence,
  createReviewSummary,
  parseOwnerDecision,
  serializeOwnerDecision,
} from '@cyberbaser/proposal-review';
import {
  digestBytes,
  openProposalQueue,
} from '@cyberbaser/proposal-queue';
import { parseConfig } from '@cyberbaser/trust';
import {
  OwnerAlphaError,
  PROPOSAL_DECISION_INDEX,
  createOwnerProposalReviewService,
  createProposalDecisionOverlay,
  defineStoreContext,
  recordProposalDecision,
  recoverProposalDecisions,
  resolveStorePath,
  validateOwnerAlphaConfig,
} from '../src/index.js';

const execFileAsync = promisify(execFile);
const APP_ROOT = path.resolve(import.meta.dir, '..');
const EXAMPLE = path.join(APP_ROOT, 'owner-alpha.example.json');
const cleanup = [];
const queues = [];
const BASE = Buffer.from('A line about teh process.\n');
const POLICY_TEXT = 'trusted: []\nagents: []\n';
const RECEIVED_AT = '2026-08-20T12:00:00Z';

function digest(byte) {
  return `sha-256=:${Buffer.alloc(32, byte).toString('base64')}:`;
}

async function reviewConfig() {
  const raw = JSON.parse(await readFile(EXAMPLE, 'utf8'));
  raw.proposalReview.enabled = true;
  raw.proposalReview.socketPath = '/run/user/1000/cyberbaser/review.sock';
  return validateOwnerAlphaConfig(raw);
}

async function projectFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'owner-decisions-'));
  cleanup.push(root);
  await execFileAsync('git', ['init', '--initial-branch=main', root]);
  await writeFile(path.join(root, '.gitignore'), '.workspace/\n');
  const workspaceRoot = path.join(root, '.workspace', 'owner-alpha');
  const storeRoot = path.join(workspaceRoot, 'store');
  return {
    root,
    context: defineStoreContext({ projectRoot: root, workspaceRoot, storeRoot }),
  };
}

async function evidenceFixture(root) {
  const proposalText = serializeProposal(prepareProposal(BASE, {
    proposalId: 'owner-decision:test',
    source: {
      repository: 'https://github.com/cybersader/cyberbase.git',
      revision: 'a'.repeat(40),
      path: 'docs/example.md',
    },
    operation: {
      type: 'quote',
      selector: { quote: 'teh', prefix: 'A line about ', suffix: ' process.' },
      replacement: 'the',
    },
    submission: {
      submittedAt: RECEIVED_AT,
      rationale: 'Correct the misspelling.',
      evidence: [],
      identityClaim: null,
    },
  }));
  const policy = {
    status: 'valid',
    digest: digestBytes(Buffer.from(POLICY_TEXT)),
    config: parseConfig(POLICY_TEXT),
  };
  const queue = await openProposalQueue({
    config: { root: path.join(root, 'queue') },
    clock: () => RECEIVED_AT,
    idFactory: () => '00000000-0000-4000-8000-000000000001',
    resolveEvidence: async () => ({ baseBytes: BASE, policy }),
  });
  queues.push(queue);
  const accepted = await queue.enqueue({
    proposalText,
    baseBytes: BASE,
    policy,
    verifiedSubject: null,
    carrier: {
      lane: 'lane-b',
      metadata: { bindingDigest: digest(2), pageId: 'docs/example' },
    },
    idempotency: {
      scope: 'lane-b',
      key: randomBytes(32).toString('base64url'),
      requestDigest: digest(3),
    },
  });
  const entry = await queue.review.load(accepted.receipt.queueId);
  const evidence = createReviewEvidence({
    queueId: entry.queueId,
    proposalText: entry.proposalText,
    receipt: entry.receipt,
    carrier: entry.carrier,
    classification: entry.classification,
    state: entry.state,
  });
  return {
    evidence,
    validated: { evidence, summary: createReviewSummary(evidence) },
  };
}

function intent(validated, overrides = {}) {
  return {
    queueId: validated.summary.queueId,
    reviewEvidenceDigest: validated.summary.reviewEvidenceDigest,
    action: 'approve',
    reason: 'The exact correction is appropriate.',
    ...overrides,
  };
}

function source(validated, calls) {
  return Object.freeze({
    async load(queueId) {
      calls.push(queueId);
      return validated;
    },
  });
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

afterEach(async () => {
  await Promise.all(queues.splice(0).map((queue) => queue.close()));
  await Promise.all(cleanup.splice(0).map((target) => rm(target, { recursive: true, force: true })));
});

describe('immutable owner proposal decisions', () => {
  test('records one canonical decision and returns the original artifact for an identical retry', async () => {
    const project = await projectFixture();
    const item = await evidenceFixture(project.root);
    const calls = [];
    const first = await recordProposalDecision({
      context: project.context,
      source: source(item.validated, calls),
      ownerIdentity: 'cybersader',
      intent: intent(item.validated),
      clock: () => new Date('2026-08-20T12:00:01Z'),
    });
    expect(first.replayed).toBe(false);
    expect(first.decision).toMatchObject({
      queueId: item.validated.summary.queueId,
      action: 'approve',
      decidedAt: '2026-08-20T12:00:01Z',
      authorityScope: 'decision-only',
      effectBoundary: {
        appliesSource: false,
        writesSource: false,
        commits: false,
        pushes: false,
        deploys: false,
        publishes: false,
        rebuilds: false,
      },
    });
    const decisionFile = resolveStorePath(
      project.context,
      `proposal-review/decisions/${first.decision.queueId}.json`,
    );
    expect(parseOwnerDecision(await readFile(decisionFile))).toEqual(first.decision);

    const retry = await recordProposalDecision({
      context: project.context,
      source: source(item.validated, calls),
      ownerIdentity: 'cybersader',
      intent: intent(item.validated),
      clock: () => new Date('2026-08-20T12:00:09Z'),
    });
    expect(retry.replayed).toBe(true);
    expect(retry.decision.decidedAt).toBe('2026-08-20T12:00:01Z');
    await expectCode(() => recordProposalDecision({
      context: project.context,
      source: source(item.validated, calls),
      ownerIdentity: 'different-owner',
      intent: intent(item.validated),
      clock: () => new Date('2026-08-20T12:00:09Z'),
    }), 'decision-already-recorded');
    await expectCode(() => recordProposalDecision({
      context: project.context,
      source: source(item.validated, calls),
      ownerIdentity: 'x'.repeat(1025),
      intent: intent(item.validated),
      clock: () => new Date('2026-08-20T12:00:09Z'),
    }), 'invalid-decision-authority');
    expect(calls).toEqual([item.validated.summary.queueId]);
  });

  test('allows one concurrent creator and preserves an exact retry after lock contention', async () => {
    const project = await projectFixture();
    const item = await evidenceFixture(project.root);
    let releaseLoad;
    let signalEntered;
    const entered = new Promise((resolve) => { signalEntered = resolve; });
    const gate = new Promise((resolve) => { releaseLoad = resolve; });
    const blockedSource = Object.freeze({
      async load() {
        signalEntered();
        await gate;
        return item.validated;
      },
    });
    const first = recordProposalDecision({
      context: project.context,
      source: blockedSource,
      ownerIdentity: 'cybersader',
      intent: intent(item.validated),
      clock: () => new Date('2026-08-20T12:00:01Z'),
    });
    await entered;
    await expectCode(() => recordProposalDecision({
      context: project.context,
      source: source(item.validated, []),
      ownerIdentity: 'cybersader',
      intent: intent(item.validated),
      clock: () => new Date('2026-08-20T12:00:01Z'),
    }), 'lock-busy');
    releaseLoad();
    const created = await first;
    expect(created.replayed).toBe(false);

    const retry = await recordProposalDecision({
      context: project.context,
      source: source(item.validated, []),
      ownerIdentity: 'cybersader',
      intent: intent(item.validated),
      clock: () => new Date('2026-08-20T12:00:02Z'),
    });
    expect(retry.replayed).toBe(true);
    expect(retry.decision).toEqual(created.decision);
  });

  test('rejects a create-once race winner recorded by a different owner authority', async () => {
    const project = await projectFixture();
    const item = await evidenceFixture(project.root);
    let releaseLoad;
    let signalEntered;
    const entered = new Promise((resolve) => { signalEntered = resolve; });
    const gate = new Promise((resolve) => { releaseLoad = resolve; });
    const attempt = recordProposalDecision({
      context: project.context,
      source: Object.freeze({
        async load() {
          signalEntered();
          await gate;
          return item.validated;
        },
      }),
      ownerIdentity: 'different-owner',
      intent: intent(item.validated),
      clock: () => new Date('2026-08-20T12:00:02Z'),
    });
    await entered;
    const winner = createOwnerDecision({
      action: 'approve',
      reason: 'The exact correction is appropriate.',
      decidedAt: '2026-08-20T12:00:01Z',
      decisionAuthority: { type: 'owner-alpha-local', identity: 'cybersader' },
      reviewEvidence: item.evidence,
    });
    const file = resolveStorePath(
      project.context,
      `proposal-review/decisions/${winner.queueId}.json`,
    );
    await writeFile(file, serializeOwnerDecision(winner), { mode: 0o600, flag: 'wx' });
    releaseLoad();
    await expectCode(() => attempt, 'decision-already-recorded');
  });

  test('rejects contradictory retries before reloading live review evidence', async () => {
    const project = await projectFixture();
    const item = await evidenceFixture(project.root);
    const calls = [];
    const reviewSource = source(item.validated, calls);
    await recordProposalDecision({
      context: project.context,
      source: reviewSource,
      ownerIdentity: 'cybersader',
      intent: intent(item.validated),
      clock: () => new Date('2026-08-20T12:00:01Z'),
    });
    await expectCode(() => recordProposalDecision({
      context: project.context,
      source: reviewSource,
      ownerIdentity: 'cybersader',
      intent: intent(item.validated, { action: 'reject' }),
      clock: () => new Date('2026-08-20T12:00:02Z'),
    }), 'decision-already-recorded');
    await expectCode(() => recordProposalDecision({
      context: project.context,
      source: reviewSource,
      ownerIdentity: 'cybersader',
      intent: intent(item.validated, { reason: 'A contradictory reason.' }),
      clock: () => new Date('2026-08-20T12:00:02Z'),
    }), 'decision-already-recorded');
    expect(calls).toEqual([item.validated.summary.queueId]);
  });

  test('binds intent to freshly loaded evidence and enforces the decision-time expiry window', async () => {
    const project = await projectFixture();
    const item = await evidenceFixture(project.root);
    await expectCode(() => recordProposalDecision({
      context: project.context,
      source: source(item.validated, []),
      ownerIdentity: 'cybersader',
      intent: intent(item.validated, { reviewEvidenceDigest: digest(9) }),
      clock: () => new Date('2026-08-20T12:00:01Z'),
    }), 'decision-evidence-mismatch');

    const unbound = structuredClone(item.validated);
    unbound.summary.candidateDigest = digest(8);
    await expectCode(() => recordProposalDecision({
      context: project.context,
      source: source(unbound, []),
      ownerIdentity: 'cybersader',
      intent: intent(item.validated),
      clock: () => new Date('2026-08-20T12:00:01Z'),
    }), 'invalid-proposal-decision');

    await expectCode(() => recordProposalDecision({
      context: project.context,
      source: source(item.validated, []),
      ownerIdentity: 'cybersader',
      intent: intent(item.validated),
      clock: () => new Date(item.evidence.receipt.expiresAt),
    }), 'invalid-proposal-decision');
  });

  test('recovers missing, corrupt, stale, and interrupted derived indexes deterministically', async () => {
    const project = await projectFixture();
    const item = await evidenceFixture(project.root);
    const recorded = await recordProposalDecision({
      context: project.context,
      source: source(item.validated, []),
      ownerIdentity: 'cybersader',
      intent: intent(item.validated),
      clock: () => new Date('2026-08-20T12:00:01Z'),
    });
    const indexFile = resolveStorePath(project.context, PROPOSAL_DECISION_INDEX);
    const expected = await readFile(indexFile);

    await rm(indexFile);
    expect((await recoverProposalDecisions(project.context)).decisions).toEqual([recorded.decision]);
    expect(await readFile(indexFile)).toEqual(expected);

    await writeFile(indexFile, '{broken\n', { mode: 0o600 });
    await recoverProposalDecisions(project.context);
    expect(await readFile(indexFile)).toEqual(expected);

    await writeFile(indexFile, '{}\n', { mode: 0o600 });
    const temporary = path.join(
      path.dirname(indexFile),
      'index.json.tmp-123-00000000-0000-4000-8000-000000000002',
    );
    await writeFile(temporary, '{}\n', { mode: 0o600 });
    await recoverProposalDecisions(project.context);
    expect(await readFile(indexFile)).toEqual(expected);
    await expect(readFile(temporary)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('retains create-once authority after an index-write interruption', async () => {
    const project = await projectFixture();
    const firstItem = await evidenceFixture(project.root);
    await recordProposalDecision({
      context: project.context,
      source: source(firstItem.validated, []),
      ownerIdentity: 'cybersader',
      intent: intent(firstItem.validated),
      clock: () => new Date('2026-08-20T12:00:01Z'),
    });
    const currentIndex = await readFile(resolveStorePath(project.context, PROPOSAL_DECISION_INDEX));

    const secondEvidence = structuredClone(firstItem.evidence);
    secondEvidence.queueId = 'Q-00000000-0000-4000-8000-000000000002';
    secondEvidence.receipt.queueId = secondEvidence.queueId;
    secondEvidence.state.queueId = secondEvidence.queueId;
    const secondValidated = {
      evidence: secondEvidence,
      summary: createReviewSummary(secondEvidence),
    };
    await expectCode(() => recordProposalDecision({
      context: project.context,
      source: source(secondValidated, []),
      ownerIdentity: 'cybersader',
      intent: intent(secondValidated),
      clock: () => new Date('2026-08-20T12:00:02Z'),
      maxIndexBytes: currentIndex.length,
    }), 'decision-index-too-large');

    const recovered = await recoverProposalDecisions(project.context);
    expect(recovered.decisions.map((decision) => decision.queueId)).toEqual([
      firstItem.validated.summary.queueId,
      secondValidated.summary.queueId,
    ]);
  });

  test('blocks readiness on unsafe or invalid immutable decision artifacts', async () => {
    const project = await projectFixture();
    const item = await evidenceFixture(project.root);
    const recorded = await recordProposalDecision({
      context: project.context,
      source: source(item.validated, []),
      ownerIdentity: 'cybersader',
      intent: intent(item.validated),
      clock: () => new Date('2026-08-20T12:00:01Z'),
    });
    const decisionFile = resolveStorePath(
      project.context,
      `proposal-review/decisions/${recorded.decision.queueId}.json`,
    );
    await writeFile(decisionFile, '{}\n', { mode: 0o600 });
    await expectCode(() => recoverProposalDecisions(project.context), 'invalid-proposal-decision');

    await writeFile(decisionFile, `${JSON.stringify(recorded.decision)}\n`, { mode: 0o600 });
    const outside = path.join(project.root, 'outside.json');
    await writeFile(outside, '{}\n', { mode: 0o600 });
    await unlink(decisionFile);
    await symlink(outside, decisionFile);
    await expectCode(() => recoverProposalDecisions(project.context), 'unsafe-decision-entry');

    await rm(decisionFile);
    await link(outside, decisionFile);
    await expectCode(() => recoverProposalDecisions(project.context), 'unsafe-decision-artifact');
  });

  test('builds actionable and retained-history overlays without changing decisions', async () => {
    const project = await projectFixture();
    const item = await evidenceFixture(project.root);
    const tamperedUndecided = structuredClone(item.validated);
    tamperedUndecided.summary.route = 'reject';
    await expectCode(
      () => createProposalDecisionOverlay({ entries: [tamperedUndecided], decisions: [] }),
      'invalid-proposal-decision',
    );

    const recorded = await recordProposalDecision({
      context: project.context,
      source: source(item.validated, []),
      ownerIdentity: 'cybersader',
      intent: intent(item.validated, { action: 'reject', reason: 'The change is not appropriate.' }),
      clock: () => new Date('2026-08-20T12:00:01Z'),
    });

    const retained = createProposalDecisionOverlay({
      entries: [item.validated],
      decisions: [recorded.decision],
    });
    expect(retained.actionable).toEqual([]);
    expect(retained.history[0]).toMatchObject({ queueRetained: true });

    const disappeared = createProposalDecisionOverlay({
      entries: [],
      decisions: [recorded.decision],
    });
    expect(disappeared.history[0]).toMatchObject({ queueRetained: false });
    expect(disappeared.history[0].decision).toEqual(recorded.decision);

    const conflicting = structuredClone(item.validated);
    conflicting.summary.reviewEvidenceDigest = digest(9);
    await expectCode(
      () => createProposalDecisionOverlay({ entries: [conflicting], decisions: [recorded.decision] }),
      'invalid-proposal-decision',
    );
  });

  test('orders presentation history newest first with a stable queue-ID tie break', async () => {
    const project = await projectFixture();
    const item = await evidenceFixture(project.root);
    const secondEvidence = structuredClone(item.evidence);
    secondEvidence.queueId = 'Q-00000000-0000-4000-8000-000000000002';
    secondEvidence.receipt.queueId = secondEvidence.queueId;
    secondEvidence.state.queueId = secondEvidence.queueId;

    const older = createOwnerDecision({
      action: 'approve',
      reason: 'Older decision.',
      decidedAt: '2026-08-20T12:00:01Z',
      decisionAuthority: { type: 'owner-alpha-local', identity: 'cybersader' },
      reviewEvidence: item.evidence,
    });
    const newer = createOwnerDecision({
      action: 'reject',
      reason: 'Newer decision.',
      decidedAt: '2026-08-20T12:00:02Z',
      decisionAuthority: { type: 'owner-alpha-local', identity: 'cybersader' },
      reviewEvidence: secondEvidence,
    });
    const newestFirst = createProposalDecisionOverlay({ entries: [], decisions: [older, newer] });
    expect(newestFirst.history.map(({ decision }) => decision.queueId)).toEqual([
      newer.queueId,
      older.queueId,
    ]);

    const tied = createOwnerDecision({
      action: 'reject',
      reason: 'Same-time decision.',
      decidedAt: older.decidedAt,
      decisionAuthority: { type: 'owner-alpha-local', identity: 'cybersader' },
      reviewEvidence: secondEvidence,
    });
    const stableTie = createProposalDecisionOverlay({ entries: [], decisions: [tied, older] });
    expect(stableTie.history.map(({ decision }) => decision.queueId)).toEqual([
      older.queueId,
      tied.queueId,
    ]);
  });

  test('advances past decided-only queue pages and fails closed when cursors stop progressing', async () => {
    const project = await projectFixture();
    const item = await evidenceFixture(project.root);
    const recorded = await recordProposalDecision({
      context: project.context,
      source: source(item.validated, []),
      ownerIdentity: 'cybersader',
      intent: intent(item.validated),
      clock: () => new Date('2026-08-20T12:00:01Z'),
    });
    const secondEvidence = structuredClone(item.evidence);
    secondEvidence.queueId = 'Q-00000000-0000-4000-8000-000000000002';
    secondEvidence.receipt.queueId = secondEvidence.queueId;
    secondEvidence.state.queueId = secondEvidence.queueId;
    const secondEntry = { evidence: secondEvidence, summary: createReviewSummary(secondEvidence) };
    const cursors = [];
    const service = createOwnerProposalReviewService({
      config: await reviewConfig(),
      context: project.context,
      source: {
        async list({ cursor }) {
          cursors.push(cursor);
          return cursor === null
            ? { entries: [item.validated], nextCursor: 'second-page' }
            : { entries: [secondEntry], nextCursor: null };
        },
        async load() { throw new Error('not used'); },
      },
      recoverDecisions: async () => ({ decisions: [recorded.decision] }),
      recordDecision: async () => { throw new Error('not used'); },
    });
    const listed = await service.list();
    expect(cursors).toEqual([null, 'second-page']);
    expect(listed.actionable.map(({ summary }) => summary.queueId)).toEqual([secondEntry.summary.queueId]);
    expect(listed.nextCursor).toBeNull();

    const stalled = createOwnerProposalReviewService({
      config: await reviewConfig(),
      context: project.context,
      source: {
        async list({ cursor }) {
          return { entries: [item.validated], nextCursor: cursor ?? 'stalled' };
        },
        async load() { throw new Error('not used'); },
      },
      recoverDecisions: async () => ({ decisions: [recorded.decision] }),
      recordDecision: async () => { throw new Error('not used'); },
    });
    await expectCode(() => stalled.list(), 'review-ipc-invalid-cursor');
  });
});

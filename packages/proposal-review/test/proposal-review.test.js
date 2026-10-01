import { afterEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { parseConfig } from '@cyberbaser/trust';
import { prepareProposal, serializeProposal } from '@cyberbaser/proposal';
import { openProposalQueue } from '@cyberbaser/proposal-queue';
import reviewSchema from '../schema/proposal-review-v1.schema.json' with { type: 'json' };
import {
  OWNER_DECISION_ARTIFACT_TYPE,
  PROPOSAL_REVIEW_SCHEMA_VERSION,
  ProposalReviewError,
  REVIEW_EVIDENCE_ARTIFACT_TYPE,
  REVIEW_SUMMARY_ARTIFACT_TYPE,
  createOwnerDecision,
  createReviewEvidence,
  createReviewSummary,
  parseOwnerDecision,
  parseReviewEvidence,
  parseReviewSummary,
  reviewEvidenceDigest,
  serializeOwnerDecision,
  serializeReviewEvidence,
  serializeReviewSummary,
  validateOwnerDecision,
  validateReviewEvidence,
  validateReviewSummary,
} from '../src/index.js';

const cleanup = [];
const queues = [];
const BASE = Buffer.from('---\ntitle: Example\n---\n\nA line about teh process.\nTail with emoji 🧭 and é.\n');
const POLICY_DIGEST = `sha-256=:${Buffer.alloc(32, 1).toString('base64')}:`;
const TRUST_CONFIG = parseConfig(`
trusted:
  - forgejo:https://forge.example#user=7
agents: []
caps:
  lines: 60
  files: 5
  proseWords: 25
allowedNewFolders:
  - "docs/**"
frontmatterAllowlist:
  - title
`);
const schemaValidator = new Ajv2020({ allErrors: true, strict: false });
addFormats(schemaValidator);
const validateAgainstSchema = schemaValidator.compile(reviewSchema);

function stamp(second = 0) {
  return new Date(Date.UTC(2026, 7, 20, 12, 0, second)).toISOString().replace('.000Z', 'Z');
}

function digest(byte) {
  return `sha-256=:${Buffer.alloc(32, byte).toString('base64')}:`;
}

function mutable(value) {
  return JSON.parse(JSON.stringify(value));
}

function expectCode(action, code) {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ProposalReviewError);
    expect(error.code).toBe(code);
    return error;
  }
  throw new Error(`expected ProposalReviewError(${code})`);
}

async function evidenceFixture({ rationale = 'Correct the misspelling without changing meaning.' } = {}) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'proposal-review-'));
  cleanup.push(parent);
  const proposal = prepareProposal(BASE, {
    proposalId: 'lane-b:review-1',
    source: {
      repository: 'https://forge.example/owner/wiki.git',
      revision: 'a'.repeat(40),
      path: 'docs/example.md',
    },
    operation: {
      type: 'quote',
      selector: { quote: 'teh', prefix: 'A line about ', suffix: ' process.' },
      replacement: 'the',
    },
    submission: {
      submittedAt: stamp(),
      rationale,
      evidence: ['https://example.com/source'],
      identityClaim: null,
    },
  });
  const queue = await openProposalQueue({
    config: { root: path.join(parent, 'queue') },
    clock: () => stamp(1),
    idFactory: () => 'Q-12345678-1234-4123-8123-123456789abc',
    resolveEvidence: async () => ({
      baseBytes: BASE,
      policy: { status: 'valid', digest: POLICY_DIGEST, config: TRUST_CONFIG },
    }),
  });
  queues.push(queue);
  const accepted = await queue.enqueue({
    proposalText: serializeProposal(proposal),
    baseBytes: BASE,
    policy: { status: 'valid', digest: POLICY_DIGEST, config: TRUST_CONFIG },
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
  const entry = await queue.load(accepted.receipt.queueId);
  const evidence = createReviewEvidence({
    queueId: entry.queueId,
    proposalText: entry.proposalText,
    receipt: entry.receipt,
    carrier: entry.carrier,
    classification: entry.classification,
    state: entry.state,
  });
  return { queue, entry, evidence };
}

afterEach(async () => {
  await Promise.all(queues.splice(0).map((queue) => queue.close()));
  await Promise.all(cleanup.splice(0).map((target) => rm(target, { recursive: true, force: true })));
});

describe('canonical review evidence', () => {
  test('binds the exact queue artifacts and serializes recursively key-sorted JSON', async () => {
    const { evidence } = await evidenceFixture();
    expect(evidence.schemaVersion).toBe(PROPOSAL_REVIEW_SCHEMA_VERSION);
    expect(evidence.artifactType).toBe(REVIEW_EVIDENCE_ARTIFACT_TYPE);
    expect(evidence.queueId).toBe(evidence.receipt.queueId);
    expect(evidence.state.queueId).toBe(evidence.queueId);
    expect(evidence.classification.verifiedSubject).toBeNull();
    expect(Object.isFrozen(evidence)).toBe(true);

    const text = serializeReviewEvidence(evidence);
    expect(text.endsWith('\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
    expect(Object.keys(JSON.parse(text))).toEqual([
      'artifactType',
      'carrier',
      'classification',
      'proposal',
      'queueId',
      'receipt',
      'schemaVersion',
      'state',
    ]);
    expect(parseReviewEvidence(text)).toEqual(evidence);
    expect(reviewEvidenceDigest(parseReviewEvidence(text))).toBe(reviewEvidenceDigest(evidence));
    expect(validateAgainstSchema(evidence)).toBe(true);
  });

  test('derives one bounded decision-binding list summary', async () => {
    const { evidence } = await evidenceFixture();
    const summary = createReviewSummary(evidence);
    expect(summary).toMatchObject({
      artifactType: REVIEW_SUMMARY_ARTIFACT_TYPE,
      queueId: evidence.queueId,
      proposalId: evidence.proposal.proposalId,
      proposalDigest: evidence.receipt.proposalDigest,
      candidateDigest: evidence.proposal.operation.candidateDigest,
      reviewEvidenceDigest: reviewEvidenceDigest(evidence),
      source: evidence.proposal.source,
      lane: 'lane-b',
      state: 'pending-review',
      tier: 'anonymous',
      route: 'full-review',
    });
    const text = serializeReviewSummary(summary, evidence);
    expect(parseReviewSummary(text, evidence)).toEqual(summary);
    expect(validateReviewSummary(summary, evidence)).toEqual(summary);
    expect(validateAgainstSchema(summary)).toBe(true);

    const tampered = mutable(summary);
    tampered.route = 'auto-merge';
    expectCode(() => validateReviewSummary(tampered, evidence), 'summary-evidence-mismatch');
    expectCode(() => validateReviewSummary(summary), 'review-evidence-required');
  });

  test('counts canonical proposal lengths as UTF-8 bytes', async () => {
    const { evidence } = await evidenceFixture({ rationale: 'Correct the misspelling 🧭 without changing meaning.' });
    expect(createReviewSummary(evidence).proposalId).toBe('lane-b:review-1');
    expect(Buffer.byteLength(serializeReviewEvidence(evidence), 'utf8')).toBeGreaterThan(0);
  });

  test('orders integer-like nested keys lexicographically', async () => {
    const { evidence } = await evidenceFixture();
    const withIntegerKeys = mutable(evidence);
    withIntegerKeys.classification.classification.checks['10'] = 'ten';
    withIntegerKeys.classification.classification.checks['2'] = 'two';
    const text = serializeReviewEvidence(withIntegerKeys);
    expect(text.indexOf('\"10\":\"ten\"')).toBeLessThan(text.indexOf('\"2\":\"two\"'));
    expect(parseReviewEvidence(text)).toEqual(validateReviewEvidence(withIntegerKeys));
  });

  test('fails closed when cross-artifact bindings disagree', async () => {
    const { evidence } = await evidenceFixture();

    const queueMismatch = mutable(evidence);
    queueMismatch.receipt.queueId = 'Q-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    expectCode(() => validateReviewEvidence(queueMismatch), 'queue-id-mismatch');

    const laneMismatch = mutable(evidence);
    laneMismatch.carrier.lane = 'lane-a';
    laneMismatch.carrier.metadata = {
      repositoryId: '1',
      pullRequestNumber: 2,
      headSha: 'b'.repeat(40),
    };
    laneMismatch.carrier.replayScope = null;
    expectCode(() => validateReviewEvidence(laneMismatch), 'lane-mismatch');

    const digestMismatch = mutable(evidence);
    digestMismatch.receipt.proposalDigest = digest(9);
    expectCode(() => validateReviewEvidence(digestMismatch), 'proposal-digest-mismatch');

    const lengthMismatch = mutable(evidence);
    lengthMismatch.receipt.proposalByteLength += 1;
    expectCode(() => validateReviewEvidence(lengthMismatch), 'proposal-length-mismatch');

    const subjectMismatch = mutable(evidence);
    subjectMismatch.classification.verifiedSubject = { author: 'someone', authorType: 'human' };
    expectCode(() => validateReviewEvidence(subjectMismatch), 'lane-b-subject-mismatch');
  });

  test('rejects malformed, noncanonical, unsafe, and credential-bearing bytes', async () => {
    const { evidence } = await evidenceFixture();
    const canonical = serializeReviewEvidence(evidence);
    expectCode(() => parseReviewEvidence(`﻿${canonical}`), 'invalid-artifact-bytes');
    expectCode(() => parseReviewEvidence(JSON.stringify(evidence, null, 2)), 'noncanonical-artifact');
    expectCode(() => parseReviewEvidence(Buffer.from([0xff, 0xfe, 0xfd])), 'invalid-artifact-bytes');

    const unknown = mutable(evidence);
    unknown.extra = true;
    expectCode(() => validateReviewEvidence(unknown), 'unknown-field');

    const unsafe = mutable(evidence);
    unsafe.classification.classification.checks.bad = 1.5;
    expectCode(() => validateReviewEvidence(unsafe), 'invalid-dependent-artifact');

    const credential = mutable(evidence);
    credential.proposal.submission.rationale = 'Authorization: Bearer abcdefghijklmnop';
    expectCode(() => validateReviewEvidence(credential), 'credential-material');
  });
});

describe('decision-only owner artifacts', () => {
  test.each(['approve', 'reject'])('creates canonical %s intent with every effect disabled', async (action) => {
    const { evidence } = await evidenceFixture();
    const decision = createOwnerDecision({
      action,
      reason: action === 'approve' ? 'The exact correction is appropriate.' : 'The cited evidence does not support this change.',
      decidedAt: stamp(2),
      decisionAuthority: { type: 'owner-alpha-local', identity: 'owner:cybersader' },
      reviewEvidence: evidence,
    });
    expect(decision.artifactType).toBe(OWNER_DECISION_ARTIFACT_TYPE);
    expect(decision.authorityScope).toBe('decision-only');
    expect(Object.values(decision.effectBoundary)).toEqual([false, false, false, false, false, false, false]);
    expect(decision.reviewEvidenceDigest).toBe(reviewEvidenceDigest(evidence));
    expect(decision.reviewEvidence).toEqual(evidence);
    expect(Object.isFrozen(decision.reviewEvidence)).toBe(true);

    const text = serializeOwnerDecision(decision);
    expect(parseOwnerDecision(text)).toEqual(decision);
    expect(validateOwnerDecision(decision)).toEqual(decision);
    expect(validateAgainstSchema(decision)).toBe(true);
  });

  test('requires pending, unexpired, digest-bound evidence', async () => {
    const { evidence } = await evidenceFixture();
    const input = {
      action: 'approve',
      reason: 'The exact correction is appropriate.',
      decidedAt: stamp(2),
      decisionAuthority: { type: 'owner-alpha-local', identity: 'owner:cybersader' },
      reviewEvidence: evidence,
    };

    expectCode(() => createOwnerDecision({ ...input, decidedAt: stamp(0) }), 'decision-before-receipt');
    expectCode(() => createOwnerDecision({ ...input, decidedAt: evidence.receipt.expiresAt }), 'decision-expired');

    const expired = mutable(evidence);
    expired.state = {
      schemaVersion: 1,
      artifactType: 'cyberbaser-proposal-queue-state',
      queueId: evidence.queueId,
      state: 'expired',
      revision: 1,
      createdAt: evidence.state.createdAt,
      updatedAt: evidence.receipt.expiresAt,
      history: [
        ...evidence.state.history,
        {
          revision: 1,
          from: 'pending-review',
          to: 'expired',
          at: evidence.receipt.expiresAt,
          reason: 'retention-expired',
        },
      ],
    };
    expectCode(() => createOwnerDecision({ ...input, reviewEvidence: expired }), 'decision-ineligible-state');

    const decision = mutable(createOwnerDecision(input));
    decision.reviewEvidenceDigest = digest(8);
    expectCode(() => validateOwnerDecision(decision), 'decision-evidence-digest-mismatch');
  });

  test('rejects authority expansion, blank reasons, unknown fields, and credential material', async () => {
    const { evidence } = await evidenceFixture();
    const decision = mutable(createOwnerDecision({
      action: 'reject',
      reason: 'The proposal is not supported.',
      decidedAt: stamp(2),
      decisionAuthority: { type: 'owner-alpha-local', identity: 'owner:cybersader' },
      reviewEvidence: evidence,
    }));

    decision.effectBoundary.pushes = true;
    expectCode(() => validateOwnerDecision(decision), 'invalid-effect-boundary');

    const blank = mutable(decision);
    blank.effectBoundary.pushes = false;
    blank.reason = '';
    expectCode(() => validateOwnerDecision(blank), 'empty-string');

    const unknown = mutable(blank);
    unknown.reason = 'A valid reason.';
    unknown.ownerAuthorization = true;
    expectCode(() => validateOwnerDecision(unknown), 'unknown-field');

    const credential = mutable(blank);
    credential.reason = 'Bearer abcdefghijklmnopqrstuvwxyz';
    expectCode(() => validateOwnerDecision(credential), 'credential-material');
  });
});

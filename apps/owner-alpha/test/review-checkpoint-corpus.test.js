import { afterEach, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createReviewEvidence } from '@cyberbaser/proposal-review';
import { documentProjection } from '@cyberbaser/review-projection';
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
import { validateOwnerReviewEvidence } from '../src/index.js';

const execFileAsync = promisify(execFile);
const cleanup = [];

afterEach(async () => {
  for (const item of cleanup.splice(0).reverse()) await item();
});

function proposalText(bytesBase64) {
  return Buffer.from(bytesBase64, 'base64').toString('utf8');
}

// Mirrors the projection input the owner review page builds for one entry.
function projectionFor(validated) {
  const operation = validated.evidence.proposal.operation;
  const path = validated.summary.source.path;
  return documentProjection({
    files: [{
      path,
      exists: validated.document.baseText !== null,
      baseText: validated.document.baseText,
      candidateText: validated.document.candidateText,
    }],
    operations: [{
      path,
      start: operation.start,
      end: operation.end,
      oldText: proposalText(operation.expectedOldBytesBase64),
      replacementText: proposalText(operation.replacementBytesBase64),
    }],
  });
}

function inlineTypes(blocks) {
  const types = new Set();
  for (const block of blocks) {
    for (const token of block.tokens ?? []) types.add(token.type);
    for (const item of block.items ?? []) for (const token of item.tokens) types.add(token.type);
  }
  return types;
}

function changedBlockKinds(view) {
  const changed = view.segments.filter((segment) => segment.kind !== 'context');
  return new Set(view.blocks
    .filter((block) => changed.some((segment) => (segment.end > segment.start
      ? segment.start < block.end && segment.end > block.start
      : segment.start >= block.start && segment.start < block.end)))
    .map((block) => block.kind));
}

test('every checkpoint proposal enters through real intake, revalidates in owner review, and exercises what the pack claims', async () => {
  const fixture = await createFixture({ pages: CHECKPOINT_PAGES });
  cleanup.push(() => fixture.cleanup());
  const intake = await openIntakeService({ config: fixture.config });
  cleanup.push(() => intake.close());

  expect(new Set(CHECKPOINT_PROPOSALS.map((proposal) => proposal.id)).size).toBe(CHECKPOINT_PROPOSALS.length);
  expect(CHECKPOINT_PAGES.map((page) => page.path).sort()).toEqual(
    [...new Set(CHECKPOINT_PROPOSALS.map((proposal) => proposal.path))].sort(),
  );

  const receipts = [];
  for (const proposal of CHECKPOINT_PROPOSALS) {
    const response = await intake.fetch(intakeRequest('/v1/corrections', {
      method: 'POST',
      origin: FORM_ORIGIN,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(checkpointIntent(fixture, proposal)),
    }));
    expect(response.status, proposal.id).toBe(202);
    receipts.push({ proposal, receipt: (await response.json()).receipt });
  }

  await execFileAsync('git', ['-C', fixture.checkout, 'remote', 'set-url', 'origin', CHECKPOINT_REPOSITORY]);
  const config = checkpointOwnerConfig({
    checkout: fixture.checkout,
    socketPath: '/run/user/1000/cyberbaser/review.sock',
  });

  for (const { proposal, receipt } of receipts) {
    const entry = await intake.review.load(receipt.queueId);
    // The same field selection the private review socket sends to owner-alpha.
    const validated = await validateOwnerReviewEvidence({
      config,
      evidence: createReviewEvidence({
        queueId: entry.queueId,
        proposalText: entry.proposalText,
        receipt: entry.receipt,
        carrier: entry.carrier,
        classification: entry.classification,
        state: entry.state,
      }),
    });
    expect(validated.summary, proposal.id).toMatchObject({
      queueId: receipt.queueId,
      state: 'pending-review',
      lane: 'lane-b',
      tier: 'anonymous',
      route: 'full-review',
    });
    expect(validated.summary.source.path).toBe(proposal.path);
    expect(validated.document.reason).toBeNull();

    const projection = projectionFor(validated);
    const [file] = projection.files;
    expect(projection.modes, proposal.id).toEqual({
      changes: { available: true, reason: null },
      proposed: { available: true, reason: null },
      current: { available: true, reason: null },
    });

    const kinds = new Set(file.current.blocks.map((block) => block.kind));
    for (const kind of proposal.expects.blockKinds) expect(kinds, `${proposal.id} block ${kind}`).toContain(kind);

    const uninterpreted = new Set(file.current.blocks.flatMap((block) => block.uninterpreted));
    for (const label of proposal.expects.uninterpreted) expect(uninterpreted, `${proposal.id} degrade ${label}`).toContain(label);
    if (proposal.expects.uninterpreted.length === 0) expect(uninterpreted.size, `${proposal.id} fully interpreted`).toBe(0);

    const inline = inlineTypes(file.current.blocks);
    for (const type of proposal.expects.inlineTypes) expect(inline, `${proposal.id} inline ${type}`).toContain(type);

    const unifiedKinds = new Set(file.unified.segments.map((segment) => segment.kind));
    expect(unifiedKinds.has('removed'), `${proposal.id} removal`).toBe(proposal.expects.removal);
    expect(unifiedKinds.has('added'), `${proposal.id} addition`).toBe(proposal.expects.addition);
    if (!proposal.expects.addition) {
      expect(file.proposed.segments.some((segment) => segment.kind === 'deletion-point'), `${proposal.id} deletion point`).toBe(true);
    }

    if (proposal.expects.changedBlockKind) {
      expect(changedBlockKinds(file.current), `${proposal.id} changed block`).toEqual(new Set([proposal.expects.changedBlockKind]));
    }
    if (proposal.expects.minHeadings) {
      const headings = file.current.blocks.filter((block) => block.kind === 'heading').length;
      expect(headings, `${proposal.id} headings`).toBeGreaterThanOrEqual(proposal.expects.minHeadings);
    }
  }
});

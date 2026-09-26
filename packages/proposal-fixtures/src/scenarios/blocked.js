import { prepareProposal, proposalDigest, serializeProposal } from '@cyberbaser/proposal';
import { defaultLaneSupport, defaultOperatingEvidence } from '../contract.js';
import { baseFixture, intent, nonExecutableExactChange, operation, projection } from './helpers.js';

const staleHistoricalBase = Buffer.from('The archive is retained for one year.\n');
const staleHistoricalProposal = prepareProposal(staleHistoricalBase, {
  proposalId: 'fixture:blocked-stale-base',
  source: { repository: 'https://forge.example/owner/handbook.git', revision: 'historical-fixture-revision', path: 'guides/example.md' },
  operation: { type: 'quote', selector: { quote: 'one year', prefix: 'retained for ', suffix: '.\n' }, replacement: 'eighteen months' },
  submission: { submittedAt: '2026-08-21T12:00:00Z', rationale: 'Illustrate a historically valid proposal whose full source base later changed.', evidence: [], identityClaim: null },
});

function blocked({ fixtureId, title, summary, blocker, boundary, group = 'blocked', path = 'guides/example.md', baseText = 'Current source text.\n', oldText = 'Current', replacementText = 'Proposed', operationCount = 1, operations = null, laneSupport, operatingEvidence, canonicalArtifact = null, proposalDigest = null, notes = [] }) {
  const start = Buffer.from(baseText).indexOf(Buffer.from(oldText));
  const defaultOps = [operation({ operationId: 'blocked-1', label: 'Historical exact comparison', path, start: Math.max(0, start), end: Math.max(0, start) + Buffer.byteLength(oldText), oldText, replacementText })];
  return baseFixture({
    fixtureId, supportLevel: 'blocked-synthetic', evidenceClass: 'synthetic-mechanical', operationCount,
    attentionKind: 'blocked', attentionLabel: 'Blocked from decision', blocker, boundary,
    laneSupport,
    operatingEvidence: operatingEvidence ?? (group === 'pre-admission' ? defaultOperatingEvidence({
      queueLifecycle: ['not-admitted', 'The invalid case fails before queue admission.'],
      exactBinding: ['invalid', blocker],
      reviewAttention: ['none', 'No retained pending proposal exists.'],
    }) : undefined),
    intent: intent({ title, summary, rationale: blocker, category: 'other', declaredScope: `${operationCount} bounded operation${operationCount === 1 ? '' : 's'} shown as negative evidence` }),
    sourceFiles: [{ path, exists: true, baseText, candidateText: null }],
    exactChange: nonExecutableExactChange({ operations: operations ?? defaultOps, reason: blocker, canonicalArtifact, proposalDigest }),
    reviewProjection: projection({ pageLabel: 'Blocked evidence', title, titleProvenance: 'Negative synthetic fixture label', fallbackTitle: 'Blocked evidence', summary, identityDisclosure: 'Negative synthetic fixture. This is not a queued owner rejection.', provenance: { title: 'negative-fixture-label' } }),
    group, decisionControls: false, comparisonMode: 'blocked-evidence',
    notes: ['Decision unavailable', blocker, 'No decision was recorded', ...notes],
  });
}

export const blockedFixtures = Object.freeze([
  blocked({
    fixtureId: 'blocked-stale-base', title: 'Retention wording proposal is bound to an older source', summary: 'A historically valid comparison remains readable, but the current full-base digest differs.', blocker: 'Current canonical source no longer matches the proposal base digest.', boundary: 'exact-binding',
    baseText: 'The archive is retained for one year. A new owner note now follows this sentence.\n', oldText: 'one year', replacementText: 'eighteen months',
    canonicalArtifact: serializeProposal(staleHistoricalProposal),
    proposalDigest: proposalDigest(staleHistoricalProposal),
    operatingEvidence: defaultOperatingEvidence({ exactBinding: ['stale', 'The current full-base digest differs from the historically valid proposal binding.'], reviewAttention: ['blocked', 'Decision controls are unavailable.'] }),
  }),
  blocked({
    fixtureId: 'blocked-ambiguous-selection', title: 'Ambiguous selection never entered the queue', summary: 'The selected quote resolves more than once and fails before proposal preparation.', blocker: 'The exact quote resolves at more than one source location.', boundary: 'pre-admission-quote-resolution', group: 'pre-admission',
    baseText: 'Repeat this sentence. Repeat this sentence.\n', oldText: 'Repeat', replacementText: 'Replace',
    laneSupport: defaultLaneSupport({ laneA: false, laneB: false, sameHostOwnerReview: false }),
    operatingEvidence: defaultOperatingEvidence({ queueLifecycle: ['not-admitted', 'Ambiguity fails before queue admission.'], exactBinding: ['ambiguous', 'The quote resolves more than once.'], reviewAttention: ['none', 'No retained pending proposal exists.'] }),
  }),
  blocked({
    fixtureId: 'blocked-overlapping-v2-operations', title: 'Overlapping research operations are invalid', summary: 'The target-v2 research validator rejects overlapping base-relative ranges before candidate construction.', blocker: 'Research operations overlap on the immutable base.', boundary: 'target-v2-research-validation', group: 'pre-admission', operationCount: 2,
    baseText: 'Install the supported runtime.\n',
    operations: [
      operation({ operationId: 'bad-1', label: 'First overlapping range', path: 'guides/example.md', start: 0, end: 11, oldText: 'Install the', replacementText: 'Use the' }),
      operation({ operationId: 'bad-2', label: 'Second overlapping range', path: 'guides/example.md', start: 8, end: 21, oldText: 'the supported', replacementText: 'a supported' }),
    ],
  }),
  blocked({
    fixtureId: 'blocked-duplicate-start-insertions', title: 'Duplicate-start insertions are invalid', summary: 'Two target operations share one base boundary and fail before candidate construction.', blocker: 'Two operations use the same base start boundary.', boundary: 'target-v2-research-validation', group: 'pre-admission', operationCount: 2,
    baseText: 'One line.\n',
    operations: [
      operation({ operationId: 'bad-insert-1', label: 'First insertion', path: 'guides/example.md', start: 4, end: 4, oldText: '', replacementText: 'first ' }),
      operation({ operationId: 'bad-insert-2', label: 'Second insertion', path: 'guides/example.md', start: 4, end: 4, oldText: '', replacementText: 'second ' }),
    ],
  }),
  blocked({
    fixtureId: 'blocked-expired-queue-evidence', title: 'Proposal evidence expired before decision', summary: 'The queue lifecycle is expired, so owner decision controls are unavailable.', blocker: 'The retained review window expired before an owner decision.', boundary: 'queue-lifecycle',
    operatingEvidence: defaultOperatingEvidence({ queueLifecycle: ['expired', 'The queue lifecycle is expired.'], reviewAttention: ['blocked', 'Expired evidence cannot be decided.'] }),
  }),
  blocked({
    fixtureId: 'blocked-owner-policy-path-mismatch', title: 'Proposal path is outside owner policy', summary: 'The declared exact path remains visible, but current owner policy does not permit review at that path.', blocker: 'The proposal path is outside the owner’s current include/exclude policy.', boundary: 'owner-policy', path: 'private/outside-policy.md',
    operatingEvidence: defaultOperatingEvidence({ exactBinding: ['verified', 'The historical exact bytes are coherent.'], reviewAttention: ['blocked', 'Owner policy makes the proposal ineligible for decision.'] }),
  }),
  blocked({
    fixtureId: 'blocked-private-review-unavailable', title: 'Private review seam unavailable', summary: 'The owner surface cannot obtain bounded independently validated evidence.', blocker: 'The same-host private review seam is unavailable; source evidence is not guessed.', boundary: 'private-review-seam',
    operatingEvidence: defaultOperatingEvidence({ exactBinding: ['unavailable', 'The private review service could not supply independently validated evidence.'], reviewAttention: ['blocked', 'Decision controls remain unavailable.'] }),
  }),
]);

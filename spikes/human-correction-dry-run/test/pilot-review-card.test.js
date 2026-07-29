import { describe, expect, test } from 'bun:test';
import { buildPilotOwnerReview, reviewCardContractMissing } from '../src/pilot-review-card.js';

const submission = Object.freeze({
  attemptId: 'HC-01',
  openedAt: '2026-07-28T12:00:00.000Z',
  submittedAt: '2026-07-28T12:00:04.000Z',
  elapsedMs: 4000,
  rationale: 'The exact rationale remains private with the owner card.',
  factualSource: 'https://example.org/source',
  publicCreditName: 'Reader Name',
  creditConsent: 'no',
});

const operator = Object.freeze({
  profile: 'independent-counted',
  repository: 'https://example.org/owner/kb',
  checkoutDir: '/private/owner/kb',
  sourcePath: 'docs/guide.md',
  publicUrl: 'https://example.org/kb/guide',
  baseCommit: '1234567890abcdef1234567890abcdef12345678',
  sourceAuthorizedForLocalProcessing: true,
  publicationBoundary: 'not-applicable',
  readerUnaided: true,
  accessInterruption: false,
  independentOwnerAttested: true,
  correctionKind: 'factual',
  renderer: {
    profile: 'owner-static-output',
    basePath: 'kb',
    buildCommand: 'owner-build baseline; owner-build candidate',
  },
});

const evaluation = Object.freeze({
  artifactType: 'private-no-write-correction-evaluation',
  caseId: 'DRY-ABCDEF123456',
  case: {
    quote: 'Old exact text.',
    replacement: 'New exact text.',
    rationale: submission.rationale,
    kind: 'factual',
  },
  base: { byteLength: 100, digest: 'sha-256=:BASE:' },
  candidate: { byteLength: 100, digest: 'sha-256=:CANDIDATE:' },
  anchor: {
    start: 10,
    end: 25,
    expectedOldBytesVerified: true,
    resolvedExactlyOnce: true,
    quoteOccurrencesWithoutContext: 1,
    contextRequired: false,
    selector: { quote: 'Old exact text.' },
  },
  splice: {
    prefixBytesPreserved: 10,
    suffixBytesPreserved: 75,
    prefixIdentical: true,
    suffixIdentical: true,
    exactlyOneFile: true,
    exactlyOneSplice: true,
  },
  ofm: { verdict: 'clean', findings: [], stats: { churn: 0.1, escapesBefore: 0, escapesAfter: 0 } },
  trust: {
    policyRevision: 'owner-policy-v1',
    authorType: 'anonymous',
    tier: 'anonymous',
    route: 'full-review',
    reasons: ['anonymous author'],
    checks: {},
  },
});

const status = Object.freeze({
  artifactType: 'private-human-correction-pilot-preparation',
  attemptId: 'HC-01',
  profile: 'independent-counted',
  countsTowardPilot: false,
  ownerDecisionEligible: false,
  blockingReasons: ['render-evidence-required'],
  noWrite: {
    suppliedCheckoutWritePerformed: false,
    automaticSourceApplicationPerformed: false,
    publicDeploymentPerformed: false,
  },
});

describe('private pilot owner review card', () => {
  test('includes owner mapping and participant context with explicit pending-human status', () => {
    const card = buildPilotOwnerReview({ submission, operator, evaluation, status });
    expect(card.evidence.mapping.checkoutDir).toBe('/private/owner/kb');
    expect(card.evidence.mapping.sourcePath).toBe('docs/guide.md');
    expect(card.evidence.participantContext.publicCreditName).toBe('Reader Name');
    expect(card.evidence.participantContext.creditConsent).toBe('no');
    expect(card.evidence.participantContext.creditAffectsTrust).toBe(false);
    expect(card.evidence.trust.authorType).toBe('anonymous');
    expect(card.evidence.status.ownerDecision).toBe('pending-human-owner');
    expect(card.html).toContain('No source write or public deployment has occurred.');
    expect(card.html).toContain('The owner must complete the bound owner-decision.json by hand');
    expect(card.html).not.toMatch(/<script\b|\s(?:src|href|action)\s*=/iu);
  });

  test('reports missing rendered views, link totals, and source binding instead of treating a thin card as complete', () => {
    const missing = reviewCardContractMissing({
      operator,
      evaluation,
      renderEvidence: {
        artifactType: 'private-owner-static-output-render-evidence',
        renderedTarget: {
          comparable: { sameRenderedPage: true },
          baseline: { page: 'guide.html', quoteOccurrences: 1, replacementOccurrences: 0 },
          candidate: { page: 'guide.html', quoteOccurrences: 0, replacementOccurrences: 1 },
        },
        siteChecks: { baseline: {}, candidate: {}, linkDelta: { counts: {} } },
      },
    });
    expect(missing).toContain('rendering.baselineView');
    expect(missing).toContain('rendering.candidateView');
    expect(missing).toContain('links.baselineBroken');
    expect(missing).toContain('rendering.preparedSnapshots');
  });

  test('identical inputs produce byte-identical private JSON and HTML', () => {
    const first = buildPilotOwnerReview({ submission, operator, evaluation, status });
    const second = buildPilotOwnerReview({ submission, operator, evaluation, status });
    expect(second.json).toBe(first.json);
    expect(second.html).toBe(first.html);
  });
});

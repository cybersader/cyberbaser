import { defaultOperatingEvidence } from '../contract.js';
import { baseFixture, intent, nonExecutableExactChange, operation, projection } from './helpers.js';

function authorityFixture({ fixtureId, title, summary, states, notes }) {
  const path = 'handbook/authority-example.md';
  return baseFixture({
    fixtureId, supportLevel: 'authority-model-only', evidenceClass: 'static-design-only',
    attentionKind: 'decided', attentionLabel: 'Decided', boundary: 'authority-model',
    operatingEvidence: defaultOperatingEvidence(states),
    intent: intent({ title, summary, rationale: 'Illustrate independent authority and evidence axes without causing an effect.', category: 'other', declaredScope: 'Authority-model illustration only' }),
    sourceFiles: [{ path, exists: true, baseText: 'Source remains unchanged.\n', candidateText: null }],
    exactChange: nonExecutableExactChange({
      reason: 'Authority-model-only fixture. Historical scenario fields are illustrative; the mockup has no execution or decision authority.',
      proposalDigest: 'sha-256=:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=:',
      queueId: 'Q-authority-model',
      reviewEvidenceDigest: 'sha-256=:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=:',
      decisionId: 'D-authority-model',
      operations: [operation({ operationId: 'authority-1', label: 'Illustrative exact scope', path, start: 0, end: 6, oldText: 'Source', replacementText: 'Source' })],
    }),
    reviewProjection: projection({ pageLabel: 'Authority boundary', title, titleProvenance: 'Authority-model fixture label', fallbackTitle: 'Authority-model fixture', summary, identityDisclosure: 'Static authority model; no receiver-verified operational claim is made.', provenance: { title: 'authority-fixture-label' } }),
    group: 'decided', comparisonMode: 'authority-model', decisionControls: false,
    notes: ['Source unchanged', ...notes],
  });
}

export const authorityFixtures = Object.freeze([
  authorityFixture({
    fixtureId: 'authority-approved-not-authorized', title: 'Approved, not authorized to apply',
    summary: 'An immutable approval receipt records owner intent while source and all downstream systems remain unchanged.',
    states: { ownerDecision: ['approved', 'A real-shaped immutable approval receipt is illustrated.'], applicationAuthority: ['absent', 'Approval alone does not authorize source application.'] },
    notes: ['Approval recorded', 'No application requested or started', 'All current effect-boundary values are false.'],
  }),
  authorityFixture({
    fixtureId: 'authority-approved-later-stale', title: 'Historical approval remains approved after source drift',
    summary: 'Fresh application eligibility is blocked by changed canonical source; the historical decision is not rewritten as rejection.',
    states: { ownerDecision: ['approved', 'Historical owner intent remains approved.'], exactBinding: ['stale-for-application', 'Current canonical source no longer matches the approved base.'], applicationAuthority: ['absent', 'No separate application authority exists.'] },
    notes: ['Approval remains historical fact', 'Fresh application eligibility blocked', 'Not retroactively rejected.'],
  }),
  authorityFixture({
    fixtureId: 'authority-applied-deployment-failed', title: 'Exact application succeeded; deployment observation failed',
    summary: 'A future separately authorized source and Git result is illustrated beside a failed deployment observation and unconfirmed publication witness.',
    states: { ownerDecision: ['approved', 'An earlier immutable decision is illustrated.'], applicationAuthority: ['separately-authorized', 'A future separate authority event is assumed for illustration only.'], applicationResult: ['exact-change-and-git-recorded', 'Illustrative future application result; not caused by this mockup.'], deploymentObservation: ['failed', 'Illustrative provider observation reports failure.'], publicationWitness: ['unconfirmed', 'No live publication witness is confirmed.'] },
    notes: ['Future operational illustration', 'Deployment failed', 'Publication unconfirmed', 'The mockup itself causes no effect.'],
  }),
]);

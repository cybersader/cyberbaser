import { defaultLaneSupport, defaultOperatingEvidence } from '../contract.js';
import { baseFixture, intent, nonExecutableExactChange, operation, projection } from './helpers.js';

const variants = [
  ['escaped-active-content', 'Active-looking content stays literal text', 'Literal <script>alert("never")</script>, **instruction text**, and onerror="never" must render as text.', 'safe-rendering'],
  ['long-unbreakable-url', 'Long evidence stays contained', `A long unbreakable locator remains accessible without page overflow: https://example.com/${'a'.repeat(360)}`, 'layout-containment'],
  ['deceptive-canonical-https-host', 'Canonical HTTPS spelling is not verification', 'https://official-looking.example/reference is a syntactically canonical locator and remains visibly unverified.', 'reference-verification'],
  ['category-scope-mismatch', 'Declared category cannot hide computed scope', 'The contributor category remains “maintenance” while computed facts flag a metadata touch and broader attention.', 'review-attention'],
  ['credential-like-text', 'Credential-shaped intake is rejected', 'A pre-admission scanner identifies credential-shaped material and retains no proposal or queued evidence.', 'pre-admission-credential-scan'],
  ['bidi-invisible-text', 'Bidirectional and invisible characters are exposed safely', 'Source contains a visible marker for U+202E and U+200B plus the literal sample: abc‮txt​end.', 'safe-rendering'],
  ['no-op-operation', 'No-op operations fail before admission', 'Expected old bytes and replacement bytes are identical.', 'pre-admission-operation-validation'],
  ['whole-file-replacement', 'Whole-file replacement is outside v1', 'A range covering the complete nonempty existing file is rejected by current v1 limits.', 'pre-admission-operation-validation'],
  ['whole-file-deletion', 'Whole-file deletion is outside v1', 'A deletion covering the complete nonempty existing file is rejected by current v1 limits.', 'pre-admission-operation-validation'],
  ['invalid-utf8-boundary', 'Invalid UTF-8 boundaries fail closed', 'An offset inside a multi-byte character is rejected before operation preparation.', 'pre-admission-operation-validation'],
  ['stale-source-reapply', 'Stale source reapplication fails without mutation', 'A valid canonical artifact cannot apply to source bytes with a different base digest.', 'application-validation'],
  ['identity-claim-no-trust', 'Serialized identity claims grant no trust', 'A carrier identity claim remains inert until the receiver supplies independently verified trust evidence.', 'trust-route'],
  ['reference-is-not-verification', 'References are inert locators', 'A reference that looks authoritative remains unverified and grants no trust, integrity result, or authority.', 'reference-verification'],
];

export const adversarialFixtures = Object.freeze(variants.map(([fixtureId, title, summary, boundary]) => {
  const preAdmission = boundary.startsWith('pre-admission');
  const baseText = `${summary}\n`;
  return baseFixture({
    fixtureId, supportLevel: 'blocked-synthetic', evidenceClass: fixtureId === 'escaped-active-content' || fixtureId === 'long-unbreakable-url' || fixtureId === 'bidi-invisible-text' ? 'static-design-only' : 'synthetic-mechanical',
    attentionKind: 'adversarial', attentionLabel: preAdmission ? 'Failed before admission' : 'Evidence lab only', boundary,
    blocker: summary,
    laneSupport: preAdmission ? defaultLaneSupport({ laneA: false, laneB: false, sameHostOwnerReview: false }) : undefined,
    operatingEvidence: defaultOperatingEvidence({
      queueLifecycle: [preAdmission ? 'not-admitted' : 'not-created', preAdmission ? 'The invalid case produces no retained queue proposal.' : 'The static adversarial projection creates no queue state.'],
      exactBinding: [boundary, summary],
      reviewAttention: [preAdmission ? 'none' : 'evidence-lab', preAdmission ? 'No retained pending proposal exists.' : 'This negative case belongs in the evidence lab, not the owner inbox.'],
    }),
    intent: intent({ title, summary, rationale: summary, category: 'other', declaredScope: 'Adversarial fixture; no executable product claim' }),
    sourceFiles: [{ path: 'adversarial/example.md', exists: true, baseText, candidateText: null }],
    exactChange: nonExecutableExactChange({ reason: summary, operations: [operation({ operationId: 'negative-1', label: title, path: 'adversarial/example.md', start: 0, end: 0, oldText: '', replacementText: '' })] }),
    reviewProjection: projection({ pageLabel: 'Adversarial evidence', title, titleProvenance: 'Adversarial fixture label', fallbackTitle: 'Adversarial evidence', summary, identityDisclosure: 'Negative synthetic or static-design fixture. No trust or authority is inferred.', provenance: { title: 'fixture-label' } }),
    group: preAdmission ? 'pre-admission' : 'adversarial', comparisonMode: 'negative-evidence', decisionControls: false,
    notes: ['No decision was recorded', 'No source or authority effect occurred.'],
  });
}));

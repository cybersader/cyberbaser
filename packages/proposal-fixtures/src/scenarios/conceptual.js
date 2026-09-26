import { baseFixture, intent, nonExecutableExactChange, operation, projection } from './helpers.js';

export const conceptualFixtures = Object.freeze([
  baseFixture({
    fixtureId: 'later-two-guide-terminology-rename', supportLevel: 'conceptual-later', evidenceClass: 'static-design-only',
    fileCount: 2, operationCount: 2,
    intent: intent({ title: 'Use “review receipt” in both contributor guides', summary: 'Rename one concept across two existing guides.', rationale: 'The old term is inconsistent with the owner decision model.', category: 'restructure', declaredScope: 'Two existing pages; conceptual multi-file transaction' }),
    sourceFiles: [
      { path: 'guides/contributing.md', exists: true, baseText: 'Keep the moderation record.\n', candidateText: 'Keep the review receipt.\n' },
      { path: 'guides/offline.md', exists: true, baseText: 'Wait for a moderation record.\n', candidateText: 'Wait for a review receipt.\n' },
    ],
    exactChange: nonExecutableExactChange({
      reason: 'Conceptual later: multi-file transaction, locking, rollback, recovery, and separate application authority are unresolved.',
      operations: [
        operation({ operationId: 'concept-1', label: 'Rename the term in the contribution guide', path: 'guides/contributing.md', start: 9, end: 26, oldText: 'moderation record', replacementText: 'review receipt' }),
        operation({ operationId: 'concept-2', label: 'Rename the term in the offline guide', path: 'guides/offline.md', start: 11, end: 28, oldText: 'moderation record', replacementText: 'review receipt' }),
      ],
    }),
    reviewProjection: projection({ pageLabel: 'Two contributor guides', title: 'Use “review receipt” in both contributor guides', titleProvenance: 'Contributor-authored title', fallbackTitle: '2-page conceptual proposal', summary: 'Rename one concept across two existing guides.', identityDisclosure: 'Conceptual later. No executable artifact or decision controls exist.', provenance: { title: 'contributor-authored' } }),
    attentionKind: 'conceptual', attentionLabel: 'Conceptual later · no decision available', boundary: 'research-only',
    comparisonMode: 'multi-file-concept', decisionControls: false, group: 'conceptual',
    notes: ['Conceptual later', 'Unresolved: transaction, locking, rollback, recovery, and application authority.'],
  }),
  baseFixture({
    fixtureId: 'later-new-handoff-checklist-page', supportLevel: 'conceptual-later', evidenceClass: 'static-design-only',
    fileCount: 1, operationCount: 1,
    intent: intent({ title: 'Add a handoff checklist page', summary: 'Create a new checklist for transferring ownership of a knowledge base.', rationale: 'Existing guides describe handoff principles but provide no concise operational checklist.', category: 'expansion', declaredScope: 'One absent Markdown path; conceptual creation only' }),
    sourceFiles: [{ path: 'guides/handoff-checklist.md', exists: false, baseText: null, candidateText: '# Handoff checklist\n\n- Confirm the canonical source.\n- Transfer version-history access.\n- Record deployment ownership.\n' }],
    exactChange: nonExecutableExactChange({
      reason: 'Conceptual later: path authority, file-creation policy, publication selection, URL continuity, and transactional application are unresolved.',
      operations: [operation({ operationId: 'concept-new-1', label: 'Illustrate candidate bytes for an absent path', path: 'guides/handoff-checklist.md', start: 0, end: 0, oldText: '', replacementText: '# Handoff checklist\n\n- Confirm the canonical source.\n- Transfer version-history access.\n- Record deployment ownership.\n' })],
    }),
    reviewProjection: projection({ pageLabel: 'Handoff checklist', title: 'Add a handoff checklist page', titleProvenance: 'Contributor-authored title', fallbackTitle: 'Conceptual new-page proposal', summary: 'Create a concise operational handoff checklist.', identityDisclosure: 'Conceptual later. Candidate bytes are illustrative and no path authority exists.', provenance: { title: 'contributor-authored' } }),
    attentionKind: 'conceptual', attentionLabel: 'Conceptual later · no decision available', boundary: 'research-only',
    comparisonMode: 'new-file-concept', decisionControls: false, group: 'conceptual',
    notes: ['Conceptual later', 'Unresolved: path authority, creation policy, publication selection, URL continuity, and transaction semantics.'],
  }),
]);

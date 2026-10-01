import { defaultClaimCeiling, defaultLaneSupport, defaultOperatingEvidence, zeroAuthorityEffects } from '../contract.js';

export const baseFixture = ({
  fixtureId, supportLevel, evidenceClass = 'static-design-only', fileCount = 1,
  operationCount = 1, attentionKind = 'ready', attentionLabel = 'Needs your decision',
  boundary = 'private-owner-review', blocker = null, laneSupport, operatingEvidence,
  intent, sourceFiles, exactChange, reviewProjection, group = 'needs',
  comparisonMode = 'side-by-side', decisionControls = true, notes = [],
}) => ({
  fixtureSchemaVersion: 1,
  fixtureId,
  supportLevel,
  laneSupport: laneSupport ?? defaultLaneSupport(),
  evidenceClass,
  fileCount,
  operationCount,
  attentionState: { kind: attentionKind, label: attentionLabel, boundary, blocker },
  expectedAuthorityEffects: zeroAuthorityEffects(),
  operatingEvidence: operatingEvidence ?? defaultOperatingEvidence(),
  intent,
  sourceFiles,
  exactChange,
  reviewProjection,
  expectedPresentation: { group, comparisonMode, decisionControls, notes },
  claimCeiling: defaultClaimCeiling(evidenceClass),
});

export const intent = ({ title = null, summary, rationale, category = 'clarification', declaredScope = 'One bounded exact change', references = [], provenance = {} }) => ({
  title,
  summary,
  rationale,
  categoryClaims: [category],
  declaredScope,
  references: references.map(({ url, label }) => ({ url, label, verification: 'unverified' })),
  provenance: { summary: 'fixture-author', title: title === null ? 'absent' : 'fixture-author', ...provenance },
});

export const projection = ({ pageLabel, title, titleProvenance, fallbackTitle, summary, identityDisclosure, provenance = {} }) => ({
  pageLabel,
  title,
  titleProvenance,
  fallbackTitle,
  summary,
  provenance,
  identityDisclosure,
});

export const operation = ({ operationId, label, path, start, end, oldText, replacementText, contextBefore = '', contextAfter = '' }) => ({
  operationId, label, path, start, end, oldText, replacementText, contextBefore, contextAfter,
});

export const nonExecutableExactChange = ({ operations, reason, canonicalArtifact = null, proposalDigest = null, queueId = null, reviewEvidenceDigest = null, decisionId = null }) => ({
  executable: false,
  canonicalArtifact,
  proposalDigest,
  queueId,
  reviewEvidenceDigest,
  decisionId,
  executionBlockReason: reason,
  operations,
});

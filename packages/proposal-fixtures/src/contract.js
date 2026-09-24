import { applyProposal, parseProposal, proposalDigest } from '@cyberbaser/proposal';

const FIXTURE_KEYS = [
  'fixtureSchemaVersion', 'fixtureId', 'supportLevel', 'laneSupport', 'evidenceClass',
  'fileCount', 'operationCount', 'attentionState', 'expectedAuthorityEffects',
  'operatingEvidence', 'intent', 'sourceFiles', 'exactChange', 'reviewProjection',
  'expectedPresentation', 'claimCeiling',
];
const SUPPORT_LEVELS = Object.freeze([
  'executable-v1', 'target-v2-research', 'conceptual-later', 'blocked-synthetic',
  'authority-model-only',
]);
const FIXTURE_EVIDENCE_CLASSES = Object.freeze(['synthetic-mechanical', 'static-design-only']);
const EVIDENCE_LEVELS = Object.freeze([
  'synthetic-mechanical', 'static-design-only', 'maintainer-comprehension',
  'independent-human', 'live-effect',
]);
const EFFECT_KEYS = Object.freeze([
  'recordsDecision', 'changesQueueLifecycle', 'appliesSource', 'writesSource',
  'commits', 'pushes', 'rebuilds', 'deploys', 'publishes',
]);
const OPERATING_AXES = Object.freeze([
  'queueLifecycle', 'exactBinding', 'contentFidelity', 'trustRoute', 'reviewAttention',
  'ownerDecision', 'applicationAuthority', 'applicationResult',
  'deploymentObservation', 'publicationWitness',
]);
const LANE_KEYS = Object.freeze(['laneA', 'laneB', 'sameHostOwnerReview']);
const CREDENTIAL_KEY_RE = /(?:^|[-_])(?:authorization|cookie|password|passwd|secret|token|credential|api[-_]?key)(?:$|[-_])/iu;
const CREDENTIAL_VALUE_RE = /(?:bearer\s+[A-Za-z0-9+/_.=-]{8,}|-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----|:\/\/[^/@\s:]+:[^/@\s]+@)/iu;

/** @typedef {'executable-v1'|'target-v2-research'|'conceptual-later'|'blocked-synthetic'|'authority-model-only'} SupportLevel */
/** @typedef {'synthetic-mechanical'|'static-design-only'} FixtureEvidenceClass */
/** @typedef {'synthetic-mechanical'|'static-design-only'|'maintainer-comprehension'|'independent-human'|'live-effect'} EvidenceLevel */

export class FixtureContractError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'FixtureContractError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(code, message, details = {}) {
  throw new FixtureContractError(code, message, details);
}
function record(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('invalid-record', `${label} must be an object`);
  return value;
}
function exact(value, keys, label) {
  record(value, label);
  const actual = Object.keys(value);
  const unknown = actual.find((key) => !keys.includes(key));
  const missing = keys.find((key) => !Object.hasOwn(value, key));
  if (unknown) fail('unknown-field', `${label} contains unknown field ${unknown}`);
  if (missing) fail('missing-field', `${label} is missing ${missing}`);
  return value;
}
function text(value, label, { empty = false, max = 32 * 1024, controls = false } = {}) {
  if (typeof value !== 'string') fail('invalid-string', `${label} must be a string`);
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.toString('utf8') !== value) fail('invalid-unicode', `${label} must contain valid Unicode`);
  if (!empty && value.trim().length === 0) fail('empty-string', `${label} must contain text`);
  if (bytes.length > max) fail('string-too-large', `${label} exceeds ${max} UTF-8 bytes`);
  if (!controls && /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value)) fail('control-character', `${label} contains a control character`);
  return value;
}
function integer(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail('invalid-integer', `${label} must be a non-negative safe integer`);
  return value;
}
function nullableText(value, label) {
  return value === null ? null : text(value, label);
}
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}
function scanCredentialLike(value, label = 'fixture', depth = 0) {
  if (depth > 30) fail('fixture-depth', `${label} exceeds nesting limit`);
  if (Array.isArray(value)) return value.forEach((item, index) => scanCredentialLike(item, `${label}[${index}]`, depth + 1));
  if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      if (CREDENTIAL_KEY_RE.test(key)) fail('credential-like-fixture', `${label} uses forbidden credential-like key ${key}`);
      scanCredentialLike(nested, `${label}.${key}`, depth + 1);
    }
  } else if (typeof value === 'string' && CREDENTIAL_VALUE_RE.test(value)) {
    fail('credential-like-fixture', `${label} contains credential-like material`);
  }
}

function validateLaneSupport(value) {
  exact(value, LANE_KEYS, 'laneSupport');
  const result = {};
  for (const lane of LANE_KEYS) {
    const entry = exact(value[lane], ['representable', 'installed', 'offered', 'publiclyExposed', 'deployed', 'reason'], `laneSupport.${lane}`);
    for (const key of ['representable', 'installed', 'offered', 'publiclyExposed', 'deployed']) {
      if (typeof entry[key] !== 'boolean') fail('invalid-boolean', `laneSupport.${lane}.${key} must be boolean`);
    }
    if (['laneA', 'laneB'].includes(lane) && (entry.installed || entry.offered || entry.publiclyExposed || entry.deployed)) {
      fail('inflated-lane-claim', `${lane} cannot claim installed, offered, exposed, or deployed evidence`);
    }
    result[lane] = { ...entry, reason: text(entry.reason, `laneSupport.${lane}.reason`) };
  }
  return result;
}
function validateEffects(value) {
  exact(value, EFFECT_KEYS, 'expectedAuthorityEffects');
  for (const key of EFFECT_KEYS) if (value[key] !== false) fail('authority-effect', `expectedAuthorityEffects.${key} must be false`);
  return Object.fromEntries(EFFECT_KEYS.map((key) => [key, false]));
}
function validateOperatingEvidence(value) {
  exact(value, OPERATING_AXES, 'operatingEvidence');
  const result = {};
  for (const axis of OPERATING_AXES) {
    const entry = exact(value[axis], ['state', 'explanation'], `operatingEvidence.${axis}`);
    result[axis] = { state: text(entry.state, `${axis}.state`), explanation: text(entry.explanation, `${axis}.explanation`) };
  }
  return result;
}
function validateIntent(value) {
  exact(value, ['title', 'summary', 'rationale', 'categoryClaims', 'declaredScope', 'references', 'provenance'], 'intent');
  if (value.title !== null) text(value.title, 'intent.title');
  for (const key of ['summary', 'rationale', 'declaredScope']) text(value[key], `intent.${key}`);
  if (!Array.isArray(value.categoryClaims) || !Array.isArray(value.references)) fail('invalid-array', 'intent categories and references must be arrays');
  value.categoryClaims.forEach((item, index) => text(item, `intent.categoryClaims[${index}]`));
  value.references.forEach((item, index) => {
    const reference = exact(item, ['url', 'label', 'verification'], `intent.references[${index}]`);
    text(reference.url, `intent.references[${index}].url`);
    text(reference.label, `intent.references[${index}].label`);
    if (reference.verification !== 'unverified') fail('reference-inflation', 'fixture references must remain unverified');
  });
  record(value.provenance, 'intent.provenance');
  return structuredClone(value);
}
function validateSourceFiles(value, fileCount) {
  if (!Array.isArray(value) || value.length !== fileCount) fail('file-count-mismatch', 'sourceFiles length must equal fileCount');
  return value.map((item, index) => {
    exact(item, ['path', 'exists', 'baseText', 'candidateText'], `sourceFiles[${index}]`);
    text(item.path, `sourceFiles[${index}].path`);
    if (typeof item.exists !== 'boolean') fail('invalid-boolean', `sourceFiles[${index}].exists must be boolean`);
    if (item.baseText !== null) text(item.baseText, `sourceFiles[${index}].baseText`, { empty: true, max: 512 * 1024, controls: true });
    if (item.candidateText !== null) text(item.candidateText, `sourceFiles[${index}].candidateText`, { empty: true, max: 512 * 1024, controls: true });
    return structuredClone(item);
  });
}
function validateExactChange(value, operationCount) {
  exact(value, ['executable', 'canonicalArtifact', 'proposalDigest', 'queueId', 'reviewEvidenceDigest', 'decisionId', 'executionBlockReason', 'operations'], 'exactChange');
  if (typeof value.executable !== 'boolean') fail('invalid-boolean', 'exactChange.executable must be boolean');
  for (const key of ['canonicalArtifact', 'proposalDigest', 'queueId', 'reviewEvidenceDigest', 'decisionId', 'executionBlockReason']) nullableText(value[key], `exactChange.${key}`);
  if (!Array.isArray(value.operations) || value.operations.length !== operationCount) fail('operation-count-mismatch', 'exactChange.operations length must equal operationCount');
  value.operations.forEach((operation, index) => {
    exact(operation, ['operationId', 'label', 'path', 'start', 'end', 'oldText', 'replacementText', 'contextBefore', 'contextAfter'], `operation[${index}]`);
    for (const key of ['operationId', 'label', 'path', 'oldText', 'replacementText', 'contextBefore', 'contextAfter']) text(operation[key], `operation[${index}].${key}`, { empty: ['oldText', 'replacementText', 'contextBefore', 'contextAfter'].includes(key), max: 128 * 1024, controls: true });
    integer(operation.start, `operation[${index}].start`);
    integer(operation.end, `operation[${index}].end`);
    if (operation.end < operation.start) fail('invalid-range', `operation[${index}] has reversed range`);
  });
  return structuredClone(value);
}
function validateExecutableV1Consistency(fixture) {
  const { exactChange, fileCount, operationCount, sourceFiles } = fixture;
  if (fileCount !== 1 || operationCount !== 1) {
    fail('invalid-executable-scope', 'executable-v1 must describe exactly one existing Markdown file and one operation');
  }
  const source = sourceFiles[0];
  const operation = exactChange.operations[0];
  if (!source.exists || source.baseText === null || source.candidateText === null) {
    fail('invalid-executable-source', 'executable-v1 requires one existing source with exact base and candidate text');
  }

  let proposal;
  let candidate;
  try {
    proposal = parseProposal(exactChange.canonicalArtifact);
    candidate = applyProposal(Buffer.from(source.baseText, 'utf8'), proposal);
  } catch (error) {
    fail('invalid-executable-artifact', 'executable-v1 canonical evidence must parse and apply to the declared base', {
      cause: typeof error?.code === 'string' ? error.code : 'proposal-error',
    });
  }

  if (proposalDigest(proposal) !== exactChange.proposalDigest) {
    fail('executable-digest-mismatch', 'executable-v1 proposalDigest must match its canonical artifact');
  }
  if (proposal.source.path !== source.path || operation.path !== source.path) {
    fail('executable-path-mismatch', 'executable-v1 artifact, source, and operation paths must match');
  }
  const canonicalOperation = proposal.operation;
  const oldText = Buffer.from(canonicalOperation.expectedOldBytesBase64, 'base64').toString('utf8');
  const replacementText = Buffer.from(canonicalOperation.replacementBytesBase64, 'base64').toString('utf8');
  if (
    operation.start !== canonicalOperation.start
    || operation.end !== canonicalOperation.end
    || operation.oldText !== oldText
    || operation.replacementText !== replacementText
  ) {
    fail('executable-operation-mismatch', 'executable-v1 operation projection must match the canonical artifact');
  }
  if (!candidate.equals(Buffer.from(source.candidateText, 'utf8'))) {
    fail('executable-candidate-mismatch', 'executable-v1 candidate text must equal the canonical artifact applied to the declared base');
  }
}

function validateReviewProjection(value) {
  exact(value, ['pageLabel', 'title', 'titleProvenance', 'fallbackTitle', 'summary', 'provenance', 'identityDisclosure'], 'reviewProjection');
  for (const key of ['pageLabel', 'title', 'titleProvenance', 'fallbackTitle', 'summary', 'identityDisclosure']) text(value[key], `reviewProjection.${key}`);
  record(value.provenance, 'reviewProjection.provenance');
  return structuredClone(value);
}
function validatePresentation(value) {
  exact(value, ['group', 'comparisonMode', 'decisionControls', 'notes'], 'expectedPresentation');
  for (const key of ['group', 'comparisonMode']) text(value[key], `expectedPresentation.${key}`);
  if (typeof value.decisionControls !== 'boolean' || !Array.isArray(value.notes)) fail('invalid-presentation', 'expectedPresentation is invalid');
  value.notes.forEach((note, index) => text(note, `expectedPresentation.notes[${index}]`));
  return structuredClone(value);
}
function validateClaimCeiling(value, evidenceClass) {
  exact(value, ['maxEvidenceLevel', 'prohibitedClaims'], 'claimCeiling');
  if (!EVIDENCE_LEVELS.includes(value.maxEvidenceLevel)) fail('invalid-evidence-level', 'claimCeiling.maxEvidenceLevel is invalid');
  if (value.maxEvidenceLevel !== evidenceClass) fail('claim-inflation', 'fixture claim ceiling must equal its fixture evidence class');
  if (!Array.isArray(value.prohibitedClaims)) fail('invalid-array', 'claimCeiling.prohibitedClaims must be an array');
  const required = ['maintainer-comprehension', 'independent-human', 'live-effect'];
  for (const claim of required) if (!value.prohibitedClaims.includes(claim)) fail('claim-inflation', `claim ceiling must prohibit ${claim}`);
  value.prohibitedClaims.forEach((item, index) => text(item, `claimCeiling.prohibitedClaims[${index}]`));
  return structuredClone(value);
}

export function validateFixture(value) {
  exact(value, FIXTURE_KEYS, 'fixture');
  if (value.fixtureSchemaVersion !== 1) fail('unsupported-fixture-schema', 'fixtureSchemaVersion must be 1');
  if (typeof value.fixtureId !== 'string' || !/^[a-z0-9][a-z0-9-]{2,95}$/u.test(value.fixtureId)) fail('invalid-fixture-id', 'fixtureId is invalid');
  if (!SUPPORT_LEVELS.includes(value.supportLevel)) fail('invalid-support-level', 'supportLevel is invalid');
  if (!FIXTURE_EVIDENCE_CLASSES.includes(value.evidenceClass)) fail('invalid-evidence-class', 'fixtures may claim only synthetic-mechanical or static-design-only');
  const fileCount = integer(value.fileCount, 'fileCount');
  const operationCount = integer(value.operationCount, 'operationCount');
  const attentionState = exact(value.attentionState, ['kind', 'label', 'boundary', 'blocker'], 'attentionState');
  for (const key of ['kind', 'label', 'boundary']) text(attentionState[key], `attentionState.${key}`);
  if (attentionState.blocker !== null) text(attentionState.blocker, 'attentionState.blocker');
  const result = {
    fixtureSchemaVersion: 1,
    fixtureId: value.fixtureId,
    supportLevel: value.supportLevel,
    laneSupport: validateLaneSupport(value.laneSupport),
    evidenceClass: value.evidenceClass,
    fileCount,
    operationCount,
    attentionState: structuredClone(attentionState),
    expectedAuthorityEffects: validateEffects(value.expectedAuthorityEffects),
    operatingEvidence: validateOperatingEvidence(value.operatingEvidence),
    intent: validateIntent(value.intent),
    sourceFiles: validateSourceFiles(value.sourceFiles, fileCount),
    exactChange: validateExactChange(value.exactChange, operationCount),
    reviewProjection: validateReviewProjection(value.reviewProjection),
    expectedPresentation: validatePresentation(value.expectedPresentation),
    claimCeiling: validateClaimCeiling(value.claimCeiling, value.evidenceClass),
  };
  const { supportLevel, exactChange, expectedPresentation } = result;
  if (!expectedPresentation.decisionControls && /\b(?:needs your decision|owner action required)\b/iu.test(result.attentionState.label)) {
    fail('contradictory-attention', 'fixtures without decision controls cannot claim that an owner decision is required');
  }
  if (['target-v2-research', 'conceptual-later', 'authority-model-only'].includes(supportLevel)) {
    for (const [lane, entry] of Object.entries(result.laneSupport)) {
      if (entry.representable) fail('inflated-lane-representability', `${supportLevel} cannot claim representability by current ${lane} mechanics`);
    }
  }
  if (supportLevel === 'executable-v1') {
    if (!exactChange.executable || exactChange.canonicalArtifact === null || exactChange.proposalDigest === null || exactChange.executionBlockReason !== null) fail('invalid-executable-fixture', 'executable-v1 must contain canonical executable evidence');
    validateExecutableV1Consistency(result);
  } else if (exactChange.executable || exactChange.executionBlockReason === null) {
    fail('inflated-nonexecutable-fixture', 'non-v1 fixtures must be nonexecutable and state a block reason');
  }
  if (['target-v2-research', 'conceptual-later', 'authority-model-only'].includes(supportLevel) && exactChange.canonicalArtifact !== null) {
    fail('noncanonical-support-artifact', `${supportLevel} cannot carry a canonical proposal artifact`);
  }
  if (supportLevel === 'blocked-synthetic' && exactChange.canonicalArtifact !== null && exactChange.proposalDigest === null) {
    fail('blocked-artifact-digest', 'blocked historical canonical evidence requires its proposal digest');
  }
  if (supportLevel === 'conceptual-later') {
    for (const key of ['proposalDigest', 'queueId', 'reviewEvidenceDigest', 'decisionId']) if (exactChange[key] !== null) fail('conceptual-id-inflation', `conceptual fixture cannot carry ${key}`);
    if (expectedPresentation.decisionControls) fail('conceptual-controls', 'conceptual fixtures cannot show decision controls');
  }
  if (supportLevel === 'blocked-synthetic' && expectedPresentation.decisionControls) fail('blocked-controls', 'blocked fixtures cannot show decision controls');
  scanCredentialLike(result);
  return deepFreeze(result);
}

export function zeroAuthorityEffects() {
  return Object.freeze(Object.fromEntries(EFFECT_KEYS.map((key) => [key, false])));
}
export function defaultClaimCeiling(evidenceClass = 'static-design-only') {
  return {
    maxEvidenceLevel: evidenceClass,
    prohibitedClaims: ['maintainer-comprehension', 'independent-human', 'live-effect', 'offered-lane', 'public-exposure', 'oci-parity'],
  };
}
export function defaultLaneSupport({ laneA = false, laneB = false, sameHostOwnerReview = false } = {}) {
  const entry = (representable, supportedReason, unsupportedReason) => ({
    representable,
    installed: false,
    offered: false,
    publiclyExposed: false,
    deployed: false,
    reason: representable ? supportedReason : unsupportedReason,
  });
  return {
    laneA: entry(laneA, 'The current Lane A adapter can represent this canonical v1 shape, but it is not installed or offered.', 'The current Lane A adapter cannot represent this fixture boundary.'),
    laneB: entry(laneB, 'The current Lane B adapter can represent this canonical v1 shape, but it remains disabled, local-only, and unoffered.', 'The current Lane B adapter cannot represent this fixture boundary.'),
    sameHostOwnerReview: entry(sameHostOwnerReview, 'The current same-host review seam can represent this canonical v1 evidence, but the fixture itself is static research.', 'The current same-host owner-review contract cannot represent this fixture boundary.'),
  };
}
export function defaultOperatingEvidence(overrides = {}) {
  const defaults = {
    queueLifecycle: ['not-created', 'The static fixture does not create or change queue lifecycle.'],
    exactBinding: ['illustrated', 'Exact binding is represented by fixture data only.'],
    contentFidelity: ['not-evaluated', 'No production content-fidelity result is claimed.'],
    trustRoute: ['advisory', 'Trust routing is shown as owner-review context and grants no authority.'],
    reviewAttention: ['review', 'The projection explains the attention required.'],
    ownerDecision: ['not-recorded', 'Mockup controls record no owner decision.'],
    applicationAuthority: ['absent', 'No source-application authority exists in this surface.'],
    applicationResult: ['none', 'No source application is attempted.'],
    deploymentObservation: ['not-observed', 'No deployment provider is contacted.'],
    publicationWitness: ['not-observed', 'No live publication witness is contacted.'],
  };
  return Object.fromEntries(OPERATING_AXES.map((axis) => {
    const [state, explanation] = overrides[axis] ?? defaults[axis];
    return [axis, { state, explanation }];
  }));
}
export const fixtureEnums = Object.freeze({ supportLevels: SUPPORT_LEVELS, fixtureEvidenceClasses: FIXTURE_EVIDENCE_CLASSES, evidenceLevels: EVIDENCE_LEVELS, operatingAxes: OPERATING_AXES });

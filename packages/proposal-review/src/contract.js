import { createHash } from 'node:crypto';
import {
  parseProposal,
  proposalDigest,
  serializeProposal,
  validateProposal,
} from '@cyberbaser/proposal';
import {
  validateClassificationArtifact,
  validateDigest,
  validateDurableCarrier,
  validateQueueId,
  validateReceipt,
  validateStateArtifact,
} from '@cyberbaser/proposal-queue';

export const PROPOSAL_REVIEW_SCHEMA_VERSION = 1;
export const REVIEW_EVIDENCE_ARTIFACT_TYPE = 'cyberbaser-proposal-review-evidence';
export const REVIEW_SUMMARY_ARTIFACT_TYPE = 'cyberbaser-proposal-review-summary';
export const OWNER_DECISION_ARTIFACT_TYPE = 'cyberbaser-proposal-owner-decision';
export const REVIEW_EVIDENCE_MAX_BYTES = 1024 * 1024;
export const REVIEW_SUMMARY_MAX_BYTES = 32 * 1024;
export const OWNER_DECISION_MAX_BYTES = 2 * 1024 * 1024;
export const OWNER_DECISION_REASON_MAX_BYTES = 4096;
export const OWNER_IDENTITY_MAX_BYTES = 1024;

const UTC_SECOND_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u;
const CONTROL_RE = /[\x00-\x1f\x7f]/u;
const CREDENTIAL_KEY_RE = /(?:^|[-_])(?:authorization|cookie|password|passwd|secret|token|credential|api[-_]?key)(?:$|[-_])/iu;
const CREDENTIAL_VALUE_RES = Object.freeze([
  /(?:^|\s)(?:bearer|basic)\s+[A-Za-z0-9+/_.=-]+/iu,
  /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/u,
  /:\/\/[^/@\s:]+:[^/@\s]+@/u,
]);

export class ProposalReviewError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ProposalReviewError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(code, message, details = {}) {
  throw new ProposalReviewError(code, message, details);
}

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactObject(value, keys, label) {
  if (!isRecord(value)) fail('invalid-record', `${label} must be an object`);
  const actual = Object.keys(value);
  const unknown = actual.filter((key) => !keys.includes(key));
  const missing = keys.filter((key) => !Object.hasOwn(value, key));
  if (unknown.length > 0) fail('unknown-field', `${label} contains unknown field ${unknown[0]}`, { field: unknown[0] });
  if (missing.length > 0) fail('missing-field', `${label} is missing required field ${missing[0]}`, { field: missing[0] });
  return value;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

function utf8String(value, label, {
  maxBytes,
  nonEmpty = true,
  trim = false,
  controls = false,
} = {}) {
  if (typeof value !== 'string') fail('invalid-string', `${label} must be a string`);
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.toString('utf8') !== value) fail('invalid-unicode', `${label} must contain valid Unicode`);
  if (nonEmpty && bytes.length === 0) fail('empty-string', `${label} must not be empty`);
  if (maxBytes !== undefined && bytes.length > maxBytes) fail('string-too-large', `${label} exceeds ${maxBytes} UTF-8 bytes`);
  if (trim && value.trim() !== value) fail('invalid-string', `${label} must not have surrounding whitespace`);
  if (!controls && CONTROL_RE.test(value)) fail('invalid-control-character', `${label} must not contain control characters`);
  return value;
}

function utcSecond(value, label) {
  if (typeof value !== 'string' || !UTC_SECOND_RE.test(value)) fail('invalid-timestamp', `${label} must use canonical UTC second precision`);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString().replace('.000Z', 'Z') !== value) {
    fail('invalid-timestamp', `${label} must use canonical UTC second precision`);
  }
  return value;
}

function canonicalJson(value, label = 'artifact', depth = 0) {
  if (depth > 32) fail('invalid-json', `${label} exceeds the nesting limit`);
  if (Array.isArray(value)) {
    if (value.length > 1024) fail('invalid-json', `${label} exceeds the array limit`);
    return `[${value.map((item, index) => canonicalJson(item, `${label}[${index}]`, depth + 1)).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => {
      utf8String(key, `${label} key`, { maxBytes: 256, controls: false });
      return `${JSON.stringify(key)}:${canonicalJson(value[key], `${label}.${key}`, depth + 1)}`;
    }).join(',')}}`;
  }
  if (typeof value === 'string') {
    utf8String(value, label, { maxBytes: 512 * 1024, nonEmpty: false, controls: true });
    return JSON.stringify(value);
  }
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (Number.isSafeInteger(value)) return JSON.stringify(value);
  fail('invalid-json', `${label} contains a non-JSON or unsafe numeric value`);
}

function assertCredentialFree(value, label = 'artifact', depth = 0) {
  if (depth > 32) fail('credential-material', `${label} exceeds the credential scan nesting limit`);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertCredentialFree(item, `${label}[${index}]`, depth + 1));
    return;
  }
  if (isRecord(value)) {
    for (const [key, nested] of Object.entries(value)) {
      if (CREDENTIAL_KEY_RE.test(key)) fail('credential-material', `${label} contains forbidden credential field ${key}`);
      assertCredentialFree(nested, `${label}.${key}`, depth + 1);
    }
    return;
  }
  if (typeof value === 'string' && CREDENTIAL_VALUE_RES.some((expression) => expression.test(value))) {
    fail('credential-material', `${label} contains credential-like material`);
  }
}

function dependency(label, callback) {
  try {
    return callback();
  } catch (error) {
    if (error instanceof ProposalReviewError) throw error;
    fail('invalid-dependent-artifact', `${label} is invalid`, {
      label,
      causeCode: typeof error?.code === 'string' ? error.code : 'unknown',
    });
  }
}

function canonicalBytes(value, validator, label, maxBytes) {
  const normalized = validator(value);
  assertCredentialFree(normalized, label);
  const bytes = Buffer.from(`${canonicalJson(normalized, label)}\n`, 'utf8');
  if (bytes.length > maxBytes) fail('artifact-too-large', `${label} exceeds ${maxBytes} bytes`);
  return bytes;
}

function parseCanonical(input, validator, label, maxBytes) {
  const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input);
  if (bytes.length < 2 || bytes.length > maxBytes) fail('invalid-artifact-bytes', `${label} is empty or oversized`);
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) fail('invalid-artifact-bytes', `${label} must not contain a UTF-8 BOM`);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) fail('invalid-artifact-bytes', `${label} must use valid UTF-8`);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail('invalid-artifact-json', `${label} must contain strict JSON`);
  }
  const normalized = validator(parsed);
  if (!canonicalBytes(normalized, validator, label, maxBytes).equals(bytes)) {
    fail('noncanonical-artifact', `${label} must use recursively key-sorted compact JSON and one final LF`);
  }
  return normalized;
}

function sha256(bytes) {
  return `sha-256=:${createHash('sha256').update(bytes).digest('base64')}:`;
}

export function validateReviewEvidence(value) {
  exactObject(value, ['schemaVersion', 'artifactType', 'queueId', 'proposal', 'receipt', 'carrier', 'classification', 'state'], 'review evidence');
  if (value.schemaVersion !== PROPOSAL_REVIEW_SCHEMA_VERSION || value.artifactType !== REVIEW_EVIDENCE_ARTIFACT_TYPE) {
    fail('unsupported-review-evidence', 'review evidence schema or artifact type is unsupported');
  }

  const queueId = dependency('review evidence queueId', () => validateQueueId(value.queueId));
  const proposal = dependency('review evidence proposal', () => validateProposal(value.proposal));
  const receipt = dependency('review evidence receipt', () => validateReceipt(value.receipt));
  const carrier = dependency('review evidence carrier', () => validateDurableCarrier(value.carrier));
  const classification = dependency('review evidence classification', () => validateClassificationArtifact(value.classification));
  const state = dependency('review evidence state', () => validateStateArtifact(value.state));
  const normalized = {
    schemaVersion: PROPOSAL_REVIEW_SCHEMA_VERSION,
    artifactType: REVIEW_EVIDENCE_ARTIFACT_TYPE,
    queueId,
    proposal,
    receipt,
    carrier,
    classification,
    state,
  };
  assertCredentialFree(normalized, 'review evidence');

  if (receipt.queueId !== queueId || state.queueId !== queueId) fail('queue-id-mismatch', 'review evidence queue identifiers must agree');
  if (receipt.lane !== carrier.lane) fail('lane-mismatch', 'review evidence receipt and carrier lanes must agree');
  if (carrier.lane === 'lane-b' && classification.verifiedSubject !== null) fail('lane-b-subject-mismatch', 'Lane B review evidence must remain anonymous');
  if (state.createdAt !== receipt.receivedAt) fail('receipt-state-mismatch', 'review evidence receipt and state creation times must agree');
  if (Date.parse(proposal.submission.submittedAt) > Date.parse(receipt.receivedAt)) fail('submission-time-mismatch', 'proposal submission must not follow queue receipt');

  const proposalText = serializeProposal(proposal);
  if (Buffer.byteLength(proposalText, 'utf8') !== receipt.proposalByteLength) fail('proposal-length-mismatch', 'review evidence proposal byte length does not match its receipt');
  if (proposalDigest(proposal) !== receipt.proposalDigest) fail('proposal-digest-mismatch', 'review evidence proposal digest does not match its receipt');

  return deepFreeze(normalized);
}

export function createReviewEvidence(entry) {
  exactObject(entry, ['queueId', 'proposalText', 'receipt', 'carrier', 'classification', 'state'], 'queue review entry');
  const proposal = dependency('queue proposalText', () => parseProposal(entry.proposalText));
  return validateReviewEvidence({
    schemaVersion: PROPOSAL_REVIEW_SCHEMA_VERSION,
    artifactType: REVIEW_EVIDENCE_ARTIFACT_TYPE,
    queueId: entry.queueId,
    proposal,
    receipt: entry.receipt,
    carrier: entry.carrier,
    classification: entry.classification,
    state: entry.state,
  });
}

export function serializeReviewEvidence(value) {
  return canonicalBytes(value, validateReviewEvidence, 'review evidence', REVIEW_EVIDENCE_MAX_BYTES).toString('utf8');
}

export function parseReviewEvidence(input) {
  return parseCanonical(input, validateReviewEvidence, 'review evidence', REVIEW_EVIDENCE_MAX_BYTES);
}

export function reviewEvidenceDigest(value) {
  return sha256(canonicalBytes(value, validateReviewEvidence, 'review evidence', REVIEW_EVIDENCE_MAX_BYTES));
}

function normalizeReviewSummary(value) {
  exactObject(value, ['schemaVersion', 'artifactType', 'queueId', 'proposalId', 'proposalDigest', 'candidateDigest', 'reviewEvidenceDigest', 'source', 'receivedAt', 'expiresAt', 'state', 'lane', 'tier', 'route'], 'review summary');
  if (value.schemaVersion !== PROPOSAL_REVIEW_SCHEMA_VERSION || value.artifactType !== REVIEW_SUMMARY_ARTIFACT_TYPE) {
    fail('unsupported-review-summary', 'review summary schema or artifact type is unsupported');
  }
  exactObject(value.source, ['repository', 'revision', 'path'], 'review summary source');
  const source = {
    repository: utf8String(value.source.repository, 'review summary source.repository', { maxBytes: 4096, trim: true }),
    revision: utf8String(value.source.revision, 'review summary source.revision', { maxBytes: 1024, trim: true }),
    path: utf8String(value.source.path, 'review summary source.path', { maxBytes: 4096, trim: true }),
  };
  if (!['pending-review', 'expired'].includes(value.state)) fail('invalid-review-state', 'review summary state is unsupported');
  if (!['lane-a', 'lane-b'].includes(value.lane)) fail('invalid-review-lane', 'review summary lane is unsupported');
  if (!['auto-merge', 'quick-review', 'full-review', 'reject'].includes(value.route)) fail('invalid-review-route', 'review summary route is unsupported');
  const normalized = {
    schemaVersion: PROPOSAL_REVIEW_SCHEMA_VERSION,
    artifactType: REVIEW_SUMMARY_ARTIFACT_TYPE,
    queueId: dependency('review summary queueId', () => validateQueueId(value.queueId)),
    proposalId: utf8String(value.proposalId, 'review summary proposalId', { maxBytes: 1024, trim: true }),
    proposalDigest: dependency('review summary proposalDigest', () => validateDigest(value.proposalDigest, 'proposalDigest')),
    candidateDigest: dependency('review summary candidateDigest', () => validateDigest(value.candidateDigest, 'candidateDigest')),
    reviewEvidenceDigest: dependency('review summary reviewEvidenceDigest', () => validateDigest(value.reviewEvidenceDigest, 'reviewEvidenceDigest')),
    source,
    receivedAt: utcSecond(value.receivedAt, 'review summary receivedAt'),
    expiresAt: utcSecond(value.expiresAt, 'review summary expiresAt'),
    state: value.state,
    lane: value.lane,
    tier: utf8String(value.tier, 'review summary tier', { maxBytes: 256, trim: true }),
    route: value.route,
  };
  if (Date.parse(normalized.expiresAt) <= Date.parse(normalized.receivedAt)) fail('invalid-review-window', 'review summary expiry must follow receipt');
  assertCredentialFree(normalized, 'review summary');
  return normalized;
}

function summaryFromEvidence(evidence) {
  return {
    schemaVersion: PROPOSAL_REVIEW_SCHEMA_VERSION,
    artifactType: REVIEW_SUMMARY_ARTIFACT_TYPE,
    queueId: evidence.queueId,
    proposalId: evidence.proposal.proposalId,
    proposalDigest: evidence.receipt.proposalDigest,
    candidateDigest: evidence.proposal.operation.candidateDigest,
    reviewEvidenceDigest: reviewEvidenceDigest(evidence),
    source: evidence.proposal.source,
    receivedAt: evidence.receipt.receivedAt,
    expiresAt: evidence.receipt.expiresAt,
    state: evidence.state.state,
    lane: evidence.receipt.lane,
    tier: evidence.classification.classification.tier,
    route: evidence.classification.classification.route,
  };
}

export function validateReviewSummary(value, evidenceInput) {
  if (evidenceInput === undefined) fail('review-evidence-required', 'review summary validation requires its exact review evidence');
  const evidence = validateReviewEvidence(evidenceInput);
  const normalized = normalizeReviewSummary(value);
  const expected = normalizeReviewSummary(summaryFromEvidence(evidence));
  if (canonicalJson(normalized, 'review summary') !== canonicalJson(expected, 'review summary')) {
    fail('summary-evidence-mismatch', 'review summary does not match its exact review evidence');
  }
  return deepFreeze(normalized);
}

export function createReviewSummary(evidenceInput) {
  const evidence = validateReviewEvidence(evidenceInput);
  return validateReviewSummary(summaryFromEvidence(evidence), evidence);
}

export function serializeReviewSummary(value, evidenceInput) {
  return canonicalBytes(value, (input) => validateReviewSummary(input, evidenceInput), 'review summary', REVIEW_SUMMARY_MAX_BYTES).toString('utf8');
}

export function parseReviewSummary(input, evidenceInput) {
  return parseCanonical(input, (value) => validateReviewSummary(value, evidenceInput), 'review summary', REVIEW_SUMMARY_MAX_BYTES);
}

function validateDecisionAuthority(value) {
  exactObject(value, ['type', 'identity'], 'decisionAuthority');
  if (value.type !== 'owner-alpha-local') fail('invalid-decision-authority', 'decisionAuthority.type must be owner-alpha-local');
  return deepFreeze({
    type: 'owner-alpha-local',
    identity: utf8String(value.identity, 'decisionAuthority.identity', { maxBytes: OWNER_IDENTITY_MAX_BYTES, trim: true }),
  });
}

function validateEffectBoundary(value) {
  const keys = ['appliesSource', 'writesSource', 'commits', 'pushes', 'deploys', 'publishes', 'rebuilds'];
  exactObject(value, keys, 'effectBoundary');
  for (const key of keys) {
    if (value[key] !== false) fail('invalid-effect-boundary', `effectBoundary.${key} must be false`);
  }
  return deepFreeze(Object.fromEntries(keys.map((key) => [key, false])));
}

export function validateOwnerDecision(value) {
  exactObject(value, ['schemaVersion', 'artifactType', 'queueId', 'action', 'reason', 'decidedAt', 'decisionAuthority', 'authorityScope', 'reviewEvidenceDigest', 'reviewEvidence', 'effectBoundary'], 'owner decision');
  if (value.schemaVersion !== PROPOSAL_REVIEW_SCHEMA_VERSION || value.artifactType !== OWNER_DECISION_ARTIFACT_TYPE) {
    fail('unsupported-owner-decision', 'owner decision schema or artifact type is unsupported');
  }
  if (!['approve', 'reject'].includes(value.action)) fail('invalid-owner-action', 'owner decision action must be approve or reject');
  if (value.authorityScope !== 'decision-only') fail('invalid-authority-scope', 'owner decision authorityScope must be decision-only');

  const queueId = dependency('owner decision queueId', () => validateQueueId(value.queueId));
  const reviewEvidence = validateReviewEvidence(value.reviewEvidence);
  const digest = dependency('owner decision reviewEvidenceDigest', () => validateDigest(value.reviewEvidenceDigest, 'reviewEvidenceDigest'));
  const decidedAt = utcSecond(value.decidedAt, 'owner decision decidedAt');
  const reason = utf8String(value.reason, 'owner decision reason', { maxBytes: OWNER_DECISION_REASON_MAX_BYTES, trim: true });

  if (reviewEvidence.queueId !== queueId) fail('decision-queue-mismatch', 'owner decision queueId must match embedded review evidence');
  if (reviewEvidenceDigest(reviewEvidence) !== digest) fail('decision-evidence-digest-mismatch', 'owner decision review evidence digest is invalid');
  if (reviewEvidence.state.state !== 'pending-review') fail('decision-ineligible-state', 'owner decisions require pending-review evidence');
  if (Date.parse(decidedAt) < Date.parse(reviewEvidence.receipt.receivedAt)) fail('decision-before-receipt', 'owner decision cannot precede receipt');
  if (Date.parse(decidedAt) >= Date.parse(reviewEvidence.receipt.expiresAt)) fail('decision-expired', 'owner decision must precede proposal expiry');

  const normalized = {
    schemaVersion: PROPOSAL_REVIEW_SCHEMA_VERSION,
    artifactType: OWNER_DECISION_ARTIFACT_TYPE,
    queueId,
    action: value.action,
    reason,
    decidedAt,
    decisionAuthority: validateDecisionAuthority(value.decisionAuthority),
    authorityScope: 'decision-only',
    reviewEvidenceDigest: digest,
    reviewEvidence,
    effectBoundary: validateEffectBoundary(value.effectBoundary),
  };
  assertCredentialFree(normalized, 'owner decision');
  return deepFreeze(normalized);
}

export function createOwnerDecision({ action, reason, decidedAt, decisionAuthority, reviewEvidence }) {
  const evidence = validateReviewEvidence(reviewEvidence);
  return validateOwnerDecision({
    schemaVersion: PROPOSAL_REVIEW_SCHEMA_VERSION,
    artifactType: OWNER_DECISION_ARTIFACT_TYPE,
    queueId: evidence.queueId,
    action,
    reason,
    decidedAt,
    decisionAuthority,
    authorityScope: 'decision-only',
    reviewEvidenceDigest: reviewEvidenceDigest(evidence),
    reviewEvidence: evidence,
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
}

export function serializeOwnerDecision(value) {
  return canonicalBytes(value, validateOwnerDecision, 'owner decision', OWNER_DECISION_MAX_BYTES).toString('utf8');
}

export function parseOwnerDecision(input) {
  return parseCanonical(input, validateOwnerDecision, 'owner decision', OWNER_DECISION_MAX_BYTES);
}

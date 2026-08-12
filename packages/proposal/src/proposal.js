import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import {
  applyCorrection,
  CorrectionError,
  prepareCorrection,
  prepareOffsetCorrection,
  resolveQuoteAnchor,
} from '@cyberbaser/correction';

const TOP_LEVEL_KEYS = [
  'schemaVersion',
  'artifactType',
  'proposalId',
  'source',
  'operation',
  'submission',
];
const SOURCE_KEYS = ['repository', 'revision', 'path'];
const OPERATION_KEYS = [
  'type',
  'selector',
  'baseByteLength',
  'baseDigest',
  'start',
  'end',
  'expectedOldBytesBase64',
  'replacementBytesBase64',
  'candidateByteLength',
  'candidateDigest',
];
const SELECTOR_KEYS = ['quote', 'prefix', 'suffix'];
const SUBMISSION_KEYS = [
  'submittedAt',
  'rationale',
  'evidence',
  'identityClaim',
];
const IDENTITY_CLAIM_KEYS = ['type', 'issuer', 'subject'];
const PREPARE_KEYS = ['proposalId', 'source', 'operation', 'submission'];
const PREPARE_QUOTE_KEYS = ['type', 'selector', 'replacement'];
const PREPARE_OFFSET_KEYS = ['type', 'start', 'end', 'replacement'];
const UTC_SECOND_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const PROPOSAL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_DIGEST_RE = /^sha-256=:[A-Za-z0-9+/]{43}=:$/;
const CONTROL_RE = /[\x00-\x1f\x7f]/u;
const UTF8_DECODER = new TextDecoder('utf-8', {
  fatal: true,
  ignoreBOM: true,
});

export const PROPOSAL_SCHEMA_VERSION = 1;
export const PROPOSAL_ARTIFACT_TYPE = 'cyberbaser-proposal';
export const PROPOSAL_MAX_BYTES = 256 * 1024;
export const PROPOSAL_MAX_SPAN_BYTES = 64 * 1024;
const MAX_RATIONALE_BYTES = 16 * 1024;
const MAX_EVIDENCE_COUNT = 8;
const MAX_URL_BYTES = 2048;
const MAX_REVISION_BYTES = 1024;
const MAX_PATH_BYTES = 4096;
const MAX_SUBJECT_BYTES = 1024;

export class ProposalError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ProposalError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new ProposalError(code, message, details);
}

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireRecord(value, label) {
  if (!isRecord(value)) fail('invalid-record', `${label} must be an object`);
  return value;
}

function requireExactKeys(value, keys, label) {
  requireRecord(value, label);
  const actual = Object.keys(value);
  const unknown = actual.filter((key) => !keys.includes(key));
  const missing = keys.filter((key) => !Object.hasOwn(value, key));
  if (unknown.length > 0) {
    fail('unknown-field', `${label} contains unknown field ${unknown[0]}`, {
      field: unknown[0],
    });
  }
  if (missing.length > 0) {
    fail('missing-field', `${label} is missing required field ${missing[0]}`, {
      field: missing[0],
    });
  }
}

function decodeUtf8(bytes, label) {
  try {
    return UTF8_DECODER.decode(bytes);
  } catch {
    fail('invalid-utf8', `${label} must be valid UTF-8`);
  }
}

function utf8Bytes(value, label, {
  nonEmpty = false,
  maxBytes,
  rejectControls = false,
  rejectCarriageReturn = false,
} = {}) {
  if (typeof value !== 'string') fail('invalid-string', `${label} must be a string`);
  const bytes = Buffer.from(value, 'utf8');
  if (decodeUtf8(bytes, label) !== value) {
    fail('invalid-unicode', `${label} must not contain unpaired Unicode surrogates`);
  }
  if (nonEmpty && bytes.length === 0) fail('empty-string', `${label} must not be empty`);
  if (maxBytes !== undefined && bytes.length > maxBytes) {
    fail('string-too-large', `${label} exceeds ${maxBytes} UTF-8 bytes`, {
      maximum: maxBytes,
      actual: bytes.length,
    });
  }
  if (rejectControls && CONTROL_RE.test(value)) {
    fail('invalid-control-character', `${label} must not contain control characters`);
  }
  if (rejectCarriageReturn && value.includes('\r')) {
    fail('invalid-line-ending', `${label} must use LF rather than CR or CRLF`);
  }
  return bytes;
}

function requireSafeInteger(value, label, { positive = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) {
    fail(
      'invalid-integer',
      `${label} must be a ${positive ? 'positive' : 'non-negative'} safe integer`,
    );
  }
  return value;
}

function requireProposalId(value) {
  if (typeof value !== 'string' || !PROPOSAL_ID_RE.test(value)) {
    fail(
      'invalid-proposal-id',
      'proposalId must be 1-128 printable ASCII identifier characters',
    );
  }
  return value;
}

function rejectNoncanonicalUrlAliases(value, parsed, label) {
  if (parsed.hostname.endsWith('.')) {
    fail('noncanonical-url', `${label} must not use a trailing-dot hostname alias`);
  }
  if (/%(?![0-9A-Fa-f]{2})/u.test(value)) {
    fail('noncanonical-url', `${label} contains an invalid percent escape`);
  }
  for (const match of value.matchAll(/%([0-9A-Fa-f]{2})/gu)) {
    const hex = match[1];
    const character = String.fromCharCode(Number.parseInt(hex, 16));
    if (hex !== hex.toUpperCase() || /[A-Za-z0-9._~-]/u.test(character)) {
      fail('noncanonical-url', `${label} must use one canonical percent-encoding spelling`);
    }
  }
}

function canonicalUrl(value, label, {
  httpsOnly = false,
  repository = false,
  forbidQueryAndFragment = false,
} = {}) {
  utf8Bytes(value, label, { nonEmpty: true, maxBytes: MAX_URL_BYTES });
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail('invalid-url', `${label} must be an absolute canonical URL`);
  }
  if (httpsOnly && parsed.protocol !== 'https:') {
    fail('invalid-url-scheme', `${label} must use https`);
  }
  if (['file:', 'data:', 'javascript:'].includes(parsed.protocol)) {
    fail('invalid-url-scheme', `${label} uses a forbidden URL scheme`);
  }
  if (parsed.username !== '' || parsed.password !== '') {
    fail('credentialed-url', `${label} must not contain credentials`);
  }
  if (forbidQueryAndFragment && (value.includes('?') || value.includes('#'))) {
    fail('invalid-url-components', `${label} must not contain a query or fragment`);
  }
  if (repository) {
    if (
      parsed.pathname === '/'
      || parsed.pathname.endsWith('/')
      || parsed.pathname.includes('//')
    ) {
      fail('invalid-source-repository', `${label} must name one unambiguous repository path`);
    }
  }
  rejectNoncanonicalUrlAliases(value, parsed, label);
  if (parsed.toString() !== value) {
    fail('noncanonical-url', `${label} must use its canonical URL spelling`);
  }
  return value;
}

function normalizeSource(value) {
  requireExactKeys(value, SOURCE_KEYS, 'source');
  const revisionBytes = utf8Bytes(value.revision, 'source.revision', {
    nonEmpty: true,
    maxBytes: MAX_REVISION_BYTES,
    rejectControls: true,
  });
  if (revisionBytes.length === 0) {
    fail('invalid-source-revision', 'source.revision must not be empty');
  }
  utf8Bytes(value.path, 'source.path', {
    nonEmpty: true,
    maxBytes: MAX_PATH_BYTES,
    rejectControls: true,
  });
  if (
    value.path.startsWith('/')
    || value.path.includes('\\')
    || !value.path.endsWith('.md')
  ) {
    fail(
      'invalid-source-path',
      'source.path must be a repository-relative POSIX Markdown path',
    );
  }
  const segments = value.path.split('/');
  if (
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
    || segments.includes('.git')
  ) {
    fail('invalid-source-path', 'source.path contains a forbidden path segment');
  }
  return {
    repository: canonicalUrl(value.repository, 'source.repository', {
      httpsOnly: true,
      repository: true,
      forbidQueryAndFragment: true,
    }),
    revision: value.revision,
    path: value.path,
  };
}

function canonicalBase64(value, label) {
  if (typeof value !== 'string') fail('invalid-base64', `${label} must be a base64 string`);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    fail('invalid-base64', `${label} must use canonical padded base64`);
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) {
    fail('invalid-base64', `${label} must use canonical padded base64`);
  }
  decodeUtf8(bytes, label);
  return bytes;
}

function requireDigest(value, label) {
  if (typeof value !== 'string' || !SHA256_DIGEST_RE.test(value)) {
    fail('invalid-digest', `${label} must be an RFC-9530-style SHA-256 digest`);
  }
  const base64 = value.slice('sha-256=:'.length, -1);
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length !== 32 || bytes.toString('base64') !== base64) {
    fail('invalid-digest', `${label} must be an RFC-9530-style SHA-256 digest`);
  }
  return value;
}

function normalizeSelector(value, oldBytes) {
  requireExactKeys(value, SELECTOR_KEYS, 'operation.selector');
  const quoteBytes = utf8Bytes(value.quote, 'operation.selector.quote', {
    nonEmpty: true,
    maxBytes: PROPOSAL_MAX_SPAN_BYTES,
  });
  if (!quoteBytes.equals(oldBytes)) {
    fail(
      'selector-old-bytes-mismatch',
      'operation.selector.quote must equal expectedOldBytesBase64',
    );
  }
  for (const name of ['prefix', 'suffix']) {
    if (value[name] !== null) {
      utf8Bytes(value[name], `operation.selector.${name}`, {
        maxBytes: PROPOSAL_MAX_SPAN_BYTES,
      });
    }
  }
  return {
    quote: value.quote,
    prefix: value.prefix,
    suffix: value.suffix,
  };
}

function normalizeOperation(value) {
  requireExactKeys(value, OPERATION_KEYS, 'operation');
  if (!['quote', 'offset'].includes(value.type)) {
    fail('invalid-operation-type', 'operation.type must be quote or offset');
  }
  const baseByteLength = requireSafeInteger(
    value.baseByteLength,
    'operation.baseByteLength',
  );
  const start = requireSafeInteger(value.start, 'operation.start');
  const end = requireSafeInteger(value.end, 'operation.end');
  if (start > end || end > baseByteLength) {
    fail('invalid-operation-range', 'operation offsets are outside the base byte range');
  }
  const oldBytes = canonicalBase64(
    value.expectedOldBytesBase64,
    'operation.expectedOldBytesBase64',
  );
  const replacementBytes = canonicalBase64(
    value.replacementBytesBase64,
    'operation.replacementBytesBase64',
  );
  if (oldBytes.length > PROPOSAL_MAX_SPAN_BYTES) {
    fail('operation-span-too-large', 'operation old span exceeds 64 KiB');
  }
  if (replacementBytes.length > PROPOSAL_MAX_SPAN_BYTES) {
    fail('operation-span-too-large', 'operation replacement span exceeds 64 KiB');
  }
  if (end - start !== oldBytes.length) {
    fail('old-bytes-length-mismatch', 'operation offsets do not span the exact old bytes');
  }
  const candidateByteLength = requireSafeInteger(
    value.candidateByteLength,
    'operation.candidateByteLength',
  );
  const expectedCandidateLength = baseByteLength - oldBytes.length + replacementBytes.length;
  if (candidateByteLength !== expectedCandidateLength) {
    fail(
      'candidate-length-mismatch',
      'operation.candidateByteLength does not match the declared splice',
    );
  }
  const baseDigest = requireDigest(value.baseDigest, 'operation.baseDigest');
  const candidateDigest = requireDigest(value.candidateDigest, 'operation.candidateDigest');
  if (oldBytes.equals(replacementBytes) || baseDigest === candidateDigest) {
    fail('no-op-proposal', 'proposal operation must change the source bytes');
  }
  if (baseByteLength > 0 && start === 0 && end === baseByteLength) {
    fail(
      'whole-file-operation',
      'proposal operation must not replace or delete the complete source file',
    );
  }
  let selector;
  if (value.type === 'quote') {
    if (value.selector === null) {
      fail('missing-selector', 'quote operations require operation.selector');
    }
    selector = normalizeSelector(value.selector, oldBytes);
  } else {
    if (value.selector !== null) {
      fail('unexpected-selector', 'offset operations require operation.selector to be null');
    }
    selector = null;
  }
  return {
    type: value.type,
    selector,
    baseByteLength,
    baseDigest,
    start,
    end,
    expectedOldBytesBase64: value.expectedOldBytesBase64,
    replacementBytesBase64: value.replacementBytesBase64,
    candidateByteLength,
    candidateDigest,
  };
}

function normalizeTimestamp(value) {
  if (typeof value !== 'string' || !UTC_SECOND_RE.test(value)) {
    fail('invalid-timestamp', 'submission.submittedAt must use UTC second precision');
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    fail('invalid-timestamp', 'submission.submittedAt must be a real UTC timestamp');
  }
  const canonical = new Date(milliseconds).toISOString().replace('.000Z', 'Z');
  if (canonical !== value) {
    fail('invalid-timestamp', 'submission.submittedAt must use canonical UTC second precision');
  }
  return value;
}

function normalizeIdentityClaim(value) {
  if (value === null) return null;
  requireExactKeys(value, IDENTITY_CLAIM_KEYS, 'submission.identityClaim');
  if (!['human', 'agent'].includes(value.type)) {
    fail('invalid-identity-claim', 'identity claim type must be human or agent');
  }
  utf8Bytes(value.subject, 'submission.identityClaim.subject', {
    nonEmpty: true,
    maxBytes: MAX_SUBJECT_BYTES,
    rejectControls: true,
  });
  return {
    type: value.type,
    issuer: canonicalUrl(value.issuer, 'submission.identityClaim.issuer', {
      forbidQueryAndFragment: true,
    }),
    subject: value.subject,
  };
}

function normalizeSubmission(value) {
  requireExactKeys(value, SUBMISSION_KEYS, 'submission');
  utf8Bytes(value.rationale, 'submission.rationale', {
    nonEmpty: true,
    maxBytes: MAX_RATIONALE_BYTES,
    rejectCarriageReturn: true,
  });
  if (value.rationale.trim().length === 0) {
    fail('invalid-rationale', 'submission.rationale must contain non-whitespace text');
  }
  if (!Array.isArray(value.evidence) || value.evidence.length > MAX_EVIDENCE_COUNT) {
    fail('invalid-evidence', `submission.evidence must contain at most ${MAX_EVIDENCE_COUNT} URLs`);
  }
  const evidence = value.evidence.map((url, index) => canonicalUrl(
    url,
    `submission.evidence[${index}]`,
    { httpsOnly: true },
  ));
  if (new Set(evidence).size !== evidence.length) {
    fail('duplicate-evidence', 'submission.evidence must not contain duplicate URLs');
  }
  return {
    submittedAt: normalizeTimestamp(value.submittedAt),
    rationale: value.rationale,
    evidence,
    identityClaim: normalizeIdentityClaim(value.identityClaim),
  };
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

function translateCorrection(error) {
  if (!(error instanceof CorrectionError)) throw error;
  fail(`correction-${error.code}`, error.message, {
    correctionPhase: error.phase,
    ...error.details,
  });
}

function encodePreparedOperation(type, prepared) {
  const selector = type === 'quote'
    ? {
        quote: prepared.selector.quote,
        prefix: prepared.selector.prefix ?? null,
        suffix: prepared.selector.suffix ?? null,
      }
    : null;
  return {
    type,
    selector,
    baseByteLength: prepared.baseByteLength,
    baseDigest: prepared.baseDigest,
    start: prepared.start,
    end: prepared.end,
    expectedOldBytesBase64: prepared.expectedOldBytes.toString('base64'),
    replacementBytesBase64: prepared.replacementBytes.toString('base64'),
    candidateByteLength: prepared.candidateByteLength,
    candidateDigest: prepared.candidateDigest,
  };
}

function correctionFromOperation(operation) {
  const correction = {
    baseByteLength: operation.baseByteLength,
    baseDigest: operation.baseDigest,
    start: operation.start,
    end: operation.end,
    expectedOldBytes: Buffer.from(operation.expectedOldBytesBase64, 'base64'),
    replacementBytes: Buffer.from(operation.replacementBytesBase64, 'base64'),
    candidateByteLength: operation.candidateByteLength,
    candidateDigest: operation.candidateDigest,
  };
  if (operation.type === 'quote') {
    correction.selector = {
      quote: operation.selector.quote,
      ...(operation.selector.prefix === null ? {} : { prefix: operation.selector.prefix }),
      ...(operation.selector.suffix === null ? {} : { suffix: operation.selector.suffix }),
    };
  } else {
    correction.operationType = 'offset';
  }
  return correction;
}

function canonicalProposalText(value) {
  return `${JSON.stringify(value)}\n`;
}

function enforceProposalSize(value) {
  const bytes = Buffer.byteLength(canonicalProposalText(value), 'utf8');
  if (bytes > PROPOSAL_MAX_BYTES) {
    fail('proposal-too-large', `proposal exceeds ${PROPOSAL_MAX_BYTES} UTF-8 bytes`, {
      maximum: PROPOSAL_MAX_BYTES,
      actual: bytes,
    });
  }
}

export function validateProposal(value) {
  requireExactKeys(value, TOP_LEVEL_KEYS, 'proposal');
  if (value.schemaVersion !== PROPOSAL_SCHEMA_VERSION) {
    fail(
      'unsupported-schema',
      `unsupported proposal schemaVersion ${JSON.stringify(value.schemaVersion)}`,
    );
  }
  if (value.artifactType !== PROPOSAL_ARTIFACT_TYPE) {
    fail('invalid-artifact-type', `artifactType must be ${PROPOSAL_ARTIFACT_TYPE}`);
  }
  const normalized = {
    schemaVersion: PROPOSAL_SCHEMA_VERSION,
    artifactType: PROPOSAL_ARTIFACT_TYPE,
    proposalId: requireProposalId(value.proposalId),
    source: normalizeSource(value.source),
    operation: normalizeOperation(value.operation),
    submission: normalizeSubmission(value.submission),
  };
  enforceProposalSize(normalized);
  return deepFreeze(normalized);
}

export function serializeProposal(value) {
  return canonicalProposalText(validateProposal(value));
}

function bytesFrom(value) {
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (value instanceof Uint8Array) return Buffer.from(value);
  fail('invalid-bytes', 'proposal must be UTF-8 text or bytes');
}

export function parseProposal(value) {
  const bytes = bytesFrom(value);
  if (bytes.length === 0) fail('empty-proposal', 'proposal must not be empty');
  if (bytes.length > PROPOSAL_MAX_BYTES) {
    fail('proposal-too-large', `proposal exceeds ${PROPOSAL_MAX_BYTES} UTF-8 bytes`);
  }
  const text = decodeUtf8(bytes, 'proposal');
  if (text.startsWith('﻿')) fail('utf8-bom', 'proposal must not begin with a UTF-8 BOM');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    fail('malformed-json', `proposal is not valid JSON: ${error.message}`);
  }
  const normalized = validateProposal(parsed);
  if (text !== serializeProposal(normalized)) {
    fail(
      'noncanonical-proposal',
      'proposal must use canonical compact JSON with fixed key order and one final LF',
    );
  }
  return normalized;
}

export function proposalDigest(value) {
  const bytes = Buffer.from(serializeProposal(value), 'utf8');
  return `sha-256=:${createHash('sha256').update(bytes).digest('base64')}:`;
}

export function prepareProposal(baseBytes, input) {
  requireExactKeys(input, PREPARE_KEYS, 'proposal input');
  requireRecord(input.operation, 'proposal input operation');
  let prepared;
  try {
    if (input.operation.type === 'quote') {
      requireExactKeys(input.operation, PREPARE_QUOTE_KEYS, 'proposal input operation');
      prepared = prepareCorrection(baseBytes, {
        selector: input.operation.selector,
        replacement: input.operation.replacement,
      });
    } else if (input.operation.type === 'offset') {
      requireExactKeys(input.operation, PREPARE_OFFSET_KEYS, 'proposal input operation');
      prepared = prepareOffsetCorrection(baseBytes, {
        start: input.operation.start,
        end: input.operation.end,
        replacement: input.operation.replacement,
      });
    } else {
      fail('invalid-operation-type', 'proposal input operation type must be quote or offset');
    }
  } catch (error) {
    translateCorrection(error);
  }
  return validateProposal({
    schemaVersion: PROPOSAL_SCHEMA_VERSION,
    artifactType: PROPOSAL_ARTIFACT_TYPE,
    proposalId: input.proposalId,
    source: input.source,
    operation: encodePreparedOperation(input.operation.type, prepared),
    submission: input.submission,
  });
}

export function applyProposal(baseBytes, value) {
  const proposal = validateProposal(value);
  const correction = correctionFromOperation(proposal.operation);
  try {
    const candidate = applyCorrection(baseBytes, correction);
    if (proposal.operation.type === 'quote') {
      const resolved = resolveQuoteAnchor(baseBytes, correction.selector);
      if (
        resolved.start !== proposal.operation.start
        || resolved.end !== proposal.operation.end
      ) {
        fail(
          'quote-offset-mismatch',
          'quote selector does not resolve to the prepared operation offsets',
        );
      }
    }
    return candidate;
  } catch (error) {
    translateCorrection(error);
  }
}

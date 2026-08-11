import {
  ACCOUNT_FREE_CONTEXT_MAX_BYTES,
  ACCOUNT_FREE_INTENT_ARTIFACT_TYPE,
  ACCOUNT_FREE_INTENT_MAX_BYTES,
  ACCOUNT_FREE_INTENT_SCHEMA_VERSION,
  ACCOUNT_FREE_MAX_EVIDENCE,
  ACCOUNT_FREE_QUOTE_MAX_BYTES,
  ACCOUNT_FREE_RATIONALE_MAX_BYTES,
  ACCOUNT_FREE_REPLACEMENT_MAX_BYTES,
  asBuffer,
  canonicalHttpsUrl,
  canonicalText,
  decodeUtf8,
  deepFreeze,
  fail,
  PAGE_ID_RE,
  requireDigest,
  requireExactKeys,
  requireString,
  sha256Digest,
} from './contract.js';

const TOP_LEVEL_KEYS = [
  'schemaVersion',
  'artifactType',
  'bindingDigest',
  'pageId',
  'selection',
  'replacement',
  'rationale',
  'evidence',
  'idempotencyKey',
];
const SELECTION_KEYS = ['quote', 'prefix', 'suffix'];
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{32,128}$/u;

function normalizeContext(value, label) {
  if (value === null) return null;
  return requireString(value, label, {
    nonEmpty: false,
    maxBytes: ACCOUNT_FREE_CONTEXT_MAX_BYTES,
  });
}

function normalizeSelection(value) {
  requireExactKeys(value, SELECTION_KEYS, 'selection');
  return {
    quote: requireString(value.quote, 'selection.quote', {
      maxBytes: ACCOUNT_FREE_QUOTE_MAX_BYTES,
    }),
    prefix: normalizeContext(value.prefix, 'selection.prefix'),
    suffix: normalizeContext(value.suffix, 'selection.suffix'),
  };
}

function normalizeIdempotencyKey(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY_RE.test(value)) {
    fail(
      'invalid-idempotency-key',
      'idempotencyKey must be null or 32-128 base64url characters',
    );
  }
  return value;
}

function normalizeEvidence(value) {
  if (!Array.isArray(value) || value.length > ACCOUNT_FREE_MAX_EVIDENCE) {
    fail('invalid-evidence', `evidence must contain at most ${ACCOUNT_FREE_MAX_EVIDENCE} URLs`);
  }
  const evidence = value.map((url, index) => canonicalHttpsUrl(
    url,
    `evidence[${index}]`,
  ));
  if (new Set(evidence).size !== evidence.length) {
    fail('duplicate-evidence', 'evidence must not contain duplicate URLs');
  }
  return evidence;
}

export function validateCorrectionIntent(value) {
  requireExactKeys(value, TOP_LEVEL_KEYS, 'correction intent');
  if (value.schemaVersion !== ACCOUNT_FREE_INTENT_SCHEMA_VERSION) {
    fail('unsupported-schema', `unsupported correction intent schemaVersion ${JSON.stringify(value.schemaVersion)}`);
  }
  if (value.artifactType !== ACCOUNT_FREE_INTENT_ARTIFACT_TYPE) {
    fail('invalid-artifact-type', `artifactType must be ${ACCOUNT_FREE_INTENT_ARTIFACT_TYPE}`);
  }
  if (typeof value.pageId !== 'string' || !PAGE_ID_RE.test(value.pageId)) {
    fail('invalid-page-id', 'pageId must be a canonical page-v1 identifier');
  }
  const rationale = requireString(value.rationale, 'rationale', {
    maxBytes: ACCOUNT_FREE_RATIONALE_MAX_BYTES,
    rejectCarriageReturn: true,
  });
  if (rationale.trim().length === 0) fail('invalid-rationale', 'rationale must contain non-whitespace text');
  const normalized = {
    schemaVersion: ACCOUNT_FREE_INTENT_SCHEMA_VERSION,
    artifactType: ACCOUNT_FREE_INTENT_ARTIFACT_TYPE,
    bindingDigest: requireDigest(value.bindingDigest, 'bindingDigest'),
    pageId: value.pageId,
    selection: normalizeSelection(value.selection),
    replacement: requireString(value.replacement, 'replacement', {
      nonEmpty: false,
      maxBytes: ACCOUNT_FREE_REPLACEMENT_MAX_BYTES,
    }),
    rationale,
    evidence: normalizeEvidence(value.evidence),
    idempotencyKey: normalizeIdempotencyKey(value.idempotencyKey),
  };
  const size = Buffer.byteLength(canonicalText(normalized), 'utf8');
  if (size > ACCOUNT_FREE_INTENT_MAX_BYTES) {
    fail('correction-intent-too-large', `correction intent exceeds ${ACCOUNT_FREE_INTENT_MAX_BYTES} bytes`, {
      maximum: ACCOUNT_FREE_INTENT_MAX_BYTES,
      actual: size,
    });
  }
  return deepFreeze(normalized);
}

export function serializeCorrectionIntent(value) {
  return canonicalText(validateCorrectionIntent(value));
}

export function parseCorrectionIntent(value) {
  const bytes = asBuffer(value, 'correction intent');
  if (bytes.length === 0) fail('empty-correction-intent', 'correction intent must not be empty');
  if (bytes.length > ACCOUNT_FREE_INTENT_MAX_BYTES) {
    fail('correction-intent-too-large', `correction intent exceeds ${ACCOUNT_FREE_INTENT_MAX_BYTES} bytes`, {
      maximum: ACCOUNT_FREE_INTENT_MAX_BYTES,
      actual: bytes.length,
    });
  }
  const text = decodeUtf8(bytes, 'correction intent');
  if (text.startsWith('﻿')) fail('utf8-bom', 'correction intent must not begin with a UTF-8 BOM');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    fail('malformed-json', `correction intent is not valid JSON: ${error.message}`);
  }
  const normalized = validateCorrectionIntent(parsed);
  if (text !== serializeCorrectionIntent(normalized)) {
    fail(
      'noncanonical-correction-intent',
      'correction intent must use compact fixed-order JSON followed by one LF',
    );
  }
  return normalized;
}

export function correctionIntentDigest(value) {
  return sha256Digest(Buffer.from(serializeCorrectionIntent(value), 'utf8'));
}

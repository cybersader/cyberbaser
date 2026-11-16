import {
  ACCOUNT_FREE_INTENT_ARTIFACT_TYPE, ACCOUNT_FREE_RATIONALE_MAX_BYTES,
  ACCOUNT_FREE_MAX_EVIDENCE, canonicalHttpsUrl, canonicalText, deepFreeze,
  fail, PAGE_ID_RE, requireDigest, requireExactKeys, requireString,
  requireSafeInteger, sha256Digest, asBuffer, decodeUtf8,
} from './contract.js';
import { validateCorrectionIntent, correctionIntentDigest } from './intent.js';

export const ACCOUNT_FREE_SUGGESTION_INTENT_MAX_BYTES = 256 * 1024;
const REQUIRED = ['schemaVersion', 'artifactType', 'bindingDigest', 'pageId', 'operations', 'idempotencyKey'];
const OPTIONAL = ['rationale', 'evidence'];
const OP_KEYS = ['operationId', 'start', 'end', 'expected', 'replacement'];

// Cheap, source-independent admission checks. The proposal core performs full
// UTF-8/CRLF boundary and exact-base validation after retained source resolution.
function normalizeOperations(values) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 50) {
    fail('operation-count', 'suggestion intent requires 1-50 operations');
  }
  const ids = new Set();
  let previous;
  let changedBytes = 0;
  return Array.from(values, (value) => {
    requireExactKeys(value, OP_KEYS, 'operation');
    const operationId = requireString(value.operationId, 'operationId', { maxBytes: 128, rejectControls: true });
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(operationId)) fail('invalid-proposal-id', 'operationId must be a printable ASCII identifier');
    if (ids.has(operationId)) fail('duplicate-operation-id', 'operation IDs must be unique');
    ids.add(operationId);
    const start = requireSafeInteger(value.start, 'operation.start');
    const end = requireSafeInteger(value.end, 'operation.end');
    if (start > end || end > 4 * 1024 * 1024) fail('invalid-operation-range', 'operation range exceeds the supported pinned base');
    if (previous && start < previous.start) fail('noncanonical-order', 'operations must arrive in ascending start order');
    if (previous && start === previous.start) fail('duplicate-start', 'operation starts must be distinct');
    if (previous && start < previous.end) fail('overlap', 'operations must not overlap');
    const expected = requireString(value.expected, 'operation.expected', { nonEmpty: false, maxBytes: 16 * 1024 });
    const replacement = requireString(value.replacement, 'operation.replacement', { nonEmpty: false, maxBytes: 16 * 1024 });
    if (/\r(?!\n)/u.test(replacement)) fail('invalid-line-ending', 'replacement must not introduce a lone CR');
    if (Buffer.byteLength(expected) !== end - start) fail('old-bytes-length-mismatch', 'expected bytes must span the declared range');
    if (expected === replacement) fail('no-op-proposal', 'each operation must change bytes');
    changedBytes += Buffer.byteLength(expected) + Buffer.byteLength(replacement);
    if (changedBytes > 64 * 1024) fail('changed-bytes-too-large', 'total expected plus replacement exceeds 64 KiB');
    previous = { start, end };
    return { operationId, start, end, expected, replacement };
  });
}

export function validateSuggestionIntent(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('invalid-record', 'suggestion intent must be an object');
  requireExactKeys(value, [...REQUIRED, ...OPTIONAL.filter((key) => Object.hasOwn(value, key))], 'suggestion intent');
  if (value.schemaVersion !== 2) fail('unsupported-schema', 'suggestion intent schemaVersion must be 2');
  if (value.artifactType !== ACCOUNT_FREE_INTENT_ARTIFACT_TYPE) fail('invalid-artifact-type', 'invalid suggestion intent artifactType');
  if (typeof value.pageId !== 'string' || !PAGE_ID_RE.test(value.pageId)) fail('invalid-page-id', 'pageId must be a canonical page-v1 identifier');
  let rationale = Object.hasOwn(value, 'rationale') ? value.rationale : null;
  if (rationale !== null) {
    rationale = requireString(rationale, 'rationale', { maxBytes: ACCOUNT_FREE_RATIONALE_MAX_BYTES, rejectCarriageReturn: true });
    if (rationale.trim().length === 0) fail('invalid-rationale', 'rationale must contain non-whitespace text');
  }
  const urls = Object.hasOwn(value, 'evidence') ? value.evidence : [];
  if (!Array.isArray(urls) || urls.length > ACCOUNT_FREE_MAX_EVIDENCE) fail('invalid-evidence', 'evidence must contain at most eight URLs');
  const evidence = Array.from(urls, (url, i) => canonicalHttpsUrl(url, `evidence[${i}]`));
  if (new Set(evidence).size !== evidence.length) fail('duplicate-evidence', 'evidence URLs must be distinct');
  if (value.idempotencyKey !== null && (typeof value.idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/u.test(value.idempotencyKey))) {
    fail('invalid-idempotency-key', 'idempotencyKey must be null or 32-128 base64url characters');
  }
  const normalized = {
    schemaVersion: 2,
    artifactType: ACCOUNT_FREE_INTENT_ARTIFACT_TYPE,
    bindingDigest: requireDigest(value.bindingDigest, 'bindingDigest'),
    pageId: value.pageId,
    operations: normalizeOperations(value.operations),
    rationale,
    evidence,
    idempotencyKey: value.idempotencyKey,
  };
  if (Buffer.byteLength(canonicalText(normalized)) > ACCOUNT_FREE_SUGGESTION_INTENT_MAX_BYTES) fail('suggestion-intent-too-large', 'suggestion intent exceeds 256 KiB');
  return deepFreeze(normalized);
}

export function serializeSuggestionIntent(value) { return canonicalText(validateSuggestionIntent(value)); }
export function suggestionIntentDigest(value) { return sha256Digest(Buffer.from(serializeSuggestionIntent(value))); }
export function parseSuggestionIntent(value) {
  const bytes = asBuffer(value, 'suggestion intent');
  if (bytes.length === 0 || bytes.length > ACCOUNT_FREE_SUGGESTION_INTENT_MAX_BYTES) fail('suggestion-intent-too-large', 'suggestion intent must contain 1-256 KiB');
  const text = decodeUtf8(bytes, 'suggestion intent');
  if (text.startsWith('﻿')) fail('utf8-bom', 'suggestion intent must not begin with a BOM');
  let parsed;
  try { parsed = JSON.parse(text); } catch { fail('malformed-json', 'suggestion intent must contain JSON'); }
  const intent = validateSuggestionIntent(parsed);
  if (text !== serializeSuggestionIntent(intent)) fail('noncanonical-suggestion-intent', 'suggestion intent must use fixed-order compact JSON and one final LF');
  return intent;
}
export function validateVersionedIntent(value) {
  return value?.schemaVersion === 2 ? validateSuggestionIntent(value) : validateCorrectionIntent(value);
}
export function versionedIntentDigest(value) {
  return value?.schemaVersion === 2 ? suggestionIntentDigest(value) : correctionIntentDigest(value);
}

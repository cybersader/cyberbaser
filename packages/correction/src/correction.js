import { createHash, timingSafeEqual } from 'node:crypto';
import { TextDecoder } from 'node:util';

const UTF8_DECODER = new TextDecoder('utf-8', {
  fatal: true,
  ignoreBOM: true,
});
const SHA256_DIGEST_RE = /^sha-256=:([A-Za-z0-9+/]{43}=):$/;

export class CorrectionError extends Error {
  constructor(code, message, phase = 'validation', details = {}) {
    super(message);
    this.name = 'CorrectionError';
    this.code = code;
    this.phase = phase;
    this.details = details;
  }
}

function fail(code, message, phase = 'validation', details = {}) {
  throw new CorrectionError(code, message, phase, details);
}

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireRecord(value, label, phase) {
  if (!isRecord(value)) fail('invalid-record', `${label} must be an object`, phase);
  return value;
}

function exactBytes(value, label, phase) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value);
  fail('invalid-bytes', `${label} must be a Buffer or Uint8Array`, phase);
}

function decodeUtf8(bytes, label, phase) {
  try {
    return UTF8_DECODER.decode(bytes);
  } catch {
    fail('invalid-utf8', `${label} must be valid UTF-8`, phase);
  }
}

function encodeUtf8(value, label, phase, { nonEmpty = false } = {}) {
  if (typeof value !== 'string') fail('invalid-string', `${label} must be a string`, phase);
  if (nonEmpty && value.length === 0) fail('empty-quote', `${label} must not be empty`, phase);

  const bytes = Buffer.from(value, 'utf8');
  if (decodeUtf8(bytes, label, phase) !== value) {
    fail('invalid-utf8', `${label} must be valid Unicode encodable as exact UTF-8`, phase);
  }
  return bytes;
}

function validateUtf8Bytes(value, label, phase) {
  const bytes = exactBytes(value, label, phase);
  decodeUtf8(bytes, label, phase);
  return bytes;
}

function normalizeSelector(selector, phase = 'anchor') {
  requireRecord(selector, 'selector', phase);
  if (!Object.hasOwn(selector, 'quote')) {
    fail('missing-quote', 'selector.quote is required', phase);
  }

  const quoteBytes = encodeUtf8(selector.quote, 'selector.quote', phase, { nonEmpty: true });
  const normalized = { quote: selector.quote };
  let prefixBytes = null;
  let suffixBytes = null;

  if (Object.hasOwn(selector, 'prefix')) {
    prefixBytes = encodeUtf8(selector.prefix, 'selector.prefix', phase);
    normalized.prefix = selector.prefix;
  }
  if (Object.hasOwn(selector, 'suffix')) {
    suffixBytes = encodeUtf8(selector.suffix, 'selector.suffix', phase);
    normalized.suffix = selector.suffix;
  }

  return { selector: normalized, quoteBytes, prefixBytes, suffixBytes };
}

function sha256Digest(bytes) {
  return `sha-256=:${createHash('sha256').update(bytes).digest('base64')}:`;
}

function parseSha256Digest(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(SHA256_DIGEST_RE);
  if (!match) return null;
  const bytes = Buffer.from(match[1], 'base64');
  if (bytes.length !== 32 || bytes.toString('base64') !== match[1]) return null;
  return bytes;
}

function verifySha256Digest(bytes, expected) {
  const expectedBytes = parseSha256Digest(expected);
  if (!expectedBytes) return false;
  const actualBytes = createHash('sha256').update(bytes).digest();
  return timingSafeEqual(actualBytes, expectedBytes);
}

function matchesImmediatelyBefore(base, start, prefixBytes) {
  if (prefixBytes === null) return true;
  const prefixStart = start - prefixBytes.length;
  return prefixStart >= 0 && base.subarray(prefixStart, start).equals(prefixBytes);
}

function matchesImmediatelyAfter(base, end, suffixBytes) {
  if (suffixBytes === null) return true;
  const suffixEnd = end + suffixBytes.length;
  return suffixEnd <= base.length && base.subarray(end, suffixEnd).equals(suffixBytes);
}

function resolveNormalized(base, normalized) {
  const { quoteBytes, prefixBytes, suffixBytes } = normalized;
  const matches = [];
  let from = 0;

  while (from <= base.length - quoteBytes.length) {
    const start = base.indexOf(quoteBytes, from);
    if (start === -1) break;
    const end = start + quoteBytes.length;
    if (
      matchesImmediatelyBefore(base, start, prefixBytes)
      && matchesImmediatelyAfter(base, end, suffixBytes)
    ) {
      matches.push({ start, end });
      if (matches.length > 1) break;
    }
    from = start + 1;
  }

  if (matches.length === 0) {
    fail('quote-not-found', 'selector did not resolve to an exact quote occurrence', 'anchor');
  }
  if (matches.length > 1) {
    fail('quote-ambiguous', 'selector resolved to multiple exact quote occurrences', 'anchor');
  }
  return matches[0];
}

/** Resolve one exact UTF-8 text quote to half-open byte offsets. */
export function resolveQuoteAnchor(baseBytes, selector) {
  const base = validateUtf8Bytes(baseBytes, 'baseBytes', 'anchor');
  const normalized = normalizeSelector(selector, 'anchor');
  return resolveNormalized(base, normalized);
}

function replacementBytesFromRequest(request) {
  if (!Object.hasOwn(request, 'replacement')) {
    fail('missing-replacement', 'request.replacement is required', 'prepare');
  }
  return encodeUtf8(request.replacement, 'request.replacement', 'prepare');
}

function splice(base, start, end, replacementBytes) {
  return Buffer.concat([
    base.subarray(0, start),
    replacementBytes,
    base.subarray(end),
  ]);
}

function requireSafeOffset(value, label, phase) {
  if (!Number.isSafeInteger(value)) {
    fail('invalid-offset', `${label} must be a safe integer`, phase);
  }
  return value;
}

function isUtf8Boundary(bytes, offset) {
  return offset === 0 || offset === bytes.length || (bytes[offset] & 0xc0) !== 0x80;
}

function validateSpliceOffsets(base, startValue, endValue, phase, labelPrefix) {
  const start = requireSafeOffset(startValue, `${labelPrefix}.start`, phase);
  const end = requireSafeOffset(endValue, `${labelPrefix}.end`, phase);
  if (start < 0 || end < start || end > base.length) {
    fail('splice-out-of-bounds', `${labelPrefix} offsets are outside the base byte range`, phase);
  }
  if (!isUtf8Boundary(base, start) || !isUtf8Boundary(base, end)) {
    fail('offset-not-utf8-boundary', `${labelPrefix} offsets must be UTF-8 byte boundaries`, phase);
  }
  return { start, end };
}

function prepareBoundCorrection(base, start, end, replacementBytes, extra = {}) {
  const expectedOldBytes = Buffer.from(base.subarray(start, end));
  const candidate = splice(base, start, end, replacementBytes);
  decodeUtf8(candidate, 'candidateBytes', 'prepare');

  return {
    baseByteLength: base.length,
    baseDigest: sha256Digest(base),
    start,
    end,
    expectedOldBytes,
    replacementBytes: Buffer.from(replacementBytes),
    ...extra,
    candidateByteLength: candidate.length,
    candidateDigest: sha256Digest(candidate),
  };
}

/** Bind an exact quote selection and replacement to one immutable base representation. */
export function prepareCorrection(baseBytes, request) {
  const base = validateUtf8Bytes(baseBytes, 'baseBytes', 'prepare');
  requireRecord(request, 'request', 'prepare');
  if (!Object.hasOwn(request, 'selector')) {
    fail('missing-selector', 'request.selector is required', 'prepare');
  }

  const normalized = normalizeSelector(request.selector, 'prepare');
  const { start, end } = resolveNormalized(base, normalized);
  const replacementBytes = replacementBytesFromRequest(request);
  return prepareBoundCorrection(base, start, end, replacementBytes, {
    selector: { ...normalized.selector },
  });
}

/** Bind one half-open UTF-8 byte range and replacement to an immutable base. */
export function prepareOffsetCorrection(baseBytes, request) {
  const base = validateUtf8Bytes(baseBytes, 'baseBytes', 'prepare');
  requireRecord(request, 'request', 'prepare');
  const { start, end } = validateSpliceOffsets(
    base,
    request.start,
    request.end,
    'prepare',
    'request',
  );
  const replacementBytes = replacementBytesFromRequest(request);
  return prepareBoundCorrection(base, start, end, replacementBytes, {
    operationType: 'offset',
  });
}

const LIMIT_NAMES = [
  'maxBaseBytes',
  'maxEditedBytes',
  'maxOldBytes',
  'maxReplacementBytes',
  'maxChangedBytes',
  'maxChangedLines',
];

function normalizeLimits(limits) {
  if (limits === undefined) return {};
  requireRecord(limits, 'limits', 'derive');

  for (const name of Object.keys(limits)) {
    if (!LIMIT_NAMES.includes(name)) {
      fail('unknown-limit', `limits.${name} is not supported`, 'derive');
    }
  }

  const normalized = {};
  for (const name of LIMIT_NAMES) {
    if (!Object.hasOwn(limits, name)) continue;
    const value = limits[name];
    if (!Number.isSafeInteger(value) || value < 0) {
      fail('invalid-limit', `limits.${name} must be a non-negative safe integer`, 'derive');
    }
    normalized[name] = value;
  }
  return normalized;
}

function enforceLimit(actual, maximum, name) {
  if (maximum !== undefined && actual > maximum) {
    fail('limit-exceeded', `${name} exceeds limits.${name}`, 'derive', {
      limit: name,
      maximum,
      actual,
    });
  }
}

function commonPrefixLength(left, right) {
  const maximum = Math.min(left.length, right.length);
  let offset = 0;
  while (offset < maximum && left[offset] === right[offset]) offset += 1;
  while (offset > 0 && (!isUtf8Boundary(left, offset) || !isUtf8Boundary(right, offset))) {
    offset -= 1;
  }
  return offset;
}

function changedLineCount(bytes) {
  if (bytes.length === 0) return 0;
  let lines = 1;
  for (const byte of bytes) {
    if (byte === 0x0a) lines += 1;
  }
  return lines;
}

function contiguousDifference(base, edited) {
  const start = commonPrefixLength(base, edited);
  let end = base.length;
  let editedEnd = edited.length;

  while (end > start && editedEnd > start && base[end - 1] === edited[editedEnd - 1]) {
    end -= 1;
    editedEnd -= 1;
  }
  while (
    end < base.length
    && editedEnd < edited.length
    && (!isUtf8Boundary(base, end) || !isUtf8Boundary(edited, editedEnd))
  ) {
    end += 1;
    editedEnd += 1;
  }

  return { start, end, editedEnd };
}

/** Derive the smallest boundary-safe contiguous byte splice for an edited text value. */
export function deriveContiguousCorrection(baseBytes, editedText, limits) {
  const base = validateUtf8Bytes(baseBytes, 'baseBytes', 'derive');
  const edited = encodeUtf8(editedText, 'editedText', 'derive');
  const normalizedLimits = normalizeLimits(limits);

  enforceLimit(base.length, normalizedLimits.maxBaseBytes, 'maxBaseBytes');
  enforceLimit(edited.length, normalizedLimits.maxEditedBytes, 'maxEditedBytes');
  if (base.equals(edited)) {
    fail('no-op-edit', 'editedText must differ from the base representation', 'derive');
  }

  const { start, end, editedEnd } = contiguousDifference(base, edited);
  const oldByteLength = end - start;
  const oldBytes = Buffer.from(base.subarray(start, end));
  const replacementBytes = Buffer.from(edited.subarray(start, editedEnd));
  const changedByteLength = Math.max(oldByteLength, replacementBytes.length);
  const changedLines = Math.max(
    changedLineCount(oldBytes),
    changedLineCount(replacementBytes),
  );

  enforceLimit(oldByteLength, normalizedLimits.maxOldBytes, 'maxOldBytes');
  enforceLimit(
    replacementBytes.length,
    normalizedLimits.maxReplacementBytes,
    'maxReplacementBytes',
  );
  enforceLimit(changedByteLength, normalizedLimits.maxChangedBytes, 'maxChangedBytes');
  enforceLimit(changedLines, normalizedLimits.maxChangedLines, 'maxChangedLines');

  const correction = prepareOffsetCorrection(base, {
    start,
    end,
    replacement: decodeUtf8(replacementBytes, 'replacementBytes', 'derive'),
  });
  const candidate = splice(base, start, end, replacementBytes);
  if (!candidate.equals(edited)) {
    fail('derived-candidate-mismatch', 'derived correction does not reproduce editedText', 'derive');
  }
  return correction;
}

function validateBoundSelector(base, correction, expectedOldBytes) {
  const normalized = normalizeSelector(correction.selector, 'apply');
  if (!normalized.quoteBytes.equals(expectedOldBytes)) {
    fail('selector-old-bytes-mismatch', 'selector.quote does not equal expectedOldBytes', 'apply');
  }
  if (!matchesImmediatelyBefore(base, correction.start, normalized.prefixBytes)) {
    fail('selector-prefix-mismatch', 'selector.prefix is not immediately before the splice', 'apply');
  }
  if (!matchesImmediatelyAfter(base, correction.end, normalized.suffixBytes)) {
    fail('selector-suffix-mismatch', 'selector.suffix is not immediately after the splice', 'apply');
  }
}

/** Validate every bound precondition and apply exactly one byte splice. */
export function applyCorrection(baseBytes, correction) {
  const base = validateUtf8Bytes(baseBytes, 'baseBytes', 'apply');
  requireRecord(correction, 'correction', 'apply');

  if (!Number.isSafeInteger(correction.baseByteLength) || correction.baseByteLength < 0) {
    fail('invalid-base-length', 'correction.baseByteLength must be a non-negative safe integer', 'apply');
  }
  if (base.length !== correction.baseByteLength) {
    fail('base-length-mismatch', 'baseBytes length does not match the prepared correction', 'apply');
  }
  if (!parseSha256Digest(correction.baseDigest)) {
    fail('invalid-base-digest', 'correction.baseDigest must be an RFC-9530-style SHA-256 digest', 'apply');
  }
  if (!verifySha256Digest(base, correction.baseDigest)) {
    fail('base-digest-mismatch', 'baseBytes have changed since the correction was prepared', 'apply');
  }

  const { start, end } = validateSpliceOffsets(
    base,
    correction.start,
    correction.end,
    'apply',
    'correction',
  );

  const expectedOldBytes = validateUtf8Bytes(
    correction.expectedOldBytes,
    'correction.expectedOldBytes',
    'apply',
  );
  if (end - start !== expectedOldBytes.length) {
    fail('old-bytes-length-mismatch', 'correction offsets do not span expectedOldBytes', 'apply');
  }
  if (!base.subarray(start, end).equals(expectedOldBytes)) {
    fail('old-bytes-mismatch', 'baseBytes do not contain expectedOldBytes at the prepared offsets', 'apply');
  }

  if (Object.hasOwn(correction, 'selector')) {
    if (Object.hasOwn(correction, 'operationType')) {
      fail('unexpected-operation-type', 'quote-bound corrections must not declare operationType', 'apply');
    }
    validateBoundSelector(base, correction, expectedOldBytes);
  } else if (correction.operationType !== 'offset') {
    fail(
      'missing-selector',
      'correction must contain a bound selector or declare operationType offset',
      'apply',
    );
  }
  const replacementBytes = validateUtf8Bytes(
    correction.replacementBytes,
    'correction.replacementBytes',
    'apply',
  );
  const candidate = splice(base, start, end, replacementBytes);
  decodeUtf8(candidate, 'candidateBytes', 'apply');

  if (!Number.isSafeInteger(correction.candidateByteLength) || correction.candidateByteLength < 0) {
    fail('invalid-candidate-length', 'correction.candidateByteLength must be a non-negative safe integer', 'apply');
  }
  if (candidate.length !== correction.candidateByteLength) {
    fail('candidate-length-mismatch', 'candidate length does not match the prepared correction', 'apply');
  }
  if (!parseSha256Digest(correction.candidateDigest)) {
    fail('invalid-candidate-digest', 'correction.candidateDigest must be an RFC-9530-style SHA-256 digest', 'apply');
  }
  if (!verifySha256Digest(candidate, correction.candidateDigest)) {
    fail('candidate-digest-mismatch', 'candidate digest does not match the prepared correction', 'apply');
  }

  return Buffer.from(candidate);
}

import { createHash, timingSafeEqual } from 'node:crypto';

export const ACCOUNT_FREE_INTENT_SCHEMA_VERSION = 1;
export const ACCOUNT_FREE_INTENT_ARTIFACT_TYPE = 'cyberbaser-account-free-correction-intent';
export const ACCOUNT_FREE_INTENT_MAX_BYTES = 96 * 1024;
export const ACCOUNT_FREE_QUOTE_MAX_BYTES = 16 * 1024;
export const ACCOUNT_FREE_REPLACEMENT_MAX_BYTES = 16 * 1024;
export const ACCOUNT_FREE_CONTEXT_MAX_BYTES = 4 * 1024;
export const ACCOUNT_FREE_RATIONALE_MAX_BYTES = 16 * 1024;
export const ACCOUNT_FREE_MAX_EVIDENCE = 8;
export const ACCOUNT_FREE_MAX_URL_BYTES = 2 * 1024;
export const SOURCE_BINDING_SCHEMA_VERSION = 1;
export const SOURCE_BINDING_ARTIFACT_TYPE = 'cyberbaser-publication-source-binding';
export const SOURCE_BINDING_MAX_BYTES = 4 * 1024 * 1024;
export const SOURCE_BINDING_MAX_PAGES = 20_000;
export const SOURCE_BLOB_MAX_BYTES = 4 * 1024 * 1024;
export const TRUST_POLICY_MAX_BYTES = 64 * 1024;
export const TRUST_POLICY_PATH = '.cyberbaser/trust.yml';
export const GIT_OUTPUT_MAX_BYTES = 16 * 1024 * 1024;

export const DIGEST_RE = /^sha-256=:([A-Za-z0-9+/]{43}=):$/u;
export const PAGE_ID_RE = /^page-v1:[A-Za-z0-9_-]{43}$/u;
export const GIT_OBJECT_ID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const CONTROL_RE = /[\x00-\x1f\x7f]/u;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export class AccountFreeIntakeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AccountFreeIntakeError';
    this.code = code;
    this.details = details;
  }
}

export function fail(code, message, details = {}) {
  throw new AccountFreeIntakeError(code, message, details);
}

export function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function requireRecord(value, label) {
  if (!isPlainObject(value)) fail('invalid-record', `${label} must be a plain object`);
  return value;
}

export function requireExactKeys(value, keys, label) {
  requireRecord(value, label);
  const actual = Object.keys(value);
  const unknown = actual.filter((key) => !keys.includes(key));
  const missing = keys.filter((key) => !Object.hasOwn(value, key));
  if (unknown.length > 0) fail('unknown-field', `${label} contains unknown field ${unknown[0]}`, { field: unknown[0] });
  if (missing.length > 0) fail('missing-field', `${label} is missing required field ${missing[0]}`, { field: missing[0] });
  return value;
}

export function decodeUtf8(value, label) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  try {
    return UTF8_DECODER.decode(bytes);
  } catch {
    fail('invalid-utf8', `${label} must be valid UTF-8`);
  }
}

export function asBuffer(value, label) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  fail('invalid-bytes', `${label} must be bytes or text`);
}

export function requireString(value, label, {
  nonEmpty = true,
  maxBytes = 4096,
  rejectControls = false,
  rejectCarriageReturn = false,
} = {}) {
  if (typeof value !== 'string') fail('invalid-string', `${label} must be a string`);
  const bytes = Buffer.from(value, 'utf8');
  if (decodeUtf8(bytes, label) !== value) fail('invalid-unicode', `${label} must be valid Unicode`);
  if (nonEmpty && bytes.length === 0) fail('empty-string', `${label} must not be empty`);
  if (bytes.length > maxBytes) fail('string-too-large', `${label} exceeds ${maxBytes} UTF-8 bytes`, { maximum: maxBytes, actual: bytes.length });
  if (rejectControls && CONTROL_RE.test(value)) fail('control-character', `${label} must not contain control characters`);
  if (rejectCarriageReturn && value.includes('\r')) fail('invalid-line-ending', `${label} must use LF rather than CR or CRLF`);
  return value;
}

export function requireSafeInteger(value, label, { positive = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) {
    fail('invalid-integer', `${label} must be a ${positive ? 'positive' : 'non-negative'} safe integer`);
  }
  return value;
}

export function requireDigest(value, label) {
  if (typeof value !== 'string') fail('invalid-digest', `${label} must be a SHA-256 digest`);
  const match = value.match(DIGEST_RE);
  if (!match) fail('invalid-digest', `${label} must be an RFC-9530-style SHA-256 digest`);
  const bytes = Buffer.from(match[1], 'base64');
  if (bytes.length !== 32 || bytes.toString('base64') !== match[1]) fail('invalid-digest', `${label} must be an RFC-9530-style SHA-256 digest`);
  return value;
}

export function sha256Digest(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return `sha-256=:${createHash('sha256').update(bytes).digest('base64')}:`;
}

export function verifyDigest(value, expected) {
  const match = typeof expected === 'string' ? expected.match(DIGEST_RE) : null;
  if (!match) return false;
  const expectedBytes = Buffer.from(match[1], 'base64');
  const actualBytes = createHash('sha256').update(value).digest();
  return expectedBytes.length === actualBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function rejectNoncanonicalUrlAliases(value, parsed, label) {
  if (parsed.hostname.endsWith('.')) fail('noncanonical-url', `${label} must not use a trailing-dot hostname alias`);
  if (/%(?![0-9A-Fa-f]{2})/u.test(value)) fail('noncanonical-url', `${label} contains an invalid percent escape`);
  for (const match of value.matchAll(/%([0-9A-Fa-f]{2})/gu)) {
    const hex = match[1];
    const character = String.fromCharCode(Number.parseInt(hex, 16));
    if (hex !== hex.toUpperCase() || /[A-Za-z0-9._~-]/u.test(character)) {
      fail('noncanonical-url', `${label} must use one canonical percent-encoding spelling`);
    }
  }
}

export function canonicalHttpsUrl(value, label, { repository = false, forbidQueryAndFragment = false } = {}) {
  requireString(value, label, { maxBytes: ACCOUNT_FREE_MAX_URL_BYTES });
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail('invalid-url', `${label} must be an absolute canonical HTTPS URL`);
  }
  if (parsed.protocol !== 'https:') fail('invalid-url-scheme', `${label} must use HTTPS`);
  if (parsed.username !== '' || parsed.password !== '') fail('credentialed-url', `${label} must not contain credentials`);
  if (forbidQueryAndFragment && (value.includes('?') || value.includes('#'))) fail('invalid-url-components', `${label} must not contain a query or fragment`);
  if (repository && (parsed.pathname === '/' || parsed.pathname.endsWith('/') || parsed.pathname.includes('//'))) {
    fail('invalid-repository-url', `${label} must name one unambiguous repository path`);
  }
  rejectNoncanonicalUrlAliases(value, parsed, label);
  if (parsed.toString() !== value) fail('noncanonical-url', `${label} must use canonical URL spelling`);
  return value;
}

export function requireSourcePath(value, label = 'path') {
  requireString(value, label, { maxBytes: 4096, rejectControls: true });
  if (value.startsWith('/') || value.includes('\\') || !value.endsWith('.md')) {
    fail('invalid-source-path', `${label} must be a repository-relative POSIX Markdown path`);
  }
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..') || segments.includes('.git')) {
    fail('invalid-source-path', `${label} contains a forbidden path segment`);
  }
  return value;
}

export function requireGitObjectId(value, label) {
  if (typeof value !== 'string' || !GIT_OBJECT_ID_RE.test(value)) {
    fail('invalid-git-object-id', `${label} must be a complete lowercase Git object ID`);
  }
  return value;
}

export function normalizeUtcSecond(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(value)) {
    fail('invalid-timestamp', `${label} must use UTC second precision`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) fail('invalid-timestamp', `${label} must be a real timestamp`);
  const canonical = new Date(milliseconds).toISOString().replace('.000Z', 'Z');
  if (canonical !== value) fail('invalid-timestamp', `${label} must use canonical UTC second precision`);
  return value;
}

export function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    if (ArrayBuffer.isView(value)) return value;
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

export function canonicalText(value) {
  return `${JSON.stringify(value)}\n`;
}

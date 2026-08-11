import { createHash } from 'node:crypto';

export const FORGEJO_INTAKE_SCHEMA_VERSION = 1;
export const FORGEJO_INTAKE_SUPPORTED_MAJOR = 16;
export const FORGEJO_INTAKE_MAX_API_BYTES = 2 * 1024 * 1024;
export const FORGEJO_INTAKE_MAX_BLOB_BYTES = 4 * 1024 * 1024;
export const FORGEJO_INTAKE_MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;
export const FORGEJO_INTAKE_TIMEOUT_MS = 15_000;
export const TRUST_POLICY_PATH = '.cyberbaser/trust.yml';
export const TRUST_POLICY_MAX_BYTES = 64 * 1024;

export const SHA_RE = /^[0-9a-f]{40}$/u;
export const FORGEJO_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;
export const DECIMAL_ID_RE = /^[1-9][0-9]{0,19}$/u;
const UTF8_DECODER = new TextDecoder('utf-8', {
  fatal: true,
  ignoreBOM: true,
});

export class ForgejoIntakeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ForgejoIntakeError';
    this.code = code;
    this.details = details;
  }
}

export function fail(code, message, details = {}) {
  throw new ForgejoIntakeError(code, message, details);
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
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  const missing = keys.filter((key) => !Object.hasOwn(value, key));
  if (unknown.length > 0) {
    fail('unknown-field', `${label} contains unknown field ${unknown[0]}`, {
      field: unknown[0],
    });
  }
  if (missing.length > 0) {
    fail('missing-field', `${label} is missing field ${missing[0]}`, {
      field: missing[0],
    });
  }
  return value;
}

export function requireString(value, label, {
  nonEmpty = true,
  maxBytes = 4096,
  rejectControls = true,
} = {}) {
  if (typeof value !== 'string') fail('invalid-string', `${label} must be a string`);
  const bytes = Buffer.from(value, 'utf8');
  if (decodeUtf8(bytes, label) !== value) fail('invalid-unicode', `${label} must be valid Unicode`);
  if (nonEmpty && value.length === 0) fail('empty-string', `${label} must not be empty`);
  if (bytes.length > maxBytes) {
    fail('string-too-large', `${label} exceeds ${maxBytes} UTF-8 bytes`, {
      maximum: maxBytes,
      actual: bytes.length,
    });
  }
  if (rejectControls && /[\x00-\x1f\x7f]/u.test(value)) {
    fail('control-character', `${label} must not contain control characters`);
  }
  return value;
}

export function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail('invalid-positive-integer', `${label} must be a positive safe integer`);
  }
  return value;
}

export function requireDecimalId(value, label) {
  const text = Number.isSafeInteger(value) ? String(value) : value;
  if (typeof text !== 'string' || !DECIMAL_ID_RE.test(text)) {
    fail('invalid-id', `${label} must be a canonical positive decimal ID`);
  }
  return text;
}

export function requireSha(value, label) {
  if (typeof value !== 'string' || !SHA_RE.test(value)) {
    fail('invalid-git-sha', `${label} must be a lowercase 40-character Git object ID`);
  }
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

export function sha256Digest(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return `sha-256=:${createHash('sha256').update(bytes).digest('base64')}:`;
}

export function normalizeUtcSecond(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    fail('invalid-timestamp', `${label} must be a timestamp string`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) fail('invalid-timestamp', `${label} must be a real timestamp`);
  return new Date(Math.floor(milliseconds / 1000) * 1000)
    .toISOString()
    .replace('.000Z', 'Z');
}

export function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

export function asBuffer(value, label) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  fail('invalid-bytes', `${label} must be bytes or text`);
}

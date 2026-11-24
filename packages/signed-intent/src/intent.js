// The signed push intent, format v1. Frozen: see README.md "Format v1".
//
// Pure and environment-neutral: no I/O, no clock, no node:crypto. The bytes
// returned by intentBytes are what every provider signs the SHA-256 of, so a
// browser or Obsidian plugin can import this file and hash with WebCrypto.

export const INTENT_DOMAIN = 'cyberbaser.publish-intent.v1';
export const INTENT_KINDS = Object.freeze(['publish', 'enroll', 'key-add', 'key-revoke', 'recovery-reset']);
export const LIMITS = Object.freeze({
  maxChanges: 64,
  maxMessageBytes: 4096,
  maxLifetimeMs: 15 * 60_000,
  maxClockSkewMs: 60_000,
  maxPathBytes: 1024,
  maxLabel: 64,
  maxOrigins: 4,
});
export const RECOVERY_KEY_ID = 'recovery';

const OID = /^[0-9a-f]{40}$/u;
const HEX32 = /^[0-9a-f]{64}$/u;
const B64URL32 = /^[A-Za-z0-9_-]{43}$/u;
const KEY_ID = /^[A-Za-z0-9._-]{1,128}$/u;
const MODES = new Set(['100644', '100755']);
const ENCODER = new TextEncoder();
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;

export class IntentError extends TypeError {
  constructor(code, message) {
    super(message);
    this.name = 'IntentError';
    this.code = code;
  }
}

const refuse = (where) => { throw new IntentError('intent-invalid', `intent: ${where}`); };
const byteLength = (text) => ENCODER.encode(text).length;

function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

/** Canonical JSON: sorted keys, no whitespace, safe integers only, well-formed strings. */
export function canonicalJson(value) {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') {
    if (LONE_SURROGATE.test(value)) throw new IntentError('intent-invalid', 'canonical JSON: lone surrogate');
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) throw new IntentError('intent-invalid', 'canonical JSON: integers only');
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (plain(value)) {
    return `{${Object.keys(value).sort().map((key) => `${canonicalJson(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  throw new IntentError('intent-invalid', 'canonical JSON: unsupported value');
}

const exactKeys = (object, keys) => plain(object) && Object.keys(object).sort().join(',') === [...keys].sort().join(',');
const text = (value, max) => typeof value === 'string' && value.length > 0 && byteLength(value) <= max
  && !/[\u0000-\u001f\u007f<>]/u.test(value) && !LONE_SURROGATE.test(value);

function validPerson(person) {
  return exactKeys(person, ['name', 'email', 'time', 'tz']) && text(person.name, 128) && text(person.email, 256)
    && person.name.trim() === person.name && person.email.trim() === person.email
    && Number.isSafeInteger(person.time) && person.time > 0 && /^[+-]\d{4}$/u.test(person.tz);
}

function validSide(side) {
  return side === null || (exactKeys(side, ['mode', 'sha256']) && MODES.has(side.mode) && HEX32.test(side.sha256));
}

export function validPath(value) {
  return typeof value === 'string' && value.length > 0 && byteLength(value) <= LIMITS.maxPathBytes
    && !LONE_SURROGATE.test(value) && !/[\u0000-\u001f\u007f\\]/u.test(value)
    && value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..' && segment.toLowerCase() !== '.git');
}

function validOrigin(value) {
  if (typeof value !== 'string' || value.length > 200) return false;
  return /^https:\/\/[a-z0-9.-]+(?::\d{1,5})?$/u.test(value) || /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$/u.test(value);
}

/**
 * An owner key as it appears inside an intent (enroll, key-add, recovery-reset).
 *   { keyId, type: 'ed25519', publicKey: b64url(32 bytes), label }
 *   { keyId, type: 'webauthn', publicKeySpki: b64url(DER), rpId, origins: [..], label }
 */
export function validOwnerKey(key) {
  if (!plain(key) || !KEY_ID.test(key.keyId ?? '') || key.keyId === RECOVERY_KEY_ID || !text(key.label, LIMITS.maxLabel)) return false;
  if (key.type === 'ed25519') return exactKeys(key, ['keyId', 'type', 'publicKey', 'label']) && B64URL32.test(key.publicKey);
  if (key.type === 'webauthn') {
    return exactKeys(key, ['keyId', 'type', 'publicKeySpki', 'rpId', 'origins', 'label'])
      && typeof key.publicKeySpki === 'string' && /^[A-Za-z0-9_-]{40,400}$/u.test(key.publicKeySpki)
      && typeof key.rpId === 'string' && /^(?:localhost|[a-z0-9-]+(?:\.[a-z0-9-]+)+)$/u.test(key.rpId)
      && Array.isArray(key.origins) && key.origins.length > 0 && key.origins.length <= LIMITS.maxOrigins
      && key.origins.every(validOrigin) && new Set(key.origins).size === key.origins.length;
  }
  return false;
}

function validSubject(kind, subject) {
  switch (kind) {
    case 'enroll': return exactKeys(subject, ['key', 'proof']) && validOwnerKey(subject.key) && B64URL32.test(subject.proof);
    case 'key-add': return exactKeys(subject, ['key']) && validOwnerKey(subject.key);
    case 'key-revoke': return exactKeys(subject, ['keyId']) && KEY_ID.test(subject.keyId ?? '') && subject.keyId !== RECOVERY_KEY_ID;
    case 'recovery-reset': return exactKeys(subject, ['key', 'recoveryKey']) && validOwnerKey(subject.key)
      && (subject.recoveryKey === null || B64URL32.test(subject.recoveryKey ?? ''));
    default: return false;
  }
}

function validPublishBody(intent) {
  const { target, base, commit, changes } = intent;
  if (!exactKeys(target, ['remote', 'branch']) || typeof target.remote !== 'string' || target.remote.length > 300
    || !/^https:\/\/[^\s@?#]+$/u.test(target.remote) || typeof target.branch !== 'string'
    || !/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u.test(target.branch) || target.branch.length > 200
    || target.branch.includes('..') || target.branch.endsWith('.lock')) refuse('target');
  if (typeof base !== 'string' || !OID.test(base)) refuse('base');
  if (!exactKeys(commit, ['author', 'committer', 'message']) || !validPerson(commit.author) || !validPerson(commit.committer)
    || typeof commit.message !== 'string' || commit.message.length === 0 || LONE_SURROGATE.test(commit.message)
    || byteLength(commit.message) > LIMITS.maxMessageBytes || !commit.message.endsWith('\n')
    || commit.message.includes('\u0000')) refuse('commit');
  if (!Array.isArray(changes) || changes.length === 0 || changes.length > LIMITS.maxChanges) refuse('changes');
  let previous = null;
  for (const change of changes) {
    if (!exactKeys(change, ['path', 'before', 'after']) || !validPath(change.path) || !validSide(change.before)
      || !validSide(change.after) || (change.before === null && change.after === null)
      || (previous !== null && change.path <= previous)) refuse('change entry');
    previous = change.path;
  }
  // A path may not be both a file and the parent of another changed path.
  const paths = new Set(changes.map((change) => change.path));
  for (const change of changes) {
    const segments = change.path.split('/');
    for (let i = 1; i < segments.length; i += 1) if (paths.has(segments.slice(0, i).join('/'))) refuse('change entry');
  }
}

/**
 * Returns a deep-frozen canonical copy, or throws IntentError. Unknown members
 * are refused, never ignored; every kind has exactly its listed members.
 */
export function validateIntent(intent) {
  const common = ['v', 'kind', 'publisher', 'keyId', 'nonce', 'issuedAt', 'expiresAt'];
  if (!plain(intent) || intent.v !== 1 || !INTENT_KINDS.includes(intent.kind)) refuse('version or kind');
  if (intent.kind === 'publish') {
    if (!exactKeys(intent, [...common, 'target', 'base', 'commit', 'changes'])) refuse('members');
    validPublishBody(intent);
  } else {
    if (!exactKeys(intent, [...common, 'subject'])) refuse('members');
    if (!validSubject(intent.kind, intent.subject)) refuse('subject');
  }
  if (typeof intent.publisher !== 'string' || !HEX32.test(intent.publisher)
    || typeof intent.keyId !== 'string' || !KEY_ID.test(intent.keyId)
    || typeof intent.nonce !== 'string' || !B64URL32.test(intent.nonce)
    || !Number.isSafeInteger(intent.issuedAt) || intent.issuedAt <= 0 || !Number.isSafeInteger(intent.expiresAt)
    || intent.expiresAt <= intent.issuedAt || intent.expiresAt - intent.issuedAt > LIMITS.maxLifetimeMs) refuse('envelope');
  // The recovery key signs exactly one thing; nothing else may claim its name.
  if ((intent.kind === 'recovery-reset') !== (intent.keyId === RECOVERY_KEY_ID)) refuse('recovery key');
  if (intent.kind === 'enroll' && intent.subject.key.keyId !== intent.keyId) refuse('enroll key');
  return deepFreeze(JSON.parse(canonicalJson(intent)));
}

/** The exact bytes whose SHA-256 every provider signs: the domain line, then canonical JSON. */
export function intentBytes(intent) {
  return ENCODER.encode(`${INTENT_DOMAIN}\n${canonicalJson(validateIntent(intent))}`);
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}

import { createHash } from 'node:crypto';
import path from 'node:path';
import { fail } from './errors.js';

export const QUEUE_SCHEMA_VERSION = 1;
export const QUEUE_STATES = Object.freeze(['pending-review', 'expired']);
export const QUEUE_LANES = Object.freeze(['lane-a', 'lane-b']);
export const DEFAULT_QUEUE_CONFIG = Object.freeze({
  maxPendingEntries: 1000,
  maxRetainedBytes: 256 * 1024 * 1024,
  maxPendingPerSource: 25,
  pendingRetentionDays: 30,
  expiredGraceDays: 7,
});
export const QUEUE_CONFIG_CAPS = Object.freeze({
  maxPendingEntries: 10_000,
  maxRetainedBytes: 1024 * 1024 * 1024,
  maxPendingPerSource: 250,
  pendingRetentionDays: 365,
  expiredGraceDays: 90,
});

const QUEUE_ID_RE = /^Q-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST_RE = /^sha-256=:[A-Za-z0-9+/]{43}=:$/;
const SHA_RE = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const UTC_SECOND_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const DECIMAL_ID_RE = /^(?:0|[1-9][0-9]*)$/;
const SCOPE_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/;
const CONTROL_RE = /[\x00-\x1f\x7f]/u;
const BANNED_METADATA_KEY_RE = /^(?:authorization|cookie|password|passwd|secret|token|credential|api[-_]?key|raw[-_]?body|request[-_]?body|client[-_]?ip|remote[-_]?addr|forwarded|x-forwarded(?:-.*)?|idempotency[-_]?key|local[-_]?path|filesystem|checkout|worktree)$/iu;
const BANNED_METADATA_VALUE_RES = Object.freeze([
  /(?:^|\s)(?:bearer|basic)\s+[A-Za-z0-9+/_.=-]+/iu,
  /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/u,
  /:\/\/[^/@\s:]+:[^/@\s]+@/u,
  /(?:^|[^0-9])(?:25[0-5]|2[0-4][0-9]|1?[0-9]{1,2})(?:\.(?:25[0-5]|2[0-4][0-9]|1?[0-9]{1,2})){3}(?:[^0-9]|$)/u,
  /(?:^|[\s"'])\/(?:home|root|run|var|tmp|etc|opt|srv|mnt|media)\//u,
  /(?:^|[\s"'])[A-Za-z]:\\/u,
]);

export function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function exactObject(value, keys, label) {
  if (!isRecord(value)) fail('invalid-record', `${label} must be an object`);
  const actual = Object.keys(value);
  const unknown = actual.filter((key) => !keys.includes(key));
  const missing = keys.filter((key) => !Object.hasOwn(value, key));
  if (unknown.length > 0) fail('unknown-field', `${label} contains unknown field ${unknown[0]}`, { field: unknown[0] });
  if (missing.length > 0) fail('missing-field', `${label} is missing required field ${missing[0]}`, { field: missing[0] });
  return value;
}

export function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

export function digestBytes(bytes) {
  return `sha-256=:${createHash('sha256').update(bytes).digest('base64')}:`;
}

export function validateDigest(value, label = 'digest') {
  if (typeof value !== 'string' || !DIGEST_RE.test(value)) fail('invalid-digest', `${label} must be one RFC-9530-style SHA-256 digest`);
  const encoded = value.slice('sha-256=:'.length, -1);
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length !== 32 || bytes.toString('base64') !== encoded) fail('invalid-digest', `${label} must be one RFC-9530-style SHA-256 digest`);
  return value;
}

export function utf8String(value, label, { nonEmpty = true, maxBytes = 4096, trim = false, controls = false } = {}) {
  if (typeof value !== 'string') fail('invalid-string', `${label} must be a string`);
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.toString('utf8') !== value) fail('invalid-unicode', `${label} must contain valid Unicode`);
  if (nonEmpty && bytes.length === 0) fail('empty-string', `${label} must not be empty`);
  if (bytes.length > maxBytes) fail('string-too-large', `${label} exceeds ${maxBytes} UTF-8 bytes`);
  if (trim && value.trim() !== value) fail('invalid-string', `${label} must not have surrounding whitespace`);
  if (!controls && CONTROL_RE.test(value)) fail('invalid-control-character', `${label} must not contain control characters`);
  return value;
}

export function utcSecond(value, label = 'timestamp') {
  if (typeof value !== 'string' || !UTC_SECOND_RE.test(value)) fail('invalid-timestamp', `${label} must use canonical UTC second precision`);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString().replace('.000Z', 'Z') !== value) {
    fail('invalid-timestamp', `${label} must use canonical UTC second precision`);
  }
  return value;
}

export function addDays(value, days) {
  const milliseconds = Date.parse(utcSecond(value)) + days * 86_400_000;
  if (!Number.isSafeInteger(milliseconds)) fail('invalid-timestamp', 'retention timestamp exceeds the safe range');
  return new Date(milliseconds).toISOString().replace('.000Z', 'Z');
}

function boundedInteger(value, label, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) fail('invalid-queue-config', `${label} must be an integer from 1 through ${maximum}`);
  return value;
}

export function validateProposalQueueConfig(input = {}) {
  if (!isRecord(input)) fail('invalid-queue-config', 'queue configuration must be an object');
  const allowed = ['root', ...Object.keys(DEFAULT_QUEUE_CONFIG)];
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) fail('unknown-field', `queue configuration contains unknown field ${unknown[0]}`);
  if (typeof input.root !== 'string' || !path.isAbsolute(input.root) || path.resolve(input.root) !== input.root) fail('invalid-queue-root', 'queue root must be one normalized absolute path');
  if (input.root === path.parse(input.root).root) fail('invalid-queue-root', 'queue root must not be a filesystem root');
  const merged = { ...DEFAULT_QUEUE_CONFIG, ...input };
  const normalized = {
    root: merged.root,
    maxPendingEntries: boundedInteger(merged.maxPendingEntries, 'maxPendingEntries', QUEUE_CONFIG_CAPS.maxPendingEntries),
    maxRetainedBytes: boundedInteger(merged.maxRetainedBytes, 'maxRetainedBytes', QUEUE_CONFIG_CAPS.maxRetainedBytes),
    maxPendingPerSource: boundedInteger(merged.maxPendingPerSource, 'maxPendingPerSource', QUEUE_CONFIG_CAPS.maxPendingPerSource),
    pendingRetentionDays: boundedInteger(merged.pendingRetentionDays, 'pendingRetentionDays', QUEUE_CONFIG_CAPS.pendingRetentionDays),
    expiredGraceDays: boundedInteger(merged.expiredGraceDays, 'expiredGraceDays', QUEUE_CONFIG_CAPS.expiredGraceDays),
  };
  if (normalized.maxPendingPerSource > normalized.maxPendingEntries) fail('invalid-queue-config', 'maxPendingPerSource must not exceed maxPendingEntries');
  return deepFreeze(normalized);
}

export function validateQueueId(value) {
  if (typeof value !== 'string' || !QUEUE_ID_RE.test(value)) fail('invalid-queue-id', 'queueId must use Q- followed by one lowercase RFC 4122 version 4 UUID');
  return value;
}

export function normalizeVerifiedSubject(value) {
  if (value === null || value === undefined) return null;
  exactObject(value, ['author', 'authorType'], 'verifiedSubject');
  if (!['human', 'agent'].includes(value.authorType)) fail('invalid-verified-subject', 'verifiedSubject.authorType must be human or agent');
  return { author: utf8String(value.author, 'verifiedSubject.author', { maxBytes: 1024, trim: true }), authorType: value.authorType };
}

export function validatePolicyInput(value) {
  exactObject(value, ['status', 'digest', 'config'], 'policy');
  if (!['valid', 'missing', 'malformed'].includes(value.status)) fail('invalid-policy-status', 'policy.status must be valid, missing, or malformed');
  if (value.status === 'valid') {
    if (!isRecord(value.config)) fail('invalid-policy-evidence', 'valid policy evidence requires a parsed configuration object');
    return deepFreeze({ status: 'valid', digest: validateDigest(value.digest, 'policy.digest'), config: value.config });
  }
  if (value.digest !== null || value.config !== null) fail('invalid-policy-evidence', 'missing or malformed policy evidence requires null digest and config');
  return deepFreeze({ status: value.status, digest: null, config: null });
}

function validateIdempotencyKey(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length < 32 || value.length > 128 || !BASE64URL_RE.test(value)) {
    fail('invalid-idempotency-key', 'idempotency.key must be 32-128 unpadded base64url characters or null');
  }
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length < 24 || decoded.toString('base64url') !== value) fail('invalid-idempotency-key', 'idempotency.key must use canonical high-entropy base64url encoding');
  return value;
}

export function validateIdempotencyInput(value, lane) {
  exactObject(value, ['scope', 'key', 'requestDigest'], 'idempotency');
  if (typeof value.scope !== 'string' || !SCOPE_RE.test(value.scope)) fail('invalid-idempotency-scope', 'idempotency.scope must be one bounded safe ASCII identifier');
  const key = validateIdempotencyKey(value.key);
  if (lane === 'lane-b' && value.scope !== 'lane-b') fail('invalid-idempotency-scope', 'Lane B idempotency.scope must be lane-b');
  if (lane === 'lane-a' && key !== null) fail('invalid-idempotency-key', 'Lane A replay is derived from repository ID, pull request, and head SHA and requires a null key');
  return deepFreeze({ scope: value.scope, key, requestDigest: validateDigest(value.requestDigest, 'idempotency.requestDigest') });
}

function normalizeLaneAMetadata(value) {
  exactObject(value, ['repositoryId', 'pullRequestNumber', 'headSha'], 'carrier.metadata');
  const repositoryId = typeof value.repositoryId === 'number' ? String(value.repositoryId) : value.repositoryId;
  if (typeof repositoryId !== 'string' || !DECIMAL_ID_RE.test(repositoryId) || repositoryId.length > 40) fail('invalid-carrier', 'Lane A repositoryId must be one bounded decimal identifier');
  if (!Number.isSafeInteger(value.pullRequestNumber) || value.pullRequestNumber < 1) fail('invalid-carrier', 'Lane A pullRequestNumber must be a positive safe integer');
  if (typeof value.headSha !== 'string' || !SHA_RE.test(value.headSha)) fail('invalid-carrier', 'Lane A headSha must be one lowercase 40- or 64-hex object identity');
  return { repositoryId, pullRequestNumber: value.pullRequestNumber, headSha: value.headSha };
}

function normalizeLaneBMetadata(value) {
  exactObject(value, ['bindingDigest', 'pageId'], 'carrier.metadata');
  return {
    bindingDigest: validateDigest(value.bindingDigest, 'carrier.metadata.bindingDigest'),
    pageId: utf8String(value.pageId, 'carrier.metadata.pageId', { maxBytes: 512, trim: true }),
  };
}

export function validateCarrierInput(value) {
  exactObject(value, ['lane', 'metadata'], 'carrier');
  if (value.lane === 'lane-a') return deepFreeze({ lane: 'lane-a', metadata: normalizeLaneAMetadata(value.metadata) });
  if (value.lane === 'lane-b') return deepFreeze({ lane: 'lane-b', metadata: normalizeLaneBMetadata(value.metadata) });
  fail('invalid-carrier', 'carrier.lane must be lane-a or lane-b');
}

export function idempotencyDigests(carrierInput, idempotencyInput) {
  const carrier = validateCarrierInput(carrierInput);
  const idempotency = validateIdempotencyInput(idempotencyInput, carrier.lane);
  const keyDigest = idempotency.key === null ? null : digestBytes(Buffer.from(idempotency.key, 'utf8'));
  let replayScope = null;
  if (carrier.lane === 'lane-a') {
    replayScope = digestBytes(Buffer.from(
      `lane-a\0${carrier.metadata.repositoryId}\0${carrier.metadata.pullRequestNumber}\0${carrier.metadata.headSha}`,
      'utf8',
    ));
  } else if (keyDigest !== null) {
    replayScope = digestBytes(Buffer.from(`lane-b\0${keyDigest}`, 'utf8'));
  }
  return deepFreeze({ requestDigest: idempotency.requestDigest, idempotencyKeyDigest: keyDigest, replayScope });
}

export function createDurableCarrier(carrierInput, replayScope) {
  const carrier = validateCarrierInput(carrierInput);
  return validateDurableCarrier({
    schemaVersion: 1,
    artifactType: 'cyberbaser-proposal-queue-carrier',
    lane: carrier.lane,
    replayScope,
    metadata: carrier.metadata,
  });
}

export function validateDurableCarrier(value) {
  exactObject(value, ['schemaVersion', 'artifactType', 'lane', 'replayScope', 'metadata'], 'carrier artifact');
  if (value.schemaVersion !== 1 || value.artifactType !== 'cyberbaser-proposal-queue-carrier') fail('invalid-carrier-artifact', 'carrier artifact schema or type is unsupported');
  if (value.replayScope !== null) validateDigest(value.replayScope, 'carrier.replayScope');
  if (value.lane === 'lane-a') return deepFreeze({ schemaVersion: 1, artifactType: value.artifactType, lane: 'lane-a', replayScope: value.replayScope, metadata: normalizeLaneAMetadata(value.metadata) });
  if (value.lane === 'lane-b') return deepFreeze({ schemaVersion: 1, artifactType: value.artifactType, lane: 'lane-b', replayScope: value.replayScope, metadata: normalizeLaneBMetadata(value.metadata) });
  fail('invalid-carrier-artifact', 'carrier artifact lane is unsupported');
}

export function validateReceipt(value) {
  exactObject(value, ['schemaVersion', 'artifactType', 'queueId', 'lane', 'receivedAt', 'expiresAt', 'proposalDigest', 'proposalByteLength', 'requestDigest', 'idempotencyKeyDigest', 'sourcePartitionDigest'], 'receipt');
  if (value.schemaVersion !== 1 || value.artifactType !== 'cyberbaser-proposal-queue-receipt') fail('invalid-receipt', 'receipt schema or type is unsupported');
  if (!QUEUE_LANES.includes(value.lane)) fail('invalid-receipt', 'receipt lane is unsupported');
  const receivedAt = utcSecond(value.receivedAt, 'receipt.receivedAt');
  const expiresAt = utcSecond(value.expiresAt, 'receipt.expiresAt');
  if (Date.parse(expiresAt) <= Date.parse(receivedAt)) fail('invalid-receipt', 'receipt expiry must follow receipt time');
  if (!Number.isSafeInteger(value.proposalByteLength) || value.proposalByteLength < 1 || value.proposalByteLength > 256 * 1024) fail('invalid-receipt', 'receipt proposalByteLength is invalid');
  if (value.idempotencyKeyDigest !== null) validateDigest(value.idempotencyKeyDigest, 'receipt.idempotencyKeyDigest');
  return deepFreeze({
    schemaVersion: 1,
    artifactType: value.artifactType,
    queueId: validateQueueId(value.queueId),
    lane: value.lane,
    receivedAt,
    expiresAt,
    proposalDigest: validateDigest(value.proposalDigest, 'receipt.proposalDigest'),
    proposalByteLength: value.proposalByteLength,
    requestDigest: validateDigest(value.requestDigest, 'receipt.requestDigest'),
    idempotencyKeyDigest: value.idempotencyKeyDigest,
    sourcePartitionDigest: validateDigest(value.sourcePartitionDigest, 'receipt.sourcePartitionDigest'),
  });
}

function normalizeJson(value, label, depth = 0) {
  if (depth > 12) fail('invalid-classification', `${label} exceeds the nesting limit`);
  if (Array.isArray(value)) {
    if (value.length > 256) fail('invalid-classification', `${label} exceeds the array limit`);
    return value.map((item, index) => normalizeJson(item, `${label}[${index}]`, depth + 1));
  }
  if (isRecord(value)) {
    const output = {};
    for (const [key, nested] of Object.entries(value)) output[key] = normalizeJson(nested, `${label}.${key}`, depth + 1);
    return output;
  }
  if (typeof value === 'string') return utf8String(value, label, { nonEmpty: false, maxBytes: 16 * 1024, controls: true });
  if (value === null || typeof value === 'boolean') return value;
  if (Number.isSafeInteger(value)) return value;
  fail('invalid-classification', `${label} contains a non-JSON value`);
}

export function validateClassificationArtifact(value) {
  exactObject(value, ['schemaVersion', 'artifactType', 'policyStatus', 'policyDigest', 'verifiedSubject', 'classification'], 'classification artifact');
  if (value.schemaVersion !== 1 || value.artifactType !== 'cyberbaser-proposal-queue-classification') fail('invalid-classification', 'classification artifact schema or type is unsupported');
  if (!['valid', 'missing', 'malformed'].includes(value.policyStatus)) fail('invalid-classification', 'classification policy status is unsupported');
  if (value.policyStatus === 'valid') validateDigest(value.policyDigest, 'classification.policyDigest');
  else if (value.policyDigest !== null) fail('invalid-classification', 'missing or malformed classification policy requires null digest');
  const classification = normalizeJson(value.classification, 'classification');
  exactObject(classification, ['tier', 'route', 'reasons', 'checks'], 'classification');
  if (!['auto-merge', 'quick-review', 'full-review', 'reject'].includes(classification.route)) fail('invalid-classification', 'classification route is unsupported');
  if (typeof classification.tier !== 'string' || !Array.isArray(classification.reasons) || !isRecord(classification.checks)) fail('invalid-classification', 'classification shape is invalid');
  return deepFreeze({ schemaVersion: 1, artifactType: value.artifactType, policyStatus: value.policyStatus, policyDigest: value.policyDigest, verifiedSubject: normalizeVerifiedSubject(value.verifiedSubject), classification });
}

export function validateStateArtifact(value) {
  exactObject(value, ['schemaVersion', 'artifactType', 'queueId', 'state', 'revision', 'createdAt', 'updatedAt', 'history'], 'state artifact');
  if (value.schemaVersion !== 1 || value.artifactType !== 'cyberbaser-proposal-queue-state') fail('invalid-state', 'state artifact schema or type is unsupported');
  const queueId = validateQueueId(value.queueId);
  if (!QUEUE_STATES.includes(value.state) || ![0, 1].includes(value.revision)) fail('invalid-state', 'queue state or revision is unsupported');
  const createdAt = utcSecond(value.createdAt, 'state.createdAt');
  const updatedAt = utcSecond(value.updatedAt, 'state.updatedAt');
  if (!Array.isArray(value.history) || value.history.length !== value.revision + 1) fail('invalid-state', 'state history length must match revision');
  const history = value.history.map((entry, index) => {
    exactObject(entry, ['revision', 'from', 'to', 'at', 'reason'], `state.history[${index}]`);
    if (entry.revision !== index) fail('invalid-state', 'state history revisions must be contiguous');
    const expected = index === 0
      ? { from: null, to: 'pending-review', reason: 'proposal-received' }
      : { from: 'pending-review', to: 'expired', reason: 'retention-expired' };
    if (entry.from !== expected.from || entry.to !== expected.to || entry.reason !== expected.reason) fail('invalid-state', 'state history contains an illegal transition');
    return { revision: index, from: entry.from, to: entry.to, at: utcSecond(entry.at, `state.history[${index}].at`), reason: entry.reason };
  });
  if (history[0].at !== createdAt || history.at(-1).at !== updatedAt || history.at(-1).to !== value.state || value.revision !== history.length - 1) fail('invalid-state', 'state timestamps and history must agree');
  return deepFreeze({ schemaVersion: 1, artifactType: value.artifactType, queueId, state: value.state, revision: value.revision, createdAt, updatedAt, history });
}

export function createPendingState(queueId, at) {
  return validateStateArtifact({ schemaVersion: 1, artifactType: 'cyberbaser-proposal-queue-state', queueId, state: 'pending-review', revision: 0, createdAt: at, updatedAt: at, history: [{ revision: 0, from: null, to: 'pending-review', at, reason: 'proposal-received' }] });
}

export function expireState(value, at) {
  const current = validateStateArtifact(value);
  if (current.state !== 'pending-review') fail('illegal-queue-transition', `${current.state} cannot transition to expired`);
  const expiredAt = utcSecond(at, 'expiration time');
  if (Date.parse(expiredAt) < Date.parse(current.updatedAt)) fail('invalid-state', 'expiration time precedes durable state');
  return validateStateArtifact({ ...current, state: 'expired', revision: 1, updatedAt: expiredAt, history: [...current.history, { revision: 1, from: 'pending-review', to: 'expired', at: expiredAt, reason: 'retention-expired' }] });
}

export function assertMetadataSafe(value, label = 'metadata', depth = 0) {
  if (depth > 12) fail('unsafe-metadata', `${label} exceeds the metadata nesting limit`);
  if (Array.isArray(value)) {
    if (value.length > 256) fail('unsafe-metadata', `${label} exceeds the metadata array limit`);
    value.forEach((item, index) => assertMetadataSafe(item, `${label}[${index}]`, depth + 1));
    return;
  }
  if (isRecord(value)) {
    for (const [key, nested] of Object.entries(value)) {
      if (BANNED_METADATA_KEY_RE.test(key)) fail('unsafe-metadata', `${label} contains forbidden field ${key}`);
      assertMetadataSafe(nested, `${label}.${key}`, depth + 1);
    }
    return;
  }
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > 16 * 1024 || BANNED_METADATA_VALUE_RES.some((expression) => expression.test(value))) fail('unsafe-metadata', `${label} contains forbidden or oversized material`);
    return;
  }
  if (value !== null && typeof value !== 'boolean' && !Number.isSafeInteger(value)) fail('unsafe-metadata', `${label} contains a non-JSON value`);
}

export function canonicalMetadataBytes(value, validator, maxBytes = 512 * 1024) {
  const normalized = validator(value);
  assertMetadataSafe(normalized);
  const bytes = Buffer.from(`${JSON.stringify(normalized)}\n`, 'utf8');
  if (bytes.length > maxBytes) fail('metadata-too-large', 'metadata artifact exceeds its byte limit');
  return bytes;
}

export function parseCanonicalMetadata(bytes, validator, label, maxBytes = 512 * 1024) {
  const buffer = Buffer.from(bytes);
  if (buffer.length < 2 || buffer.length > maxBytes) fail('invalid-metadata', `${label} is empty or oversized`);
  const text = buffer.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(buffer)) fail('invalid-metadata', `${label} must be valid UTF-8`);
  let parsed;
  try { parsed = JSON.parse(text); } catch { fail('invalid-metadata', `${label} must be strict JSON`); }
  const normalized = validator(parsed);
  if (!canonicalMetadataBytes(normalized, validator, maxBytes).equals(buffer)) fail('noncanonical-metadata', `${label} must use canonical compact JSON and one final LF`);
  return normalized;
}

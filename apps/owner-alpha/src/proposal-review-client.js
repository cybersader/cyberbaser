import net from 'node:net';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  createReviewEvidence,
} from '@cyberbaser/proposal-review';
import {
  validateDigest,
  validateQueueId,
} from '@cyberbaser/proposal-queue';
import { fail, OwnerAlphaError } from './errors.js';
import { canonicalJson, deepFreeze, isPlainObject } from './json.js';

export const PROPOSAL_REVIEW_IPC_SCHEMA_VERSION = 1;
export const PROPOSAL_REVIEW_IPC_REQUEST_MAX_BYTES = 4 * 1024;
export const PROPOSAL_REVIEW_IPC_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;

const UTC_SECOND_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u;

function exactObject(value, keys, label) {
  if (!isPlainObject(value)) fail('invalid-review-response', `${label} must be an object`);
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  const missing = keys.filter((key) => !Object.hasOwn(value, key));
  if (unknown.length > 0 || missing.length > 0) {
    fail('invalid-review-response', `${label} must contain its exact fields`, {
      unknown: unknown.sort(),
      missing: missing.sort(),
    });
  }
  return value;
}

function optionalObject(value, keys, label) {
  if (!isPlainObject(value)) fail('invalid-review-request', `${label} must be an object`);
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  if (unknown.length > 0) {
    fail('invalid-review-request', `${label} contains unknown fields`, { fields: unknown.sort() });
  }
  return value;
}

function boundedString(value, label, maximum, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string'
    || value.length === 0
    || value.trim() !== value
    || Buffer.byteLength(value, 'utf8') > maximum
    || /\p{Cc}/u.test(value)) {
    fail('invalid-review-response', `${label} must be one bounded exact string`);
  }
  return value;
}

function utcSecond(value, label) {
  if (typeof value !== 'string' || !UTC_SECOND_RE.test(value)) {
    fail('invalid-review-response', `${label} must use canonical UTC second precision`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)
    || new Date(milliseconds).toISOString().replace('.000Z', 'Z') !== value) {
    fail('invalid-review-response', `${label} must use canonical UTC second precision`);
  }
  return value;
}

function assertResponseJson(value) {
  const pending = [{ value, depth: 0, label: 'review IPC response' }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current.depth > 32) {
      fail('invalid-review-response', 'review IPC response exceeds the nesting limit');
    }
    if (Array.isArray(current.value)) {
      if (current.value.length > 1024) {
        fail('invalid-review-response', 'review IPC response exceeds the array limit');
      }
      current.value.forEach((entry, index) => pending.push({
        value: entry,
        depth: current.depth + 1,
        label: `${current.label}[${index}]`,
      }));
      continue;
    }
    if (isPlainObject(current.value)) {
      const keys = Object.keys(current.value);
      if (keys.length > 1024) {
        fail('invalid-review-response', 'review IPC response exceeds the object field limit');
      }
      for (const key of keys) {
        if (Buffer.byteLength(key, 'utf8') > 256 || /\p{Cc}/u.test(key)) {
          fail('invalid-review-response', 'review IPC response contains an invalid object key');
        }
        pending.push({
          value: current.value[key],
          depth: current.depth + 1,
          label: `${current.label}.${key}`,
        });
      }
      continue;
    }
    if (typeof current.value === 'string') {
      if (Buffer.byteLength(current.value, 'utf8') > 512 * 1024) {
        fail('invalid-review-response', `${current.label} exceeds the string limit`);
      }
      continue;
    }
    if (current.value === null || typeof current.value === 'boolean') continue;
    if (Number.isSafeInteger(current.value)) continue;
    fail('invalid-review-response', `${current.label} contains an unsupported JSON value`);
  }
}

function reviewSummary(value) {
  exactObject(value, [
    'schemaVersion',
    'artifactType',
    'queueId',
    'proposalId',
    'proposalDigest',
    'candidateDigest',
    'reviewEvidenceDigest',
    'source',
    'receivedAt',
    'expiresAt',
    'state',
    'lane',
    'tier',
    'route',
  ], 'review summary');
  if (value.schemaVersion !== 1 || value.artifactType !== 'cyberbaser-proposal-review-summary') {
    fail('invalid-review-response', 'review summary schema or artifact type is unsupported');
  }
  exactObject(value.source, ['repository', 'revision', 'path'], 'review summary source');
  if (!['pending-review', 'expired'].includes(value.state)
    || !['lane-a', 'lane-b'].includes(value.lane)
    || !['auto-merge', 'quick-review', 'full-review', 'reject'].includes(value.route)) {
    fail('invalid-review-response', 'review summary contains an unsupported state, lane, or route');
  }
  let queueId;
  let proposalDigest;
  let candidateDigest;
  let reviewEvidenceDigest;
  try {
    queueId = validateQueueId(value.queueId);
    proposalDigest = validateDigest(value.proposalDigest, 'proposalDigest');
    candidateDigest = validateDigest(value.candidateDigest, 'candidateDigest');
    reviewEvidenceDigest = validateDigest(value.reviewEvidenceDigest, 'reviewEvidenceDigest');
  } catch (error) {
    fail('invalid-review-response', 'review summary identifiers or digests are invalid', {
      cause: error?.code ?? 'unknown',
    });
  }
  const receivedAt = utcSecond(value.receivedAt, 'review summary receivedAt');
  const expiresAt = utcSecond(value.expiresAt, 'review summary expiresAt');
  if (Date.parse(expiresAt) <= Date.parse(receivedAt)) {
    fail('invalid-review-response', 'review summary expiry must follow receipt');
  }
  return deepFreeze({
    schemaVersion: 1,
    artifactType: value.artifactType,
    queueId,
    proposalId: boundedString(value.proposalId, 'review summary proposalId', 1024),
    proposalDigest,
    candidateDigest,
    reviewEvidenceDigest,
    source: {
      repository: boundedString(value.source.repository, 'review summary source.repository', 4096),
      revision: boundedString(value.source.revision, 'review summary source.revision', 1024),
      path: boundedString(value.source.path, 'review summary source.path', 4096),
    },
    receivedAt,
    expiresAt,
    state: value.state,
    lane: value.lane,
    tier: boundedString(value.tier, 'review summary tier', 256),
    route: value.route,
  });
}

function parseResponse(input, maximum) {
  const bytes = Buffer.from(input);
  if (bytes.length < 2 || bytes.length > maximum) {
    fail('invalid-review-response', 'review IPC response is empty or oversized');
  }
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    fail('invalid-review-response', 'review IPC response must not contain a UTF-8 BOM');
  }
  if (bytes.at(-1) !== 0x0a || bytes.indexOf(0x0a) !== bytes.length - 1) {
    fail('invalid-review-response', 'review IPC response must contain exactly one final LF');
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    fail('invalid-review-response', 'review IPC response must use valid UTF-8');
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail('invalid-review-response', 'review IPC response must contain strict JSON');
  }
  assertResponseJson(parsed);
  let canonical;
  try {
    canonical = canonicalJson(parsed);
  } catch (error) {
    if (error instanceof OwnerAlphaError) throw error;
    fail('invalid-review-response', 'review IPC response could not be canonicalized');
  }
  if (`${canonical}\n` !== text) {
    fail('invalid-review-response', 'review IPC response must use canonical JSON');
  }
  if (parsed.error !== undefined) {
    exactObject(parsed, ['schemaVersion', 'error'], 'review IPC error response');
  } else if (parsed.operation === 'list') {
    exactObject(parsed, ['schemaVersion', 'operation', 'entries', 'nextCursor'], 'review IPC list response');
  } else if (parsed.operation === 'load') {
    exactObject(parsed, ['schemaVersion', 'operation', 'entry'], 'review IPC load response');
  } else {
    fail('invalid-review-response', 'review IPC response operation is unsupported');
  }
  if (parsed.schemaVersion !== PROPOSAL_REVIEW_IPC_SCHEMA_VERSION) {
    fail('invalid-review-response', 'review IPC response schema is unsupported');
  }
  if (parsed.error !== undefined) {
    exactObject(parsed.error, ['code'], 'review IPC error');
    const code = boundedString(parsed.error.code, 'review IPC error code', 128);
    if (!/^[a-z][a-z0-9-]{0,63}$/u.test(code)) {
      fail('invalid-review-response', 'review IPC error code is invalid');
    }
    throw new OwnerAlphaError(`review-ipc-${code}`, 'proposal review source rejected the request');
  }
  return parsed;
}

async function assertPrivateSocket(socketPath) {
  if (typeof socketPath !== 'string'
    || !path.isAbsolute(socketPath)
    || path.normalize(socketPath) !== socketPath
    || socketPath === path.parse(socketPath).root) {
    fail('invalid-review-socket', 'proposal review socket must be one normalized absolute path');
  }
  const parent = path.dirname(socketPath);
  let parentMetadata;
  let socketMetadata;
  try {
    [parentMetadata, socketMetadata] = await Promise.all([
      lstat(parent),
      lstat(socketPath),
    ]);
  } catch (error) {
    fail('review-source-unavailable', 'proposal review socket is unavailable', {
      cause: error?.code ?? 'unknown',
    });
  }
  if (parentMetadata.isSymbolicLink()
    || !parentMetadata.isDirectory()
    || await realpath(parent) !== parent
    || (parentMetadata.mode & 0o777) !== 0o700
    || typeof process.getuid !== 'function'
    || parentMetadata.uid !== process.getuid()
    || (typeof process.getgid === 'function' && parentMetadata.gid !== process.getgid())) {
    fail('unsafe-review-socket', 'proposal review socket parent must be a private runtime-owned real directory');
  }
  if (socketMetadata.isSymbolicLink()
    || !socketMetadata.isSocket()
    || (socketMetadata.mode & 0o777) !== 0o600
    || socketMetadata.uid !== process.getuid()
    || (typeof process.getgid === 'function' && socketMetadata.gid !== process.getgid())) {
    fail('unsafe-review-socket', 'proposal review socket must be a private runtime-owned Unix socket');
  }
}

async function exchange(socketPath, request, { timeoutMs, maxResponseBytes }) {
  await assertPrivateSocket(socketPath);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    const chunks = [];
    let length = 0;
    let settled = false;
    const settle = (action, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action(value);
    };
    const timer = setTimeout(() => {
      socket.destroy();
      settle(reject, new OwnerAlphaError('review-source-timeout', 'proposal review source did not respond before its deadline'));
    }, timeoutMs);
    socket.once('connect', () => socket.write(request));
    socket.on('data', (chunk) => {
      length += chunk.length;
      if (length > maxResponseBytes) {
        socket.destroy();
        settle(reject, new OwnerAlphaError('review-response-too-large', 'proposal review response exceeded its byte limit'));
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    socket.once('end', () => settle(resolve, Buffer.concat(chunks, length)));
    socket.once('error', (error) => settle(reject, new OwnerAlphaError(
      'review-source-unavailable',
      'proposal review source connection failed',
      { cause: error?.code ?? 'unknown' },
    )));
  });
}

function requestBytes(value) {
  const bytes = Buffer.from(`${canonicalJson(value)}\n`, 'utf8');
  if (bytes.length > PROPOSAL_REVIEW_IPC_REQUEST_MAX_BYTES) {
    fail('invalid-review-request', 'proposal review request exceeds its byte limit');
  }
  return bytes;
}

export function createProposalReviewClient({
  socketPath,
  requestTimeoutMs = 5000,
  maxResponseBytes = PROPOSAL_REVIEW_IPC_RESPONSE_MAX_BYTES,
  transport = exchange,
} = {}) {
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 5000) {
    fail('invalid-review-client', 'requestTimeoutMs must be a positive integer no greater than 5000');
  }
  if (!Number.isSafeInteger(maxResponseBytes)
    || maxResponseBytes < 1
    || maxResponseBytes > PROPOSAL_REVIEW_IPC_RESPONSE_MAX_BYTES) {
    fail('invalid-review-client', 'maxResponseBytes is invalid');
  }
  if (typeof transport !== 'function') fail('invalid-review-client', 'transport must be a function');

  async function request(value) {
    const response = await transport(socketPath, requestBytes(value), {
      timeoutMs: requestTimeoutMs,
      maxResponseBytes,
    });
    return parseResponse(response, maxResponseBytes);
  }

  return Object.freeze({
    async list(options = {}) {
      optionalObject(options, ['state', 'cursor', 'limit'], 'review list options');
      const state = options.state ?? 'pending-review';
      const cursor = options.cursor ?? null;
      const limit = options.limit ?? 100;
      if (state !== null && !['pending-review', 'expired'].includes(state)) {
        fail('invalid-review-request', 'review list state is unsupported');
      }
      if (cursor !== null) boundedString(cursor, 'review list cursor', 1024);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        fail('invalid-review-request', 'review list limit must be between 1 and 100');
      }
      const response = await request({
        schemaVersion: PROPOSAL_REVIEW_IPC_SCHEMA_VERSION,
        operation: 'list',
        state,
        cursor,
        limit,
      });
      if (response.operation !== 'list'
        || !Array.isArray(response.entries)
        || response.entries.length > limit
        || (response.nextCursor !== null && typeof response.nextCursor !== 'string')) {
        fail('invalid-review-response', 'review IPC list response is invalid');
      }
      const entries = response.entries.map(reviewSummary);
      for (let index = 1; index < entries.length; index += 1) {
        const previous = entries[index - 1];
        const current = entries[index];
        if (previous.receivedAt > current.receivedAt
          || (previous.receivedAt === current.receivedAt && previous.queueId >= current.queueId)) {
          fail('invalid-review-response', 'review summaries must use strict receivedAt and queueId order');
        }
      }
      const nextCursor = response.nextCursor === null
        ? null
        : boundedString(response.nextCursor, 'review list nextCursor', 1024);
      return deepFreeze({ entries, nextCursor });
    },
    async load(queueIdInput) {
      let queueId;
      try {
        queueId = validateQueueId(queueIdInput);
      } catch (error) {
        fail('invalid-review-request', 'review load queueId is invalid', {
          cause: error?.code ?? 'unknown',
        });
      }
      const response = await request({
        schemaVersion: PROPOSAL_REVIEW_IPC_SCHEMA_VERSION,
        operation: 'load',
        queueId,
      });
      if (response.operation !== 'load') {
        fail('invalid-review-response', 'review IPC load response is invalid');
      }
      try {
        const evidence = createReviewEvidence(response.entry);
        if (evidence.queueId !== queueId) {
          fail('review-load-mismatch', 'review IPC load response does not match the requested queue ID');
        }
        return evidence;
      } catch (error) {
        if (error instanceof OwnerAlphaError) throw error;
        fail('invalid-review-evidence', 'review IPC load response contains invalid evidence', {
          cause: error?.code ?? 'unknown',
        });
      }
    },
  });
}

import net from 'node:net';
import { chmod, lstat, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import {
  ProposalReviewError,
  createReviewEvidence,
  createReviewSummary,
} from '@cyberbaser/proposal-review';
import {
  ProposalQueueError,
  digestBytes,
  validateDigest,
  validateQueueId,
} from '@cyberbaser/proposal-queue';

export const REVIEW_IPC_SCHEMA_VERSION = 1;
export const REVIEW_IPC_REQUEST_MAX_BYTES = 4 * 1024;
export const REVIEW_IPC_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;

const CURSOR_MAX_BYTES = 1024;
const UTC_SECOND_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u;

export class IntakeReviewIpcError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'IntakeReviewIpcError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new IntakeReviewIpcError(code, message);
}

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactObject(value, keys, label) {
  if (!isRecord(value)) fail('invalid-request', `${label} must be an object`);
  const unknown = Object.keys(value).find((key) => !keys.includes(key));
  if (unknown !== undefined) fail('invalid-request', `${label} contains unknown field ${unknown}`);
  const missing = keys.find((key) => !Object.hasOwn(value, key));
  if (missing !== undefined) fail('invalid-request', `${label} is missing field ${missing}`);
  return value;
}

function canonicalJson(value, depth = 0) {
  if (depth > 32) fail('invalid-response', 'IPC value exceeds the nesting limit');
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item, depth + 1)).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key], depth + 1)}`
    )).join(',')}}`;
  }
  if (typeof value === 'string' || value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (Number.isSafeInteger(value)) return JSON.stringify(value);
  fail('invalid-response', 'IPC value contains a non-JSON or unsafe numeric value');
}

function canonicalBytes(value, maximum = REVIEW_IPC_RESPONSE_MAX_BYTES) {
  const bytes = Buffer.from(`${canonicalJson(value)}\n`, 'utf8');
  if (bytes.length > maximum) fail('response-too-large', 'IPC response exceeds its byte limit');
  return bytes;
}

function utcSecond(value, label) {
  if (typeof value !== 'string' || !UTC_SECOND_RE.test(value)) fail('invalid-cursor', `${label} is invalid`);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString().replace('.000Z', 'Z') !== value) {
    fail('invalid-cursor', `${label} is invalid`);
  }
  return value;
}

function normalizeRequest(value, maxListEntries) {
  if (!isRecord(value)) fail('invalid-request', 'request must be an object');
  if (value.operation === 'list') {
    exactObject(value, ['schemaVersion', 'operation', 'state', 'cursor', 'limit'], 'list request');
    if (value.schemaVersion !== REVIEW_IPC_SCHEMA_VERSION) fail('unsupported-schema', 'request schema is unsupported');
    if (value.state !== null && !['pending-review', 'expired'].includes(value.state)) fail('invalid-state', 'list state is unsupported');
    if (value.cursor !== null && (typeof value.cursor !== 'string' || value.cursor.length === 0 || Buffer.byteLength(value.cursor, 'utf8') > CURSOR_MAX_BYTES)) {
      fail('invalid-cursor', 'list cursor is invalid');
    }
    if (!Number.isSafeInteger(value.limit) || value.limit < 1 || value.limit > maxListEntries) fail('invalid-limit', 'list limit is invalid');
    return Object.freeze({
      schemaVersion: REVIEW_IPC_SCHEMA_VERSION,
      operation: 'list',
      state: value.state,
      cursor: value.cursor,
      limit: value.limit,
    });
  }
  if (value.operation === 'load') {
    exactObject(value, ['schemaVersion', 'operation', 'queueId'], 'load request');
    if (value.schemaVersion !== REVIEW_IPC_SCHEMA_VERSION) fail('unsupported-schema', 'request schema is unsupported');
    let queueId;
    try {
      queueId = validateQueueId(value.queueId);
    } catch {
      fail('invalid-queue-id', 'load queueId is invalid');
    }
    return Object.freeze({ schemaVersion: REVIEW_IPC_SCHEMA_VERSION, operation: 'load', queueId });
  }
  fail('unsupported-operation', 'request operation is unsupported');
}

export function parseReviewIpcRequest(input, maxListEntries = 100) {
  const bytes = Buffer.from(input);
  if (bytes.length < 2 || bytes.length > REVIEW_IPC_REQUEST_MAX_BYTES) fail('invalid-request-bytes', 'request is empty or oversized');
  if (bytes.at(-1) !== 0x0a || bytes.indexOf(0x0a) !== bytes.length - 1) fail('noncanonical-request', 'request must contain one final LF');
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) fail('invalid-request-bytes', 'request must not contain a UTF-8 BOM');
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    fail('invalid-request-bytes', 'request must use valid UTF-8');
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail('invalid-request-json', 'request must contain strict JSON');
  }
  const normalized = normalizeRequest(parsed, maxListEntries);
  if (!canonicalBytes(normalized, REVIEW_IPC_REQUEST_MAX_BYTES).equals(bytes)) fail('noncanonical-request', 'request must use canonical JSON');
  return normalized;
}

function cursorPayload(value) {
  exactObject(value, ['schemaVersion', 'state', 'snapshotDigest', 'receivedAt', 'queueId'], 'cursor');
  if (value.schemaVersion !== REVIEW_IPC_SCHEMA_VERSION) fail('invalid-cursor', 'cursor schema is unsupported');
  if (value.state !== null && !['pending-review', 'expired'].includes(value.state)) fail('invalid-cursor', 'cursor state is unsupported');
  let queueId;
  let snapshotDigest;
  try {
    queueId = validateQueueId(value.queueId);
    snapshotDigest = validateDigest(value.snapshotDigest, 'cursor snapshotDigest');
  } catch {
    fail('invalid-cursor', 'cursor binding is invalid');
  }
  return Object.freeze({
    schemaVersion: REVIEW_IPC_SCHEMA_VERSION,
    state: value.state,
    snapshotDigest,
    receivedAt: utcSecond(value.receivedAt, 'cursor receivedAt'),
    queueId,
  });
}

function snapshotDigest(entries) {
  const identity = entries.map((entry) => ({
    queueId: entry.queueId,
    receivedAt: entry.receipt.receivedAt,
  }));
  return digestBytes(Buffer.from(canonicalJson(identity), 'utf8'));
}

function encodeCursor(entry, state, digest) {
  const payload = cursorPayload({
    schemaVersion: REVIEW_IPC_SCHEMA_VERSION,
    state,
    snapshotDigest: digest,
    receivedAt: entry.receipt.receivedAt,
    queueId: entry.queueId,
  });
  return Buffer.from(canonicalJson(payload), 'utf8').toString('base64url');
}

function decodeCursor(value, state) {
  if (value === null) return null;
  let bytes;
  try {
    bytes = Buffer.from(value, 'base64url');
  } catch {
    fail('invalid-cursor', 'cursor encoding is invalid');
  }
  if (bytes.length === 0 || bytes.length > CURSOR_MAX_BYTES || bytes.toString('base64url') !== value) fail('invalid-cursor', 'cursor encoding is invalid');
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail('invalid-cursor', 'cursor payload is invalid');
  }
  const payload = cursorPayload(parsed);
  if (canonicalJson(payload) !== bytes.toString('utf8') || payload.state !== state) fail('invalid-cursor', 'cursor does not match the requested list');
  return payload;
}

function entryAfterCursor(entry, cursor) {
  if (cursor === null) return true;
  return entry.receipt.receivedAt > cursor.receivedAt
    || (entry.receipt.receivedAt === cursor.receivedAt && entry.queueId > cursor.queueId);
}

function loadProjection(entry) {
  return Object.freeze({
    queueId: entry.queueId,
    proposalText: entry.proposalText,
    receipt: entry.receipt,
    carrier: entry.carrier,
    classification: entry.classification,
    state: entry.state,
  });
}

function publicError(error) {
  if (error instanceof IntakeReviewIpcError) return error.code;
  if (error instanceof ProposalQueueError && error.code === 'queue-entry-not-found') return 'not-found';
  if (error instanceof ProposalQueueError || error instanceof ProposalReviewError) return 'integrity-error';
  return 'internal-error';
}

function errorBytes(code) {
  return canonicalBytes({ schemaVersion: REVIEW_IPC_SCHEMA_VERSION, error: { code } }, 4096);
}

export function createReviewIpcHandler({ review, maxListEntries = 100 } = {}) {
  if (!review || typeof review.list !== 'function' || typeof review.load !== 'function') fail('invalid-review-source', 'review IPC requires the dedicated read-only snapshot interface');
  if (!Number.isSafeInteger(maxListEntries) || maxListEntries < 1 || maxListEntries > 100) fail('invalid-limit', 'maxListEntries is invalid');

  return async function handle(input) {
    try {
      const request = parseReviewIpcRequest(input, maxListEntries);
      if (request.operation === 'load') {
        const entry = await review.load(request.queueId);
        createReviewEvidence(loadProjection(entry));
        return canonicalBytes({
          schemaVersion: REVIEW_IPC_SCHEMA_VERSION,
          operation: 'load',
          entry: loadProjection(entry),
        });
      }

      const cursor = decodeCursor(request.cursor, request.state);
      const listed = await review.list({ state: request.state });
      const ordered = [...listed].sort((a, b) => (
        a.receipt.receivedAt.localeCompare(b.receipt.receivedAt) || a.queueId.localeCompare(b.queueId)
      ));
      const digest = snapshotDigest(ordered);
      if (cursor !== null && cursor.snapshotDigest !== digest) {
        fail('invalid-cursor', 'cursor snapshot no longer matches the live queue');
      }
      const remaining = ordered.filter((entry) => entryAfterCursor(entry, cursor));
      const page = remaining.slice(0, request.limit);
      const entries = page.map((entry) => {
        const evidence = createReviewEvidence(loadProjection(entry));
        return createReviewSummary(evidence);
      });
      const nextCursor = remaining.length > page.length && page.length > 0
        ? encodeCursor(page.at(-1), request.state, digest)
        : null;
      return canonicalBytes({
        schemaVersion: REVIEW_IPC_SCHEMA_VERSION,
        operation: 'list',
        entries,
        nextCursor,
      });
    } catch (error) {
      return errorBytes(publicError(error));
    }
  };
}

async function exactPrivateSocketParent(socketPath) {
  const parent = path.dirname(socketPath);
  const metadata = await lstat(parent);
  if (metadata.isSymbolicLink() || !metadata.isDirectory() || await realpath(parent) !== parent) {
    fail('unsafe-socket-parent', 'review IPC socket parent must be one real directory');
  }
  if (typeof process.getuid !== 'function' || metadata.uid !== process.getuid()) fail('unsafe-socket-parent', 'review IPC socket parent must be owned by the runtime identity');
  if (typeof process.getgid === 'function' && metadata.gid !== process.getgid()) fail('unsafe-socket-parent', 'review IPC socket parent must use the runtime primary group');
  if ((metadata.mode & 0o777) !== 0o700) fail('unsafe-socket-parent', 'review IPC socket parent must have mode 0700');
}

async function socketIsActive(socketPath) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection({ path: socketPath });
    const timer = setTimeout(() => {
      client.destroy();
      reject(new IntakeReviewIpcError('socket-probe-timeout', 'review IPC socket probe timed out'));
    }, 250);
    client.once('connect', () => {
      clearTimeout(timer);
      client.destroy();
      resolve(true);
    });
    client.once('error', (error) => {
      clearTimeout(timer);
      if (['ECONNREFUSED', 'ENOENT'].includes(error?.code)) resolve(false);
      else reject(error);
    });
  });
}

async function prepareSocketPath(socketPath) {
  await exactPrivateSocketParent(socketPath);
  let before;
  try {
    before = await lstat(socketPath, { bigint: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (before.isSymbolicLink() || !before.isSocket() || before.uid !== BigInt(process.getuid())) {
    fail('unsafe-socket-path', 'review IPC socket path is occupied by an unsafe entry');
  }
  if (await socketIsActive(socketPath)) fail('socket-active', 'review IPC socket path already has an active listener');
  const after = await lstat(socketPath, { bigint: true });
  if (!after.isSocket() || after.uid !== before.uid || after.dev !== before.dev || after.ino !== before.ino) {
    fail('unsafe-socket-path', 'review IPC socket path changed during stale-socket validation');
  }
  await unlink(socketPath);
}

async function verifyBoundSocket(socketPath) {
  await chmod(socketPath, 0o600);
  const metadata = await lstat(socketPath, { bigint: true });
  if (!metadata.isSocket() || metadata.uid !== BigInt(process.getuid()) || (metadata.mode & 0o777n) !== 0o600n) {
    fail('unsafe-socket-path', 'review IPC listener did not create the required private socket');
  }
  return Object.freeze({ dev: metadata.dev, ino: metadata.ino, uid: metadata.uid });
}

async function unlinkOwnedSocket(socketPath, identity) {
  let metadata;
  try {
    metadata = await lstat(socketPath, { bigint: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (!metadata.isSocket() || metadata.dev !== identity.dev || metadata.ino !== identity.ino || metadata.uid !== identity.uid) {
    fail('unsafe-socket-path', 'review IPC socket identity changed before cleanup');
  }
  await unlink(socketPath);
}

export async function startReviewIpcServer({ config, review } = {}) {
  if (!config?.reviewIpc?.enabled) return null;
  const { socketPath, requestTimeoutMs, maxConcurrentRequests, maxListEntries } = config.reviewIpc;
  await prepareSocketPath(socketPath);
  const handle = createReviewIpcHandler({ review, maxListEntries });
  const sockets = new Set();
  const inFlight = new Set();
  let active = 0;
  let closed = false;
  let networkClosed = false;
  let unlinked = false;
  let closing = null;

  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    if (closed || active >= maxConcurrentRequests) {
      socket.end(errorBytes('busy'));
      return;
    }
    active += 1;
    sockets.add(socket);
    const chunks = [];
    let length = 0;
    let finished = false;
    let processing = false;
    let processingSettled = false;
    let socketClosed = false;
    let slotReleased = false;
    const timer = setTimeout(() => finish(errorBytes('timeout')), requestTimeoutMs);

    function releaseSlot() {
      if (slotReleased || !socketClosed || (processing && !processingSettled)) return;
      slotReleased = true;
      active -= 1;
    }

    function cleanup() {
      clearTimeout(timer);
      socketClosed = true;
      sockets.delete(socket);
      releaseSlot();
    }

    function finish(bytes) {
      if (finished) return;
      finished = true;
      socket.end(bytes);
    }

    function processRequest() {
      if (finished || processing) return;
      processing = true;
      const operation = handle(Buffer.concat(chunks));
      inFlight.add(operation);
      operation.then(finish, () => finish(errorBytes('internal-error'))).finally(() => {
        processingSettled = true;
        inFlight.delete(operation);
        releaseSlot();
      });
    }

    socket.on('data', (chunk) => {
      if (finished) return;
      length += chunk.length;
      if (length > REVIEW_IPC_REQUEST_MAX_BYTES) {
        finish(errorBytes('request-too-large'));
        return;
      }
      chunks.push(Buffer.from(chunk));
      if (chunk.includes(0x0a)) processRequest();
    });
    socket.on('end', processRequest);
    socket.on('error', cleanup);
    socket.on('close', cleanup);
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(socketPath, () => {
      server.off('error', onError);
      resolve();
    });
  });

  let identity;
  try {
    identity = await verifyBoundSocket(socketPath);
  } catch (error) {
    await new Promise((resolve) => server.close(resolve));
    await unlink(socketPath).catch(() => {});
    throw error;
  }

  async function close() {
    if (unlinked) return;
    if (closing !== null) return closing;
    closing = (async () => {
      closed = true;
      if (!networkClosed) {
        await new Promise((resolve) => {
          server.close(resolve);
          for (const socket of sockets) socket.destroy();
        });
        networkClosed = true;
      }
      await Promise.allSettled([...inFlight]);
      if (!unlinked) {
        await unlinkOwnedSocket(socketPath, identity);
        unlinked = true;
      }
    })();
    try {
      await closing;
    } finally {
      closing = null;
    }
  }

  return Object.freeze({ socketPath, close });
}

import { chmod, chown, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fail } from '../errors.js';

export const MAX_FRAME_BYTES = 1024;
export const READ_TIMEOUT_MS = 1_000;
export const PUSH_STATUSES = Object.freeze(['pushed', 'already-pushed']);
export const REJECTION_CODES = Object.freeze([
  'publisher-invalid-request', 'publisher-request-timeout', 'publisher-busy',
  'publisher-job-not-found', 'publisher-job-not-admitted', 'publication-evidence-missing',
  'publisher-receipt-mismatch', 'remote-destination-mismatch', 'remote-advanced',
  'git-push-failed', 'forge-access-unavailable', 'publisher-failed',
]);

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export function validSocketPath(value) {
  return typeof value === 'string' && path.isAbsolute(value) && path.normalize(value) === value
    && path.dirname(value) !== '/' && !value.endsWith('/') && !/[\\\p{Cc}]/u.test(value)
    && Buffer.byteLength(value, 'utf8') <= 107;
}

// One line with no buffered tail. This reader never retains an oversize chunk.
export function readFrame(socket, onFrame, onInvalid, { maxBytes = MAX_FRAME_BYTES } = {}) {
  const chunks = [];
  let size = 0;
  function data(chunk) {
    size += chunk.length;
    const newline = chunk.indexOf(0x0a);
    if (size > maxBytes || (newline < 0 && size === maxBytes)
      || (newline >= 0 && newline !== chunk.length - 1)) {
      stop();
      onInvalid();
      return;
    }
    chunks.push(chunk);
    if (newline < 0) return;
    stop();
    let text;
    try {
      text = UTF8.decode(Buffer.concat(chunks, size).subarray(0, -1));
    } catch {
      onInvalid();
      return;
    }
    onFrame(text);
  }
  function stop() {
    socket.off('data', data);
    socket.pause();
  }
  socket.on('data', data);
  return stop;
}

export function validSocketGroup(value) {
  return value === null || (Number.isSafeInteger(value) && value > 0);
}

// Owner-only by default; owner and the one socket group when a group is given.
export async function restrictSocket(address, uid, socketGroup) {
  if (socketGroup !== null) await chown(address, uid, socketGroup);
  await chmod(address, socketGroup === null ? 0o600 : 0o660);
  const metadata = await lstat(address, { bigint: true });
  if (!metadata.isSocket() || metadata.uid !== BigInt(uid)
    || (metadata.mode & 0o7777n) !== (socketGroup === null ? 0o600n : 0o660n)
    || (socketGroup !== null && metadata.gid !== BigInt(socketGroup))) {
    fail('publisher-unsafe-socket', 'publisher Unix socket permissions could not be secured');
  }
  return metadata;
}

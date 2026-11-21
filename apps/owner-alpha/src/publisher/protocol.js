import path from 'node:path';

export const MAX_FRAME_BYTES = 1024;
export const READ_TIMEOUT_MS = 1_000;
export const PUSH_STATUSES = Object.freeze(['pushed', 'already-pushed']);
export const REJECTION_CODES = Object.freeze([
  'publisher-invalid-request', 'publisher-request-timeout', 'publisher-busy',
  'publisher-job-not-found', 'publisher-job-not-admitted', 'publication-evidence-missing',
  'publisher-receipt-mismatch', 'remote-destination-mismatch', 'remote-advanced',
  'git-push-failed', 'publisher-failed',
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

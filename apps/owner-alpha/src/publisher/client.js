import net from 'node:net';
import { OwnerAlphaError, fail } from '../errors.js';
import { validateJobId } from '../job-state.js';
import { PUSH_STATUSES, REJECTION_CODES, readFrame, validSocketPath } from './protocol.js';

export async function requestPublication({ socketPath, jobId, timeoutMs = 30_000 } = {}) {
  if (!validSocketPath(socketPath)) fail('publisher-invalid-socket', 'publisher socket must be one local absolute path');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    fail('publisher-invalid-timeout', 'publisher timeout must be a positive integer');
  }
  const frame = `${JSON.stringify({ v: 1, jobId: validateJobId(jobId) })}\n`;
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    let settled = false;
    function settle(action, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stopReading();
      socket.destroy();
      action(value);
    }
    const unavailable = () => settle(reject, new OwnerAlphaError(
      'publisher-unavailable', 'publisher did not confirm the push; check its durable record before taking another action',
    ));
    const invalid = () => settle(reject, new OwnerAlphaError('publisher-invalid-response', 'publisher response was invalid'));
    const timer = setTimeout(unavailable, Math.min(timeoutMs, 2_147_483_647));
    const stopReading = readFrame(socket, (text) => {
      let response;
      try { response = JSON.parse(text); } catch { return invalid(); }
      if (!response || Array.isArray(response) || typeof response !== 'object' || Object.keys(response).length !== 2) return invalid();
      if (response.ok === true && PUSH_STATUSES.includes(response.status)) {
        return settle(resolve, response);
      }
      if (response.ok === false && REJECTION_CODES.includes(response.code)) {
        return settle(reject, new OwnerAlphaError(response.code, 'publisher refused or could not confirm the push'));
      }
      return invalid();
    }, invalid);
    socket.once('connect', () => socket.write(frame));
    socket.once('error', unavailable);
    socket.once('end', unavailable);
    socket.once('close', unavailable);
  });
}

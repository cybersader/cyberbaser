import { fromBase64Url } from './wire.js';

// The code the node's Devices page shows: cb1.<node ticket>.<enrolment id>.<secret>.
// The ticket names the node and its relay; the secret never leaves this device.
export function parsePairingCode(input) {
  if (typeof input !== 'string' || input.length > 2048) return null;
  const parts = input.trim().split('.');
  if (parts.length !== 4 || parts[0] !== 'cb1' || !/^[a-z0-9]{8,1800}$/u.test(parts[1])
    || !/^[0-9a-f]{32}$/u.test(parts[2])) return null;
  const secret = fromBase64Url(parts[3]);
  if (!secret || secret.length !== 32) return null;
  return { ticket: parts[1], enrollmentId: parts[2], secret };
}

// obsidian://cyberbaser-pair?code=… (a QR code can carry this link later).
// Obsidian hands the handler the query as an object.
export function codeFromLink(params) {
  const value = params?.code ?? params?.c;
  return typeof value === 'string' ? value : null;
}

export const PAIR_LINK_ACTION = 'cyberbaser-pair';
export function pairingLink(code) {
  return `obsidian://${PAIR_LINK_ACTION}?code=${encodeURIComponent(code)}`;
}

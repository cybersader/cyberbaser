import { sha256, toBase64, utf8 } from './wire.js';

// Quiet one-line status for the open note.
export const STATUS = Object.freeze({
  live: 'Live',
  older: 'Live, older version',
  pending: 'Public, not confirmed yet',
  notSelected: 'Not public',
  notPaired: 'Not paired',
  unreachable: "Can't reach your node",
  noAccess: 'Status needs full access',
  checking: 'Checking',
});

// Short forms for the phone's note header, where space is tight. The full
// label is the button's accessible name and appears in the Send window.
export const SHORT = Object.freeze({
  live: 'Live', older: 'Older live', pending: 'Not confirmed', notSelected: 'Not public', notPaired: 'Not paired',
  unreachable: 'Offline', noAccess: 'No status', checking: '…',
});

// Same folding as the node's workspace binding: one leading byte-order mark
// dropped, CRLF and CR become LF. Null when the node would refuse the text.
export function foldText(text) {
  let value = text.startsWith('\uFEFF') ? text.slice(1) : text;
  if (value.includes('\uFEFF') || !value.isWellFormed()) return null;
  value = value.replace(/\r\n?/gu, '\n');
  return value;
}

async function digest(text) {
  return `sha-256=:${toBase64(await sha256(utf8(text)))}:`;
}

export async function textDigests(text) {
  const folded = foldText(text);
  return { exact: await digest(text), folded: folded === null ? null : await digest(folded) };
}

// reply: the node's readNoteStatus result, or a refusal. Kinds:
//   { paired: false } | { unreachable: true } | { refused: true } | { reply }
export function statusFor(state, digests) {
  if (state.paired === false) return { key: 'notPaired', label: STATUS.notPaired };
  if (state.unreachable) return { key: 'unreachable', label: STATUS.unreachable };
  if (state.refused) return { key: 'noAccess', label: STATUS.noAccess };
  const reply = state.reply;
  if (!reply || reply.selected !== true) return { key: 'notSelected', label: STATUS.notSelected };
  if (!reply.live) return { key: 'pending', label: STATUS.pending };
  const current = reply.live.folded ? digests?.folded : digests?.exact;
  return current && current === reply.live.digest
    ? { key: 'live', label: STATUS.live, version: reply.live.version }
    : { key: 'older', label: STATUS.older, version: reply.live.version };
}

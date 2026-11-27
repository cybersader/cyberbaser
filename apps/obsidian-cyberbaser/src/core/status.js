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
  draft: 'Draft',
  waiting: 'Waiting for approval',
});

// Only this state earns a mark on the note: there is something to send or
// publish. Everything else stays out of the way until the owner asks.
export const MARK_KEYS = Object.freeze(['older']);
export function needsMark(status) {
  return MARK_KEYS.includes(status?.key);
}

// The on-demand sentence: the status plus when the node confirmed it live.
export function describeStatus(status) {
  if (!status?.label) return '';
  if (status.key === 'draft') return 'Draft, not on your site. Publish to your site turns Draft off in the change you approve.';
  const at = typeof status.at === 'string' ? new Date(status.at) : null;
  if (!at || Number.isNaN(at.getTime())) return status.label;
  const when = at.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  if (status.key === 'live') return `Live. Confirmed on your site ${when}.`;
  if (status.key === 'older') return `Live, older version. Your site has the version confirmed ${when}; this note has changes since.`;
  return status.label;
}

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
//   { paired: false } | { unreachable: true } | { refused: true } | { draft: true }
//   | { reply, waiting? }   waiting: a new page from this device awaits approval
export function statusFor(state, digests) {
  if (state.paired === false) return { key: 'notPaired', label: STATUS.notPaired };
  if (state.draft) return { key: 'draft', label: STATUS.draft };
  if (state.unreachable) return { key: 'unreachable', label: STATUS.unreachable };
  if (state.refused) return { key: 'noAccess', label: STATUS.noAccess };
  const reply = state.reply;
  const current = reply?.live ? (reply.live.folded ? digests?.folded : digests?.exact) : null;
  // A new page stops waiting once the site's repository has this text (published), even before it is confirmed live.
  const published = typeof reply?.committed?.digest === 'string'
    && reply.committed.digest === (reply.committed.folded ? digests?.folded : digests?.exact);
  if (state.waiting && !published && !(current && current === reply.live.digest)) return { key: 'waiting', label: STATUS.waiting };
  if (!reply || reply.selected !== true) return { key: 'notSelected', label: STATUS.notSelected };
  if (!reply.live) return { key: 'pending', label: STATUS.pending };
  const extra = { version: reply.live.version, ...(typeof reply.live.at === 'string' ? { at: reply.live.at } : {}) };
  return current && current === reply.live.digest
    ? { key: 'live', label: STATUS.live, ...extra }
    : { key: 'older', label: STATUS.older, ...extra };
}

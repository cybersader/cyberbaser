import { capturePayload, NodeError } from './client.js';
import { statusFor, textDigests } from './status.js';

// Everything the plugin does, without Obsidian: pair, unpair, status, send.
// The Obsidian glue (main.js) only shows what this returns.

const MESSAGES = Object.freeze({
  'capture-base-unavailable': 'Your vault has no committed copy of this note yet.',
  'capture-path-refused': 'This note is outside what your vault publishes.',
  'capture-too-large': 'This note is too large for your vault settings.',
  'delivery-not-round-trippable': "This note's text can't be matched to the vault exactly.",
  'publication-candidate-mismatch': "This note's text can't be matched to the vault exactly.",
  'workspace-diff-too-complex': 'The change is too spread out to send as one edit. Send smaller changes.',
  'proposal-budget-exhausted': 'Too many sends in the last minute. Try again shortly.',
  'publication-expected-source-mismatch': "Your node hasn't received this version yet. Wait for sync, then try again.",
  'workspace-unbound': "Your node hasn't linked this note to the vault yet.",
  'delivery-moved-since-baseline': 'The vault copy changed since your node last checked it.',
  'workspace-diverged': 'The vault copy changed since your node last checked it.',
  'publication-read-only': 'Your node cannot publish right now.',
  'publication-disabled': 'Publishing is turned off on your node.',
  'retired-material': 'This text contains material your vault has retired.',
  'workspace-text-repeated': 'This note repeats the vault text; check for a sync conflict.',
  'workspace-properties-invalid': "This note's properties block is broken.",
  'note-needs-linking': "Your node hasn't linked this note to your vault yet. On your node, open Devices and link it under Notes to link, then send again.",
});

export function messageFor(error) {
  if (!(error instanceof NodeError)) return 'Something went wrong. Nothing was sent.';
  switch (error.kind) {
    case 'unreachable': return "Can't reach your node.";
    case 'invalid-code': return "That isn't a pairing code from your node.";
    case 'words-mismatch': return 'The words did not match. Nothing was paired.';
    case 'too-large': return 'This note is too large to send from here.';
    default: return MESSAGES[error.reason] ?? 'Your node refused this. This device may not be allowed to do it.';
  }
}

// data.json syncs with the vault: only these display settings ever go there.
// showMark: a quiet mark when the open note has changes your site lacks.
// (Older versions stored the same choice as showStatus.)
export const DEFAULT_SETTINGS = Object.freeze({ showMark: true });
export function publicSettings(settings) {
  const value = settings?.showMark ?? settings?.showStatus;
  return { showMark: value !== false };
}

export function createController({ client, store }) {
  let pairing;
  const loaded = async () => {
    if (pairing === undefined) pairing = await store.load();
    return pairing;
  };

  return Object.freeze({
    async paired() {
      const current = await loaded();
      return current === null ? null : { keyId: current.keyId, grants: [...current.grants], pairedAt: current.pairedAt };
    },

    async pair(code, options) {
      const record = await client.pair(code, options);
      await store.save(record);
      pairing = record;
      return { keyId: record.keyId, grants: [...record.grants] };
    },

    async unpair() {
      await store.clear();
      pairing = null;
    },

    // The status line for this note. Never throws.
    async status(file, text) {
      const current = await loaded().catch(() => null);
      if (current === null) return { status: statusFor({ paired: false }), reply: null };
      const digests = await textDigests(text);
      // Full access sees drafts and publishing; a device that may only
      // propose still sees what the public site shows: public, and live.
      if (!current.grants.includes('publication') && !current.grants.includes('propose')) {
        return { status: statusFor({ refused: true }), reply: null };
      }
      try {
        const reply = await client.request(current, 'readNoteStatus', { path: file.path });
        return { status: statusFor({ reply }, digests), reply };
      } catch (error) {
        const state = error instanceof NodeError && error.kind === 'refused' ? { refused: true } : { unreachable: true };
        return { status: statusFor(state), reply: null };
      }
    },

    // Publish only with the grant, on the node's configured page, when the
    // node can publish. Everything else is a proposal for review.
    canPublish(reply) {
      return Boolean(pairing?.grants.includes('publish') && reply?.selected === true && reply.publishAvailable === true);
    },

    async propose(file, text) {
      const current = await loaded();
      if (current === null) throw new NodeError('refused');
      const receipt = await client.request(current, 'submitCapture', capturePayload(file, text));
      if (receipt?.unchanged === true) return { kind: 'unchanged', text: 'Nothing changed compared with your vault.' };
      return { kind: 'proposed', queueId: receipt.queueId,
        text: 'Sent for review. It is waiting in your Proposals inbox.' };
    },

    async publish(file, text, reply) {
      const current = await loaded();
      if (current === null || !this.canPublish(reply)) throw new NodeError('refused');
      const digests = await textDigests(text);
      const expectedDigest = reply.workspace ? digests.folded : digests.exact;
      if (expectedDigest === null) throw new NodeError('refused', 'delivery-not-round-trippable');
      const prepared = await client.request(current, 'preparePublication', { mappingId: reply.mappingId, expectedDigest });
      if (prepared?.outcome === 'unchanged') return { kind: 'unchanged', text: 'Your site already has this text.' };
      const started = await client.request(current, 'publish', { draftId: prepared.draftId });
      return { kind: 'publishing', version: started.capturedVersion, jobId: started.jobId,
        text: 'Publishing. The status changes to Live once your site shows it.' };
    },
  });
}

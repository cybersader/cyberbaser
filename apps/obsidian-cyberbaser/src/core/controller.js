import { capturePayload, NodeError } from './client.js';
import {
  approvalFor, ApprovalProblem, confirmMatches, createSigningKey, enrolIntent, enrollConfirm, intentDigest, keyFingerprint,
  parseEnrolCode, prepareApproval,
} from './signing.js';
import { statusFor, textDigests } from './status.js';
import { createTapGate, TapRequired } from './tap.js';
import { hex } from './wire.js';

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
  'recovery-in-progress': 'Your node is finishing an earlier publish. Try again in a moment.',
  'recovery-failed': 'Your node could not finish an earlier publish. Restart Cyberbaser on your node.',
  'signing-unavailable': "Your node can't reach the publisher's approvals yet. Nothing was signed.",
  'enroll-refused': 'The publisher did not accept this device. The code may be used or expired; ask for a new one.',
  'enroll-not-confirmed': 'The answer did not come from your publisher. This device was not set up to approve.',
  'enroll-publisher-mismatch': 'The answer did not come from your publisher. This device was not set up to approve.',
  'not-paired': 'Pair this device with your node first.',
  'not-enrolled': 'This device is not set up to approve publishing yet.',
  'approval-not-found': 'That approval is no longer waiting.',
  'approval-expired': 'That approval expired. Start the publish again.',
  'approval-invalid': "This request doesn't add up, so it was not signed.",
  'approval-bytes-mismatch': "The change sent with this request doesn't match what it asks you to sign. Nothing was signed.",
  'approval-wrong-publisher': 'This request is for a different publisher than the one this device approves for. Nothing was signed.',
  'approval-mismatch': "This request doesn't add up, so it was not signed.",
  'approval-too-large': 'This change is too large to approve from here. Approve it on a computer.',
  'tap-required': 'Tap the button yourself to approve. Nothing was signed.',
});

export function messageFor(error) {
  if (error instanceof ApprovalProblem || error instanceof TapRequired) return MESSAGES[error.reason];
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

export function createController({ client, store, signingStore = null, tapGate = createTapGate(), now = Date.now,
  random = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n)) }) {
  let pairing;
  let signing;
  const loaded = async () => {
    if (pairing === undefined) pairing = await store.load();
    return pairing;
  };
  const signingLoaded = async () => {
    if (signing === undefined) signing = signingStore === null ? null : await signingStore.load();
    return signing;
  };
  const requirePairing = async () => {
    const current = await loaded();
    if (current === null) throw new NodeError('refused', 'not-paired');
    return current;
  };
  const requireSigning = async () => {
    const current = await signingLoaded();
    if (current === null) throw new NodeError('refused', 'not-enrolled');
    return current;
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

    // ---- Signing device ----

    async signingDevice() {
      const current = await signingLoaded().catch(() => null);
      return current === null ? null : { keyId: current.keyId, label: current.label, fingerprint: current.fingerprint,
        enrolledAt: current.enrolledAt };
    },

    /**
     * Become a signing device with the publisher's one-time code. Creates a
     * new non-extractable key, signs one enroll intent (only on a real tap),
     * and keeps the key only once the publisher proves it holds the same code.
     */
    async enrol(codeInput, { label, tap } = {}) {
      const parsed = parseEnrolCode(codeInput);
      if (!parsed) throw new NodeError('invalid-code');
      try {
        if (signingStore === null) throw new NodeError('refused', 'not-enrolled');
        const current = await requirePairing();
        tapGate.consume(tap);
        const clean = typeof label === 'string' ? [...label.trim()].filter((c) => c >= ' ' && c !== '\u007f' && c !== '<' && c !== '>').join('').slice(0, 64) : '';
        const created = await createSigningKey();
        const key = { keyId: `device-${hex(random(6))}`, type: 'ed25519', publicKey: created.publicKey, label: clean || 'Phone' };
        const challenge = await client.request(current, 'readSigningChallenge', { publisher: parsed.publisher });
        if (challenge?.publisher !== parsed.publisher || typeof challenge.nonce !== 'string') {
          throw new NodeError('refused', 'enroll-publisher-mismatch');
        }
        if (!Number.isSafeInteger(challenge.expiresAt) || challenge.expiresAt <= now()) throw new NodeError('refused', 'approval-expired');
        // The publisher's own times, so a phone clock that is off does not matter.
        const issuedAt = Number.isSafeInteger(challenge.issuedAt) ? challenge.issuedAt : now();
        const intent = await enrolIntent({ publisher: parsed.publisher, secret: parsed.secret, key, nonce: challenge.nonce,
          now: issuedAt, expiresAt: challenge.expiresAt });
        const digest = await intentDigest(intent);
        const approval = await approvalFor(created.privateKey, digest);
        const answer = await client.request(current, 'enrollSigningKey', { intent, approval });
        // Only the real publisher holds the code, so only it can answer this.
        const expected = await enrollConfirm(parsed.secret, parsed.publisher, hex(digest));
        if (!confirmMatches(expected, answer?.confirm)) throw new NodeError('refused', 'enroll-not-confirmed');
        const record = { version: 1, keyId: key.keyId, label: key.label, publicKey: key.publicKey, privateKey: created.privateKey,
          publisher: parsed.publisher, fingerprint: await keyFingerprint(key), enrolledAt: now() };
        await signingStore.save(record);
        signing = record;
        return { keyId: record.keyId, label: record.label, fingerprint: record.fingerprint };
      } finally {
        parsed.secret.fill(0);
      }
    },

    async forgetSigning() {
      await signingStore?.clear();
      signing = null;
    },

    /** Requests waiting for this device: [{ requestId, expiresAt }]. */
    async waitingApprovals() {
      const current = await requirePairing();
      await requireSigning();
      const reply = await client.request(current, 'listApprovals', { waiting: true });
      return Array.isArray(reply?.waiting) ? reply.waiting.filter((entry) => typeof entry?.requestId === 'string')
        .map((entry) => ({ requestId: entry.requestId, expiresAt: entry.expiresAt })) : [];
    },

    /** Fetch one request and check it; returns what the dialog shows. */
    async readApproval(requestId) {
      const current = await requirePairing();
      const key = await requireSigning();
      const request = await client.request(current, 'readApproval', { requestId });
      return prepareApproval({ request, signing: key, now: now() });
    },

    /** Sign exactly the checked intent, only on a real tap, and send it back. */
    async approve(prepared, tap) {
      const current = await requirePairing();
      const key = await requireSigning();
      tapGate.consume(tap);
      if (prepared?.template?.keyId !== key.keyId || prepared.template.publisher !== key.publisher) throw new ApprovalProblem('approval-invalid');
      if (prepared.template.expiresAt <= now()) throw new ApprovalProblem('approval-expired');
      const approval = await approvalFor(key.privateKey, await intentDigest(prepared.template));
      await client.request(current, 'submitApproval', { requestId: prepared.requestId, intent: prepared.template, approval });
      return { approved: true };
    },

    async decline(requestId) {
      const current = await requirePairing();
      await client.request(current, 'declineApproval', { requestId });
      return { declined: true };
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

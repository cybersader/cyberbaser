// Relay between the publisher, which checks every publish signature, and the
// owner's signing device (the Obsidian plugin), which makes it.
//
// The node only carries messages. It holds no signing key and its word is not
// trusted by either end: the device renders what it signs from the intent and
// from file bytes it hashes itself, and the publisher checks the signature and
// the pushed commit on its own. So this module checks shape and consistency,
// never authority, and keeps nothing on disk: a node restart drops waiting
// requests and the owner simply taps again (the publisher's nonces are in
// memory too).
//
//   publisher: { challenge() -> { publisher, nonce, issuedAt, expiresAt },
//                enroll({ intent, approval }) -> { confirm, ... } }
//   (the publisher's owner-control verbs, relayed; see publisherSigningFromSocket)
//   refresh:   async () => void, run before every list: lets the publish path
//              offer jobs that wait for approval (see job-approvals.js).
import { createHash, randomBytes } from 'node:crypto';
import { canonicalJson, validateIntent } from '../../../../packages/signed-intent/src/intent.js';
import { fail } from '../errors.js';
import { isPlainObject } from '../json.js';

// What the device reads for one approval. The plugin's carrier accepts at
// most 512 KiB per reply; base64 grows bytes by a third.
export const APPROVAL_MAX_FILE_BYTES = 360 * 1024;
export const APPROVAL_MAX_PENDING = 16;
// The node fills keyId with this placeholder; the signing device puts its own
// key ID there and nothing else may differ.
export const APPROVAL_KEY_PLACEHOLDER = 'signing-device';
const REQUEST_ID = /^[A-Za-z0-9_-]{22}$/u;
const ASKED_BY = /^[^\u0000-\u001f\u007f<>]{1,64}$/u;
const B64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
// A file side the device reads in chunks rather than inline.
export const CHUNKED = 'chunked';
export const APPROVAL_CHUNK_BYTES = 256 * 1024;

const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');

function exactKeys(value, keys) {
  return isPlainObject(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function bytesOf(value, label) {
  if (value === null) return null;
  if (typeof value !== 'string' || !B64.test(value)) fail('approval-invalid', `${label} must be base64 or null`);
  return Buffer.from(value, 'base64');
}

// The files must be exactly the intent's changes, and each side must hash to
// what the intent says. The device re-checks all of this; the node checks so
// it never offers a request the device would refuse.
function checkedFiles(intent, files, blobs = null) {
  if (!Array.isArray(files) || files.length !== intent.changes.length) fail('approval-invalid', 'files must match the changes');
  let total = 0;
  return files.map((file, index) => {
    const change = intent.changes[index];
    if (!exactKeys(file, ['path', 'before', 'after']) || file.path !== change.path) fail('approval-invalid', 'files must follow the changes');
    // A new image too large to read in one reply: the device fetches it in
    // chunks (readChunk) and hashes the whole file itself.
    if (file.after === CHUNKED) {
      const bytes = blobs?.get(file.path) ?? null;
      if (file.before !== null || change.before !== null || change.after === null || bytes === null
        || sha256Hex(bytes) !== change.after.sha256) fail('approval-invalid', 'a chunked file must be a new file with matching bytes');
      return { path: file.path, before: null, after: CHUNKED, byteLength: bytes.length };
    }
    const before = bytesOf(file.before, 'before');
    const after = bytesOf(file.after, 'after');
    for (const [side, bytes] of [['before', before], ['after', after]]) {
      if ((change[side] === null) !== (bytes === null) || (bytes !== null && sha256Hex(bytes) !== change[side].sha256)) {
        fail('approval-invalid', `${side} bytes do not match the intent`);
      }
      total += bytes?.length ?? 0;
    }
    if (total > APPROVAL_MAX_FILE_BYTES) fail('approval-too-large', 'this change is too large to approve from a phone');
    return { path: file.path, before: file.before, after: file.after };
  });
}

function checkedAdditions(intent, value) {
  if (value === null) return null;
  const added = new Set(intent.changes.filter((change) => change.before === null).map((change) => change.path));
  if (!Array.isArray(value) || value.length > 4 || value.some((entry) => !exactKeys(entry, ['path', 'address'])
    || !added.has(entry.path) || typeof entry.address !== 'string' || !/^\/[^\u0000-\u001f\u007f<>]{0,1023}$/u.test(entry.address))) {
    fail('approval-invalid', 'public additions must name new files and their addresses');
  }
  return value.map((entry) => ({ path: entry.path, address: entry.address }));
}

export function createApprovalRelay({ publisher = null, clock = Date.now, random = randomBytes, maxPending = APPROVAL_MAX_PENDING,
  refresh = null } = {}) {
  const pending = new Map(); // requestId -> { template, files, askedBy, expiresAt, settle }

  function expire() {
    const now = clock();
    for (const [requestId, entry] of pending) {
      if (entry.expiresAt <= now) {
        pending.delete(requestId);
        entry.settle.reject(Object.assign(new Error('the approval expired'), { code: 'approval-expired' }));
      }
    }
  }

  function take(requestId) {
    expire();
    if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId) || !pending.has(requestId)) {
      fail('approval-not-found', 'no approval is waiting under that id');
    }
    return pending.get(requestId);
  }

  function requirePublisher(verb) {
    if (typeof publisher?.[verb] !== 'function') fail('signing-unavailable', 'the publisher does not accept signed approvals yet');
    return publisher;
  }

  return Object.freeze({
    /**
     * Ask the owner's signing device to approve one publish intent. `intent`
     * carries APPROVAL_KEY_PLACEHOLDER as keyId; `files` hold the exact before
     * and after bytes (base64, or null for an added or deleted file) in the
     * order of intent.changes. `result` resolves with { intent, approval }
     * once a device signs, and rejects with code approval-declined or
     * approval-expired.
     */
    request({ intent, files, askedBy, publicAdditions = null, blobs = null }) {
      expire();
      const template = validateIntent(intent);
      if (template.kind !== 'publish' || template.keyId !== APPROVAL_KEY_PLACEHOLDER) {
        fail('approval-invalid', 'only a publish intent with the placeholder key id can be relayed');
      }
      if (typeof askedBy !== 'string' || !ASKED_BY.test(askedBy)) fail('approval-invalid', 'askedBy must be a short plain label');
      if (template.expiresAt <= clock()) fail('approval-expired', 'the intent has already expired');
      if (pending.size >= maxPending) fail('approval-capacity', 'too many approvals are waiting');
      const checked = checkedFiles(template, files, blobs);
      const additions = checkedAdditions(template, publicAdditions);
      const requestId = Buffer.from(random(16)).toString('base64url');
      let settle;
      const result = new Promise((resolve, reject) => { settle = { resolve, reject }; });
      result.catch(() => {});
      pending.set(requestId, { template, files: checked, askedBy, expiresAt: template.expiresAt, settle, additions,
        blobs: blobs === null ? null : new Map(checked.filter((file) => file.after === CHUNKED).map((file) => [file.path, blobs.get(file.path)])) });
      return Object.freeze({ requestId, result });
    },

    /** What is waiting: ids and who asked. No bytes. */
    async list() {
      if (typeof refresh === 'function') await refresh();
      expire();
      return [...pending].map(([requestId, entry]) => ({ requestId, askedBy: entry.askedBy, expiresAt: entry.expiresAt }));
    },

    /** One request in full: the intent and the bytes the device hashes and shows. */
    read({ requestId }) {
      const entry = take(requestId);
      return { requestId, askedBy: entry.askedBy, intent: entry.template, files: entry.files,
        ...(entry.additions === null ? {} : { publicAdditions: entry.additions }) };
    },

    /** One chunk of a file the device reads in pieces: { data (base64), total }. */
    readChunk({ requestId, path, offset }) {
      const entry = take(requestId);
      const bytes = entry.blobs?.get(path) ?? null;
      if (bytes === null || !Number.isSafeInteger(offset) || offset < 0 || offset >= bytes.length) fail('approval-not-found', 'no such file part');
      return { data: bytes.subarray(offset, offset + APPROVAL_CHUNK_BYTES).toString('base64'), total: bytes.length };
    },

    /**
     * The device's signed answer. The intent must equal the request except for
     * keyId, which becomes the device's own. The publisher verifies the
     * signature; the node only checks the shape and passes it on.
     */
    submit({ requestId, intent, approval }) {
      const entry = take(requestId);
      let signed;
      try { signed = validateIntent(intent); } catch { fail('approval-invalid', 'the signed intent is not valid'); }
      if (signed.keyId === APPROVAL_KEY_PLACEHOLDER
        || canonicalJson({ ...signed, keyId: APPROVAL_KEY_PLACEHOLDER }) !== canonicalJson(entry.template)) {
        fail('approval-mismatch', 'the signed intent differs from the one requested');
      }
      if (!exactKeys(approval, ['type', 'signature']) || approval.type !== 'ed25519'
        || typeof approval.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/u.test(approval.signature)) {
        fail('approval-invalid', 'the approval must be one Ed25519 signature');
      }
      pending.delete(requestId);
      entry.settle.resolve(Object.freeze({ intent: signed, approval: { type: approval.type, signature: approval.signature } }));
      return { requestId, accepted: true };
    },

    decline({ requestId }) {
      const entry = take(requestId);
      pending.delete(requestId);
      entry.settle.reject(Object.assign(new Error('the owner declined'), { code: 'approval-declined' }));
      return { requestId, declined: true };
    },

    // Enrolment of a signing device, relayed to the publisher verbatim.
    async challenge() {
      const answer = await requirePublisher('challenge').challenge();
      if (!exactKeys(answer, ['publisher', 'nonce', 'issuedAt', 'expiresAt']) || !/^[0-9a-f]{64}$/u.test(answer.publisher)
        || !/^[A-Za-z0-9_-]{43}$/u.test(answer.nonce) || !Number.isSafeInteger(answer.issuedAt)
        || !Number.isSafeInteger(answer.expiresAt) || answer.expiresAt <= answer.issuedAt) {
        fail('signing-unavailable', 'the publisher gave no usable challenge');
      }
      return { publisher: answer.publisher, nonce: answer.nonce, issuedAt: answer.issuedAt, expiresAt: answer.expiresAt };
    },

    async enroll({ intent, approval }) {
      let checked;
      try { checked = validateIntent(intent); } catch { fail('enroll-refused', 'the enrolment intent is not valid'); }
      if (checked.kind !== 'enroll' || !exactKeys(approval, ['type', 'signature']) || approval.type !== 'ed25519'
        || typeof approval.signature !== 'string') {
        fail('enroll-refused', 'only an Ed25519 enrolment can be relayed');
      }
      const relay = requirePublisher('enroll');
      let answer;
      try {
        answer = await relay.enroll({ intent: checked, approval: { type: approval.type, signature: approval.signature } });
      } catch {
        fail('enroll-refused', 'the publisher refused the enrolment');
      }
      if (!isPlainObject(answer) || typeof answer.confirm !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(answer.confirm)) {
        fail('enroll-refused', 'the publisher gave no confirmation');
      }
      return { confirm: answer.confirm };
    },
  });
}

/**
 * The publisher's own owner-control socket (publisher/owner-control.js) as
 * the relay's publisher. Only challenge and enroll are relayed to devices.
 */
export function publisherSigningFromSocket({ socketPath, ownerRequest }) {
  return Object.freeze({
    challenge: () => ownerRequest({ socketPath, op: 'challenge' }),
    enroll: (record) => ownerRequest({ socketPath, op: 'enroll', record }),
  });
}

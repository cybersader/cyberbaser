// The publisher core's two checks, shared by every provider:
//   admitApproval: a key on the publisher's own list signed this exact intent,
//                  for this publisher, inside its lifetime, with a live one-use nonce.
//   checkCommit:   the commit the publisher imported is exactly what a publish
//                  intent says, read from Git objects alone.
// Pure: the clock, randomness, the key list and Git are all passed in.
import { intentDigest, sha256Hex } from './crypto.js';
import { IntentError, LIMITS, validateIntent } from './intent.js';
import { PROVIDERS } from './providers.js';

const refuse = (code, extra = {}) => Object.freeze({ ok: false, code, ...extra });

/** Pending nonces live in memory only: a publisher restart voids unfinished approvals. */
export function createNonceBook({ random, ttlMs = LIMITS.maxLifetimeMs, max = 64 }) {
  if (typeof random !== 'function') throw new TypeError('nonce book needs a random source');
  const pending = new Map();
  return Object.freeze({
    issue(now) {
      for (const [nonce, expiresAt] of pending) if (expiresAt <= now) pending.delete(nonce);
      if (pending.size >= max) return null;
      const nonce = Buffer.from(random(32)).toString('base64url');
      pending.set(nonce, now + ttlMs);
      return { nonce, issuedAt: now, expiresAt: now + ttlMs };
    },
    live(nonce, now) {
      const expiresAt = pending.get(nonce);
      return expiresAt !== undefined && expiresAt > now;
    },
    consume(nonce, now) {
      const expiresAt = pending.get(nonce);
      pending.delete(nonce);
      return expiresAt !== undefined && expiresAt > now;
    },
    get size() { return pending.size; },
  });
}

/**
 * roster: Map keyId -> { type, publicKey | publicKeySpki+rpId+origins+counter, may: [...], revoked }
 * signerKey (optional): the key to check against when the signer is not on the
 * roster yet (enroll: the new key signs its own enrollment).
 * Codes: intent-invalid, wrong-publisher, not-yet-valid, expired, unknown-key,
 * revoked-key, key-not-allowed, wrong-provider, provider codes, nonce-unknown-or-used.
 */
export function admitApproval({ intent, approval, roster, publisherId, nonces, now, signerKey = null }) {
  let valid;
  try { valid = validateIntent(intent); }
  catch (error) { if (error instanceof IntentError) return refuse('intent-invalid'); throw error; }
  if (valid.publisher !== publisherId) return refuse('wrong-publisher');
  if (now < valid.issuedAt - LIMITS.maxClockSkewMs) return refuse('not-yet-valid');
  if (now >= valid.expiresAt) return refuse('expired');
  const key = signerKey ?? roster.get(valid.keyId) ?? null;
  if (key === null) return refuse('unknown-key');
  if (key.revoked) return refuse('revoked-key');
  if (!Array.isArray(key.may) || !key.may.includes(valid.kind)) return refuse('key-not-allowed');
  const provider = PROVIDERS.get(key.type);
  if (!provider || approval?.type !== key.type) return refuse('wrong-provider');
  const digest = intentDigest(valid);
  const result = provider.verify({ digest, approval, key });
  if (!result.ok) return result;
  // Consumed only after a valid signature, so garbage cannot burn real nonces.
  if (!nonces.consume(valid.nonce, now)) return refuse('nonce-unknown-or-used');
  return Object.freeze({ ok: true, intent: valid, digest: digest.toString('hex'), keyId: valid.keyId, provider: key.type,
    ...(result.counter === undefined ? {} : { counter: result.counter }) });
}

const person = (p) => `${p.name} <${p.email}> ${p.time} ${p.tz}`;
const RAW = /^:(\d{6}) (\d{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ([ADMT])$/u;

/**
 * git(args) -> Promise<Buffer>, run against the publisher's own validated
 * object store only (never a node-written index, ref or record).
 * Codes: commit-unreadable, commit-header-mismatch, commit-message-mismatch,
 * unsigned-path-changed, change-mismatch, mode-mismatch, content-mismatch,
 * signed-change-missing.
 */
export async function checkCommit(git, intent, commit) {
  const want = validateIntent(intent);
  if (want.kind !== 'publish' || typeof commit !== 'string' || !/^[0-9a-f]{40}$/u.test(commit)) return refuse('commit-unreadable');
  let raw;
  try { raw = Buffer.from(await git(['cat-file', 'commit', commit])); } catch { return refuse('commit-unreadable'); }
  const boundary = raw.indexOf('\n\n');
  if (boundary < 0) return refuse('commit-unreadable');
  const [tree, ...rest] = raw.subarray(0, boundary).toString('utf8').split('\n');
  // Exactly: tree, one parent = the signed base, the signed author and committer.
  // No gpgsig, encoding, mergetag or any other header the owner did not see.
  const expected = [`parent ${want.base}`, `author ${person(want.commit.author)}`, `committer ${person(want.commit.committer)}`];
  if (!/^tree [0-9a-f]{40}$/u.test(tree) || rest.join('\n') !== expected.join('\n')) return refuse('commit-header-mismatch');
  if (!raw.subarray(boundary + 2).equals(Buffer.from(want.commit.message, 'utf8'))) return refuse('commit-message-mismatch');
  let diff;
  try { diff = Buffer.from(await git(['diff-tree', '-r', '-z', '--no-renames', '--no-commit-id', '--raw', want.base, commit])); }
  catch { return refuse('commit-unreadable'); }
  const fields = diff.toString('utf8').split('\0');
  if (fields.at(-1) === '') fields.pop();
  if (fields.length % 2 !== 0) return refuse('commit-unreadable');
  const byPath = new Map(want.changes.map((change) => [change.path, change]));
  const seen = new Set();
  for (let i = 0; i < fields.length; i += 2) {
    const match = RAW.exec(fields[i]);
    const path = fields[i + 1];
    const change = byPath.get(path);
    if (match === null || change === undefined || seen.has(path)) return refuse('unsigned-path-changed', { path });
    const [, oldMode, newMode, oldId, newId] = match;
    for (const [side, mode, id] of [['before', oldMode, oldId], ['after', newMode, newId]]) {
      const signed = change[side];
      if (signed === null) {
        if (mode !== '000000') return refuse('change-mismatch', { path });
        continue;
      }
      if (mode === '000000') return refuse('change-mismatch', { path });
      if (mode !== signed.mode) return refuse('mode-mismatch', { path });
      let blob;
      try { blob = await git(['cat-file', 'blob', id]); } catch { return refuse('commit-unreadable'); }
      if (sha256Hex(blob) !== signed.sha256) return refuse('content-mismatch', { path });
    }
    seen.add(path);
  }
  if (seen.size !== want.changes.length) return refuse('signed-change-missing');
  return Object.freeze({ ok: true, commit, tree: tree.slice(5) });
}

/** The publisher's pushed receipt body; it signs this with its own key. */
export function receiptBody({ intentDigest: digest, keyId, provider, commit, remote, branch, remoteHeadBefore, remoteHeadAfter, at }) {
  return { v: 1, kind: 'pushed', intent: digest, keyId, provider, commit, remote, branch, remoteHeadBefore, remoteHeadAfter, at };
}

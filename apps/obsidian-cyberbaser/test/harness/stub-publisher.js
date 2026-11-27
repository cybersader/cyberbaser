// A stand-in for the publisher's signing verbs, built only from
// @cyberbaser/signed-intent: it issues challenges, accepts one enrolment with
// its one-time code, and verifies publish approvals exactly as the provider
// does. Used by the plugin tests and the phone-step harness until the real
// publisher offers these verbs. Synthetic keys only.
import { createHash, randomBytes } from 'node:crypto';
import {
  ed25519FromSeed, ed25519Provider, ENROLL_CODE_BYTES, enrollConfirm, enrollProof, formatCode, intentDigest, macEqual,
  validateIntent,
} from '../../../../packages/signed-intent/src/index.js';

export function createStubPublisher({ now = Date.now } = {}) {
  const pair = ed25519FromSeed(randomBytes(32));
  const publisher = Buffer.from(pair.publicKey).toString('hex');
  let secret = randomBytes(ENROLL_CODE_BYTES);
  const code = formatCode(secret);
  const nonces = new Set();
  const keys = new Map();
  const approvals = [];
  const take = (nonce) => { if (!nonces.delete(nonce)) throw Object.assign(new Error('nonce'), { code: 'nonce-unknown' }); };
  return {
    publisher,
    code,
    enrolLink: `cyberbaser-enroll:v1?publisher=${publisher}&code=${code}`,
    keys,
    approvals,
    challenge() {
      const nonce = randomBytes(32).toString('base64url');
      nonces.add(nonce);
      const at = now();
      return { publisher, nonce, issuedAt: at, expiresAt: at + 10 * 60_000 };
    },
    enroll({ intent, approval }) {
      const checked = validateIntent(intent);
      if (secret === null || checked.kind !== 'enroll' || checked.publisher !== publisher) throw new Error('enroll refused');
      take(checked.nonce);
      if (!macEqual(checked.subject.proof, enrollProof(secret, publisher, checked.subject.key))) throw new Error('wrong code');
      const digest = intentDigest(checked);
      if (!ed25519Provider.verify({ digest, approval, key: checked.subject.key }).ok) throw new Error('bad signature');
      keys.set(checked.keyId, checked.subject.key);
      const confirm = enrollConfirm(secret, publisher, digest.toString('hex'));
      secret = null; // the window closes after the first device
      return { confirm };
    },
    // What the real publisher does before pushing, minus Git: key on the list,
    // signature over exactly this intent, nonce issued here and unused.
    verifyPublish({ intent, approval }) {
      const checked = validateIntent(intent);
      const key = keys.get(checked.keyId);
      if (!key || checked.publisher !== publisher) return { ok: false, code: 'unknown-key' };
      const result = ed25519Provider.verify({ digest: intentDigest(checked), approval, key });
      if (result.ok) { take(checked.nonce); approvals.push(checked); }
      return result;
    },
  };
}

export const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** A publish intent for one note, with the node's placeholder key ID. */
export function publishIntent({ publisher, nonce, path, before, after, now = Date.now(), remote = 'https://github.com/example/vault.git' }) {
  const person = { name: 'Owner', email: 'owner@example.invalid', time: Math.floor(now / 1000), tz: '+0000' };
  return {
    v: 1, kind: 'publish', publisher, keyId: 'signing-device', nonce, issuedAt: now, expiresAt: now + 10 * 60_000,
    target: { remote, branch: 'main' }, base: '1'.repeat(40),
    commit: { author: person, committer: person, message: `Edit ${path}\n` },
    changes: [{ path, before: { mode: '100644', sha256: sha256Hex(before) }, after: { mode: '100644', sha256: sha256Hex(after) } }],
  };
}

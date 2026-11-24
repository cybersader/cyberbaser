// Writes vectors.json: fixed inputs and expected outcomes every implementation
// (this package, the Obsidian plugin, a later publisher in another language)
// must reproduce. Run once when the format changes: bun test/make-vectors.js
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import {
  b64url, ed25519FromSeed, ed25519Provider, enrollConfirm, enrollProof, formatCode, intentBytes, intentDigest,
  recoveryKeyFromCode,
} from '../src/index.js';

const ORDER = 2n ** 252n + 27742317777372353535851937790883648493n;
const PUBLISHER = 'a'.repeat(64);
const device = ed25519FromSeed(Buffer.alloc(32, 7));
const deviceKey = { keyId: 'phone-1', type: 'ed25519', publicKey: b64url(device.publicKey), label: 'Phone' };
const envelope = { v: 1, publisher: PUBLISHER, nonce: b64url(Buffer.alloc(32, 1)), issuedAt: 1_800_000_000_000, expiresAt: 1_800_000_600_000 };

const publish = {
  ...envelope, kind: 'publish', keyId: 'phone-1',
  target: { remote: 'https://github.com/example/vault.git', branch: 'main' },
  base: '1'.repeat(40),
  commit: {
    author: { name: 'Owner', email: 'owner@example.invalid', time: 1_800_000_000, tz: '+0000' },
    committer: { name: 'Owner', email: 'owner@example.invalid', time: 1_800_000_000, tz: '+0000' },
    message: 'Edit notes/a.md\n',
  },
  changes: [
    { path: 'notes/a.md', before: { mode: '100644', sha256: 'b'.repeat(64) }, after: { mode: '100644', sha256: 'c'.repeat(64) } },
    { path: 'notes/new.md', before: null, after: { mode: '100644', sha256: 'd'.repeat(64) } },
  ],
};
const enrollSecret = Buffer.alloc(20, 5);
const enrollIntent = { ...envelope, kind: 'enroll', keyId: 'phone-1', subject: { key: deviceKey, proof: enrollProof(enrollSecret, PUBLISHER, deviceKey) } };
const laptopKey = { keyId: 'laptop-1', type: 'ed25519', publicKey: b64url(ed25519FromSeed(Buffer.alloc(32, 8)).publicKey), label: 'Work laptop' };
const recoveryCode = formatCode(Buffer.alloc(15, 3));
const recovery = recoveryKeyFromCode(recoveryCode, PUBLISHER);
const intents = {
  publish,
  enroll: enrollIntent,
  'key-add': { ...envelope, kind: 'key-add', keyId: 'phone-1', subject: { key: laptopKey } },
  'key-revoke': { ...envelope, kind: 'key-revoke', keyId: 'phone-1', subject: { keyId: 'laptop-1' } },
  'recovery-reset': { ...envelope, kind: 'recovery-reset', keyId: 'recovery', subject: { key: laptopKey, recoveryKey: null } },
};

const digest = intentDigest(publish);
const other = intentDigest({ ...publish, base: '2'.repeat(40) });
const edSig = sign(null, ed25519Provider.message(digest), device.privateKey);
const malleable = Buffer.from(edSig);
let s = 0n;
for (let i = 63; i >= 32; i -= 1) s = (s << 8n) | BigInt(malleable[i]);
s += ORDER;
for (let i = 32; i < 64; i += 1) { malleable[i] = Number(s & 0xffn); s >>= 8n; }

const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const rpId = 'localhost';
const origin = 'http://localhost:4319';
function assertion({ challenge = digest, flags = 0x05, counter = 0, rp = rpId, org = origin, type = 'webauthn.get' } = {}) {
  const clientDataJSON = Buffer.from(JSON.stringify({ type, challenge: b64url(challenge), origin: org, crossOrigin: false }));
  const authData = Buffer.alloc(37);
  createHash('sha256').update(rp).digest().copy(authData, 0);
  authData[32] = flags;
  authData.writeUInt32BE(counter, 33);
  const sig = sign('sha256', Buffer.concat([authData, createHash('sha256').update(clientDataJSON).digest()]), ec.privateKey);
  return { type: 'webauthn', clientDataJSON: b64url(clientDataJSON), authenticatorData: b64url(authData), signature: b64url(sig) };
}
const passkey = { type: 'webauthn', rpId, origins: [origin], counter: 0, publicKeySpki: b64url(ec.publicKey.export({ format: 'der', type: 'spki' })) };
const counted = { ...passkey, counter: 10 };
const edKey = { type: 'ed25519', publicKey: deviceKey.publicKey };
const hex = (bytes) => bytes.toString('hex');

const vectors = {
  note: 'Conformance vectors for @cyberbaser/signed-intent format v1. Regenerating changes the passkey cases (random P-256 key) but never the intent bytes.',
  publisher: PUBLISHER,
  intents: Object.fromEntries(Object.entries(intents).map(([name, intent]) => [name, {
    intent, bytesUtf8: Buffer.from(intentBytes(intent)).toString('utf8'), digestHex: hex(intentDigest(intent)),
  }])),
  invalidIntents: [
    { name: 'unknown member', intent: { ...publish, note: 'x' } },
    { name: 'no changes', intent: { ...publish, changes: [] } },
    { name: 'lifetime over 15 minutes', intent: { ...publish, expiresAt: publish.issuedAt + 15 * 60_000 + 1 } },
    { name: 'unsorted changes', intent: { ...publish, changes: [...publish.changes].reverse() } },
    { name: 'path with ..', intent: { ...publish, changes: [{ ...publish.changes[0], path: 'notes/../x.md' }] } },
    { name: 'path into .git', intent: { ...publish, changes: [{ ...publish.changes[0], path: '.git/config' }] } },
    { name: 'symlink mode', intent: { ...publish, changes: [{ ...publish.changes[0], after: { mode: '120000', sha256: 'c'.repeat(64) } }] } },
    { name: 'message without final newline', intent: { ...publish, commit: { ...publish.commit, message: 'x' } } },
    { name: 'float time', intent: { ...publish, issuedAt: 1.5 } },
    { name: 'recovery key signing a publish', intent: { ...publish, keyId: 'recovery' } },
    { name: 'enroll for another key', intent: { ...enrollIntent, keyId: 'someone-else' } },
  ],
  approvals: [
    { name: 'ed25519 valid', digest: hex(digest), key: edKey, approval: { type: 'ed25519', signature: b64url(edSig) }, expect: 'ok' },
    { name: 'ed25519 other intent', digest: hex(other), key: edKey, approval: { type: 'ed25519', signature: b64url(edSig) }, expect: 'bad-signature' },
    { name: 'ed25519 s+L malleated', digest: hex(digest), key: edKey, approval: { type: 'ed25519', signature: b64url(malleable) }, expect: 'non-canonical-signature' },
    { name: 'ed25519 truncated', digest: hex(digest), key: edKey, approval: { type: 'ed25519', signature: b64url(edSig.subarray(0, 63)) }, expect: 'malformed' },
    { name: 'ed25519 small-order key', digest: hex(digest), key: { type: 'ed25519', publicKey: b64url(Buffer.from(`01${'00'.repeat(31)}`, 'hex')) }, approval: { type: 'ed25519', signature: b64url(edSig) }, expect: 'weak-key' },
    { name: 'passkey valid synced (counter 0)', digest: hex(digest), key: passkey, approval: assertion(), expect: 'ok' },
    { name: 'passkey other intent', digest: hex(other), key: passkey, approval: assertion(), expect: 'wrong-challenge' },
    { name: 'passkey wrong origin', digest: hex(digest), key: passkey, approval: assertion({ org: 'http://localhost:4317' }), expect: 'wrong-origin' },
    { name: 'passkey wrong rp', digest: hex(digest), key: passkey, approval: assertion({ rp: 'evil.example' }), expect: 'wrong-rp' },
    { name: 'passkey create not get', digest: hex(digest), key: passkey, approval: assertion({ type: 'webauthn.create' }), expect: 'wrong-type' },
    { name: 'passkey no user presence', digest: hex(digest), key: passkey, approval: assertion({ flags: 0x04 }), expect: 'no-user-presence' },
    { name: 'passkey no user verification', digest: hex(digest), key: passkey, approval: assertion({ flags: 0x01 }), expect: 'no-user-verification' },
    { name: 'security key counter advanced', digest: hex(digest), key: counted, approval: assertion({ counter: 11 }), expect: 'ok' },
    { name: 'security key counter replayed', digest: hex(digest), key: counted, approval: assertion({ counter: 10 }), expect: 'counter-regressed' },
  ],
  enrollment: {
    secretHex: hex(enrollSecret), code: formatCode(enrollSecret), key: deviceKey,
    proof: enrollProof(enrollSecret, PUBLISHER, deviceKey),
    confirm: enrollConfirm(enrollSecret, PUBLISHER, hex(intentDigest(enrollIntent))),
  },
  recovery: { code: recoveryCode, publicKey: recovery.publicKey },
};
writeFileSync(new URL('./vectors.json', import.meta.url), `${JSON.stringify(vectors, null, 2)}\n`);
console.log(`wrote ${vectors.approvals.length} approval cases, publish digest ${vectors.intents.publish.digestHex}`);

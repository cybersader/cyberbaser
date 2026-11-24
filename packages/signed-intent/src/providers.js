// Approval providers. Each answers one question: "does this approval prove
// that key K approved exactly this 32-byte intent digest?" A provider never
// sees the key list, the nonces, Git or the clock; the publisher core does
// those once for every provider.
import { createHash, createPublicKey, timingSafeEqual, verify } from 'node:crypto';
import { acceptableEd25519PublicKey, ed25519PublicKeyObject, fromB64url } from './crypto.js';

const ORDER = 2n ** 252n + 27742317777372353535851937790883648493n;
export const ED25519_APPROVAL_DOMAIN = 'cyberbaser.publish-approval.ed25519.v1\n';
const ED_DOMAIN = Buffer.from(ED25519_APPROVAL_DOMAIN, 'utf8');

const refuse = (code) => Object.freeze({ ok: false, code });
const exactKeys = (object, keys) => object !== null && typeof object === 'object' && !Array.isArray(object)
  && Object.keys(object).sort().join(',') === [...keys].sort().join(',');

function digestBytes(digest) {
  const bytes = Buffer.isBuffer(digest) ? digest : digest instanceof Uint8Array ? Buffer.from(digest) : null;
  return bytes?.length === 32 ? bytes : null;
}

/**
 * Device key (Obsidian plugin, paired computer, desktop shell). Pure RFC 8032
 * Ed25519 over the domain line plus the 32-byte digest.
 *   key:      { publicKey: b64url(32) }
 *   approval: { type: 'ed25519', signature: b64url(64) }
 */
export const ed25519Provider = Object.freeze({
  type: 'ed25519',
  message(digest) { return Buffer.concat([ED_DOMAIN, digestBytes(digest)]); },
  verify({ digest, approval, key }) {
    const bytes = digestBytes(digest);
    if (!exactKeys(approval, ['type', 'signature']) || approval.type !== 'ed25519' || bytes === null) return refuse('malformed');
    const pub = fromB64url(key?.publicKey, 32);
    const sig = fromB64url(approval.signature, 64);
    if (!pub || !sig) return refuse('malformed');
    if (!acceptableEd25519PublicKey(pub)) return refuse('weak-key');
    // Refuse non-canonical S (s >= L) explicitly, whatever the library does.
    let s = 0n;
    for (let i = 63; i >= 32; i -= 1) s = (s << 8n) | BigInt(sig[i]);
    if (s >= ORDER) return refuse('non-canonical-signature');
    let ok = false;
    try { ok = verify(null, Buffer.concat([ED_DOMAIN, bytes]), ed25519PublicKeyObject(pub), sig); } catch { ok = false; }
    return ok ? Object.freeze({ ok: true }) : refuse('bad-signature');
  },
});

/**
 * WebAuthn passkey or security key (W3C WebAuthn Level 3, verifying an
 * assertion). The challenge is the intent digest itself.
 *   key:      { publicKeySpki: b64url(DER, P-256 or Ed25519), rpId, origins: [..], counter }
 *   approval: { type: 'webauthn', clientDataJSON, authenticatorData, signature } (all b64url)
 * Returns { ok: true, counter } so the caller can store the new counter.
 */
export const webauthnProvider = Object.freeze({
  type: 'webauthn',
  verify({ digest, approval, key }) {
    const bytes = digestBytes(digest);
    if (!exactKeys(approval, ['type', 'clientDataJSON', 'authenticatorData', 'signature']) || approval.type !== 'webauthn'
      || bytes === null || !Array.isArray(key?.origins) || typeof key?.rpId !== 'string'
      || !Number.isSafeInteger(key?.counter) || key.counter < 0) return refuse('malformed');
    const clientData = fromB64url(approval.clientDataJSON, 1, 4096);
    const authData = fromB64url(approval.authenticatorData, 37, 1024);
    const sig = fromB64url(approval.signature, 8, 512);
    const spki = fromB64url(key.publicKeySpki, 32, 300);
    if (!clientData || !authData || !sig || !spki) return refuse('malformed');
    let client;
    try { client = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(clientData)); } catch { return refuse('malformed'); }
    if (client === null || typeof client !== 'object') return refuse('malformed');
    if (client.type !== 'webauthn.get') return refuse('wrong-type');
    const challenge = fromB64url(client.challenge, 32);
    if (!challenge || !timingSafeEqual(challenge, bytes)) return refuse('wrong-challenge');
    if (typeof client.origin !== 'string' || !key.origins.includes(client.origin) || client.crossOrigin === true
      || client.topOrigin !== undefined) return refuse('wrong-origin');
    const rpIdHash = createHash('sha256').update(key.rpId, 'utf8').digest();
    if (!timingSafeEqual(authData.subarray(0, 32), rpIdHash)) return refuse('wrong-rp');
    const flags = authData[32];
    if ((flags & 0x01) === 0) return refuse('no-user-presence');
    if ((flags & 0x04) === 0) return refuse('no-user-verification');
    const counter = authData.readUInt32BE(33);
    // Synced passkeys report 0 forever; only a non-zero counter must increase.
    if ((counter !== 0 || key.counter !== 0) && counter <= key.counter) return refuse('counter-regressed');
    let publicKey;
    try { publicKey = createPublicKey({ key: spki, format: 'der', type: 'spki' }); } catch { return refuse('malformed'); }
    const type = publicKey.asymmetricKeyType;
    if (type === 'ec' && publicKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') return refuse('unsupported-key');
    if (!['ed25519', 'ec'].includes(type)) return refuse('unsupported-key');
    const signed = Buffer.concat([authData, createHash('sha256').update(clientData).digest()]);
    let ok = false;
    try { ok = verify(type === 'ed25519' ? null : 'sha256', signed, publicKey, sig); } catch { ok = false; }
    return ok ? Object.freeze({ ok: true, counter }) : refuse('bad-signature');
  },
});

export const PROVIDERS = Object.freeze(new Map([[ed25519Provider.type, ed25519Provider], [webauthnProvider.type, webauthnProvider]]));

// Hashing, the publisher's own signed statements, enrollment proofs and the
// recovery key. Pure: node:crypto only, no I/O, no clock reads.
import { createHash, createHmac, createPrivateKey, createPublicKey, hkdfSync, sign, timingSafeEqual, verify } from 'node:crypto';
import { canonicalJson, intentBytes } from './intent.js';

const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');
const P = 2n ** 255n - 19n;
// Encodings of the eight small-order points (sign bit cleared), as libsodium lists them.
const SMALL_ORDER = [
  '0000000000000000000000000000000000000000000000000000000000000000',
  '0100000000000000000000000000000000000000000000000000000000000000',
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
  'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
];

export const STATEMENT_DOMAIN = 'cyberbaser.publisher-statement.v1';
export const ENROLL_PROOF_DOMAIN = 'cyberbaser.enroll-proof.v1';
export const ENROLL_CONFIRM_DOMAIN = 'cyberbaser.enroll-confirm.v1';
export const RECOVERY_INFO = 'cyberbaser.recovery-key.v1';
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export const b64url = (bytes) => Buffer.from(bytes).toString('base64url');

/** Strict base64url: canonical encoding only, exact length range in bytes. */
export function fromB64url(value, min, max = min) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/u.test(value)) return null;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.length >= min && bytes.length <= max && bytes.toString('base64url') === value ? bytes : null;
}

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest();
export const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const intentDigest = (intent) => sha256(intentBytes(intent));
export const intentDigestHex = (intent) => intentDigest(intent).toString('hex');

/** False for small-order points and non-canonical encodings (y >= p). */
export function acceptableEd25519PublicKey(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== 32) return false;
  const cleared = Buffer.from(bytes);
  cleared[31] &= 0x7f;
  let y = 0n;
  for (let i = 31; i >= 0; i -= 1) y = (y << 8n) | BigInt(cleared[i]);
  if (y >= P) return false;
  return !SMALL_ORDER.includes(cleared.toString('hex'));
}

export function ed25519FromSeed(seed) {
  if (!Buffer.isBuffer(seed) || seed.length !== 32) throw new TypeError('ed25519 seed must be 32 bytes');
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: 'der', type: 'pkcs8' });
  const publicKey = Buffer.from(privateKey.export({ format: 'jwk' }).x, 'base64url');
  return { privateKey, publicKey };
}

export function ed25519PublicKeyObject(bytes) {
  return createPublicKey({ key: Buffer.concat([SPKI_ED25519, bytes]), format: 'der', type: 'spki' });
}

// The publisher's own statements (signed key list, push receipts):
// Ed25519 over the domain line plus canonical JSON of the body.
export function statementBytes(body) {
  return Buffer.from(`${STATEMENT_DOMAIN}\n${canonicalJson(body)}`, 'utf8');
}

export function signStatement(body, seed) {
  return b64url(sign(null, statementBytes(body), ed25519FromSeed(seed).privateKey));
}

export function verifyStatement(body, signature, publisherHex) {
  const key = typeof publisherHex === 'string' && /^[0-9a-f]{64}$/u.test(publisherHex) ? Buffer.from(publisherHex, 'hex') : null;
  const sig = fromB64url(signature, 64);
  if (key === null || sig === null) return false;
  try { return verify(null, statementBytes(body), ed25519PublicKeyObject(key), sig); } catch { return false; }
}

// Enrollment: the device proves it read the one-time code the publisher
// showed, bound to the publisher's key and the device's own key record.
function enrollMac(domain, secret, publisherHex, payload) {
  return createHmac('sha256', secret).update(`${domain}\n${publisherHex}\n${payload}`, 'utf8').digest();
}

export function enrollProof(secret, publisherHex, key) {
  return b64url(enrollMac(ENROLL_PROOF_DOMAIN, secret, publisherHex, canonicalJson(key)));
}

/** The publisher's answer, so the device knows the real publisher (not a node) holds the code. */
export function enrollConfirm(secret, publisherHex, digestHex) {
  return b64url(enrollMac(ENROLL_CONFIRM_DOMAIN, secret, publisherHex, digestHex));
}

export function macEqual(left, right) {
  const a = fromB64url(left, 32);
  const b = fromB64url(right, 32);
  return a !== null && b !== null && timingSafeEqual(a, b);
}

// Codes people read and type: Crockford base32, groups of four, case-insensitive,
// I/L read as 1 and O as 0.
export function formatCode(bytes) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 31];
  return out.match(/.{1,4}/gu).join('-');
}

export function parseCode(text, byteLength) {
  if (typeof text !== 'string') return null;
  const clean = text.toUpperCase().replace(/[\s-]/gu, '').replace(/[IL]/gu, '1').replace(/O/gu, '0');
  if (clean.length !== Math.ceil((byteLength * 8) / 5) || [...clean].some((c) => !CROCKFORD.includes(c))) return null;
  let bits = 0;
  let value = 0;
  const out = [];
  for (const c of clean) {
    value = (value << 5) | CROCKFORD.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
    value &= 0xff;
  }
  const bytes = Buffer.from(out.slice(0, byteLength));
  return formatCode(bytes) === clean.match(/.{1,4}/gu).join('-') ? bytes : null;
}

export const ENROLL_CODE_BYTES = 20; // 160 bits, 32 characters
export const RECOVERY_CODE_BYTES = 15; // 120 bits, 24 characters

/**
 * The recovery key: an Ed25519 key derived from the written recovery code,
 * bound to one publisher. The publisher keeps only the public half, a one-way
 * function of the code; whoever types the code derives the same key and signs
 * one recovery-reset. The code itself never travels.
 */
export function recoveryKeyFromCode(code, publisherHex) {
  const bytes = Buffer.isBuffer(code) ? code : parseCode(code, RECOVERY_CODE_BYTES);
  if (bytes === null || bytes.length !== RECOVERY_CODE_BYTES || !/^[0-9a-f]{64}$/u.test(publisherHex ?? '')) return null;
  const seed = Buffer.from(hkdfSync('sha256', bytes, Buffer.from(publisherHex, 'hex'), RECOVERY_INFO, 32));
  const pair = ed25519FromSeed(seed);
  return { seed, publicKey: b64url(pair.publicKey), privateKey: pair.privateKey };
}

/** Short fingerprint both screens show after enrollment: 4 groups of 4 hex. */
export function keyFingerprint(key) {
  return sha256Hex(Buffer.from(canonicalJson(key), 'utf8')).slice(0, 16).match(/.{4}/gu).join(' ');
}

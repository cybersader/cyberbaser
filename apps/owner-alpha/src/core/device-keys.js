import { createPublicKey } from 'node:crypto';
import { isProxy } from 'node:util/types';
import { isPlainObject } from '../json.js';
import { actorAllowsGrant, OWNER_GRANTS } from './grants.js';

const MAX_KEYS = 256;
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');
const registries = new WeakSet();

export function isKeyId(value) {
  return typeof value === 'string' && value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value);
}

export function boundedText(value, max) {
  return typeof value === 'string' && value.length <= max && value.length > 0
    && value.trim() === value && !/[\p{Cc}\p{Cs}]/u.test(value);
}

// Node's base64 decoder accepts aliases and whitespace. Require a canonical
// spelling so equality, uniqueness, and replay decisions refer to one value.
export function decodeBase64(value, min, max = min) {
  if (typeof value !== 'string' || value.length > 4 * Math.ceil(max / 3)) return null;
  const bytes = Buffer.from(value, 'base64');
  return bytes.length >= min && bytes.length <= max && bytes.toString('base64') === value ? bytes : null;
}

export function plainData(value, required, optional = []) {
  if (isProxy(value) || !isPlainObject(value)) return null;
  const output = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (!required.includes(key) && !optional.includes(key)) return null;
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field.enumerable || !Object.hasOwn(field, 'value')) return null;
    output[key] = field.value;
  }
  return required.every((key) => Object.hasOwn(output, key)) ? output : null;
}

export function denseDataArray(value, max) {
  if (isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length > max || Reflect.ownKeys(value).length !== value.length + 1) return null;
  const output = [];
  for (let i = 0; i < value.length; i += 1) {
    const field = Object.getOwnPropertyDescriptor(value, String(i));
    if (!field?.enumerable || !Object.hasOwn(field, 'value')) return null;
    output.push(field.value);
  }
  return output;
}

function rejectEnrollment() {
  throw new TypeError('invalid device key enrollment registry');
}

// Importing a raw SPKI in node:crypto does not check the compressed point.
// Check canonical y, curve membership and reject points of order dividing 8.
// Signature verification itself is performed only by node:crypto.
const FIELD = 2n ** 255n - 19n;
const D = 37095705934669439343138083508754565189542113879843219016388785533085940283555n;
function validPublicPoint(bytes) {
  let y = BigInt(bytes[31] & 127);
  for (let i = 30; i >= 0; i -= 1) y = (y << 8n) | BigInt(bytes[i]);
  if (y >= FIELD) return false;
  const y2 = y * y % FIELD;
  if (y2 === 0n || y2 === 1n || (D * y2 * y2 + 2n * y2 - 1n) % FIELD === 0n) return false;
  // x² = (y² - 1) / (d*y² + 1). Multiplying by the denominator instead
  // preserves square status; Euler's criterion requires a nonzero square.
  let base = (y2 - 1n) * (D * y2 + 1n) % FIELD;
  let residue = 1n;
  for (let exp = (FIELD - 1n) / 2n; exp > 0n; exp >>= 1n) {
    if (exp & 1n) residue = residue * base % FIELD;
    base = base * base % FIELD;
  }
  return residue === 1n;
}

export function isIrohNodeId(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}

function parseRegistry(input) {
  const config = plainData(input, ['ownerId', 'entries']);
  const entries = config && denseDataArray(config.entries, MAX_KEYS);
  if (!entries || !boundedText(config.ownerId, 128)) rejectEnrollment();

  const keys = new Map();
  const publicKeys = new Set();
  for (const value of entries) {
    // irohNodeId is optional: a key enrolled by pairing names the one Iroh
    // endpoint allowed to present it; a key without one cannot use Iroh.
    const entry = plainData(value, ['keyId', 'publicKey', 'actor', 'grants', 'notBefore', 'notAfter', 'revoked'], ['irohNodeId']);
    if (!entry || !isKeyId(entry.keyId) || keys.has(entry.keyId)
      || !Number.isSafeInteger(entry.notBefore) || entry.notBefore < 0
      || !Number.isSafeInteger(entry.notAfter) || entry.notAfter <= entry.notBefore
      || typeof entry.revoked !== 'boolean'
      || (Object.hasOwn(entry, 'irohNodeId') && !isIrohNodeId(entry.irohNodeId))) rejectEnrollment();
    const bytes = decodeBase64(entry.publicKey, 32);
    if (!bytes || publicKeys.has(entry.publicKey) || !validPublicPoint(bytes)) rejectEnrollment();

    const actor = plainData(entry.actor, ['kind', 'id', 'label']);
    const grants = denseDataArray(entry.grants, OWNER_GRANTS.length);
    if (!actor || !['owner-device', 'agent'].includes(actor.kind) || !boundedText(actor.id, 128)
      || !boundedText(actor.label, 128) || (actor.kind === 'agent' && actor.id === config.ownerId)
      || !grants || new Set(grants).size !== grants.length
      || grants.some((grant) => !actorAllowsGrant(actor.kind, grant))) rejectEnrollment();

    let publicKey;
    try {
      publicKey = createPublicKey({ key: Buffer.concat([SPKI_ED25519, bytes]), format: 'der', type: 'spki' });
    } catch {
      rejectEnrollment();
    }
    publicKeys.add(entry.publicKey);
    keys.set(entry.keyId, Object.freeze({
      keyId: entry.keyId, publicKey, publicKeyText: entry.publicKey, actor: Object.freeze({ ...actor }), grants: Object.freeze(grants),
      notBefore: entry.notBefore, notAfter: entry.notAfter, revoked: entry.revoked,
      irohNodeId: Object.hasOwn(entry, 'irohNodeId') ? entry.irohNodeId : null,
    }));
  }
  return { ownerId: config.ownerId, keys };
}

export function createDeviceKeyRegistry(input) {
  const { ownerId, keys } = parseRegistry(input);
  const registry = Object.freeze({ ownerId, find: (keyId) => keys.get(keyId) ?? null });
  registries.add(registry);
  return registry;
}

// A registry the running node can change. `replace` validates the whole next
// set before swapping it in, so a lookup sees either the old or the new set.
// A key or public key once seen revoked stays revoked for this process even if
// a later set omits or un-revokes it; the durable store enforces the same.
export function createLiveDeviceKeyRegistry(input) {
  let current = parseRegistry(input);
  const ownerId = current.ownerId;
  const revokedIds = new Set();
  const revokedPublicKeys = new Set();
  const remember = (keys) => {
    for (const key of keys.values()) {
      if (key.revoked) { revokedIds.add(key.keyId); revokedPublicKeys.add(key.publicKeyText); }
    }
  };
  remember(current.keys);
  const registry = Object.freeze({
    ownerId,
    find(keyId) {
      const key = current.keys.get(keyId) ?? null;
      if (!key || key.revoked || (!revokedIds.has(key.keyId) && !revokedPublicKeys.has(key.publicKeyText))) return key;
      return Object.freeze({ ...key, revoked: true });
    },
    entries: () => [...current.keys.values()],
  });
  registries.add(registry);
  return Object.freeze({
    registry,
    replace(next) {
      const parsed = parseRegistry(next);
      if (parsed.ownerId !== ownerId) rejectEnrollment();
      remember(parsed.keys);
      current = parsed;
    },
  });
}

export function isDeviceKeyRegistry(registry) {
  return registries.has(registry);
}

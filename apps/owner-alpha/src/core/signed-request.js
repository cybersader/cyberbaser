import { createHash, timingSafeEqual, verify } from 'node:crypto';
import { isProxy } from 'node:util/types';
import { fail } from '../errors.js';
import { canonicalJson, deepFreeze, isPlainObject } from '../json.js';
import { boundedText, decodeBase64, denseDataArray, isDeviceKeyRegistry, isKeyId, plainData } from './device-keys.js';

const DOMAIN = 'cyberbaser.owner-command.v1';
const CLAIMS = ['audience', 'keyId', 'command', 'inputDigest', 'nonce', 'issuedAt'];
const MAX_BINDING_BYTES = 256;
const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const MAX_INPUT_NODES = 16_384;
const MAX_REPLAY_ENTRIES = 65_536;
const MAX_WINDOW_MS = 10 * 60_000;

export function refuseSignedRequest() {
  fail('invalid-session', 'a verified owner session is required');
}

function claimsBytes(claims) {
  return Buffer.from(canonicalJson([DOMAIN, claims.audience, claims.keyId, claims.command,
    claims.inputDigest, claims.nonce, claims.issuedAt, claims.channelBinding ?? null]), 'utf8');
}

function validClaims(claims) {
  return boundedText(claims.audience, 128) && isKeyId(claims.keyId)
    && typeof claims.command === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(claims.command)
    && typeof claims.inputDigest === 'string' && /^[0-9a-f]{64}$/u.test(claims.inputDigest)
    && decodeBase64(claims.nonce, 16) !== null
    && Number.isSafeInteger(claims.issuedAt) && claims.issuedAt >= 0;
}

// The wire metadata uses canonical padded base64 for nonce, signature and
// optional channel binding, and lowercase hex for the SHA-256 input digest.
export function signedRequestBytes(input) {
  const claims = plainData(input, CLAIMS, ['channelBinding']);
  if (!claims || !validClaims(claims)
    || (Object.hasOwn(claims, 'channelBinding') && !decodeBase64(claims.channelBinding, 1, MAX_BINDING_BYTES))) {
    throw new TypeError('invalid signed request claims');
  }
  return claimsBytes(claims);
}

function canonicalInput(input) {
  let bytesLeft = MAX_INPUT_BYTES;
  let nodesLeft = MAX_INPUT_NODES;
  const invalid = () => { throw new TypeError('invalid signed command input'); };
  function charge(bytes) {
    bytesLeft -= bytes;
    if (bytesLeft < 0) invalid();
  }
  function chargeString(value) {
    if (value.length > bytesLeft) invalid();
    charge(Buffer.byteLength(JSON.stringify(value)));
  }
  function copy(value, depth) {
    if (--nodesLeft < 0 || depth > 32) invalid();
    if (typeof value === 'string') {
      chargeString(value);
      return value;
    }
    if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
      charge(JSON.stringify(value).length);
      return value;
    }
    if (isProxy(value)) invalid();
    if (Array.isArray(value)) {
      const array = denseDataArray(value, nodesLeft);
      if (!array) invalid();
      charge(2 + Math.max(0, array.length - 1));
      return array.map((entry) => copy(entry, depth + 1));
    }
    if (!isPlainObject(value)) invalid();
    const keys = Reflect.ownKeys(value);
    if (keys.length > nodesLeft) invalid();
    charge(2 + keys.length + Math.max(0, keys.length - 1));
    const object = Object.create(null);
    for (const key of keys) {
      const field = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== 'string' || !field.enumerable || !Object.hasOwn(field, 'value')) invalid();
      chargeString(key);
      object[key] = copy(field.value, depth + 1);
    }
    return object;
  }
  return canonicalJson(copy(input, 0));
}

const hashInput = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

export function signedInputDigest(input) {
  return hashInput(canonicalInput(input));
}

function connectionBytes(value) {
  if (!(value instanceof Uint8Array) || isProxy(value) || value.byteLength < 1 || value.byteLength > MAX_BINDING_BYTES) {
    throw new TypeError('invalid carrier channel binding');
  }
  return Buffer.from(value);
}

// One instance per owner node, including its replay cache. A carrier can scope
// verification to a connection using forChannel() without resetting that cache.
// `verify` returns evidence, not an attested principal; see principal.js.
export function createSignedRequestVerifier({ registry, audience, now = Date.now, windowMs = 120_000,
  maxReplayEntries = 4096, audit = () => {}, requireChannelBinding = false, channelBinding } = {}) {
  if (!isDeviceKeyRegistry(registry) || !boundedText(audience, 128) || typeof now !== 'function' || typeof audit !== 'function'
    || !Number.isSafeInteger(windowMs) || windowMs < 1 || windowMs > MAX_WINDOW_MS
    || !Number.isSafeInteger(maxReplayEntries) || maxReplayEntries < 1 || maxReplayEntries > MAX_REPLAY_ENTRIES
    || typeof requireChannelBinding !== 'boolean') throw new TypeError('invalid signed request verifier configuration');
  const nonces = new Map();
  let earliestExpiry = Infinity;
  let latestTime = -1;

  function report(event) {
    // Audit failures never become a second response channel. An asynchronous
    // sink owns delivery/retry; prevent its rejected promise escaping here.
    try { void Promise.resolve(audit(Object.freeze(event))).catch(() => {}); } catch { /* isolated sink */ }
  }

  function verifyFor(expectedBinding) {
    function check(envelope, acceptsCommand) {
      let command = null;
      let key = null;
      let at = null;
      const event = (outcome, reason) => report({ keyId: key?.keyId ?? null, actorKind: key?.actor.kind ?? null,
        command, outcome, reason, at });
      const reject = (reason) => {
        event('refused', reason);
        return null;
      };
      let time;
      try { time = now(); } catch { return reject('clock-unavailable'); }
      if (!Number.isSafeInteger(time) || time < 0 || time > Number.MAX_SAFE_INTEGER - 2 * windowMs) return reject('clock-unavailable');
      at = time;
      // Evicted nonces must not become admissible again after a clock rollback.
      if (at < latestTime) return reject('clock-regressed');
      latestTime = at;

      const request = plainData(envelope, [...CLAIMS, 'input', 'signature'], ['channelBinding']);
      if (!request || !validClaims(request)) return reject('malformed-envelope');
      if (typeof acceptsCommand !== 'function' || !acceptsCommand(request.command)) return reject('unknown-command');
      command = request.command;
      key = registry.find(request.keyId);
      if (request.audience !== audience) return reject('audience-mismatch');
      if (!key) return reject('unknown-key');
      if (key.revoked) return reject('revoked-key');
      if (at < key.notBefore) return reject('key-not-yet-valid');
      if (at >= key.notAfter) return reject('expired-key');
      if (request.issuedAt < at - windowMs) return reject('timestamp-too-old');
      if (request.issuedAt > at + windowMs) return reject('timestamp-in-future');

      if (Object.hasOwn(request, 'channelBinding')) {
        const actual = decodeBase64(request.channelBinding, 1, MAX_BINDING_BYTES);
        if (!actual) return reject('malformed-channel-binding');
        if (!expectedBinding || actual.length !== expectedBinding.length || !timingSafeEqual(actual, expectedBinding)) {
          return reject('channel-binding-mismatch');
        }
      } else if (requireChannelBinding) return reject('channel-binding-missing');

      const signature = decodeBase64(request.signature, 64);
      if (!signature) return reject('malformed-signature');
      let signatureValid;
      try { signatureValid = verify(null, claimsBytes(request), key.publicKey, signature); } catch { /* fail closed */ }
      if (!signatureValid) return reject('bad-signature');
      let text;
      try { text = canonicalInput(request.input); } catch { return reject('invalid-input'); }
      if (hashInput(text) !== request.inputDigest) return reject('input-digest-mismatch');
      // Execute a detached, immutable parse of the exact bytes hashed above.
      const input = deepFreeze(JSON.parse(text));

      if (earliestExpiry < at) {
        earliestExpiry = Infinity;
        for (const [nonce, expiry] of nonces) {
          if (expiry < at) nonces.delete(nonce);
          else earliestExpiry = Math.min(earliestExpiry, expiry);
        }
      }
      const nonce = `${key.keyId}:${request.nonce}`;
      if (nonces.has(nonce)) return reject('replay');
      if (nonces.size >= maxReplayEntries) return reject('replay-cache-full');
      const expiry = Math.max(at, request.issuedAt) + windowMs;
      nonces.set(nonce, expiry);
      earliestExpiry = Math.min(earliestExpiry, expiry);
      event('accepted', null);
      return Object.freeze({ command, input, key, authenticatedAt: at });
    }
    return (envelope, acceptsCommand) => check(envelope, acceptsCommand) ?? refuseSignedRequest();
  }

  return Object.freeze({
    ownerId: registry.ownerId,
    verify: verifyFor(channelBinding === undefined ? null : connectionBytes(channelBinding)),
    forChannel: (binding) => Object.freeze({ verify: verifyFor(connectionBytes(binding)) }),
  });
}

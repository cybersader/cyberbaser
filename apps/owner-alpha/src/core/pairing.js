import { createHash, createHmac, randomBytes, timingSafeEqual, verify } from 'node:crypto';
import { canonicalJson } from '../json.js';
import { boundedText, decodeBase64, isIrohNodeId, plainData } from './device-keys.js';
import { OWNER_GRANTS } from './grants.js';

// Pairing a phone or agent: the owner picks what it may do, the node issues a
// five-minute, one-use code, the device proves it holds that code and its new
// key over an authenticated Iroh connection, both sides show four words, and
// only the owner's Confirm enrols the key with exactly the picked grants.

export const PAIRING_CODE_TTL_MS = 5 * 60_000;
export const PAIRING_CONFIRM_WINDOW_MS = 5 * 60_000;
export const PAIRING_REFUSAL = 'pairing-refused';
const MAX_OPEN_PAIRINGS = 8;
const MAX_FINISHED_PAIRINGS = 32;

// Segmented choices on the owner screen. An agent may only propose.
export const ACCESS_CHOICES = Object.freeze({
  agent: Object.freeze({ propose: Object.freeze(['propose']) }),
  'owner-device': Object.freeze({
    propose: Object.freeze(['propose']),
    review: Object.freeze(['read', 'review', 'propose']),
    full: Object.freeze([...OWNER_GRANTS]),
  }),
});

// 256 short, distinct, plain words: one per byte of the comparison hash.
export const PAIRING_WORDS = Object.freeze(`
acorn amber anchor apple arch arrow aspen atlas autumn badge bagel bamboo banjo barley basil beacon
beach beetle bell berry birch biscuit bison blanket bloom bluff boat bonfire boulder bramble brass bread
breeze brick bridge brook bucket buffalo bugle bundle butter cabin cactus camel candle canoe canyon carrot
castle cedar cello chalk cherry chess chimney cider cinder citrus clay cliff clover cobalt cocoa comet
compass copper coral cotton cougar crane crater cricket crown crystal cypress daisy dawn delta denim desert
dingo dolphin domino donkey dove dragon drum dune eagle echo eclipse elbow elm ember emerald falcon
fern ferry fiddle field finch fjord flame flint flute forest fossil fox frost garden garnet gecko
geyser ginger glacier globe goose granite grape gravel grove gull hammer harbor harp hazel heron hickory
hill honey horizon hornet iris island ivory jacket jade jasmine jelly jetty juniper kayak kettle kiwi
koala ladder lagoon lantern larch lark lava lemon lilac lily linen lizard llama lobster locket lotus
lumber lynx magnet mango maple marble marsh meadow melon mesa meteor mint mirror moose moss moth
mountain mule nectar nest nickel nutmeg oak oasis ocean olive onyx orbit orchid otter owl oyster paddle
panda papaya parrot peach pebble pecan pelican pepper pine planet plum pond poppy prairie puffin pumpkin
quail quartz quill rabbit radish rain raven reef ribbon river robin rocket rose ruby saddle saffron sage
salmon sand sapphire satin shell sierra silver sparrow spruce squid star stone storm summit sunset swan
tango thistle thunder tiger timber topaz tulip tundra turtle valley velvet violet walnut willow
`.trim().split(/\s+/u));
if (PAIRING_WORDS.length !== 256 || new Set(PAIRING_WORDS).size !== 256) throw new Error('pairing word list must hold 256 distinct words');

const HEX32 = /^[0-9a-f]{32}$/u;

function refuse() {
  const error = new Error(PAIRING_REFUSAL);
  error.code = PAIRING_REFUSAL;
  throw error;
}

// Everything both sides commit to. The client endpoint ID comes from Iroh's
// authenticated handshake on the node side, never from the device's message.
export function pairingTranscript({ nodeId, clientEndpointId, enrollmentId, devicePublicKey }) {
  return Buffer.from(canonicalJson(['cyberbaser.pair.v1', nodeId, clientEndpointId, enrollmentId, devicePublicKey]), 'utf8');
}

export function pairingWords(transcript) {
  const digest = createHash('sha256').update(canonicalJson(['cyberbaser.pair-words.v1', transcript.toString('base64')])).digest();
  return [...digest.subarray(0, 4)].map((byte) => PAIRING_WORDS[byte]);
}

export function pairingMac(secret, transcript) {
  return createHmac('sha256', secret).update(transcript).digest('base64');
}

// `cb1.<node ticket>.<enrollment id>.<secret>`. The ticket names the node and
// how to reach it (relay URL, or direct addresses in loopback tests).
export function formatPairingCode({ ticket, enrollmentId, secret }) {
  return `cb1.${ticket}.${enrollmentId}.${secret.toString('base64url')}`;
}

export function parsePairingCode(code) {
  if (typeof code !== 'string' || code.length > 2048) return null;
  const parts = code.trim().split('.');
  if (parts.length !== 4 || parts[0] !== 'cb1' || !/^[a-z0-9]{8,1800}$/u.test(parts[1]) || !HEX32.test(parts[2])) return null;
  const secret = Buffer.from(parts[3], 'base64url');
  if (secret.length !== 32 || secret.toString('base64url') !== parts[3]) return null;
  return { ticket: parts[1], enrollmentId: parts[2], secret };
}

export function createPairingManager({ ownerId, store, clock = Date.now, random = randomBytes }) {
  if (!boundedText(ownerId, 128) || typeof store?.enrol !== 'function' || typeof clock !== 'function') {
    throw new TypeError('pairing needs the owner, a device store and a clock');
  }
  const pairings = new Map();
  let node = null; // { nodeId, ticket } once the Iroh endpoint is up

  function now() {
    const at = clock();
    if (!Number.isSafeInteger(at) || at < 0) refuse();
    return at;
  }

  function settle(record, outcome) {
    if (record.state === 'enrolled' || record.state === 'closed') return;
    record.state = outcome.ok ? 'enrolled' : 'closed';
    record.secret?.fill(0);
    record.secret = null;
    record.finishedAt = clock();
    for (const resolve of record.waiters.splice(0)) resolve(outcome);
    clearTimeout(record.timer);
  }

  function sweep(at) {
    for (const record of pairings.values()) {
      if (record.state === 'open' && at >= record.expiresAt) settle(record, { ok: false });
      if (record.state === 'awaiting' && at >= record.confirmBy) settle(record, { ok: false });
    }
    const finished = [...pairings.values()].filter((record) => record.state === 'enrolled' || record.state === 'closed');
    for (const record of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED_PAIRINGS))) pairings.delete(record.enrollmentId);
  }

  function view(record) {
    const at = clock();
    return Object.freeze({
      enrollmentId: record.enrollmentId, kind: record.kind, access: record.access, label: record.label,
      grants: [...record.grants], state: record.state === 'awaiting' && at >= record.confirmBy ? 'closed' : record.state,
      expiresAt: record.expiresAt, confirmBy: record.confirmBy ?? null,
      words: record.state === 'awaiting' ? [...record.words] : null, keyId: record.keyId ?? null,
    });
  }

  return Object.freeze({
    attachNode({ nodeId, ticket }) {
      if (!isIrohNodeId(nodeId) || typeof ticket !== 'string') throw new TypeError('invalid node identity');
      node = Object.freeze({ nodeId, ticket });
    },
    available: () => node !== null,

    start({ kind, access, label }) {
      const at = now();
      sweep(at);
      const grants = ACCESS_CHOICES[kind]?.[access];
      if (!node || !Object.hasOwn(ACCESS_CHOICES, kind) || !Object.hasOwn(ACCESS_CHOICES[kind], access) || !grants
        || !boundedText(label, 64)) refuse();
      if ([...pairings.values()].filter((record) => record.state === 'open' || record.state === 'awaiting').length >= MAX_OPEN_PAIRINGS) refuse();
      const enrollmentId = random(16).toString('hex');
      const secret = Buffer.from(random(32));
      if (!HEX32.test(enrollmentId) || secret.length !== 32 || pairings.has(enrollmentId)) refuse();
      const record = { enrollmentId, kind, access, label, grants: Object.freeze([...grants]), secret,
        expiresAt: at + PAIRING_CODE_TTL_MS, state: 'open', waiters: [], timer: null };
      pairings.set(enrollmentId, record);
      return Object.freeze({ enrollmentId, expiresAt: record.expiresAt,
        code: formatPairingCode({ ticket: node.ticket, enrollmentId, secret }) });
    },

    // Called by the carrier with the authenticated remote endpoint ID. The
    // first attempt uses the code up, whether or not it is valid.
    attempt(clientEndpointId, message) {
      const at = now();
      sweep(at);
      const request = plainData(message, ['enrollmentId', 'devicePublicKey', 'mac', 'signature']);
      const record = request && typeof request.enrollmentId === 'string' ? pairings.get(request.enrollmentId) : null;
      if (!record || !node || !isIrohNodeId(clientEndpointId)) refuse();
      if (record.state !== 'open' || at >= record.expiresAt) { settle(record, { ok: false }); refuse(); }
      const secret = record.secret;
      record.state = 'used';
      const publicKeyBytes = decodeBase64(request.devicePublicKey, 32);
      const mac = decodeBase64(request.mac, 32);
      const signature = decodeBase64(request.signature, 64);
      const transcript = publicKeyBytes && pairingTranscript({ nodeId: node.nodeId, clientEndpointId,
        enrollmentId: record.enrollmentId, devicePublicKey: request.devicePublicKey });
      let valid = false;
      try {
        const expected = transcript && Buffer.from(pairingMac(secret, transcript), 'base64');
        valid = Boolean(mac && signature && expected && timingSafeEqual(mac, expected)
          && verify(null, transcript, { key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), publicKeyBytes]), format: 'der', type: 'spki' }, signature));
      } catch { valid = false; }
      if (!valid) { settle(record, { ok: false }); refuse(); }
      record.secret.fill(0);
      record.secret = null;
      record.state = 'awaiting';
      record.clientEndpointId = clientEndpointId;
      record.devicePublicKey = request.devicePublicKey;
      record.words = Object.freeze(pairingWords(transcript));
      record.confirmBy = at + PAIRING_CONFIRM_WINDOW_MS;
      record.timer = setTimeout(() => settle(record, { ok: false }), PAIRING_CONFIRM_WINDOW_MS);
      record.timer.unref?.();
      return Object.freeze({ words: [...record.words] });
    },

    // The device waits on the same connection for the owner's decision.
    result(enrollmentId, clientEndpointId) {
      const record = pairings.get(enrollmentId);
      if (!record || record.clientEndpointId !== clientEndpointId) return Promise.resolve({ ok: false });
      if (record.state === 'enrolled') return Promise.resolve({ ok: true, keyId: record.keyId, grants: [...record.grants] });
      if (record.state !== 'awaiting' && record.state !== 'confirming') return Promise.resolve({ ok: false });
      return new Promise((resolve) => record.waiters.push(resolve));
    },

    // Owner session only. The grants come from the record made at start; the
    // owner's request names the attempt and the words they saw, nothing else.
    async confirm({ enrollmentId, words }) {
      const at = now();
      sweep(at);
      const record = typeof enrollmentId === 'string' ? pairings.get(enrollmentId) : null;
      if (!record || record.state !== 'awaiting' || at >= record.confirmBy) refuse();
      if (!Array.isArray(words) || words.length !== 4 || words.some((word, i) => word !== record.words[i])) {
        settle(record, { ok: false });
        refuse();
      }
      record.state = 'confirming';
      try {
        const entry = await store.enrol({ kind: record.kind, label: record.label, grants: [...record.grants],
          publicKey: record.devicePublicKey, irohNodeId: record.clientEndpointId });
        record.keyId = entry.keyId;
        record.state = 'awaiting';
        settle(record, { ok: true, keyId: entry.keyId, grants: [...record.grants] });
        return Object.freeze({ keyId: entry.keyId });
      } catch {
        record.state = 'awaiting';
        settle(record, { ok: false });
        refuse();
      }
    },

    cancel(enrollmentId) {
      const record = typeof enrollmentId === 'string' ? pairings.get(enrollmentId) : null;
      if (!record) refuse();
      settle(record, { ok: false });
    },

    list() {
      sweep(clock());
      return [...pairings.values()].filter((record) => record.state !== 'closed' && record.state !== 'enrolled').map(view);
    },
    get: (enrollmentId) => (pairings.has(enrollmentId) ? view(pairings.get(enrollmentId)) : null),
  });
}

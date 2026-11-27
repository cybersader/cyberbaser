// Byte-for-byte the same envelopes the owner node verifies
// (apps/owner-alpha/src/core/signed-request.js, pairing.js, iroh-carrier.js),
// built with WebCrypto only so it runs in Obsidian desktop and mobile.

const encoder = new TextEncoder();
const subtle = () => globalThis.crypto.subtle;

export const CMD_ALPN = 'cyberbaser/cmd/1';
export const PAIR_ALPN = 'cyberbaser/pair/1';
const COMMAND_DOMAIN = 'cyberbaser.owner-command.v1';

export function utf8(text) {
  return encoder.encode(text);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// Same rules as the node: sorted keys, JSON.stringify spelling, finite numbers.
export function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON requires finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  throw new TypeError('canonical JSON accepts only JSON-compatible values');
}

export function toBase64(bytes) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

export function fromBase64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function fromBase64Url(text) {
  if (!/^[A-Za-z0-9_-]*$/u.test(text)) return null;
  const padded = text.replaceAll('-', '+').replaceAll('_', '/');
  try { return fromBase64(padded + '='.repeat((4 - (padded.length % 4)) % 4)); } catch { return null; }
}

export function hex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function sha256(bytes) {
  return new Uint8Array(await subtle().digest('SHA-256', bytes));
}

export function frame(value) {
  return utf8(`${canonicalJson(value)}\n`);
}

export function parseReply(bytes) {
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

// ---- Pairing ----

// The same 256 words as the node (a test checks they are identical).
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

export function pairingTranscript({ nodeId, clientEndpointId, enrollmentId, devicePublicKey }) {
  return utf8(canonicalJson(['cyberbaser.pair.v1', nodeId, clientEndpointId, enrollmentId, devicePublicKey]));
}

export async function pairingWords(transcript) {
  const digest = await sha256(utf8(canonicalJson(['cyberbaser.pair-words.v1', toBase64(transcript)])));
  return [...digest.subarray(0, 4)].map((byte) => PAIRING_WORDS[byte]);
}

export async function pairingMac(secret, transcript) {
  const key = await subtle().importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toBase64(new Uint8Array(await subtle().sign('HMAC', key, transcript)));
}

// ---- Device key (Ed25519, non-extractable private half) ----

export async function createDeviceKey() {
  const pair = await subtle().generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
  const publicKey = toBase64(new Uint8Array(await subtle().exportKey('raw', pair.publicKey)));
  return { privateKey: pair.privateKey, publicKey };
}

export async function signWith(privateKey, bytes) {
  return toBase64(new Uint8Array(await subtle().sign({ name: 'Ed25519' }, privateKey, bytes)));
}

// ---- Signed command envelope ----

export async function channelBinding({ nodeId, clientEndpointId, challenge }) {
  return toBase64(await sha256(utf8(canonicalJson(['cyberbaser.iroh-binding.v1', nodeId, clientEndpointId, toBase64(challenge)]))));
}

export async function inputDigest(input) {
  return hex(await sha256(utf8(canonicalJson(input))));
}

export function claimsBytes(claims) {
  return utf8(canonicalJson([COMMAND_DOMAIN, claims.audience, claims.keyId, claims.command,
    claims.inputDigest, claims.nonce, claims.issuedAt, claims.channelBinding ?? null]));
}

export async function signedEnvelope({ privateKey, keyId, audience, command, input, channelBinding: binding, now = Date.now() }) {
  const claims = { audience, keyId, command, inputDigest: await inputDigest(input),
    nonce: toBase64(globalThis.crypto.getRandomValues(new Uint8Array(16))), issuedAt: now, channelBinding: binding };
  return { ...claims, input, signature: await signWith(privateKey, claimsBytes(claims)) };
}

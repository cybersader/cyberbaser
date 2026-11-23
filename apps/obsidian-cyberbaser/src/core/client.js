import { parsePairingCode } from './pairing-code.js';
import {
  channelBinding, CMD_ALPN, createDeviceKey, fromBase64, frame, PAIR_ALPN, pairingMac, pairingTranscript,
  pairingWords, parseReply, signedEnvelope, signWith,
} from './wire.js';

// Talks to the owner node through a carrier: open(secret, ticket, alpn) gives
// a session with nodeId(), endpointId(), exchange(bytes) and close(). In the
// plugin that is the Iroh WASM build; in tests it can be the node's own
// bindings. One request per stream, exactly like the agent CLI.

export const CONNECT_TIMEOUT_MS = 20_000;
export const REQUEST_TIMEOUT_MS = 20_000;
export const CONFIRM_TIMEOUT_MS = 7 * 60_000;
// The node reads at most 512 KiB per request; leave room for the envelope.
export const MAX_NOTE_BYTES = 400 * 1024;

export class NodeError extends Error {
  constructor(kind, reason = null) {
    super(kind);
    this.kind = kind; // 'unreachable' | 'refused' | 'invalid-code' | 'words-mismatch' | 'too-large'
    this.reason = reason;
  }
}

function withTimeout(promise, ms, kind = 'unreachable') {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new NodeError(kind)), ms);
  })]).finally(() => clearTimeout(timer));
}

async function exchange(session, value, ms = REQUEST_TIMEOUT_MS) {
  const bytes = await withTimeout(session.exchange(frame(value)), ms);
  return parseReply(bytes);
}

async function openSession(carrier, secret, ticket, alpn) {
  try {
    return await withTimeout(carrier.open(secret, ticket, alpn), CONNECT_TIMEOUT_MS);
  } catch (error) {
    if (error instanceof NodeError) throw error;
    throw new NodeError('unreachable');
  }
}

export function createNodeClient({ carrier, random = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n)), now = Date.now }) {
  return Object.freeze({
    // Pair with a code from the node's Devices page. onWords(words) shows the
    // four words; the node enrols nothing until the owner confirms them there.
    async pair(code, { onWords = () => {} } = {}) {
      const parsed = parsePairingCode(code);
      if (!parsed) throw new NodeError('invalid-code');
      const device = await createDeviceKey();
      const irohSecret = random(32);
      const session = await openSession(carrier, irohSecret, parsed.ticket, PAIR_ALPN);
      try {
        const nodeId = session.nodeId();
        const transcript = pairingTranscript({ nodeId, clientEndpointId: session.endpointId(),
          enrollmentId: parsed.enrollmentId, devicePublicKey: device.publicKey });
        const words = await pairingWords(transcript);
        let reply;
        try {
          reply = await exchange(session, { enrollmentId: parsed.enrollmentId, devicePublicKey: device.publicKey,
            mac: await pairingMac(parsed.secret, transcript), signature: await signWith(device.privateKey, transcript) });
        } finally { parsed.secret.fill(0); }
        if (reply?.ok !== true) throw new NodeError('refused');
        // The node derived its words from what it actually received; if they
        // differ, something altered the request on the way. Stop here.
        if (!Array.isArray(reply.words) || reply.words.join(' ') !== words.join(' ')) throw new NodeError('words-mismatch');
        onWords(words);
        const outcome = await exchange(session, { type: 'await' }, CONFIRM_TIMEOUT_MS);
        if (outcome?.ok !== true || typeof outcome.keyId !== 'string' || typeof outcome.audience !== 'string') {
          throw new NodeError('refused');
        }
        return { version: 1, keyId: outcome.keyId, audience: outcome.audience,
          grants: Array.isArray(outcome.grants) ? outcome.grants.filter((grant) => typeof grant === 'string') : [],
          ticket: parsed.ticket, nodeId, publicKey: device.publicKey, privateKey: device.privateKey,
          irohSecret, pairedAt: now() };
      } finally {
        await Promise.resolve(session.close()).catch(() => {});
      }
    },

    // One signed command over a fresh connection, bound to it by a node challenge.
    async request(pairing, command, input) {
      const session = await openSession(carrier, pairing.irohSecret, pairing.ticket, CMD_ALPN);
      try {
        if (session.nodeId() !== pairing.nodeId) throw new NodeError('refused');
        const challengeReply = await exchange(session, { type: 'challenge' });
        if (challengeReply?.ok !== true || typeof challengeReply.challenge !== 'string') throw new NodeError('refused');
        const binding = await channelBinding({ nodeId: pairing.nodeId, clientEndpointId: session.endpointId(),
          challenge: fromBase64(challengeReply.challenge) });
        const envelope = await signedEnvelope({ privateKey: pairing.privateKey, keyId: pairing.keyId,
          audience: pairing.audience, command, input, channelBinding: binding, now: now() });
        const reply = await exchange(session, envelope);
        if (reply?.ok !== true) throw new NodeError('refused', typeof reply?.reason === 'string' ? reply.reason : null);
        return reply.receipt;
      } catch (error) {
        if (error instanceof NodeError) throw error;
        throw new NodeError('unreachable');
      } finally {
        await Promise.resolve(session.close()).catch(() => {});
      }
    },
  });
}

// What "Send to Cyberbaser" sends: the vault path and the text as open now.
export function capturePayload(file, text) {
  if (typeof file?.path !== 'string' || !file.path.endsWith('.md')) throw new NodeError('refused', 'capture-path-refused');
  if (new TextEncoder().encode(text).length > MAX_NOTE_BYTES) throw new NodeError('too-large');
  return { path: file.path, text };
}

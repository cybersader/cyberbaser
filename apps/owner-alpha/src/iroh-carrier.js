import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { link, open, rm } from 'node:fs/promises';
import path from 'node:path';
import { Endpoint, EndpointAddr, EndpointTicket, RelayMode, SecretKey, presetMinimal } from '@number0/iroh';
import { executeSigned } from './core/commands.js';
import { readPrivateKeyJson } from './core/device-key-files.js';
import { decodeBase64, isIrohNodeId, plainData } from './core/device-keys.js';
import { PAIRING_REFUSAL } from './core/pairing.js';
import { canonicalJson } from './json.js';
import { SIGNED_REQUEST_MAX_BYTES, SIGNED_REQUEST_REFUSAL } from './signed-request-socket.js';

// The owner node's Iroh carrier. Two ALPNs:
//   cyberbaser/cmd/1   the same signed envelopes the local Unix socket accepts
//   cyberbaser/pair/1  enrolment of a new device or agent (see core/pairing.js)
// One request per bidirectional stream, canonical JSON plus a newline, the same
// 512 KiB cap, five-second read deadline and single generic refusal.

export const CMD_ALPN = 'cyberbaser/cmd/1';
export const PAIR_ALPN = 'cyberbaser/pair/1';
// n0's public relay: the one explicit default when Iroh is enabled without a
// relay setting. Never used as a fallback for a configured relay.
export const N0_PUBLIC_RELAY_URL = 'https://use1-1.relay.n0.iroh.link./';
const NODE_SECRET_FILE = 'iroh-node.json';
const REFUSED = Object.freeze({ ok: false, code: SIGNED_REQUEST_REFUSAL });
const PAIR_REFUSED = Object.freeze({ ok: false, code: PAIRING_REFUSAL });
const MAX_CONNECTIONS = 8;
const MAX_REQUESTS_PER_CONNECTION = 16;
const READ_TIMEOUT_MS = 5000;
const IDLE_TIMEOUT_MS = 30_000;

// Signed commands this carrier accepts. Everything else gets the generic
// refusal before any verification work.
export const IROH_COMMANDS = Object.freeze(['submitProposal', 'submitCapture', 'readNoteStatus',
  'preparePublication', 'publish', 'readPublicationReceipt']);
// After a request verified, a command's own refusal may name one of these
// fixed reasons so the device can say something useful. Signature, key, grant
// and binding failures stay the single generic refusal.
export const IROH_REFUSAL_REASONS = Object.freeze(['proposal-budget-exhausted', 'capture-path-refused',
  'capture-base-unavailable', 'capture-too-large', 'delivery-not-round-trippable', 'workspace-diff-too-complex',
  'publication-candidate-mismatch', 'publication-expected-source-mismatch', 'workspace-unbound',
  'delivery-moved-since-baseline', 'workspace-diverged', 'publication-read-only', 'publication-disabled',
  'workspace-text-repeated', 'workspace-properties-invalid', 'retired-material', 'publication-draft-not-found',
  'note-needs-linking']);
const PAIR_WAIT_MS = 6 * 60_000;

const alpnBytes = (name) => [...Buffer.from(name, 'utf8')];
const sameAlpn = (bytes, name) => Buffer.from(bytes).toString('utf8') === name;

export function irohAudience(nodeId) {
  return `cyberbaser.owner.iroh.v1:${nodeId}`;
}

// Why this replaces the TLS exporter used in the browser spike: the JavaScript
// bindings expose the peer's authenticated endpoint ID (Connection.remoteId(),
// proved by Iroh's TLS handshake) but not export_keying_material. A signature
// over this value is still useless anywhere else: it names this node, the
// authenticated client endpoint, and a fresh 32-byte challenge the node issued
// on this connection and accepts once. Another connection gets another
// challenge; another endpoint has another ID; the device record also names the
// one endpoint allowed to present its key.
export function irohChannelBinding({ nodeId, clientEndpointId, challenge }) {
  return createHash('sha256')
    .update(canonicalJson(['cyberbaser.iroh-binding.v1', nodeId, clientEndpointId, Buffer.from(challenge).toString('base64')]))
    .digest();
}

export function relayMode(relay) {
  if (relay === 'none') return RelayMode.disabled();
  return RelayMode.customFromUrls([relay === 'n0' ? N0_PUBLIC_RELAY_URL : relay]);
}

export function relayUrlFor(relay) {
  return relay === 'none' ? null : relay === 'n0' ? N0_PUBLIC_RELAY_URL : relay;
}

// The node's Iroh identity. Created once, owner-only, outside the vault; its
// bytes never enter the policy revision, logs or responses.
export async function loadNodeSecret(directory) {
  const file = path.join(directory, NODE_SECRET_FILE);
  try {
    const record = plainData(await readPrivateKeyJson(file, 1024), ['secretKey']);
    const bytes = record && decodeBase64(record.secretKey, 32);
    if (!bytes) throw new Error('invalid node secret');
    return bytes;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw new Error('Iroh node secret is unreadable or unsafe');
  }
  const bytes = Buffer.from(SecretKey.generate().toBytes());
  const temporary = path.join(directory, `.tmp-${randomBytes(8).toString('hex')}`);
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify({ secretKey: bytes.toString('base64') })}\n`);
    await handle.sync();
  } finally { await handle.close(); }
  try { await link(temporary, file); } finally { await rm(temporary, { force: true }); }
  return bytes;
}

export async function bindEndpoint({ secretKey, relay, bindAddress = null, alpns = [] }) {
  const builder = Endpoint.builder();
  presetMinimal(builder); // no discovery publishing
  builder.secretKey([...secretKey]);
  builder.relayMode(relayMode(relay));
  builder.alpns(alpns.map(alpnBytes));
  if (bindAddress !== null) builder.bindAddr(bindAddress);
  return builder.bind();
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); })])
    .finally(() => clearTimeout(timer));
}

async function readFrame(recv) {
  const bytes = Buffer.from(await withTimeout(recv.readToEnd(SIGNED_REQUEST_MAX_BYTES), READ_TIMEOUT_MS));
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (!text.endsWith('\n') || text.indexOf('\n') !== text.length - 1) throw new Error('frame');
  const line = text.slice(0, -1);
  const value = JSON.parse(line);
  // Canonical wire JSON rejects duplicate members and alternative spellings.
  if (canonicalJson(value) !== line) throw new Error('frame');
  return value;
}

// What a device gets back: a small fixed projection per command, never a
// draft's text, session or private references.
const PROJECTIONS = Object.freeze({
  preparePublication: (result) => (result.outcome === 'unchanged' ? { outcome: 'unchanged' } : {
    outcome: 'prepared', draftId: result.summary.draftId, jobId: result.summary.jobId,
    capturedVersion: result.summary.capturedVersion, candidateDigest: result.summary.candidateDigest }),
  publish: (result) => ({ draftId: result.draftId, jobId: result.jobId, state: result.state,
    capturedVersion: result.capturedVersion, replayed: result.replayed }),
});

function plainReceipt(command, value) {
  return JSON.parse(JSON.stringify(PROJECTIONS[command]?.(value) ?? value));
}

async function writeFrame(send, value) {
  await send.writeAll([...Buffer.from(`${canonicalJson(value)}\n`, 'utf8')]);
  await send.finish();
}

// Start the carrier on an already bound endpoint. `verifier` is the device
// principal adapter for this node's Iroh audience; `pairing` may be null.
export function startIrohCarrier({ endpoint, commands, verifier, pairing = null, relay }) {
  const nodeId = endpoint.id().toString();
  const connections = new Map(); // connection -> remote endpoint id
  let closing = null;

  async function serveCommands(connection, remote) {
    let challenge = null;
    for (let count = 0; count < MAX_REQUESTS_PER_CONNECTION * 2; count += 1) {
      const stream = await withTimeout(connection.acceptBi(), IDLE_TIMEOUT_MS);
      let response = REFUSED;
      try {
        const message = await readFrame(stream.recv);
        if (plainData(message, ['type'])?.type === 'challenge') {
          // One outstanding challenge per connection, consumed by the next request.
          challenge = randomBytes(32);
          response = { ok: true, challenge: challenge.toString('base64') };
        } else {
          const issued = challenge;
          challenge = null;
          if (issued !== null && IROH_COMMANDS.includes(message?.command)) {
            const binding = irohChannelBinding({ nodeId, clientEndpointId: remote, challenge: issued });
            const receipt = await executeSigned(commands, verifier.forChannel(binding, { peer: remote }), message);
            response = { ok: true, receipt: plainReceipt(message.command, receipt) };
          }
        }
      } catch (error) {
        response = IROH_REFUSAL_REASONS.includes(error?.code) ? { ...REFUSED, reason: error.code } : REFUSED;
      }
      await writeFrame(stream.send, response).catch(() => {});
    }
  }

  async function servePairing(connection, remote) {
    if (pairing === null) return;
    const first = await withTimeout(connection.acceptBi(), READ_TIMEOUT_MS);
    let enrollmentId = null;
    try {
      const message = await readFrame(first.recv);
      const { words } = pairing.attempt(remote, message);
      enrollmentId = message.enrollmentId;
      await writeFrame(first.send, { ok: true, words });
    } catch {
      await writeFrame(first.send, PAIR_REFUSED).catch(() => {});
      return;
    }
    const second = await withTimeout(connection.acceptBi(), PAIR_WAIT_MS);
    try {
      if (plainData(await readFrame(second.recv), ['type'])?.type !== 'await') throw new Error('frame');
      const outcome = await withTimeout(pairing.result(enrollmentId, remote), PAIR_WAIT_MS);
      // The device learns the grants the owner picked, so it can offer only
      // what it may do. The node still checks every grant on every request.
      await writeFrame(second.send, outcome.ok
        ? { ok: true, keyId: outcome.keyId, audience: irohAudience(nodeId), grants: outcome.grants } : PAIR_REFUSED);
    } catch {
      await writeFrame(second.send, PAIR_REFUSED).catch(() => {});
    }
  }

  async function handle(incoming) {
    let connection;
    try {
      const accepting = await withTimeout(incoming.accept(), READ_TIMEOUT_MS);
      connection = await withTimeout(accepting.connect(), READ_TIMEOUT_MS);
      const remote = connection.remoteId().toString();
      if (!isIrohNodeId(remote)) throw new Error('peer');
      connections.set(connection, remote);
      const alpn = connection.alpn();
      if (sameAlpn(alpn, CMD_ALPN)) await serveCommands(connection, remote);
      else if (sameAlpn(alpn, PAIR_ALPN)) await servePairing(connection, remote);
    } catch { /* never log request details or peer identities */ }
    finally {
      if (connection) {
        connections.delete(connection);
        // Let the peer read the last reply before the connection goes away.
        await withTimeout(connection.closed(), 2000).catch(() => {});
        try { connection.close(0n, []); } catch { /* already closed */ }
      }
    }
  }

  const accepting = (async () => {
    while (closing === null) {
      const incoming = await endpoint.acceptNext().catch(() => null);
      if (incoming === null) break;
      if (closing !== null || connections.size >= MAX_CONNECTIONS) { void incoming.refuse().catch(() => {}); continue; }
      void handle(incoming);
    }
  })();

  const addr = new EndpointAddr(endpoint.id(), relayUrlFor(relay), relay === 'none' ? endpoint.boundSockets() : []);
  const ticket = EndpointTicket.fromAddr(addr).toString();

  return Object.freeze({
    nodeId,
    ticket,
    audience: irohAudience(nodeId),
    // Revocation already makes every later request fail; this also drops the
    // revoked endpoint's open connections at once.
    closePeer(irohNodeId) {
      for (const [connection, remote] of connections) {
        if (remote === irohNodeId) { try { connection.close(1n, []); } catch { /* closed */ } }
      }
    },
    close() {
      closing ??= (async () => {
        for (const connection of connections.keys()) { try { connection.close(0n, []); } catch { /* closed */ } }
        await endpoint.close().catch(() => {});
        await accepting.catch(() => {});
      })();
      return closing;
    },
  });
}

// ---- Client side (agents) ----

export async function connectToNode({ secretKey, ticket, alpn }) {
  const target = EndpointTicket.fromString(ticket).endpointAddr();
  const relayUrl = target.relayUrl();
  const endpoint = await bindEndpoint({ secretKey, relay: relayUrl === null ? 'none' : relayUrl, alpns: [] });
  try {
    const connection = await withTimeout(endpoint.connect(target, alpnBytes(alpn)), 30_000);
    return { endpoint, connection, nodeId: target.id().toString(), clientEndpointId: endpoint.id().toString() };
  } catch (error) {
    await endpoint.close().catch(() => {});
    throw error;
  }
}

export async function exchange(connection, value, timeoutMs = 15_000) {
  const stream = await connection.openBi();
  await writeFrame(stream.send, value);
  const bytes = Buffer.from(await withTimeout(stream.recv.readToEnd(SIGNED_REQUEST_MAX_BYTES), timeoutMs));
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

// Ask for a challenge, let the caller sign with the resulting binding, send.
export async function sendSignedRequestOverIroh({ secretKey, ticket, sign }) {
  let session;
  try {
    session = await connectToNode({ secretKey, ticket, alpn: CMD_ALPN });
    const { connection, nodeId, clientEndpointId } = session;
    const reply = await exchange(connection, { type: 'challenge' });
    const challenge = reply?.ok === true ? decodeBase64(reply.challenge, 32) : null;
    if (!challenge) return REFUSED;
    const channelBinding = irohChannelBinding({ nodeId, clientEndpointId, challenge }).toString('base64');
    const envelope = sign({ audience: irohAudience(nodeId), channelBinding });
    if (Buffer.byteLength(`${canonicalJson(envelope)}\n`) > SIGNED_REQUEST_MAX_BYTES) return REFUSED;
    return await exchange(connection, envelope);
  } catch {
    return REFUSED;
  } finally {
    if (session) {
      try { session.connection.close(0n, []); } catch { /* closed */ }
      await session.endpoint.close().catch(() => {});
    }
  }
}

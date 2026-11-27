import { afterEach, expect, test } from 'bun:test';
import { createPublicKey, randomBytes, verify } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
// The node's own code, to prove the plugin speaks exactly its protocol.
import { validateOwnerAlphaConfig } from '../../owner-alpha/src/config.js';
import { createOwnerCommands } from '../../owner-alpha/src/core/commands.js';
import { openDeviceStore } from '../../owner-alpha/src/core/device-store.js';
import * as nodePairing from '../../owner-alpha/src/core/pairing.js';
import { createDevicePrincipalAdapter } from '../../owner-alpha/src/core/principal.js';
import { signedInputDigest, signedRequestBytes } from '../../owner-alpha/src/core/signed-request.js';
import { bindEndpoint, CMD_ALPN, connectToNode, irohAudience, irohChannelBinding, PAIR_ALPN, startIrohCarrier } from '../../owner-alpha/src/iroh-carrier.js';
import { capturePayload, createNodeClient, MAX_NOTE_BYTES, NodeError } from '../src/core/client.js';
import { createController, messageFor, publicSettings } from '../src/core/controller.js';
import { createDeviceStore, memoryBackend } from '../src/core/device-store.js';
import { codeFromLink, pairingLink, parsePairingCode } from '../src/core/pairing-code.js';
import { describeStatus, foldText, needsMark, STATUS, statusFor, textDigests } from '../src/core/status.js';
import { createNoteStatus } from '../../owner-alpha/src/note-status.js';
import * as wire from '../src/core/wire.js';

const cleanup = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });

// ---- Same bytes as the node ----

test('wire: envelopes, bindings and pairing values match the node byte for byte', async () => {
  const input = { path: 'Notes/a.md', text: 'héllo\r\n', n: [1, 2.5, null, true], nested: { b: 1, a: 'x' } };
  expect(await wire.inputDigest(input)).toBe(signedInputDigest(input));
  const claims = { audience: 'cyberbaser.owner.iroh.v1:ab', keyId: 'device-1', command: 'submitCapture',
    inputDigest: signedInputDigest(input), nonce: randomBytes(16).toString('base64'), issuedAt: 1_800_000_000_000,
    channelBinding: randomBytes(32).toString('base64') };
  expect(Buffer.from(wire.claimsBytes(claims)).equals(signedRequestBytes(claims))).toBe(true);
  const nodeId = 'a'.repeat(64); const clientEndpointId = 'b'.repeat(64); const challenge = randomBytes(32);
  expect(await wire.channelBinding({ nodeId, clientEndpointId, challenge: new Uint8Array(challenge) }))
    .toBe(irohChannelBinding({ nodeId, clientEndpointId, challenge }).toString('base64'));
  expect([...wire.PAIRING_WORDS]).toEqual([...nodePairing.PAIRING_WORDS]);
  const fields = { nodeId, clientEndpointId, enrollmentId: 'c'.repeat(32), devicePublicKey: randomBytes(32).toString('base64') };
  const transcript = wire.pairingTranscript(fields);
  expect(Buffer.from(transcript).equals(nodePairing.pairingTranscript(fields))).toBe(true);
  expect(await wire.pairingWords(transcript)).toEqual(nodePairing.pairingWords(Buffer.from(transcript)));
  const secret = randomBytes(32);
  expect(await wire.pairingMac(new Uint8Array(secret), transcript)).toBe(nodePairing.pairingMac(secret, Buffer.from(transcript)));
});

test('wire: the WebCrypto device key signs what the node verifies, and its private half cannot be exported', async () => {
  const key = await wire.createDeviceKey();
  expect(key.privateKey.extractable).toBe(false);
  await expect(crypto.subtle.exportKey('pkcs8', key.privateKey)).rejects.toThrow();
  const message = wire.utf8('cyberbaser');
  const signature = Buffer.from(await wire.signWith(key.privateKey, message), 'base64');
  const spki = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(key.publicKey, 'base64')]), format: 'der', type: 'spki' });
  expect(verify(null, message, spki, signature)).toBe(true);
});

test('pairing code: same parsing as the node; the link carries the code', () => {
  const ticket = 'endpointabc123def456';
  const secret = randomBytes(32);
  const code = `cb1.${ticket}.${'0'.repeat(32)}.${secret.toString('base64url')}`;
  const parsed = parsePairingCode(code);
  const node = nodePairing.parsePairingCode(code);
  expect(parsed.ticket).toBe(node.ticket);
  expect(parsed.enrollmentId).toBe(node.enrollmentId);
  expect(Buffer.from(parsed.secret).equals(node.secret)).toBe(true);
  for (const bad of ['', 'cb2.x.y.z', `cb1.${ticket}.${'0'.repeat(31)}.${secret.toString('base64url')}`, `cb1.${ticket}.${'0'.repeat(32)}.abc`, `cb1.UPPER${ticket}.${'0'.repeat(32)}.${secret.toString('base64url')}`]) {
    expect(parsePairingCode(bad)).toBe(null);
  }
  expect(pairingLink(code)).toBe(`obsidian://cyberbaser-pair?code=${encodeURIComponent(code)}`);
  expect(codeFromLink({ action: 'cyberbaser-pair', code })).toBe(code);
  expect(codeFromLink({ action: 'cyberbaser-pair', c: code })).toBe(code);
  expect(codeFromLink({ action: 'cyberbaser-pair' })).toBe(null);
});

// ---- Status ----

test('status: every node answer maps to one plain label', async () => {
  const text = '# Note\r\nBody\r\n';
  const digests = await textDigests(text);
  expect(foldText('\uFEFFa\r\nb\rc')).toBe('a\nb\nc');
  expect(foldText('a\uFEFFb')).toBe(null);
  const live = (digest, folded = true) => ({ reply: { selected: true, live: { version: 2, digest, folded } } });
  expect(statusFor(live(digests.folded), digests).label).toBe(STATUS.live);
  expect(statusFor(live(digests.exact, false), digests).label).toBe(STATUS.live);
  expect(statusFor(live('sha-256=:other:'), digests)).toMatchObject({ label: 'Live, older version', version: 2 });
  expect(statusFor({ reply: { selected: true, live: null } }, digests).label).toBe('Public, not confirmed yet');
  expect(statusFor({ reply: { selected: false } }, digests).label).toBe('Not public');
  expect(statusFor({ paired: false }).label).toBe('Not paired');
  expect(statusFor({ unreachable: true }).label).toBe("Can't reach your node");
  expect(statusFor({ refused: true }).label).toBe('Status needs full access');
  // Quiet by default: only a note with changes the site lacks earns a mark.
  const keys = ['live', 'older', 'pending', 'notSelected', 'notPaired', 'unreachable', 'noAccess', 'checking'];
  expect(keys.filter((key) => needsMark({ key }))).toEqual(['older']);
  // On demand, with the time the node confirmed it live.
  const at = '2026-11-23T10:00:00.000Z';
  const withTime = statusFor({ reply: { selected: true, live: { digest: digests.folded, folded: true, at } } }, digests);
  expect(withTime).toMatchObject({ key: 'live', at });
  expect(describeStatus(withTime)).toStartWith('Live. Confirmed on your site ');
  expect(describeStatus(statusFor({ reply: { selected: true, live: { digest: 'sha-256=:x:', folded: true, at } } }, digests)))
    .toContain('this note has changes since');
  expect(describeStatus(statusFor({ reply: { selected: false } }, digests))).toBe('Not public');
});

test('links: the obsidian:// link the QR carries opens pairing with the exact code', () => {
  const code = `cb1.endpointabc123.${'0'.repeat(32)}.${randomBytes(32).toString('base64url')}`;
  const link = pairingLink(code);
  // Obsidian hands the handler the decoded query, as URLSearchParams would.
  const params = Object.fromEntries(new URL(link).searchParams);
  expect(codeFromLink(params)).toBe(code);
  expect(parsePairingCode(codeFromLink(params))).not.toBe(null);
});

// ---- Capture payload ----

test('capture: the path and text exactly as open, bounded below the node frame limit', () => {
  expect(capturePayload({ path: 'Notes/a.md' }, 'x\r\ny')).toEqual({ path: 'Notes/a.md', text: 'x\r\ny' });
  expect(() => capturePayload({ path: 'Notes/a.canvas' }, 'x')).toThrow(NodeError);
  expect(() => capturePayload({ path: 'a.md' }, 'é'.repeat(MAX_NOTE_BYTES / 2 + 1))).toThrow(NodeError);
  expect(MAX_NOTE_BYTES).toBeLessThan(512 * 1024);
  expect(messageFor(new NodeError('refused', 'capture-base-unavailable'))).toBe('Your vault has no committed copy of this note yet.');
  expect(messageFor(new NodeError('unreachable'))).toBe("Can't reach your node.");
  expect(messageFor(new NodeError('refused', 'note-needs-linking'))).toContain('open Devices and link it');
});

// ---- Storage: never in synced plugin data ----

test('storage: the pairing goes to device storage only; synced settings carry display choices alone', async () => {
  const backend = memoryBackend();
  const store = createDeviceStore(backend, 'vault:test');
  const device = await wire.createDeviceKey();
  const irohSecret = new Uint8Array(randomBytes(32));
  const record = { version: 1, keyId: 'phone-abc', audience: 'cyberbaser.owner.iroh.v1:x', grants: ['propose'],
    ticket: 'endpointabc', nodeId: 'd'.repeat(64), publicKey: device.publicKey, privateKey: device.privateKey, irohSecret, pairedAt: 1 };
  const client = { pair: async () => record, request: async () => { throw new NodeError('unreachable'); } };
  const controller = createController({ client, store });
  // A plugin that (wrongly) merged everything into its settings would leak; publicSettings drops it.
  const settings = { showMark: true };
  const paired = await controller.pair('cb1.x');
  Object.assign(settings, paired, { pairing: record });
  const synced = JSON.stringify(publicSettings(settings));
  expect(synced).toBe('{"showMark":true}');
  // The older setting name keeps its choice.
  expect(publicSettings({ showStatus: false })).toEqual({ showMark: false });
  for (const secret of [Buffer.from(irohSecret).toString('base64'), 'phone-abc', device.publicKey]) expect(synced).not.toContain(secret);
  expect(backend.map.get('vault:test').irohSecret).toBe(irohSecret);
  expect(await controller.paired()).toEqual({ keyId: 'phone-abc', grants: ['propose'], pairedAt: 1 });
  // Another vault on the same device has its own scope.
  expect(await createDeviceStore(backend, 'vault:other').load()).toBe(null);
  await controller.unpair();
  expect(backend.map.size).toBe(0);
  expect((await controller.status({ path: 'a.md' }, 'x')).status.label).toBe('Not paired');
});

// ---- Against the real node carrier (node bindings stand in for the WASM build) ----

function nodeBindingsCarrier() {
  return {
    async open(secret, ticket, alpn) {
      const session = await connectToNode({ secretKey: Buffer.from(secret), ticket, alpn });
      return {
        nodeId: () => session.nodeId,
        endpointId: () => session.clientEndpointId,
        async exchange(bytes) {
          const stream = await session.connection.openBi();
          await stream.send.writeAll([...bytes]);
          await stream.send.finish();
          return new Uint8Array(await stream.recv.readToEnd(512 * 1024));
        },
        async close() { try { session.connection.close(0n, []); } catch { /* closed */ } await session.endpoint.close(); },
      };
    },
  };
}

async function tempDir() {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'cb-plugin-')));
  await chmod(dir, 0o700);
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('client: pairs with the real pairing manager, then sends a capture and asks for status over Iroh', async () => {
  const example = await Bun.file(new URL('../../owner-alpha/owner-alpha.example.json', import.meta.url)).json();
  const root = await tempDir();
  const checkout = path.join(root, 'vault');
  await mkdir(checkout);
  await writeFile(path.join(checkout, 'garden.md'), '# Garden\n\nWater daily.\n');
  await writeFile(path.join(checkout, 'private.md'), '# Private\n');
  await writeFile(path.join(checkout, 'publish.yml'), 'allow:\n  - garden.md\n');
  const git = (...args) => execFileSync('git', ['-C', checkout, '-c', 'commit.gpgSign=false', ...args]);
  git('init', '-q', '--initial-branch=main'); git('config', 'user.name', 'T'); git('config', 'user.email', 't@example.invalid');
  git('add', '-A'); git('commit', '-q', '-m', 'base');
  const config = validateOwnerAlphaConfig({ ...example, repository: { ...example.repository, checkout },
    proposalReview: { ...example.proposalReview, enabled: true, socketPath: path.join(root, 'review.sock') } });
  const store = await openDeviceStore({ directory: path.join(root, 'devices'), ownerId: config.owner.identity, parentDirectory: root });
  const pairing = nodePairing.createPairingManager({ ownerId: config.owner.identity, store });
  const endpoint = await bindEndpoint({ secretKey: randomBytes(32), relay: 'none', bindAddress: '127.0.0.1:0', alpns: [CMD_ALPN, PAIR_ALPN] });
  const nodeId = endpoint.id().toString();
  const verifier = createDevicePrincipalAdapter({ registry: store.registry, audience: irohAudience(nodeId), requireChannelBinding: true });
  const submitted = [];
  const noteStatus = createNoteStatus({ config, context: null, listJobs: async () => [] });
  const commands = createOwnerCommands({ config, devicePrincipalAdapter: verifier, noteStatus,
    proposalReview: { submitSigned: async (input) => { submitted.push(input); return { queueId: `Q-${crypto.randomUUID()}`, acceptedAt: '2026-11-23T10:00:00Z', baseBound: true }; } } });
  const carrier = startIrohCarrier({ endpoint, commands, verifier, pairing, relay: 'none' });
  pairing.attachNode({ nodeId, ticket: carrier.ticket });
  cleanup.push(() => carrier.close());

  const backend = memoryBackend();
  const controller = createController({ client: createNodeClient({ carrier: nodeBindingsCarrier() }), store: createDeviceStore(backend, 'vault:t') });
  const started = pairing.start({ kind: 'owner-device', access: 'propose', label: 'Phone' });
  let shown = null;
  const paired = controller.pair(started.code, { onWords: (words) => { shown = words; } });
  // The owner sees the same words on the node and confirms.
  let pending;
  for (let i = 0; i < 100 && !pending; i += 1) {
    pending = pairing.list().find((item) => item.enrollmentId === started.enrollmentId && item.state === 'awaiting');
    if (!pending) await Bun.sleep(50);
  }
  for (let i = 0; i < 100 && !shown; i += 1) await Bun.sleep(20);
  expect(shown).toEqual(pending.words);
  await pairing.confirm({ enrollmentId: started.enrollmentId, words: pending.words });
  expect(await paired).toMatchObject({ grants: ['propose'] });
  const record = backend.map.get('vault:t');
  expect(record.privateKey.extractable).toBe(false);
  const enrolled = store.registry.find(record.keyId);
  expect(/^[0-9a-f]{64}$/u.test(enrolled.irohNodeId)).toBe(true);
  expect([...enrolled.grants]).toEqual(['propose']);

  const sent = await controller.propose({ path: 'garden.md' }, '# Garden\n\nWater weekly.\n');
  expect(sent).toMatchObject({ kind: 'proposed', text: 'Sent for review. It is waiting in your Proposals inbox.' });
  expect(submitted[0].submitter).toMatchObject({ kind: 'owner-device', label: 'Phone', keyId: record.keyId });
  expect(await controller.propose({ path: 'garden.md' }, '# Garden\n\nWater daily.\n')).toMatchObject({ kind: 'unchanged' });
  await expect(controller.propose({ path: 'missing.md' }, 'x')).rejects.toMatchObject({ kind: 'refused', reason: 'capture-base-unavailable' });
  // A propose-only phone sees what the public site shows, nothing more.
  const publicReply = await controller.status({ path: 'garden.md' }, 'x');
  expect(publicReply.status.label).toBe('Public, not confirmed yet');
  expect(Object.keys(publicReply.reply).sort()).toEqual(['live', 'path', 'selected']);
  expect((await controller.status({ path: 'private.md' }, 'x')).status.label).toBe('Not public');
  // Revoked on the node: refused from then on.
  await store.revoke(record.keyId);
  await expect(controller.propose({ path: 'garden.md' }, '# Garden\n\nWater hourly.\n')).rejects.toMatchObject({ kind: 'refused', reason: null });
  expect(submitted.length).toBe(1);
}, 60_000);

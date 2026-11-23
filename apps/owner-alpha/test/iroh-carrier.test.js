import { afterEach, expect, test } from 'bun:test';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SecretKey } from '@number0/iroh';
import { validateOwnerAlphaConfig, computePolicyRevision } from '../src/config.js';
import { createOwnerCommands, executeSigned } from '../src/core/commands.js';
import { createLiveDeviceKeyRegistry } from '../src/core/device-keys.js';
import { openDeviceStore } from '../src/core/device-store.js';
import { createPairingManager, pairingMac, pairingTranscript, pairingWords, parsePairingCode, PAIRING_CODE_TTL_MS } from '../src/core/pairing.js';
import { createDevicePrincipalAdapter } from '../src/core/principal.js';
import { signedInputDigest, signedRequestBytes } from '../src/core/signed-request.js';
import { bindEndpoint, CMD_ALPN, connectToNode, exchange, irohAudience, irohChannelBinding, loadNodeSecret, PAIR_ALPN,
  sendSignedRequestOverIroh, startIrohCarrier } from '../src/iroh-carrier.js';

const example = await Bun.file(new URL('../owner-alpha.example.json', import.meta.url)).json();
const cleanup = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });

async function tempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cb-iroh-'));
  await chmod(dir, 0o700);
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function deviceKey() {
  const pair = generateKeyPairSync('ed25519');
  return { privateKey: pair.privateKey, publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64') };
}

const nodeIdOf = () => SecretKey.generate().public().toString();

function envelope({ keyId, privateKey, audience, channelBinding, input = { probe: 1 }, command = 'submitProposal' }) {
  const claims = { audience, keyId, command, inputDigest: signedInputDigest(input), nonce: randomBytes(16).toString('base64'),
    issuedAt: Date.now(), ...(channelBinding ? { channelBinding } : {}) };
  return { ...claims, input, signature: sign(null, signedRequestBytes(claims), privateKey).toString('base64') };
}

function entry(keyId, publicKey, { kind = 'agent', grants = ['propose'], irohNodeId } = {}) {
  return { keyId, publicKey, actor: { kind, id: keyId, label: keyId }, grants, notBefore: Date.now() - 1000,
    notAfter: Date.now() + 600_000, revoked: false, ...(irohNodeId ? { irohNodeId } : {}) };
}

// ---- Binding ----

test('a captured envelope is useless on another connection, another endpoint, or without a binding', () => {
  const node = nodeIdOf(); const client = nodeIdOf(); const other = nodeIdOf();
  const key = deviceKey();
  const { registry } = createLiveDeviceKeyRegistry({ ownerId: 'cybersader', entries: [entry('agent-a', key.publicKey, { irohNodeId: client })] });
  const verifier = createDevicePrincipalAdapter({ registry, audience: irohAudience(node), requireChannelBinding: true });
  const accepts = () => true;
  const first = irohChannelBinding({ nodeId: node, clientEndpointId: client, challenge: randomBytes(32) });
  const captured = envelope({ keyId: 'agent-a', privateKey: key.privateKey, audience: irohAudience(node), channelBinding: first.toString('base64') });
  // Accepted on its own connection.
  expect(verifier.forChannel(first, { peer: client }).verify(structuredClone(captured), accepts).principal.keyId).toBe('agent-a');
  // A second connection has a fresh challenge: the same bytes are refused.
  const second = irohChannelBinding({ nodeId: node, clientEndpointId: client, challenge: randomBytes(32) });
  const fresh = { ...captured, nonce: randomBytes(16).toString('base64') };
  expect(() => verifier.forChannel(second, { peer: client }).verify(captured, accepts)).toThrow();
  expect(() => verifier.forChannel(second, { peer: client }).verify(fresh, accepts)).toThrow();
  // Another endpoint: its own binding, and the key names a different node ID.
  const otherBinding = irohChannelBinding({ nodeId: node, clientEndpointId: other, challenge: randomBytes(32) });
  const fromOther = envelope({ keyId: 'agent-a', privateKey: key.privateKey, audience: irohAudience(node), channelBinding: otherBinding.toString('base64') });
  expect(() => verifier.forChannel(otherBinding, { peer: other }).verify(fromOther, accepts)).toThrow();
  // Missing binding.
  const unbound = envelope({ keyId: 'agent-a', privateKey: key.privateKey, audience: irohAudience(node) });
  expect(() => verifier.forChannel(second, { peer: client }).verify(unbound, accepts)).toThrow();
  // A key without an Iroh node ID cannot be used over Iroh at all.
  const plain = deviceKey();
  const { registry: staticOnly } = createLiveDeviceKeyRegistry({ ownerId: 'cybersader', entries: [entry('agent-b', plain.publicKey)] });
  const v2 = createDevicePrincipalAdapter({ registry: staticOnly, audience: irohAudience(node), requireChannelBinding: true });
  const b = irohChannelBinding({ nodeId: node, clientEndpointId: client, challenge: randomBytes(32) });
  expect(() => v2.forChannel(b, { peer: client }).verify(envelope({ keyId: 'agent-b', privateKey: plain.privateKey,
    audience: irohAudience(node), channelBinding: b.toString('base64') }), accepts)).toThrow();
});

// ---- Durable registry ----

test('enrol and revoke persist as create-once private records and revoked keys never verify again', async () => {
  const root = await tempDir();
  const directory = path.join(root, 'devices');
  const key = deviceKey(); const peer = nodeIdOf();
  const store = await openDeviceStore({ directory, ownerId: 'cybersader', parentDirectory: root });
  const { keyId } = await store.enrol({ kind: 'agent', label: 'Agent one', grants: ['propose'], publicKey: key.publicKey, irohNodeId: peer });
  expect(store.registry.find(keyId).irohNodeId).toBe(peer);
  // An agent may hold only propose; owner devices only owner grants.
  await expect(store.enrol({ kind: 'agent', label: 'Greedy', grants: ['propose', 'publish'], publicKey: deviceKey().publicKey, irohNodeId: nodeIdOf() })).rejects.toThrow();
  await expect(store.enrol({ kind: 'owner-device', label: 'Odd', grants: ['root'], publicKey: deviceKey().publicKey, irohNodeId: nodeIdOf() })).rejects.toThrow();
  // The same public key cannot be enrolled twice.
  await expect(store.enrol({ kind: 'agent', label: 'Again', grants: ['propose'], publicKey: key.publicKey, irohNodeId: nodeIdOf() })).rejects.toThrow();
  const reopened = await openDeviceStore({ directory, ownerId: 'cybersader', parentDirectory: root });
  expect(reopened.registry.find(keyId)?.revoked).toBe(false);
  await reopened.revoke(keyId);
  expect(reopened.registry.find(keyId).revoked).toBe(true);
  const files = (await readdir(directory)).sort();
  expect(files).toEqual([`${keyId}.key.json`, `${keyId}.revoked.json`]);
  for (const file of files) expect((await Bun.file(path.join(directory, file)).stat()).mode & 0o777).toBe(0o600);
  const third = await openDeviceStore({ directory, ownerId: 'cybersader', parentDirectory: root });
  expect(third.registry.find(keyId).revoked).toBe(true);
  // A live registry never un-revokes, even if handed a set that says otherwise.
  const live = createLiveDeviceKeyRegistry({ ownerId: 'o', entries: [{ ...entry('k1', key.publicKey), revoked: true }] });
  live.replace({ ownerId: 'o', entries: [entry('k1', key.publicKey)] });
  expect(live.registry.find('k1').revoked).toBe(true);
  // A group-readable directory is refused.
  const loose = path.join(root, 'loose');
  await mkdir(loose, { mode: 0o755 });
  await chmod(loose, 0o755);
  await expect(openDeviceStore({ directory: loose, ownerId: 'cybersader' })).rejects.toThrow();
});

// ---- Pairing rules (no network) ----

function pairingSetup(at = { now: 1_000_000 }) {
  const enrolled = [];
  const store = { enrol: async (record) => { enrolled.push(record); return { keyId: `agent-${enrolled.length}` }; } };
  const manager = createPairingManager({ ownerId: 'cybersader', store, clock: () => at.now });
  const nodeId = nodeIdOf();
  manager.attachNode({ nodeId, ticket: 'endpointticketabc' });
  function attempt(started, { clientEndpointId = nodeIdOf(), key = deviceKey(), secret } = {}) {
    const code = parsePairingCode(started.code);
    const transcript = pairingTranscript({ nodeId, clientEndpointId, enrollmentId: code.enrollmentId, devicePublicKey: key.publicKey });
    const message = { enrollmentId: code.enrollmentId, devicePublicKey: key.publicKey,
      mac: pairingMac(secret ?? code.secret, transcript), signature: sign(null, transcript, key.privateKey).toString('base64') };
    return { message, clientEndpointId, words: pairingWords(transcript) };
  }
  return { manager, enrolled, at, attempt };
}

test('pairing: words match, Confirm enrols exactly the picked grants once', async () => {
  const { manager, enrolled, attempt } = pairingSetup();
  const started = manager.start({ kind: 'agent', access: 'propose', label: 'Writer' });
  const { message, clientEndpointId, words } = attempt(started);
  expect(manager.attempt(clientEndpointId, message).words).toEqual(words);
  const waiting = manager.result(started.enrollmentId, clientEndpointId);
  expect(await manager.confirm({ enrollmentId: started.enrollmentId, words })).toEqual({ keyId: 'agent-1' });
  expect(await waiting).toEqual({ ok: true, keyId: 'agent-1' });
  expect(enrolled).toEqual([{ kind: 'agent', label: 'Writer', grants: ['propose'], publicKey: message.devicePublicKey, irohNodeId: clientEndpointId }]);
  await expect(manager.confirm({ enrollmentId: started.enrollmentId, words })).rejects.toThrow();
  expect(() => manager.attempt(clientEndpointId, message)).toThrow();
});

test('pairing: expired, reused, wrong-secret, wrong-word, unconfirmed and tampered attempts enrol nothing', async () => {
  const { manager, enrolled, at, attempt } = pairingSetup();
  // An agent cannot be given more than propose.
  expect(() => manager.start({ kind: 'agent', access: 'review', label: 'Greedy' })).toThrow();
  expect(() => manager.start({ kind: 'agent', access: 'full', label: 'Greedy' })).toThrow();
  // Expired.
  const expired = manager.start({ kind: 'agent', access: 'propose', label: 'Late' });
  at.now += PAIRING_CODE_TTL_MS;
  const late = attempt(expired);
  expect(() => manager.attempt(late.clientEndpointId, late.message)).toThrow();
  // Wrong secret uses the code up; the right one afterwards is refused.
  const used = manager.start({ kind: 'agent', access: 'propose', label: 'Used' });
  const forged = attempt(used, { secret: randomBytes(32) });
  expect(() => manager.attempt(forged.clientEndpointId, forged.message)).toThrow();
  const genuine = attempt(used);
  expect(() => manager.attempt(genuine.clientEndpointId, genuine.message)).toThrow();
  // Grant tampering: the device message is closed, so it cannot carry grants.
  const tamper = manager.start({ kind: 'agent', access: 'propose', label: 'Tamper' });
  const t = attempt(tamper);
  expect(() => manager.attempt(t.clientEndpointId, { ...t.message, grants: ['publish'] })).toThrow();
  // Wrong words at Confirm close the attempt.
  const words = manager.start({ kind: 'agent', access: 'propose', label: 'Words' });
  const w = attempt(words);
  manager.attempt(w.clientEndpointId, w.message);
  await expect(manager.confirm({ enrollmentId: words.enrollmentId, words: ['acorn', 'amber', 'anchor', 'apple'] })).rejects.toThrow();
  await expect(manager.confirm({ enrollmentId: words.enrollmentId, words: w.words })).rejects.toThrow();
  // No Confirm within the window.
  const idle = manager.start({ kind: 'agent', access: 'propose', label: 'Idle' });
  const i = attempt(idle);
  manager.attempt(i.clientEndpointId, i.message);
  at.now += PAIRING_CODE_TTL_MS + 1;
  await expect(manager.confirm({ enrollmentId: idle.enrollmentId, words: i.words })).rejects.toThrow();
  expect(await manager.result(idle.enrollmentId, i.clientEndpointId)).toEqual({ ok: false });
  expect(enrolled).toEqual([]);
});

// ---- Carrier on loopback (direct Iroh, no relay) ----

async function loopbackCarrier({ submitSigned }) {
  const root = await tempDir();
  const config = validateOwnerAlphaConfig({ ...example, proposalReview: { ...example.proposalReview, enabled: true, socketPath: path.join(root, 'review.sock') } });
  const store = await openDeviceStore({ directory: path.join(root, 'devices'), ownerId: config.owner.identity, parentDirectory: root });
  const pairing = createPairingManager({ ownerId: config.owner.identity, store });
  const secretKey = await loadNodeSecret(root);
  expect(Buffer.compare(secretKey, await loadNodeSecret(root))).toBe(0);
  const endpoint = await bindEndpoint({ secretKey, relay: 'none', bindAddress: '127.0.0.1:0', alpns: [CMD_ALPN, PAIR_ALPN] });
  const nodeId = endpoint.id().toString();
  const verifier = createDevicePrincipalAdapter({ registry: store.registry, audience: irohAudience(nodeId), requireChannelBinding: true });
  const commands = createOwnerCommands({ config, devicePrincipalAdapter: verifier, proposalReview: { submitSigned } });
  const carrier = startIrohCarrier({ endpoint, commands, verifier, pairing, relay: 'none' });
  store.setRevokeListener((key) => carrier.closePeer(key.irohNodeId));
  pairing.attachNode({ nodeId, ticket: carrier.ticket });
  cleanup.push(() => carrier.close());
  return { root, store, pairing, carrier, nodeId, config };
}

test('carrier: one challenge per request; replay on a new connection and challenge reuse are refused', async () => {
  const seen = [];
  const { store, carrier, nodeId } = await loopbackCarrier({ submitSigned: async (input) => { seen.push(input); throw new Error('stop'); } });
  const key = deviceKey();
  const irohSecret = Buffer.from(SecretKey.generate().toBytes());
  const clientId = SecretKey.fromBytes([...irohSecret]).public().toString();
  const { keyId } = await store.enrol({ kind: 'agent', label: 'Probe', grants: ['propose'], publicKey: key.publicKey, irohNodeId: clientId });
  const session = await connectToNode({ secretKey: irohSecret, ticket: carrier.ticket, alpn: CMD_ALPN });
  cleanup.push(() => session.endpoint.close());
  expect(session.nodeId).toBe(nodeId);
  const { challenge } = await exchange(session.connection, { type: 'challenge' });
  const binding = irohChannelBinding({ nodeId, clientEndpointId: clientId, challenge: Buffer.from(challenge, 'base64') }).toString('base64');
  const first = envelope({ keyId, privateKey: key.privateKey, audience: irohAudience(nodeId), channelBinding: binding, input: { not: 'a proposal' } });
  // Verified and reaching the command, which refuses the bogus proposal: generic refusal.
  expect(await exchange(session.connection, first)).toEqual({ ok: false, code: 'proposal-submission-refused' });
  // The challenge is spent: a second request reusing it is refused before verification.
  const reuse = envelope({ keyId, privateKey: key.privateKey, audience: irohAudience(nodeId), channelBinding: binding });
  expect(await exchange(session.connection, reuse)).toEqual({ ok: false, code: 'proposal-submission-refused' });
  // A new connection with its own challenge: the captured envelope fails binding.
  const again = await connectToNode({ secretKey: irohSecret, ticket: carrier.ticket, alpn: CMD_ALPN });
  cleanup.push(() => again.endpoint.close());
  await exchange(again.connection, { type: 'challenge' });
  expect(await exchange(again.connection, first)).toEqual({ ok: false, code: 'proposal-submission-refused' });
  // Commands outside the socket's surface are refused.
  const { challenge: c2 } = await exchange(again.connection, { type: 'challenge' });
  const b2 = irohChannelBinding({ nodeId, clientEndpointId: clientId, challenge: Buffer.from(c2, 'base64') }).toString('base64');
  expect(await exchange(again.connection, envelope({ keyId, privateKey: key.privateKey, audience: irohAudience(nodeId), channelBinding: b2, command: 'approveProposal' })))
    .toEqual({ ok: false, code: 'proposal-submission-refused' });
  // A different endpoint presenting the enrolled key is refused.
  const stranger = await sendSignedRequestOverIroh({ secretKey: randomBytes(32), ticket: carrier.ticket,
    sign: (extra) => envelope({ keyId, privateKey: key.privateKey, ...extra }) });
  expect(stranger).toEqual({ ok: false, code: 'proposal-submission-refused' });
  expect(seen.length).toBe(0);
});

test('config: Iroh is off unless enabled, needs review, takes the relay as configuration and stays out of the policy revision', () => {
  const review = { ...example.proposalReview, enabled: true, socketPath: '/run/cb/review.sock' };
  const base = { ...example, proposalReview: review };
  const on = validateOwnerAlphaConfig({ ...base, iroh: { enabled: true, stateDirectory: '/var/lib/cb-iroh' } });
  expect(on.iroh.relay).toBe('n0');
  expect(validateOwnerAlphaConfig({ ...base, iroh: { enabled: true, stateDirectory: '/x', relay: 'https://relay.example.net/' } }).iroh.relay).toBe('https://relay.example.net/');
  expect(() => validateOwnerAlphaConfig({ ...base, iroh: { enabled: true, stateDirectory: '/x', relay: 'http://relay.example.net/' } })).toThrow();
  expect(() => validateOwnerAlphaConfig({ ...example, iroh: { enabled: true, stateDirectory: '/x' } })).toThrow();
  expect(computePolicyRevision({ ...base, iroh: { enabled: true, stateDirectory: '/x' } })).toBe(computePolicyRevision(base));
});

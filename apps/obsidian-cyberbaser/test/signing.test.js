import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
// The format package and its conformance vectors are the reference.
import * as reference from '../../../packages/signed-intent/src/index.js';
// The node's own code, to prove the relay and the plugin agree.
import { validateOwnerAlphaConfig } from '../../owner-alpha/src/config.js';
import { createApprovalRelay, publisherSigningFromSocket } from '../../owner-alpha/src/core/approvals.js';
import { ownerRequest } from '../../owner-alpha/src/publisher/owner-control.js';
import { startOwnerServices } from '../../owner-alpha/src/publisher/owner-services.js';
import { createJobApprovals } from '../../owner-alpha/src/core/job-approvals.js';
import { gitIn } from '../../owner-alpha/src/signed-publish.js';
import { createOwnerCommands } from '../../owner-alpha/src/core/commands.js';
import { openDeviceStore } from '../../owner-alpha/src/core/device-store.js';
import * as nodePairing from '../../owner-alpha/src/core/pairing.js';
import { createDevicePrincipalAdapter } from '../../owner-alpha/src/core/principal.js';
import { bindEndpoint, CMD_ALPN, connectToNode, irohAudience, PAIR_ALPN, startIrohCarrier } from '../../owner-alpha/src/iroh-carrier.js';
import { createNodeClient, NodeError } from '../src/core/client.js';
import { createController, messageFor, publicSettings } from '../src/core/controller.js';
import { createDeviceStore, indexedDbBackend, memoryBackend } from '../src/core/device-store.js';
import * as signing from '../src/core/signing.js';
import { createTapGate, isRealTap } from '../src/core/tap.js';
import { createStubPublisher, publishIntent, sha256Hex } from './harness/stub-publisher.js';

const vectors = JSON.parse(await readFile(new URL('../../../packages/signed-intent/test/vectors.json', import.meta.url), 'utf8'));
const cleanup = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });

// Tests stand in for a finger: these taps pass the gate, nothing else does.
const fingerTaps = new WeakSet();
const finger = () => { const tap = { finger: true }; fingerTaps.add(tap); return tap; };
const testGate = () => createTapGate((event) => fingerTaps.has(event));

// ---- Same bytes and signatures as the reference ----

test('vectors: every intent digest, the enrolment code, proof, confirm and fingerprint match the package', async () => {
  for (const [kind, entry] of Object.entries(vectors.intents)) {
    expect(signing.b64url(await signing.intentDigest(entry.intent))).toBe(Buffer.from(entry.digestHex, 'hex').toString('base64url'));
    expect(kind).toBe(entry.intent.kind);
  }
  const { enrollment } = vectors;
  const parsed = signing.parseEnrolCode(`cyberbaser-enroll:v1?publisher=${vectors.publisher}&code=${enrollment.code}`);
  expect(Buffer.from(parsed.secret).toString('hex')).toBe(enrollment.secretHex);
  // Lower case and look-alike letters read the same; a wrong length does not.
  expect(Buffer.from(signing.parseCode(enrollment.code.toLowerCase().replaceAll('1', 'l'))).toString('hex')).toBe(enrollment.secretHex);
  expect(signing.parseCode(enrollment.code.slice(0, -1))).toBe(null);
  expect(await signing.enrollProof(parsed.secret, vectors.publisher, enrollment.key)).toBe(enrollment.proof);
  expect(await signing.enrollConfirm(parsed.secret, vectors.publisher, vectors.intents.enroll.digestHex)).toBe(enrollment.confirm);
  expect(await signing.keyFingerprint(enrollment.key)).toBe(reference.keyFingerprint(enrollment.key));
  // Every form the code may arrive in.
  const link = signing.enrolLink(vectors.publisher, enrollment.code);
  expect(link.startsWith('obsidian://cyberbaser-enrol?')).toBe(true);
  expect(signing.parseEnrolCode(link)?.publisher).toBe(vectors.publisher);
  expect(signing.parseEnrolCode(Object.fromEntries(new URL(link).searchParams))?.publisher).toBe(vectors.publisher);
  for (const bad of ['', 'cyberbaser-enroll:v1?code=x', `cyberbaser-enroll:v1?publisher=${'A'.repeat(64)}&code=${enrollment.code}`]) {
    expect(signing.parseEnrolCode(bad)).toBe(null);
  }
});

test('signature: the WebCrypto signing key signs what the reference Ed25519 provider verifies, and nothing else', async () => {
  const key = await signing.createSigningKey();
  expect(key.privateKey.extractable).toBe(false);
  await expect(crypto.subtle.exportKey('pkcs8', key.privateKey)).rejects.toThrow();
  const digest = Buffer.from(vectors.intents.publish.digestHex, 'hex');
  const approval = await signing.approvalFor(key.privateKey, new Uint8Array(digest));
  expect(reference.ed25519Provider.verify({ digest, approval, key: { publicKey: key.publicKey } })).toEqual({ ok: true });
  const other = Buffer.from(vectors.intents['key-add'].digestHex, 'hex');
  expect(reference.ed25519Provider.verify({ digest: other, approval, key: { publicKey: key.publicKey } }).ok).toBe(false);
  // And the provider's own vector cases agree with the same domain line.
  expect(signing.ED25519_APPROVAL_DOMAIN).toBe(reference.ED25519_APPROVAL_DOMAIN);
});

// ---- What the owner sees comes from the intent ----

const pinned = (publisher) => ({ keyId: 'device-1', publisher });

async function request(overrides = {}) {
  const before = Buffer.from('# Garden\n\nWater the roses daily in the morning.\n');
  const after = Buffer.from('# Garden\n\nWater the roses weekly in the morning.\n');
  const publisher = 'a'.repeat(64);
  const intent = publishIntent({ publisher, nonce: 'A'.repeat(43), path: 'notes/garden.md', before, after, now: 1_800_000_000_000 });
  return { publisher, before, after,
    value: { requestId: 'r'.repeat(22), askedBy: 'Desktop browser', intent,
      files: [{ path: 'notes/garden.md', before: before.toString('base64'), after: after.toString('base64') }], ...overrides } };
}

test('summary: title, whole-word change, repository and branch come from the intent and hash-checked bytes only', async () => {
  const { value, publisher } = await request();
  const prepared = await signing.prepareApproval({ request: value, signing: pinned(publisher), now: 1_800_000_000_001 });
  expect(prepared.template.keyId).toBe('device-1');
  expect(prepared.summary).toMatchObject({ repository: 'example/vault', branch: 'main', changesBuild: false });
  const [file] = prepared.summary.files;
  expect(file).toMatchObject({ title: 'garden', kind: 'edited', path: 'notes/garden.md' });
  expect(file.preview.filter((part) => part.kind !== 'same' && part.kind !== 'gap')).toEqual([
    { kind: 'removed', text: 'daily' }, { kind: 'added', text: 'weekly' }]);
  // Words are never cut.
  expect(file.preview.map((part) => part.text).join('')).toContain('Water the roses ');
  // Whatever the node adds beside the intent changes nothing shown.
  const noisy = await signing.prepareApproval({ request: { ...value, askedBy: 'Trust me', summary: 'Fix a typo' },
    signing: pinned(publisher), now: 1_800_000_000_001 });
  expect(noisy.summary).toEqual(prepared.summary);
  expect(JSON.stringify(noisy)).not.toContain('Trust me');
  expect(JSON.stringify(noisy)).not.toContain('Fix a typo');
});

test('summary: bytes that do not hash to the intent, another publisher, or an expired request are refused', async () => {
  const { value, publisher, after } = await request();
  const swapped = { ...value, files: [{ ...value.files[0], after: Buffer.from(after.toString().replace('weekly', 'hourly')).toString('base64') }] };
  await expect(signing.prepareApproval({ request: swapped, signing: pinned(publisher), now: 1_800_000_000_001 }))
    .rejects.toMatchObject({ reason: 'approval-bytes-mismatch' });
  await expect(signing.prepareApproval({ request: value, signing: pinned('b'.repeat(64)), now: 1_800_000_000_001 }))
    .rejects.toMatchObject({ reason: 'approval-wrong-publisher' });
  await expect(signing.prepareApproval({ request: value, signing: pinned(publisher), now: 1_900_000_000_000 }))
    .rejects.toMatchObject({ reason: 'approval-expired' });
  const build = await request();
  build.value.intent.changes[0].path = '.github/workflows/publish.yml';
  build.value.files[0].path = '.github/workflows/publish.yml';
  const shown = await signing.prepareApproval({ request: build.value, signing: pinned(publisher), now: 1_800_000_000_001 });
  expect(shown.summary.changesBuild).toBe(true);
  expect(messageFor(new signing.ApprovalProblem('approval-bytes-mismatch'))).toContain('Nothing was signed');
});

// ---- No signature without a tap ----

test('tap: synthetic, forged, missing or reused taps never sign', async () => {
  expect(isRealTap(undefined)).toBe(false);
  expect(isRealTap({ isTrusted: true, type: 'click' })).toBe(false);
  if (typeof Event === 'function') expect(isRealTap(new Event('click'))).toBe(false);
  if (typeof MouseEvent === 'function') {
    const forged = Object.create(MouseEvent.prototype);
    Object.defineProperty(forged, 'isTrusted', { value: true });
    Object.defineProperty(forged, 'type', { value: 'click' });
    expect(isRealTap(forged)).toBe(false);
  }
  const { value, publisher } = await request();
  const key = await signing.createSigningKey();
  const record = { version: 1, keyId: 'device-1', label: 'Phone', publicKey: key.publicKey, privateKey: key.privateKey,
    publisher, fingerprint: 'x', enrolledAt: 1 };
  const backend = memoryBackend();
  await signing.createSigningStore(backend, 'vault:t').save(record);
  const calls = [];
  const make = (tapGate) => createController({
    client: { request: async (_, command, input) => { calls.push([command, input]); return command === 'readApproval' ? value : { accepted: true }; } },
    store: { load: async () => ({ keyId: 'p', grants: ['publish'] }) },
    signingStore: signing.createSigningStore(backend, 'vault:t'), now: () => 1_800_000_000_001,
    ...(tapGate ? { tapGate } : {}),
  });
  // The real gate, as in Obsidian: nothing a script makes counts.
  const real = make(null);
  const prepared = await real.readApproval(value.requestId);
  calls.length = 0;
  for (const tap of [undefined, null, { isTrusted: true, type: 'click' }, typeof Event === 'function' ? new Event('click') : {}]) {
    await expect(real.approve(prepared, tap)).rejects.toMatchObject({ reason: 'tap-required' });
  }
  expect(calls).toEqual([]);

  // With a finger: signs exactly once per tap, and the signature verifies.
  const withFinger = make(testGate());
  const ready = await withFinger.readApproval(value.requestId);
  calls.length = 0;
  const tap = finger();
  expect(await withFinger.approve(ready, tap)).toEqual({ approved: true });
  await expect(withFinger.approve(ready, tap)).rejects.toMatchObject({ reason: 'tap-required' });
  expect(calls.map(([command]) => command)).toEqual(['submitApproval']);
  const sent = calls[0][1];
  expect(sent.intent.keyId).toBe('device-1');
  const digest = reference.intentDigest(sent.intent);
  expect(reference.ed25519Provider.verify({ digest, approval: sent.approval, key: { publicKey: key.publicKey } })).toEqual({ ok: true });
});

// ---- The key never reaches data.json ----

test('storage: the signing key lives in device storage under its own database; synced settings never carry it', async () => {
  const backend = memoryBackend();
  const store = signing.createSigningStore(backend, 'vault:t');
  const key = await signing.createSigningKey();
  const record = { version: 1, keyId: 'device-1', label: 'Phone', publicKey: key.publicKey, privateKey: key.privateKey,
    publisher: 'a'.repeat(64), fingerprint: 'abcd abcd abcd abcd', enrolledAt: 1 };
  await store.save(record);
  expect(backend.map.get('vault:t').privateKey.extractable).toBe(false);
  const settings = { showMark: true, signing: record, signingKeyId: 'device-1' };
  const synced = JSON.stringify(publicSettings(settings));
  expect(synced).toBe('{"showMark":true}');
  for (const secret of [key.publicKey, 'device-1', 'a'.repeat(64)]) expect(synced).not.toContain(secret);
  expect(signing.signingDatabase()).toEqual({ database: 'cyberbaser-signing', store: 'keys' });
  await expect(store.save({ ...record, privateKey: null })).rejects.toThrow();
});


test('storage: pairing and signing open separate databases, each with its own store', async () => {
  const opened = [];
  const fakeIndexedDb = { open(name, version) {
    const request = {};
    queueMicrotask(() => {
      const created = [];
      request.result = { createObjectStore: (store) => created.push(store) };
      request.onupgradeneeded?.();
      opened.push({ name, version, created });
    });
    return request;
  } };
  void indexedDbBackend(fakeIndexedDb).get('vault:t');
  void indexedDbBackend(fakeIndexedDb, signing.signingDatabase()).get('vault:t');
  await Bun.sleep(5);
  expect(opened).toEqual([
    { name: 'cyberbaser-device', version: 1, created: ['pairings'] },
    { name: 'cyberbaser-signing', version: 1, created: ['keys'] },
  ]);
});

// ---- End to end: the node relays, a stand-in publisher verifies ----

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
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'cb-signing-')));
  await chmod(dir, 0o700);
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function pairedDevice({ pairing, controller, access }) {
  const started = pairing.start({ kind: 'owner-device', access, label: 'Phone' });
  const paired = controller.pair(started.code, {});
  let pending;
  for (let i = 0; i < 200 && !pending; i += 1) {
    pending = pairing.list().find((item) => item.enrollmentId === started.enrollmentId && item.state === 'awaiting');
    if (!pending) await Bun.sleep(25);
  }
  await pairing.confirm({ enrollmentId: started.enrollmentId, words: pending.words });
  return paired;
}

test('relay: enrol with the one-time code, then approve a publish the node relays; the publisher verifies the signature', async () => {
  const example = await Bun.file(new URL('../../owner-alpha/owner-alpha.example.json', import.meta.url)).json();
  const root = await tempDir();
  const checkout = path.join(root, 'vault');
  await mkdir(checkout);
  await writeFile(path.join(checkout, 'garden.md'), '# Garden\n');
  execFileSync('git', ['-C', checkout, 'init', '-q', '--initial-branch=main']);
  const config = validateOwnerAlphaConfig({ ...example, repository: { ...example.repository, checkout } });
  const store = await openDeviceStore({ directory: path.join(root, 'devices'), ownerId: config.owner.identity, parentDirectory: root });
  const pairing = nodePairing.createPairingManager({ ownerId: config.owner.identity, store });
  const endpoint = await bindEndpoint({ secretKey: randomBytes(32), relay: 'none', bindAddress: '127.0.0.1:0', alpns: [CMD_ALPN, PAIR_ALPN] });
  const nodeId = endpoint.id().toString();
  const verifier = createDevicePrincipalAdapter({ registry: store.registry, audience: irohAudience(nodeId), requireChannelBinding: true });
  const publisher = createStubPublisher();
  const approvals = createApprovalRelay({ publisher });
  const commands = createOwnerCommands({ config, devicePrincipalAdapter: verifier, approvals });
  const carrier = startIrohCarrier({ endpoint, commands, verifier, pairing, relay: 'none' });
  pairing.attachNode({ nodeId, ticket: carrier.ticket });
  cleanup.push(() => carrier.close());

  const signingBackend = memoryBackend();
  const make = (scope) => createController({ client: createNodeClient({ carrier: nodeBindingsCarrier() }),
    store: createDeviceStore(memoryBackend(), scope), signingStore: signing.createSigningStore(signingBackend, scope), tapGate: testGate() });
  const phone = make('vault:phone');
  await pairedDevice({ pairing, controller: phone, access: 'full' });

  // A code typed wrong is refused by the publisher; nothing is kept.
  const wrong = `cyberbaser-enroll:v1?publisher=${publisher.publisher}&code=${reference.formatCode(randomBytes(20))}`;
  await expect(phone.enrol(wrong, { label: 'Phone', tap: finger() })).rejects.toMatchObject({ reason: 'enroll-refused' });
  expect(await phone.signingDevice()).toBe(null);
  // No tap, no enrolment.
  await expect(phone.enrol(publisher.enrolLink, { label: 'Phone' })).rejects.toMatchObject({ reason: 'tap-required' });
  const enrolled = await phone.enrol(publisher.enrolLink, { label: 'Pixel', tap: finger() });
  expect(enrolled.fingerprint).toBe(reference.keyFingerprint(publisher.keys.get(enrolled.keyId)));
  expect(signingBackend.map.get('vault:phone').privateKey.extractable).toBe(false);
  // The code works once.
  const again = make('vault:again');
  await pairedDevice({ pairing, controller: again, access: 'full' });
  await expect(again.enrol(publisher.enrolLink, { label: 'Other', tap: finger() })).rejects.toMatchObject({ reason: 'enroll-refused' });

  // The node asks for an approval (as the publish path will), with the bytes.
  const before = Buffer.from('# Garden\n\nWater daily.\n');
  const after = Buffer.from('# Garden\n\nWater weekly.\n');
  const { nonce } = publisher.challenge();
  const asked = approvals.request({ askedBy: 'Desktop browser', intent: publishIntent({ publisher: publisher.publisher, nonce, path: 'garden.md', before, after }),
    files: [{ path: 'garden.md', before: before.toString('base64'), after: after.toString('base64') }] });
  const waiting = await phone.waitingApprovals();
  expect(waiting.map((entry) => entry.requestId)).toEqual([asked.requestId]);
  const prepared = await phone.readApproval(asked.requestId);
  expect(prepared.summary.files[0].preview.filter((part) => part.kind === 'added')).toEqual([{ kind: 'added', text: 'weekly.' }]);
  await phone.approve(prepared, finger());
  const signed = await asked.result;
  expect(signed.intent.keyId).toBe(enrolled.keyId);
  expect(publisher.verifyPublish(signed)).toEqual({ ok: true });
  // Replaying the same approval is refused by the publisher's nonce.
  expect(() => publisher.verifyPublish(signed)).toThrow();
  expect(await phone.waitingApprovals()).toEqual([]);

  // Decline: the node's request ends, nothing signed.
  const { nonce: second } = publisher.challenge();
  const declined = approvals.request({ askedBy: 'Agent', intent: publishIntent({ publisher: publisher.publisher, nonce: second, path: 'garden.md', before, after }),
    files: [{ path: 'garden.md', before: before.toString('base64'), after: after.toString('base64') }] });
  await phone.decline(declined.requestId);
  await expect(declined.result).rejects.toMatchObject({ code: 'approval-declined' });

  // A device that may only propose never reaches the approvals.
  const proposer = make('vault:proposer');
  await pairedDevice({ pairing, controller: proposer, access: 'propose' });
  await signing.createSigningStore(signingBackend, 'vault:proposer').save({ ...signingBackend.map.get('vault:phone') });
  await expect(proposer.waitingApprovals()).rejects.toMatchObject({ kind: 'refused', reason: null });
  expect(sha256Hex(before)).toBe(signed.intent.changes[0].before.sha256);
}, 90_000);

test('jobs waiting for approval: offered from the committed Git objects, signed on the phone, attached and resumed; the publisher commit check passes', async () => {
  const example = await Bun.file(new URL('../../owner-alpha/owner-alpha.example.json', import.meta.url)).json();
  const root = await tempDir();
  const checkout = path.join(root, 'vault');
  await mkdir(path.join(checkout, 'notes'), { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', checkout, '-c', 'commit.gpgSign=false', ...args]).toString().trim();
  git('init', '-q', '--initial-branch=main'); git('config', 'user.name', 'Owner'); git('config', 'user.email', 'owner@example.invalid');
  await writeFile(path.join(checkout, 'notes/garden.md'), '# Garden\n\nWater the roses daily.\n');
  git('add', '-A'); git('commit', '-q', '-m', 'base');
  await writeFile(path.join(checkout, 'notes/garden.md'), '# Garden\n\nWater the roses weekly.\n');
  git('add', '-A'); git('commit', '-q', '-m', 'Edit notes/garden.md');
  const commit = git('rev-parse', 'HEAD');
  const config = validateOwnerAlphaConfig({ ...example, repository: { ...example.repository, checkout } });
  const store = await openDeviceStore({ directory: path.join(root, 'devices'), ownerId: config.owner.identity, parentDirectory: root });
  const pairing = nodePairing.createPairingManager({ ownerId: config.owner.identity, store });
  const endpoint = await bindEndpoint({ secretKey: randomBytes(32), relay: 'none', bindAddress: '127.0.0.1:0', alpns: [CMD_ALPN, PAIR_ALPN] });
  const nodeId = endpoint.id().toString();
  const verifier = createDevicePrincipalAdapter({ registry: store.registry, audience: irohAudience(nodeId), requireChannelBinding: true });
  const publisher = createStubPublisher();
  const attached = [];
  const resumed = [];
  let jobState = 'awaiting-approval';
  const jobs = createJobApprovals({ config, context: null, pipeline: { resumeJob: async ({ jobId }) => { resumed.push(jobId); jobState = 'pushing'; } },
    listJobs: async () => [{ jobId: 'OA-waiting', state: jobState }, { jobId: 'OA-done', state: 'completed' }],
    readCommit: async (_, jobId) => (jobId === 'OA-waiting' ? commit : null),
    attach: async (input) => { attached.push(input); }, git: gitIn(checkout) });
  const approvals = createApprovalRelay({ publisher, refresh: () => jobs.refresh(approvals) });
  const commands = createOwnerCommands({ config, devicePrincipalAdapter: verifier, approvals });
  const carrier = startIrohCarrier({ endpoint, commands, verifier, pairing, relay: 'none' });
  pairing.attachNode({ nodeId, ticket: carrier.ticket });
  cleanup.push(() => carrier.close());
  const phone = createController({ client: createNodeClient({ carrier: nodeBindingsCarrier() }),
    store: createDeviceStore(memoryBackend(), 'vault:p'), signingStore: signing.createSigningStore(memoryBackend(), 'vault:p'), tapGate: testGate() });
  await pairedDevice({ pairing, controller: phone, access: 'full' });
  await phone.enrol(publisher.enrolLink, { label: 'Phone', tap: finger() });

  const waiting = await phone.waitingApprovals();
  expect(waiting).toHaveLength(1);
  // Listing again does not offer the same job twice.
  expect(await phone.waitingApprovals()).toHaveLength(1);
  const prepared = await phone.readApproval(waiting[0].requestId);
  expect(prepared.summary).toMatchObject({ repository: config.repository.remote.url.replace(/^https:\/\/github\.com\//u, '').replace(/\.git$/u, ''),
    branch: config.repository.branch, message: 'Edit notes/garden.md' });
  expect(prepared.summary.files[0]).toMatchObject({ title: 'garden', kind: 'edited' });
  expect(prepared.summary.files[0].preview.filter((part) => part.kind !== 'same')).toEqual([
    { kind: 'removed', text: 'daily.' }, { kind: 'added', text: 'weekly.' }]);
  await phone.approve(prepared, finger());
  for (let i = 0; i < 100 && resumed.length === 0; i += 1) await Bun.sleep(20);
  expect(resumed).toEqual(['OA-waiting']);
  expect(attached).toHaveLength(1);
  expect(attached[0].jobId).toBe('OA-waiting');
  const { record } = attached[0];
  expect(publisher.verifyPublish(record)).toEqual({ ok: true });
  // What the publisher checks before pushing: this commit matches the signed intent.
  expect(await reference.checkCommit(gitIn(checkout), record.intent, commit)).toMatchObject({ ok: true, commit });
  expect(await phone.waitingApprovals()).toEqual([]);
}, 90_000);

test('real publisher: the plugin enrols with the code from the publisher log and its approval passes the publisher gate', async () => {
  const example = await Bun.file(new URL('../../owner-alpha/owner-alpha.example.json', import.meta.url)).json();
  const root = await tempDir();
  const checkout = path.join(root, 'vault');
  await mkdir(checkout);
  const git = (...args) => execFileSync('git', ['-C', checkout, '-c', 'commit.gpgSign=false', ...args]).toString().trim();
  git('init', '-q', '--initial-branch=main'); git('config', 'user.name', 'Owner'); git('config', 'user.email', 'owner@example.invalid');
  await writeFile(path.join(checkout, 'garden.md'), '# Garden\n\nWater daily.\n');
  git('add', '-A'); git('commit', '-q', '-m', 'base');
  await writeFile(path.join(checkout, 'garden.md'), '# Garden\n\nWater weekly.\n');
  git('add', '-A'); git('commit', '-q', '-m', 'Edit garden.md');
  const commit = git('rev-parse', 'HEAD');
  const config = validateOwnerAlphaConfig({ ...example, repository: { ...example.repository, checkout } });
  // The publisher's owner services, as the installed publisher starts them.
  const ipc = path.join(root, 'ipc');
  await mkdir(ipc, { mode: 0o700 });
  const socketPath = path.join(ipc, 'publisher.sock');
  const lines = [];
  const services = await startOwnerServices({ owners: { directory: path.join(root, 'owners'), mode: 'enforce' }, socketPath,
    uid: process.getuid(), log: (line) => lines.push(line) });
  cleanup.push(() => services.close());
  const scanned = lines.map((line) => /scan: (\S+)$/u.exec(line)?.[1]).find(Boolean);
  expect(scanned).toStartWith('obsidian://cyberbaser-enrol?');

  const store = await openDeviceStore({ directory: path.join(root, 'devices'), ownerId: config.owner.identity, parentDirectory: root });
  const pairing = nodePairing.createPairingManager({ ownerId: config.owner.identity, store });
  const endpoint = await bindEndpoint({ secretKey: randomBytes(32), relay: 'none', bindAddress: '127.0.0.1:0', alpns: [CMD_ALPN, PAIR_ALPN] });
  const nodeId = endpoint.id().toString();
  const verifier = createDevicePrincipalAdapter({ registry: store.registry, audience: irohAudience(nodeId), requireChannelBinding: true });
  const attached = [];
  const jobs = createJobApprovals({ config, context: null, pipeline: { resumeJob: async () => {} },
    listJobs: async () => (attached.length ? [] : [{ jobId: 'OA-waiting', state: 'awaiting-approval' }]),
    readCommit: async () => commit, attach: async (input) => { attached.push(input); }, git: gitIn(checkout) });
  const approvals = createApprovalRelay({ publisher: publisherSigningFromSocket({ socketPath, ownerRequest }), refresh: () => jobs.refresh(approvals) });
  const commands = createOwnerCommands({ config, devicePrincipalAdapter: verifier, approvals });
  const carrier = startIrohCarrier({ endpoint, commands, verifier, pairing, relay: 'none' });
  pairing.attachNode({ nodeId, ticket: carrier.ticket });
  cleanup.push(() => carrier.close());
  const phone = createController({ client: createNodeClient({ carrier: nodeBindingsCarrier() }),
    store: createDeviceStore(memoryBackend(), 'vault:p'), signingStore: signing.createSigningStore(memoryBackend(), 'vault:p'), tapGate: testGate() });
  await pairedDevice({ pairing, controller: phone, access: 'full' });

  // The link the OS hands to Obsidian after scanning the publisher's QR code.
  const enrolled = await phone.enrol(Object.fromEntries(new URL(scanned).searchParams), { label: 'Pixel', tap: finger() });
  const keys = await services.ownerKeys.keys?.() ?? null;
  expect((await services.ownerKeys.status()).devices).toBe(1);
  if (keys !== null) expect(JSON.stringify(keys)).toContain(enrolled.keyId);

  const [waiting] = await phone.waitingApprovals();
  const prepared = await phone.readApproval(waiting.requestId);
  expect(prepared.summary.files[0].preview.filter((part) => part.kind === 'added')).toEqual([{ kind: 'added', text: 'weekly.' }]);
  await phone.approve(prepared, finger());
  for (let i = 0; i < 100 && attached.length === 0; i += 1) await Bun.sleep(20);
  expect(attached).toHaveLength(1);
  // The publisher's own gate: key on its list, signature, nonce, target, then the commit field by field.
  const authorization = await services.gate.authorize(attached[0].record, { remote: config.repository.remote.url, branch: config.repository.branch });
  expect(authorization.admitted.keyId).toBe(enrolled.keyId);
  await authorization.verifyCommit(gitIn(checkout), commit);
  // Spent: the same approval cannot be used twice.
  await expect(services.gate.authorize(attached[0].record, { remote: config.repository.remote.url, branch: config.repository.branch }))
    .rejects.toHaveProperty('code');
}, 90_000);

test('relay: the node refuses requests whose bytes disagree with the intent, and answers that differ from the request', async () => {
  const publisher = createStubPublisher();
  const relay = createApprovalRelay({ publisher });
  const before = Buffer.from('a\n'); const after = Buffer.from('b\n');
  const intent = publishIntent({ publisher: publisher.publisher, nonce: publisher.challenge().nonce, path: 'a.md', before, after });
  expect(() => relay.request({ askedBy: 'x', intent, files: [{ path: 'a.md', before: before.toString('base64'), after: before.toString('base64') }] }))
    .toThrow(expect.objectContaining({ code: 'approval-invalid' }));
  const asked = relay.request({ askedBy: 'x', intent, files: [{ path: 'a.md', before: before.toString('base64'), after: after.toString('base64') }] });
  const changed = { ...intent, keyId: 'device-1', target: { ...intent.target, branch: 'other' } };
  expect(() => relay.submit({ requestId: asked.requestId, intent: changed, approval: { type: 'ed25519', signature: 'A'.repeat(86) } }))
    .toThrow(expect.objectContaining({ code: 'approval-mismatch' }));
  expect(new NodeError('refused', 'approval-mismatch').reason).toBe('approval-mismatch');
});

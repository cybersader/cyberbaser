import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SecretKey } from '@number0/iroh';
import { validateOwnerAlphaConfig } from '../src/config.js';
import { createCaptureProposalBuilder, deliveryPathFor, readCommittedDelivery } from '../src/core/capture-submission.js';
import { createOwnerCommands, executeSigned } from '../src/core/commands.js';
import { createLiveDeviceKeyRegistry } from '../src/core/device-keys.js';
import { openDeviceStore } from '../src/core/device-store.js';
import { createDevicePrincipalAdapter } from '../src/core/principal.js';
import { PROPOSAL_BUDGET } from '../src/core/proposal-submission.js';
import { signedInputDigest, signedRequestBytes } from '../src/core/signed-request.js';
import { bindEndpoint, CMD_ALPN, IROH_COMMANDS, irohAudience, PAIR_ALPN, sendSignedRequestOverIroh, startIrohCarrier } from '../src/iroh-carrier.js';

// A paired phone sends the note it has open (path + text); the node binds it
// to the committed vault text and queues an ordinary proposal. A full-access
// phone may also ask which version is live. No HTTP route is involved.

const example = await Bun.file(new URL('../owner-alpha.example.json', import.meta.url)).json();
const cleanup = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });

const BASE = '---\r\ntitle: Garden\r\n---\r\n\r\n# Garden\r\n\r\nWater the tomatoes daily.\r\n';
const MAPPING = { id: 'garden', source: { identity: 'phone-workspace', path: 'Notes/Garden.md', kind: 'workspace' },
  relativePath: 'garden.md', slug: 'garden' };
const REPOSITORY = example.repository.remote.url;

function configFor(checkout, { publication = true } = {}) {
  return validateOwnerAlphaConfig({ ...example,
    repository: { ...example.repository, checkout, remote: { name: 'origin', url: REPOSITORY } },
    proposalReview: { ...example.proposalReview, enabled: true, socketPath: '/run/cb/review.sock' },
    ...(publication ? { ownerPublication: { enabled: true, mappings: [MAPPING] } } : {}) });
}

async function tempDir() {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'cb-capture-')));
  await chmod(dir, 0o700);
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'commit.gpgSign=false', ...args], { encoding: 'utf8' }).trim();

async function vault(files = { 'garden.md': BASE, 'other.md': '# Other\n\nPlain.\n' }) {
  const checkout = path.join(await tempDir(), 'vault');
  await mkdir(checkout);
  for (const [name, text] of Object.entries(files)) await writeFile(path.join(checkout, name), text);
  git(checkout, 'init', '-q', '--initial-branch=main');
  git(checkout, 'config', 'user.name', 'T'); git(checkout, 'config', 'user.email', 't@example.invalid');
  git(checkout, 'add', '-A'); git(checkout, 'commit', '-q', '-m', 'base');
  return checkout;
}

function deviceKey() {
  const pair = generateKeyPairSync('ed25519');
  return { privateKey: pair.privateKey, publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64') };
}

function entry(keyId, publicKey, { kind = 'owner-device', grants = ['propose'], irohNodeId } = {}) {
  return { keyId, publicKey, actor: { kind, id: keyId, label: `${keyId} label` }, grants, notBefore: Date.now() - 1000,
    notAfter: Date.now() + 600_000, revoked: false, ...(irohNodeId ? { irohNodeId } : {}) };
}

function envelope({ keyId, privateKey, audience, input, command, channelBinding }) {
  const claims = { audience, keyId, command, inputDigest: signedInputDigest(input), nonce: randomBytes(16).toString('base64'),
    issuedAt: Date.now(), ...(channelBinding ? { channelBinding } : {}) };
  return { ...claims, input, signature: sign(null, signedRequestBytes(claims), privateKey).toString('base64') };
}

// ---- Binding a capture to the vault ----

test('capture: the node binds the text to the committed vault blob in the vault spelling', async () => {
  const checkout = await vault();
  const config = configFor(checkout);
  const head = git(checkout, 'rev-parse', 'HEAD');
  const build = createCaptureProposalBuilder({ config, clock: () => Date.parse('2026-11-23T10:00:00Z') });
  // The phone's copy uses LF; the vault uses CRLF. One changed word.
  const phone = BASE.replaceAll('\r\n', '\n').replace('daily', 'weekly');
  const built = await build({ path: 'Notes/Garden.md', text: phone });
  expect(built.unchanged).toBe(false);
  expect(built.deliveryPath).toBe('garden.md');
  const text = JSON.stringify(built.proposal);
  expect(text).toContain(REPOSITORY);
  expect(text).toContain(head);
  expect(text).toContain('"garden.md"');
  // The smallest exact splice: "dai|ly" becomes "week|ly".
  expect(text).toContain('"expected":"dai","replacement":"week"');
  // Same text, different line endings: nothing to submit.
  expect(await build({ path: 'Notes/Garden.md', text: BASE.replaceAll('\r\n', '\n') })).toEqual({ unchanged: true, deliveryPath: 'garden.md' });
  // A path with no publication mapping names the same vault file.
  expect(deliveryPathFor(config, 'other.md')).toBe('other.md');
  expect((await build({ path: 'other.md', text: '# Other\n\nPlainer.\n' })).deliveryPath).toBe('other.md');
});

test('capture: refusals for paths, sizes, missing notes and unmatchable text', async () => {
  const checkout = await vault();
  const config = configFor(checkout);
  const build = createCaptureProposalBuilder({ config });
  const code = (input) => build(input).then(() => 'accepted', (error) => error.code);
  expect(await code({ path: '../garden.md', text: 'x' })).toBe('capture-path-refused');
  expect(await code({ path: 'garden.txt', text: 'x' })).toBe('capture-path-refused');
  expect(await code({ path: '.git/config.md', text: 'x' })).toBe('capture-path-refused');
  expect(await code({ path: 'missing.md', text: 'x' })).toBe('capture-base-unavailable');
  expect(await code({ path: 'garden.md', text: 'x'.repeat(config.limits.maxSourceBytes + 1) })).toBe('capture-too-large');
  expect(await code({ path: 'garden.md', text: 'a\uFEFFb' })).toBe('delivery-not-round-trippable');
  expect(await code({ path: 'garden.md', text: 'x', extra: 1 })).toBe('invalid-command-input');
  // The working tree never counts: an uncommitted edit is not the base.
  await writeFile(path.join(checkout, 'garden.md'), 'uncommitted\n');
  const base = await readCommittedDelivery({ config, relativePath: 'garden.md' });
  expect(base.base.toString('utf8')).toBe(BASE);
});

// ---- Commands: grants, budget, status ----

function commandsFor({ config, grants, kind = 'owner-device', submitted = [], publication = null, readCaptureBase }) {
  const key = deviceKey();
  const { registry } = createLiveDeviceKeyRegistry({ ownerId: config.owner.identity,
    entries: [entry('phone-1', key.publicKey, { kind, grants })] });
  const verifier = createDevicePrincipalAdapter({ registry, audience: 'local-test' });
  const commands = createOwnerCommands({ config, devicePrincipalAdapter: verifier, publication, readCaptureBase,
    proposalReview: { submitSigned: async (input) => {
      submitted.push(input);
      return { queueId: `Q-${randomUUID()}`, acceptedAt: '2026-11-23T10:00:00Z', baseBound: true };
    } } });
  const run = (command, input) => executeSigned(commands, verifier, envelope({ keyId: 'phone-1', privateKey: key.privateKey,
    audience: 'local-test', command, input }));
  return { run, submitted };
}

test('submitCapture: queues as the paired device with the propose grant and shares the proposal budget', async () => {
  const checkout = await vault();
  const config = configFor(checkout);
  const submitted = [];
  const { run } = commandsFor({ config, grants: ['propose'], submitted });
  const receipt = await run('submitCapture', { path: 'Notes/Garden.md', text: BASE.replace('daily', 'weekly') });
  expect(receipt).toMatchObject({ baseBound: true, deliveryPath: 'garden.md' });
  expect(submitted[0].submitter).toEqual({ kind: 'owner-device', id: 'phone-1', label: 'phone-1 label', keyId: 'phone-1' });
  // Unchanged text is not queued but still counts against the budget.
  expect(await run('submitCapture', { path: 'Notes/Garden.md', text: BASE })).toEqual({ unchanged: true, deliveryPath: 'garden.md' });
  for (let i = 2; i < PROPOSAL_BUDGET.attempts; i += 1) {
    await run('submitCapture', { path: 'Notes/Garden.md', text: BASE.replace('daily', `day ${i}`) });
  }
  await expect(run('submitCapture', { path: 'Notes/Garden.md', text: BASE.replace('daily', 'more') })).rejects.toHaveProperty('code', 'proposal-budget-exhausted');
  expect(submitted.length).toBe(PROPOSAL_BUDGET.attempts - 1);
});

test('submitCapture and readNoteStatus refuse devices without the grant; propose-only status is the public tier', async () => {
  const checkout = await vault();
  const config = configFor(checkout);
  // A device without propose cannot capture.
  const reader = commandsFor({ config, grants: ['read'] });
  await expect(reader.run('submitCapture', { path: 'garden.md', text: 'x' })).rejects.toHaveProperty('code', 'invalid-session');
  // A device without propose or publication gets no status at all.
  await expect(reader.run('readNoteStatus', { path: 'garden.md' })).rejects.toHaveProperty('code', 'invalid-session');
  // A propose-only phone or agent gets only the public tier: no drafts, no
  // mapping, no publishing (here the node has no selection, so not public).
  const proposer = commandsFor({ config, grants: ['propose'] });
  expect(await proposer.run('readNoteStatus', { path: 'Notes/Garden.md' })).toEqual({ path: 'Notes/Garden.md', selected: false, live: null });
  const agent = commandsFor({ config, grants: ['propose'], kind: 'agent' });
  expect(await agent.run('readNoteStatus', { path: 'garden.md' })).toEqual({ path: 'garden.md', selected: false, live: null });
  // Paths outside the vault policy are refused before any Git read.
  let reads = 0;
  const counted = commandsFor({ config, grants: ['propose'], readCaptureBase: async (input) => { reads += 1; return readCommittedDelivery(input); } });
  await expect(counted.run('submitCapture', { path: '.workspace/x.md', text: 'x' })).rejects.toHaveProperty('code', 'capture-path-refused');
  expect(reads).toBe(0);
});

test('readNoteStatus: the configured page reports its live version; other notes are not selected', async () => {
  const checkout = await vault();
  const config = configFor(checkout);
  const live = { version: 3, foldedTextDigest: 'sha-256=:AAAA:', attribution: null, jobId: 'OA-1', verified: true, liveKind: 'text' };
  const publication = { publishAvailable: true, readStatus: async ({ mappingId }) => ({ mappingId, selected: true, live,
    latest: { draftId: 'd'.repeat(64), version: 4, foldedTextDigest: 'sha-256=:BBBB:', attribution: null, jobId: 'OA-2', state: 'running' } }) };
  const { run } = commandsFor({ config, grants: ['read', 'save', 'review', 'apply', 'publication', 'publish', 'propose'], publication });
  expect(await run('readNoteStatus', { path: 'Notes/Garden.md' })).toEqual({ path: 'Notes/Garden.md', selected: true, mappingId: 'garden', workspace: true,
    live: { version: 3, digest: 'sha-256=:AAAA:', folded: true }, latest: { version: 4, state: 'running', draftId: 'd'.repeat(64) }, publishAvailable: true });
  expect(await run('readNoteStatus', { path: 'other.md' })).toEqual({ path: 'other.md', selected: false, publishAvailable: true });
  // With publication off, only the public tier remains.
  const off = commandsFor({ config: configFor(checkout, { publication: false }), grants: ['publication', 'propose'] });
  expect(await off.run('readNoteStatus', { path: 'garden.md' })).toEqual({ path: 'garden.md', selected: false, live: null });
  const offOnly = commandsFor({ config: configFor(checkout, { publication: false }), grants: ['publication'] });
  expect(await offOnly.run('readNoteStatus', { path: 'garden.md' })).toEqual({ path: 'garden.md', selected: false, live: null });
});

// ---- Over the Iroh carrier ----

test('carrier: a paired phone captures over Iroh; refusals carry only fixed reasons; status is grant-checked', async () => {
  const checkout = await vault();
  const root = await tempDir();
  const config = configFor(checkout);
  const store = await openDeviceStore({ directory: path.join(root, 'devices'), ownerId: config.owner.identity, parentDirectory: root });
  const endpoint = await bindEndpoint({ secretKey: randomBytes(32), relay: 'none', bindAddress: '127.0.0.1:0', alpns: [CMD_ALPN, PAIR_ALPN] });
  const nodeId = endpoint.id().toString();
  const verifier = createDevicePrincipalAdapter({ registry: store.registry, audience: irohAudience(nodeId), requireChannelBinding: true });
  const submitted = [];
  const queueId = `Q-${randomUUID()}`;
  const commands = createOwnerCommands({ config, devicePrincipalAdapter: verifier,
    proposalReview: { submitSigned: async (input) => { submitted.push(input); return { queueId, acceptedAt: '2026-11-23T10:00:00Z', baseBound: true }; } },
    publication: { publishAvailable: false, readStatus: async () => ({ selected: true, live: null, latest: null }) } });
  const carrier = startIrohCarrier({ endpoint, commands, verifier, relay: 'none' });
  cleanup.push(() => carrier.close());
  const key = deviceKey();
  const irohSecret = randomBytes(32);
  const clientId = SecretKey.fromBytes([...irohSecret]).public().toString();
  const { keyId } = await store.enrol({ kind: 'owner-device', label: 'Phone', grants: ['propose'], publicKey: key.publicKey, irohNodeId: clientId });
  const send = (command, input) => sendSignedRequestOverIroh({ secretKey: irohSecret, ticket: carrier.ticket,
    sign: (extra) => envelope({ keyId, privateKey: key.privateKey, command, input, ...extra }) });

  const ok = await send('submitCapture', { path: 'garden.md', text: BASE.replace('daily', 'weekly') });
  expect(ok).toEqual({ ok: true, receipt: { queueId, acceptedAt: '2026-11-23T10:00:00Z', baseBound: true, deliveryPath: 'garden.md' } });
  expect(submitted.length).toBe(1);
  expect(await send('submitCapture', { path: 'missing.md', text: 'x' })).toEqual({ ok: false, code: 'proposal-submission-refused', reason: 'capture-base-unavailable' });
  // Propose only: the public tier, never the publication page's drafts.
  expect(await send('readNoteStatus', { path: 'garden.md' })).toEqual({ ok: true, receipt: { path: 'garden.md', selected: false, live: null } });
  // Commands outside the device surface stay refused.
  expect(IROH_COMMANDS).not.toContain('applyProposal');
  expect(await send('applyProposal', { queueId: 'x' })).toEqual({ ok: false, code: 'proposal-submission-refused' });
  // After revoke nothing works.
  await store.revoke(keyId);
  expect(await send('submitCapture', { path: 'garden.md', text: BASE.replace('daily', 'hourly') })).toEqual({ ok: false, code: 'proposal-submission-refused' });
  expect(submitted.length).toBe(1);
});

test('config: an http relay is accepted only on 127.0.0.1 with a port', () => {
  const base = { ...example, proposalReview: { ...example.proposalReview, enabled: true, socketPath: '/run/cb/review.sock' } };
  const relay = (value) => validateOwnerAlphaConfig({ ...base, iroh: { enabled: true, stateDirectory: '/x', relay: value } }).iroh.relay;
  expect(relay('http://127.0.0.1:3340/')).toBe('http://127.0.0.1:3340/');
  for (const bad of ['http://127.0.0.1/', 'http://localhost:3340/', 'http://192.168.1.2:3340/', 'http://127.0.0.1:3340/?x=1']) {
    expect(() => relay(bad)).toThrow();
  }
});

import { afterEach, expect, test } from 'bun:test';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { readFile, readdir, rm } from 'node:fs/promises';
import { createJsonArtifactOnce } from '../src/artifacts.js';
import { createOwnerCommands, executeSigned } from '../src/core/commands.js';
import { createDeviceKeyRegistry } from '../src/core/device-keys.js';
import { createMemoryEditSessionStore } from '../src/core/edit-sessions.js';
import { createBootstrapPrincipalAdapter, createDevicePrincipalAdapter } from '../src/core/principal.js';
import { signedInputDigest, signedRequestBytes } from '../src/core/signed-request.js';
import { OwnerAlphaError } from '../src/errors.js';
import { initializeDurableJob } from '../src/job-state.js';
import { canonicalJson } from '../src/json.js';
import { createOwnerHandoffStore } from '../src/owner-direct.js';
import { createOwnerPublicationRuntime } from '../src/owner-publication-runtime.js';
import { pipelineArtifactPaths } from '../src/pipeline.js';
import { createEditSession } from '../src/source.js';
import { resolveStorePath } from '../src/store.js';
import { BASE, EDITED, MAPPING, cleanup, deferred, publicationFixture } from './publication-fixture.js';

const example = JSON.parse(await readFile(new URL('../owner-alpha.example.json', import.meta.url), 'utf8'));
const audience = 'synthetic-owner-node';
const at = Date.parse('2026-11-21T10:00:00Z');
const windowMs = 120_000;
const mapping = { mappingId: MAPPING.id };
const draft = { draftId: '7'.repeat(64) };
const lookup = { jobId: 'OA-device-input-fixture' };
const expectedRefusal = { name: 'OwnerAlphaError', code: 'invalid-session', message: 'a verified owner session is required', details: {} };

function syntheticKey(keyId, { grants = ['read'], actor, ...overrides } = {}) {
  const pair = generateKeyPairSync('ed25519');
  const publicKey = pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
  return {
    privateKey: pair.privateKey,
    entry: { keyId, publicKey, actor: actor ?? { kind: 'owner-device', id: keyId, label: `Device ${keyId}` }, grants,
      notBefore: at - 2 * windowMs, notAfter: at + 10 * windowMs, revoked: false, ...overrides },
  };
}

function envelope(key, command = 'readJob', input = lookup, overrides = {}) {
  const claims = { audience, keyId: key.entry.keyId, command, inputDigest: signedInputDigest(input),
    nonce: randomBytes(16).toString('base64'), issuedAt: at, ...overrides };
  return { ...claims, input, signature: sign(null, signedRequestBytes(claims), key.privateKey).toString('base64') };
}

function commandFixture(keys, { config = example, publication, proposalReview, ...options } = {}) {
  const registry = createDeviceKeyRegistry({ ownerId: config.owner.identity, entries: keys.map((key) => key.entry) });
  const principalAdapter = createBootstrapPrincipalAdapter();
  const devicePrincipalAdapter = createDevicePrincipalAdapter({ registry, audience, now: () => at, ...options });
  const commands = createOwnerCommands({ config, principalAdapter, devicePrincipalAdapter, publication, proposalReview,
    lookupJob: async (jobId) => ({ jobId, state: 'accepted' }) });
  return { commands, devicePrincipalAdapter, principalAdapter,
    run: (request, verifier = devicePrincipalAdapter) => executeSigned(commands, verifier, request) };
}

async function refused(action) {
  try { await action; } catch (error) {
    expect(error).toBeInstanceOf(OwnerAlphaError);
    const { name, code, message, details } = error;
    const shape = { name, code, message, details };
    expect(shape).toEqual(expectedRefusal);
    return JSON.stringify(shape);
  }
  throw new Error('expected the command to be refused');
}

function recordAudit() {
  const records = [];
  return { records, audit: (event) => records.push(event), get last() { return records.at(-1); } };
}

afterEach(async () => { await Promise.all(cleanup.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

test('an owner device follows one publication and a fresh signed retry recovers the same durable job after restart', async () => {
  const f = await publicationFixture();
  const key = syntheticKey('phone', { grants: ['publication', 'publish'] });
  const starts = [];
  // Same durable-acceptance fixture as the headless client; no publication effects run.
  const pipeline = {
    startEdit({ jobId, session, operation }) {
      const completion = deferred();
      const files = pipelineArtifactPaths(jobId);
      const accepted = (async () => {
        await createJsonArtifactOnce(f.context, files.session, session);
        await createJsonArtifactOnce(f.context, files.operation, operation);
        return initializeDurableJob(f.context, { jobId, policyRevision: session.policyRevision, at: new Date(at).toISOString() });
      })();
      starts.push(jobId);
      return { jobId, accepted, completion: completion.promise };
    },
  };
  function client() {
    const publication = createOwnerPublicationRuntime({ config: f.config, context: f.context, readNote: f.readNote, pipeline,
      sourceSession: (input) => createEditSession({ ...input, git: f.git }), checkoutReady: f.dependencies.assertCheckoutReady });
    return commandFixture([key], { config: f.config, publication });
  }
  const a = client();
  const issue = (command, input) => a.run(envelope(key, command, input));
  expect(await issue('readPublicationStatus', mapping)).toMatchObject({ ...mapping, selected: true, live: null, latest: null });
  const digest = `sha-256=:${createHash('sha256').update(EDITED).digest('base64')}:`;
  const { summary: { draftId } } = await issue('preparePublication', { ...mapping, expectedVersion: 7, expectedDigest: digest });
  expect(await issue('readPublicationReview', { draftId })).toMatchObject({ draft: { draftId }, publishAvailable: true });
  expect(await issue('readPublicationReceipt', { draftId })).toMatchObject({ ...mapping, draftId, digest, version: 7, state: 'prepared', liveVerified: false });

  const request = envelope(key, 'publish', { draftId });
  const first = await a.run(request);
  const { jobId } = first;
  expect(first).toMatchObject({ replayed: false, jobId: `OA-PUB-${draftId}` });
  expect(await issue('readPublicationStatus', mapping)).toMatchObject({ live: null, latest: { draftId, digest, version: 7, jobId, state: 'publishing' } });
  await refused(a.run(request));

  f.setUnavailable();
  const b = client();
  const retry = envelope(key, 'publish', { draftId });
  expect(retry.nonce).not.toBe(request.nonce);
  expect(await b.run(retry)).toMatchObject({ jobId, replayed: true });
  expect(await b.run(envelope(key, 'readPublicationStatus', mapping))).toMatchObject({ live: null, latest: { draftId, jobId } });
  expect(starts).toEqual([jobId]);
  expect(await readdir(resolveStorePath(f.context, 'jobs'))).toEqual([jobId]);
});

test('identical replay is refused while the same nonce on a different enrolled key is independent', async () => {
  const a = syntheticKey('one');
  const b = syntheticKey('two');
  const audit = recordAudit();
  const { run } = commandFixture([a, b], audit);
  const request = envelope(a);
  expect(await run(request)).toEqual({ ...lookup, state: 'accepted' });
  await refused(run(request));
  expect(audit.last.reason).toBe('replay');
  expect(await run(envelope(b, 'readJob', lookup, { nonce: request.nonce }))).toEqual({ ...lookup, state: 'accepted' });
});

test('the injected clock rejects old and future timestamps and accepts both exact boundaries', async () => {
  const key = syntheticKey('freshness');
  const audit = recordAudit();
  let now = at;
  const { run } = commandFixture([key], { audit: audit.audit, now: () => now });
  for (const [issuedAt, reason] of [[at - windowMs - 1, 'timestamp-too-old'], [at + windowMs + 1, 'timestamp-in-future']]) {
    await refused(run(envelope(key, 'readJob', lookup, { issuedAt })));
    expect(audit.last).toMatchObject({ at, reason });
  }
  for (const issuedAt of [at - windowMs, at + windowMs]) {
    expect(await run(envelope(key, 'readJob', lookup, { issuedAt }))).toHaveProperty('jobId', lookup.jobId);
  }
  now = at - 1;
  await refused(run(envelope(key)));
  expect(audit.last.reason).toBe('clock-regressed');
});

test('input substitution, command substitution, another audience and a wrong signing key are refused', async () => {
  const key = syntheticKey('binding');
  const other = syntheticKey('another');
  const audit = recordAudit();
  const { run } = commandFixture([key], audit);
  const request = envelope(key);
  for (const [bad, reason] of [
    [{ ...request, input: { jobId: 'OA-replaced-fixture' } }, 'input-digest-mismatch'],
    [{ ...request, command: 'readPublicationStatus' }, 'bad-signature'],
    [envelope(key, 'readJob', lookup, { audience: 'different-owner-node' }), 'audience-mismatch'],
    [envelope(other, 'readJob', lookup, { keyId: key.entry.keyId }), 'bad-signature'],
  ]) {
    await refused(run(bad));
    expect(audit.last.reason).toBe(reason);
  }
  expect(await run(request)).toHaveProperty('jobId', lookup.jobId);
});

test('the versioned transcript interoperates with a signer that does not use the verifier helper', async () => {
  const key = syntheticKey('wire-format');
  const { run } = commandFixture([key]);
  const inputDigest = createHash('sha256').update(canonicalJson(lookup), 'utf8').digest('hex');
  const nonce = Buffer.alloc(16, 1).toString('base64');
  const command = 'readJob';
  const claims = { audience, keyId: key.entry.keyId, command, inputDigest, nonce, issuedAt: at };
  const transcript = Buffer.from(JSON.stringify(['cyberbaser.owner-command.v1', audience, claims.keyId, command, inputDigest, nonce, at, null]));
  expect(signedRequestBytes(claims)).toEqual(transcript);
  expect(await run({ ...claims, input: lookup, signature: sign(null, transcript, key.privateKey).toString('base64') })).toHaveProperty('jobId', lookup.jobId);
});

test('a device attestation cannot be reused with different input, command, or a second execution', async () => {
  const key = syntheticKey('one-request');
  const { commands, devicePrincipalAdapter } = commandFixture([key]);
  const { principal, input } = devicePrincipalAdapter.verify(envelope(key), (name) => name === 'readJob');
  await refused(commands.readJob({ ...input }, principal));
  await refused(commands.readPageSource(input, principal)); // Also requires the read grant.
  expect(await commands.readJob(input, principal)).toHaveProperty('jobId', lookup.jobId);
  await refused(commands.readJob(input, principal));
});

test('canonical input is detached, immutable, descriptor-safe and order-independent', async () => {
  const key = syntheticKey('snapshot');
  const input = { z: { visible: 'original' }, a: ['first', -0] };
  const request = envelope(key, 'readPageSource', input);
  expect(request.inputDigest).toBe(createHash('sha256').update(canonicalJson(input)).digest('hex'));
  const reordered = { a: ['first', 0], z: { visible: 'original' } };
  const audit = recordAudit();
  const { devicePrincipalAdapter } = commandFixture([key], { audit: (event) => {
    audit.audit(event);
    if (event.outcome === 'accepted') reordered.z.visible = 'changed by audit after verification';
  } });
  const verified = devicePrincipalAdapter.verify({ ...request, input: reordered }, (name) => name === 'readPageSource');
  expect(verified.input).toEqual({ a: ['first', 0], z: { visible: 'original' } });
  expect(Object.isFrozen(verified.input.z)).toBe(true);
  expect(Object.isFrozen(verified.input.a)).toBe(true);
  expect(reordered.z.visible).toBe('changed by audit after verification');

  const { run } = commandFixture([key], audit);
  let accessed = false;
  const getter = { get jobId() { accessed = true; return lookup.jobId; } };
  const signed = envelope(key);
  for (const inputValue of [getter, { ...lookup, [Symbol('extra')]: true }, new Proxy(lookup, { get() { accessed = true; } })]) {
    await refused(run({ ...signed, input: inputValue }));
    expect(audit.last.reason).toBe('invalid-input');
  }
  expect(accessed).toBe(false);
});

test('required channel binding must match the actual connection; connection views share replay state', async () => {
  const key = syntheticKey('channel');
  const own = Buffer.alloc(32, 7);
  const other = Buffer.alloc(32, 8);
  const audit = recordAudit();
  const { run, devicePrincipalAdapter } = commandFixture([key], { audit: audit.audit, requireChannelBinding: true, channelBinding: own });
  await refused(run(envelope(key)));
  expect(audit.last.reason).toBe('channel-binding-missing');
  await refused(run(envelope(key, 'readJob', lookup, { channelBinding: other.toString('base64') })));
  expect(audit.last.reason).toBe('channel-binding-mismatch');
  const request = envelope(key, 'readJob', lookup, { channelBinding: own.toString('base64') });
  expect(await run(request)).toHaveProperty('jobId', lookup.jobId);
  await refused(run(request, devicePrincipalAdapter.forChannel(own)));
  expect(audit.last.reason).toBe('replay');
  const sameNonce = envelope(key, 'readJob', lookup, { channelBinding: other.toString('base64'), nonce: request.nonce });
  await refused(run(sameNonce, devicePrincipalAdapter.forChannel(other)));
  expect(audit.last.reason).toBe('replay');
  const fresh = envelope(key, 'readJob', lookup, { channelBinding: other.toString('base64') });
  expect(await run(fresh, devicePrincipalAdapter.forChannel(other))).toHaveProperty('jobId', lookup.jobId);
});

test('revoked, expired, pending and unknown keys return one byte-identical refusal with metadata-only audit', async () => {
  const revoked = syntheticKey('revoked', { revoked: true });
  const expired = syntheticKey('expired', { notAfter: at });
  const pending = syntheticKey('pending', { notBefore: at + 1 });
  const unknown = syntheticKey('unknown');
  const audit = recordAudit();
  const { run } = commandFixture([revoked, expired, pending], audit);
  const output = [];
  const sentinel = 'synthetic input content must not reach audit';
  const cases = [[revoked, 'revoked-key'], [expired, 'expired-key'], [pending, 'key-not-yet-valid'], [unknown, 'unknown-key']];
  for (const [key, reason] of cases) {
    const request = envelope(key, 'readJob', { sentinel });
    output.push(await refused(run(request)));
    expect(audit.last).toEqual({ keyId: key === unknown ? null : key.entry.keyId,
      actorKind: key === unknown ? null : 'owner-device', command: 'readJob', outcome: 'refused', reason, at });
    const serialized = `${output.at(-1)}\n${JSON.stringify(audit.last)}`;
    for (const value of [sentinel, request.inputDigest, request.signature, key.entry.publicKey,
      key.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')]) {
      expect(serialized.includes(value)).toBe(false);
    }
  }
  expect(new Set(output).size).toBe(1);
});

test('strict enrollment rejects agent effect grants, owner impersonation, duplicate keys/IDs, malformed keys and extra fields', () => {
  const ownerId = example.owner.identity;
  const a = syntheticKey('one');
  const b = syntheticKey('two');
  const agent = { kind: 'agent', id: 'fixture-agent', label: 'Fixture Agent' };
  const rejected = (entries) => expect(() => createDeviceKeyRegistry({ ownerId, entries })).toThrow('invalid device key enrollment registry');
  for (const grant of ['publish', 'apply', 'review', 'save', 'publication', 'read', 'approve']) {
    rejected([{ ...b.entry, actor: agent, grants: [grant] }]);
  }
  rejected([{ ...b.entry, actor: { ...agent, id: ownerId }, grants: [] }]);
  rejected([a.entry, { ...b.entry, keyId: a.entry.keyId }]);
  rejected([a.entry, { ...b.entry, publicKey: a.entry.publicKey }]);
  for (const publicKey of ['bad key', Buffer.alloc(31).toString('base64'), Buffer.alloc(32).toString('base64'), `${a.entry.publicKey}\n`]) {
    rejected([{ ...a.entry, publicKey }]);
  }
  rejected([{ ...a.entry, grants: ['approves'] }]);
  rejected([{ ...a.entry, grants: ['read', 'read'] }]);
  rejected([{ ...a.entry, actor: { ...a.entry.actor, other: 1 } }]);
  rejected([{ ...a.entry, privateKey: a.privateKey }]);
  rejected([{ ...a.entry, notBefore: a.entry.notAfter }]);
  rejected([{ ...a.entry, get revoked() { throw new Error('accessor invoked'); } }]);
  expect(createDeviceKeyRegistry({ ownerId, entries: [a.entry, { ...b.entry, actor: agent, grants: [] }] }).ownerId).toBe(ownerId);
});

test('agent principals cannot see selected notes or use owner effects and plain objects cannot attest', async () => {
  const actor = { kind: 'agent', id: 'fixture-agent', label: 'Fixture Agent' };
  const agent = syntheticKey('agent-key', { actor, grants: [] });
  const owner = syntheticKey('owner-key', { grants: ['publication'] });
  const audit = recordAudit();
  const config = { ...example, ownerPublication: { enabled: true, mappings: [MAPPING] } };
  const { run, commands, devicePrincipalAdapter, principalAdapter } = commandFixture([agent, owner], { config, audit: audit.audit });
  const agentPrincipal = devicePrincipalAdapter.verify(envelope(agent), (name) => name === 'readJob').principal;
  expect(agentPrincipal).toEqual({ id: actor.id, actor, method: 'device-key', keyId: agent.entry.keyId, authenticatedAt: at });
  expect(devicePrincipalAdapter.isVerified(agentPrincipal)).toBe(true);
  expect(principalAdapter.isVerified(agentPrincipal)).toBe(false);
  expect(agentPrincipal.id).not.toBe(config.owner.identity);
  const ownerPrincipal = devicePrincipalAdapter.verify(envelope(owner), (name) => name === 'readJob').principal;
  expect(ownerPrincipal.id).toBe(config.owner.identity);
  expect(Object.isFrozen(ownerPrincipal.actor)).toBe(true);
  for (const principal of [{ ...ownerPrincipal }, { ...agentPrincipal, id: config.owner.identity }, ownerPrincipal]) {
    if (principal === ownerPrincipal) await refused(commands.readJob(lookup, principal)); // Permission still requires a grant.
    else await refused(commands.readPublicationStatus(mapping, principal));
  }

  for (const [command, input] of [
    ['readPublicationStatus', mapping], ['readPublicationStatus', { mappingId: 'not-a-selected-note' }],
    ['readPublicationReceipt', draft], ['preparePublication', mapping], ['readPublicationReview', draft], ['publish', draft],
    ['applyProposal', {}], ['recordDecision', { action: 'approve' }], ['saveOwnerDirect', {}], ['saveRawEdit', {}],
  ]) {
    await refused(run(envelope(agent, command, input)));
    expect(audit.last).toMatchObject({ keyId: 'agent-key', actorKind: 'agent', command, outcome: 'accepted' }); // Authentication only.
  }
  for (const command of ['stageOwnerDirect', 'requireGrant', 'constructor']) {
    await refused(run(envelope(agent, command, {})));
    expect(audit.last).toMatchObject({ command: null, reason: 'unknown-command' });
  }
});

test('a signed owner-direct inspection cannot be saved by a different device key or browser session', async () => {
  const f = await publicationFixture();
  const a = syntheticKey('editor-key', { grants: ['read', 'save'] });
  const b = syntheticKey('second-key', { grants: ['save'] });
  const ownerId = f.config.owner.identity;
  const principalAdapter = createBootstrapPrincipalAdapter();
  const devicePrincipalAdapter = createDevicePrincipalAdapter({ audience, now: () => at,
    registry: createDeviceKeyRegistry({ ownerId, entries: [a.entry, b.entry] }) });
  const bootstrap = principalAdapter.fromSession({ id: ownerId, sessionId: a.entry.keyId, authenticatedAt: at });
  const jobId = 'OA-device-direct-fixture';
  const saves = [];
  const commands = createOwnerCommands({ config: f.config, projectRoot: f.root, principalAdapter, devicePrincipalAdapter,
    createEditSession: (input) => createEditSession({ ...input, git: f.git }),
    handoffs: createOwnerHandoffStore(), directEdits: createMemoryEditSessionStore(), createJobId: () => jobId,
    saveEdit: async (input) => { saves.push(input.jobId); return { jobId, state: 'accepted' }; } });
  const bytes = Buffer.from(BASE);
  const offset = bytes.indexOf('old');
  const staged = await commands.stageOwnerDirect({ handoff: {
    source: { path: MAPPING.relativePath, byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
    revision: f.head, slug: MAPPING.slug,
    operations: [{ operationId: 'change-old', start: offset, end: offset + 3, expected: 'old', replacement: 'new' }],
  } });
  const signed = (key, command, input) => executeSigned(commands, devicePrincipalAdapter, envelope(key, command, input));
  const { editId } = await signed(a, 'inspectOwnerDirect', staged);
  await expect(signed(b, 'saveOwnerDirect', { editId })).rejects.toHaveProperty('code', 'owner-handoff-expired');
  await expect(commands.saveOwnerDirect({ editId }, bootstrap)).rejects.toHaveProperty('code', 'owner-handoff-expired');
  expect(saves).toEqual([]);
  expect(await signed(a, 'saveOwnerDirect', { editId })).toEqual({ jobId, state: 'accepted' });
  expect(saves).toEqual([jobId]);
});

test('an enrolled owner key cannot bypass disabled features or borrow another key’s grants', async () => {
  const reader = syntheticKey('status-only', { grants: ['publication'] });
  const publisher = syntheticKey('publish-only', { grants: ['publish'] });
  const { run } = commandFixture([reader, publisher]);
  await refused(run(envelope(reader, 'publish', draft)));
  await refused(run(envelope(publisher, 'readPublicationStatus', mapping)));
  await expect(run(envelope(reader, 'readPublicationStatus', mapping))).rejects.toHaveProperty('code', 'publication-disabled');
  await expect(run(envelope(publisher, 'publish', draft))).rejects.toHaveProperty('code', 'publication-disabled');
});

test('a full replay cache fails closed, then evicts only when no accepted envelope is still fresh', async () => {
  let now = at;
  const key = syntheticKey('capacity');
  const audit = recordAudit();
  const { run } = commandFixture([key], { audit: audit.audit, maxReplayEntries: 1, now: () => now });
  const first = envelope(key, 'readJob', lookup, { issuedAt: at + windowMs });
  expect(await run(first)).toHaveProperty('jobId', lookup.jobId);
  const next = () => envelope(key, 'readJob', lookup, { issuedAt: now });
  for (const time of [at, at + windowMs + 1, at + 2 * windowMs]) {
    now = time;
    await refused(run(next()));
    expect(audit.last.reason).toBe('replay-cache-full');
    await refused(run(first));
    expect(audit.last.reason).toBe('replay');
  }
  now += 1;
  expect(await run(next())).toHaveProperty('jobId', lookup.jobId);
  await refused(run(first));
  expect(audit.last.reason).toBe('timestamp-too-old');
});

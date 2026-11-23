import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readdir, rm, unlink } from 'node:fs/promises';
import { createJsonArtifactOnce } from '../src/artifacts.js';
import { createOwnerCommands } from '../src/core/commands.js';
import { createBootstrapPrincipalAdapter } from '../src/core/principal.js';
import { JOB_STATES, initializeDurableJob, loadDurableJob, transitionDurableJob } from '../src/job-state.js';
import { createOwnerPublicationRuntime } from '../src/owner-publication-runtime.js';
import { PUBLICATION_JOB_STATES } from '../src/owner-publication-store.js';
import { PIPELINE_SCHEMA_VERSION, pipelineArtifactPaths } from '../src/pipeline.js';
import { createEditSession } from '../src/source.js';
import { resolveStorePath } from '../src/store.js';
import { BASE, EDITED, MAPPING, PRIVATE_ID, PRIVATE_PATH, cleanup, deferred, publicationFixture } from './publication-fixture.js';

const page = { mappingId: MAPPING.id };
const digest = (text) => `sha-256=:${createHash('sha256').update(text).digest('base64')}:`;
const secondText = BASE.replace('old', 'next');
const failureMessage = 'synthetic worker stderr must not escape';

afterEach(async () => { await Promise.all(cleanup.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture(options) {
  const f = await publicationFixture(options);
  const starts = [];
  let time = Date.parse('2026-11-21T10:00:00.000Z');
  const at = () => new Date(time += 1000).toISOString();
  // The effects worker is entirely synthetic. Its only outputs are the same
  // immutable records and legal durable transitions the real pipeline emits.
  const pipeline = {
    startEdit({ jobId, session, operation }) {
      const completion = deferred();
      const files = pipelineArtifactPaths(jobId);
      const accepted = (async () => {
        await createJsonArtifactOnce(f.context, files.session, session);
        await createJsonArtifactOnce(f.context, files.operation, operation);
        return initializeDurableJob(f.context, { jobId, policyRevision: session.policyRevision, at: at() });
      })();
      starts.push({ jobId, completion, files, liveUrl: session.liveUrl });
      return { jobId, accepted, completion: completion.promise };
    },
  };
  const client = (config = f.config) => {
    const principalAdapter = createBootstrapPrincipalAdapter();
    const owner = principalAdapter.fromSession({ id: config.owner.identity, sessionId: 'synthetic-client-session', authenticatedAt: 1 });
    const publication = createOwnerPublicationRuntime({ config, context: f.context, readNote: f.readNote, pipeline,
      sourceSession: (input) => createEditSession({ ...input, git: f.git }), checkoutReady: f.dependencies.assertCheckoutReady });
    const commands = createOwnerCommands({ config, principalAdapter, publication });
    return { commands, principalAdapter, owner,
      status: () => commands.readPublicationStatus(page, owner),
      prepare: (expected = {}) => commands.preparePublication({ ...page, ...expected }, owner),
      receipt: (draftId) => commands.readPublicationReceipt({ draftId }, owner),
      publish: (draftId) => commands.publish({ draftId }, owner) };
  };
  const advance = async (jobId, ...states) => {
    for (const state of states) {
      const failure = ['live-verification-failed', 'failed'].includes(state)
        ? { failure: { code: 'synthetic-check', message: failureMessage, retryable: state === 'live-verification-failed' } } : {};
      const durable = await transitionDurableJob(f.context, jobId, state, { at: at(), reason: `synthetic-${state}`, ...failure });
      if (['completed', 'failed', 'live-verification-failed'].includes(state)) {
        starts.find((start) => start.jobId === jobId).completion.resolve(durable);
      }
    }
  };
  const reachLiveCheck = (jobId) => advance(jobId, 'preflighting', 'checking', 'rendering', 'ready-to-apply', 'applying', 'source-applied',
    'committing', 'committed', 'pushing', 'pushed', 'discovering-run', 'run-bound', 'monitoring-deployment', 'deployment-succeeded', 'verifying-live');
  const witness = async (jobId, overrides = {}) => {
    const { files, liveUrl } = starts.find((start) => start.jobId === jobId);
    await createJsonArtifactOnce(f.context, files.live, { schemaVersion: PIPELINE_SCHEMA_VERSION, artifactType: 'owner-alpha-live-result',
      jobId, result: { pageUrl: liveUrl, oldWitnessAbsent: true, newWitnessUnique: true }, ...overrides });
  };
  return { ...f, client, starts, advance, reachLiveCheck, witness };
}

function assertNoPrivateData(payload) {
  const serialized = JSON.stringify(payload);
  for (const value of [BASE, EDITED, secondText, 'The old value.', 'The new value.', 'The next value.',
    ...[BASE, EDITED, secondText].map((text) => Buffer.from(text).toString('base64')),
    PRIVATE_ID, PRIVATE_PATH, MAPPING.relativePath, 'synthetic-client-session', failureMessage]) {
    expect(serialized).not.toContain(value);
  }
}

function expectedReceipt(draftId, version, text, jobId, state, liveVerified, attribution = 'unknown') {
  return { draftId, mappingId: MAPPING.id, version, digest: digest(text), jobId, state, liveVerified, attribution, ...(liveVerified && { liveKind: 'text' }) };
}

function expectedLatest(receipt) {
  const { draftId, version, digest, jobId, state, attribution } = receipt;
  return { draftId, version, digest, jobId, state, attribution };
}

test('headless client reviews an exact revision and follows one publication through replays, restart, and live verification', async () => {
  const f = await fixture();
  const attribution = ['audit-entry:opaque'];
  f.setAttribution(attribution);
  const a = f.client();
  expect(await a.status()).toEqual({ ...page, selected: true, live: null, latest: null });
  const { summary } = await a.prepare({ expectedVersion: 7, expectedDigest: digest(EDITED) });
  const { draftId } = summary;
  expect((await a.prepare({ expectedVersion: 7 })).summary).toEqual({ ...summary, replayed: true });
  const prepared = expectedReceipt(draftId, 7, EDITED, null, 'prepared', false, attribution);
  expect(await a.receipt(draftId)).toEqual(prepared);
  expect(await a.status()).toEqual({ ...page, selected: true, live: null, latest: expectedLatest(prepared) });

  const first = await a.publish(draftId);
  const { jobId } = first;
  expect(first.replayed).toBe(false);
  expect(jobId).toBe(`OA-PUB-${draftId}`);
  const publishing = expectedReceipt(draftId, 7, EDITED, jobId, 'publishing', false, attribution);
  expect(await a.status()).toEqual({ ...page, selected: true, live: null, latest: expectedLatest(publishing) });
  expect(await a.publish(draftId)).toEqual({ ...first, replayed: true });

  f.setUnavailable();
  const b = f.client(); // Fresh command set, principal adapter, and runtime; same durable store.
  expect(await b.publish(draftId)).toEqual({ ...first, replayed: true });
  expect(await b.receipt(draftId)).toEqual(publishing);
  expect(f.starts.map((start) => start.jobId)).toEqual([jobId]);
  expect(await readdir(resolveStorePath(f.context, 'jobs'))).toEqual([jobId]);

  await f.reachLiveCheck(jobId);
  expect(await b.status()).toEqual({ ...page, selected: true, live: null, latest: expectedLatest(publishing) });
  await f.witness(jobId);
  expect(await b.receipt(draftId)).toEqual(publishing); // Result persisted, confirmation transition not yet durable.
  await f.advance(jobId, 'live-confirmed', 'rebuilding-local', 'completed');
  const live = expectedReceipt(draftId, 7, EDITED, jobId, 'live', true, attribution);
  const receipt = await b.receipt(draftId);
  const status = await b.status();
  expect(receipt).toEqual(live);
  expect(status).toEqual({ ...page, selected: true, live: { version: 7, digest: digest(EDITED), jobId, verified: true, liveKind: 'text', attribution, confirmedAt: expect.any(String) }, latest: expectedLatest(live) });
  for (const payload of [receipt, status, prepared, publishing]) assertNoPrivateData(payload);
});

test('failed, missing, or wrongly bound live evidence never replaces the previous verified revision', async () => {
  const f = await fixture();
  const client = f.client();
  const first = (await client.prepare()).summary;
  const old = await client.publish(first.draftId);
  await f.reachLiveCheck(old.jobId);
  await f.witness(old.jobId);
  // Local rebuild failure does not undo the already recorded public check.
  await f.advance(old.jobId, 'live-confirmed', 'rebuilding-local', 'failed');
  expect(await client.receipt(first.draftId)).toEqual(expectedReceipt(first.draftId, 7, EDITED, old.jobId, 'needs-attention', true));
  const previous = { version: 7, digest: digest(EDITED), jobId: old.jobId, verified: true, liveKind: 'text', attribution: 'unknown', confirmedAt: expect.any(String) };
  expect((await client.status()).live).toEqual(previous);

  f.setSource(secondText, 8);
  const next = (await client.prepare()).summary;
  const newer = await client.publish(next.draftId);
  await f.reachLiveCheck(newer.jobId);
  expect((await client.status()).live).toEqual(previous);
  await f.advance(newer.jobId, 'live-verification-failed');
  const unverified = expectedReceipt(next.draftId, 8, secondText, newer.jobId, 'not-verified', false);
  const expectedStatus = { ...page, selected: true, live: previous, latest: expectedLatest(unverified) };
  expect(await client.status()).toEqual(expectedStatus);
  const receipt = await client.receipt(next.draftId);
  expect(receipt).toEqual(unverified);
  assertNoPrivateData(receipt);

  await f.advance(newer.jobId, 'verifying-live', 'live-confirmed');
  expect(await client.status()).toEqual(expectedStatus);
  await f.witness(newer.jobId, { jobId: old.jobId });
  expect(await client.status()).toEqual(expectedStatus);
  const liveFile = resolveStorePath(f.context, pipelineArtifactPaths(newer.jobId).live);
  await unlink(liveFile);
  await f.witness(newer.jobId, { result: { oldWitnessAbsent: true, newWitnessUnique: false } });
  expect(await client.status()).toEqual(expectedStatus);
  await unlink(liveFile);
  await f.witness(newer.jobId);
  expect((await client.status()).live).toEqual({ version: 8, digest: digest(secondText), jobId: newer.jobId, verified: true, liveKind: 'text', attribution: 'unknown', confirmedAt: expect.any(String) });
});

test('headless receipt and status distinguish an unchanged render from a text transition', async () => {
  const source = `---\nname: Example # old comment\n---\n${BASE}`;
  const edited = source.replace('old comment', 'new comment');
  const f = await fixture({ workspace: true, base: source, allowProperties: true });
  f.setSource(source, 1);
  await f.runtime.bindWorkspaceBaseline(page);
  f.setSource(edited, 2);
  const client = f.client();
  const { draftId } = (await client.prepare()).summary;
  const { jobId } = await client.publish(draftId);
  await f.reachLiveCheck(jobId);
  const { files, liveUrl } = f.starts[0];
  const commit = '2'.repeat(40);
  const stable = 'Synthetic page The old value.';
  const visibleTextDigest = `sha256:${createHash('sha256').update(stable).digest('hex')}`;
  const save = (file, artifactType, result) => createJsonArtifactOnce(f.context, file, { schemaVersion: PIPELINE_SCHEMA_VERSION, artifactType, jobId, result });
  const binding = { provider: 'github-actions', headSha: commit, runId: '42', runAttempt: 1 };
  await save(files.preApplyChecks, 'owner-alpha-pre-apply-check-result', { rendered: { witnesses: { kind: 'no-visible-change', stable, digest: visibleTextDigest } } });
  await save(files.committed, 'owner-alpha-committed-effect', { commit });
  await save(files.runBound, 'owner-alpha-run-bound-effect', { binding });
  await f.witness(jobId, { result: { kind: 'no-visible-change', pageUrl: liveUrl, stableWitnessPresent: true, applicationSha: commit, visibleTextDigest } });
  expect(await client.receipt(draftId)).toMatchObject({ liveVerified: false });
  await f.advance(jobId, 'live-confirmed', 'rebuilding-local', 'completed');
  expect(await client.receipt(draftId)).toMatchObject({ liveVerified: false });
  expect((await client.status()).live).toBeNull();
  await save(files.deployment, 'owner-alpha-deployment-result', { provider: binding.provider,
    run: { ...binding, status: 'completed', conclusion: 'success' }, environment: { state: 'success' } });
  const receipt = await f.client().receipt(draftId);
  const status = await f.client().status();
  expect(receipt).toMatchObject({ jobId, state: 'live', liveVerified: true, liveKind: 'no-visible-change' });
  expect(status.live).toMatchObject({ jobId, verified: true, liveKind: 'no-visible-change' });
  for (const payload of [receipt, status]) {
    expect(JSON.stringify(payload)).not.toContain(stable);
    expect(JSON.stringify(payload)).not.toContain(visibleTextDigest);
  }
});

test('only digest expectations refuse capture and Publish refuses changed prepared text', async () => {
  const f = await fixture();
  const client = f.client();
  await expect(client.prepare({ expectedDigest: digest(BASE) })).rejects.toHaveProperty('code', 'publication-expected-source-mismatch');
  await expect(readdir(resolveStorePath(f.context, 'owner-publication'))).rejects.toHaveProperty('code', 'ENOENT');
  expect(await client.status()).toEqual({ ...page, selected: true, live: null, latest: null });
  const { summary: { draftId, jobId } } = await client.prepare({ expectedVersion: 6, expectedDigest: digest(EDITED) });
  f.setSource(secondText, 7); // Same version, different text.
  await expect(client.publish(draftId)).rejects.toHaveProperty('code', 'authoring-source-stale');
  expect(await readdir(resolveStorePath(f.context, 'owner-publication/authorizations'))).toEqual([]);
  await expect(loadDurableJob(f.context, jobId)).rejects.toHaveProperty('code', 'artifact-not-found');
  expect(f.starts).toEqual([]);
  expect(await client.receipt(draftId)).toEqual(expectedReceipt(draftId, 7, EDITED, null, 'prepared', false));
});

test('status and receipt require the owner publication grant before inspecting or revealing input', async () => {
  const f = await fixture();
  const client = f.client();
  const { summary: { draftId } } = await client.prepare();
  const missingDraft = (draftId[0] === '0' ? '1' : '0') + draftId.slice(1);
  const otherOwner = client.principalAdapter.fromSession({ id: 'not-the-owner', sessionId: 'other', authenticatedAt: 1 });
  const untouchable = new Proxy({}, { getPrototypeOf() { throw new Error('input inspected before grant'); } });
  for (const principal of [undefined, { ...client.owner }, otherOwner]) {
    for (const input of [page, { mappingId: 'unknown-mapping' }, untouchable]) {
      await expect(client.commands.readPublicationStatus(input, principal)).rejects.toHaveProperty('code', 'invalid-session');
    }
    for (const input of [{ draftId }, { draftId: missingDraft }, untouchable]) {
      await expect(client.commands.readPublicationReceipt(input, principal)).rejects.toHaveProperty('code', 'invalid-session');
    }
  }
  const disabled = f.client({ ...f.config, ownerPublication: { enabled: false } });
  for (const input of [page, { mappingId: 'unknown-mapping' }]) {
    await expect(disabled.commands.readPublicationStatus(input, disabled.owner)).rejects.toHaveProperty('code', 'publication-disabled');
  }
  for (const id of [draftId, missingDraft]) {
    await expect(disabled.receipt(id)).rejects.toHaveProperty('code', 'publication-disabled');
  }
  await expect(client.commands.readPublicationStatus({ mappingId: 'unknown-mapping' }, client.owner)).rejects.toHaveProperty('code', 'publication-mapping-not-found');
  await expect(client.receipt(missingDraft)).rejects.toHaveProperty('code', 'publication-draft-not-found');
});

test('headless input shapes are closed and identifiers, versions, and digests are validated inside the core', async () => {
  const { commands, owner } = (await fixture()).client();
  const draftId = '0'.repeat(64);
  for (const [name, input, code] of [
    ['readPublicationStatus', { mappingId: '../note' }, 'invalid-publication-mapping-id'],
    ['readPublicationStatus', { mappingId: 'one..page' }, 'invalid-publication-mapping-id'],
    ['readPublicationStatus', { ...page, other: 1 }, 'invalid-command-input'],
    ['readPublicationStatus', { ...page, [Symbol('extra')]: 1 }, 'invalid-command-input'],
    ['readPublicationStatus', { get mappingId() { throw new Error('accessor invoked'); } }, 'invalid-command-input'],
    ['readPublicationReceipt', { draftId: `${draftId}/other` }, 'invalid-publication-draft-id'],
    ['readPublicationReceipt', { draftId, jobId: 'OA-other' }, 'invalid-command-input'],
    ['preparePublication', { ...page, unexpected: true }, 'invalid-command-input'],
    ['preparePublication', { ...page, expectedVersion: 0 }, 'invalid-publication-expected-version'],
    ['preparePublication', { ...page, expectedVersion: '7' }, 'invalid-publication-expected-version'],
    ['preparePublication', { ...page, expectedDigest: 'malformed' }, 'invalid-publication-expected-digest'],
    ['publish', { draftId, another: true }, 'invalid-command-input'],
    ['readJob', { jobId: '../other' }, 'invalid-job-id'],
    ['readJob', { jobId: 'OA-other', another: true }, 'invalid-command-input'],
  ]) await expect(commands[name](input, owner)).rejects.toHaveProperty('code', code);
});

test('history remains readable for the same mapping across unrelated policy revisions without reauthorizing Publish', async () => {
  const f = await fixture();
  const client = f.client();
  const { summary: { draftId } } = await client.prepare();
  const { jobId } = await client.publish(draftId);
  await f.reachLiveCheck(jobId);
  await f.witness(jobId);
  await f.advance(jobId, 'live-confirmed', 'rebuilding-local', 'completed');
  const revised = f.client({ ...f.config, limits: { ...f.config.limits, maxChangedLines: f.config.limits.maxChangedLines - 1 } });
  expect(await revised.receipt(draftId)).toEqual(await client.receipt(draftId));
  expect(await revised.status()).toEqual(await client.status());
  await expect(revised.publish(draftId)).rejects.toHaveProperty('code', 'publication-draft-policy-mismatch');
  const unrelated = f.client({ ...f.config, ownerPublication: { enabled: true, mappings: [{ ...MAPPING, slug: 'Notes/other' }] } });
  expect(await unrelated.status()).toEqual({ ...page, selected: true, live: null, latest: null });
  await expect(unrelated.receipt(draftId)).rejects.toHaveProperty('code', 'publication-draft-not-found');
});

test('the client state table classifies every durable job state exactly once', () => {
  expect(Object.keys(PUBLICATION_JOB_STATES).sort()).toEqual([...JOB_STATES].sort());
  const groups = Object.groupBy(JOB_STATES, (state) => PUBLICATION_JOB_STATES[state]);
  expect(groups).toEqual({
    publishing: ['accepted', 'preflighting', 'checking', 'rendering', 'ready-to-apply', 'applying', 'source-applied',
      'committing', 'committed', 'pushing', 'pushed', 'discovering-run', 'run-bound', 'monitoring-deployment',
      'deployment-succeeded', 'verifying-live'],
    live: ['live-confirmed', 'rebuilding-local', 'completed'],
    'not-verified': ['live-verification-failed'],
    'needs-attention': ['blocked-pre-apply', 'deployment-failed', 'manual-intervention', 'cancelled', 'failed'],
  });
});

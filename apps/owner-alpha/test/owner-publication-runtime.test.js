import { afterEach, expect, test } from 'bun:test';
import { chmod, link, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createJsonArtifactOnce } from '../src/artifacts.js';
import { createJobState } from '../src/job-state.js';
import { computePolicyRevision } from '../src/config.js';
import { createHash } from 'node:crypto';
import { defaultProposalReviewGit, readTrustPolicy } from '../src/proposal-review.js';
import { createPublicationJobReader, createPublicationSourceGuard } from '../src/owner-publication-runtime.js';
import { artifactJson } from '../src/json.js';
import { assertCheckoutReady } from '../src/source.js';
import { OwnerAlphaError } from '../src/errors.js';
import { BASE, MAPPING, PRIVATE_ID, PRIVATE_PATH, cleanup, publicationFixture } from './publication-fixture.js';

afterEach(async () => { await Promise.all(cleanup.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

test('real Git-bound preparation and immediate checks create only a private draft, not a job or source edit', async () => {
  const data = await publicationFixture();
  const result = await data.prepare();
  expect(result.summary.capturedVersion).toBe(7);
  expect(result.draft.prepared.session.baseCommit).toBe(data.head);
  expect(await data.runtime.readJob(result.draft.jobId)).toEqual({ status: 'missing' });
  expect(await readFile(path.join(data.root, MAPPING.relativePath), 'utf8')).toBe(BASE);
  expect(JSON.stringify(result.summary)).not.toContain(PRIVATE_ID);
  expect(JSON.stringify(result.summary)).not.toContain(PRIVATE_PATH);
});

test('pinned Git trust reader preserves significant trailing UTF-8 bytes instead of the text-trimming runner contract', async () => {
  const trust = 'trusted: [example]\n# Exact policy bytes: café  \n \n';
  const data = await publicationFixture({ trust });
  const policy = await readTrustPolicy(defaultProposalReviewGit, data.root, data.head);
  expect(policy.status).toBe('valid');
  expect(policy.digest).toBe(`sha-256=:${createHash('sha256').update(trust).digest('base64')}:`);
  expect((await data.prepare()).draft.checks.ok).toBe(true);
});

test('missing or malformed pinned trust policy refuses preparation, with no permissive fallback', async () => {
  for (const trust of [null, '[]\n', 'broken: [\n']) {
    const data = await publicationFixture({ trust });
    await expect(data.prepare()).rejects.toMatchObject({ code: 'publication-immediate-checks-failed' });
    await expect(readFile(path.join(data.context.storeRoot, 'owner-publication/drafts'))).rejects.toMatchObject({ code: 'ENOENT' });
  }
});

test('actual durable pipeline acceptance and concurrent duplicate Publish share one job; stale source after rendering blocks effects', async () => {
  const data = await publicationFixture();
  const { draft } = await data.prepare();
  const receipts = await Promise.all(Array.from({ length: 3 }, () => data.runtime.publish({ draftId: draft.draftId })));
  expect(receipts.filter((item) => !item.replayed)).toHaveLength(1);
  expect(new Set(receipts.map((item) => item.jobId)).size).toBe(1);
  const status = await data.runtime.readJob(draft.jobId);
  expect(status.status).toBe('present');
  expect(status.session.origin.reference.source.identity).toBe(PRIVATE_ID);
  expect(status.publication.draftId).toBe(draft.draftId);
  data.setSource(); // same bytes, newer coherent save version must still refuse.
  data.renderGate.resolve({ ok: true, rendered: { witnesses: { old: 'old', new: 'new' } } });
  const completed = await data.completion;
  expect(completed.state).toBe('blocked-pre-apply');
  expect(completed.failure.code).toBe('authoring-source-stale');
  expect(await readFile(path.join(data.root, MAPPING.relativePath), 'utf8')).toBe(BASE);
  const reads = data.reads;
  data.setUnavailable();
  const replay = await data.runtime.publish({ draftId: draft.draftId });
  expect(replay.replayed).toBe(true);
  expect(replay.state).toBe('blocked-pre-apply');
  expect(data.reads).toBe(reads);
  expect((await data.prepare().catch(() => null))).toBeNull();
});

test('a source save AFTER successful rendering and final checkout verification still blocks before application', async () => {
  let data; let rendered = false; let effects = 0;
  data = await publicationFixture({ overrides: {
    runPreApplyChecks: async () => { const checks = await data.renderGate.promise; rendered = true; return checks; },
    assertCheckoutReady: async (config) => {
      const ready = await assertCheckoutReady(config, { git: data.git });
      if (rendered) data.setSource(); // completed render, then checkout, then host save.
      return ready;
    },
    applyAcceptedOperation: async () => { effects += 1; throw new Error('must not apply'); },
  } });
  const { draft } = await data.prepare(); await data.runtime.publish({ draftId: draft.draftId });
  data.renderGate.resolve({ ok: true }); const result = await data.completion;
  expect(rendered).toBe(true); expect(effects).toBe(0); expect(result.state).toBe('blocked-pre-apply');
  expect(result.failure.code).toBe('authoring-source-stale');
});

test('matching immutable authorization and unchanged source pass the real final guard exactly once before application', async () => {
  let effects = 0;
  const data = await publicationFixture({ overrides: {
    applyAcceptedOperation: async () => { effects += 1; throw new OwnerAlphaError('synthetic-stop', 'stop at synthetic effect boundary'); },
  } });
  const { draft } = await data.prepare(); await data.runtime.publish({ draftId: draft.draftId }); const before = data.reads;
  data.renderGate.resolve({ ok: true }); const result = await data.completion;
  expect(effects).toBe(1); expect(data.reads).toBe(before + 1); expect(result.failure.code).toBe('synthetic-stop');
});

test('guard keeps stale source, missing or tampered authorization, and missing draft failures distinct before effects', async () => {
  for (const [condition, code] of [['stale', 'authoring-source-stale'], ['missing-authorization', 'publication-handoff-unapproved'],
    ['tampered-authorization', 'publication-authorization-mismatch'], ['missing-draft', 'publication-draft-not-found'], ['policy', 'publication-draft-policy-mismatch']]) {
    let effects = 0;
    const data = await publicationFixture({ overrides: { applyAcceptedOperation: async () => { effects += 1; throw new Error('must not apply'); } } });
    const { draft } = await data.prepare();
    if (condition === 'policy') {
      const changed = structuredClone(data.config); changed.git.commitMessagePrefix = 'synthetic-changed-policy:';
      data.dependencies.revalidateSource = createPublicationSourceGuard({ config: changed, context: data.context, readNote: data.readNote });
    }
    await data.runtime.publish({ draftId: draft.draftId });
    const authorization = path.join(data.context.storeRoot, 'owner-publication/authorizations', `${draft.draftId}.json`);
    if (condition === 'stale') data.setSource();
    if (condition === 'missing-authorization') await rm(authorization);
    if (condition === 'missing-draft') await rm(path.join(data.context.storeRoot, 'owner-publication/drafts', `${draft.draftId}.json`));
    if (condition === 'tampered-authorization') {
      const event = JSON.parse(await readFile(authorization, 'utf8'));
      event.authority.identity = 'synthetic-other-owner'; await writeFile(authorization, artifactJson(event));
    }
    data.renderGate.resolve({ ok: true }); const result = await data.completion;
    expect(result.state).toBe('blocked-pre-apply'); expect(result.failure.code).toBe(code); expect(effects).toBe(0);
    expect(JSON.stringify(result.failure)).not.toContain(PRIVATE_ID); expect(JSON.stringify(result.failure)).not.toContain(PRIVATE_PATH);
  }
});

test('guard unknown or hostile error descriptors stay generic without reading error getters or leaking secret-bearing codes', async () => {
  const data = await publicationFixture(); const guard = createPublicationSourceGuard({ config: data.config, context: data.context, readNote: data.readNote });
  let getters = 0;
  const unknown = Object.assign(new OwnerAlphaError(PRIVATE_ID, PRIVATE_PATH), { details: { secret: PRIVATE_PATH } });
  const accessor = new OwnerAlphaError('authoring-source-stale', PRIVATE_PATH);
  Object.defineProperty(accessor, 'code', { get() { getters += 1; throw new Error(PRIVATE_ID); } });
  const reflected = new Proxy(new OwnerAlphaError('authoring-source-stale', PRIVATE_PATH), {
    getOwnPropertyDescriptor() { throw new Error(PRIVATE_ID); },
  });
  for (const error of [unknown, accessor, reflected, Object.assign(new Error(PRIVATE_PATH), { code: 'authoring-source-stale' })]) {
    const session = { origin: { type: 'owner-publication', get draftId() { throw error; } } };
    try { await guard({ jobId: 'synthetic-unstarted', session, operation: {} }); throw new Error('expected refusal'); }
    catch (failure) {
      expect(failure.code).toBe('publication-source-check-failed'); expect(failure.message).toBe('publication source and authorization could not be validated');
      expect(failure.details).toEqual({}); expect(JSON.stringify(failure)).not.toContain(PRIVATE_ID); expect(JSON.stringify(failure)).not.toContain(PRIVATE_PATH);
    }
  }
  expect(getters).toBe(0);
});

test('guard allowlisted codes use fixed messages and never copy a known error message or details', async () => {
  const data = await publicationFixture(); const guard = createPublicationSourceGuard({ config: data.config, context: data.context, readNote: data.readNote });
  const known = new OwnerAlphaError('publication-authorization-mismatch', PRIVATE_PATH, { secret: PRIVATE_ID });
  let getters = 0;
  Object.defineProperty(known, 'message', { get() { getters += 1; throw new Error(PRIVATE_PATH); } });
  Object.defineProperty(known, 'details', { get() { getters += 1; throw new Error(PRIVATE_ID); } });
  const session = { origin: { type: 'owner-publication', get draftId() { throw known; } } };
  await expect(guard({ jobId: 'synthetic-unstarted', session, operation: {} })).rejects.toMatchObject({ code: 'publication-authorization-mismatch',
    message: 'publication owner authorization does not match the reviewed draft', details: {} });
  expect(getters).toBe(0);
});

test('real job reader refuses partial directory, missing inputs and unsafe private artifacts instead of proving absence', async () => {
  const data = await publicationFixture();
  const id = 'OA-PUB-ambiguous'; const directory = path.join(data.context.storeRoot, 'jobs', id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  expect(await data.runtime.readJob(id)).toEqual({ status: 'unavailable' });
  await createJsonArtifactOnce(data.context, `jobs/${id}/state.json`, createJobState({ jobId: id, policyRevision: computePolicyRevision(data.config) }));
  expect(await data.runtime.readJob(id)).toEqual({ status: 'unavailable' });
  await chmod(directory, 0o755);
  expect(await data.runtime.readJob(id)).toEqual({ status: 'unavailable' });
  await chmod(directory, 0o700);
  await rm(directory, { recursive: true });
  await symlink(data.root, directory);
  expect(await data.runtime.readJob(id)).toEqual({ status: 'unavailable' });
});

test('actual accepted-job reader hardens state/session/operation reads and canonical bytes', async () => {
  const data = await publicationFixture(); const { draft } = await data.prepare();
  await data.runtime.publish({ draftId: draft.draftId });
  const file = path.join(data.context.storeRoot, 'jobs', draft.jobId, 'session.json');
  const original = await readFile(file);
  await chmod(file, 0o644); expect(await data.runtime.readJob(draft.jobId)).toEqual({ status: 'unavailable' });
  await chmod(file, 0o600);
  await link(file, `${file}.link`); expect(await data.runtime.readJob(draft.jobId)).toEqual({ status: 'unavailable' });
  await rm(`${file}.link`);
  await writeFile(file, `${original.toString()} `); expect(await data.runtime.readJob(draft.jobId)).toEqual({ status: 'unavailable' });
  await writeFile(file, original);
  data.setSource(); data.renderGate.resolve({ ok: true }); await data.completion;
  expect((await data.runtime.readJob(draft.jobId)).status).toBe('present');
  const small = structuredClone(data.config);
  Object.assign(small.limits, { maxSourceBytes: 1024, maxChangedBytes: 128, maxReplacementBytes: 128, maxArtifactBytes: 1024 });
  // Bounded read maximum independently prevents parsing an oversized artifact.
  const read = createPublicationJobReader({ config: small, context: data.context });
  expect(await read(draft.jobId)).toEqual({ status: 'unavailable' });
});

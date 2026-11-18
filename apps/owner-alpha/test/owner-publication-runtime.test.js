import { afterEach, expect, test } from 'bun:test';
import { chmod, link, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createJsonArtifactOnce } from '../src/artifacts.js';
import { createJobState } from '../src/job-state.js';
import { computePolicyRevision } from '../src/config.js';
import { createHash } from 'node:crypto';
import { defaultProposalReviewGit, readTrustPolicy } from '../src/proposal-review.js';
import { createOwnerPublicationRuntime, createPublicationJobReader, createPublicationSourceGuard,
  PUBLICATION_VIEW_LIMIT, PUBLICATION_VIEW_BYTE_LIMIT, PUBLICATION_VIEW_TTL_MS } from '../src/owner-publication-runtime.js';
import { artifactJson } from '../src/json.js';
import { assertCheckoutReady, createEditSession, detectYamlFrontmatterRange } from '../src/source.js';
import { prepareOwnerPublication } from '../src/owner-publication.js';
import { OwnerAlphaError } from '../src/errors.js';
import { BASE, MAPPING, PRIVATE_ID, PRIVATE_PATH, cleanup, publicationFixture } from './publication-fixture.js';
import { cleanupPublicationReviewFixture, publicationReviewCase } from './publication-readonly-checkpoints.js';

afterEach(async () => { await Promise.all(cleanup.splice(0).map((root) =>
  cleanupPublicationReviewFixture(root, () => rm(root, { recursive: true, force: true })))); });

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

test('Prepare reads and creates a base once on both branches; changed artifacts are byte-identical to ordinary preparation', () =>
  publicationReviewCase('runtime-prepare', (onRoot) => publicationFixture({ onRoot }), async (data) => {
  let sessions = 0;
  const runtime = createOwnerPublicationRuntime({ config: data.config, context: data.context, readNote: data.readNote,
    sourceSession: async (input) => { sessions += 1; return createEditSession({ ...input, git: data.git }); } });
  const before = data.reads;
  const result = await runtime.prepare({ mappingId: MAPPING.id });
  expect(data.reads).toBe(before + 1); expect(sessions).toBe(1);
  const expected = await prepareOwnerPublication({ config: data.config, mappingId: MAPPING.id, readNote: data.readNote,
    createEditSession: (input) => createEditSession({ ...input, git: data.git }) });
  expect(artifactJson(result.draft.prepared)).toBe(artifactJson(expected));
  data.setSource(BASE, 9); const reads = data.reads;
  const unchanged = await runtime.prepare({ mappingId: MAPPING.id });
  expect(data.reads).toBe(reads + 1); expect(sessions).toBe(2);
  expect(Object.keys(unchanged).sort()).toEqual(['outcome', 'reviewUrl']);
  expect(unchanged.outcome).toBe('unchanged');
  const viewId = unchanged.reviewUrl.split('/').at(-1);
  expect(viewId).toMatch(/^[0-9a-f]{64}$/u);
  const view = runtime.loadCurrent({ viewId });
  expect(view.text).toBe(BASE); expect(Object.isFrozen(view)).toBe(true);
  expect(artifactJson(view)).not.toContain(PRIVATE_ID); expect(artifactJson(view)).not.toContain(PRIVATE_PATH);
  expect(data.reads).toBe(reads + 1);
}));

test('writer absence denies direct Publish before any context, source, checkout, authorization or job access', () =>
  publicationReviewCase('runtime-deny', (onRoot) => publicationFixture({ onRoot }), async (data) => {
  const { draft } = await data.prepare();
  let accesses = 0;
  const forbidden = () => { accesses += 1; throw new Error('must not run'); };
  for (const pipeline of [undefined, {}, { startEdit: null }]) {
    const runtime = createOwnerPublicationRuntime({ config: data.config, context: data.context, pipeline,
      readNote: forbidden, sourceSession: forbidden, checkoutReady: forbidden, onCompletion: forbidden });
    expect(runtime.publishAvailable).toBe(false);
    await expect(runtime.publish({ draftId: draft.draftId })).rejects.toMatchObject({ code: 'publication-start-unavailable' });
    const poison = createOwnerPublicationRuntime({ config: data.config, context: new Proxy({}, { get: forbidden }) });
    await expect(poison.publish({ draftId: 'invalid' })).rejects.toMatchObject({ code: 'publication-start-unavailable' });
  }
  expect(accesses).toBe(0); expect(data.reads).toBe(1);
  await expect(readFile(path.join(data.context.storeRoot, 'owner-publication/authorizations', `${draft.draftId}.json`))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await data.runtime.readJob(draft.jobId)).toEqual({ status: 'missing' });
  expect(data.runtime.publishAvailable).toBe(true);
}));

async function memoryReviewRuntime(onRoot) {
  const data = await publicationFixture({ onRoot });
  const template = await createEditSession({ config: data.config, renderer: { relativePath: MAPPING.relativePath, slug: MAPPING.slug }, git: data.git });
  let now = 1000; let text = BASE; let reads = 0; let sessions = 0;
  const session = () => {
    const bytes = Buffer.from(text);
    return { ...template, source: { ...template.source, text, bytesBase64: bytes.toString('base64'),
      byteLength: bytes.length, digest: `sha-256=:${createHash('sha256').update(bytes).digest('base64')}:`,
      frontmatter: detectYamlFrontmatterRange(bytes) } };
  };
  const runtime = createOwnerPublicationRuntime({ config: data.config, context: new Proxy({}, { get() { throw new Error('unchanged must not touch store'); } }),
    clock: () => now,
    readNote: async () => { reads += 1; const value = session(); return { ...MAPPING.source, version: 7, ...Object.fromEntries(['text', 'bytesBase64', 'byteLength', 'digest'].map((key) => [key, value.source[key]])) }; },
    sourceSession: async () => { sessions += 1; return session(); } });
  return { runtime, setText: (value) => { text = value; }, setTime: (value) => { now = value; },
    prepare: async () => (await runtime.prepare({ mappingId: MAPPING.id })).reviewUrl.split('/').at(-1),
    get reads() { return reads; }, get sessions() { return sessions; } };
}

test('unchanged views evict oldest entries at eight, refuse missing/invalid IDs and expire at thirty minutes without reads', () =>
  publicationReviewCase('runtime-entry-expiry', memoryReviewRuntime, async (data) => {
  const ids = [];
  expect(PUBLICATION_VIEW_LIMIT).toBe(8); expect(PUBLICATION_VIEW_TTL_MS).toBe(30 * 60 * 1000);
  for (let i = 0; i < 9; i += 1) { data.setText(`# Page ${i}\n\nFull unchanged page.\n`); ids.push(await data.prepare()); }
  expect(new Set(ids).size).toBe(9);
  for (const viewId of [ids[0], '0'.repeat(64), '../other', ids[1].toUpperCase(), null]) {
    expect(() => data.runtime.loadCurrent({ viewId })).toThrow();
  }
  for (const viewId of ids.slice(1)) expect(data.runtime.loadCurrent({ viewId }).text).toContain('Full unchanged page.');
  data.setTime(1000 + PUBLICATION_VIEW_TTL_MS - 1);
  expect(data.runtime.loadCurrent({ viewId: ids[1] }).text).toContain('Page 1');
  data.setTime(1000 + PUBLICATION_VIEW_TTL_MS);
  for (const viewId of ids) expect(() => data.runtime.loadCurrent({ viewId })).toThrow();
  expect(data.reads).toBe(9); expect(data.sessions).toBe(9);
  const fresh = await data.prepare(); expect(data.runtime.loadCurrent({ viewId: fresh }).text).toContain('Page 8');
}));

test('unchanged views enforce the total byte ceiling independently of entry count and refuse a single oversized view', () =>
  publicationReviewCase('runtime-byte-capacity', memoryReviewRuntime, async (data) => {
  expect(PUBLICATION_VIEW_BYTE_LIMIT).toBe(2 * 1024 * 1024);
  data.setText('a'.repeat(400_000)); const first = await data.prepare();
  data.setText('b'.repeat(400_000)); const second = await data.prepare();
  expect(() => data.runtime.loadCurrent({ viewId: first })).toThrow();
  expect(data.runtime.loadCurrent({ viewId: second }).byteLength).toBe(400_000);
  data.setText('c'.repeat(710_000));
  await expect(data.prepare()).rejects.toMatchObject({ code: 'publication-view-too-large' });
  expect(data.runtime.loadCurrent({ viewId: second }).byteLength).toBe(400_000);
  expect(data.reads).toBe(3); expect(data.sessions).toBe(3);
}));

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

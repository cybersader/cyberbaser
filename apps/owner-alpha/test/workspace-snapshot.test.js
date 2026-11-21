import { afterEach, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readdir, readFile, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJsonArtifactOnce } from '../src/artifacts.js';
import { computePolicyRevision, policyDocument, validateOwnerAlphaConfig } from '../src/config.js';
import { initializeDurableJob, transitionDurableJob } from '../src/job-state.js';
import { artifactJson, canonicalJson } from '../src/json.js';
import { readAuthoringSource, revalidateOwnerPublicationSource, publicationDigest, foldWorkspaceText, foldedWorkspaceDigest, spellWorkspaceCandidate } from '../src/owner-publication.js';
import { createOwnerPublicationRuntime } from '../src/owner-publication-runtime.js';
import { pipelineArtifactPaths, PIPELINE_SCHEMA_VERSION } from '../src/pipeline.js';
import { deriveEditorOperation } from '../src/operation.js';
import { deriveOwnerDirect } from '../src/owner-direct.js';
import { deriveProposalApplication } from '../src/proposal-application.js';
import { createEditSession } from '../src/source.js';
import { BASE, EDITED, MAPPING, cleanup, command, deferred, publicationFixture } from './publication-fixture.js';

const INPUT = { mappingId: MAPPING.id };
const PREFIX = 'owner-publication';
const SECOND = BASE.replace('old', 'second');
const RETIRED = { version: 1, pathPrefixes: [], paths: [], contentDigests: [] };
const digest = (text) => publicationDigest(Buffer.from(text));
const hex = (text) => createHash('sha256').update(text).digest('hex');
const deliveryFile = (f) => path.join(f.root, f.mapping.relativePath);
const inStore = (f, relative) => path.join(f.context.storeRoot, relative);
const errorOf = (promise) => promise.then(() => { throw new Error('expected refusal'); }, (error) => error);
const entries = (dir) => readdir(dir).catch((error) => { if (error?.code === 'ENOENT') return []; throw error; });

afterEach(async () => { await Promise.all(cleanup.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function privateFile() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'workspace-retirement-fixture-'));
  cleanup.push(dir);
  return path.join(dir, 'retired.json');
}

async function bind(f, text = BASE) {
  f.setSource(text, 0);
  const baseline = await f.runtime.bindWorkspaceBaseline(INPUT);
  f.setSource(EDITED, 0);
  return baseline;
}

async function storedBaseline(f) {
  const dir = inStore(f, `${PREFIX}/baselines`);
  const files = await entries(dir);
  if (files.length === 0) return null;
  expect(files).toHaveLength(1);
  return JSON.parse(await readFile(path.join(dir, files[0]), 'utf8')).baseline;
}

async function commitDelivery(f, value) {
  await writeFile(deliveryFile(f), value);
  await command(f.root, ['add', '--', f.mapping.relativePath]);
  await command(f.root, ['commit', '-q', '-m', 'synthetic delivery revision']);
  return command(f.root, ['rev-parse', 'HEAD']);
}

function syntheticWriter(f) {
  const starts = new Map();
  let time = Date.parse('2026-11-21T10:00:00Z');
  const at = () => new Date(time += 1000).toISOString();
  const pipeline = {
    startEdit({ jobId, session, operation }) {
      const files = pipelineArtifactPaths(jobId);
      const completion = deferred();
      starts.set(jobId, { files, session, operation, completion });
      const accepted = (async () => {
        await createJsonArtifactOnce(f.context, files.session, session);
        await createJsonArtifactOnce(f.context, files.operation, operation);
        return initializeDurableJob(f.context, { jobId, policyRevision: session.policyRevision, at: at() });
      })();
      return { jobId, accepted, completion: completion.promise };
    },
  };
  const runtime = () => createOwnerPublicationRuntime({ config: f.config, context: f.context, pipeline, readNote: f.readNote,
    sourceSession: (input) => createEditSession({ ...input, git: f.git }), checkoutReady: f.dependencies.assertCheckoutReady });
  const step = (jobId, to, extra = {}) => transitionDurableJob(f.context, jobId, to, { at: at(), reason: `synthetic-${to}`, ...extra });
  const reachWitness = async (jobId, text) => {
    const { files, session, operation } = starts.get(jobId);
    const commit = await commitDelivery(f, text);
    const candidateBlob = await command(f.root, ['rev-parse', `${commit}:${f.mapping.relativePath}`]);
    await createJsonArtifactOnce(f.context, files.committed, { schemaVersion: PIPELINE_SCHEMA_VERSION,
      artifactType: 'owner-alpha-committed-effect', jobId, result: { status: 'commit-verified', commit,
        parentCommit: session.baseCommit, sourcePath: session.relativePath, sourceMode: session.source.gitMode,
        parentBlob: session.source.gitObjectId, candidateBlob, candidateDigest: operation.candidateDigest } });
    for (const state of ['preflighting', 'checking', 'rendering', 'ready-to-apply', 'applying', 'source-applied', 'committing',
      'committed', 'pushing', 'pushed', 'discovering-run', 'run-bound', 'monitoring-deployment', 'deployment-succeeded', 'verifying-live']) {
      await step(jobId, state);
    }
    return commit;
  };
  const witness = (jobId) => {
    const { files, session } = starts.get(jobId);
    return createJsonArtifactOnce(f.context, files.live, { schemaVersion: PIPELINE_SCHEMA_VERSION, artifactType: 'owner-alpha-live-result',
      jobId, result: { pageUrl: session.liveUrl, oldWitnessAbsent: true, newWitnessUnique: true } });
  };
  return { starts, step, reachWitness, witness, runtime };
}

test('workspace versions may be absent or zero; the digest decides staleness regardless of advisory version', async () => {
  const f = await publicationFixture({ workspace: true });
  await bind(f);
  f.omitVersion();
  f.setAttribution(['audit:opaque-1']);
  const { draft, summary } = await f.prepare();
  expect(summary.capturedVersion).toBe(0);
  expect(draft.prepared.reference.source.attribution).toEqual(['audit:opaque-1']);
  f.setSource(EDITED, 0);
  expect((await f.prepare()).summary.draftId).toBe(draft.draftId);
  f.setSource(EDITED, 123);
  expect((await revalidateOwnerPublicationSource({ config: f.config, reference: draft.prepared.reference, readNote: f.readNote })).foldedTextDigest).toBe(digest(EDITED));
  f.setSource(SECOND, 0);
  await expect(f.runtime.publish({ draftId: summary.draftId })).rejects.toHaveProperty('code', 'authoring-source-stale');
  expect(await entries(inStore(f, `${PREFIX}/authorizations`))).toEqual([]);
});

test('reader errors keep each stable code but never copy reader text, details or causes', async () => {
  const f = await publicationFixture({ workspace: true });
  await bind(f);
  const { summary } = await f.prepare();
  const sentinel = 'reader-private-message-sentinel';
  for (const code of ['not-found', 'moved', 'not-settled', 'pending-erasure', 'out-of-scope', 'unsupported-type', 'over-budget', 'unknown-provider']) {
    f.setReaderFailure(Object.assign(new Error(sentinel, { cause: sentinel }), { code, details: sentinel }));
    for (const request of [f.prepare(), f.runtime.publish({ draftId: summary.draftId })]) {
      const error = await errorOf(request);
      expect(error.code).toBe(['unknown-provider', 'not-settled'].includes(code) ? 'authoring-read-failed' : code);
      expect(JSON.stringify(error)).not.toContain(sentinel);
      expect(error.message).not.toContain(sentinel);
      expect(error.details).toEqual({});
      expect(error.cause).toBeUndefined();
    }
  }
});

test('attribution is bounded and defaults to unknown rather than inferring identity', async () => {
  const f = await publicationFixture();
  const read = () => readAuthoringSource({ config: f.config, ...INPUT, readNote: f.readNote });
  expect((await read()).attribution).toBe('unknown');
  for (const value of [Array(33).fill('audit'), ['á'.repeat(129)], [''], ['\n'], { name: 'synthetic' }, 'operator']) {
    f.setAttribution(value);
    await expect(read()).rejects.toHaveProperty('code', 'invalid-authoring-attribution');
  }
});

test('binding never copies source, refuses divergence, and gates both prepare and publish', async () => {
  const f = await publicationFixture({ workspace: true });
  const unchanged = await readFile(deliveryFile(f));
  await expect(f.prepare()).rejects.toHaveProperty('code', 'workspace-unbound');
  await expect(f.runtime.bindWorkspaceBaseline(INPUT)).rejects.toHaveProperty('code', 'workspace-diverged');
  expect(await storedBaseline(f)).toBeNull();
  expect(await readFile(deliveryFile(f))).toEqual(unchanged);
  const baseline = await bind(f);
  expect(baseline).toEqual({ ...INPUT, commit: f.head, foldedTextDigest: digest(BASE) });
  expect(await storedBaseline(f)).toMatchObject({ commit: f.head, foldedTextDigest: digest(BASE) });
  expect(await readFile(deliveryFile(f))).toEqual(unchanged);
  const first = (await f.prepare()).summary;
  const baselineFiles = await entries(inStore(f, `${PREFIX}/baselines`));
  const baselinePath = inStore(f, `${PREFIX}/baselines/${baselineFiles[0]}`);
  const saved = await readFile(baselinePath);
  await unlink(baselinePath);
  await expect(f.runtime.publish({ draftId: first.draftId })).rejects.toHaveProperty('code', 'workspace-unbound');
  await writeFile(baselinePath, saved, { mode: 0o600 });
  await commitDelivery(f, SECOND);
  await expect(f.prepare()).rejects.toHaveProperty('code', 'delivery-moved-since-baseline');
  await expect(f.runtime.publish({ draftId: first.draftId })).rejects.toHaveProperty('code', 'delivery-moved-since-baseline');
  expect(await entries(inStore(f, `${PREFIX}/authorizations`))).toEqual([]);
});

test('verified-live evidence advances the baseline after restart; a second edit publishes against it', async () => {
  const f = await publicationFixture({ workspace: true });
  await bind(f);
  const worker = syntheticWriter(f);
  let runtime = worker.runtime();
  const first = (await runtime.prepare(INPUT)).summary;
  f.setSource(EDITED, 19); // Version drift alone is accepted.
  await runtime.publish({ draftId: first.draftId });
  const firstCommit = await worker.reachWitness(first.jobId, EDITED);
  const submitted = await storedBaseline(f);
  expect(submitted).toMatchObject({ commit: f.head, foldedTextDigest: digest(BASE) });
  await worker.step(first.jobId, 'live-confirmed');
  runtime = worker.runtime();
  expect((await runtime.readStatus(INPUT)).live).toBeNull(); // Confirmation without the witness is not live.
  expect(await storedBaseline(f)).toEqual(submitted);
  await expect(runtime.prepare(INPUT)).rejects.toHaveProperty('code', 'delivery-moved-since-baseline');
  await worker.witness(first.jobId);
  expect((await runtime.readStatus(INPUT)).live).toMatchObject({ foldedTextDigest: digest(EDITED), verified: true, attribution: 'unknown' });
  expect(await storedBaseline(f)).toMatchObject({ commit: firstCommit, foldedTextDigest: digest(EDITED) });
  f.setSource(SECOND, 19);
  const second = (await runtime.prepare(INPUT)).draft;
  expect(second.prepared.reference.workspaceBaseline).toMatchObject({ commit: firstCommit, foldedTextDigest: digest(EDITED) });
  expect(second.prepared.session.baseCommit).toBe(firstCommit);
  await runtime.publish({ draftId: second.draftId });
  const secondCommit = await worker.reachWitness(second.jobId, SECOND);
  await worker.witness(second.jobId);
  await worker.step(second.jobId, 'live-confirmed');
  expect((await runtime.prepare(INPUT)).outcome).toBe('unchanged'); // Prepare can also reconcile without polling status.
  expect(await storedBaseline(f)).toMatchObject({ commit: secondCommit, foldedTextDigest: digest(SECOND) });
});

test('a failed live check leaves the previous baseline unchanged', async () => {
  const f = await publicationFixture({ workspace: true });
  await bind(f);
  const worker = syntheticWriter(f);
  const runtime = worker.runtime();
  const { summary } = await runtime.prepare(INPUT);
  await runtime.publish({ draftId: summary.draftId });
  await worker.reachWitness(summary.jobId, EDITED);
  await worker.step(summary.jobId, 'live-verification-failed', { failure: { code: 'synthetic-failure', message: 'synthetic', retryable: true } });
  expect((await runtime.readStatus(INPUT)).live).toBeNull();
  expect(await storedBaseline(f)).toMatchObject({ commit: f.head, foldedTextDigest: digest(BASE) });
});

for (const [name, bytes, reason] of [
  ['lone CR', Buffer.from(`${BASE.slice(0, -1)}\r`), 'lone-carriage-return'],
  ['internal BOM', Buffer.from(`${BASE}\uFEFF`), 'byte-order-mark'],
  ['invalid UTF-8', Buffer.from([0xff, 0x0a]), 'invalid-utf8'],
]) {
  test(`workspace delivery ${name} is refused without normalizing Git bytes or storing a draft`, async () => {
    const f = await publicationFixture({ workspace: true });
    await bind(f);
    const head = await commitDelivery(f, bytes);
    await expect(f.prepare()).rejects.toMatchObject({ code: 'delivery-not-round-trippable', details: { reason } });
    expect(await readFile(deliveryFile(f))).toEqual(bytes);
    expect(await command(f.root, ['rev-parse', 'HEAD'])).toBe(head);
    expect(await entries(inStore(f, `${PREFIX}/drafts`))).toEqual([]);
  });
}

const crlf = (text) => text.replaceAll('\n', '\r\n');

function expectExactSplice(draft, vault, expected) {
  const { operation, candidate, reference } = draft.prepared;
  const base = Buffer.from(vault);
  const bytes = Buffer.from(candidate.bytesBase64, 'base64');
  const replacement = Buffer.from(operation.replacementBytesBase64, 'base64');
  expect(bytes).toEqual(Buffer.from(expected));
  expect(candidate.digest).toBe(publicationDigest(bytes));
  expect(reference.source.foldedTextDigest).toBe(foldedWorkspaceDigest(expected));
  expect(reference.source).not.toHaveProperty('digest');
  expect(bytes.subarray(0, operation.start)).toEqual(base.subarray(0, operation.start));
  expect(bytes.subarray(operation.start + replacement.length)).toEqual(base.subarray(operation.end));
}

test('CRLF vault and LF workspace bind without producing a draft or changing delivery', async () => {
  const f = await publicationFixture({ workspace: true, base: crlf(BASE) });
  const baseline = await bind(f);
  f.setSource(BASE, 0);
  const review = await f.prepare();
  expect(review.outcome).toBe('unchanged');
  const view = f.runtime.loadCurrent({ viewId: review.reviewUrl.split('/').at(-1) });
  expect(view).toMatchObject({ text: crlf(BASE), foldedTextDigest: digest(BASE) });
  expect(baseline).toMatchObject({ foldedTextDigest: digest(BASE) });
  expect(await readFile(deliveryFile(f))).toEqual(Buffer.from(crlf(BASE)));
  expect(await entries(inStore(f, `${PREFIX}/drafts`))).toEqual([]);
});

test('CRLF word edit publishes exact bytes and advances baseline using verified local Git evidence', async () => {
  const f = await publicationFixture({ workspace: true, base: crlf(BASE), localGit: true });
  await bind(f);
  const { draft, summary } = await f.prepare();
  expectExactSplice(draft, crlf(BASE), crlf(EDITED));
  expect(draft.prepared.operation).toMatchObject({ expectedOldBytesBase64: Buffer.from('old').toString('base64'),
    replacementBytesBase64: Buffer.from('new').toString('base64') });
  f.renderGate.resolve({ ok: true, rendered: { witnesses: { old: 'old', new: 'new' } } });
  // Client-only spelling and version drift does not stale the reviewed draft.
  f.setSource(`\uFEFF${crlf(EDITED)}`, 18);
  await f.runtime.publish({ draftId: summary.draftId });
  const result = await f.completion;
  expect(result.failure).toBeNull();
  expect(result.state).toBe('completed');
  const commit = await f.actualGit(f.remote, ['rev-parse', 'refs/heads/main'], { encoding: 'utf8' });
  expect(commit).not.toBe(f.head);
  expect(await f.actualGit(f.remote, ['show', `${commit}:${f.mapping.relativePath}`])).toEqual(Buffer.from(crlf(EDITED)));
  expect((await f.runtime.readStatus(INPUT)).live).toMatchObject({ verified: true, foldedTextDigest: digest(EDITED) });
  expect(await storedBaseline(f)).toMatchObject({ commit, foldedTextDigest: digest(EDITED) });
});

for (const [label, vault, before, after, expected] of [
  ['mixed terminators', '# Title\r\n\nFirst value.\nSecond value.\r\nPlain tail.\n', '# Title\n\nFirst value.\nSecond value.\nPlain tail.\n',
    '# Title\n\nFirst draft.\nSecond draft.\nPlain tail.\n', '# Title\r\n\nFirst draft.\nSecond draft.\r\nPlain tail.\n'],
  ['leading BOM with CRLF frontmatter', '\uFEFF---\r\ntitle: Test\r\n---\r\n\r\nThe old word.\r\n', '---\ntitle: Test\n---\n\nThe old word.\n',
    '---\ntitle: Test\n---\n\nThe new word.\n', '\uFEFF---\r\ntitle: Test\r\n---\r\n\r\nThe new word.\r\n'],
  ['no final newline', '# Old title\r\n\r\nLast line.', '# Old title\n\nLast line.', '# New title\n\nLast line.', '# New title\r\n\r\nLast line.'],
  ['preceding CRLF', 'Alpha\nBeta\r\nGamma\r\n', 'Alpha\nBeta\nGamma\n', 'Alpha\nBeta\nNew line\nGamma\n', 'Alpha\nBeta\r\nNew line\r\nGamma\r\n'],
  ['preceding LF', 'Alpha\nBeta\n', 'Alpha\nBeta\n', 'Alpha\nNew line\nBeta\n', 'Alpha\nNew line\nBeta\n'],
  ['first file terminator', 'Alpha\r\nBeta\n', 'Alpha\nBeta\n', 'New line\nAlpha\nBeta\n', 'New line\r\nAlpha\r\nBeta\n'],
  ['default LF', 'Alpha', 'Alpha', 'New line\nAlpha', 'New line\nAlpha'],
]) {
  test(`workspace exact splice preserves ${label}`, async () => {
    const f = await publicationFixture({ workspace: true, base: vault });
    await bind(f, before);
    f.setSource(after, 0);
    const { draft } = await f.prepare();
    expectExactSplice(draft, vault, expected);
    expect((await f.runtime.readReceipt({ draftId: draft.draftId })).foldedTextDigest).toBe(foldedWorkspaceDigest(after));
  });
}

test('raw spelling of the workspace capture does not affect an LF vault draft', async () => {
  const f = await publicationFixture({ workspace: true });
  await bind(f);
  const first = (await f.prepare()).draft;
  f.setSource(crlf(EDITED), 0);
  const second = (await f.prepare()).draft;
  expect(second).toEqual(first);
  expectExactSplice(second, BASE, EDITED);
  expect((await f.prepare()).summary.foldedTextDigest).toBe(digest(EDITED));
});

test('invalid reader text/bytes and internal BOM are refused without a draft', async () => {
  const f = await publicationFixture({ workspace: true });
  await bind(f);
  for (const [text, reason] of [['bad\ud800', 'invalid-utf8'], [`bad\uFEFFtext`, 'byte-order-mark']]) {
    f.setSource(text, 0);
    await expect(f.prepare()).rejects.toMatchObject({ code: 'delivery-not-round-trippable', details: { reason } });
  }
  const bytes = Buffer.from([0xc0, 0xaf]);
  const readNote = async () => ({ ...await f.readNote(), text: '??', bytesBase64: bytes.toString('base64'),
    byteLength: bytes.length, digest: publicationDigest(bytes) });
  await expect(readAuthoringSource({ config: f.config, ...INPUT, readNote })).rejects.toMatchObject({
    code: 'delivery-not-round-trippable', details: { reason: 'invalid-utf8' } });
  expect(await entries(inStore(f, `${PREFIX}/drafts`))).toEqual([]);
});

test('the owner computes folded identity independently of the reader raw digest', async () => {
  const f = await publicationFixture({ workspace: true });
  f.setSource(`\uFEFF${crlf(EDITED)}`, 0);
  const note = await readAuthoringSource({ config: f.config, ...INPUT,
    readNote: async () => ({ ...await f.readNote(), digest: digest('unrelated') }) });
  expect(note.foldedTextDigest).toBe(digest(EDITED));
  expect(note.digest).toBe(digest(`\uFEFF${crlf(EDITED)}`));
});

test('randomized single-line edits leave every original terminator and every outside byte unchanged', async () => {
  const f = await publicationFixture({ workspace: true });
  const template = await createEditSession({ config: f.config, renderer: { relativePath: f.mapping.relativePath, slug: f.mapping.slug }, git: f.git, workspacePublication: true });
  let seed = 0xcab005e;
  const draw = (max) => { seed = (Math.imul(1664525, seed) + 1013904223) >>> 0; return (seed >>> 16) % max; };
  for (let sample = 0; sample < 48; sample += 1) {
    const count = 2 + draw(12);
    const editedIndex = draw(count);
    const lines = Array.from({ length: count }, (_, index) => `Line ${index}: é old λ`);
    const ends = lines.map((_, index) => index === count - 1 ? ['', '\n', '\r\n'][draw(3)] : ['\n', '\r\n'][draw(2)]);
    const bom = draw(2) ? '\uFEFF' : '';
    const raw = bom + lines.map((line, i) => line + ends[i]).join('');
    const base = Buffer.from(raw);
    lines[editedIndex] = lines[editedIndex].replace('old', 'new');
    const edited = lines.map((line, i) => line + (ends[i] ? '\n' : '')).join('');
    const expected = bom + lines.map((line, i) => line + ends[i]).join('');
    const spelled = spellWorkspaceCandidate(base, edited);
    expect(spelled).toBe(expected);
    expect(foldWorkspaceText(Buffer.from(spelled))).toBe(edited);
    const session = { ...template, source: { ...template.source, text: raw, bytesBase64: base.toString('base64'),
      digest: publicationDigest(base), byteLength: base.length } };
    const operation = deriveEditorOperation({ session, editedText: spelled, config: f.config, workspacePublication: true });
    expect(Buffer.from(operation.expectedOldBytesBase64, 'base64').toString()).toBe('old');
    expect(Buffer.from(operation.replacementBytesBase64, 'base64').toString()).toBe('new');
    const candidate = Buffer.from(spelled);
    expect(candidate.subarray(0, operation.start)).toEqual(base.subarray(0, operation.start));
    expect(candidate.subarray(operation.start + 3)).toEqual(base.subarray(operation.end));
  }
});

test('old raw workspace baselines and drafts require an explicit rebind and fresh preparation', async () => {
  const f = await publicationFixture({ workspace: true });
  await bind(f);
  const { draft } = await f.prepare();
  const baselines = inStore(f, `${PREFIX}/baselines`);
  const baselineFile = path.join(baselines, (await entries(baselines))[0]);
  const old = structuredClone(draft);
  const anchor = old.prepared.reference.workspaceBaseline;
  anchor.digest = anchor.foldedTextDigest;
  delete anchor.foldedTextDigest;
  await writeFile(baselineFile, artifactJson({ schemaVersion: 1, baseline: anchor }));
  const source = old.prepared.reference.source;
  source.digest = source.foldedTextDigest;
  source.byteLength = Buffer.byteLength(EDITED);
  delete source.foldedTextDigest;
  old.draftId = hex(canonicalJson(old.prepared));
  old.jobId = `OA-PUB-${old.draftId}`;
  await createJsonArtifactOnce(f.context, `${PREFIX}/drafts/${old.draftId}.json`, old);
  await expect(f.prepare()).rejects.toHaveProperty('code', 'workspace-snapshot-incompatible');
  await expect(f.runtime.readStatus(INPUT)).rejects.toHaveProperty('code', 'workspace-snapshot-incompatible');
  await expect(f.runtime.readReceipt({ draftId: old.draftId })).rejects.toHaveProperty('code', 'workspace-snapshot-incompatible');
  await expect(f.runtime.publish({ draftId: old.draftId })).rejects.toHaveProperty('code', 'workspace-snapshot-incompatible');
  await bind(f);
  expect((await storedBaseline(f)).bindingId).not.toBe(anchor.bindingId);
  expect((await f.prepare()).draft.draftId).not.toBe(old.draftId);
  expect((await f.runtime.readStatus(INPUT)).latest.draftId).not.toBe(old.draftId);
});

test('raw edit still refuses a CR base and CR in the edited text', async () => {
  const f = await publicationFixture();
  const renderer = { relativePath: f.mapping.relativePath, slug: f.mapping.slug };
  const read = () => createEditSession({ config: f.config, renderer, git: f.git });
  const session = await read();
  expect(() => deriveEditorOperation({ session, config: f.config, editedText: crlf(EDITED) }))
    .toThrow(expect.objectContaining({ code: 'editor-value-not-lf-only' }));
  await commitDelivery(f, crlf(BASE));
  await expect(read()).rejects.toHaveProperty('code', 'source-not-lf-only');
});

test('owner-direct Save derivation still refuses a CR base', async () => {
  const f = await publicationFixture({ workspace: true, base: crlf(BASE) });
  const renderer = { relativePath: f.mapping.relativePath, slug: f.mapping.slug };
  const session = await createEditSession({ config: f.config, renderer, git: f.git, workspacePublication: true });
  expect(() => deriveOwnerDirect({ config: f.config, session, handoff: {} }))
    .toThrow(expect.objectContaining({ code: 'source-not-lf-only' }));
});

test('approved proposal application still refuses a CR base', async () => {
  const f = await publicationFixture({ base: crlf(BASE) });
  const baseBytes = Buffer.from(crlf(BASE));
  const fakeDigest = digest('fixture');
  const time = '2026-11-21T10:00:00Z';
  const input = { schemaVersion: 1, artifactType: 'owner-alpha-approved-proposal-input',
    queueId: 'Q-00000000-0000-4000-8000-000000000001', preparedAt: time,
    decision: { digest: fakeDigest, decidedAt: time, reviewEvidenceDigest: fakeDigest,
      authority: { type: 'owner-alpha-local', identity: 'example' } },
    proposal: { proposalId: 'synthetic', proposalDigest: fakeDigest, lane: 'B', tier: 'unknown', route: 'queue' },
    source: { repository: f.config.repository.remote.url, path: f.mapping.relativePath,
      revision: f.head, branch: 'main', branchTip: f.head, gitMode: '100644',
      gitObjectId: await command(f.root, ['rev-parse', `HEAD:${f.mapping.relativePath}`]),
      baseByteLength: baseBytes.length, baseDigest: publicationDigest(baseBytes) },
    operation: { type: 'offset', start: 0, end: 0, expectedOldBytesBase64: '', replacementBytesBase64: '' },
    candidate: { byteLength: baseBytes.length, digest: publicationDigest(baseBytes) },
    trustPolicy: { status: 'missing', digest: null }, applicationGate: { state: 'not-authorized', event: null, note: 'Fixture' },
    effectBoundary: { appliesSource: false, writesSource: false, commits: false, pushes: false, deploys: false, publishes: false, rebuilds: false } };
  expect(deriveProposalApplication({ config: f.config, input, baseBytes, branchTip: f.head, slug: f.mapping.slug }))
    .toMatchObject({ applicable: false, reason: 'source-not-lf-only' });
});

test('bind and prepare refuse exactly doubled or tripled folded vault text without storing a draft', async () => {
  const f = await publicationFixture({ workspace: true, base: crlf(BASE) });
  for (const repeats of [2, 3]) {
    f.setSource(BASE.repeat(repeats), 0);
    await expect(f.runtime.bindWorkspaceBaseline(INPUT)).rejects.toMatchObject({ code: 'workspace-text-repeated', details: { repeats } });
    expect(await storedBaseline(f)).toBeNull();
    expect(await entries(inStore(f, `${PREFIX}/drafts`))).toEqual([]);
  }
  await bind(f);
  for (const repeats of [2, 3]) {
    f.setSource(BASE.repeat(repeats), 0);
    const error = await errorOf(f.prepare());
    expect(error).toMatchObject({ code: 'workspace-text-repeated', details: { repeats } });
    expect(error.message).not.toContain('Synthetic page');
    expect(await entries(inStore(f, `${PREFIX}/drafts`))).toEqual([]);
    expect(await entries(inStore(f, 'jobs'))).toEqual([]);
  }
});

test('an exact double-length edit and a partial self-quotation are not duplicates', async () => {
  const f = await publicationFixture({ workspace: true });
  await bind(f);
  const doubleLength = BASE + EDITED;
  expect(Buffer.byteLength(doubleLength)).toBe(2 * Buffer.byteLength(BASE));
  for (const text of [doubleLength, `${BASE}\n> The old value.\n`]) {
    f.setSource(text, 0);
    expect((await f.prepare()).draft.prepared.candidate.text).toBe(text);
  }
});

test('adjacent duplicate frontmatter and unterminated leading frontmatter are refused structurally', async () => {
  const base = '---\ntitle: Example\n---\n\nA synthetic note.\n';
  const f = await publicationFixture({ workspace: true, base });
  const inputs = ['---\ntitle: Example\n---\n\n---\nother: second\n---\n\nA synthetic note.\n', '---\ntitle: Example\n\nNo closing delimiter.\n'];
  for (const text of inputs) {
    f.setSource(text, 0);
    await expect(f.runtime.bindWorkspaceBaseline(INPUT)).rejects.toMatchObject({ code: 'workspace-properties-invalid', details: {} });
    expect(await storedBaseline(f)).toBeNull();
  }
  await bind(f, base);
  for (const text of inputs) {
    f.setSource(text, 0);
    const error = await errorOf(f.prepare());
    expect(error).toMatchObject({ code: 'workspace-properties-invalid', details: {} });
    expect(error.message).not.toContain('Example');
    expect(await entries(inStore(f, `${PREFIX}/drafts`))).toEqual([]);
  }
});

test('Publish refuses a fresh repeated capture and also refuses an older draft whose own candidate is repeated', async () => {
  const f = await publicationFixture({ workspace: true });
  await bind(f);
  const { draft } = await f.prepare();
  const repeated = BASE.repeat(2);
  f.setSource(crlf(repeated), 0);
  const duplicate = { code: 'workspace-text-repeated', details: { repeats: 2 } };
  await expect(f.runtime.publish({ draftId: draft.draftId })).rejects.toMatchObject(duplicate);

  const old = structuredClone(draft);
  old.prepared.reference.source.foldedTextDigest = foldedWorkspaceDigest(repeated);
  old.prepared.operation = deriveEditorOperation({ session: old.prepared.session, editedText: repeated,
    config: f.config, workspacePublication: true });
  const bytes = Buffer.from(repeated);
  old.prepared.candidate = { text: repeated, bytesBase64: bytes.toString('base64'), byteLength: bytes.length, digest: publicationDigest(bytes) };
  old.draftId = hex(canonicalJson(old.prepared));
  old.jobId = `OA-PUB-${old.draftId}`;
  await createJsonArtifactOnce(f.context, `${PREFIX}/drafts/${old.draftId}.json`, old);
  f.setSource(EDITED, 0);
  await expect(f.runtime.publish({ draftId: old.draftId })).rejects.toMatchObject(duplicate);
  expect(await entries(inStore(f, `${PREFIX}/authorizations`))).toEqual([]);
  expect(await entries(inStore(f, 'jobs'))).toEqual([]);
});

test('capture rehearsal runs in a child, prints the exact delivery diff, and cleans its owned root', async () => {
  const file = await privateFile();
  const after = `${file}.after`;
  const capture = (text) => JSON.stringify({ source: 'rehearsal', path: 'notes/example.md', text });
  await writeFile(file, capture(crlf(BASE)));
  const run = async (text) => {
    await writeFile(after, capture(text));
    const proc = Bun.spawn([process.execPath, fileURLToPath(new URL('./workspace-capture-rehearsal.js', import.meta.url)), file, after],
      { stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, status] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    const reportedRoot = stdout.match(/^Temporary root: (.+)$/mu)?.[1];
    if (reportedRoot) await expect(stat(JSON.parse(reportedRoot))).rejects.toHaveProperty('code', 'ENOENT');
    return { stdout, stderr, status, reportedRoot };
  };
  const { stdout, stderr, status, reportedRoot } = await run(EDITED);
  expect({ status, stderr }).toEqual({ status: 0, stderr: '' });
  expect(reportedRoot).toBeDefined();
  expect(stdout).toContain('Bound: yes. Published one exact change');
  expect(stdout).toMatch(/Commit: [0-9a-f]{40}\n/u);
  expect(stdout).toContain('Deployment: simulated. Live check: simulated.');
  expect(stdout).toContain('-The old value.\r\n+The new value.\r\n');
  const refused = await run(BASE.repeat(2));
  expect(refused.status).toBe(1);
  expect(refused.reportedRoot).toBeDefined();
  expect(refused.stderr).toContain('workspace-text-repeated. The workspace note repeats the vault text 2 times.');
  expect(refused.stderr).not.toContain('Synthetic page');
  expect(refused.stdout).not.toContain('Commit:');
}, 15000);

async function assertNoRules(f, payload, rules, messages = []) {
  const files = await readdir(f.context.storeRoot, { recursive: true, withFileTypes: true });
  const artifacts = await Promise.all(files.filter((file) => file.isFile())
    .map((file) => readFile(path.join(file.parentPath, file.name), 'utf8')));
  const surfaces = [JSON.stringify(payload), ...messages.map((message) => JSON.stringify(message)), ...artifacts];
  for (const token of [...rules.pathPrefixes, ...rules.paths, ...rules.contentDigests]) {
    for (const surface of surfaces) expect(surface).not.toContain(token);
  }
}

for (const [name, rules, sourcePath, candidate] of [
  ['workspace prefix', { pathPrefixes: ['RemovedWorkspace'] }, 'RemovedWorkspace/x/note.md', EDITED],
  ['vault prefix', { pathPrefixes: ['Notes/'] }, MAPPING.source.path, EDITED],
  ['exact note path', { paths: [MAPPING.source.path] }, MAPPING.source.path, EDITED],
  ['NFC path', { paths: ['Retired/Café.md'] }, 'Retired/Café.md', EDITED],
  ['exact content', { contentDigests: [hex(EDITED)] }, MAPPING.source.path, EDITED],
  ['BOM and lone-CR folded content', { contentDigests: [hex(EDITED)] }, MAPPING.source.path, `\uFEFF${EDITED.replaceAll('\n', '\r')}`],
  ['CRLF-normalized content', { contentDigests: [hex(EDITED)] }, MAPPING.source.path, EDITED.replaceAll('\n', '\r\n')],
]) {
  test(`retirement refuses ${name} without exposing retirement rules`, async () => {
    const file = await privateFile();
    const policy = { ...RETIRED, ...rules };
    await writeFile(file, JSON.stringify(policy), { mode: 0o600 });
    const f = await publicationFixture({ workspace: true, retiredFile: file, sourcePath });
    await bind(f);
    f.setSource(candidate, 0);
    const messages = [];
    const spies = [spyOn(console, 'warn'), spyOn(console, 'log'), spyOn(console, 'error'), spyOn(process, 'emitWarning')]
      .map((spy) => spy.mockImplementation((...args) => { messages.push(args); }));
    try {
      const error = await errorOf(f.prepare());
      expect(error).toMatchObject({ code: 'retired-material', details: {} });
      expect(await entries(inStore(f, `${PREFIX}/drafts`))).toEqual([]);
      await assertNoRules(f, { code: error.code, message: error.message, details: error.details }, policy, messages);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
}

test('retired-list updates are re-read before Publish, without starting or authorizing an effect', async () => {
  const file = await privateFile();
  await writeFile(file, JSON.stringify(RETIRED), { mode: 0o600 });
  const f = await publicationFixture({ workspace: true, retiredFile: file, sourcePath: 'Vault-recalled/note.md' });
  await bind(f);
  const { summary } = await f.prepare();
  const rules = { ...RETIRED, pathPrefixes: ['Vault-recalled'], paths: ['Other/Sentinel.md'], contentDigests: [hex('other private text')] };
  await writeFile(file, JSON.stringify(rules));
  const error = await errorOf(f.runtime.publish({ draftId: summary.draftId }));
  expect(error).toMatchObject({ code: 'retired-material', details: {} });
  // The immutable draft predates this rule and naturally contains its mapped
  // workspace path. No new record copies the retirement rule or records a hit.
  expect(await entries(inStore(f, `${PREFIX}/authorizations`))).toEqual([]);
  expect(await entries(inStore(f, 'jobs'))).toEqual([]);
  await assertNoRules(f, { code: error.code, message: error.message, details: error.details }, { ...rules, pathPrefixes: [] });
  expect(error.message).not.toContain(rules.pathPrefixes[0]);
  await unlink(file);
  await expect(f.runtime.publish({ draftId: summary.draftId })).rejects.toHaveProperty('code', 'retired-list-unavailable');
});

test('empty digest, unrelated path components and case differences do not match', async () => {
  const file = await privateFile();
  await writeFile(file, JSON.stringify({ ...RETIRED, pathPrefixes: ['notes', 'Notes/Page.md.other', 'Private'],
    contentDigests: [hex(''), digest('')] }), { mode: 0o600 });
  const f = await publicationFixture({ workspace: true, retiredFile: file });
  await commitDelivery(f, '');
  await bind(f, '');
  f.setSource('', 0);
  expect((await f.prepare()).outcome).toBe('unchanged');
  f.setSource(EDITED, 0);
  expect((await f.prepare()).draft.prepared.candidate.text).toBe(EDITED);
});

test('missing, malformed, symlinked, unreadable and group-readable retirement policy all fail closed', async () => {
  const file = await privateFile();
  const f = await publicationFixture({ workspace: true, retiredFile: file });
  await bind(f);
  const refused = async () => {
    const error = await errorOf(f.prepare());
    expect(error).toMatchObject({ code: 'retired-list-unavailable', details: {} });
    expect(error.message).not.toContain(file);
    expect(await entries(inStore(f, `${PREFIX}/drafts`))).toEqual([]);
  };
  await refused();
  for (const value of ['{"pathPrefixes":["secret sentinel"', JSON.stringify({ ...RETIRED, contentDigests: ['not-a-digest'] })]) {
    await writeFile(file, value, { mode: 0o600 });
    await refused();
  }
  await writeFile(file, JSON.stringify(RETIRED));
  await chmod(file, 0o640);
  await refused();
  await chmod(file, 0o200);
  await refused();
  await chmod(file, 0o600);
  const target = `${file}.target`;
  await writeFile(target, JSON.stringify(RETIRED), { mode: 0o600 });
  await unlink(file);
  await symlink(target, file);
  await refused();
});

test('a retired list cannot be loaded from a vault checkout or the private workspace store', async () => {
  const f = await publicationFixture({ workspace: true });
  await bind(f);
  for (const file of [path.join(f.context.workspaceRoot, 'retired.json'), inStore(f, 'retired.json')]) {
    await writeFile(file, JSON.stringify(RETIRED), { mode: 0o600 });
    const config = validateOwnerAlphaConfig({ ...f.config, ownerPublication: { ...f.config.ownerPublication, retiredList: { file } } });
    const runtime = createOwnerPublicationRuntime({ config, context: f.context, readNote: f.readNote,
      sourceSession: (input) => createEditSession({ ...input, git: f.git }) });
    await expect(runtime.prepare(INPUT)).rejects.toHaveProperty('code', 'retired-list-unavailable');
  }
});

test('legacy config keeps the old policy bytes; only the optional file path enters the revision', async () => {
  const f = await publicationFixture();
  const disabled = validateOwnerAlphaConfig({ ...f.config, ownerPublication: { enabled: false } });
  const legacyPolicy = { ...policyDocument(disabled), ownerPublication: { enabled: true, mappings: [MAPPING] } };
  expect(canonicalJson(policyDocument(f.config))).toBe(canonicalJson(legacyPolicy));
  expect(computePolicyRevision(f.config)).toBe(`sha256:${hex(canonicalJson(legacyPolicy))}`);
  const file = await privateFile();
  const withFile = (location) => validateOwnerAlphaConfig({ ...f.config,
    ownerPublication: { ...f.config.ownerPublication, retiredList: { file: location } } });
  const first = computePolicyRevision(withFile(file));
  expect(first).not.toBe(computePolicyRevision(f.config));
  expect(first).not.toBe(computePolicyRevision(withFile(`${file}.other`)));
  await writeFile(file, JSON.stringify({ ...RETIRED, paths: ['No-policy-leak.md'] }), { mode: 0o600 });
  expect(computePolicyRevision(withFile(file))).toBe(first);
  expect(canonicalJson(policyDocument(withFile(file)))).not.toContain('No-policy-leak.md');
  expect(() => withFile('relative/file.json')).toThrow();
  expect((await f.prepare()).summary.capturedVersion).toBe(7); // No workspace opt-in or retired list.
});

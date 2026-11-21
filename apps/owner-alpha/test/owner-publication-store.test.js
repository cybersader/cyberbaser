import { afterEach, describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, link, mkdtemp, readFile, readdir, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { computePolicyRevision, validateOwnerAlphaConfig } from '../src/config.js';
import { OwnerAlphaError } from '../src/errors.js';
import { artifactJson, canonicalJson } from '../src/json.js';
import { applyEditorOperation } from '../src/operation.js';
import { detectYamlFrontmatterRange, liveUrlForSlug } from '../src/source.js';
import { defineStoreContext, resolveStorePath } from '../src/store.js';
import {
  OWNER_PUBLICATION_DRAFT_LIMIT, OWNER_PUBLICATION_DRAFT_ROOT,
  OWNER_PUBLICATION_PUBLISH_LOCK, guardOwnerPublicationSource, loadOwnerPublicationDraft,
  prepareOwnerPublicationDraft, publishOwnerPublicationDraft,
} from '../src/owner-publication-store.js';

const execFileAsync = promisify(execFile);
const EXAMPLE = JSON.parse(await readFile(new URL('../owner-alpha.example.json', import.meta.url), 'utf8'));
const BASE = '---\ntitle: Synthetic\n---\nBefore old after.\n';
const EDITED = BASE.replace('old', 'new');
const MAPPING = { id: 'pilot-page', source: { identity: 'synthetic-source', path: 'Drafts/Page.md' }, relativePath: 'Notes/Page.md', slug: 'Notes/page' };
const cleanup = [];
const tick = () => new Promise((resolve) => setImmediate(resolve));

function digest(bytes) { return `sha-256=:${createHash('sha256').update(bytes).digest('base64')}:`; }
function hash(value) { return createHash('sha256').update(canonicalJson(value)).digest('hex'); }
function deferred() { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function configWith(change = () => {}) {
  const raw = structuredClone(EXAMPLE);
  raw.repository = { checkout: '/synthetic/not-opened', remote: { name: 'origin', url: 'https://github.com/example/fixture.git' }, branch: 'main' };
  raw.owner.identity = 'example'; raw.workflow.repository = 'example/fixture'; raw.live.baseUrl = 'https://example.github.io/fixture/';
  raw.ownerPublication = { enabled: true, mappings: [structuredClone(MAPPING)] };
  Object.assign(raw.limits, { maxSourceBytes: 4096, maxReplacementBytes: 128, maxChangedBytes: 128, maxChangedLines: 6, maxArtifactBytes: 32768 });
  change(raw); return validateOwnerAlphaConfig(raw);
}
function note(text = EDITED, version = 7) {
  const bytes = Buffer.from(text);
  return { ...MAPPING.source, version, text, bytesBase64: bytes.toString('base64'), byteLength: bytes.length, digest: digest(bytes) };
}
function sessionFor(config) {
  const bytes = Buffer.from(BASE);
  return { schemaVersion: 1, artifactType: 'owner-alpha-edit-session', relativePath: MAPPING.relativePath, slug: MAPPING.slug,
    liveUrl: liveUrlForSlug(config.live.baseUrl, MAPPING.slug), baseCommit: 'a'.repeat(40), policyRevision: computePolicyRevision(config),
    source: { text: BASE, bytesBase64: bytes.toString('base64'), byteLength: bytes.length, digest: digest(bytes),
      gitMode: '100644', gitObjectId: 'b'.repeat(40), frontmatter: detectYamlFrontmatterRange(bytes) } };
}
function fileFor(data, draftId, kind = 'drafts') { return resolveStorePath(data.context, `${OWNER_PUBLICATION_DRAFT_ROOT}/${kind}/${draftId}.json`); }
function deeplyFrozen(value) {
  if (value === null || typeof value !== 'object') return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) deeplyFrozen(child);
}
async function expectCode(action, code) {
  try { await action(); } catch (error) {
    expect(error).toBeInstanceOf(OwnerAlphaError); expect(error.code).toBe(code); return error;
  }
  throw new Error(`expected ${code}`);
}
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'publication-store-'));
  cleanup.push(root);
  // Only git init/check-ignore run on this throwaway fixture. No commits, remotes,
  // canonical content, app startup, network, renderer or installation is involved.
  await execFileAsync('git', ['init', '--quiet', '--initial-branch=main', root]);
  await writeFile(path.join(root, '.gitignore'), '.workspace/\n');
  const context = defineStoreContext({ projectRoot: root, workspaceRoot: path.join(root, '.workspace/owner-alpha'), storeRoot: path.join(root, '.workspace/owner-alpha/store') });
  const config = configWith();
  let current = note();
  const counts = { reads: 0, sessions: 0, checks: 0, checkouts: 0 };
  const readNote = async () => { counts.reads += 1; return structuredClone(current); };
  const createEditSession = async ({ config: received, renderer }) => {
    counts.sessions += 1; expect(renderer).toEqual({ relativePath: MAPPING.relativePath, slug: MAPPING.slug }); return sessionFor(received);
  };
  const immediateChecks = ({ baseBytes, candidateBytes, operation, sourcePath }) => {
    counts.checks += 1; expect(baseBytes).toEqual(Buffer.from(BASE)); expect(sourcePath).toBe(MAPPING.relativePath);
    expect(candidateBytes).toEqual(applyEditorOperation(sessionFor(config), operation)); return { ok: true };
  };
  const checkoutReady = async (received) => { counts.checkouts += 1; return { root: received.repository.checkout, origin: received.repository.remote.url, branch: received.repository.branch, head: 'a'.repeat(40) }; };
  return { root, context, config, counts, readNote, createEditSession, immediateChecks, checkoutReady,
    setNote(value) { current = value; },
    prepare(overrides = {}) { return prepareOwnerPublicationDraft({ context, config, mappingId: MAPPING.id, readNote, createEditSession, immediateChecks, clock: () => '2026-10-30T10:00:00.000Z', ...overrides }); },
  };
}
function runtime(data, overrides = {}) {
  const jobs = new Map(); const starts = []; const outcomes = []; const completion = deferred();
  const startEdit = (input) => {
    expect(existsSync(fileFor(data, input.publication.draftId, 'authorizations'))).toBe(true);
    starts.push(input);
    jobs.set(input.jobId, { status: 'present', ...structuredClone(input), state: 'accepted' });
    return { jobId: input.jobId, accepted: Promise.resolve({ jobId: input.jobId, state: 'accepted' }), completion: completion.promise };
  };
  const args = { context: data.context, config: data.config, readNote: data.readNote, checkoutReady: data.checkoutReady,
    readJob: async (jobId) => jobs.get(jobId) ?? { status: 'missing' }, startEdit,
    onCompletion: (outcome) => { outcomes.push(outcome); }, clock: () => '2026-10-30T11:00:00.000Z', ...overrides };
  return { jobs, starts, outcomes, completion, args, publish: (draftId, extra = {}) => publishOwnerPublicationDraft({ ...args, draftId, ...extra }) };
}

afterEach(async () => { await Promise.all(cleanup.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('immutable private owner publication drafts', () => {
  test('creates/replays one full-binding identity with private modes, exact bytes and no job/source effects', async () => {
    const data = await fixture();
    const first = await data.prepare();
    const bytes = await readFile(fileFor(data, first.draft.draftId));
    const replay = await data.prepare({ clock: () => '2026-10-31T12:00:00.000Z' });
    expect(first.draft.draftId).toBe(hash(first.draft.prepared));
    expect(first.draft.jobId).toBe(`OA-PUB-${first.draft.draftId}`);
    expect(first.summary.replayed).toBe(false); expect(replay.summary.replayed).toBe(true);
    expect(replay.draft).toEqual(first.draft); expect(await readFile(fileFor(data, first.draft.draftId))).toEqual(bytes);
    expect(await loadOwnerPublicationDraft({ ...data, draftId: first.draft.draftId })).toEqual(first.draft);
    deeplyFrozen(first);
    for (const directory of [data.context.workspaceRoot, data.context.storeRoot,
      path.dirname(fileFor(data, first.draft.draftId)), path.dirname(fileFor(data, first.draft.draftId, 'authorizations'))]) {
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
    }
    expect((await stat(fileFor(data, first.draft.draftId))).mode & 0o777).toBe(0o600);
    expect(await readdir(path.dirname(fileFor(data, first.draft.draftId, 'authorizations')))).toEqual([]);
    expect(existsSync(path.join(data.context.storeRoot, 'jobs'))).toBe(false);
    expect(data.counts).toEqual({ reads: 2, sessions: 2, checks: 2, checkouts: 0 });
    expect(JSON.stringify(first.summary)).not.toContain(MAPPING.source.identity);
    expect(JSON.stringify(first.summary)).not.toContain(MAPPING.source.path);
    expect(first.draft.prepared.session).not.toHaveProperty('origin');
  });

  test('old immutable drafts without attribution retain their original identity and can be published', async () => {
    const data = await fixture();
    const { draft } = await data.prepare();
    const old = structuredClone(draft);
    delete old.prepared.reference.source.attribution;
    old.draftId = hash(old.prepared);
    old.jobId = `OA-PUB-${old.draftId}`;
    await writeFile(fileFor(data, old.draftId), artifactJson(old), { mode: 0o600 });
    expect(await loadOwnerPublicationDraft({ ...data, draftId: old.draftId })).toEqual(old);
    expect((await runtime(data).publish(old.draftId)).jobId).toBe(old.jobId);
  });

  test('requires real callback injections and a positive immediate-check result, redacting thrown data', async () => {
    const data = await fixture();
    for (const key of ['readNote', 'createEditSession', 'immediateChecks']) {
      await expectCode(() => data.prepare({ [key]: undefined }), 'publication-dependency-required');
    }
    await expectCode(() => data.prepare({ clock: null }), 'publication-dependency-required');
    for (const immediateChecks of [async () => undefined, async () => ({ ok: false }), async () => { throw new Error('sensitive-provider-body'); }]) {
      const error = await expectCode(() => data.prepare({ immediateChecks }), 'publication-immediate-checks-failed');
      expect(error.message).not.toContain('sensitive'); expect(error.details).toEqual({});
    }
    expect(existsSync(data.context.storeRoot)).toBe(false);
  });

  test('detects corrupted digest/operation bindings, including a rehashed but nonreproducible artifact', async () => {
    const data = await fixture(); const { draft } = await data.prepare();
    const original = artifactJson(draft);
    for (const change of [
      (value) => { value.prepared.candidate.text = EDITED.replace('new', 'NEW'); },
      (value) => { value.prepared.operation.start += 1; },
      (value) => { value.jobId = 'OA-unrelated'; },
      (value) => { value.checks.ok = false; },
      (value) => { value.extra = true; },
    ]) {
      const bad = structuredClone(draft); change(bad); await writeFile(fileFor(data, draft.draftId), artifactJson(bad));
      await expectCode(() => loadOwnerPublicationDraft({ ...data, draftId: draft.draftId }), bad.extra ? 'invalid-publication-artifact' : 'invalid-publication-draft');
      await writeFile(fileFor(data, draft.draftId), original);
    }
    const bad = structuredClone(draft); bad.prepared.operation.start += 1;
    bad.draftId = hash(bad.prepared); bad.jobId = `OA-PUB-${bad.draftId}`;
    await writeFile(fileFor(data, bad.draftId), artifactJson(bad), { mode: 0o600 });
    await expectCode(() => loadOwnerPublicationDraft({ ...data, draftId: bad.draftId }), 'invalid-publication-draft');
    const replayBad = structuredClone(draft); replayBad.prepared.session.origin = { type: 'caller-injected' };
    replayBad.draftId = hash(replayBad.prepared); replayBad.jobId = `OA-PUB-${replayBad.draftId}`;
    await writeFile(fileFor(data, replayBad.draftId), artifactJson(replayBad), { mode: 0o600 });
    await expectCode(() => loadOwnerPublicationDraft({ ...data, draftId: replayBad.draftId }), 'invalid-publication-draft');
  });

  test('refuses unsafe modes, links, malformed/oversized bytes, and loss of ignored containment', async () => {
    const data = await fixture(); const { draft } = await data.prepare(); const file = fileFor(data, draft.draftId); const bytes = await readFile(file);
    await chmod(file, 0o644); await expectCode(() => loadOwnerPublicationDraft({ ...data, draftId: draft.draftId }), 'unsafe-decision-artifact'); await chmod(file, 0o600);
    const extra = path.join(data.context.storeRoot, 'hardlink'); await link(file, extra);
    await expectCode(() => loadOwnerPublicationDraft({ ...data, draftId: draft.draftId }), 'unsafe-decision-artifact'); await unlink(extra);
    await unlink(file); await writeFile(extra, bytes, { mode: 0o600 }); await symlink(extra, file);
    await expectCode(() => loadOwnerPublicationDraft({ ...data, draftId: draft.draftId }), 'store-symlink-rejected'); await unlink(file); await writeFile(file, bytes, { mode: 0o600 });
    await chmod(path.dirname(file), 0o755); await expectCode(() => loadOwnerPublicationDraft({ ...data, draftId: draft.draftId }), 'unsafe-decision-directory'); await chmod(path.dirname(file), 0o700);
    for (const contents of ['{broken', `${bytes.toString()} `, Buffer.from([0xff]), Buffer.alloc(32769, 0x61)]) {
      await writeFile(file, contents);
      await expectCode(() => loadOwnerPublicationDraft({ ...data, draftId: draft.draftId }), contents.length > 32768 ? 'decision-artifact-size' : 'invalid-publication-artifact');
    }
    await writeFile(file, bytes); await writeFile(path.join(data.root, '.gitignore'), 'unrelated/\n');
    await expectCode(() => loadOwnerPublicationDraft({ ...data, draftId: draft.draftId }), 'store-not-ignored');
  });

  test('enforces 64 immutable slots without pruning, while replay remains valid at capacity', async () => {
    const data = await fixture(); const { draft } = await data.prepare();
    // Seed consistent private immutable fixtures cheaply; each retains exact
    // candidate/operation bytes but binds a different coherent source version.
    for (let version = 8; version < 7 + OWNER_PUBLICATION_DRAFT_LIMIT; version += 1) {
      const fixtureDraft = structuredClone(draft); fixtureDraft.prepared.reference.source.version = version;
      fixtureDraft.draftId = hash(fixtureDraft.prepared); fixtureDraft.jobId = `OA-PUB-${fixtureDraft.draftId}`;
      await writeFile(fileFor(data, fixtureDraft.draftId), artifactJson(fixtureDraft), { mode: 0o600 });
    }
    expect((await readdir(path.dirname(fileFor(data, draft.draftId)))).length).toBe(64);
    expect((await data.prepare()).summary.replayed).toBe(true);
    data.setNote(note(EDITED, 100)); await expectCode(() => data.prepare(), 'publication-draft-capacity');
    expect((await readdir(path.dirname(fileFor(data, draft.draftId)))).length).toBe(64);
  });

  test('rechecks current policy/mapping and refuses arbitrary draft ids or unexpected layout entries', async () => {
    const data = await fixture(); const { draft } = await data.prepare();
    for (const config of [configWith((raw) => { raw.ownerPublication.mappings[0].source.path = 'Drafts/Other.md'; }),
      configWith((raw) => { raw.limits.maxChangedLines -= 1; }), configWith((raw) => { raw.ownerPublication = { enabled: false }; })]) {
      await expectCode(() => loadOwnerPublicationDraft({ context: data.context, config, draftId: draft.draftId }), 'publication-draft-policy-mismatch');
    }
    for (const draftId of ['../escape', 'a'.repeat(63), `${draft.draftId}/other`]) {
      await expectCode(() => loadOwnerPublicationDraft({ ...data, draftId }), 'invalid-publication-draft-id');
    }
    await writeFile(path.join(path.dirname(fileFor(data, draft.draftId)), 'unexpected.json'), '{}', { mode: 0o600 });
    await expectCode(() => data.prepare(), 'unsafe-publication-entry');
  });
});

describe('explicit deterministic publication controller', () => {
  test('stores authorization before start and derives provenance without changing the prepared session or bytes', async () => {
    const data = await fixture(); const { draft } = await data.prepare(); const run = runtime(data);
    const receipt = await run.publish(draft.draftId);
    expect(receipt).toEqual({ draftId: draft.draftId, jobId: draft.jobId, state: 'accepted', authorizedAt: '2026-10-30T11:00:00.000Z',
      capturedVersion: 7, candidateDigest: draft.prepared.candidate.digest, replayed: false });
    const event = JSON.parse(await readFile(fileFor(data, draft.draftId, 'authorizations'), 'utf8'));
    expect(event.action).toBe('publish'); expect(event.draftId).toBe(draft.draftId); expect(event.jobId).toBe(draft.jobId);
    expect((await stat(fileFor(data, draft.draftId, 'authorizations'))).mode & 0o777).toBe(0o600);
    expect(run.starts).toHaveLength(1); const input = run.starts[0];
    expect(input.publication).toEqual({ draftId: draft.draftId, authorizationDigest: hash(event) });
    expect(input.session).toEqual({ ...draft.prepared.session, origin: { type: 'owner-publication', ...input.publication, reference: draft.prepared.reference } });
    expect(input.operation).toEqual(draft.prepared.operation);
    expect(applyEditorOperation(input.session, input.operation).toString('base64')).toBe(draft.prepared.candidate.bytesBase64);
    expect((await loadOwnerPublicationDraft({ ...data, draftId: draft.draftId })).prepared.session).not.toHaveProperty('origin');
    expect(JSON.stringify(receipt)).not.toContain(MAPPING.source.identity); expect(JSON.stringify(receipt)).not.toContain(MAPPING.source.path);
  });

  test('changed/unavailable source, changed policy and wrong/dirty/unavailable checkout block before authorization', async () => {
    const data = await fixture(); const { draft } = await data.prepare(); const run = runtime(data);
    for (const current of [note(EDITED.replace('new', 'NEW'), 7), note(EDITED.replace('new', 'next'), 8)]) {
      data.setNote(current); await expectCode(() => run.publish(draft.draftId), 'authoring-source-stale');
    }
    data.setNote(note());
    await expectCode(() => run.publish(draft.draftId, { readNote: async () => { throw new Error('sensitive-reader'); } }), 'authoring-read-failed');
    await expectCode(() => run.publish(draft.draftId, { config: configWith((raw) => { raw.limits.maxChangedLines -= 1; }) }), 'publication-draft-policy-mismatch');
    await expectCode(() => run.publish(draft.draftId, { checkoutReady: async () => ({ root: data.config.repository.checkout, origin: data.config.repository.remote.url, branch: 'main', head: 'c'.repeat(40) }) }), 'publication-base-mismatch');
    const error = await expectCode(() => run.publish(draft.draftId, { checkoutReady: async () => { throw new Error('dirty sensitive-path'); } }), 'publication-checkout-unavailable');
    expect(error.message).not.toContain('sensitive'); expect(run.starts).toHaveLength(0);
    expect(existsSync(fileFor(data, draft.draftId, 'authorizations'))).toBe(false);
  });

  test('serializes concurrent duplicate Publish and releases its separate lock after acceptance, not completion', async () => {
    const data = await fixture(); const { draft } = await data.prepare(); const accepted = deferred(); const started = deferred(); const run = runtime(data);
    const original = run.args.startEdit;
    run.args.startEdit = (input) => { const result = original(input); started.resolve(); return { ...result, accepted: accepted.promise }; };
    const first = run.publish(draft.draftId); await started.promise;
    const duplicates = Array.from({ length: 4 }, () => run.publish(draft.draftId)); await tick();
    expect(run.starts).toHaveLength(1); accepted.resolve({ jobId: draft.jobId, state: 'accepted' });
    const receipts = await Promise.all([first, ...duplicates]);
    expect(receipts.map((receipt) => receipt.jobId)).toEqual(Array(5).fill(draft.jobId));
    expect(receipts.filter((receipt) => !receipt.replayed)).toHaveLength(1); expect(run.starts).toHaveLength(1);
    expect(OWNER_PUBLICATION_PUBLISH_LOCK).not.toBe('.pipeline-mutation.lock');
    expect(existsSync(resolveStorePath(data.context, OWNER_PUBLICATION_PUBLISH_LOCK))).toBe(true);
    run.completion.resolve({ jobId: draft.jobId, state: 'completed' }); await tick(); expect(run.outcomes).toHaveLength(1);
  });

  test('an authorization/no-job crash gap resumes the same event and deterministic job, never a new identity', async () => {
    const data = await fixture(); const { draft } = await data.prepare(); const run = runtime(data);
    const error = await expectCode(() => run.publish(draft.draftId, { startEdit: () => { throw new Error('sensitive-start'); } }), 'publication-start-unavailable');
    expect(error.message).not.toContain('sensitive');
    const before = await readFile(fileFor(data, draft.draftId, 'authorizations'));
    const receipt = await run.publish(draft.draftId, { clock: () => '2026-11-01T00:00:00.000Z' });
    expect(receipt.jobId).toBe(draft.jobId); expect(run.starts).toHaveLength(1);
    expect(await readFile(fileFor(data, draft.draftId, 'authorizations'))).toEqual(before);
    expect(await readdir(path.dirname(fileFor(data, draft.draftId, 'authorizations')))).toEqual([`${draft.draftId}.json`]);
  });

  test('accepted/applying/terminal bound jobs return existing receipts with no host reads, restart or new retry version', async () => {
    const data = await fixture(); const { draft } = await data.prepare(); const run = runtime(data); await run.publish(draft.draftId);
    for (const state of ['accepted', 'applying', 'manual-intervention', 'blocked-pre-apply', 'failed', 'completed']) {
      run.jobs.get(draft.jobId).state = state;
      const receipt = await run.publish(draft.draftId, { readNote: async () => { throw new Error('host-unavailable'); }, checkoutReady: async () => { throw new Error('must-not-check'); } });
      expect(receipt.state).toBe(state); expect(receipt.replayed).toBe(true);
    }
    expect(run.starts).toHaveLength(1);
    const again = await data.prepare(); expect(again.draft.draftId).toBe(draft.draftId); expect(again.draft.jobId).toBe(draft.jobId);
    expect((await run.publish(again.draft.draftId)).state).toBe('completed'); expect(run.starts).toHaveLength(1);
  });

  test('unavailable/ambiguous/malformed status and an unapproved or mismatched durable handoff cannot start', async () => {
    const data = await fixture(); const { draft } = await data.prepare(); const run = runtime(data);
    for (const readJob of [async () => ({ status: 'ambiguous' }), async () => ({ status: 'unavailable' }), async () => { throw new Error('sensitive-status'); }]) {
      const error = await expectCode(() => run.publish(draft.draftId, { readJob }), 'publication-job-unavailable'); expect(error.message).not.toContain('sensitive');
    }
    await expectCode(() => run.publish(draft.draftId, { readJob: async () => ({ status: 'missing', traces: true }) }), 'invalid-publication-job-status');
    const unapproved = { status: 'present', jobId: draft.jobId, state: 'accepted', session: draft.prepared.session, operation: draft.prepared.operation, publication: { draftId: draft.draftId, authorizationDigest: '0'.repeat(64) } };
    await expectCode(() => run.publish(draft.draftId, { readJob: async () => unapproved }), 'publication-handoff-unapproved');
    expect(run.starts).toHaveLength(0); await run.publish(draft.draftId);
    for (const change of [
      (job) => { job.session.origin.authorizationDigest = '0'.repeat(64); },
      (job) => { delete job.session.origin; },
      (job) => { job.operation.start += 1; },
      (job) => { job.publication.draftId = '0'.repeat(64); },
    ]) {
      const job = structuredClone(run.jobs.get(draft.jobId)); change(job);
      await expectCode(() => run.publish(draft.draftId, { readJob: async () => job }), 'publication-job-binding-mismatch');
    }
    expect(run.starts).toHaveLength(1);
  });

  test('requires all Publish injections and rejects uncertain/invalid acceptance without creating a second job', async () => {
    const data = await fixture(); const { draft } = await data.prepare(); const run = runtime(data);
    for (const key of ['readNote', 'checkoutReady', 'readJob', 'startEdit', 'onCompletion']) {
      await expectCode(() => run.publish(draft.draftId, { [key]: undefined }), 'publication-dependency-required');
    }
    await expectCode(() => run.publish(draft.draftId, { startEdit: async () => { throw new Error('sensitive-async-starter'); } }), 'invalid-publication-acceptance');
    await tick(); expect(run.outcomes.at(-1).failureCode).toBe('publication-completion-failed');
    await expectCode(() => run.publish(draft.draftId, { startEdit: () => ({ jobId: draft.jobId, accepted: Promise.reject(new Error('sensitive-acceptance')), completion: Promise.reject(new Error('sensitive-completion')) }) }), 'publication-not-accepted');
    await tick(); expect(run.outcomes.at(-1).failureCode).toBe('publication-completion-failed');
    await expectCode(() => run.publish(draft.draftId, { startEdit: () => ({ jobId: draft.jobId, accepted: Promise.resolve({ jobId: draft.jobId, state: 'accepted' }), completion: Promise.resolve({ state: 'completed' }) }) }), 'publication-acceptance-uncertain');
    await run.publish(draft.draftId); expect(run.starts).toHaveLength(1);
  });

  test('observes rejected completion and observer failure without raw error leakage or unhandled rejection', async () => {
    const data = await fixture(); const { draft } = await data.prepare(); const run = runtime(data);
    await run.publish(draft.draftId); run.completion.reject(new Error('sensitive-provider-body')); await tick();
    expect(run.outcomes).toEqual([{ draftId: draft.draftId, jobId: draft.jobId, status: 'rejected', state: null, failureCode: 'publication-completion-failed' }]);
    const secondData = await fixture(); const secondDraft = (await secondData.prepare()).draft;
    const second = runtime(secondData, { onCompletion: () => Promise.reject(new Error('sensitive-observer')) });
    const originalWarning = process.emitWarning; const warnings = [];
    process.emitWarning = (...args) => { warnings.push(args); };
    try {
      await second.publish(secondDraft.draftId); second.completion.reject(new Error('sensitive-completion')); await tick(); await tick();
      expect(warnings).toEqual([['owner publication completion observer failed', { code: 'PUBLICATION_OBSERVER_FAILED' }]]);
    } finally { process.emitWarning = originalWarning; }
  });
});

describe('bound immediately-before-application source guard', () => {
  test('requires immutable owner authorization and mechanically derived session/operation provenance', async () => {
    const data = await fixture(); const { draft } = await data.prepare(); const run = runtime(data);
    const args = { ...data, draftId: draft.draftId, jobId: draft.jobId, session: draft.prepared.session, operation: draft.prepared.operation };
    await expectCode(() => guardOwnerPublicationSource(args), 'publication-handoff-unapproved');
    await run.publish(draft.draftId); const input = run.starts[0];
    const source = await guardOwnerPublicationSource({ ...args, session: input.session });
    expect(source).toEqual(draft.prepared.reference.source); deeplyFrozen(source);
    for (const overrides of [{ session: draft.prepared.session }, { jobId: 'OA-other' }, { operation: { ...input.operation, start: input.operation.start + 1 } },
      { session: { ...input.session, origin: { ...input.session.origin, reference: { ...input.session.origin.reference, policyRevision: `sha256:${'0'.repeat(64)}` } } } }]) {
      await expectCode(() => guardOwnerPublicationSource({ ...args, session: input.session, ...overrides }), 'publication-handoff-mismatch');
    }
    const eventFile = fileFor(data, draft.draftId, 'authorizations'); const event = JSON.parse(await readFile(eventFile, 'utf8')); event.action = 'unapproved';
    await writeFile(eventFile, artifactJson(event));
    await expectCode(() => guardOwnerPublicationSource({ ...args, session: input.session }), 'publication-authorization-mismatch');
  });

  test('pre-apply and recovered pre-apply checks refuse stale/unavailable sources; post-apply behavior belongs to runtime', async () => {
    const data = await fixture(); const { draft } = await data.prepare(); const run = runtime(data); await run.publish(draft.draftId);
    const input = run.starts[0]; const args = { ...data, draftId: draft.draftId, jobId: draft.jobId, session: input.session, operation: input.operation };
    const reloaded = JSON.parse(JSON.stringify(input.session));
    expect(await guardOwnerPublicationSource({ ...args, session: reloaded })).toEqual(draft.prepared.reference.source);
    data.setNote(note(EDITED.replace('new', 'next'), 8)); await expectCode(() => guardOwnerPublicationSource({ ...args, session: reloaded }), 'authoring-source-stale');
    await expectCode(() => guardOwnerPublicationSource({ ...args, readNote: undefined }), 'publication-dependency-required');
    await expectCode(() => guardOwnerPublicationSource({ ...args, readNote: async () => { throw new Error('sensitive-expired-access'); } }), 'authoring-read-failed');
    await expectCode(() => guardOwnerPublicationSource({ ...args, config: configWith((raw) => { raw.ownerPublication.mappings[0].source.identity = 'another-source'; }) }), 'publication-draft-policy-mismatch');
    expect(run.starts).toHaveLength(1);
  });
});

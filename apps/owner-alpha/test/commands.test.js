import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { readJsonArtifact } from '../src/artifacts.js';
import { createOwnerCommands } from '../src/core/commands.js';
import { createMemoryEditSessionStore } from '../src/core/edit-sessions.js';
import { createBootstrapPrincipalAdapter } from '../src/core/principal.js';
import { OwnerAlphaError } from '../src/errors.js';
import { applyEditorOperation } from '../src/operation.js';
import { createOwnerHandoffStore, guardOwnerDirect } from '../src/owner-direct.js';
import { createEditSession } from '../src/source.js';
import { BASE, EDITED, MAPPING, cleanup, publicationFixture } from './publication-fixture.js';

const example = JSON.parse(await readFile(new URL('../owner-alpha.example.json', import.meta.url), 'utf8'));
const reviewEnabled = { ...example.proposalReview, enabled: true, socketPath: '/tmp/core-review.sock' };
const enabled = { ...example, proposalReview: reviewEnabled, ownerPublication: { enabled: true, mappings: [MAPPING] } };
const page = { relativePath: MAPPING.relativePath, slug: MAPPING.slug };
const queueId = 'Q-00000000-0000-4000-8000-000000000001';
const viewId = '1'.repeat(64);
const draftId = '2'.repeat(64);
const jobId = 'OA-core-fixture';
const intent = { queueId, reviewEvidenceDigest: `sha-256=:${Buffer.alloc(32, 7).toString('base64')}:`, action: 'approve', reason: 'Matches reviewed source.' };

const principalAdapter = createBootstrapPrincipalAdapter();
const attest = (adapter, id = example.owner.identity, sessionId = 'device-one') => adapter.fromSession({ id, sessionId, authenticatedAt: 1 });
const principal = attest(principalAdapter);
const unverified = [undefined, null, 'owner', {}, { ...principal }, attest(createBootstrapPrincipalAdapter()), attest(principalAdapter, 'other-owner')];

function fixtureCommands(overrides = {}) {
  return createOwnerCommands({ config: enabled, principalAdapter, ...overrides });
}

afterEach(async () => {
  for (const root of cleanup.splice(0)) await rm(root, { recursive: true, force: true });
});

const protectedCommands = [
  'readPageSource', 'inspectOwnerDirect', 'saveOwnerDirect', 'openRawEdit', 'saveRawEdit',
  'listProposals', 'readProposal', 'recordDecision', 'readDecision', 'applyProposal',
  'preparePublication', 'readPublicationCurrent', 'readPublicationReview', 'publish', 'readJob',
];

test.each(protectedCommands)('%s refuses an absent or invalid principal before reading input or dependencies', async (command) => {
  const commands = fixtureCommands();
  const untouchable = new Proxy({}, { get() { throw new Error('input read before authorization'); } });
  for (const rejected of unverified) {
    const result = commands[command](untouchable, rejected);
    await expect(result).rejects.toBeInstanceOf(OwnerAlphaError);
    await expect(result).rejects.toHaveProperty('code', 'invalid-session');
  }
});

test('a verified owner can read and Save raw source and separately inspect and Save a staged exact change', async () => {
  const f = await publicationFixture();
  const owner = attest(principalAdapter, f.config.owner.identity);
  const otherDevice = attest(principalAdapter, f.config.owner.identity, 'device-two');
  const saves = [];
  const rawJobId = 'OA-core-raw';
  const directJobId = 'OA-core-direct';
  const commands = fixtureCommands({
    config: f.config,
    projectRoot: f.root,
    createEditSession: (input) => createEditSession({ ...input, git: f.git }),
    editSessions: createMemoryEditSessionStore(),
    handoffs: createOwnerHandoffStore(),
    directEdits: createMemoryEditSessionStore(),
    createJobId: () => saves.length ? directJobId : rawJobId,
    async saveEdit(input) {
      if (input.operation) await guardOwnerDirect({ context: f.context, config: f.config, ...input });
      saves.push(input);
      return { jobId: input.jobId, state: 'accepted' };
    },
  });

  const source = await commands.readPageSource(page, owner);
  expect(source.source.text).toBe(BASE);
  const raw = await commands.openRawEdit(page, owner);
  expect(raw.session).toEqual(source);
  expect(await commands.saveRawEdit({ editSessionId: raw.editSessionId, editedText: EDITED }, owner)).toEqual({ jobId: rawJobId, state: 'accepted' });
  expect(saves[0]).toEqual({ jobId: rawJobId, session: source, editedText: EDITED });
  await expect(commands.saveRawEdit({ editSessionId: raw.editSessionId, editedText: EDITED }, owner)).rejects.toHaveProperty('code', 'edit-session-expired');

  const bytes = Buffer.from(BASE);
  const offset = bytes.indexOf('old');
  const handoff = {
    source: { path: source.relativePath, byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
    revision: source.baseCommit,
    slug: source.slug,
    operations: [{ operationId: 'change-old', start: offset, end: offset + 3, expected: 'old', replacement: 'new' }],
  };
  // Staging alone is the intentionally unauthenticated exception.
  await expect(commands.stageOwnerDirect({ handoff: {} })).rejects.toHaveProperty('code', 'invalid-owner-handoff');
  const staged = await commands.stageOwnerDirect({ handoff });
  const review = await commands.inspectOwnerDirect(staged, owner);
  expect(review.session).toEqual(source);
  expect(review.operationCount).toBe(1);
  const authorizationPath = `owner-direct/${directJobId}.json`;
  await expect(readJsonArtifact(f.context, authorizationPath)).rejects.toHaveProperty('code', 'artifact-not-found');
  const directSave = { editId: review.editId };
  await expect(commands.saveOwnerDirect(directSave, otherDevice)).rejects.toHaveProperty('code', 'owner-handoff-expired');
  expect(saves).toHaveLength(1);
  expect(await commands.saveOwnerDirect(directSave, owner)).toEqual({ jobId: directJobId, state: 'accepted' });
  expect(saves).toHaveLength(2);
  expect(applyEditorOperation(saves[1].session, saves[1].operation).toString()).toBe(EDITED);
  expect((await readJsonArtifact(f.context, authorizationPath)).authority).toBe('owner-direct');
  await expect(commands.inspectOwnerDirect(staged, owner)).rejects.toHaveProperty('code', 'owner-handoff-expired');
});

test('a verified owner can list, inspect, decide, read a receipt, and apply an approved proposal', async () => {
  const decision = { action: 'approve', decidedAt: '2026-11-19T12:00:00Z' };
  const summary = { queueId, ...decision };
  const entry = { summary: { queueId }, sourceVerification: { status: 'verified' } };
  const history = { decision, summary, queueRetained: true };
  const application = { queueId, state: 'ready' };
  const applied = { applied: true, event: { attempt: 1 }, job: { jobId, state: 'accepted' } };
  const proposalReview = {
    applicationAvailable: true,
    async list({ cursor }) { expect(cursor).toBeNull(); return { actionable: [entry], history: [], nextCursor: null }; },
    async load(id) { expect(id).toBe(queueId); return { entry, decision: null }; },
    async record(input) { expect(input).toEqual(intent); return { decision, index: { decisions: [summary] }, replayed: false }; },
    async loadDecision(id) { expect(id).toBe(queueId); return history; },
    async applicationStatus(id) { expect(id).toBe(queueId); return application; },
    async apply(id) { expect(id).toBe(queueId); return applied; },
  };
  const commands = fixtureCommands({ proposalReview });
  expect(await commands.listProposals({ cursor: null }, principal)).toEqual({ actionable: [entry], history: [], nextCursor: null });
  expect(await commands.readProposal({ queueId }, principal)).toEqual({ entry, decision: null });
  expect(await commands.recordDecision(intent, principal)).toEqual({ ...decision, summary, replayed: false });
  expect(await commands.readDecision({ queueId }, principal)).toEqual({ ...history, application });
  expect(await commands.applyProposal({ queueId }, principal)).toEqual(applied);
});

test('a verified owner can prepare and read publication reviews, publish, and read job status', async () => {
  const job = { jobId, state: 'accepted' };
  const draft = { draftId, jobId };
  const publication = {
    publishAvailable: true,
    async prepare({ mappingId }) { expect(mappingId).toBe(MAPPING.id); return { outcome: 'unchanged', viewId }; },
    async loadCurrent(input) { expect(input).toEqual({ viewId }); return { text: BASE }; },
    async load(input) { expect(input).toEqual({ draftId }); return draft; },
    async readJob(id) { expect(id).toBe(jobId); return job; },
    async publish(input) { expect(input).toEqual({ draftId }); return { draftId, ...job }; },
  };
  const commands = fixtureCommands({ publication, lookupJob: publication.readJob });
  expect(await commands.preparePublication({ mappingId: MAPPING.id }, principal)).toEqual({ outcome: 'unchanged', viewId });
  expect(await commands.readPublicationCurrent({ viewId }, principal)).toEqual({ text: BASE });
  expect(await commands.readPublicationReview({ draftId }, principal)).toEqual({ draft, job, publishAvailable: true });
  expect(await commands.publish({ draftId }, principal)).toEqual({ draftId, ...job });
  expect(await commands.readJob({ jobId }, principal)).toEqual(job);
});

test('valid principals do not bypass disabled, unavailable, or read-only grants', async () => {
  const disabled = fixtureCommands({ config: example });
  await expect(disabled.listProposals({}, principal)).rejects.toHaveProperty('code', 'proposal-review-disabled');
  await expect(disabled.applyProposal({ queueId }, principal)).rejects.toHaveProperty('code', 'proposal-review-disabled');
  await expect(disabled.preparePublication({}, principal)).rejects.toHaveProperty('code', 'publication-disabled');
  await expect(disabled.publish({}, principal)).rejects.toHaveProperty('code', 'publication-disabled');
  const unavailable = fixtureCommands({ proposalReview: { applicationAvailable: false }, publication: { publishAvailable: false } });
  await expect(unavailable.applyProposal({ queueId }, principal)).rejects.toHaveProperty('code', 'application-unavailable');
  await expect(unavailable.publish({ draftId }, principal)).rejects.toHaveProperty('code', 'publication-read-only');
});

test('unexpected effect errors use the existing route fallback codes', async () => {
  const unexpected = () => { throw new Error('internal fixture failure'); };
  const commands = fixtureCommands({ proposalReview: { list: unexpected }, publication: { prepare: unexpected }, lookupJob: unexpected });
  for (const [run, code] of [
    [() => commands.listProposals({ cursor: null }, principal), 'review-list-failed'],
    [() => commands.preparePublication({ mappingId: MAPPING.id }, principal), 'publication-prepare-failed'],
    [() => commands.readJob({ jobId }, principal), 'job-lookup-failed'],
  ]) {
    const result = run();
    await expect(result).rejects.toBeInstanceOf(OwnerAlphaError);
    await expect(result).rejects.toHaveProperty('code', code);
  }
});

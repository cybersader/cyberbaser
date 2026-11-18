import { afterEach, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { createJsonArtifactOnce } from '../src/artifacts.js';
import { computePolicyRevision } from '../src/config.js';
import { OwnerAlphaError } from '../src/errors.js';
import { initializeDurableJob, transitionDurableJob } from '../src/job-state.js';
import { runOwnerAlphaPipeline, pipelineArtifactPaths } from '../src/pipeline.js';
import { createPublicationSourceGuard } from '../src/owner-publication-runtime.js';
import { cleanup, publicationFixture } from './publication-fixture.js';

const AT = '2026-10-30T12:00:00.000Z';
const SEQUENCE = ['preflighting', 'checking', 'rendering', 'ready-to-apply', 'applying', 'source-applied'];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function seeded(data, target = 'ready-to-apply', publication = true) {
  const { draft } = await data.prepare();
  const { prepared } = draft;
  const jobId = 'OA-RECOVERY-SYNTHETIC';
  const session = publication ? { ...prepared.session, origin: { type: 'owner-publication', draftId: draft.draftId,
    authorizationDigest: 'a'.repeat(64), reference: prepared.reference } } : prepared.session;
  const operation = prepared.operation;
  const paths = pipelineArtifactPaths(jobId);
  await createJsonArtifactOnce(data.context, paths.session, session);
  await createJsonArtifactOnce(data.context, paths.operation, operation);
  await createJsonArtifactOnce(data.context, paths.preApplyChecks, { schemaVersion: 1, artifactType: 'owner-alpha-pre-apply-check-result', jobId,
    result: { ok: true, rendered: { witnesses: { old: 'old', new: 'new' } } } });
  await initializeDurableJob(data.context, { jobId, policyRevision: computePolicyRevision(data.config), at: AT });
  for (const state of SEQUENCE) {
    await transitionDurableJob(data.context, jobId, state, { at: AT, reason: `synthetic-${state}` });
    if (state === target) break;
  }
  return { jobId, session, operation, prepared, paths, config: data.config, context: data.context };
}

test('generic optional guard is last after ready checkout and before source application, without changing ordinary edit behavior', async () => {
  const data = await publicationFixture(); const input = await seeded(data, 'ready-to-apply', false); const calls = [];
  const result = await runOwnerAlphaPipeline(input, {
    assertCheckoutReady: async () => { calls.push('checkout'); return { head: data.head }; },
    revalidateSource: async ({ jobId, session, operation }) => { calls.push('guard'); expect(jobId).toBe(input.jobId); expect(session).toEqual(input.session); expect(operation).toEqual(input.operation); },
    applyAcceptedOperation: async () => { calls.push('apply'); throw new OwnerAlphaError('synthetic-stop', 'synthetic effect boundary'); },
  });
  expect(calls).toEqual(['checkout', 'guard', 'apply']); expect(result.state).toBe('manual-intervention');
  const other = await publicationFixture(); const ordinary = await seeded(other, 'ready-to-apply', false); let applied = 0;
  const unchanged = await runOwnerAlphaPipeline(ordinary, { assertCheckoutReady: async () => ({ head: other.head }),
    applyAcceptedOperation: async () => { applied += 1; throw new OwnerAlphaError('synthetic-stop', 'synthetic effect boundary'); } });
  expect(applied).toBe(1); expect(unchanged.failure.code).toBe('synthetic-stop');
  const before = other.reads;
  await createPublicationSourceGuard({ config: other.config, context: other.context, readNote: other.readNote })(ordinary);
  expect(other.reads).toBe(before);
});

test('recovered preapply publication refuses missing guard or missing coherent reader before any effect', async () => {
  for (const missing of ['guard', 'reader']) {
    const data = await publicationFixture(); const input = await seeded(data); let applied = 0;
    const dependencies = { assertCheckoutReady: async () => ({ head: data.head }),
      applyAcceptedOperation: async () => { applied += 1; throw new Error('must not apply'); } };
    if (missing === 'reader') dependencies.revalidateSource = createPublicationSourceGuard({ config: data.config, context: data.context });
    const result = await runOwnerAlphaPipeline({ config: input.config, context: input.context, jobId: input.jobId }, dependencies);
    expect(result.state).toBe('blocked-pre-apply'); expect(applied).toBe(0);
    expect(result.failure.code).toBe(missing === 'guard' ? 'publication-guard-unavailable' : 'publication-reader-unavailable');
  }
});

test('malformed publication provenance cannot pass a permissive injected guard', async () => {
  const data = await publicationFixture(); const { draft } = await data.prepare();
  const session = { ...draft.prepared.session, origin: { type: 'owner-publication', draftId: 'bad', authorizationDigest: 'a'.repeat(64), reference: {} } };
  let guards = 0; let effects = 0;
  const result = await runOwnerAlphaPipeline({ config: data.config, context: data.context, jobId: 'OA-BAD-ORIGIN', session, operation: draft.prepared.operation }, {
    assertCheckoutReady: async () => ({ head: data.head }), runPreApplyChecks: async () => ({ ok: true }),
    revalidateSource: async () => { guards += 1; }, applyAcceptedOperation: async () => { effects += 1; },
  });
  expect(result.state).toBe('blocked-pre-apply'); expect(result.failure.code).toBe('invalid-publication-origin'); expect(guards).toBe(0); expect(effects).toBe(0);
});

test('recovered applying without an exact source-applied receipt preserves manual refusal and never calls host', async () => {
  const data = await publicationFixture(); const input = await seeded(data, 'applying'); let guard = 0; let effects = 0;
  const result = await runOwnerAlphaPipeline({ config: input.config, context: input.context, jobId: input.jobId }, {
    revalidateSource: async () => { guard += 1; throw new Error('host unavailable'); },
    applyAcceptedOperation: async () => { effects += 1; },
  });
  expect(result.state).toBe('manual-intervention'); expect(result.failure.code).toBe('interrupted-application-ambiguous'); expect(guard).toBe(0); expect(effects).toBe(0);
});

test('postapplication recovery completes with unavailable host using only durable effect bindings and injected downstream effects', async () => {
  const data = await publicationFixture(); const input = await seeded(data, 'source-applied'); const op = input.operation;
  await createJsonArtifactOnce(data.context, input.paths.sourceApplied, { schemaVersion: 1, artifactType: 'owner-alpha-source-applied-effect', jobId: input.jobId,
    result: { status: 'source-applied', recovery: 'reconcile-then-commit', checkout: data.root, baseCommit: data.head,
      sourcePath: input.session.relativePath, sourceMode: '100644', baseBlob: input.session.source.gitObjectId,
      baseDigest: op.baseDigest, candidateDigest: op.candidateDigest, candidateByteLength: op.candidateByteLength,
      candidateBytesBase64: input.prepared.candidate.bytesBase64, correction: { ...op },
      exactSplice: { start: op.start, end: op.end, oldByteLength: op.end - op.start, replacementByteLength: Buffer.from(op.replacementBytesBase64, 'base64').length } } });
  const calls = []; const commit = 'b'.repeat(40); const reads = data.reads; data.setUnavailable();
  const result = await runOwnerAlphaPipeline({ config: data.config, context: data.context, jobId: input.jobId }, {
    revalidateSource: async () => { calls.push('host'); throw new Error('must not read host'); },
    assertCheckoutReady: async () => { throw new Error('must not preflight after apply'); },
    applyAcceptedOperation: async () => { throw new Error('must not reapply'); },
    getHead: async () => data.head,
    commitAppliedCandidate: async () => { calls.push('commit'); return { status: 'committed', commit }; },
    pushExactCommit: async () => { calls.push('push'); return { status: 'pushed', commit }; },
    discoverDeploymentRun: async () => { calls.push('discover'); return { binding: { runId: '42', headSha: commit } }; },
    monitorDeploymentRun: async () => { calls.push('monitor'); return { state: 'success' }; },
    confirmLivePage: async () => { calls.push('live'); return { oldWitnessAbsent: true, newWitnessUnique: true }; },
    rebuildLocal: async () => { calls.push('rebuild'); return { status: 'local-rebuilt', commit }; },
  });
  expect(result.state).toBe('completed'); expect(calls).toEqual(['commit', 'push', 'discover', 'monitor', 'live', 'rebuild']); expect(data.reads).toBe(reads);
});

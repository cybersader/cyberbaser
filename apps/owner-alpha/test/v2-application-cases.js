// Imported by proposal-application.test.js through its local fixture registration.
// This file is a factory, not a second test runner.
import { createHash, randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { createEditSession, defaultGitRunner } from '../src/source.js';
import { changeSetCorrection } from '../src/change-set-operation.js';
import { deriveProposalApplication } from '../src/proposal-application.js';
import { prepareApprovedProposalInput } from '../src/approved-proposal.js';

export function registerV2ApplicationCases(api) {
  const { test, expect, cleanup, createFixture, git, path, mkdir, writeFile, readFile, ownerRuntime,
    createChangeSetProposal, prepareProposal, serializeChangeSetProposal, serializeProposal,
    applyChangeSetProposal, openProposalQueue, digestBytes, createReviewIpcHandler,
    createProposalReviewClient, createOwnerProposalReviewSource, readTrustPolicy,
    createOwnerAlphaHandler, createOwnerProposalReviewService, runPreApplyChecks, runImmediateChecks,
    recordProposalDecision, applyApprovedProposal, assessProposalApplication, listProposalApplicationEvents,
    listApprovedProposalInputs, readJsonArtifact, pipelineArtifactPaths, defineStoreContext, prepareStore,
    initializeDurableJob, transitionDurableJob, createJsonArtifactOnce, computePolicyRevision,
    createSaveHandler, gitState } = api;
  const sourcePath = 'docs/multi.md';
  const text = '# Multi\n\nKeep **format** and café unchanged.\n\nCorrect teh typo.\n\nAn old detail.\n\nTail\tstays.\n';
  const base = Buffer.from(text);
  const resolveSlug = async () => 'docs/multi';

  async function fixture({ replacements = ['the', 'new'], trustFile = true } = {}) {
    const item = await createFixture({ pages: [{ path: sourcePath, text }] });
    cleanup.push(() => item.cleanup());
    item.bare = path.join(item.root, 'objects.git');
    // The owner pipeline's policy is real, committed and independently reread.
    if (trustFile) await writeFile(path.join(item.checkout, '.cyberbaser/trust.yml'), 'trusted: [owner]\nagents: []\n');
    else await unlink(path.join(item.checkout, '.cyberbaser/trust.yml')); // a fresh vault: no trust file at all
    await writeFile(path.join(item.checkout, 'publish.yml'), 'allow:\n  - "docs/**"\n');
    await git(item.checkout, ['add', '--all']);
    await git(item.checkout, ['commit', '-q', '-m', 'Fixture publication policy']);
    item.revision = await git(item.checkout, ['rev-parse', 'HEAD']);
    const renderer = async ({ contentDir, outputDir, targetPage }) => {
      const markdown = await readFile(path.join(contentDir, sourcePath), 'utf8');
      const escaped = markdown.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
      await mkdir(path.dirname(path.join(outputDir, targetPage)), { recursive: true });
      await writeFile(path.join(outputDir, targetPage), `<html><body><main>${escaped}</main></body></html>`);
      return { renderer: 'hermetic-v2', outputDir };
    };
    const runtime = await ownerRuntime(item, {
      runPreApplyChecks: (input) => runPreApplyChecks({ ...input, renderer }),
    });
    const policy = await readTrustPolicy(runtime.policyGit, item.checkout, item.revision);
    const submittedAt = new Date().toISOString().replace(/\.\d{3}Z$/u, 'Z');
    const source = { repository: runtime.config.repository.remote.url, revision: item.revision, path: sourcePath };
    const submission = { submittedAt, rationale: 'Two separate corrections as one reviewed suggestion.', evidence: [], identityClaim: null };
    const proposal = createChangeSetProposal(base, { proposalId: 'test:multi-change', source, submission, operations: [
      { operationId: 'spelling', start: base.indexOf('teh'), end: base.indexOf('teh') + 3, expected: 'teh', replacement: replacements[0] },
      { operationId: 'detail', start: base.indexOf('old'), end: base.indexOf('old') + 3, expected: 'old', replacement: replacements[1] },
    ] });
    const legacy = prepareProposal(base, { proposalId: 'test:legacy', source, submission,
      operation: { type: 'quote', selector: { quote: 'teh', prefix: 'Correct ', suffix: ' typo.' }, replacement: 'that' } });
    const queue = await openProposalQueue({ config: { root: path.join(item.root, 'multi-queue') },
      resolveEvidence: async () => ({ baseBytes: base, policy }) });
    cleanup.push(() => queue.close());
    const enqueue = async (proposalText) => queue.enqueue({ proposalText, baseBytes: base, policy, verifiedSubject: null,
      carrier: { lane: 'lane-b', metadata: { bindingDigest: item.bindingDigest, pageId: item.pageId } },
      idempotency: { scope: 'lane-b', key: randomUUID(), requestDigest: digestBytes(Buffer.from(proposalText)) } });
    const accepted = await enqueue(serializeChangeSetProposal(proposal));
    await enqueue(serializeProposal(legacy));
    // Real IPC handler and owner parser; only the Unix socket transport is replaced.
    const ipc = createReviewIpcHandler({ review: queue.review });
    const client = createProposalReviewClient({ socketPath: '/fixture/review.sock', transport: (_, bytes) => ipc(bytes) });
    const review = createOwnerProposalReviewSource({ config: runtime.config, git: runtime.policyGit, client });
    const queueId = accepted.receipt.queueId;
    const decide = async () => {
      const entry = await review.load(queueId);
      return recordProposalDecision({ context: runtime.context, source: review, ownerIdentity: 'owner',
        intent: { queueId, reviewEvidenceDigest: entry.summary.reviewEvidenceDigest, action: 'approve', reason: 'Approve both exact changes.' } });
    };
    const apply = (extra = {}) => applyApprovedProposal({ context: runtime.context, config: runtime.config, queueId,
      git: runtime.policyGit, resolveSlug, checkoutReady: runtime.checkoutReady, saveEdit: runtime.saveEdit,
      createJobId: () => 'OA-v2-atomic', ...extra });
    return { item, runtime, policy, proposal, queueId, client, review, decide, apply };
  }

  test('owner-direct rendered and Markdown-block edits use one exact commit with no proposal approval, then resume safely', async () => {
    const { item, runtime, review } = await fixture();
    const service = createOwnerProposalReviewService({ config: runtime.config, context: runtime.context, source: review });
    const handler = createOwnerAlphaHandler({ config: runtime.config, projectRoot: runtime.ownerProject, proposalReview: service,
      createEditSession: input => createEditSession({ ...input, git: async (cwd, args, options) => {
        if (args.join(' ') === 'remote get-url origin' || args.join(' ') === 'remote get-url --push origin') return runtime.config.repository.remote.url;
        return defaultGitRunner(cwd, args, options);
      } }),
      saveEdit: runtime.saveEdit, lookupJob: async () => null, createJobId: () => 'OA-owner-direct-atomic' });
    const origin = `http://${runtime.config.listen.host}:${runtime.config.listen.port}`;
    const request = (url, options = {}) => handler(new Request(`${origin}${url}`, { ...options, headers: { Host: new URL(origin).host, ...options.headers } }));
    const login = await request(`/owner/bootstrap?token=${handler.bootstrapToken}`);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const operations = [
      { operationId: 'source-block-1', start: base.indexOf('**format**'), end: base.indexOf('**format**') + 10, expected: '**format**', replacement: '*format*' },
      { operationId: 'edit-run-2', start: base.indexOf('teh'), end: base.indexOf('teh') + 3, expected: 'teh', replacement: 'the' },
    ];
    const handoff = { source: { path: sourcePath, byteLength: base.length, sha256: createHash('sha256').update(base).digest('hex') }, revision: item.revision, slug: 'docs/multi', operations };
    const stage = await request('/owner/stage', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'http://127.0.0.1:4318' }, body: new URLSearchParams({ changeSet: JSON.stringify(handoff) }).toString() });
    expect(stage.status).toBe(303);
    const response = await request(stage.headers.get('location'), { headers: { Cookie: cookie } });
    const html = await response.text(); expect(response.status, html).toBe(200);
    const editId = /data-edit-id="([^"]+)"/.exec(html)[1], csrf = /data-csrf="([^"]+)"/.exec(html)[1];
    const before = await gitState(item.checkout);
    const saved = await request('/api/owner-direct', { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ editId, csrf }) });
    expect(saved.status).toBe(202);
    const completed = await runtime.completions.get('OA-owner-direct-atomic');
    expect(completed.failure).toBeNull(); expect(completed.state).toBe('completed');
    const expected = Buffer.from(text.replace('**format**', '*format*').replace('teh', 'the'));
    expect(await readFile(path.join(item.checkout, sourcePath))).toEqual(expected);
    expect(await git(item.checkout, ['rev-parse', 'HEAD^'])).toBe(before.head);
    expect(await git(item.checkout, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'])).toBe(sourcePath);
    expect(await listApprovedProposalInputs(runtime.context)).toEqual([]);
    expect(await listProposalApplicationEvents(runtime.context)).toEqual([]);
    const paths = pipelineArtifactPaths('OA-owner-direct-atomic');
    const checks = await readJsonArtifact(runtime.context, paths.preApplyChecks);
    expect(checks.result.immediate.operation).toEqual({ reproducesCandidate: true, operationCount: 2, outsideBytesIdentical: true });
    const after = await gitState(item.checkout);
    const resumed = await runtime.handler.resumeJob({ jobId: 'OA-owner-direct-atomic' });
    expect(resumed.state).toBe('completed'); expect(await gitState(item.checkout)).toEqual(after);
    const stale = await request('/owner/stage', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ changeSet: JSON.stringify(handoff) }).toString() });
    expect((await request(stale.headers.get('location'), { headers: { Cookie: cookie } })).status).toBe(409);
    await unlink(path.join(runtime.context.storeRoot, 'owner-direct/OA-owner-direct-atomic.json'));
    await expect(runtime.handler.resumeJob({ jobId: 'OA-owner-direct-atomic' })).rejects.toHaveProperty('code', 'artifact-not-found');
    expect(await gitState(item.checkout)).toEqual(after);
  });

  test('v2 mixed inbox, per-change inspection, one approval and exact atomic commit; durable effect resumes without replay', async () => {
    const { item, runtime, proposal, queueId, client, review, decide, apply } = await fixture({ replacements: ['that', 'fresh'] });
    const advertised = await client.list();
    expect(advertised.entries.map((entry) => entry.proposalVersion).sort()).toEqual([1, 2]);
    const listed = await review.list();
    expect(listed.entries).toHaveLength(2);
    const entry = listed.entries.find((entry) => entry.summary.queueId === queueId);
    expect(entry.changes.operations).toHaveLength(2);
    expect(entry.changes.operations[0].startPosition).toEqual({ line: 5, column: 9 });
    expect(entry.changes.operations[1].context.before).toContain('typo.');
    const expected = applyChangeSetProposal(base, proposal);
    expect(entry.document.candidateText).toBe(expected.toString('utf8'));
    const service = createOwnerProposalReviewService({ config: runtime.config, context: runtime.context, source: review });
    const handler = createOwnerAlphaHandler({ config: runtime.config, proposalReview: service,
      saveEdit: runtime.saveEdit, lookupJob: async () => null });
    const origin = `http://${runtime.config.listen.host}:${runtime.config.listen.port}`;
    const request = (url, cookie) => new Request(`${origin}${url}`, { headers: { Host: new URL(origin).host, ...(cookie ? { Cookie: cookie } : {}) } });
    const signIn = await handler(request(`/owner/bootstrap?token=${handler.bootstrapToken}`));
    expect(signIn.status).toBe(303);
    const cookie = signIn.headers.get('set-cookie').split(';')[0];
    const inbox = await handler(request('/owner/review', cookie));
    expect(inbox.status).toBe(200);
    expect(await inbox.text()).toMatch(new RegExp(`<a[^>]+href="/owner/review/${queueId}"[^>]*>[\\s\\S]*?class="proposal-row-count">2 changes</span>`));
    const detail = await handler(request(`/owner/review/${queueId}`, cookie));
    expect(detail.status).toBe(200);
    const html = await detail.text();
    expect(html).toContain('Line 5, column 9');
    expect(html).toContain('Change 2');
    // One whole-set decision: the panel lists both changes and the note sheet covers both.
    expect(html).toContain('See all 2 changes');
    expect(html).toContain('data-change-count="2"');
    expect(html).toContain('Tail');
    const before = await gitState(item.checkout);
    await decide();
    expect(await gitState(item.checkout)).toEqual(before);
    expect(await listProposalApplicationEvents(runtime.context)).toEqual([]);
    const result = await apply();
    expect(result.applied).toBe(true);
    const completed = await runtime.completions.get('OA-v2-atomic');
    expect(completed.failure).toBeNull();
    expect(completed.state).toBe('completed');
    expect(await readFile(path.join(item.checkout, sourcePath))).toEqual(expected);
    // Explicit interval proof independent of the implementation's returned flag.
    const [first, second] = proposal.changeSet.files[0].operations;
    expect(expected.subarray(0, first.start)).toEqual(base.subarray(0, first.start));
    const firstShift = Buffer.byteLength(first.replacement) - (first.end - first.start);
    const secondShift = Buffer.byteLength(second.replacement) - (second.end - second.start);
    expect(expected.subarray(first.end + firstShift, second.start + firstShift)).toEqual(base.subarray(first.end, second.start));
    expect(expected.subarray(second.end + firstShift + secondShift)).toEqual(base.subarray(second.end));
    expect(await git(item.checkout, ['rev-parse', 'HEAD^'])).toBe(before.head);
    expect(await git(item.checkout, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'])).toBe(sourcePath);
    const after = await gitState(item.checkout);
    const paths = pipelineArtifactPaths('OA-v2-atomic');
    const checks = await readJsonArtifact(runtime.context, paths.preApplyChecks);
    expect(checks.result.immediate.operation).toEqual({ reproducesCandidate: true, operationCount: 2, outsideBytesIdentical: true });
    const inputs = await listApprovedProposalInputs(runtime.context);
    expect(inputs).toHaveLength(1);
    expect(inputs[0].schemaVersion).toBe(2);
    expect(inputs[0].operation.proposal).toEqual(proposal);
    expect((await apply()).applied).toBe(false);
    expect(await listProposalApplicationEvents(runtime.context)).toHaveLength(1);

    // Rehydrate the exact pre-commit crash boundary in a fresh private store.
    // HEAD already contains the same one commit: recovery must reconcile, not recommit.
    const recoveryContext = defineStoreContext({ projectRoot: runtime.ownerProject,
      workspaceRoot: runtime.context.workspaceRoot, storeRoot: path.join(runtime.context.workspaceRoot, 'recovery-store') });
    await prepareStore(recoveryContext);
    await initializeDurableJob(recoveryContext, { jobId: 'OA-v2-atomic', policyRevision: computePolicyRevision(runtime.config) });
    for (const state of ['preflighting', 'checking', 'rendering', 'ready-to-apply', 'applying', 'source-applied']) {
      await transitionDurableJob(recoveryContext, 'OA-v2-atomic', state, { reason: 'interrupted-v2-fixture' });
    }
    for (const name of ['session', 'operation', 'preApplyChecks', 'sourceApplied']) {
      await createJsonArtifactOnce(recoveryContext, paths[name], await readJsonArtifact(runtime.context, paths[name]));
    }
    const recovered = createSaveHandler({ config: runtime.config, context: recoveryContext, projectRoot: runtime.ownerProject,
      dependencies: { ...runtime.dependencies, applyAcceptedOperation: async () => { throw new Error('must not replay source application'); },
        commitAppliedCandidate: async () => { throw new Error('must not create another commit'); } } });
    expect((await recovered.resumeJob({ jobId: 'OA-v2-atomic' })).state).toBe('completed');
    expect(await gitState(item.checkout)).toEqual(after);
  }, 60_000);

  // A fresh vault has no .cyberbaser/trust.yml. Every change then classifies
  // as full-review, which the owner's own approval satisfies: the owner read
  // the whole proposal and approved it. Nothing writes a trust file.
  test('an owner-approved proposal applies in a vault with no trust file, and is recorded as owner-reviewed', async () => {
    const { item, runtime, decide, apply, queueId } = await fixture({ trustFile: false });
    await decide();
    const result = await apply();
    expect(result.applied).toBe(true);
    const completed = await runtime.completions.get('OA-v2-atomic');
    expect(completed.failure).toBeNull();
    expect(completed.state).toBe('completed');
    const checks = await readJsonArtifact(runtime.context, pipelineArtifactPaths('OA-v2-atomic').preApplyChecks);
    expect(checks.result.immediate.trust.route).toBe('full-review');
    expect(checks.result.immediate.trust.reasons).toEqual(['no-trust-config']);
    expect(checks.result.immediate.trustRequirement).toMatchObject({ route: 'full-review',
      satisfiedBy: { type: 'approved-proposal', queueId } });
    expect(await git(item.checkout, ['ls-files', '.cyberbaser'])).toBe('');
  });

  test('v2 policy eligibility counts the complete set, not each independently acceptable change', async () => {
    const { runtime, queueId, decide } = await fixture();
    await decide();
    const { input } = await prepareApprovedProposalInput({ context: runtime.context, config: runtime.config, queueId, git: runtime.policyGit });
    const config = { ...runtime.config, limits: { ...runtime.config.limits, maxReplacementBytes: 5, maxChangedBytes: 5 } };
    expect(deriveProposalApplication({ config, input, baseBytes: base, branchTip: input.source.branchTip, slug: 'docs/multi' }))
      .toMatchObject({ applicable: false, reason: 'replacement-limit' });
  }, 30_000);

  test('v2 recovery at ready-to-apply rejects a different complete proposal even when it reproduces valid bytes', async () => {
    const { item, runtime, proposal, decide, apply } = await fixture();
    await decide();
    let captured;
    await apply({ saveEdit: async (input) => { captured = input; return { jobId: input.jobId, state: 'accepted' }; } });
    const { jobId, session } = captured;
    const substituted = createChangeSetProposal(base, { proposalId: proposal.proposalId,
      source: { repository: proposal.changeSet.repository, revision: proposal.changeSet.baseRevision, path: sourcePath },
      submission: proposal.submission, operations: proposal.changeSet.files[0].operations.map((op, index) => index === 1 ? { ...op, replacement: 'bad' } : op) });
    const operation = { ...captured.operation, ...changeSetCorrection(substituted) };
    const paths = pipelineArtifactPaths(jobId);
    await initializeDurableJob(runtime.context, { jobId, policyRevision: computePolicyRevision(runtime.config) });
    for (const state of ['preflighting', 'checking', 'rendering', 'ready-to-apply']) await transitionDurableJob(runtime.context, jobId, state, { reason: 'v2-ready-recovery-fixture' });
    await createJsonArtifactOnce(runtime.context, paths.session, session);
    await createJsonArtifactOnce(runtime.context, paths.operation, operation);
    await createJsonArtifactOnce(runtime.context, paths.preApplyChecks, { schemaVersion: 1, artifactType: 'owner-alpha-pre-apply-check-result', jobId, result: { ok: true } });
    const before = await gitState(item.checkout);
    const result = await runtime.handler.resumeJob({ jobId });
    expect(result.failure.code).toBe('application-authority-mismatch');
    expect(await gitState(item.checkout)).toEqual(before);
    expect(await readFile(path.join(item.checkout, sourcePath))).toEqual(base);
  }, 30_000);

  test('v2 changed trust policy refuses application with the source bytes still identical', async () => {
    const { item, runtime, decide, apply } = await fixture();
    await decide();
    await writeFile(path.join(item.checkout, '.cyberbaser/trust.yml'), 'trusted: [owner, another-owner]\nagents: []\n');
    await git(item.checkout, ['add', '--all']);
    await git(item.checkout, ['commit', '-q', '-m', 'Owner changed policy']);
    await git(item.checkout, ['push', '-q', 'origin', 'main']);
    expect(await apply()).toMatchObject({ applied: false, status: { state: 'stale', reason: 'trust-policy-changed' } });
    expect(await listProposalApplicationEvents(runtime.context)).toEqual([]);
    expect(await readFile(path.join(item.checkout, sourcePath))).toEqual(base);
  }, 30_000);

  test('v2 stale source refuses the complete set without an application event or job', async () => {
    const { item, runtime, queueId, decide, apply } = await fixture();
    await decide();
    await writeFile(path.join(item.checkout, sourcePath), `${text}Owner changed the page.\n`);
    await git(item.checkout, ['add', '--all']);
    await git(item.checkout, ['commit', '-q', '-m', 'Owner moved source']);
    await git(item.checkout, ['push', '-q', 'origin', 'main']);
    const before = await gitState(item.checkout);
    const result = await apply();
    expect(result).toMatchObject({ applied: false, status: { state: 'stale', reason: 'source-changed' } });
    expect(await listProposalApplicationEvents(runtime.context)).toEqual([]);
    expect(runtime.completions.size).toBe(0);
    expect(await gitState(item.checkout)).toEqual(before);
    expect((await assessProposalApplication({ context: runtime.context, config: runtime.config, queueId, git: runtime.policyGit, resolveSlug })).state).toBe('stale');
  }, 30_000);

  test('v2 interrupted applying without durable effect evidence never replays automatically', async () => {
    const { item, runtime, decide, apply } = await fixture();
    await decide();
    let captured;
    await apply({ saveEdit: async (input) => { captured = input; return { jobId: input.jobId, state: 'accepted' }; } });
    const { jobId, session, operation } = captured;
    const paths = pipelineArtifactPaths(jobId);
    await initializeDurableJob(runtime.context, { jobId, policyRevision: computePolicyRevision(runtime.config) });
    for (const state of ['preflighting', 'checking', 'rendering', 'ready-to-apply', 'applying']) {
      await transitionDurableJob(runtime.context, jobId, state, { reason: 'interrupted-v2-fixture' });
    }
    await createJsonArtifactOnce(runtime.context, paths.session, session);
    await createJsonArtifactOnce(runtime.context, paths.operation, operation);
    const before = await gitState(item.checkout);
    const result = await runtime.handler.resumeJob({ jobId });
    expect(result.failure.code).toBe('interrupted-application-ambiguous');
    expect(await gitState(item.checkout)).toEqual(before);
    expect(await readFile(path.join(item.checkout, sourcePath))).toEqual(base);
    expect(await listProposalApplicationEvents(runtime.context)).toHaveLength(1);
  }, 30_000);
}

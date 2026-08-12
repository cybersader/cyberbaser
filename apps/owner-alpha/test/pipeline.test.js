import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  OwnerAlphaError,
  PIPELINE_MUTATION_LOCK,
  createJsonArtifactOnce,
  computePolicyRevision,
  createSaveHandler,
  defineStoreContext,
  initializeDurableJob,
  loadDurableJob,
  pipelineArtifactPaths,
  readJsonArtifact,
  runOwnerAlphaPipeline,
  transitionDurableJob,
  validateOwnerAlphaConfig,
} from '../src/index.js';

const APP_ROOT = path.resolve(import.meta.dir, '..');
const EXAMPLE = path.join(APP_ROOT, 'owner-alpha.example.json');
const POLICY_REVISION = `sha256:${'a'.repeat(64)}`;
const BASE_COMMIT = '1'.repeat(40);
const COMMIT = '2'.repeat(40);
const cleanup = [];

function digest(bytes) {
  return `sha-256=:${createHash('sha256').update(bytes).digest('base64')}:`;
}

async function command(args, cwd) {
  const child = Bun.spawn(args, { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`${args.join(' ')} failed: ${stderr || stdout}`);
}

async function fixture({ provider = 'github-actions' } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'owner-alpha-pipeline-'));
  cleanup.push(root);
  await command(['git', 'init', '-q'], root);
  await writeFile(path.join(root, '.gitignore'), '.workspace/\n', 'utf8');
  const raw = JSON.parse(await readFile(EXAMPLE, 'utf8'));
  raw.repository.checkout = root;
  if (provider === 'forgejo-actions') {
    raw.repository.remote.url = 'https://forgejo.example/owner/repository.git';
    raw.owner.identity = 'owner';
    raw.live.baseUrl = 'https://published.example/site/';
    raw.workflow = {
      provider: 'forgejo-actions',
      apiBaseUrl: 'https://forgejo.example/api/v1',
      repository: 'owner/repository',
      path: '.forgejo/workflows/publish-site.yml',
      event: 'push',
      branch: 'main',
      jobs: ['build', 'deploy'],
      deploymentJob: 'deploy',
    };
  }
  const config = validateOwnerAlphaConfig(raw);
  const context = defineStoreContext({
    projectRoot: root,
    workspaceRoot: path.join(root, config.workspace.root),
    storeRoot: path.join(root, config.workspace.store),
  });
  return { root, config, context };
}

function acceptedInput() {
  const baseBytes = Buffer.from('# Page\n\nThe old value.\n');
  const candidateBytes = Buffer.from('# Page\n\nThe new value.\n');
  const oldBytes = Buffer.from('old');
  const newBytes = Buffer.from('new');
  const start = baseBytes.indexOf(oldBytes);
  const session = Object.freeze({
    schemaVersion: 1,
    artifactType: 'owner-alpha-edit-session',
    relativePath: 'docs/page.md',
    slug: 'docs/page',
    liveUrl: 'https://cybersader.github.io/cyberbase/docs/page',
    baseCommit: BASE_COMMIT,
    policyRevision: POLICY_REVISION,
    source: Object.freeze({
      text: baseBytes.toString('utf8'),
      bytesBase64: baseBytes.toString('base64'),
      byteLength: baseBytes.length,
      digest: digest(baseBytes),
      gitMode: '100644',
      gitObjectId: '3'.repeat(40),
      frontmatter: null,
    }),
  });
  const correction = Object.freeze({
    operationType: 'offset',
    baseByteLength: baseBytes.length,
    baseDigest: digest(baseBytes),
    start,
    end: start + oldBytes.length,
    expectedOldBytes: oldBytes,
    replacementBytes: newBytes,
    candidateByteLength: candidateBytes.length,
    candidateDigest: digest(candidateBytes),
  });
  const operation = Object.freeze({
    schemaVersion: 1,
    artifactType: 'owner-alpha-source-operation',
    source: Object.freeze({
      relativePath: session.relativePath,
      slug: session.slug,
      liveUrl: session.liveUrl,
      baseCommit: session.baseCommit,
      policyRevision: session.policyRevision,
    }),
    operationType: 'offset',
    baseByteLength: correction.baseByteLength,
    baseDigest: correction.baseDigest,
    start: correction.start,
    end: correction.end,
    expectedOldBytesBase64: oldBytes.toString('base64'),
    replacementBytesBase64: newBytes.toString('base64'),
    candidateByteLength: correction.candidateByteLength,
    candidateDigest: correction.candidateDigest,
    changedBytes: 3,
    changedLines: 1,
    frontmatter: null,
    outsideBytesUnchanged: true,
  });
  return { session, operation, baseBytes, candidateBytes, correction };
}

function fixtureDependencies(input, calls = {}) {
  const count = (name) => { calls[name] = (calls[name] ?? 0) + 1; };
  return {
    now: () => '2026-07-31T12:00:00.000Z',
    assertCheckoutReady: async () => ({ head: BASE_COMMIT }),
    applyEditorOperation: () => Buffer.from(input.candidateBytes),
    runPreApplyChecks: async () => {
      count('checks');
      return {
        ok: true,
        rendered: { witnesses: { old: 'The old value.', new: 'The new value.' } },
      };
    },
    applyAcceptedOperation: async ({ checkout, lock }) => {
      count('apply');
      expect(lock.file.endsWith(PIPELINE_MUTATION_LOCK)).toBe(true);
      return {
        status: 'source-applied',
        recovery: 'reconcile-then-commit',
        checkout,
        baseCommit: BASE_COMMIT,
        sourcePath: input.session.relativePath,
        sourceMode: '100644',
        baseBlob: '3'.repeat(40),
        baseDigest: input.correction.baseDigest,
        candidateDigest: input.correction.candidateDigest,
        candidateByteLength: input.candidateBytes.length,
        candidateBytes: Buffer.from(input.candidateBytes),
        correction: { ...input.correction },
        exactSplice: {
          start: input.correction.start,
          end: input.correction.end,
          oldByteLength: 3,
          replacementByteLength: 3,
        },
      };
    },
    getHead: async () => BASE_COMMIT,
    commitAppliedCandidate: async () => {
      count('commit');
      return {
        status: 'committed',
        recovery: 'resume-push',
        commit: COMMIT,
        message: 'owner-alpha: docs/page.md',
        hooksUsed: true,
        verification: { status: 'commit-verified', commit: COMMIT },
        commandReportedFailure: false,
      };
    },
    pushExactCommit: async () => {
      count('push');
      return {
        status: 'pushed',
        recovery: 'resume-run-discovery',
        commit: COMMIT,
        remote: 'origin',
        branch: 'main',
        remoteRef: COMMIT,
        pushPerformed: true,
      };
    },
    discoverDeploymentRun: async () => {
      count('discover');
      return { binding: { provider: 'github-actions', runId: '42', headSha: COMMIT, runAttempt: 1 } };
    },
    monitorDeploymentRun: async () => {
      count('monitor');
      return { provider: 'github-actions', run: { runId: '42', headSha: COMMIT }, environment: { state: 'success' } };
    },
    confirmLivePage: async () => {
      count('live');
      return { pageUrl: input.session.liveUrl, oldWitnessAbsent: true, newWitnessUnique: true };
    },
    rebuildLocal: async () => {
      count('rebuild');
      return { status: 'local-rebuilt', commit: COMMIT };
    },
  };
}

function hasBuffer(value) {
  if (Buffer.isBuffer(value)) return true;
  if (Array.isArray(value)) return value.some(hasBuffer);
  if (value && typeof value === 'object') return Object.values(value).some(hasBuffer);
  return false;
}

async function expectCodeAsync(action, code) {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(OwnerAlphaError);
    expect(error.code).toBe(code);
    return;
  }
  throw new Error(`expected OwnerAlphaError(${code})`);
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((target) => rm(target, { recursive: true, force: true })));
});

describe('owner-alpha integration pipeline', () => {
  test('runs the accepted Save through exact effects and persists JSON-safe evidence', async () => {
    const data = await fixture();
    const input = acceptedInput();
    const policyRevision = computePolicyRevision(data.config);
    const session = Object.freeze({ ...input.session, policyRevision });
    const operation = Object.freeze({
      ...input.operation,
      source: Object.freeze({ ...input.operation.source, policyRevision }),
    });
    const bound = { ...input, session, operation };
    const calls = {};
    const result = await runOwnerAlphaPipeline({
      config: data.config,
      context: data.context,
      jobId: 'OA-HAPPY',
      session,
      operation,
    }, fixtureDependencies(bound, calls));

    expect(result.state).toBe('completed');
    const durable = await loadDurableJob(data.context, 'OA-HAPPY');
    expect(durable.history.map((entry) => entry.to)).toEqual([
      'accepted',
      'preflighting',
      'checking',
      'rendering',
      'ready-to-apply',
      'applying',
      'source-applied',
      'committing',
      'committed',
      'pushing',
      'pushed',
      'discovering-run',
      'run-bound',
      'monitoring-deployment',
      'deployment-succeeded',
      'verifying-live',
      'live-confirmed',
      'rebuilding-local',
      'completed',
    ]);
    expect(calls).toEqual({
      checks: 1,
      apply: 1,
      commit: 1,
      push: 1,
      discover: 1,
      monitor: 1,
      live: 1,
      rebuild: 1,
    });

    const paths = pipelineArtifactPaths('OA-HAPPY');
    for (const artifactPath of [
      paths.session,
      paths.operation,
      paths.preApplyChecks,
      paths.sourceApplied,
      paths.committed,
      paths.pushed,
      paths.runBound,
      paths.deployment,
      paths.live,
      paths.localRebuild,
    ]) {
      const artifact = await readJsonArtifact(data.context, artifactPath);
      expect(hasBuffer(artifact)).toBe(false);
      expect(JSON.stringify(artifact)).not.toContain('apiToken');
    }
    const applied = await readJsonArtifact(data.context, paths.sourceApplied);
    expect(applied.result.candidateBytesBase64).toBe(bound.candidateBytes.toString('base64'));
    expect(applied.result).not.toHaveProperty('candidateBytes');
  });

  test('blocks a checkout or remote advance immediately before source application', async () => {
    const data = await fixture();
    const input = acceptedInput();
    const policyRevision = computePolicyRevision(data.config);
    const session = Object.freeze({ ...input.session, policyRevision });
    const operation = Object.freeze({
      ...input.operation,
      source: Object.freeze({ ...input.operation.source, policyRevision }),
    });
    const bound = { ...input, session, operation };
    const sourcePath = path.join(data.root, ...session.relativePath.split('/'));
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, input.baseBytes);

    const calls = {};
    const dependencies = fixtureDependencies(bound, calls);
    dependencies.assertCheckoutReady = async () => ({ head: '4'.repeat(40) });
    const result = await runOwnerAlphaPipeline({
      config: data.config,
      context: data.context,
      jobId: 'OA-PRE-APPLY-ADVANCE',
      session,
      operation,
    }, dependencies);

    expect(result.state).toBe('blocked-pre-apply');
    expect(result.failure.code).toBe('pre-apply-checkout-advanced');
    expect(await readFile(sourcePath)).toEqual(input.baseBytes);
    expect(calls).toEqual({ checks: 1 });
    await expectCodeAsync(
      () => readJsonArtifact(
        data.context,
        pipelineArtifactPaths('OA-PRE-APPLY-ADVANCE').sourceApplied,
      ),
      'artifact-not-found',
    );
  });

  test('classifies pre-apply, effectful, deployment, and live failures exactly', async () => {
    const cases = [
      ['preapply', 'runPreApplyChecks', 'blocked-pre-apply'],
      ['apply', 'applyAcceptedOperation', 'manual-intervention'],
      ['deployment', 'monitorDeploymentRun', 'deployment-failed'],
      ['live', 'confirmLivePage', 'live-verification-failed'],
    ];
    for (const [suffix, dependency, expectedState] of cases) {
      const data = await fixture();
      const input = acceptedInput();
      const policyRevision = computePolicyRevision(data.config);
      const session = Object.freeze({ ...input.session, policyRevision });
      const operation = Object.freeze({ ...input.operation, source: Object.freeze({ ...input.operation.source, policyRevision }) });
      const bound = { ...input, session, operation };
      const dependencies = fixtureDependencies(bound);
      dependencies[dependency] = async () => { throw new OwnerAlphaError(`${suffix}-failed`, `${suffix} failed`); };
      const result = await runOwnerAlphaPipeline({
        config: data.config,
        context: data.context,
        jobId: `OA-${suffix}`,
        session,
        operation,
      }, dependencies);
      expect(result.state).toBe(expectedState);
      expect(result.failure.code).toBe(`${suffix}-failed`);
      expect(result.failure.retryable).toBe(expectedState === 'live-verification-failed');
    }
  });

  test('resumes a persisted Forgejo run/job binding without rediscovery or replaying mutation effects', async () => {
    const data = await fixture({ provider: 'forgejo-actions' });
    const input = acceptedInput();
    const policyRevision = computePolicyRevision(data.config);
    const session = Object.freeze({ ...input.session, policyRevision });
    const operation = Object.freeze({ ...input.operation, source: Object.freeze({ ...input.operation.source, policyRevision }) });
    const jobId = 'OA-RESUME';
    const paths = pipelineArtifactPaths(jobId);
    await initializeDurableJob(data.context, { jobId, policyRevision, at: '2026-07-31T12:00:00.000Z' });
    for (const state of [
      'preflighting', 'checking', 'rendering', 'ready-to-apply', 'applying', 'source-applied',
      'committing', 'committed', 'pushing', 'pushed', 'discovering-run', 'run-bound',
      'monitoring-deployment',
    ]) {
      await transitionDurableJob(data.context, jobId, state, {
        at: '2026-07-31T12:00:00.000Z',
        reason: `seed-${state}`,
      });
    }
    await createJsonArtifactOnce(data.context, paths.session, session);
    await createJsonArtifactOnce(data.context, paths.operation, operation);
    const record = (artifactType, result) => ({ schemaVersion: 1, artifactType, jobId, result });
    await createJsonArtifactOnce(data.context, paths.preApplyChecks, record(
      'owner-alpha-pre-apply-check-result',
      { ok: true, rendered: { witnesses: { old: 'The old value.', new: 'The new value.' } } },
    ));
    await createJsonArtifactOnce(data.context, paths.sourceApplied, record('owner-alpha-source-applied-effect', {
      status: 'source-applied',
      recovery: 'reconcile-then-commit',
      checkout: data.root,
      baseCommit: BASE_COMMIT,
      sourcePath: session.relativePath,
      sourceMode: '100644',
      baseBlob: '3'.repeat(40),
      baseDigest: input.correction.baseDigest,
      candidateDigest: input.correction.candidateDigest,
      candidateByteLength: input.candidateBytes.length,
      candidateBytesBase64: input.candidateBytes.toString('base64'),
      correction: {
        operationType: 'offset',
        baseByteLength: input.correction.baseByteLength,
        baseDigest: input.correction.baseDigest,
        start: input.correction.start,
        end: input.correction.end,
        expectedOldBytesBase64: input.correction.expectedOldBytes.toString('base64'),
        replacementBytesBase64: input.correction.replacementBytes.toString('base64'),
        candidateByteLength: input.correction.candidateByteLength,
        candidateDigest: input.correction.candidateDigest,
      },
      exactSplice: { start: input.correction.start, end: input.correction.end, oldByteLength: 3, replacementByteLength: 3 },
    }));
    await createJsonArtifactOnce(data.context, paths.committed, record('owner-alpha-committed-effect', {
      status: 'committed', commit: COMMIT,
    }));
    await createJsonArtifactOnce(data.context, paths.pushed, record('owner-alpha-pushed-effect', {
      status: 'pushed', commit: COMMIT, remoteRef: COMMIT,
    }));
    const forgejoBinding = {
      provider: 'forgejo-actions',
      apiBaseUrl: 'https://forgejo.example/api/v1',
      instanceVersion: '16.0.2',
      repository: 'owner/repository',
      repositoryId: '123',
      runId: '456',
      runNumber: 17,
      workflowId: 'publish-site.yml',
      configuredWorkflowPath: '.forgejo/workflows/publish-site.yml',
      event: 'push',
      triggerEvent: 'push',
      ref: 'refs/heads/main',
      headSha: COMMIT,
      htmlUrl: 'https://forgejo.example/owner/repository/actions/runs/17',
      jobs: [
        { id: '701', name: 'build', attempt: 1, handle: 'build-handle', needs: [] },
        { id: '702', name: 'deploy', attempt: 1, handle: 'deploy-handle', needs: ['build'] },
      ],
    };
    await createJsonArtifactOnce(data.context, paths.runBound, record('owner-alpha-run-bound-effect', {
      binding: forgejoBinding,
    }));

    const calls = {};
    const dependencies = fixtureDependencies({ ...input, session, operation }, calls);
    dependencies.monitorDeploymentRun = async ({ applicationSha, boundRun }) => {
      calls.monitor = (calls.monitor ?? 0) + 1;
      expect(applicationSha).toBe(COMMIT);
      expect(boundRun).toEqual(forgejoBinding);
      return {
        provider: 'forgejo-actions',
        run: { id: '456', headSha: COMMIT, status: 'success' },
        publication: { state: 'success', destinationSource: 'owner-policy' },
      };
    };
    const result = await runOwnerAlphaPipeline({
      config: data.config,
      context: data.context,
      jobId,
    }, dependencies);
    expect(result.state).toBe('completed');
    expect(calls.apply).toBeUndefined();
    expect(calls.commit).toBeUndefined();
    expect(calls.push).toBeUndefined();
    expect(calls.discover).toBeUndefined();
    expect(calls).toEqual({ monitor: 1, live: 1, rebuild: 1 });
  });

  test('never replays an interrupted application without durable source-applied evidence', async () => {
    const data = await fixture();
    const input = acceptedInput();
    const policyRevision = computePolicyRevision(data.config);
    const jobId = 'OA-AMBIGUOUS-APPLY';
    await initializeDurableJob(data.context, { jobId, policyRevision, at: '2026-07-31T12:00:00.000Z' });
    for (const state of ['preflighting', 'checking', 'rendering', 'ready-to-apply', 'applying']) {
      await transitionDurableJob(data.context, jobId, state, {
        at: '2026-07-31T12:00:00.000Z',
        reason: `seed-${state}`,
      });
    }
    const calls = {};
    const result = await runOwnerAlphaPipeline({
      config: data.config,
      context: data.context,
      jobId,
    }, fixtureDependencies(input, calls));
    expect(result.state).toBe('manual-intervention');
    expect(result.failure.code).toBe('interrupted-application-ambiguous');
    expect(calls.apply).toBeUndefined();
  });

  test('holds one store-wide job lock and exposes the narrow Save handler adapter', async () => {
    const data = await fixture();
    const input = acceptedInput();
    const policyRevision = computePolicyRevision(data.config);
    const session = Object.freeze({ ...input.session, policyRevision });
    const operation = Object.freeze({ ...input.operation, source: Object.freeze({ ...input.operation.source, policyRevision }) });
    let releaseChecks;
    let checksStarted;
    const started = new Promise((resolve) => { checksStarted = resolve; });
    const gate = new Promise((resolve) => { releaseChecks = resolve; });
    const dependencies = fixtureDependencies({ ...input, session, operation });
    dependencies.runPreApplyChecks = async () => {
      checksStarted();
      await gate;
      return { ok: true, rendered: { witnesses: { old: 'The old value.', new: 'The new value.' } } };
    };
    const handler = createSaveHandler({
      config: data.config,
      projectRoot: data.root,
      context: data.context,
      dependencies,
    });
    const first = handler.startEdit({ jobId: 'OA-LOCK-1', session, operation });
    const accepted = await first.accepted;
    expect(accepted.state).toBe('accepted');
    const paths = pipelineArtifactPaths('OA-LOCK-1');
    expect(await readJsonArtifact(data.context, paths.session)).toEqual(session);
    expect(await readJsonArtifact(data.context, paths.operation)).toEqual(operation);

    await started;
    await expectCodeAsync(
      () => handler.saveEdit({ jobId: 'OA-LOCK-2', session, operation }),
      'lock-busy',
    );
    releaseChecks();
    expect((await first.completion).state).toBe('completed');
    expect((await handler.getJob('OA-LOCK-1')).state).toBe('completed');
  });
});

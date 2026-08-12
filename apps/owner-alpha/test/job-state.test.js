import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  JOB_STATES,
  LEGAL_JOB_TRANSITIONS,
  OwnerAlphaError,
  RECOVERY_CLASSIFICATIONS,
  acquireFileLock,
  createJobState,
  defineStoreContext,
  initializeDurableJob,
  jobArtifactPaths,
  listDurableJobs,
  loadDurableJob,
  recoveryForState,
  transitionDurableJob,
  transitionJobState,
  validateJobState,
} from '../src/index.js';

const POLICY_REVISION = `sha256:${'a'.repeat(64)}`;
const cleanup = [];

const SUCCESS_PATH = [
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
];

function stamp(index) {
  return new Date(Date.UTC(2026, 6, 31, 12, 0, index)).toISOString();
}

function walkTo(target, jobId = 'OA-WALK') {
  let state = createJobState({ jobId, policyRevision: POLICY_REVISION, at: stamp(0) });
  if (target === 'accepted') return state;
  const targetIndex = SUCCESS_PATH.indexOf(target);
  if (targetIndex === -1) throw new Error(`cannot walk successful path to ${target}`);
  SUCCESS_PATH.slice(0, targetIndex + 1).forEach((next, index) => {
    state = transitionJobState(state, next, {
      at: stamp(index + 1),
      reason: `enter-${next}`,
    });
  });
  return state;
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

async function fixture() {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'owner-alpha-jobs-'));
  cleanup.push(projectRoot);
  await command(['git', 'init', '-q'], projectRoot);
  await writeFile(path.join(projectRoot, '.gitignore'), '.private/\n', 'utf8');
  const workspaceRoot = path.join(projectRoot, '.private', 'owner-alpha');
  const storeRoot = path.join(workspaceRoot, 'store');
  return defineStoreContext({ projectRoot, workspaceRoot, storeRoot });
}

function expectCode(action, code) {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(OwnerAlphaError);
    expect(error.code).toBe(code);
    return error;
  }
  throw new Error(`expected OwnerAlphaError(${code})`);
}

async function expectCodeAsync(action, code) {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(OwnerAlphaError);
    expect(error.code).toBe(code);
    return error;
  }
  throw new Error(`expected OwnerAlphaError(${code})`);
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((target) => rm(target, { recursive: true, force: true })));
});

describe('one-Save job state machine', () => {
  test('publishes the complete durable pipeline and exceptional states', () => {
    expect(JOB_STATES).toEqual([
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
      'blocked-pre-apply',
      'deployment-failed',
      'live-verification-failed',
      'manual-intervention',
      'cancelled',
      'failed',
    ]);
    expect(LEGAL_JOB_TRANSITIONS['live-verification-failed']).toEqual(['verifying-live']);
    for (const terminal of [
      'completed',
      'blocked-pre-apply',
      'deployment-failed',
      'manual-intervention',
      'cancelled',
      'failed',
    ]) {
      expect(LEGAL_JOB_TRANSITIONS[terminal]).toEqual([]);
    }
  });

  test('starts at accepted because Save is the authority event', () => {
    const state = createJobState({ jobId: 'OA-000', policyRevision: POLICY_REVISION, at: stamp(0) });
    expect(state.state).toBe('accepted');
    expect(state.revision).toBe(0);
    expect(state.history).toEqual([{
      revision: 0,
      from: null,
      to: 'accepted',
      at: stamp(0),
      reason: 'save-accepted',
    }]);
  });

  test('walks the full successful path with contiguous durable history', () => {
    const state = walkTo('completed', 'OA-001');
    expect(state.state).toBe('completed');
    expect(state.revision).toBe(SUCCESS_PATH.length);
    expect(state.history).toHaveLength(SUCCESS_PATH.length + 1);
    expect(state.history.map((event) => event.to)).toEqual(['accepted', ...SUCCESS_PATH]);
    expect(state.recovery.classification).toBe('terminal');
    expect(Object.isFrozen(state.history)).toBe(true);
    expect(validateJobState(structuredClone(state))).toEqual(state);
  });

  test('allows cancellation only before ready-to-apply', () => {
    for (const [index, phase] of ['accepted', 'preflighting', 'checking', 'rendering'].entries()) {
      const state = walkTo(phase, `OA-CANCEL-${index}`);
      const cancelled = transitionJobState(state, 'cancelled', {
        at: stamp(index + 20),
        reason: 'save-cancelled-before-boundary',
      });
      expect(cancelled.state).toBe('cancelled');
      expect(cancelled.failure).toBeNull();
    }
    const ready = walkTo('ready-to-apply', 'OA-CANCEL-READY');
    expectCode(
      () => transitionJobState(ready, 'cancelled', { at: stamp(20), reason: 'too-late' }),
      'illegal-job-transition',
    );
  });

  test('rejects skipped, backward, repeated, and terminal transitions', () => {
    const accepted = walkTo('accepted', 'OA-002');
    expectCode(
      () => transitionJobState(accepted, 'ready-to-apply', { at: stamp(1), reason: 'skip' }),
      'illegal-job-transition',
    );
    const preflighting = transitionJobState(accepted, 'preflighting', {
      at: stamp(1),
      reason: 'preflight',
    });
    expectCode(
      () => transitionJobState(preflighting, 'preflighting', { at: stamp(2), reason: 'repeat' }),
      'illegal-job-transition',
    );
    expectCode(
      () => transitionJobState(preflighting, 'accepted', { at: stamp(2), reason: 'backward' }),
      'illegal-job-transition',
    );
    const cancelled = transitionJobState(preflighting, 'cancelled', {
      at: stamp(2),
      reason: 'cancel-before-boundary',
    });
    expectCode(
      () => transitionJobState(cancelled, 'preflighting', { at: stamp(3), reason: 'revive' }),
      'illegal-job-transition',
    );
  });

  test('blocks before application with source untouched and immutable evidence', () => {
    const checking = walkTo('checking', 'OA-003');
    const blocked = transitionJobState(checking, 'blocked-pre-apply', {
      at: stamp(10),
      reason: 'exact-binding-missing',
      failure: { code: 'binding-missing', message: 'exact source binding was not found', retryable: false },
    });
    expect(blocked.failure).toEqual({
      fromState: 'checking',
      code: 'binding-missing',
      message: 'exact source binding was not found',
      retryable: false,
    });
    expect(blocked.recovery.classification).toBe('terminal-source-untouched');
    expect(blocked.recovery.instruction).toContain('source remains untouched');
    expectCode(
      () => transitionJobState(blocked, 'preflighting', { at: stamp(11), reason: 'revive' }),
      'illegal-job-transition',
    );
  });

  test('routes an uncertain source mutation to immutable manual intervention', () => {
    const applying = walkTo('applying', 'OA-004');
    const manual = transitionJobState(applying, 'manual-intervention', {
      at: stamp(10),
      reason: 'application-outcome-unknown',
      failure: { code: 'apply-interrupted', message: 'application outcome is unknown', retryable: false },
    });
    expect(manual.failure.fromState).toBe('applying');
    expect(manual.recovery).toEqual({
      classification: 'manual-intervention',
      automatic: false,
      instruction: 'Keep mutation disabled until the recorded ambiguity is reconciled outside this job.',
    });
    expect(validateJobState(structuredClone(manual))).toEqual(manual);
    expectCode(
      () => transitionJobState(manual, 'source-applied', { at: stamp(11), reason: 'unsafe-resume' }),
      'illegal-job-transition',
    );
  });

  test('retains a bound external deployment failure as a terminal result', () => {
    const monitoring = walkTo('monitoring-deployment', 'OA-005');
    const deploymentFailed = transitionJobState(monitoring, 'deployment-failed', {
      at: stamp(20),
      reason: 'bound-run-failed',
      failure: { code: 'run-failed', message: 'stored deployment run concluded with failure', retryable: true },
    });
    expect(deploymentFailed.failure).toEqual({
      fromState: 'monitoring-deployment',
      code: 'run-failed',
      message: 'stored deployment run concluded with failure',
      retryable: true,
    });
    expect(deploymentFailed.recovery.classification).toBe('terminal-external-failure');
    expect(deploymentFailed.recovery.automatic).toBe(false);
    expect(LEGAL_JOB_TRANSITIONS['deployment-failed']).toEqual([]);
  });

  test('allows a failed live check to retry only the read-only verification phase', () => {
    const verifying = walkTo('verifying-live', 'OA-006');
    const liveFailed = transitionJobState(verifying, 'live-verification-failed', {
      at: stamp(20),
      reason: 'live-content-mismatch',
      failure: { code: 'content-mismatch', message: 'live content does not match the commit', retryable: true },
    });
    expect(liveFailed.recovery.classification).toBe('retry-read-only');
    expect(liveFailed.recovery.automatic).toBe(true);
    expectCode(
      () => transitionJobState(liveFailed, 'live-confirmed', { at: stamp(21), reason: 'skip-recheck' }),
      'illegal-job-transition',
    );
    const retrying = transitionJobState(liveFailed, 'verifying-live', {
      at: stamp(21),
      reason: 'retry-read-only-check',
    });
    expect(retrying.failure).toBeNull();
    expect(retrying.recovery.classification).toBe('restart-read-only');
  });

  test('records a closed generic phase failure without inferring retry from metadata', () => {
    const checking = walkTo('checking', 'OA-007');
    const failed = transitionJobState(checking, 'failed', {
      at: stamp(10),
      reason: 'check-process-failed',
      failure: { code: 'check-exit', message: 'check process exited 2', retryable: true },
    });
    expect(failed.failure).toEqual({
      fromState: 'checking',
      code: 'check-exit',
      message: 'check process exited 2',
      retryable: true,
    });
    expect(failed.recovery.classification).toBe('inspect-failure');
    expect(failed.recovery.automatic).toBe(false);
    expectCode(
      () => transitionJobState(failed, 'checking', { at: stamp(11), reason: 'implicit-retry' }),
      'illegal-job-transition',
    );
  });

  test('requires explicit failure data and rejects credential-bearing failure records', () => {
    const checking = walkTo('checking', 'OA-008');
    expectCode(
      () => transitionJobState(checking, 'blocked-pre-apply', {
        at: stamp(10),
        reason: 'blocked',
      }),
      'invalid-job-state',
    );
    expectCode(
      () => transitionJobState(checking, 'failed', {
        at: stamp(10),
        reason: 'failed',
        failure: {
          code: 'remote',
          message: 'https://user:password@example.test/private',
          retryable: false,
        },
      }),
      'credentials-forbidden',
    );
  });

  test('rejects unknown keys, history tampering, recovery drift, and non-monotonic time', () => {
    const state = createJobState({ jobId: 'OA-009', policyRevision: POLICY_REVISION, at: stamp(1) });
    expectCode(() => validateJobState({ ...state, surprise: true }), 'unknown-job-key');
    expectCode(
      () => validateJobState({
        ...state,
        recovery: { ...state.recovery, classification: 'terminal' },
      }),
      'recovery-classification-mismatch',
    );
    expectCode(
      () => validateJobState({
        ...state,
        history: [{ ...state.history[0], to: 'ready-to-apply' }],
      }),
      'invalid-job-state',
    );
    expectCode(
      () => transitionJobState(state, 'preflighting', { at: stamp(0), reason: 'time-travel' }),
      'invalid-job-state',
    );
  });
});

describe('restart recovery classifications', () => {
  test('classifies every exact crash window and keeps unsafe mutation disabled', () => {
    expect(Object.keys(RECOVERY_CLASSIFICATIONS)).toEqual(JOB_STATES);
    const expected = {
      accepted: 'restart-safe',
      preflighting: 'restart-safe',
      checking: 'restart-safe',
      rendering: 'restart-safe',
      'ready-to-apply': 'restart-safe',
      applying: 'manual-intervention',
      'source-applied': 'reconcile-then-commit',
      committing: 'reconcile-commit',
      committed: 'resume-push',
      pushing: 'reconcile-push',
      pushed: 'resume-run-discovery',
      'discovering-run': 'restart-run-discovery',
      'run-bound': 'reobserve-external',
      'monitoring-deployment': 'reobserve-external',
      'deployment-succeeded': 'resume-live-verification',
      'verifying-live': 'restart-read-only',
      'live-confirmed': 'resume-local-rebuild',
      'rebuilding-local': 'restart-idempotent',
      completed: 'terminal',
      'blocked-pre-apply': 'terminal-source-untouched',
      'deployment-failed': 'terminal-external-failure',
      'live-verification-failed': 'retry-read-only',
      'manual-intervention': 'manual-intervention',
      cancelled: 'terminal-source-untouched',
      failed: 'inspect-failure',
    };
    for (const [state, classification] of Object.entries(expected)) {
      expect(recoveryForState(state).classification).toBe(classification);
    }
    expect(recoveryForState('applying').automatic).toBe(false);
    expect(recoveryForState('source-applied').automatic).toBe(true);
    expect(recoveryForState('committed').instruction).toContain('exact durable commit');
    expect(recoveryForState('pushed').instruction).toContain('exact pushed commit');
    expect(recoveryForState('run-bound').instruction).toContain('stored deployment run');
    expect(recoveryForState('monitoring-deployment').instruction).toContain('stored deployment run');
    expect(recoveryForState('verifying-live').instruction).toContain('read-only');
    expect(recoveryForState('completed').automatic).toBe(false);
    expectCode(() => recoveryForState('invented'), 'unknown-job-state');
  });
});

describe('durable job artifacts', () => {
  test('creates once, reloads, and atomically advances under the state lock', async () => {
    const context = await fixture();
    const initial = await initializeDurableJob(context, {
      jobId: 'OA-100',
      policyRevision: POLICY_REVISION,
      at: stamp(0),
    });
    expect(initial.state).toBe('accepted');
    expect(await loadDurableJob(context, 'OA-100')).toEqual(initial);
    await expectCodeAsync(
      () => initializeDurableJob(context, {
        jobId: 'OA-100',
        policyRevision: POLICY_REVISION,
        at: stamp(0),
      }),
      'artifact-already-exists',
    );

    const preflighting = await transitionDurableJob(context, 'OA-100', 'preflighting', {
      at: stamp(1),
      reason: 'preflight',
    });
    expect(preflighting.revision).toBe(1);
    expect((await loadDurableJob(context, 'OA-100')).state).toBe('preflighting');
    expect(jobArtifactPaths('OA-100')).toEqual({
      state: 'jobs/OA-100/state.json',
      lock: 'jobs/OA-100/.state.lock',
    });
  });

  test('enumerates durable jobs in stable identifier order', async () => {
    const context = await fixture();
    expect(await listDurableJobs(context)).toEqual([]);
    await initializeDurableJob(context, {
      jobId: 'OA-BETA',
      policyRevision: POLICY_REVISION,
      at: stamp(0),
    });
    await initializeDurableJob(context, {
      jobId: 'OA-ALPHA',
      policyRevision: POLICY_REVISION,
      at: stamp(0),
    });
    expect((await listDurableJobs(context)).map((job) => job.jobId))
      .toEqual(['OA-ALPHA', 'OA-BETA']);
  });

  test('fails busy while a child holds the state lock and succeeds after release', async () => {
    const context = await fixture();
    await initializeDurableJob(context, {
      jobId: 'OA-101',
      policyRevision: POLICY_REVISION,
      at: stamp(0),
    });
    const paths = jobArtifactPaths('OA-101');
    const lock = await acquireFileLock(context, paths.lock);
    await expectCodeAsync(
      () => transitionDurableJob(context, 'OA-101', 'preflighting', {
        at: stamp(1),
        reason: 'preflight',
      }),
      'lock-busy',
    );
    await lock.release();
    expect((await transitionDurableJob(context, 'OA-101', 'preflighting', {
      at: stamp(1),
      reason: 'preflight',
    })).state).toBe('preflighting');
  });

  test('serializes concurrent stale transition attempts so only one can advance', async () => {
    const context = await fixture();
    await initializeDurableJob(context, {
      jobId: 'OA-102',
      policyRevision: POLICY_REVISION,
      at: stamp(0),
    });
    const outcomes = await Promise.allSettled(
      Array.from({ length: 12 }, () => transitionDurableJob(context, 'OA-102', 'preflighting', {
        at: stamp(1),
        reason: 'preflight',
      })),
    );
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status !== 'fulfilled').every(
      (outcome) => ['lock-busy', 'illegal-job-transition'].includes(outcome.reason.code),
    )).toBe(true);
    const final = await loadDurableJob(context, 'OA-102');
    expect(final.state).toBe('preflighting');
    expect(final.revision).toBe(1);
    expect(final.history).toHaveLength(2);
  });
});

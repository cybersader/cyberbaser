import { lstat, readdir } from 'node:fs/promises';
import { fail, OwnerAlphaError } from './errors.js';
import { assertNoCredentialMaterial, deepFreeze, isPlainObject } from './json.js';
import {
  createJsonArtifactOnce,
  readJsonArtifact,
  replaceJsonArtifactAtomic,
} from './artifacts.js';
import { withFileLock } from './flock.js';
import {
  assertNoSymlinkComponents,
  prepareStore,
  resolveStorePath,
} from './store.js';

export const JOB_SCHEMA_VERSION = 1;
export const JOB_ARTIFACT_TYPE = 'owner-alpha-job-state';

const transitions = {
  accepted: ['preflighting', 'blocked-pre-apply', 'cancelled', 'failed'],
  preflighting: ['checking', 'blocked-pre-apply', 'cancelled', 'failed'],
  checking: ['rendering', 'blocked-pre-apply', 'cancelled', 'failed'],
  rendering: ['ready-to-apply', 'blocked-pre-apply', 'cancelled', 'failed'],
  'ready-to-apply': ['applying', 'blocked-pre-apply', 'failed'],
  applying: ['source-applied', 'manual-intervention'],
  'source-applied': ['committing', 'manual-intervention'],
  committing: ['committed', 'manual-intervention'],
  committed: ['pushing', 'failed'],
  pushing: ['pushed', 'manual-intervention'],
  pushed: ['discovering-run', 'failed'],
  'discovering-run': ['run-bound', 'deployment-failed', 'failed'],
  'run-bound': ['monitoring-deployment', 'deployment-failed', 'failed'],
  'monitoring-deployment': ['deployment-succeeded', 'deployment-failed', 'failed'],
  'deployment-succeeded': ['verifying-live', 'failed'],
  'verifying-live': ['live-confirmed', 'live-verification-failed', 'failed'],
  'live-confirmed': ['rebuilding-local', 'failed'],
  'rebuilding-local': ['completed', 'failed'],
  completed: [],
  'blocked-pre-apply': [],
  'deployment-failed': [],
  'live-verification-failed': ['verifying-live'],
  'manual-intervention': [],
  cancelled: [],
  failed: [],
};

export const LEGAL_JOB_TRANSITIONS = deepFreeze(
  Object.fromEntries(Object.entries(transitions).map(([state, next]) => [state, [...next]])),
);
export const JOB_STATES = Object.freeze(Object.keys(LEGAL_JOB_TRANSITIONS));

const recovery = {
  accepted: {
    classification: 'restart-safe',
    automatic: true,
    instruction: 'Restart preflight from the durable Save event.',
  },
  preflighting: {
    classification: 'restart-safe',
    automatic: true,
    instruction: 'Discard incomplete preflight output and rerun preflight.',
  },
  checking: {
    classification: 'restart-safe',
    automatic: true,
    instruction: 'Discard incomplete check output and rerun deterministic checks.',
  },
  rendering: {
    classification: 'restart-safe',
    automatic: true,
    instruction: 'Discard incomplete render output and rerun rendering.',
  },
  'ready-to-apply': {
    classification: 'restart-safe',
    automatic: true,
    instruction: 'Reconfirm the exact source and base binding, then enter source application.',
  },
  applying: {
    classification: 'manual-intervention',
    automatic: false,
    instruction: 'Disable mutation and reconcile canonical source against the exact candidate.',
  },
  'source-applied': {
    classification: 'reconcile-then-commit',
    automatic: true,
    instruction: 'Reconcile the exact applied bytes and Git worktree, then resume committing.',
  },
  committing: {
    classification: 'reconcile-commit',
    automatic: true,
    instruction: 'Recognize the exact expected commit if present; otherwise create it from the reconciled source.',
  },
  committed: {
    classification: 'resume-push',
    automatic: true,
    instruction: 'Resume pushing the exact durable commit.',
  },
  pushing: {
    classification: 'reconcile-push',
    automatic: true,
    instruction: 'Check the configured remote for the exact commit and push only if it is absent.',
  },
  pushed: {
    classification: 'resume-run-discovery',
    automatic: true,
    instruction: 'Resume discovery of the deployment run for the exact pushed commit.',
  },
  'discovering-run': {
    classification: 'restart-run-discovery',
    automatic: true,
    instruction: 'Repeat read-only deployment run discovery for the exact pushed commit.',
  },
  'run-bound': {
    classification: 'reobserve-external',
    automatic: true,
    instruction: 'Reobserve the stored deployment run without triggering a new run.',
  },
  'monitoring-deployment': {
    classification: 'reobserve-external',
    automatic: true,
    instruction: 'Reobserve the stored deployment run without triggering a new run.',
  },
  'deployment-succeeded': {
    classification: 'resume-live-verification',
    automatic: true,
    instruction: 'Begin read-only verification of the exact live URL and commit binding.',
  },
  'verifying-live': {
    classification: 'restart-read-only',
    automatic: true,
    instruction: 'Repeat read-only live verification against the same commit binding.',
  },
  'live-confirmed': {
    classification: 'resume-local-rebuild',
    automatic: true,
    instruction: 'Resume rebuilding the local derivative from the confirmed source commit.',
  },
  'rebuilding-local': {
    classification: 'restart-idempotent',
    automatic: true,
    instruction: 'Discard incomplete local derivative output and rebuild it from the confirmed source commit.',
  },
  completed: {
    classification: 'terminal',
    automatic: false,
    instruction: 'Keep the completed evidence immutable.',
  },
  'blocked-pre-apply': {
    classification: 'terminal-source-untouched',
    automatic: false,
    instruction: 'Keep the blocker evidence immutable; canonical source remains untouched.',
  },
  'deployment-failed': {
    classification: 'terminal-external-failure',
    automatic: false,
    instruction: 'Retain the bound external deployment failure and perform no further mutation.',
  },
  'live-verification-failed': {
    classification: 'retry-read-only',
    automatic: true,
    instruction: 'Retry only read-only live verification against the same commit binding.',
  },
  'manual-intervention': {
    classification: 'manual-intervention',
    automatic: false,
    instruction: 'Keep mutation disabled until the recorded ambiguity is reconciled outside this job.',
  },
  cancelled: {
    classification: 'terminal-source-untouched',
    automatic: false,
    instruction: 'Keep the cancellation immutable; canonical source remains untouched.',
  },
  failed: {
    classification: 'inspect-failure',
    automatic: false,
    instruction: 'Inspect the recorded phase failure and create a new job if further work is needed.',
  },
};

export const RECOVERY_CLASSIFICATIONS = deepFreeze(recovery);

const FAILURE_STATES = Object.freeze([
  'blocked-pre-apply',
  'deployment-failed',
  'live-verification-failed',
  'manual-intervention',
  'failed',
]);

function exactObject(value, location, keys) {
  if (!isPlainObject(value)) fail('invalid-job-state', `${location} must be an object`);
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  const missing = keys.filter((key) => !Object.hasOwn(value, key));
  if (unknown.length > 0) {
    fail('unknown-job-key', `${location} contains unknown keys`, { location, keys: unknown.sort() });
  }
  if (missing.length > 0) {
    fail('missing-job-key', `${location} is missing required keys`, { location, keys: missing });
  }
  return value;
}

function exactString(value, location, { max = 1000 } = {}) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || value.trim() !== value) {
    fail('invalid-job-state', `${location} must be a non-empty exact string`);
  }
  return value;
}

function timestamp(value, location) {
  const stamp = exactString(value, location, { max: 40 });
  let normalized;
  try {
    normalized = new Date(stamp).toISOString();
  } catch {
    fail('invalid-job-state', `${location} must be an exact ISO-8601 UTC timestamp`);
  }
  if (normalized !== stamp) fail('invalid-job-state', `${location} must be an exact ISO-8601 UTC timestamp`);
  return stamp;
}

export function validateJobId(value) {
  const jobId = exactString(value, 'jobId', { max: 128 });
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(jobId) || jobId.includes('..')) {
    fail('invalid-job-id', 'jobId must be one safe path segment');
  }
  return jobId;
}

function validatePolicyRevision(value) {
  const revision = exactString(value, 'policyRevision', { max: 80 });
  if (!/^sha256:[a-f0-9]{64}$/.test(revision)) {
    fail('invalid-policy-revision', 'policyRevision must be one lowercase SHA-256 revision');
  }
  return revision;
}

function validateRecovery(value, state, location = 'recovery') {
  const input = exactObject(value, location, ['classification', 'automatic', 'instruction']);
  const expected = RECOVERY_CLASSIFICATIONS[state];
  if (input.classification !== expected.classification
    || input.automatic !== expected.automatic
    || input.instruction !== expected.instruction) {
    fail('recovery-classification-mismatch', `${location} must exactly match state ${state}`);
  }
  return { ...expected };
}

function validateFailure(value, state) {
  if (!FAILURE_STATES.includes(state)) {
    if (value !== null) fail('invalid-job-state', `failure must be null unless state records a failure`);
    return null;
  }
  const input = exactObject(value, 'failure', ['fromState', 'code', 'message', 'retryable']);
  if (!JOB_STATES.includes(input.fromState)
    || !LEGAL_JOB_TRANSITIONS[input.fromState]?.includes(state)) {
    fail('invalid-job-state', `failure.fromState must identify a state that can enter ${state}`);
  }
  if (typeof input.retryable !== 'boolean') fail('invalid-job-state', 'failure.retryable must be boolean');
  return {
    fromState: input.fromState,
    code: exactString(input.code, 'failure.code', { max: 100 }),
    message: exactString(input.message, 'failure.message', { max: 2000 }),
    retryable: input.retryable,
  };
}

function validateHistory(value, currentState, revision, createdAt, updatedAt) {
  if (!Array.isArray(value) || value.length === 0) {
    fail('invalid-job-state', 'history must be a non-empty array');
  }
  let previousState = null;
  const normalized = value.map((entry, index) => {
    const item = exactObject(entry, `history[${index}]`, ['revision', 'from', 'to', 'at', 'reason']);
    if (item.revision !== index) fail('invalid-job-state', 'history revisions must be contiguous from zero');
    if (index === 0) {
      if (item.from !== null || item.to !== 'accepted' || item.reason !== 'save-accepted') {
        fail('invalid-job-state', 'history must begin with the canonical Save acceptance event');
      }
    } else if (item.from !== previousState || !LEGAL_JOB_TRANSITIONS[item.from]?.includes(item.to)) {
      fail('illegal-job-transition', `history contains illegal transition ${item.from} -> ${item.to}`);
    }
    if (!JOB_STATES.includes(item.to)) fail('invalid-job-state', `history[${index}].to is unknown`);
    const at = timestamp(item.at, `history[${index}].at`);
    if (index === 0 && at !== createdAt) fail('invalid-job-state', 'creation history time must match createdAt');
    previousState = item.to;
    return {
      revision: item.revision,
      from: item.from,
      to: item.to,
      at,
      reason: exactString(item.reason, `history[${index}].reason`, { max: 500 }),
    };
  });
  if (revision !== normalized.length - 1 || currentState !== previousState) {
    fail('invalid-job-state', 'state and revision must match the final history event');
  }
  if (normalized.at(-1).at !== updatedAt) fail('invalid-job-state', 'updatedAt must match final history time');
  return normalized;
}

export function recoveryForState(state) {
  if (!JOB_STATES.includes(state)) fail('unknown-job-state', `${state} is not an owner-alpha job state`);
  return deepFreeze({ ...RECOVERY_CLASSIFICATIONS[state] });
}

export function validateJobState(value) {
  assertNoCredentialMaterial(value);
  const input = exactObject(value, '$', [
    'schemaVersion',
    'artifactType',
    'jobId',
    'policyRevision',
    'state',
    'revision',
    'createdAt',
    'updatedAt',
    'recovery',
    'failure',
    'history',
  ]);
  if (input.schemaVersion !== JOB_SCHEMA_VERSION || input.artifactType !== JOB_ARTIFACT_TYPE) {
    fail('invalid-job-state', 'job state schema or artifact type is unsupported');
  }
  if (!JOB_STATES.includes(input.state)) fail('unknown-job-state', `${input.state} is not an owner-alpha job state`);
  if (!Number.isSafeInteger(input.revision) || input.revision < 0) {
    fail('invalid-job-state', 'revision must be a non-negative safe integer');
  }
  const createdAt = timestamp(input.createdAt, 'createdAt');
  const updatedAt = timestamp(input.updatedAt, 'updatedAt');
  if (Date.parse(updatedAt) < Date.parse(createdAt)) fail('invalid-job-state', 'updatedAt precedes createdAt');
  const failure = validateFailure(input.failure, input.state);
  const normalized = {
    schemaVersion: JOB_SCHEMA_VERSION,
    artifactType: JOB_ARTIFACT_TYPE,
    jobId: validateJobId(input.jobId),
    policyRevision: validatePolicyRevision(input.policyRevision),
    state: input.state,
    revision: input.revision,
    createdAt,
    updatedAt,
    recovery: validateRecovery(input.recovery, input.state),
    failure,
    history: validateHistory(input.history, input.state, input.revision, createdAt, updatedAt),
  };
  if (normalized.failure !== null
    && normalized.failure.fromState !== normalized.history.at(-1).from) {
    fail('invalid-job-state', 'failure.fromState must match the failure transition');
  }
  return deepFreeze(normalized);
}

export function createJobState({ jobId, policyRevision, at = new Date().toISOString() }) {
  const createdAt = timestamp(at, 'at');
  return validateJobState({
    schemaVersion: JOB_SCHEMA_VERSION,
    artifactType: JOB_ARTIFACT_TYPE,
    jobId: validateJobId(jobId),
    policyRevision: validatePolicyRevision(policyRevision),
    state: 'accepted',
    revision: 0,
    createdAt,
    updatedAt: createdAt,
    recovery: recoveryForState('accepted'),
    failure: null,
    history: [{ revision: 0, from: null, to: 'accepted', at: createdAt, reason: 'save-accepted' }],
  });
}

export function transitionJobState(
  stateInput,
  nextState,
  { at = new Date().toISOString(), reason, failure = null } = {},
) {
  const current = validateJobState(stateInput);
  if (!JOB_STATES.includes(nextState)) fail('unknown-job-state', `${nextState} is not an owner-alpha job state`);
  if (!LEGAL_JOB_TRANSITIONS[current.state].includes(nextState)) {
    fail('illegal-job-transition', `${current.state} cannot transition to ${nextState}`);
  }
  const transitionAt = timestamp(at, 'at');
  if (Date.parse(transitionAt) < Date.parse(current.updatedAt)) {
    fail('invalid-job-state', 'transition timestamp precedes the durable state');
  }
  const transitionReason = exactString(reason, 'reason', { max: 500 });
  let normalizedFailure = null;
  if (FAILURE_STATES.includes(nextState)) {
    if (!isPlainObject(failure)) fail('invalid-job-state', `${nextState} transitions require failure details`);
    normalizedFailure = validateFailure({ ...failure, fromState: current.state }, nextState);
  } else if (failure !== null) {
    fail('invalid-job-state', 'failure details are allowed only for a failure-recording transition');
  }
  const revision = current.revision + 1;
  return validateJobState({
    ...current,
    state: nextState,
    revision,
    updatedAt: transitionAt,
    recovery: recoveryForState(nextState),
    failure: normalizedFailure,
    history: [
      ...current.history,
      {
        revision,
        from: current.state,
        to: nextState,
        at: transitionAt,
        reason: transitionReason,
      },
    ],
  });
}

export function jobArtifactPaths(jobIdInput) {
  const jobId = validateJobId(jobIdInput);
  return deepFreeze({
    state: `jobs/${jobId}/state.json`,
    lock: `jobs/${jobId}/.state.lock`,
  });
}

export async function initializeDurableJob(
  context,
  { jobId, policyRevision, at, maxBytes = 1024 * 1024 },
) {
  const state = createJobState({ jobId, policyRevision, at });
  const paths = jobArtifactPaths(state.jobId);
  await createJsonArtifactOnce(context, paths.state, state, { maxBytes });
  return state;
}

export async function loadDurableJob(context, jobId, { maxBytes = 1024 * 1024 } = {}) {
  const paths = jobArtifactPaths(jobId);
  return validateJobState(await readJsonArtifact(context, paths.state, { maxBytes }));
}

export async function listDurableJobs(context, { maxBytes = 1024 * 1024 } = {}) {
  await prepareStore(context);
  const jobsRoot = resolveStorePath(context, 'jobs');
  await assertNoSymlinkComponents(context, jobsRoot);
  let metadata;
  try {
    metadata = await lstat(jobsRoot);
  } catch (error) {
    if (error?.code === 'ENOENT') return Object.freeze([]);
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    fail('unsafe-jobs-directory', 'durable jobs path must be one real directory');
  }
  const entries = await readdir(jobsRoot, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  const jobs = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      fail('unsafe-job-entry', 'durable jobs directory may contain only real job directories', {
        entry: entry.name,
      });
    }
    let jobId;
    try {
      jobId = validateJobId(entry.name);
    } catch (error) {
      if (error instanceof OwnerAlphaError) {
        fail('unsafe-job-entry', 'durable jobs directory contains an invalid job identifier', {
          entry: entry.name,
        });
      }
      throw error;
    }
    jobs.push(await loadDurableJob(context, jobId, { maxBytes }));
  }
  return Object.freeze(jobs);
}

export async function transitionDurableJob(
  context,
  jobId,
  nextState,
  options = {},
) {
  const paths = jobArtifactPaths(jobId);
  const maxBytes = options.maxBytes ?? 1024 * 1024;
  return withFileLock(context, paths.lock, async () => {
    const current = await loadDurableJob(context, jobId, { maxBytes });
    const next = transitionJobState(current, nextState, options);
    await replaceJsonArtifactAtomic(context, paths.state, next, { maxBytes });
    return next;
  });
}

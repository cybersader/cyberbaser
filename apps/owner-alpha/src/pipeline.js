import { digestBytes } from '@cyberbaser/proposal-queue';
import { findFrontmatterInText } from '../../../packages/correction/src/frontmatter.js';
import { validateChangeSetCorrection } from './change-set-operation.js';
import { randomUUID } from 'node:crypto';
import { applyAcceptedOperation } from './apply.js';
import { createJsonArtifactOnce, readJsonArtifact, replaceJsonArtifactAtomic } from './artifacts.js';
import { rm } from 'node:fs/promises';
import { runPreApplyChecks } from './checks.js';
import { computePolicyRevision, isPrivateSite, validateOwnerAlphaConfig } from './config.js';
import {
  discoverDeploymentRun,
  monitorDeploymentRun,
} from './deployment/index.js';
import { OwnerAlphaError, fail } from './errors.js';
import { withFileLock } from './flock.js';
import {
  commitAppliedCandidate,
  pushExactCommit,
  verifyExactCommit,
} from './git-publish.js';
import {
  initializeDurableJob,
  LEGAL_JOB_TRANSITIONS,
  loadDurableJob,
  transitionDurableJob,
  validateJobId,
} from './job-state.js';
import { canonicalJson, deepFreeze, isPlainObject } from './json.js';
import { bundleJobId, PAGE_BUNDLE_ORIGIN, validateBundleSession } from './bundle-lifecycle.js';
import {
  confirmLivePage, confirmNewPagesLive, hasExactSuccessfulDeployment, hasNewPageLiveProof, hasStableLiveProof, isStableWitness,
} from './live-confirm.js';
import { applyEditorOperation, deriveEditorOperation } from './operation.js';
import { requestPublication } from './publisher/client.js';
import {
  DEFAULT_OWNER_ALPHA_PROJECT_ROOT,
  ensureOwnerSite,
  rebuildOwnerSite,
} from './site.js';
import { assertCheckoutReady, createEditSession, defaultGitRunner } from './source.js';
import { assertSafeStoreTarget, resolveStorePath, storeContextFromConfig } from './store.js';

export const PIPELINE_SCHEMA_VERSION = 1;
export const PIPELINE_MUTATION_LOCK = 'locks/owner-alpha-mutation.lock';

const TERMINAL_NO_RESUME = new Set([
  'blocked-pre-apply',
  'deployment-failed',
  'manual-intervention',
  'cancelled',
  'failed',
  'completed',
]);
const PRE_APPLY_STATES = new Set([
  'accepted',
  'preflighting',
  'checking',
  'rendering',
  'ready-to-apply',
]);
const EFFECT_AMBIGUOUS_STATES = new Set([
  'applying',
  'source-applied',
  'committing',
  'pushing',
]);
const DEPLOYMENT_STATES = new Set([
  'discovering-run',
  'run-bound',
  'monitoring-deployment',
]);

function exactTimestamp(value) {
  const stamp = typeof value === 'number' ? new Date(value).toISOString() : value;
  if (typeof stamp !== 'string') fail('invalid-pipeline-clock', 'pipeline clock must return an ISO timestamp or epoch milliseconds');
  let normalized;
  try {
    normalized = new Date(stamp).toISOString();
  } catch {
    fail('invalid-pipeline-clock', 'pipeline clock returned an invalid timestamp');
  }
  if (normalized !== stamp) fail('invalid-pipeline-clock', 'pipeline clock must return an exact ISO-8601 UTC timestamp');
  return stamp;
}

function jsonClone(value) {
  return JSON.parse(canonicalJson(value));
}

function artifactRecord(artifactType, jobId, result) {
  return deepFreeze({
    schemaVersion: PIPELINE_SCHEMA_VERSION,
    artifactType,
    jobId,
    result: jsonClone(result),
  });
}

function artifactResult(value, artifactType, jobId) {
  if (!isPlainObject(value)
    || value.schemaVersion !== PIPELINE_SCHEMA_VERSION
    || value.artifactType !== artifactType
    || value.jobId !== jobId
    || !Object.hasOwn(value, 'result')) {
    fail('invalid-pipeline-artifact', `${artifactType} artifact is invalid or bound to a different job`);
  }
  return deepFreeze(value.result);
}

async function optionalArtifact(context, relativePath, options) {
  try {
    return await readJsonArtifact(context, relativePath, options);
  } catch (error) {
    if (error instanceof OwnerAlphaError && error.code === 'artifact-not-found') return null;
    throw error;
  }
}

// The owner approval travels as standard base64 of its JSON, so random
// signature text can never look like a credential to the artifact writer.
export const OWNER_APPROVAL_ARTIFACT = 'owner-alpha-owner-approval';
const MAX_APPROVAL_BYTES = 12 * 1024;

function encodeOwnerApproval(jobId, record) {
  if (!isPlainObject(record) || Object.keys(record).sort().join(',') !== 'approval,intent') {
    fail('owner-approval-invalid', 'an owner approval is exactly { intent, approval }');
  }
  const text = JSON.stringify(record);
  if (Buffer.byteLength(text) > MAX_APPROVAL_BYTES) fail('owner-approval-invalid', 'owner approval is too large');
  return { schemaVersion: 1, artifactType: OWNER_APPROVAL_ARTIFACT, jobId, recordBase64: Buffer.from(text, 'utf8').toString('base64') };
}

function decodeOwnerApproval(stored, jobId) {
  if (!isPlainObject(stored) || stored.artifactType !== OWNER_APPROVAL_ARTIFACT || stored.jobId !== jobId
    || typeof stored.recordBase64 !== 'string' || stored.recordBase64.length > MAX_APPROVAL_BYTES * 2) return null;
  try { return JSON.parse(Buffer.from(stored.recordBase64, 'base64').toString('utf8')); } catch { return null; }
}

/** The approval record attached to a job, or null. Read by the publisher only as a carrier. */
export async function readOwnerApproval(context, jobId, options = {}) {
  const stored = await optionalArtifact(context, pipelineArtifactPaths(jobId).ownerApproval, options);
  return stored === null ? null : decodeOwnerApproval(stored, jobId);
}

async function discardOwnerApproval(context, paths, options) {
  const file = resolveStorePath(context, paths.ownerApproval);
  if (await optionalArtifact(context, paths.ownerApproval, options).catch(() => null) === null) return;
  await assertSafeStoreTarget(context, file);
  await rm(file, { force: true });
}

/**
 * Attach (or replace) the owner's signed approval for a job's push. The node
 * stores what a device sent; only the publisher decides whether it counts.
 */
export async function attachOwnerApproval({ context, config, jobId, record }) {
  const id = validateJobId(jobId);
  const paths = pipelineArtifactPaths(id);
  const options = artifactOptions(config);
  const value = encodeOwnerApproval(id, record);
  try { await createJsonArtifactOnce(context, paths.ownerApproval, value, options); }
  catch (error) {
    if (!(error instanceof OwnerAlphaError) || error.code !== 'artifact-already-exists') throw error;
    await replaceJsonArtifactAtomic(context, paths.ownerApproval, value, options);
  }
}

async function createOrMatch(context, relativePath, value, options) {
  const existing = await optionalArtifact(context, relativePath, options);
  if (existing !== null) {
    if (canonicalJson(existing) !== canonicalJson(value)) {
      fail('pipeline-artifact-mismatch', `${relativePath} already contains different immutable evidence`);
    }
    return deepFreeze(existing);
  }
  await createJsonArtifactOnce(context, relativePath, value, options);
  return value;
}

function serializeApplication(application) {
  return deepFreeze({
    status: application.status,
    recovery: application.recovery,
    checkout: application.checkout,
    baseCommit: application.baseCommit,
    sourcePath: application.sourcePath,
    sourceMode: application.sourceMode,
    baseBlob: application.baseBlob,
    baseDigest: application.baseDigest,
    candidateDigest: application.candidateDigest,
    candidateByteLength: application.candidateByteLength,
    candidateBytesBase64: Buffer.from(application.candidateBytes).toString('base64'),
    correction: application.correction.operationType === 'change-set' ? validateChangeSetCorrection(application.correction) : {
      operationType: application.correction.operationType,
      baseByteLength: application.correction.baseByteLength,
      baseDigest: application.correction.baseDigest,
      start: application.correction.start,
      end: application.correction.end,
      expectedOldBytesBase64: Buffer.from(application.correction.expectedOldBytes).toString('base64'),
      replacementBytesBase64: Buffer.from(application.correction.replacementBytes).toString('base64'),
      candidateByteLength: application.correction.candidateByteLength,
      candidateDigest: application.correction.candidateDigest,
    },
    exactSplice: jsonClone(application.exactSplice),
  });
}

function deserializeApplication(value) {
  if (!isPlainObject(value) || !isPlainObject(value.correction)
    || typeof value.candidateBytesBase64 !== 'string') {
    fail('invalid-source-applied-artifact', 'durable source-applied evidence is incomplete');
  }
  const candidateBytes = Buffer.from(value.candidateBytesBase64, 'base64');
  if (candidateBytes.toString('base64') !== value.candidateBytesBase64) {
    fail('invalid-source-applied-artifact', 'durable candidate bytes are not canonical base64');
  }
  if (value.correction.operationType === 'change-set') {
    const correction = validateChangeSetCorrection(value.correction);
    if (candidateBytes.length !== correction.candidateByteLength || digestBytes(candidateBytes) !== correction.candidateDigest
      || value.candidateDigest !== correction.candidateDigest || value.baseDigest !== correction.baseDigest
      || value.sourcePath !== correction.proposal.changeSet.files[0].path) fail('invalid-source-applied-artifact', 'durable change-set effect bindings disagree');
    return deepFreeze({ ...value, candidateBytes, correction });
  }
  const expectedOldBytes = Buffer.from(value.correction.expectedOldBytesBase64, 'base64');
  const replacementBytes = Buffer.from(value.correction.replacementBytesBase64, 'base64');
  if (expectedOldBytes.toString('base64') !== value.correction.expectedOldBytesBase64
    || replacementBytes.toString('base64') !== value.correction.replacementBytesBase64) {
    fail('invalid-source-applied-artifact', 'durable correction bytes are not canonical base64');
  }
  return deepFreeze({
    ...value,
    candidateBytes,
    correction: {
      ...value.correction,
      expectedOldBytes,
      replacementBytes,
    },
  });
}

function dependencySet(overrides = {}) {
  return {
    createEditSession,
    assertCheckoutReady,
    deriveEditorOperation,
    applyEditorOperation,
    runPreApplyChecks,
    applyAcceptedOperation,
    commitAppliedCandidate,
    pushExactCommit,
    verifyExactCommit,
    discoverDeploymentRun,
    monitorDeploymentRun,
    confirmLivePage,
    confirmNewPages: confirmNewPagesLive,
    rebuildLocal: defaultLocalRebuild,
    getHead: (checkout) => defaultGitRunner(checkout, ['rev-parse', 'HEAD']),
    now: () => new Date().toISOString(),
    ...overrides,
  };
}

function validateDependencies(dependencies) {
  for (const name of [
    'createEditSession',
    'assertCheckoutReady',
    'deriveEditorOperation',
    'applyEditorOperation',
    'runPreApplyChecks',
    'applyAcceptedOperation',
    'commitAppliedCandidate',
    'pushExactCommit',
    'verifyExactCommit',
    'discoverDeploymentRun',
    'monitorDeploymentRun',
    'confirmLivePage',
    'confirmNewPages',
    'rebuildLocal',
    'getHead',
    'now',
  ]) {
    if (typeof dependencies[name] !== 'function') {
      fail('invalid-pipeline-dependencies', `${name} must be an injected function`);
    }
  }
  return dependencies;
}

export function pipelineArtifactPaths(jobIdInput) {
  const jobId = validateJobId(jobIdInput);
  return deepFreeze({
    mutationLock: PIPELINE_MUTATION_LOCK,
    session: `jobs/${jobId}/session.json`,
    operation: `jobs/${jobId}/operation.json`,
    preApplyChecks: `jobs/${jobId}/checks/pre-apply.json`,
    sourceApplied: `jobs/${jobId}/effects/source-applied.json`,
    committed: `jobs/${jobId}/effects/committed.json`,
    pushed: `jobs/${jobId}/effects/pushed.json`,
    // The owner's signed approval for this job's push, as a device sent it.
    // Its authority comes from the signature the publisher checks, not from being stored here.
    ownerApproval: `jobs/${jobId}/approvals/owner-approval.json`,
    runBound: `jobs/${jobId}/effects/run-bound.json`,
    deployment: `jobs/${jobId}/results/deployment.json`,
    live: `jobs/${jobId}/results/live.json`,
    localRebuild: `jobs/${jobId}/effects/local-rebuild.json`,
    failures: `jobs/${jobId}/results/failures`,
  });
}

function artifactOptions(config) {
  return { maxBytes: config.limits.maxArtifactBytes };
}

async function loadRecord(context, relativePath, artifactType, jobId, options) {
  const value = await optionalArtifact(context, relativePath, options);
  return value === null ? null : artifactResult(value, artifactType, jobId);
}

async function readStableDeploymentCommit(context, paths, jobId, options) {
  const commit = (await loadRecord(context, paths.committed, 'owner-alpha-committed-effect', jobId, options))?.commit;
  const binding = await loadRecord(context, paths.runBound, 'owner-alpha-run-bound-effect', jobId, options);
  const deployment = await loadRecord(context, paths.deployment, 'owner-alpha-deployment-result', jobId, options);
  return hasExactSuccessfulDeployment(commit, binding, deployment) ? commit : null;
}

async function saveRecord(context, relativePath, artifactType, jobId, result, options) {
  const record = artifactRecord(artifactType, jobId, result);
  const persisted = await createOrMatch(context, relativePath, record, options);
  return artifactResult(persisted, artifactType, jobId);
}

async function transition(context, state, nextState, reason, dependencies, failure = null) {
  return transitionDurableJob(context, state.jobId, nextState, {
    at: exactTimestamp(dependencies.now()),
    reason,
    ...(failure === null ? {} : { failure }),
  });
}

function failureTarget(state) {
  if (PRE_APPLY_STATES.has(state)) return 'blocked-pre-apply';
  if (EFFECT_AMBIGUOUS_STATES.has(state)) return 'manual-intervention';
  if (DEPLOYMENT_STATES.has(state)) return 'deployment-failed';
  if (state === 'verifying-live' || state === 'live-verification-failed') {
    return 'live-verification-failed';
  }
  return 'failed';
}

function safeFailure(error, state, target) {
  const ownerError = error instanceof OwnerAlphaError;
  return deepFreeze({
    fromState: state,
    targetState: target,
    code: ownerError ? error.code : 'pipeline-phase-failed',
    message: ownerError ? error.message : 'owner-alpha pipeline phase failed',
    retryable: target === 'live-verification-failed',
  });
}

async function recordFailure(context, paths, state, error, dependencies, options) {
  if (!state || TERMINAL_NO_RESUME.has(state.state)) return state;
  let target = failureTarget(state.state);
  if (!LEGAL_JOB_TRANSITIONS[state.state]?.includes(target)) {
    target = LEGAL_JOB_TRANSITIONS[state.state]?.includes('failed') ? 'failed' : null;
  }
  if (target === null) return state;
  const failure = safeFailure(error, state.state, target);
  const artifactPath = `${paths.failures}/${String(state.revision + 1).padStart(4, '0')}-${target}.json`;
  try {
    await createOrMatch(
      context,
      artifactPath,
      artifactRecord('owner-alpha-pipeline-failure', state.jobId, failure),
      options,
    );
  } catch {
    // The state record remains the minimum durable failure evidence if the richer result cannot be written.
  }
  try {
    return await transition(context, state, target, failure.code, dependencies, {
      code: failure.code,
      message: failure.message,
      retryable: failure.retryable,
    });
  } catch {
    return state;
  }
}

async function ensureJob(
  context,
  jobId,
  policyRevision,
  dependencies,
  options,
  initializeInputs,
) {
  try {
    const state = await loadDurableJob(context, jobId, options);
    if (state.policyRevision !== policyRevision) {
      fail('job-policy-mismatch', 'durable job policy revision differs from the current owner policy');
    }
    return { state, bindings: null, created: false };
  } catch (error) {
    if (!(error instanceof OwnerAlphaError) || error.code !== 'artifact-not-found') throw error;
    const bindings = await initializeInputs();
    const state = await initializeDurableJob(context, {
      jobId,
      policyRevision,
      at: exactTimestamp(dependencies.now()),
      ...options,
    });
    return { state, bindings, created: true };
  }
}

async function boundInputs(input, config, context, paths, dependencies, options) {
  let session = await optionalArtifact(context, paths.session, options);
  if (session === null) {
    session = input.session ?? await dependencies.createEditSession({
      config,
      renderer: input.renderer,
    });
    await createJsonArtifactOnce(context, paths.session, session, options);
  } else if (input.session && canonicalJson(input.session) !== canonicalJson(session)) {
    fail('edit-session-artifact-mismatch', 'supplied edit session differs from the durable immutable session');
  }
  session = deepFreeze(session);

  let operation = await optionalArtifact(context, paths.operation, options);
  if (operation === null) {
    operation = input.operation ?? dependencies.deriveEditorOperation({
      session,
      editedText: input.editedText,
      config,
    });
    await createJsonArtifactOnce(context, paths.operation, operation, options);
  } else if (input.operation && canonicalJson(input.operation) !== canonicalJson(operation)) {
    fail('source-operation-artifact-mismatch', 'supplied source operation differs from the durable immutable operation');
  }
  operation = deepFreeze(operation);
  const candidateBytes = dependencies.applyEditorOperation(session, operation, { allowProperties: config.owner.allowProperties });
  return { session, operation, candidateBytes };
}

async function reconcileCommit(input, application, config, dependencies) {
  const head = await dependencies.getHead(config.repository.checkout);
  if (head === application.baseCommit) return null;
  const expectedMessage = input.commitMessage
    ?? `${config.git.commitMessagePrefix} ${application.sourcePath}`;
  const verification = await dependencies.verifyExactCommit({
    checkout: config.repository.checkout,
    commit: head,
    application,
    expectedMessage,
  });
  return deepFreeze({
    status: 'committed',
    recovery: 'resume-push',
    commit: head,
    message: verification.message,
    hooksUsed: config.git.useHooks,
    verification,
    commandReportedFailure: false,
    reconciledFromRepository: true,
  });
}

function assertPushedReceipt(pushed, committed, config) {
  if (!['pushed', 'already-pushed'].includes(pushed?.status) || pushed.commit !== committed.commit
    || pushed.remoteRef !== committed.commit || pushed.branch !== config.repository.branch
    || pushed.remote !== config.repository.remote.name) {
    fail('publisher-receipt-mismatch', 'push evidence does not match the bound commit and destination');
  }
}

// The executor accepts a job ID, never a destination, checkout, commit or candidate.
// The pipeline holds the mutation lock; the IPC publisher must not acquire it again.
// approvalGate (publisher only, approval-gate.js): every push first needs the
// owner's signed approval for exactly this commit. Absent, nothing changes.
export function createJobPublisher({ config, context, pushCommit = pushExactCommit, bindCommitMessage = false, approvalGate = null }) {
  const options = artifactOptions(config);
  const policyRevision = computePolicyRevision(config);
  return async function publishJob(id) {
    const jobId = validateJobId(id);
    const paths = pipelineArtifactPaths(jobId);
    const state = await loadDurableJob(context, jobId, options);
    if (state.state !== 'pushing' || state.policyRevision !== policyRevision || !config.git.autoPush || !config.git.autoCommit) {
      fail('publisher-job-not-admitted', 'publication requires a pushing job bound to the current automatic publication policy');
    }
    const durable = await loadRecord(context, paths.sourceApplied, 'owner-alpha-source-applied-effect', jobId, options);
    const committed = await loadRecord(context, paths.committed, 'owner-alpha-committed-effect', jobId, options);
    if (durable === null || committed === null) {
      fail('publication-evidence-missing', 'push phase requires durable source and commit evidence');
    }
    const application = deserializeApplication(durable);
    const prior = await loadRecord(context, paths.pushed, 'owner-alpha-pushed-effect', jobId, options);
    if (prior !== null) {
      assertPushedReceipt(prior, committed, config);
      return 'already-pushed';
    }
    let authorization = null;
    if (approvalGate !== null) {
      // The record is only a carrier; admitPublish checks the signature against
      // the publisher's own key list and spends its one-use nonce.
      const record = await readOwnerApproval(context, jobId, options).catch(() => null);
      authorization = await approvalGate.authorize(record, { remote: config.repository.remote.url, branch: config.repository.branch });
    }
    let pushed = await pushCommit({
      checkout: config.repository.checkout, application, commit: committed.commit,
      remote: config.repository.remote.name, remoteUrl: config.repository.remote.url,
      branch: config.repository.branch, useHooks: config.git.useHooks,
      ...(bindCommitMessage ? { expectedMessage: committed.message } : {}),
      ...(authorization === null ? {} : { verifyCommit: authorization.verifyCommit }),
    });
    assertPushedReceipt(pushed, committed, config);
    const signed = authorization?.receipt(pushed) ?? null;
    if (signed !== null) {
      pushed = { ...pushed, ownerApproval: { intent: signed.body.intent, keyId: signed.body.keyId },
        publisherReceiptBase64: Buffer.from(JSON.stringify(signed), 'utf8').toString('base64') };
    }
    await saveRecord(context, paths.pushed, 'owner-alpha-pushed-effect', jobId, pushed, options);
    return pushed.status;
  };
}

function pipelineSummary(state, paths) {
  return deepFreeze({
    jobId: state.jobId,
    state: state.state,
    revision: state.revision,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    recovery: state.recovery,
    failure: state.failure,
    artifacts: paths,
  });
}

// The states a page bundle job may be in: it starts at its push.
const BUNDLE_JOB_STATES = new Set(['accepted', 'pushed', ...DEPLOYMENT_STATES, 'deployment-succeeded', 'verifying-live',
  'live-verification-failed', 'live-confirmed', 'rebuilding-local', 'completed', 'deployment-failed', 'failed']);

// Record a pushed bundle's evidence once, then its job (bundle-lifecycle.js).
// Existing evidence must match exactly; a second call only resumes.
async function ensureBundleJob(evidence, context, jobId, paths, policyRevision, dependencies, options) {
  if (!isPlainObject(evidence) || jobId !== bundleJobId(evidence.session?.origin?.bundleId)) {
    fail('invalid-bundle-session', 'bundle evidence does not belong to this job');
  }
  validateBundleSession(evidence.session);
  const existing = await optionalArtifact(context, paths.session, options);
  if (existing === null) await createJsonArtifactOnce(context, paths.session, jsonClone(evidence.session), options);
  else if (canonicalJson(existing) !== canonicalJson(evidence.session)) {
    fail('pipeline-artifact-mismatch', 'a different bundle is already recorded for this job');
  }
  await saveRecord(context, paths.committed, 'owner-alpha-committed-effect', jobId, evidence.committed, options);
  await saveRecord(context, paths.pushed, 'owner-alpha-pushed-effect', jobId, evidence.pushed, options);
  try {
    await loadDurableJob(context, jobId, options);
  } catch (error) {
    if (!(error instanceof OwnerAlphaError) || error.code !== 'artifact-not-found') throw error;
    await initializeDurableJob(context, { jobId, policyRevision, at: exactTimestamp(dependencies.now()), ...options });
  }
}

async function executeLocked(input, config, context, dependencies) {
  const jobId = validateJobId(input.jobId);
  const paths = pipelineArtifactPaths(jobId);
  const options = artifactOptions(config);
  const policyRevision = computePolicyRevision(config);
  let bindings = null;
  if (input.pushedBundle !== undefined) await ensureBundleJob(input.pushedBundle, context, jobId, paths, policyRevision, dependencies, options);
  const ensured = await ensureJob(
    context,
    jobId,
    policyRevision,
    dependencies,
    options,
    async () => boundInputs(input, config, context, paths, dependencies, options),
  );
  let state = ensured.state;
  bindings = ensured.bindings;
  // Owner-direct authority must survive every restart, including after the
  // source effect but before commit/push. Never infer it from job state alone.
  const durableSession = bindings?.session ?? await optionalArtifact(context, paths.session, options);
  const bundleSession = durableSession?.origin?.type === PAGE_BUNDLE_ORIGIN ? validateBundleSession(durableSession) : null;
  if (bundleSession !== null && !BUNDLE_JOB_STATES.has(state.state)) {
    fail('bundle-job-state-invalid', 'a page bundle job only follows its pushed commit');
  }
  if (durableSession?.origin?.type === 'owner-direct') {
    bindings ??= await boundInputs(input, config, context, paths, dependencies, options);
    const { guardOwnerDirect } = await import('./owner-direct.js');
    await guardOwnerDirect({ context, config, jobId, ...bindings });
  }
  if (TERMINAL_NO_RESUME.has(state.state)) return pipelineSummary(state, paths);
  if (state.state === 'accepted' && bundleSession === null) {
    bindings ??= await boundInputs(input, config, context, paths, dependencies, options);
    if (typeof input.onAccepted === 'function') {
      input.onAccepted(pipelineSummary(state, paths));
    }
  }

  let checks = null;
  let application = null;
  let committed = null;
  const publishJob = config.publisher ? null : createJobPublisher({
    config, context, pushCommit: (request) => dependencies.pushExactCommit(request, input.gitDependencies),
  });
  let runBinding = null;
  let enteredApplying = false;

  try {
    while (true) {
      switch (state.state) {
        case 'accepted':
          if (bundleSession !== null) {
            // The bundle was pushed by the publisher; its job starts from that evidence.
            committed = await loadRecord(context, paths.committed, 'owner-alpha-committed-effect', jobId, options);
            const pushed = await loadRecord(context, paths.pushed, 'owner-alpha-pushed-effect', jobId, options);
            if (committed === null || pushed === null || committed.commit !== bundleSession.origin.commit) {
              fail('pushed-evidence-missing', 'a page bundle job needs its durable commit and push evidence');
            }
            assertPushedReceipt(pushed, committed, config);
            state = await transition(context, state, 'pushed', 'page-bundle-pushed', dependencies);
            break;
          }
          state = await transition(context, state, 'preflighting', 'begin-accepted-save', dependencies);
          break;
        case 'preflighting':
          if (!config.git.autoCommit || !config.git.autoPush) {
            fail('automatic-publication-disabled', 'owner-alpha integration pipeline requires automatic commit and push policy');
          }
          bindings = await boundInputs(input, config, context, paths, dependencies, options);
          state = await transition(context, state, 'checking', 'immutable-edit-bound', dependencies);
          break;
        case 'checking':
          state = await transition(context, state, 'rendering', 'begin-isolated-pre-apply-checks', dependencies);
          break;
        case 'rendering': {
          bindings ??= await boundInputs(input, config, context, paths, dependencies, options);
          checks = await loadRecord(context, paths.preApplyChecks, 'owner-alpha-pre-apply-check-result', jobId, options);
          if (checks === null) {
            // An owner-approved proposal carries the owner's full review into the
            // trust check, but only after its immutable application act is verified.
            const ownerReview = bindings.session.origin?.type === 'approved-proposal'
              ? await (await import('./proposal-application.js')).verifiedOwnerReview({ context, jobId, session: bindings.session })
              : null;
            checks = await dependencies.runPreApplyChecks({
              config,
              checkoutDir: config.repository.checkout,
              session: bindings.session,
              sourcePath: bindings.session.relativePath,
              baseBytes: Buffer.from(bindings.session.source.bytesBase64, 'base64'),
              candidateBytes: bindings.candidateBytes,
              operation: bindings.operation,
              trustPolicy: input.trustPolicy,
              trustSubject: input.trustSubject,
              ownerReview,
              renderer: input.rendererAdapter,
            });
            checks = await saveRecord(
              context,
              paths.preApplyChecks,
              'owner-alpha-pre-apply-check-result',
              jobId,
              checks,
              options,
            );
          }
          state = await transition(context, state, 'ready-to-apply', 'all-pre-apply-checks-passed', dependencies);
          break;
        }
        case 'ready-to-apply': {
          if (await optionalArtifact(context, paths.preApplyChecks, options) === null) {
            fail('pre-apply-evidence-missing', 'ready-to-apply job has no durable pre-apply check result');
          }
          bindings ??= await boundInputs(input, config, context, paths, dependencies, options);
          const checkout = await dependencies.assertCheckoutReady(config);
          if (checkout.head !== bindings.session.baseCommit) {
            fail(
              'pre-apply-checkout-advanced',
              'canonical checkout or remote branch advanced after the edit was bound',
              { expected: bindings.session.baseCommit, actual: checkout.head },
            );
          }
          if (bindings.operation.schemaVersion === 2) {
            const guard = bindings.session.origin?.type === 'owner-direct'
              ? (await import('./owner-direct.js')).guardOwnerDirect
              : (await import('./proposal-application.js')).guardChangeSetApplication;
            await guard({ context, config, jobId, ...bindings });
          }
          // A publication source is an injected candidate, not a second source
          // authority. Recheck it at the final pre-effect gate, also on recovery.
          if (bindings.session.origin?.type === 'owner-publication') {
            const origin = bindings.session.origin;
            if (!isPlainObject(origin)
              || Object.keys(origin).sort().join(',') !== 'authorizationDigest,draftId,reference,type'
              || !/^[0-9a-f]{64}$/u.test(origin.draftId)
              || !/^[0-9a-f]{64}$/u.test(origin.authorizationDigest)
              || !isPlainObject(origin.reference)) {
              fail('invalid-publication-origin', 'publication job provenance is invalid');
            }
            if (typeof dependencies.revalidateSource !== 'function') {
              fail('publication-guard-unavailable', 'publication requires a pre-application source guard');
            }
          }
          if (typeof dependencies.revalidateSource === 'function') {
            await dependencies.revalidateSource({ jobId, session: bindings.session, operation: bindings.operation });
          }
          state = await transition(context, state, 'applying', 'apply-exact-accepted-save', dependencies);
          application = null;
          enteredApplying = true;
          break;
        }
        case 'applying': {
          const durable = await loadRecord(context, paths.sourceApplied, 'owner-alpha-source-applied-effect', jobId, options);
          if (durable !== null) {
            application = deserializeApplication(durable);
          } else {
            if (!enteredApplying) {
              fail(
                'interrupted-application-ambiguous',
                'application was interrupted without durable source-applied evidence; automatic replay is forbidden',
              );
            }
            bindings ??= await boundInputs(input, config, context, paths, dependencies, options);
            application = await dependencies.applyAcceptedOperation({
              checkout: config.repository.checkout,
              operation: bindings.operation,
              lock: input.mutationLock,
            }, input.applyDependencies);
            const serialized = serializeApplication(application);
            await saveRecord(
              context,
              paths.sourceApplied,
              'owner-alpha-source-applied-effect',
              jobId,
              serialized,
              options,
            );
          }
          state = await transition(context, state, 'source-applied', 'exact-source-effect-durable', dependencies);
          break;
        }
        case 'source-applied': {
          const durable = await loadRecord(context, paths.sourceApplied, 'owner-alpha-source-applied-effect', jobId, options);
          if (durable === null) fail('source-applied-evidence-missing', 'source-applied state has no durable exact effect evidence');
          application = deserializeApplication(durable);
          state = await transition(context, state, 'committing', 'begin-exact-commit', dependencies);
          break;
        }
        case 'committing': {
          const durableApplication = await loadRecord(context, paths.sourceApplied, 'owner-alpha-source-applied-effect', jobId, options);
          if (durableApplication === null) fail('source-applied-evidence-missing', 'commit phase requires durable source-applied evidence');
          application = deserializeApplication(durableApplication);
          committed = await loadRecord(context, paths.committed, 'owner-alpha-committed-effect', jobId, options);
          if (committed === null) {
            committed = await reconcileCommit(input, application, config, dependencies);
            if (committed === null) {
              committed = await dependencies.commitAppliedCandidate({
                checkout: config.repository.checkout,
                application,
                branch: config.repository.branch,
                commitMessagePrefix: config.git.commitMessagePrefix,
                message: input.commitMessage,
                useHooks: config.git.useHooks,
              }, input.gitDependencies);
            }
            committed = await saveRecord(
              context,
              paths.committed,
              'owner-alpha-committed-effect',
              jobId,
              committed,
              options,
            );
          }
          state = await transition(context, state, 'committed', 'exact-commit-durable', dependencies);
          break;
        }
        case 'committed': {
          committed = await loadRecord(context, paths.committed, 'owner-alpha-committed-effect', jobId, options);
          if (committed === null) fail('committed-evidence-missing', 'committed state has no durable exact commit evidence');
          state = await transition(context, state, 'pushing', 'begin-exact-push', dependencies);
          break;
        }
        case 'awaiting-approval': {
          // Waiting for the owner's device. A job resumes from here only when an
          // approval was attached to it (attachOwnerApproval); otherwise it stays
          // put: no retry loop, no failure, nothing lost.
          if (await optionalArtifact(context, paths.ownerApproval, options) === null) return pipelineSummary(state, paths);
          state = await transition(context, state, 'pushing', 'owner-approval-attached', dependencies);
          break;
        }
        case 'pushing': {
          if (config.publisher) {
            try {
              await requestPublication({
                socketPath: config.publisher.socketPath,
                jobId,
                timeoutMs: config.limits.networkTimeoutMs,
              });
            } catch (error) {
              // Waiting or a spent approval: park the job durably and drop the stale
              // approval so a fresh one can be attached. Nothing was pushed.
              if (error instanceof OwnerAlphaError && ['owner-approval-missing', 'owner-approval-expired'].includes(error.code)) {
                await discardOwnerApproval(context, paths, options);
                state = await transition(context, state, 'awaiting-approval', error.code, dependencies);
                return pipelineSummary(state, paths);
              }
              // A bad or mismatched approval never pushes: the job fails closed.
              if (error instanceof OwnerAlphaError && ['owner-approval-invalid', 'owner-approval-mismatch'].includes(error.code)) {
                state = await transition(context, state, 'failed', error.code, dependencies, {
                  code: error.code,
                  message: error.message,
                  retryable: false,
                });
                return pipelineSummary(state, paths);
              }
              throw error;
            }
            const receipt = await loadRecord(context, paths.pushed, 'owner-alpha-pushed-effect', jobId, options);
            if (receipt === null) fail('pushed-evidence-missing', 'publisher did not persist an exact push receipt');
            const boundCommit = await loadRecord(context, paths.committed, 'owner-alpha-committed-effect', jobId, options);
            if (boundCommit === null) fail('committed-evidence-missing', 'push phase has no durable exact commit evidence');
            assertPushedReceipt(receipt, boundCommit, config);
          } else {
            await publishJob(jobId);
          }
          state = await transition(context, state, 'pushed', 'exact-push-durable', dependencies);
          break;
        }
        case 'pushed':
          if (bundleSession === null && state.history.some(({ from, to }) => from === 'accepted' && to === 'pushed')) {
            fail('pushed-evidence-missing', 'only a page bundle job may start at its push');
          }
          if (await optionalArtifact(context, paths.pushed, options) === null) {
            fail('pushed-evidence-missing', 'pushed state has no durable exact remote evidence');
          }
          state = await transition(context, state, 'discovering-run', 'discover-deployment-for-exact-commit', dependencies);
          break;
        case 'discovering-run': {
          committed = await loadRecord(context, paths.committed, 'owner-alpha-committed-effect', jobId, options);
          if (committed === null) fail('committed-evidence-missing', 'deployment discovery requires durable commit evidence');
          runBinding = await loadRecord(context, paths.runBound, 'owner-alpha-run-bound-effect', jobId, options);
          if (runBinding === null) {
            const discovery = await dependencies.discoverDeploymentRun({
              config,
              applicationSha: committed.commit,
              projectRoot: context.projectRoot,
              signal: input.signal,
            }, input.deploymentDependencies);
            runBinding = await saveRecord(
              context,
              paths.runBound,
              'owner-alpha-run-bound-effect',
              jobId,
              discovery,
              options,
            );
          }
          state = await transition(context, state, 'run-bound', 'deployment-run-bound-to-commit', dependencies);
          break;
        }
        case 'run-bound':
          runBinding = await loadRecord(context, paths.runBound, 'owner-alpha-run-bound-effect', jobId, options);
          if (runBinding === null) fail('run-binding-evidence-missing', 'run-bound state has no durable deployment run binding');
          state = await transition(context, state, 'monitoring-deployment', 'monitor-bound-deployment-run', dependencies);
          break;
        case 'monitoring-deployment': {
          committed = await loadRecord(context, paths.committed, 'owner-alpha-committed-effect', jobId, options);
          runBinding = await loadRecord(context, paths.runBound, 'owner-alpha-run-bound-effect', jobId, options);
          if (committed === null || runBinding === null) fail('deployment-evidence-missing', 'deployment monitoring requires durable commit and run evidence');
          let deployment = await loadRecord(context, paths.deployment, 'owner-alpha-deployment-result', jobId, options);
          if (deployment === null) {
            deployment = await dependencies.monitorDeploymentRun({
              config,
              applicationSha: committed.commit,
              projectRoot: context.projectRoot,
              boundRun: runBinding.binding ?? runBinding,
              signal: input.signal,
            }, input.deploymentDependencies);
            deployment = await saveRecord(
              context,
              paths.deployment,
              'owner-alpha-deployment-result',
              jobId,
              deployment,
              options,
            );
          }
          state = await transition(context, state, 'deployment-succeeded', 'bound-deployment-succeeded', dependencies);
          break;
        }
        case 'deployment-succeeded':
          if (await optionalArtifact(context, paths.deployment, options) === null) {
            fail('deployment-evidence-missing', 'deployment-succeeded state has no durable result');
          }
          state = await transition(context, state, 'verifying-live', 'verify-live-visible-witness', dependencies);
          break;
        case 'live-verification-failed':
          state = await transition(context, state, 'verifying-live', 'retry-read-only-live-verification', dependencies);
          break;
        case 'verifying-live': {
          if (bundleSession !== null) {
            const applicationSha = await readStableDeploymentCommit(context, paths, jobId, options);
            if (applicationSha === null || applicationSha !== bundleSession.origin.commit) {
              fail('deployment-evidence-missing', 'live verification requires a successful deployment of the exact commit');
            }
            const proof = { commit: applicationSha, pages: bundleSession.pages, images: bundleSession.images };
            let live = await loadRecord(context, paths.live, 'owner-alpha-live-result', jobId, options);
            if (live === null) {
              live = await dependencies.confirmNewPages({
                config,
                pages: bundleSession.pages.map((page) => ({ pageUrl: page.liveUrl, witness: page.witness })),
                images: bundleSession.images.map(({ url, byteLength, sha256 }) => ({ url, byteLength, sha256 })),
                signal: input.signal,
              }, input.liveDependencies);
              live = { ...live, applicationSha };
              if (!hasNewPageLiveProof(live, proof)) fail('live-witness-evidence-missing', 'the new pages or images are not live as published');
              live = await saveRecord(context, paths.live, 'owner-alpha-live-result', jobId, live, options);
            }
            if (!hasNewPageLiveProof(live, proof)) {
              fail('live-witness-evidence-missing', 'stored live result does not match the new pages and deployed commit');
            }
            state = await transition(context, state, 'live-confirmed', 'new-page-live-confirmed', dependencies);
            break;
          }
          bindings ??= await boundInputs(input, config, context, paths, dependencies, options);
          checks ??= await loadRecord(context, paths.preApplyChecks, 'owner-alpha-pre-apply-check-result', jobId, options);
          if (checks === null) fail('pre-apply-evidence-missing', 'live verification requires durable rendered witnesses');
          const witnesses = checks.rendered?.witnesses;
          const stable = witnesses?.kind === 'no-visible-change';
          let live = await loadRecord(context, paths.live, 'owner-alpha-live-result', jobId, options);
          const applicationSha = stable ? await readStableDeploymentCommit(context, paths, jobId, options) : null;
          if (stable && applicationSha === null) {
            fail('deployment-evidence-missing', 'live verification requires a successful deployment of the exact commit');
          }
          const proof = { pageUrl: bindings.session.liveUrl, commit: applicationSha, witness: witnesses };
          if (live === null) {
            if (stable ? !isStableWitness(witnesses) : typeof witnesses?.old !== 'string' || typeof witnesses?.new !== 'string') {
              fail('live-witness-evidence-missing', 'pre-apply checks did not persist a valid live witness');
            }
            live = await dependencies.confirmLivePage({
              config,
              pageUrl: bindings.session.liveUrl,
              ...(stable ? { stableWitness: witnesses.stable } : { oldWitness: witnesses.old, newWitness: witnesses.new }),
              signal: input.signal,
            }, input.liveDependencies);
            if (stable) {
              live = { ...live, applicationSha, visibleTextDigest: witnesses.digest };
              if (!hasStableLiveProof(live, proof)) fail('live-witness-evidence-missing', 'live page did not establish the stable witness');
            }
            live = await saveRecord(context, paths.live, 'owner-alpha-live-result', jobId, live, options);
          }
          if (stable && !hasStableLiveProof(live, proof)) {
            fail('live-witness-evidence-missing', 'stored live result does not match the stable witness and deployed commit');
          }
          state = await transition(context, state, 'live-confirmed', stable ? 'live-stable-witness-confirmed' : 'live-visible-witness-confirmed', dependencies);
          break;
        }
        case 'live-confirmed':
          if (await optionalArtifact(context, paths.live, options) === null) {
            fail('live-evidence-missing', 'live-confirmed state has no durable result');
          }
          state = await transition(context, state, 'rebuilding-local', 'rebuild-local-derivative', dependencies);
          break;
        case 'rebuilding-local': {
          committed = await loadRecord(context, paths.committed, 'owner-alpha-committed-effect', jobId, options);
          if (bundleSession === null) bindings ??= await boundInputs(input, config, context, paths, dependencies, options);
          if (committed === null) fail('committed-evidence-missing', 'local rebuild requires durable commit evidence');
          let rebuild = await loadRecord(context, paths.localRebuild, 'owner-alpha-local-rebuild-effect', jobId, options);
          if (rebuild === null) {
            rebuild = await dependencies.rebuildLocal({
              config,
              projectRoot: context.projectRoot,
              jobId,
              commit: committed.commit,
              sourcePath: bundleSession?.relativePath ?? bindings.session.relativePath,
              signal: input.signal,
            });
            rebuild = await saveRecord(
              context,
              paths.localRebuild,
              'owner-alpha-local-rebuild-effect',
              jobId,
              rebuild,
              options,
            );
          }
          state = await transition(context, state, 'completed', 'local-derivative-rebuilt', dependencies);
          break;
        }
        case 'completed':
          return pipelineSummary(state, paths);
        default:
          return pipelineSummary(state, paths);
      }
    }
  } catch (error) {
    state = await loadDurableJob(context, jobId, options).catch(() => state);
    state = await recordFailure(context, paths, state, error, dependencies, options);
    if (input.throwOnFailure === true) throw error;
    return pipelineSummary(state, paths);
  }
}

/**
 * Run or resume one accepted per-edit Save through the complete owner-alpha pipeline.
 * A single store-wide flock is held for the whole automatic job, including source/Git effects.
 */
export async function runOwnerAlphaPipeline(input = {}, dependencyOverrides = {}) {
  const config = validateOwnerAlphaConfig(input.config);
  const projectRoot = input.projectRoot ?? DEFAULT_OWNER_ALPHA_PROJECT_ROOT;
  const context = input.context ?? storeContextFromConfig(config, projectRoot);
  const dependencies = validateDependencies(dependencySet({
    ...dependencyOverrides,
    ...(input.dependencies ?? {}),
  }));
  const jobId = validateJobId(input.jobId);
  return withFileLock(context, PIPELINE_MUTATION_LOCK, async (mutationLock) => executeLocked(
    { ...input, jobId, mutationLock },
    config,
    context,
    dependencies,
  ));
}

export async function resumeOwnerAlphaPipeline(input = {}, dependencyOverrides = {}) {
  return runOwnerAlphaPipeline(input, dependencyOverrides);
}

export async function getOwnerAlphaJob({ config: configInput, projectRoot, context, jobId } = {}) {
  const config = validateOwnerAlphaConfig(configInput);
  const store = context ?? storeContextFromConfig(
    config,
    projectRoot ?? DEFAULT_OWNER_ALPHA_PROJECT_ROOT,
  );
  const paths = pipelineArtifactPaths(jobId);
  const state = await loadDurableJob(store, jobId, artifactOptions(config));
  // Where the change came from: the owner's own edit, or an approved suggestion.
  const session = await optionalArtifact(store, paths.session, artifactOptions(config));
  let origin = null;
  if (session?.origin?.type === PAGE_BUNDLE_ORIGIN && typeof session.relativePath === 'string') {
    origin = { type: PAGE_BUNDLE_ORIGIN, bundleId: session.origin.bundleId, relativePath: session.relativePath };
  } else if (session && typeof session.relativePath === 'string') {
    origin = session.origin?.type === 'approved-proposal' && typeof session.origin.queueId === 'string'
      ? { type: 'approved-proposal', queueId: session.origin.queueId, relativePath: session.relativePath }
      : { type: session.origin?.type === 'owner-publication' ? 'owner-publication' : 'owner-edit', relativePath: session.relativePath };
  }
  const filename = session?.relativePath?.split('/').at(-1)?.replace(/\.md$/u, '');
  const found = findFrontmatterInText(session?.source?.text ?? '');
  const titleLine = found.yamlText?.match(/^title:[ \t]*([^\r\n]+)$/mu)?.[1];
  const title = titleLine?.trim().replace(/^(["'])(.*)\1$/u, '$2') || filename;
  const page = session && typeof session.slug === 'string' ? { title: title || 'Your page', slug: session.slug } : null;
  const options = artifactOptions(config);
  const live = state.history.some(({ to }) => to === 'live-confirmed')
    ? await loadRecord(store, paths.live, 'owner-alpha-live-result', jobId, options) : null;
  let liveKind = null;
  if (live?.kind === 'new-page-live' && session?.origin?.type === PAGE_BUNDLE_ORIGIN) {
    const commit = await readStableDeploymentCommit(store, paths, jobId, options);
    if (commit && hasNewPageLiveProof(live, { commit, pages: session.pages, images: session.images })) liveKind = live.kind;
  } else if (live?.kind === 'no-visible-change') {
    const commit = await readStableDeploymentCommit(store, paths, jobId, options);
    const checks = await loadRecord(store, paths.preApplyChecks, 'owner-alpha-pre-apply-check-result', jobId, options);
    if (commit && hasStableLiveProof(live, { pageUrl: session?.liveUrl, commit, witness: checks?.rendered?.witnesses })) liveKind = live.kind;
  } else if (live?.oldWitnessAbsent === true && live.newWitnessUnique === true) {
    liveKind = 'text';
  }
  const liveConfirmedAt = liveKind ? state.history.findLast(({ to }) => to === 'live-confirmed')?.at ?? null : null;
  return deepFreeze({ ...pipelineSummary(state, paths), origin, page, ...(liveKind && { liveKind, liveConfirmedAt }) });
}

/** Narrow server adapter: durable acceptance precedes the automatic effect pipeline. */
export function createSaveHandler({ config: configInput, projectRoot, context, dependencies = {} } = {}) {
  const config = validateOwnerAlphaConfig(configInput);
  const root = projectRoot ?? DEFAULT_OWNER_ALPHA_PROJECT_ROOT;
  const store = context ?? storeContextFromConfig(config, root);

  function startEdit(input = {}) {
    const jobId = input.jobId ?? `OA-${randomUUID()}`;
    let settled = false;
    let resolveAccepted;
    let rejectAccepted;
    const accepted = new Promise((resolve, reject) => {
      resolveAccepted = resolve;
      rejectAccepted = reject;
    });
    const completion = runOwnerAlphaPipeline({
      ...input,
      jobId,
      config,
      projectRoot: root,
      context: store,
      onAccepted(summary) {
        settled = true;
        resolveAccepted(summary);
      },
    }, dependencies);
    completion.then(
      (summary) => {
        if (!settled) {
          rejectAccepted(new OwnerAlphaError(
            summary.failure?.code ?? 'save-not-accepted',
            summary.failure?.message ?? 'Save did not reach durable acceptance',
          ));
        }
      },
      (error) => {
        if (!settled) rejectAccepted(error);
      },
    );
    return Object.freeze({ jobId, accepted, completion });
  }

  return Object.freeze({
    startEdit,
    async saveEdit(input = {}) {
      return startEdit(input).accepted;
    },
    async runEdit(input = {}) {
      const jobId = input.jobId ?? `OA-${randomUUID()}`;
      return runOwnerAlphaPipeline({
        ...input,
        jobId,
        config,
        projectRoot: root,
        context: store,
      }, dependencies);
    },
    async resumeJob(input = {}) {
      return resumeOwnerAlphaPipeline({
        ...input,
        config,
        projectRoot: root,
        context: store,
      }, dependencies);
    },
    async getJob(jobId) {
      return getOwnerAlphaJob({ config, projectRoot: root, context: store, jobId });
    },
    // A pushed page bundle (bundle-lifecycle.js pushedBundleEvidence): record
    // it as a job and follow it through deployment and the live check.
    async trackBundle(evidence) {
      return runOwnerAlphaPipeline({
        jobId: bundleJobId(evidence?.session?.origin?.bundleId),
        pushedBundle: evidence,
        config,
        projectRoot: root,
        context: store,
      }, dependencies);
    },
  });
}

/** Default safe local derivative rebuild through the shared owner-site builder. */
export async function defaultLocalRebuild({
  config: configInput,
  projectRoot = DEFAULT_OWNER_ALPHA_PROJECT_ROOT,
  jobId,
  commit,
  sourcePath,
}) {
  const config = validateOwnerAlphaConfig(configInput);
  const head = await defaultGitRunner(config.repository.checkout, ['rev-parse', 'HEAD']);
  if (head !== commit) {
    fail(
      'local-rebuild-head-mismatch',
      'local rebuild checkout HEAD must equal the confirmed application commit',
    );
  }
  // A private site was just built from this commit as its "deployment":
  // reuse that build when it is still current instead of building twice.
  const rebuilt = isPrivateSite(config)
    ? await ensureOwnerSite({ config, projectRoot })
    : await rebuildOwnerSite({ config, projectRoot });
  if (rebuilt.manifest.source.head !== commit) {
    fail(
      'local-rebuild-manifest-mismatch',
      'local owner site manifest must bind the confirmed application commit',
    );
  }
  return deepFreeze({
    status: 'local-rebuilt',
    jobId,
    commit,
    sourcePath,
    renderer: rebuilt.manifest.renderer.name,
    rendererRevision: rebuilt.manifest.renderer.revision,
    publishedCount: rebuilt.manifest.publication.selectedFiles,
    projectionVerified: rebuilt.manifest.projection.verification.ok,
    sourceBytesIdentical: rebuilt.manifest.projection.bytePreserving.ok,
    policyRevision: rebuilt.manifest.policyRevision,
  });
}

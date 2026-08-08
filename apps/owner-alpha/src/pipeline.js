import { randomUUID } from 'node:crypto';
import { applyAcceptedOperation } from './apply.js';
import { createJsonArtifactOnce, readJsonArtifact } from './artifacts.js';
import { runPreApplyChecks } from './checks.js';
import { computePolicyRevision, validateOwnerAlphaConfig } from './config.js';
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
import { confirmLivePage } from './live-confirm.js';
import { applyEditorOperation, deriveEditorOperation } from './operation.js';
import {
  DEFAULT_OWNER_ALPHA_PROJECT_ROOT,
  rebuildOwnerSite,
} from './site.js';
import { assertCheckoutReady, createEditSession, defaultGitRunner } from './source.js';
import { storeContextFromConfig } from './store.js';

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
    correction: {
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
  const candidateBytes = dependencies.applyEditorOperation(session, operation);
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

async function executeLocked(input, config, context, dependencies) {
  const jobId = validateJobId(input.jobId);
  const paths = pipelineArtifactPaths(jobId);
  const options = artifactOptions(config);
  const policyRevision = computePolicyRevision(config);
  let bindings = null;
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
  if (TERMINAL_NO_RESUME.has(state.state)) return pipelineSummary(state, paths);
  if (state.state === 'accepted') {
    bindings ??= await boundInputs(input, config, context, paths, dependencies, options);
    if (typeof input.onAccepted === 'function') {
      input.onAccepted(pipelineSummary(state, paths));
    }
  }

  let checks = null;
  let application = null;
  let committed = null;
  let pushed = null;
  let runBinding = null;
  let enteredApplying = false;

  try {
    while (true) {
      switch (state.state) {
        case 'accepted':
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
        case 'pushing': {
          const durableApplication = await loadRecord(context, paths.sourceApplied, 'owner-alpha-source-applied-effect', jobId, options);
          committed = await loadRecord(context, paths.committed, 'owner-alpha-committed-effect', jobId, options);
          if (durableApplication === null || committed === null) {
            fail('publication-evidence-missing', 'push phase requires durable source and commit evidence');
          }
          application = deserializeApplication(durableApplication);
          pushed = await loadRecord(context, paths.pushed, 'owner-alpha-pushed-effect', jobId, options);
          if (pushed === null) {
            pushed = await dependencies.pushExactCommit({
              checkout: config.repository.checkout,
              application,
              commit: committed.commit,
              remote: config.repository.remote.name,
              remoteUrl: config.repository.remote.url,
              branch: config.repository.branch,
              useHooks: config.git.useHooks,
            }, input.gitDependencies);
            pushed = await saveRecord(
              context,
              paths.pushed,
              'owner-alpha-pushed-effect',
              jobId,
              pushed,
              options,
            );
          }
          state = await transition(context, state, 'pushed', 'exact-push-durable', dependencies);
          break;
        }
        case 'pushed':
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
          bindings ??= await boundInputs(input, config, context, paths, dependencies, options);
          checks ??= await loadRecord(context, paths.preApplyChecks, 'owner-alpha-pre-apply-check-result', jobId, options);
          if (checks === null) fail('pre-apply-evidence-missing', 'live verification requires durable rendered witnesses');
          let live = await loadRecord(context, paths.live, 'owner-alpha-live-result', jobId, options);
          if (live === null) {
            const witnesses = checks.rendered?.witnesses;
            if (typeof witnesses?.old !== 'string' || typeof witnesses?.new !== 'string') {
              fail('live-witness-evidence-missing', 'pre-apply checks did not persist exact old/new live witnesses');
            }
            live = await dependencies.confirmLivePage({
              config,
              pageUrl: bindings.session.liveUrl,
              oldWitness: witnesses.old,
              newWitness: witnesses.new,
              signal: input.signal,
            }, input.liveDependencies);
            live = await saveRecord(
              context,
              paths.live,
              'owner-alpha-live-result',
              jobId,
              live,
              options,
            );
          }
          state = await transition(context, state, 'live-confirmed', 'live-visible-witness-confirmed', dependencies);
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
          bindings ??= await boundInputs(input, config, context, paths, dependencies, options);
          if (committed === null) fail('committed-evidence-missing', 'local rebuild requires durable commit evidence');
          let rebuild = await loadRecord(context, paths.localRebuild, 'owner-alpha-local-rebuild-effect', jobId, options);
          if (rebuild === null) {
            rebuild = await dependencies.rebuildLocal({
              config,
              projectRoot: context.projectRoot,
              jobId,
              commit: committed.commit,
              sourcePath: bindings.session.relativePath,
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
  const state = await loadDurableJob(store, jobId, artifactOptions(config));
  return pipelineSummary(state, pipelineArtifactPaths(jobId));
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
  const rebuilt = await rebuildOwnerSite({ config, projectRoot });
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

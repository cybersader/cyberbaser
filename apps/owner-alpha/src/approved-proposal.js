// The approved-proposal input adapter: the first place an owner decision
// touches the owner side, and deliberately the smallest one.
//
// It consumes one immutable Approve decision, re-checks that the pinned
// source is still exactly what the owner reviewed at the configured branch
// tip, and writes one create-once input artifact under the private owner
// store. The artifact carries an explicit, unfilled application gate and an
// all-false effect boundary. Nothing consumes it: no job, no edit session, no
// application, no Git mutation, no publication. A separately selected owner
// application-authority event is still required before any of that exists.

import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { applyProposal, classifyProposal } from '@cyberbaser/proposal';
import { serializeOwnerDecision, validateOwnerDecision } from '@cyberbaser/proposal-review';
import { digestBytes, validateDigest, validateQueueId } from '@cyberbaser/proposal-queue';
import { createJsonArtifactOnce } from './artifacts.js';
import { validateOwnerAlphaConfig } from './config.js';
import { fail, OwnerAlphaError } from './errors.js';
import { withFileLock } from './flock.js';
import { canonicalJson, deepFreeze, isPlainObject } from './json.js';
import {
  assertPrivateDirectory,
  readPrivateFile,
  recoverProposalDecisions,
} from './proposal-decisions.js';
import {
  defaultProposalReviewGit,
  exactObjectId,
  literalPathspec,
  parseTreeEntry,
  readBlob,
  readTrustPolicy,
  runGit,
  trimFinalLf,
  validateCheckout,
} from './proposal-review.js';
import {
  assertNoSymlinkComponents,
  prepareStore,
  prepareStoreParent,
  resolveStorePath,
} from './store.js';

export const APPROVED_INPUT_SCHEMA_VERSION = 1;
export const APPROVED_INPUT_ARTIFACT_TYPE = 'owner-alpha-approved-proposal-input';
export const APPROVED_INPUT_ROOT = 'proposal-inputs';
export const APPROVED_INPUT_LOCK = `${APPROVED_INPUT_ROOT}/.input.lock`;
export const APPROVED_INPUT_MAX_BYTES = 2 * 1024 * 1024;
export const APPROVED_INPUT_AUTHORIZATION_STATE = 'not-authorized';
export const APPROVED_INPUT_STALE_REASONS = Object.freeze([
  'revision-unreachable',
  'source-missing',
  'source-changed',
  'trust-policy-changed',
]);

const INPUT_FILE_RE = /^(Q-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/u;
const UTC_SECOND_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u;
const REGULAR_BLOB_MODES = new Set(['100644', '100755']);
const GIT_OBJECT_ID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const EFFECT_KEYS = ['appliesSource', 'writesSource', 'commits', 'pushes', 'deploys', 'publishes', 'rebuilds'];
const AUTHORIZATION_NOTE = 'A separately selected owner application-authority event must reference this input before any source application. Nothing consumes this artifact.';

function exactObject(value, keys, label) {
  if (!isPlainObject(value)) fail('invalid-approved-input', `${label} must be an object`);
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  const missing = keys.filter((key) => !Object.hasOwn(value, key));
  if (unknown.length > 0 || missing.length > 0) {
    fail('invalid-approved-input', `${label} must contain its exact fields`, {
      unknown: unknown.sort(),
      missing: missing.sort(),
    });
  }
  return value;
}

function exactString(value, label, maximum = 4096) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value
    || Buffer.byteLength(value, 'utf8') > maximum || /\p{Cc}/u.test(value)) {
    fail('invalid-approved-input', `${label} must be one bounded exact string`);
  }
  return value;
}

function exactInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail('invalid-approved-input', `${label} must be a non-negative safe integer`);
  return value;
}

function utcSecond(value, label) {
  if (typeof value !== 'string' || !UTC_SECOND_RE.test(value) || !Number.isFinite(Date.parse(value))) {
    fail('invalid-approved-input', `${label} must use canonical UTC second precision`);
  }
  return value;
}

function digestField(value, label) {
  try {
    return validateDigest(value, label);
  } catch (error) {
    fail('invalid-approved-input', `${label} is not a valid digest`, { cause: error?.code ?? 'unknown' });
  }
}

function decisionDigest(decision) {
  return digestBytes(Buffer.from(serializeOwnerDecision(decision), 'utf8'));
}

/**
 * Validate one approved-proposal input artifact. The shape is closed, the
 * authorization state must be the unfilled gate, and every effect flag must
 * be false, so a consumer can never mistake this record for an authorization.
 */
export function validateApprovedProposalInput(value) {
  exactObject(value, [
    'schemaVersion', 'artifactType', 'queueId', 'preparedAt', 'decision', 'proposal',
    'source', 'operation', 'candidate', 'trustPolicy', 'applicationGate', 'effectBoundary',
  ], 'approved proposal input');
  if (value.schemaVersion !== APPROVED_INPUT_SCHEMA_VERSION || value.artifactType !== APPROVED_INPUT_ARTIFACT_TYPE) {
    fail('invalid-approved-input', 'approved proposal input schema or artifact type is unsupported');
  }
  let queueId;
  try {
    queueId = validateQueueId(value.queueId);
  } catch (error) {
    fail('invalid-approved-input', 'approved proposal input queueId is invalid', { cause: error?.code ?? 'unknown' });
  }
  exactObject(value.decision, ['digest', 'decidedAt', 'reviewEvidenceDigest', 'authority'], 'input decision');
  exactObject(value.decision.authority, ['type', 'identity'], 'input decision authority');
  if (value.decision.authority.type !== 'owner-alpha-local') fail('invalid-approved-input', 'decision authority must be owner-alpha-local');
  exactObject(value.proposal, ['proposalId', 'proposalDigest', 'lane', 'tier', 'route'], 'input proposal');
  exactObject(value.source, ['repository', 'path', 'revision', 'branch', 'branchTip', 'gitMode', 'gitObjectId', 'baseByteLength', 'baseDigest'], 'input source');
  exactObject(value.operation, ['type', 'start', 'end', 'expectedOldBytesBase64', 'replacementBytesBase64'], 'input operation');
  exactObject(value.candidate, ['byteLength', 'digest'], 'input candidate');
  exactObject(value.trustPolicy, ['status', 'digest'], 'input trust policy');
  exactObject(value.applicationGate, ['state', 'event', 'note'], 'input application gate');
  if (value.applicationGate.state !== APPROVED_INPUT_AUTHORIZATION_STATE || value.applicationGate.event !== null) {
    fail('invalid-approved-input', 'approved proposal input must carry the unfilled application gate');
  }
  exactObject(value.effectBoundary, EFFECT_KEYS, 'input effect boundary');
  for (const key of EFFECT_KEYS) {
    if (value.effectBoundary[key] !== false) fail('invalid-approved-input', `effectBoundary.${key} must be false`);
  }
  if (!['offset', 'quote'].includes(value.operation.type)) fail('invalid-approved-input', 'operation type is unsupported');
  if (!GIT_OBJECT_ID_RE.test(value.source.revision) || !GIT_OBJECT_ID_RE.test(value.source.branchTip)
    || !GIT_OBJECT_ID_RE.test(value.source.gitObjectId) || !REGULAR_BLOB_MODES.has(value.source.gitMode)) {
    fail('invalid-approved-input', 'source Git identity is invalid');
  }
  if (!['valid', 'missing', 'malformed'].includes(value.trustPolicy.status)
    || (value.trustPolicy.status === 'valid') !== (value.trustPolicy.digest !== null)) {
    fail('invalid-approved-input', 'trust policy evidence is inconsistent');
  }
  const start = exactInteger(value.operation.start, 'operation.start');
  const end = exactInteger(value.operation.end, 'operation.end');
  if (end < start || end > exactInteger(value.source.baseByteLength, 'source.baseByteLength')) {
    fail('invalid-approved-input', 'operation span must lie inside the base');
  }
  return deepFreeze({
    schemaVersion: APPROVED_INPUT_SCHEMA_VERSION,
    artifactType: APPROVED_INPUT_ARTIFACT_TYPE,
    queueId,
    preparedAt: utcSecond(value.preparedAt, 'preparedAt'),
    decision: {
      digest: digestField(value.decision.digest, 'decision.digest'),
      decidedAt: utcSecond(value.decision.decidedAt, 'decision.decidedAt'),
      reviewEvidenceDigest: digestField(value.decision.reviewEvidenceDigest, 'decision.reviewEvidenceDigest'),
      authority: { type: 'owner-alpha-local', identity: exactString(value.decision.authority.identity, 'decision.authority.identity', 1024) },
    },
    proposal: {
      proposalId: exactString(value.proposal.proposalId, 'proposal.proposalId', 1024),
      proposalDigest: digestField(value.proposal.proposalDigest, 'proposal.proposalDigest'),
      lane: exactString(value.proposal.lane, 'proposal.lane', 64),
      tier: exactString(value.proposal.tier, 'proposal.tier', 256),
      route: exactString(value.proposal.route, 'proposal.route', 64),
    },
    source: {
      repository: exactString(value.source.repository, 'source.repository'),
      path: exactString(value.source.path, 'source.path'),
      revision: value.source.revision,
      branch: exactString(value.source.branch, 'source.branch', 1024),
      branchTip: value.source.branchTip,
      gitMode: value.source.gitMode,
      gitObjectId: value.source.gitObjectId,
      baseByteLength: value.source.baseByteLength,
      baseDigest: digestField(value.source.baseDigest, 'source.baseDigest'),
    },
    operation: {
      type: value.operation.type,
      start,
      end,
      expectedOldBytesBase64: typeof value.operation.expectedOldBytesBase64 === 'string' ? value.operation.expectedOldBytesBase64 : fail('invalid-approved-input', 'operation.expectedOldBytesBase64 must be a string'),
      replacementBytesBase64: typeof value.operation.replacementBytesBase64 === 'string' ? value.operation.replacementBytesBase64 : fail('invalid-approved-input', 'operation.replacementBytesBase64 must be a string'),
    },
    candidate: {
      byteLength: exactInteger(value.candidate.byteLength, 'candidate.byteLength'),
      digest: digestField(value.candidate.digest, 'candidate.digest'),
    },
    trustPolicy: {
      status: value.trustPolicy.status,
      digest: value.trustPolicy.digest === null ? null : digestField(value.trustPolicy.digest, 'trustPolicy.digest'),
    },
    applicationGate: {
      state: APPROVED_INPUT_AUTHORIZATION_STATE,
      event: null,
      note: exactString(value.applicationGate.note, 'applicationGate.note'),
    },
    effectBoundary: Object.fromEntries(EFFECT_KEYS.map((key) => [key, false])),
  });
}

function stale(reason, details) {
  return deepFreeze({ eligible: false, reason, ...details });
}

/**
 * Re-check one approved decision against the live checkout without writing
 * anything. Strict rule: the blob at the configured branch tip must be the
 * exact object the owner reviewed, and the trust policy must be unchanged.
 * Anything else is stale and is never rebased or re-resolved here.
 */
export async function assessApprovedProposal({
  config: configInput,
  decision: decisionInput,
  git = defaultProposalReviewGit,
} = {}) {
  const config = validateOwnerAlphaConfig(configInput);
  let decision;
  try {
    decision = validateOwnerDecision(decisionInput);
  } catch (error) {
    fail('invalid-approved-decision', 'approved proposal assessment requires one valid owner decision', { cause: error?.code ?? 'unknown' });
  }
  if (decision.action !== 'approve') fail('decision-not-approval', 'only an Approve decision can prepare an input', { queueId: decision.queueId });
  const evidence = decision.reviewEvidence;
  const { proposal } = evidence;
  if (proposal.source.repository !== config.repository.remote.url) {
    fail('input-repository-mismatch', 'approved proposal repository does not match owner policy');
  }

  const checkout = await validateCheckout(config, git);
  const branch = config.repository.branch;
  const revision = exactObjectId(proposal.source.revision, 'approved proposal source revision');
  const branchTip = trimFinalLf(
    await runGit(git, checkout, ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`]),
    'configured branch tip',
  );
  exactObjectId(branchTip, 'configured branch tip');

  let mergeBase = null;
  try {
    mergeBase = trimFinalLf(await runGit(git, checkout, ['merge-base', revision, branchTip]), 'approved revision merge base');
  } catch (error) {
    if (!(error instanceof OwnerAlphaError) || error.code !== 'review-git-failed') throw error;
  }
  if (mergeBase !== revision) return stale('revision-unreachable', { branchTip });

  const sourcePath = proposal.source.path;
  const pinned = parseTreeEntry(
    await runGit(git, checkout, ['ls-tree', '-z', revision, '--', literalPathspec(sourcePath)]),
    sourcePath,
    'approved pinned source tree entry',
  );
  if (pinned.type !== 'blob' || !REGULAR_BLOB_MODES.has(pinned.mode)) {
    fail('input-pinned-source-invalid', 'the reviewed source is not one regular Git blob at its pinned revision');
  }
  const current = parseTreeEntry(
    await runGit(git, checkout, ['ls-tree', '-z', branchTip, '--', literalPathspec(sourcePath)]),
    sourcePath,
    'approved current source tree entry',
    { allowMissing: true },
  );
  if (current === null) return stale('source-missing', { branchTip });
  if (current.type !== 'blob' || current.objectId !== pinned.objectId || current.mode !== pinned.mode) {
    return stale('source-changed', { branchTip });
  }

  const baseBytes = await readBlob(git, checkout, current.objectId, 'approved source blob', config.limits.maxSourceBytes);
  if (digestBytes(baseBytes) !== proposal.operation.baseDigest) {
    fail('input-base-digest-mismatch', 'the current blob does not match the reviewed base digest');
  }
  let candidate;
  try {
    candidate = applyProposal(baseBytes, proposal);
  } catch (error) {
    fail('input-application-failed', 'the approved proposal no longer applies to its base', { cause: error?.code ?? 'unknown' });
  }
  const candidateDigest = digestBytes(candidate);
  if (candidateDigest !== proposal.operation.candidateDigest) {
    fail('input-candidate-mismatch', 'replaying the approved proposal did not reproduce the reviewed candidate');
  }

  const policy = await readTrustPolicy(git, checkout, branchTip);
  if (policy.status !== evidence.classification.policyStatus || policy.digest !== evidence.classification.policyDigest) {
    return stale('trust-policy-changed', { branchTip });
  }
  const classification = classifyProposal(baseBytes, proposal, policy.config, evidence.classification.verifiedSubject);
  if (canonicalJson(classification) !== canonicalJson(evidence.classification.classification)) {
    fail('input-classification-mismatch', 'recomputed classification does not match the reviewed classification');
  }

  return deepFreeze({
    eligible: true,
    reason: null,
    branchTip,
    source: {
      gitMode: current.mode,
      gitObjectId: current.objectId,
      baseByteLength: baseBytes.length,
    },
    candidate: { byteLength: candidate.length, digest: candidateDigest },
    trustPolicy: { status: policy.status, digest: policy.digest },
  });
}

function createInput({ decision, assessment, preparedAt, branch }) {
  const evidence = decision.reviewEvidence;
  const { proposal } = evidence;
  return validateApprovedProposalInput({
    schemaVersion: APPROVED_INPUT_SCHEMA_VERSION,
    artifactType: APPROVED_INPUT_ARTIFACT_TYPE,
    queueId: decision.queueId,
    preparedAt,
    decision: {
      digest: decisionDigest(decision),
      decidedAt: decision.decidedAt,
      reviewEvidenceDigest: decision.reviewEvidenceDigest,
      authority: { type: decision.decisionAuthority.type, identity: decision.decisionAuthority.identity },
    },
    proposal: {
      proposalId: proposal.proposalId,
      proposalDigest: evidence.receipt.proposalDigest,
      lane: evidence.receipt.lane,
      tier: evidence.classification.classification.tier,
      route: evidence.classification.classification.route,
    },
    source: {
      repository: proposal.source.repository,
      path: proposal.source.path,
      revision: proposal.source.revision,
      branch,
      branchTip: assessment.branchTip,
      gitMode: assessment.source.gitMode,
      gitObjectId: assessment.source.gitObjectId,
      baseByteLength: assessment.source.baseByteLength,
      baseDigest: proposal.operation.baseDigest,
    },
    operation: {
      type: proposal.operation.type,
      start: proposal.operation.start,
      end: proposal.operation.end,
      expectedOldBytesBase64: proposal.operation.expectedOldBytesBase64,
      replacementBytesBase64: proposal.operation.replacementBytesBase64,
    },
    candidate: assessment.candidate,
    trustPolicy: assessment.trustPolicy,
    applicationGate: { state: APPROVED_INPUT_AUTHORIZATION_STATE, event: null, note: AUTHORIZATION_NOTE },
    effectBoundary: Object.fromEntries(EFFECT_KEYS.map((key) => [key, false])),
  });
}

function preparedTime(clock) {
  const value = clock();
  const milliseconds = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(milliseconds)) fail('invalid-input-clock', 'approved proposal clock is invalid');
  return new Date(milliseconds).toISOString().replace(/\.\d{3}Z$/u, 'Z');
}

async function prepareInputLayout(context) {
  await prepareStore(context);
  const root = resolveStorePath(context, APPROVED_INPUT_ROOT);
  await prepareStoreParent(context, resolveStorePath(context, `${APPROVED_INPUT_ROOT}/.layout`));
  await assertNoSymlinkComponents(context, root);
  await assertPrivateDirectory(root, 'approved proposal input root');
  return root;
}

function inputPath(queueId) {
  return `${APPROVED_INPUT_ROOT}/${queueId}.json`;
}

async function readInput(context, queueId) {
  const bytes = await readPrivateFile(
    resolveStorePath(context, inputPath(queueId)),
    `${queueId}.json`,
    APPROVED_INPUT_MAX_BYTES,
  );
  if (bytes === undefined) return null;
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail('invalid-approved-input', `${queueId}.json is not strict JSON`);
  }
  const input = validateApprovedProposalInput(parsed);
  if (input.queueId !== queueId) fail('invalid-approved-input', 'approved proposal input filename does not match its queue ID');
  return input;
}

/**
 * Prepare (or replay) the input artifact for one approved decision.
 *
 * Returns `{ prepared, replayed, input, eligibility }`. An existing artifact
 * is returned unchanged with a fresh eligibility check against the current
 * branch tip, so the owner can see whether a prepared input has gone stale
 * without anything being rewritten.
 */
export async function prepareApprovedProposalInput({
  context,
  config: configInput,
  queueId: queueIdInput,
  git = defaultProposalReviewGit,
  clock = () => new Date(),
} = {}) {
  if (!context) fail('invalid-input-dependency', 'approved proposal preparation requires a store context');
  const config = validateOwnerAlphaConfig(configInput);
  let queueId;
  try {
    queueId = validateQueueId(queueIdInput);
  } catch (error) {
    fail('invalid-input-queue-id', 'approved proposal queueId is invalid', { cause: error?.code ?? 'unknown' });
  }
  return withFileLock(context, APPROVED_INPUT_LOCK, async () => {
    await prepareInputLayout(context);
    const recovered = await recoverProposalDecisions(context);
    const decision = recovered.decisions.find((item) => item.queueId === queueId) ?? null;
    if (decision === null) fail('decision-not-found', 'no immutable owner decision exists for this proposal', { queueId });
    if (decision.action !== 'approve') fail('decision-not-approval', 'only an Approve decision can prepare an input', { queueId });
    const digest = decisionDigest(decision);

    const existing = await readInput(context, queueId);
    if (existing !== null) {
      if (existing.decision.digest !== digest) {
        fail('input-decision-mismatch', 'the prepared input references a different decision record', { queueId });
      }
      const eligibility = await assessApprovedProposal({ config, decision, git });
      return deepFreeze({
        prepared: true,
        replayed: true,
        input: existing,
        eligibility: { eligible: eligibility.eligible, reason: eligibility.reason, branchTip: eligibility.branchTip },
      });
    }

    const assessment = await assessApprovedProposal({ config, decision, git });
    if (!assessment.eligible) {
      return deepFreeze({
        prepared: false,
        replayed: false,
        input: null,
        eligibility: { eligible: false, reason: assessment.reason, branchTip: assessment.branchTip },
      });
    }
    const input = createInput({
      decision,
      assessment,
      preparedAt: preparedTime(clock),
      branch: config.repository.branch,
    });
    try {
      await createJsonArtifactOnce(context, inputPath(queueId), input, { maxBytes: APPROVED_INPUT_MAX_BYTES });
    } catch (error) {
      if (!(error instanceof OwnerAlphaError) || error.code !== 'artifact-already-exists') throw error;
      const winner = await readInput(context, queueId);
      if (winner === null || winner.decision.digest !== digest) {
        fail('input-decision-mismatch', 'a different input won the create-once race', { queueId });
      }
      return deepFreeze({
        prepared: true,
        replayed: true,
        input: winner,
        eligibility: { eligible: true, reason: null, branchTip: assessment.branchTip },
      });
    }
    return deepFreeze({
      prepared: true,
      replayed: false,
      input,
      eligibility: { eligible: true, reason: null, branchTip: assessment.branchTip },
    });
  });
}

/** List every prepared input, failing closed on any unexpected entry. */
export async function listApprovedProposalInputs(context) {
  if (!context) fail('invalid-input-dependency', 'listing approved proposal inputs requires a store context');
  return withFileLock(context, APPROVED_INPUT_LOCK, async () => {
    const root = await prepareInputLayout(context);
    const entries = await readdir(root, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    const inputs = [];
    for (const entry of entries) {
      if (entry.name === '.input.lock') continue;
      const match = entry.name.match(INPUT_FILE_RE);
      if (!match || entry.isSymbolicLink() || !entry.isFile()) {
        fail('unsafe-input-entry', 'approved proposal input root contains an unexpected entry', { entry: entry.name });
      }
      inputs.push(await readInput(context, match[1]));
    }
    return Object.freeze(inputs.filter((input) => input !== null));
  });
}

export function approvedProposalInputPath(context, queueId) {
  return resolveStorePath(context, inputPath(validateQueueId(queueId)));
}

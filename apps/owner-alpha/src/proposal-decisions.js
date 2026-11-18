import { constants } from 'node:fs';
import {
  lstat,
  open,
  readdir,
  rm,
} from 'node:fs/promises';
import path from 'node:path';
import {
  OWNER_DECISION_MAX_BYTES,
  OWNER_DECISION_REASON_MAX_BYTES,
  OWNER_IDENTITY_MAX_BYTES,
  createOwnerDecision,
  createReviewSummary,
  parseOwnerDecision,
  validateOwnerDecision,
  validateReviewEvidence,
  validateReviewSummary,
} from '@cyberbaser/proposal-review';
import {
  validateDigest,
  validateQueueId,
} from '@cyberbaser/proposal-queue';
import {
  createJsonArtifactOnce,
  replaceJsonArtifactAtomic,
} from './artifacts.js';
import { fail, OwnerAlphaError } from './errors.js';
import { withFileLock } from './flock.js';
import {
  artifactJson,
  canonicalJson,
  deepFreeze,
  isPlainObject,
} from './json.js';
import {
  assertNoSymlinkComponents,
  prepareStore,
  prepareStoreParent,
  resolveStorePath,
} from './store.js';

export const PROPOSAL_DECISION_INDEX_SCHEMA_VERSION = 1;
export const PROPOSAL_DECISION_INDEX_ARTIFACT_TYPE = 'owner-alpha-proposal-decision-index';
export const PROPOSAL_DECISION_ROOT = 'proposal-review';
export const PROPOSAL_DECISION_LOCK = `${PROPOSAL_DECISION_ROOT}/.decision.lock`;
export const PROPOSAL_DECISION_INDEX = `${PROPOSAL_DECISION_ROOT}/index.json`;
export const PROPOSAL_DECISION_MAX_INDEX_BYTES = 8 * 1024 * 1024;

const DECISIONS_DIRECTORY = `${PROPOSAL_DECISION_ROOT}/decisions`;
const DECISION_FILE_RE = /^(Q-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/u;
const INDEX_TEMP_RE = /^index\.json\.tmp-[1-9][0-9]*-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const UTC_SECOND_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u;

function exactObject(value, keys, label) {
  if (!isPlainObject(value)) fail('invalid-decision-input', `${label} must be an object`);
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  const missing = keys.filter((key) => !Object.hasOwn(value, key));
  if (unknown.length > 0 || missing.length > 0) {
    fail('invalid-decision-input', `${label} must contain its exact fields`, {
      unknown: unknown.sort(),
      missing: missing.sort(),
    });
  }
  return value;
}

function dependency(label, action) {
  try {
    return action();
  } catch (error) {
    if (error instanceof OwnerAlphaError) throw error;
    fail('invalid-proposal-decision', `${label} is invalid`, {
      cause: error?.code ?? error?.message ?? 'unknown',
    });
  }
}

function decisionPath(queueIdInput) {
  let queueId;
  try {
    queueId = validateQueueId(queueIdInput);
  } catch (error) {
    fail('invalid-decision-input', 'decision queueId is invalid', {
      cause: error?.code ?? 'unknown',
    });
  }
  return `${DECISIONS_DIRECTORY}/${queueId}.json`;
}

function normalizeIntent(value) {
  exactObject(value, ['queueId', 'reviewEvidenceDigest', 'action', 'reason'], 'decision intent');
  const relativePath = decisionPath(value.queueId);
  if (!['approve', 'reject'].includes(value.action)) {
    fail('invalid-decision-input', 'decision action must be approve or reject');
  }
  if (typeof value.reason !== 'string'
    || value.reason.trim() !== value.reason
    || value.reason.length === 0
    || Buffer.byteLength(value.reason, 'utf8') > OWNER_DECISION_REASON_MAX_BYTES
    || /\p{Cc}/u.test(value.reason)) {
    fail('invalid-decision-input', 'decision reason must be one bounded nonblank exact string');
  }
  let reviewEvidenceDigest;
  try {
    reviewEvidenceDigest = validateDigest(value.reviewEvidenceDigest, 'reviewEvidenceDigest');
  } catch (error) {
    fail('invalid-decision-input', 'decision reviewEvidenceDigest is invalid', {
      cause: error?.code ?? 'unknown',
    });
  }
  return deepFreeze({
    queueId: value.queueId,
    relativePath,
    reviewEvidenceDigest,
    action: value.action,
    reason: value.reason,
  });
}

function normalizeOwnerIdentity(value) {
  if (typeof value !== 'string'
    || value.trim() !== value
    || value.length === 0
    || Buffer.byteLength(value, 'utf8') > OWNER_IDENTITY_MAX_BYTES
    || /\p{Cc}/u.test(value)) {
    fail('invalid-decision-authority', 'owner identity must be one bounded exact nonblank string');
  }
  return value;
}

function decisionTime(clock) {
  const value = clock();
  const milliseconds = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(milliseconds)) fail('invalid-decision-clock', 'decision clock is invalid');
  const timestamp = new Date(milliseconds).toISOString().replace(/\.\d{3}Z$/u, 'Z');
  if (!UTC_SECOND_RE.test(timestamp)) fail('invalid-decision-clock', 'decision clock is invalid');
  return timestamp;
}

function decisionSummary(decisionInput) {
  const decision = dependency('owner proposal decision', () => validateOwnerDecision(decisionInput));
  const review = dependency('owner proposal decision summary', () => createReviewSummary(decision.reviewEvidence));
  return deepFreeze({
    queueId: decision.queueId,
    action: decision.action,
    reason: decision.reason,
    decidedAt: decision.decidedAt,
    reviewEvidenceDigest: decision.reviewEvidenceDigest,
    proposalId: review.proposalId,
    proposalDigest: review.proposalDigest,
    candidateDigest: review.candidateDigest,
    source: review.source,
    receivedAt: review.receivedAt,
    expiresAt: review.expiresAt,
    lane: review.lane,
    tier: review.tier,
    route: review.route,
  });
}

function createIndex(decisionsInput) {
  const decisions = [...decisionsInput]
    .map(decisionSummary)
    .sort((left, right) => left.queueId.localeCompare(right.queueId));
  return deepFreeze({
    schemaVersion: PROPOSAL_DECISION_INDEX_SCHEMA_VERSION,
    artifactType: PROPOSAL_DECISION_INDEX_ARTIFACT_TYPE,
    decisions,
  });
}

export async function assertPrivateDirectory(directory, label) {
  const metadata = await lstat(directory);
  if (metadata.isSymbolicLink()
    || !metadata.isDirectory()
    || (metadata.mode & 0o777) !== 0o700
    || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())
    || (typeof process.getgid === 'function' && metadata.gid !== process.getgid())) {
    fail('unsafe-decision-directory', `${label} must be one private runtime-owned real directory`);
  }
}

async function prepareDecisionLayout(context) {
  await prepareStore(context);
  const root = resolveStorePath(context, PROPOSAL_DECISION_ROOT);
  const decisions = resolveStorePath(context, DECISIONS_DIRECTORY);
  await prepareStoreParent(context, resolveStorePath(context, PROPOSAL_DECISION_INDEX));
  await prepareStoreParent(context, resolveStorePath(context, `${DECISIONS_DIRECTORY}/.layout`));
  await assertNoSymlinkComponents(context, root);
  await assertNoSymlinkComponents(context, decisions);
  await assertPrivateDirectory(root, 'proposal decision root');
  await assertPrivateDirectory(decisions, 'proposal decisions directory');
  return { root, decisions };
}

export async function readPrivateFile(file, label, maximum, { oversizeAsNull = false } = {}) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const metadata = await handle.stat();
    if (!metadata.isFile()
      || metadata.nlink !== 1
      || (metadata.mode & 0o777) !== 0o600
      || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())
      || (typeof process.getgid === 'function' && metadata.gid !== process.getgid())) {
      fail('unsafe-decision-artifact', `${label} must be one private runtime-owned regular file`);
    }
    if (metadata.size < 1 || metadata.size > maximum) {
      if (oversizeAsNull) return null;
      fail('decision-artifact-size', `${label} is empty or oversized`);
    }
    return await handle.readFile();
  } catch (error) {
    if (error instanceof OwnerAlphaError) throw error;
    if (error?.code === 'ENOENT') return undefined;
    if (error?.code === 'ELOOP') fail('unsafe-decision-artifact', `${label} must not be a symlink`);
    throw error;
  } finally {
    await handle?.close();
  }
}

async function removeSafeIndexTemporaries(root, entries) {
  for (const entry of entries) {
    if (!INDEX_TEMP_RE.test(entry.name)) continue;
    const file = path.join(root, entry.name);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      fail('unsafe-decision-entry', 'proposal decision root contains an unsafe index temporary');
    }
    const metadata = await lstat(file);
    if (metadata.nlink !== 1
      || (metadata.mode & 0o777) !== 0o600
      || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())
      || (typeof process.getgid === 'function' && metadata.gid !== process.getgid())) {
      fail('unsafe-decision-entry', 'proposal decision index temporary is not privately owned');
    }
    await rm(file);
  }
}

async function scanDecisions(context, layout) {
  const rootEntries = await readdir(layout.root, { withFileTypes: true });
  await removeSafeIndexTemporaries(layout.root, rootEntries);
  const allowedRoot = new Set(['.decision.lock', 'index.json', 'decisions']);
  for (const entry of await readdir(layout.root, { withFileTypes: true })) {
    if (!allowedRoot.has(entry.name)) {
      fail('unsafe-decision-entry', 'proposal decision root contains an unexpected entry', {
        entry: entry.name,
      });
    }
    if (entry.isSymbolicLink()
      || (entry.name === 'decisions' ? !entry.isDirectory() : !entry.isFile())) {
      fail('unsafe-decision-entry', 'proposal decision root contains an unsafe entry', {
        entry: entry.name,
      });
    }
  }

  const entries = await readdir(layout.decisions, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  const decisions = [];
  for (const entry of entries) {
    const match = entry.name.match(DECISION_FILE_RE);
    if (!match || entry.isSymbolicLink() || !entry.isFile()) {
      fail('unsafe-decision-entry', 'proposal decisions directory contains an unexpected entry', {
        entry: entry.name,
      });
    }
    const queueId = dependency('decision filename queueId', () => validateQueueId(match[1]));
    const file = resolveStorePath(context, `${DECISIONS_DIRECTORY}/${entry.name}`);
    const bytes = await readPrivateFile(file, entry.name, OWNER_DECISION_MAX_BYTES);
    const decision = dependency(entry.name, () => parseOwnerDecision(bytes));
    if (decision.queueId !== queueId) {
      fail('decision-filename-mismatch', 'proposal decision filename does not match its queue ID');
    }
    decisions.push(decision);
  }
  return decisions;
}

async function synchronizeIndex(context, decisions, maximum) {
  const value = createIndex(decisions);
  const expected = Buffer.from(artifactJson(value), 'utf8');
  if (expected.length > maximum) fail('decision-index-too-large', 'proposal decision index exceeds its byte limit');
  const file = resolveStorePath(context, PROPOSAL_DECISION_INDEX);
  const existing = await readPrivateFile(file, 'proposal decision index', maximum, {
    oversizeAsNull: true,
  });
  if (existing !== undefined && existing !== null && existing.equals(expected)) return value;
  if (existing === undefined) {
    await createJsonArtifactOnce(context, PROPOSAL_DECISION_INDEX, value, { maxBytes: maximum });
  } else {
    await replaceJsonArtifactAtomic(context, PROPOSAL_DECISION_INDEX, value, { maxBytes: maximum });
  }
  return value;
}

async function recoverUnlocked(context, { maxIndexBytes }) {
  const layout = await prepareDecisionLayout(context);
  const decisions = await scanDecisions(context, layout);
  const index = await synchronizeIndex(context, decisions, maxIndexBytes);
  return deepFreeze({ decisions: Object.freeze(decisions), index });
}

export async function recoverProposalDecisions(
  context,
  { maxIndexBytes = PROPOSAL_DECISION_MAX_INDEX_BYTES } = {},
) {
  if (!Number.isSafeInteger(maxIndexBytes) || maxIndexBytes < 1) {
    fail('invalid-decision-limit', 'maxIndexBytes must be a positive safe integer');
  }
  return withFileLock(context, PROPOSAL_DECISION_LOCK, () => recoverUnlocked(context, {
    maxIndexBytes,
  }));
}

function semanticallyMatches(decision, intent, ownerIdentity) {
  return decision.queueId === intent.queueId
    && decision.reviewEvidenceDigest === intent.reviewEvidenceDigest
    && decision.action === intent.action
    && decision.reason === intent.reason
    && decision.decisionAuthority.type === 'owner-alpha-local'
    && decision.decisionAuthority.identity === ownerIdentity;
}

export async function recordProposalDecision({
  context,
  source,
  ownerIdentity,
  intent: intentInput,
  clock = () => new Date(),
  maxIndexBytes = PROPOSAL_DECISION_MAX_INDEX_BYTES,
} = {}) {
  if (!context || !source || typeof source.load !== 'function') {
    fail('invalid-decision-dependency', 'proposal decision recording requires a store context and review source');
  }
  if (!Number.isSafeInteger(maxIndexBytes) || maxIndexBytes < 1) {
    fail('invalid-decision-limit', 'maxIndexBytes must be a positive safe integer');
  }
  const identity = normalizeOwnerIdentity(ownerIdentity);
  const intent = normalizeIntent(intentInput);
  return withFileLock(context, PROPOSAL_DECISION_LOCK, async () => {
    const recovered = await recoverUnlocked(context, { maxIndexBytes });
    const existing = recovered.decisions.find((decision) => decision.queueId === intent.queueId) ?? null;
    if (existing !== null) {
      if (semanticallyMatches(existing, intent, identity)) {
        return deepFreeze({ decision: existing, replayed: true, index: recovered.index });
      }
      fail('decision-already-recorded', 'an immutable owner decision already exists for this proposal', {
        queueId: intent.queueId,
      });
    }

    const validated = await source.load(intent.queueId);
    if (!validated?.evidence || !validated?.summary) {
      fail('decision-evidence-mismatch', 'decision source did not return validated review evidence');
    }
    dependency(
      'fresh proposal review summary',
      () => validateReviewSummary(validated.summary, validated.evidence),
    );
    if (validated.summary.queueId !== intent.queueId
      || validated.summary.reviewEvidenceDigest !== intent.reviewEvidenceDigest) {
      fail('decision-evidence-mismatch', 'decision intent does not match freshly validated review evidence');
    }
    const decision = dependency('new owner proposal decision', () => createOwnerDecision({
      action: intent.action,
      reason: intent.reason,
      decidedAt: decisionTime(clock),
      decisionAuthority: { type: 'owner-alpha-local', identity },
      reviewEvidence: validated.evidence,
    }));

    try {
      await createJsonArtifactOnce(context, intent.relativePath, decision, {
        maxBytes: OWNER_DECISION_MAX_BYTES,
      });
    } catch (error) {
      if (!(error instanceof OwnerAlphaError) || error.code !== 'artifact-already-exists') throw error;
      const winnerBytes = await readPrivateFile(
        resolveStorePath(context, intent.relativePath),
        path.basename(intent.relativePath),
        OWNER_DECISION_MAX_BYTES,
      );
      const winner = dependency('concurrent owner proposal decision', () => parseOwnerDecision(winnerBytes));
      if (!semanticallyMatches(winner, intent, identity)) {
        fail('decision-already-recorded', 'a contradictory owner decision won the create-once race');
      }
      const nextRecovered = await recoverUnlocked(context, { maxIndexBytes });
      return deepFreeze({ decision: winner, replayed: true, index: nextRecovered.index });
    }

    const decisions = [...recovered.decisions, decision];
    const index = await synchronizeIndex(context, decisions, maxIndexBytes);
    return deepFreeze({ decision, replayed: false, index });
  });
}

export function createProposalDecisionOverlay({ entries, decisions }) {
  if (!Array.isArray(entries) || !Array.isArray(decisions)) {
    fail('invalid-decision-overlay', 'decision overlay requires entry and decision arrays');
  }
  const current = new Map();
  for (const entry of entries) {
    if (!entry?.summary || !entry?.evidence) {
      fail('invalid-decision-overlay', 'current review entries must contain summary and evidence');
    }
    const evidence = dependency(
      'decision overlay review evidence',
      () => validateReviewEvidence(entry.evidence),
    );
    const summary = dependency(
      'decision overlay review summary',
      () => validateReviewSummary(entry.summary, evidence),
    );
    if (evidence.state.state !== 'pending-review') {
      fail('invalid-decision-overlay', 'current actionable review evidence must remain pending-review');
    }
    if (current.has(summary.queueId)) {
      fail('invalid-decision-overlay', 'current review entries contain a duplicate queue ID');
    }
    current.set(summary.queueId, deepFreeze({
      summary,
      evidence,
      sourceVerification: entry.sourceVerification ?? null,
    }));
  }

  const decided = new Map();
  for (const decisionInput of decisions) {
    const decision = dependency('decision overlay artifact', () => validateOwnerDecision(decisionInput));
    if (decided.has(decision.queueId)) {
      fail('invalid-decision-overlay', 'decision history contains a duplicate queue ID');
    }
    decided.set(decision.queueId, decision);
    const retained = current.get(decision.queueId);
    if (retained !== undefined
      && (retained.summary.reviewEvidenceDigest !== decision.reviewEvidenceDigest
        || canonicalJson(retained.evidence) !== canonicalJson(decision.reviewEvidence))) {
      fail('decision-evidence-conflict', 'retained queue evidence contradicts immutable owner history', {
        queueId: decision.queueId,
      });
    }
  }

  const actionable = [...current.values()]
    .filter((entry) => !decided.has(entry.summary.queueId))
    .sort((left, right) => (
      left.summary.receivedAt.localeCompare(right.summary.receivedAt)
      || left.summary.queueId.localeCompare(right.summary.queueId)
    ));
  const history = [...decided.values()]
    .sort((left, right) => (
      right.decidedAt.localeCompare(left.decidedAt)
      || left.queueId.localeCompare(right.queueId)
    ))
    .map((decision) => deepFreeze({
      decision,
      summary: decisionSummary(decision),
      queueRetained: current.has(decision.queueId),
    }));

  return deepFreeze({ actionable, history });
}

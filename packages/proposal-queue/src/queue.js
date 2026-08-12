import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { applyProposal, classifyProposal, parseProposal, proposalDigest, serializeProposal, validateProposal } from '@cyberbaser/proposal';
import { fail } from './errors.js';
import { createQueueFilesystem } from './filesystem.js';
import {
  addDays, canonicalMetadataBytes, createDurableCarrier, createPendingState, deepFreeze,
  digestBytes, exactObject, expireState, idempotencyDigests, isRecord,
  normalizeVerifiedSubject, parseCanonicalMetadata, utcSecond, validateCarrierInput,
  validateClassificationArtifact, validateDurableCarrier, validateIdempotencyInput,
  validatePolicyInput, validateProposalQueueConfig, validateQueueId, validateReceipt,
  validateStateArtifact,
} from './validation.js';

const OPEN_KEYS = Object.freeze(['config', 'clock', 'idFactory', 'filesystem', 'resolveEvidence']);
const INSPECT_KEYS = Object.freeze(['config', 'filesystem', 'resolveEvidence']);
const ENQUEUE_KEYS = Object.freeze(['proposalText', 'baseBytes', 'policy', 'verifiedSubject', 'carrier', 'idempotency']);
const EVIDENCE_KEYS = Object.freeze(['baseBytes', 'policy']);
const defaultClock = () => new Date().toISOString().replace(/\.\d{3}Z$/u, 'Z');

function queueIdFromFactory(idFactory) {
  const value = idFactory();
  if (typeof value !== 'string') fail('invalid-id-factory', 'idFactory must return a UUID string');
  return validateQueueId(value.startsWith('Q-') ? value : `Q-${value}`);
}
function exactBytes(value, label) {
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (value instanceof Uint8Array) return Buffer.from(value);
  fail('invalid-bytes', `${label} must be text or bytes`);
}
const sourcePartitionDigest = (proposal) => digestBytes(Buffer.from(`${proposal.source.repository}\0${proposal.source.path}`, 'utf8'));

export function proposalSemantics(value) {
  const proposal = typeof value === 'string' || value instanceof Uint8Array ? parseProposal(value) : validateProposal(value);
  return deepFreeze({
    source: { repository: proposal.source.repository, revision: proposal.source.revision, path: proposal.source.path },
    baseByteLength: proposal.operation.baseByteLength,
    baseDigest: proposal.operation.baseDigest,
    start: proposal.operation.start,
    end: proposal.operation.end,
    expectedOldBytesBase64: proposal.operation.expectedOldBytesBase64,
    replacementBytesBase64: proposal.operation.replacementBytesBase64,
    candidateByteLength: proposal.operation.candidateByteLength,
    candidateDigest: proposal.operation.candidateDigest,
  });
}

function createReceipt(input) {
  return validateReceipt({
    schemaVersion: 1,
    artifactType: 'cyberbaser-proposal-queue-receipt',
    queueId: input.queueId,
    lane: input.lane,
    receivedAt: input.receivedAt,
    expiresAt: input.expiresAt,
    proposalDigest: input.digest,
    proposalByteLength: input.proposalByteLength,
    requestDigest: input.requestDigest,
    idempotencyKeyDigest: input.idempotencyKeyDigest,
    sourcePartitionDigest: input.sourcePartition,
  });
}
function createClassificationArtifact(policy, verifiedSubject, classification) {
  return validateClassificationArtifact({
    schemaVersion: 1,
    artifactType: 'cyberbaser-proposal-queue-classification',
    policyStatus: policy.status,
    policyDigest: policy.digest,
    verifiedSubject,
    classification,
  });
}
function artifactBytes({ proposalBytes, receipt, carrier, classification, state }) {
  return {
    'proposal.json': proposalBytes,
    'receipt.json': canonicalMetadataBytes(receipt, validateReceipt),
    'carrier.json': canonicalMetadataBytes(carrier, validateDurableCarrier),
    'classification.json': canonicalMetadataBytes(classification, validateClassificationArtifact),
    'state.json': canonicalMetadataBytes(state, validateStateArtifact),
  };
}
const retainedBytes = (artifacts) => Object.values(artifacts).reduce((total, bytes) => total + bytes.length, 0);
function freezeEntry(entry) {
  return deepFreeze({
    queueId: entry.queueId, location: entry.location, proposalText: entry.proposalText,
    proposal: entry.proposal, receipt: entry.receipt, carrier: entry.carrier,
    classification: entry.classification, state: entry.state, semantics: entry.semantics,
    retainedBytes: entry.retainedBytes,
  });
}
function parseEntryArtifacts(queueId, location, artifacts) {
  const proposalBytes = artifacts['proposal.json'];
  const proposal = parseProposal(proposalBytes);
  const receipt = parseCanonicalMetadata(artifacts['receipt.json'], validateReceipt, 'receipt.json');
  const carrier = parseCanonicalMetadata(artifacts['carrier.json'], validateDurableCarrier, 'carrier.json');
  const classification = parseCanonicalMetadata(artifacts['classification.json'], validateClassificationArtifact, 'classification.json');
  const state = parseCanonicalMetadata(artifacts['state.json'], validateStateArtifact, 'state.json');
  if (receipt.queueId !== queueId || state.queueId !== queueId) fail('queue-id-mismatch', 'entry artifacts do not bind their directory identifier');
  if (receipt.lane !== carrier.lane) fail('queue-lane-mismatch', 'receipt and carrier lane disagree');
  if (receipt.proposalDigest !== proposalDigest(proposal) || receipt.proposalByteLength !== proposalBytes.length) fail('proposal-digest-mismatch', 'receipt does not bind the exact canonical proposal bytes');
  if (receipt.sourcePartitionDigest !== sourcePartitionDigest(proposal)) fail('source-partition-mismatch', 'receipt source partition does not match the proposal');
  if (state.createdAt !== receipt.receivedAt) fail('queue-time-mismatch', 'state creation must match receipt time');
  if (state.state === 'pending-review' && state.updatedAt !== receipt.receivedAt) fail('queue-time-mismatch', 'pending state update time must match receipt time');
  if (!Buffer.from(serializeProposal(proposal), 'utf8').equals(proposalBytes)) fail('noncanonical-proposal', 'proposal.json must contain exact canonical proposal bytes');
  return freezeEntry({
    queueId, location, proposalText: proposalBytes.toString('utf8'), proposal, receipt,
    carrier, classification, state, semantics: proposalSemantics(proposal),
    retainedBytes: retainedBytes(artifacts),
  });
}
async function readEntry(filesystem, root, location, queueId) {
  const directory = path.join(root, location, queueId);
  await filesystem.removeStateTemporaries(directory);
  return parseEntryArtifacts(queueId, location, await filesystem.readEntry(directory));
}
async function readEntryReadonly(filesystem, root, location, queueId) {
  const directory = path.join(root, location, queueId);
  return parseEntryArtifacts(queueId, location, await filesystem.readEntry(directory));
}
async function scanEntries(filesystem, config) {
  const entries = [];
  for (const location of ['pending', 'expired']) {
    for (const child of await filesystem.list(path.join(config.root, location))) {
      if (!child.isDirectory) fail('unsafe-queue-entry', `${location} may contain only real queue entry directories`);
      entries.push(await readEntry(filesystem, config.root, location, validateQueueId(child.name)));
    }
  }
  entries.sort((a, b) => a.receipt.receivedAt.localeCompare(b.receipt.receivedAt) || a.queueId.localeCompare(b.queueId));
  return entries;
}
async function scanEntriesReadonly(filesystem, config) {
  const entries = [];
  for (const location of ['pending', 'expired']) {
    for (const child of await filesystem.list(path.join(config.root, location))) {
      if (!child.isDirectory) fail('unsafe-queue-entry', `${location} may contain only real queue entry directories`);
      entries.push(await readEntryReadonly(
        filesystem,
        config.root,
        location,
        validateQueueId(child.name),
      ));
    }
  }
  entries.sort((a, b) => a.receipt.receivedAt.localeCompare(b.receipt.receivedAt) || a.queueId.localeCompare(b.queueId));
  return entries;
}
const compareJson = (left, right) => JSON.stringify(left) === JSON.stringify(right);
async function verifyEvidence(entry, resolveEvidence) {
  if (typeof resolveEvidence !== 'function') fail('recovery-evidence-required', 'opening a nonempty queue requires resolveEvidence()');
  const evidence = await resolveEvidence(entry);
  exactObject(evidence, EVIDENCE_KEYS, 'resolved queue evidence');
  const baseBytes = exactBytes(evidence.baseBytes, 'resolved baseBytes');
  const policy = validatePolicyInput(evidence.policy);
  if (policy.status !== entry.classification.policyStatus || policy.digest !== entry.classification.policyDigest) fail('policy-evidence-mismatch', 'resolved base policy does not match durable classification evidence');
  applyProposal(baseBytes, entry.proposal);
  const recomputed = classifyProposal(baseBytes, entry.proposal, policy.config, entry.classification.verifiedSubject);
  if (!compareJson(recomputed, entry.classification.classification)) fail('classification-mismatch', 'durable classification does not match recomputed proposal evidence');
}
function buildIndexes(entries) {
  const byId = new Map();
  const replay = new Map();
  for (const entry of entries) {
    if (byId.has(entry.queueId)) fail('duplicate-queue-id', `queue contains duplicate identifier ${entry.queueId}`);
    byId.set(entry.queueId, entry);
    if (entry.carrier.replayScope !== null) {
      if (replay.has(entry.carrier.replayScope)) fail('duplicate-replay-scope', 'queue contains an ambiguous acknowledged replay scope');
      replay.set(entry.carrier.replayScope, entry);
    }
    if (entry.location === 'pending' && entry.state.state !== 'pending-review') fail('ambiguous-queue-location', 'pending queue location contains an expired acknowledged entry');
    if (entry.location === 'expired' && entry.state.state !== 'expired') fail('ambiguous-queue-location', 'expired queue location contains a non-expired acknowledged entry');
  }
  return { byId, replay };
}
function snapshotStats(entries) {
  return deepFreeze({
    pendingEntries: entries.filter((entry) => entry.state.state === 'pending-review').length,
    expiredEntries: entries.filter((entry) => entry.state.state === 'expired').length,
    retainedBytes: entries.reduce((total, entry) => total + entry.retainedBytes, 0),
    sourcePartitions: new Set(entries.filter((entry) => entry.state.state === 'pending-review').map((entry) => entry.receipt.sourcePartitionDigest)).size,
  });
}
function admissionCheck(entries, sourceDigest, addedBytes, config) {
  const pending = entries.filter((entry) => entry.state.state === 'pending-review');
  if (pending.length >= config.maxPendingEntries) fail('queue-pending-capacity', 'proposal queue is at pending entry capacity');
  if (pending.filter((entry) => entry.receipt.sourcePartitionDigest === sourceDigest).length >= config.maxPendingPerSource) fail('queue-source-capacity', 'proposal source is at pending entry capacity');
  const bytes = entries.reduce((total, entry) => total + entry.retainedBytes, 0);
  if (bytes + addedBytes > config.maxRetainedBytes) fail('queue-retained-capacity', 'proposal queue is at retained byte capacity', { retainedBytes: bytes, addedBytes, maximum: config.maxRetainedBytes });
}
async function expireAndPurge({ filesystem, config, at }) {
  const now = Date.parse(utcSecond(at, 'retention time'));
  const expired = [];
  const purged = [];
  let entries = await scanEntries(filesystem, config);
  for (const entry of entries) {
    if (entry.location === 'pending' && entry.state.state === 'expired') {
      await filesystem.moveEntry(
        path.join(config.root, 'pending', entry.queueId),
        path.join(config.root, 'expired', entry.queueId),
      );
    }
  }
  entries = await scanEntries(filesystem, config);
  for (const entry of entries) {
    if (entry.state.state === 'pending-review' && Date.parse(entry.receipt.expiresAt) <= now) {
      const next = expireState(entry.state, entry.receipt.expiresAt);
      const source = path.join(config.root, 'pending', entry.queueId);
      await filesystem.replaceState(source, canonicalMetadataBytes(next, validateStateArtifact));
      await filesystem.moveEntry(source, path.join(config.root, 'expired', entry.queueId));
      expired.push(entry.queueId);
    }
  }
  entries = await scanEntries(filesystem, config);
  for (const entry of entries) {
    if (entry.state.state === 'expired' && Date.parse(addDays(entry.receipt.expiresAt, config.expiredGraceDays)) <= now) {
      const source = path.join(config.root, 'expired', entry.queueId);
      const staged = path.join(config.root, 'staging', `.purge-${entry.queueId}`);
      await filesystem.moveEntry(source, staged);
      await filesystem.removeTree(staged);
      purged.push(entry.queueId);
    }
  }
  return { entries: await scanEntries(filesystem, config), result: deepFreeze({ expired: Object.freeze(expired), purged: Object.freeze(purged) }) };
}
async function recover({ filesystem, config, resolveEvidence, clock }) {
  const staging = await filesystem.removeStaging(config.root);
  let entries = await scanEntries(filesystem, config);
  for (const entry of entries) await verifyEvidence(entry, resolveEvidence);
  for (const entry of entries) {
    if (entry.location === 'pending' && entry.state.state === 'expired') await filesystem.moveEntry(path.join(config.root, 'pending', entry.queueId), path.join(config.root, 'expired', entry.queueId));
  }
  entries = await scanEntries(filesystem, config);
  buildIndexes(entries);
  const retention = await expireAndPurge({ filesystem, config, at: clock() });
  for (const entry of retention.entries) await verifyEvidence(entry, resolveEvidence);
  buildIndexes(retention.entries);
  return { entries: retention.entries, staging, retention: retention.result };
}
function validateFilesystem(value) {
  const required = ['prepare', 'acquireLock', 'list', 'readEntry', 'createStage', 'commitStage', 'replaceState', 'moveEntry', 'removeTree', 'removeStaging', 'removeStateTemporaries'];
  if (!isRecord(value) || required.some((name) => typeof value[name] !== 'function')) fail('invalid-filesystem', 'filesystem must implement the proposal queue filesystem seam');
  return value;
}
function validateInspectionFilesystem(value) {
  const required = ['inspect', 'acquireSharedLock', 'list', 'readEntry'];
  if (!isRecord(value) || required.some((name) => typeof value[name] !== 'function')) {
    fail('invalid-filesystem', 'filesystem must implement the read-only proposal queue inspection seam');
  }
  return value;
}

export async function inspectProposalQueue(options = {}) {
  if (!isRecord(options)) fail('invalid-inspect-options', 'inspectProposalQueue options must be an object');
  const unknown = Object.keys(options).filter((key) => !INSPECT_KEYS.includes(key));
  if (unknown.length > 0) fail('unknown-field', `inspectProposalQueue options contain unknown field ${unknown[0]}`);
  const config = validateProposalQueueConfig(options.config);
  const filesystem = validateInspectionFilesystem(options.filesystem ?? createQueueFilesystem());
  const resolveEvidence = options.resolveEvidence;
  if (typeof resolveEvidence !== 'function') {
    fail('recovery-evidence-required', 'read-only inspection requires resolveEvidence()');
  }
  await filesystem.inspect(config.root);
  const lock = await filesystem.acquireSharedLock(config.root);
  let closed = false;
  let entries;
  let indexes;
  try {
    const staging = await filesystem.list(path.join(config.root, 'staging'));
    if (staging.length > 0) {
      fail('queue-recovery-required', 'proposal queue staging is not empty; run normal recovery before inspection');
    }
    entries = await scanEntriesReadonly(filesystem, config);
    indexes = buildIndexes(entries);
    for (const entry of entries) await verifyEvidence(entry, resolveEvidence);
  } catch (error) {
    await lock.release();
    throw error;
  }
  const requireOpen = () => { if (closed) fail('queue-closed', 'proposal queue inspection is closed'); };
  return Object.freeze({
    async load(queueIdInput) {
      requireOpen();
      const queueId = validateQueueId(queueIdInput);
      const entry = indexes.byId.get(queueId);
      if (entry === undefined) fail('queue-entry-not-found', `${queueId} is not retained`);
      await verifyEvidence(entry, resolveEvidence);
      return entry;
    },
    async list(optionsInput = {}) {
      requireOpen();
      if (!isRecord(optionsInput)) fail('invalid-list-options', 'list options must be an object');
      const unknownKeys = Object.keys(optionsInput).filter((key) => key !== 'state');
      if (unknownKeys.length > 0) fail('unknown-field', `list options contain unknown field ${unknownKeys[0]}`);
      const state = optionsInput.state ?? null;
      if (state !== null && !['pending-review', 'expired'].includes(state)) fail('invalid-queue-state', 'state filter must be pending-review, expired, or null');
      for (const entry of entries) await verifyEvidence(entry, resolveEvidence);
      return Object.freeze(entries.filter((entry) => state === null || entry.state.state === state));
    },
    stats() {
      requireOpen();
      return snapshotStats(entries);
    },
    async close() {
      if (closed) return;
      closed = true;
      await lock.release();
    },
  });
}

export async function openProposalQueue(options = {}) {
  if (!isRecord(options)) fail('invalid-open-options', 'openProposalQueue options must be an object');
  const unknown = Object.keys(options).filter((key) => !OPEN_KEYS.includes(key));
  if (unknown.length > 0) fail('unknown-field', `openProposalQueue options contain unknown field ${unknown[0]}`);
  const config = validateProposalQueueConfig(options.config);
  const clock = options.clock ?? defaultClock;
  const idFactory = options.idFactory ?? randomUUID;
  if (typeof clock !== 'function' || typeof idFactory !== 'function') fail('invalid-open-options', 'clock and idFactory must be functions');
  const filesystem = validateFilesystem(options.filesystem ?? createQueueFilesystem());
  const resolveEvidence = options.resolveEvidence;
  if (resolveEvidence !== undefined && typeof resolveEvidence !== 'function') fail('invalid-open-options', 'resolveEvidence must be a function');
  await filesystem.prepare(config.root);
  const lock = await filesystem.acquireLock(config.root);
  let closed = false;
  let entries;
  let indexes;
  const refresh = (next) => { entries = next; indexes = buildIndexes(entries); };
  try {
    const recovered = await recover({ filesystem, config, resolveEvidence, clock });
    refresh(recovered.entries);
  } catch (error) {
    await lock.release();
    throw error;
  }
  const requireOpen = () => { if (closed) fail('queue-closed', 'proposal queue is closed'); };
  return Object.freeze({
    async enqueue(input) {
      requireOpen();
      exactObject(input, ENQUEUE_KEYS, 'enqueue input');
      const carrierInput = validateCarrierInput(input.carrier);
      const idempotency = validateIdempotencyInput(input.idempotency, carrierInput.lane);
      const digests = idempotencyDigests(carrierInput, idempotency);
      const replay = digests.replayScope === null ? null : indexes.replay.get(digests.replayScope) ?? null;
      if (replay !== null) {
        if (replay.receipt.requestDigest !== digests.requestDigest) fail('idempotency-conflict', 'lane-scoped idempotency identity is bound to a different request digest');
        if (input.proposalText !== null && proposalDigest(parseProposal(exactBytes(input.proposalText, 'proposalText'))) !== replay.receipt.proposalDigest) fail('idempotency-conflict', 'lane-scoped idempotency identity is bound to a different proposal');
        return deepFreeze({ replayed: true, receipt: replay.receipt });
      }
      if (input.proposalText === null && input.baseBytes === null && input.policy === null) return deepFreeze({ replayed: false, receipt: null });
      const proposalBytes = exactBytes(input.proposalText, 'proposalText');
      const proposal = parseProposal(proposalBytes);
      const baseBytes = exactBytes(input.baseBytes, 'baseBytes');
      const policy = validatePolicyInput(input.policy);
      const verifiedSubject = normalizeVerifiedSubject(input.verifiedSubject);
      if (carrierInput.lane === 'lane-b' && verifiedSubject !== null) fail('lane-b-subject-forbidden', 'Lane B queue submissions must remain anonymous');
      applyProposal(baseBytes, proposal);
      const classification = createClassificationArtifact(policy, verifiedSubject, classifyProposal(baseBytes, proposal, policy.config, verifiedSubject));
      const receivedAt = utcSecond(clock(), 'queue clock');
      const queueId = queueIdFromFactory(idFactory);
      if (indexes.byId.has(queueId)) fail('queue-id-collision', 'idFactory returned an existing queue identifier');
      const receipt = createReceipt({
        queueId, lane: carrierInput.lane, receivedAt,
        expiresAt: addDays(receivedAt, config.pendingRetentionDays),
        digest: proposalDigest(proposal), proposalByteLength: proposalBytes.length,
        requestDigest: digests.requestDigest, idempotencyKeyDigest: digests.idempotencyKeyDigest,
        sourcePartition: sourcePartitionDigest(proposal),
      });
      const carrier = createDurableCarrier(carrierInput, digests.replayScope);
      const state = createPendingState(queueId, receivedAt);
      const artifacts = artifactBytes({ proposalBytes, receipt, carrier, classification, state });
      admissionCheck(entries, receipt.sourcePartitionDigest, retainedBytes(artifacts), config);
      const stage = await filesystem.createStage(config.root, queueId, artifacts);
      try {
        await filesystem.commitStage(stage, path.join(config.root, 'pending', queueId));
      } catch (error) {
        await filesystem.removeStaging(config.root);
        refresh(await scanEntries(filesystem, config));
        throw error;
      }
      const entry = await readEntry(filesystem, config.root, 'pending', queueId);
      refresh([...entries, entry].sort((a, b) => a.receipt.receivedAt.localeCompare(b.receipt.receivedAt) || a.queueId.localeCompare(b.queueId)));
      return deepFreeze({ replayed: false, receipt: entry.receipt });
    },
    async load(queueIdInput) {
      requireOpen();
      const queueId = validateQueueId(queueIdInput);
      refresh(await scanEntries(filesystem, config));
      const entry = indexes.byId.get(queueId);
      if (entry === undefined) fail('queue-entry-not-found', `${queueId} is not retained`);
      await verifyEvidence(entry, resolveEvidence);
      return entry;
    },
    async list(optionsInput = {}) {
      requireOpen();
      if (!isRecord(optionsInput)) fail('invalid-list-options', 'list options must be an object');
      const unknownKeys = Object.keys(optionsInput).filter((key) => key !== 'state');
      if (unknownKeys.length > 0) fail('unknown-field', `list options contain unknown field ${unknownKeys[0]}`);
      const state = optionsInput.state ?? null;
      if (state !== null && !['pending-review', 'expired'].includes(state)) fail('invalid-queue-state', 'state filter must be pending-review, expired, or null');
      refresh(await scanEntries(filesystem, config));
      for (const entry of entries) await verifyEvidence(entry, resolveEvidence);
      return Object.freeze(entries.filter((entry) => state === null || entry.state.state === state));
    },
    async expireDue() {
      requireOpen();
      refresh(await scanEntries(filesystem, config));
      for (const entry of entries) await verifyEvidence(entry, resolveEvidence);
      const result = await expireAndPurge({ filesystem, config, at: clock() });
      refresh(result.entries);
      return result.result;
    },
    async close() {
      if (closed) return;
      closed = true;
      await lock.release();
    },
    stats() {
      requireOpen();
      return snapshotStats(entries);
    },
  });
}

import { createHash } from 'node:crypto';
import {
  ProposalError, PROPOSAL_ARTIFACT_TYPE, PROPOSAL_MAX_BYTES,
  requireExactKeys, requireProposalId, requireSafeInteger, requireDigest,
  normalizeSource, normalizeSubmission, decodeUtf8, utf8Bytes, deepFreeze,
  enforceProposalSize, validateProposal, proposalDigest, parseProposal as parseV1,
} from './proposal.js';

export const CHANGE_SET_SCHEMA_VERSION = 2;
export const CHANGE_SET_MAX_OPERATIONS = 50;
export const CHANGE_SET_MAX_SPAN_BYTES = 16 * 1024;
export const CHANGE_SET_MAX_CHANGED_BYTES = 64 * 1024;
export const CHANGE_SET_MAX_FILE_BYTES = 4 * 1024 * 1024;

const TOP_KEYS = ['schemaVersion', 'artifactType', 'proposalId', 'changeSet', 'submission'];
const SET_KEYS = ['atomic', 'repository', 'baseRevision', 'files', 'changeSetDigest'];
const FILE_KEYS = ['path', 'kind', 'base', 'operations', 'candidate'];
const OP_KEYS = ['operationId', 'start', 'end', 'expected', 'replacement'];
const fail = (code, message) => { throw new ProposalError(code, message); };
const hash = (bytes) => `sha-256=:${createHash('sha256').update(bytes).digest('base64')}:`;
const canonical = (value) => `${JSON.stringify(value)}\n`;

function fileBinding(value, label) {
  requireExactKeys(value, ['byteLength', 'digest'], label);
  const byteLength = requireSafeInteger(value.byteLength, `${label}.byteLength`);
  if (byteLength > CHANGE_SET_MAX_FILE_BYTES) fail('file-too-large', `${label} exceeds 4 MiB`);
  return { byteLength, digest: requireDigest(value.digest, `${label}.digest`) };
}

export function normalizeOperations(values, baseLength) {
  if (!Array.isArray(values) || values.length < 1 || values.length > CHANGE_SET_MAX_OPERATIONS) {
    fail('operation-count', `change set requires 1-${CHANGE_SET_MAX_OPERATIONS} operations`);
  }
  const ids = new Set();
  let previous;
  let changed = 0;
  let removed = 0;
  let inserted = 0;
  const operations = [];
  // for..of intentionally visits sparse slots, so holes cannot evade validation.
  for (const value of values) {
    requireExactKeys(value, OP_KEYS, 'operation');
    utf8Bytes(value.operationId, 'operation.operationId', { nonEmpty: true, maxBytes: 128, rejectControls: true });
    const operationId = requireProposalId(value.operationId);
    if (ids.has(operationId)) fail('duplicate-operation-id', 'operation IDs must be unique');
    ids.add(operationId);
    const start = requireSafeInteger(value.start, 'operation.start');
    const end = requireSafeInteger(value.end, 'operation.end');
    if (start > end || end > baseLength) fail('invalid-operation-range', 'operation lies outside the pinned base');
    if (previous) {
      if (start < previous.start) fail('noncanonical-order', 'operations must arrive in ascending start order');
      if (start === previous.start) fail('duplicate-start', 'operations must have distinct starts, including insertions');
      if (start < previous.end) fail('overlap', 'operations must not overlap');
    }
    const expected = utf8Bytes(value.expected, 'operation.expected', { maxBytes: CHANGE_SET_MAX_SPAN_BYTES });
    const replacement = utf8Bytes(value.replacement, 'operation.replacement', { maxBytes: CHANGE_SET_MAX_SPAN_BYTES });
    if (/\r(?!\n)/u.test(value.replacement)) fail('invalid-line-ending', 'replacement must not introduce a lone CR');
    if (expected.length !== end - start) fail('old-bytes-length-mismatch', 'expected bytes must span the declared range');
    if (expected.equals(replacement)) fail('no-op-proposal', 'each operation must change bytes');
    changed += expected.length + replacement.length;
    removed += expected.length;
    inserted += replacement.length;
    if (changed > CHANGE_SET_MAX_CHANGED_BYTES) fail('changed-bytes-too-large', 'total expected plus replacement bytes exceeds 64 KiB');
    const operation = { operationId, start, end, expected: value.expected, replacement: value.replacement };
    operations.push(operation);
    previous = operation;
  }
  if (baseLength > 0 && removed === baseLength) {
    fail('whole-file-operation', 'the removed-range union must not cover the complete nonempty file');
  }
  const candidateLength = baseLength - removed + inserted;
  if (candidateLength > CHANGE_SET_MAX_FILE_BYTES) fail('file-too-large', 'candidate exceeds 4 MiB');
  return { operations, candidateLength };
}

// Inner digest binds the canonical set body (without its own digest), including
// source identity and all file bindings. The outer digest also binds submission.
function bodyDigest(body) { return hash(Buffer.from(canonical(body))); }

function normalizeChangeSet(value) {
  requireExactKeys(value, SET_KEYS, 'changeSet');
  if (value.atomic !== true) fail('non-atomic-change-set', 'changeSet.atomic must be true');
  if (!Array.isArray(value.files) || value.files.length !== 1) fail('file-count', 'exactly one existing Markdown file is supported');
  const file = value.files[0];
  requireExactKeys(file, FILE_KEYS, 'changeSet.files[0]');
  if (file.kind !== 'modify') fail('invalid-file-kind', 'only modify is supported');
  const source = normalizeSource({ repository: value.repository, revision: value.baseRevision, path: file.path });
  const base = fileBinding(file.base, 'base');
  const { operations, candidateLength } = normalizeOperations(file.operations, base.byteLength);
  const candidate = fileBinding(file.candidate, 'candidate');
  if (candidate.byteLength !== candidateLength) fail('candidate-length-mismatch', 'candidate length does not match the declared operations');
  if (candidate.digest === base.digest) fail('no-op-proposal', 'the complete change set must change the source');
  const body = {
    atomic: true,
    repository: source.repository,
    baseRevision: source.revision,
    files: [{ path: source.path, kind: 'modify', base, operations, candidate }],
  };
  const changeSetDigest = requireDigest(value.changeSetDigest, 'changeSet.changeSetDigest');
  if (changeSetDigest !== bodyDigest(body)) fail('change-set-digest-mismatch', 'changeSetDigest does not match the canonical set body');
  return { ...body, changeSetDigest };
}

function baseBuffer(value) {
  if (!(value instanceof Uint8Array)) fail('invalid-bytes', 'base must be a Buffer or Uint8Array');
  if (value.byteLength > CHANGE_SET_MAX_FILE_BYTES) fail('file-too-large', 'base exceeds 4 MiB');
  const bytes = Buffer.from(value);
  decodeUtf8(bytes, 'base');
  return bytes;
}

function checkBoundary(base, offset) {
  if (offset !== base.length && (base[offset] & 0xc0) === 0x80) {
    fail('offset-not-utf8-boundary', 'operation offsets must be UTF-8 code point boundaries');
  }
  if (offset > 0 && base[offset - 1] === 13 && base[offset] === 10) {
    fail('crlf-split', 'operations must not split an existing CRLF pair');
  }
}

export function constructCandidate(base, operations) {
  const pieces = [];
  let cursor = 0;
  for (const operation of operations) {
    checkBoundary(base, operation.start);
    checkBoundary(base, operation.end);
    if (!base.subarray(operation.start, operation.end).equals(Buffer.from(operation.expected))) {
      fail('old-bytes-mismatch', 'the pinned base slice does not match operation.expected');
    }
    pieces.push(base.subarray(cursor, operation.start), Buffer.from(operation.replacement));
    cursor = operation.end;
  }
  pieces.push(base.subarray(cursor));
  const candidate = Buffer.concat(pieces);
  if (candidate.equals(base)) fail('no-op-proposal', 'the complete change set must change the source');
  return candidate;
}

function verifyAgainstBase(baseInput, proposal) {
  const base = baseBuffer(baseInput);
  const file = proposal.changeSet.files[0];
  if (base.length !== file.base.byteLength) fail('base-length-mismatch', 'base byte length does not match');
  if (hash(base) !== file.base.digest) fail('base-digest-mismatch', 'base digest does not match');
  const candidate = constructCandidate(base, file.operations);
  if (candidate.length !== file.candidate.byteLength) fail('candidate-length-mismatch', 'candidate byte length does not match');
  if (hash(candidate) !== file.candidate.digest) fail('candidate-digest-mismatch', 'candidate digest does not match');
  return candidate;
}

/** Structural/digest validation; supply baseBytes for full source verification. */
export function validateChangeSetProposal(value, baseBytes) {
  requireExactKeys(value, TOP_KEYS, 'proposal v2');
  if (value.schemaVersion !== CHANGE_SET_SCHEMA_VERSION) fail('unsupported-schema', 'expected proposal schemaVersion 2');
  if (value.artifactType !== PROPOSAL_ARTIFACT_TYPE) fail('invalid-artifact-type', 'expected cyberbaser-proposal');
  const normalized = {
    schemaVersion: CHANGE_SET_SCHEMA_VERSION,
    artifactType: PROPOSAL_ARTIFACT_TYPE,
    proposalId: requireProposalId(value.proposalId),
    changeSet: normalizeChangeSet(value.changeSet),
    submission: normalizeSubmission(value.submission),
  };
  enforceProposalSize(normalized);
  if (baseBytes !== undefined) verifyAgainstBase(baseBytes, normalized);
  return deepFreeze(normalized);
}

/** Input: {proposalId, source:{repository,revision,path}, operations, submission}. */
export function createChangeSetProposal(baseBytes, input) {
  requireExactKeys(input, ['proposalId', 'source', 'operations', 'submission'], 'proposal v2 input');
  const proposalId = requireProposalId(input.proposalId);
  const source = normalizeSource(input.source);
  const submission = normalizeSubmission(input.submission);
  const base = baseBuffer(baseBytes);
  const { operations } = normalizeOperations(input.operations, base.length);
  const candidate = constructCandidate(base, operations);
  const body = {
    atomic: true,
    repository: source.repository,
    baseRevision: source.revision,
    files: [{
      path: source.path,
      kind: 'modify',
      base: { byteLength: base.length, digest: hash(base) },
      operations,
      candidate: { byteLength: candidate.length, digest: hash(candidate) },
    }],
  };
  return validateChangeSetProposal({
    schemaVersion: CHANGE_SET_SCHEMA_VERSION,
    artifactType: PROPOSAL_ARTIFACT_TYPE,
    proposalId,
    changeSet: { ...body, changeSetDigest: bodyDigest(body) },
    submission,
  });
}

export function applyChangeSetProposal(baseBytes, value) {
  return verifyAgainstBase(baseBytes, validateChangeSetProposal(value));
}

export function serializeChangeSetProposal(value) {
  return canonical(validateChangeSetProposal(value));
}

export function changeSetProposalDigest(value) {
  return hash(Buffer.from(serializeChangeSetProposal(value)));
}

/** Additive dispatcher. The legacy package-root parseProposal remains v1-only. */
export function parseProposal(value) {
  let bytes;
  if (typeof value === 'string') {
    if (Buffer.byteLength(value) > PROPOSAL_MAX_BYTES) fail('proposal-too-large', 'proposal exceeds 256 KiB');
    bytes = utf8Bytes(value, 'proposal');
  } else if (value instanceof Uint8Array) {
    if (value.byteLength > PROPOSAL_MAX_BYTES) fail('proposal-too-large', 'proposal exceeds 256 KiB');
    bytes = Buffer.from(value);
  }
  else fail('invalid-bytes', 'proposal must be UTF-8 text or bytes');
  if (bytes.length === 0) fail('empty-proposal', 'proposal must not be empty');
  if (bytes.length > PROPOSAL_MAX_BYTES) fail('proposal-too-large', 'proposal exceeds 256 KiB');
  const text = decodeUtf8(bytes, 'proposal');
  if (text.startsWith('﻿')) fail('utf8-bom', 'proposal must not begin with a UTF-8 BOM');
  let valueObject;
  try { valueObject = JSON.parse(text); }
  catch { fail('malformed-json', 'proposal is not valid JSON'); }
  if (valueObject?.schemaVersion === 1) return deepFreeze({ version: 1, proposal: parseV1(bytes) });
  if (valueObject?.schemaVersion !== 2) fail('unsupported-schema', 'unsupported proposal schemaVersion');
  const proposal = validateChangeSetProposal(valueObject);
  if (text !== canonical(proposal)) fail('noncanonical-proposal', 'proposal requires compact fixed-order JSON and exactly one final LF');
  return deepFreeze({ version: 2, proposal });
}

/** Ephemeral view only: not a v2 artifact and never suitable for application. */
export function projectV1ToChangeSet(value) {
  const proposal = validateProposal(value);
  const operation = proposal.operation;
  const body = {
    atomic: true,
    repository: proposal.source.repository,
    baseRevision: proposal.source.revision,
    files: [{
      path: proposal.source.path,
      kind: 'modify',
      base: { byteLength: operation.baseByteLength, digest: operation.baseDigest },
      operations: [{
        operationId: 'v1:operation',
        start: operation.start,
        end: operation.end,
        expected: Buffer.from(operation.expectedOldBytesBase64, 'base64').toString('utf8'),
        replacement: Buffer.from(operation.replacementBytesBase64, 'base64').toString('utf8'),
      }],
      candidate: { byteLength: operation.candidateByteLength, digest: operation.candidateDigest },
    }],
  };
  return deepFreeze({
    version: 1,
    proposalDigest: proposalDigest(proposal),
    proposalId: proposal.proposalId,
    changeSet: { ...body, changeSetDigest: bodyDigest(body) },
    submission: proposal.submission,
  });
}

import { createHash } from 'node:crypto';
import {
  applyCorrection,
  CorrectionError,
  deriveContiguousCorrection,
} from '../../../packages/correction/src/index.js';
import { computePolicyRevision, validateOwnerAlphaConfig } from './config.js';
import { fail, OwnerAlphaError } from './errors.js';
import { deepFreeze, isPlainObject } from './json.js';
import {
  detectYamlFrontmatterRange,
  EDIT_SESSION_ARTIFACT_TYPE,
  EDIT_SESSION_SCHEMA_VERSION,
} from './source.js';

export const SOURCE_OPERATION_SCHEMA_VERSION = 1;
export const SOURCE_OPERATION_ARTIFACT_TYPE = 'owner-alpha-source-operation';

function sha256Digest(bytes) {
  return `sha-256=:${createHash('sha256').update(bytes).digest('base64')}:`;
}

function decodeBase64(value, label) {
  if (typeof value !== 'string' || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    fail('invalid-operation-bytes', `${label} must be canonical base64`);
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) fail('invalid-operation-bytes', `${label} must be canonical base64`);
  return bytes;
}

function exactSessionString(value, label) {
  if (typeof value !== 'string' || value.length === 0) fail('invalid-edit-session', `${label} must be a non-empty string`);
  return value;
}

function validateEditSession(session) {
  if (!isPlainObject(session)
    || session.schemaVersion !== EDIT_SESSION_SCHEMA_VERSION
    || session.artifactType !== EDIT_SESSION_ARTIFACT_TYPE
    || !isPlainObject(session.source)) {
    fail('invalid-edit-session', 'operation requires one owner-alpha immutable edit session');
  }
  for (const key of ['relativePath', 'slug', 'liveUrl', 'baseCommit', 'policyRevision']) {
    exactSessionString(session[key], `session.${key}`);
  }
  if (!/^[0-9a-f]{40}$/u.test(session.baseCommit)) {
    fail('invalid-edit-session', 'session.baseCommit must be a lowercase 40-character commit ID');
  }
  if (!/^sha256:[0-9a-f]{64}$/u.test(session.policyRevision)) {
    fail('invalid-edit-session', 'session.policyRevision must be a lowercase SHA-256 policy revision');
  }
  if (typeof session.source.text !== 'string'
    || !Number.isSafeInteger(session.source.byteLength)
    || session.source.byteLength < 0
    || typeof session.source.digest !== 'string') {
    fail('invalid-edit-session', 'session source binding is incomplete');
  }

  const base = decodeBase64(session.source.bytesBase64, 'session.source.bytesBase64');
  if (base.length !== session.source.byteLength
    || sha256Digest(base) !== session.source.digest
    || Buffer.from(session.source.text, 'utf8').toString('base64') !== session.source.bytesBase64) {
    fail('edit-session-source-mismatch', 'session source text, bytes, length, and digest must identify one exact base');
  }
  if (session.source.text.includes('\r')) {
    fail('source-not-lf-only', 'owner-alpha browser MVP accepts LF-only Markdown source');
  }
  const detected = detectYamlFrontmatterRange(base);
  const recorded = session.source.frontmatter ?? null;
  // Durable artifacts round-trip through canonical sorted-key JSON, so the
  // recorded range must be compared by value, never by serialized form.
  const matches = detected === null
    ? recorded === null
    : isPlainObject(recorded)
      && Object.keys(recorded).length === 2
      && recorded.start === detected.start
      && recorded.end === detected.end;
  if (!matches) {
    fail('edit-session-frontmatter-mismatch', 'session frontmatter range must match its exact source bytes');
  }
  return { base, frontmatter: detected };
}

function rethrowCorrection(error) {
  if (error instanceof OwnerAlphaError) throw error;
  if (error instanceof CorrectionError) {
    fail(error.code, error.message, { correctionPhase: error.phase, ...error.details });
  }
  throw error;
}

function changedLineCount(bytes) {
  if (bytes.length === 0) return 0;
  let count = 1;
  for (const byte of bytes) if (byte === 0x0a) count += 1;
  return count;
}

function correctionFromOperation(operation) {
  return {
    operationType: 'offset',
    baseByteLength: operation.baseByteLength,
    baseDigest: operation.baseDigest,
    start: operation.start,
    end: operation.end,
    expectedOldBytes: decodeBase64(operation.expectedOldBytesBase64, 'operation.expectedOldBytesBase64'),
    replacementBytes: decodeBase64(operation.replacementBytesBase64, 'operation.replacementBytesBase64'),
    candidateByteLength: operation.candidateByteLength,
    candidateDigest: operation.candidateDigest,
  };
}

function assertOperationBinding(session, operation) {
  if (!isPlainObject(operation)
    || operation.schemaVersion !== SOURCE_OPERATION_SCHEMA_VERSION
    || operation.artifactType !== SOURCE_OPERATION_ARTIFACT_TYPE
    || !isPlainObject(operation.source)) {
    fail('invalid-source-operation', 'operation must be one owner-alpha source operation');
  }
  const expected = {
    relativePath: session.relativePath,
    slug: session.slug,
    liveUrl: session.liveUrl,
    baseCommit: session.baseCommit,
    policyRevision: session.policyRevision,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (operation.source[key] !== value) {
      fail('operation-source-binding-mismatch', `operation source ${key} does not match the edit session`);
    }
  }
  if (operation.operationType !== 'offset') {
    fail('invalid-source-operation', 'owner-alpha source operation must be one offset splice');
  }
}

function assertFrontmatterUnchanged(base, candidate, correction, frontmatter) {
  if (frontmatter && correction.start < frontmatter.end) {
    fail('frontmatter-edit-rejected', 'owner-alpha browser edits must not intersect YAML frontmatter');
  }

  const candidateFrontmatter = detectYamlFrontmatterRange(candidate);
  if (JSON.stringify(candidateFrontmatter) !== JSON.stringify(frontmatter)) {
    fail('frontmatter-edit-rejected', 'owner-alpha browser edits must not add, remove, or resize YAML frontmatter');
  }
  if (frontmatter
    && !candidate.subarray(frontmatter.start, frontmatter.end)
      .equals(base.subarray(frontmatter.start, frontmatter.end))) {
    fail('frontmatter-edit-rejected', 'owner-alpha browser edits must preserve exact YAML frontmatter bytes');
  }
}

function proveOutsideBytesUnchanged(base, candidate, correction) {
  if (!candidate.subarray(0, correction.start).equals(base.subarray(0, correction.start))) {
    fail('outside-operation-bytes-changed', 'candidate prefix outside the exact operation changed');
  }
  const candidateSuffix = candidate.subarray(correction.start + correction.replacementBytes.length);
  if (!candidateSuffix.equals(base.subarray(correction.end))) {
    fail('outside-operation-bytes-changed', 'candidate suffix outside the exact operation changed');
  }
}

function assertLfOnlyCandidate(candidate) {
  if (candidate.includes(0x0d)) {
    fail('candidate-not-lf-only', 'owner-alpha browser MVP accepts LF-only candidate Markdown');
  }
}

export function deriveEditorOperation({ session, editedText, config: configInput }) {
  const config = validateOwnerAlphaConfig(configInput);
  const { base, frontmatter } = validateEditSession(session);
  if (computePolicyRevision(config) !== session.policyRevision) {
    fail('edit-session-policy-mismatch', 'current config policy revision differs from the edit session');
  }
  if (typeof editedText !== 'string') fail('invalid-editor-value', 'editedText must be a string');
  if (editedText.includes('\r')) {
    fail('editor-value-not-lf-only', 'owner-alpha browser MVP accepts LF-only edited Markdown');
  }

  let correction;
  let candidate;
  try {
    correction = deriveContiguousCorrection(base, editedText, {
      maxBaseBytes: config.limits.maxSourceBytes,
      maxEditedBytes: config.limits.maxSourceBytes,
      maxOldBytes: config.limits.maxChangedBytes,
      maxReplacementBytes: config.limits.maxReplacementBytes,
      maxChangedBytes: config.limits.maxChangedBytes,
      maxChangedLines: config.limits.maxChangedLines,
    });
    candidate = applyCorrection(base, correction);
  } catch (error) {
    rethrowCorrection(error);
  }

  const editedBytes = Buffer.from(editedText, 'utf8');
  if (!candidate.equals(editedBytes)) {
    fail('candidate-editor-mismatch', 'derived exact operation did not reproduce the editor value');
  }
  assertLfOnlyCandidate(candidate);
  assertFrontmatterUnchanged(base, candidate, correction, frontmatter);
  proveOutsideBytesUnchanged(base, candidate, correction);

  const changedBytes = Math.max(
    correction.expectedOldBytes.length,
    correction.replacementBytes.length,
  );
  const changedLines = Math.max(
    changedLineCount(correction.expectedOldBytes),
    changedLineCount(correction.replacementBytes),
  );

  return deepFreeze({
    schemaVersion: SOURCE_OPERATION_SCHEMA_VERSION,
    artifactType: SOURCE_OPERATION_ARTIFACT_TYPE,
    source: {
      relativePath: session.relativePath,
      slug: session.slug,
      liveUrl: session.liveUrl,
      baseCommit: session.baseCommit,
      policyRevision: session.policyRevision,
    },
    operationType: 'offset',
    baseByteLength: correction.baseByteLength,
    baseDigest: correction.baseDigest,
    start: correction.start,
    end: correction.end,
    expectedOldBytesBase64: correction.expectedOldBytes.toString('base64'),
    replacementBytesBase64: correction.replacementBytes.toString('base64'),
    candidateByteLength: correction.candidateByteLength,
    candidateDigest: correction.candidateDigest,
    changedBytes,
    changedLines,
    frontmatter,
    outsideBytesUnchanged: true,
  });
}

export function applyEditorOperation(session, operation) {
  const { base, frontmatter } = validateEditSession(session);
  assertOperationBinding(session, operation);
  const correction = correctionFromOperation(operation);
  let candidate;
  try {
    candidate = applyCorrection(base, correction);
  } catch (error) {
    rethrowCorrection(error);
  }
  assertLfOnlyCandidate(candidate);
  assertFrontmatterUnchanged(base, candidate, correction, frontmatter);
  proveOutsideBytesUnchanged(base, candidate, correction);
  return candidate;
}

const CAPTURE_HINT_KEYS = [
  'schemaVersion',
  'repositoryId',
  'repository',
  'sourceRunId',
  'sourceRunAttempt',
  'prNumber',
];

const DECIMAL_ID_RE = /^[1-9]\d{0,19}$/;
const MAX_UNSIGNED_64 = 18_446_744_073_709_551_615n;
const REPOSITORY_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9._-]{1,100}$/;
const RUN_NAME_RE = /^Decision Ledger Capture \/ PR #([1-9]\d*)$/;
const ARTIFACT_NAME_RE = /^decision-ledger-capture-run-([1-9]\d{0,19})-pr-([1-9]\d*)$/;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export const CAPTURE_HINT_SCHEMA_VERSION = 1;
export const CAPTURE_HINT_FILENAME = 'decision-ledger-capture.json';
export const CAPTURE_HINT_MAX_BYTES = 1024;
export const CAPTURE_ARTIFACT_MAX_BYTES = 16 * 1024;
export const CAPTURE_WORKFLOW_NAME = 'Decision Ledger Capture';
export const CAPTURE_WORKFLOW_PATH = '.github/workflows/decision-ledger-capture.yml';

export class LedgerGithubError extends Error {
  constructor(code, message, details = {}, exitCode = 2) {
    super(message);
    this.name = 'LedgerGithubError';
    this.code = code;
    this.details = details;
    this.exitCode = exitCode;
  }
}

function fail(code, message, details = {}, exitCode = 2) {
  throw new LedgerGithubError(code, message, details, exitCode);
}

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireRecord(value, label) {
  if (!isRecord(value)) fail('invalid-record', `${label} must be an object`);
  return value;
}

function requireExactKeys(value, keys, label) {
  requireRecord(value, label);
  const actual = Object.keys(value);
  const unknown = actual.filter((key) => !keys.includes(key));
  const missing = keys.filter((key) => !Object.hasOwn(value, key));
  if (unknown.length > 0) {
    fail('unknown-field', `${label} contains unknown field ${unknown[0]}`, { field: unknown[0] });
  }
  if (missing.length > 0) {
    fail('missing-field', `${label} is missing required field ${missing[0]}`, { field: missing[0] });
  }
}

function requirePositiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail('invalid-positive-integer', `${label} must be a positive safe integer`);
  }
  return value;
}

function requireDecimalId(value, label) {
  if (typeof value !== 'string' || !DECIMAL_ID_RE.test(value)) {
    fail('invalid-id', `${label} must be a canonical positive decimal string`);
  }
  if (BigInt(value) > MAX_UNSIGNED_64) {
    fail('invalid-id', `${label} must fit in an unsigned 64-bit integer`);
  }
  return value;
}

function requireRepository(value, label = 'repository') {
  if (typeof value !== 'string' || !REPOSITORY_RE.test(value)) {
    fail('invalid-repository', `${label} must be an exact GitHub owner/repository name`);
  }
  const [, name] = value.split('/');
  if (name === '.' || name === '..') {
    fail('invalid-repository', `${label} must be an exact GitHub owner/repository name`);
  }
  return value;
}

function metadataId(value, label) {
  if (typeof value === 'string') return requireDecimalId(value, label);
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail('unsafe-metadata-id', `${label} must be a positive safe integer or canonical decimal string`);
  }
  return String(value);
}

function bytesFrom(value, label) {
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (value instanceof Uint8Array) return Buffer.from(value);
  fail('invalid-bytes', `${label} must be UTF-8 text or bytes`);
}

function decodeUtf8(bytes, label) {
  try {
    return UTF8_DECODER.decode(bytes);
  } catch {
    fail('invalid-utf8', `${label} must be valid UTF-8`);
  }
}

function parsePositiveIntegerText(value, label) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
    fail('invalid-positive-integer', `${label} must contain a canonical positive integer`);
  }
  const parsed = Number(value);
  return requirePositiveSafeInteger(parsed, label);
}

export function validateCaptureHint(value) {
  requireExactKeys(value, CAPTURE_HINT_KEYS, 'capture hint');
  if (value.schemaVersion !== CAPTURE_HINT_SCHEMA_VERSION) {
    fail(
      'unsupported-capture-schema',
      `unsupported capture hint schemaVersion ${JSON.stringify(value.schemaVersion)}`,
      {},
      3,
    );
  }
  return {
    schemaVersion: CAPTURE_HINT_SCHEMA_VERSION,
    repositoryId: requireDecimalId(value.repositoryId, 'repositoryId'),
    repository: requireRepository(value.repository),
    sourceRunId: requireDecimalId(value.sourceRunId, 'sourceRunId'),
    sourceRunAttempt: requirePositiveSafeInteger(value.sourceRunAttempt, 'sourceRunAttempt'),
    prNumber: requirePositiveSafeInteger(value.prNumber, 'prNumber'),
  };
}

export function serializeCaptureHint(value) {
  const text = `${JSON.stringify(validateCaptureHint(value))}\n`;
  if (Buffer.byteLength(text, 'utf8') > CAPTURE_HINT_MAX_BYTES) {
    fail('capture-hint-too-large', `capture hint exceeds ${CAPTURE_HINT_MAX_BYTES} bytes`);
  }
  return text;
}

export function parseCaptureHint(value) {
  const bytes = bytesFrom(value, 'capture hint');
  if (bytes.length === 0) fail('empty-capture-hint', 'capture hint must not be empty');
  if (bytes.length > CAPTURE_HINT_MAX_BYTES) {
    fail('capture-hint-too-large', `capture hint exceeds ${CAPTURE_HINT_MAX_BYTES} bytes`);
  }
  const text = decodeUtf8(bytes, 'capture hint');
  if (text.startsWith('﻿')) fail('utf8-bom', 'capture hint must not begin with a UTF-8 BOM');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    fail('malformed-capture-json', `capture hint is not valid JSON: ${error.message}`);
  }
  const normalized = validateCaptureHint(parsed);
  if (text !== serializeCaptureHint(normalized)) {
    fail('noncanonical-capture-hint', 'capture hint must use canonical compact JSON with one final LF');
  }
  return normalized;
}

export function captureRunName(prNumber) {
  return `${CAPTURE_WORKFLOW_NAME} / PR #${requirePositiveSafeInteger(prNumber, 'prNumber')}`;
}

export function parseCaptureRunName(value) {
  if (typeof value !== 'string') fail('invalid-run-name', 'source run display title must be a string');
  const match = value.match(RUN_NAME_RE);
  if (!match) fail('invalid-run-name', 'source run display title does not match the trusted capture run-name format');
  return { prNumber: parsePositiveIntegerText(match[1], 'run-name prNumber') };
}

export function captureArtifactName(value) {
  const hint = validateCaptureHint(value);
  return `decision-ledger-capture-run-${hint.sourceRunId}-pr-${hint.prNumber}`;
}

export function parseCaptureArtifactName(value) {
  if (typeof value !== 'string') fail('invalid-artifact-name', 'artifact name must be a string');
  const match = value.match(ARTIFACT_NAME_RE);
  if (!match) fail('invalid-artifact-name', 'artifact name does not match the trusted capture artifact format');
  return {
    sourceRunId: requireDecimalId(match[1], 'artifact sourceRunId'),
    prNumber: parsePositiveIntegerText(match[2], 'artifact prNumber'),
  };
}

export function selectCaptureArtifact(artifacts, value) {
  if (!Array.isArray(artifacts)) fail('invalid-artifacts', 'artifacts must be an array');
  if (artifacts.length === 0) fail('missing-capture-artifact', 'source run has no capture artifact');
  if (artifacts.length !== 1) {
    fail('multiple-capture-artifacts', 'source run must have exactly one artifact', { count: artifacts.length });
  }
  const hint = validateCaptureHint(value);
  const artifact = requireRecord(artifacts[0], 'artifact');
  const expectedName = captureArtifactName(hint);
  if (artifact.name !== expectedName) {
    fail('artifact-name-mismatch', 'artifact name does not match the source run and PR number', {
      expected: expectedName,
      actual: artifact.name,
    });
  }
  return artifact;
}

export function parseCaptureArtifactEntries(entries) {
  if (!Array.isArray(entries)) fail('invalid-archive', 'artifact archive entries must be an array');
  if (entries.length !== 1) {
    fail('invalid-archive-entry-count', 'artifact archive must contain exactly one file', { count: entries.length });
  }
  const entry = requireRecord(entries[0], 'artifact archive entry');
  if (entry.name !== CAPTURE_HINT_FILENAME) {
    fail('invalid-archive-entry-name', `artifact archive must contain only ${CAPTURE_HINT_FILENAME}`);
  }
  return parseCaptureHint(entry.data);
}

function validateExpectedRepository(expectedRepository) {
  requireExactKeys(expectedRepository, ['repositoryId', 'repository'], 'expected repository');
  return {
    repositoryId: requireDecimalId(expectedRepository.repositoryId, 'expected repositoryId'),
    repository: requireRepository(expectedRepository.repository, 'expected repository'),
  };
}

export function validateCaptureRunBinding(value, sourceRun, expectedRepository) {
  const hint = validateCaptureHint(value);
  const run = requireRecord(sourceRun, 'source run');
  const expected = validateExpectedRepository(expectedRepository);
  const runId = metadataId(run.id, 'source run id');
  const runAttempt = requirePositiveSafeInteger(run.run_attempt, 'source run attempt');
  const repository = requireRecord(run.repository, 'source run repository');
  const repositoryId = metadataId(repository.id, 'source run repository id');
  const repositoryName = requireRepository(repository.full_name, 'source run repository name');

  if (runId !== hint.sourceRunId) fail('source-run-id-mismatch', 'capture hint sourceRunId does not match the source run');
  if (runAttempt !== hint.sourceRunAttempt) {
    fail('source-run-attempt-mismatch', 'capture hint sourceRunAttempt does not match the source run');
  }
  if (repositoryId !== hint.repositoryId || repositoryName !== hint.repository) {
    fail('source-run-repository-mismatch', 'capture hint repository does not match the source run repository');
  }
  if (repositoryId !== expected.repositoryId || repositoryName !== expected.repository) {
    fail('expected-repository-mismatch', 'source run repository does not match the recorder repository');
  }
  if (run.name !== CAPTURE_WORKFLOW_NAME || run.path !== CAPTURE_WORKFLOW_PATH) {
    fail('untrusted-source-workflow', 'source run does not identify the trusted capture workflow');
  }
  if (run.event !== 'pull_request') fail('invalid-source-event', 'source run event must be pull_request');
  if (run.status !== 'completed' || run.conclusion !== 'success') {
    fail('unsuccessful-source-run', 'source run must be completed successfully');
  }

  const runName = parseCaptureRunName(run.display_title);
  if (runName.prNumber !== hint.prNumber) {
    fail('source-run-pr-mismatch', 'capture hint prNumber does not match the source run display title');
  }

  if (!Array.isArray(run.pull_requests)) {
    fail('invalid-source-pull-requests', 'source run pull_requests must be an array');
  }
  if (run.pull_requests.length > 1) {
    fail('ambiguous-source-pull-requests', 'source run identifies more than one pull request');
  }
  if (run.pull_requests.length === 1) {
    const pullRequest = requireRecord(run.pull_requests[0], 'source run pull request');
    if (pullRequest.number !== hint.prNumber) {
      fail('source-run-pull-request-mismatch', 'source run pull request does not match capture hint prNumber');
    }
  }

  return hint;
}

export function validateCaptureArtifactBinding(value, artifact) {
  const hint = validateCaptureHint(value);
  const metadata = requireRecord(artifact, 'artifact');
  const parsedName = parseCaptureArtifactName(metadata.name);
  if (parsedName.sourceRunId !== hint.sourceRunId || parsedName.prNumber !== hint.prNumber) {
    fail('artifact-name-mismatch', 'artifact name does not match the capture hint');
  }
  if (metadata.expired !== false) fail('expired-capture-artifact', 'capture artifact must exist and be unexpired');
  if (!Number.isSafeInteger(metadata.size_in_bytes) || metadata.size_in_bytes <= 0) {
    fail('invalid-artifact-size', 'capture artifact compressed size must be a positive safe integer');
  }
  if (metadata.size_in_bytes > CAPTURE_ARTIFACT_MAX_BYTES) {
    fail('artifact-too-large', `capture artifact exceeds ${CAPTURE_ARTIFACT_MAX_BYTES} compressed bytes`);
  }
  const workflowRun = requireRecord(metadata.workflow_run, 'artifact workflow_run');
  if (metadataId(workflowRun.id, 'artifact workflow run id') !== hint.sourceRunId) {
    fail('artifact-run-mismatch', 'artifact workflow run id does not match capture hint sourceRunId');
  }
  if (metadataId(workflowRun.repository_id, 'artifact repository id') !== hint.repositoryId) {
    fail('artifact-repository-mismatch', 'artifact repository id does not match capture hint repositoryId');
  }
  return hint;
}

export function bindCaptureHint({ hint: value, sourceRun, artifact, expectedRepository }) {
  const hint = validateCaptureRunBinding(value, sourceRun, expectedRepository);
  validateCaptureArtifactBinding(hint, artifact);
  return hint;
}

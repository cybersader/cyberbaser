import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  applyProposal,
  classifyProposal,
} from '@cyberbaser/proposal';
import {
  createReviewSummary,
  validateReviewEvidence,
  validateReviewSummary,
} from '@cyberbaser/proposal-review';
import { digestBytes } from '@cyberbaser/proposal-queue';
import { parseConfig } from '@cyberbaser/trust';
import { validateOwnerAlphaConfig } from './config.js';
import { fail, OwnerAlphaError } from './errors.js';
import { canonicalJson, deepFreeze } from './json.js';

const execFileAsync = promisify(execFile);
const GIT_OBJECT_ID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const REGULAR_BLOB_MODES = new Set(['100644', '100755']);
const TRUST_POLICY_PATH = '.cyberbaser/trust.yml';
const TRUST_POLICY_MAX_BYTES = 64 * 1024;
const GIT_OUTPUT_MAX_BYTES = 16 * 1024 * 1024;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

const REVIEW_DOCUMENT_MAX_BYTES = 256 * 1024;

/**
 * Carry the verified base and candidate text for reading projections.
 *
 * The bytes are already read and verified above; this only decides whether they are
 * small enough to render, and says so rather than truncating.
 */
function readableDocument(baseBytes, candidateBytes) {
  if (baseBytes.length > REVIEW_DOCUMENT_MAX_BYTES || candidateBytes.length > REVIEW_DOCUMENT_MAX_BYTES) {
    return {
      baseText: null,
      candidateText: null,
      reason: `the pinned page exceeds the ${REVIEW_DOCUMENT_MAX_BYTES} byte reading bound, so only the declared change spans are shown`,
    };
  }
  return {
    baseText: baseBytes.toString('utf8'),
    candidateText: candidateBytes.toString('utf8'),
    reason: null,
  };
}

function dependency(label, action) {
  try {
    return action();
  } catch (error) {
    if (error instanceof OwnerAlphaError) throw error;
    fail('invalid-review-evidence', `${label} is invalid`, {
      cause: error?.code ?? error?.message ?? 'unknown',
    });
  }
}

function sanitizedGitEnvironment() {
  const env = { ...process.env };
  for (const name of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_CONFIG_COUNT',
    'GIT_CONFIG_PARAMETERS',
  ]) delete env[name];
  env.GIT_OPTIONAL_LOCKS = '0';
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_NO_LAZY_FETCH = '1';
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  return env;
}

export async function defaultProposalReviewGit(checkout, args, { maxBytes = GIT_OUTPUT_MAX_BYTES } = {}) {
  try {
    const { stdout } = await execFileAsync('git', [
      '-C', checkout,
      '--no-replace-objects',
      '-c', 'protocol.allow=never',
      ...args,
    ], {
      encoding: 'buffer',
      env: sanitizedGitEnvironment(),
      maxBuffer: maxBytes,
    });
    return Buffer.from(stdout);
  } catch (error) {
    fail('review-git-failed', `git ${args[0] ?? 'command'} failed during proposal review`, {
      command: args[0] ?? null,
      cause: Number.isSafeInteger(error?.code) ? error.code : error?.code ?? 'unknown',
    });
  }
}

function decodeUtf8(bytes, label) {
  try {
    return UTF8_DECODER.decode(bytes);
  } catch {
    fail('review-source-invalid-utf8', `${label} must use valid UTF-8`);
  }
}

function trimFinalLf(bytes, label) {
  return decodeUtf8(bytes, label).replace(/\r?\n$/u, '');
}

function exactObjectId(value, label) {
  if (typeof value !== 'string' || !GIT_OBJECT_ID_RE.test(value)) {
    fail('invalid-review-revision', `${label} must be one lowercase Git object ID`);
  }
  return value;
}

function literalPathspec(value) {
  return `:(literal)${value}`;
}

function parseTreeEntry(bytes, expectedPath, label, { allowMissing = false } = {}) {
  if (bytes.length === 0 && allowMissing) return null;
  if (bytes.length === 0 || bytes.at(-1) !== 0) {
    fail('invalid-review-tree-entry', `${label} must contain one NUL-terminated tree entry`);
  }
  const text = decodeUtf8(bytes.subarray(0, -1), label);
  if (text.includes('\0')) fail('invalid-review-tree-entry', `${label} contains multiple entries`);
  const match = text.match(/^(\d{6}) (\S+) ([0-9a-f]{40}|[0-9a-f]{64})\t([\s\S]+)$/u);
  if (!match || match[4] !== expectedPath) {
    fail('invalid-review-tree-entry', `${label} does not identify the exact requested path`);
  }
  return { mode: match[1], type: match[2], objectId: match[3] };
}

async function runGit(git, checkout, args, options) {
  try {
    return Buffer.from(await git(checkout, args, options));
  } catch (error) {
    if (error instanceof OwnerAlphaError) throw error;
    fail('review-git-failed', `git ${args[0] ?? 'command'} failed during proposal review`, {
      command: args[0] ?? null,
      cause: error?.code ?? error?.message ?? 'unknown',
    });
  }
}

async function readBlob(git, checkout, objectIdInput, label, maximum) {
  const objectId = exactObjectId(objectIdInput, `${label} object ID`);
  const type = trimFinalLf(await runGit(git, checkout, ['cat-file', '-t', objectId]), `${label} type`);
  if (type !== 'blob') fail('review-object-not-blob', `${label} must resolve to a blob`);
  const sizeText = trimFinalLf(await runGit(git, checkout, ['cat-file', '-s', objectId]), `${label} size`);
  if (!/^\d+$/u.test(sizeText)) fail('invalid-review-blob-size', `${label} returned an invalid size`);
  const size = Number(sizeText);
  if (!Number.isSafeInteger(size) || size < 0 || size > maximum) {
    fail('review-blob-too-large', `${label} exceeds its byte limit`, {
      maximum,
      actual: Number.isSafeInteger(size) ? size : null,
    });
  }
  const bytes = await runGit(git, checkout, ['cat-file', '-p', objectId], { maxBytes: maximum + 1 });
  if (bytes.length !== size) fail('review-blob-size-mismatch', `${label} changed while it was read`);
  return bytes;
}

async function readTrustPolicy(git, checkout, revision) {
  const tree = await runGit(git, checkout, [
    'ls-tree', '-z', revision, '--', literalPathspec(TRUST_POLICY_PATH),
  ]);
  const entry = parseTreeEntry(tree, TRUST_POLICY_PATH, 'review trust policy tree entry', {
    allowMissing: true,
  });
  if (entry === null) return deepFreeze({ status: 'missing', digest: null, config: null });
  if (entry.type !== 'blob' || !REGULAR_BLOB_MODES.has(entry.mode)) {
    return deepFreeze({ status: 'malformed', digest: null, config: null });
  }
  try {
    const bytes = await readBlob(git, checkout, entry.objectId, 'review trust policy', TRUST_POLICY_MAX_BYTES);
    const config = parseConfig(decodeUtf8(bytes, 'review trust policy'));
    if (config === null) return deepFreeze({ status: 'malformed', digest: null, config: null });
    return deepFreeze({ status: 'valid', digest: digestBytes(bytes), config });
  } catch (error) {
    if (['review-blob-too-large', 'review-source-invalid-utf8', 'review-object-not-blob'].includes(error?.code)) {
      return deepFreeze({ status: 'malformed', digest: null, config: null });
    }
    throw error;
  }
}

function pathMatchesPolicy(relativePath, policy) {
  let included;
  let excluded;
  try {
    included = policy.include.some((pattern) => path.matchesGlob(relativePath, pattern));
    excluded = policy.exclude.some((pattern) => path.matchesGlob(relativePath, pattern));
  } catch (error) {
    fail('invalid-path-policy', 'configured source path glob could not be evaluated', {
      cause: error?.message ?? 'unknown',
    });
  }
  if (!included || excluded) {
    fail('review-source-path-forbidden', 'proposal source path is outside owner policy');
  }
}

function clockMilliseconds(clock) {
  const value = clock();
  const milliseconds = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(milliseconds)) fail('invalid-review-clock', 'proposal review clock is invalid');
  return milliseconds;
}

function assertReviewWindow(evidence, now) {
  if (now < Date.parse(evidence.receipt.receivedAt)) {
    fail('review-before-receipt', 'owner clock precedes proposal receipt');
  }
  if (now >= Date.parse(evidence.receipt.expiresAt)) {
    fail('review-expired', 'proposal review evidence has expired');
  }
}

async function validateCheckout(config, git) {
  const checkout = config.repository.checkout;
  let resolved;
  try {
    resolved = await realpath(checkout);
    if (!(await stat(resolved)).isDirectory()) fail('review-checkout-unavailable', 'owner checkout is not a directory');
  } catch (error) {
    if (error instanceof OwnerAlphaError) throw error;
    fail('review-checkout-unavailable', 'owner checkout could not be resolved', {
      cause: error?.code ?? 'unknown',
    });
  }
  if (resolved !== checkout) fail('review-checkout-symlink', 'owner checkout must be its exact real path');

  const gitRootRaw = trimFinalLf(
    await runGit(git, checkout, ['rev-parse', '--show-toplevel']),
    'review Git root',
  );
  let gitRoot;
  try {
    gitRoot = await realpath(gitRootRaw);
  } catch (error) {
    fail('review-checkout-not-root', 'Git returned an unresolvable worktree root', {
      cause: error?.code ?? 'unknown',
    });
  }
  if (gitRoot !== checkout) fail('review-checkout-not-root', 'owner checkout must be the Git worktree root');

  const origin = trimFinalLf(
    await runGit(git, checkout, ['remote', 'get-url', config.repository.remote.name]),
    'review Git remote URL',
  );
  const pushOrigin = trimFinalLf(
    await runGit(git, checkout, ['remote', 'get-url', '--push', config.repository.remote.name]),
    'review Git push URL',
  );
  if (origin !== config.repository.remote.url || pushOrigin !== config.repository.remote.url) {
    fail('review-checkout-origin-mismatch', 'owner checkout remote does not match review policy');
  }
  return checkout;
}

export async function validateOwnerReviewEvidence({
  config: configInput,
  evidence: evidenceInput,
  clock = () => new Date(),
  git = defaultProposalReviewGit,
} = {}) {
  const config = validateOwnerAlphaConfig(configInput);
  const evidence = dependency('proposal review evidence', () => validateReviewEvidence(evidenceInput));
  const startedAt = clockMilliseconds(clock);

  if (evidence.state.state !== 'pending-review'
    || evidence.state.revision !== 0
    || evidence.state.updatedAt !== evidence.receipt.receivedAt) {
    fail('review-not-actionable', 'owner review requires exact pending-review queue evidence');
  }
  assertReviewWindow(evidence, startedAt);
  if (evidence.proposal.source.repository !== config.repository.remote.url) {
    fail('review-repository-mismatch', 'proposal repository does not match owner policy');
  }
  pathMatchesPolicy(evidence.proposal.source.path, config.paths);
  const sourcePartition = digestBytes(Buffer.from(
    `${evidence.proposal.source.repository}\0${evidence.proposal.source.path}`,
    'utf8',
  ));
  if (sourcePartition !== evidence.receipt.sourcePartitionDigest) {
    fail('review-source-partition-mismatch', 'proposal receipt does not bind the exact source partition');
  }

  const checkout = await validateCheckout(config, git);
  const revision = exactObjectId(evidence.proposal.source.revision, 'proposal source revision');
  const revisionType = trimFinalLf(
    await runGit(git, checkout, ['cat-file', '-t', revision]),
    'proposal source revision type',
  );
  if (revisionType !== 'commit') fail('review-object-not-commit', 'proposal source revision must resolve to a commit');
  const resolvedRevision = trimFinalLf(
    await runGit(git, checkout, ['rev-parse', '--verify', `${revision}^{commit}`]),
    'resolved proposal source revision',
  );
  if (resolvedRevision !== revision) {
    fail('review-revision-mismatch', 'proposal source revision did not resolve to itself exactly');
  }
  let mergeBase;
  try {
    mergeBase = trimFinalLf(
      await runGit(git, checkout, [
        'merge-base', revision, `refs/heads/${config.repository.branch}`,
      ]),
      'proposal source branch merge base',
    );
  } catch (error) {
    if (error instanceof OwnerAlphaError && error.code === 'review-git-failed') {
      fail('review-revision-unreachable', 'proposal source revision is not reachable from the configured branch');
    }
    throw error;
  }
  if (mergeBase !== revision) {
    fail('review-revision-unreachable', 'proposal source revision is not reachable from the configured branch');
  }

  const sourcePath = evidence.proposal.source.path;
  const tree = await runGit(git, checkout, [
    'ls-tree', '-z', revision, '--', literalPathspec(sourcePath),
  ]);
  const entry = parseTreeEntry(tree, sourcePath, 'review source tree entry');
  if (entry.type !== 'blob' || !REGULAR_BLOB_MODES.has(entry.mode)) {
    fail('unsupported-review-source', 'proposal source must be one regular Git blob');
  }
  const baseBytes = await readBlob(
    git,
    checkout,
    entry.objectId,
    'review source Markdown blob',
    config.limits.maxSourceBytes,
  );
  decodeUtf8(baseBytes, 'review source Markdown blob');
  const candidateBytes = dependency(
    'base-bound proposal application',
    () => applyProposal(baseBytes, evidence.proposal),
  );

  const policy = await readTrustPolicy(git, checkout, revision);
  if (policy.status !== evidence.classification.policyStatus
    || policy.digest !== evidence.classification.policyDigest) {
    fail('review-policy-mismatch', 'base-bound trust policy contradicts queue classification evidence');
  }
  const classification = dependency('base-bound trust classification', () => classifyProposal(
    baseBytes,
    evidence.proposal,
    policy.config,
    evidence.classification.verifiedSubject,
  ));
  if (canonicalJson(classification) !== canonicalJson(evidence.classification.classification)) {
    fail('review-classification-mismatch', 'queue classification does not match independently recomputed evidence');
  }

  const completedAt = clockMilliseconds(clock);
  if (completedAt < startedAt) fail('invalid-review-clock', 'proposal review clock moved backwards');
  assertReviewWindow(evidence, completedAt);
  const summary = dependency('proposal review summary', () => createReviewSummary(evidence));
  return deepFreeze({
    summary,
    evidence,
    document: readableDocument(baseBytes, candidateBytes),
    sourceVerification: {
      revision,
      path: sourcePath,
      gitMode: entry.mode,
      gitObjectId: entry.objectId,
      baseByteLength: baseBytes.length,
      baseDigest: evidence.proposal.operation.baseDigest,
      candidateByteLength: candidateBytes.length,
      candidateDigest: evidence.proposal.operation.candidateDigest,
      policyStatus: policy.status,
      policyDigest: policy.digest,
    },
  });
}

export function createOwnerProposalReviewSource({
  config,
  client,
  clock = () => new Date(),
  git = defaultProposalReviewGit,
} = {}) {
  const normalizedConfig = validateOwnerAlphaConfig(config);
  if (!client || typeof client.list !== 'function' || typeof client.load !== 'function') {
    fail('invalid-review-source', 'owner proposal review source requires list and load methods');
  }

  async function load(queueId) {
    const evidence = await client.load(queueId);
    return validateOwnerReviewEvidence({
      config: normalizedConfig,
      evidence,
      clock,
      git,
    });
  }

  return Object.freeze({
    async list(options = {}) {
      const page = await client.list(options);
      const entries = [];
      for (const advertised of page.entries) {
        const validated = await load(advertised.queueId);
        dependency(
          'advertised proposal review summary',
          () => validateReviewSummary(advertised, validated.evidence),
        );
        entries.push(validated);
      }
      return deepFreeze({ entries, nextCursor: page.nextCursor });
    },
    load,
  });
}

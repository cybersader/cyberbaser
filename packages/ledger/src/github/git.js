import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { checkChange } from '@cyberbaser/ofm';
import { parseConfig } from '@cyberbaser/trust';
import yaml from 'js-yaml';
import { LedgerGithubError } from './contract.js';

const execFileAsync = promisify(execFile);
const SHA_RE = /^[0-9a-f]{40}$/;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

export const TRUST_POLICY_PATH = '.cyberbaser/trust.yml';
export const GIT_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
export const GIT_MAX_DIFF_BYTES = 4 * 1024 * 1024;
export const GIT_MAX_CHANGED_FILES = 1_000;
export const GIT_MAX_MARKDOWN_FILE_BYTES = 4 * 1024 * 1024;
export const GIT_MAX_TOTAL_MARKDOWN_BYTES = 32 * 1024 * 1024;
export const TRUST_POLICY_MAX_BYTES = 64 * 1024;

function fail(code, message, details = {}) {
  throw new LedgerGithubError(code, message, details);
}

function requireSha(value, label) {
  if (typeof value !== 'string' || !SHA_RE.test(value)) {
    fail('invalid-git-sha', `${label} must be a lowercase 40-character Git object ID`);
  }
  return value;
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail('invalid-positive-integer', `${label} must be a positive safe integer`);
  }
  return value;
}

function requireDecimalId(value, label) {
  if (typeof value !== 'string' || !/^[1-9]\d{0,19}$/.test(value)) {
    fail('invalid-id', `${label} must be a canonical positive decimal string`);
  }
  return value;
}

function asBuffer(value, label) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  fail('invalid-git-output', `${label} must return bytes or text`);
}

function decodeUtf8(bytes, label) {
  try {
    return UTF8_DECODER.decode(bytes);
  } catch {
    fail('invalid-git-utf8', `${label} is not valid UTF-8`);
  }
}

function trimFinalLf(value) {
  return value.replace(/\r?\n$/, '');
}

export function createGitReader({ checkout, command = 'git', maxOutputBytes = GIT_MAX_OUTPUT_BYTES } = {}) {
  if (typeof checkout !== 'string' || checkout.length === 0) {
    fail('invalid-checkout', 'checkout must be a non-empty path');
  }
  if (typeof command !== 'string' || command.length === 0) fail('invalid-git-command', 'command must be non-empty');
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    fail('invalid-git-bound', 'maxOutputBytes must be a positive safe integer');
  }
  return async function git(args) {
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
      fail('invalid-git-arguments', 'git arguments must be an array of strings');
    }
    try {
      const { stdout } = await execFileAsync(command, ['-C', checkout, ...args], {
        encoding: 'buffer',
        maxBuffer: maxOutputBytes,
        windowsHide: true,
      });
      return asBuffer(stdout, 'git stdout');
    } catch (error) {
      if (error instanceof LedgerGithubError) throw error;
      fail('git-command-failed', `git ${args[0] ?? 'command'} failed`, {
        exitCode: Number.isSafeInteger(error?.code) ? error.code : null,
      });
    }
  };
}

async function run(git, args, label) {
  if (typeof git !== 'function') fail('invalid-git-reader', 'git must be an injected function');
  try {
    return asBuffer(await git(args), label);
  } catch (error) {
    if (error instanceof LedgerGithubError) throw error;
    fail('git-command-failed', `${label} failed`, { cause: error?.message ?? String(error) });
  }
}

async function requireCommit(git, sha, label) {
  const type = trimFinalLf(decodeUtf8(await run(git, ['cat-file', '-t', sha], `${label} type`), `${label} type`));
  if (type !== 'commit') fail('git-object-not-commit', `${label} must resolve to a commit`, { type });
}

async function requireRefSha(git, ref, expectedSha, label) {
  const actual = trimFinalLf(decodeUtf8(
    await run(git, ['rev-parse', '--verify', `${ref}^{commit}`], `${label} ref`),
    `${label} ref`,
  ));
  if (actual !== expectedSha) {
    fail('git-ref-sha-mismatch', `${label} ref does not match the authoritative GitHub SHA`, {
      expected: expectedSha,
      actual,
    });
  }
}

export async function fetchAndVerifyPullRequestObjects({
  git,
  remote = 'origin',
  sourceRunId,
  pullRequest,
} = {}) {
  if (typeof remote !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(remote)) {
    fail('invalid-git-remote', 'remote must be a simple configured Git remote name');
  }
  const runId = requireDecimalId(sourceRunId, 'sourceRunId');
  if (pullRequest === null || typeof pullRequest !== 'object' || Array.isArray(pullRequest)) {
    fail('invalid-pull-request', 'pullRequest must be an object');
  }
  const prNumber = requirePositiveInteger(pullRequest.number, 'pullRequest.number');
  const baseSha = requireSha(pullRequest.base?.sha, 'pullRequest.base.sha');
  const headSha = requireSha(pullRequest.head?.sha, 'pullRequest.head.sha');
  const merged = pullRequest.merged;
  if (typeof merged !== 'boolean') fail('invalid-merged-flag', 'pullRequest.merged must be boolean');
  const mergeSha = merged ? requireSha(pullRequest.merge_commit_sha, 'pullRequest.merge_commit_sha') : null;
  const namespace = `refs/cyberbaser/ledger/run-${runId}-pr-${prNumber}`;
  const baseRef = `${namespace}/base`;
  const headRef = `${namespace}/head`;
  const mergeRef = `${namespace}/merge`;

  await run(git, [
    'fetch', '--no-tags', '--no-recurse-submodules', remote, `+${baseSha}:${baseRef}`,
  ], 'base commit fetch');
  await run(git, [
    'fetch', '--no-tags', '--no-recurse-submodules', remote, `+refs/pull/${prNumber}/head:${headRef}`,
  ], 'pull-request head fetch');
  if (mergeSha !== null) {
    await run(git, [
      'fetch', '--no-tags', '--no-recurse-submodules', remote, `+${mergeSha}:${mergeRef}`,
    ], 'merge commit fetch');
  }

  await requireRefSha(git, baseRef, baseSha, 'base');
  await requireRefSha(git, headRef, headSha, 'pull-request head');
  await requireCommit(git, baseSha, 'base object');
  await requireCommit(git, headSha, 'head object');
  if (mergeSha !== null) {
    await requireRefSha(git, mergeRef, mergeSha, 'merge');
    await requireCommit(git, mergeSha, 'merge object');
  }

  return { baseSha, headSha, mergeSha, baseRef, headRef, mergeRef: mergeSha === null ? null : mergeRef };
}

async function readBlob(git, objectSpec, { label, maxBytes }) {
  const type = trimFinalLf(decodeUtf8(
    await run(git, ['cat-file', '-t', objectSpec], `${label} type`),
    `${label} type`,
  ));
  if (type !== 'blob') fail('git-object-not-blob', `${label} must be a regular Git blob`, { type });
  const bytes = await run(git, ['cat-file', '-p', objectSpec], label);
  if (bytes.length > maxBytes) {
    fail('git-blob-too-large', `${label} exceeds ${maxBytes} bytes`, { bytes: bytes.length });
  }
  return bytes;
}

function validatePolicySource(text) {
  let source;
  try {
    source = yaml.load(text);
  } catch {
    fail('malformed-base-policy', `base-bound ${TRUST_POLICY_PATH} is malformed`);
  }
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    fail('malformed-base-policy', `base-bound ${TRUST_POLICY_PATH} must contain one policy object`);
  }
  const agents = Object.hasOwn(source, 'agents') ? source.agents : [];
  if (!Array.isArray(agents)
    || agents.some((agent) => typeof agent !== 'string' || agent.length === 0 || agent.trim() !== agent)) {
    fail('malformed-base-policy', `base-bound ${TRUST_POLICY_PATH} has an invalid agents list`);
  }
  return agents.map((agent) => agent.toLowerCase());
}

export async function readBaseTrustPolicy({
  git,
  baseSha,
  parseConfigImpl = parseConfig,
} = {}) {
  const sha = requireSha(baseSha, 'baseSha');
  if (typeof parseConfigImpl !== 'function') fail('invalid-policy-parser', 'parseConfigImpl must be a function');
  let bytes;
  try {
    bytes = await readBlob(git, `${sha}:${TRUST_POLICY_PATH}`, {
      label: 'base-bound trust policy',
      maxBytes: TRUST_POLICY_MAX_BYTES,
    });
  } catch (error) {
    if (error instanceof LedgerGithubError && error.code === 'git-command-failed') {
      fail('missing-base-policy', `base commit must contain ${TRUST_POLICY_PATH}`);
    }
    throw error;
  }
  const text = decodeUtf8(bytes, 'base-bound trust policy');
  const expectedAgents = validatePolicySource(text);
  const policy = parseConfigImpl(text);
  if (!policy) fail('malformed-base-policy', `base-bound ${TRUST_POLICY_PATH} is malformed`);
  if (!Array.isArray(policy.agents)
    || policy.agents.some((agent) => typeof agent !== 'string')
    || policy.agents.length !== expectedAgents.length
    || policy.agents.some((agent, index) => agent !== expectedAgents[index])) {
    fail('malformed-base-policy', `base-bound ${TRUST_POLICY_PATH} has an invalid agents list`);
  }
  return policy;
}

function parseNameStatus(bytes) {
  if (bytes.length > GIT_MAX_DIFF_BYTES) {
    fail('git-diff-too-large', `Git name-status output exceeds ${GIT_MAX_DIFF_BYTES} bytes`);
  }
  if (bytes.length === 0) return [];
  if (bytes[bytes.length - 1] !== 0) fail('malformed-git-diff', 'Git name-status output must end with NUL');
  const fields = decodeUtf8(bytes.subarray(0, -1), 'Git name-status output').split('\0');
  if (fields.length % 2 !== 0) fail('malformed-git-diff', 'Git name-status output has an incomplete record');
  const changes = [];
  for (let index = 0; index < fields.length; index += 2) {
    const status = fields[index];
    const path = fields[index + 1];
    if (!/^[ADM]$/.test(status)) {
      fail('unsupported-git-diff-status', `unsupported Git name-status ${JSON.stringify(status)}`);
    }
    if (path.length === 0) fail('malformed-git-diff', 'Git name-status path must not be empty');
    changes.push({ status, path });
  }
  if (changes.length > GIT_MAX_CHANGED_FILES) {
    fail('too-many-changed-files', `change contains more than ${GIT_MAX_CHANGED_FILES} files`);
  }
  return changes;
}

export async function recomputeOfmVerdict({
  git,
  baseSha,
  headSha,
  checkChangeImpl = checkChange,
} = {}) {
  const base = requireSha(baseSha, 'baseSha');
  const head = requireSha(headSha, 'headSha');
  if (typeof checkChangeImpl !== 'function') fail('invalid-ofm-checker', 'checkChangeImpl must be a function');
  const diffBytes = await run(git, [
    'diff', '--name-status', '-z', '--no-renames', base, head, '--',
  ], 'Git name-status diff');
  const changes = parseNameStatus(diffBytes);
  const markdown = changes.filter(({ status, path }) => (
    status === 'M' && /\.(?:md|mdx)$/i.test(path)
  ));
  if (markdown.length === 0) return 'not-applicable';

  const verdicts = [];
  let totalBytes = 0;
  for (const change of markdown) {
    const beforeBytes = await readBlob(git, `${base}:${change.path}`, {
      label: `base Markdown ${change.path}`,
      maxBytes: GIT_MAX_MARKDOWN_FILE_BYTES,
    });
    const afterBytes = await readBlob(git, `${head}:${change.path}`, {
      label: `head Markdown ${change.path}`,
      maxBytes: GIT_MAX_MARKDOWN_FILE_BYTES,
    });
    totalBytes += beforeBytes.length + afterBytes.length;
    if (totalBytes > GIT_MAX_TOTAL_MARKDOWN_BYTES) {
      fail('markdown-total-too-large', `Markdown evidence exceeds ${GIT_MAX_TOTAL_MARKDOWN_BYTES} bytes`);
    }
    const before = decodeUtf8(beforeBytes, `base Markdown ${change.path}`);
    const after = decodeUtf8(afterBytes, `head Markdown ${change.path}`);
    let result;
    try {
      result = checkChangeImpl(before, after);
    } catch (error) {
      fail('ofm-recomputation-failed', `OFM recomputation failed for ${change.path}`, {
        cause: error?.message ?? String(error),
      });
    }
    if (!result || !new Set(['clean', 'suspect', 'damage']).has(result.verdict)) {
      fail('invalid-ofm-result', `OFM returned an invalid verdict for ${change.path}`);
    }
    verdicts.push(result.verdict);
  }

  if (verdicts.includes('damage')) return 'damage';
  if (verdicts.includes('suspect')) return 'suspect';
  return 'clean';
}

export async function reconstructGitEvidence(options = {}) {
  const objects = await fetchAndVerifyPullRequestObjects(options);
  const policy = await readBaseTrustPolicy({
    git: options.git,
    baseSha: objects.baseSha,
    parseConfigImpl: options.parseConfigImpl,
  });
  const ofmVerdict = await recomputeOfmVerdict({
    git: options.git,
    baseSha: objects.baseSha,
    headSha: objects.headSha,
    checkChangeImpl: options.checkChangeImpl,
  });
  return { objects, policy, ofmVerdict };
}

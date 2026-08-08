import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { applyCorrection } from '../../../packages/correction/src/index.js';
import { fail, OwnerAlphaError } from './errors.js';

const execFileAsync = promisify(execFile);
const COMMIT_RE = /^[0-9a-f]{40}$/u;
const DIGEST_RE = /^sha-256=:[A-Za-z0-9+/]{43}=:$/u;
const MAX_GIT_OUTPUT = 64 * 1024 * 1024;
const SAFE_TREE_MODES = new Set(['100644', '100755']);

function freeze(value) {
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function exactCommit(value, label) {
  if (typeof value !== 'string' || !COMMIT_RE.test(value)) {
    fail('invalid-commit', `${label} must be one lowercase 40-character Git object ID`);
  }
  return value;
}

function repositoryPath(value) {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > 4096
    || value.includes('\\')
    || value.includes('\0')
    || /\p{Cc}/u.test(value)
    || path.posix.isAbsolute(value)) {
    fail('invalid-source-path', 'sourcePath must be one exact repository-relative POSIX path');
  }
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')
    || segments[0] === '.git') {
    fail('invalid-source-path', 'sourcePath must not contain empty, dot, parent, or Git metadata segments');
  }
  return value;
}

function branchName(value) {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > 255
    || value === '@'
    || value.startsWith('/')
    || value.endsWith('/')
    || value.endsWith('.')
    || value.includes('..')
    || value.includes('//')
    || value.includes('@{')
    || /[ ~^:?*[\\\p{Cc}]/u.test(value)
    || value.split('/').some((segment) => segment.startsWith('.') || segment.endsWith('.lock'))) {
    fail('invalid-branch', 'branch must be one exact safe Git branch name');
  }
  return value;
}

function remoteName(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)) {
    fail('invalid-remote', 'remote must be one exact configured Git remote name');
  }
  return value;
}

function remoteUrl(value) {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > 4096
    || value.trim() !== value
    || /[\r\n\0]/u.test(value)) {
    fail('invalid-remote-url', 'remoteUrl must be one exact configured Git destination');
  }
  return value;
}

function applicationBinding(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('applied-candidate-required', 'an exact applied candidate binding is required');
  }
  const source = input.source && typeof input.source === 'object' ? input.source : {};
  const baseCommit = exactCommit(input.baseCommit ?? source.baseCommit, 'baseCommit');
  const sourcePath = repositoryPath(input.sourcePath ?? source.path ?? source.repositoryRelativePath);
  const correction = input.correction;
  if (!correction || typeof correction !== 'object' || Array.isArray(correction)) {
    fail('applied-candidate-required', 'applied candidate must retain its prepared correction');
  }
  const candidateBytes = Buffer.isBuffer(input.candidateBytes) || input.candidateBytes instanceof Uint8Array
    ? Buffer.from(input.candidateBytes)
    : null;
  if (!candidateBytes) fail('applied-candidate-required', 'applied candidate must contain exact candidate bytes');
  const candidateDigest = input.candidateDigest ?? correction.candidateDigest;
  if (typeof candidateDigest !== 'string' || !DIGEST_RE.test(candidateDigest)) {
    fail('invalid-candidate-digest', 'applied candidate must contain one exact SHA-256 digest');
  }
  if (correction.candidateDigest !== candidateDigest || sha256Digest(candidateBytes) !== candidateDigest) {
    fail('applied-candidate-mismatch', 'candidate bytes, correction, and accepted digest must agree exactly');
  }
  return { baseCommit, sourcePath, correction, candidateBytes, candidateDigest };
}

function sha256Digest(bytes) {
  return `sha-256=:${createHash('sha256').update(bytes).digest('base64')}:`;
}

function parseNul(bytes) {
  const records = Buffer.from(bytes).toString('utf8').split('\0');
  if (records.at(-1) === '') records.pop();
  return records;
}

function parseTreeEntry(bytes, expectedPath, revision) {
  const records = parseNul(bytes);
  if (records.length !== 1) {
    fail('commit-tree-entry-mismatch', `sourcePath must identify exactly one blob at ${revision}`);
  }
  const match = records[0].match(/^([0-7]{6}) (blob) ([0-9a-f]{40})\t([\s\S]+)$/u);
  if (!match || match[4] !== expectedPath || !SAFE_TREE_MODES.has(match[1])) {
    fail('commit-tree-entry-mismatch', `sourcePath must identify one regular blob at ${revision}`);
  }
  return { mode: match[1], objectId: match[3], path: match[4] };
}

function parseIndexEntry(bytes, expectedPath) {
  const records = parseNul(bytes);
  if (records.length !== 1) fail('index-path-mismatch', 'Git index must contain exactly one expected source entry');
  const match = records[0].match(/^([0-7]{6}) ([0-9a-f]{40}) ([0-3])\t([\s\S]+)$/u);
  if (!match || match[3] !== '0' || match[4] !== expectedPath || !SAFE_TREE_MODES.has(match[1])) {
    fail('index-path-mismatch', 'Git index entry must be the exact stage-zero regular source path');
  }
  return { mode: match[1], objectId: match[2], path: match[4] };
}

function commandEnvironment(environment = process.env) {
  return {
    ...environment,
    GIT_TERMINAL_PROMPT: '0',
    GIT_EDITOR: ':',
    GIT_SEQUENCE_EDITOR: ':',
    GIT_MERGE_AUTOEDIT: 'no',
  };
}

async function rawGit(checkout, args, { encoding = 'buffer', env = process.env } = {}) {
  try {
    const result = await execFileAsync('git', ['-C', checkout, ...args], {
      encoding,
      env: commandEnvironment(env),
      maxBuffer: MAX_GIT_OUTPUT,
    });
    return encoding === 'buffer' ? Buffer.from(result.stdout) : String(result.stdout).trim();
  } catch (error) {
    const wrapped = new Error(`git ${args[0]} failed`);
    wrapped.exitCode = error?.code;
    wrapped.stdout = String(error?.stdout ?? '').trim().slice(-4000);
    wrapped.stderr = String(error?.stderr ?? '').trim().slice(-4000);
    throw wrapped;
  }
}

async function defaultGit(checkout, args, options) {
  try {
    return await rawGit(checkout, args, options);
  } catch (error) {
    fail('git-publication-inspection-failed', `git ${args[0]} failed during exact publication verification`, {
      exitCode: error.exitCode,
      stderr: error.stderr,
    });
  }
}

function dependencies(overrides = {}) {
  return { git: defaultGit, mutateGit: rawGit, ...overrides };
}

async function assertCheckout(checkout, git) {
  if (typeof checkout !== 'string' || !path.isAbsolute(checkout) || path.normalize(checkout) !== checkout) {
    fail('invalid-checkout', 'checkout must be one normalized absolute path');
  }
  const root = await git(checkout, ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (path.resolve(root) !== checkout) fail('checkout-not-root', 'checkout must identify the exact Git worktree root');
}

function commitMessage(prefix, requested, sourcePath) {
  if (typeof prefix !== 'string'
    || prefix.length === 0
    || prefix.length > 100
    || prefix.trim() !== prefix
    || /\p{Cc}/u.test(prefix)) {
    fail('invalid-commit-prefix', 'commitMessagePrefix must be one non-empty exact line');
  }
  const message = requested ?? `${prefix} ${sourcePath}`;
  if (typeof message !== 'string'
    || message.length === 0
    || message.length > 998
    || message.trim() !== message
    || /[\r\n\0]/u.test(message)
    || !(message === prefix || message.startsWith(`${prefix} `))) {
    fail('invalid-commit-message', 'commit message must be one exact line beginning with the configured prefix');
  }
  return message;
}

async function exactRemoteRef(checkout, remote, branch, git) {
  const output = await git(checkout, ['ls-remote', '--refs', remote, `refs/heads/${branch}`], { encoding: 'utf8' });
  if (output === '') return null;
  const lines = output.split('\n');
  if (lines.length !== 1) fail('remote-ref-ambiguous', 'configured remote returned more than one exact branch ref');
  const match = lines[0].match(/^([0-9a-f]{40})\trefs\/heads\/([^\s]+)$/u);
  if (!match || match[2] !== branch) fail('remote-ref-invalid', 'configured remote returned an invalid exact branch ref');
  return match[1];
}

async function assertRemoteDestination(checkout, remote, expectedUrl, git) {
  const [fetchUrl, pushUrl] = await Promise.all([
    git(checkout, ['remote', 'get-url', remote], { encoding: 'utf8' }),
    git(checkout, ['remote', 'get-url', '--push', remote], { encoding: 'utf8' }),
  ]);
  if (fetchUrl !== expectedUrl || pushUrl !== expectedUrl) {
    fail('remote-destination-mismatch', 'configured Git fetch and push destinations must both equal policy', {
      expected: expectedUrl,
      fetchUrl,
      pushUrl,
    });
  }
}

/** Independently prove a commit is the exact accepted one-file splice. */
export async function verifyExactCommit({
  checkout,
  commit,
  application,
  expectedMessage,
} = {}, overrides = {}) {
  const deps = dependencies(overrides);
  const binding = applicationBinding(application);
  await assertCheckout(checkout, deps.git);
  const revision = exactCommit(commit, 'commit');
  await deps.git(checkout, ['cat-file', '-e', `${revision}^{commit}`]);
  const ancestry = (await deps.git(checkout, ['rev-list', '--parents', '-n', '1', revision], { encoding: 'utf8' }))
    .split(/\s+/u);
  if (ancestry.length !== 2 || ancestry[0] !== revision || ancestry[1] !== binding.baseCommit) {
    fail('commit-parent-mismatch', 'application commit must have exactly one parent equal to the accepted base', {
      expectedBase: binding.baseCommit,
      ancestry,
    });
  }
  const committedMessage = await deps.git(
    checkout,
    ['show', '-s', '--format=%B', revision],
    { encoding: 'utf8' },
  );
  if (expectedMessage !== undefined && committedMessage !== expectedMessage) {
    fail('commit-message-mismatch', 'application commit message must equal the exact authorized message', {
      expected: expectedMessage,
      actual: committedMessage,
    });
  }

  const changedPaths = parseNul(await deps.git(checkout, [
    'diff-tree', '--no-commit-id', '--name-only', '-r', '-z', '--no-renames',
    binding.baseCommit, revision, '--',
  ]));
  if (changedPaths.length !== 1 || changedPaths[0] !== binding.sourcePath) {
    fail('commit-path-mismatch', 'application commit must change exactly the accepted source path', {
      expectedPath: binding.sourcePath,
      changedPaths,
    });
  }

  const [baseEntry, candidateEntry] = await Promise.all([
    deps.git(checkout, ['ls-tree', '-z', '--full-tree', binding.baseCommit, '--', binding.sourcePath])
      .then((bytes) => parseTreeEntry(bytes, binding.sourcePath, binding.baseCommit)),
    deps.git(checkout, ['ls-tree', '-z', '--full-tree', revision, '--', binding.sourcePath])
      .then((bytes) => parseTreeEntry(bytes, binding.sourcePath, revision)),
  ]);
  if (baseEntry.mode !== candidateEntry.mode) {
    fail('commit-mode-changed', 'application commit must preserve the exact source mode');
  }
  const [baseBytes, committedBytes] = await Promise.all([
    deps.git(checkout, ['cat-file', 'blob', baseEntry.objectId]),
    deps.git(checkout, ['cat-file', 'blob', candidateEntry.objectId]),
  ]);
  let reconstructed;
  try {
    reconstructed = applyCorrection(baseBytes, binding.correction);
  } catch (error) {
    fail('commit-splice-reconstruction-failed', 'accepted correction could not be reconstructed from the commit parent', {
      correctionCode: error?.code ?? 'unknown',
    });
  }
  const prefixIdentical = committedBytes.subarray(0, binding.correction.start)
    .equals(baseBytes.subarray(0, binding.correction.start));
  const suffixIdentical = committedBytes.subarray(
    binding.correction.start + binding.correction.replacementBytes.length,
  ).equals(baseBytes.subarray(binding.correction.end));
  if (!committedBytes.equals(binding.candidateBytes)
    || !committedBytes.equals(reconstructed)
    || sha256Digest(committedBytes) !== binding.candidateDigest
    || !prefixIdentical
    || !suffixIdentical) {
    fail('commit-candidate-mismatch', 'application commit blob must equal the exact accepted candidate splice');
  }

  return freeze({
    status: 'commit-verified',
    commit: revision,
    message: committedMessage,
    parentCommit: binding.baseCommit,
    sourcePath: binding.sourcePath,
    sourceMode: baseEntry.mode,
    parentBlob: baseEntry.objectId,
    candidateBlob: candidateEntry.objectId,
    candidateDigest: binding.candidateDigest,
    exactSplice: {
      start: binding.correction.start,
      end: binding.correction.end,
      prefixIdentical,
      suffixIdentical,
      committedBytesEqualCandidate: true,
    },
  });
}

/** Stage only the accepted path, create a noninteractive commit, and verify it independently. */
export async function commitAppliedCandidate({
  checkout,
  application,
  branch,
  commitMessagePrefix,
  message,
  useHooks = true,
} = {}, overrides = {}) {
  const deps = dependencies(overrides);
  const binding = applicationBinding(application);
  const targetBranch = branchName(branch);
  const exactMessage = commitMessage(commitMessagePrefix, message, binding.sourcePath);
  if (typeof useHooks !== 'boolean') fail('invalid-hooks-policy', 'useHooks must be an explicit boolean');
  await assertCheckout(checkout, deps.git);

  const [head, currentBranch, status, stagedPaths] = await Promise.all([
    deps.git(checkout, ['rev-parse', 'HEAD'], { encoding: 'utf8' }),
    deps.git(checkout, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { encoding: 'utf8' }),
    deps.git(checkout, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.']),
    deps.git(checkout, ['diff', '--cached', '--name-only', '-z', '--']),
  ]);
  if (head !== binding.baseCommit) fail('commit-base-mismatch', 'checkout HEAD must equal the accepted base before commit');
  if (currentBranch !== targetBranch) fail('commit-branch-mismatch', 'checkout branch must equal the configured publication branch');
  const statusRecords = parseNul(status);
  const staged = parseNul(stagedPaths);
  const allowedStatus = [` M ${binding.sourcePath}`, `M  ${binding.sourcePath}`];
  if (statusRecords.length !== 1 || !allowedStatus.includes(statusRecords[0])) {
    fail('commit-worktree-mismatch', 'only the exact applied source path may differ before staging', {
      status: statusRecords.slice(0, 20),
    });
  }
  if (staged.length > 0 && (staged.length !== 1 || staged[0] !== binding.sourcePath)) {
    fail('index-path-mismatch', 'Git index may contain only the expected source path');
  }

  try {
    await deps.mutateGit(checkout, ['add', '--', binding.sourcePath]);
  } catch (error) {
    throw new OwnerAlphaError('git-stage-failed', 'Git could not stage the exact applied source path', {
      stderr: error.stderr,
      recovery: 'reconcile-then-commit',
      automaticRollbackPerformed: false,
    });
  }
  const indexPaths = parseNul(await deps.git(checkout, ['diff', '--cached', '--name-only', '-z', '--']));
  if (indexPaths.length !== 1 || indexPaths[0] !== binding.sourcePath) {
    fail('index-path-mismatch', 'staging must produce exactly the expected source path in the index');
  }
  const [baseTree, indexEntry] = await Promise.all([
    deps.git(checkout, ['ls-tree', '-z', '--full-tree', binding.baseCommit, '--', binding.sourcePath])
      .then((bytes) => parseTreeEntry(bytes, binding.sourcePath, binding.baseCommit)),
    deps.git(checkout, ['ls-files', '--stage', '-z', '--', binding.sourcePath])
      .then((bytes) => parseIndexEntry(bytes, binding.sourcePath)),
  ]);
  if (indexEntry.mode !== baseTree.mode) fail('index-mode-changed', 'staged candidate must preserve the source mode');
  const stagedBytes = await deps.git(checkout, ['cat-file', 'blob', indexEntry.objectId]);
  if (!stagedBytes.equals(binding.candidateBytes) || sha256Digest(stagedBytes) !== binding.candidateDigest) {
    fail('index-blob-mismatch', 'staged blob must equal the exact accepted candidate');
  }

  const args = ['commit', '--no-gpg-sign'];
  if (!useHooks) args.push('--no-verify');
  args.push('-m', exactMessage);
  let commandFailure = null;
  try {
    await deps.mutateGit(checkout, args, { encoding: 'utf8', env: commandEnvironment() });
  } catch (error) {
    commandFailure = error;
  }
  const commit = await deps.git(checkout, ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (commit === binding.baseCommit) {
    throw new OwnerAlphaError('git-commit-not-created', 'Git commit did not complete; the exact staged candidate remains for reconciliation', {
      stderr: commandFailure?.stderr ?? '',
      recovery: 'reconcile-commit',
      automaticRollbackPerformed: false,
    });
  }

  let verification;
  try {
    verification = await verifyExactCommit({
      checkout,
      commit,
      application: binding,
      expectedMessage: exactMessage,
    }, overrides);
  } catch (error) {
    if (error instanceof OwnerAlphaError) {
      error.details = {
        ...error.details,
        recovery: 'manual-reconcile',
        automaticRollbackPerformed: false,
        commit,
      };
    }
    throw error;
  }
  const finalStatus = parseNul(await deps.git(checkout, [
    'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.',
  ]));
  if (finalStatus.length !== 0) {
    fail('post-commit-worktree-dirty', 'worktree must be clean after the exact application commit', {
      status: finalStatus.slice(0, 20),
      recovery: 'manual-reconcile',
      commit,
    });
  }
  return freeze({
    status: 'committed',
    recovery: 'resume-push',
    commit,
    message: exactMessage,
    hooksUsed: useHooks,
    verification,
    commandReportedFailure: commandFailure !== null,
  });
}

/** Push exactly commit:refs/heads/branch without force, then verify the remote ref. */
export async function pushExactCommit({
  checkout,
  application,
  commit,
  remote,
  remoteUrl: configuredRemoteUrl,
  branch,
  useHooks = true,
} = {}, overrides = {}) {
  const deps = dependencies(overrides);
  const binding = applicationBinding(application);
  const revision = exactCommit(commit, 'commit');
  const targetRemote = remoteName(remote);
  const targetRemoteUrl = remoteUrl(configuredRemoteUrl);
  const targetBranch = branchName(branch);
  if (typeof useHooks !== 'boolean') fail('invalid-hooks-policy', 'useHooks must be an explicit boolean');
  await assertCheckout(checkout, deps.git);
  await assertRemoteDestination(checkout, targetRemote, targetRemoteUrl, deps.git);
  await verifyExactCommit({ checkout, commit: revision, application: binding }, overrides);

  const before = await exactRemoteRef(checkout, targetRemote, targetBranch, deps.git);
  if (before === revision) {
    return freeze({
      status: 'already-pushed',
      recovery: 'resume-run-discovery',
      commit: revision,
      remote: targetRemote,
      remoteUrl: targetRemoteUrl,
      branch: targetBranch,
      remoteRef: revision,
      pushPerformed: false,
    });
  }
  if (before !== binding.baseCommit) {
    throw new OwnerAlphaError('remote-advanced', 'configured remote branch no longer equals the accepted base; no push was attempted', {
      expectedBase: binding.baseCommit,
      remoteHead: before,
      recovery: 'manual-reconcile',
      pushPerformed: false,
    });
  }

  const refspec = `${revision}:refs/heads/${targetBranch}`;
  const args = ['push', '--porcelain'];
  if (!useHooks) args.push('--no-verify');
  args.push(targetRemote, refspec);
  let pushFailure = null;
  try {
    await deps.mutateGit(checkout, args, { encoding: 'utf8', env: commandEnvironment() });
  } catch (error) {
    pushFailure = error;
  }
  const remoteHead = await exactRemoteRef(checkout, targetRemote, targetBranch, deps.git);
  if (remoteHead !== revision) {
    throw new OwnerAlphaError(
      remoteHead !== binding.baseCommit ? 'remote-advanced' : 'git-push-failed',
      'exact non-force push did not publish the verified commit; no rollback, rebase, or merge was attempted',
      {
        expectedCommit: revision,
        remoteHead,
        stderr: pushFailure?.stderr ?? '',
        recovery: 'manual-reconcile',
        forceUsed: false,
        automaticRollbackPerformed: false,
        automaticRebasePerformed: false,
        automaticMergePerformed: false,
      },
    );
  }

  return freeze({
    status: 'pushed',
    recovery: 'resume-run-discovery',
    commit: revision,
    remote: targetRemote,
    branch: targetBranch,
    refspec,
    remoteRef: remoteHead,
    hooksUsed: useHooks,
    forceUsed: false,
    commandReportedFailure: pushFailure !== null,
  });
}

export async function publishAppliedCandidate(options = {}, overrides = {}) {
  const committed = await commitAppliedCandidate(options, overrides);
  if (options.autoPush === false) {
    return freeze({ status: 'committed', committed, pushed: null });
  }
  const pushed = await pushExactCommit({
    checkout: options.checkout,
    application: options.application,
    commit: committed.commit,
    remote: options.remote,
    remoteUrl: options.remoteUrl,
    branch: options.branch,
    useHooks: options.useHooks,
  }, overrides);
  return freeze({ status: pushed.status, committed, pushed });
}

export const commitExactCandidate = commitAppliedCandidate;
export const pushVerifiedCommit = pushExactCommit;

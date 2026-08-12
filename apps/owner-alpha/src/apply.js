import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import {
  lstat,
  open,
  realpath,
  rename,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { applyCorrection } from '../../../packages/correction/src/index.js';
import { fail, OwnerAlphaError } from './errors.js';

const execFileAsync = promisify(execFile);
const COMMIT_RE = /^[0-9a-f]{40}$/u;
const DIGEST_RE = /^sha-256=:[A-Za-z0-9+/]{43}=:$/u;
const SAFE_TREE_MODES = new Set(['100644', '100755']);
const MAX_GIT_OUTPUT = 64 * 1024 * 1024;

function freeze(value) {
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function exactCommit(value, label = 'baseCommit') {
  if (typeof value !== 'string' || !COMMIT_RE.test(value)) {
    fail('invalid-base-commit', `${label} must be one lowercase 40-character Git object ID`);
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

function decodeOperationBytes(value, label) {
  if (typeof value !== 'string'
    || value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    fail('invalid-accepted-operation', `${label} must be canonical base64`);
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) {
    fail('invalid-accepted-operation', `${label} must be canonical base64`);
  }
  return bytes;
}

function correctionFromArtifact(input) {
  if (input.artifactType !== 'owner-alpha-source-operation'
    || input.schemaVersion !== 1
    || input.operationType !== 'offset') return null;
  return {
    operationType: 'offset',
    baseByteLength: input.baseByteLength,
    baseDigest: input.baseDigest,
    start: input.start,
    end: input.end,
    expectedOldBytes: decodeOperationBytes(
      input.expectedOldBytesBase64,
      'operation.expectedOldBytesBase64',
    ),
    replacementBytes: decodeOperationBytes(
      input.replacementBytesBase64,
      'operation.replacementBytesBase64',
    ),
    candidateByteLength: input.candidateByteLength,
    candidateDigest: input.candidateDigest,
  };
}

function acceptedOperation(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('accepted-operation-required', 'an accepted exact operation is required');
  }
  const operationArtifact = input.artifactType === 'owner-alpha-source-operation';
  const accepted = input.decision === 'accept'
    || input.accepted === true
    || input.status === 'accepted'
    || (operationArtifact && Object.isFrozen(input));
  if (!accepted) {
    fail('accepted-operation-required', 'source application requires an explicitly accepted immutable operation');
  }
  const source = input.source && typeof input.source === 'object' ? input.source : {};
  const baseCommit = exactCommit(input.baseCommit ?? source.baseCommit);
  const sourcePath = repositoryPath(
    input.sourcePath ?? source.path ?? source.repositoryRelativePath ?? source.relativePath,
  );
  const correction = input.correction ?? correctionFromArtifact(input);
  if (!correction || typeof correction !== 'object' || Array.isArray(correction)) {
    fail('invalid-accepted-operation', 'accepted operation must contain its exact prepared correction');
  }
  const candidateDigest = input.candidateDigest ?? input.candidate?.digest ?? correction.candidateDigest;
  if (typeof candidateDigest !== 'string' || !DIGEST_RE.test(candidateDigest)) {
    fail('invalid-candidate-digest', 'accepted operation must contain one RFC-9530-style SHA-256 candidate digest');
  }
  if (correction.candidateDigest !== candidateDigest) {
    fail('accepted-candidate-mismatch', 'accepted candidate digest must equal the prepared correction digest');
  }
  return { baseCommit, sourcePath, correction, candidateDigest };
}

function sha256Digest(bytes) {
  return `sha-256=:${createHash('sha256').update(bytes).digest('base64')}:`;
}

function parseNul(bytes) {
  const records = Buffer.from(bytes).toString('utf8').split('\0');
  if (records.at(-1) === '') records.pop();
  return records;
}

function parseTreeEntry(bytes, sourcePath, revision) {
  const records = parseNul(bytes);
  if (records.length !== 1) {
    fail('source-tree-entry-mismatch', `sourcePath must identify exactly one blob at ${revision}`);
  }
  const match = records[0].match(/^([0-7]{6}) (blob) ([0-9a-f]{40})\t([\s\S]+)$/u);
  if (!match || match[4] !== sourcePath) {
    fail('source-tree-entry-mismatch', `sourcePath must identify exactly one blob at ${revision}`);
  }
  if (!SAFE_TREE_MODES.has(match[1])) {
    fail('unsafe-source-type', 'sourcePath must be a tracked regular file, not a symlink or submodule', {
      mode: match[1],
    });
  }
  return { mode: match[1], objectId: match[3], path: match[4] };
}

function expectedExecutable(treeMode) {
  return treeMode === '100755';
}

function assertSafeMetadata(metadata, treeMode, code = 'unsafe-source-file') {
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    fail(code, 'sourcePath must resolve to one regular file without following a symlink');
  }
  if (metadata.nlink !== 1) {
    fail('source-hardlink-rejected', 'sourcePath must have exactly one hard link before application', {
      links: metadata.nlink,
    });
  }
  const executable = (metadata.mode & 0o111) !== 0;
  if (executable !== expectedExecutable(treeMode)) {
    fail('source-mode-mismatch', 'working source mode must match the exact base tree mode', {
      treeMode,
      fileMode: (metadata.mode & 0o7777).toString(8),
    });
  }
}

async function assertNoSymlinkComponents(root, sourcePath, inspect) {
  let current = root;
  for (const segment of sourcePath.split('/')) {
    current = path.join(current, segment);
    const metadata = await inspect(current);
    if (metadata.isSymbolicLink()) {
      fail('source-symlink-rejected', 'sourcePath must not contain symlink components');
    }
  }
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function exactStatus(records, allowed = []) {
  const expected = new Set(allowed);
  return records.length === expected.size && records.every((record) => expected.delete(record)) && expected.size === 0;
}

async function defaultGit(checkout, args, { encoding = 'buffer', env = process.env } = {}) {
  try {
    const result = await execFileAsync('git', ['-C', checkout, ...args], {
      encoding,
      env: { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
      maxBuffer: MAX_GIT_OUTPUT,
    });
    return encoding === 'buffer' ? Buffer.from(result.stdout) : String(result.stdout).trim();
  } catch (error) {
    fail('git-apply-inspection-failed', `git ${args[0]} failed while revalidating source application`, {
      exitCode: error?.code,
      stderr: String(error?.stderr ?? '').trim().slice(0, 2000),
    });
  }
}

async function assertCheckout(checkoutInput, git) {
  if (typeof checkoutInput !== 'string' || !path.isAbsolute(checkoutInput) || path.normalize(checkoutInput) !== checkoutInput) {
    fail('invalid-checkout', 'checkout must be one normalized absolute path');
  }
  let checkout;
  try {
    checkout = await realpath(checkoutInput);
  } catch (error) {
    fail('checkout-unavailable', 'configured checkout could not be resolved', { cause: error?.code ?? 'unknown' });
  }
  if (checkout !== checkoutInput) {
    fail('checkout-path-mismatch', 'configured checkout must already be its exact real path');
  }
  const root = await realpath(await git(checkout, ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }));
  if (root !== checkout) fail('checkout-not-root', 'configured checkout must identify the Git worktree root');
  return checkout;
}

async function assertLockHeld(lock, dependencyAssertion) {
  if (dependencyAssertion) {
    await dependencyAssertion(lock);
    return;
  }
  if (!lock || !Number.isSafeInteger(lock.pid) || lock.pid < 1 || typeof lock.release !== 'function') {
    fail('caller-lock-required', 'source application must run inside a caller-held owner-alpha lock');
  }
  try {
    process.kill(lock.pid, 0);
  } catch {
    fail('caller-lock-lost', 'the caller-held owner-alpha lock process is no longer alive');
  }
}

function dependencies(overrides = {}) {
  return {
    git: defaultGit,
    open,
    lstat,
    rename,
    unlink,
    writeCandidate: (handle, bytes) => handle.writeFile(bytes),
    syncFile: (handle) => handle.sync(),
    syncDirectory: async (directory) => {
      const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    },
    assertLockHeld: null,
    ...overrides,
  };
}

function wrapFailure(error, renamed, sourcePath) {
  if (error instanceof OwnerAlphaError) {
    error.details = {
      ...error.details,
      sourcePath,
      recovery: renamed ? 'manual-reconcile' : 'source-untouched',
      sourceMayHaveChanged: renamed,
    };
    return error;
  }
  return new OwnerAlphaError(
    renamed ? 'post-rename-verification-failed' : 'source-application-failed',
    renamed
      ? 'source rename completed but durable verification did not; manual reconciliation is required'
      : 'source application stopped before atomic rename; canonical source is untouched',
    {
      sourcePath,
      cause: error?.code ?? error?.message ?? 'unknown',
      recovery: renamed ? 'manual-reconcile' : 'source-untouched',
      sourceMayHaveChanged: renamed,
    },
  );
}

/**
 * Apply one explicitly accepted correction under a lock held by the caller.
 * No rollback is attempted. Failures after rename are classified for manual reconciliation.
 */
export async function applyAcceptedOperation({ checkout, operation, lock } = {}, overrides = {}) {
  const deps = dependencies(overrides);
  const accepted = acceptedOperation(operation);
  try {
    await assertLockHeld(lock, deps.assertLockHeld);
  } catch (error) {
    throw wrapFailure(error, false, accepted.sourcePath);
  }
  let root;
  try {
    root = await assertCheckout(checkout, deps.git);
  } catch (error) {
    throw wrapFailure(error, false, accepted.sourcePath);
  }
  const sourceFile = path.join(root, ...accepted.sourcePath.split('/'));
  const sourceParent = path.dirname(sourceFile);
  const tempName = `.${path.basename(sourceFile)}.owner-alpha-${randomUUID()}.tmp`;
  const tempFile = path.join(sourceParent, tempName);
  const tempPath = path.posix.join(path.posix.dirname(accepted.sourcePath), tempName)
    .replace(/^\.\//u, '');
  let sourceHandle;
  let tempHandle;
  let tempCreated = false;
  let renamed = false;

  try {
    const head = await deps.git(root, ['rev-parse', 'HEAD'], { encoding: 'utf8' });
    if (head !== accepted.baseCommit) {
      fail('stale-base-head', 'checkout HEAD no longer equals the accepted operation base', {
        expected: accepted.baseCommit,
        actual: head,
      });
    }
    const initialStatus = parseNul(await deps.git(root, [
      'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.',
    ]));
    if (initialStatus.length !== 0) {
      fail('worktree-not-clean', 'checkout must be completely clean before source application', {
        status: initialStatus.slice(0, 20),
      });
    }

    const treeEntry = parseTreeEntry(
      await deps.git(root, ['ls-tree', '-z', '--full-tree', accepted.baseCommit, '--', accepted.sourcePath]),
      accepted.sourcePath,
      accepted.baseCommit,
    );
    const committedBytes = await deps.git(root, ['cat-file', 'blob', treeEntry.objectId]);
    await assertNoSymlinkComponents(root, accepted.sourcePath, deps.lstat);
    const initialMetadata = await deps.lstat(sourceFile);
    assertSafeMetadata(initialMetadata, treeEntry.mode);

    sourceHandle = await deps.open(sourceFile, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openedMetadata = await sourceHandle.stat();
    assertSafeMetadata(openedMetadata, treeEntry.mode);
    if (!sameIdentity(initialMetadata, openedMetadata)) {
      fail('source-raced', 'sourcePath changed identity while it was opened');
    }
    const baseBytes = Buffer.from(await sourceHandle.readFile());
    const afterReadMetadata = await sourceHandle.stat();
    if (!sameIdentity(openedMetadata, afterReadMetadata)
      || afterReadMetadata.size !== baseBytes.length
      || !baseBytes.equals(committedBytes)) {
      fail('stale-source-bytes', 'working source bytes no longer exactly equal the accepted base blob');
    }

    let candidateBytes;
    try {
      candidateBytes = applyCorrection(baseBytes, accepted.correction);
    } catch (error) {
      fail('accepted-operation-invalid', 'accepted correction could not be reconstructed against current source', {
        correctionCode: error?.code ?? 'unknown',
      });
    }
    if (sha256Digest(candidateBytes) !== accepted.candidateDigest) {
      fail('accepted-candidate-mismatch', 'reconstructed candidate does not equal the accepted candidate digest');
    }

    const preservedMode = initialMetadata.mode & 0o7777;
    tempHandle = await deps.open(
      tempFile,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      preservedMode,
    );
    tempCreated = true;
    await deps.writeCandidate(tempHandle, candidateBytes);
    await tempHandle.chmod(preservedMode);
    await deps.syncFile(tempHandle);
    const tempMetadata = await tempHandle.stat();
    if (!tempMetadata.isFile() || tempMetadata.nlink !== 1 || tempMetadata.size !== candidateBytes.length) {
      fail('unsafe-temporary-file', 'exclusive same-directory temporary file failed metadata verification');
    }
    await tempHandle.close();
    tempHandle = null;

    const [headBeforeRename, statusBeforeRename, finalMetadata, finalBytes] = await Promise.all([
      deps.git(root, ['rev-parse', 'HEAD'], { encoding: 'utf8' }),
      deps.git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.']),
      deps.lstat(sourceFile),
      deps.open(sourceFile, constants.O_RDONLY | constants.O_NOFOLLOW).then(async (handle) => {
        try {
          return Buffer.from(await handle.readFile());
        } finally {
          await handle.close();
        }
      }),
    ]);
    if (headBeforeRename !== accepted.baseCommit) fail('stale-base-head', 'checkout HEAD changed before atomic rename');
    const statusRecords = parseNul(statusBeforeRename);
    if (!exactStatus(statusRecords, [`?? ${tempPath}`])) {
      fail('worktree-changed-before-rename', 'checkout changed while preparing the atomic source replacement', {
        status: statusRecords.slice(0, 20),
      });
    }
    assertSafeMetadata(finalMetadata, treeEntry.mode);
    if (!sameIdentity(initialMetadata, finalMetadata) || !finalBytes.equals(baseBytes)) {
      fail('source-raced', 'sourcePath changed before atomic rename');
    }

    await deps.rename(tempFile, sourceFile);
    renamed = true;
    tempCreated = false;
    await deps.syncDirectory(sourceParent);

    const appliedMetadata = await deps.lstat(sourceFile);
    assertSafeMetadata(appliedMetadata, treeEntry.mode, 'unsafe-applied-source');
    if ((appliedMetadata.mode & 0o7777) !== preservedMode) {
      fail('applied-mode-mismatch', 'atomic replacement did not preserve the exact source mode');
    }
    const appliedHandle = await deps.open(sourceFile, constants.O_RDONLY | constants.O_NOFOLLOW);
    let appliedBytes;
    try {
      appliedBytes = Buffer.from(await appliedHandle.readFile());
      await appliedHandle.sync();
    } finally {
      await appliedHandle.close();
    }
    const appliedDigest = sha256Digest(appliedBytes);
    if (!appliedBytes.equals(candidateBytes) || appliedDigest !== accepted.candidateDigest) {
      fail('applied-digest-mismatch', 'canonical source does not equal the exact accepted candidate after rename');
    }

    return freeze({
      status: 'source-applied',
      recovery: 'reconcile-then-commit',
      checkout: root,
      baseCommit: accepted.baseCommit,
      sourcePath: accepted.sourcePath,
      sourceMode: treeEntry.mode,
      baseBlob: treeEntry.objectId,
      baseDigest: accepted.correction.baseDigest,
      candidateDigest: appliedDigest,
      candidateByteLength: appliedBytes.length,
      candidateBytes: Buffer.from(appliedBytes),
      correction: {
        ...accepted.correction,
        expectedOldBytes: Buffer.from(accepted.correction.expectedOldBytes),
        replacementBytes: Buffer.from(accepted.correction.replacementBytes),
        ...(accepted.correction.selector
          ? { selector: { ...accepted.correction.selector } }
          : {}),
      },
      exactSplice: {
        start: accepted.correction.start,
        end: accepted.correction.end,
        oldByteLength: accepted.correction.expectedOldBytes.length,
        replacementByteLength: accepted.correction.replacementBytes.length,
      },
    });
  } catch (error) {
    throw wrapFailure(error, renamed, accepted.sourcePath);
  } finally {
    await sourceHandle?.close().catch(() => {});
    await tempHandle?.close().catch(() => {});
    if (tempCreated && !renamed) await deps.unlink(tempFile).catch(() => {});
  }
}

export const applyExactAcceptedOperation = applyAcceptedOperation;

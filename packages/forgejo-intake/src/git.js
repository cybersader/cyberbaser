import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseConfig } from '@cyberbaser/trust';
import {
  asBuffer,
  decodeUtf8,
  fail,
  FORGEJO_INTAKE_MAX_BLOB_BYTES,
  FORGEJO_INTAKE_MAX_GIT_OUTPUT_BYTES,
  requirePositiveInteger,
  requireSha,
  sha256Digest,
  TRUST_POLICY_MAX_BYTES,
  TRUST_POLICY_PATH,
} from './contract.js';
import { validateForgejoIntakeConfig } from './config.js';

const execFileAsync = promisify(execFile);
const REMOTE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

function trimFinalLf(value) {
  return value.replace(/\r?\n$/u, '');
}

function requireRemote(value) {
  if (typeof value !== 'string' || !REMOTE_RE.test(value)) {
    fail('invalid-git-remote', 'remote must be one simple configured Git remote name');
  }
  return value;
}

function requirePath(value) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || Buffer.byteLength(value, 'utf8') > 4096
    || value.startsWith('/')
    || value.includes('\\')
    || !value.endsWith('.md')
    || /[\x00-\x1f\x7f]/u.test(value)
  ) {
    fail('invalid-source-path', 'changed path must be one safe repository-relative Markdown path');
  }
  const segments = value.split('/');
  if (
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
    || segments.includes('.git')
  ) {
    fail('invalid-source-path', 'changed path contains a forbidden segment');
  }
  return value;
}

function literalPathspec(path) {
  return `:(literal)${path}`;
}

function parseNameStatus(bytes) {
  if (bytes.length === 0 || bytes[bytes.length - 1] !== 0) {
    fail('invalid-change-shape', 'Git name-status output must contain one NUL-terminated change');
  }
  const fields = decodeUtf8(bytes.subarray(0, -1), 'Git name-status output').split('\0');
  if (fields.length !== 2 || fields[0] !== 'M') {
    fail('invalid-change-shape', 'Lane A v1 requires exactly one modified existing file');
  }
  return requirePath(fields[1]);
}

function parseTreeEntry(bytes, expectedPath, label) {
  if (bytes.length === 0 || bytes[bytes.length - 1] !== 0) {
    fail('invalid-tree-entry', `${label} must contain one NUL-terminated tree entry`);
  }
  const text = decodeUtf8(bytes.subarray(0, -1), label);
  if (text.includes('\0')) fail('invalid-tree-entry', `${label} contains multiple tree entries`);
  const match = text.match(/^(\d{6}) (\S+) ([0-9a-f]{40})\t([\s\S]+)$/u);
  if (!match || match[4] !== expectedPath || match[2] !== 'blob') {
    fail('invalid-tree-entry', `${label} must be one regular Git blob for the changed path`);
  }
  if (!new Set(['100644', '100755']).has(match[1])) {
    fail('unsupported-git-mode', `${label} uses unsupported Git mode ${match[1]}`);
  }
  return { mode: match[1], object: match[3] };
}

export function createForgejoGitReader({
  checkout,
  command = 'git',
  execute = null,
  maxOutputBytes = FORGEJO_INTAKE_MAX_GIT_OUTPUT_BYTES,
  maxBlobBytes = FORGEJO_INTAKE_MAX_BLOB_BYTES,
} = {}) {
  if (typeof checkout !== 'string' || checkout.length === 0) {
    fail('invalid-checkout', 'checkout must be a non-empty local Git checkout path');
  }
  if (typeof command !== 'string' || command.length === 0) {
    fail('invalid-git-command', 'command must be a non-empty executable name');
  }
  if (execute !== null && typeof execute !== 'function') {
    fail('invalid-git-executor', 'execute must be null or an injected function');
  }
  const outputLimit = requirePositiveInteger(maxOutputBytes, 'maxOutputBytes');
  const blobLimit = requirePositiveInteger(maxBlobBytes, 'maxBlobBytes');

  async function run(args, { allowFailure = false, maxBytes = outputLimit } = {}) {
    if (!Array.isArray(args) || args.some((argument) => typeof argument !== 'string')) {
      fail('invalid-git-arguments', 'Git arguments must be strings');
    }
    try {
      if (execute !== null) {
        const result = await execute({
          command,
          args: ['-C', checkout, ...args],
          maxBytes,
        });
        const exitCode = Number.isSafeInteger(result?.exitCode) ? result.exitCode : 0;
        const stdout = asBuffer(result?.stdout ?? Buffer.alloc(0), 'Git stdout');
        if (stdout.length > maxBytes) fail('git-output-too-large', `Git output exceeds ${maxBytes} bytes`);
        if (exitCode !== 0 && !allowFailure) {
          fail('git-command-failed', `git ${args[0] ?? 'command'} failed`, { exitCode });
        }
        return { stdout, exitCode };
      }
      const { stdout } = await execFileAsync(command, ['-C', checkout, ...args], {
        encoding: 'buffer',
        maxBuffer: maxBytes,
        windowsHide: true,
      });
      return { stdout: asBuffer(stdout, 'Git stdout'), exitCode: 0 };
    } catch (error) {
      if (error?.name === 'ForgejoIntakeError') throw error;
      const exitCode = Number.isSafeInteger(error?.code) ? error.code : null;
      if (allowFailure) {
        return {
          stdout: asBuffer(error?.stdout ?? Buffer.alloc(0), 'Git stdout'),
          exitCode: exitCode ?? 1,
        };
      }
      fail('git-command-failed', `git ${args[0] ?? 'command'} failed`, { exitCode });
    }
  }

  async function requireRefSha(ref, expectedSha, label) {
    const { stdout } = await run(['rev-parse', '--verify', `${ref}^{commit}`]);
    const actual = trimFinalLf(decodeUtf8(stdout, `${label} ref`));
    if (actual !== expectedSha) {
      fail('git-ref-sha-mismatch', `${label} ref does not match Forgejo metadata`);
    }
  }

  async function requireCommit(sha, label) {
    const { stdout } = await run(['cat-file', '-t', sha]);
    if (trimFinalLf(decodeUtf8(stdout, `${label} type`)) !== 'commit') {
      fail('git-object-not-commit', `${label} must resolve to a commit`);
    }
  }

  async function readBlob(objectSpec, label, maximum) {
    const { stdout: typeBytes } = await run(['cat-file', '-t', objectSpec]);
    if (trimFinalLf(decodeUtf8(typeBytes, `${label} type`)) !== 'blob') {
      fail('git-object-not-blob', `${label} must resolve to a regular blob`);
    }
    const { stdout: sizeBytes } = await run(['cat-file', '-s', objectSpec]);
    const sizeText = trimFinalLf(decodeUtf8(sizeBytes, `${label} size`));
    if (!/^\d+$/u.test(sizeText)) fail('invalid-git-size', `${label} returned an invalid size`);
    const size = Number(sizeText);
    if (!Number.isSafeInteger(size) || size > maximum) {
      fail('git-blob-too-large', `${label} exceeds ${maximum} bytes`, {
        actual: Number.isSafeInteger(size) ? size : null,
      });
    }
    const { stdout } = await run(['cat-file', '-p', objectSpec], { maxBytes: maximum + 1 });
    if (stdout.length !== size) fail('git-blob-size-mismatch', `${label} size changed while reading`);
    decodeUtf8(stdout, label);
    return Buffer.from(stdout);
  }

  async function readPolicy(baseSha) {
    const objectSpec = `${baseSha}:${TRUST_POLICY_PATH}`;
    const probe = await run(['cat-file', '-e', objectSpec], { allowFailure: true });
    if (probe.exitCode !== 0) {
      return Object.freeze({ status: 'missing', digest: null, config: null });
    }
    try {
      const bytes = await readBlob(
        objectSpec,
        'base-bound trust policy',
        TRUST_POLICY_MAX_BYTES,
      );
      const config = parseConfig(decodeUtf8(bytes, 'base-bound trust policy'));
      if (config === null) {
        return Object.freeze({ status: 'malformed', digest: null, config: null });
      }
      return Object.freeze({
        status: 'valid',
        digest: sha256Digest(bytes),
        config,
      });
    } catch (error) {
      if (
        error?.code === 'git-blob-too-large'
        || error?.code === 'git-object-not-blob'
        || error?.code === 'invalid-utf8'
      ) {
        return Object.freeze({ status: 'malformed', digest: null, config: null });
      }
      throw error;
    }
  }

  async function readPullRequest({
    config: inputConfig,
    pullRequestNumber,
    baseSha: inputBaseSha,
    headSha: inputHeadSha,
    remote: inputRemote = 'origin',
  } = {}) {
    const config = validateForgejoIntakeConfig(inputConfig);
    const number = requirePositiveInteger(pullRequestNumber, 'pullRequestNumber');
    const baseSha = requireSha(inputBaseSha, 'baseSha');
    const headSha = requireSha(inputHeadSha, 'headSha');
    const remote = requireRemote(inputRemote);
    const namespace = `refs/cyberbaser/forgejo-intake/pr-${number}-${headSha}`;
    const baseRef = `${namespace}/base`;
    const headRef = `${namespace}/head`;
    let baseFetched = false;
    let headFetched = false;
    let result;
    let failure = null;

    try {
      const { stdout: remoteBytes } = await run(['remote', 'get-url', '--all', remote]);
      const urls = decodeUtf8(remoteBytes, 'Git remote URLs').split(/\r?\n/u).filter(Boolean);
      if (urls.length !== 1 || urls[0] !== config.repository.url) {
        fail('git-remote-mismatch', 'configured Git remote does not match repository.url');
      }

      await run([
        'fetch', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head',
        remote, `+${baseSha}:${baseRef}`,
      ]);
      baseFetched = true;
      await run([
        'fetch', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head',
        remote, `+refs/pull/${number}/head:${headRef}`,
      ]);
      headFetched = true;
      await requireRefSha(baseRef, baseSha, 'base');
      await requireRefSha(headRef, headSha, 'pull-request head');
      await requireCommit(baseSha, 'base object');
      await requireCommit(headSha, 'head object');
      const ancestry = await run(
        ['merge-base', '--is-ancestor', baseSha, headSha],
        { allowFailure: true },
      );
      if (ancestry.exitCode !== 0) {
        fail(
          'pull-request-base-not-ancestor',
          'pull request head must descend from the exact Forgejo base commit',
        );
      }

      const { stdout: diffBytes } = await run([
        'diff', '--name-status', '-z', '--no-renames', baseSha, headSha, '--',
      ]);
      const path = parseNameStatus(diffBytes);
      const pathspec = literalPathspec(path);
      const { stdout: baseTreeBytes } = await run(['ls-tree', '-z', baseSha, '--', pathspec]);
      const { stdout: headTreeBytes } = await run(['ls-tree', '-z', headSha, '--', pathspec]);
      const baseEntry = parseTreeEntry(baseTreeBytes, path, 'base tree entry');
      const headEntry = parseTreeEntry(headTreeBytes, path, 'head tree entry');
      if (baseEntry.mode !== headEntry.mode) {
        fail('git-mode-changed', 'Lane A v1 does not support Git mode changes');
      }

      const baseBytes = await readBlob(`${baseSha}:${path}`, 'base Markdown blob', blobLimit);
      const headBytes = await readBlob(`${headSha}:${path}`, 'head Markdown blob', blobLimit);
      const { stdout: patchBytes } = await run([
        'diff', '--unified=0', '--no-ext-diff', '--no-textconv', '--no-renames',
        baseSha, headSha, '--', pathspec,
      ], { maxBytes: blobLimit * 2 + 64 * 1024 });
      const patch = decodeUtf8(patchBytes, 'Git zero-context patch');
      const hunks = patch.match(/^@@ /gmu) ?? [];
      if (hunks.length !== 1) {
        fail('unsupported-hunk-count', 'Lane A v1 requires exactly one Git diff hunk', {
          actual: hunks.length,
        });
      }
      const policy = await readPolicy(baseSha);
      result = {
        baseSha,
        headSha,
        path,
        baseBytes,
        headBytes,
        policy,
      };
    } catch (error) {
      failure = error;
    }

    let cleanupFailed = false;
    if (headFetched) {
      cleanupFailed = (await run(['update-ref', '-d', headRef], { allowFailure: true })).exitCode !== 0;
    }
    if (baseFetched) {
      cleanupFailed = (await run(['update-ref', '-d', baseRef], { allowFailure: true })).exitCode !== 0
        || cleanupFailed;
    }
    if (cleanupFailed) fail('git-ref-cleanup-failed', 'temporary Forgejo intake refs could not be removed');
    if (failure !== null) throw failure;
    return result;
  }

  return Object.freeze({ readPullRequest });
}

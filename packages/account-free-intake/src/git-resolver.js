import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseConfig } from '@cyberbaser/trust';
import {
  asBuffer,
  canonicalHttpsUrl,
  decodeUtf8,
  deepFreeze,
  fail,
  GIT_OUTPUT_MAX_BYTES,
  requireGitObjectId,
  requireSafeInteger,
  sha256Digest,
  SOURCE_BLOB_MAX_BYTES,
  TRUST_POLICY_MAX_BYTES,
  TRUST_POLICY_PATH,
} from './contract.js';
import { validateSourceBindingManifest } from './source-binding.js';

const execFileAsync = promisify(execFile);
const REGULAR_BLOB_MODES = new Set(['100644', '100755']);

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

function trimFinalLf(value) {
  return value.replace(/\r?\n$/u, '');
}

function literalPathspec(pagePath) {
  return `:(literal)${pagePath}`;
}

function parseTreeEntry(bytes, expectedPath, label, { allowMissing = false } = {}) {
  if (bytes.length === 0 && allowMissing) return null;
  if (bytes.length === 0 || bytes[bytes.length - 1] !== 0) {
    fail('invalid-git-tree-entry', `${label} must contain one NUL-terminated tree entry`);
  }
  const text = decodeUtf8(bytes.subarray(0, -1), label);
  if (text.includes('\0')) fail('invalid-git-tree-entry', `${label} contains multiple tree entries`);
  const match = text.match(/^(\d{6}) (\S+) ([0-9a-f]{40}|[0-9a-f]{64})\t([\s\S]+)$/u);
  if (!match || match[4] !== expectedPath) {
    fail('invalid-git-tree-entry', `${label} must identify the exact requested path`);
  }
  return { mode: match[1], type: match[2], objectId: match[3] };
}

export function createBareGitObjectResolver({
  gitDirectory,
  repository,
  command = 'git',
  execute = null,
  maxOutputBytes = GIT_OUTPUT_MAX_BYTES,
  maxBlobBytes = SOURCE_BLOB_MAX_BYTES,
} = {}) {
  if (typeof gitDirectory !== 'string' || gitDirectory.length === 0) {
    fail('invalid-git-directory', 'gitDirectory must be one owner-configured bare Git directory');
  }
  const repositoryUrl = canonicalHttpsUrl(repository, 'repository', {
    repository: true,
    forbidQueryAndFragment: true,
  });
  if (typeof command !== 'string' || command.length === 0) {
    fail('invalid-git-command', 'command must be a non-empty executable name');
  }
  if (execute !== null && typeof execute !== 'function') {
    fail('invalid-git-executor', 'execute must be null or an injected function');
  }
  const outputLimit = requireSafeInteger(maxOutputBytes, 'maxOutputBytes', { positive: true });
  const blobLimit = requireSafeInteger(maxBlobBytes, 'maxBlobBytes', { positive: true });
  const environment = sanitizedGitEnvironment();

  async function run(args, { maxBytes = outputLimit } = {}) {
    if (!Array.isArray(args) || args.some((argument) => typeof argument !== 'string')) {
      fail('invalid-git-arguments', 'Git arguments must be strings');
    }
    const commandArgs = [
      '--no-replace-objects',
      `--git-dir=${gitDirectory}`,
      '-c', 'protocol.allow=never',
      ...args,
    ];
    try {
      if (execute !== null) {
        const result = await execute({ command, args: commandArgs, maxBytes, env: { ...environment } });
        const stdout = asBuffer(result?.stdout ?? Buffer.alloc(0), 'Git stdout');
        const exitCode = Number.isSafeInteger(result?.exitCode) ? result.exitCode : 0;
        if (stdout.length > maxBytes) fail('git-output-too-large', `Git output exceeds ${maxBytes} bytes`);
        if (exitCode !== 0) fail('git-command-failed', `git ${args[0] ?? 'command'} failed`, { exitCode });
        return stdout;
      }
      const { stdout } = await execFileAsync(command, commandArgs, {
        encoding: 'buffer',
        env: environment,
        maxBuffer: maxBytes,
        windowsHide: true,
      });
      return asBuffer(stdout, 'Git stdout');
    } catch (error) {
      if (error?.name === 'AccountFreeIntakeError') throw error;
      const exitCode = Number.isSafeInteger(error?.code) ? error.code : null;
      fail('git-command-failed', `git ${args[0] ?? 'command'} failed`, { exitCode });
    }
  }

  async function readBlob(objectId, label, maximum) {
    const exactObjectId = requireGitObjectId(objectId, `${label} object ID`);
    const type = trimFinalLf(decodeUtf8(
      await run(['cat-file', '-t', exactObjectId]),
      `${label} type`,
    ));
    if (type !== 'blob') fail('git-object-not-blob', `${label} must resolve to a blob`);
    const sizeText = trimFinalLf(decodeUtf8(
      await run(['cat-file', '-s', exactObjectId]),
      `${label} size`,
    ));
    if (!/^\d+$/u.test(sizeText)) fail('invalid-git-size', `${label} returned an invalid size`);
    const size = Number(sizeText);
    if (!Number.isSafeInteger(size) || size > maximum) {
      fail('git-blob-too-large', `${label} exceeds ${maximum} bytes`, {
        maximum,
        actual: Number.isSafeInteger(size) ? size : null,
      });
    }
    const bytes = await run(['cat-file', '-p', exactObjectId], { maxBytes: maximum + 1 });
    if (bytes.length !== size) fail('git-blob-size-mismatch', `${label} size changed while reading`);
    return Buffer.from(bytes);
  }

  async function readPolicy(revision) {
    const treeBytes = await run([
      'ls-tree', '-z', revision, '--', literalPathspec(TRUST_POLICY_PATH),
    ]);
    const entry = parseTreeEntry(treeBytes, TRUST_POLICY_PATH, 'trust policy tree entry', {
      allowMissing: true,
    });
    if (entry === null) return deepFreeze({ status: 'missing', digest: null, config: null });
    if (entry.type !== 'blob' || !REGULAR_BLOB_MODES.has(entry.mode)) {
      return deepFreeze({ status: 'malformed', digest: null, config: null });
    }
    try {
      const bytes = await readBlob(entry.objectId, 'base-bound trust policy', TRUST_POLICY_MAX_BYTES);
      const config = parseConfig(decodeUtf8(bytes, 'base-bound trust policy'));
      if (config === null) return deepFreeze({ status: 'malformed', digest: null, config: null });
      return deepFreeze({ status: 'valid', digest: sha256Digest(bytes), config });
    } catch (error) {
      if (['git-blob-too-large', 'invalid-utf8', 'git-object-not-blob'].includes(error?.code)) {
        return deepFreeze({ status: 'malformed', digest: null, config: null });
      }
      throw error;
    }
  }

  async function resolve(binding) {
    if (binding === null || typeof binding !== 'object' || Array.isArray(binding)) {
      fail('invalid-binding', 'binding must contain one exact retained manifest and page');
    }
    const manifest = validateSourceBindingManifest(binding.manifest);
    if (manifest.source.repository !== repositoryUrl) {
      fail('repository-binding-mismatch', 'source binding repository does not match this bare object store');
    }
    const pageId = binding.page?.pageId;
    const page = manifest.pages.find((candidate) => candidate.pageId === pageId);
    if (
      !page
      || binding.page.path !== page.path
      || binding.page.byteLength !== page.byteLength
      || binding.page.digest !== page.digest
    ) {
      fail('unresolvable-binding', 'publication binding could not be resolved');
    }
    const revision = requireGitObjectId(manifest.source.revision, 'source.revision');
    const bare = trimFinalLf(decodeUtf8(
      await run(['rev-parse', '--is-bare-repository']),
      'bare repository probe',
    ));
    if (bare !== 'true') {
      fail('git-repository-not-bare', 'account-free source resolution requires a bare Git repository');
    }
    const revisionType = trimFinalLf(decodeUtf8(
      await run(['cat-file', '-t', revision]),
      'source revision type',
    ));
    if (revisionType !== 'commit') fail('git-object-not-commit', 'source.revision must resolve to a commit');
    const resolvedRevision = trimFinalLf(decodeUtf8(
      await run(['rev-parse', '--verify', `${revision}^{commit}`]),
      'resolved source revision',
    ));
    if (resolvedRevision !== revision) {
      fail('git-revision-mismatch', 'source.revision did not resolve to itself exactly');
    }
    const treeBytes = await run([
      'ls-tree', '-z', revision, '--', literalPathspec(page.path),
    ]);
    const entry = parseTreeEntry(treeBytes, page.path, 'source page tree entry');
    if (entry.type !== 'blob' || !REGULAR_BLOB_MODES.has(entry.mode)) {
      fail('unsupported-source-object', 'bound source page must be one regular Git blob');
    }
    const baseBytes = await readBlob(entry.objectId, 'source Markdown blob', blobLimit);
    decodeUtf8(baseBytes, 'source Markdown blob');
    if (baseBytes.length !== page.byteLength || sha256Digest(baseBytes) !== page.digest) {
      fail('source-binding-mismatch', 'source blob does not match the retained publication binding');
    }
    const policy = await readPolicy(revision);
    if (policy.status !== manifest.trustPolicy.status || policy.digest !== manifest.trustPolicy.digest) {
      fail('trust-policy-binding-mismatch', 'base trust policy does not match the publication binding');
    }
    return { baseBytes: Buffer.from(baseBytes), policy };
  }

  return Object.freeze({ resolve });
}

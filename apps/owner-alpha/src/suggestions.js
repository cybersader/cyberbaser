import { spawn as nodeSpawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  TRUST_POLICY_MAX_BYTES,
  TRUST_POLICY_PATH,
  prepareSourceBindingManifest,
  retainedManifestFilename,
  serializeSourceBindingManifest,
  sha256Digest,
  sourceBindingDigest,
} from '@cyberbaser/account-free-intake';
import { parseConfig as parseTrustPolicy } from '@cyberbaser/trust';
import { forgeIdentity, suggestionsEnabled, validateOwnerAlphaConfig } from './config.js';
import { fail, OwnerAlphaError } from './errors.js';
import { canonicalJson, deepFreeze } from './json.js';
import { PINNED_QUARTZ_COMMIT } from './quartz-renderer.js';

/**
 * Suggestions: the owner app's one place for the outside lanes.
 *
 * The owner config says which lanes are on. From that, this module derives the
 * intake service's complete settings, keeps the retained publication binding
 * and bare object store the intake reads from, and starts and stops the intake
 * beside the owner app. Owner-alpha still never imports the intake app or reads
 * queue files: the intake stays its own process with its own exclusive queue
 * lock, and suggestions reach the inbox through the same private review socket
 * as before. Nothing here writes source or the forge.
 */

export const SUGGESTIONS_DIRECTORY = 'suggestions';
export const SUGGESTION_INTAKE_CONFIG_FILENAME = 'intake.json';
export const SUGGESTION_INTAKE_READY_PREFIX = 'account-free intake ready:';
export const SUGGESTION_PUBLICATION_REF_PREFIX = 'refs/cyberbaser/publications/';
export const SUGGESTION_QUEUE_LIMITS = Object.freeze({
  maxPendingEntries: 1000,
  maxRetainedBytes: 268_435_456,
  maxPendingPerSource: 25,
  pendingRetentionMs: 2_592_000_000,
  expiredGraceMs: 604_800_000,
});
export const SUGGESTION_INTAKE_LIMITS = Object.freeze({
  maxBodyBytes: 98_304,
  requestTimeoutMs: 5_000,
  maxConcurrentRequests: 4,
  tokenBucketCapacity: 20,
  tokenBucketRefillPerSecond: 1,
});
const PUBLISH_POLICY_PATH = 'publish.yml';
const REGULAR_BLOB_MODES = new Set(['100644', '100755']);
const COMMIT_RE = /^[0-9a-f]{40}$/u;
const HEX_DIGEST_RE = /^sha256:([0-9a-f]{64})$/u;
const GIT_OUTPUT_MAX_BYTES = 512 * 1024 * 1024;
const DEFAULT_START_TIMEOUT_MS = 60_000;
const DEFAULT_STOP_TIMEOUT_MS = 15_000;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

function exactCommit(value, label) {
  if (typeof value !== 'string' || !COMMIT_RE.test(value)) {
    fail('invalid-git-commit', `${label} must be one lowercase 40-character commit ID`);
  }
  return value;
}

export function suggestionPaths(configInput, projectRoot) {
  const config = validateOwnerAlphaConfig(configInput);
  if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot)) {
    fail('invalid-project-root', 'projectRoot must be one absolute path');
  }
  const root = path.resolve(projectRoot, config.workspace.root, SUGGESTIONS_DIRECTORY);
  return deepFreeze({
    root,
    bindingsRoot: path.join(root, 'bindings'),
    gitDir: path.join(root, 'objects.git'),
    queueRoot: path.join(root, 'queue'),
    cloneDir: path.join(root, 'forge-clone'),
    configFile: path.join(root, SUGGESTION_INTAKE_CONFIG_FILENAME),
  });
}

/** Where the owner's private site posts suggestions: the owner port plus two. */
export function suggestionFormOrigin(configInput) {
  const config = validateOwnerAlphaConfig(configInput);
  if (!config.suggestions.form.enabled) return null;
  return `http://${config.listen.host}:${config.listen.readerPort + 1}`;
}

/**
 * The intake's complete settings, derived from the owner config. The owner
 * never edits these; the same values are written for the intake process.
 */
export function deriveIntakeConfig(configInput, projectRoot) {
  const config = validateOwnerAlphaConfig(configInput);
  if (!suggestionsEnabled(config)) return null;
  const paths = suggestionPaths(config, projectRoot);
  const formOrigin = suggestionFormOrigin(config);
  const forge = config.suggestions.forge;
  const identity = forge.enabled ? forgeIdentity(forge.repository) : null;
  return deepFreeze({
    schemaVersion: 1,
    enabled: true,
    publicOrigin: formOrigin,
    listen: formOrigin === null ? null : { host: config.listen.host, port: config.listen.readerPort + 1 },
    allowedFormOrigins: formOrigin === null ? [] : [`http://${config.listen.host}:${config.listen.readerPort}`],
    repository: config.repository.remote.url,
    bindingsRoot: paths.bindingsRoot,
    gitDir: paths.gitDir,
    queue: { root: paths.queueRoot, ...SUGGESTION_QUEUE_LIMITS },
    reviewIpc: {
      enabled: true,
      socketPath: config.proposalReview.socketPath,
      requestTimeoutMs: config.proposalReview.requestTimeoutMs,
      maxConcurrentRequests: 4,
      maxListEntries: config.proposalReview.maxListEntries,
    },
    limits: { ...SUGGESTION_INTAKE_LIMITS },
    ...(forge.enabled ? {
      forgejo: {
        enabled: true,
        apiBaseUrl: identity.apiBaseUrl,
        repository: {
          url: forge.repository,
          owner: identity.owner,
          name: identity.name,
          baseBranch: config.repository.branch,
        },
        cloneDir: paths.cloneDir,
        pollIntervalMs: forge.pollIntervalMs,
        tokenFile: forge.tokenFile,
      },
    } : {}),
  });
}

function gitEnvironment() {
  const allowed = {};
  for (const name of ['HOME', 'PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL']) {
    if (typeof process.env[name] === 'string') allowed[name] = process.env[name];
  }
  return {
    ...allowed,
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_LAZY_FETCH: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
  };
}

/** Run one git command against the bare store with bounded buffered output. */
export async function defaultSuggestionGit({ gitDir, args, input = null, spawn = nodeSpawn }) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['--no-replace-objects', `--git-dir=${gitDir}`, ...args], {
      env: gitEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error); else resolve(value);
    };
    child.on('error', (error) => finish(error));
    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > GIT_OUTPUT_MAX_BYTES) {
        child.kill('SIGKILL');
        finish(new OwnerAlphaError('suggestion-git-output-too-large', 'git output exceeded the bounded buffer'));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => { if (stderr.length < 64) stderr.push(chunk); });
    child.on('close', (code) => {
      finish(null, {
        exitCode: code,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr).toString('utf8').slice(-4_000),
      });
    });
    if (input !== null) child.stdin.end(input);
    else child.stdin.end();
  });
}

async function runGit(git, gitDir, args, { input = null, code = 'suggestion-git-failed' } = {}) {
  let result;
  try {
    result = await git({ gitDir, args, input });
  } catch (error) {
    if (error instanceof OwnerAlphaError) throw error;
    fail(code, `git ${args[0]} failed while maintaining the suggestion object store`, {
      command: args[0],
      cause: error?.code ?? error?.message ?? 'unknown',
    });
  }
  if (result?.exitCode !== 0) {
    fail(code, `git ${args[0]} failed while maintaining the suggestion object store`, {
      command: args[0],
      exitCode: result?.exitCode ?? null,
      stderr: String(result?.stderr ?? '').slice(-1_000),
    });
  }
  return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? '');
}

async function privateDirectory(target, label) {
  await mkdir(target, { recursive: true, mode: 0o700 });
  const metadata = await lstat(target);
  if (metadata.isSymbolicLink() || !metadata.isDirectory() || await realpath(target) !== target) {
    fail('suggestion-path-invalid', `${label} must be one real private directory`);
  }
  return target;
}

/**
 * Create the suggestions workspace and its bare object store when missing.
 * The store is where the intake reads exact base bytes; it only ever receives
 * fetches from the owner's own checkout and is never collected automatically,
 * so every retained publication stays resolvable.
 */
export async function ensureSuggestionWorkspace(configInput, projectRoot, { git = defaultSuggestionGit } = {}) {
  const paths = suggestionPaths(configInput, projectRoot);
  await privateDirectory(paths.root, 'suggestions root');
  await privateDirectory(paths.bindingsRoot, 'suggestion bindings root');
  let exists = false;
  try {
    const metadata = await lstat(paths.gitDir);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      fail('suggestion-store-invalid', 'suggestion object store must be one real directory');
    }
    exists = true;
  } catch (error) {
    if (error instanceof OwnerAlphaError) throw error;
    if (error?.code !== 'ENOENT') throw error;
  }
  if (!exists) {
    await mkdir(paths.gitDir, { mode: 0o700 });
    await runGit(git, paths.gitDir, ['init', '--quiet', '--bare'], { code: 'suggestion-store-init-failed' });
    await runGit(git, paths.gitDir, ['config', 'gc.auto', '0']);
    await runGit(git, paths.gitDir, ['config', 'fetch.fsckObjects', 'true']);
  }
  const bare = UTF8_DECODER.decode(await runGit(git, paths.gitDir, ['rev-parse', '--is-bare-repository'])).trim();
  if (bare !== 'true') fail('suggestion-store-invalid', 'suggestion object store must be a bare Git repository');
  return paths;
}

function parseTree(bytes) {
  const entries = new Map();
  let offset = 0;
  while (offset < bytes.length) {
    const end = bytes.indexOf(0, offset);
    if (end === -1) fail('suggestion-tree-invalid', 'git ls-tree returned an unterminated entry');
    const line = UTF8_DECODER.decode(bytes.subarray(offset, end));
    const tab = line.indexOf('\t');
    if (tab === -1) fail('suggestion-tree-invalid', 'git ls-tree returned an entry without a path');
    const [mode, type, objectId] = line.slice(0, tab).split(' ');
    if (!mode || !type || !objectId) fail('suggestion-tree-invalid', 'git ls-tree returned a malformed entry');
    entries.set(line.slice(tab + 1), { mode, type, objectId });
    offset = end + 1;
  }
  return entries;
}

function parseBatch(bytes, objectIds) {
  const blobs = new Map();
  let offset = 0;
  for (const objectId of objectIds) {
    const headerEnd = bytes.indexOf(0x0a, offset);
    if (headerEnd === -1) fail('suggestion-batch-invalid', 'git cat-file returned a truncated header');
    const header = UTF8_DECODER.decode(bytes.subarray(offset, headerEnd)).split(' ');
    if (header[0] !== objectId || header[1] !== 'blob' || !/^\d+$/u.test(header[2] ?? '')) {
      fail('suggestion-batch-invalid', 'git cat-file returned an unexpected object', { objectId, header: header.join(' ').slice(0, 200) });
    }
    const size = Number(header[2]);
    const start = headerEnd + 1;
    if (!Number.isSafeInteger(size) || start + size + 1 > bytes.length || bytes[start + size] !== 0x0a) {
      fail('suggestion-batch-invalid', 'git cat-file returned a truncated blob', { objectId });
    }
    blobs.set(objectId, Buffer.from(bytes.subarray(start, start + size)));
    offset = start + size + 1;
  }
  if (offset !== bytes.length) fail('suggestion-batch-invalid', 'git cat-file returned trailing output');
  return blobs;
}

function rfc9530Digest(value, label) {
  const match = typeof value === 'string' ? value.match(HEX_DIGEST_RE) : null;
  if (!match) fail('invalid-digest', `${label} must be one sha256:HEX digest`);
  return `sha-256=:${Buffer.from(match[1], 'hex').toString('base64')}:`;
}

function trustPolicyEvidence(entry, bytes) {
  if (entry === undefined) return { status: 'missing', digest: null };
  if (entry.type !== 'blob' || !REGULAR_BLOB_MODES.has(entry.mode)) return { status: 'malformed', digest: null };
  if (bytes.length > TRUST_POLICY_MAX_BYTES) return { status: 'malformed', digest: null };
  let text;
  try {
    text = UTF8_DECODER.decode(bytes);
  } catch {
    return { status: 'malformed', digest: null };
  }
  if (parseTrustPolicy(text) === null) return { status: 'malformed', digest: null };
  return { status: 'valid', digest: sha256Digest(bytes) };
}

/**
 * Retain one exact publication for the form: fetch the owner branch tip into
 * the bare store, read every published page blob and the base trust policy
 * exactly as the intake will, and write the content-addressed binding manifest
 * the rendered pages carry. Idempotent: an existing identical manifest is kept.
 */
export async function retainPublication({
  config: configInput,
  projectRoot,
  checkout,
  publishedPaths,
  selectedTreeDigest,
  git = defaultSuggestionGit,
} = {}) {
  const config = validateOwnerAlphaConfig(configInput);
  if (!config.suggestions.form.enabled) fail('suggestion-form-disabled', 'the suggestion form is off in the owner config');
  const head = exactCommit(checkout?.head, 'checkout.head');
  if (typeof checkout?.root !== 'string' || !path.isAbsolute(checkout.root)) {
    fail('invalid-checkout', 'checkout.root must be one absolute path');
  }
  if (!Array.isArray(publishedPaths) || publishedPaths.some((entry) => typeof entry !== 'string')) {
    fail('invalid-published-paths', 'publishedPaths must be an array of repository-relative paths');
  }
  const pagePaths = [...new Set(publishedPaths.filter((entry) => entry.endsWith('.md')))].sort();
  if (pagePaths.length === 0) fail('suggestion-publication-empty', 'the publication has no Markdown pages to bind');
  const treeDigest = rfc9530Digest(selectedTreeDigest, 'selectedTreeDigest');

  const paths = await ensureSuggestionWorkspace(config, projectRoot, { git });
  const branchRef = `refs/heads/${config.repository.branch}`;
  await runGit(git, paths.gitDir, [
    'fetch', '--quiet', '--no-tags', '--no-write-fetch-head', checkout.root,
    `+${branchRef}:${SUGGESTION_PUBLICATION_REF_PREFIX}${head}`,
  ], { code: 'suggestion-store-fetch-failed' });
  const fetched = UTF8_DECODER.decode(await runGit(git, paths.gitDir, [
    'rev-parse', '--verify', `${SUGGESTION_PUBLICATION_REF_PREFIX}${head}^{commit}`,
  ])).trim();
  if (fetched !== head) {
    // The checkout moved between the readiness check and this fetch; the caller
    // re-checks HEAD and fails the build closed.
    await runGit(git, paths.gitDir, ['update-ref', '-d', `${SUGGESTION_PUBLICATION_REF_PREFIX}${head}`]).catch(() => {});
    fail('suggestion-store-head-mismatch', 'the owner branch tip no longer matches the publication HEAD', {
      expected: head,
      fetched,
    });
  }

  const tree = parseTree(await runGit(git, paths.gitDir, ['ls-tree', '-r', '-z', head]));
  const wanted = [];
  for (const pagePath of pagePaths) {
    const entry = tree.get(pagePath);
    if (!entry || entry.type !== 'blob' || !REGULAR_BLOB_MODES.has(entry.mode)) {
      fail('suggestion-source-not-regular-blob', 'every published page must be one regular blob at HEAD', { path: pagePath });
    }
    wanted.push(entry.objectId);
  }
  const policyEntry = tree.get(PUBLISH_POLICY_PATH);
  if (!policyEntry || policyEntry.type !== 'blob' || !REGULAR_BLOB_MODES.has(policyEntry.mode)) {
    fail('suggestion-publish-policy-missing', `${PUBLISH_POLICY_PATH} must be one regular blob at HEAD`);
  }
  wanted.push(policyEntry.objectId);
  const trustEntry = tree.get(TRUST_POLICY_PATH);
  if (trustEntry?.type === 'blob') wanted.push(trustEntry.objectId);
  const objectIds = [...new Set(wanted)];
  const blobs = parseBatch(
    await runGit(git, paths.gitDir, ['cat-file', '--batch'], { input: `${objectIds.join('\n')}\n` }),
    objectIds,
  );

  const pages = pagePaths.map((pagePath) => {
    const bytes = blobs.get(tree.get(pagePath).objectId);
    return { path: pagePath, byteLength: bytes.length, digest: sha256Digest(bytes) };
  });
  const trustPolicy = trustPolicyEvidence(
    trustEntry,
    trustEntry?.type === 'blob' ? blobs.get(trustEntry.objectId) : Buffer.alloc(0),
  );
  const manifest = prepareSourceBindingManifest({
    source: { repository: config.repository.remote.url, revision: head },
    publication: {
      publishPolicyDigest: sha256Digest(blobs.get(policyEntry.objectId)),
      selectedTreeDigest: treeDigest,
    },
    renderer: { name: 'quartz-cyberbase', revision: PINNED_QUARTZ_COMMIT },
    trustPolicy,
    pages,
  });
  const bindingDigest = sourceBindingDigest(manifest);
  const text = serializeSourceBindingManifest(manifest);
  const file = path.join(paths.bindingsRoot, retainedManifestFilename(bindingDigest));
  let handle;
  try {
    handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const existing = await readFile(file);
    if (!existing.equals(Buffer.from(text, 'utf8'))) {
      fail('suggestion-binding-conflict', 'a different manifest already occupies this binding digest', { file });
    }
  } finally {
    await handle?.close();
  }
  return deepFreeze({
    bindingDigest,
    file,
    gitDir: paths.gitDir,
    bindingsRoot: paths.bindingsRoot,
    source: { repository: config.repository.remote.url, revision: head },
    pages: pages.length,
    trustPolicy,
  });
}

/** True when the binding a built site carries is still retained and resolvable. */
export async function verifyRetainedPublication({
  config: configInput,
  projectRoot,
  head,
  bindingDigest,
  git = defaultSuggestionGit,
} = {}) {
  const config = validateOwnerAlphaConfig(configInput);
  if (typeof bindingDigest !== 'string' || !COMMIT_RE.test(head ?? '')) return false;
  const paths = suggestionPaths(config, projectRoot);
  let filename;
  try {
    filename = retainedManifestFilename(bindingDigest);
  } catch {
    return false;
  }
  try {
    const metadata = await lstat(path.join(paths.bindingsRoot, filename));
    if (!metadata.isFile()) return false;
    const type = UTF8_DECODER.decode(await runGit(git, paths.gitDir, ['cat-file', '-t', head])).trim();
    return type === 'commit';
  } catch {
    return false;
  }
}

async function writePrivateJson(file, value) {
  const temporary = `${file}.tmp-${process.pid}`;
  await rm(temporary, { force: true });
  let handle;
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(`${canonicalJson(value)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, file);
  } finally {
    await handle?.close();
    await rm(temporary, { force: true });
  }
}

function childEnvironment() {
  const allowed = {};
  for (const name of ['HOME', 'PATH', 'TMPDIR', 'TMP', 'TEMP', 'XDG_CACHE_HOME', 'LANG', 'LC_ALL']) {
    if (typeof process.env[name] === 'string') allowed[name] = process.env[name];
  }
  return { ...allowed, GIT_TERMINAL_PROMPT: '0' };
}

/**
 * Start the intake beside the owner app from the derived settings and wait for
 * its ready line. Returns null when every lane is off. `close()` stops it.
 */
export async function startSuggestionIntake({
  config: configInput,
  projectRoot,
  spawn = nodeSpawn,
  git = defaultSuggestionGit,
  intakeEntry = null,
  startTimeoutMs = DEFAULT_START_TIMEOUT_MS,
  stopTimeoutMs = DEFAULT_STOP_TIMEOUT_MS,
} = {}) {
  const config = validateOwnerAlphaConfig(configInput);
  const intakeConfig = deriveIntakeConfig(config, projectRoot);
  if (intakeConfig === null) return null;
  const paths = await ensureSuggestionWorkspace(config, projectRoot, { git });
  await mkdir(path.dirname(config.proposalReview.socketPath), { recursive: true, mode: 0o700 });
  await writePrivateJson(paths.configFile, intakeConfig);
  const entry = intakeEntry ?? path.join(projectRoot, 'apps', 'account-free-intake', 'bin', 'server.js');

  const child = spawn(process.execPath, [entry, '--config', paths.configFile], {
    cwd: projectRoot,
    env: childEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdoutText = '';
  let stderrText = '';
  let exitCode = null;
  const exited = new Promise((resolve) => {
    child.on('exit', (code, signal) => {
      exitCode = code ?? signal ?? 'unknown';
      resolve(exitCode);
    });
  });
  child.stdout.on('data', (chunk) => { stdoutText = `${stdoutText}${chunk}`.slice(-8_000); });
  child.stderr.on('data', (chunk) => { stderrText = `${stderrText}${chunk}`.slice(-8_000); });

  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new OwnerAlphaError('suggestion-intake-start-timeout', 'the suggestion intake did not report ready in time', {
        stderr: stderrText.slice(-1_000),
      }));
    }, startTimeoutMs);
    const check = () => {
      const line = stdoutText.split('\n').find((candidate) => candidate.startsWith(SUGGESTION_INTAKE_READY_PREFIX));
      if (line !== undefined) {
        clearTimeout(timer);
        resolve(line);
      }
    };
    child.stdout.on('data', check);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new OwnerAlphaError('suggestion-intake-spawn-failed', 'the suggestion intake could not be started', {
        cause: error?.code ?? error?.message ?? 'unknown',
      }));
    });
    exited.then(() => {
      clearTimeout(timer);
      reject(new OwnerAlphaError('suggestion-intake-start-failed', 'the suggestion intake exited before it was ready', {
        exitCode,
        stderr: stderrText.slice(-1_000),
      }));
    });
    check();
  });

  let closing = null;
  async function close() {
    if (closing !== null) return closing;
    closing = (async () => {
      if (exitCode !== null) return exitCode;
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), stopTimeoutMs);
      try {
        return await exited;
      } finally {
        clearTimeout(timer);
      }
    })();
    return closing;
  }

  return Object.freeze({
    formOrigin: intakeConfig.publicOrigin,
    forge: intakeConfig.forgejo?.enabled === true ? intakeConfig.forgejo.repository.url : null,
    configFile: paths.configFile,
    ready,
    pid: child.pid ?? null,
    exited,
    exitCode: () => exitCode,
    close,
  });
}

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { computePolicyRevision, validateOwnerAlphaConfig } from './config.js';
import { fail, OwnerAlphaError } from './errors.js';
import { deepFreeze, isPlainObject } from './json.js';

const execFileAsync = promisify(execFile);
const COMMIT_RE = /^[0-9a-f]{40}$/u;
const TRACKED_ENTRY_RE = /^(100644|100755) ([0-9a-f]{40}|[0-9a-f]{64}) 0\t([^\0]+)\0$/u;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

export const EDIT_SESSION_SCHEMA_VERSION = 1;
export const EDIT_SESSION_ARTIFACT_TYPE = 'owner-alpha-edit-session';

function sha256Digest(bytes) {
  return `sha-256=:${createHash('sha256').update(bytes).digest('base64')}:`;
}

function exactRendererPath(value) {
  if (typeof value !== 'string'
    || value.length === 0
    || value.trim() !== value
    || value.includes('\\')
    || value.startsWith('/')
    || /\p{Cc}/u.test(value)) {
    fail('invalid-renderer-path', 'relativePath must be one exact repo-relative POSIX path');
  }
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')
    || path.posix.normalize(value) !== value) {
    fail('invalid-renderer-path', 'relativePath must not contain empty, dot, or parent segments');
  }
  if (path.posix.extname(value) !== '.md') {
    fail('source-not-markdown', 'relativePath must identify one lowercase .md source file');
  }
  return value;
}

function exactRendererSlug(value) {
  if (typeof value !== 'string'
    || value.length === 0
    || value.trim() !== value
    || value.includes('\\')
    || value.startsWith('/')
    || value.endsWith('/')
    || value.includes('?')
    || value.includes('#')
    || /\p{Cc}/u.test(value)) {
    fail('invalid-renderer-slug', 'slug must be one exact renderer-issued relative URL path');
  }
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    fail('invalid-renderer-slug', 'slug must not contain empty, dot, or parent segments');
  }
  return value;
}

function validateRendererRequest(value) {
  if (!isPlainObject(value)) fail('invalid-renderer-request', 'renderer request must be an object');
  const keys = Object.keys(value);
  const unknown = keys.filter((key) => !['relativePath', 'slug'].includes(key));
  if (unknown.length > 0) {
    fail('invalid-renderer-request', 'renderer request contains unknown fields', { fields: unknown.sort() });
  }
  if (!Object.hasOwn(value, 'relativePath') || !Object.hasOwn(value, 'slug')) {
    fail('invalid-renderer-request', 'renderer request requires relativePath and slug');
  }
  return {
    relativePath: exactRendererPath(value.relativePath),
    slug: exactRendererSlug(value.slug),
  };
}

function liveUrlForSlug(baseUrl, slug) {
  const segments = slug.split('/');
  if (segments.at(-1) === 'index') segments.pop();
  const encoded = segments.map((segment) => encodeURIComponent(segment)).join('/');
  return new URL(encoded === '' ? './' : encoded, baseUrl).toString();
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
  if (!included) fail('source-path-not-included', 'renderer source path is outside the configured include policy');
  if (excluded) fail('source-path-excluded', 'renderer source path is protected by the configured exclude policy');
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== ''
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

async function assertNoSymlinkComponents(root, relativePath) {
  let current = root;
  for (const segment of relativePath.split('/')) {
    current = path.join(current, segment);
    let metadata;
    try {
      metadata = await lstat(current);
    } catch (error) {
      if (error?.code === 'ENOENT') fail('source-not-found', 'renderer source path does not exist');
      throw error;
    }
    if (metadata.isSymbolicLink()) {
      fail('source-symlink-rejected', 'renderer source path must not contain symlink components');
    }
  }
}

export async function defaultGitRunner(checkout, args, { encoding = 'utf8' } = {}) {
  const { stdout } = await execFileAsync('git', ['-C', checkout, ...args], {
    encoding,
    env: {
      ...process.env,
      GIT_OPTIONAL_LOCKS: '0',
      GIT_TERMINAL_PROMPT: '0',
      GIT_NO_LAZY_FETCH: '1',
    },
    maxBuffer: 16 * 1024 * 1024,
  });
  if (encoding === 'buffer') return Buffer.from(stdout);
  return String(stdout).trim();
}

async function runGit(git, checkout, args, options) {
  try {
    const output = await git(checkout, args, options);
    return Buffer.isBuffer(output) ? output : String(output ?? '').trim();
  } catch (error) {
    if (error instanceof OwnerAlphaError) throw error;
    fail('git-inspection-failed', `git ${args[0]} failed during owner-alpha source inspection`, {
      command: args[0],
      cause: error?.code ?? error?.message ?? 'unknown',
    });
  }
}

function exactCommit(value, label) {
  if (typeof value !== 'string' || !COMMIT_RE.test(value)) {
    fail('invalid-git-commit', `${label} must resolve to one lowercase 40-character commit ID`);
  }
  return value;
}

export async function assertCheckoutReady(configInput, { git = defaultGitRunner } = {}) {
  const config = validateOwnerAlphaConfig(configInput);
  const configuredRoot = config.repository.checkout;
  let checkoutReal;
  try {
    checkoutReal = await realpath(configuredRoot);
    if (!(await stat(checkoutReal)).isDirectory()) {
      fail('checkout-not-directory', 'configured checkout must be a directory');
    }
  } catch (error) {
    if (error instanceof OwnerAlphaError) throw error;
    fail('checkout-unavailable', 'configured checkout could not be resolved', { cause: error?.code ?? 'unknown' });
  }
  if (checkoutReal !== configuredRoot) {
    fail('checkout-symlink-rejected', 'configured checkout must be an explicit real path without symlink aliases');
  }

  const gitRootRaw = await runGit(git, checkoutReal, ['rev-parse', '--show-toplevel']);
  let gitRoot;
  try {
    gitRoot = await realpath(gitRootRaw);
  } catch (error) {
    fail('checkout-not-repository-root', 'Git did not return a resolvable worktree root', {
      cause: error?.code ?? 'unknown',
    });
  }
  if (gitRoot !== checkoutReal) {
    fail('checkout-not-repository-root', 'configured checkout must identify the Git worktree root');
  }

  const { remote, branch } = config.repository;
  const origin = await runGit(git, checkoutReal, ['remote', 'get-url', remote.name]);
  if (origin !== remote.url) {
    fail('checkout-origin-mismatch', 'configured checkout remote URL does not match policy', {
      expected: remote.url,
      actual: origin,
    });
  }
  const pushOrigin = await runGit(git, checkoutReal, ['remote', 'get-url', '--push', remote.name]);
  if (pushOrigin !== remote.url) {
    fail('checkout-push-origin-mismatch', 'configured checkout push URL does not match policy', {
      expected: remote.url,
      actual: pushOrigin,
    });
  }

  const currentBranch = await runGit(git, checkoutReal, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (currentBranch !== branch) {
    fail('checkout-branch-mismatch', 'configured checkout must be on the exact policy branch', {
      expected: branch,
      actual: currentBranch,
    });
  }

  const head = exactCommit(await runGit(git, checkoutReal, ['rev-parse', 'HEAD']), 'HEAD');
  const remoteRef = `refs/heads/${branch}`;
  const remoteOutput = await runGit(git, checkoutReal, [
    'ls-remote',
    '--refs',
    remote.name,
    remoteRef,
  ]);
  const remoteMatch = String(remoteOutput).match(/^([0-9a-f]{40})\trefs\/heads\/([^\s]+)$/u);
  if (!remoteMatch || remoteMatch[2] !== branch) {
    fail(
      'checkout-remote-branch-unavailable',
      'configured remote must expose exactly one valid branch ref',
      { remote: remote.name, branch },
    );
  }
  const remoteHead = exactCommit(remoteMatch[1], `${remote.name}/${branch}`);
  if (head !== remoteHead) {
    fail('checkout-not-at-origin-branch', 'checkout HEAD must exactly equal the actual configured remote branch', {
      head,
      remoteHead,
    });
  }

  const status = await runGit(git, checkoutReal, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (status !== '') {
    fail('checkout-not-clean', 'configured checkout must have an empty tracked and untracked status', {
      status: status.split('\n').slice(0, 20),
    });
  }

  return deepFreeze({ root: checkoutReal, origin, branch, head });
}

function parseTrackedEntry(output, relativePath) {
  const match = String(output).match(TRACKED_ENTRY_RE);
  if (!match || match[3] !== relativePath) {
    fail('source-not-tracked-regular-file', 'source must be exactly one tracked regular Git file');
  }
  return { mode: match[1], objectId: match[2] };
}

async function readSourceFile(root, relativePath, maxSourceBytes) {
  await assertNoSymlinkComponents(root, relativePath);
  const candidate = path.join(root, ...relativePath.split('/'));
  let sourceReal;
  try {
    sourceReal = await realpath(candidate);
  } catch (error) {
    if (error?.code === 'ENOENT') fail('source-not-found', 'renderer source path does not exist');
    throw error;
  }
  if (!isWithin(root, sourceReal) || sourceReal !== candidate) {
    fail('source-outside-checkout', 'renderer source path must resolve strictly inside the checkout');
  }

  let handle;
  try {
    handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.nlink !== 1) {
      fail('source-not-single-link-regular-file', 'source must be one regular file with exactly one hard link');
    }
    if (metadata.size > maxSourceBytes) {
      fail('source-too-large', `source exceeds the ${maxSourceBytes}-byte policy limit`, {
        maximum: maxSourceBytes,
        actual: metadata.size,
      });
    }
    const bytes = await handle.readFile();
    if (bytes.length !== metadata.size) fail('source-read-race', 'source size changed while it was being read');
    return bytes;
  } catch (error) {
    if (error instanceof OwnerAlphaError) throw error;
    if (error?.code === 'ELOOP') fail('source-symlink-rejected', 'source must not be a symlink');
    fail('source-read-failed', 'source bytes could not be read', { cause: error?.code ?? 'unknown' });
  } finally {
    await handle?.close();
  }
}

function decodeSource(bytes) {
  let text;
  try {
    text = UTF8_DECODER.decode(bytes);
  } catch {
    fail('source-invalid-utf8', 'source must be valid UTF-8');
  }
  if (text.includes('\r')) {
    fail('source-not-lf-only', 'owner-alpha browser MVP accepts LF-only Markdown source');
  }
  return text;
}

export function detectYamlFrontmatterRange(sourceBytes) {
  const bytes = Buffer.from(sourceBytes);
  if (bytes.length < 4 || !bytes.subarray(0, 4).equals(Buffer.from('---\n'))) return null;

  let lineStart = 4;
  while (lineStart <= bytes.length) {
    const newline = bytes.indexOf(0x0a, lineStart);
    const lineEnd = newline === -1 ? bytes.length : newline;
    const line = bytes.subarray(lineStart, lineEnd);
    if (line.equals(Buffer.from('---')) || line.equals(Buffer.from('...'))) {
      return deepFreeze({ start: 0, end: newline === -1 ? lineEnd : newline + 1 });
    }
    if (newline === -1) break;
    lineStart = newline + 1;
  }
  fail('unterminated-frontmatter', 'source begins with YAML frontmatter but has no closing delimiter');
}

export async function createEditSession({ config: configInput, renderer, git = defaultGitRunner }) {
  const config = validateOwnerAlphaConfig(configInput);
  const request = validateRendererRequest(renderer);
  pathMatchesPolicy(request.relativePath, config.paths);
  const checkout = await assertCheckoutReady(config, { git });

  const trackedOutput = await runGit(git, checkout.root, [
    'ls-files',
    '--stage',
    '-z',
    '--',
    request.relativePath,
  ]);
  const tracked = parseTrackedEntry(trackedOutput, request.relativePath);
  const bytes = await readSourceFile(checkout.root, request.relativePath, config.limits.maxSourceBytes);
  const text = decodeSource(bytes);
  const frontmatter = detectYamlFrontmatterRange(bytes);

  const headAfterRead = exactCommit(await runGit(git, checkout.root, ['rev-parse', 'HEAD']), 'HEAD');
  const statusAfterRead = await runGit(git, checkout.root, [
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
  ]);
  if (headAfterRead !== checkout.head || statusAfterRead !== '') {
    fail('source-snapshot-changed', 'checkout changed while the edit session source was being bound');
  }

  return deepFreeze({
    schemaVersion: EDIT_SESSION_SCHEMA_VERSION,
    artifactType: EDIT_SESSION_ARTIFACT_TYPE,
    relativePath: request.relativePath,
    slug: request.slug,
    liveUrl: liveUrlForSlug(config.live.baseUrl, request.slug),
    baseCommit: checkout.head,
    policyRevision: computePolicyRevision(config),
    source: {
      text,
      bytesBase64: bytes.toString('base64'),
      byteLength: bytes.length,
      digest: sha256Digest(bytes),
      gitMode: tracked.mode,
      gitObjectId: tracked.objectId,
      frontmatter,
    },
  });
}

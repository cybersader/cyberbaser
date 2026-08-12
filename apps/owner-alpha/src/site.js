import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSite } from '@cyberbaser/linkcheck';
import { project as projectContent, verifyProjection } from '@cyberbaser/projection';
import { select } from '@cyberbaser/publish';
import { computePolicyRevision, validateOwnerAlphaConfig } from './config.js';
import { fail, OwnerAlphaError } from './errors.js';
import { canonicalJson, deepFreeze, isPlainObject } from './json.js';
import {
  PINNED_QUARTZ_COMMIT,
  PINNED_QUARTZ_REF,
  PINNED_QUARTZ_REPOSITORY,
  renderPinnedQuartz,
} from './quartz-renderer.js';
import { assertCheckoutReady } from './source.js';

export const OWNER_SITE_SCHEMA_VERSION = 1;
export const OWNER_SITE_ARTIFACT_TYPE = 'owner-alpha-site-manifest';
export const OWNER_SITE_MANIFEST_FILENAME = 'owner-alpha-site-manifest.json';
export const DEFAULT_OWNER_ALPHA_PROJECT_ROOT = path.resolve(fileURLToPath(
  new URL('../../../', import.meta.url),
));

const COMMIT_RE = /^[0-9a-f]{40}$/u;
const BUILD_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/u;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

function contained(root, target, { strict = false, code = 'site-path-outside-root' } = {}) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (relative === '..'
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
    || (strict && relative === '')) {
    fail(code, `${resolvedTarget} must remain ${strict ? 'strictly ' : ''}inside ${resolvedRoot}`);
  }
  return resolvedTarget;
}

function pathsOverlap(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return a === b
    || containedWithoutFailure(a, b)
    || containedWithoutFailure(b, a);
}

function containedWithoutFailure(root, target) {
  const relative = path.relative(root, target);
  return relative !== ''
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function exactAbsolutePath(value, label) {
  if (typeof value !== 'string'
    || !path.isAbsolute(value)
    || path.normalize(value) !== value
    || value === path.parse(value).root) {
    fail('invalid-site-path', `${label} must be one normalized non-root absolute path`);
  }
  return value;
}

function exactBuildId(value) {
  if (typeof value !== 'string' || !BUILD_ID_RE.test(value)) {
    fail('invalid-site-build-id', 'site build ID must contain only bounded lowercase letters, digits, and hyphens');
  }
  return value;
}

function exactPublishedPath(value) {
  if (typeof value !== 'string'
    || value.length === 0
    || value.trim() !== value
    || value.includes('\\')
    || value.startsWith('/')
    || /\p{Cc}/u.test(value)) {
    fail('invalid-published-path', 'publication selection returned an unsafe relative path');
  }
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    fail('invalid-published-path', 'publication selection returned dot, parent, or empty path segments');
  }
  return value;
}

async function exactExistingDirectory(value, label) {
  const absolute = exactAbsolutePath(value, label);
  let metadata;
  try {
    metadata = await lstat(absolute);
  } catch (error) {
    fail('site-directory-unavailable', `${label} could not be inspected`, {
      cause: error?.code ?? 'unknown',
    });
  }
  if (metadata.isSymbolicLink()) fail('site-symlink-rejected', `${label} must not be a symlink`);
  if (!metadata.isDirectory()) fail('site-not-directory', `${label} must be a directory`);
  const resolved = await realpath(absolute);
  if (resolved !== absolute) fail('site-symlink-rejected', `${label} must be an explicit real path`);
  return absolute;
}

async function assertNoSymlinkComponents(root, target) {
  const absolute = contained(root, target, { code: 'site-path-outside-project' });
  const relative = path.relative(root, absolute);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink()) {
        fail('site-symlink-rejected', 'owner site paths must not contain symbolic links', {
          path: path.relative(root, current).split(path.sep).join('/'),
        });
      }
    } catch (error) {
      if (error?.code === 'ENOENT') break;
      if (error instanceof OwnerAlphaError) throw error;
      throw error;
    }
  }
  return absolute;
}

async function prepareContainedDirectory(projectRoot, workspaceRoot, target, label) {
  const absolute = contained(workspaceRoot, target, {
    strict: target !== workspaceRoot,
    code: 'site-path-outside-workspace',
  });
  await assertNoSymlinkComponents(projectRoot, absolute);
  await mkdir(absolute, { recursive: true, mode: 0o700 });
  await assertNoSymlinkComponents(projectRoot, absolute);
  const resolved = await realpath(absolute);
  if (resolved !== absolute) fail('site-symlink-rejected', `${label} must resolve without symlink aliases`);
  contained(workspaceRoot, resolved, {
    strict: target !== workspaceRoot,
    code: 'site-path-outside-workspace',
  });
  return absolute;
}

async function assertAbsent(projectRoot, target, label) {
  await assertNoSymlinkComponents(projectRoot, target);
  try {
    await lstat(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  fail('site-build-path-exists', `${label} already exists; refusing to reuse a candidate path`);
}

async function readRegularNoFollow(root, file, label) {
  const absolute = contained(root, file, { strict: true, code: 'site-file-outside-root' });
  await assertNoSymlinkComponents(root, absolute);
  let handle;
  try {
    handle = await open(
      absolute,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.nlink !== 1) {
      fail('site-non-regular-file', `${label} must be one regular file with one hard link`);
    }
    const bytes = await handle.readFile();
    if (bytes.length !== metadata.size) fail('site-file-read-race', `${label} changed while it was read`);
    return bytes;
  } catch (error) {
    if (error instanceof OwnerAlphaError) throw error;
    if (error?.code === 'ELOOP') fail('site-symlink-rejected', `${label} must not be a symlink`);
    fail('site-file-read-failed', `${label} could not be read`, { cause: error?.code ?? 'unknown' });
  } finally {
    await handle?.close();
  }
}

function updateTreeDigest(hash, relativePath, bytes) {
  hash.update(Buffer.from(relativePath, 'utf8'));
  hash.update(Buffer.from([0]));
  hash.update(Buffer.from(String(bytes.length), 'ascii'));
  hash.update(Buffer.from([0]));
  hash.update(bytes);
}

async function verifyBytePreservingProjection(checkoutRoot, projectionRoot, published) {
  const paths = [...published].map(exactPublishedPath).sort();
  if (new Set(paths).size !== paths.length) {
    fail('duplicate-published-path', 'publication selection returned duplicate paths');
  }
  const sourceHash = createHash('sha256');
  const projectedHash = createHash('sha256');
  let totalBytes = 0;

  for (const relativePath of paths) {
    const segments = relativePath.split('/');
    const source = await readRegularNoFollow(
      checkoutRoot,
      path.join(checkoutRoot, ...segments),
      `canonical source ${relativePath}`,
    );
    const projected = await readRegularNoFollow(
      projectionRoot,
      path.join(projectionRoot, ...segments),
      `projected source ${relativePath}`,
    );
    if (!source.equals(projected)) {
      fail('projected-bytes-changed', 'projection did not preserve selected source bytes exactly', {
        path: relativePath,
      });
    }
    updateTreeDigest(sourceHash, relativePath, source);
    updateTreeDigest(projectedHash, relativePath, projected);
    totalBytes += source.length;
    if (!Number.isSafeInteger(totalBytes)) fail('site-byte-count-overflow', 'projected byte count exceeded safe JSON range');
  }

  const sourceDigest = `sha256:${sourceHash.digest('hex')}`;
  const projectedDigest = `sha256:${projectedHash.digest('hex')}`;
  if (sourceDigest !== projectedDigest) {
    fail('projected-tree-digest-mismatch', 'projected tree digest did not match the canonical selected tree');
  }
  return {
    ok: true,
    files: paths.length,
    bytes: totalBytes,
    sourceDigest,
    projectedDigest,
  };
}

async function inspectRegularTree(root, label) {
  const pending = [''];
  const files = [];
  while (pending.length > 0) {
    const relativeDirectory = pending.pop();
    const directory = relativeDirectory
      ? path.join(root, ...relativeDirectory.split('/'))
      : root;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      fail('site-output-unreadable', `${label} could not be traversed`, {
        path: relativeDirectory,
        cause: error?.code ?? 'unknown',
      });
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        fail('site-symlink-rejected', `${label} must not contain symbolic links`, {
          path: relativePath,
        });
      }
      if (entry.isDirectory()) pending.push(relativePath);
      else if (entry.isFile()) files.push(relativePath);
      else {
        fail('site-non-regular-file', `${label} contains a non-file entry`, {
          path: relativePath,
        });
      }
    }
  }
  return files.sort();
}

async function digestRegularTree(root, label, { exclude = [] } = {}) {
  const excluded = new Set(exclude);
  const files = (await inspectRegularTree(root, label))
    .filter((relativePath) => !excluded.has(relativePath));
  const hash = createHash('sha256');
  let bytes = 0;
  for (const relativePath of files) {
    const contents = await readRegularNoFollow(
      root,
      path.join(root, ...relativePath.split('/')),
      `${label} ${relativePath}`,
    );
    updateTreeDigest(hash, relativePath, contents);
    bytes += contents.length;
  }
  return {
    digest: `sha256:${hash.digest('hex')}`,
    files: files.length,
    bytes,
  };
}

async function runtimeResourceIdentity(projectRoot) {
  const roots = [
    'apps/owner-alpha/src',
    'apps/owner-alpha/public',
    'renderers/quartz-cyberbase',
    'packages/correction/src',
    'packages/linkcheck/src',
    'packages/ofm/src',
    'packages/projection/src',
    'packages/publish/src',
    'packages/trust/src',
  ];
  const hash = createHash('sha256');
  let files = 0;
  let bytes = 0;
  for (const relativeRoot of roots) {
    const root = await exactExistingDirectory(
      path.join(projectRoot, ...relativeRoot.split('/')),
      `runtime resource ${relativeRoot}`,
    );
    for (const relativePath of await inspectRegularTree(root, `runtime resource ${relativeRoot}`)) {
      const contents = await readRegularNoFollow(
        root,
        path.join(root, ...relativePath.split('/')),
        `runtime resource ${relativeRoot}/${relativePath}`,
      );
      updateTreeDigest(hash, `${relativeRoot}/${relativePath}`, contents);
      files += 1;
      bytes += contents.length;
    }
  }
  return {
    digest: `sha256:${hash.digest('hex')}`,
    files,
    bytes,
  };
}

async function inspectHtmlSite(siteRoot) {
  const html = (await inspectRegularTree(siteRoot, 'rendered candidate site'))
    .filter((relativePath) => /\.html?$/iu.test(relativePath));
  if (html.length === 0 || !html.includes('index.html')) {
    fail('site-html-baseline-missing', 'rendered candidate must contain index.html and at least one HTML page');
  }
  for (const relativePath of html) {
    const bytes = await readRegularNoFollow(
      siteRoot,
      path.join(siteRoot, ...relativePath.split('/')),
      `rendered HTML ${relativePath}`,
    );
    let text;
    try {
      text = UTF8_DECODER.decode(bytes);
    } catch {
      fail('site-html-invalid-utf8', 'rendered HTML must be valid UTF-8', { path: relativePath });
    }
    if (!/<html(?:\s|>)/iu.test(text) || !/<\/html\s*>/iu.test(text)) {
      fail('site-html-invalid', 'rendered HTML page is missing a complete html element', {
        path: relativePath,
      });
    }
  }
  return { pages: html.length, files: html };
}

function safeCount(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('invalid-linkcheck-result', `${label} must be a non-negative safe integer`);
  }
  return value;
}

function summarizeLinks(check, htmlPages) {
  if (!isPlainObject(check) || !Array.isArray(check.broken) || !isPlainObject(check.byClass)) {
    fail('invalid-linkcheck-result', 'link checker returned an invalid baseline');
  }
  const summary = {
    total: safeCount(check.total, 'link total'),
    ok: safeCount(check.ok, 'link ok count'),
    occurrences: safeCount(check.occurrences, 'link occurrence count'),
    pages: safeCount(check.pages, 'link page count'),
    broken: safeCount(check.broken.length, 'broken link count'),
    byClass: Object.fromEntries(Object.entries(check.byClass).sort(([left], [right]) => left.localeCompare(right))),
  };
  for (const [classification, count] of Object.entries(summary.byClass)) {
    if (typeof classification !== 'string' || classification.length === 0) {
      fail('invalid-linkcheck-result', 'link classification names must be non-empty strings');
    }
    safeCount(count, `link class ${classification}`);
  }
  if (summary.pages !== htmlPages || summary.total !== summary.ok + summary.broken) {
    fail('invalid-linkcheck-result', 'link checker baseline counts are internally inconsistent', {
      htmlPages,
      links: summary,
    });
  }
  return summary;
}

function checkoutSnapshot(value, config) {
  if (!isPlainObject(value)) fail('invalid-checkout-snapshot', 'checkout readiness check returned no snapshot');
  const root = exactAbsolutePath(value.root, 'checkout root');
  if (typeof value.head !== 'string' || !COMMIT_RE.test(value.head)) {
    fail('invalid-checkout-snapshot', 'checkout readiness check must return a lowercase 40-character HEAD');
  }
  const branch = typeof value.branch === 'string' ? value.branch : config.repository.branch;
  const origin = typeof value.origin === 'string' ? value.origin : config.repository.remote.url;
  if (root !== config.repository.checkout
    || branch !== config.repository.branch
    || origin !== config.repository.remote.url) {
    fail('checkout-snapshot-policy-mismatch', 'checkout readiness snapshot must match the configured canonical checkout policy');
  }
  return { root, head: value.head, branch, origin };
}

function sameCheckout(left, right) {
  return left.root === right.root
    && left.head === right.head
    && left.branch === right.branch
    && left.origin === right.origin;
}

function jsonSafe(value, label) {
  try {
    return JSON.parse(canonicalJson(value));
  } catch (error) {
    if (error instanceof OwnerAlphaError) {
      fail('invalid-site-manifest', `${label} was not JSON-safe`, { cause: error.code });
    }
    throw error;
  }
}

function timestamp(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) fail('invalid-site-clock', 'site build clock returned an invalid timestamp');
  return date.toISOString();
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

async function assertSafeExistingSite(projectRoot, workspaceRoot, siteRoot) {
  contained(workspaceRoot, siteRoot, { strict: true, code: 'site-path-outside-workspace' });
  await assertNoSymlinkComponents(projectRoot, siteRoot);
  let metadata;
  try {
    metadata = await lstat(siteRoot);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  if (metadata.isSymbolicLink()) fail('site-symlink-rejected', 'configured owner site must not be a symlink');
  if (!metadata.isDirectory()) fail('site-not-directory', 'configured owner site must be a directory');
  await inspectRegularTree(siteRoot, 'configured owner site');
  return true;
}

async function publishCandidate({ projectRoot, workspaceRoot, candidateSite, siteRoot, backupRoot }) {
  await assertAbsent(projectRoot, backupRoot, 'owner site backup');
  const hadExisting = await assertSafeExistingSite(projectRoot, workspaceRoot, siteRoot);
  let oldMoved = false;
  try {
    if (hadExisting) {
      await rename(siteRoot, backupRoot);
      oldMoved = true;
    }
    await rename(candidateSite, siteRoot);
    await syncDirectory(path.dirname(siteRoot));
  } catch (error) {
    if (oldMoved) {
      try {
        await rename(backupRoot, siteRoot);
        await syncDirectory(path.dirname(siteRoot));
      } catch (rollbackError) {
        fail('site-publish-rollback-failed', 'candidate publish failed and the previous site could not be restored', {
          cause: error?.code ?? error?.message ?? 'unknown',
          rollbackCause: rollbackError?.code ?? rollbackError?.message ?? 'unknown',
        });
      }
    }
    fail('site-publish-failed', 'validated candidate site could not be published', {
      cause: error?.code ?? error?.message ?? 'unknown',
    });
  }
  if (oldMoved) await rm(backupRoot, { recursive: true, force: false });
  return { replacedExisting: hadExisting };
}

function reusableManifest(value, config, checkout, htmlPages, resources, outputTree) {
  if (!isPlainObject(value)
    || value.schemaVersion !== OWNER_SITE_SCHEMA_VERSION
    || value.artifactType !== OWNER_SITE_ARTIFACT_TYPE
    || !isPlainObject(value.source)
    || !isPlainObject(value.renderer)
    || !isPlainObject(value.site)
    || value.source.head !== checkout.head
    || value.source.branch !== config.repository.branch
    || value.source.remote?.name !== config.repository.remote.name
    || value.source.remote?.url !== config.repository.remote.url
    || value.policyRevision !== computePolicyRevision(config)
    || value.renderer.name !== 'quartz-cyberbase'
    || value.renderer.revision !== PINNED_QUARTZ_COMMIT
    || value.renderer.tag !== PINNED_QUARTZ_REF
    || value.renderer.repository !== PINNED_QUARTZ_REPOSITORY
    || value.renderer.editLinkMode !== 'owner'
    || value.renderer.ownerOrigin !== `http://${config.listen.host}:${config.listen.port}`
    || value.renderer.resources?.digest !== resources.digest
    || value.renderer.resources?.files !== resources.files
    || value.renderer.resources?.bytes !== resources.bytes
    || value.site.manifest !== OWNER_SITE_MANIFEST_FILENAME
    || value.site.htmlPages !== htmlPages
    || value.site.outputTree?.digest !== outputTree.digest
    || value.site.outputTree?.files !== outputTree.files
    || value.site.outputTree?.bytes !== outputTree.bytes) {
    return null;
  }
  return deepFreeze(jsonSafe(value, 'reusable owner site manifest'));
}

/** Reuse only a complete owner site bound to the current checkout and policy. */
export async function reuseOwnerSite({
  config: configInput,
  projectRoot = DEFAULT_OWNER_ALPHA_PROJECT_ROOT,
} = {}, dependencyOverrides = {}) {
  const config = validateOwnerAlphaConfig(configInput);
  const project = await exactExistingDirectory(projectRoot, 'projectRoot');
  const resources = await runtimeResourceIdentity(project);
  const workspaceRoot = contained(project, path.resolve(project, config.workspace.root), {
    strict: true,
    code: 'site-workspace-outside-project',
  });
  const siteRoot = contained(workspaceRoot, path.resolve(project, config.workspace.site), {
    strict: true,
    code: 'site-path-outside-workspace',
  });
  const cacheRoot = contained(workspaceRoot, path.resolve(project, config.workspace.cache), {
    strict: true,
    code: 'site-path-outside-workspace',
  });
  const checkCheckout = dependencyOverrides.assertCheckoutReady ?? assertCheckoutReady;
  if (typeof checkCheckout !== 'function') {
    fail('invalid-site-dependency', 'assertCheckoutReady must be an injected function');
  }

  const before = checkoutSnapshot(await checkCheckout(config), config);
  if (!(await assertSafeExistingSite(project, workspaceRoot, siteRoot))) return null;

  let manifest;
  try {
    const bytes = await readRegularNoFollow(
      siteRoot,
      path.join(siteRoot, OWNER_SITE_MANIFEST_FILENAME),
      'owner site manifest',
    );
    if (bytes.length > 1024 * 1024) fail('site-manifest-too-large', 'owner site manifest exceeds one MiB');
    manifest = JSON.parse(UTF8_DECODER.decode(bytes));
  } catch (error) {
    if (error instanceof OwnerAlphaError) throw error;
    fail('invalid-site-manifest', 'configured owner site manifest is not valid UTF-8 JSON');
  }

  const html = await inspectHtmlSite(siteRoot);
  const outputTree = await digestRegularTree(siteRoot, 'configured owner site', {
    exclude: [OWNER_SITE_MANIFEST_FILENAME],
  });
  const accepted = reusableManifest(
    manifest,
    config,
    before,
    html.pages,
    resources,
    outputTree,
  );
  if (accepted === null) return null;
  const after = checkoutSnapshot(await checkCheckout(config), config);
  if (!sameCheckout(before, after)) {
    fail('site-checkout-changed', 'canonical checkout changed while the cached owner site was validated');
  }
  return deepFreeze({
    ok: true,
    reused: true,
    siteRoot,
    cacheRoot,
    manifest: accepted,
    publication: { replacedExisting: false, reusedExisting: true },
  });
}

/** Reuse a current verified site, otherwise perform a complete rebuild. */
export async function ensureOwnerSite(options = {}, dependencyOverrides = {}) {
  const reused = await reuseOwnerSite(options, dependencyOverrides);
  if (reused !== null) return reused;
  return rebuildOwnerSite(options, dependencyOverrides);
}

/**
 * Build and safely publish the local owner wiki from one ready canonical checkout.
 * The canonical checkout is read only; all projection, renderer, and publication
 * output remains under the configured owner-alpha workspace.
 */
export async function rebuildOwnerSite({
  config: configInput,
  projectRoot = DEFAULT_OWNER_ALPHA_PROJECT_ROOT,
  renderer = renderPinnedQuartz,
} = {}, dependencyOverrides = {}) {
  const config = validateOwnerAlphaConfig(configInput);
  const project = await exactExistingDirectory(projectRoot, 'projectRoot');
  const resources = await runtimeResourceIdentity(project);
  const workspaceRoot = contained(project, path.resolve(project, config.workspace.root), {
    strict: true,
    code: 'site-workspace-outside-project',
  });
  const siteRoot = contained(workspaceRoot, path.resolve(project, config.workspace.site), {
    strict: true,
    code: 'site-path-outside-workspace',
  });
  const cacheRoot = contained(workspaceRoot, path.resolve(project, config.workspace.cache), {
    strict: true,
    code: 'site-path-outside-workspace',
  });
  if (pathsOverlap(siteRoot, cacheRoot)) {
    fail('site-workspace-path-overlap', 'configured owner site and cache paths must not overlap');
  }

  await prepareContainedDirectory(project, workspaceRoot, workspaceRoot, 'workspace root');
  await prepareContainedDirectory(project, workspaceRoot, cacheRoot, 'cache root');
  await prepareContainedDirectory(project, workspaceRoot, path.dirname(siteRoot), 'site parent');

  const checkCheckout = dependencyOverrides.assertCheckoutReady ?? assertCheckoutReady;
  const selectPublic = dependencyOverrides.select ?? select;
  const projectPublic = dependencyOverrides.project ?? projectContent;
  const verifyPublic = dependencyOverrides.verifyProjection ?? verifyProjection;
  const render = dependencyOverrides.renderPinnedQuartz ?? renderer;
  const checkLinks = dependencyOverrides.checkSite ?? checkSite;
  const now = dependencyOverrides.now ?? (() => new Date());
  const createBuildId = dependencyOverrides.createBuildId ?? randomUUID;

  if (typeof checkCheckout !== 'function'
    || typeof selectPublic !== 'function'
    || typeof projectPublic !== 'function'
    || typeof verifyPublic !== 'function'
    || typeof render !== 'function'
    || typeof checkLinks !== 'function'
    || typeof now !== 'function'
    || typeof createBuildId !== 'function') {
    const types = {
      checkCheckout: typeof checkCheckout,
      selectPublic: typeof selectPublic,
      projectPublic: typeof projectPublic,
      verifyPublic: typeof verifyPublic,
      render: typeof render,
      checkLinks: typeof checkLinks,
      now: typeof now,
      createBuildId: typeof createBuildId,
    };
    fail('invalid-site-dependency', `owner site dependencies must be functions: ${canonicalJson(types)}`, {
      types,
    });
  }

  const before = checkoutSnapshot(await checkCheckout(config), config);
  await exactExistingDirectory(before.root, 'canonical checkout');
  if (pathsOverlap(before.root, workspaceRoot)) {
    fail('site-checkout-workspace-overlap', 'owner site workspace must be completely outside the canonical checkout');
  }

  const buildId = exactBuildId(createBuildId());
  const buildRoot = contained(cacheRoot, path.join(cacheRoot, 'site-builds', buildId), {
    strict: true,
    code: 'site-build-outside-cache',
  });
  const projectionRoot = contained(buildRoot, path.join(buildRoot, 'projection'), {
    strict: true,
    code: 'site-build-outside-cache',
  });
  const rendererWorkspace = contained(cacheRoot, path.join(cacheRoot, 'quartz-owner'), {
    strict: true,
    code: 'site-renderer-workspace-outside-cache',
  });
  const candidateSite = contained(workspaceRoot, `${siteRoot}.candidate-${buildId}`, {
    strict: true,
    code: 'site-candidate-outside-workspace',
  });
  const backupRoot = contained(workspaceRoot, `${siteRoot}.previous-${buildId}`, {
    strict: true,
    code: 'site-backup-outside-workspace',
  });

  await assertAbsent(project, buildRoot, 'site build workspace');
  await assertAbsent(project, candidateSite, 'candidate owner site');
  await assertAbsent(project, backupRoot, 'owner site backup');
  await mkdir(buildRoot, { recursive: true, mode: 0o700 });
  await prepareContainedDirectory(project, workspaceRoot, rendererWorkspace, 'persistent Quartz workspace');

  let published = false;
  try {
    let selection;
    try {
      selection = await selectPublic(before.root, { audience: 'public' });
    } catch (error) {
      fail('site-selection-failed', 'public publication selection failed', {
        cause: error?.code ?? error?.message ?? 'unknown',
      });
    }
    if (!isPlainObject(selection)
      || !Array.isArray(selection.published)
      || !Array.isArray(selection.errors)
      || !isPlainObject(selection.report)
      || selection.published.length === 0
      || !isPlainObject(selection.report.published)
      || !Array.isArray(selection.report.published.pages)
      || selection.report.published.pages.length === 0) {
      fail('site-publication-empty', 'public publication selection must contain at least one page');
    }

    let projection;
    try {
      projection = await projectPublic(before.root, projectionRoot, {
        audience: 'public',
        selectResult: selection,
        lowercase: false,
        verify: true,
        writeReport: false,
      });
    } catch (error) {
      if (error instanceof OwnerAlphaError) throw error;
      fail('site-projection-failed', 'public projection threw before verification', {
        cause: error?.code ?? error?.message ?? 'unknown',
      });
    }
    if (!isPlainObject(projection) || projection.ok !== true) {
      fail('site-projection-failed', 'public projection did not complete successfully', {
        failures: Array.isArray(projection?.failures) ? projection.failures.slice(0, 20) : [],
      });
    }

    let explicitVerification;
    try {
      explicitVerification = await verifyPublic(before.root, projectionRoot, selection, {
        lowercase: false,
      });
    } catch (error) {
      fail('site-projection-verification-failed', 'explicit projection verification threw', {
        cause: error?.code ?? error?.message ?? 'unknown',
      });
    }
    if (!isPlainObject(explicitVerification) || explicitVerification.ok !== true) {
      fail('site-projection-verification-failed', 'explicit projection verification did not pass', {
        unexpected: explicitVerification?.unexpected?.slice?.(0, 20) ?? [],
        missing: explicitVerification?.missing?.slice?.(0, 20) ?? [],
        deniedPresent: explicitVerification?.deniedPresent?.slice?.(0, 20) ?? [],
      });
    }
    await inspectRegularTree(projectionRoot, 'public projection');
    const byteVerification = await verifyBytePreservingProjection(
      before.root,
      projectionRoot,
      selection.published,
    );

    let rendererResult;
    try {
      rendererResult = await render({
        contentDir: projectionRoot,
        outputDir: candidateSite,
        workspaceDir: rendererWorkspace,
        editLinkMode: 'owner',
        ownerOrigin: `http://${config.listen.host}:${config.listen.port}`,
      });
    } catch (error) {
      if (error instanceof OwnerAlphaError) throw error;
      fail('site-render-failed', 'pinned Quartz renderer failed', {
        cause: error?.code ?? error?.message ?? 'unknown',
      });
    }
    if (!isPlainObject(rendererResult)
      || rendererResult.renderer !== 'quartz-cyberbase'
      || rendererResult.revision !== PINNED_QUARTZ_COMMIT
      || rendererResult.tag !== PINNED_QUARTZ_REF
      || (rendererResult.outputDir !== undefined && path.resolve(rendererResult.outputDir) !== candidateSite)) {
      fail('site-renderer-identity-mismatch', 'renderer result did not prove the pinned Quartz owner build identity');
    }

    const html = await inspectHtmlSite(candidateSite);
    const outputTree = await digestRegularTree(candidateSite, 'rendered candidate site');
    let linkCheck;
    try {
      linkCheck = await checkLinks(candidateSite, {
        basePath: new URL(config.live.baseUrl).pathname.replace(/^\/+|\/+$/gu, ''),
      });
    } catch (error) {
      fail('site-linkcheck-failed', 'candidate site linkcheck baseline could not be computed', {
        cause: error?.code ?? error?.message ?? 'unknown',
      });
    }
    const links = summarizeLinks(linkCheck, html.pages);

    const after = checkoutSnapshot(await checkCheckout(config), config);
    if (!sameCheckout(before, after)) {
      fail('site-checkout-changed', 'canonical checkout changed while the owner site candidate was built', {
        before: { head: before.head, root: before.root },
        after: { head: after.head, root: after.root },
      });
    }

    const selectionDigest = `sha256:${createHash('sha256')
      .update(selection.published.map(exactPublishedPath).sort().join('\n'))
      .digest('hex')}`;
    const manifest = deepFreeze(jsonSafe({
      schemaVersion: OWNER_SITE_SCHEMA_VERSION,
      artifactType: OWNER_SITE_ARTIFACT_TYPE,
      generatedAt: timestamp(now),
      source: {
        head: before.head,
        branch: config.repository.branch,
        remote: config.repository.remote,
      },
      policyRevision: computePolicyRevision(config),
      publication: {
        audience: 'public',
        selectedFiles: selection.published.length,
        selectedPages: selection.report.published.pages.length,
        selectedAssets: Array.isArray(selection.report.published.assets)
          ? selection.report.published.assets.length
          : 0,
        deniedFiles: Array.isArray(selection.report.denied) ? selection.report.denied.length : 0,
        selectionErrors: selection.errors.length,
        selectionDigest,
      },
      projection: {
        ok: true,
        counts: jsonSafe(projection.counts ?? {}, 'projection counts'),
        warnings: Array.isArray(projection.warnings) ? projection.warnings.length : 0,
        verification: {
          ok: true,
          checked: jsonSafe(explicitVerification.checked ?? {}, 'projection verification counts'),
          unexpected: explicitVerification.unexpected?.length ?? 0,
          missing: explicitVerification.missing?.length ?? 0,
          deniedPresent: explicitVerification.deniedPresent?.length ?? 0,
          titleMatches: explicitVerification.titleMatchCount ?? 0,
        },
        bytePreserving: byteVerification,
      },
      renderer: {
        name: 'quartz-cyberbase',
        revision: PINNED_QUARTZ_COMMIT,
        tag: PINNED_QUARTZ_REF,
        repository: PINNED_QUARTZ_REPOSITORY,
        editLinkMode: 'owner',
        ownerOrigin: `http://${config.listen.host}:${config.listen.port}`,
        resources,
      },
      links,
      site: {
        htmlPages: html.pages,
        manifest: OWNER_SITE_MANIFEST_FILENAME,
        outputTree,
      },
    }, 'owner site manifest'));

    await writeFile(
      path.join(candidateSite, OWNER_SITE_MANIFEST_FILENAME),
      `${canonicalJson(manifest)}\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    );
    const publication = await publishCandidate({
      projectRoot: project,
      workspaceRoot,
      candidateSite,
      siteRoot,
      backupRoot,
    });
    published = true;

    return deepFreeze({
      ok: true,
      siteRoot,
      cacheRoot,
      rendererWorkspace,
      manifest,
      publication,
    });
  } finally {
    if (!published) {
      await rm(candidateSite, { recursive: true, force: true });
    }
    await rm(buildRoot, { recursive: true, force: true });
  }
}

export const buildOwnerSite = rebuildOwnerSite;

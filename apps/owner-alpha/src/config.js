import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail, OwnerAlphaError } from './errors.js';
import {
  assertNoCredentialMaterial,
  canonicalJson,
  deepFreeze,
  isPlainObject,
} from './json.js';
import { validatePrivateNetworkIpv4Host } from './network.js';

export const CONFIG_SCHEMA_VERSION = 1;
export const MAX_CONFIG_BYTES = 256 * 1024;
export const KNOWN_CHECKS = Object.freeze([
  'allowedOfmVerdicts',
  'requirePublishedSource',
  'requireProjectionVerification',
  'requireNoNewBrokenLinks',
  'requireRenderedWitness',
]);
export const REQUIRED_SAFETY_CHECKS = Object.freeze([
  'requirePublishedSource',
  'requireProjectionVerification',
  'requireNoNewBrokenLinks',
  'requireRenderedWitness',
]);

const TRUST_ROUTES = Object.freeze(['auto-merge', 'quick-review']);
const OFM_VERDICTS = Object.freeze(['clean', 'suspect']);
const WORKSPACE_ROOT = '.workspace/owner-alpha';
const REQUIRED_PATH_EXCLUDES = Object.freeze(['.git/**', '.workspace/**']);

function objectAt(value, location, keys) {
  if (!isPlainObject(value)) fail('invalid-config', `${location} must be an object`);
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  if (unknown.length > 0) {
    fail('unknown-config-key', `${location} contains unknown keys`, { location, keys: unknown.sort() });
  }
  const missing = keys.filter((key) => !Object.hasOwn(value, key));
  if (missing.length > 0) {
    fail('missing-config-key', `${location} is missing required keys`, { location, keys: missing });
  }
  return value;
}

function exactString(value, location, { max = 4096 } = {}) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || value.trim() !== value) {
    fail('invalid-config', `${location} must be a non-empty exact string without surrounding whitespace`);
  }
  if (/\p{Cc}/u.test(value)) fail('invalid-config', `${location} must not contain control characters`);
  return value;
}

function requiredBoolean(value, location) {
  if (typeof value !== 'boolean') fail('invalid-config', `${location} must be a boolean`);
  return value;
}

function positiveInteger(value, location, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    fail('invalid-config', `${location} must be a positive integer no greater than ${max}`);
  }
  return value;
}

function repositoryRelativePath(value, location, { globs = false } = {}) {
  const candidate = exactString(value, location);
  if (candidate.includes('\\') || candidate.startsWith('/') || candidate.startsWith('!')) {
    fail('invalid-config-path', `${location} must be a relative POSIX path${globs ? ' or glob' : ''}`);
  }
  const segments = candidate.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    fail('invalid-config-path', `${location} must not contain empty, dot, or parent segments`);
  }
  if (!globs && /[*?[\]{}]/u.test(candidate)) {
    fail('invalid-config-path', `${location} must not contain glob metacharacters`);
  }
  return candidate;
}

function absoluteCheckout(value, location) {
  const candidate = exactString(value, location);
  const root = path.parse(candidate).root;
  if (!path.isAbsolute(candidate)
    || candidate === root
    || candidate.includes('\\')
    || candidate.endsWith('/')
    || path.normalize(candidate) !== candidate) {
    fail('invalid-config-path', `${location} must be one normalized absolute checkout path`);
  }
  return candidate;
}

function branchName(value, location) {
  const branch = exactString(value, location, { max: 255 });
  const segments = branch.split('/');
  if (branch === '@'
    || branch.startsWith('/')
    || branch.endsWith('/')
    || branch.endsWith('.')
    || branch.includes('..')
    || branch.includes('//')
    || branch.includes('@{')
    || /[ ~^:?*[\\]/u.test(branch)
    || segments.some((segment) => segment.startsWith('.') || segment.endsWith('.lock'))) {
    fail('invalid-config-ref', `${location} must be one exact safe Git branch name`);
  }
  return branch;
}

// `allowPort` is only ever passed for the self-hosted forgejo-actions provider,
// whose instance commonly listens on a non-443 port. Every other rule is kept,
// including the exact canonical round-trip check. That check still rejects an
// explicit `:443`, because `https://host:443/` serializes back to the portless
// `https://host/` and therefore never equals the raw configured string. GitHub
// call sites never pass this option and stay byte-for-byte strict.
function exactHttpsUrl(value, location, { allowPort = false } = {}) {
  const raw = exactString(value, location);
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail('invalid-config-url', `${location} must be an absolute HTTPS URL`);
  }
  if (url.protocol !== 'https:'
    || url.username
    || url.password
    || (!allowPort && url.port)
    || url.search
    || url.hash
    || url.toString() !== raw) {
    fail('invalid-config-url', `${location} must be one canonical credential-free HTTPS URL`);
  }
  return url;
}

function uniqueStrings(values, location, validate, { sortBy } = {}) {
  if (!Array.isArray(values)) fail('invalid-config', `${location} must be an array`);
  const normalized = values.map((value, index) => validate(value, `${location}[${index}]`));
  if (new Set(normalized).size !== normalized.length) {
    fail('invalid-config', `${location} must not contain duplicates`);
  }
  if (sortBy) normalized.sort((left, right) => sortBy.indexOf(left) - sortBy.indexOf(right));
  return normalized;
}

function githubIdentityFromRemote(remoteUrl) {
  const url = new URL(remoteUrl);
  const match = url.pathname.match(/^\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\/([A-Za-z0-9_.-]{1,100})\.git$/u);
  if (url.hostname !== 'github.com' || !match || match[2].endsWith('.')) return null;
  return {
    owner: match[1],
    repository: match[2],
    slug: `${match[1]}/${match[2]}`,
    origin: url.origin,
  };
}

const FORGEJO_IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;

function forgejoIdentityFromRemote(remoteUrl) {
  const url = new URL(remoteUrl);
  const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\.git$/u);
  if (!match
    || !FORGEJO_IDENTIFIER_RE.test(match[1])
    || !FORGEJO_IDENTIFIER_RE.test(match[2])
    || match[1].endsWith('.')
    || match[2].endsWith('.')) return null;
  return {
    owner: match[1],
    repository: match[2],
    slug: `${match[1]}/${match[2]}`,
    origin: url.origin,
  };
}

function validateListen(value) {
  if (!isPlainObject(value)) fail('invalid-config', '$.listen must be an object');
  const unknown = Object.keys(value).filter((key) => !['host', 'port', 'readerPort'].includes(key));
  if (unknown.length > 0) {
    fail('unknown-config-key', '$.listen contains unknown keys', { location: '$.listen', keys: unknown.sort() });
  }
  if (!Object.hasOwn(value, 'host') || !Object.hasOwn(value, 'port')) {
    fail('missing-config-key', '$.listen is missing required keys');
  }
  const host = validatePrivateNetworkIpv4Host(value.host, '$.listen.host');
  const port = positiveInteger(value.port, '$.listen.port', 65534);
  const readerPort = Object.hasOwn(value, 'readerPort')
    ? positiveInteger(value.readerPort, '$.listen.readerPort', 65535)
    : port + 1;
  if (readerPort !== port + 1) {
    fail('invalid-reader-port', '$.listen.readerPort must be exactly one greater than the privileged owner port');
  }
  if (port === 80 || readerPort === 80) {
    // URL serialization elides the default HTTP port, which would break every
    // exact Host and Origin comparison in the server boundary.
    fail('default-http-port-forbidden', '$.listen ports must not place either origin on default HTTP port 80');
  }
  return { host, port, readerPort };
}

function validateRepository(value, provider) {
  const input = objectAt(value, '$.repository', ['checkout', 'remote', 'branch']);
  const remoteInput = objectAt(input.remote, '$.repository.remote', ['name', 'url']);
  const name = exactString(remoteInput.name, '$.repository.remote.name', { max: 255 });
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name)) {
    fail('invalid-config', '$.repository.remote.name must be one exact safe Git remote name');
  }
  const remoteUrl = exactHttpsUrl(remoteInput.url, '$.repository.remote.url', {
    allowPort: provider === 'forgejo-actions',
  });
  const identity = provider === 'github-actions'
    ? githubIdentityFromRemote(remoteUrl.toString())
    : forgejoIdentityFromRemote(remoteUrl.toString());
  if (!identity) {
    if (provider === 'github-actions') {
      fail('invalid-config-url', '$.repository.remote.url must be an exact https://github.com/owner/repository.git URL');
    }
    fail('invalid-config-url', '$.repository.remote.url must be an exact https://HOST/OWNER/REPOSITORY.git URL');
  }
  return {
    checkout: absoluteCheckout(input.checkout, '$.repository.checkout'),
    remote: { name, url: remoteUrl.toString() },
    branch: branchName(input.branch, '$.repository.branch'),
    identity,
  };
}

function validateOwner(value, repository, provider) {
  const input = objectAt(value, '$.owner', ['identity', 'allowedTrustRoutes']);
  const maxIdentityLength = provider === 'github-actions' ? 39 : 100;
  const identity = exactString(input.identity, '$.owner.identity', { max: maxIdentityLength });
  if (identity !== repository.identity.owner) {
    const forge = provider === 'forgejo-actions' ? 'Forgejo' : 'GitHub';
    fail('owner-identity-mismatch', `$.owner.identity must exactly match the configured ${forge} remote owner`);
  }
  const allowedTrustRoutes = uniqueStrings(
    input.allowedTrustRoutes,
    '$.owner.allowedTrustRoutes',
    (entry, location) => {
      const route = exactString(entry, location, { max: 32 });
      if (!TRUST_ROUTES.includes(route)) {
        fail('unknown-trust-route', `${location} may only be "auto-merge" or "quick-review"`);
      }
      return route;
    },
    { sortBy: TRUST_ROUTES },
  );
  if (!allowedTrustRoutes.includes('auto-merge')) {
    fail('invalid-trust-policy', '$.owner.allowedTrustRoutes must include "auto-merge"');
  }
  return { identity, allowedTrustRoutes };
}

function validateGithubLive(value, repository) {
  const input = objectAt(value, '$.live', ['baseUrl']);
  const url = exactHttpsUrl(input.baseUrl, '$.live.baseUrl');
  const { owner, repository: name } = repository.identity;
  const expectedHost = `${owner.toLowerCase()}.github.io`;
  const expectedPath = name.toLowerCase() === expectedHost ? '/' : `/${name}/`;
  if (url.hostname !== expectedHost || url.pathname !== expectedPath) {
    fail(
      'live-origin-mismatch',
      '$.live.baseUrl must be the exact GitHub Pages base URL for the configured repository',
      { expected: `https://${expectedHost}${expectedPath}` },
    );
  }
  return { baseUrl: url.toString() };
}

function validateForgejoLive(value) {
  const input = objectAt(value, '$.live', ['baseUrl']);
  const url = exactHttpsUrl(input.baseUrl, '$.live.baseUrl', { allowPort: true });
  if (!url.pathname.endsWith('/')) {
    fail('invalid-config-url', '$.live.baseUrl must be a canonical credential-free HTTPS URL ending in /');
  }
  return { baseUrl: url.toString() };
}

function validateGithubWorkflow(value, repository) {
  const input = objectAt(
    value,
    '$.workflow',
    ['provider', 'repository', 'name', 'path', 'event', 'branch', 'jobs', 'environment'],
  );
  if (input.provider !== 'github-actions') {
    fail('invalid-config', '$.workflow.provider must be exactly "github-actions"');
  }
  const workflowRepository = exactString(input.repository, '$.workflow.repository', { max: 255 });
  if (workflowRepository !== repository.identity.slug) {
    fail('workflow-repository-mismatch', '$.workflow.repository must exactly match the configured GitHub remote');
  }
  const name = exactString(input.name, '$.workflow.name', { max: 255 });
  const workflowPath = repositoryRelativePath(input.path, '$.workflow.path');
  if (!/^\.github\/workflows\/[A-Za-z0-9][A-Za-z0-9._-]*\.yml$/u.test(workflowPath)) {
    fail('invalid-config-path', '$.workflow.path must be a full .github/workflows/*.yml path');
  }
  if (input.event !== 'push') fail('invalid-config', '$.workflow.event must be exactly "push"');
  const branch = branchName(input.branch, '$.workflow.branch');
  if (branch !== repository.branch) {
    fail('workflow-branch-mismatch', '$.workflow.branch must exactly match $.repository.branch');
  }
  const jobs = uniqueStrings(input.jobs, '$.workflow.jobs', (entry, location) => (
    exactString(entry, location, { max: 255 })
  ));
  if (jobs.length === 0) fail('invalid-config', '$.workflow.jobs must contain the exact ordered job names');
  if (input.environment !== 'github-pages') {
    fail('invalid-config', '$.workflow.environment must be exactly "github-pages"');
  }
  return {
    provider: 'github-actions',
    repository: workflowRepository,
    name,
    path: workflowPath,
    event: 'push',
    branch,
    jobs,
    environment: 'github-pages',
  };
}

function validateForgejoWorkflow(value, repository) {
  const input = objectAt(
    value,
    '$.workflow',
    ['provider', 'apiBaseUrl', 'repository', 'path', 'event', 'branch', 'jobs', 'deploymentJob'],
  );
  if (input.provider !== 'forgejo-actions') {
    fail('invalid-config', '$.workflow.provider must be exactly "forgejo-actions"');
  }
  const apiBaseUrl = exactHttpsUrl(input.apiBaseUrl, '$.workflow.apiBaseUrl', { allowPort: true });
  if (apiBaseUrl.origin !== repository.identity.origin || apiBaseUrl.pathname !== '/api/v1') {
    fail('forgejo-api-mismatch', '$.workflow.apiBaseUrl must be exactly https://HOST/api/v1 on the configured Git remote origin');
  }
  const workflowRepository = exactString(input.repository, '$.workflow.repository', { max: 201 });
  if (workflowRepository !== repository.identity.slug) {
    fail('workflow-repository-mismatch', '$.workflow.repository must exactly match the configured Forgejo remote');
  }
  const workflowPath = repositoryRelativePath(input.path, '$.workflow.path');
  const workflowMatch = workflowPath.match(/^\.forgejo\/workflows\/([A-Za-z0-9][A-Za-z0-9._-]*)\.yml$/u);
  if (!workflowMatch
    || !FORGEJO_IDENTIFIER_RE.test(workflowMatch[1])
    || workflowMatch[1].endsWith('.')) {
    fail('invalid-config-path', '$.workflow.path must be a full .forgejo/workflows/<safe-name>.yml path');
  }
  if (input.event !== 'push') fail('invalid-config', '$.workflow.event must be exactly "push"');
  const branch = branchName(input.branch, '$.workflow.branch');
  if (branch !== repository.branch) {
    fail('workflow-branch-mismatch', '$.workflow.branch must exactly match $.repository.branch');
  }
  const jobs = uniqueStrings(input.jobs, '$.workflow.jobs', (entry, location) => (
    exactString(entry, location, { max: 255 })
  ));
  if (jobs.length === 0) fail('invalid-config', '$.workflow.jobs must contain at least one exact job name');
  const deploymentJob = exactString(input.deploymentJob, '$.workflow.deploymentJob', { max: 255 });
  if (jobs.filter((job) => job === deploymentJob).length !== 1) {
    fail('invalid-config', '$.workflow.deploymentJob must occur exactly once in $.workflow.jobs');
  }
  return {
    provider: 'forgejo-actions',
    apiBaseUrl: apiBaseUrl.toString(),
    repository: workflowRepository,
    path: workflowPath,
    event: 'push',
    branch,
    jobs,
    deploymentJob,
  };
}

function workflowProvider(value) {
  if (!isPlainObject(value) || !Object.hasOwn(value, 'provider')) {
    fail('missing-config-key', '$.workflow is missing required keys', { location: '$.workflow', keys: ['provider'] });
  }
  if (value.provider === 'github-actions' || value.provider === 'forgejo-actions') return value.provider;
  fail('unsupported-deployment-provider', 'unsupported deployment observation provider');
}

function isStrictlyWithin(root, candidate) {
  const relative = path.posix.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith('../') && !path.posix.isAbsolute(relative);
}

function validateWorkspace(value) {
  const input = objectAt(value, '$.workspace', ['root', 'store', 'site', 'cache']);
  const root = repositoryRelativePath(input.root, '$.workspace.root');
  if (root !== WORKSPACE_ROOT) {
    fail('invalid-workspace-root', `$.workspace.root must be exactly "${WORKSPACE_ROOT}"`);
  }
  const children = Object.fromEntries(['store', 'site', 'cache'].map((key) => {
    const candidate = repositoryRelativePath(input[key], `$.workspace.${key}`);
    if (!isStrictlyWithin(root, candidate)) {
      fail('workspace-path-outside-root', `$.workspace.${key} must be strictly beneath ${WORKSPACE_ROOT}`);
    }
    return [key, candidate];
  }));
  if (new Set(Object.values(children)).size !== Object.keys(children).length) {
    fail('invalid-config-path', '$.workspace.store, site, and cache must be distinct paths');
  }
  return { root, ...children };
}

function validatePaths(value) {
  const input = objectAt(value, '$.paths', ['include', 'exclude']);
  const include = uniqueStrings(
    input.include,
    '$.paths.include',
    (entry, location) => repositoryRelativePath(entry, location, { globs: true }),
  ).sort();
  const exclude = uniqueStrings(
    input.exclude,
    '$.paths.exclude',
    (entry, location) => repositoryRelativePath(entry, location, { globs: true }),
  ).sort();
  if (include.length === 0) fail('invalid-config', '$.paths.include must not be empty');
  const overlap = include.filter((entry) => exclude.includes(entry));
  if (overlap.length > 0) {
    fail('invalid-path-policy', '$.paths include and exclude entries must not overlap exactly', { paths: overlap });
  }
  const missingExcludes = REQUIRED_PATH_EXCLUDES.filter((entry) => !exclude.includes(entry));
  if (missingExcludes.length > 0) {
    fail('missing-safety-exclude', '$.paths.exclude must protect Git metadata and owner-alpha workspace', {
      paths: missingExcludes,
    });
  }
  return { include, exclude };
}

function validateLimits(value) {
  const input = objectAt(value, '$.limits', [
    'maxSourceBytes',
    'maxReplacementBytes',
    'maxChangedBytes',
    'maxChangedLines',
    'maxArtifactBytes',
    'requestTimeoutMs',
    'networkTimeoutMs',
  ]);
  const limits = Object.fromEntries(Object.keys(input).map((key) => [
    key,
    positiveInteger(input[key], `$.limits.${key}`),
  ]));
  if (limits.maxReplacementBytes > limits.maxChangedBytes
    || limits.maxChangedBytes > limits.maxSourceBytes
    || limits.maxSourceBytes > limits.maxArtifactBytes
    || limits.requestTimeoutMs > limits.networkTimeoutMs) {
    fail(
      'invalid-limit-policy',
      'limits must satisfy replacement <= changed <= source <= artifact and request timeout <= network timeout',
    );
  }
  return limits;
}

function validateChecks(value) {
  const input = objectAt(value, '$.checks', KNOWN_CHECKS);
  const allowedOfmVerdicts = uniqueStrings(
    input.allowedOfmVerdicts,
    '$.checks.allowedOfmVerdicts',
    (entry, location) => {
      const verdict = exactString(entry, location, { max: 32 });
      if (!OFM_VERDICTS.includes(verdict)) {
        fail('unknown-ofm-verdict', `${location} may only be "clean" or "suspect"; "damage" is never allowed`);
      }
      return verdict;
    },
    { sortBy: OFM_VERDICTS },
  );
  if (!allowedOfmVerdicts.includes('clean')) {
    fail('invalid-check-policy', '$.checks.allowedOfmVerdicts must include "clean"');
  }
  const checks = { allowedOfmVerdicts };
  for (const key of REQUIRED_SAFETY_CHECKS) {
    checks[key] = requiredBoolean(input[key], `$.checks.${key}`);
    if (!checks[key]) fail('missing-safety-check', `$.checks.${key} must be true`);
  }
  return checks;
}

function validateGit(value) {
  const input = objectAt(value, '$.git', [
    'autoCommit',
    'autoPush',
    'useHooks',
    'commitMessagePrefix',
  ]);
  const autoCommit = requiredBoolean(input.autoCommit, '$.git.autoCommit');
  const autoPush = requiredBoolean(input.autoPush, '$.git.autoPush');
  const useHooks = requiredBoolean(input.useHooks, '$.git.useHooks');
  if (autoPush && !autoCommit) {
    fail('invalid-git-policy', '$.git.autoPush cannot be true when $.git.autoCommit is false');
  }
  const commitMessagePrefix = exactString(
    input.commitMessagePrefix,
    '$.git.commitMessagePrefix',
    { max: 100 },
  );
  return { autoCommit, autoPush, useHooks, commitMessagePrefix };
}

export function validateOwnerAlphaConfig(value) {
  assertNoCredentialMaterial(value);
  const input = objectAt(value, '$', [
    'schemaVersion',
    'listen',
    'repository',
    'owner',
    'live',
    'workflow',
    'workspace',
    'paths',
    'limits',
    'checks',
    'git',
  ]);
  if (input.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    fail('unsupported-config-version', `schemaVersion must be ${CONFIG_SCHEMA_VERSION}`);
  }
  const provider = workflowProvider(input.workflow);
  const repositoryWithIdentity = validateRepository(input.repository, provider);
  const repository = {
    checkout: repositoryWithIdentity.checkout,
    remote: repositoryWithIdentity.remote,
    branch: repositoryWithIdentity.branch,
  };
  const normalized = {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    listen: validateListen(input.listen),
    repository,
    owner: validateOwner(input.owner, repositoryWithIdentity, provider),
    live: provider === 'github-actions'
      ? validateGithubLive(input.live, repositoryWithIdentity)
      : validateForgejoLive(input.live),
    workflow: provider === 'github-actions'
      ? validateGithubWorkflow(input.workflow, repositoryWithIdentity)
      : validateForgejoWorkflow(input.workflow, repositoryWithIdentity),
    workspace: validateWorkspace(input.workspace),
    paths: validatePaths(input.paths),
    limits: validateLimits(input.limits),
    checks: validateChecks(input.checks),
    git: validateGit(input.git),
  };
  return deepFreeze(normalized);
}

export function policyDocument(configInput) {
  const config = validateOwnerAlphaConfig(configInput);
  return deepFreeze({
    schemaVersion: config.schemaVersion,
    listen: config.listen,
    repository: {
      remote: config.repository.remote,
      branch: config.repository.branch,
    },
    owner: config.owner,
    live: config.live,
    workflow: config.workflow,
    workspace: config.workspace,
    paths: config.paths,
    limits: config.limits,
    checks: config.checks,
    git: config.git,
  });
}

export function computePolicyRevision(configInput) {
  const document = policyDocument(configInput);
  return `sha256:${createHash('sha256').update(canonicalJson(document)).digest('hex')}`;
}

export async function loadOwnerAlphaConfig(file) {
  const absolute = path.resolve(file instanceof URL ? fileURLToPath(file) : file);
  let handle;
  try {
    handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.nlink !== 1) {
      fail('invalid-config-file', 'owner-alpha config must be one regular, unlinked file');
    }
    if ((metadata.mode & 0o077) !== 0) {
      fail('config-permissions-too-open', 'owner-alpha config must not be accessible by group or other users');
    }
    if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) {
      fail('config-owner-mismatch', 'owner-alpha config must be owned by the current user');
    }
    if (metadata.size > MAX_CONFIG_BYTES) {
      fail('config-too-large', `owner-alpha config exceeds ${MAX_CONFIG_BYTES} bytes`);
    }
    const parsed = JSON.parse(await handle.readFile('utf8'));
    return validateOwnerAlphaConfig(parsed);
  } catch (error) {
    if (error instanceof OwnerAlphaError) throw error;
    if (error?.code === 'ELOOP') fail('config-symlink-rejected', 'owner-alpha config must not be a symlink');
    if (error instanceof SyntaxError) fail('invalid-config-json', 'owner-alpha config must be strict JSON');
    fail('config-read-failed', 'owner-alpha config could not be read', { cause: error?.code ?? 'unknown' });
  } finally {
    await handle?.close();
  }
}

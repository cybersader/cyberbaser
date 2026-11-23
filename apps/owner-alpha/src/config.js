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
import { validSocketPath } from './publisher/protocol.js';

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

// Other repository identities the owner declares to be the same vault, for
// example a Forgejo copy that exists only to take pull requests. A proposal
// bound to an alias passes the repository identity check at review and Apply;
// every exact check (base reachable from the owner branch, exact blob) still
// applies. The list is part of the durable policy.
const MAX_REPOSITORY_ALIASES = 8;

function validateRepositoryAliases(value, remoteUrl) {
  if (value === undefined) return [];
  const aliases = uniqueStrings(value, '$.repository.aliases', (entry, location) => {
    const url = exactHttpsUrl(entry, location, { allowPort: true });
    if (!url.pathname.endsWith('.git') || url.pathname.split('/').length !== 3 || url.pathname.includes('//')) {
      fail('invalid-config-url', `${location} must be an exact https://HOST/OWNER/REPOSITORY.git URL`);
    }
    if (url.toString() === remoteUrl) fail('invalid-config', `${location} repeats $.repository.remote.url`);
    return url.toString();
  });
  if (aliases.length > MAX_REPOSITORY_ALIASES) {
    fail('invalid-config', `$.repository.aliases may name at most ${MAX_REPOSITORY_ALIASES} repositories`);
  }
  return aliases;
}

/** True when a proposal bound to `repositoryUrl` belongs to this owner's vault. */
export function repositoryMatchesPolicy(config, repositoryUrl) {
  return repositoryUrl === config.repository.remote.url || config.repository.aliases.includes(repositoryUrl);
}

function validateRepository(value, provider) {
  const keys = ['checkout', 'remote', 'branch'];
  if (isPlainObject(value) && Object.hasOwn(value, 'aliases')) keys.push('aliases');
  const input = objectAt(value, '$.repository', keys);
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
    aliases: validateRepositoryAliases(input.aliases, remoteUrl.toString()),
    identity,
  };
}

function validateOwner(value, repository, provider) {
  const optional = isPlainObject(value) && Object.hasOwn(value, 'allowProperties');
  const input = objectAt(value, '$.owner', ['identity', 'allowedTrustRoutes', ...(optional ? ['allowProperties'] : [])]);
  const allowProperties = optional && requiredBoolean(input.allowProperties, '$.owner.allowProperties');
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
  return { identity, allowedTrustRoutes, ...(allowProperties ? { allowProperties } : {}) };
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

function validateProposalReview(value) {
  const input = objectAt(value, '$.proposalReview', [
    'enabled',
    'socketPath',
    'requestTimeoutMs',
    'maxListEntries',
  ]);
  const enabled = requiredBoolean(input.enabled, '$.proposalReview.enabled');
  if (input.requestTimeoutMs !== 5000) {
    fail('invalid-review-policy', '$.proposalReview.requestTimeoutMs must be exactly 5000');
  }
  if (input.maxListEntries !== 100) {
    fail('invalid-review-policy', '$.proposalReview.maxListEntries must be exactly 100');
  }
  let socketPath = null;
  if (enabled) {
    socketPath = exactString(input.socketPath, '$.proposalReview.socketPath');
    const parent = path.dirname(socketPath);
    if (!path.isAbsolute(socketPath)
      || path.normalize(socketPath) !== socketPath
      || socketPath.endsWith('/')
      || socketPath === path.parse(socketPath).root
      || parent === path.parse(parent).root) {
      fail('invalid-config-path', '$.proposalReview.socketPath must be one normalized absolute path beneath a non-root parent');
    }
  } else if (input.socketPath !== null) {
    fail('invalid-review-policy', '$.proposalReview.socketPath must be null while proposal review is disabled');
  }
  return { enabled, socketPath, requestTimeoutMs: 5000, maxListEntries: 100 };
}

// A configured input is not a reader or publication grant. The approved coherent
// reader is injected separately; this policy only selects one existing page.
function publicationPath(value, location) {
  const candidate = repositoryRelativePath(value, location);
  if (candidate.length > 1024 || !candidate.isWellFormed() || /[:%?#]/u.test(candidate)) {
    fail('invalid-config-path', `${location} must be one bounded exact relative path without URL syntax`);
  }
  return candidate;
}

function publicationId(value, location) {
  const candidate = exactString(value, location, { max: 128 });
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(candidate) || candidate.includes('..')) {
    fail('invalid-config', `${location} must be one opaque safe identifier`);
  }
  return candidate;
}

function validateOwnerPublication(value) {
  if (value === undefined) return { enabled: false };
  if (!isPlainObject(value)) fail('invalid-config', '$.ownerPublication must be an object');
  const enabled = requiredBoolean(value.enabled, '$.ownerPublication.enabled');
  if (!enabled) {
    objectAt(value, '$.ownerPublication', ['enabled']);
    return { enabled: false };
  }
  const input = objectAt(value, '$.ownerPublication', ['enabled', 'mappings',
    ...(Object.hasOwn(value, 'retiredList') ? ['retiredList'] : []),
  ]);
  const retiredList = Object.hasOwn(input, 'retiredList') ? {
    file: absoluteCheckout(objectAt(input.retiredList, '$.ownerPublication.retiredList', ['file']).file,
      '$.ownerPublication.retiredList.file'),
  } : undefined;
  if (!Array.isArray(input.mappings) || input.mappings.length !== 1) {
    fail('invalid-config', '$.ownerPublication.mappings must contain exactly one existing-page mapping');
  }
  const location = '$.ownerPublication.mappings[0]';
  const mapping = objectAt(input.mappings[0], location, ['id', 'source', 'relativePath', 'slug']);
  const hasKind = isPlainObject(mapping.source) && Object.hasOwn(mapping.source, 'kind');
  const source = objectAt(mapping.source, `${location}.source`, ['identity', 'path', ...(hasKind ? ['kind'] : [])]);
  if (hasKind && source.kind !== 'workspace') {
    fail('invalid-config', `${location}.source.kind must be omitted or "workspace"`);
  }
  const relativePath = publicationPath(mapping.relativePath, `${location}.relativePath`);
  if (path.posix.extname(relativePath) !== '.md') {
    fail('invalid-config-path', `${location}.relativePath must identify one lowercase .md page`);
  }
  return {
    enabled: true,
    mappings: [{
      id: publicationId(mapping.id, `${location}.id`),
      source: {
        identity: publicationId(source.identity, `${location}.source.identity`),
        path: publicationPath(source.path, `${location}.source.path`),
        ...(hasKind ? { kind: source.kind } : {}),
      },
      relativePath,
      slug: publicationPath(mapping.slug, `${location}.slug`),
    }],
    ...(retiredList !== undefined ? { retiredList } : {}),
  };
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

// Suggestions: the owner's one place to turn the outside lanes on or off. The
// form lane serves the account-free correction form on the owner's private
// local site; the forge lane watches one forge copy of the vault for pull
// requests. Both feed the same Proposals inbox through the intake service the
// owner app starts beside itself, so the intake's own settings are derived from
// here and never edited separately. Off is the default and leaves the pinned
// policy revision unchanged.
const SUGGESTION_FORGE_MIN_POLL_MS = 10_000;
const SUGGESTION_FORGE_MAX_POLL_MS = 3_600_000;

// Registry membership and provider-specific key validation belong to the intake
// and renderer. Owner policy validates only the portable public configuration.
function validateSuggestionChallenge(value, formEnabled) {
  const location = '$.suggestions.form.challenge';
  const input = objectAt(value, location, ['provider', 'siteKey', 'secretFile', 'expectedHostnames']);
  if (!formEnabled) fail('invalid-config', `${location} requires the suggestion form to be enabled`);
  const provider = exactString(input.provider, `${location}.provider`, { max: 64 });
  if (!/^[a-z][a-z0-9-]*$/u.test(provider)) {
    fail('invalid-config', `${location}.provider must be one provider id`);
  }
  const siteKey = exactString(input.siteKey, `${location}.siteKey`, { max: 256 });
  if (/[\s\x00-\x1f\x7f]/u.test(siteKey)) {
    fail('invalid-config', `${location}.siteKey must be one public key without whitespace or control characters`);
  }
  const secretFile = exactString(input.secretFile, `${location}.secretFile`);
  if (!path.isAbsolute(secretFile) || path.normalize(secretFile) !== secretFile
    || secretFile.includes('\0') || secretFile.endsWith('/')
    || path.dirname(secretFile) === path.parse(secretFile).root) {
    fail('invalid-config-path', `${location}.secretFile must be one normalized absolute path beneath a non-root parent`);
  }
  const hosts = input.expectedHostnames;
  if (!Array.isArray(hosts) || hosts.length < 1 || hosts.length > 100
    || hosts.some((host) => typeof host !== 'string' || host.length > 253
      || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(host)
      || host.split('.').some((label) => label.length > 63 || label.startsWith('-') || label.endsWith('-') || label.length === 0))
    || new Set(hosts).size !== hosts.length) {
    fail('invalid-config', `${location}.expectedHostnames must contain unique canonical hostnames without ports`);
  }
  return { provider, siteKey, secretFile, expectedHostnames: [...hosts] };
}

function validateSuggestions(value, { listen, proposalReview, repository }) {
  if (value === undefined) return { form: { enabled: false }, forge: { enabled: false } };
  const input = objectAt(value, '$.suggestions', ['form', 'forge', ...(isPlainObject(value) && Object.hasOwn(value, 'editEntry') ? ['editEntry'] : [])]);
  if (Object.hasOwn(input, 'editEntry') && !['auto', 'floating', 'inline'].includes(input.editEntry)) fail('invalid-config', '$.suggestions.editEntry must be auto, floating, or inline');
  const form = objectAt(input.form, '$.suggestions.form', [
    'enabled',
    ...(isPlainObject(input.form) && Object.hasOwn(input.form, 'challenge') ? ['challenge'] : []),
  ]);
  const formEnabled = requiredBoolean(form.enabled, '$.suggestions.form.enabled');
  if (formEnabled && listen.readerPort + 1 > 65535) {
    fail('invalid-config', '$.listen.port leaves no room for the suggestion form port (owner port + 2)');
  }

  if (!isPlainObject(input.forge)) fail('invalid-config', '$.suggestions.forge must be an object');
  const forgeEnabled = requiredBoolean(input.forge.enabled, '$.suggestions.forge.enabled');
  let forge = { enabled: false };
  if (forgeEnabled) {
    const forgeInput = objectAt(input.forge, '$.suggestions.forge', [
      'enabled',
      'repository',
      'tokenFile',
      'pollIntervalMs',
    ]);
    const url = exactHttpsUrl(forgeInput.repository, '$.suggestions.forge.repository', { allowPort: true });
    const segments = url.pathname.split('/');
    if (!url.pathname.endsWith('.git') || segments.length !== 3 || url.pathname.includes('//')) {
      fail('invalid-config-url', '$.suggestions.forge.repository must be an exact https://HOST/OWNER/REPOSITORY.git URL');
    }
    const repositoryUrl = url.toString();
    if (repositoryUrl !== repository.remote.url && !repository.aliases.includes(repositoryUrl)) {
      fail('invalid-config', '$.suggestions.forge.repository must be $.repository.remote.url or one of $.repository.aliases');
    }
    let tokenFile = null;
    if (forgeInput.tokenFile !== null) {
      tokenFile = exactString(forgeInput.tokenFile, '$.suggestions.forge.tokenFile');
      const parent = path.dirname(tokenFile);
      if (!path.isAbsolute(tokenFile)
        || path.normalize(tokenFile) !== tokenFile
        || tokenFile.endsWith('/')
        || parent === path.parse(parent).root) {
        fail('invalid-config-path', '$.suggestions.forge.tokenFile must be one normalized absolute path beneath a non-root parent');
      }
    }
    const pollIntervalMs = positiveInteger(forgeInput.pollIntervalMs, '$.suggestions.forge.pollIntervalMs', SUGGESTION_FORGE_MAX_POLL_MS);
    if (pollIntervalMs < SUGGESTION_FORGE_MIN_POLL_MS) {
      fail('invalid-config', `$.suggestions.forge.pollIntervalMs must be at least ${SUGGESTION_FORGE_MIN_POLL_MS}`);
    }
    // Declared values only, so a normalized config re-validates unchanged; the
    // forge API base, owner, and name derive from the URL via forgeIdentity().
    forge = { enabled: true, repository: repositoryUrl, tokenFile, pollIntervalMs };
  } else {
    objectAt(input.forge, '$.suggestions.forge', ['enabled']);
  }

  if ((formEnabled || forgeEnabled) && !proposalReview.enabled) {
    fail('suggestions-require-proposal-review', 'suggestions reach the inbox through proposal review; enable $.proposalReview first');
  }
  return {
    form: {
      enabled: formEnabled,
      ...(Object.hasOwn(form, 'challenge') ? { challenge: validateSuggestionChallenge(form.challenge, formEnabled) } : {}),
    },
    forge,
    ...(Object.hasOwn(input, 'editEntry') ? { editEntry: input.editEntry } : {}),
  };
}

/** The forge API base, owner, and repository name behind one forge clone URL. */
export function forgeIdentity(repositoryUrl) {
  const url = new URL(repositoryUrl);
  const segments = url.pathname.split('/');
  return {
    apiBaseUrl: `${url.origin}/api/v1`,
    owner: segments[1],
    name: segments[2].slice(0, -'.git'.length),
  };
}

export function suggestionsEnabled(config) {
  return config.suggestions.form.enabled || config.suggestions.forge.enabled;
}

// Off unless present with enabled: true. The relay is configuration: 'n0'
// (n0's public relay, the explicit default when enabled), 'none' (direct
// paths only), or one https relay URL the owner runs. Nothing falls back.
function validateIroh(value) {
  const keys = isPlainObject(value) ? Object.keys(value) : [];
  const input = objectAt(value, '$.iroh', ['enabled', 'stateDirectory',
    ...['relay', 'bindAddress'].filter((key) => keys.includes(key))]);
  if (typeof input.enabled !== 'boolean') fail('invalid-config', '$.iroh.enabled must be a boolean');
  const stateDirectory = absoluteCheckout(input.stateDirectory, '$.iroh.stateDirectory');
  const relay = Object.hasOwn(input, 'relay') ? input.relay : 'n0';
  if (relay !== 'n0' && relay !== 'none') {
    let url;
    try { url = new URL(relay); } catch { url = null; }
    // Plain HTTP only for a relay on this machine's loopback address (local
    // tests and browser clients on the same machine); anything else is https.
    const loopbackHttp = url?.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port !== '';
    if (typeof relay !== 'string' || relay.length > 512 || (url?.protocol !== 'https:' && !loopbackHttp)
      || url.username || url.password || url.search || url.hash) {
      fail('invalid-config', "$.iroh.relay must be 'n0', 'none', one https relay URL, or an http://127.0.0.1:<port>/ relay");
    }
  }
  let bindAddress = null;
  if (Object.hasOwn(input, 'bindAddress')) {
    const match = typeof input.bindAddress === 'string' && /^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/u.exec(input.bindAddress);
    if (!match || match[1].split('.').some((part) => Number(part) > 255) || Number(match[2]) > 65535) {
      fail('invalid-config', '$.iroh.bindAddress must be one IPv4 address and port');
    }
    bindAddress = input.bindAddress;
  }
  return { enabled: input.enabled, stateDirectory, relay, ...(bindAddress === null ? {} : { bindAddress }) };
}

// Where the publisher gets its short-lived push credential. Only the provider
// and the public GitHub App client ID are policy; the state directory is the
// publisher's private storage and never enters the policy revision.
const FORGE_ACCESS_PROVIDERS = Object.freeze(['github-app', 'token']);

function validateForgeAccess(value, provider) {
  const keys = isPlainObject(value) && value.provider === 'github-app'
    ? ['provider', 'clientId', 'stateDirectory'] : ['provider', 'stateDirectory'];
  const input = objectAt(value, '$.forgeAccess', keys);
  if (!FORGE_ACCESS_PROVIDERS.includes(input.provider)) {
    fail('invalid-config', '$.forgeAccess.provider must be "github-app" or "token"');
  }
  if (provider !== 'github-actions') {
    fail('invalid-config', '$.forgeAccess is only available for a GitHub repository today');
  }
  const stateDirectory = absoluteCheckout(input.stateDirectory, '$.forgeAccess.stateDirectory');
  if (input.provider === 'token') return { provider: 'token', stateDirectory };
  const clientId = exactString(input.clientId, '$.forgeAccess.clientId', { max: 64 });
  if (!/^Iv[0-9A-Za-z.]{6,40}$/u.test(clientId)) {
    fail('invalid-config', '$.forgeAccess.clientId must be a GitHub App client ID (it starts with Iv)');
  }
  return { provider: 'github-app', clientId, stateDirectory };
}

/**
 * The raw config with its GitHub repository changed to `fullName` ("owner/name").
 * Every GitHub field is derived from that one identity, so the result changes the
 * policy revision exactly as editing the repository by hand would.
 */
export function retargetGithubRepository(raw, fullName) {
  const identity = typeof fullName === 'string' ? githubIdentityFromRemote(`https://github.com/${fullName}.git`) : null;
  if (identity === null || identity.slug !== fullName) fail('invalid-repository', 'repository must be one exact owner/name');
  const current = validateOwnerAlphaConfig(raw);
  if (current.workflow.provider !== 'github-actions') fail('invalid-config', 'only a GitHub repository can be picked this way');
  const pagesHost = `${identity.owner.toLowerCase()}.github.io`;
  const next = structuredClone(raw);
  next.repository.remote.url = `https://github.com/${identity.slug}.git`;
  next.workflow.repository = identity.slug;
  next.owner.identity = identity.owner;
  next.live.baseUrl = `https://${pagesHost}${identity.repository.toLowerCase() === pagesHost ? '/' : `/${identity.repository}/`}`;
  if (Array.isArray(next.repository.aliases)) {
    next.repository.aliases = next.repository.aliases.filter((alias) => alias !== next.repository.remote.url);
    if (next.repository.aliases.length === 0) delete next.repository.aliases;
  }
  validateOwnerAlphaConfig(next);
  return next;
}

function validatePublisher(value) {
  const { socketPath } = objectAt(value, '$.publisher', ['socketPath']);
  if (!validSocketPath(socketPath)) {
    fail('invalid-config-path', '$.publisher.socketPath must be one normalized absolute Unix socket path');
  }
  return { socketPath };
}

export function validateOwnerAlphaConfig(value) {
  assertNoCredentialMaterial(value);
  const input = objectAt(value, '$', [
    'schemaVersion',
    'listen',
    'proposalReview',
    'repository',
    'owner',
    'live',
    'workflow',
    'workspace',
    'paths',
    'limits',
    'checks',
    'git',
    ...(isPlainObject(value) && Object.hasOwn(value, 'suggestions') ? ['suggestions'] : []),
    ...(isPlainObject(value) && Object.hasOwn(value, 'ownerPublication') ? ['ownerPublication'] : []),
    ...(isPlainObject(value) && Object.hasOwn(value, 'publisher') ? ['publisher'] : []),
    ...(isPlainObject(value) && Object.hasOwn(value, 'deviceRegistryFile') ? ['deviceRegistryFile'] : []),
    ...(isPlainObject(value) && Object.hasOwn(value, 'signedRequestSocket') ? ['signedRequestSocket'] : []),
    ...(isPlainObject(value) && Object.hasOwn(value, 'iroh') ? ['iroh'] : []),
    ...(isPlainObject(value) && Object.hasOwn(value, 'forgeAccess') ? ['forgeAccess'] : []),
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
    aliases: repositoryWithIdentity.aliases,
  };
  const listen = validateListen(input.listen);
  const proposalReview = validateProposalReview(input.proposalReview);
  const deviceRegistryFile = Object.hasOwn(input, 'deviceRegistryFile')
    ? absoluteCheckout(input.deviceRegistryFile, '$.deviceRegistryFile') : undefined;
  if (Object.hasOwn(input, 'signedRequestSocket')) {
    if (!validSocketPath(input.signedRequestSocket)) {
      fail('invalid-config-path', '$.signedRequestSocket must be one normalized absolute Unix socket path');
    }
    if (deviceRegistryFile === undefined || !proposalReview.enabled) {
      fail('signed-socket-requires-review-and-keys', '$.signedRequestSocket requires a device registry and proposal review');
    }
    if ([proposalReview.socketPath, input.publisher?.socketPath].includes(input.signedRequestSocket)) {
      fail('signed-socket-path-conflict', '$.signedRequestSocket must not share another socket path');
    }
  }
  const iroh = Object.hasOwn(input, 'iroh') ? validateIroh(input.iroh) : null;
  if (iroh?.enabled && !proposalReview.enabled) {
    fail('iroh-requires-review', '$.iroh requires proposal review, where paired agents send proposals');
  }
  const normalized = {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    listen,
    proposalReview,
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
    suggestions: validateSuggestions(input.suggestions, { listen, proposalReview, repository }),
    ownerPublication: validateOwnerPublication(input.ownerPublication),
    // Local execution routing, not a change to the approved publication policy.
    ...(Object.hasOwn(input, 'publisher') ? { publisher: validatePublisher(input.publisher) } : {}),
    ...(deviceRegistryFile === undefined ? {} : { deviceRegistryFile }),
    ...(Object.hasOwn(input, 'signedRequestSocket') ? { signedRequestSocket: input.signedRequestSocket } : {}),
    // Local reach routing, not publication policy: it never enters the policy revision.
    ...(iroh === null ? {} : { iroh }),
    ...(Object.hasOwn(input, 'forgeAccess') ? { forgeAccess: validateForgeAccess(input.forgeAccess, provider) } : {}),
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
      // Only present when declared, so the pinned GitHub policy revision is unchanged.
      ...(config.repository.aliases.length > 0 ? { aliases: config.repository.aliases } : {}),
    },
    owner: config.owner,
    live: config.live,
    workflow: config.workflow,
    workspace: config.workspace,
    paths: config.paths,
    limits: config.limits,
    checks: config.checks,
    git: config.git,
    // Only lane authority enters the policy revision. editEntry is presentation only.
    ...(suggestionsEnabled(config) ? { suggestions: { form: config.suggestions.form, forge: config.suggestions.forge } } : {}),
    ...(config.ownerPublication.enabled ? { ownerPublication: config.ownerPublication } : {}),
    // Only present when declared, so existing policy revisions are unchanged.
    ...(config.forgeAccess ? { forgeAccess: { provider: config.forgeAccess.provider,
      ...(config.forgeAccess.clientId ? { clientId: config.forgeAccess.clientId } : {}) } } : {}),
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

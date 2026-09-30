import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { validateProposalQueueConfig } from '@cyberbaser/proposal-queue';

const CONFIG_MAX_BYTES = 64 * 1024;
const DAY_MS = 86_400_000;
const TOP_LEVEL_KEYS = Object.freeze([
  'schemaVersion',
  'enabled',
  'publicOrigin',
  'listen',
  'allowedFormOrigins',
  'repository',
  'bindingsRoot',
  'gitDir',
  'queue',
  'reviewIpc',
  'limits',
]);
const LISTEN_KEYS = Object.freeze(['host', 'port']);
const QUEUE_KEYS = Object.freeze([
  'root',
  'maxPendingEntries',
  'maxRetainedBytes',
  'maxPendingPerSource',
  'pendingRetentionMs',
  'expiredGraceMs',
]);
const REVIEW_IPC_KEYS = Object.freeze([
  'enabled',
  'socketPath',
  'requestTimeoutMs',
  'maxConcurrentRequests',
  'maxListEntries',
]);
// The forge watcher: optional. When present and enabled, the service polls one
// Forgejo repository for open pull requests and feeds them into the same queue
// as Lane A entries, read-only towards the forge.
const FORGEJO_KEYS = Object.freeze([
  'enabled',
  'apiBaseUrl',
  'repository',
  'cloneDir',
  'pollIntervalMs',
  'tokenFile',
]);
const FORGEJO_REPOSITORY_KEYS = Object.freeze(['url', 'owner', 'name', 'baseBranch']);
const FORGEJO_MIN_POLL_MS = 10_000;
const FORGEJO_MAX_POLL_MS = 3_600_000;
const FORGEJO_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;
const LIMIT_KEYS = Object.freeze([
  'maxBodyBytes',
  'requestTimeoutMs',
  'maxConcurrentRequests',
  'tokenBucketCapacity',
  'tokenBucketRefillPerSecond',
]);

export class IntakeConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'IntakeConfigError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new IntakeConfigError(code, message);
}

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactObject(value, keys, label) {
  if (!isRecord(value)) fail('invalid-config', `${label} must be an object`);
  const unknown = Object.keys(value).find((key) => !keys.includes(key));
  if (unknown !== undefined) fail('invalid-config', `${label} contains unknown field ${unknown}`);
  const missing = keys.find((key) => !Object.hasOwn(value, key));
  if (missing !== undefined) fail('invalid-config', `${label} is missing field ${missing}`);
  return value;
}

function exactInteger(value, expected, label) {
  if (value !== expected) fail('invalid-config', `${label} must be ${expected}`);
  return value;
}

function normalizedAbsolutePath(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.normalize(value) !== value) {
    fail('invalid-config', `${label} must be one normalized absolute path`);
  }
  if (value === path.parse(value).root || value.includes('\0')) {
    fail('invalid-config', `${label} must not be a filesystem root or contain NUL`);
  }
  return value;
}

function canonicalHttpsOrigin(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
    fail('invalid-config', `${label} must be a bounded HTTPS origin`);
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail('invalid-config', `${label} must be a canonical HTTPS origin`);
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.pathname !== '/'
    || parsed.search !== ''
    || parsed.hash !== ''
    || parsed.hostname.endsWith('.')
    || parsed.origin !== value
  ) {
    fail('invalid-config', `${label} must be a canonical credential-free HTTPS origin`);
  }
  return parsed.origin;
}

function canonicalRepository(value, label = 'repository') {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
    fail('invalid-config', `${label} must be a bounded canonical HTTPS URL`);
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail('invalid-config', `${label} must be a canonical HTTPS URL`);
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.pathname === '/'
    || parsed.pathname.endsWith('/')
    || parsed.pathname.includes('//')
    || parsed.search !== ''
    || parsed.hash !== ''
    || parsed.hostname.endsWith('.')
    || parsed.toString() !== value
  ) {
    fail('invalid-config', `${label} must be one canonical credential-free HTTPS repository URL`);
  }
  return value;
}

function queueDays(milliseconds, label) {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < DAY_MS || milliseconds % DAY_MS !== 0) {
    fail('invalid-config', `${label} must be a positive whole number of days in milliseconds`);
  }
  return milliseconds / DAY_MS;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

function validateForgejo(input) {
  if (input === undefined || input === null) return null;
  if (isRecord(input) && input.enabled === false) {
    exactObject(input, ['enabled'], 'forgejo');
    return Object.freeze({ enabled: false });
  }
  exactObject(input, FORGEJO_KEYS, 'forgejo');
  if (input.enabled !== true) fail('invalid-config', 'forgejo.enabled must be a boolean');
  exactObject(input.repository, FORGEJO_REPOSITORY_KEYS, 'forgejo.repository');
  const repositoryUrl = canonicalRepository(input.repository.url, 'forgejo.repository.url');
  const api = new URL(canonicalHttpsUrlWithPort(input.apiBaseUrl, 'forgejo.apiBaseUrl'));
  const repository = new URL(repositoryUrl);
  if (api.origin !== repository.origin || api.pathname !== '/api/v1') {
    fail('invalid-config', 'forgejo.apiBaseUrl must be the exact same-origin /api/v1 for forgejo.repository.url');
  }
  for (const key of ['owner', 'name']) {
    const value = input.repository[key];
    if (typeof value !== 'string' || !FORGEJO_ID_RE.test(value) || value.endsWith('.')) {
      fail('invalid-config', `forgejo.repository.${key} must be one Forgejo identifier`);
    }
  }
  if (repository.pathname !== `/${input.repository.owner}/${input.repository.name}.git`) {
    fail('invalid-config', 'forgejo.repository.url must match forgejo.repository.owner and name');
  }
  const baseBranch = input.repository.baseBranch;
  if (typeof baseBranch !== 'string' || baseBranch.length === 0 || baseBranch.length > 255
    || /[\s~^:?*[\\]|\.\.|@\{|^\/|\/$|\/\/|^\.|\.lock$/u.test(baseBranch)) {
    fail('invalid-config', 'forgejo.repository.baseBranch must be one plain branch name');
  }
  if (!Number.isSafeInteger(input.pollIntervalMs) || input.pollIntervalMs < FORGEJO_MIN_POLL_MS || input.pollIntervalMs > FORGEJO_MAX_POLL_MS) {
    fail('invalid-config', `forgejo.pollIntervalMs must be between ${FORGEJO_MIN_POLL_MS} and ${FORGEJO_MAX_POLL_MS}`);
  }
  return Object.freeze({
    enabled: true,
    apiBaseUrl: api.toString(),
    repository: Object.freeze({
      url: repositoryUrl,
      owner: input.repository.owner,
      name: input.repository.name,
      baseBranch,
    }),
    cloneDir: normalizedAbsolutePath(input.cloneDir, 'forgejo.cloneDir'),
    pollIntervalMs: input.pollIntervalMs,
    tokenFile: input.tokenFile === null ? null : normalizedAbsolutePath(input.tokenFile, 'forgejo.tokenFile'),
  });
}

// Like canonicalHttpsOrigin plus a path, and a self-hosted forge may carry one
// explicit port.
function canonicalHttpsUrlWithPort(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
    fail('invalid-config', `${label} must be a bounded HTTPS URL`);
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail('invalid-config', `${label} must be a canonical HTTPS URL`);
  }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== ''
    || parsed.search !== '' || parsed.hash !== '' || parsed.hostname.endsWith('.') || parsed.toString() !== value) {
    fail('invalid-config', `${label} must be one canonical credential-free HTTPS URL`);
  }
  return value;
}

export function validateConfig(input) {
  const keys = isRecord(input) && Object.hasOwn(input, 'forgejo') ? [...TOP_LEVEL_KEYS, 'forgejo'] : TOP_LEVEL_KEYS;
  exactObject(input, keys, 'config');
  if (input.schemaVersion !== 1) fail('invalid-config', 'schemaVersion must be 1');
  if (input.enabled !== true) fail('intake-disabled', 'enabled must be literal true');
  const forgejo = validateForgejo(input.forgejo);

  // The public form endpoint is off when listen is null. The service then runs
  // for the review socket and the forge watcher only; at least one input must be on.
  const formEnabled = input.listen !== null;
  if (!formEnabled && !(forgejo?.enabled === true)) {
    fail('invalid-config', 'listen may be null only when the forgejo watcher is enabled');
  }
  let publicOrigin = null;
  let listen = null;
  let allowedFormOrigins = [];
  if (formEnabled) {
    publicOrigin = canonicalHttpsOrigin(input.publicOrigin, 'publicOrigin');
    exactObject(input.listen, LISTEN_KEYS, 'listen');
    if (input.listen.host !== '0.0.0.0') fail('invalid-config', 'listen.host must be 0.0.0.0');
    if (!Number.isSafeInteger(input.listen.port) || input.listen.port < 1 || input.listen.port > 65535) {
      fail('invalid-config', 'listen.port must be an integer from 1 through 65535');
    }
    listen = { host: '0.0.0.0', port: input.listen.port };
    if (!Array.isArray(input.allowedFormOrigins) || input.allowedFormOrigins.length === 0) {
      fail('invalid-config', 'allowedFormOrigins must contain at least one origin');
    }
    allowedFormOrigins = input.allowedFormOrigins.map((origin, index) => (
      canonicalHttpsOrigin(origin, `allowedFormOrigins[${index}]`)
    ));
    if (new Set(allowedFormOrigins).size !== allowedFormOrigins.length) {
      fail('invalid-config', 'allowedFormOrigins must not contain duplicates');
    }
  } else {
    if (input.publicOrigin !== null) fail('invalid-config', 'publicOrigin must be null when listen is null');
    if (!Array.isArray(input.allowedFormOrigins) || input.allowedFormOrigins.length !== 0) {
      fail('invalid-config', 'allowedFormOrigins must be empty when listen is null');
    }
  }

  exactObject(input.queue, QUEUE_KEYS, 'queue');
  const queueRoot = normalizedAbsolutePath(input.queue.root, 'queue.root');
  const queueConfig = validateProposalQueueConfig({
    root: queueRoot,
    maxPendingEntries: input.queue.maxPendingEntries,
    maxRetainedBytes: input.queue.maxRetainedBytes,
    maxPendingPerSource: input.queue.maxPendingPerSource,
    pendingRetentionDays: queueDays(input.queue.pendingRetentionMs, 'queue.pendingRetentionMs'),
    expiredGraceDays: queueDays(input.queue.expiredGraceMs, 'queue.expiredGraceMs'),
  });

  exactObject(input.reviewIpc, REVIEW_IPC_KEYS, 'reviewIpc');
  if (typeof input.reviewIpc.enabled !== 'boolean') fail('invalid-config', 'reviewIpc.enabled must be a boolean');
  let reviewSocketPath = null;
  if (input.reviewIpc.enabled) {
    reviewSocketPath = normalizedAbsolutePath(input.reviewIpc.socketPath, 'reviewIpc.socketPath');
    if (path.dirname(reviewSocketPath) === path.parse(reviewSocketPath).root) {
      fail('invalid-config', 'reviewIpc.socketPath parent must not be a filesystem root');
    }
  } else if (input.reviewIpc.socketPath !== null) {
    fail('invalid-config', 'reviewIpc.socketPath must be null when reviewIpc is disabled');
  }
  const reviewIpc = Object.freeze({
    enabled: input.reviewIpc.enabled,
    socketPath: reviewSocketPath,
    requestTimeoutMs: exactInteger(input.reviewIpc.requestTimeoutMs, 5_000, 'reviewIpc.requestTimeoutMs'),
    maxConcurrentRequests: exactInteger(input.reviewIpc.maxConcurrentRequests, 4, 'reviewIpc.maxConcurrentRequests'),
    maxListEntries: exactInteger(input.reviewIpc.maxListEntries, 100, 'reviewIpc.maxListEntries'),
  });

  exactObject(input.limits, LIMIT_KEYS, 'limits');
  const limits = Object.freeze({
    maxBodyBytes: exactInteger(input.limits.maxBodyBytes, 98_304, 'limits.maxBodyBytes'),
    requestTimeoutMs: exactInteger(input.limits.requestTimeoutMs, 5_000, 'limits.requestTimeoutMs'),
    maxConcurrentRequests: exactInteger(input.limits.maxConcurrentRequests, 4, 'limits.maxConcurrentRequests'),
    tokenBucketCapacity: exactInteger(input.limits.tokenBucketCapacity, 20, 'limits.tokenBucketCapacity'),
    tokenBucketRefillPerSecond: exactInteger(input.limits.tokenBucketRefillPerSecond, 1, 'limits.tokenBucketRefillPerSecond'),
  });

  return deepFreeze({
    schemaVersion: 1,
    enabled: true,
    publicOrigin,
    publicHost: publicOrigin === null ? null : new URL(publicOrigin).host,
    listen,
    allowedFormOrigins,
    forgejo,
    repository: canonicalRepository(input.repository),
    bindingsRoot: normalizedAbsolutePath(input.bindingsRoot, 'bindingsRoot'),
    gitDir: normalizedAbsolutePath(input.gitDir, 'gitDir'),
    queue: {
      root: queueRoot,
      maxPendingEntries: queueConfig.maxPendingEntries,
      maxRetainedBytes: queueConfig.maxRetainedBytes,
      maxPendingPerSource: queueConfig.maxPendingPerSource,
      pendingRetentionDays: queueConfig.pendingRetentionDays,
      expiredGraceDays: queueConfig.expiredGraceDays,
    },
    reviewIpc,
    limits,
  });
}

async function assertPathComponents(pathname, { mustExist, directory }, label) {
  const absolute = normalizedAbsolutePath(pathname, label);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  let finalMetadata = null;
  for (const segment of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink()) fail('unsafe-config-path', `${label} must not contain symlink components`);
      finalMetadata = metadata;
    } catch (error) {
      if (error instanceof IntakeConfigError) throw error;
      if (error?.code === 'ENOENT') {
        if (mustExist) fail('config-path-unavailable', `${label} does not exist`);
        finalMetadata = null;
        break;
      }
      throw error;
    }
  }
  if (mustExist) {
    if (directory && !finalMetadata?.isDirectory()) fail('unsafe-config-path', `${label} must be a real directory`);
    if (await realpath(absolute) !== absolute) fail('unsafe-config-path', `${label} must not resolve through symlinks`);
  }
}

export async function validateRuntimePaths(config) {
  await assertPathComponents(config.bindingsRoot, { mustExist: true, directory: true }, 'bindingsRoot');
  await assertPathComponents(config.gitDir, { mustExist: true, directory: true }, 'gitDir');
  await assertPathComponents(config.queue.root, { mustExist: false, directory: true }, 'queue.root');
  if (config.forgejo?.enabled) {
    await assertPathComponents(config.forgejo.cloneDir, { mustExist: false, directory: true }, 'forgejo.cloneDir');
    if (config.forgejo.tokenFile !== null) {
      await assertPathComponents(path.dirname(config.forgejo.tokenFile), { mustExist: true, directory: true }, 'forgejo.tokenFile parent');
    }
  }
  if (config.reviewIpc.enabled) {
    await assertPathComponents(path.dirname(config.reviewIpc.socketPath), { mustExist: true, directory: true }, 'reviewIpc.socketPath parent');
  }
  return config;
}

export async function loadConfig(configPath) {
  if (
    typeof configPath !== 'string'
    || !path.isAbsolute(configPath)
    || path.normalize(configPath) !== configPath
  ) {
    fail('invalid-config-path', 'config path must be one normalized absolute path');
  }
  const absolute = configPath;
  let handle;
  try {
    if (await realpath(absolute) !== absolute) {
      fail('unsafe-config-file', 'config path must not contain symbolic-link components');
    }
    handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size < 2 || metadata.size > CONFIG_MAX_BYTES) {
      fail('unsafe-config-file', 'config must be one bounded regular singly linked file');
    }
    const bytes = await handle.readFile();
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    if (text.startsWith('﻿')) fail('invalid-config', 'config must not begin with a UTF-8 BOM');
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      fail('invalid-config', 'config must contain strict JSON');
    }
    return validateConfig(parsed);
  } catch (error) {
    if (error instanceof IntakeConfigError) throw error;
    if (error?.code === 'ELOOP') fail('unsafe-config-file', 'config must not be a symlink');
    throw error;
  } finally {
    await handle?.close();
  }
}

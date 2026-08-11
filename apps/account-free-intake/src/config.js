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

function canonicalRepository(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
    fail('invalid-config', 'repository must be a bounded canonical HTTPS URL');
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail('invalid-config', 'repository must be a canonical HTTPS URL');
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
    fail('invalid-config', 'repository must be one canonical credential-free HTTPS repository URL');
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

export function validateConfig(input) {
  exactObject(input, TOP_LEVEL_KEYS, 'config');
  if (input.schemaVersion !== 1) fail('invalid-config', 'schemaVersion must be 1');
  if (input.enabled !== true) fail('intake-disabled', 'enabled must be literal true');

  const publicOrigin = canonicalHttpsOrigin(input.publicOrigin, 'publicOrigin');
  exactObject(input.listen, LISTEN_KEYS, 'listen');
  if (input.listen.host !== '0.0.0.0') fail('invalid-config', 'listen.host must be 0.0.0.0');
  if (!Number.isSafeInteger(input.listen.port) || input.listen.port < 1 || input.listen.port > 65535) {
    fail('invalid-config', 'listen.port must be an integer from 1 through 65535');
  }

  if (!Array.isArray(input.allowedFormOrigins) || input.allowedFormOrigins.length === 0) {
    fail('invalid-config', 'allowedFormOrigins must contain at least one origin');
  }
  const allowedFormOrigins = input.allowedFormOrigins.map((origin, index) => (
    canonicalHttpsOrigin(origin, `allowedFormOrigins[${index}]`)
  ));
  if (new Set(allowedFormOrigins).size !== allowedFormOrigins.length) {
    fail('invalid-config', 'allowedFormOrigins must not contain duplicates');
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

  exactObject(input.limits, LIMIT_KEYS, 'limits');
  const limits = Object.freeze({
    maxBodyBytes: exactInteger(input.limits.maxBodyBytes, 98_304, 'limits.maxBodyBytes'),
    requestTimeoutMs: exactInteger(input.limits.requestTimeoutMs, 5_000, 'limits.requestTimeoutMs'),
    maxConcurrentRequests: exactInteger(input.limits.maxConcurrentRequests, 4, 'limits.maxConcurrentRequests'),
    tokenBucketCapacity: exactInteger(input.limits.tokenBucketCapacity, 20, 'limits.tokenBucketCapacity'),
    tokenBucketRefillPerSecond: exactInteger(input.limits.tokenBucketRefillPerSecond, 1, 'limits.tokenBucketRefillPerSecond'),
  });

  const parsedPublicOrigin = new URL(publicOrigin);
  return deepFreeze({
    schemaVersion: 1,
    enabled: true,
    publicOrigin,
    publicHost: parsedPublicOrigin.host,
    listen: { host: '0.0.0.0', port: input.listen.port },
    allowedFormOrigins,
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

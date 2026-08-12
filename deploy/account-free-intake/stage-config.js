#!/usr/bin/env bun

import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from '../../apps/account-free-intake/src/config.js';

export const SOURCE_CONFIG = '/config/account-free-intake.json';
export const ACTIVE_CONFIG = '/run/account-free-intake/account-free-intake.json';
export const CONTAINER_PATHS = Object.freeze({
  bindingsRoot: '/srv/cyberbaser/source-bindings',
  gitDir: '/srv/cyberbaser/source-objects.git',
  queueRoot: '/var/lib/cyberbaser/proposal-queue',
});
const MAX_CONFIG_BYTES = 64 * 1024;

function fail(message) {
  throw new Error(message);
}

function exactAbsoluteFile(value, label) {
  if (
    typeof value !== 'string'
    || !path.isAbsolute(value)
    || path.normalize(value) !== value
    || value === path.parse(value).root
  ) fail(`${label} must be one normalized absolute file path`);
  return value;
}

async function exactPrivateDirectory(directory) {
  const metadata = await lstat(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    fail('active config parent must be one real directory');
  }
  if (await realpath(directory) !== directory) fail('active config parent must not use symlink aliases');
  if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) {
    fail('active config parent must be owned by the runtime identity');
  }
  if (typeof process.getgid === 'function' && metadata.gid !== process.getgid()) {
    fail('active config parent must use the runtime primary group');
  }
  if ((metadata.mode & 0o777) !== 0o700) fail('active config parent must have mode 0700');
}

async function readSource(source) {
  let handle;
  try {
    handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n) fail('source config must be one regular file with one link');
    if ((before.mode & 0o222n) !== 0n) fail('source config must have no write permission bits');
    if (before.size < 2n || before.size > BigInt(MAX_CONFIG_BYTES)) {
      fail(`source config must contain 2 through ${MAX_CONFIG_BYTES} bytes`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      BigInt(bytes.length) !== before.size
      || after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || after.mtimeNs !== before.mtimeNs
      || after.ctimeNs !== before.ctimeNs
    ) fail('source config changed while it was read');
    return bytes;
  } catch (error) {
    if (error?.code === 'ELOOP') fail('source config must not be a symlink');
    throw error;
  } finally {
    await handle?.close();
  }
}

async function verifyActive(file, expectedSize) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size !== expectedSize) {
      fail('active config must be one unchanged regular file with one link');
    }
    if ((metadata.mode & 0o777) !== 0o600) fail('active config must have mode 0600');
    if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) {
      fail('active config must be owned by the runtime identity');
    }
    if (typeof process.getgid === 'function' && metadata.gid !== process.getgid()) {
      fail('active config must use the runtime primary group');
    }
  } finally {
    await handle?.close();
  }
}

export async function stageIntakeConfig({
  source = SOURCE_CONFIG,
  destination = ACTIVE_CONFIG,
  requireContainerContract = false,
} = {}) {
  const sourceFile = exactAbsoluteFile(source, 'source config');
  const activeFile = exactAbsoluteFile(destination, 'active config');
  const parent = path.dirname(activeFile);
  await exactPrivateDirectory(parent);

  try {
    await lstat(activeFile);
    fail('active config destination must be absent before staging');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const bytes = await readSource(sourceFile);
  const temporary = path.join(parent, `.${path.basename(activeFile)}.tmp-${process.pid}-${randomUUID()}`);
  let handle;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.chmod(0o600);
    await handle.close();
    handle = null;
    await rename(temporary, activeFile);
  } finally {
    await handle?.close();
    await rm(temporary, { force: true });
  }

  try {
    await verifyActive(activeFile, bytes.length);
    const config = await loadConfig(activeFile);
    if (requireContainerContract && (
      config.bindingsRoot !== CONTAINER_PATHS.bindingsRoot
      || config.gitDir !== CONTAINER_PATHS.gitDir
      || config.queue.root !== CONTAINER_PATHS.queueRoot
    )) fail('container config paths do not match the fixed mount contract');
    return config;
  } catch (error) {
    await rm(activeFile, { force: true });
    throw error;
  }
}

if (import.meta.main) {
  try {
    await stageIntakeConfig({ requireContainerContract: true });
  } catch {
    process.stderr.write('account-free intake config staging failed\n');
    process.exit(1);
  }
}

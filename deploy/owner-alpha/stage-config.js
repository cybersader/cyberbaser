#!/usr/bin/env bun

import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadOwnerAlphaConfig, MAX_CONFIG_BYTES } from '../../apps/owner-alpha/src/config.js';

export const SOURCE_CONFIG = '/config/owner-alpha.local.json';
export const ACTIVE_CONFIG = '/run/owner-alpha/owner-alpha.local.json';

function fail(message) {
  throw new Error(message);
}

function exactAbsoluteFile(value, label) {
  if (typeof value !== 'string'
    || !path.isAbsolute(value)
    || path.normalize(value) !== value
    || value === path.parse(value).root) {
    fail(`${label} must be one normalized absolute file path`);
  }
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

function hostIsAssigned(host, interfaces = os.networkInterfaces()) {
  return Object.values(interfaces).flatMap((entries) => entries ?? []).some((entry) => (
    entry?.address === host && (entry.family === 'IPv4' || entry.family === 4)
  ));
}

async function readSource(source) {
  let handle;
  try {
    handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n) fail('source config must be one regular file with one link');
    if (before.size < 2n || before.size > BigInt(MAX_CONFIG_BYTES)) {
      fail(`source config must contain 2 through ${MAX_CONFIG_BYTES} bytes`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (BigInt(bytes.length) !== before.size
      || after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || after.mtimeNs !== before.mtimeNs
      || after.ctimeNs !== before.ctimeNs) {
      fail('source config changed while it was read');
    }
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

export async function stageOwnerAlphaConfig({
  source = SOURCE_CONFIG,
  destination = ACTIVE_CONFIG,
  interfaces,
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
    const config = await loadOwnerAlphaConfig(activeFile);
    if (requireContainerContract && config.repository.checkout !== '/vault') {
      fail('container config repository.checkout must be exactly /vault');
    }
    if (!hostIsAssigned(config.listen.host, interfaces)) {
      fail('configured private IPv4 address is not assigned in this Linux network namespace');
    }
    return config;
  } catch (error) {
    await rm(activeFile, { force: true });
    throw error;
  }
}

if (import.meta.main) {
  try {
    await stageOwnerAlphaConfig({ requireContainerContract: true });
  } catch {
    process.stderr.write('owner-alpha config staging failed\n');
    process.exit(1);
  }
}

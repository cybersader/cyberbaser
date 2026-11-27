import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fail } from '../errors.js';
import { createDeviceKeyRegistry } from './device-keys.js';

export async function readPrivateKeyJson(file, maxBytes) {
  const absolute = path.resolve(file);
  if (await realpath(path.dirname(absolute)) !== path.dirname(absolute)) throw new Error('key file parent is not canonical');
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid()
      || (info.mode & 0o7177) !== 0 || info.size < 1 || info.size > maxBytes) throw new Error('unsafe key file');
    const bytes = Buffer.alloc(maxBytes + 1);
    let size = 0;
    while (size <= maxBytes) {
      const { bytesRead } = await handle.read(bytes, size, bytes.length - size, size);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    if (size > maxBytes) throw new Error('oversize key file');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)));
  } finally {
    await handle.close();
  }
}

export async function readEnrollment(file) {
  const input = await readPrivateKeyJson(file, 512 * 1024);
  return { input, registry: createDeviceKeyRegistry(input) };
}

export async function assertOutsideVault(config, file) {
  const checkout = await realpath(config.repository.checkout);
  const real = await realpath(file).catch(() => file);
  for (const root of [config.repository.checkout, checkout]) {
    for (const candidate of [file, real]) {
      if (candidate === root || candidate.startsWith(`${root}${path.sep}`) || root.startsWith(`${candidate}${path.sep}`)) {
        throw new Error('private state is in the vault');
      }
    }
  }
}

export async function loadDeviceKeyRegistry(config, { withInput = false } = {}) {
  const file = config.deviceRegistryFile;
  if (file === undefined) return withInput ? { registry: null, input: null } : null;
  try {
    await assertOutsideVault(config, file);
    const { registry, input } = await readEnrollment(file);
    if (registry.ownerId !== config.owner.identity) throw new Error('registry owner mismatch');
    return withInput ? { registry, input } : registry;
  } catch {
    fail('device-registry-invalid', 'Device registry must be valid, owner-owned, private JSON in a regular file outside the vault, and name the configured owner.');
  }
}

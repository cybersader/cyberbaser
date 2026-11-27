// Linux descriptor-relative operations. /proc/self/fd/<fd>/<name> is the
// openat equivalent for Node/Bun's path-only API. Every <name> is a single
// component and the directory handle stays open for the entire lookup.
import { constants } from 'node:fs';
import { mkdir, open, opendir } from 'node:fs/promises';
import path from 'node:path';
import { fail, OwnerAlphaError } from './errors.js';

const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const O_PATH = 0o10000000; // Linux UAPI, not exposed in node:fs.constants.
export const MAX_SITE_FILE_BYTES = 64 * 1024 * 1024;
const SITE_LIMITS = Object.freeze({ fileBytes: MAX_SITE_FILE_BYTES, bytes: 1024 ** 3, entries: 50_000, depth: 64 });

function invalidEntry() {
  return Object.assign(new Error('not a regular, singly linked site file'), { code: 'EINVAL' });
}

function fdPath(handle, name) {
  if (name !== undefined && (!name || name === '.' || name === '..' || /[/\0�]/u.test(name))) throw invalidEntry();
  return `/proc/self/fd/${handle.fd}${name === undefined ? '' : `/${name}`}`;
}

async function openDirectory(absolute, segments = []) {
  if (process.platform !== 'linux' || !path.isAbsolute(absolute) || path.normalize(absolute) !== absolute) throw invalidEntry();
  let handle = await open('/', DIRECTORY_FLAGS);
  try {
    for (const name of [...absolute.split('/').filter(Boolean), ...segments]) {
      const next = await open(fdPath(handle, name), DIRECTORY_FLAGS);
      await handle.close();
      handle = next;
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function openRegular(directory, name) {
  // Check the exact inode without opening a device or blocking on a FIFO.
  // A symlink opened with O_PATH|O_NOFOLLOW is itself, not its target.
  const entry = await open(fdPath(directory, name), O_PATH | constants.O_NOFOLLOW);
  try {
    const initial = await entry.stat();
    if (!initial.isFile() || initial.nlink !== 1) throw invalidEntry();
    const file = await open(fdPath(entry), constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (stat.dev !== initial.dev || stat.ino !== initial.ino || stat.nlink !== 1) throw invalidEntry();
      return { file, stat };
    } catch (error) {
      await file.close();
      throw error;
    }
  } finally {
    await entry.close();
  }
}

async function exactBytes(file, destination, buffer, size) {
  for (let offset = 0; offset < size;) {
    const { bytesRead } = await file.read(buffer, 0, Math.min(size - offset, buffer.length), offset);
    if (bytesRead === 0) throw invalidEntry();
    await destination(buffer, bytesRead, offset);
    offset += bytesRead;
  }
}

async function assertUnchanged(file, before) {
  const after = await file.stat();
  if (after.nlink !== 1 || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
    throw invalidEntry();
  }
}

export async function readSiteFile(root, segments, maxBytes = MAX_SITE_FILE_BYTES) {
  const directory = await openDirectory(root, segments.slice(0, -1));
  try {
    const { file, stat } = await openRegular(directory, segments.at(-1));
    try {
      if (stat.size > maxBytes) throw Object.assign(new Error('site file too large'), { code: 'EFBIG' });
      const bytes = Buffer.allocUnsafe(stat.size);
      for (let offset = 0; offset < bytes.length;) {
        const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) throw invalidEntry();
        offset += bytesRead;
      }
      await assertUnchanged(file, stat);
      return bytes;
    } finally { await file.close(); }
  } finally { await directory.close(); }
}

// Destination is a new sibling of the live site, outside every directory
// granted to the renderer. The caller owns cleanup of any partial destination.
export async function copySiteOutput(staging, candidate, limits = SITE_LIMITS) {
  const buffer = Buffer.allocUnsafe(128 * 1024);
  let entries = 0;
  let bytes = 0;
  async function visit(source, target, depth) {
    if (depth > limits.depth) fail('site-output-limit', 'renderer output exceeds the directory depth limit');
    const reader = await opendir(fdPath(source));
    for await (const entry of reader) {
      if (++entries > limits.entries) fail('site-output-limit', 'renderer output exceeds the entry limit');
      const child = fdPath(source, entry.name);
      const destination = path.join(target, entry.name);
      if (entry.isDirectory()) {
        const directory = await open(child, DIRECTORY_FLAGS);
        try {
          await mkdir(destination, { mode: 0o700 });
          await visit(directory, destination, depth + 1);
        } finally { await directory.close(); }
      } else {
        if (!entry.isFile()) throw invalidEntry();
        const { file, stat } = await openRegular(source, entry.name);
        try {
          if (stat.size > limits.fileBytes || stat.size > limits.bytes - bytes) {
            fail('site-output-limit', 'renderer output exceeds the byte limit');
          }
          bytes += stat.size;
          const copy = await open(destination, 'wx', 0o600);
          try {
            await exactBytes(file, async (chunk, length, position) => {
              for (let offset = 0; offset < length;) {
                const { bytesWritten } = await copy.write(chunk, offset, length - offset, position + offset);
                if (!bytesWritten) throw invalidEntry();
                offset += bytesWritten;
              }
            }, buffer, stat.size);
            await assertUnchanged(file, stat);
          } finally { await copy.close(); }
        } finally { await file.close(); }
      }
    }
  }

  try {
    const source = await openDirectory(staging);
    try {
      await mkdir(candidate, { mode: 0o700 });
      await visit(source, candidate, 0);
    } finally { await source.close(); }
  } catch (error) {
    if (error instanceof OwnerAlphaError) throw error;
    fail('site-output-copy-failed', 'renderer output could not be copied as regular files', { cause: error?.code ?? 'unknown' });
  }
}

// Copy inside the Landlock build domain without touching file metadata. The
// renderer cannot chmod, set attributes or restore timestamps, even inside
// its work tree. Set the initial mode when creating each new inode instead.
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, readdir, readFile, readlink, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

const [source, destination, mode] = process.argv.slice(2);
if (!path.isAbsolute(source ?? '') || !path.isAbsolute(destination ?? '') || !['mirror', 'merge'].includes(mode)) {
  throw new Error('copy-render-tree requires absolute source and destination plus mirror or merge');
}

async function copy(from, to) {
  const src = await lstat(from);
  const dst = await lstat(to).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
  if (src.isDirectory()) {
    if (!dst?.isDirectory()) {
      if (dst) await rm(to, { recursive: true });
      await mkdir(to, { mode: 0o750 });
    }
    const names = new Set(await readdir(from));
    if (mode === 'mirror') for (const name of await readdir(to)) {
      if (!names.has(name)) await rm(path.join(to, name), { recursive: true });
    }
    for (const name of names) await copy(path.join(from, name), path.join(to, name));
    return;
  }
  if (src.isSymbolicLink()) {
    const target = await readlink(from);
    if (dst?.isSymbolicLink() && await readlink(to) === target) return;
    if (dst) await rm(to, { recursive: true });
    await symlink(target, to);
    return;
  }
  if (!src.isFile()) throw new Error('unsupported entry in render input');
  // Keep small unchanged content files incremental without trusting timestamps.
  // Larger copies stream with bounded memory. Never truncate an existing inode.
  const executable = src.mode & 0o110;
  if (dst?.isFile() && dst.nlink === 1 && dst.size === src.size && src.size <= 1024 * 1024
    && (dst.mode & 0o110) === executable && (await readFile(from)).equals(await readFile(to))) return;
  if (dst) await rm(to, { recursive: true });
  await pipeline(createReadStream(from), createWriteStream(to, { flags: 'wx', mode: 0o640 | executable }));
}

await copy(source, destination);

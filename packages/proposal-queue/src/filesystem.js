import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fail, ProposalQueueError } from './errors.js';

export const ENTRY_FILES = Object.freeze([
  'proposal.json',
  'receipt.json',
  'carrier.json',
  'classification.json',
  'state.json',
]);

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;

const exactMode = (metadata, mode) => (metadata.mode & 0o777) === mode;

async function assertDirectory(directory, label) {
  let metadata;
  try { metadata = await lstat(directory); } catch (error) {
    if (error?.code === 'ENOENT') fail('queue-path-missing', `${label} does not exist`);
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory() || !exactMode(metadata, DIRECTORY_MODE)) {
    fail('unsafe-queue-directory', `${label} must be one real 0700 directory`);
  }
  return directory;
}

export async function assertNoSymlinkComponents(target) {
  const resolved = path.resolve(target);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const segment of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink()) {
        fail('queue-symlink-rejected', 'queue paths must not contain symbolic links', { path: current });
      }
    } catch (error) {
      if (error?.code === 'ENOENT') break;
      if (error instanceof ProposalQueueError) throw error;
      throw error;
    }
  }
  return resolved;
}

async function ensureDirectory(directory) {
  await assertNoSymlinkComponents(directory);
  let created = false;
  try {
    await mkdir(directory, { mode: DIRECTORY_MODE });
    created = true;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  if (created) await chmod(directory, DIRECTORY_MODE);
  await assertNoSymlinkComponents(directory);
  await assertDirectory(directory, directory);
  return directory;
}

async function syncDirectory(directory, hooks) {
  await hooks.beforeDirectorySync?.(directory);
  let handle;
  try {
    handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

async function writeExclusive(file, bytes, hooks) {
  await hooks.beforeWrite?.(file, bytes);
  let handle;
  try {
    handle = await open(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, FILE_MODE);
    await handle.writeFile(bytes);
    await hooks.beforeFileSync?.(file);
    await handle.sync();
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.nlink !== 1 || !exactMode(metadata, FILE_MODE)) {
      fail('unsafe-queue-artifact', `${path.basename(file)} must be one regular 0600 file with one link`);
    }
  } catch (error) {
    await rm(file, { force: true });
    throw error;
  } finally {
    await handle?.close();
  }
}

async function readRegular(file, { maxBytes = MAX_ARTIFACT_BYTES } = {}) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.nlink !== 1 || !exactMode(metadata, FILE_MODE)) {
      fail('unsafe-queue-artifact', `${path.basename(file)} must be one regular 0600 file with one link`);
    }
    if (metadata.size < 1 || metadata.size > maxBytes) {
      fail('queue-artifact-size', `${path.basename(file)} is empty or exceeds its read limit`);
    }
    return await handle.readFile();
  } catch (error) {
    if (error instanceof ProposalQueueError) throw error;
    if (error?.code === 'ENOENT') fail('queue-artifact-missing', `${path.basename(file)} is missing`);
    if (error?.code === 'ELOOP') fail('unsafe-queue-artifact', `${path.basename(file)} must not be a symlink`);
    throw error;
  } finally {
    await handle?.close();
  }
}

async function listDirectory(directory) {
  await assertDirectory(directory, directory);
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (entry.isSymbolicLink()) fail('queue-symlink-rejected', 'queue directories must not contain symbolic links', { entry: entry.name });
  }
  return entries;
}

async function validateLockFile(lockFile, { create }) {
  let handle;
  try {
    handle = await open(
      lockFile,
      (create ? constants.O_CREAT | constants.O_RDWR : constants.O_RDONLY)
        | constants.O_NOFOLLOW,
      FILE_MODE,
    );
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.nlink !== 1 || !exactMode(metadata, FILE_MODE)) {
      fail('unsafe-lock-file', 'queue lock must be one regular 0600 file with one link');
    }
  } catch (error) {
    if (error instanceof ProposalQueueError) throw error;
    if (error?.code === 'ENOENT') fail('queue-not-initialized', 'proposal queue lock does not exist');
    if (error?.code === 'ELOOP') fail('unsafe-lock-file', 'queue lock must not be a symlink');
    fail('lock-unavailable', 'queue lock file could not be prepared', { cause: error?.code ?? 'unknown' });
  } finally {
    await handle?.close();
  }
}

async function acquireLock(lockFile, { shared = false, create = true } = {}) {
  await validateLockFile(lockFile, { create });
  const token = `proposal-queue-lock-ready-${process.pid}-${randomUUID()}\n`;
  const conflictExitCode = 75;
  const child = spawn('flock', [shared ? '--shared' : '--exclusive', '--nonblock', '--conflict-exit-code', String(conflictExitCode), lockFile, 'cat'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  child.stdin.on('error', () => {});
  await new Promise((resolve, reject) => {
    let settled = false;
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    child.once('error', (error) => rejectOnce(new ProposalQueueError('flock-unavailable', 'the util-linux flock child could not start', { cause: error?.code ?? 'spawn-failed' })));
    child.once('exit', (code, signal) => {
      if (settled) return;
      if (code === conflictExitCode) return rejectOnce(new ProposalQueueError('lock-busy', 'another process has the proposal queue open'));
      rejectOnce(new ProposalQueueError('flock-unavailable', 'the flock child exited before confirming queue ownership', { exitCode: code, signal, stderr: stderr.trim().slice(0, 1000) }));
    });
    child.stdout.on('data', (chunk) => {
      if (settled) return;
      stdout += chunk.toString();
      if (stdout.includes(token)) { settled = true; resolve(); }
    });
    child.stdin.write(token);
  });
  let released = false;
  return Object.freeze({
    async release() {
      if (released) return;
      released = true;
      if (child.exitCode !== null) return;
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.stdin.end();
      await exited;
    },
  });
}

async function inspectExistingQueue(root) {
  await assertNoSymlinkComponents(root);
  await assertDirectory(root, root);
  if (await realpath(root) !== root) fail('queue-symlink-rejected', 'queue root must not resolve through symbolic links');
  for (const child of ['staging', 'pending', 'expired']) await assertDirectory(path.join(root, child), child);
  const rootEntries = await readdir(root, { withFileTypes: true });
  const allowed = new Set(['.queue.lock', 'staging', 'pending', 'expired']);
  for (const entry of rootEntries) {
    if (!allowed.has(entry.name)) fail('unexpected-queue-root-entry', `queue root contains unexpected entry ${entry.name}`);
    if (entry.isSymbolicLink()) fail('queue-symlink-rejected', 'queue root entries must not be symbolic links');
  }
  await validateLockFile(path.join(root, '.queue.lock'), { create: false });
}

export function createQueueFilesystem(hooks = {}) {
  const seam = {
    beforeWrite: hooks.beforeWrite,
    beforeFileSync: hooks.beforeFileSync,
    beforeRename: hooks.beforeRename,
    beforeDirectorySync: hooks.beforeDirectorySync,
  };
  return Object.freeze({
    async prepare(root) {
      process.umask(process.umask() | 0o077);
      await ensureDirectory(root);
      if (await realpath(root) !== root) fail('queue-symlink-rejected', 'queue root must not resolve through symbolic links');
      for (const child of ['staging', 'pending', 'expired']) await ensureDirectory(path.join(root, child));
      const rootEntries = await readdir(root, { withFileTypes: true });
      const allowed = new Set(['.queue.lock', 'staging', 'pending', 'expired']);
      for (const entry of rootEntries) {
        if (!allowed.has(entry.name)) fail('unexpected-queue-root-entry', `queue root contains unexpected entry ${entry.name}`);
        if (entry.isSymbolicLink()) fail('queue-symlink-rejected', 'queue root entries must not be symbolic links');
      }
    },
    acquireLock: (root) => acquireLock(path.join(root, '.queue.lock')),
    async inspect(root) {
      await inspectExistingQueue(root);
    },
    acquireSharedLock: (root) => acquireLock(
      path.join(root, '.queue.lock'),
      { shared: true, create: false },
    ),
    async list(directory) {
      const entries = await listDirectory(directory);
      return entries.map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory(), isFile: entry.isFile() }));
    },
    async readEntry(directory) {
      const entries = await listDirectory(directory);
      const names = entries.map((entry) => entry.name);
      const wanted = [...ENTRY_FILES].sort();
      if (names.length !== wanted.length || names.some((name, index) => name !== wanted[index])) {
        fail('unexpected-queue-artifact', `${directory} must contain exactly the queue artifact set`, { entries: names });
      }
      if (entries.some((entry) => !entry.isFile())) fail('unsafe-queue-artifact', 'queue entry artifacts must be regular files');
      const artifacts = {};
      for (const name of ENTRY_FILES) artifacts[name] = await readRegular(path.join(directory, name));
      return artifacts;
    },
    readFile: (file, options) => readRegular(file, options),
    async createStage(root, queueId, artifacts, suffix = randomUUID()) {
      const stage = path.join(root, 'staging', `.stage-${queueId}-${suffix}`);
      try { await mkdir(stage, { mode: DIRECTORY_MODE }); } catch (error) {
        if (error?.code === 'EEXIST') fail('queue-id-collision', 'queue staging identity already exists');
        throw error;
      }
      await chmod(stage, DIRECTORY_MODE);
      try {
        for (const name of ENTRY_FILES) {
          if (!Object.hasOwn(artifacts, name)) fail('missing-queue-artifact', `stage is missing ${name}`);
          await writeExclusive(path.join(stage, name), Buffer.from(artifacts[name]), seam);
        }
        await syncDirectory(stage, seam);
        return stage;
      } catch (error) {
        await rm(stage, { recursive: true, force: true });
        throw error;
      }
    },
    async commitStage(stage, destination) {
      await seam.beforeRename?.(stage, destination);
      await rename(stage, destination);
      await syncDirectory(path.dirname(destination), seam);
    },
    async replaceState(directory, bytes, suffix = randomUUID()) {
      const state = path.join(directory, 'state.json');
      const temporary = path.join(directory, `.state.tmp-${suffix}`);
      await writeExclusive(temporary, Buffer.from(bytes), seam);
      try {
        await seam.beforeRename?.(temporary, state);
        await rename(temporary, state);
        await syncDirectory(directory, seam);
      } finally {
        await rm(temporary, { force: true });
      }
    },
    async moveEntry(source, destination) {
      await seam.beforeRename?.(source, destination);
      await rename(source, destination);
      await syncDirectory(path.dirname(source), seam);
      if (path.dirname(destination) !== path.dirname(source)) await syncDirectory(path.dirname(destination), seam);
    },
    async removeTree(directory) {
      await rm(directory, { recursive: true, force: true });
      await syncDirectory(path.dirname(directory), seam);
    },
    async removeStaging(root) {
      const staging = path.join(root, 'staging');
      const entries = await listDirectory(staging);
      let discarded = 0;
      let purged = 0;
      for (const entry of entries) {
        if (!entry.isDirectory()) fail('unsafe-staging-entry', `staging contains non-directory entry ${entry.name}`);
        if (entry.name.startsWith('.stage-Q-')) discarded += 1;
        else if (entry.name.startsWith('.purge-Q-')) purged += 1;
        else fail('unsafe-staging-entry', `staging contains unrecognized entry ${entry.name}`);
        await rm(path.join(staging, entry.name), { recursive: true, force: true });
      }
      if (entries.length > 0) await syncDirectory(staging, seam);
      return Object.freeze({ discarded, purged });
    },
    async removeStateTemporaries(directory) {
      const entries = await listDirectory(directory);
      const temporaries = entries.filter((entry) => entry.name.startsWith('.state.tmp-'));
      for (const entry of temporaries) {
        if (!entry.isFile()) fail('unsafe-queue-artifact', `${entry.name} must be a regular file`);
        await rm(path.join(directory, entry.name), { force: true });
      }
      if (temporaries.length > 0) await syncDirectory(directory, seam);
      return temporaries.length;
    },
  });
}

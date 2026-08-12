import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { fail, OwnerAlphaError } from './errors.js';
import { prepareStore, prepareStoreParent, resolveStorePath } from './store.js';

async function prepareLockFile(file) {
  let handle;
  try {
    handle = await open(
      file,
      constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    );
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.nlink !== 1) {
      fail('unsafe-lock-file', 'lock path must be one regular, unlinked file');
    }
  } catch (error) {
    if (error instanceof OwnerAlphaError) throw error;
    if (error?.code === 'ELOOP') fail('unsafe-lock-file', 'lock path must not be a symlink');
    fail('lock-unavailable', 'lock file could not be prepared', { cause: error?.code ?? 'unknown' });
  } finally {
    await handle?.close();
  }
}

async function acquireChildHeldLock(file, { conflictExitCode = 75 } = {}) {
  const token = `owner-alpha-lock-ready-${process.pid}-${randomUUID()}\n`;
  const child = spawn(
    'flock',
    ['--exclusive', '--nonblock', '--conflict-exit-code', String(conflictExitCode), file, 'cat'],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let stdout = '';
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  child.stdin.on('error', () => {
    // The exit/error handlers below own failure reporting.
  });

  await new Promise((resolve, reject) => {
    let settled = false;
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    child.once('error', (error) => {
      rejectOnce(new OwnerAlphaError(
        'flock-unavailable',
        'the util-linux flock child could not start',
        { cause: error?.code ?? 'spawn-failed' },
      ));
    });
    child.once('exit', (code, signal) => {
      if (settled) return;
      if (code === conflictExitCode) {
        rejectOnce(new OwnerAlphaError('lock-busy', 'another owner-alpha transition holds the lock'));
        return;
      }
      rejectOnce(new OwnerAlphaError(
        'flock-unavailable',
        'the flock child exited before confirming ownership',
        { exitCode: code, signal, stderr: stderr.trim().slice(0, 2000) },
      ));
    });
    child.stdout.on('data', (chunk) => {
      if (settled) return;
      stdout += chunk.toString();
      if (stdout.includes(token)) {
        settled = true;
        resolve();
      }
    });
    child.stdin.write(token);
  });

  let released = false;
  return Object.freeze({
    file,
    pid: child.pid,
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

export async function acquireFileLock(context, relativePath) {
  await prepareStore(context);
  const file = resolveStorePath(context, relativePath);
  await prepareStoreParent(context, file);
  await prepareLockFile(file);
  return acquireChildHeldLock(file);
}

export async function withFileLock(context, relativePath, action) {
  if (typeof action !== 'function') fail('invalid-lock-action', 'lock action must be a function');
  const lock = await acquireFileLock(context, relativePath);
  try {
    return await action(lock);
  } finally {
    await lock.release();
  }
}

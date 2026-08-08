import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  OwnerAlphaError,
  acquireFileLock,
  defineStoreContext,
  prepareStore,
  resolveStorePath,
  withFileLock,
} from '../src/index.js';

const cleanup = [];

async function command(args, cwd) {
  const child = Bun.spawn(args, { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

async function fixture() {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'owner-alpha-flock-'));
  cleanup.push(projectRoot);
  const init = await command(['git', 'init', '-q'], projectRoot);
  if (init.exitCode !== 0) throw new Error(init.stderr);
  await writeFile(path.join(projectRoot, '.gitignore'), '.private/\n', 'utf8');
  const workspaceRoot = path.join(projectRoot, '.private', 'owner-alpha');
  const storeRoot = path.join(workspaceRoot, 'store');
  return {
    context: defineStoreContext({ projectRoot, workspaceRoot, storeRoot }),
    projectRoot,
    storeRoot,
  };
}

async function expectCodeAsync(action, code) {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(OwnerAlphaError);
    expect(error.code).toBe(code);
    return error;
  }
  throw new Error(`expected OwnerAlphaError(${code})`);
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((target) => rm(target, { recursive: true, force: true })));
});

describe('child-held flock', () => {
  test('uses the kernel lock rather than persistent lock-file existence', async () => {
    const { context } = await fixture();
    await prepareStore(context);
    const file = resolveStorePath(context, 'locks/job.lock');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, 'stale prior process note\n', 'utf8');

    let count = 0;
    await withFileLock(context, 'locks/job.lock', async () => { count += 1; });
    await withFileLock(context, 'locks/job.lock', async () => { count += 1; });
    expect(count).toBe(2);
  });

  test('the child holds the lock until release and all nonblocking contenders fail busy', async () => {
    const { context, projectRoot } = await fixture();
    const lock = await acquireFileLock(context, 'locks/job.lock');
    const lockFile = resolveStorePath(context, 'locks/job.lock');

    const external = await command(
      ['flock', '--exclusive', '--nonblock', '--conflict-exit-code', '75', lockFile, 'true'],
      projectRoot,
    );
    expect(external.exitCode).toBe(75);

    const contenders = await Promise.allSettled(
      Array.from({ length: 12 }, () => acquireFileLock(context, 'locks/job.lock')),
    );
    expect(contenders.every(
      (outcome) => outcome.status === 'rejected' && outcome.reason.code === 'lock-busy',
    )).toBe(true);

    await lock.release();
    const after = await command(
      ['flock', '--exclusive', '--nonblock', '--conflict-exit-code', '75', lockFile, 'true'],
      projectRoot,
    );
    expect(after.exitCode).toBe(0);
  });

  test('releases the child-held lock when the protected action throws', async () => {
    const { context } = await fixture();
    const marker = new Error('action failed');
    await expect(withFileLock(context, 'locks/job.lock', async () => {
      throw marker;
    })).rejects.toBe(marker);

    const lock = await acquireFileLock(context, 'locks/job.lock');
    await lock.release();
    await lock.release();
  });

  test('rejects a symlinked lock path', async () => {
    const { context, storeRoot } = await fixture();
    await prepareStore(context);
    const outside = path.join(path.dirname(storeRoot), 'outside.lock');
    await writeFile(outside, '', 'utf8');
    const lockFile = resolveStorePath(context, 'locks/job.lock');
    await mkdir(path.dirname(lockFile), { recursive: true });
    await symlink(outside, lockFile);
    await expectCodeAsync(() => acquireFileLock(context, 'locks/job.lock'), 'store-symlink-rejected');
  });
});

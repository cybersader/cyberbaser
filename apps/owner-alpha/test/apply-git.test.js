import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareCorrection } from '../../../packages/correction/src/index.js';
import { OwnerAlphaError } from '../src/errors.js';
import { applyAcceptedOperation } from '../src/apply.js';
import {
  commitAppliedCandidate,
  pushExactCommit,
  verifyExactCommit,
} from '../src/git-publish.js';

const cleanup = [];
const LOCK = Object.freeze({ pid: process.pid, release: async () => {} });

async function git(cwd, args, { encoding = 'utf8', allowFailure = false } = {}) {
  const child = Bun.spawn(['git', '-C', cwd, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_EDITOR: ':',
      GIT_SEQUENCE_EDITOR: ':',
    },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const bytes = Buffer.from(stdout);
  if (exitCode !== 0 && !allowFailure) {
    throw new Error(`git ${args.join(' ')} failed (${exitCode}): ${stderr}`);
  }
  return {
    exitCode,
    stderr,
    stdout: encoding === 'buffer' ? bytes : bytes.toString('utf8').trim(),
  };
}

async function moduleGit(checkout, args, { encoding = 'buffer' } = {}) {
  return (await git(checkout, args, { encoding })).stdout;
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'owner-alpha-apply-git-'));
  cleanup.push(root);
  const checkout = path.join(root, 'checkout');
  const remote = path.join(root, 'remote.git');
  await mkdir(checkout);
  await git(checkout, ['init', '-q', '--initial-branch=main']);
  await git(checkout, ['config', 'user.name', 'Owner Alpha Test']);
  await git(checkout, ['config', 'user.email', 'owner-alpha@example.test']);
  await mkdir(path.join(checkout, 'docs'));
  const sourcePath = 'docs/page.md';
  const sourceFile = path.join(checkout, sourcePath);
  const baseBytes = Buffer.from('# Page\n\nThe old value is wrong.\n', 'utf8');
  await writeFile(sourceFile, baseBytes, { mode: 0o644 });
  await writeFile(path.join(checkout, 'other.txt'), 'stable\n', 'utf8');
  await git(checkout, ['add', '--', sourcePath, 'other.txt']);
  await git(checkout, ['commit', '-q', '-m', 'base']);
  const baseCommit = (await git(checkout, ['rev-parse', 'HEAD'])).stdout;
  await git(root, ['init', '--bare', '-q', '--initial-branch=main', remote]);
  await git(checkout, ['remote', 'add', 'origin', remote]);
  await git(checkout, ['push', '-q', '-u', 'origin', 'main']);
  const correction = prepareCorrection(baseBytes, {
    selector: { quote: 'wrong', prefix: 'is ', suffix: '.\n' },
    replacement: 'right',
  });
  const operation = Object.freeze({
    schemaVersion: 1,
    artifactType: 'owner-alpha-source-operation',
    source: Object.freeze({ relativePath: sourcePath, baseCommit }),
    operationType: 'offset',
    baseByteLength: correction.baseByteLength,
    baseDigest: correction.baseDigest,
    start: correction.start,
    end: correction.end,
    expectedOldBytesBase64: correction.expectedOldBytes.toString('base64'),
    replacementBytesBase64: correction.replacementBytes.toString('base64'),
    candidateByteLength: correction.candidateByteLength,
    candidateDigest: correction.candidateDigest,
  });
  return { root, checkout, remote, sourcePath, sourceFile, baseBytes, baseCommit, correction, operation };
}

async function applyFx(fx, overrides) {
  return applyAcceptedOperation({
    checkout: fx.checkout,
    operation: fx.operation,
    lock: LOCK,
  }, overrides);
}

async function commitFx(fx, application, options = {}) {
  return commitAppliedCandidate({
    checkout: fx.checkout,
    application,
    branch: 'main',
    commitMessagePrefix: 'owner-alpha:',
    useHooks: true,
    ...options,
  });
}

async function expectCode(action, code) {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(OwnerAlphaError);
    expect(error.code).toBe(code);
    return error;
  }
  throw new Error(`expected OwnerAlphaError(${code})`);
}

async function assertNoTemporarySibling(sourceFile) {
  const entries = await readdir(path.dirname(sourceFile));
  expect(entries.some((name) => name.includes('.owner-alpha-') && name.endsWith('.tmp'))).toBe(false);
}

async function advanceRemote(fx) {
  const peer = path.join(fx.root, 'peer');
  await git(fx.root, ['clone', '-q', fx.remote, peer]);
  await git(peer, ['config', 'user.name', 'Remote Peer']);
  await git(peer, ['config', 'user.email', 'peer@example.test']);
  await writeFile(path.join(peer, 'other.txt'), 'remote advanced\n', 'utf8');
  await git(peer, ['add', '--', 'other.txt']);
  await git(peer, ['commit', '-q', '-m', 'advance remote']);
  await git(peer, ['push', '-q', 'origin', 'main']);
  return (await git(peer, ['rev-parse', 'HEAD'])).stdout;
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((target) => rm(target, { recursive: true, force: true })));
});

describe('fail-closed atomic source application', () => {
  test('rejects a stale accepted base and leaves source untouched', async () => {
    const fx = await fixture();
    await writeFile(fx.sourceFile, '# Page\n\nA newer committed source.\n', 'utf8');
    await git(fx.checkout, ['add', '--', fx.sourcePath]);
    await git(fx.checkout, ['commit', '-q', '-m', 'new base']);

    const error = await expectCode(() => applyFx(fx), 'stale-base-head');
    expect(error.details.recovery).toBe('source-untouched');
    expect(await readFile(fx.sourceFile, 'utf8')).toContain('newer committed source');
    await assertNoTemporarySibling(fx.sourceFile);
  });

  test('requires the caller-held lock before inspecting or writing source', async () => {
    const fx = await fixture();
    const error = await expectCode(() => applyAcceptedOperation({
      checkout: fx.checkout,
      operation: fx.operation,
    }), 'caller-lock-required');
    expect(error.details.recovery).toBe('source-untouched');
    expect(await readFile(fx.sourceFile)).toEqual(fx.baseBytes);
  });

  test('rejects dirty or unrelated paths before creating a temporary file', async () => {
    const fx = await fixture();
    await writeFile(path.join(fx.checkout, 'unrelated.tmp'), 'dirty\n', 'utf8');

    const error = await expectCode(() => applyFx(fx), 'worktree-not-clean');
    expect(error.details.status).toContain('?? unrelated.tmp');
    expect(await readFile(fx.sourceFile)).toEqual(fx.baseBytes);
    await assertNoTemporarySibling(fx.sourceFile);
  });

  test('rejects mode changes, symlinks, and hardlinks at the source boundary', async () => {
    const modeFx = await fixture();
    await git(modeFx.checkout, ['config', 'core.fileMode', 'false']);
    await chmod(modeFx.sourceFile, 0o755);
    await expectCode(() => applyFx(modeFx), 'source-mode-mismatch');

    const symlinkFx = await fixture();
    const target = path.join(symlinkFx.root, 'same-bytes.md');
    await writeFile(target, symlinkFx.baseBytes);
    await unlink(symlinkFx.sourceFile);
    await symlink(target, symlinkFx.sourceFile);
    await expectCode(() => applyFx(symlinkFx, {
      git: async (checkout, args, options) => (
        args[0] === 'status' ? Buffer.alloc(0) : moduleGit(checkout, args, options)
      ),
    }), 'source-symlink-rejected');

    const hardlinkFx = await fixture();
    const linked = path.join(hardlinkFx.root, 'linked.md');
    await link(hardlinkFx.sourceFile, linked);
    expect((await lstat(hardlinkFx.sourceFile)).nlink).toBe(2);
    await expectCode(() => applyFx(hardlinkFx), 'source-hardlink-rejected');
  });

  test('cleans exclusive temporary files when write or fsync fails before rename', async () => {
    for (const seam of ['write', 'fsync']) {
      const fx = await fixture();
      const overrides = seam === 'write'
        ? { writeCandidate: async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); } }
        : { syncFile: async () => { throw Object.assign(new Error('sync failed'), { code: 'EIO' }); } };
      const error = await expectCode(() => applyFx(fx, overrides), 'source-application-failed');
      expect(error.details.recovery).toBe('source-untouched');
      expect(error.details.sourceMayHaveChanged).toBe(false);
      expect(await readFile(fx.sourceFile)).toEqual(fx.baseBytes);
      await assertNoTemporarySibling(fx.sourceFile);
    }
  });

  test('classifies failure after rename as manual reconciliation without rollback', async () => {
    const fx = await fixture();
    const error = await expectCode(() => applyFx(fx, {
      syncDirectory: async () => { throw Object.assign(new Error('directory sync failed'), { code: 'EIO' }); },
    }), 'post-rename-verification-failed');
    expect(error.details.recovery).toBe('manual-reconcile');
    expect(error.details.sourceMayHaveChanged).toBe(true);
    expect((await readFile(fx.sourceFile, 'utf8'))).toContain('right');
    await assertNoTemporarySibling(fx.sourceFile);
  });
});

describe('exact commit and non-force publication', () => {
  test('leaves the exact candidate staged when a configured commit hook fails', async () => {
    const fx = await fixture();
    const application = await applyFx(fx);
    const hook = path.join(fx.checkout, '.git', 'hooks', 'pre-commit');
    await writeFile(hook, '#!/bin/sh\nexit 23\n', { mode: 0o755 });

    const error = await expectCode(() => commitFx(fx, application), 'git-commit-not-created');
    expect(error.details.recovery).toBe('reconcile-commit');
    expect(error.details.automaticRollbackPerformed).toBe(false);
    expect((await git(fx.checkout, ['rev-parse', 'HEAD'])).stdout).toBe(fx.baseCommit);
    expect((await git(fx.checkout, ['diff', '--cached', '--name-only'])).stdout).toBe(fx.sourcePath);
    expect((await git(fx.checkout, ['show', `:${fx.sourcePath}`], { encoding: 'buffer' })).stdout)
      .toEqual(application.candidateBytes);
  });

  test('rejects a commit whose hook changes the exact authorized message', async () => {
    const fx = await fixture();
    const application = await applyFx(fx);
    const hook = path.join(fx.checkout, '.git', 'hooks', 'commit-msg');
    await writeFile(hook, '#!/bin/sh\nprintf "\\nchanged by hook\\n" >> "$1"\n', { mode: 0o755 });

    const error = await expectCode(
      () => commitFx(fx, application),
      'commit-message-mismatch',
    );
    expect(error.details.recovery).toBe('manual-reconcile');
    expect((await git(fx.checkout, ['show', '-s', '--format=%B', 'HEAD'])).stdout)
      .toContain('changed by hook');
  });

  test('rejects a distinct push URL before contacting or mutating it', async () => {
    const fx = await fixture();
    const application = await applyFx(fx);
    const committed = await commitFx(fx, application);
    const alternate = path.join(fx.root, 'alternate.git');
    await git(fx.root, ['init', '--bare', '-q', '--initial-branch=main', alternate]);
    await git(fx.checkout, ['remote', 'set-url', '--push', 'origin', alternate]);

    const error = await expectCode(() => pushExactCommit({
      checkout: fx.checkout,
      application,
      commit: committed.commit,
      remote: 'origin',
      remoteUrl: fx.remote,
      branch: 'main',
      useHooks: true,
    }), 'remote-destination-mismatch');
    expect(error.details.fetchUrl).toBe(fx.remote);
    expect(error.details.pushUrl).toBe(alternate);
    expect((await git(fx.remote, ['rev-parse', 'refs/heads/main'])).stdout).toBe(fx.baseCommit);
  });

  test('refuses a remote advance without force, rollback, rebase, or merge', async () => {
    const fx = await fixture();
    const application = await applyFx(fx);
    const committed = await commitFx(fx, application);
    const remoteHead = await advanceRemote(fx);

    const error = await expectCode(() => pushExactCommit({
      checkout: fx.checkout,
      application,
      commit: committed.commit,
      remote: 'origin',
      remoteUrl: fx.remote,
      branch: 'main',
      useHooks: true,
    }), 'remote-advanced');
    expect(error.details.remoteHead).toBe(remoteHead);
    expect(error.details.pushPerformed).toBe(false);
    expect((await git(fx.checkout, ['rev-parse', 'HEAD'])).stdout).toBe(committed.commit);
    expect((await git(fx.remote, ['rev-parse', 'refs/heads/main'])).stdout).toBe(remoteHead);
  });

  test('atomically applies, commits one unchanged-mode path, and pushes the exact commit', async () => {
    const fx = await fixture();
    const beforeMode = (await lstat(fx.sourceFile)).mode & 0o7777;
    const application = await applyFx(fx);
    expect(application.status).toBe('source-applied');
    expect(application.baseCommit).toBe(fx.baseCommit);
    expect(application.sourcePath).toBe(fx.sourcePath);
    expect(await readFile(fx.sourceFile)).toEqual(application.candidateBytes);
    expect((await lstat(fx.sourceFile)).mode & 0o7777).toBe(beforeMode);

    const committed = await commitFx(fx, application);
    expect(committed.status).toBe('committed');
    expect(committed.message).toBe(`owner-alpha: ${fx.sourcePath}`);
    expect(committed.verification.parentCommit).toBe(fx.baseCommit);
    expect(committed.verification.exactSplice).toEqual({
      start: fx.correction.start,
      end: fx.correction.end,
      prefixIdentical: true,
      suffixIdentical: true,
      committedBytesEqualCandidate: true,
    });
    expect((await git(fx.checkout, [
      'diff-tree', '--no-commit-id', '--name-only', '-r', committed.commit,
    ])).stdout).toBe(fx.sourcePath);
    expect((await git(fx.checkout, ['diff', `${fx.baseCommit}..${committed.commit}`, '--summary'])).stdout)
      .not.toContain('mode change');
    expect(await verifyExactCommit({
      checkout: fx.checkout,
      commit: committed.commit,
      application,
    })).toEqual(committed.verification);

    const pushed = await pushExactCommit({
      checkout: fx.checkout,
      application,
      commit: committed.commit,
      remote: 'origin',
      remoteUrl: fx.remote,
      branch: 'main',
      useHooks: true,
    });
    expect(pushed.status).toBe('pushed');
    expect(pushed.refspec).toBe(`${committed.commit}:refs/heads/main`);
    expect(pushed.forceUsed).toBe(false);
    expect((await git(fx.remote, ['rev-parse', 'refs/heads/main'])).stdout).toBe(committed.commit);
    expect((await git(fx.remote, ['show', `${committed.commit}:${fx.sourcePath}`], { encoding: 'buffer' })).stdout)
      .toEqual(application.candidateBytes);

    const reconciled = await pushExactCommit({
      checkout: fx.checkout,
      application,
      commit: committed.commit,
      remote: 'origin',
      remoteUrl: fx.remote,
      branch: 'main',
      useHooks: true,
    });
    expect(reconciled.status).toBe('already-pushed');
    expect(reconciled.remoteRef).toBe(committed.commit);
    expect(reconciled.pushPerformed).toBe(false);
    expect(reconciled).not.toHaveProperty('refspec');
  });
});

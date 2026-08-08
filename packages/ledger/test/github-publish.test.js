import { afterEach, describe, expect, test } from 'bun:test';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DECISION_LEDGER_PATH,
  LedgerGithubError,
  publishLedgerEntry,
  serializeLedgerEntry,
} from '../src/index.js';

const temporaryDirectories = [];
const SHA_A = '1'.repeat(40);
const SHA_B = '2'.repeat(40);
const SHA_C = '3'.repeat(40);

function entry(overrides = {}) {
  const base = {
    schemaVersion: 1,
    prNumber: 42,
    author: 'helper-bot',
    authorType: 'agent',
    trustRoute: 'quick-review',
    ofmVerdict: 'clean',
    checks: [{
      name: 'validate',
      appSlug: 'github-actions',
      status: 'completed',
      conclusion: 'success',
    }],
    maintainerDecision: 'merged',
    mergeCommitSha: SHA_C,
    baseSha: SHA_A,
    headSha: SHA_B,
    timestamps: {
      openedAt: '2026-08-03T10:00:00Z',
      closedAt: '2026-08-03T11:00:00Z',
      recordedAt: '2026-08-03T12:00:00Z',
    },
  };
  return {
    ...base,
    ...overrides,
    timestamps: { ...base.timestamps, ...(overrides.timestamps ?? {}) },
  };
}

async function git(cwd, args, { encoding = 'utf8', allowFailure = false, env = process.env } = {}) {
  const child = Bun.spawn(['git', '-C', cwd, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...env,
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
    const error = new Error(`git ${args.join(' ')} failed (${exitCode}): ${stderr}`);
    error.exitCode = exitCode;
    throw error;
  }
  return {
    exitCode,
    stderr,
    stdout: encoding === 'buffer' ? bytes : bytes.toString('utf8').trim(),
  };
}

async function moduleGit(checkout, args, { encoding = 'buffer', env = process.env } = {}) {
  return (await git(checkout, args, { encoding, env })).stdout;
}

async function setupRepository({ existingLedger = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'cb-ledger-publish-test-'));
  temporaryDirectories.push(root);
  const checkout = join(root, 'checkout');
  const remote = join(root, 'remote.git');
  await mkdir(checkout);
  await git(checkout, ['init', '-q', '--initial-branch=main']);
  await git(checkout, ['config', 'user.name', 'Ledger Test Maintainer']);
  await git(checkout, ['config', 'user.email', 'maintainer@example.test']);
  await writeFile(join(checkout, 'README.md'), '# Test vault\n');
  if (existingLedger !== null) {
    await mkdir(join(checkout, '.cyberbaser'));
    await writeFile(join(checkout, DECISION_LEDGER_PATH), serializeLedgerEntry(existingLedger));
  }
  await git(checkout, ['add', '.']);
  await git(checkout, ['commit', '-q', '-m', 'base']);
  const baseCommit = (await git(checkout, ['rev-parse', 'HEAD'])).stdout;
  await git(root, ['init', '--bare', '-q', '--initial-branch=main', remote]);
  await git(checkout, ['remote', 'add', 'origin', remote]);
  await git(checkout, ['push', '-q', '-u', 'origin', 'main']);
  return { root, checkout, remote, baseCommit };
}

async function publish(fixture, candidate = entry(), overrides = {}) {
  return publishLedgerEntry({
    checkout: fixture.checkout,
    entry: candidate,
    remote: 'origin',
    remoteUrl: fixture.remote,
    branch: 'main',
  }, overrides);
}

async function expectGithubError(action, code) {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(LedgerGithubError);
    expect(error.code).toBe(code);
    return error;
  }
  throw new Error(`expected LedgerGithubError(${code})`);
}

async function advanceRemote(fixture) {
  const peer = join(fixture.root, `peer-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await git(fixture.root, ['clone', '-q', fixture.remote, peer]);
  await git(peer, ['config', 'user.name', 'Concurrent Maintainer']);
  await git(peer, ['config', 'user.email', 'peer@example.test']);
  await writeFile(join(peer, 'concurrent.txt'), 'branch advanced\n');
  await git(peer, ['add', 'concurrent.txt']);
  await git(peer, ['commit', '-q', '-m', 'Advance branch concurrently']);
  await git(peer, ['push', '-q', 'origin', 'main']);
  return (await git(peer, ['rev-parse', 'HEAD'])).stdout;
}

async function rewriteRemoteFromAcceptedBase(fixture) {
  const peer = join(fixture.root, `rewrite-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await git(fixture.root, ['clone', '-q', fixture.remote, peer]);
  await git(peer, ['config', 'user.name', 'Rewriting Maintainer']);
  await git(peer, ['config', 'user.email', 'rewrite@example.test']);
  await git(peer, ['checkout', '--detach', fixture.baseCommit]);
  await writeFile(join(peer, 'rewrite.txt'), 'replacement branch tip\n');
  await git(peer, ['add', 'rewrite.txt']);
  await git(peer, ['commit', '-q', '-m', 'Replace the just-pushed ledger commit']);
  const sibling = (await git(peer, ['rev-parse', 'HEAD'])).stdout;
  const transferRef = 'refs/cyberbaser-test/rewrite';
  await git(peer, ['push', '-q', 'origin', `${sibling}:${transferRef}`]);
  await git(fixture.remote, ['update-ref', 'refs/heads/main', sibling]);
  await git(fixture.remote, ['update-ref', '-d', transferRef]);
  return sibling;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe('safe ledger publication', () => {
  test('creates the ledger in a fresh detached worktree and publishes one ledger-only bot commit', async () => {
    const fixture = await setupRepository();
    const candidate = entry();
    const mutationCommands = [];
    const result = await publish(fixture, candidate, {
      async mutateGit(checkout, args, options) {
        mutationCommands.push([...args]);
        return moduleGit(checkout, args, options);
      },
    });

    expect(result).toMatchObject({
      status: 'published',
      attempts: 1,
      append: { status: 'appended', prNumber: 42, line: 1 },
      baseCommit: fixture.baseCommit,
      message: 'Record decision ledger entry for PR #42',
      pushPerformed: true,
      forceUsed: false,
    });
    expect(result.refspec).toBe(`${result.commit}:refs/heads/main`);
    expect((await git(fixture.remote, ['rev-parse', 'refs/heads/main'])).stdout).toBe(result.commit);
    expect((await git(fixture.remote, [
      'diff-tree', '--no-commit-id', '--name-only', '-r', result.commit,
    ])).stdout).toBe(DECISION_LEDGER_PATH);
    expect((await git(fixture.remote, ['show', '-s', '--format=%an <%ae>', result.commit])).stdout)
      .toBe('Cyberbaser Ledger Bot <cyberbaser-ledger[bot]@users.noreply.github.com>');
    expect((await git(fixture.remote, ['show', `${result.commit}:${DECISION_LEDGER_PATH}`], { encoding: 'buffer' })).stdout)
      .toEqual(Buffer.from(serializeLedgerEntry(candidate)));
    expect((await git(fixture.checkout, ['status', '--porcelain'])).stdout).toBe('');
    expect(readFile(join(fixture.checkout, DECISION_LEDGER_PATH))).rejects.toThrow();
    expect(mutationCommands.some((args) => args.includes('merge') || args.includes('rebase'))).toBe(false);
    expect(mutationCommands.some((args) => args.includes('--force') || args.includes('--force-with-lease'))).toBe(false);
    expect(mutationCommands.some((args) => args.some((argument) => argument.startsWith('+')))).toBe(false);
    const pushCommand = mutationCommands.find((args) => args.includes('push'));
    expect(pushCommand).toContain('--no-follow-tags');
    expect(pushCommand).toContain('--recurse-submodules=no');
    expect(pushCommand).toContain('remote.origin.mirror=false');
    expect(pushCommand?.at(-1)).toBe(result.refspec);
  });

  test('preserves the first closure as a duplicate no-op without creating or pushing a commit', async () => {
    const first = entry();
    const fixture = await setupRepository({ existingLedger: first });
    const result = await publish(fixture, entry({ ofmVerdict: 'damage' }));

    expect(result).toMatchObject({
      status: 'already-recorded',
      attempts: 1,
      baseCommit: fixture.baseCommit,
      commit: null,
      pushPerformed: false,
    });
    expect((await git(fixture.remote, ['rev-parse', 'refs/heads/main'])).stdout).toBe(fixture.baseCommit);
    expect((await git(fixture.remote, ['rev-list', '--count', 'main'])).stdout).toBe('1');
    expect((await git(fixture.remote, [`show`, `main:${DECISION_LEDGER_PATH}`], { encoding: 'buffer' })).stdout)
      .toEqual(Buffer.from(serializeLedgerEntry(first)));
  });

  test('retries only a classified branch-advance race from a new remote tip', async () => {
    const fixture = await setupRepository();
    let raceCommit = null;
    let injected = false;
    const result = await publish(fixture, entry(), {
      async mutateGit(checkout, args, options) {
        const output = await moduleGit(checkout, args, options);
        if (!injected && args.includes('commit')) {
          injected = true;
          raceCommit = await advanceRemote(fixture);
        }
        return output;
      },
    });

    expect(injected).toBe(true);
    expect(result).toMatchObject({ status: 'published', attempts: 2, pushPerformed: true });
    expect((await git(fixture.remote, ['rev-parse', 'refs/heads/main'])).stdout).toBe(result.commit);
    expect((await git(fixture.remote, ['rev-list', result.commit])).stdout.split('\n')).toContain(raceCommit);
    expect((await git(fixture.remote, ['show', `${result.commit}:${DECISION_LEDGER_PATH}`], { encoding: 'buffer' })).stdout)
      .toEqual(Buffer.from(serializeLedgerEntry(entry())));
  });

  test('rejects a distinct push destination before creating any ledger commit', async () => {
    const fixture = await setupRepository();
    const alternate = join(fixture.root, 'alternate.git');
    await git(fixture.root, ['init', '--bare', '-q', '--initial-branch=main', alternate]);
    await git(fixture.checkout, ['remote', 'set-url', '--push', 'origin', alternate]);

    const error = await expectGithubError(() => publish(fixture), 'remote-destination-mismatch');
    expect(error.details).toEqual({
      fetchDestinationCount: 1,
      pushDestinationCount: 1,
      fetchMatches: true,
      pushMatches: false,
    });
    expect((await git(fixture.remote, ['rev-parse', 'refs/heads/main'])).stdout).toBe(fixture.baseCommit);
    expect((await git(fixture.root, ['ls-remote', '--refs', alternate, 'refs/heads/main'])).stdout).toBe('');
  });

  test('does not retry a successful push that was subsequently rewritten off the published commit', async () => {
    const fixture = await setupRepository();
    let sibling = null;
    const error = await expectGithubError(() => publish(fixture, entry(), {
      async mutateGit(checkout, args, options) {
        const output = await moduleGit(checkout, args, options);
        if (sibling === null && args.includes('push')) {
          sibling = await rewriteRemoteFromAcceptedBase(fixture);
        }
        return output;
      },
    }), 'publication-branch-not-fast-forward');

    expect(error.details).toMatchObject({
      expectedBase: expect.stringMatching(/^[0-9a-f]{40}$/),
      advancedHead: sibling,
      stage: 'post-push',
    });
    expect(error.details.expectedBase).not.toBe(fixture.baseCommit);
    expect((await git(fixture.remote, ['rev-parse', 'refs/heads/main'])).stdout).toBe(sibling);
  });

  test('fails post-push verification when Git reports success without moving the exact remote ref', async () => {
    const fixture = await setupRepository();
    let interceptedPush = false;
    const error = await expectGithubError(() => publish(fixture, entry(), {
      async mutateGit(checkout, args, options) {
        if (args.includes('push')) {
          interceptedPush = true;
          return options?.encoding === 'utf8' ? '' : Buffer.alloc(0);
        }
        return moduleGit(checkout, args, options);
      },
    }), 'post-push-verification-failed');

    expect(interceptedPush).toBe(true);
    expect(error.details).toMatchObject({
      remoteHead: fixture.baseCommit,
      forceUsed: false,
    });
    expect((await git(fixture.remote, ['rev-parse', 'refs/heads/main'])).stdout).toBe(fixture.baseCommit);
    expect((await git(fixture.remote, ['rev-list', '--count', 'main'])).stdout).toBe('1');
  });
});

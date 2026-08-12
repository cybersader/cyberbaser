import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LedgerGithubError,
  createGitReader,
  fetchAndVerifyPullRequestObjects,
  readBaseTrustPolicy,
  recomputeOfmVerdict,
  reconstructGitEvidence,
} from '../src/index.js';

const temporaryDirectories = [];

function expectGithubError(error, code) {
  expect(error).toBeInstanceOf(LedgerGithubError);
  expect(error.code).toBe(code);
}

async function git(cwd, ...args) {
  const process = Bun.spawn(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${stderr}`);
  return stdout.trim();
}

async function setupRepository({
  before = '# Note\n\nKeep [[Target]].\n',
  after = '# Note\n\nKeep [[Target]]!\n',
  path = 'docs/note.md',
  policy = 'agents:\n  - helper-bot\ntrusted:\n  - alice\n',
  includePolicy = true,
  merge = false,
  divergeBase = false,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'cb-ledger-git-'));
  temporaryDirectories.push(root);
  const remote = join(root, 'remote.git');
  const source = join(root, 'source');
  const checkout = join(root, 'checkout');
  await mkdir(source);
  await git(root, 'init', '--bare', remote);
  await git(source, 'init', '-b', 'main');
  await git(source, 'config', 'user.name', 'Test Maintainer');
  await git(source, 'config', 'user.email', 'maintainer@example.test');
  if (includePolicy) {
    await mkdir(join(source, '.cyberbaser'), { recursive: true });
    await writeFile(join(source, '.cyberbaser', 'trust.yml'), policy);
  }
  await mkdir(join(source, path, '..'), { recursive: true });
  await writeFile(join(source, path), before);
  if (divergeBase) {
    await mkdir(join(source, 'docs'), { recursive: true });
    await writeFile(join(source, 'docs', 'base-only.md'), '# Base\n\nPlain text.\n');
  }
  await git(source, 'add', '.');
  await git(source, 'commit', '-m', 'base');
  let baseSha = await git(source, 'rev-parse', 'HEAD');
  await git(source, 'remote', 'add', 'origin', remote);
  await git(source, 'push', '-u', 'origin', 'main');
  await git(remote, 'symbolic-ref', 'HEAD', 'refs/heads/main');

  await git(source, 'checkout', '-b', 'pr-42');
  await writeFile(join(source, path), after);
  await git(source, 'add', '.');
  await git(source, 'commit', '-m', 'candidate');
  const headSha = await git(source, 'rev-parse', 'HEAD');
  await git(source, 'push', 'origin', 'HEAD:refs/pull/42/head');

  if (divergeBase) {
    await git(source, 'checkout', 'main');
    await writeFile(join(source, 'docs', 'base-only.md'), '# Base\n\nKeep [[Base target]].\n');
    await git(source, 'add', 'docs/base-only.md');
    await git(source, 'commit', '-m', 'advance base independently');
    baseSha = await git(source, 'rev-parse', 'HEAD');
    await git(source, 'push', 'origin', 'main');
  }

  let mergeSha = null;
  if (merge) {
    await git(source, 'checkout', 'main');
    await git(source, 'merge', '--no-ff', 'pr-42', '-m', 'merge candidate');
    mergeSha = await git(source, 'rev-parse', 'HEAD');
    await git(source, 'push', 'origin', 'main');
  }
  await git(root, 'clone', remote, checkout);
  return {
    root,
    remote,
    source,
    checkout,
    reader: createGitReader({ checkout }),
    baseSha,
    headSha,
    mergeSha,
  };
}

function pullRequest(fixture, overrides = {}) {
  const base = {
    number: 42,
    merged: fixture.mergeSha !== null,
    base: { sha: fixture.baseSha },
    head: { sha: fixture.headSha },
    merge_commit_sha: fixture.mergeSha,
  };
  return {
    ...base,
    ...overrides,
    base: { ...base.base, ...(overrides.base ?? {}) },
    head: { ...base.head, ...(overrides.head ?? {}) },
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('exact inert Git object verification', () => {
  test('fetches only exact base, pull-request head, and merge evidence without checking out contributor content', async () => {
    const fixture = await setupRepository({ merge: true });
    const beforeHead = await git(fixture.checkout, 'rev-parse', 'HEAD');
    const result = await fetchAndVerifyPullRequestObjects({
      git: fixture.reader,
      sourceRunId: '987654321',
      pullRequest: pullRequest(fixture),
    });
    expect(result).toEqual({
      baseSha: fixture.baseSha,
      headSha: fixture.headSha,
      mergeSha: fixture.mergeSha,
      baseRef: 'refs/cyberbaser/ledger/run-987654321-pr-42/base',
      headRef: 'refs/cyberbaser/ledger/run-987654321-pr-42/head',
      mergeRef: 'refs/cyberbaser/ledger/run-987654321-pr-42/merge',
    });
    expect(await git(fixture.checkout, 'rev-parse', 'HEAD')).toBe(beforeHead);
    expect(await git(fixture.checkout, 'rev-parse', result.headRef)).toBe(fixture.headSha);
  });

  test('fails when the authoritative API head SHA differs from refs/pull/N/head', async () => {
    const fixture = await setupRepository();
    try {
      await fetchAndVerifyPullRequestObjects({
        git: fixture.reader,
        sourceRunId: '987654321',
        pullRequest: pullRequest(fixture, { head: { sha: fixture.baseSha } }),
      });
    } catch (error) {
      expectGithubError(error, 'git-ref-sha-mismatch');
    }
  });

  test('fails closed when an exact Git object cannot be fetched', async () => {
    const fixture = await setupRepository();
    try {
      await fetchAndVerifyPullRequestObjects({
        git: fixture.reader,
        sourceRunId: '987654321',
        pullRequest: pullRequest(fixture, { base: { sha: 'f'.repeat(40) } }),
      });
    } catch (error) {
      expectGithubError(error, 'git-command-failed');
    }
  });
});

describe('base-bound policy and OFM recomputation', () => {
  test('reads agents only from the exact base policy and recomputes a clean verdict', async () => {
    const fixture = await setupRepository();
    const evidence = await reconstructGitEvidence({
      git: fixture.reader,
      sourceRunId: '987654321',
      pullRequest: pullRequest(fixture),
    });
    expect(evidence.policy.agents).toEqual(['helper-bot']);
    expect(evidence.ofmVerdict).toBe('clean');
  });

  test('reports damage when exact head bytes remove an OFM construct', async () => {
    const fixture = await setupRepository({ after: '# Note\n\nKeep Target.\n' });
    await fetchAndVerifyPullRequestObjects({
      git: fixture.reader,
      sourceRunId: '987654321',
      pullRequest: pullRequest(fixture),
    });
    expect(await recomputeOfmVerdict({
      git: fixture.reader,
      baseSha: fixture.baseSha,
      headSha: fixture.headSha,
    })).toBe('damage');
  });

  test('compares the exact API base and head trees when the base advanced independently', async () => {
    const fixture = await setupRepository({ divergeBase: true });
    await fetchAndVerifyPullRequestObjects({
      git: fixture.reader,
      sourceRunId: '987654321',
      pullRequest: pullRequest(fixture),
    });
    expect(await recomputeOfmVerdict({
      git: fixture.reader,
      baseSha: fixture.baseSha,
      headSha: fixture.headSha,
    })).toBe('damage');
  });

  test.each(['A', 'D'])('returns not-applicable for %s-only Markdown changes', async (status) => {
    const commands = [];
    const verdict = await recomputeOfmVerdict({
      git: async (args) => {
        commands.push(args);
        if (args[0] === 'diff') return Buffer.from(`${status}\0docs/only.md\0`);
        throw new Error(`unexpected git ${args.join(' ')}`);
      },
      baseSha: '1'.repeat(40),
      headSha: '2'.repeat(40),
    });
    expect(verdict).toBe('not-applicable');
    expect(commands).toEqual([[
      'diff', '--name-status', '-z', '--no-renames', '1'.repeat(40), '2'.repeat(40), '--',
    ]]);
  });

  test('returns not-applicable when no Markdown path changed', async () => {
    const fixture = await setupRepository({ path: 'data/value.txt', before: 'one\n', after: 'two\n' });
    await fetchAndVerifyPullRequestObjects({
      git: fixture.reader,
      sourceRunId: '987654321',
      pullRequest: pullRequest(fixture),
    });
    expect(await recomputeOfmVerdict({
      git: fixture.reader,
      baseSha: fixture.baseSha,
      headSha: fixture.headSha,
    })).toBe('not-applicable');
  });

  test('rejects missing and malformed base-bound trust policies', async () => {
    for (const options of [
      { includePolicy: false, code: 'missing-base-policy' },
      { policy: 'agents: [unterminated\n', code: 'malformed-base-policy' },
      { policy: 'agents: helper-bot\n', code: 'malformed-base-policy' },
      { policy: 'agents:\n  - 123\n', code: 'malformed-base-policy' },
      { policy: 'agents:\n  - " helper-bot"\n', code: 'malformed-base-policy' },
    ]) {
      const fixture = await setupRepository(options);
      await fetchAndVerifyPullRequestObjects({
        git: fixture.reader,
        sourceRunId: '987654321',
        pullRequest: pullRequest(fixture),
      });
      try {
        await readBaseTrustPolicy({ git: fixture.reader, baseSha: fixture.baseSha });
      } catch (error) {
        expectGithubError(error, options.code);
      }
    }
  });

  test('uses an injected OFM checker over exact base and head text', async () => {
    const fixture = await setupRepository();
    await fetchAndVerifyPullRequestObjects({
      git: fixture.reader,
      sourceRunId: '987654321',
      pullRequest: pullRequest(fixture),
    });
    const seen = [];
    const verdict = await recomputeOfmVerdict({
      git: fixture.reader,
      baseSha: fixture.baseSha,
      headSha: fixture.headSha,
      checkChangeImpl(before, after) {
        seen.push({ before, after });
        return { verdict: 'suspect' };
      },
    });
    expect(verdict).toBe('suspect');
    expect(seen).toEqual([{
      before: '# Note\n\nKeep [[Target]].\n',
      after: '# Note\n\nKeep [[Target]]!\n',
    }]);
  });
});

import { afterEach, describe, expect, test } from 'bun:test';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CAPTURE_HINT_FILENAME,
  CAPTURE_HINT_SCHEMA_VERSION,
  CAPTURE_WORKFLOW_NAME,
  CAPTURE_WORKFLOW_PATH,
  DECISION_LEDGER_PATH,
  captureArtifactName,
  captureRunName,
  createGitReader,
  parseLedgerText,
  serializeCaptureHint,
} from '../src/index.js';
import { runGithubCli } from '../src/github/cli.js';

const REPOSITORY_ID = '123456789';
const REPOSITORY = 'example/example-wiki';
const API_BASE_URL = 'https://api.example.test';
const temporaryDirectories = [];

async function git(cwd, ...args) {
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
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`git ${args.join(' ')} failed (${exitCode}): ${stderr}`);
  return Buffer.from(stdout).toString('utf8').trim();
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function setupRepository({
  prNumber,
  fork = false,
  merged = true,
  contributor = fork ? 'fork-contributor' : 'maintainer',
  includeContributorProgram = false,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'cb-ledger-wp1-acceptance-'));
  temporaryDirectories.push(root);
  const remote = join(root, 'base.git');
  const source = join(root, 'maintainer');
  const contributorCheckout = fork ? join(root, 'contributor') : source;
  const forkRemote = fork ? join(root, 'fork.git') : null;
  const checkout = join(root, 'trusted-checkout');
  const contributorMarker = join(root, 'contributor-code-ran');

  await git(root, 'init', '--bare', '--initial-branch=main', remote);
  await mkdir(source);
  await git(source, 'init', '--initial-branch=main');
  await git(source, 'config', 'user.name', 'Test Maintainer');
  await git(source, 'config', 'user.email', 'maintainer@example.test');
  await mkdir(join(source, '.cyberbaser'));
  await mkdir(join(source, 'docs'));
  await writeFile(join(source, '.cyberbaser', 'trust.yml'), [
    'agents:',
    '  - helper-bot',
    'trusted:',
    '  - maintainer',
    '  - fork-contributor',
    '',
  ].join('\n'));
  await writeFile(join(source, 'docs', 'note.md'), '# Note\n\nKeep [[Target]].\n');
  await git(source, 'add', '.');
  await git(source, 'commit', '-m', 'Create trusted base');
  const baseSha = await git(source, 'rev-parse', 'HEAD');
  await git(source, 'remote', 'add', 'origin', remote);
  await git(source, 'push', '-u', 'origin', 'main');
  await git(remote, 'symbolic-ref', 'HEAD', 'refs/heads/main');

  if (fork) {
    await git(root, 'init', '--bare', '--initial-branch=main', forkRemote);
    await git(root, 'clone', remote, contributorCheckout);
    await git(contributorCheckout, 'remote', 'set-url', 'origin', forkRemote);
    await git(contributorCheckout, 'remote', 'add', 'upstream', remote);
    await git(contributorCheckout, 'push', '-u', 'origin', 'main');
  }

  await git(contributorCheckout, 'config', 'user.name', 'Test Contributor');
  await git(contributorCheckout, 'config', 'user.email', 'contributor@example.test');
  await git(contributorCheckout, 'checkout', '-b', `pr-${prNumber}`);
  await writeFile(join(contributorCheckout, 'docs', 'note.md'), '# Note\n\nKeep [[Target]]!\n');
  if (includeContributorProgram) {
    await writeFile(join(contributorCheckout, 'package.json'), JSON.stringify({
      name: 'contributor-controlled-package',
      scripts: {
        postinstall: `bun -e "require('node:fs').writeFileSync(${JSON.stringify(contributorMarker)}, 'ran')"`,
      },
    }, null, 2));
  }
  await git(contributorCheckout, 'add', '.');
  await git(contributorCheckout, 'commit', '-m', 'Propose note correction');
  const headSha = await git(contributorCheckout, 'rev-parse', 'HEAD');
  if (fork) {
    await git(contributorCheckout, 'push', 'origin', `HEAD:refs/heads/pr-${prNumber}`);
    await git(contributorCheckout, 'push', 'upstream', `HEAD:refs/pull/${prNumber}/head`);
  } else {
    await git(contributorCheckout, 'push', 'origin', `HEAD:refs/pull/${prNumber}/head`);
  }

  let mergeSha = null;
  if (merged) {
    await git(source, 'checkout', 'main');
    if (fork) {
      await git(source, 'fetch', 'origin', `refs/pull/${prNumber}/head`);
      await git(source, 'merge', '--no-ff', 'FETCH_HEAD', '-m', `Merge PR #${prNumber}`);
    } else {
      await git(source, 'merge', '--no-ff', `pr-${prNumber}`, '-m', `Merge PR #${prNumber}`);
    }
    mergeSha = await git(source, 'rev-parse', 'HEAD');
    await git(source, 'push', 'origin', 'main');
  }

  await git(root, 'clone', remote, checkout);
  return {
    root,
    remote,
    forkRemote,
    source,
    checkout,
    contributorCheckout,
    contributorMarker,
    baseSha,
    headSha,
    mergeSha,
    prNumber,
    fork,
    merged,
    contributor,
  };
}

function captureHint(fixture) {
  return {
    schemaVersion: CAPTURE_HINT_SCHEMA_VERSION,
    repositoryId: REPOSITORY_ID,
    repository: REPOSITORY,
    sourceRunId: String(9_000_000 + fixture.prNumber),
    sourceRunAttempt: 1,
    prNumber: fixture.prNumber,
  };
}

function workflowRun(fixture) {
  const hint = captureHint(fixture);
  return {
    id: Number(hint.sourceRunId),
    run_attempt: hint.sourceRunAttempt,
    name: CAPTURE_WORKFLOW_NAME,
    path: CAPTURE_WORKFLOW_PATH,
    display_title: captureRunName(fixture.prNumber),
    event: 'pull_request',
    status: 'completed',
    conclusion: 'success',
    head_sha: fixture.mergeSha ?? fixture.headSha,
    repository: { id: Number(REPOSITORY_ID), full_name: REPOSITORY },
    pull_requests: [],
  };
}

function pullRequest(fixture) {
  return {
    number: fixture.prNumber,
    state: 'closed',
    merged: fixture.merged,
    user: { login: fixture.contributor, type: 'User' },
    created_at: '2026-08-01T10:00:00Z',
    closed_at: '2026-08-01T11:00:00Z',
    merged_at: fixture.merged ? '2026-08-01T11:00:00Z' : null,
    merged_by: fixture.merged ? { login: 'maintainer' } : null,
    merge_commit_sha: fixture.mergeSha,
    base: {
      sha: fixture.baseSha,
      ref: 'main',
      repo: { id: Number(REPOSITORY_ID), full_name: REPOSITORY },
    },
    head: {
      sha: fixture.headSha,
      ref: `pr-${fixture.prNumber}`,
      repo: fixture.fork
        ? { id: 987654321, full_name: 'contributor/example-wiki' }
        : { id: Number(REPOSITORY_ID), full_name: REPOSITORY },
    },
  };
}

function jsonResponse(value, init = {}) {
  return new Response(JSON.stringify(value), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipSingleFile(name, data) {
  const filename = Buffer.from(name, 'utf8');
  const contents = Buffer.from(data);
  const checksum = crc32(contents);
  const local = Buffer.alloc(30 + filename.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(contents.length, 18);
  local.writeUInt32LE(contents.length, 22);
  local.writeUInt16LE(filename.length, 26);
  filename.copy(local, 30);

  const central = Buffer.alloc(46 + filename.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(contents.length, 20);
  central.writeUInt32LE(contents.length, 24);
  central.writeUInt16LE(filename.length, 28);
  filename.copy(central, 46);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length + contents.length, 16);
  return Buffer.concat([local, contents, central, end]);
}

function fakeGithub(fixture, { artifactHint = captureHint(fixture) } = {}) {
  const hint = captureHint(fixture);
  const run = workflowRun(fixture);
  const archive = zipSingleFile(CAPTURE_HINT_FILENAME, serializeCaptureHint(artifactHint));
  const artifact = {
    id: 8000 + fixture.prNumber,
    name: captureArtifactName(hint),
    expired: false,
    size_in_bytes: archive.length,
    workflow_run: { id: Number(hint.sourceRunId), repository_id: Number(REPOSITORY_ID) },
  };
  const repoPath = '/repos/example/example-wiki';
  const routes = new Map([
    [`${repoPath}/actions/runs/${hint.sourceRunId}`, jsonResponse(run)],
    [`${repoPath}/actions/runs/${hint.sourceRunId}/artifacts?per_page=100&page=1`, jsonResponse({
      total_count: 1,
      artifacts: [artifact],
    })],
    [`${repoPath}/actions/artifacts/${artifact.id}/zip`, new Response(archive)],
    [`${repoPath}/pulls/${fixture.prNumber}`, jsonResponse(pullRequest(fixture))],
    [`${repoPath}/issues/${fixture.prNumber}/labels?per_page=100&page=1`, jsonResponse([
      { id: 1, name: fixture.merged ? 'trust:quick-review' : 'trust:reject' },
    ])],
    [`${repoPath}/commits/${fixture.headSha}/check-runs?per_page=100&page=1`, jsonResponse({
      total_count: 1,
      check_runs: [{
        id: 1,
        name: 'validate',
        app: { slug: 'github-actions' },
        status: 'completed',
        conclusion: 'success',
      }],
    })],
    [`${repoPath}/collaborators/maintainer/permission`, jsonResponse({
      permission: 'write',
      role_name: 'maintain',
      user: { login: 'maintainer' },
    })],
  ]);
  if (!fixture.merged) {
    routes.set(`${repoPath}/issues/${fixture.prNumber}/timeline?per_page=100&page=1`, jsonResponse([
      { event: 'closed', created_at: '2026-08-01T11:00:00.500Z', actor: { login: 'maintainer' } },
    ]));
  }
  const calls = [];
  return {
    run,
    calls,
    fetch: async (url, options) => {
      const key = `${url.pathname}${url.search}`;
      calls.push({ key, options });
      const response = routes.get(key);
      return response ? response.clone() : jsonResponse({ message: `missing fake route ${key}` }, { status: 404 });
    },
  };
}

function recordArguments(fixture, eventPath) {
  const hint = captureHint(fixture);
  return [
    'record',
    '--event', eventPath,
    '--run-id', hint.sourceRunId,
    '--run-attempt', String(hint.sourceRunAttempt),
    '--checkout', fixture.checkout,
    '--repository-id', REPOSITORY_ID,
    '--repository', REPOSITORY,
    '--remote', 'origin',
    '--remote-url', fixture.remote,
    '--branch', 'main',
  ];
}

async function record(fixture, github) {
  const eventPath = join(fixture.root, `workflow-run-${fixture.prNumber}.json`);
  await writeFile(eventPath, JSON.stringify({ workflow_run: github.run }));
  const reconstructionGitCommands = [];
  const result = await runGithubCli(recordArguments(fixture, eventPath), {
    environment: {
      GITHUB_TOKEN: 'test-token',
      GITHUB_API_URL: API_BASE_URL,
    },
    fetch: github.fetch,
    createGitReader({ checkout }) {
      const reader = createGitReader({ checkout });
      return async (args) => {
        reconstructionGitCommands.push([...args]);
        return reader(args);
      };
    },
  });
  return { result, reconstructionGitCommands };
}

async function remoteLedger(fixture) {
  const text = await git(fixture.remote, 'show', `refs/heads/main:${DECISION_LEDGER_PATH}`);
  return parseLedgerText(`${text}\n`);
}

async function remoteHead(fixture) {
  return git(fixture.remote, 'rev-parse', 'refs/heads/main');
}

async function remoteCommitCount(fixture) {
  return Number(await git(fixture.remote, 'rev-list', '--count', 'refs/heads/main'));
}

async function localCyberbaserRefs(fixture) {
  return git(fixture.checkout, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/cyberbaser');
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe('hermetic WP1 two-stage acceptance', () => {
  test('records a maintainer-authored merged PR through fake GitHub authority and a local bare remote', async () => {
    const fixture = await setupRepository({ prNumber: 101, contributor: 'maintainer' });
    const checkoutHead = await git(fixture.checkout, 'rev-parse', 'HEAD');
    const github = fakeGithub(fixture);
    const { result, reconstructionGitCommands } = await record(fixture, github);
    const [entry] = await remoteLedger(fixture);

    expect(result).toMatchObject({ status: 'published', prNumber: 101, attempts: 1, pushPerformed: true });
    expect(entry).toMatchObject({
      prNumber: 101,
      author: 'maintainer',
      authorType: 'human',
      trustRoute: 'quick-review',
      ofmVerdict: 'clean',
      maintainerDecision: 'merged',
      mergeCommitSha: fixture.mergeSha,
      baseSha: fixture.baseSha,
      headSha: fixture.headSha,
    });
    expect(github.calls.some(({ key }) => key.includes('/pulls?'))).toBe(false);
    expect(await git(fixture.checkout, 'rev-parse', 'HEAD')).toBe(checkoutHead);
    expect(await git(fixture.checkout, 'status', '--porcelain')).toBe('');
    expect(reconstructionGitCommands.some(([command]) => ['checkout', 'switch', 'worktree'].includes(command))).toBe(false);
  });

  test('records a fork PR while treating contributor files only as inert Git objects', async () => {
    const fixture = await setupRepository({
      prNumber: 102,
      fork: true,
      contributor: 'helper-bot',
      includeContributorProgram: true,
    });
    const checkoutHead = await git(fixture.checkout, 'rev-parse', 'HEAD');
    const { result, reconstructionGitCommands } = await record(fixture, fakeGithub(fixture));
    const [entry] = await remoteLedger(fixture);

    expect(result.status).toBe('published');
    expect(entry).toMatchObject({ prNumber: 102, author: 'helper-bot', authorType: 'agent' });
    expect(await exists(fixture.contributorMarker)).toBe(false);
    expect(await git(fixture.checkout, 'rev-parse', 'HEAD')).toBe(checkoutHead);
    expect(await git(fixture.checkout, 'status', '--porcelain')).toBe('');
    expect(reconstructionGitCommands.some(([command]) => ['checkout', 'switch', 'worktree'].includes(command))).toBe(false);
    expect(reconstructionGitCommands).toContainEqual([
      'fetch', '--no-tags', '--no-recurse-submodules', 'origin',
      `+refs/pull/${fixture.prNumber}/head:refs/cyberbaser/ledger/run-${captureHint(fixture).sourceRunId}-pr-${fixture.prNumber}/head`,
    ]);
  });

  test('records a closed-unmerged PR with the unique authoritative timeline actor', async () => {
    const fixture = await setupRepository({ prNumber: 103, merged: false, contributor: 'fork-contributor', fork: true });
    const github = fakeGithub(fixture);
    const { result } = await record(fixture, github);
    const [entry] = await remoteLedger(fixture);

    expect(result.status).toBe('published');
    expect(entry).toMatchObject({
      prNumber: 103,
      maintainerDecision: 'closed-unmerged',
      mergeCommitSha: null,
      trustRoute: 'reject',
    });
    expect(github.calls.some(({ key }) => key.endsWith(`/issues/${fixture.prNumber}/timeline?per_page=100&page=1`))).toBe(true);
  });

  test('duplicate delivery preserves the first row and creates no second commit', async () => {
    const fixture = await setupRepository({ prNumber: 104, contributor: 'maintainer' });
    const github = fakeGithub(fixture);
    const first = await record(fixture, github);
    const firstHead = await remoteHead(fixture);
    const firstCount = await remoteCommitCount(fixture);
    const firstLedger = await git(fixture.remote, 'show', `refs/heads/main:${DECISION_LEDGER_PATH}`);

    const second = await record(fixture, github);
    expect(first.result.status).toBe('published');
    expect(second.result).toMatchObject({
      status: 'already-recorded',
      prNumber: 104,
      commit: null,
      pushPerformed: false,
    });
    expect(await remoteHead(fixture)).toBe(firstHead);
    expect(await remoteCommitCount(fixture)).toBe(firstCount);
    expect(await git(fixture.remote, 'show', `refs/heads/main:${DECISION_LEDGER_PATH}`)).toBe(firstLedger);
    expect((await remoteLedger(fixture))).toHaveLength(1);
  });

  test('tampered artifact fails before any ledger or Git mutation', async () => {
    const fixture = await setupRepository({ prNumber: 105, fork: true, contributor: 'helper-bot' });
    const beforeRemoteHead = await remoteHead(fixture);
    const beforeRemoteCount = await remoteCommitCount(fixture);
    const beforeCheckoutHead = await git(fixture.checkout, 'rev-parse', 'HEAD');
    const beforeRefs = await localCyberbaserRefs(fixture);
    const github = fakeGithub(fixture, {
      artifactHint: { ...captureHint(fixture), prNumber: fixture.prNumber + 1 },
    });
    const eventPath = join(fixture.root, 'tampered-workflow-run.json');
    await writeFile(eventPath, JSON.stringify({ workflow_run: github.run }));
    const reconstructionGitCommands = [];

    await expect(runGithubCli(recordArguments(fixture, eventPath), {
      environment: { GITHUB_TOKEN: 'test-token', GITHUB_API_URL: API_BASE_URL },
      fetch: github.fetch,
        createGitReader({ checkout }) {
        const reader = createGitReader({ checkout });
        return async (args) => {
          reconstructionGitCommands.push([...args]);
          return reader(args);
        };
      },
    })).rejects.toMatchObject({ code: 'artifact-name-mismatch' });

    expect(reconstructionGitCommands).toEqual([]);
    expect(await remoteHead(fixture)).toBe(beforeRemoteHead);
    expect(await remoteCommitCount(fixture)).toBe(beforeRemoteCount);
    expect(await git(fixture.checkout, 'rev-parse', 'HEAD')).toBe(beforeCheckoutHead);
    expect(await git(fixture.checkout, 'status', '--porcelain')).toBe('');
    expect(await localCyberbaserRefs(fixture)).toBe(beforeRefs);
    expect(await exists(join(fixture.checkout, DECISION_LEDGER_PATH))).toBe(false);
    expect(await exists(fixture.contributorMarker)).toBe(false);
    await expect(readFile(join(fixture.checkout, DECISION_LEDGER_PATH))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { appendLedgerEntryFile } from '../cli.js';
import { validateLedgerEntry } from '../ledger.js';
import { LedgerGithubError } from './contract.js';

const execFileAsync = promisify(execFile);
const COMMIT_RE = /^[0-9a-f]{40}$/;
const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_PUBLICATION_ATTEMPTS = 3;
const BOT_NAME = 'Cyberbaser Ledger Bot';
const BOT_EMAIL = 'cyberbaser-ledger[bot]@users.noreply.github.com';

export const DECISION_LEDGER_PATH = '.cyberbaser/decision-ledger.jsonl';

function fail(code, message, details = {}, exitCode = 4) {
  throw new LedgerGithubError(code, message, details, exitCode);
}

function invalid(code, message, details = {}) {
  fail(code, message, details, 2);
}

function exactCommit(value, label) {
  if (typeof value !== 'string' || !COMMIT_RE.test(value)) {
    fail('invalid-git-commit', `${label} must be one lowercase 40-character Git commit ID`);
  }
  return value;
}

function branchName(value) {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > 255
    || value === '@'
    || value.startsWith('/')
    || value.endsWith('/')
    || value.endsWith('.')
    || value.includes('..')
    || value.includes('//')
    || value.includes('@{')
    || /[ ~^:?*[\\\p{Cc}]/u.test(value)
    || value.split('/').some((segment) => segment.startsWith('.') || segment.endsWith('.lock'))) {
    invalid('invalid-publication-branch', 'branch must be one exact safe Git branch name');
  }
  return value;
}

function remoteName(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    invalid('invalid-publication-remote', 'remote must be one exact configured Git remote name');
  }
  return value;
}

function remoteUrl(value) {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > 4096
    || value.trim() !== value
    || /[\r\n\0]/.test(value)) {
    invalid('invalid-publication-remote-url', 'remoteUrl must be one exact configured Git destination');
  }
  return value;
}

function attempts(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PUBLICATION_ATTEMPTS) {
    invalid(
      'invalid-publication-attempts',
      `maxAttempts must be a positive integer no greater than ${MAX_PUBLICATION_ATTEMPTS}`,
    );
  }
  return value;
}

function commandEnvironment(environment = process.env) {
  return {
    ...environment,
    GIT_TERMINAL_PROMPT: '0',
    GIT_EDITOR: ':',
    GIT_SEQUENCE_EDITOR: ':',
  };
}

async function rawGit(checkout, args, { encoding = 'buffer', env = process.env } = {}) {
  try {
    const result = await execFileAsync('git', ['-C', checkout, ...args], {
      encoding,
      env: commandEnvironment(env),
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      windowsHide: true,
    });
    return encoding === 'buffer' ? Buffer.from(result.stdout) : String(result.stdout).trim();
  } catch (error) {
    const wrapped = new Error(`git ${args[0] ?? 'command'} failed`);
    wrapped.exitCode = Number.isSafeInteger(error?.code) ? error.code : null;
    throw wrapped;
  }
}

async function inspectionGit(checkout, args, options) {
  try {
    return await rawGit(checkout, args, options);
  } catch (error) {
    fail('git-publication-inspection-failed', `git ${args[0] ?? 'command'} failed during ledger publication`, {
      exitCode: error.exitCode,
    });
  }
}

function dependencies(overrides = {}) {
  return {
    git: inspectionGit,
    mutateGit: rawGit,
    appendLedger: appendLedgerEntryFile,
    makeTemporaryDirectory: (prefix) => mkdtemp(prefix),
    removeDirectory: (target) => rm(target, { recursive: true, force: true }),
    ...overrides,
  };
}

async function mutate(deps, checkout, args, code, message, options) {
  try {
    return await deps.mutateGit(checkout, args, options);
  } catch (error) {
    fail(code, message, { exitCode: error.exitCode });
  }
}

async function assertCheckout(checkout, git) {
  if (typeof checkout !== 'string' || !path.isAbsolute(checkout) || path.normalize(checkout) !== checkout) {
    invalid('invalid-publication-checkout', 'checkout must be one normalized absolute path');
  }
  const root = await git(checkout, ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (path.resolve(root) !== checkout) {
    invalid('publication-checkout-not-root', 'checkout must identify the exact Git worktree root');
  }
}

function parseLines(value) {
  return value === '' ? [] : value.split('\n');
}

async function assertRemoteDestination(checkout, remote, expectedUrl, git) {
  const [fetchText, pushText] = await Promise.all([
    git(checkout, ['remote', 'get-url', '--all', remote], { encoding: 'utf8' }),
    git(checkout, ['remote', 'get-url', '--push', '--all', remote], { encoding: 'utf8' }),
  ]);
  const fetchUrls = parseLines(fetchText);
  const pushUrls = parseLines(pushText);
  if (
    fetchUrls.length !== 1
    || pushUrls.length !== 1
    || fetchUrls[0] !== expectedUrl
    || pushUrls[0] !== expectedUrl
  ) {
    fail(
      'remote-destination-mismatch',
      'configured Git fetch and push destinations must both equal the trusted base repository destination',
      {
        fetchDestinationCount: fetchUrls.length,
        pushDestinationCount: pushUrls.length,
        fetchMatches: fetchUrls.length === 1 && fetchUrls[0] === expectedUrl,
        pushMatches: pushUrls.length === 1 && pushUrls[0] === expectedUrl,
      },
      2,
    );
  }
}

async function exactRemoteRef(checkout, remote, branch, git) {
  const ref = `refs/heads/${branch}`;
  const output = await git(checkout, ['ls-remote', '--refs', remote, ref], { encoding: 'utf8' });
  if (output === '') return null;
  const lines = output.split('\n');
  if (lines.length !== 1) fail('remote-ref-ambiguous', 'configured remote returned more than one exact branch ref');
  const match = lines[0].match(/^([0-9a-f]{40})\trefs\/heads\/([^\s]+)$/);
  if (!match || match[2] !== branch) {
    fail('remote-ref-invalid', 'configured remote returned an invalid exact branch ref');
  }
  return match[1];
}

function branchRace(expectedBase, remoteHead, stage) {
  return new LedgerGithubError(
    'branch-advance-race',
    'the publication branch advanced during ledger publication',
    { expectedBase, remoteHead, stage, retryable: true },
    4,
  );
}

async function requireFastForwardAdvance({ git, checkout, expectedBase, advancedHead, stage }) {
  const next = exactCommit(advancedHead, 'advanced remote branch tip');
  if (next === expectedBase) {
    fail('publication-branch-unstable', 'publication branch changed and returned to the accepted base', { stage });
  }
  const missingFromAdvanced = await git(
    checkout,
    ['rev-list', '--count', `${next}..${expectedBase}`],
    { encoding: 'utf8' },
  );
  if (!/^\d+$/.test(missingFromAdvanced)) {
    fail('invalid-ancestry-result', 'Git returned an invalid publication ancestry count');
  }
  if (missingFromAdvanced !== '0') {
    fail(
      'publication-branch-not-fast-forward',
      'publication branch changed by rewind or divergent update; automatic retry is forbidden',
      { expectedBase, advancedHead: next, stage },
    );
  }
  return branchRace(expectedBase, next, stage);
}

async function classifyRemoteAdvance({
  deps,
  checkout,
  remote,
  branch,
  expectedBase,
  observedHead,
  stage,
}) {
  if (observedHead === null) {
    fail('publication-branch-disappeared', 'publication branch disappeared during ledger publication', { stage });
  }
  exactCommit(observedHead, 'observed remote branch tip');
  const raceRef = `refs/cyberbaser/ledger/race/${randomBytes(12).toString('hex')}`;
  try {
    await mutate(
      deps,
      checkout,
      ['fetch', '--no-tags', '--no-recurse-submodules', remote, `refs/heads/${branch}:${raceRef}`],
      'ledger-race-fetch-failed',
      'Git could not fetch the advanced publication branch for classification',
    );
    const fetchedHead = exactCommit(
      await deps.git(checkout, ['rev-parse', '--verify', `${raceRef}^{commit}`], { encoding: 'utf8' }),
      'fetched advanced publication tip',
    );
    return await requireFastForwardAdvance({
      git: deps.git,
      checkout,
      expectedBase,
      advancedHead: fetchedHead,
      stage,
    });
  } finally {
    try {
      await deps.mutateGit(checkout, ['update-ref', '-d', raceRef]);
    } catch (error) {
      fail('publication-cleanup-failed', 'Git could not delete the temporary race-classification ref', {
        exitCode: error.exitCode,
      });
    }
  }
}

function parseNul(value) {
  const records = Buffer.from(value).toString('utf8').split('\0');
  if (records.at(-1) === '') records.pop();
  return records;
}

async function ensureSafeLedgerPath(worktree) {
  const directory = path.join(worktree, '.cyberbaser');
  const ledger = path.join(worktree, DECISION_LEDGER_PATH);
  let directoryStat;
  try {
    directoryStat = await lstat(directory);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (directoryStat === undefined) {
    await mkdir(directory, { mode: 0o755 });
  } else if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    fail('unsafe-ledger-directory', '.cyberbaser must be a real directory in the publication base');
  }

  try {
    const ledgerStat = await lstat(ledger);
    if (!ledgerStat.isFile() || ledgerStat.isSymbolicLink() || ledgerStat.nlink !== 1) {
      fail('unsafe-ledger-path', `${DECISION_LEDGER_PATH} must be one regular, unlinked file`);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return ledger;
}

async function assertDetachedWorktree(worktree, expectedBase, git) {
  const [head, branch] = await Promise.all([
    git(worktree, ['rev-parse', 'HEAD'], { encoding: 'utf8' }),
    git(worktree, ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }),
  ]);
  if (head !== expectedBase || branch !== 'HEAD') {
    fail('publication-worktree-mismatch', 'fresh publication worktree must be detached at the accepted remote tip', {
      expectedBase,
      head,
      detached: branch === 'HEAD',
    });
  }
}

async function assertOnlyLedgerChanged(worktree, git) {
  const [statusBytes, stagedBytes] = await Promise.all([
    git(worktree, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.']),
    git(worktree, ['diff', '--cached', '--name-only', '-z', '--']),
  ]);
  const status = parseNul(statusBytes);
  const staged = parseNul(stagedBytes);
  const allowed = new Set([` M ${DECISION_LEDGER_PATH}`, `?? ${DECISION_LEDGER_PATH}`]);
  if (status.length !== 1 || !allowed.has(status[0])) {
    fail('ledger-worktree-mismatch', `only ${DECISION_LEDGER_PATH} may change before publication`, {
      status: status.slice(0, 20),
    });
  }
  if (staged.length !== 0) {
    fail('ledger-index-not-empty', 'fresh publication worktree index must be empty before staging', {
      staged: staged.slice(0, 20),
    });
  }
}

async function assertCleanWorktree(worktree, git) {
  const status = parseNul(await git(
    worktree,
    ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.'],
  ));
  if (status.length !== 0) {
    fail('post-publication-worktree-dirty', 'publication worktree must be clean', { status: status.slice(0, 20) });
  }
}

function commitMessage(entry) {
  return `Record decision ledger entry for PR #${entry.prNumber}`;
}

async function createLedgerCommit({ deps, worktree, acceptedBase, entry, ledgerFile }) {
  await assertOnlyLedgerChanged(worktree, deps.git);
  await mutate(
    deps,
    worktree,
    ['add', '--', DECISION_LEDGER_PATH],
    'ledger-stage-failed',
    'Git could not stage the exact decision-ledger path',
  );
  const staged = parseNul(await deps.git(worktree, ['diff', '--cached', '--name-only', '-z', '--']));
  if (staged.length !== 1 || staged[0] !== DECISION_LEDGER_PATH) {
    fail('ledger-index-mismatch', `Git index must contain exactly ${DECISION_LEDGER_PATH}`, { staged });
  }

  const message = commitMessage(entry);
  const identityEnvironment = {
    ...process.env,
    GIT_AUTHOR_NAME: BOT_NAME,
    GIT_AUTHOR_EMAIL: BOT_EMAIL,
    GIT_COMMITTER_NAME: BOT_NAME,
    GIT_COMMITTER_EMAIL: BOT_EMAIL,
  };
  await mutate(
    deps,
    worktree,
    [
      '-c', 'core.hooksPath=/dev/null',
      'commit', '--no-gpg-sign', '--no-verify', '-m', message,
    ],
    'ledger-commit-failed',
    'Git could not create the factual decision-ledger bot commit',
    { encoding: 'utf8', env: identityEnvironment },
  );

  const commit = exactCommit(
    await deps.git(worktree, ['rev-parse', 'HEAD'], { encoding: 'utf8' }),
    'publication commit',
  );
  const ancestry = (await deps.git(
    worktree,
    ['rev-list', '--parents', '-n', '1', commit],
    { encoding: 'utf8' },
  )).split(/\s+/);
  if (ancestry.length !== 2 || ancestry[0] !== commit || ancestry[1] !== acceptedBase) {
    fail('ledger-commit-parent-mismatch', 'ledger commit must have exactly one parent equal to the accepted remote tip');
  }
  const committedMessage = await deps.git(
    worktree,
    ['show', '-s', '--format=%B', commit],
    { encoding: 'utf8' },
  );
  if (committedMessage !== message) {
    fail('ledger-commit-message-mismatch', 'ledger commit message must equal the factual bot message');
  }
  const changedPaths = parseNul(await deps.git(worktree, [
    'diff-tree', '--no-commit-id', '--name-only', '-r', '-z', '--no-renames',
    acceptedBase, commit, '--',
  ]));
  if (changedPaths.length !== 1 || changedPaths[0] !== DECISION_LEDGER_PATH) {
    fail('ledger-commit-path-mismatch', `ledger commit must change exactly ${DECISION_LEDGER_PATH}`, {
      changedPaths,
    });
  }
  const [workingBytes, committedBytes] = await Promise.all([
    readFile(ledgerFile),
    deps.git(worktree, ['show', `${commit}:${DECISION_LEDGER_PATH}`]),
  ]);
  if (!Buffer.from(committedBytes).equals(workingBytes)) {
    fail('ledger-commit-bytes-mismatch', 'committed ledger bytes must equal the validated appended ledger bytes');
  }
  await assertCleanWorktree(worktree, deps.git);
  return { commit, message };
}

async function cleanupAttempt({ deps, checkout, root, worktree, localRef }) {
  let removedByGit = false;
  try {
    await deps.mutateGit(checkout, ['worktree', 'remove', worktree]);
    removedByGit = true;
  } catch {
    await deps.removeDirectory(root);
    try {
      await deps.mutateGit(checkout, ['worktree', 'prune']);
    } catch (error) {
      fail('publication-cleanup-failed', 'Git could not prune the fresh publication worktree', {
        exitCode: error.exitCode,
      });
    }
  }
  if (removedByGit) await deps.removeDirectory(root);
  try {
    await deps.mutateGit(checkout, ['update-ref', '-d', localRef]);
  } catch (error) {
    fail('publication-cleanup-failed', 'Git could not delete the temporary publication ref', {
      exitCode: error.exitCode,
    });
  }
}

async function publicationAttempt({
  deps,
  checkout,
  remote,
  expectedRemoteUrl,
  branch,
  entry,
  attempt,
}) {
  await assertRemoteDestination(checkout, remote, expectedRemoteUrl, deps.git);
  const observedBase = await exactRemoteRef(checkout, remote, branch, deps.git);
  if (observedBase === null) {
    fail('missing-publication-branch', 'trusted base repository does not contain the configured default branch');
  }
  const acceptedBase = exactCommit(observedBase, 'remote branch tip');
  const nonce = randomBytes(12).toString('hex');
  const localRef = `refs/cyberbaser/ledger/publication/${nonce}`;
  await mutate(
    deps,
    checkout,
    ['fetch', '--no-tags', '--no-recurse-submodules', remote, `refs/heads/${branch}:${localRef}`],
    'ledger-fetch-failed',
    'Git could not fetch the exact publication branch',
  );
  const fetchedBase = exactCommit(
    await deps.git(checkout, ['rev-parse', '--verify', `${localRef}^{commit}`], { encoding: 'utf8' }),
    'fetched publication tip',
  );
  if (fetchedBase !== acceptedBase) {
    try {
      await deps.mutateGit(checkout, ['update-ref', '-d', localRef]);
    } catch (error) {
      fail('publication-cleanup-failed', 'Git could not delete the temporary publication ref', {
        exitCode: error.exitCode,
      });
    }
    throw await requireFastForwardAdvance({
      git: deps.git,
      checkout,
      expectedBase: acceptedBase,
      advancedHead: fetchedBase,
      stage: 'fetch',
    });
  }

  const root = await deps.makeTemporaryDirectory(path.join(tmpdir(), 'cb-ledger-publication-'));
  const worktree = path.join(root, 'worktree');
  let shouldCleanup = false;
  try {
    await mutate(
      deps,
      checkout,
      ['worktree', 'add', '--detach', worktree, acceptedBase],
      'ledger-worktree-create-failed',
      'Git could not create a fresh detached ledger publication worktree',
    );
    shouldCleanup = true;
    await assertDetachedWorktree(worktree, acceptedBase, deps.git);
    const ledgerFile = await ensureSafeLedgerPath(worktree);
    let append;
    try {
      append = await deps.appendLedger(ledgerFile, entry);
    } catch (error) {
      if (error?.code) throw error;
      fail('ledger-append-failed', 'the existing decision ledger could not be validated and appended');
    }

    if (append.status !== 'appended') {
      await assertCleanWorktree(worktree, deps.git);
      const current = await exactRemoteRef(checkout, remote, branch, deps.git);
      if (current !== acceptedBase) {
        throw await classifyRemoteAdvance({
          deps,
          checkout,
          remote,
          branch,
          expectedBase: acceptedBase,
          observedHead: current,
          stage: 'duplicate-verification',
        });
      }
      return {
        status: append.status,
        attempts: attempt,
        append,
        baseCommit: acceptedBase,
        commit: null,
        pushPerformed: false,
      };
    }

    const committed = await createLedgerCommit({
      deps,
      worktree,
      acceptedBase,
      entry,
      ledgerFile,
    });
    const beforePush = await exactRemoteRef(checkout, remote, branch, deps.git);
    if (beforePush !== acceptedBase) {
      throw await classifyRemoteAdvance({
        deps,
        checkout,
        remote,
        branch,
        expectedBase: acceptedBase,
        observedHead: beforePush,
        stage: 'pre-push',
      });
    }

    const refspec = `${committed.commit}:refs/heads/${branch}`;
    let pushFailure = null;
    try {
      await deps.mutateGit(
        worktree,
        [
          '-c', 'core.hooksPath=/dev/null',
          '-c', `remote.${remote}.mirror=false`,
          '-c', 'push.followTags=false',
          'push', '--porcelain', '--no-verify', '--no-follow-tags', '--recurse-submodules=no', remote, refspec,
        ],
        { encoding: 'utf8' },
      );
    } catch (error) {
      pushFailure = error;
    }
    const remoteHead = await exactRemoteRef(checkout, remote, branch, deps.git);
    if (remoteHead !== committed.commit) {
      if (remoteHead !== acceptedBase) {
        throw await classifyRemoteAdvance({
          deps,
          checkout,
          remote,
          branch,
          expectedBase: pushFailure === null ? committed.commit : acceptedBase,
          observedHead: remoteHead,
          stage: 'post-push',
        });
      }
      if (pushFailure !== null) {
        fail('ledger-push-failed', 'exact non-force ledger push failed and the remote branch remained unchanged', {
          exitCode: pushFailure.exitCode,
          forceUsed: false,
        });
      }
      fail('post-push-verification-failed', 'Git reported success but the exact ledger commit is not the remote branch tip', {
        expectedCommit: committed.commit,
        remoteHead,
        forceUsed: false,
      });
    }

    return {
      status: 'published',
      attempts: attempt,
      append,
      baseCommit: acceptedBase,
      commit: committed.commit,
      message: committed.message,
      refspec,
      remoteRef: remoteHead,
      pushPerformed: true,
      forceUsed: false,
    };
  } finally {
    if (shouldCleanup) {
      await cleanupAttempt({ deps, checkout, root, worktree, localRef });
    } else {
      await deps.removeDirectory(root);
      try {
        await deps.mutateGit(checkout, ['update-ref', '-d', localRef]);
      } catch (error) {
        fail('publication-cleanup-failed', 'Git could not delete the temporary publication ref', {
          exitCode: error.exitCode,
        });
      }
    }
  }
}

export async function publishLedgerEntry({
  checkout,
  entry: candidate,
  remote = 'origin',
  remoteUrl: expectedUrl,
  branch,
  maxAttempts = MAX_PUBLICATION_ATTEMPTS,
} = {}, overrides = {}) {
  const deps = dependencies(overrides);
  const normalizedEntry = validateLedgerEntry(candidate);
  const targetRemote = remoteName(remote);
  const targetRemoteUrl = remoteUrl(expectedUrl);
  const targetBranch = branchName(branch);
  const boundedAttempts = attempts(maxAttempts);
  await assertCheckout(checkout, deps.git);

  let lastRace = null;
  for (let attempt = 1; attempt <= boundedAttempts; attempt += 1) {
    try {
      return await publicationAttempt({
        deps,
        checkout,
        remote: targetRemote,
        expectedRemoteUrl: targetRemoteUrl,
        branch: targetBranch,
        entry: normalizedEntry,
        attempt,
      });
    } catch (error) {
      if (!(error instanceof LedgerGithubError) || error.code !== 'branch-advance-race') throw error;
      lastRace = error;
    }
  }
  fail(
    'branch-advance-retry-exhausted',
    `publication branch advanced during all ${boundedAttempts} bounded attempts`,
    { attempts: boundedAttempts, lastRace: lastRace?.details ?? null },
  );
}

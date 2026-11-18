// The forge watcher: the intake service's second ear.
//
// The service already holds the proposal queue's only writer lock for the
// public form. This module lets the same process watch one Forgejo repository
// for open pull requests, read each one through the Lane A adapter with its
// own private clone, and enqueue the exact suggestion as a Lane A entry with
// the author's forge identity attached. It is read-only towards the forge:
// no comments, labels, merges, closes, or pushes. It writes only to its
// private clone (retained refs) and to the queue through the open writer.

import { execFile } from 'node:child_process';
import { lstat, mkdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import {
  createForgejoApi,
  createForgejoGitReader,
  createTokenFileReader,
  deriveForgejoPullRequestProposal,
  ForgejoIntakeError,
} from '@cyberbaser/forgejo-intake';
import { digestBytes, ProposalQueueError } from '@cyberbaser/proposal-queue';

const execFileAsync = promisify(execFile);
const RETAINED_REF_ROOT = 'refs/cyberbaser/lane-a/retained';
const GIT_ENV = Object.freeze({
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_ASKPASS: '',
  SSH_ASKPASS: '',
  LC_ALL: 'C',
  PATH: process.env.PATH ?? '/usr/bin:/bin',
});

export class ForgejoWatcherError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ForgejoWatcherError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new ForgejoWatcherError(code, message, details);
}

/** The adapter's own config shape, derived from the service config. */
export function laneAConfig(forgejo) {
  return Object.freeze({
    schemaVersion: 1,
    forgejo: { apiBaseUrl: forgejo.apiBaseUrl },
    repository: {
      url: forgejo.repository.url,
      owner: forgejo.repository.owner,
      name: forgejo.repository.name,
      baseBranch: forgejo.repository.baseBranch,
    },
  });
}

/** The Lane A request digest: deterministic, so polling can never enqueue twice. */
export function laneARequestDigest({ repositoryId, pullRequestNumber, headSha }) {
  return digestBytes(Buffer.from(`lane-a\0${repositoryId}\0${pullRequestNumber}\0${headSha}`, 'utf8'));
}

function defaultExecute({ command, args, maxBytes }) {
  return execFileAsync(command, args, { encoding: 'buffer', maxBuffer: maxBytes, env: { ...GIT_ENV }, windowsHide: true })
    .then(({ stdout }) => ({ stdout, exitCode: 0 }))
    .catch((error) => {
      if (Number.isSafeInteger(error?.code)) return { stdout: error.stdout ?? Buffer.alloc(0), exitCode: error.code };
      throw error;
    });
}

/**
 * The watcher's private clone: created on first use, remote fixed to the
 * configured repository, automatic gc off so retained objects stay put.
 */
export async function prepareForgejoClone({ cloneDir, repositoryUrl, execute = defaultExecute }) {
  const run = async (args, { allowFailure = false } = {}) => {
    const result = await execute({ command: 'git', args: ['-C', cloneDir, ...args], maxBytes: 1024 * 1024 });
    if (result.exitCode !== 0 && !allowFailure) fail('clone-git-failed', `git ${args[0]} failed in the watcher clone`, { exitCode: result.exitCode });
    return Buffer.from(result.stdout ?? Buffer.alloc(0)).toString('utf8').trim();
  };
  let exists = false;
  try {
    const metadata = await lstat(cloneDir);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail('clone-dir-invalid', 'forgejo.cloneDir must be a real directory');
    exists = true;
  } catch (error) {
    if (error instanceof ForgejoWatcherError) throw error;
    if (error?.code !== 'ENOENT') throw error;
  }
  if (!exists) await mkdir(cloneDir, { recursive: true, mode: 0o700 });
  const inside = await run(['rev-parse', '--is-inside-work-tree'], { allowFailure: true });
  if (inside !== 'true') {
    await run(['init', '-q', '--initial-branch=main']);
    await run(['remote', 'add', 'origin', repositoryUrl]);
    await run(['config', 'gc.auto', '0']);
    await run(['config', 'fetch.fsckObjects', 'true']);
  }
  const remote = await run(['remote', 'get-url', 'origin'], { allowFailure: true });
  if (remote !== repositoryUrl) fail('clone-remote-mismatch', 'the watcher clone remote does not name the configured repository', { remote });
  return cloneDir;
}

/**
 * Create the watcher. `queue` is the open proposal queue (the one writer).
 * `fetch`, `execute`, `getToken`, and `clock` default to the real ones; tests
 * inject fakes. Nothing starts until `start()`; `pollOnce()` drives one round.
 */
export function createForgejoWatcher({
  config,
  queue,
  fetch: fetchImpl = globalThis.fetch,
  execute = defaultExecute,
  getToken = null,
  clock = () => new Date(),
  log = () => {},
} = {}) {
  if (!config?.forgejo?.enabled) fail('watcher-disabled', 'the forge watcher requires an enabled forgejo config block');
  if (!queue || typeof queue.enqueue !== 'function' || !queue.review || typeof queue.review.list !== 'function') {
    fail('invalid-watcher-queue', 'the forge watcher requires the open proposal queue');
  }
  const { forgejo } = config;
  const adapterConfig = laneAConfig(forgejo);
  const tokenReader = getToken ?? (forgejo.tokenFile === null ? null : createTokenFileReader(forgejo.tokenFile));
  const api = createForgejoApi({ fetch: fetchImpl, getToken: tokenReader });
  const git = createForgejoGitReader({ checkout: forgejo.cloneDir, execute: execute === defaultExecute ? null : execute });
  const seen = new Set();
  const skipped = new Map();
  let clonePrepared = null;
  let seenLoaded = null;
  let polling = null;
  let timer = null;
  const stats = { polls: 0, enqueued: 0, replayed: 0, skipped: 0, failures: 0, lastPollAt: null, lastError: null };

  const seenKey = (number, headSha) => `${number}:${headSha}`;

  async function loadSeen() {
    for (const state of ['pending-review', 'expired']) {
      const entries = await queue.review.list({ state });
      for (const entry of entries) {
        if (entry.carrier.lane !== 'lane-a') continue;
        seen.add(seenKey(entry.carrier.metadata.pullRequestNumber, entry.carrier.metadata.headSha));
      }
    }
  }

  // The clone is needed by recovery before the queue is open to callers; the
  // seen set needs the open queue. Prepare them separately.
  async function prepareClone() {
    clonePrepared ??= prepareForgejoClone({ cloneDir: forgejo.cloneDir, repositoryUrl: forgejo.repository.url, execute });
    return clonePrepared;
  }

  async function prepare() {
    await prepareClone();
    seenLoaded ??= loadSeen();
    return seenLoaded;
  }

  async function retainBase(baseSha) {
    // Objects fetched into the reader's temporary refs are unreachable once
    // those refs are removed; a retained ref keeps the base commit for recovery.
    const result = await execute({
      command: 'git',
      args: ['-C', forgejo.cloneDir, 'fetch', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', 'origin', `+${baseSha}:${RETAINED_REF_ROOT}/${baseSha}`],
      maxBytes: 1024 * 1024,
    });
    if (result.exitCode !== 0) fail('retain-base-failed', 'the watcher could not retain the base commit', { exitCode: result.exitCode });
  }

  async function ingest(listed) {
    const key = seenKey(listed.number, listed.headSha);
    const snapshot = await api.readPullRequest({ config: adapterConfig, pullRequestNumber: listed.number });
    const gitEvidence = await git.readPullRequest({
      config: adapterConfig,
      pullRequestNumber: listed.number,
      baseSha: snapshot.pullRequest.baseSha,
      headSha: snapshot.pullRequest.headSha,
    });
    const result = deriveForgejoPullRequestProposal({ config: adapterConfig, pullRequestNumber: listed.number, snapshot, gitEvidence });
    await retainBase(gitEvidence.baseSha);
    const metadata = { repositoryId: snapshot.repository.id, pullRequestNumber: listed.number, headSha: snapshot.pullRequest.headSha };
    const queued = await queue.enqueue({
      proposalText: result.proposalText,
      baseBytes: gitEvidence.baseBytes,
      policy: gitEvidence.policy,
      verifiedSubject: result.verifiedSubject,
      carrier: { lane: 'lane-a', metadata },
      idempotency: { scope: 'lane-a', key: null, requestDigest: laneARequestDigest(metadata) },
    });
    seen.add(key);
    if (queued.replayed) stats.replayed += 1;
    else stats.enqueued += 1;
    log({ event: 'lane-a-enqueued', pullRequestNumber: listed.number, headSha: listed.headSha, queueId: queued.receipt.queueId, replayed: queued.replayed });
    return queued;
  }

  async function pollOnce() {
    if (polling !== null) return polling;
    polling = (async () => {
      await prepare();
      stats.polls += 1;
      stats.lastPollAt = clock().toISOString();
      const outcome = { listed: 0, enqueued: [], skipped: [], failed: [] };
      let listing;
      try {
        listing = await api.listOpenPullRequests({ config: adapterConfig });
      } catch (error) {
        stats.failures += 1;
        stats.lastError = error?.code ?? 'list-failed';
        log({ event: 'lane-a-list-failed', code: stats.lastError });
        return Object.freeze(outcome);
      }
      for (const listed of listing.pullRequests) {
        outcome.listed += 1;
        if (!listed.open || listed.draft) continue;
        const key = seenKey(listed.number, listed.headSha);
        if (seen.has(key) || skipped.has(key)) continue;
        try {
          const queued = await ingest(listed);
          outcome.enqueued.push({ pullRequestNumber: listed.number, headSha: listed.headSha, queueId: queued.receipt.queueId, replayed: queued.replayed });
        } catch (error) {
          if (error instanceof ForgejoIntakeError) {
            // The adapter refused this head: it is not a version 1 suggestion.
            // Remember it so the forge is not asked again until the head changes.
            skipped.set(key, error.code);
            stats.skipped += 1;
            outcome.skipped.push({ pullRequestNumber: listed.number, headSha: listed.headSha, code: error.code });
            log({ event: 'lane-a-skipped', pullRequestNumber: listed.number, headSha: listed.headSha, code: error.code });
          } else {
            stats.failures += 1;
            stats.lastError = error?.code ?? error?.name ?? 'ingest-failed';
            outcome.failed.push({ pullRequestNumber: listed.number, headSha: listed.headSha, code: stats.lastError });
            log({ event: 'lane-a-ingest-failed', pullRequestNumber: listed.number, headSha: listed.headSha, code: stats.lastError });
            if (!(error instanceof ProposalQueueError) && !(error instanceof ForgejoWatcherError)) throw error;
          }
        }
      }
      return Object.freeze(outcome);
    })();
    try {
      return await polling;
    } finally {
      polling = null;
    }
  }

  /**
   * Recovery evidence for one durable Lane A entry, from the clone's retained
   * objects only. Shape matches the queue's resolveEvidence contract.
   */
  async function resolveEvidence(entry) {
    if (entry.carrier.lane !== 'lane-a') fail('unsupported-queue-lane', 'the forge watcher resolves Lane A entries only');
    if (entry.proposal.source.repository !== forgejo.repository.url) {
      fail('repository-binding-mismatch', 'durable Lane A proposal names a repository this watcher does not follow');
    }
    await prepareClone();
    const retained = await git.readRetained({ revision: entry.proposal.source.revision, path: entry.proposal.source.path });
    return Object.freeze({ baseBytes: retained.baseBytes, policy: retained.policy });
  }

  function start() {
    if (timer !== null) return;
    timer = setInterval(() => { pollOnce().catch((error) => log({ event: 'lane-a-poll-crashed', code: error?.code ?? error?.name ?? 'unknown' })); }, forgejo.pollIntervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    pollOnce().catch((error) => log({ event: 'lane-a-poll-crashed', code: error?.code ?? error?.name ?? 'unknown' }));
  }

  function stop() {
    if (timer !== null) clearInterval(timer);
    timer = null;
  }

  return Object.freeze({
    pollOnce,
    resolveEvidence,
    start,
    stop,
    prepare,
    state: () => Object.freeze({ ...stats, running: timer !== null, seen: seen.size, skipped: skipped.size }),
  });
}

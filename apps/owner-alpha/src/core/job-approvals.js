// Offer every job that waits for the owner's approval to the signing device.
//
// A job parks in `awaiting-approval` when the publisher refuses its push for
// want of a signature (pipeline.js). Whenever a device asks what is waiting,
// this turns each such job into one approval request: a fresh publisher
// challenge, the publish intent described from the committed Git objects, and
// the exact before and after bytes the device hashes and shows. When the
// device signs, the approval is attached to the job and the job resumes; the
// publisher then checks the signature and the commit itself. No restart, no
// disk state of its own: after a restart the jobs are simply offered again.
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readJsonArtifact } from '../artifacts.js';
import { listDurableJobs } from '../job-state.js';
import { attachOwnerApproval, pipelineArtifactPaths } from '../pipeline.js';
import { describePublish, gitIn, publishIntent } from '../signed-publish.js';
import { APPROVAL_KEY_PLACEHOLDER } from './approvals.js';

export const NOT_NOW_MS = 15 * 60_000;
const STARTER_FILE = 'starter-pending.json';

/**
 * The starter publish.yml commit setup prepared and nobody has approved yet.
 * Kept beside the node's device records (owner-only, outside the vault) so a
 * restart still offers it. { read() -> commit | null, save(commit), clear() }.
 */
export function pendingStarterFile(directory) {
  const file = path.join(directory, STARTER_FILE);
  return Object.freeze({
    async read() {
      try {
        const value = JSON.parse(await readFile(file, 'utf8'));
        return typeof value?.commit === 'string' && /^[0-9a-f]{40}$/u.test(value.commit) ? value.commit : null;
      } catch { return null; }
    },
    async save(commit) {
      if (!/^[0-9a-f]{40}$/u.test(commit ?? '')) throw new TypeError('starter commit must be 40 hex');
      await writeFile(file, `${JSON.stringify({ v: 1, commit })}\n`, { mode: 0o600 });
    },
    clear: () => rm(file, { force: true }),
  });
}

async function committedCommit(context, jobId) {
  const committed = await readJsonArtifact(context, pipelineArtifactPaths(jobId).committed);
  return committed?.result?.commit;
}

// starter: pendingStarterFile(...) or null. publishStarter({ commit, record }):
// the publisher's signed publish-starter; then the checkout moves to the commit
// and afterStarter() runs (the node rebuilds its preview: the vault may have
// published nothing before).
export function createJobApprovals({ config, context, pipeline, listJobs = listDurableJobs, git = gitIn(config.repository.checkout),
  readCommit = committedCommit, attach = attachOwnerApproval, clock = Date.now, log = () => {},
  starter = null, publishStarter = null, afterStarter = async () => {} }) {
  const offered = new Map(); // jobId -> requestId
  const quiet = new Map(); // jobId -> time before which it is not offered again ("Not now", or it could not be offered)
  let running = null;

  async function describe(relay, commit) {
    const description = await describePublish({ git, commit, remote: config.repository.remote.url, branch: config.repository.branch });
    const blob = async (revision, path) => (await git(['cat-file', 'blob', `${revision}:${path}`])).toString('base64');
    const files = [];
    for (const change of description.changes) {
      files.push({ path: change.path, before: change.before === null ? null : await blob(description.base, change.path),
        after: change.after === null ? null : await blob(commit, change.path) });
    }
    const challenge = await relay.challenge();
    const intent = publishIntent({ challenge, keyId: APPROVAL_KEY_PLACEHOLDER, description });
    return relay.request({ intent, files, askedBy: 'Your node' });
  }

  async function offer(relay, jobId) {
    const commit = await readCommit(context, jobId);
    if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/u.test(commit)) throw new Error('job has no commit');
    const { requestId, result } = await describe(relay, commit);
    offered.set(jobId, requestId);
    result.then(async (record) => {
      offered.delete(jobId);
      await attach({ context, config, jobId, record });
      await pipeline.resumeJob({ jobId });
    }, (error) => {
      offered.delete(jobId);
      if (error?.code === 'approval-declined') quiet.set(jobId, clock() + NOT_NOW_MS);
    }).catch((error) => log(`approval for ${jobId} could not resume the job: ${error?.code ?? 'failed'}`));
  }

  // Setup's starter publish.yml: signed like any publish, pushed by the
  // publisher's own publish-starter check, then the checkout moves to it.
  async function offerStarter(relay, commit) {
    const { requestId, result } = await describe(relay, commit);
    offered.set('starter', requestId);
    result.then(async (record) => {
      offered.delete('starter');
      await publishStarter({ commit, record });
      await git(['merge', '--ff-only', '--quiet', commit]);
      await starter.clear();
      await Promise.resolve(afterStarter()).catch((error) => log(`the preview was not rebuilt after the starter: ${error?.code ?? 'failed'}`));
    }, (error) => {
      offered.delete('starter');
      if (error?.code === 'approval-declined') quiet.set('starter', clock() + NOT_NOW_MS);
    }).catch((error) => log(`the starter publish.yml was approved but not published: ${error?.code ?? 'failed'}`));
  }

  async function refreshOnce(relay) {
    const now = clock();
    const starterCommit = starter === null || publishStarter === null ? null : await starter.read();
    if (starterCommit !== null && !offered.has('starter') && (quiet.get('starter') ?? 0) <= now) {
      try { await offerStarter(relay, starterCommit); } catch (error) {
        quiet.set('starter', now + 60_000);
        log(`the starter publish.yml was not offered: ${error?.code ?? error?.message ?? 'failed'}`);
      }
    }
    const jobs = await listJobs(context, { maxBytes: config.limits.maxArtifactBytes });
    for (const job of jobs) {
      if (job.state !== 'awaiting-approval' || offered.has(job.jobId) || (quiet.get(job.jobId) ?? 0) > now) continue;
      try {
        await offer(relay, job.jobId);
      } catch (error) {
        // Too large for a phone, publisher unreachable, unreadable commit: try
        // again later rather than on every list.
        quiet.set(job.jobId, now + 60_000);
        log(`approval for ${job.jobId} not offered: ${error?.code ?? error?.message ?? 'failed'}`);
      }
    }
  }

  return Object.freeze({
    /** Called by the relay before each list; one refresh at a time. */
    refresh(relay) {
      running ??= refreshOnce(relay).finally(() => { running = null; });
      return running;
    },
  });
}

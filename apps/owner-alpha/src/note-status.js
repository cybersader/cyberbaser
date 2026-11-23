// Whether a note is public and which version is live, for any note the site
// publishes, answered only from the node's own checkout and its own evidence:
//   - "public" is the vault's own publication rules (the same selector the
//     site build uses, @cyberbaser/publish) run on the committed tree at the
//     publication branch head;
//   - "live" is the note's committed text at the newest commit whose
//     deployment this node verified (a job that reached live-confirmed and
//     whose run, deployment and commit records agree).
// The selection is cached per commit, so a status costs one rev-parse while
// the branch head is unchanged. Nothing here reads the device's text, other
// notes' contents beyond their properties, or anything outside the checkout
// and the private job store.
import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { selectTree } from '@cyberbaser/publish';
import { readJsonArtifact } from './artifacts.js';
import { fail } from './errors.js';
import { listDurableJobs } from './job-state.js';
import { hasExactSuccessfulDeployment } from './live-confirm.js';
import { foldWorkspaceText, publicationDigest } from './owner-publication.js';
import { PIPELINE_SCHEMA_VERSION, pipelineArtifactPaths } from './pipeline.js';

const MAX_TREE_ENTRIES = 50_000;
const MAX_MARKDOWN_BYTES = 128 * 1024 * 1024;
const MAX_CACHED_COMMITS = 3;
const EVIDENCE_TTL_MS = 15_000;
const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;

function gitEnvironment() {
  const env = { ...process.env };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS']) delete env[name];
  env.GIT_OPTIONAL_LOCKS = '0';
  env.GIT_TERMINAL_PROMPT = '0';
  return env;
}

// One git process; stdin optional; stdout bounded.
function git(checkout, args, { input = null, maxBytes = 16 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', checkout, '--no-replace-objects', '-c', 'protocol.allow=never', ...args],
      { env: gitEnvironment(), stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks = [];
    let size = 0;
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) { child.kill('SIGKILL'); reject(new Error('git output too large')); return; }
      chunks.push(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`git ${args[0]} failed`))));
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? undefined);
  });
}

// Every regular blob at a commit: path -> object id.
async function listTree(checkout, commit) {
  const out = await git(checkout, ['ls-tree', '-r', '-z', '--full-tree', commit], { maxBytes: 64 * 1024 * 1024 });
  const blobs = new Map();
  for (const record of out.toString('utf8').split('\0')) {
    if (record === '') continue;
    const match = record.match(/^(\d{6}) (\w+) ([0-9a-f]{40,64})\t(.+)$/su);
    if (!match) throw new Error('unexpected tree entry');
    if (match[2] === 'blob' && ['100644', '100755'].includes(match[1])) blobs.set(match[4], match[3]);
    if (blobs.size > MAX_TREE_ENTRIES) throw new Error('tree too large');
  }
  return blobs;
}

// Read many blobs with one `git cat-file --batch`.
async function readBlobs(checkout, objectIds) {
  if (objectIds.length === 0) return [];
  const out = await git(checkout, ['cat-file', '--batch'], { input: `${objectIds.join('\n')}\n`, maxBytes: MAX_MARKDOWN_BYTES });
  const result = [];
  let offset = 0;
  for (const objectId of objectIds) {
    const newline = out.indexOf(0x0a, offset);
    const header = out.subarray(offset, newline).toString('utf8').split(' ');
    if (header[0] !== objectId || header[1] !== 'blob') throw new Error('unexpected cat-file header');
    const size = Number(header[2]);
    const start = newline + 1;
    result.push(out.subarray(start, start + size));
    offset = start + size + 1;
  }
  return result;
}

const isMarkdownPath = (p) => p.toLowerCase().endsWith('.md');

function foldedDigest(bytes) {
  try { return publicationDigest(Buffer.from(foldWorkspaceText(bytes), 'utf8')); } catch { return null; }
}

export function createNoteStatus({ config, context, listJobs = listDurableJobs, readArtifact = readJsonArtifact,
  clock = Date.now } = {}) {
  const checkout = config.repository.checkout;
  const branch = config.repository.branch;
  const maxArtifactBytes = config.limits.maxArtifactBytes;
  const selections = new Map(); // commit -> Promise<{ published:Set, blobs:Map }>
  const jobEvidence = new Map(); // jobId -> { commit, at } | null, live-confirmed jobs only
  let evidence = null; // { at, value: { commit, at } | null }

  async function head() {
    if (await realpath(checkout) !== checkout) throw new Error('checkout moved');
    const commit = (await git(checkout, ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`])).toString('utf8').trim();
    if (!COMMIT.test(commit)) throw new Error('bad head');
    return commit;
  }

  function selectionAt(commit) {
    if (!selections.has(commit)) {
      const pending = (async () => {
        const blobs = await listTree(checkout, commit);
        const markdown = [...blobs.keys()].filter(isMarkdownPath);
        const configId = blobs.get('publish.yml');
        const contents = await readBlobs(checkout, [...markdown.map((p) => blobs.get(p)), ...(configId ? [configId] : [])]);
        const files = {};
        for (const p of blobs.keys()) files[p] = null;
        markdown.forEach((p, i) => { files[p] = contents[i].toString('utf8'); });
        const publishYml = configId ? contents.at(-1).toString('utf8') : null;
        const { published } = selectTree(files, publishYml, { audience: 'public' });
        return Object.freeze({ published: new Set(published.filter(isMarkdownPath)), blobs });
      })();
      pending.catch(() => selections.delete(commit));
      selections.set(commit, pending);
      while (selections.size > MAX_CACHED_COMMITS) selections.delete(selections.keys().next().value);
    }
    return selections.get(commit);
  }

  async function readResult(jobId, file, artifactType) {
    const record = await readArtifact(context, file, { maxBytes: maxArtifactBytes });
    if (record?.schemaVersion !== PIPELINE_SCHEMA_VERSION || record.artifactType !== artifactType
      || record.jobId !== jobId || record.result === null || typeof record.result !== 'object') throw new Error('binding');
    return record.result;
  }

  // The newest commit whose deployment this node verified, and when.
  async function verifiedDeployment() {
    const now = clock();
    if (evidence !== null && now - evidence.at < EVIDENCE_TTL_MS) return evidence.value;
    let best = null;
    for (const job of await listJobs(context, { maxBytes: maxArtifactBytes })) {
      const confirmed = job.history.find(({ to }) => to === 'live-confirmed');
      if (!confirmed) continue;
      if (!jobEvidence.has(job.jobId)) {
        let found = null;
        try {
          const files = pipelineArtifactPaths(job.jobId);
          const committed = await readResult(job.jobId, files.committed, 'owner-alpha-committed-effect');
          const binding = await readResult(job.jobId, files.runBound, 'owner-alpha-run-bound-effect');
          const deployment = await readResult(job.jobId, files.deployment, 'owner-alpha-deployment-result');
          if (hasExactSuccessfulDeployment(committed.commit, binding, deployment)) found = { commit: committed.commit, at: confirmed.at };
        } catch { found = null; }
        jobEvidence.set(job.jobId, found);
      }
      const found = jobEvidence.get(job.jobId);
      if (found && (best === null || found.at > best.at)) best = found;
    }
    evidence = { at: now, value: best };
    return best;
  }

  return Object.freeze({
    head,

    // Published Markdown paths at the branch head, for the owner's link picker.
    async publishedPaths() {
      return [...(await selectionAt(await head())).published].sort();
    },

    // { selected, live: { digest, folded: true, at, commit } | null } for one
    // vault path. Throws when the node cannot establish it.
    async status(vaultPath) {
      try {
        const current = await selectionAt(await head());
        if (typeof vaultPath !== 'string' || !current.published.has(vaultPath)) return { selected: false, live: null };
        const deployed = await verifiedDeployment();
        if (deployed === null) return { selected: true, live: null };
        const then = await selectionAt(deployed.commit);
        const objectId = then.published.has(vaultPath) ? then.blobs.get(vaultPath) : undefined;
        if (!objectId) return { selected: true, live: null };
        const [bytes] = await readBlobs(checkout, [objectId]);
        const digest = foldedDigest(bytes);
        return { selected: true, live: digest === null ? null : { digest, folded: true, at: deployed.at, commit: deployed.commit } };
      } catch {
        fail('publication-status-unavailable', 'note status could not be established from the checkout');
      }
    },

    // The committed text at the branch head for one vault path, or null.
    async committedText(vaultPath) {
      const commit = await head();
      const current = await selectionAt(commit);
      const objectId = current.blobs.get(vaultPath);
      if (!objectId) return null;
      const [bytes] = await readBlobs(checkout, [objectId]);
      return { commit, bytes };
    },
  });
}

// Lines that differ between two texts (both sides), after line-ending
// folding. Bounded: very large differences report `many`.
export function countDifferentLines(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA -= 1; endB -= 1; }
  const n = endA - start;
  const m = endB - start;
  if (n === 0 || m === 0) return { count: n + m, many: false };
  if (n * m > 4_000_000) return { count: n + m, many: true };
  let previous = new Uint32Array(m + 1);
  let row = new Uint32Array(m + 1);
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      row[j] = a[start + i - 1] === b[start + j - 1] ? previous[j - 1] + 1 : Math.max(previous[j], row[j - 1]);
    }
    [previous, row] = [row, previous];
  }
  const common = previous[m];
  return { count: n - common + (m - common), many: false };
}

import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { bundleJobId, pushedBundleEvidence } from '../src/bundle-lifecycle.js';
import { OwnerAlphaError } from '../src/errors.js';
import { confirmNewPagesLive, witnessDigest } from '../src/live-confirm.js';
import { createNoteStatus } from '../src/note-status.js';
import { createSaveHandler, getOwnerAlphaJob } from '../src/pipeline.js';
import { gitIn } from '../src/signed-publish.js';
import { defineStoreContext, loadDurableJob, validateOwnerAlphaConfig } from '../src/index.js';

// A pushed page bundle follows the same after-push lifecycle as an edit: one
// durable job from its push through deployment, a live check for each new page
// and image, and the local rebuild; the note's status then reads Live with the
// time it was confirmed. Synthetic repository, fake deployment and site.

const EXAMPLE = path.resolve(import.meta.dir, '../owner-alpha.example.json');
const cleanup = [];
afterEach(async () => { for (const dir of cleanup.splice(0)) await rm(dir, { recursive: true, force: true }); });

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'commit.gpgSign=false', ...args], { encoding: 'utf8' }).trim();
const NOTE = 'posts/Tabletop in one hour.md';
const NOTE_TEXT = '---\ntitle: "Tabletop in one hour"\ndate: 2026-11-24\n---\n\nRun a short exercise.\n';
const IMAGE = 'posts/cover.png';
const IMAGE_BYTES = Buffer.from('89504e470d0a1a0a0000000d49484452synthetic-cover', 'utf8');
const PAGE_URL = 'https://cybersader.github.io/cyberbase/posts/Tabletop-in-one-hour';
const IMAGE_URL = 'https://cybersader.github.io/cyberbase/posts/cover.png';

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'cb-bundle-life-')));
  cleanup.push(root);
  git(root, 'init', '-q', '--initial-branch=main');
  git(root, 'config', 'user.name', 'T');
  git(root, 'config', 'user.email', 't@example.invalid');
  await writeFile(path.join(root, '.gitignore'), '.workspace/\n');
  await writeFile(path.join(root, 'publish.yml'), 'allow:\n  - posts/**\n');
  await mkdir(path.join(root, 'posts'));
  await writeFile(path.join(root, 'posts/old.md'), '# Old\n\nKept.\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  await writeFile(path.join(root, NOTE), NOTE_TEXT);
  await writeFile(path.join(root, IMAGE), IMAGE_BYTES);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'Add Tabletop in one hour with 1 image');
  const commit = git(root, 'rev-parse', 'HEAD');
  const raw = JSON.parse(await readFile(EXAMPLE, 'utf8'));
  raw.repository.checkout = root;
  const config = validateOwnerAlphaConfig(raw);
  const context = defineStoreContext({ projectRoot: root, workspaceRoot: path.join(root, config.workspace.root),
    storeRoot: path.join(root, config.workspace.store) });
  const record = { v: 1, bundleId: `bundle-${randomUUID()}`, state: 'published', commit,
    publicAdditions: [{ path: NOTE, address: '/posts/Tabletop-in-one-hour' }],
    images: [{ path: IMAGE, mediaType: 'image/png', byteLength: IMAGE_BYTES.length }] };
  const evidence = await pushedBundleEvidence({ config, record, git: gitIn(root),
    result: { repository: 'cybersader/cyberbase', branch: 'main', commit, receipt: { body: { synthetic: true } } } });
  return { root, config, context, commit, record, evidence };
}

let clock = Date.parse('2026-11-24T12:00:00.000Z'); // one clock for every handler: durable times only move forward
const discovery = (applicationSha) => ({ binding: { provider: 'github-actions', runId: '7', headSha: applicationSha, runAttempt: 1 } });
const deployed = (applicationSha) => ({ provider: 'github-actions',
  run: { headSha: applicationSha, runId: '7', runAttempt: 1, status: 'completed', conclusion: 'success' }, environment: { state: 'success' } });

// The site as a reader's browser sees it: the page and the image at their addresses.
function site({ page = '<h1>Tabletop in one hour</h1><p>Run a short exercise.</p>', image = IMAGE_BYTES } = {}) {
  return async (url) => {
    if (url === PAGE_URL && page !== null) return new Response(`<!doctype html><html><body>${page}</body></html>`, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    if (url === IMAGE_URL && image !== null) return new Response(image, { status: 200, headers: { 'content-type': 'image/png' } });
    return new Response('not found', { status: 404, headers: { 'content-type': 'text/html' } });
  };
}

function handler({ config, context, root }, overrides = {}) {
  const seen = [];
  const statesAt = (name) => async () => { seen.push([name, (await loadDurableJob(context, overrides.jobId)).state]); };
  const dependencies = {
    now: () => new Date(clock += 1000).toISOString(),
    discoverDeploymentRun: async ({ applicationSha }) => { await statesAt('discover')(); return discovery(applicationSha); },
    monitorDeploymentRun: async ({ applicationSha }) => { await statesAt('monitor')(); return deployed(applicationSha); },
    confirmNewPages: (input) => confirmNewPagesLive(input, { fetch: site(), sleep: async () => {}, retryIntervalMs: 1 }),
    rebuildLocal: async ({ commit, jobId, sourcePath }) => ({ status: 'local-rebuilt', commit, jobId, sourcePath }),
    ...overrides.dependencies,
  };
  return { pipeline: createSaveHandler({ config, context, projectRoot: root, dependencies }), seen };
}

test('pushed bundle: pushed -> deploying -> live, then the note status reads Live with the confirmed time', async () => {
  const f = await fixture();
  const jobId = bundleJobId(f.record.bundleId);
  expect(f.evidence.session.pages).toEqual([{ path: NOTE, address: '/posts/Tabletop-in-one-hour', liveUrl: PAGE_URL,
    witness: 'Tabletop in one hour', witnessDigest: witnessDigest('Tabletop in one hour') }]);
  expect(f.evidence.session.images).toEqual([{ path: IMAGE, url: IMAGE_URL, byteLength: IMAGE_BYTES.length,
    sha256: createHash('sha256').update(IMAGE_BYTES).digest('hex') }]);
  const { pipeline, seen } = handler(f, { jobId });

  const status = createNoteStatus({ config: f.config, context: f.context });
  const before = await status.status(NOTE);
  expect(before.selected).toBe(true);
  expect(before.live).toBeNull();

  const summary = await pipeline.trackBundle(f.evidence);
  expect(summary.state).toBe('completed');
  expect(seen).toEqual([['discover', 'discovering-run'], ['monitor', 'monitoring-deployment']]);
  const job = await loadDurableJob(f.context, jobId);
  expect(job.history.map(({ to }) => to)).toEqual(['accepted', 'pushed', 'discovering-run', 'run-bound', 'monitoring-deployment',
    'deployment-succeeded', 'verifying-live', 'live-confirmed', 'rebuilding-local', 'completed']);
  const confirmedAt = job.history.find(({ to }) => to === 'live-confirmed').at;

  const view = await getOwnerAlphaJob({ config: f.config, context: f.context, jobId });
  expect(view.origin).toEqual({ type: 'page-bundle', bundleId: f.record.bundleId, relativePath: NOTE });
  expect(view.liveKind).toBe('new-page-live');

  const after = await createNoteStatus({ config: f.config, context: f.context }).status(NOTE);
  expect(after.live).toEqual({ digest: after.committed, folded: true, at: confirmedAt, commit: f.commit });

  // Recording the same bundle again only resumes; a different one for the same job is refused.
  expect((await pipeline.trackBundle(f.evidence)).state).toBe('completed');
  const other = { ...f.evidence, pushed: { ...f.evidence.pushed, commit: 'f'.repeat(40) } };
  await expect(pipeline.trackBundle(other)).rejects.toMatchObject({ code: 'pipeline-artifact-mismatch' });
});

test('pushed bundle: a failed deployment stops at deployment-failed and never reads Live', async () => {
  const f = await fixture();
  const jobId = bundleJobId(f.record.bundleId);
  const { pipeline } = handler(f, { jobId, dependencies: {
    monitorDeploymentRun: async () => { throw new OwnerAlphaError('deployment-run-failed', 'the bound run failed'); },
  } });
  const summary = await pipeline.trackBundle(f.evidence);
  expect(summary.state).toBe('deployment-failed');
  expect(summary.failure.code).toBe('deployment-run-failed');
  expect((await createNoteStatus({ config: f.config, context: f.context }).status(NOTE)).live).toBeNull();
});

test('pushed bundle: a live check that does not match leaves the job retryable and the note not Live', async () => {
  // The image is served with other bytes.
  const f = await fixture();
  const jobId = bundleJobId(f.record.bundleId);
  const { pipeline } = handler(f, { jobId, dependencies: {
    confirmNewPages: (input) => confirmNewPagesLive(input, { fetch: site({ image: Buffer.from('other bytes') }), sleep: async () => {}, retryIntervalMs: 1 }),
  } });
  const summary = await pipeline.trackBundle(f.evidence);
  expect(summary.state).toBe('live-verification-failed');
  expect(summary.failure).toMatchObject({ code: 'live-asset-mismatch', retryable: true });
  expect((await createNoteStatus({ config: f.config, context: f.context }).status(NOTE)).live).toBeNull();

  // A page that never shows its title times out the same way.
  const g = await fixture();
  let now = 0;
  const { pipeline: second } = handler(g, { jobId: bundleJobId(g.record.bundleId), dependencies: {
    confirmNewPages: (input) => confirmNewPagesLive({ ...input, timeoutMs: 50 }, { fetch: site({ page: '<h1>Another page</h1>' }),
      clock: () => (now += 20), sleep: async () => {}, retryIntervalMs: 10 }),
  } });
  const timedOut = await second.trackBundle(g.evidence);
  expect(timedOut.state).toBe('live-verification-failed');
  expect(timedOut.failure.code).toBe('live-confirm-timeout');

  // A checker whose proof does not name the approved pages is refused too.
  const h = await fixture();
  const { pipeline: third } = handler(h, { jobId: bundleJobId(h.record.bundleId), dependencies: {
    confirmNewPages: async ({ pages, images }) => ({ kind: 'new-page-live',
      pages: pages.map((page) => ({ pageUrl: page.pageUrl, witnessPresent: true, witnessDigest: witnessDigest('Something else') })),
      images }),
  } });
  const wrong = await third.trackBundle(h.evidence);
  expect(wrong.state).toBe('live-verification-failed');
  expect(wrong.failure.code).toBe('live-witness-evidence-missing');

  // Once the site serves the page, the retry confirms it.
  const { pipeline: retry } = handler(h, { jobId: bundleJobId(h.record.bundleId) });
  expect((await retry.resumeJob({ jobId: bundleJobId(h.record.bundleId) })).state).toBe('completed');
  expect((await createNoteStatus({ config: h.config, context: h.context }).status(NOTE)).live?.commit).toBe(h.commit);
});

test('pushed bundle evidence: refuses a publisher answer for another commit or branch', async () => {
  const f = await fixture();
  await expect(pushedBundleEvidence({ config: f.config, record: f.record, git: gitIn(f.root),
    result: { branch: 'main', commit: 'a'.repeat(40) } })).rejects.toMatchObject({ code: 'publisher-receipt-mismatch' });
  await expect(pushedBundleEvidence({ config: f.config, record: f.record, git: gitIn(f.root),
    result: { branch: 'other', commit: f.commit } })).rejects.toMatchObject({ code: 'publisher-receipt-mismatch' });
});

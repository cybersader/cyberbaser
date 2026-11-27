import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { bundleJobId, bundleProgress, pushedBundleEvidence } from '../src/bundle-lifecycle.js';
import { isPrivateSite, validateOwnerAlphaConfig } from '../src/config.js';
import { discoverDeploymentRun, monitorDeploymentRun } from '../src/deployment/index.js';
import { PRIVATE_SITE_LIVE, privateReaderBase } from '../src/deployment/private-site.js';
import { declaredSiteUrl, initialSetupState, ownerConfigFromSetup, setupPage } from '../src/first-run.js';
import { confirmLivePage, confirmNewPagesLive, hasExactSuccessfulDeployment } from '../src/live-confirm.js';
import { createSaveHandler, getOwnerAlphaJob } from '../src/pipeline.js';
import { ownerHttpTools } from '../src/server.js';
import { gitIn } from '../src/signed-publish.js';
import { defineStoreContext, loadDurableJob } from '../src/index.js';

// Private-only publication: no public website and no deployment watch. After
// the push, the node's own private build of that exact commit is the
// deployment, and Live means the node's private reader serves the new page.
// Synthetic repository and reader; nothing here reaches GitHub.

const EXAMPLE = path.resolve(import.meta.dir, '../owner-alpha.example.json');
const cleanup = [];
afterEach(async () => { for (const dir of cleanup.splice(0)) await rm(dir, { recursive: true, force: true }); });
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'commit.gpgSign=false', ...args], { encoding: 'utf8' }).trim();

const NOTE = 'posts/Tabletop in one hour.md';
const NOTE_TEXT = '---\ntitle: "Tabletop in one hour"\n---\n\nRun a short exercise.\n';
const READER = 'http://127.0.0.1:4318/';

async function exampleRaw(checkout) {
  const raw = JSON.parse(await readFile(EXAMPLE, 'utf8'));
  raw.repository.checkout = checkout;
  raw.workflow = { provider: 'private-site', branch: 'main' };
  raw.live = { baseUrl: 'https://cyberchief.example/' };
  return raw;
}

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'cb-private-site-')));
  cleanup.push(root);
  git(root, 'init', '-q', '--initial-branch=main');
  git(root, 'config', 'user.name', 'T');
  git(root, 'config', 'user.email', 't@example.invalid');
  await writeFile(path.join(root, '.gitignore'), '.workspace/\n');
  await writeFile(path.join(root, 'publish.yml'), 'allow:\n  - posts/**\n');
  await mkdir(path.join(root, '.cyberbaser'));
  await writeFile(path.join(root, '.cyberbaser/site.yml'), 'site:\n  title: Example\n  baseUrl: https://cyberchief.example/\n');
  await mkdir(path.join(root, 'posts'));
  await writeFile(path.join(root, 'posts/old.md'), '# Old\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  await writeFile(path.join(root, NOTE), NOTE_TEXT);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'Add Tabletop in one hour');
  const commit = git(root, 'rev-parse', 'HEAD');
  const config = validateOwnerAlphaConfig(await exampleRaw(root));
  const context = defineStoreContext({ projectRoot: root, workspaceRoot: path.join(root, config.workspace.root),
    storeRoot: path.join(root, config.workspace.store) });
  const record = { v: 1, bundleId: `bundle-${randomUUID()}`, state: 'published', commit,
    publicAdditions: [{ path: NOTE, address: '/posts/Tabletop-in-one-hour' }], images: [] };
  const evidence = await pushedBundleEvidence({ config, record, git: gitIn(root),
    result: { repository: 'cybersader/cyberbase', branch: 'main', commit, receipt: { body: { synthetic: true } } } });
  return { root, config, context, commit, record, evidence };
}

// The node's private reader as fetch sees it.
function reader(seen, { page = '<h1>Tabletop in one hour</h1>' } = {}) {
  return async (url) => {
    seen.push(String(url));
    if (url === `${READER}posts/Tabletop-in-one-hour`) {
      return new Response(`<!doctype html><html><body>${page}</body></html>`, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    return new Response('not found', { status: 404, headers: { 'content-type': 'text/html' } });
  };
}

test('config: private-site keeps the GitHub repository and needs no Pages workflow', async () => {
  const raw = await exampleRaw('/tmp/vault');
  const config = validateOwnerAlphaConfig(raw);
  expect(config.workflow).toEqual({ provider: 'private-site', branch: 'main' });
  expect(isPrivateSite(config)).toBe(true);
  expect(config.repository.remote.url).toBe('https://github.com/cybersader/cyberbase.git');
  expect(() => validateOwnerAlphaConfig({ ...raw, workflow: { provider: 'private-site', branch: 'trunk' } })).toThrow(/branch/u);
  expect(() => validateOwnerAlphaConfig({ ...raw, workflow: { provider: 'private-site', branch: 'main', environment: 'github-pages' } })).toThrow();
  expect(() => validateOwnerAlphaConfig({ ...raw, live: { baseUrl: 'http://cyberchief.example/' } })).toThrow();
  // The GitHub App still holds the push credential.
  expect(() => validateOwnerAlphaConfig({ ...raw, forgeAccess: { provider: 'github-app', clientId: 'Iv23liFAKEcyberbaser', stateDirectory: '/tmp/forge' } })).not.toThrow();
});

test('deployment: the private build of the exact commit, never a GitHub run', async () => {
  const config = validateOwnerAlphaConfig(await exampleRaw('/tmp/vault'));
  const sha = 'a'.repeat(40);
  const bound = await discoverDeploymentRun({ config, applicationSha: sha });
  expect(bound.binding).toEqual({ provider: 'private-site', runId: '1', headSha: sha });
  const built = [];
  const rebuild = async (input) => { built.push(input.projectRoot); return { manifest: { source: { head: sha }, renderer: { name: 'cyberchief' } } }; };
  const result = await monitorDeploymentRun({ config, applicationSha: sha, boundRun: bound, projectRoot: '/tmp/project' }, { rebuild });
  expect(built).toEqual(['/tmp/project']);
  expect(hasExactSuccessfulDeployment(sha, bound, result)).toBe(true);
  // Built from another commit: refused.
  await expect(monitorDeploymentRun({ config, applicationSha: sha, boundRun: bound },
    { rebuild: async () => ({ manifest: { source: { head: 'b'.repeat(40) } } }) })).rejects.toMatchObject({ code: 'deployment-head-mismatch' });
  // A failed build is a failed deployment.
  await expect(monitorDeploymentRun({ config, applicationSha: sha, boundRun: bound },
    { rebuild: async () => { throw Object.assign(new Error('x'), { code: 'renderer-build-failed' }); } })).rejects.toMatchObject({ code: 'deployment-failed' });
  // A record without the private marker never counts.
  expect(hasExactSuccessfulDeployment(sha, bound, { ...result, publication: { state: 'success' } })).toBe(false);
});

test('live: checked on the node reader, recorded under the identity address, marked private-site-live', async () => {
  const f = await fixture();
  expect(await privateReaderBase(f.config)).toBe(READER);
  const seen = [];
  const [page] = f.evidence.session.pages;
  expect(page.liveUrl).toBe('https://cyberchief.example/posts/Tabletop-in-one-hour');
  const live = await confirmNewPagesLive({ config: f.config, pages: [{ pageUrl: page.liveUrl, witness: page.witness }] },
    { fetch: reader(seen), sleep: async () => {}, retryIntervalMs: 1 });
  expect(seen).toEqual([`${READER}posts/Tabletop-in-one-hour`]);
  expect(live.evidence).toBe(PRIVATE_SITE_LIVE);
  expect(live.site).toBe('private');
  expect(live.pages[0].pageUrl).toBe(page.liveUrl);
  // The public check still refuses a plain-HTTP address.
  const publicConfig = validateOwnerAlphaConfig({ ...(JSON.parse(await readFile(EXAMPLE, 'utf8'))), repository: { ...f.config.repository, aliases: undefined } });
  await expect(confirmLivePage({ config: publicConfig, pageUrl: 'http://127.0.0.1:4318/x', stableWitness: 'x' }, { fetch: reader([]) }))
    .rejects.toMatchObject({ code: 'invalid-live-url' });
});

test('pipeline: a pushed bundle goes Live on the private site, and the device gets the private link', async () => {
  const f = await fixture();
  const jobId = bundleJobId(f.record.bundleId);
  const seen = [];
  let clock = Date.parse('2026-11-24T12:00:00.000Z');
  const pipeline = createSaveHandler({ config: f.config, context: f.context, projectRoot: f.root, dependencies: {
    now: () => new Date(clock += 1000).toISOString(),
    monitorDeploymentRun: (input) => monitorDeploymentRun(input, {
      rebuild: async () => ({ manifest: { source: { head: f.commit }, renderer: { name: 'cyberchief' } } }) }),
    confirmNewPages: (input) => confirmNewPagesLive(input, { fetch: reader(seen), sleep: async () => {}, retryIntervalMs: 1 }),
    rebuildLocal: async ({ commit }) => ({ status: 'local-rebuilt', commit }),
  } });
  const summary = await pipeline.trackBundle(f.evidence);
  expect(summary.state).toBe('completed');
  const job = await loadDurableJob(f.context, jobId);
  expect(job.history.map(({ to }) => to)).toContain('live-confirmed');
  const view = await getOwnerAlphaJob({ config: f.config, context: f.context, jobId });
  expect(view.liveKind).toBe('new-page-live');
  const progress = bundleProgress({ config: f.config, record: f.record, job: view, privateBase: READER });
  expect(progress.step).toBe('live');
  expect(progress.site).toBe('private');
  expect(progress.pages[0].url).toBe(`${READER}posts/Tabletop-in-one-hour`);
});

test('setup: the website step offers the private site first, and its config has no deployment', async () => {
  const state = { ...initialSetupState(), step: 'website', repository: 'cybersader/cyberchief' };
  const tools = ownerHttpTools();
  const page = setupPage({ state, csrfToken: 'c'.repeat(43), tools, privateDefault: true, readerAddress: READER });
  expect(page).toContain('Keep it private');
  expect(page).toContain(READER);
  expect(page).toContain('data-action="show-public"');
  const publicPage = setupPage({ state: { ...state, website: { url: null, source: 'show-public' } }, csrfToken: 'c'.repeat(43), tools, privateDefault: true });
  expect(publicPage).toContain('Site address');

  const done = { ...state, step: 'done', website: { url: null, source: 'private' },
    notes: { ...state.notes, branch: 'main', siteUrl: declaredSiteUrl('site:\n  baseUrl: https://cyberchief.me/\n') } };
  const renderer = { name: 'cyberchief', directory: '/var/lib/cyberbaser/renderers/cyberchief',
    quartzCommit: '4923affa7722dfc751f1074348e6dad214fe0c08', fingerprint: ['build', 'quartz.config.ts'] };
  const { config, privateSite } = ownerConfigFromSetup(done, { listen: { host: '127.0.0.1', port: 4317 },
    checkout: '/var/lib/cyberbaser-shared/notes/notes', publisherSocket: '/run/p.sock', reviewSocket: '/run/r.sock',
    irohStateDirectory: '/var/lib/cyberbaser/iroh', forgeStateDirectory: '/var/lib/cyberbaser-publisher/forge', clientId: 'Iv23liFAKEcyberbaser', renderer });
  expect(privateSite).toBe(true);
  expect(config.workflow).toEqual({ provider: 'private-site', branch: 'main' });
  expect(config.live.baseUrl).toBe('https://cyberchief.me/');
  expect(config.renderer.name).toBe('cyberchief');
});

test('declaredSiteUrl reads the vault site address or nothing', () => {
  expect(declaredSiteUrl('site:\n  baseUrl: https://cyberchief.me/\n')).toBe('https://cyberchief.me/');
  expect(declaredSiteUrl('site:\n  baseUrl: notes.example.com/garden\n')).toBe('https://notes.example.com/garden/');
  expect(declaredSiteUrl('site:\n  baseUrl: https://user:pw@x.example/\n')).toBeNull();
  expect(declaredSiteUrl('site: {}\n')).toBeNull();
  expect(declaredSiteUrl(': : :')).toBeNull();
  expect(declaredSiteUrl(null)).toBeNull();
});

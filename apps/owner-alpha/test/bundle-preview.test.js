// Route C on the site's own design: a new page from a bundle built by the
// configured renderer, shown safely, and the simplified page whenever that
// does not work.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { png } from '../../../packages/media-check/test/fixtures.js';
import { createBundlePreview } from '../src/bundle-preview.js';
import { BUNDLE_FRAME_CSP } from '../src/bundle-review-page.js';
import { validateOwnerAlphaConfig } from '../src/config.js';
import { openBundleDesk } from '../src/core/bundle-desk.js';
import { PINNED_QUARTZ_COMMIT, PINNED_QUARTZ_REF } from '../src/quartz-renderer.js';
import { createMemoryEditSessionStore, createOwnerAlphaHandler } from '../src/server.js';
import { SITE_FRAME_CSP } from '../src/site-review-page.js';
import { parsePageBundle } from '../../../packages/proposal/src/page-bundle.js';
import { bundleVault, gitSync, REMOTE_URL } from './bundle-fixture.js';

const ORIGIN = 'http://127.0.0.1:4317';
const HOST = '127.0.0.1:4317';
const TOKENS = { process: 'a'.repeat(43), csrf: 'b'.repeat(43), bootstrap: 'c'.repeat(43), edit: 'd'.repeat(43) };
const request = (pathname, { headers = {} } = {}) => new Request(`${ORIGIN}${pathname}`, { headers: { Host: HOST, ...headers } });

// A stand-in for a contract renderer: one HTML page per note in the site's
// design (a stylesheet with a font, the image beside it, a script to strip).
function fakeRenderer(calls, { name = 'cyberchief' } = {}) {
  return async ({ contentDir, outputDir, workspaceDir, ownerOrigin }) => {
    calls.push({ contentDir, outputDir, workspaceDir, ownerOrigin, files: await readdir(contentDir, { recursive: true }) });
    await mkdir(path.join(outputDir, 'topic'), { recursive: true });
    await mkdir(path.join(outputDir, 'static'), { recursive: true });
    await writeFile(path.join(outputDir, 'index.css'), '@font-face{font-family:Site;src:url("./static/site.woff2")}body{background:#0c0e11;font-family:Site}');
    await writeFile(path.join(outputDir, 'static', 'site.woff2'), 'wOF2-fake');
    await copyFile(path.join(contentDir, 'topic', 'cover.png'), path.join(outputDir, 'topic', 'cover.png'));
    const note = await readFile(path.join(contentDir, 'topic', 'new-post.md'), 'utf8');
    await writeFile(path.join(outputDir, 'topic', 'new-post.html'), `<!doctype html><html><head><link rel="stylesheet" href="../index.css"><script>window.x=1</script></head>
<body><nav class="cc-nav"><a href="/">Home</a></nav><article class="popover-hint"><h1>New post</h1><p>${note.length} bytes</p><img src="./cover.png" onerror="alert(1)"></article></body></html>`);
    return { renderer: name, revision: PINNED_QUARTZ_COMMIT, tag: PINNED_QUARTZ_REF, outputDir };
  };
}

let world;
beforeAll(async () => {
  const vault = await bundleVault();
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'owner-alpha-bundle-preview-'));
  const rendererRoot = await mkdtemp(path.join(os.tmpdir(), 'owner-alpha-bundle-renderer-'));
  const raw = JSON.parse(await readFile(path.join(import.meta.dir, '..', 'owner-alpha.example.json'), 'utf8'));
  raw.proposalReview.enabled = true;
  raw.proposalReview.socketPath = '/run/user/1000/cyberbaser/review.sock';
  const bundled = validateOwnerAlphaConfig(raw);
  const config = validateOwnerAlphaConfig({ ...raw, renderer: { name: 'cyberchief', directory: rendererRoot,
    quartzCommit: PINNED_QUARTZ_COMMIT, fingerprint: ['build'] } });
  const desk = await openBundleDesk({ config: { limits: { maxSourceBytes: 1024 * 1024 }, repository: { remote: { url: REMOTE_URL } } },
    git: (await import('../src/core/page-bundle.js')).bundleGit(vault.repo), directory: path.join(vault.root, 'bundles'),
    branchHead: async () => gitSync(vault.repo, 'rev-parse', 'main') });
  const cover = png();
  const sha = new Bun.CryptoHasher('sha256').update(cover).digest('hex');
  desk.staging.stage({ keyId: 'agent', sha256: sha, size: cover.length, offset: 0, data: Buffer.from(cover).toString('base64') });
  const agent = { keyId: 'agent', actor: { kind: 'agent', id: 'agent-1', label: 'Research agent' } };
  const submitted = await desk.submit({ main: { path: 'topic/new-post.md', text: '---\ntitle: New\n---\n# New post\n\n![[cover.png]]\n' },
    assets: [{ path: 'topic/cover.png', sha256: sha }] }, agent, 'propose');
  const handler = (bundlePreview) => createOwnerAlphaHandler({
    config, projectRoot, editSessions: createMemoryEditSessionStore({ createToken: () => TOKENS.edit }),
    createToken: (() => { const values = [TOKENS.process, TOKENS.csrf, TOKENS.bootstrap]; return () => values.shift(); })(),
    createJobId: () => 'job-1', createEditSession: async () => ({}), saveEdit: async () => ({}), lookupJob: async () => null,
    proposalReview: { list: async () => ({ actionable: [], history: [], historyTruncated: false, nextCursor: null }),
      load: async () => null, loadDecision: async () => null, record: async () => null },
    devices: { bundleDesk: desk }, bundlePreview,
  });
  const signIn = async (fetch) => (await fetch(request(`/owner/bootstrap?token=${TOKENS.bootstrap}`))).headers.get('set-cookie')?.split(';', 1)[0];
  world = { vault, desk, projectRoot, rendererRoot, config, bundled, bundleId: submitted.bundleId, cover, handler, signIn };
});
afterAll(async () => {
  for (const root of [world.vault.root, world.projectRoot, world.rendererRoot]) await rm(root, { recursive: true, force: true });
});

async function previewInput() {
  const record = await world.desk.load(world.bundleId);
  return { bundleId: world.bundleId, index: 0, bundle: parsePageBundle(record.bundleText), record, colorScheme: 'dark',
    readImage: (imagePath) => world.desk.readImage(world.bundleId, imagePath) };
}

describe('a new page on the site design', () => {
  test('only a configured renderer builds previews', () => {
    expect(createBundlePreview({ config: world.bundled, projectRoot: world.projectRoot })).toBeNull();
    expect(createBundlePreview({ config: world.config, projectRoot: world.projectRoot })).toBeFunction();
  });

  test('builds just the bundle files privately, shows the page safely with a banner, and cleans up', async () => {
    const calls = [];
    const preview = createBundlePreview({ config: world.config, projectRoot: world.projectRoot, render: fakeRenderer(calls) });
    const html = await preview(await previewInput());
    expect(calls).toHaveLength(1);
    expect(calls[0].files.sort()).toEqual(['topic', 'topic/cover.png', 'topic/new-post.md']);
    expect(calls[0].ownerOrigin).toBe('http://127.0.0.1:4317');
    expect(calls[0].outputDir.startsWith(path.join(world.projectRoot, '.workspace/owner-alpha/cache/bundle-previews/'))).toBe(true);
    expect(html).toContain('<p class="cbr-banner">New page at <strong>/topic/new-post</strong></p>');
    expect(html).toContain(`src="data:image/png;base64,${Buffer.from(world.cover).toString('base64')}"`);
    expect(html).toContain('url(data:font/woff2;base64,');
    expect(html).toContain('saved-theme="dark"');
    expect(html).not.toMatch(/<script|onerror|href=|<link/u);
    // The private build is gone; the preview is kept in memory.
    await expect(readdir(path.join(world.projectRoot, '.workspace/owner-alpha/cache/bundle-previews'))).resolves.toEqual([]);
    expect(await preview(await previewInput())).toBe(html);
    expect(calls).toHaveLength(1);
  });

  test('a failed build or a result from another renderer gives the simplified page', async () => {
    const failing = createBundlePreview({ config: world.config, projectRoot: world.projectRoot, render: async () => { throw new Error('boom'); } });
    expect(await failing(await previewInput())).toBeNull();
    const other = createBundlePreview({ config: world.config, projectRoot: world.projectRoot, render: fakeRenderer([], { name: 'quartz-cyberbase' }) });
    expect(await other(await previewInput())).toBeNull();
    const preview = createBundlePreview({ config: world.config, projectRoot: world.projectRoot, render: fakeRenderer([]) });
    expect(await preview({ ...(await previewInput()), bundleId: '../escape' })).toBeNull();
    expect(await preview({ ...(await previewInput()), index: 3 })).toBeNull();
  });

  test('the owner app frames the site page with the site frame policy, or falls back to the simplified page', async () => {
    const preview = createBundlePreview({ config: world.config, projectRoot: world.projectRoot, render: fakeRenderer([]) });
    const fetch = world.handler(preview);
    const cookie = await world.signIn(fetch);
    const site = await fetch(request(`/owner/bundles/${world.bundleId}/page/0`, { headers: { Cookie: cookie } }));
    expect(site.status).toBe(200);
    expect(site.headers.get('content-security-policy')).toBe(SITE_FRAME_CSP);
    expect(await site.text()).toContain('class="cbr-banner"');
    const shell = await fetch(request(`/owner/bundles/${world.bundleId}`, { headers: { Cookie: cookie } }));
    expect(await shell.text()).toContain('class="rv-doc rv-bundle rv-scheme-light"');

    const plainFetch = world.handler(async () => null);
    const plainCookie = await world.signIn(plainFetch);
    const plain = await plainFetch(request(`/owner/bundles/${world.bundleId}/page/0`, { headers: { Cookie: plainCookie } }));
    expect(plain.headers.get('content-security-policy')).toBe(BUNDLE_FRAME_CSP);
    expect(await plain.text()).toContain('<div class="banner">New page at');
  });
});

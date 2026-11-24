// Route C for page bundles, through the owner app's own handler: the new
// page in the simplified rendering with its "New page at /address" banner,
// images from the bundle's bytes with strict headers, and Approve that only
// moves the bundle to the owner's signature.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { png } from '../../../packages/media-check/test/fixtures.js';
import { validateOwnerAlphaConfig } from '../src/config.js';
import { openBundleDesk } from '../src/core/bundle-desk.js';
import { createMemoryEditSessionStore, createOwnerAlphaHandler } from '../src/server.js';
import { BUNDLE_FRAME_CSP, bundleFramePage } from '../src/bundle-review-page.js';
import { bundleVault, gitSync, REMOTE_URL } from './bundle-fixture.js';

const ORIGIN = 'http://127.0.0.1:4317';
const HOST = '127.0.0.1:4317';
const TOKENS = { process: 'a'.repeat(43), csrf: 'b'.repeat(43), bootstrap: 'c'.repeat(43), edit: 'd'.repeat(43) };
const request = (pathname, { method = 'GET', headers = {}, body } = {}) => new Request(`${ORIGIN}${pathname}`, { method, headers: { Host: HOST, ...headers }, body });

let world;
beforeAll(async () => {
  const vault = await bundleVault();
  const raw = JSON.parse(await readFile(path.join(import.meta.dir, '..', 'owner-alpha.example.json'), 'utf8'));
  raw.proposalReview.enabled = true;
  raw.proposalReview.socketPath = '/run/user/1000/cyberbaser/review.sock';
  const config = validateOwnerAlphaConfig(raw);
  const desk = await openBundleDesk({ config: { limits: { maxSourceBytes: 1024 * 1024 }, repository: { remote: { url: REMOTE_URL } } },
    git: (await import('../src/core/page-bundle.js')).bundleGit(vault.repo), directory: path.join(vault.root, 'bundles'),
    branchHead: async () => gitSync(vault.repo, 'rev-parse', 'main') });
  const cover = png();
  const sha = new Bun.CryptoHasher('sha256').update(cover).digest('hex');
  desk.staging.stage({ keyId: 'agent', sha256: sha, size: cover.length, offset: 0, data: Buffer.from(cover).toString('base64') });
  const agent = { keyId: 'agent', actor: { kind: 'agent', id: 'agent-1', label: 'Research <agent>' } };
  const submitted = await desk.submit({ main: { path: 'topic/new-post.md', text: '---\ntitle: <b>New</b>\n---\n# New post\n\n![[cover.png]]\n\n<script>alert(1)</script>\n' },
    assets: [{ path: 'topic/cover.png', sha256: sha }] }, agent, 'propose');
  const fetch = createOwnerAlphaHandler({
    config, editSessions: createMemoryEditSessionStore({ createToken: () => TOKENS.edit }),
    createToken: (() => { const values = [TOKENS.process, TOKENS.csrf, TOKENS.bootstrap]; return () => values.shift(); })(),
    createJobId: () => 'job-1', createEditSession: async () => ({}), saveEdit: async () => ({}), lookupJob: async () => null,
    proposalReview: { list: async () => ({ actionable: [], history: [], historyTruncated: false, nextCursor: null }),
      load: async () => null, loadDecision: async () => null, record: async () => null },
    devices: { bundleDesk: desk },
  });
  const bootstrap = await fetch(request(`/owner/bootstrap?token=${TOKENS.bootstrap}`));
  const cookie = bootstrap.headers.get('set-cookie')?.split(';', 1)[0];
  world = { vault, desk, fetch, cookie, bundleId: submitted.bundleId, cover };
});
afterAll(async () => { await rm(world.vault.root, { recursive: true, force: true }); });

const get = (pathname) => world.fetch(request(pathname, { headers: { Cookie: world.cookie } }));

test('the shell lists the new page and its image, escapes the sender, and frames the page sandboxed', async () => {
  const response = await get(`/owner/bundles/${world.bundleId}`);
  expect(response.status).toBe(200);
  const body = await response.text();
  expect(body).toContain('New page at <strong>/topic/new-post</strong>');
  expect(body).toContain('Research &lt;agent&gt;');
  expect(body).toContain(`<iframe title="The new page" sandbox="" src="/owner/bundles/${world.bundleId}/page/0">`);
  expect(response.headers.get('content-security-policy')).toContain("frame-src 'self'");
  expect(response.headers.get('content-security-policy')).toContain("script-src 'self'");
});

test('the page frame runs nothing, loads nothing, and inlines the bundle image', async () => {
  const response = await get(`/owner/bundles/${world.bundleId}/page/0`);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-security-policy')).toBe(BUNDLE_FRAME_CSP);
  expect(BUNDLE_FRAME_CSP).toContain('sandbox');
  expect(BUNDLE_FRAME_CSP).toContain("default-src 'none'");
  const body = await response.text();
  expect(body).toContain('New page at <strong>/topic/new-post</strong>');
  expect(body).toContain(`src="data:image/png;base64,${Buffer.from(world.cover).toString('base64')}"`);
  expect(body).not.toContain('<script>');
  expect(body).toContain('&lt;script&gt;');
});

test('an image is served from the bundle bytes with its sniffed type and strict headers', async () => {
  const response = await get(`/owner/bundles/${world.bundleId}/image/0`);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('image/png');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; img-src 'self'; sandbox");
  expect(Buffer.from(await response.arrayBuffer()).equals(Buffer.from(world.cover))).toBe(true);
  expect((await get(`/owner/bundles/${world.bundleId}/image/3`)).status).toBe(404);
});

test('Approve needs the CSRF token and only moves the bundle to the owner signature', async () => {
  const post = (token) => world.fetch(request(`/owner/bundles/${world.bundleId}/approve`, { method: 'POST',
    headers: { Origin: ORIGIN, Cookie: world.cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: `csrf=${token}` }));
  expect((await post('x'.repeat(43))).status).toBe(403);
  expect((await world.desk.load(world.bundleId)).state).toBe('review');
  const approved = await post(TOKENS.csrf);
  expect(approved.status).toBe(303);
  const record = await world.desk.load(world.bundleId);
  expect(record.state).toBe('signing');
  expect(gitSync(world.vault.repo, 'rev-parse', `${record.commit}^`)).toBe(world.vault.head);
  // Nothing moved in the vault: publishing still needs the signature.
  expect(gitSync(world.vault.repo, 'rev-parse', 'main')).toBe(world.vault.head);
});

test('the frame renderer shows a missing image as text, never fetches it', () => {
  const html = bundleFramePage({ path: 'topic/a.md', text: '![[elsewhere.png]]\n', address: '/topic/a', images: new Map() });
  expect(html).toContain('<span class="missing">![[elsewhere.png]]</span>');
  expect(html).not.toContain('<img');
});

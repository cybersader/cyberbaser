// Folder notes (Cyberchief site model v3): each post is a folder with a
// same-name note and its photos beside it; topics have a same-name note. The
// node checks addresses against the whole base tree and the rest of the
// bundle, and the review preview finds the built page whether the renderer
// draws the note as a page or as its folder's page.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { png } from '../../../packages/media-check/test/fixtures.js';
import { parsePageBundle } from '../../../packages/proposal/src/page-bundle.js';
import { createBundlePreview } from '../src/bundle-preview.js';
import { validateOwnerAlphaConfig } from '../src/config.js';
import { openBundleDesk } from '../src/core/bundle-desk.js';
import { bundleGit, checkPageBundle } from '../src/core/page-bundle.js';
import { PINNED_QUARTZ_COMMIT, PINNED_QUARTZ_REF } from '../src/quartz-renderer.js';
import { bundleOf, bundleVault, gitSync, readerFor, REMOTE_URL } from './bundle-fixture.js';

const TOPIC = 'Leadership & strategy';
const FILES = Object.freeze({
  'publish.yml': 'allow:\n  - "Leadership & strategy/**"\n  - "Knowledge base/**"\n',
  '.cyberbaser/site.yml': 'site:\n  title: Cyberchief\n  addresses: lowercase-hyphen\n',
  [`${TOPIC}/${TOPIC}.md`]: '---\ntitle: Leadership & strategy\n---\n',
  [`${TOPIC}/Writing a strategy/Writing a strategy.md`]: '# Strategy\n',
  [`${TOPIC}/Old flat post.md`]: '# Old\n',
  'Knowledge base/Knowledge base.md': '# Knowledge base\n',
  'Knowledge base/Risk/Risk.md': '# Risk\n',
  'Knowledge base/Risk/Board/Board.md': '# Board\n',
  'Private/Unpublished/Unpublished.md': '# Not public\n',
});
const COVER = png();

let vault; let projectRoot;
beforeAll(async () => {
  vault = await bundleVault(FILES);
  projectRoot = await mkdtemp(path.join(os.tmpdir(), 'oa-bundle-folder-notes-'));
});
afterAll(async () => {
  for (const root of [vault.root, projectRoot]) await rm(root, { recursive: true, force: true });
});

const check = (creates, assets = []) => checkPageBundle({ bundle: bundleOf(vault.head, { creates, assets }), git: vault.git, head: vault.head,
  readAsset: readerFor(assets), maxSourceBytes: 1 << 20 });
const codeOf = async (promise) => { try { await promise; return 'ok'; } catch (error) { return error.code; } };

test('a post in its own folder, its cover beside it named by the bare file name', async () => {
  const post = `${TOPIC}/New post/New post.md`;
  const assets = [{ path: `${TOPIC}/New post/New post cover.png`, bytes: COVER }];
  const checked = await check([{ path: post, text: '---\ntitle: New post\ncover: New post cover.png\n---\nBody.\n' }], assets);
  expect(checked.publicAdditions).toEqual([{ path: post, address: '/leadership-and-strategy/new-post' }]);
  expect(checked.images.map((image) => image.path)).toEqual([`${TOPIC}/New post/New post cover.png`]);
});

test('a KB page plus its new sub-folder note, both same-name folder notes', async () => {
  const checked = await check([
    { path: 'Knowledge base/Risk/Vendors/Vendors.md', text: '# Vendors\n' },
    { path: 'Knowledge base/Risk/Vendors/Vendor reviews/Vendor reviews.md', text: '# Reviews\n' },
  ]);
  expect(checked.publicAdditions.map((entry) => entry.address).sort())
    .toEqual(['/knowledge-base/risk/vendors', '/knowledge-base/risk/vendors/vendor-reviews']);
});

test('create-address-collision against the whole base tree: folder-note forms, case, & vs and, unpublished files', async () => {
  // An old flat post and a new folder-note post of the same name.
  expect(await codeOf(check([{ path: `${TOPIC}/Old flat post/Old flat post.md`, text: '# x\n' }]))).toBe('create-address-collision');
  // A flat note beside an existing folder-note post.
  expect(await codeOf(check([{ path: `${TOPIC}/Writing a strategy.md`, text: '# x\n' }]))).toBe('create-address-collision');
  // index.md beside a same-name folder note.
  expect(await codeOf(check([{ path: 'Knowledge base/Risk/index.md', text: '# x\n' }]))).toBe('create-address-collision');
  // Case, accents and "&" vs "and" do not make a new address.
  expect(await codeOf(check([{ path: 'Leadership and strategy/writing a STRATEGY/writing a STRATEGY.md', text: '# x\n' }])))
    .not.toBe('ok');
  // Same folder names, other case: the path check refuses first.
  expect(await codeOf(check([{ path: `${TOPIC}/writing a STRATEGY/writing a STRATEGY.md`, text: '# x\n' }]))).toBe('create-path-case-collision');
  // Only the address agrees (punctuation, accents): the address check.
  expect(await codeOf(check([{ path: `${TOPIC}/Writing a strategy!/Writing a strategy!.md`, text: '# x\n' }]))).toBe('create-address-collision');
  expect(await codeOf(check([{ path: 'Knowledge base/Rïsk/Rïsk.md', text: '# x\n' }]))).toBe('create-address-collision');
  // A file that is not published (a draft) still holds its address.
  const unpublished = await bundleVault({ ...FILES, 'publish.yml': 'allow:\n  - "Private/**"\n',
    'Private/Unpublished/Unpublished.md': '---\ndraft: true\n---\n# Not yet\n' });
  try {
    const creates = [{ path: 'Private/Unpublished.md', text: '# x\n' }];
    expect(await codeOf(checkPageBundle({ bundle: bundleOf(unpublished.head, { creates }), git: unpublished.git, head: unpublished.head,
      readAsset: readerFor([]), maxSourceBytes: 1 << 20 }))).toBe('create-address-collision');
  } finally {
    await rm(unpublished.root, { recursive: true, force: true });
  }
});

test('create-address-collision within the bundle: two images of one address', async () => {
  const post = `${TOPIC}/Two photos/Two photos.md`;
  const assets = [{ path: `${TOPIC}/Two photos/Cover.png`, bytes: COVER }, { path: `${TOPIC}/Two photos/cover.png`, bytes: COVER }];
  expect(await codeOf(check([{ path: post, text: '![[Cover.png]] ![[cover.png]]\n' }], assets))).toBe('create-address-collision');
});

// A contract renderer that draws each note where renderSlugs puts it, written as the test says.
function renderer(note, slug) {
  return async ({ contentDir, outputDir }) => {
    const text = await readFile(path.join(contentDir, note), 'utf8');
    const target = path.join(outputDir, `${slug}.html`);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `<!doctype html><html><head></head><body><article><h1>N</h1><p>${text.length}</p></article></body></html>`);
    return { renderer: 'cyberchief', revision: PINNED_QUARTZ_COMMIT, tag: PINNED_QUARTZ_REF, outputDir };
  };
}

test('route C finds the built page: a post is drawn as a page, a new topic as its folder page', async () => {
  const raw = JSON.parse(await readFile(path.join(import.meta.dir, '..', 'owner-alpha.example.json'), 'utf8'));
  raw.proposalReview.enabled = true;
  raw.proposalReview.socketPath = '/run/user/1000/cyberbaser/review.sock';
  const config = validateOwnerAlphaConfig({ ...raw, renderer: { name: 'cyberchief', directory: projectRoot, quartzCommit: PINNED_QUARTZ_COMMIT, fingerprint: ['build'] } });
  const desk = await openBundleDesk({ config: { limits: { maxSourceBytes: 1 << 20 }, repository: { remote: { url: REMOTE_URL } } },
    git: bundleGit(vault.repo), directory: path.join(vault.root, 'bundles'), branchHead: async () => gitSync(vault.repo, 'rev-parse', 'main') });
  const owner = { keyId: 'phone', actor: { kind: 'owner-device', id: 'phone', label: 'Phone' } };
  const checkout = { assertCheckoutReady: async () => ({ root: vault.repo, head: gitSync(vault.repo, 'rev-parse', 'main') }) };
  const preview = async (submitted, note, slug) => {
    const record = await desk.load(submitted.bundleId);
    const input = { bundleId: submitted.bundleId, index: 0, bundle: parsePageBundle(record.bundleText), record, colorScheme: 'light', readImage: async () => null };
    return createBundlePreview({ config, projectRoot, render: renderer(note, slug), dependencies: checkout })(input);
  };

  // "Topic/Post/Post.md" holds only itself: a page, "<folder>.html".
  const post = `${TOPIC}/Fresh post/Fresh post.md`;
  const one = await desk.submit({ main: { path: post, text: '# Fresh\n' }, assets: [] }, owner, 'owner');
  expect(one.publicAdditions).toEqual([{ path: post, address: '/leadership-and-strategy/fresh-post' }]);
  expect(typeof await preview(one, post, 'leadership-and-strategy/fresh-post')).toBe('string');
  expect(await preview(one, post, 'leadership-and-strategy/fresh-post/index')).toEqual({ refused: 'address-mismatch' });

  // A new top-level topic's note is its folder's page, "<folder>/index.html".
  const topic = 'Threats & response/Threats & response.md';
  const publishable = await bundleVault({ ...FILES, 'publish.yml': 'allow:\n  - "**"\n' });
  try {
    const desk2 = await openBundleDesk({ config: { limits: { maxSourceBytes: 1 << 20 }, repository: { remote: { url: REMOTE_URL } } },
      git: bundleGit(publishable.repo), directory: path.join(publishable.root, 'bundles'), branchHead: async () => gitSync(publishable.repo, 'rev-parse', 'main') });
    const two = await desk2.submit({ main: { path: topic, text: '# Threats\n' }, assets: [] }, owner, 'owner');
    expect(two.publicAdditions).toEqual([{ path: topic, address: '/threats-and-response' }]);
    const record = await desk2.load(two.bundleId);
    const input = { bundleId: two.bundleId, index: 0, bundle: parsePageBundle(record.bundleText), record, colorScheme: 'light', readImage: async () => null };
    const at = (slug) => createBundlePreview({ config, projectRoot, render: renderer(topic, slug),
      dependencies: { assertCheckoutReady: async () => ({ root: publishable.repo, head: gitSync(publishable.repo, 'rev-parse', 'main') }) } })(input);
    expect(typeof await at('threats-and-response/index')).toBe('string');
    expect(await at('threats-and-response')).toEqual({ refused: 'address-mismatch' });
  } finally {
    await rm(publishable.root, { recursive: true, force: true });
  }
});

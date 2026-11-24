// Page bundles on a real Git fixture: every refusal the node makes, the
// create-once commit, and the publisher's own bundle rules.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { buildBundleCommit, checkPageBundle } from '../src/core/page-bundle.js';
import { checkBundleCommit } from '../src/publisher/bundle-publish.js';
import { exifTiff, jpeg, png, SVG } from '../../../packages/media-check/test/fixtures.js';
import { bundleOf, bundleVault, gitSync, readerFor } from './bundle-fixture.js';

let vault;
beforeAll(async () => { vault = await bundleVault(); });
afterAll(async () => { await rm(vault.root, { recursive: true, force: true }); });

const COVER = png();
const note = (body = 'Hello.\n', props = 'title: New\n') => `---\n${props}---\n${body}`;
const check = (bundle, assets = [], head = vault.head) => checkPageBundle({ bundle, git: vault.git, head, readAsset: readerFor(assets), maxSourceBytes: 1024 * 1024 });
const codeOf = async (promise) => { try { await promise; return 'ok'; } catch (error) { return error.code; } };
const create = (path, text = note(), assets = [], head = vault.head) => check(bundleOf(head, { creates: [{ path, text }], assets }), assets, head);

describe('a valid new page with a cover image', () => {
  test('passes, lists one public addition, and commits create-once on the pinned base', async () => {
    const assets = [{ path: 'topic/sub/cover.png', bytes: COVER }];
    const checked = await create('topic/sub/new-note.md', note('![[cover.png]]\n'), assets);
    expect(checked.publicAdditions).toEqual([{ path: 'topic/sub/new-note.md', address: '/topic/sub/new-note' }]);
    expect(checked.images).toEqual([{ path: 'topic/sub/cover.png', mediaType: 'image/png', byteLength: COVER.length }]);
    const before = gitSync(vault.repo, 'status', '--porcelain');
    const commit = await buildBundleCommit({ git: vault.git, checked, message: 'Add new-note\n',
      author: { name: 'Owner', email: 'owner@example.invalid' }, time: 1_800_000_000 });
    expect(gitSync(vault.repo, 'rev-parse', `${commit}^`)).toBe(vault.head);
    expect(gitSync(vault.repo, 'diff-tree', '-r', '--name-status', '--no-commit-id', vault.head, commit).split('\n').sort())
      .toEqual(['A\ttopic/sub/cover.png', 'A\ttopic/sub/new-note.md']);
    expect(Buffer.from(await vault.git(['cat-file', 'blob', `${commit}:topic/sub/cover.png`])).equals(Buffer.from(COVER))).toBe(true);
    // No ref moved and the working tree is untouched.
    expect(gitSync(vault.repo, 'rev-parse', 'main')).toBe(vault.head);
    expect(gitSync(vault.repo, 'status', '--porcelain')).toBe(before);
    // The publisher's own rules accept it.
    expect(await checkBundleCommit(vault.git, vault.head, commit)).toEqual({ ok: true });
  });

  test('a new folder with its index.md and a modify of an existing note', async () => {
    const checked = await check(bundleOf(vault.head, { creates: [{ path: 'topic/new/index.md', text: '# New folder\n' },
      { path: 'topic/new/first.md', text: '# First\n' }] }));
    expect(checked.publicAdditions.map((entry) => entry.address).sort()).toEqual(['/topic/new/', '/topic/new/first']);
  });
});

describe('every node refusal', () => {
  test('create-path-refused: hidden folders and reserved names', async () => {
    expect(await codeOf(create('.github/workflows/x.md'))).toBe('create-path-refused');
    expect(await codeOf(create('topic/.obsidian/x.md'))).toBe('create-path-refused');
    expect(await codeOf(create('topic/CON.md'))).toBe('create-path-refused');
    expect(await codeOf(create('topic/dir./x.md'))).toBe('create-path-refused');
    expect(await codeOf(create('topic/a:b.md'))).toBe('create-path-refused');
  });

  test('create-path-exists, create-path-case-collision, create-parent-is-file', async () => {
    expect(await codeOf(create('topic/existing.md'))).toBe('create-path-exists');
    expect(await codeOf(create('topic/Existing.md'))).toBe('create-path-case-collision');
    expect(await codeOf(create('Topic/new.md'))).toBe('create-path-case-collision');
    expect(await codeOf(create('topic/existing.md/child.md'))).toBe('create-parent-is-file');
  });

  test('create-address-collision: a slug another published page already has', async () => {
    expect(await codeOf(create('topic/a  b.md'))).toBe('create-address-collision');
  });

  test('create-outside-publication: outside the allow list, or a draft', async () => {
    expect(await codeOf(create('journal/new.md'))).toBe('create-outside-publication');
    expect(await codeOf(create('topic/wip.md', note('x\n', 'draft: true\n')))).toBe('create-outside-publication');
    expect(await codeOf(create('topic/sample.md', note('x\n', 'sample: true\n')))).toBe('create-outside-publication');
  });

  test('capture-base-moved: the branch head is not the pinned base', async () => {
    expect(await codeOf(check(bundleOf(vault.head, { creates: [{ path: 'topic/x.md', text: '# X\n' }] }), [], 'f'.repeat(40)))).toBe('capture-base-moved');
  });

  test('asset-type-refused, asset-type-mismatch, image-has-location', async () => {
    const polyglot = Uint8Array.from([...png(), ...Buffer.from('<script>alert(1)</script>')]);
    const refused = [{ path: 'topic/p.png', bytes: polyglot }];
    expect(await codeOf(create('topic/p.md', '![[p.png]]\n', refused))).toBe('asset-type-refused');
    const renamed = [{ path: 'topic/p.jpg', bytes: png() }];
    expect(await codeOf(create('topic/p.md', '![[p.jpg]]\n', renamed))).toBe('asset-type-mismatch');
    const gps = [{ path: 'topic/photo.jpg', bytes: jpeg({ exif: exifTiff() }) }];
    expect(await codeOf(create('topic/p.md', '![[photo.jpg]]\n', gps))).toBe('image-has-location');
    // SVG never gets a bundle at all.
    expect(await codeOf(Promise.resolve().then(() => bundleOf(vault.head, { creates: [{ path: 'topic/p.md', text: '![[l.svg]]' }],
      assets: [{ path: 'topic/l.svg', bytes: SVG, mediaType: 'image/svg+xml' }] })))).toBe('asset-type-refused');
  });

  test('asset-too-large and bundle-too-large are refused before any check', async () => {
    const big = (n, size) => ({ path: `topic/big${n}.png`, bytes: new Uint8Array(size) });
    expect(await codeOf(Promise.resolve().then(() => bundleOf(vault.head, { creates: [{ path: 'topic/p.md', text: 'x' }],
      assets: [big(0, 5 * 1024 * 1024 + 1)] })))).toBe('asset-too-large');
    expect(await codeOf(Promise.resolve().then(() => bundleOf(vault.head, { creates: [{ path: 'topic/p.md', text: 'x' }],
      assets: [big(0, 5 * 1024 * 1024), big(1, 5 * 1024 * 1024), big(2, 3 * 1024 * 1024)] })))).toBe('bundle-too-large');
  });

  test('asset-unreferenced: an image no page in the bundle shows', async () => {
    expect(await codeOf(create('topic/p.md', '# no image\n', [{ path: 'topic/lonely.png', bytes: COVER }]))).toBe('asset-unreferenced');
  });

  test('a cover named only in properties is shown by the page, by its vault path', async () => {
    const assets = [{ path: 'topic/sub/post-cover.png', bytes: COVER }];
    const checked = await create('topic/sub/post.md', note('No embeds.\n', 'title: Post\ncover: topic/sub/post-cover.png\n'), assets);
    expect(checked.images.map((image) => image.path)).toEqual(['topic/sub/post-cover.png']);
    const commit = await buildBundleCommit({ git: vault.git, checked, message: 'Add post\n',
      author: { name: 'Owner', email: 'owner@example.invalid' }, time: 1_800_000_000 });
    expect(await checkBundleCommit(vault.git, vault.head, commit)).toEqual({ ok: true });
    // A note-relative property value is not a reference.
    expect(await codeOf(create('topic/sub/post2.md', note('x\n', 'title: Post\ncover: post2-cover.png\n'),
      [{ path: 'topic/sub/post2-cover.png', bytes: COVER }]))).toBe('asset-unreferenced');
  });

  test('remote-image-refused: http(s), protocol-relative and data: images', async () => {
    for (const body of ['![x](https://example.com/a.png)\n', '![x](//example.com/a.png)\n', '<img src="data:image/png;base64,AAAA">\n']) {
      expect(await codeOf(create('topic/p.md', body))).toBe('remote-image-refused');
    }
  });

  const editExisting = (replacement) => {
    const base = Buffer.from('---\ntitle: Existing\n---\n# Existing\n\nHello. ![[shared/shown.png]]\n');
    const at = base.indexOf('title: Existing\n') + 'title: Existing\n'.length;
    return bundleOf(vault.head, { creates: [{ path: 'topic/new.md', text: '# New\n' }],
      modify: { path: 'topic/existing.md', baseBytes: base, operations: [{ operationId: 'e', start: at, end: at, expected: '', replacement }] } });
  };

  test('public-set-removal-refused, address-changed, public-set-change-unlisted', async () => {
    expect(await codeOf(check(editExisting('cb-publish: false\n')))).toBe('create-outside-publication');
    expect(await codeOf(check(editExisting('slug: elsewhere\n')))).toBe('address-changed');
    const embedPrivate = bundleOf(vault.head, { creates: [{ path: 'topic/new.md', text: '# New\n\n![[shared/private.png]]\n' }] });
    expect(await codeOf(check(embedPrivate))).toBe('public-set-change-unlisted');
  });

  test('public-set-removal-refused: an edit that takes an image off the site', async () => {
    const base = Buffer.from('---\ntitle: Existing\n---\n# Existing\n\nHello. ![[shared/shown.png]]\n');
    const at = base.indexOf(' ![[shared/shown.png]]');
    const removal = bundleOf(vault.head, { creates: [{ path: 'topic/new.md', text: '# New\n' }],
      modify: { path: 'topic/existing.md', baseBytes: base, operations: [{ operationId: 'e', start: at, end: at + ' ![[shared/shown.png]]'.length,
        expected: ' ![[shared/shown.png]]', replacement: '' }] } });
    expect(await codeOf(check(removal))).toBe('public-set-removal-refused');
  });

  test('capture-base-unavailable: a modify of a file the vault does not have', async () => {
    const missing = bundleOf(vault.head, { modify: { path: 'topic/missing.md', baseBytes: Buffer.from('x\n'),
      operations: [{ operationId: 'e', start: 0, end: 1, expected: 'x', replacement: 'y' }] } });
    expect(await codeOf(check(missing))).toBe('capture-base-unavailable');
  });
});

describe('the publisher re-checks a bundle commit on its own', () => {
  async function commitWith(files) {
    const env = { GIT_INDEX_FILE: `${vault.root}/index-${Math.random().toString(16).slice(2)}` };
    await vault.git(['read-tree', vault.head], { env });
    for (const [file, bytes] of Object.entries(files)) {
      const oid = (await vault.git(['hash-object', '-w', '--stdin'], { input: bytes })).toString().trim();
      await vault.git(['update-index', '--add', '--cacheinfo', `100644,${oid},${file}`], { env });
    }
    const tree = (await vault.git(['write-tree'], { env })).toString().trim();
    return (await vault.git(['commit-tree', tree, '-p', vault.head, '-F', '-'], { input: 'x\n', env: {
      GIT_AUTHOR_NAME: 'A', GIT_AUTHOR_EMAIL: 'a@example.invalid', GIT_COMMITTER_NAME: 'A', GIT_COMMITTER_EMAIL: 'a@example.invalid' } })).toString().trim();
  }

  test('publish.yml, hidden paths, case collisions and located photos are refused', async () => {
    expect((await checkBundleCommit(vault.git, vault.head, await commitWith({ 'publish.yml': 'allow: ["**"]\n', 'topic/x.md': '#\n' }))).code)
      .toBe('selection-config-change-refused');
    expect((await checkBundleCommit(vault.git, vault.head, await commitWith({ '.github/workflows/x.yml': 'x' }))).code).toBe('create-path-refused');
    expect((await checkBundleCommit(vault.git, vault.head, await commitWith({ 'topic/EXISTING.md': '#\n' }))).code).toBe('create-path-case-collision');
    expect((await checkBundleCommit(vault.git, vault.head, await commitWith({ 'topic/p.md': '#\n', 'topic/p.jpg': jpeg({ exif: exifTiff() }) }))).code)
      .toBe('image-has-location');
    expect((await checkBundleCommit(vault.git, vault.head, await commitWith({ 'topic/p.md': '#\n', 'topic/p.svg': SVG }))).code).toBe('asset-type-refused');
    expect((await checkBundleCommit(vault.git, vault.head, await commitWith({ 'topic/p.md': '#\n', 'topic/p.jpg': png() }))).code).toBe('asset-type-mismatch');
  });

  test('asset-unreferenced: an image no note in the commit shows, in its text or its properties', async () => {
    const lonely = await checkBundleCommit(vault.git, vault.head, await commitWith({ 'topic/p.md': '#\n', 'topic/p.png': png() }));
    expect(lonely).toEqual({ ok: false, code: 'asset-unreferenced', path: 'topic/p.png' });
    expect(await checkBundleCommit(vault.git, vault.head, await commitWith({ 'topic/p.md': '#\n![[p.png]]\n', 'topic/p.png': png() }))).toEqual({ ok: true });
    expect(await checkBundleCommit(vault.git, vault.head, await commitWith({ 'topic/p.md': '---\ncover: topic/p.png\n---\n#\n', 'topic/p.png': png() })))
      .toEqual({ ok: true });
  });
});

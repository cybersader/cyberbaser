import { describe, expect, test } from 'bun:test';
import {
  bundleCandidates, createPageBundle, PAGE_BUNDLE_LIMITS, pageBundleDigest, parsePageBundle, serializePageBundle, validatePageBundle,
} from '../src/index.js';

const SOURCE = { repository: 'https://github.com/example/vault.git', revision: 'a'.repeat(40) };
const SUBMISSION = { submittedAt: '2026-11-24T12:00:00Z', rationale: 'New page from a device.', evidence: [], identityClaim: null };
const IMAGE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

const input = (overrides = {}) => ({
  bundleId: 'bundle-1', source: SOURCE, submission: SUBMISSION, modify: null,
  creates: [{ path: 'topic/sub/new-note.md', text: '---\ntitle: New\n---\n![[cover.png]]\n' }],
  assets: [{ path: 'topic/sub/cover.png', mediaType: 'image/png', bytes: IMAGE }],
  ...overrides,
});

const code = (fn) => { try { fn(); } catch (error) { return error.code; } return 'no error'; };

describe('page bundle contract', () => {
  test('a new note with an image round-trips canonically and verifies its bytes', async () => {
    const bundle = createPageBundle(input());
    expect(bundle.files.map((file) => [file.path, file.kind])).toEqual([
      ['topic/sub/cover.png', 'create-asset'], ['topic/sub/new-note.md', 'create']]);
    const text = serializePageBundle(bundle);
    expect(parsePageBundle(text)).toEqual(bundle);
    expect(pageBundleDigest(bundle)).toMatch(/^sha-256=:/u);
    const out = await bundleCandidates(bundle, { readBase: () => { throw new Error('none'); }, readAsset: () => IMAGE });
    expect(out.get('topic/sub/cover.png').equals(IMAGE)).toBe(true);
    await expect(bundleCandidates(bundle, { readBase: () => null, readAsset: () => Buffer.from([1]) })).rejects.toMatchObject({ code: 'candidate-digest-mismatch' });
  });

  test('a modify plus a new note: the splice is checked against the base', async () => {
    const base = Buffer.from('# Topic\n\nSee also.\n');
    const bundle = createPageBundle(input({ assets: [], modify: { path: 'topic/index.md', baseBytes: base,
      operations: [{ operationId: 'link', start: 17, end: 17, expected: '', replacement: ' [[new-note]]' }] } }));
    const out = await bundleCandidates(bundle, { readBase: () => base, readAsset: () => null });
    expect(out.get('topic/index.md').toString()).toBe('# Topic\n\nSee also [[new-note]].\n');
    await expect(bundleCandidates(bundle, { readBase: () => Buffer.from('other'), readAsset: () => null })).rejects.toMatchObject({ code: 'base-digest-mismatch' });
  });

  test('limits: at most 2 new notes, 4 images, 1 modify', () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ path: `topic/sub/img${i}.png`, mediaType: 'image/png', bytes: IMAGE }));
    expect(code(() => createPageBundle(input({ assets: many })))).toBe('bundle-file-count');
    expect(code(() => createPageBundle(input({ creates: [{ path: 'a/x.md', text: 'x' }, { path: 'a/y.md', text: 'y' }] })))).toBe('bundle-file-count');
    expect(code(() => createPageBundle(input({ creates: [{ path: 'a/x.md', text: 'x' }, { path: 'b/index.md', text: 'y' }] })))).toBe('bundle-file-count');
    expect(createPageBundle(input({ creates: [{ path: 'a/x.md', text: 'x' }, { path: 'a/index.md', text: 'y' }], assets: [] })).files.length).toBe(2);
    expect(code(() => createPageBundle(input({ creates: [], assets: many.slice(0, 1) })))).toBe('bundle-file-count');
  });

  test('two new notes: a note plus its folder note, in either form (index.md or same-name)', () => {
    const two = (a, b) => createPageBundle(input({ creates: [{ path: a, text: 'x' }, { path: b, text: 'y' }], assets: [] }));
    // A post that is its own folder's note, plus its new topic's folder note.
    expect(two('Topic/Post/Post.md', 'Topic/Topic.md').files.length).toBe(2);
    expect(two('Topic/Post/Post.md', 'Topic/index.md').files.length).toBe(2);
    // Names compare as addresses: case, accents and & vs and do not matter.
    expect(two('Risk & governance/New page/New page.md', 'Risk & governance/risk and governance.md').files.length).toBe(2);
    // A KB page in a new sub-folder.
    expect(two('Knowledge base/Risk/New/Page/Page.md', 'Knowledge base/Risk/New/New.md').files.length).toBe(2);
    // Not the folder note of the note's own folder, or not a folder note at all.
    expect(code(() => two('Topic/Post/Post.md', 'Other/Other.md'))).toBe('bundle-file-count');
    expect(two('Topic/Post/Other.md', 'Topic/Post/Post.md').files.length).toBe(2);
    expect(code(() => two('Topic/Post/Post.md', 'Topic/Notes.md'))).toBe('bundle-file-count');
    expect(code(() => two('A/Post/Post.md', 'A/Post/index.md'))).toBe('bundle-file-count');
  });

  test('the folder-note rule here is the one in packages/publish addresses.js', async () => {
    const { isFolderNotePath } = await import('../../publish/src/addresses.js');
    const { isFolderNoteFile } = await import('../src/page-bundle.js');
    const cases = JSON.parse(await Bun.file(new URL('../../publish/test/fixtures/cyberchief-address-rule.cases.json', import.meta.url)).text()).cases;
    for (const { path } of cases.filter((c) => /\.md$/u.test(c.path))) {
      expect([path, isFolderNoteFile(path)]).toEqual([path, isFolderNotePath(path, 'lowercase-hyphen')]);
    }
  });

  test('sizes: one image over 5 MiB, a bundle over 12 MiB', () => {
    const big = (n) => ({ path: `topic/sub/big${n}.png`, mediaType: 'image/png', bytes: Buffer.alloc(PAGE_BUNDLE_LIMITS.maxAssetBytes) });
    expect(code(() => createPageBundle(input({ assets: [{ ...big(0), bytes: Buffer.alloc(PAGE_BUNDLE_LIMITS.maxAssetBytes + 1) }] })))).toBe('asset-too-large');
    expect(code(() => createPageBundle(input({ assets: [big(0), big(1), big(2)] })))).toBe('bundle-too-large');
  });

  test('paths: traversal, backslash, dot segments, parent conflicts, order', () => {
    for (const bad of ['../x.md', 'a/./x.md', 'a//x.md', '/a.md', 'a\\b.md', 'a/\u0001.md']) {
      expect(code(() => createPageBundle(input({ assets: [], creates: [{ path: bad, text: 'x' }] })))).toBe('create-path-refused');
    }
    expect(code(() => createPageBundle(input({ assets: [], creates: [{ path: 'a/x.txt', text: 'x' }] })))).toBe('create-path-refused');
    const bundle = createPageBundle(input());
    const swapped = { ...JSON.parse(JSON.stringify(bundle)), files: [...bundle.files].reverse() };
    expect(code(() => validatePageBundle(swapped))).toBe('noncanonical-order');
    expect(code(() => createPageBundle(input({ creates: [{ path: 'topic/x.md', text: 'x' }],
      assets: [{ path: 'topic/x.md/a.png', mediaType: 'image/png', bytes: IMAGE }] })))).toBe('create-parent-is-file');
  });

  test('image names and media types: SVG refused, mismatches refused', () => {
    expect(code(() => createPageBundle(input({ assets: [{ path: 'topic/sub/logo.svg', mediaType: 'image/svg+xml', bytes: IMAGE }] })))).toBe('asset-type-refused');
    expect(code(() => createPageBundle(input({ assets: [{ path: 'topic/sub/cover.jpg', mediaType: 'image/png', bytes: IMAGE }] })))).toBe('asset-type-mismatch');
  });

  test('a v2 consumer is not handed a bundle: schema and type are distinct', () => {
    const bundle = JSON.parse(serializePageBundle(createPageBundle(input())));
    expect(code(() => validatePageBundle({ ...bundle, schemaVersion: 2 }))).toBe('unsupported-schema');
    expect(code(() => validatePageBundle({ ...bundle, extra: 1 }))).not.toBe('no error');
  });
});

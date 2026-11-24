import { expect, test } from 'bun:test';
import { exifTiff, jpeg, png, pngChunk, SVG } from '../../../packages/media-check/test/fixtures.js';
import { hasLocation } from '../../../packages/media-check/src/index.js';
import { createController, messageFor } from '../src/core/controller.js';
import { NodeError } from '../src/core/client.js';
import { embeddedImages, newPageProblem, notePublicStatus, prepareImages } from '../src/core/new-page.js';
import { STATUS, statusFor } from '../src/core/status.js';

const PUBLISH_YML = 'allow:\n  - "topic/**"\n';

test('the device works out public status and address from its own publish.yml', () => {
  expect(notePublicStatus({ path: 'topic/a b.md', text: '# A\n', publishYml: PUBLISH_YML }))
    .toEqual({ published: true, address: '/topic/a-b', draft: false, marker: null, rule: 'rule-3-allowlist' });
  expect(notePublicStatus({ path: 'topic/x.md', text: '---\ndraft: true\n---\n', publishYml: PUBLISH_YML }))
    .toMatchObject({ published: false, draft: true, marker: 'draft' });
  expect(notePublicStatus({ path: 'journal/x.md', text: '# x', publishYml: PUBLISH_YML })).toMatchObject({ published: false, draft: false });
  expect(notePublicStatus({ path: 'topic/x.md', text: '# x', publishYml: null })).toMatchObject({ published: false, rule: 'config-unavailable' });
});

test('embedded images: vault images resolved, remote ones reported', () => {
  const text = '![[cover.jpg]]\n![a](https://example.com/x.png)\n![b](pics/b.png)\n![[other.md]]\n';
  const resolve = (target) => ({ 'cover.jpg': 'topic/cover.jpg', 'pics/b.png': 'topic/pics/b.png', 'other.md': 'topic/other.md' })[target] ?? null;
  expect(embeddedImages({ path: 'topic/n.md', text, resolve })).toEqual({ local: ['topic/cover.jpg', 'topic/pics/b.png'],
    remote: ['![a](https://example.com/x.png)'] });
});

test('a cover named only in properties is sent, by its exact vault path, once', () => {
  const vault = new Set(['from-the-field/x-cover.png', 'from-the-field/x.md']);
  const exists = (path) => vault.has(path);
  const resolve = () => null;
  const text = '---\ntitle: X\ncover: from-the-field/x-cover.png\nlink: https://example.com/a.png\n---\nNo embeds.\n';
  expect(embeddedImages({ path: 'from-the-field/x.md', text, resolve, exists })).toEqual({ local: ['from-the-field/x-cover.png'], remote: [] });
  // Embedded and named: listed once.
  const both = `${text}![[x-cover.png]]\n`;
  expect(embeddedImages({ path: 'from-the-field/x.md', text: both, resolve: () => 'from-the-field/x-cover.png', exists }).local)
    .toEqual(['from-the-field/x-cover.png']);
  // Not a vault path, or no such file: not sent.
  expect(embeddedImages({ path: 'from-the-field/x.md', text: '---\ncover: x-cover.png\n---\n', resolve, exists }).local).toEqual([]);
  expect(embeddedImages({ path: 'from-the-field/x.md', text, resolve }).local).toEqual([]);
});

test('GPS is stripped on the device before sending; refused images are flagged before anything is sent', () => {
  const photo = jpeg({ exif: exifTiff() });
  const [cleaned, plain, vector, renamed, pngGps] = prepareImages([
    { path: 'topic/photo.jpg', bytes: photo },
    { path: 'topic/plain.png', bytes: png() },
    { path: 'topic/logo.svg', bytes: SVG },
    { path: 'topic/renamed.jpg', bytes: png() },
    { path: 'topic/gps.png', bytes: png({ extra: [pngChunk('eXIf', [...exifTiff({ littleEndian: true })])] }) },
  ]);
  expect(cleaned).toMatchObject({ cleaned: true, refused: null, type: 'image/jpeg' });
  expect(hasLocation(cleaned.bytes)).toBe(false);
  expect(hasLocation(photo)).toBe(true);
  expect(plain).toMatchObject({ cleaned: false, refused: null });
  expect(vector.refused).toBe('asset-type-refused');
  expect(renamed.refused).toBe('asset-type-mismatch');
  expect(pngGps).toMatchObject({ cleaned: true, refused: null });
  const status = { published: true, draft: false };
  expect(newPageProblem({ status, images: [cleaned, plain], remote: [] })).toBeNull();
  expect(newPageProblem({ status, images: [vector], remote: [] })).toBe('asset-type-refused');
  expect(newPageProblem({ status: { published: false, draft: true }, images: [], remote: [] })).toBe('note-is-draft');
  expect(newPageProblem({ status: { published: false, draft: false }, images: [], remote: [] })).toBe('create-outside-publication');
  expect(newPageProblem({ status, images: [], remote: ['![x](https://e/x.png)'] })).toBe('remote-image-refused');
  expect(newPageProblem({ status, images: [plain, plain, plain, plain, plain], remote: [] })).toBe('bundle-file-count');
});

test('a draft is never sent: publishNewPage refuses before any request', async () => {
  const calls = [];
  const controller = createController({ client: { request: async (...args) => { calls.push(args); return {}; } },
    store: { load: async () => ({ keyId: 'k', grants: ['publish'] }) } });
  const status = notePublicStatus({ path: 'topic/x.md', text: '---\ndraft: true\n---\n', publishYml: PUBLISH_YML });
  await expect(controller.publishNewPage({ path: 'topic/x.md' }, '---\ndraft: true\n---\n', { status }))
    .rejects.toMatchObject({ reason: 'note-is-draft' });
  expect(calls).toEqual([]);
  expect(messageFor(new NodeError('refused', 'note-is-draft'))).toContain('draft');
  expect(messageFor(new NodeError('refused', 'image-has-location'))).toContain('where it was taken');
});

test('images go in 256 KiB chunks, then one bundle; the status reads Waiting for approval until live', async () => {
  const calls = [];
  const controller = createController({ client: { request: async (_p, command, input) => {
    calls.push([command, input]);
    if (command === 'submitPageBundle') return { bundleId: 'bundle-x', state: 'signing', publicAdditions: [{ path: 'topic/n.md', address: '/topic/n' }] };
    if (command === 'readNoteStatus') return { path: 'topic/n.md', selected: false, live: null };
    return { complete: false };
  } }, store: { load: async () => ({ keyId: 'k', grants: ['publish', 'propose'] }) } });
  const big = new Uint8Array(600 * 1024);
  const result = await controller.publishNewPage({ path: 'topic/n.md' }, '![[n.png]]', { status: { published: true, draft: false },
    images: [{ path: 'topic/n.png', bytes: big, size: big.length, refused: null }] });
  expect(result).toMatchObject({ kind: 'publishing', address: '/topic/n' });
  expect(calls.map(([command, input]) => [command, input.offset ?? null])).toEqual([
    ['stageAsset', 0], ['stageAsset', 262144], ['stageAsset', 524288], ['submitPageBundle', null]]);
  expect(calls.at(-1)[1].assets[0]).toMatchObject({ path: 'topic/n.png' });
  const { status } = await controller.status({ path: 'topic/n.md' }, '![[n.png]]');
  expect(status).toEqual({ key: 'waiting', label: STATUS.waiting });
  const draft = await controller.status({ path: 'topic/n.md' }, '---\ndraft: true\n---\n', { publishYml: PUBLISH_YML });
  expect(draft.status).toEqual({ key: 'draft', label: STATUS.draft });
  expect(statusFor({ reply: { selected: true, live: { digest: 'd', folded: false } }, waiting: true }, { exact: 'd' }).key).toBe('live');
});

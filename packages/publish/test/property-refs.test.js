import { test, expect } from 'bun:test';
import { noteAssetTargets, selectFiles, RULES } from '../src/select.js';
import { propertyImagePath, propertyImageRefs, propertyImages } from '../src/property-refs.js';

const CONFIG = { allow: ['posts/**', 'authors/**'] };

test('a property value names an image only by its exact vault path', () => {
  expect(propertyImagePath('posts/x-cover.png')).toBe('posts/x-cover.png');
  expect(propertyImagePath('/posts/x-cover.PNG')).toBe('posts/x-cover.PNG');
  expect(propertyImagePath('[[posts/x-cover.png]]')).toBe('posts/x-cover.png');
  expect(propertyImagePath('![[posts/x-cover.png|wide]]')).toBe('posts/x-cover.png');
  for (const value of ['https://example.com/x.png', '//cdn/x.png', 'data:image/png;base64,AA', '../x.png', 'posts/../x.png',
    'posts/x.md', 'posts/notes', 'a title.', 'x.png?v=1', 'x\\y.png', '', 42, true, null, ['posts/x.png']]) {
    expect(propertyImagePath(value)).toBeNull();
  }
});

test('refs come from top-level properties and carry the key and line', () => {
  const text = '---\ntitle: X\ncover: posts/x-cover.png\nnested:\n  image: posts/y.png\n---\nbody\n';
  expect(propertyImageRefs(text)).toEqual([{ key: 'cover', target: 'posts/x-cover.png', candidates: ['posts/x-cover.png'], line: 3, kind: 'property', raw: 'cover: posts/x-cover.png' }]);
  expect(propertyImageRefs(text, 'posts/x/x.md')[0].candidates).toEqual(['posts/x-cover.png', 'posts/x/posts/x-cover.png']);
  expect(propertyImageRefs('---\n: [\n---\n')).toEqual([]);
  expect(propertyImages(text, (p) => p === 'posts/x-cover.png')).toEqual(['posts/x-cover.png']);
  expect(propertyImages(text, () => false)).toEqual([]);
});

test('rule 5: a cover named only in properties publishes with its page', () => {
  const files = {
    'posts/a.md': '---\ntitle: A\ncover: posts/a-cover.png\n---\nNo embeds.\n',
    'posts/a-cover.png': null,
    'authors/chief.md': '---\ntitle: Chief\navatar: authors/chief/avatar.png\nportrait: "[[authors/chief/portrait.png]]"\n---\n',
    'authors/chief/avatar.png': null,
    'authors/chief/portrait.png': null,
    'private/p.md': '---\ncover: private/secret.png\n---\n',
    'private/secret.png': null,
  };
  const { published, report } = selectFiles(files, CONFIG);
  expect(published).toContain('posts/a-cover.png');
  expect(published).toContain('authors/chief/avatar.png');
  expect(published).toContain('authors/chief/portrait.png');
  expect(published).not.toContain('private/secret.png');
  expect(report.assets.find((a) => a.path === 'posts/a-cover.png').referencedBy[0]).toMatchObject({ source: 'posts/a.md', kind: 'property', line: 3 });
  expect(report.denied.find((d) => d.path === 'private/secret.png').rule).toBe(RULES.ASSET_UNREACHABLE);
});

test('rule 5: a property image is found from the vault root, then the note\'s own folder, never by file name', () => {
  const files = {
    'Topic/Post/Post.md': '---\ncover: Post cover.jpg\n---\n',
    'Topic/Post/Post cover.jpg': null,
    'Topic/Other/Other.md': '---\ncover: lonely.png\n---\n',
    'Elsewhere/lonely.png': null,
    'Topic/Both/Both.md': '---\ncover: both.png\n---\n',
    'Topic/Both/both.png': null,
    'both.png': null,
  };
  const { published, report } = selectFiles(files, { allow: ['**'] });
  expect(published).toContain('Topic/Post/Post cover.jpg');
  // Obsidian's third step (the only file of that name anywhere) is not taken.
  expect(published).not.toContain('Elsewhere/lonely.png');
  // The vault root comes first, as in Obsidian and the Cyberchief renderer.
  expect(published).toContain('both.png');
  expect(published).not.toContain('Topic/Both/both.png');
  expect(report.assets.find((a) => a.path === 'Topic/Post/Post cover.jpg').referencedBy[0]).toMatchObject({ source: 'Topic/Post/Post.md', kind: 'property' });
  expect(propertyImages('---\ncover: Post cover.jpg\n---\n', (p) => p === 'Topic/Post/Post cover.jpg', 'Topic/Post/Post.md')).toEqual(['Topic/Post/Post cover.jpg']);
  expect(propertyImages('---\ncover: Post cover.jpg\n---\n', (p) => p === 'Topic/Post/Post cover.jpg')).toEqual([]);
});

test('noteAssetTargets: body embeds, links and property images, resolved like the selector', () => {
  const paths = ['posts/a.md', 'posts/a-cover.png', 'posts/inline.jpg', 'shared/d.webp', 'posts/other.md'];
  const text = '---\ncover: posts/a-cover.png\n---\n![[inline.jpg]] ![d](../shared/d.webp) [[other]]\n';
  expect(noteAssetTargets('posts/a.md', text, paths)).toEqual(['posts/a-cover.png', 'posts/inline.jpg', 'shared/d.webp']);
  expect(noteAssetTargets('posts/a.md', '---\ncover: posts/missing.png\n---\n', paths)).toEqual([]);
  expect(noteAssetTargets('posts/a.md', '---\ncover: a-cover.png\n---\n', paths)).toEqual(['posts/a-cover.png']);
});

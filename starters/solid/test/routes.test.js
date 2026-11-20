import { expect, test } from 'bun:test';
import { assertDistinctOutputs, makeResolver, relativeUrl } from '../src/routes.js';
import { parseNote, renderMarkdown } from '../src/markdown.js';

test('encoded segments, slug override, and exact-case resolution preserve source-relative semantics', () => {
  const from = parseNote('Guides/A.md', '---\nslug: moved/A\n---\n[Link](../Docs/100%25%20%231.md#Résumé)');
  const to = parseNote('Docs/100% #1.md', '---\nslug: "Référence/100% #1"\n---\n## Résumé');
  const fromWithLink = makeResolver([from, to], []);
  expect(renderMarkdown(from, fromWithLink)).toContain('href="../R%C3%A9f%C3%A9rence/100%25%20%231.html#r%C3%A9sum%C3%A9"');
  expect(fromWithLink(from, '../docs/100%25%20%231.md', 'link')?.url).toBe('../R%C3%A9f%C3%A9rence/100%25%20%231.html');
  expect(fromWithLink(from, '%2e%2e/Docs/100%25%20%231.md', 'link')).toBeUndefined();
  expect(fromWithLink(from, '../Docs%2f100%25%20%231.md', 'link')).toBeUndefined();
  expect(relativeUrl('notes/dir/file.html', 'notes/example:part.html')).toBe('../example%3Apart.html');
});

test('wikilink ambiguity stays inert and local exact matches take precedence', () => {
  const from = parseNote('nested/from.md', 'From');
  const first = parseNote('first/shared.md', '---\naliases: [Alias]\n---\nFirst');
  const second = parseNote('second/shared.md', '---\naliases: [alias]\n---\nSecond');
  const local = parseNote('nested/shared.md', 'Local');
  const resolve = makeResolver([from, first, second, local], []);
  expect(resolve(from, 'Alias', 'wiki')?.url).toBe('../first/shared.html');
  expect(resolve(from, 'ALIAS', 'wiki')).toBeUndefined();
  expect(resolve(from, 'shared', 'wiki')?.url).toBe('./shared.html');
  expect(resolve(from, '../second/shared', 'wiki')?.url).toBe('../second/shared.html');
  expect(resolve(from, './Alias', 'wiki')).toBeUndefined();
});

test('output plans refuse file/directory collisions', () => {
  expect(() => assertDistinctOutputs(['notes/entry.html', 'notes/entry.html/nested.html'])).toThrow('output file conflicts with directory');
});

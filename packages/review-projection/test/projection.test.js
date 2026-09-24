import { expect, test } from 'bun:test';
import { documentProjection, inlineTokens, markdownBlocks } from '../src/index.js';

const BASE = '# Backup retention\n\nDaily backups are kept for thirty days.\n\n## Recovery\n\nTest one restore each quarter.\n';

function project(baseText, candidateText, operations) {
  return documentProjection({
    files: [{ path: 'handbook/backup.md', exists: baseText !== null, baseText, candidateText }],
    operations: operations.map((operation) => ({ path: 'handbook/backup.md', ...operation })),
  });
}
function operationFor(baseText, oldText, replacementText) {
  const start = Buffer.byteLength(baseText.slice(0, baseText.indexOf(oldText)), 'utf8');
  return { start, end: start + Buffer.byteLength(oldText, 'utf8'), oldText, replacementText };
}

test('every mode replays the declared operations over the pinned base', () => {
  const operation = operationFor(BASE, 'thirty days', 'ninety days');
  const candidate = BASE.replace('thirty days', 'ninety days');
  const projection = project(BASE, candidate, [operation]);

  expect(projection.modes).toEqual({
    changes: { available: true, reason: null },
    proposed: { available: true, reason: null },
    current: { available: true, reason: null },
  });
  const [file] = projection.files;
  expect(file.current.segments.map((item) => item.text).join('')).toBe(BASE);
  expect(file.proposed.segments.map((item) => item.text).join('')).toBe(candidate);
  expect(file.unified.segments.map((item) => item.kind)).toEqual(['context', 'removed', 'added', 'context']);
  expect(file.operationNumbers).toEqual([1]);

  for (const segment of file.current.segments) {
    expect(BASE.slice(segment.start, segment.end)).toBe(segment.text);
  }
});

test('insertions and deletions keep an anchor instead of inventing text', () => {
  const insertionStart = Buffer.byteLength(BASE.slice(0, BASE.indexOf('\n\n## Recovery')), 'utf8');
  const inserted = ' Older archives are pruned automatically.';
  const insertion = project(
    BASE,
    `${BASE.slice(0, BASE.indexOf('\n\n## Recovery'))}${inserted}${BASE.slice(BASE.indexOf('\n\n## Recovery'))}`,
    [{ start: insertionStart, end: insertionStart, oldText: '', replacementText: inserted }],
  );
  expect(insertion.files[0].current.segments.map((item) => item.kind)).toEqual(['context', 'insertion-point', 'context']);
  expect(insertion.files[0].proposed.segments.map((item) => item.kind)).toEqual(['context', 'added', 'context']);

  const deletionOperation = operationFor(BASE, '\n\n## Recovery\n\nTest one restore each quarter.', '');
  const deletion = project(BASE, BASE.replace('\n\n## Recovery\n\nTest one restore each quarter.', ''), [deletionOperation]);
  expect(deletion.files[0].proposed.segments.map((item) => item.kind)).toEqual(['context', 'deletion-point', 'context']);
});

test('the projection refuses to derive a view it cannot reproduce', () => {
  const operation = operationFor(BASE, 'thirty days', 'ninety days');

  const stale = project(BASE, null, [operation]);
  expect(stale.modes.current.available).toBe(true);
  expect(stale.modes.proposed.reason).toContain('No candidate result is derivable');

  const wrongOldBytes = project(BASE, BASE, [{ ...operation, oldText: 'sixty days' }]);
  expect(wrongOldBytes.modes.current.reason).toContain('declared old bytes do not match');

  const wrongCandidate = project(BASE, `${BASE}fabricated tail\n`, [operation]);
  expect(wrongCandidate.modes.proposed.reason).toContain('does not reproduce the declared candidate');

  const overlapping = project(BASE, BASE, [
    { start: 2, end: 10, oldText: BASE.slice(2, 10), replacementText: 'x' },
    { start: 6, end: 12, oldText: BASE.slice(6, 12), replacementText: 'y' },
  ]);
  expect(overlapping.modes.current.reason).toContain('not canonically ordered');

  const missingBase = project(null, 'A brand new page.\n', [{ start: 0, end: 0, oldText: '', replacementText: 'A brand new page.\n' }]);
  expect(missingBase.modes.current.reason).toContain('does not exist in the pinned base');
  expect(missingBase.modes.proposed.available).toBe(true);
});

test('blocks partition the document and name any construct outside the rung', () => {
  const text = '---\ntitle: Example\n---\n\n# Heading\n\nProse with **bold** and a [[wikilink]].\n\n> [!note] Callout\n> Body.\n\n| a | b |\n| - | - |\n';
  const blocks = markdownBlocks(text);
  expect(blocks[0].start).toBe(0);
  expect(blocks.at(-1).end).toBe(text.length);
  for (let index = 1; index < blocks.length; index += 1) {
    expect(blocks[index].start).toBe(blocks[index - 1].end);
  }
  const named = blocks.filter((block) => block.uninterpreted.length > 0).map((block) => block.uninterpreted);
  expect(named).toEqual([['callout'], ['table']]);
  expect(blocks[0].kind).toBe('frontmatter');
  expect(blocks[0].entries).toEqual([{ name: 'title', value: 'Example' }]);
});

test('inline tokens never pass raw HTML through and expose invisible controls', () => {
  expect(inlineTokens('<img src=x onerror=alert(1)>').map((item) => item.type)).toEqual(['text']);
  expect(inlineTokens('<img src=x>')[0].text).toBe('<img src=x>');
  const bidi = inlineTokens('before‮after');
  expect(bidi[0].text).toContain('⟦U+202E RIGHT-TO-LEFT OVERRIDE⟧');
  expect(bidi[0].text).not.toContain('‮');
  expect(inlineTokens('a `code` and [text](/where/)').filter((item) => item.type !== 'text').map((item) => item.type))
    .toEqual(['code', 'link']);
});

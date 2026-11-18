import { expect, test } from 'bun:test';
import {
  DOCUMENT_UNAVAILABLE_REASONS,
  documentProjection,
  inlineTokens,
  markdownBlocks,
  segmentsWithinSpan,
} from '../src/index.js';

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
  // Context is cut at the edges of the changed block so consumers never slice exposed text.
  expect(file.unified.segments.map((item) => item.kind)).toEqual(['context', 'context', 'removed', 'added', 'context', 'context']);
  expect(file.unified.segments.map((item) => item.text).join('')).toBe(BASE.slice(0, operation.start) + 'thirty days' + 'ninety days' + BASE.slice(operation.end));
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
  expect(insertion.files[0].current.segments.map((item) => item.kind)).toEqual(['context', 'context', 'insertion-point', 'context', 'context']);
  expect(insertion.files[0].proposed.segments.map((item) => item.kind)).toEqual(['context', 'context', 'added', 'context', 'context']);

  const deletionOperation = operationFor(BASE, '\n\n## Recovery\n\nTest one restore each quarter.', '');
  const deletion = project(BASE, BASE.replace('\n\n## Recovery\n\nTest one restore each quarter.', ''), [deletionOperation]);
  expect(deletion.files[0].proposed.segments.map((item) => item.kind)).toEqual(['context', 'context', 'deletion-point', 'context']);
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

test('keeps structure on CRLF files while offsets still cover the raw bytes', () => {
  const text = '---\r\ntitle: Example\r\n---\r\n\r\n# Heading\r\n\r\nProse line.\r\n\r\n- item\r\n\r\n---\r\n';
  const blocks = markdownBlocks(text);
  expect(blocks.filter((block) => block.kind !== 'gap').map((block) => block.kind))
    .toEqual(['frontmatter', 'heading', 'paragraph', 'list', 'rule']);
  expect(blocks[0].entries).toEqual([{ name: 'title', value: 'Example' }]);
  expect(blocks.at(-1).end).toBe(text.length);
  for (let index = 1; index < blocks.length; index += 1) expect(blocks[index].start).toBe(blocks[index - 1].end);
});

test('degrades every construct outside the rung instead of reading it wrongly', () => {
  const named = (text) => markdownBlocks(text).filter((block) => block.kind !== 'gap').map((block) => [block.kind, [...block.uninterpreted]]);
  expect(named('See ![alt](img.png) here.\n')).toEqual([['paragraph', ['image']]]);
  expect(named('Week | Primary\n--- | ---\n38 | Dana\n')).toEqual([['paragraph', ['table']]]);
  expect(named('Title\n=====\n')).toEqual([['paragraph', ['setext heading']]]);
  expect(named('Title\n---\n')).toEqual([['paragraph', ['setext heading']], ['rule', []]]);
  expect(named('    indented code\n')).toEqual([['paragraph', ['indented block']]]);
  expect(named('Text <!-- hidden --> more\n')).toEqual([['paragraph', ['inline HTML']]]);
  expect(named('---\ntags:\n  - a\n---\n')).toEqual([['frontmatter', ['structured metadata']]]);
  expect(named('---\ntitle: Flat\nreviewed: 2026-01-01\n---\n')).toEqual([['frontmatter', []]]);
  expect(named('* * *\n')).toEqual([['rule', []]]);
  expect(named('- - -\n')).toEqual([['rule', []]]);
});

test('inline scanning keeps intraword underscores and every wikilink alias character', () => {
  expect(inlineTokens('use snake_case_name here').map((item) => item.type)).toEqual(['text']);
  expect(inlineTokens('an _emphasised_ word').map((item) => item.type)).toEqual(['text', 'emphasis', 'text']);
  const [wikilink] = inlineTokens('[[Page|alias|extra]]');
  expect(wikilink).toMatchObject({ type: 'wikilink', text: 'alias|extra', target: 'Page' });
  expect(inlineTokens('[text](https://x.example/a) tail')[0]).toMatchObject({ type: 'link', text: 'text', target: 'https://x.example/a' });
  expect(inlineTokens('[unclosed and `code`').map((item) => item.type)).toEqual(['text', 'code']);
});

test('adversarial inline and block input stays linear', () => {
  const started = performance.now();
  markdownBlocks(`${'['.repeat(65_536)}\n`);
  markdownBlocks(`${'*'.repeat(65_536)}\n`);
  markdownBlocks(`${'![['.repeat(16_384)}\n`);
  markdownBlocks(`\`\`\`\n${'\n'.repeat(65_536)}\`\`\`\n`);
  markdownBlocks(`${'_a'.repeat(32_768)}\n`);
  expect(performance.now() - started).toBeLessThan(5_000);
});

test('refuses byte offsets that are out of range or split a character', () => {
  const base = 'A 😀 b.\n';
  const inside = documentProjection({
    files: [{ path: 'a.md', exists: true, baseText: base, candidateText: base }],
    operations: [{ path: 'a.md', start: 3, end: 3, oldText: '', replacementText: 'x' }],
  });
  expect(inside.modes.current.reason).toBe(DOCUMENT_UNAVAILABLE_REASONS.invalidOffsets);
  const beyond = documentProjection({
    files: [{ path: 'a.md', exists: true, baseText: base, candidateText: base }],
    operations: [{ path: 'a.md', start: 40, end: 40, oldText: '', replacementText: 'x' }],
  });
  expect(beyond.modes.current.reason).toBe(DOCUMENT_UNAVAILABLE_REASONS.invalidOffsets);
  const boundary = Buffer.byteLength('A 😀 ');
  const valid = documentProjection({
    files: [{ path: 'a.md', exists: true, baseText: base, candidateText: base.replace('b', 'B') }],
    operations: [{ path: 'a.md', start: boundary, end: boundary + 1, oldText: 'b', replacementText: 'B' }],
  });
  expect(valid.modes.current.available).toBe(true);
  expect(valid.files[0].proposed.segments.map((item) => item.text).join('')).toBe(base.replace('b', 'B'));
});

test('an appended change belongs to the final block and context never crosses a changed block', () => {
  const base = '# T\n\nFirst\u200bpara.\n\nLast para.\n';
  const appended = '\nAdded.\n';
  const projection = documentProjection({
    files: [{ path: 'a.md', exists: true, baseText: base, candidateText: base + appended }],
    operations: [{ path: 'a.md', start: Buffer.byteLength(base), end: Buffer.byteLength(base), oldText: '', replacementText: appended }],
  });
  const { unified } = projection.files[0];
  const last = unified.blocks.at(-1);
  const documentEnd = last.end;
  expect(segmentsWithinSpan(unified.segments, last, documentEnd).map((item) => item.kind)).toEqual(['context', 'added']);
  expect(segmentsWithinSpan(unified.segments, unified.blocks[0], documentEnd).map((item) => item.kind)).toEqual(['context']);

  // The invisible character is spelled out in the text, but every context segment
  // still lies entirely inside or entirely outside the changed block.
  const changed = unified.blocks.filter((block) => segmentsWithinSpan(unified.segments, block, documentEnd).some((item) => item.kind !== 'context'));
  expect(changed).toEqual([last]);
  for (const item of unified.segments.filter((segment) => segment.kind === 'context')) {
    const inside = item.start >= last.start && item.end <= last.end;
    const outside = item.end <= last.start || item.start >= last.end;
    expect(inside || outside).toBe(true);
  }
  expect(unified.segments.some((item) => item.text.includes('⟦U+200B ZERO WIDTH SPACE⟧'))).toBe(true);
});

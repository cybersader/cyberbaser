import { describe, expect, test } from 'bun:test';
import { Buffer } from 'node:buffer';
import { publicationDisplay, refineForDisplay, verifiedDisplayProjection } from '../src/publication-display.js';
import { publicationRehearsalCorpus, PUBLICATION_REHEARSAL_BASE } from '../bin/publication-rehearsal-corpus.js';
const path = 'synthetic.md';
function input(baseText, candidateText, start = 0, end = Buffer.byteLength(baseText), replacementText = candidateText) {
  return { path, baseText, candidateText, operation: { path, start, end,
    oldText: Buffer.from(baseText).subarray(start, end).toString('utf8'), replacementText } };
}
function replay(base, operations) {
  let result = Buffer.from(base);
  for (const operation of [...operations].reverse()) result = Buffer.concat([result.subarray(0, operation.start), Buffer.from(operation.replacementText), result.subarray(operation.end)]);
  return result.toString('utf8');
}
describe('publication-only derived display', () => {
  test('long corpus is realistic and dispersed differences leave intervening blocks unmarked', () => {
    const corpus = publicationRehearsalCorpus();
    expect(PUBLICATION_REHEARSAL_BASE.split(/\s+/u).length).toBeGreaterThanOrEqual(1500);
    expect(PUBLICATION_REHEARSAL_BASE.split(/\s+/u).length).toBeLessThanOrEqual(2500);
    const display = publicationDisplay(input(corpus.base, corpus.candidate));
    expect(display.available).toBe(true); expect(display.coarse).toBe(false); expect(display.markCount).toBe(2);
    expect(display.operations).toHaveLength(2); expect(replay(corpus.base, display.operations)).toBe(corpus.candidate);
    const between = display.rows.find((row) => row.block?.raw?.includes('A shared bench'))
      ?? display.rows.find((row) => row.block && corpus.candidate.slice(row.block.start, row.block.end).startsWith('A shared bench'));
    expect(between).toBeDefined(); expect(between.changed).toBe(false); expect(between.mark).toBe(null);
  });
  test('mid-line partial first and last fragments preserve multibyte boundaries, not block alignment', () => {
    const base = 'préfix café OLD tail\n\nSame paragraph.\n\n終 OLD suffix\n';
    const start = Buffer.byteLength('préfix café '); const end = Buffer.byteLength(base.slice(0, base.lastIndexOf('OLD') + 3));
    const replacement = Buffer.from(base).subarray(start, end).toString('utf8').replaceAll('OLD', 'NEW 🙂');
    const candidate = Buffer.from(base).subarray(0, start).toString('utf8') + replacement + Buffer.from(base).subarray(end).toString('utf8');
    const display = publicationDisplay(input(base, candidate, start, end, replacement));
    expect(display.available).toBe(true); expect(display.operations).toHaveLength(2);
    expect(display.operations[0].start).toBe(start); expect(display.operations.at(-1).end).toBe(end);
    expect(replay(base, display.operations)).toBe(candidate);
    expect(display.rows.filter((row) => row.changed)).toHaveLength(2);
    expect(display.rows.find((row) => row.block && candidate.slice(row.block.start, row.block.end).includes('Same paragraph')).changed).toBe(false);
  });
  test.each([
    ['repeat\nrepeat\nlast\n', 'repeat\nchanged\nlast\n'],
    ['first\n\nkeep\n\nlast\n', 'keep\n'],
    ['keep\n', 'start\n\nkeep\n\nend\n'],
    ['α\n\nβ\n', 'α\n\n'],
    ['\n\ntext\n', '\ntext\n'],
    ['', '🙂\n'],
  ])('replays repeated lines, deletion, edge insertion and whitespace: %s', (base, candidate) => {
    const display = publicationDisplay(input(base, candidate));
    expect(display.available).toBe(true); expect(replay(base, display.operations)).toBe(candidate);
    for (const operation of display.operations) expect(Buffer.from(base).subarray(operation.start, operation.end).toString('utf8')).toBe(operation.oldText);
  });
  test('pure deletion owns a visible location and does not mark the unchanged neighbour', () => {
    const display = publicationDisplay(input('remove\n\nkeep\n', 'keep\n'));
    expect(display.rows.some((row) => row.removed && row.mark)).toBe(true);
    expect(display.rows.find((row) => row.block).changed).toBe(false);
  });
  test('failed refined replay falls back original, without trusting a corrupt original', () => {
    const value = input('old\n', 'new\n');
    const fallback = verifiedDisplayProjection(value, { operations: [{ ...value.operation, replacementText: 'wrong' }] });
    expect(fallback.available).toBe(true); expect(fallback.operations).toEqual([value.operation]); expect(fallback.coarseReason).toContain('could not be verified');
    for (const corrupt of [{ oldText: 'wrong' }, { replacementText: 'wrong' }, { start: -1 }, { end: -1 }]) {
      expect(publicationDisplay({ ...value, operation: { ...value.operation, ...corrupt } }).available).toBe(false);
    }
    expect(publicationDisplay({ ...value, baseText: null }).available).toBe(false);
    const unicode = input('é old', 'é new'); unicode.operation.start = 1;
    expect(publicationDisplay(unicode).available).toBe(false);
  });
  test('all display budgets withdraw individual navigation, retaining complete evidence', () => {
    const value = input('# Title\n\nold\n\nlast\n', '# Title\n\nnew\n\nchanged\n');
    for (const limit of [{ maxBytes: 1 }, { maxLines: 1 }, { maxDiffCells: 1 }, { maxBlocks: 1 }, { maxMarks: 1 }]) {
      const display = publicationDisplay(value, limit);
      expect(display.available).toBe(true); expect(display.coarse).toBe(true); expect(display.markCount).toBe(0);
      expect(display.rows.every((row) => row.mark === null)).toBe(true);
      expect(replay(value.baseText, display.operations)).toBe(value.candidateText);
    }
  });
  test('broad rewrite and actual diff-budget fixture become honest coarse review', () => {
    for (const variation of ['broad', 'coarse']) {
      const corpus = publicationRehearsalCorpus(variation); const display = publicationDisplay(input(corpus.base, corpus.candidate));
      expect(display.available).toBe(true); expect(display.coarse).toBe(true); expect(display.markCount).toBe(0);
      expect(display.exactOnly).toBe(false); expect(display.rows.length).toBeGreaterThan(20);
    }
  });
  test('actual default mark budget exceeds 500 without a partial 500-mark review', () => {
    const base = Array.from({ length: 501 }, (_, index) => `Old paragraph ${index}.\n\n`).join('');
    const candidate = base.replaceAll('Old paragraph', 'New paragraph');
    const display = publicationDisplay(input(base, candidate));
    expect(display.differingBlocks).toBe(501); expect(display.coarseReason).toContain('too many blocks');
    expect(display.markCount).toBe(0); expect(display.rows.every((row) => row.mark === null)).toBe(true);
    expect(display.exactOnly).toBe(false); expect(display.rows.filter((row) => row.block)).toHaveLength(501);
    expect(replay(base, display.operations)).toBe(candidate);
  });
  test('both partial edges may directly abut multibyte characters', () => {
    const base = 'éOLD\n\nUnchanged.\n\nOLD終'; const start = Buffer.byteLength('é'); const end = Buffer.byteLength(base) - Buffer.byteLength('終');
    const replacement = 'NEW\n\nUnchanged.\n\nNEW'; const candidate = `é${replacement}終`;
    const display = publicationDisplay(input(base, candidate, start, end, replacement));
    expect(display.available).toBe(true); expect(display.operations).toHaveLength(2);
    expect(display.operations[0].start).toBe(start); expect(display.operations[1].end).toBe(end);
    expect(replay(base, display.operations)).toBe(candidate); expect(candidate).not.toContain('�');
    expect(display.rows.find((row) => row.block && candidate.slice(row.block.start, row.block.end).startsWith('Unchanged')).changed).toBe(false);
  });
  test('unsupported table is a normal labelled-source block, not an inconsistent operation', () => {
    const corpus = publicationRehearsalCorpus('table'); const display = publicationDisplay(input(corpus.base, corpus.candidate));
    expect(display.available).toBe(true); expect(display.markCount).toBe(1);
    expect(display.rows.find((row) => row.changed).block.uninterpreted.length).toBeGreaterThan(0);
  });
});

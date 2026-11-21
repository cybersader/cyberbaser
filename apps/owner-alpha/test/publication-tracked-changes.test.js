import { describe, expect, test } from 'bun:test';
import { publicationDisplay, verifiedDisplayProjection } from '../src/publication-display.js';
import { readFile } from 'node:fs/promises';
import { comparable, identity, reconstruct, trackedChanges, verifyRuns, wordUnits, TRACKED_CHANGE_LIMITS } from '../src/publication-tracked-changes.js';
import { publicationRehearsalCorpus } from '../bin/publication-rehearsal-corpus.js';
function input(baseText, candidateText) { return { path: 'test.md', baseText, candidateText,
  operation: { path: 'test.md', start: 0, end: Buffer.byteLength(baseText), oldText: baseText, replacementText: candidateText } }; }
function review(base, next, overrides = {}, Segmenter = Intl.Segmenter) {
  const value = input(base, next); const display = publicationDisplay(value);
  return trackedChanges(display, value, overrides, Segmenter);
}
const changed = (result) => result.rows.filter((row) => row.changed);
function prove(result) {
  for (const row of result.rows.filter((entry) => entry.tracked?.kind === 'inline')) {
    for (let i = 0; i < row.tracked.groups.length; i += 1) {
      expect(verifyRuns(row.tracked.groups[i].runs, row.tracked.base.streams[i], row.tracked.candidate.streams[i])).toBe(true);
      expect(identity(reconstruct(row.tracked.groups[i].runs, 'base'))).toBe(identity(row.tracked.base.streams[i]));
      expect(identity(reconstruct(row.tracked.groups[i].runs, 'candidate'))).toBe(identity(row.tracked.candidate.streams[i]));
    }
  }
}
describe('publication endpoint tracked changes', () => {
  test.each(['small', 'dispersed'])('same full-page %s has meaningful inline changes and untouched prose', (variation) => {
    const corpus = publicationRehearsalCorpus(variation); const result = review(corpus.base, corpus.candidate);
    expect(result.reason).toBe(null); expect(result.counts.inline).toBe(variation === 'small' ? 1 : 2);
    const runs = changed(result).flatMap((row) => row.tracked.groups.flatMap((group) => group.runs));
    expect(runs.some((run) => run.kind === 'removed' && run.token.text === 'twelve')).toBe(true);
    expect(runs.some((run) => run.kind === 'added' && run.token.text === 'eighteen')).toBe(true);
    expect(result.rows.some((row) => !row.changed && row.block?.tokens?.some((token) => token.text.includes('A shared bench')))).toBe(true); prove(result);
  });
  test.each([
    ['Keep words.\n', 'Keep new words.\n'], ['Keep old words.\n', 'Keep words.\n'],
    ['same same old same\n', 'same same new same\n'], ['éOLD\ncontinued\n', 'éNEW\ncontinued\n'],
    ['日本語の旧文\n', '日本語の新文\n'], ['Café é 👩‍🔬 old\n', 'Café é 👩‍🔬 new\n'],
    ['a ́old end\n', 'a ́new end\n'], ['one\ntwo old\n', 'one\ntwo new\n'],
  ])('reconstructs insertion/deletion/repetition/Unicode/multiline %s', (base, next) => {
    const result = review(base, next); expect(result.counts.inline).toBe(1); prove(result);
  });
  test('word cuts are real grapheme boundaries, including space plus combining mark', () => {
    const text = 'a ́word 👩‍👩‍👧‍👦 é 中文'; const units = wordUnits(text);
    expect(units.join('')).toBe(text); const bounds = new Set([text.length, ...[...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map((part) => part.index)]);
    let end = 0; for (const unit of units) { end += unit.length; expect(bounds.has(end)).toBe(true); }
    expect(wordUnits(text, null)).toBe(null);
    const result = review('one old word\n', 'one new word\n', {}, null);
    expect(changed(result)[0].tracked.note).toContain('whole text'); prove(result);
  });
  test.each([
    ['**old**\n', '**new**\n'], ['*old*\n', '*new*\n'], ['`old`\n', '`new`\n'],
    ['[same](https://old.example)\n', '[same](https://new.example)\n'],
    ['[[old|same]]\n', '[[new|same]]\n'], ['```js\nold\n```\n', '```js\nnew\n```\n'],
  ])('whole formatted/link/code token including target metadata: %s', (base, next) => {
    const result = review(base, next); expect(result.counts.inline).toBe(1); prove(result);
    const runs = changed(result)[0].tracked.groups[0].runs;
    expect(runs.filter((run) => run.kind === 'removed')).toHaveLength(1); expect(runs.filter((run) => run.kind === 'added')).toHaveLength(1);
  });
  test.each([
    ['```js\nsame\n```\n', '```python\nsame\n```\n'], ['1. same\n', '3. same\n'],
    ['1. same\n', '1) same\n'], ['- same\n', '+ same\n'],
    ['Body.\n\n---\n', 'Body.\n\n***\n', '---\n'], ['same\nwords\n', 'same words\n'],
  ])('source-only formatting remains navigable with exact prior source: %s', (base, next, previous = base) => {
    const result = review(base, next); expect(result.counts.source).toBe(1); expect(changed(result)[0].mark).toBe(1);
    expect(changed(result)[0].previous).toEqual([previous]); expect(changed(result)[0].tracked.reason).toContain('Source/formatting');
  });
  test('replacing a leading unclosed fence exposes its previous exact source at a navigable change', () => {
    const value = input('---\n', '***\n');
    const display = publicationDisplay(value);
    expect(display.file.current.blocks[0]).toMatchObject({ kind: 'fence-like', start: 0, end: value.baseText.length,
      uninterpreted: ['fence-like text'] });
    const result = display.tracked;
    expect(result.counts.exact).toBe(1); expect(result.counts.source).toBe(0);
    expect(result.coarse).toBe(false); expect(result.markCount).toBe(1);
    const rows = changed(result); expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ mark: 1, position: 0, previous: [value.baseText],
      tracked: { kind: 'exact', reason: expect.stringContaining('exact-source fallback') } });
    expect(value.candidateText.slice(rows[0].block.start, rows[0].block.end)).toBe('***\n');
  });
  test('structural metadata differs even if words do not', () => {
    const result = review('# Same\n', '## Same\n'); expect(result.counts.block).toBe(1);
    expect(changed(result)[0].tracked.reason).toContain('structure');
    const a = { kind: 'paragraph', start: 0, end: 4, uninterpreted: [], tokens: [{ type: 'text', text: 'same', extra: { future: 1 } }] };
    const b = { ...a, tokens: [{ ...a.tokens[0], extra: { future: 2 } }] };
    expect(identity(comparable(a))).not.toBe(identity(comparable(b)));
  });
  test('full deletion owns real pinned block; insertion-only has complete candidate', () => {
    const removed = review('Remove this.\n\nKeep this.\n', 'Keep this.\n');
    expect(removed.counts.deleted).toBe(1); expect(removed.rows[0].deleted).toBe(true); expect(removed.rows[0].mark).toBe(1);
    expect(removed.rows[0].previous[0]).toBe('Remove this.\n'); expect(removed.rows[1].changed).toBe(false);
    const added = review('Keep this.\n', 'Keep this.\n\nAdded.\n'); expect(added.counts.added).toBe(1);
  });
  test('mid-document gap insertion stays before its next proposed block and is numbered there', () => {
    const base = '# A\n\npara one\n\npara two\n\npara three\n';
    const candidate = base.replace('\n\npara two', '\n\n\npara two'); const result = review(base, candidate);
    const marker = changed(result)[0];
    expect(result.counts.source).toBe(1); expect(result.markCount).toBe(1);
    expect(marker.removed).toBe(false); expect(marker.mark).toBe(1);
    expect(result.rows.indexOf(marker)).toBe(2);
    expect(result.rows[3].block.tokens[0].text).toBe('para two');
    expect(marker.position).toBeLessThanOrEqual(result.rows[3].position);
    expect(result.rows.map((row) => row.position)).toEqual(result.rows.map((row) => row.position).toSorted((a, b) => a - b));
  });
  test('mid-document gap deletion retains exactly one source marker before the next block', () => {
    const base = '# A\n\npara one\n\n\npara two\n\npara three\n';
    const candidate = base.replace('\n\n\npara two', '\n\npara two'); const result = review(base, candidate);
    const markers = changed(result); expect(markers).toHaveLength(1);
    expect(result.counts.source).toBe(1); expect(result.counts.deleted).toBe(0); expect(result.markCount).toBe(1);
    expect(markers[0].removed).toBe(true); expect(markers[0].previous).toEqual(['\n']);
    expect(markers[0].tracked.reason).toContain('Source text removed');
    expect(result.rows.indexOf(markers[0])).toBe(2); expect(result.rows[3].block.tokens[0].text).toBe('para two');
    expect(markers[0].position).toBe(result.rows[3].position);
  });
  test.each(['Remove this.\n\nKeep this.\n', 'Remove one.\n\nRemove two.\n\nKeep this.\n'])('whole deleted blocks cover their own operation without a duplicate source marker: %s', (base) => {
    const result = review(base, 'Keep this.\n'); const count = base.includes('Remove two') ? 2 : 1;
    expect(result.counts.deleted).toBe(count); expect(result.counts.source).toBe(0);
    expect(changed(result)).toHaveLength(count); expect(result.markCount).toBe(count);
    expect(result.rows.filter((row) => row.removed)).toHaveLength(0);
    expect(result.rows.at(-1).block.tokens[0].text).toBe('Keep this.');
  });
  test.each(['gap', 'block'])('earlier length-changing edit keeps later %s deletion in proposed coordinates', (kind) => {
    const base = kind === 'gap' ? '# A\n\nOld opening.\n\nKeep middle.\n\n\nKeep end.\n'
      : '# A\n\nOld opening.\n\nKeep middle.\n\nRemove later.\n\nKeep end.\n';
    const opening = 'A much longer opening ' + 'for this synthetic test '.repeat(8) + '.';
    const candidate = base.replace('Old opening.', opening).replace(kind === 'gap' ? '\n\n\nKeep end.' : 'Remove later.\n\n', kind === 'gap' ? '\n\nKeep end.' : '');
    const result = review(base, candidate); const later = result.rows.find((row) => kind === 'gap' ? row.removed : row.deleted);
    const middle = result.rows.find((row) => !row.deleted && row.block?.tokens?.[0]?.text === 'Keep middle.');
    const end = result.rows.find((row) => !row.deleted && row.block?.tokens?.[0]?.text === 'Keep end.');
    expect(later).toBeDefined(); expect(result.rows.indexOf(later)).toBeGreaterThan(result.rows.indexOf(middle));
    expect(result.rows.indexOf(later)).toBeLessThan(result.rows.indexOf(end)); expect(later.position).toBe(end.block.start);
    expect(changed(result).map((row) => row.mark)).toEqual([1, 2]);
    expect(result.counts.source).toBe(kind === 'gap' ? 1 : 0); expect(result.counts.deleted).toBe(kind === 'block' ? 1 : 0);
    if (kind === 'block') expect(later.block.start).toBeLessThan(middle.block.start); // BASE start would misorder it.
  });
  test('co-located real source deletion/insertion markers retain canonical operation order before numbering', () => {
    const base = '# A\n\none\n\n\nthree\n'; const candidate = '# A\n\none\n \nthree\n'; const value = input(base, candidate);
    const operations = [{ path: 'test.md', start: 9, end: 10, oldText: '\n', replacementText: '' },
      { path: 'test.md', start: 10, end: 10, oldText: '', replacementText: ' ' }];
    const verified = verifiedDisplayProjection(value, { operations }); expect(verified.available).toBe(true);
    const display = { ...publicationDisplay(value), file: verified.projection.files[0], operations: verified.operations };
    for (const rows of [display.rows, [...display.rows].reverse()]) {
      const result = trackedChanges({ ...display, rows }, value); const markers = changed(result);
      expect(result.reason).toBe(null); expect(result.counts.source).toBe(2); expect(result.markCount).toBe(2);
      expect(markers.map((row) => row.operation)).toEqual([1, 2]); expect(markers.map((row) => row.removed)).toEqual([true, false]);
      expect(markers.map((row) => row.position)).toEqual([9, 9]); expect(markers.map((row) => row.mark)).toEqual([1, 2]);
      expect(result.rows.indexOf(markers[1])).toBeLessThan(result.rows.length - 1);
    }
  });
  test.each(['unanchored', 'anchored'])('partial plus whole-block deletion retains every difference with %s pairing', (variant) => {
    const anchor = variant === 'anchored' ? 'Unchanged anchor.\n\n' : '';
    const base = `Keep old phrase.\n\n${anchor}Remove later.\n\nKeep end.\n`;
    const candidate = `Keep phrase.\n\n${anchor}Keep end.\n`; const value = input(base, candidate);
    const start = base.indexOf('Remove later.'); const end = base.indexOf('Keep end.');
    const operations = [{ path: 'test.md', start: 5, end: 9, oldText: 'old ', replacementText: '' },
      { path: 'test.md', start, end, oldText: base.slice(start, end), replacementText: '' }];
    const verified = verifiedDisplayProjection(value, { operations }); expect(verified.available).toBe(true);
    const file = verified.projection.files[0]; const original = publicationDisplay(value);
    // Reproduce the original fixture defect: borrowed rows reference another
    // projection's block objects, and correctly trigger the authority fallback.
    expect(original.rows.some((row) => row.block && !file.proposed.blocks.includes(row.block))).toBe(true);
    const inconsistent = trackedChanges({ ...original, file, operations: verified.operations }, value);
    expect(inconsistent.reason).toContain('Block pairing disagrees'); expect(inconsistent.counts.deleted).toBe(0);
    // BOTH operations are pure deletions: the real display assembler would mark
    // no block from added segments. Build rows from THIS same verified file.
    expect(file.proposed.segments.some((part) => part.kind === 'added')).toBe(false);
    const rows = file.proposed.blocks.filter((block) => block.kind !== 'gap').map((block) => ({ block, position: block.start, changed: false, previous: [] }));
    const result = trackedChanges({ ...original, file, operations: verified.operations, rows }, value);
    expect(result.reason).toBe(null);
    if (variant === 'anchored') {
      expect(result.counts.deleted).toBe(1); expect(result.counts.inline).toBe(1); expect(result.counts.source).toBe(1);
      const marker = result.rows.find((row) => row.removed); expect(marker.operation).toBe(1); expect(marker.previous).toEqual(['old ']);
      // Conservatively retain this marker; the separate N2 over-count policy is unchanged.
    } else {
      // Without a context anchor, two old blocks versus one new block cannot be
      // honestly refined inline: retain the original unanchored case as explicit
      // whole-block fallback, not a guessed one-to-one pairing or hidden change.
      expect(result.counts.deleted).toBe(2); expect(result.counts.added).toBe(1);
      expect(result.counts.inline).toBe(0); expect(result.counts.source).toBe(0);
      expect(result.rows.filter((row) => row.deleted).map((row) => row.previous[0])).toEqual(['Keep old phrase.\n', 'Remove later.\n']);
      expect(result.rows.filter((row) => row.tracked?.kind === 'added').map((row) => row.block.tokens[0].text)).toEqual(['Keep phrase.']);
      expect(result.rows.filter((row) => !row.deleted).map((row) => row.block.tokens[0].text)).toEqual(['Keep phrase.', 'Keep end.']);
      expect(changed(result)).toHaveLength(3); expect(result.markCount).toBe(3);
    }
  });
  test('clean-reading CSS hides the complete marker-only wrapper, not candidate prose', async () => {
    const css = await readFile(new URL('../public/owner.css', import.meta.url), 'utf8');
    expect(css).toContain('.publication-document-review [data-marks-visible="false"] .publication-block:has(> .publication-removal) { display: none; }');
    const result = review('One.\n\n\nTwo.\n', 'One.\n\nTwo.\n');
    const marker = changed(result)[0]; expect(marker.block).toBeUndefined(); expect(marker.removed).toBe(true);
    expect(result.rows.filter((row) => row.block).map((row) => row.block.tokens[0].text)).toEqual(['One.', 'Two.']);
    // Server's existing publication-removal is a direct child only for marker rows;
    // the CSS selector hides its explanatory prose and otherwise-empty wrapper.
  });
  test('unsupported source is explicit and literal CriticMarkup/HTML are not parsed here', () => {
    const result = review('| a |\n| --- |\n| old |\n', '| a |\n| --- |\n| new |\n');
    expect(result.counts.exact).toBe(1);
    const literal = review('`{++old++}`\n', '`{++new++}`\n'); prove(literal);
    expect(changed(literal)[0].tracked.groups[0].runs.some((run) => run.token.text.includes('{++new++}'))).toBe(true);
  });
  test('two-way proof rejects lost token metadata, reordering, missing pieces and extra text', () => {
    const result = review('[same](https://a.example)\n', '[same](https://b.example)\n'); const detail = changed(result)[0].tracked;
    const runs = detail.groups[0].runs; const before = detail.base.streams[0]; const after = detail.candidate.streams[0];
    expect(verifyRuns(runs, before, after)).toBe(true);
    expect(verifyRuns(runs.map((run) => ({ ...run, token: { type: run.token.type, text: run.token.text } })), before, after)).toBe(false);
    expect(verifyRuns(runs.slice(1), before, after)).toBe(false);
    expect(verifyRuns([...runs, runs[0]], before, after)).toBe(false);
  });
  test.each([
    [{ maxBlockCells: 1 }, 'Block-pairing'], [{ maxTokenCells: 1 }, 'Token LCS'],
    [{ maxWordCells: 1 }, 'Word LCS'], [{ maxEligibleBlocks: 0 }, 'Eligible-block'],
    [{ maxMarks: 0 }, 'Inline-mark'], [{ maxTotalCells: 5 }, 'Cumulative'],
  ])('every comparison bound falls back visibly: %j', (limits, reason) => {
    const result = review('old word\n', 'new word\n', limits); const message = result.reason ?? changed(result)[0].tracked.reason;
    expect(message).toContain(reason); expect(result.rows.filter((row) => row.block)).toHaveLength(1);
    expect(result.cells).toBeLessThanOrEqual(limits.maxTotalCells ?? TRACKED_CHANGE_LIMITS.maxTotalCells);
  });
  test('cumulative guard stops many individually eligible comparisons', () => {
    const base = 'old one\n\nold two\n\nold three\n'; const result = review(base, base.replaceAll('old', 'new'), { maxTotalCells: 50 });
    expect(result.cells).toBeLessThanOrEqual(50); expect(changed(result).some((row) => row.tracked.reason?.includes('Cumulative'))).toBe(true);
  });
  test('broad rewrite is complete and defaults clean with truthful counts/fallback', () => {
    const corpus = publicationRehearsalCorpus('broad'); const result = review(corpus.base, corpus.candidate);
    expect(result.defaultClean).toBe(true); expect(result.rows.filter((row) => row.block && !row.deleted)).toHaveLength(publicationDisplay(input(corpus.base, corpus.candidate)).rows.filter((row) => row.block).length);
    expect(Object.values(result.counts).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
  });
  test('invalid original and missing base never gain tracked proof or publication authority', () => {
    const value = input('old\n', 'new\n');
    for (const corrupt of [{ baseText: null }, { operation: { ...value.operation, oldText: 'wrong' } }, { candidateText: 'wrong' }]) {
      const invalid = { ...value, ...corrupt }; const display = publicationDisplay(invalid);
      expect(display.available).toBe(false); expect(trackedChanges(display, invalid).available).toBe(false);
    }
    const snapshot = identity(value); publicationDisplay(value); expect(identity(value)).toBe(snapshot);
  });
});

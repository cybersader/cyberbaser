import { expect, test } from 'bun:test';
import { proposalDisplay } from '../src/publication-display.js';
import { verifyRuns } from '../src/publication-tracked-changes.js';

function display(baseText, splices, Segmenter) {
  const path = 'note.md';
  const base = Buffer.from(baseText);
  const operations = Object.freeze(splices.map(([start, oldText, replacementText]) => Object.freeze({
    path, start: Buffer.byteLength(baseText.slice(0, start)),
    end: Buffer.byteLength(baseText.slice(0, start)) + Buffer.byteLength(oldText), oldText, replacementText,
  })));
  const bytesBefore = JSON.stringify(operations);
  const pieces = []; let cursor = 0;
  for (const op of operations) {
    expect(base.subarray(op.start, op.end).toString()).toBe(op.oldText);
    pieces.push(base.subarray(cursor, op.start), Buffer.from(op.replacementText));
    cursor = op.end;
  }
  const candidateText = Buffer.concat([...pieces, base.subarray(cursor)]).toString();
  const result = proposalDisplay({ path, baseText, candidateText, operations }, Segmenter);
  expect(result.available).toBe(true);
  expect(result.operations).toBe(operations);
  expect(JSON.stringify(operations)).toBe(bytesBefore);
  for (const { tracked } of result.tracked.rows) if (tracked?.kind === 'inline') {
    tracked.groups.forEach(({ runs }, index) => {
      expect(verifyRuns(runs, tracked.base.streams[index], tracked.candidate.streams[index])).toBe(true);
    });
  }
  const runs = result.tracked.rows.flatMap(({ tracked }) => tracked?.groups?.flatMap((group) => group.runs) ?? []);
  return { result, marks: runs.filter((run) => run.kind !== 'context').map(({ kind, token }) => [kind, token.text.trimEnd()]) };
}

function replace(base, find, next, Segmenter) {
  return display(base, [[base.indexOf(find), find, next]], Segmenter);
}

test('a mid-word operation shows both complete phrases without their punctuation', () => {
  const base = 'Store the notes in the blue folder.\n';
  expect(replace(base, 'blue fol', 'green bin').marks).toEqual([['removed', 'blue folder'], ['added', 'green binder']]);
  expect(replace('Check (a bender), then wait.\n', 'ben', 'bin').marks).toEqual([['removed', 'bender'], ['added', 'binder']]);
});

test('two exact changes in one sentence keep the words between them unchanged', () => {
  const base = 'Bring a bender and a marker to the workshop.\n';
  const { marks } = display(base, [[base.indexOf('ben'), 'ben', 'bin'], [base.indexOf('mar'), 'mar', 'tic']]);
  expect(marks).toEqual([['removed', 'bender'], ['added', 'binder'], ['removed', 'marker'], ['added', 'ticker']]);
});

test('a pure insertion and a pure deletion are one-sided where possible', () => {
  const base = 'Bring the binder.\n';
  expect(display(base, [[base.indexOf('binder'), '', 'green ']]).marks).toEqual([['added', 'green']]);
  const { result, marks } = replace('Bring the green binder.\n', 'green ', '');
  expect(marks).toEqual([['removed', 'green']]);
  expect(result.tracked.markCount).toBe(1);
});

test('a pure insertion inside a word still displays complete words', () => {
  const base = 'Make it do now.\n';
  expect(display(base, [[base.indexOf(' now'), '', 'able']]).marks).toEqual([['removed', 'do'], ['added', 'doable']]);
});

test('a word in a list and one inside code are refined in place', () => {
  const base = '- Find the bender.\n- Keep the list.\n\n```js\nlet bender = cart;\n```\n';
  const first = base.indexOf('bender');
  const { result, marks } = display(base, [[first, 'ben', 'bin'], [base.lastIndexOf('bender'), 'ben', 'bin']]);
  expect(marks).toEqual([['removed', 'bender'], ['added', 'binder'], ['removed', 'bender'], ['added', 'binder']]);
  expect(result.tracked.rows.map((row) => row.block.kind)).toEqual(['list', 'code']);
});

test('word segmentation uses dictionary boundaries; fallback keeps whole graphemes', () => {
  expect(replace('今天打開資料夾。\n', '今天', '明天').marks).toEqual([['removed', '今天'], ['added', '明天']]);
  expect(replace('Use café and honey.\n', 'fé', 'ke', null).marks).toEqual([['removed', 'café'], ['added', 'cake']]);
  expect(replace('Use café and honey.\n', 'fe', 'ke', null).marks).toEqual([['removed', 'café'], ['added', 'caké']]);
});

test('a whole inserted or removed block retains its original full line span', () => {
  const added = display('# Start\n', [[8, '', '\nAdded a paragraph.\n']]).result.tracked.rows.find((row) => row.tracked?.kind === 'added');
  expect(added.block.tokens).toEqual([{ type: 'text', text: 'Added a paragraph.' }]);
  const removed = replace('Keep this.\n\nRemove this.\n', '\nRemove this.\n', '').result.tracked.rows.find((row) => row.deleted);
  expect(removed.previous).toEqual(['Remove this.\n']);
});

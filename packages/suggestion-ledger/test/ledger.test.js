import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { SuggestionLedger, digestBytes, createCoordinateAdapter, createDisplayAdapterRegistry,
  criticMarkupAdapter, viewSegmentsAdapter, defaultDisplayAdapters } from '../src/index.js';

import { make, check, clock } from './helpers.js';
const enc = new TextEncoder();

describe('pinned source and coordinates', () => {
  test('SHA-256 matches standard vectors and independent platform implementation', () => {
    for (const text of ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'a'.repeat(129), '﻿中😀\r\n']) {
      const bytes = enc.encode(text);
      expect(digestBytes(bytes)).toBe(`sha-256=:${createHash('sha256').update(bytes).digest('base64')}:`);
    }
    expect(digestBytes(enc.encode('abc'))).toBe('sha-256=:ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=:');
  });
  test('constructor validates actual bytes, length and strict UTF-8', () => {
    const bytes = enc.encode('abc'), identity = make('abc').baseIdentity;
    expect(() => new SuggestionLedger(enc.encode('abd'), identity)).toThrow('digest');
    expect(() => new SuggestionLedger(bytes, { ...identity, byteLength: 2 })).toThrow();
    expect(() => new SuggestionLedger(new Uint8Array([0xc0, 0xaf]), { path: 'x', byteLength: 2, digest: digestBytes(new Uint8Array([0xc0, 0xaf])) })).toThrow();
    expect(() => new SuggestionLedger(bytes, { ...identity, extra: true })).toThrow();
  });
  test('source bytes, identity, operations and metadata cannot be mutated by callers', () => {
    const bytes = enc.encode('abc'), identity = { ...make('abc').baseIdentity };
    const ledger = new SuggestionLedger(bytes, identity, { clock });
    bytes[0] = 90; identity.path = 'different.md'; ledger.baseBytes[0] = 88;
    ledger.insert(1, 'X');
    expect(ledger.currentText).toBe('aXbc');
    expect(ledger.baseIdentity.path).toBe('Example.md');
    expect(Object.isFrozen(ledger.metadata)).toBe(true);
    expect(Object.isFrozen(ledger.metadata['suggestion-1'])).toBe(true);
    check(ledger);
  });
  test('Buffer input is copied rather than retaining Buffer.slice shared memory', () => {
    const bytes = Buffer.from('abc');
    const ledger = new SuggestionLedger(bytes, make('abc').baseIdentity, { clock });
    bytes[0] = 90; ledger.baseBytes[1] = 88;
    check(ledger, 'abc');
  });
  test('UTF-16 ↔ UTF-8 refuses split emoji and UTF-8 continuation bytes', () => {
    const map = createCoordinateAdapter(enc.encode('a😀中é'));
    expect(map.utf16ToByte(3)).toBe(5);
    expect(map.byteToUtf16(8)).toBe(4);
    for (const offset of [2, 3, 4, 6, 7, 10, -1, 100, 0.5, NaN]) expect(() => map.byteToUtf16(offset)).toThrow();
    expect(() => map.utf16ToByte(2)).toThrow();
    expect(map.utf16ToByte(5)).toBe(9); // Combining code points stay independently addressable.
    expect(map.utf16ToByte(6)).toBe(11);
  });
  test('line and column adapters preserve BOM, CRLF, lone CR, mixed EOL and terminal newlines', () => {
    const text = '﻿A😀\r\n中\rZ\n';
    const ledger = make(text), map = ledger.coordinates('base');
    expect(map.lineCount).toBe(4);
    const afterCRLF = enc.encode('﻿A😀\r\n').length;
    expect(map.positionAt(afterCRLF)).toEqual({ line: 2, column: 1 });
    expect(map.byteAt({ line: 2, column: 2 })).toBe(afterCRLF + 3);
    expect(map.positionAt(afterCRLF - 1)).toEqual({ line: 1, column: 6 });
    expect(() => map.byteAt({ line: 1, column: 4 })).toThrow(); // Inside emoji.
    expect(() => map.byteAt({ line: 2, column: 99 })).toThrow();
    expect(() => map.byteAt({ line: 0, column: 1 })).toThrow();
    check(ledger, text);
  });
  test('coordinate adapters are immutable snapshots of their requested view', () => {
    const ledger = make('a😀b'), before = ledger.coordinates();
    ledger.insert(1, '中');
    expect(before.byteLength).toBe(6);
    expect(ledger.coordinates().byteLength).toBe(9);
    expect(ledger.coordinates('base').byteLength).toBe(6);
    expect(() => ledger.coordinates('unknown')).toThrow();
  });
});

describe('origin-aware composition', () => {
  test('empty base permits insertion and cancellation', () => {
    const ledger = make(''); ledger.insert(0, '中😀'); check(ledger, '中😀');
    expect(ledger.toOperations()[0]).toMatchObject({ start: 0, end: 0, expected: '', replacement: '中😀' });
    ledger.delete({ start: 0, end: 7 }); check(ledger, '');
    expect(ledger.toOperations()).toEqual([]);
  });
  test('edits wholly inside inserted text retain the original suggestion id and timestamp', () => {
    const ledger = make('abc'); ledger.insert(1, 'XYZ', { comment: 'first' });
    const original = ledger.toOperations()[0].operationId;
    ledger.replace({ start: 2, end: 3 }, '中');
    ledger.replace({ start: 1, end: 6 }, 'Q');
    check(ledger, 'aQbc');
    expect(ledger.toOperations()[0]).toEqual({ operationId: original, start: 1, end: 1, expected: '', replacement: 'Q' });
    expect(ledger.metadata[original]).toEqual({ comment: 'first', createdAt: clock() });
  });
  test('deleting inserted text creates no deletion suggestion', () => {
    const ledger = make('abc'); ledger.insert(1, 'XYZ'); ledger.delete({ start: 1, end: 4 });
    check(ledger, 'abc'); expect(ledger.toOperations()).toEqual([]);
    expect(ledger.metadata).toEqual({});
  });
  test('a deletion spanning inserted text and original text composes into one original operation', () => {
    const ledger = make('abcdef'); ledger.insert(2, 'XYZ'); ledger.delete({ start: 1, end: 6 });
    check(ledger, 'adef');
    expect(ledger.toOperations()).toEqual([{ operationId: 'suggestion-1', start: 1, end: 3, expected: 'bc', replacement: '' }]);
  });
  test('adjacent and bridging edits merge to the oldest creation id, not leftmost id', () => {
    const ledger = make('abcdefghi');
    ledger.replace({ start: 5, end: 6 }, 'F', { comment: 'right' });
    ledger.replace({ start: 1, end: 2 }, 'B', { comment: 'left' });
    expect(ledger.toOperations().map((op) => op.operationId)).toEqual(['suggestion-2', 'suggestion-1']);
    ledger.replace({ start: 2, end: 5 }, 'CDE', { comment: 'bridge' });
    check(ledger, 'aBCDEFghi');
    expect(ledger.toOperations()).toHaveLength(1);
    expect(ledger.toOperations()[0].operationId).toBe('suggestion-1');
    expect(ledger.metadata['suggestion-1'].comment).toBe('right\nleft\nbridge');
  });
  test('comments stay local to the edited suggestion', () => {
    const ledger = make('abcdef'); ledger.insert(1, 'A', { comment: 'one' });
    ledger.insert(6, 'B', { comment: 'two' });
    expect(ledger.metadata['suggestion-1'].comment).toBe('one');
    expect(ledger.metadata['suggestion-2'].comment).toBe('two');
    check(ledger);
  });
  test('replacement cancellation restores base provenance, not an empty operation', () => {
    const ledger = make('abcdef'); ledger.replace({ start: 1, end: 4 }, 'XYZ');
    ledger.replace({ start: 1, end: 4 }, 'bcd'); check(ledger, 'abcdef');
    expect(ledger.toOperations()).toEqual([]);
    ledger.insert(3, '!'); check(ledger, 'abc!def');
  });
  test('base-coordinate edits stay pinned after earlier length changes', () => {
    const ledger = make('a😀bcdef');
    ledger.insert(1, '中', { space: 'base' });
    ledger.replace({ start: 6, end: 7 }, 'C', { space: 'base' });
    check(ledger, 'a中😀bCdef');
    expect(ledger.toOperations().map(({ start, end }) => [start, end])).toEqual([[1, 1], [6, 7]]);
    expect(ledger.baseToView(1, 'left')).toBe(1);
    expect(ledger.baseToView(1, 'right')).toBe(4);
  });
  test('overlapping base replacement boundaries absorb dependent replacement text', () => {
    const ledger = make('abcdef'); ledger.replace({ start: 1, end: 4 }, 'X', { space: 'base' });
    ledger.replace({ start: 2, end: 5 }, 'Y', { space: 'base' });
    check(ledger, 'aYf');
    expect(ledger.toOperations()[0]).toEqual({ operationId: 'suggestion-1', start: 1, end: 5, expected: 'bcde', replacement: 'Y' });
  });
  test('base ranges exclude suggestions beginning at their end boundary', () => {
    const ledger = make('abcdef'); ledger.replace({ start: 3, end: 4 }, 'X');
    ledger.replace({ start: 1, end: 3 }, 'Y', { space: 'base' });
    check(ledger, 'aYXef');
    expect(ledger.toOperations()).toHaveLength(1);
  });
  test('CRLF and BOM untouched bytes survive multiple edits exactly', () => {
    const ledger = make('﻿one\r\n中😀\r\nend\r\n');
    ledger.replace({ start: 3, end: 6 }, 'ONE');
    ledger.insert(8, '!');
    check(ledger, '﻿ONE\r\n!中😀\r\nend\r\n');
    expect(ledger.toCandidateBytes().filter((byte) => byte === 13)).toHaveLength(3);
  });
  test('invalid byte ranges, scalar splits, and lone surrogates fail without changing state', () => {
    const ledger = make('a😀b'), before = ledger.serialize();
    for (const action of [() => ledger.insert(2, 'x'), () => ledger.delete({ start: 1, end: 3 }),
      () => ledger.replace({ start: 5, end: 1 }, 'x'), () => ledger.insert(-1, 'x'),
      () => ledger.insert(99, 'x'), () => ledger.insert(1, '\ud800'), () => ledger.insert(1, '\udc00'),
      () => ledger.insert(1, 'x', { comment: '\ud800' }), () => ledger.insert(1, 'x', { space: 'other' }),
      () => ledger.baseToView(1, 'other')]) {
      expect(action).toThrow(); expect(ledger.serialize()).toBe(before);
    }
  });
  test('distant edits whose whole candidate equals base cancel globally', () => {
    const ledger = make('aaaa'); ledger.insert(0, 'a'); ledger.delete({ start: 4, end: 5 });
    check(ledger, 'aaaa'); expect(ledger.toOperations()).toEqual([]);
    ledger.undo(); check(ledger, 'aaaaa');
  });
  test('no-op requests do not create history, ids or metadata', () => {
    const ledger = make('abc'), before = ledger.serialize();
    expect(ledger.insert(1, '')).toBe(false);
    expect(ledger.replace({ start: 0, end: 3 }, 'abc')).toBe(false);
    expect(ledger.serialize()).toBe(before); expect(ledger.canUndo).toBe(false);
  });
});

describe('history, metadata and persistence', () => {
  test('undo and redo restore composed text, ids and metadata as ledger steps', () => {
    const ledger = make('abc'); ledger.insert(1, 'X', { comment: 'why' });
    ledger.insert(2, 'Y'); ledger.setComment('suggestion-1', 'revised');
    expect(ledger.undo()).toBe(true); expect(ledger.metadata['suggestion-1'].comment).toBe('why');
    expect(ledger.undo()).toBe(true); check(ledger, 'aXbc');
    expect(ledger.undo()).toBe(true); check(ledger, 'abc'); expect(ledger.undo()).toBe(false);
    expect(ledger.redo()).toBe(true); expect(ledger.redo()).toBe(true); expect(ledger.redo()).toBe(true);
    check(ledger, 'aXYbc'); expect(ledger.redo()).toBe(false);
    expect(ledger.toOperations()[0].operationId).toBe('suggestion-1');
    expect(ledger.metadata['suggestion-1'].comment).toBe('revised');
  });
  test('branching after undo clears redo without recycling discarded ids', () => {
    const ledger = make('abcdef'); ledger.insert(1, 'X'); ledger.undo(); ledger.insert(4, 'Y');
    expect(ledger.toOperations()[0].operationId).toBe('suggestion-2');
    expect(ledger.canRedo).toBe(false); check(ledger, 'abcdYef');
  });
  test('discard restores only that suggestion and is undoable', () => {
    const ledger = make('abcdef'); ledger.insert(1, 'X'); ledger.replace({ start: 5, end: 6 }, 'E');
    ledger.discard('suggestion-1'); check(ledger, 'abcdEf');
    ledger.undo(); check(ledger, 'aXbcdEf');
    expect(() => ledger.discard('missing')).toThrow();
    expect(() => ledger.setComment('missing', 'x')).toThrow();
    expect(ledger.setComment('suggestion-1', '')).toBe(false);
  });
  test('persistence retains comments, undo/redo, next id and exact bytes', () => {
    const ledger = make('﻿a😀\r\n中b'); ledger.insert(3, 'X', { comment: 'reason' });
    ledger.insert(ledger.coordinates().byteLength, 'Y'); ledger.undo();
    const restored = SuggestionLedger.deserialize(ledger.baseBytes, ledger.baseIdentity, ledger.serialize(), { clock });
    expect(restored.serialize()).toBe(ledger.serialize());
    check(restored, ledger.currentText); restored.redo(); ledger.redo();
    expect(restored.serialize()).toBe(ledger.serialize());
    restored.undo(); restored.insert(0, 'Z');
    expect(restored.toOperations()[0].operationId).toBe('suggestion-3');
  });
  test('reload refuses stale base, wrong path, wrong claimed digest and malformed history', () => {
    const ledger = make('abc'); ledger.insert(1, 'X');
    const state = ledger.serialize(), changed = enc.encode('abd');
    expect(() => SuggestionLedger.deserialize(changed, { ...ledger.baseIdentity, digest: digestBytes(changed) }, state)).toThrow('identity');
    expect(() => SuggestionLedger.deserialize(changed, ledger.baseIdentity, state)).toThrow('digest');
    expect(() => SuggestionLedger.deserialize(ledger.baseBytes, { ...ledger.baseIdentity, path: 'Other.md' }, state)).toThrow('identity');
    const cases = [
      (v) => { v.current.operations[0].expected = 'wrong'; },
      (v) => { v.current.operations[0].start = 100; },
      (v) => { v.current.operations[0].replacement = '\ud800'; },
      (v) => { v.current.operations[0].extra = 1; },
      (v) => { v.current.operations.push(v.current.operations[0]); },
      (v) => { v.current.metadata = {}; },
      (v) => { v.current.metadata.extra = { comment: '', createdAt: clock() }; },
      (v) => { v.nextSequence = 1; },
      (v) => { v.undo[0].operations = [{ operationId: 'bad' }]; },
      (v) => { v.schemaVersion = 2; },
    ];
    for (const change of cases) {
      const value = JSON.parse(state); change(value);
      expect(() => SuggestionLedger.deserialize(ledger.baseBytes, ledger.baseIdentity, JSON.stringify(value))).toThrow();
    }
  });
  test('configured bounds fail atomically, including clock and operation count', () => {
    expect(() => make('abc', { limits: { maxBaseBytes: 2 } })).toThrow();
    expect(() => make('a', { limits: { surprise: 10 } })).toThrow();
    const ledger = make('abcdef', { limits: { maxViewBytes: 8, maxOperations: 1, maxHistory: 2 } });
    ledger.insert(1, 'X'); const before = ledger.serialize();
    expect(() => ledger.insert(5, 'Y')).toThrow('Operation'); expect(ledger.serialize()).toBe(before);
    expect(() => ledger.insert(2, 'LONG')).toThrow('View'); expect(ledger.serialize()).toBe(before);
    const brokenClock = make('abc', { clock: () => 'invalid' });
    expect(() => brokenClock.insert(1, 'X')).toThrow(); check(brokenClock, 'abc'); expect(brokenClock.canUndo).toBe(false);
    const bounded = make('a', { limits: { maxHistory: 2 } });
    bounded.insert(1, '1'); bounded.insert(2, '2'); bounded.insert(3, '3');
    bounded.undo(); bounded.undo(); expect(bounded.undo()).toBe(false); check(bounded, 'a1');
    expect(() => make('a', { limits: { maxSerializedBytes: 1 } }).serialize()).toThrow();
  });
});

describe('replaceable display adapters', () => {
  test('CriticMarkup renders replacement, insertion, deletion and local comments', () => {
    const ledger = make('abcdef');
    ledger.replace({ start: 0, end: 1 }, 'A', { comment: 'correct' });
    ledger.insert(3, 'X'); ledger.delete({ start: 6, end: 7 });
    expect(ledger.render('critic-markup')).toBe('{~~a~>A~~}{>>correct<<}bc{++X++}de{--f--}');
    check(ledger, 'AbcXde');
  });
  test('view segments reconstruct original and candidate with true zero-width insertion anchors', () => {
    const ledger = make('a😀bc'); ledger.replace({ start: 1, end: 5 }, '中');
    const runs = ledger.render('view-segments');
    expect(runs).toEqual([
      { kind: 'equal', text: 'a', baseStart: 0, baseEnd: 1 },
      { kind: 'delete', text: '😀', baseStart: 1, baseEnd: 5 },
      { kind: 'insert', text: '中', baseStart: 1, baseEnd: 1 },
      { kind: 'equal', text: 'bc', baseStart: 5, baseEnd: 7 },
    ]);
    expect(runs.filter((run) => run.kind !== 'insert').map((run) => run.text).join('')).toBe('a😀bc');
    expect(runs.filter((run) => run.kind !== 'delete').map((run) => run.text).join('')).toBe(ledger.currentText);
    expect(Object.isFrozen(runs)).toBe(true);
  });
  test('ambiguous literal CriticMarkup markers fail closed while plain runs remain available', () => {
    for (const marker of ['{++', '++}', '{--', '--}', '{~~', '~>', '~~}', '{>>', '<<}']) {
      const ledger = make(`abc${marker}def`); expect(() => ledger.render('critic-markup')).toThrow('delimiter');
      expect(ledger.render('view-segments')[0].text).toBe(`abc${marker}def`);
    }
    const ledger = make('abc'); ledger.insert(1, '{++'); expect(() => ledger.render('critic-markup')).toThrow();
    ledger.setComment('suggestion-1', '<<}'); expect(() => ledger.render('critic-markup')).toThrow();
  });
  test('registry conformance: providers are replaceable, duplicate and unknown ids refuse', () => {
    for (const provider of [criticMarkupAdapter, viewSegmentsAdapter]) {
      const registry = createDisplayAdapterRegistry([provider]);
      expect(registry.get(provider.id).render).toBeFunction();
      expect(() => registry.get('missing')).toThrow();
      expect(() => createDisplayAdapterRegistry([provider, provider])).toThrow();
      expect(make().render(provider.id, registry)).toBeDefined();
    }
    const provider = { id: 'custom', render: ({ operations }) => operations.length };
    const registry = createDisplayAdapterRegistry([provider]); provider.render = () => -1;
    const ledger = make(); expect(ledger.render('custom', registry)).toBe(0); ledger.insert(1, 'X');
    expect(ledger.render('custom', registry)).toBe(1);
    expect(() => createDisplayAdapterRegistry([{ id: 'bad' }])).toThrow();
    expect(() => ledger.render('missing', defaultDisplayAdapters)).toThrow();
  });
});


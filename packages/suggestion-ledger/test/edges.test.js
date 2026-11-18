import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { SuggestionLedger, createCoordinateAdapter, digestBytes } from '../src/index.js';
import { make, clock } from './helpers.js';

const enc = new TextEncoder();
const metadata = (ids) => Object.fromEntries(ids.map((id) => [id, { comment: '', createdAt: clock() }]));
const reload = (ledger, value, options) => SuggestionLedger.deserialize(ledger.baseBytes, ledger.baseIdentity, JSON.stringify(value), options);

test('persistence refuses globally unchanged current and historical operation sets', () => {
  const ledger = make('aaaa');
  const invalid = { operations: [
    { operationId: 'suggestion-1', start: 0, end: 0, expected: '', replacement: 'a' },
    { operationId: 'suggestion-2', start: 3, end: 4, expected: 'a', replacement: '' },
  ], metadata: metadata(['suggestion-1', 'suggestion-2']) };
  for (const destination of ['current', 'undo', 'redo']) {
    const value = JSON.parse(ledger.serialize()); value.nextSequence = 3;
    if (destination === 'current') value.current = invalid;
    else value[destination] = [invalid];
    expect(() => reload(ledger, value)).toThrow('Globally unchanged');
  }
});

test('persistence refuses mid-codepoint, adjacent, individual no-op and unsafe-id operations', () => {
  const ledger = make('😀abc');
  const cases = [
    [{ operationId: 'suggestion-1', start: 1, end: 4, expected: '', replacement: 'X' }],
    [
      { operationId: 'suggestion-1', start: 4, end: 5, expected: 'a', replacement: 'A' },
      { operationId: 'suggestion-2', start: 5, end: 6, expected: 'b', replacement: 'B' },
    ],
    [{ operationId: 'suggestion-1', start: 4, end: 5, expected: 'a', replacement: 'a' }],
    [{ operationId: 'suggestion-9007199254740992', start: 4, end: 5, expected: 'a', replacement: 'A' }],
  ];
  for (const operations of cases) {
    const value = JSON.parse(ledger.serialize()); value.nextSequence = 3;
    value.current = { operations, metadata: metadata(operations.map((op) => op.operationId)) };
    expect(() => reload(ledger, value)).toThrow();
  }
});

test('persistence validates view, byte and total undo/redo budgets before restoring', () => {
  const ledger = make('abc'); ledger.insert(1, 'X');
  const value = JSON.parse(ledger.serialize());
  expect(() => reload(ledger, value, { limits: { maxViewBytes: 3 } })).toThrow('bounds');
  expect(() => reload(ledger, value, { limits: { maxSerializedBytes: 10 } })).toThrow('size');
  value.redo = [value.undo[0]];
  expect(() => reload(ledger, value, { limits: { maxHistory: 1 } })).toThrow('history');
});

test('packed coordinate boundaries round-trip a longer mixed-scalar and mixed-EOL fixture', () => {
  const text = 'a'.repeat(65536) + '😀\r\n中é\rZ\n';
  const bytes = enc.encode(text), adapter = createCoordinateAdapter(bytes);
  bytes[0] = 0; // The adapter is a snapshot, not a mutable source-byte view.
  let utf16 = 0, byte = 0;
  for (const scalar of text) {
    expect(adapter.utf16ToByte(utf16)).toBe(byte);
    expect(adapter.byteToUtf16(byte)).toBe(utf16);
    utf16 += scalar.length; byte += enc.encode(scalar).length;
  }
  expect(adapter.utf16ToByte(utf16)).toBe(byte);
  expect(adapter.positionAt(byte)).toEqual({ line: 4, column: 1 });
  expect(() => adapter.utf16ToByte(65537)).toThrow();
});

test('synchronous browser-compatible SHA-256 agrees on independent arbitrary binary fixtures', () => {
  for (const length of [0, 1, 31, 55, 56, 63, 64, 65, 511, 1024, 65536]) {
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i++) bytes[i] = (i * 173 + length * 11) & 255;
    expect(digestBytes(bytes)).toBe(`sha-256=:${createHash('sha256').update(bytes).digest('base64')}:`);
  }
});

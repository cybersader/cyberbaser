import { expect, test } from 'bun:test';
import { SuggestionLedger } from '../src/index.js';
import { make, check, replay, clock } from './helpers.js';

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const alphabet = ['a', 'b', ' ', '\t', '\r\n', '\n', '\r', '中', '文', '😀', '🦄', 'é', '́', '﻿', '👩‍💻'];
function random(seed) {
  let value = seed >>> 0;
  return (limit) => {
    value ^= value << 13; value ^= value >>> 17; value ^= value << 5;
    return (value >>> 0) % limit;
  };
}
function boundaries(text) {
  const result = [{ byte: 0, index: 0 }];
  let byte = 0, index = 0;
  for (const scalar of text) {
    byte += enc.encode(scalar).length; index += scalar.length;
    result.push({ byte, index });
  }
  return result;
}
function text(random, maximum) {
  let result = '';
  const count = random(maximum + 1);
  for (let i = 0; i < count; i++) result += alphabet[random(alphabet.length)];
  return result;
}

// Independent projection from a reverse-spliced prefix, used only for base-coordinate tests.
function basePosition(base, operations, offset, right) {
  let consumed = 0, projected = 0;
  for (const op of operations) {
    if (offset < op.start) return projected + offset - consumed;
    projected += op.start - consumed;
    if (offset < op.end || offset === op.start) return projected + (right ? enc.encode(op.replacement).length : 0);
    projected += enc.encode(op.replacement).length; consumed = op.end;
  }
  return projected + offset - consumed;
}

for (let seed = 1; seed <= 100; seed++) {
  test(`deterministic Unicode origin/history/persistence fuzz seed ${seed}`, () => {
    const rng = random(seed * 0x9e3779b1);
    const baseText = text(rng, 24), baseBytes = enc.encode(baseText);
    let ledger = make(baseText), twin = make(baseText), model = baseText;
    const undo = [], redo = [];
    for (let step = 0; step < 100; step++) {
      const action = rng(12);
      if (action === 0) {
        const expected = undo.length > 0;
        expect(ledger.undo()).toBe(expected); expect(twin.undo()).toBe(expected);
        if (expected) { redo.push(model); model = undo.pop(); }
      } else if (action === 1) {
        const expected = redo.length > 0;
        expect(ledger.redo()).toBe(expected); expect(twin.redo()).toBe(expected);
        if (expected) { undo.push(model); model = redo.pop(); }
      } else if (action === 2 && ledger.toOperations().length) {
        const operations = ledger.toOperations(), target = operations[rng(operations.length)];
        undo.push(model); redo.length = 0;
        model = replay(baseBytes, operations.filter((op) => op.operationId !== target.operationId));
        ledger.discard(target.operationId); twin.discard(target.operationId);
      } else {
        const baseSpace = action === 3 || action === 4;
        const bounds = boundaries(baseSpace ? baseText : model);
        let a = rng(bounds.length), b = rng(bounds.length);
        if (action >= 9) b = a; // Bias toward insertion and edits within existing insertions.
        if (a > b) [a, b] = [b, a];
        const start = bounds[a].byte, end = bounds[b].byte;
        const replacement = action === 5 ? '' : text(rng, 5);
        let viewStart = start, viewEnd = end;
        if (baseSpace) {
          const operations = ledger.toOperations();
          if (start === end) viewStart = viewEnd = basePosition(baseBytes, operations, start, true);
          else {
            viewStart = basePosition(baseBytes, operations, start, false);
            const interior = operations.some((op) => op.start < end && end < op.end);
            viewEnd = basePosition(baseBytes, operations, end, interior);
          }
        }
        const currentBytes = enc.encode(model);
        const startIndex = dec.decode(currentBytes.slice(0, viewStart)).length;
        const endIndex = dec.decode(currentBytes.slice(0, viewEnd)).length;
        const intended = model.slice(0, startIndex) + replacement + model.slice(endIndex);
        const changed = intended !== model;
        const options = { space: baseSpace ? 'base' : 'view' };
        expect(ledger.replace({ start, end }, replacement, options)).toBe(changed);
        expect(twin.replace({ start, end }, replacement, options)).toBe(changed);
        if (changed) { undo.push(model); redo.length = 0; model = intended; }
      }
      check(ledger, model);
      expect(replay(baseBytes, ledger.toOperations())).toBe(model);
      expect(ledger.serialize()).toBe(twin.serialize());
      for (const space of ['base', 'view']) {
        const value = space === 'base' ? baseText : model;
        const map = ledger.coordinates(space);
        for (const point of boundaries(value)) {
          expect(map.utf16ToByte(point.index)).toBe(point.byte);
          expect(map.byteToUtf16(point.byte)).toBe(point.index);
          expect(map.byteAt(map.positionAt(point.byte))).toBe(point.byte);
        }
      }
      if (step % 17 === 0) {
        const serialized = ledger.serialize();
        ledger = SuggestionLedger.deserialize(baseBytes, ledger.baseIdentity, serialized, { clock });
        expect(ledger.serialize()).toBe(serialized);
        check(ledger, model);
      }
    }
    while (undo.length) {
      redo.push(model); model = undo.pop();
      expect(ledger.undo()).toBe(true); check(ledger, model);
    }
    expect(ledger.undo()).toBe(false);
    while (redo.length) {
      undo.push(model); model = redo.pop();
      expect(ledger.redo()).toBe(true); check(ledger, model);
    }
    expect(ledger.redo()).toBe(false);
  });
}

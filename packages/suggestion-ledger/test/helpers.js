import { expect } from 'bun:test';
import { SuggestionLedger, digestBytes } from '../src/index.js';

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const clock = () => '2026-11-16T12:00:00.000Z';
function make(text = 'abcdef', options = {}) {
  const bytes = enc.encode(text);
  return new SuggestionLedger(bytes, { path: 'Example.md', byteLength: bytes.length, digest: digestBytes(bytes) }, { clock, ...options });
}
function check(ledger, intended = ledger.currentText) {
  expect(ledger.verify()).toBe(true);
  const base = ledger.baseBytes, operations = ledger.toOperations(), candidate = ledger.toCandidateBytes();
  expect(candidate).toEqual(enc.encode(intended));
  let cursor = 0, shifted = 0, lastEnd = -1;
  const ids = new Set();
  expect(Object.isFrozen(operations)).toBe(true);
  for (const op of operations) {
    expect(Object.keys(op).sort()).toEqual(['end', 'expected', 'operationId', 'replacement', 'start']);
    expect(Object.isFrozen(op)).toBe(true);
    expect(op.start).toBeGreaterThan(lastEnd);
    expect(op.end).toBeGreaterThanOrEqual(op.start);
    expect(op.expected).not.toBe(op.replacement);
    expect(ids.has(op.operationId)).toBe(false); ids.add(op.operationId);
    expect(enc.encode(op.expected)).toEqual(base.slice(op.start, op.end));
    const gap = base.slice(cursor, op.start);
    expect(candidate.slice(shifted, shifted + gap.length)).toEqual(gap);
    shifted += gap.length + enc.encode(op.replacement).length;
    cursor = op.end; lastEnd = op.end;
  }
  expect(candidate.slice(shifted)).toEqual(base.slice(cursor));
  expect(Object.keys(ledger.metadata).sort()).toEqual([...ids].sort());
}

// Independent reverse UTF-16 splice replay is deliberately not the production byte-slice path.
function replay(base, operations) {
  let result = dec.decode(base);
  for (const op of [...operations].reverse()) {
    const start = dec.decode(base.slice(0, op.start)).length;
    const end = dec.decode(base.slice(0, op.end)).length;
    result = result.slice(0, start) + op.replacement + result.slice(end);
  }
  return result;
}


export { make, check, replay, clock };

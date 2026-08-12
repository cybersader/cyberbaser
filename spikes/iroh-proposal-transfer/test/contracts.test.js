import { describe, expect, test } from 'bun:test';
import {
  proposalContentKey,
  runtimeLeakPaths,
  sha256Digest,
  stableStringify,
} from '../src/contracts.js';

describe('deterministic fixture contracts', () => {
  test('stable JSON sorts keys, preserves arrays, and appends one LF', () => {
    expect(stableStringify({ z: 1, a: [2, { d: 4, c: 3 }] })).toBe(
      '{\n  "a": [\n    2,\n    {\n      "c": 3,\n      "d": 4\n    }\n  ],\n  "z": 1\n}\n',
    );
  });

  test('content key is canonical unpadded base64url SHA-256', () => {
    const bytes = Buffer.from('canonical proposal bytes\n');
    const key = proposalContentKey(bytes);
    expect(key).toHaveLength(43);
    expect(key).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(Buffer.from(key, 'base64url')).toHaveLength(32);
    expect(sha256Digest(bytes)).toMatch(/^sha-256=:[A-Za-z0-9+/]{43}=:$/u);
  });

  test('runtime leak detector rejects unstable paths, ports, and timing keys', () => {
    expect(runtimeLeakPaths({ safe: true })).toEqual([]);
    expect(runtimeLeakPaths({ tempPath: '/tmp/cb-iroh-x', endpoint: '127.0.0.1:1234', elapsed: 2 }).length).toBeGreaterThan(0);
  });
});

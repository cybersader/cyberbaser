import { test, expect } from 'bun:test';
import { mask, unmask, MaskCollisionError } from '../src/mask.js';
import { roundtrip, normEqual } from '../src/pipeline.js';
import { fixtures } from './fixtures.mjs';

test('mask -> unmask is lossless on every fixture', () => {
  for (const fx of fixtures) {
    const { text, store } = mask(fx.src);
    expect(unmask(text, store)).toBe(fx.src);
  }
});

test('masking removes every OFM bracket construct from parser input', () => {
  for (const fx of fixtures) {
    const { text } = mask(fx.src);
    expect(text).not.toMatch(/!\[\[|\[\[|\[![A-Za-z]/);
  }
});

test('PUA sentinel collision is refused, not silently corrupted', () => {
  expect(() => mask('has a  sentinel')).toThrow(MaskCollisionError);
});

test('round-trip diagnostic reproduces the spike result: >= 20/21 norm-equal, zero mask leaks', () => {
  let ok = 0;
  const failures = [];
  for (const fx of fixtures) {
    const { out, maskLeak } = roundtrip(fx.src);
    expect(maskLeak).toBe(false);
    if (normEqual(out, fx.src)) ok++;
    else failures.push(fx.name);
  }
  // The spike's one known holdout is the nested-callout reflow.
  expect(failures.length).toBeLessThanOrEqual(1);
  if (failures.length === 1) expect(failures[0]).toBe('callout-nested');
  expect(ok).toBeGreaterThanOrEqual(fixtures.length - 1);
});

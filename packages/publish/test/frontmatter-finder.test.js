import { expect, test } from 'bun:test';
import { findFrontmatter, findFrontmatterInText } from '../../correction/src/frontmatter.js';

// Frozen pre-R25 selector. This is a compatibility oracle, not a second reader.
function oldSelectorBlock(text) {
  return /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/d.exec(text);
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
const byteLength = (text) => encoder.encode(text).length;
const bom = String.fromCodePoint(0xfeff);

test('shared byte and string finders preserve the old selector fence and exact YAML text', () => {
  const prefixes = ['', bom, '\n', bom + '\n', 'body\n', bom + bom];
  const openers = ['---\n', '--- \n', '---\t\n', '---\r\n', '---\t \r\n', '---\r', ' ---\n', '----\n', '--- \n'];
  const bodies = ['', '\n', 'title: naïve 😀\n', 'one\r\ntwo\r\n', '---\n', '...\n', '---x\n--- \n', 'text\r\r\n'];
  const closers = ['', '---', '---\nBody\n', '--- \r\nBody\r\n', '---\t ', '---\r', '---\r\r\n', '...\n', '--- ', '  ---\n'];
  for (const prefix of prefixes) for (const opener of openers) for (const body of bodies) for (const closer of closers) {
    const text = prefix + opener + body + closer;
    const match = oldSelectorBlock(text);
    const bytes = encoder.encode(text);
    const raw = findFrontmatter(bytes);
    const result = findFrontmatterInText(text);
    expect(result.kind === 'block').toBe(match !== null);
    expect(raw.kind).toBe(result.kind);
    expect(raw.leadingBom).toBe(text.startsWith(bom));
    if (!match) continue;
    const range = { start: text.startsWith(bom) ? 3 : 0, end: byteLength(match[0]) };
    const yaml = { start: byteLength(text.slice(0, match.indices[1][0])), end: byteLength(text.slice(0, match.indices[1][1])) };
    expect(result.yamlText).toBe(match[1]);
    expect(result.range).toEqual(range);
    expect(raw.range).toEqual(range);
    expect(raw.yaml).toEqual(yaml);
    expect(decoder.decode(bytes.subarray(raw.yaml.start, raw.yaml.end))).toBe(match[1]);
  }
  const unpaired = '---\nvalue: \ud800\n---\n';
  expect(findFrontmatterInText(unpaired).yamlText).toBe(oldSelectorBlock(unpaired)[1]);
});

test('non-selector legacy fences have protection ranges but no YAML range', () => {
  for (const [text, protectedPrefix, reason] of [
    ['---\n---\nbody', '---\n---\n', 'legacy-close'],
    ['---\nvalue: yes\n...\nbody', '---\nvalue: yes\n...\n', 'legacy-close'],
    ['---\r\nvalue: yes\r\n...\r\nbody', '---\r\nvalue: yes\r\n...\r\n', 'legacy-close'],
    ['---\nvalue: yes\nbody', '---\nvalue: yes\nbody', 'unclosed'],
    ['---\nvalue: yes\n---\r', '---\nvalue: yes\n---\r', 'legacy-close'],
  ]) {
    expect(oldSelectorBlock(text)).toBeNull();
    expect(findFrontmatter(encoder.encode(text))).toEqual({
      kind: 'fence-like', range: { start: 0, end: byteLength(protectedPrefix) }, leadingBom: false, reason,
    });
  }
  const paddedClose = '---\nvalue: yes\n--- \n';
  const oldGuarded = paddedClose + 'legacy protected\n---\n';
  const overlap = findFrontmatter(encoder.encode(oldGuarded + 'body'));
  expect(overlap.kind).toBe('block');
  expect(overlap.range.end).toBe(paddedClose.length);
  expect(overlap.protectionEnd).toBe(oldGuarded.length);
});

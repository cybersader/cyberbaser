import { test, expect } from 'bun:test';
import { checkChange } from '../src/check.js';
import { roundtrip } from '../src/pipeline.js';

const DOC = `---
title: Sample
---

See [[Some Page|the alias]] and [[Other]].

> [!note] Heads up
> A callout body with ![[diagram.png|200]] inside.

- item one
- item two with $E = mc^2$
- item three
- item four

A paragraph to edit.
`;

test('an honest region edit is clean', () => {
  const after = DOC.replace('A paragraph to edit.', 'A paragraph that was edited.');
  const r = checkChange(DOC, after);
  expect(r.verdict).toBe('clean');
});

test('deleting a whole section that contains constructs reports removals (damage)', () => {
  const after = DOC.replace('> [!note] Heads up\n> A callout body with ![[diagram.png|200]] inside.\n', '');
  const r = checkChange(DOC, after);
  expect(r.verdict).toBe('damage');
  const types = r.findings.map((f) => f.type);
  expect(types).toContain('callout-removed');
  expect(types).toContain('embed-removed');
});

test('wikilink degraded to a markdown link is damage', () => {
  const after = DOC.replace('[[Some Page|the alias]]', '[Some Page](Some%20Page)');
  const r = checkChange(DOC, after);
  expect(r.verdict).toBe('damage');
  expect(r.findings.some((f) => f.type === 'wikilink-degraded')).toBe(true);
});

test('a re-serializing tool leaves fingerprints: remark output on a real doc is at least suspect', () => {
  const { out } = roundtrip(DOC);
  const r = checkChange(DOC, out);
  expect(['suspect', 'damage']).toContain(r.verdict);
});

test('injected escapes are flagged', () => {
  const after = DOC.replace('A paragraph to edit.', 'A paragraph to edit.\n\n\\[bracket\\] \\*star\\* \\_u\\_ \\#tag');
  const r = checkChange(DOC, after);
  expect(r.findings.some((f) => f.type === 'escapes-injected')).toBe(true);
});

test('identical input is clean with zero churn', () => {
  const r = checkChange(DOC, DOC);
  expect(r.verdict).toBe('clean');
  expect(r.stats.churn).toBe(0);
});

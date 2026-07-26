import { test, expect } from 'bun:test';
import { classify, parseConfig } from '../src/classify.js';

const CONFIG = parseConfig(`
trusted:
  - cybersader
  - somehuman
agents:
  - cyberbaser-bot
  - claude-agent
caps:
  lines: 60
  files: 5
  proseWords: 25
allowedNewFolders:
  - "📁 51 - Cyberbase/**"
  - "docs/**"
frontmatterAllowlist:
  - tags
  - updated
`);

const PAGE = `---
title: Threat modeling
tags: [security]
---

# Threat modeling

See [[STRIDE]] and [[Attack trees|attack trees]] for the standard decompositions.

> [!note] Scope
> This page covers the design phase only.

A paragraph about teh process.
`;

const modified = (path, before, after) => ({ path, before, after, status: 'modified' });
const agentChange = (files) => ({ author: 'cyberbaser-bot', authorType: 'agent', files });

test('an agent typo fix auto-merges', () => {
  const after = PAGE.replace('about teh process', 'about the process');
  const r = classify(agentChange([modified('📁 51 - Cyberbase/threat-modeling.md', PAGE, after)]), CONFIG);
  expect(r.tier).toBe('agent');
  expect(r.route).toBe('auto-merge');
  expect(r.checks.ofm.verdict).toBe('clean');
  expect(r.reasons).toContain('all-agent-gates-passed');
});

test('the same change from an anonymous author does not auto-merge', () => {
  const after = PAGE.replace('about teh process', 'about the process');
  const change = { author: '', authorType: 'anonymous', files: [modified('📁 51 - Cyberbase/threat-modeling.md', PAGE, after)] };
  const r = classify(change, CONFIG);
  expect(r.tier).toBe('anonymous');
  expect(r.route).toBe('full-review');
});

test('an unregistered agent handle fails closed to full-review', () => {
  const after = PAGE.replace('about teh process', 'about the process');
  const change = { author: 'some-other-bot', authorType: 'agent', files: [modified('a.md', PAGE, after)] };
  const r = classify(change, CONFIG);
  expect(r.tier).toBe('unregistered-agent');
  expect(r.route).toBe('full-review');
  expect(r.reasons).toContain('agent-not-registered');
});

test('an agent change that damages a wikilink is rejected', () => {
  const after = PAGE.replace('[[Attack trees|attack trees]]', '[Attack trees](Attack%20trees)');
  const r = classify(agentChange([modified('a.md', PAGE, after)]), CONFIG);
  expect(r.checks.ofm.verdict).toBe('damage');
  expect(['reject', 'full-review']).toContain(r.route);
  expect(r.route).toBe('reject');
  expect(r.reasons).toContain('ofm-damage');
});

test('an oversize agent diff is downgraded', () => {
  const bulk = Array.from({ length: 120 }, (_, i) => `Line ${i} of appended material with a source https://example.com/${i}.`).join('\n');
  const r = classify(agentChange([modified('a.md', PAGE, `${PAGE}\n${bulk}\n`)]), CONFIG);
  expect(r.route).not.toBe('auto-merge');
  expect(r.route).toBe('full-review');
  expect(r.reasons.some((x) => x.startsWith('diff-too-large'))).toBe(true);
});

test('a file deletion is downgraded', () => {
  const change = agentChange([{ path: '📁 51 - Cyberbase/old.md', before: PAGE, after: '', status: 'removed' }]);
  const r = classify(change, CONFIG);
  expect(r.route).not.toBe('auto-merge');
  expect(r.reasons.some((x) => x.startsWith('file-deleted'))).toBe(true);
});

test('a missing config fails closed to full-review', () => {
  const after = PAGE.replace('about teh process', 'about the process');
  const change = agentChange([modified('a.md', PAGE, after)]);
  for (const bad of [null, undefined, '', 0, []]) {
    const r = classify(change, bad);
    expect(r.route).toBe('full-review');
    expect(r.reasons).toContain('no-trust-config');
  }
});

test('a human on the trusted list gets quick-review for a content change', () => {
  const after = PAGE.replace(
    'A paragraph about teh process.',
    'A rewritten paragraph about the process, with several new sentences of guidance for practitioners who are new to it.',
  );
  const change = { author: 'SomeHuman', authorType: 'human', files: [modified('a.md', PAGE, after)] };
  const r = classify(change, CONFIG);
  expect(r.tier).toBe('trusted-human');
  expect(r.route).toBe('quick-review');
});

test('an untrusted human gets full-review', () => {
  const after = PAGE.replace('about teh process', 'about the process');
  const change = { author: 'drive-by', authorType: 'human', files: [modified('a.md', PAGE, after)] };
  const r = classify(change, CONFIG);
  expect(r.route).toBe('full-review');
  expect(r.reasons).toContain('author-not-on-trusted-list');
});

test('an unknown author type fails closed', () => {
  const change = { author: 'x', authorType: 'daemon', files: [modified('a.md', PAGE, PAGE)] };
  const r = classify(change, CONFIG);
  expect(r.tier).toBe('unknown');
  expect(r.route).toBe('full-review');
  expect(r.reasons).toContain('unknown-author-type');
});

test('new prose with no URL is a soft downgrade to quick-review, not a reject', () => {
  const prose = 'Modern control frameworks converge on the same short list of mitigations, and the mapping between them is mechanical rather than a matter of judgment for most control families in practice.';
  const r = classify(agentChange([modified('a.md', PAGE, `${PAGE}\n${prose}\n`)]), CONFIG);
  expect(r.route).toBe('quick-review');
  expect(r.reasons).toContain('no-source-cited');
});

test('the same prose with a citation auto-merges', () => {
  const prose = 'Modern control frameworks converge on the same short list of mitigations, and the mapping between them is mechanical rather than a matter of judgment for most control families in practice (https://csrc.nist.gov/pubs/sp/800/53/r5/upd1/final).';
  const r = classify(agentChange([modified('a.md', PAGE, `${PAGE}\n${prose}\n`)]), CONFIG);
  expect(r.checks.source.hasUrl).toBe(true);
  expect(r.route).toBe('auto-merge');
});

test('a frontmatter key outside the allowlist is downgraded', () => {
  const after = PAGE.replace('title: Threat modeling', 'title: Threat modelling');
  const r = classify(agentChange([modified('a.md', PAGE, after)]), CONFIG);
  expect(r.route).toBe('full-review');
  expect(r.reasons).toContain('frontmatter-key-not-allowlisted:title');
});

test('an allowlisted frontmatter key still auto-merges', () => {
  const after = PAGE.replace('tags: [security]', 'tags: [security, threat-modeling]');
  const r = classify(agentChange([modified('a.md', PAGE, after)]), CONFIG);
  expect(r.checks.frontmatter.changed).toContain('tags');
  expect(r.route).toBe('auto-merge');
});

test('a new file outside the allowed folders is downgraded', () => {
  const body = '# Notes\n\nA short new page.\n';
  const ok = classify(agentChange([{ path: 'docs/new-page.md', before: '', after: body, status: 'added' }]), CONFIG);
  expect(ok.route).toBe('auto-merge');
  const bad = classify(agentChange([{ path: '📁 09 - Personal/new-page.md', before: '', after: body, status: 'added' }]), CONFIG);
  expect(bad.route).toBe('full-review');
  expect(bad.reasons.some((x) => x.startsWith('new-file-outside-allowed-folders'))).toBe(true);
});

test('too many files is downgraded', () => {
  const files = Array.from({ length: 7 }, (_, i) => modified(`p${i}.md`, PAGE, PAGE.replace('teh', 'the')));
  const r = classify(agentChange(files), CONFIG);
  expect(r.reasons.some((x) => x.startsWith('too-many-files'))).toBe(true);
  expect(r.route).toBe('full-review');
});

test('a heading or link-target rewrite is a structural change, not an auto-merge', () => {
  const after = PAGE.replace('# Threat modeling', '# Threat modelling 101');
  const r = classify(agentChange([modified('a.md', PAGE, after)]), CONFIG);
  expect(r.checks.structural.changed).toBe(true);
  expect(r.route).toBe('quick-review');
});

test('an empty change list never auto-merges', () => {
  const r = classify({ author: 'cyberbaser-bot', authorType: 'agent', files: [] }, CONFIG);
  expect(r.route).toBe('full-review');
  expect(r.reasons).toContain('no-files-in-change');
});

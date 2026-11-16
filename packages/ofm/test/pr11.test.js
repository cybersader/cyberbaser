import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { checkChange } from '../src/check.js';
import { roundtrip, makePipeline, RoundtripContentLossError } from '../src/pipeline.js';
import { changedLinePairs } from '../src/line-pairs.js';

// Exact, trimmed public PR #11 excerpts. Base 0cc579a4b0484b1939db1bd76ed9b8b3c1b6a717,
// head 2a2fa72d16b498e662becb52d79e403981daa09c; preserve vault paths verbatim.
const community = '📁 06 - Learning, Notes/⬇️ Notes Drop/Get an Epic Cyber Education for Free (almost) - Carrie Roberts.md';
const features = '📁 10 - My Obsidian Stack/Obsidian Git/Obsidian Git Features & Solutions/Obsidian Git Features & Solutions.md';
const aperture = '📁 03 - Curations, Stacks/Awesome AI/Tailscale Aperture - AI Gateway.md';
const factory = '📁 21 - Development/Software Factory for AI-Written Code.md';
const fixture = (side, path) => readFileSync(new URL(`./fixtures/pr11/${side}/${path}`, import.meta.url), 'utf8');
const types = (result) => result.findings.map((f) => f.type);

test('PR11 community repair is an informational retarget, not damage or suspect', () => {
  const before = fixture('before', community), after = fixture('after', community);
  const result = checkChange(before, after);
  expect(result.verdict).toBe('clean');
  expect(result.findings).toEqual([{
    type: 'wikilink-retargeted', severity: 'info',
    construct: before.trim(), replacement: after.trim(),
  }]);
});

test('multiple links and embeds retarget positionally on corresponding changed lines', () => {
  const result = checkChange('[[A]] and [[B]]\n![[one.png]] ![[two.png]]\n', '[[C]] and [[D]]\n![[three.png]] ![[four.png]]\n');
  expect(result.verdict).toBe('clean');
  expect(types(result)).toEqual(['wikilink-retargeted', 'wikilink-retargeted', 'embed-retargeted', 'embed-retargeted']);
});

test('retarget plus a genuinely removed link or embed still reports damage', () => {
  for (const prefix of ['', '!']) {
    const result = checkChange(`${prefix}[[A]] and ${prefix}[[B]]\n`, `${prefix}[[C]]\n`);
    expect(result.verdict).toBe('damage');
    expect(types(result)).toContain(`${prefix ? 'embed' : 'wikilink'}-retargeted`);
    expect(types(result)).toContain(`${prefix ? 'embed' : 'wikilink'}-removed`);
  }
});

test('a removal cannot be excused by equal-count additions elsewhere', () => {
  const result = checkChange('Remove [[A]] here.\nUnchanged anchor.\nAdd here.\n', 'Remove here.\nUnchanged anchor.\nAdd [[B]] here.\n');
  expect(result.verdict).toBe('damage');
  expect(types(result)).toContain('wikilink-removed');
  expect(types(result)).not.toContain('wikilink-retargeted');
});

test('an unchanged link moving slots is not a newly added replacement', () => {
  const result = checkChange('[[A]] [[B]]\n', '[[B]] [[C]]\n');
  expect(result.verdict).toBe('damage');
  expect(types(result)).toContain('wikilink-removed');
});

test('link removal, plain text and Markdown degradation remain damage', () => {
  for (const after of ['', 'A\n', '[A](A.md)\n']) {
    expect(checkChange('[[A]]\n', after).verdict).toBe('damage');
  }
  expect(checkChange('![[image.png]]\n', '![image.png](image.png)\n').verdict).toBe('damage');
});

test('unchanged line anchors survive inserted lines before a retarget', () => {
  const result = checkChange('Title\n\n[[A]]\nEnd\n', 'New heading\nTitle\n\n[[B]]\nEnd\n');
  expect(result.verdict).toBe('clean');
  expect(types(result)).toEqual(['wikilink-retargeted']);
});

test('ambiguous unequal-length hunks do not infer a retarget', () => {
  const result = checkChange('[[A]]\nEnd\n', 'New text\n[[B]]\nEnd\n');
  expect(result.verdict).toBe('damage');
});

test('bounded alignment fails closed on a whole-file rewrite', () => {
  const before = Array.from({ length: 150 }, (_, i) => `old ${i}`).join('\n');
  const after = Array.from({ length: 150 }, (_, i) => `new ${i}`).join('\n');
  expect(changedLinePairs(before, after)).toEqual([]);
});

test('informational retargets do not suppress genuine normalization fingerprints', () => {
  const before = '[[A]]\n' + '- ordinary text\n'.repeat(50);
  const after = '[[B]]\n' + '* ordinary text\n'.repeat(50);
  const result = checkChange(before, after);
  expect(result.verdict).toBe('suspect');
  expect(types(result)).toContain('wikilink-retargeted');
  expect(types(result)).toContain('list-marker-normalized');
});

test('PR11 bracket escapes disambiguate real Markdown labels without injection', () => {
  const before = fixture('before', features), after = fixture('after', features);
  const result = checkChange(before, after);
  expect(result.stats.escapesAfter - result.stats.escapesBefore).toBe(4);
  expect(result.verdict).toBe('clean');
  expect(types(result)).not.toContain('escapes-injected');
});

test('ordinary prose escape injection remains suspect beside deliberate label repairs', () => {
  const before = fixture('before', features) + '\n*plain* _prose_ #tag.\n';
  const after = fixture('after', features) + '\n\\*plain\\* \\_prose\\_ \\#tag\\.\n';
  const result = checkChange(before, after);
  expect(result.verdict).toBe('suspect');
  expect(result.findings.find((f) => f.type === 'escapes-injected').count).toBe(6);
});

test('new link labels, changed destinations and inline code do not earn exemptions', () => {
  const before = '[[Feature]: title](https://example.com)\n'.repeat(2);
  const escaped = '[\\[Feature\\]: title](https://other.example.com)\n'.repeat(2);
  expect(types(checkChange(before, escaped))).toContain('escapes-injected');
  expect(types(checkChange('', escaped))).toContain('escapes-injected');
  expect(types(checkChange('`' + before.trim() + '`', '`' + escaped.trim() + '`'))).toContain('escapes-injected');
});

test('non-bracket escapes inside real labels remain detectable', () => {
  const before = '[[Feature]: one * two _ three #](https://example.com)\n';
  const after = '[\\[Feature\\]: one \\* two \\_ three \\#](https://example.com)\n';
  expect(types(checkChange(before, after))).toContain('escapes-injected');
});

test('PR11 factory sentence survives; the blank first divergence was inserted spacing', () => {
  const src = fixture('after', factory);
  const sentence = src.split('\n').find((line) => line.startsWith('- **Correct'));
  const { out } = roundtrip(src);
  expect(out).toContain(sentence);
  expect(out.split('\n')[1]).toBe('');
  expect(out).not.toContain('\n* ');
  expect(checkChange(src, out).verdict).toBe('clean');
});

test('PR11 Aperture diagnostic keeps dash bullets instead of inventing author churn', () => {
  const src = fixture('after', aperture);
  const { out, maskLeak } = roundtrip(src);
  expect(maskLeak).toBe(false);
  expect(out.match(/^\s*- /gm)?.length).toBe(src.match(/^\s*- /gm)?.length);
  expect(out).not.toMatch(/^\s*\* /m);
  expect(types(checkChange(src, out))).not.toContain('list-marker-normalized');
});

test('default diagnostic adopts dash, star and plus markers, ignoring code fences', () => {
  for (const bullet of ['-', '*', '+']) {
    const src = '```md\n* not a list\n```\n\n' + `${bullet} first\n${bullet} second\n`;
    expect(roundtrip(src).out).toContain(`${bullet} first\n${bullet} second`);
  }
});

test('an explicitly supplied serializer retains its configured bullet option', () => {
  expect(roundtrip('- item\n', makePipeline({ bullet: '*' })).out).toBe('* item\n');
});

test('loss of a sentence is a checker error, never a silent roundtrip pass', () => {
  const src = fixture('after', factory);
  const droppingPipeline = { processSync: (text) => text.replace(/^- \*\*Correct[^\n]*\n/m, '') };
  expect(() => roundtrip(src, droppingPipeline)).toThrow(RoundtripContentLossError);
  expect(() => roundtrip(src, droppingPipeline)).toThrow('checker error');
});

test('complete disappearance or substitution of a mask token is a checker error', () => {
  expect(() => roundtrip('See [[secret page]].\n', { processSync: () => 'See .\n' })).toThrow(RoundtripContentLossError);
  expect(() => roundtrip('[[A]] [[B]]\n', {
    processSync: (text) => text.replace('0', '1'),
  })).toThrow(RoundtripContentLossError);
});

test('guard detects dropped code, frontmatter, link destinations and image alt content', () => {
  for (const [src, dropped] of [
    ['```js\ncritical();\n```\n', '```js\n```\n'],
    ['---\ntitle: Important\n---\n\nBody.\n', 'Body.\n'],
    ['[label](https://critical.example/path)\n', 'label\n'],
    ['![Critical diagram](image.png)\n', '![](image.png)\n'],
  ]) expect(() => roundtrip(src, { processSync: () => dropped })).toThrow(RoundtripContentLossError);
});

test('guard allows whitespace and Markdown delimiter normalization without claiming content loss', () => {
  expect(roundtrip('**bold** and &amp;\n', { processSync: () => '__bold__   and &\n\n' }).out).toBe('__bold__   and &\n\n');
});

test('a retargeted occurrence cannot hide removal of an identical duplicate', () => {
  for (const prefix of ['', '!']) {
    const result = checkChange(`${prefix}[[A]] ${prefix}[[A]]\n`, `${prefix}[[B]]\n`);
    expect(result.verdict).toBe('damage');
    expect(types(result)).toContain(`${prefix ? 'embed' : 'wikilink'}-removed`);
  }
});

test('content-loss guard does not accept an anagram as retained source text', () => {
  expect(() => roundtrip('abc def\n', { processSync: () => 'abd cef\n' })).toThrow(RoundtripContentLossError);
});

test('content guard accepts reference links, footnotes, Unicode and semantic delimiter normalization', () => {
  for (const src of [
    '[reference][ID]\n\n[ID]: https://example.com "Title"\n',
    'Text[^A].\n\n[^A]: Footnote body.\n',
    '## heading ##\n\n~~deleted~~ and &copy;.\n',
    '👩‍💻 Café and [[📁 11 - Community]].\n',
    '',
  ]) expect(() => roundtrip(src)).not.toThrow();
});

test('Markdown-shaped links in fenced code do not earn bracket exemptions', () => {
  const before = '```md\n[[Feature]: title](https://example.com)\n[[Bug]: title](https://example.com)\n```\n';
  const after = '```md\n[\\[Feature\\]: title](https://example.com)\n[\\[Bug\\]: title](https://example.com)\n```\n';
  expect(types(checkChange(before, after))).toContain('escapes-injected');
});

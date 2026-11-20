import { expect, test } from 'bun:test';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const starter = fileURLToPath(new URL('../', import.meta.url));
const fixture = path.join(starter, 'test', 'fixture');
const read = (p) => readFileSync(p, 'utf8');

function inTemp(fn) {
  const root = mkdtempSync(path.join(tmpdir(), 'solid-reader-'));
  try { fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

function run(input, output) {
  const result = Bun.spawnSync([process.execPath, 'run', '--cwd', starter, 'build', input, output], {
    stdout: 'pipe', stderr: 'pipe', timeout: 15_000,
  });
  return { status: result.exitCode, log: `${result.stdout}\n${result.stderr}` };
}

function ok(input, output, summary) {
  const result = run(input, output);
  expect(result.log).toContain(summary);
  expect(result.status).toBe(0);
}

function refuses(input, output, reason) {
  const result = run(input, output);
  expect(result.status).not.toBe(0);
  expect(result.log).toContain(reason);
}

test('documented CLI emits static Solid pages, local navigation, and a stable URL manifest', () => inTemp((root) => {
  const output = path.join(root, 'site');
  ok(fixture, output, '2 notes, 1 images, 0 skipped assets');
  const home = read(path.join(output, 'index.html'));
  const guide = read(path.join(output, 'notes/guides/Field Guide.html'));
  const catalog = read(path.join(output, 'notes/index.html'));
  expect(home).toContain('<h1>Field Notebook</h1>');
  expect(home).toContain('href="./notes/index.html"');
  expect(home).toContain('href="./notes/guides/Field%20Guide.html#first-steps"');
  expect(home).toContain('href="./notes/guides/Field%20Guide.html">Open the guide by alias');
  expect(home).toContain('class="unresolved-reference">Missing notes remain readable text.');
  expect(home).toContain('src="./_media/media/sample.png" alt="Green blocks in a small mosaic"');
  expect(home).toContain('href="https://example.com/reference" rel="noreferrer"');
  expect(guide).toContain('href="../../index.html">Return home');
  expect(guide).toContain('href="../../reader.css"');
  expect(guide).toContain('id="first-steps"');
  expect(guide).toContain('id="first-steps-1"');
  expect(guide).toContain('href="#first-steps-1"');
  expect(guide).toContain('class="align-right"');
  expect(guide).toContain('<strong>Markdown</strong>');
  expect(guide).toContain('src="../../_media/media/sample.png" alt="Embedded mosaic"');
  expect(catalog).toContain('href="./guides/Field%20Guide.html">Field guide');
  expect(catalog).toContain('href="../index.html">Field Notebook');
  expect(readFileSync(path.join(output, '_media/media/sample.png'))).toEqual(readFileSync(path.join(fixture, 'media/sample.png')));
  expect(JSON.parse(read(path.join(output, 'notes.json')))).toEqual([
    { source: 'README.md', file: 'index.html', url: 'index.html' },
    { source: 'guides/Field Guide.md', file: 'notes/guides/Field Guide.html', url: 'notes/guides/Field%20Guide.html' },
  ]);
  expect(read(path.join(fixture, 'README.md'))).toContain('hidden-multiline-canary');
  expect(existsSync(path.join(output, 'README.md'))).toBe(false);
}));

test('OFM comments are absent from emitted bytes and do not alter code examples', () => inTemp((root) => {
  const output = path.join(root, 'site');
  ok(fixture, output, '2 notes');
  const bytes = read(path.join(output, 'index.html'));
  for (const canary of ['hidden-multiline-canary', 'hidden-multiline-code-canary', 'Hidden comment link canary', 'Not an outline heading', 'hidden-inline-canary']) {
    expect(bytes).not.toContain(canary);
  }
  expect(bytes).toContain('A visible sentence after the multiline comment. A  short sentence.');
  expect(bytes).toContain('<code>100%%</code>');
  expect(bytes).toContain('literal %% from a code fence');
}));

test('untrusted author content cannot add active markup, fetch remote media, or link outside the projection', () => inTemp((root) => {
  const input = path.join(root, 'projection');
  const output = path.join(root, 'site');
  mkdirSync(input);
  writeFileSync(path.join(input, 'a.md'), `---
title: '<b>Not HTML</b>'
---
<script>raw-literal-canary</script>

<img src="x" onerror="raw-event-canary()">

[Not an executable link](javascript:void%280%29)

[Not a protocol-relative link](//example.com/assets)

![Not a remote image](https://example.com/image.png)

![Not a data image](data:image/png;base64,AAAA)

[Not off the tree](../elsewhere.md) [Still not off the tree](%2e%2e/elsewhere.md)

[Not through separators](%2felsewhere.md) [Backslash encoded](%5celsewhere.md)

[[x.svg|Not a raster]] [Not HTML](active.html) ![[fake.png]]

\`[[unresolved-literal]]\` and [[b|<b>escaped wiki label</b>]]

%%unclosed-comment-canary
`);
  writeFileSync(path.join(input, 'b.md'), 'B');
  writeFileSync(path.join(root, 'elsewhere.md'), 'outside-projection-canary');
  writeFileSync(path.join(input, 'x.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  writeFileSync(path.join(input, 'active.html'), '<p>active html file</p>');
  writeFileSync(path.join(input, 'fake.png'), '<p>not a png</p>');
  ok(input, output, '2 notes, 0 images, 3 skipped assets');
  const html = read(path.join(output, 'notes/a.html'));
  expect(html).toContain('&lt;script&gt;raw-literal-canary&lt;/script&gt;');
  expect(html).toContain('<h1>&lt;b>Not HTML&lt;/b></h1>');
  expect(html).toContain('<a href="./b.html">&lt;b&gt;escaped wiki label&lt;/b&gt;</a>');
  expect(html).toContain('<code>[[unresolved-literal]]</code>');
  expect(html).toContain("script-src 'none'");
  expect(html).not.toMatch(/<(?:script|img|iframe)\b|\b(?:href|src)="(?:javascript:|data:|\/\/)|\bhref="[^"\n]*(?:elsewhere|active\.html|x\.svg)/i);
  expect(html).not.toContain('unclosed-comment-canary');
  expect(existsSync(path.join(output, '_media'))).toBe(false);
  expect(read(path.join(output, 'index.html'))).toContain('<h1>All notes</h1>');
}));

test('collision and slug preflight do not create output', () => inTemp((root) => {
  const input = path.join(root, 'projection');
  const output = path.join(root, 'site');
  mkdirSync(input);
  writeFileSync(path.join(input, 'a.md'), '---\nslug: index\n---\nA');
  writeFileSync(path.join(input, 'b.md'), '---\nslug: index\n---\nB');
  refuses(input, output, 'duplicate output route');
  expect(existsSync(output)).toBe(false);
  writeFileSync(path.join(input, 'b.md'), '---\nslug: ../outside\n---\nB');
  refuses(input, output, 'invalid note route');
  expect(existsSync(output)).toBe(false);
  expect(existsSync(path.join(root, 'outside.html'))).toBe(false);
}));

test('existing directories and dangling symlinks are never replaced', () => inTemp((root) => {
  const out = path.join(root, 'exists');
  mkdirSync(out);
  writeFileSync(path.join(out, 'retain'), 'owned by caller');
  refuses(fixture, out, 'output already exists');
  expect(read(path.join(out, 'retain'))).toBe('owned by caller');
  const dangling = path.join(root, 'dangling');
  symlinkSync(path.join(root, 'missing'), dangling);
  refuses(fixture, dangling, 'output already exists');
  expect(existsSync(path.join(root, 'missing'))).toBe(false);
}));

test('symlinks, hard links, and directory-argument traversal are refused', () => inTemp((root) => {
  const input = path.join(root, 'projection');
  const output = path.join(root, 'site');
  mkdirSync(input);
  const outside = path.join(root, 'outside.md');
  writeFileSync(outside, 'outside');
  const linkedEntry = path.join(input, 'link.md');
  symlinkSync(outside, linkedEntry);
  refuses(input, output, 'symlink or non-regular entry');
  rmSync(linkedEntry);
  linkSync(outside, linkedEntry);
  refuses(input, output, 'symlink or non-regular entry');
  rmSync(linkedEntry);
  const linkDir = path.join(root, 'dir-link');
  symlinkSync(input, linkDir);
  refuses(linkDir, output, 'not a directory or is a symlink');
  refuses(input, `${linkDir}/not-created`, 'not a directory or is a symlink');
  refuses(`${input}/../projection`, output, 'parent traversal');
  refuses(input, `${root}/projection/../site`, 'parent traversal');
  refuses(input, path.join(input, 'site'), 'output must be outside');
  expect(existsSync(output)).toBe(false);
}));

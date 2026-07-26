import { test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkSite, classify, isExternal, normalizeHref } from '../src/check.js';

let site;

// Fixture layout (mirrors the shapes Quartz actually emits, emoji folder included):
//
//   index.html
//   guide.html
//   section/index.html
//   📁-01---Notes/note.html
//   📁-01---Notes/_attachments/pic.png
//
beforeAll(() => {
  site = mkdtempSync(join(tmpdir(), 'cb-linkcheck-'));
  mkdirSync(join(site, 'section'), { recursive: true });
  mkdirSync(join(site, '📁-01---Notes', '_attachments'), { recursive: true });

  writeFileSync(join(site, 'guide.html'), '<h1>guide</h1>');
  writeFileSync(join(site, 'section', 'index.html'), '<h1>section</h1>');
  writeFileSync(join(site, '📁-01---Notes', 'note.html'), '<h1>note</h1>');
  writeFileSync(join(site, '📁-01---Notes', '_attachments', 'pic.png'), 'PNG');

  writeFileSync(
    join(site, 'index.html'),
    [
      '<a href="./guide">resolving page link</a>',
      '<a href="./section">resolving directory index</a>',
      '<a href="./%F0%9F%93%81-01---Notes/note">percent-encoded emoji path</a>',
      '<a href="./does-not-exist">broken page link</a>',
      '<img src="./_attachments/pic.png" alt="broken attachment">',
      '<a href="https://example.com/page">external, skipped</a>',
      '<a href="#section-two">anchor only, skipped</a>',
      '<a href="mailto:someone@example.com">mail, skipped</a>',
      '<a href="javascript:void(0)">js, skipped</a>',
    ].join('\n'),
  );
});

afterAll(() => rmSync(site, { recursive: true, force: true }));

test('resolving links, directory indexes and percent-encoded emoji paths all count as ok', () => {
  const r = checkSite(site);
  const okHrefs = ['./guide', './section', './%F0%9F%93%81-01---Notes/note'];
  for (const h of okHrefs) {
    expect(r.broken.find((b) => b.href === h)).toBeUndefined();
  }
  expect(r.ok).toBe(3);
});

test('external, anchor-only, mailto and javascript hrefs are never checked', () => {
  const r = checkSite(site);
  // 5 internal links on index.html; the 4 skipped ones never enter the count.
  expect(r.total).toBe(5);
  const all = r.broken.map((b) => b.href).join(' ');
  expect(all).not.toContain('example.com');
  expect(all).not.toContain('mailto');
});

test('a dead page link and a dead _attachments link are reported and classified', () => {
  const r = checkSite(site);
  expect(r.broken.length).toBe(2);
  expect(r.byClass).toEqual({ 'relative-attachment': 1, 'missing-page': 1 });

  const att = r.broken.find((b) => b.class === 'relative-attachment');
  expect(att.href).toBe('./_attachments/pic.png');
  expect(att.page).toBe('index.html');

  const page = r.broken.find((b) => b.class === 'missing-page');
  expect(page.href).toBe('./does-not-exist');
});

test('percent-encoding is decoded before the on-disk test', () => {
  const r = checkSite(site);
  expect(normalizeHref('./%F0%9F%93%81-01---Notes/note')).toBe('./📁-01---Notes/note');
  expect(r.total).toBeGreaterThan(0);
});

test('output is deterministic and byPage is sorted by break count', () => {
  const a = JSON.stringify(checkSite(site));
  const b = JSON.stringify(checkSite(site));
  expect(a).toBe(b);
  expect(Object.keys(checkSite(site).byPage)).toEqual(['index.html']);
});

test('classification falls back by extension', () => {
  expect(classify('a/_attachments/x.png')).toBe('relative-attachment');
  expect(classify('a/b.png')).toBe('missing-asset');
  expect(classify('a/b')).toBe('missing-page');
  expect(classify('a/b.html')).toBe('missing-page');
  expect(classify('a/b.zzz')).toBe('other');
});

test('isExternal covers the skip list', () => {
  const skipped = ['https://x.test', 'http://x.test', '//x.test', '#a', 'mailto:a@b.c', 'tel:+1', 'javascript:1', 'about:blank#x', 'data:image/png;base64,AA'];
  for (const h of skipped) {
    expect(isExternal(h)).toBe(true);
  }
  expect(isExternal('./local')).toBe(false);
});

test('basePath strips the deploy prefix from root-absolute hrefs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cb-linkcheck-base-'));
  writeFileSync(join(dir, 'index.css'), 'x');
  writeFileSync(join(dir, 'index.html'), '<a href="/cyberbase/index.css">css</a>');
  expect(checkSite(dir).broken.length).toBe(1);
  expect(checkSite(dir, { basePath: '/cyberbase/' }).broken).toEqual([]);
  rmSync(dir, { recursive: true, force: true });
});

test('fragments and queries are stripped before resolution', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cb-linkcheck-frag-'));
  writeFileSync(join(dir, 'target.html'), 'x');
  writeFileSync(join(dir, 'index.html'), '<a href="./target#heading">frag</a><a href="./target?v=1">query</a>');
  const r = checkSite(dir);
  expect(r.broken).toEqual([]);
  expect(r.ok).toBe(2);
  rmSync(dir, { recursive: true, force: true });
});

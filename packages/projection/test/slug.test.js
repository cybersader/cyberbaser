import { afterAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { project, slugTarget } from '../src/index.js';

// Publish rule 2 requires an explicit `slug:` for a page granted outside the
// allowlist; the projection applies it by projecting the page to `<slug>.md`.

const roots = [];
const mkroot = (name) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `cb-slug-${name}-`)); roots.push(d); return d; };
afterAll(() => { for (const d of roots) fs.rmSync(d, { recursive: true, force: true }); });
const write = (root, rel, content) => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
};

test('slugTarget accepts plain relative paths only', () => {
  expect(slugTarget('index')).toBe('index.md');
  expect(slugTarget('/notes/start/')).toBe('notes/start.md');
  expect(slugTarget('about.html')).toBe('about.md');
  for (const bad of ['', '  ', '../up', 'a/../b', 'a//b', 'a\\b', 'x\u0001', 42, null]) expect(slugTarget(bad)).toBeNull();
});

test('slug: index makes a root note the home page and keeps its old path as an alias', () => {
  const v = mkroot('home');
  write(v, 'publish.yml', 'allow:\n  - pub/**\n');
  write(v, 'README.md', '---\ncb-publish: true\nslug: index\ntitle: Home\n---\n\n<img src="_attachments/art.png">\n');
  write(v, '_attachments/art.png', Buffer.from([137, 80, 78, 71]));
  write(v, 'pub/note.md', '---\ntitle: Note\n---\n\nbody\n');
  const out = path.join(mkroot('home-out'), 'content');
  const r = project(v, out, { writeReport: false });
  expect(r.failures).toEqual([]);
  expect(r.counts.relocatedPages).toBe(1);
  expect(fs.existsSync(path.join(out, 'README.md'))).toBe(false);
  const home = fs.readFileSync(path.join(out, 'index.md'), 'utf8');
  expect(home).toContain('README');
  expect(home).toContain('<img src="_attachments/art.png">');
  expect(fs.existsSync(path.join(out, '_attachments/art.png'))).toBe(true);
  expect(r.leakTest.ok).toBe(true);
});

test('a slug onto a path another page uses fails before anything is written', () => {
  const v = mkroot('taken');
  write(v, 'publish.yml', 'allow:\n  - "*.md"\n');
  write(v, 'README.md', '---\nslug: index\n---\n\nhome\n');
  write(v, 'index.md', '---\ntitle: Placeholder\n---\n\nold home\n');
  const out = path.join(mkroot('taken-out'), 'content');
  const r = project(v, out, { writeReport: false });
  expect(r.ok).toBe(false);
  expect(r.failures.find((f) => f.kind === 'slug').message).toContain('index.md');
  expect(fs.existsSync(out)).toBe(false);
});

test('a slug that moves a note to another folder fails when it has relative references', () => {
  const v = mkroot('move');
  write(v, 'publish.yml', 'allow: []\n');
  write(v, 'private/Start.md', '---\ncb-publish: true\nslug: start\n---\n\n![x](pic.png)\n');
  write(v, 'private/pic.png', Buffer.from([1]));
  const r = project(v, path.join(mkroot('move-out'), 'content'), { writeReport: false });
  expect(r.ok).toBe(false);
  expect(r.failures.find((f) => f.kind === 'slug').message).toContain('pic.png');

  write(v, 'private/Start.md', '---\ncb-publish: true\nslug: start\n---\n\n[[Other]] and https://example.com\n');
  const out = path.join(mkroot('move-out2'), 'content');
  const ok = project(v, out, { writeReport: false });
  expect(ok.failures).toEqual([]);
  expect(fs.existsSync(path.join(out, 'start.md'))).toBe(true);
});

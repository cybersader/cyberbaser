import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { proposalDisplay } from '../src/publication-display.js';
import { excerptDocument, FRAME_CSP, reviewModel } from '../src/proposal-review-page.js';
import { SITE_FRAME_CSP, SITE_REVIEW_REASONS, loadSitePage, markSitePage, prepareSiteFrame, quartzSlug, sitePageSlug } from '../src/site-review-page.js';
import { createProposalDocumentFixture, FIXTURE_TEXTS } from './proposal-document-fixtures.js';

// Captured from a real pinned Quartz 4.5.2 build with source provenance of
// synthetic notes (long Quartz scripts and component styles trimmed).
const FIXTURES = path.join(import.meta.dir, 'fixtures/site-review');
const fixture = async (name) => ({
  html: await readFile(path.join(FIXTURES, `${name}.html`), 'utf8'),
  provenance: JSON.parse(await readFile(path.join(FIXTURES, `${name}.provenance.json`), 'utf8')),
});
const MARKUP_BASE = '# Restore notes\n\nRestore a **small** folder to the original drive.\n\n- Write dates in the same format.\n- Keep the green binder by the door.\n\n<!-- HTML_HIDDEN_CANARY -->\n\n%% OBSIDIAN_HIDDEN_CANARY %%\n\n<script>window.HOSTILE_SCRIPT = 1</script>\n\n<img src="x" onerror="window.HOSTILE_IMG = 1">\n\n<a href="https://evil.example/away" target="_top">Read more</a>\n\n<iframe src="https://evil.example/frame"></iframe>\n\n![diagram](../_attachments/diagram.svg)\n\nThe ending stays.\n';
const REWRITES = [
  ['Restore some files somewhere and see if it worked. If nothing complains, the backup is probably fine for now.',
    'Restore a small folder to a spare drive. Keep the working copy disconnected until you have checked every restored file.'],
  ['Look at a few files when you have time. If they open at all, you can assume the rest of them are fine.',
    'Open a document and a photo from the restored folder. Compare their checksums with the originals; a matching count is not enough.'],
  ['Delete the test copy when you are done so it does not take up space on the drive afterwards.',
    'Keep the restored folder until you have written down the snapshot name, the date and how long the restore took.'],
];

function proposal(baseText, edits) {
  const base = Buffer.from(baseText);
  const operations = edits.map(([find, oldText, replacementText]) => {
    const start = base.indexOf(find);
    if (start < 0) throw new Error(`missing ${find}`);
    return { path: 'note.md', start, end: start + Buffer.byteLength(oldText), oldText, replacementText };
  });
  let candidate = base;
  for (const op of [...operations].sort((a, b) => b.start - a.start)) {
    candidate = Buffer.concat([candidate.subarray(0, op.start), Buffer.from(op.replacementText), candidate.subarray(op.end)]);
  }
  const document = { baseText, candidateText: candidate.toString(), reason: null };
  const display = proposalDisplay({ path: 'note.md', ...document, operations });
  return { operations, document, model: reviewModel({ operations, display, document }) };
}

async function mark(name, baseText, edits) {
  const { html, provenance } = await fixture(name);
  const { operations, model } = proposal(baseText, edits);
  return markSitePage({ html, provenance, baseText, operations, model });
}

const paragraph = (html, node) => new RegExp(`<p data-cb-node="${node}">[\\s\\S]*?</p>`, 'u').exec(html)?.[0];

describe('marking changes on the built site page', () => {
  test('the captured fixtures were rendered from exactly the synthetic base bytes', async () => {
    for (const [name, text] of [['backup', FIXTURE_TEXTS.backup], ['rewrite', FIXTURE_TEXTS.rewriteBase], ['markup', MARKUP_BASE]]) {
      const { provenance } = await fixture(name);
      expect(provenance.source.sha256).toBe(createHash('sha256').update(text).digest('hex'));
    }
  });

  test('a one-word replacement is marked at whole words where the site rendered it', async () => {
    const html = await mark('backup', FIXTURE_TEXTS.backup, [['original drive', 'original drive', 'spare drive']]);
    expect(paragraph(html, 'cb3')).toBe('<p data-cb-node="cb3">Restore a small folder to the <span class="cbr-c cbr-n1" id="c1"><del>original</del> <ins>spare</ins></span> drive. Leave the working copy alone.</p>');
  });

  test('a change inside a word grows to the whole word', async () => {
    const html = await mark('backup', FIXTURE_TEXTS.backup, [['riginal drive', 'rig', 'bor']]);
    expect(paragraph(html, 'cb3')).toContain('<del>original</del> <ins>oborinal</ins>');
  });

  test('insertions and deletions are marked in place, each with its own anchor', async () => {
    const html = await mark('backup', FIXTURE_TEXTS.backup, [['small folder', '', 'very '], ['Leave the working', 'Leave the ', 'Leave the whole ']]);
    expect(paragraph(html, 'cb3')).toBe('<p data-cb-node="cb3">Restore a <span class="cbr-c cbr-n1" id="c1"><ins>very</ins> </span>small folder to the original drive. Leave the <span class="cbr-c cbr-n2" id="c2"><ins>whole</ins> </span>working copy alone.</p>');
    const removed = await mark('backup', FIXTURE_TEXTS.backup, [['working copy', 'working ', '']]);
    expect(paragraph(removed, 'cb3')).toContain('Leave the <span class="cbr-c cbr-n1" id="c1"><del>working</del> </span>copy alone.');
  });

  test('a link text change inside the link is placed; one crossing markup is not guessed', async () => {
    const inside = await mark('backup', FIXTURE_TEXTS.backup, [['restore guide', 'restore guide', 'recovery guide']]);
    expect(inside).toContain('<span class="cbr-c cbr-n1" id="c1"><del>restore</del> <ins>recovery</ins></span> guide');
    // Shared link markup is context, so only the plain word before it changes.
    expect(await mark('backup', FIXTURE_TEXTS.backup, [['the [restore', 'the [restore', 'our [restore']])).toContain('<del>the</del> <ins>our</ins>');
    expect(await mark('backup', FIXTURE_TEXTS.backup, [['the [restore guide]', 'the [restore guide]', 'the guide']])).toBeNull();
    expect(await mark('markup', MARKUP_BASE, [['a **small** folder', 'a **small** folder', 'one folder']])).toBeNull();
  });

  test('a change the site would render differently, or with no provenance, falls back', async () => {
    expect(await mark('backup', FIXTURE_TEXTS.backup, [['original drive', 'original', '**spare**']])).toBeNull();
    const { html, provenance } = await fixture('backup');
    const { operations, model } = proposal(FIXTURE_TEXTS.backup, [['original drive', 'original', 'spare']]);
    const stripped = { ...provenance, leaves: provenance.leaves.filter((leaf) => !leaf.text.includes('original drive')) };
    expect(markSitePage({ html, provenance: stripped, baseText: FIXTURE_TEXTS.backup, operations, model })).toBeNull();
    // A page whose rendered text no longer matches its provenance is not trusted.
    expect(markSitePage({ html: html.replace('original drive', 'other drive'), provenance, baseText: FIXTURE_TEXTS.backup, operations, model })).toBeNull();
    // A link destination is not rendered text.
    expect(await mark('backup', FIXTURE_TEXTS.backup, [['docs.example/restore', 'docs.example', 'help.example']])).toBeNull();
  });

  test('rewritten paragraphs keep the site block, labelled, with the old text a tap away', async () => {
    const html = await mark('rewrite', FIXTURE_TEXTS.rewriteBase, REWRITES.map(([old, next]) => [old, old, next]));
    expect(html.match(/<div class="cbr-rw"><span class="cbr-tag">Rewritten<\/span><p data-cb-node="cb\d+">/gu)).toHaveLength(3);
    for (const [index, [old, next]] of REWRITES.entries()) {
      const block = new RegExp(`<p data-cb-node="cb\\d+">[^<]*<span class="cbr-c[^"]*" id="c${index + 1}">[\\s\\S]*?</p>`, 'u').exec(html)?.[0];
      expect(block.replace(/<[^>]+>/gu, '')).toBe(next);
      expect(html).toContain(`<details class="cbr-old"><summary>Show what it said before</summary><div class="cbr-was">${old}</div></details></div>`);
    }
  });

  test('one exact change spanning three paragraphs is shown paragraph by paragraph under one anchor', async () => {
    const old = REWRITES.map(([before]) => before).join('\n\n');
    const next = REWRITES.map(([, after]) => after).join('\n\n');
    const html = await mark('rewrite', FIXTURE_TEXTS.rewriteBase, [[old, old, next]]);
    expect(html.match(/<div class="cbr-rw">/gu)).toHaveLength(3);
    expect(html.match(/class="cbr-c cbr-n1"/gu)).toHaveLength(3);
    expect(html.match(/id="c1"/gu)).toHaveLength(1);
    expect(html).toContain('body:has(#c1:target) .cbr-n1 :is(ins,del)');
  });

  // The site renders some characters differently from their source (curly
  // quotes, dashes): provenance records them as atom runs inside a text node.
  async function withAtom() {
    const { html, provenance } = await fixture('rewrite');
    const leaves = provenance.leaves.map((leaf) => {
      const at = leaf.text.indexOf('worked.');
      if (at < 0) return leaf;
      const k = at + 'worked'.length; const [r0, r1] = leaf.runs[0].rendered; const [s0, s1] = leaf.runs[0].source;
      return { ...leaf, exact: undefined, runs: [{ rendered: [r0, k], source: [s0, s0 + k], kind: 'exact' },
        { rendered: [k, k + 1], source: [s0 + k, s0 + k + 1], kind: 'atom' }, { rendered: [k + 1, r1], source: [s0 + k + 1, s1], kind: 'exact' }] };
    });
    return { html, provenance: { ...provenance, leaves } };
  }

  test('a rewrite across differently rendered characters is placed when every block maps exactly, folded as Rewritten', async () => {
    const { html, provenance } = await withAtom();
    const old = REWRITES.map(([before]) => before).join('\n\n');
    const next = REWRITES.map(([, after]) => after).join('\n\n');
    const { operations, model } = proposal(FIXTURE_TEXTS.rewriteBase, [[old, old, next]]);
    const marked = markSitePage({ html, provenance, baseText: FIXTURE_TEXTS.rewriteBase, operations, model });
    expect(marked.match(/<div class="cbr-rw">/gu)).toHaveLength(3);
    expect(marked).toContain(`<div class="cbr-was">${REWRITES[0][0]}</div>`);
    expect(marked.match(/id="c1"/gu)).toHaveLength(1);
  });

  test('a small change across a differently rendered character is never guessed', async () => {
    const { html, provenance } = await withAtom();
    const { operations, model } = proposal(FIXTURE_TEXTS.rewriteBase, [['worked. If', 'worked. If', 'worked, so if']]);
    expect(markSitePage({ html, provenance, baseText: FIXTURE_TEXTS.rewriteBase, operations, model })).toBeNull();
    // A rewrite that crosses from one rendered text node into another is not placed either.
    const crossing = `${REWRITES[0][0]}\n\n${REWRITES[1][0]}`;
    const crossed = proposal(FIXTURE_TEXTS.rewriteBase, [[crossing, crossing, `${REWRITES[0][1]} ${REWRITES[1][1]}`]]);
    expect(markSitePage({ html, provenance, baseText: FIXTURE_TEXTS.rewriteBase, operations: crossed.operations, model: crossed.model })).toBeNull();
  });

  test('a list item change is placed inside its list item', async () => {
    const html = await mark('markup', MARKUP_BASE, [['green binder', 'green', 'blue']]);
    expect(html).toContain('Keep the <span class="cbr-c cbr-n1" id="c1"><del>green</del> <ins>blue</ins></span> binder by the door.');
  });

  test('hidden comments never appear, and a change that touches one falls back', async () => {
    const html = await mark('markup', MARKUP_BASE, [['ending stays', 'ending', 'end']]);
    const framed = await prepareSiteFrame({ html: `${html}<!-- HTML_HIDDEN_CANARY -->`, slug: 'markup/restore-notes', readAsset: async () => null });
    expect(framed).not.toContain('HIDDEN_CANARY');
    expect(framed).not.toContain('<!--');
    expect(await mark('markup', MARKUP_BASE, [['HTML_HIDDEN_CANARY', 'HTML_HIDDEN_CANARY', 'NEW']])).toBeNull();
  });
});

describe('making the built page safe for the frame', () => {
  test('scripts, handlers, frames and forms are stripped; links are inert; only the site’s own assets are inlined', async () => {
    const marked = await mark('markup', MARKUP_BASE, [['ending stays', 'ending', 'end']]);
    expect(marked).toContain('<script');
    const reads = [];
    const framed = await prepareSiteFrame({ html: marked, slug: 'markup/restore-notes', colorScheme: 'dark', readAsset: async (relative) => {
      reads.push(relative);
      if (relative === 'index.css') return Buffer.from('body{color:red}</style><script>x</script>');
      if (relative === '_attachments/diagram.svg') return Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
      return null;
    } });
    expect(reads.sort()).toEqual(['_attachments/diagram.svg', 'index.css']);
    // An inlined stylesheet cannot close its own style element.
    expect(framed.match(/<\/style>/gu).length).toBe(framed.match(/<style>/gu).length);
    const markup = framed.replace(/<style>[\s\S]*?<\/style>/gu, '');
    expect(markup).not.toMatch(/<(script|iframe|object|embed|base|link|form|template|noscript)\b/iu);
    expect(framed).not.toMatch(/<[a-z][^>]*\son[a-z]+\s*=/iu);
    expect(framed).not.toMatch(/\s(href|srcset|target|action|formaction)=/iu);
    expect(framed).not.toContain('evil.example');
    expect(framed).not.toContain('HOSTILE_SCRIPT');
    expect(framed).toContain('<style>body{color:red}<\\/style><script>x</script></style>');
    expect(framed).toContain('src="data:image/svg+xml;base64,');
    expect(framed).not.toContain('src="x"');
    expect(framed).toContain('saved-theme="dark"');
    expect(framed).toContain('Read more');
    expect(framed).toContain('<span class="cbr-c cbr-n1" id="c1">');
  });

  test('the site’s own fonts are inlined from its stylesheet; other addresses and marked furniture are not', async () => {
    const html = '<html><head><link rel="stylesheet" href="../index.css"></head><body><article>Text</article>'
      + '<nav class="tabs" data-cyberbaser-review="hide">Content Knowledge</nav></body></html>';
    const reads = [];
    const framed = await prepareSiteFrame({ html, slug: 'posts/one', readAsset: async (relative) => {
      reads.push(relative);
      if (relative === 'index.css') {
        return Buffer.from('@font-face{font-family:A;src:url(./static/fonts/a.woff2)format("woff2")}'
          + '@font-face{font-family:B;src:url("https://evil.example/b.woff2")}'
          + '@font-face{font-family:C;src:url(../../outside.woff2)}'
          + 'body{background:url(./static/bg.png)}');
      }
      if (relative === 'static/fonts/a.woff2') return Buffer.from('wOF2fake');
      return null;
    } });
    // Paths resolve inside the built site only; a missing file stays unresolved.
    expect(reads.sort()).toEqual(['index.css', 'outside.woff2', 'static/fonts/a.woff2']);
    expect(framed).toContain(`url(data:font/woff2;base64,${Buffer.from('wOF2fake').toString('base64')})`);
    expect(framed).toContain('url("https://evil.example/b.woff2")');
    expect(framed).not.toContain('Content Knowledge');
    expect(framed).toContain('<article>Text</article>');
  });

  test('the site frame policy allows inline styles and data images only, never scripts', () => {
    const directives = SITE_FRAME_CSP.split('; ');
    for (const directive of ["default-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'self'", 'img-src data:', 'font-src data:', 'sandbox']) {
      expect(directives).toContain(directive);
    }
    expect(SITE_FRAME_CSP).not.toMatch(/script-src|connect-src|https?:|'self' |\*/u);
  });
});

// ---------------------------------------------------------------------------
// The review page with a private site build on disk.

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

// The backup capture, moved to the site root the way `slug: index` moves the
// home page: same rendered page, provenance shifted past the frontmatter.
async function homeCapture() {
  const { html, provenance } = await fixture('backup');
  const shift = Buffer.byteLength(FIXTURE_TEXTS.homeSlug) - Buffer.byteLength(FIXTURE_TEXTS.backup);
  const move = (range) => (Array.isArray(range) ? range.map((value) => value + shift) : range);
  return { html, provenance: { ...provenance,
    source: { path: 'README.md', byteLength: Buffer.byteLength(FIXTURE_TEXTS.homeSlug), sha256: createHash('sha256').update(FIXTURE_TEXTS.homeSlug).digest('hex') },
    leaves: provenance.leaves.map((leaf) => ({ ...leaf, exact: move(leaf.exact), runs: leaf.runs.map((run) => ({ ...run, source: move(run.source) })) })) } };
}

async function siteRoot({ head = FIXTURE_TEXTS.revision, page = 'backup', withPage = true, dropLeaf = null, home = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'owner-alpha-review-site-'));
  roots.push(root);
  await writeFile(path.join(root, 'owner-alpha-site-manifest.json'), `${JSON.stringify({ schemaVersion: 1, artifactType: 'owner-alpha-site-manifest',
    generatedAt: '2026-11-22T00:00:00Z', source: { head }, renderer: { name: 'quartz-cyberbase' } })}\n`);
  await writeFile(path.join(root, 'index.css'), 'article{font-family:serif}');
  if (withPage) {
    const { html, provenance } = await fixture(page);
    await mkdir(path.join(root, 'curations/backups'), { recursive: true });
    await writeFile(path.join(root, 'curations/backups/testing-a-backup.html'), html);
    await writeFile(path.join(root, 'curations/backups/testing-a-backup.provenance.json'),
      JSON.stringify({ ...provenance, source: { ...provenance.source, path: 'curations/backups/testing-a-backup.md' },
        leaves: provenance.leaves.filter((leaf) => dropLeaf === null || !leaf.text.includes(dropLeaf)) }));
  }
  if (home) {
    const { html, provenance } = await homeCapture();
    await writeFile(path.join(root, 'index.html'), html);
    await writeFile(path.join(root, 'index.provenance.json'), JSON.stringify(provenance));
  }
  return root;
}

async function open(options) {
  const value = createProposalDocumentFixture(options);
  const handler = await value.handler();
  const host = new URL(value.ownerOrigin).host;
  const request = (route, cookie) => handler(new Request(value.ownerOrigin + route, { headers: { Host: host, ...(cookie ? { Cookie: cookie } : {}) } }));
  const login = await request(`/owner/bootstrap?token=${handler.bootstrapToken}`);
  const cookie = login.headers.get('set-cookie').split(';', 1)[0];
  const get = async (route) => { const response = await request(route, cookie); return { status: response.status, html: await response.text(), headers: response.headers }; };
  return {
    shell: (key) => get(`/owner/review/${value.cases.get(key).queueId}`),
    frame: (key) => get(`/owner/review/${value.cases.get(key).queueId}/page`),
    receipt: (key) => get(`/owner/decisions/${value.cases.get(key).queueId}`),
    decidedFrame: (key) => get(`/owner/decisions/${value.cases.get(key).queueId}/page`),
  };
}
const details = (html) => /<details class="rv-details"[^>]*>([\s\S]*?)<\/details>\s*<\/div>\s*<\/section>/u.exec(html)?.[1] ?? '';

describe('review page: the site’s own page when the private build matches', () => {
  test('head equal: the frame is the built page with the change marked, under the site frame policy', async () => {
    const { frame, shell } = await open({ port: 47811, reviewSiteRoot: await siteRoot() });
    const framed = await frame('one-word');
    expect(framed.status).toBe(200);
    expect(framed.headers.get('content-security-policy')).toBe(SITE_FRAME_CSP);
    expect(framed.html).toContain('<article class="popover-hint">');
    expect(framed.html).toContain('<span class="cbr-c cbr-n1" id="c1"><del>original</del> <ins>spare</ins></span>');
    expect(framed.html).toContain('<style>article{font-family:serif}</style>');
    expect(framed.html).not.toMatch(/<script\b/iu);
    const page = await shell('one-word');
    expect(page.html).toContain('data-anchors="1"');
    // The frame opens at the first change, so a phone shows it above the panel.
    expect(page.html).toMatch(/<iframe [^>]*src="\/owner\/review\/Q-[^"]+\/page#c1"/u);
    expect(details(page.html)).not.toContain('rv-site-note');
  });

  test('a note with a frontmatter slug of index is found at the site root, as the renderer addresses it', async () => {
    const { frame, shell } = await open({ port: 47821, reviewSiteRoot: await siteRoot({ home: true }) });
    const framed = await frame('home-slug');
    expect(framed.headers.get('content-security-policy')).toBe(SITE_FRAME_CSP);
    expect(framed.html).toContain('<span class="cbr-c cbr-n1" id="c1"><del>original</del> <ins>spare</ins></span>');
    expect(details((await shell('home-slug')).html)).not.toContain('rv-site-note');
  });

  test('the page address follows the renderer: frontmatter slug, else the path; a malformed slug is ignored', () => {
    expect(sitePageSlug('README.md', FIXTURE_TEXTS.homeSlug)).toBe('index');
    expect(sitePageSlug('notes/a.md', '---\nslug: /guides/Start here.md\n---\nBody\n')).toBe('guides/Start-here');
    expect(sitePageSlug('notes/a.md', '---\nslug: ../escape\n---\n')).toBe('notes/a');
    expect(sitePageSlug('notes/a.md', '---\nslug: 2024\n---\n')).toBe('notes/a');
    expect(sitePageSlug('notes/a.md', 'No frontmatter.\n')).toBe('notes/a');
    expect(sitePageSlug('../a.md', FIXTURE_TEXTS.homeSlug)).toBeNull();
  });

  test('a decided proposal stays on the site page, read-only, while the queue holds the page text', async () => {
    const { receipt, decidedFrame } = await open({ port: 47823, reviewSiteRoot: await siteRoot() });
    const framed = await decidedFrame('approved-with-page');
    expect(framed.headers.get('content-security-policy')).toBe(SITE_FRAME_CSP);
    expect(framed.html).toContain('<span class="cbr-c cbr-n1" id="c1"><del>original</del> <ins>spare</ins></span>');
    expect(framed.html).not.toMatch(/<(script|form|iframe)\b/iu);
    const shellPage = await receipt('approved-with-page');
    expect(shellPage.html).toMatch(/<iframe [^>]*sandbox=""[^>]*src="\/owner\/decisions\/Q-[^"]+\/page#c1"/u);
    expect(shellPage.html).toContain('Apply to page');
    // Without a matching build, the excerpt keeps whole words.
    const { decidedFrame: noSite } = await open({ port: 47825, reviewSiteRoot: await siteRoot({ head: 'b'.repeat(40) }) });
    const excerpt = await noSite('approved-split-word');
    expect(excerpt.headers.get('content-security-policy')).toBe(FRAME_CSP);
    expect(excerpt.html).toContain('Restore a small folder to the <del>original</del> <ins>offsite</ins> drive.');
  });
});

describe('the decided excerpt', () => {
  const op = (base, find, expected, replacement) => {
    const start = Buffer.from(base).indexOf(find);
    return { start, end: start + Buffer.byteLength(expected), expected, replacement };
  };
  test('marks whole words with the line around them, never a split word', () => {
    const base = '# Corporate\n\n- [ ] Create guide for Obsidian corporate use 🔺 ➕ 2024-10-30\n';
    const html = excerptDocument({ operations: [op(base, 'corporate use', 'corporat', 'enterpris')], title: 'Corporate', sourcePath: 'a/b.md', baseText: base });
    expect(html).toContain('<p>Create guide for Obsidian <del>corporate</del> <ins>enterprise</ins> use 🔺 ➕ 2024-10-30</p>');
    expect(html).not.toContain('<del>corporat</del>');
  });
  test('without the page text, only the exact characters, said plainly; hidden content stays masked', () => {
    const base = 'One %% SECRET_CANARY %% line with words.\n';
    const html = excerptDocument({ operations: [op(base, 'words', 'words', 'terms')], title: 'T', sourcePath: 'a.md' });
    expect(html).toContain('only the exact characters are shown');
    const masked = excerptDocument({ operations: [op(base, 'words', 'words', 'terms'), op(base, 'SECRET_CANARY', 'SECRET_CANARY', 'X')], title: 'T', sourcePath: 'a.md', baseText: base });
    expect(masked).not.toContain('CANARY');
    expect(masked.match(/Hidden content/gu)).toHaveLength(1);
  });

  test('head different: the simplified rendering, with the reason in Details', async () => {
    const { frame, shell } = await open({ port: 47813, reviewSiteRoot: await siteRoot({ head: 'b'.repeat(40) }) });
    const framed = await frame('one-word');
    expect(framed.headers.get('content-security-policy')).toBe(FRAME_CSP);
    expect(framed.html).not.toContain('popover-hint');
    expect(details((await shell('one-word')).html)).toContain(SITE_REVIEW_REASONS.changed);
  });

  test('no build, or the note missing from it: the simplified rendering, with the reason', async () => {
    for (const root of [path.join(os.tmpdir(), 'owner-alpha-no-such-site'), await siteRoot({ withPage: false })]) {
      const { frame, shell } = await open({ port: 47815, reviewSiteRoot: root });
      expect((await frame('one-word')).headers.get('content-security-policy')).toBe(FRAME_CSP);
      expect(details((await shell('one-word')).html)).toContain('your site’s page for this note isn’t available');
    }
  });

  test('a change the site page cannot place: the whole page is simplified and says why', async () => {
    // The build has no provenance for the changed sentence.
    const { frame, shell } = await open({ port: 47817, reviewSiteRoot: await siteRoot({ dropLeaf: 'original drive' }) });
    const framed = await frame('one-word');
    expect(framed.headers.get('content-security-policy')).toBe(FRAME_CSP);
    expect(framed.html).not.toContain('popover-hint');
    expect(details((await shell('one-word')).html)).toContain('this change can’t be placed on your site’s page');
    // A note rendered from other bytes than the proposal's base is not used.
    expect(details((await shell('link-destination')).html)).toContain('your site’s page for this note isn’t available');
  });

  test('the loader refuses a build whose page was rendered from other bytes', async () => {
    const root = await siteRoot();
    expect((await loadSitePage({ siteRoot: root, sourcePath: 'curations/backups/testing-a-backup.md', revision: FIXTURE_TEXTS.revision, baseText: FIXTURE_TEXTS.backup })).html).toBeString();
    expect((await loadSitePage({ siteRoot: root, sourcePath: 'curations/backups/testing-a-backup.md', revision: FIXTURE_TEXTS.revision, baseText: `${FIXTURE_TEXTS.backup} ` })).reason).toBe('unavailable');
    expect(quartzSlug('📁 03 - Curations, Stacks/MFA & methods.md')).toBe('📁-03---Curations,-Stacks/MFA--and--methods');
    expect(quartzSlug('../escape.md')).toBeNull();
  });
});

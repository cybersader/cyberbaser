// The proposal shown on the owner's own site page. When the owner-private
// Quartz build was made from exactly the proposal's pinned base, take that
// note's built HTML and mark each change where its source bytes were rendered,
// using the build's source provenance. Anything that cannot be placed exactly
// sends the whole page back to the simplified rendering, with a plain reason.
// Reads only the private build. No network, no build, no vault reads.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { parseFrontmatter } from '@cyberbaser/publish';
import { escapeHtml, REWRITE_THRESHOLD, wholeWordChange } from './proposal-review-page.js';
import { hasHiddenProposalSource, refineForDisplay } from './publication-display.js';

export const SITE_REVIEW_REASONS = Object.freeze({
  unavailable: 'Shown simplified: your site’s page for this note isn’t available.',
  changed: 'Your site has changed since this was proposed, so this is shown simplified.',
  unplaceable: 'Shown simplified: this change can’t be placed on your site’s page.',
});

// The site page in the frame: its own inlined stylesheets and images only.
export const SITE_FRAME_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
  'img-src data:',
  'font-src data:',
  "style-src 'unsafe-inline'",
  'sandbox',
].join('; ');

const MANIFEST = 'owner-alpha-site-manifest.json';
const LIMITS = Object.freeze({ manifest: 1024 * 1024, page: 4 * 1024 * 1024, provenance: 5 * 1024 * 1024,
  stylesheet: 2 * 1024 * 1024, image: 2 * 1024 * 1024, images: 8 * 1024 * 1024, font: 1024 * 1024, fonts: 4 * 1024 * 1024 });
const FONT_TYPES = Object.freeze({ '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf' });
const IMAGE_TYPES = Object.freeze({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' });
const COMMIT_RE = /^[0-9a-f]{40}$/u;

// ---------------------------------------------------------------------------
// Reading the private build.

async function readContained(root, relative, maxBytes) {
  const realRoot = await realpath(root);
  const absolute = path.resolve(realRoot, relative);
  const inside = path.relative(realRoot, absolute);
  if (inside === '' || inside.startsWith('..') || path.isAbsolute(inside)) return null;
  let resolved;
  try { resolved = await realpath(absolute); } catch { return null; }
  // No symlink anywhere on the way: the real path is the requested path.
  if (resolved !== absolute) return null;
  let handle;
  try {
    handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) return null;
    const bytes = await handle.readFile();
    return bytes.length === info.size ? bytes : null;
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

/** Quartz 4.5.2 slugifyFilePath for a Markdown source path; null when unsafe. */
export function quartzSlug(sourcePath) {
  if (typeof sourcePath !== 'string' || !/\.md$/iu.test(sourcePath) || /[\\\0]/u.test(sourcePath)) return null;
  const segments = sourcePath.replace(/\.md$/iu, '').split('/');
  if (segments.some((part) => part === '' || part === '.' || part === '..')) return null;
  const slug = segments.map((part) => part.replace(/\s/gu, '-').replace(/&/gu, '-and-').replace(/%/gu, '-percent')
    .replace(/\?/gu, '').replace(/#/gu, '')).join('/').replace(/_index$/u, 'index');
  return slug.split('/').some((part) => part === '' || part === '.' || part === '..') ? null : slug;
}

/**
 * The built page for a note, addressed the way the renderer addresses it: a
 * plain frontmatter `slug:` moves the page (`slug: index` is the site's home
 * page), otherwise the page follows its path. Same rules as the renderer's
 * FrontmatterSlug and the projection's slugTarget. Reads only the pinned base
 * text; the page's provenance must still name this path and these bytes.
 */
export function sitePageSlug(sourcePath, baseText) {
  const own = quartzSlug(sourcePath);
  if (own === null || typeof baseText !== 'string') return own;
  const slug = parseFrontmatter(baseText).data?.slug;
  if (typeof slug !== 'string') return own;
  const target = slug.trim().replace(/^\/+|\/+$/gu, '').replace(/\.(md|html)$/iu, '');
  if (target === '' || target.includes('\\') || /[\u0000-\u001F\u007F]/u.test(target)) return own;
  if (target.split('/').some((part) => part === '' || part === '.' || part === '..' || part.trim() !== part)) return own;
  return quartzSlug(`${target}.md`);
}

async function readManifest(siteRoot) {
  const bytes = await readContained(siteRoot, MANIFEST, LIMITS.manifest);
  if (bytes === null) return null;
  try {
    const value = JSON.parse(bytes.toString('utf8'));
    if (value?.artifactType !== 'owner-alpha-site-manifest' || value.schemaVersion !== 1
      || value.renderer?.name !== 'quartz-cyberbase' || !COMMIT_RE.test(value.source?.head ?? '')) return null;
    return { head: value.source.head, generatedAt: String(value.generatedAt), digest: createHash('sha256').update(bytes).digest('hex') };
  } catch {
    return null;
  }
}

function validProvenance(value, sourcePath, baseBytes) {
  return value?.schema === 'cyberbaser.source-provenance' && value.version === 2
    && value.source?.path === sourcePath && value.source.byteLength === baseBytes.length
    && value.source.sha256 === createHash('sha256').update(baseBytes).digest('hex')
    && Array.isArray(value.leaves) && value.leaves.length > 0;
}

/**
 * The note's built page and provenance, only when the private build was made
 * from the pinned base and rendered exactly these base bytes.
 */
export async function loadSitePage({ siteRoot, sourcePath, revision, baseText }) {
  if (typeof siteRoot !== 'string' || typeof baseText !== 'string') return { reason: 'unavailable' };
  const before = await readManifest(siteRoot);
  if (before === null) return { reason: 'unavailable' };
  if (before.head !== revision) return { reason: 'changed' };
  const slug = sitePageSlug(sourcePath, baseText);
  if (slug === null) return { reason: 'unavailable' };
  const [page, sidecar] = await Promise.all([
    readContained(siteRoot, `${slug}.html`, LIMITS.page),
    readContained(siteRoot, `${slug}.provenance.json`, LIMITS.provenance),
  ]);
  if (page === null || sidecar === null) return { reason: 'unavailable' };
  let provenance;
  try { provenance = JSON.parse(sidecar.toString('utf8')); } catch { return { reason: 'unavailable' }; }
  if (!validProvenance(provenance, sourcePath, Buffer.from(baseText, 'utf8'))) return { reason: 'unavailable' };
  // The page and its provenance came from one published build.
  const after = await readManifest(siteRoot);
  if (after === null || after.digest !== before.digest) return { reason: 'unavailable' };
  let html;
  try { html = new TextDecoder('utf-8', { fatal: true }).decode(page); } catch { return { reason: 'unavailable' }; }
  return { html, provenance, slug };
}

// ---------------------------------------------------------------------------
// A small reader for the serializer-normalized HTML Quartz writes. It locates
// text nodes the way the browser's childNodes does; it does not sanitize.

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript']);
const ATTRIBUTE = /\s*([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/uy;

function tokenize(html) {
  const tokens = [];
  let at = 0;
  while (at < html.length) {
    if (html.startsWith('<!--', at)) {
      const close = html.indexOf('-->', at + 4);
      const end = close < 0 ? html.length : close + 3;
      tokens.push({ type: 'comment', start: at, end });
      at = end;
    } else if (html[at] === '<' && (html[at + 1] === '!' || html[at + 1] === '?')) {
      const close = html.indexOf('>', at);
      const end = close < 0 ? html.length : close + 1;
      tokens.push({ type: 'doctype', start: at, end });
      at = end;
    } else if (html[at] === '<' && html[at + 1] === '/' && /[A-Za-z]/u.test(html[at + 2] ?? '')) {
      const match = /^<\/([A-Za-z][^\s/>]*)[^>]*>/u.exec(html.slice(at, at + 256));
      if (!match) throw new Error('unreadable close tag');
      tokens.push({ type: 'close', tag: match[1].toLowerCase(), start: at, end: at + match[0].length });
      at += match[0].length;
    } else if (html[at] === '<' && /[A-Za-z]/u.test(html[at + 1] ?? '')) {
      const name = /^<([A-Za-z][^\s/>]*)/u.exec(html.slice(at, at + 128));
      const tag = name[1].toLowerCase();
      let cursor = at + name[0].length;
      const attributes = new Map();
      for (;;) {
        const rest = /^\s*(\/?)>/u.exec(html.slice(cursor, cursor + 64));
        if (rest) { cursor += rest[0].length; break; }
        ATTRIBUTE.lastIndex = cursor;
        const attribute = ATTRIBUTE.exec(html);
        if (!attribute || attribute[0].length === 0) throw new Error('unreadable attribute');
        attributes.set(attribute[1].toLowerCase(), attribute[2] ?? attribute[3] ?? attribute[4] ?? '');
        cursor = ATTRIBUTE.lastIndex;
      }
      const selfClosing = html[cursor - 2] === '/';
      tokens.push({ type: 'open', tag, attributes, start: at, end: cursor, selfClosing });
      at = cursor;
      if (RAW.has(tag) && !selfClosing) {
        const close = html.toLowerCase().indexOf(`</${tag}`, at);
        const end = close < 0 ? html.length : close;
        if (end > at) tokens.push({ type: 'raw', start: at, end });
        at = end;
      }
    } else {
      let end = html.indexOf('<', at + 1);
      while (end >= 0 && !/[A-Za-z!/?]/u.test(html[end + 1] ?? '')) end = html.indexOf('<', end + 1);
      if (end < 0) end = html.length;
      const previous = tokens.at(-1);
      if (previous?.type === 'text' && previous.end === at) previous.end = end;
      else tokens.push({ type: 'text', start: at, end });
      at = end;
    }
  }
  return tokens;
}

function buildTree(html) {
  const root = { tag: '#root', children: [], parent: null };
  const stack = [root];
  for (const token of tokenize(html)) {
    const top = stack.at(-1);
    if (token.type === 'open') {
      const node = { tag: token.tag, open: token, close: null, children: [], parent: top };
      top.children.push(node);
      if (!token.selfClosing && !VOID.has(token.tag)) stack.push(node);
    } else if (token.type === 'close') {
      const index = stack.findLastIndex((node) => node.tag === token.tag);
      if (index > 0) { stack[index].close = token; stack.length = index; }
    } else if (token.type !== 'doctype') {
      top.children.push({ tag: `#${token.type}`, token, parent: top });
    }
  }
  return root;
}

const ENTITIES = Object.freeze({ amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ' });
function decodeText(raw) {
  let unknown = false;
  const text = raw.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/giu, (whole, name) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
      try { return String.fromCodePoint(code); } catch { unknown = true; return whole; }
    }
    if (Object.hasOwn(ENTITIES, name)) return ENTITIES[name];
    unknown = true;
    return whole;
  });
  return unknown ? null : text;
}

function* elements(node) {
  for (const child of node.children ?? []) {
    if (!child.tag.startsWith('#')) { yield child; yield* elements(child); }
  }
}

// ---------------------------------------------------------------------------
// Placing each exact change at whole words.

// New text that the site would render as something other than itself (markup,
// links, math, tags, entities, new blocks) cannot be shown as plain words.
const MARKDOWN = /[\\`*_[\]<>#|~$]|==|%%|&[#\w]+;|https?:\/\/|www\.|\n[^\S\n]*\n|\n[^\S\n]*(?:[-+*>]|\d+[.)])\s|^\s*(?:[-+*>]|\d+[.)])\s|\r/iu;

function wordSpan(baseText, operation) {
  const base = Buffer.from(baseText, 'utf8');
  if (base.subarray(operation.start, operation.end).toString('utf8') !== operation.oldText) return false;
  const change = wholeWordChange(Array.from(base.subarray(0, operation.start).toString('utf8')), Array.from(operation.oldText),
    Array.from(operation.replacementText), Array.from(base.subarray(operation.end).toString('utf8')));
  if (change === null) return null;
  const start = Buffer.byteLength(change.lead.join(''), 'utf8');
  return { start, end: start + Buffer.byteLength(change.oldText, 'utf8'), oldText: change.oldText, newText: change.newText };
}

function locate(leaves, base, span) {
  const found = [];
  for (const leaf of leaves) {
    for (const run of leaf.runs ?? []) {
      if (run.kind !== 'exact' || !Array.isArray(run.source) || !Array.isArray(run.rendered)) continue;
      const [sourceStart, sourceEnd] = run.source;
      const inside = span.start === span.end
        ? sourceStart <= span.start && span.start <= sourceEnd
        : sourceStart <= span.start && span.end <= sourceEnd;
      if (inside) found.push({ leaf, run });
    }
  }
  if (found.length !== 1) return null;
  const [{ leaf, run }] = found;
  const [renderedStart, renderedEnd] = run.rendered;
  const runText = base.subarray(run.source[0], run.source[1]).toString('utf8');
  if (typeof leaf.text !== 'string' || leaf.text.slice(renderedStart, renderedEnd) !== runText) return null;
  const from = renderedStart + base.subarray(run.source[0], span.start).toString('utf8').length;
  const to = from + base.subarray(span.start, span.end).toString('utf8').length;
  if (leaf.text.slice(from, to) !== span.oldText) return null;
  return { leaf, from, to, inexact: false };
}

// A rewrite of a whole paragraph usually crosses characters the site renders
// differently from their source (curly quotes, dashes). Its location is still
// exact when every source byte of the change lies in one rendered text node,
// in runs that follow each other without gaps, and both ends fall in exactly
// mapped runs. Such a change can only be shown folded as Rewritten, never as
// word marks, because the old text on the page differs from the source.
function locateSpanning(leaves, base, span) {
  if (span.start === span.end) return null;
  const touching = [];
  for (const leaf of leaves) {
    for (const run of leaf.runs ?? []) {
      if (Array.isArray(run.source) && run.source[0] < span.end && run.source[1] > span.start) touching.push({ leaf, run });
    }
  }
  if (touching.length === 0 || touching.some((item) => item.leaf !== touching[0].leaf)) return null;
  const { leaf } = touching[0];
  if (typeof leaf.text !== 'string') return null;
  const indexes = touching.map((item) => leaf.runs.indexOf(item.run));
  const first = Math.min(...indexes); const last = Math.max(...indexes);
  for (let index = first; index <= last; index += 1) {
    const run = leaf.runs[index];
    if (!Array.isArray(run.source) || !Array.isArray(run.rendered) || !['exact', 'atom'].includes(run.kind)) return null;
    if (index > first && (run.source[0] !== leaf.runs[index - 1].source[1] || run.rendered[0] !== leaf.runs[index - 1].rendered[1])) return null;
    if (run.kind === 'exact' && leaf.text.slice(run.rendered[0], run.rendered[1]) !== base.subarray(run.source[0], run.source[1]).toString('utf8')) return null;
  }
  const head = leaf.runs[first]; const tail = leaf.runs[last];
  if (head.source[0] > span.start || tail.source[1] < span.end) return null;
  if ((head.kind !== 'exact' && head.source[0] !== span.start) || (tail.kind !== 'exact' && tail.source[1] !== span.end)) return null;
  const from = head.rendered[0] + base.subarray(head.source[0], span.start).toString('utf8').length;
  const to = tail.rendered[1] - base.subarray(span.end, tail.source[1]).toString('utf8').length;
  return from <= to ? { leaf, from, to, inexact: true } : null;
}

const BLOCKS = new Set(['p', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'td', 'th', 'dd', 'dt', 'figcaption', 'pre']);
const INSIDE_BLOCKS = new Set(['li', 'td', 'th', 'dd', 'dt']);

function marked(tag, text) {
  const [, lead, words, trail] = /^(\s*)([\s\S]*?)(\s*)$/u.exec(text);
  return words === '' ? escapeHtml(text) : `${escapeHtml(lead)}<${tag}>${escapeHtml(words)}</${tag}>${escapeHtml(trail)}`;
}

function changeHtml(placement) {
  const { number, first, span, rewritten } = placement;
  const open = `<span class="cbr-c cbr-n${number}"${first ? ` id="c${number}"` : ''}>`;
  if (rewritten) return `${open}<span class="cbr-new">${escapeHtml(span.newText)}</span></span>`;
  const removed = span.oldText === '' ? '' : marked('del', span.oldText);
  const added = span.newText === '' ? '' : marked('ins', span.newText);
  const gap = removed && added && !/\s$/u.test(span.oldText) && !/^\s/u.test(span.newText) ? ' ' : '';
  return `${open}${removed}${gap}${added}</span>`;
}

function textOf(node, html) {
  if (node.tag === '#text') return decodeText(html.slice(node.token.start, node.token.end)) ?? '';
  if (node.tag.startsWith('#')) return '';
  return node.children.map((child) => textOf(child, html)).join('');
}

// The same fold the simplified page uses: enough words on both sides, and
// most of them changed. Display only.
function rewritten(before, after) {
  const a = before.match(/\S+/gu) ?? []; const b = after.match(/\S+/gu) ?? [];
  if (a.length < REWRITE_THRESHOLD.minimumWords || b.length < REWRITE_THRESHOLD.minimumWords || a.length * b.length > 250_000) return false;
  const width = b.length + 1; const grid = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) for (let j = b.length - 1; j >= 0; j -= 1) {
    grid[i * width + j] = a[i] === b[j] ? grid[(i + 1) * width + j + 1] + 1 : Math.max(grid[(i + 1) * width + j], grid[i * width + j + 1]);
  }
  return 1 - (2 * grid[0]) / (a.length + b.length) >= REWRITE_THRESHOLD.changedShare;
}

// Highlight every part of the change the panel points at, and the first
// change before any navigation. Generated from change numbers only.
function highlightStyle(numbers, first) {
  const ring = '{box-shadow:0 0 0 2px var(--cbr-acc)}';
  const target = (scope, number) => `${scope} .cbr-n${number} :is(ins,del),${scope} .cbr-rw:has(.cbr-n${number})${ring}`;
  const rules = numbers.map((number) => target(`body:has(#c${number}:target)`, number));
  if (first !== undefined) rules.push(target('body:not(:has(.cbr-c:target))', first));
  return `<style>${rules.join('')}</style>`;
}

/**
 * Mark every change on the built page, or return null when any change cannot
 * be placed exactly. Pure: no I/O. A change that spans several lines is shown
 * line by line (display only; its exact bytes are unchanged).
 */
export function markSitePage({ html, provenance, baseText, operations, model }) {
  if (!model?.pageAvailable || model.coarse || model.properties.length > 0 || model.blocked) return null;
  if (model.body.length !== operations.length) return null;
  if (model.body.some((change) => change.kind !== 'visible' || change.hidden)) return null;
  let tree;
  try { tree = buildTree(html); } catch { return null; }
  const article = [...elements(tree)].find((node) => node.tag === 'article'
    && (node.open.attributes.get('class') ?? '').split(/\s+/u).includes('popover-hint'));
  const head = [...elements(tree)].find((node) => node.tag === 'head');
  if (!article?.close || !head?.close) return null;
  const byId = new Map();
  for (const node of elements(article)) {
    const id = node.open.attributes.get('data-cb-node');
    if (id === undefined) continue;
    if (byId.has(id)) return null;
    byId.set(id, node);
  }
  const base = Buffer.from(baseText, 'utf8');
  const placements = [];
  for (let index = 0; index < operations.length; index += 1) {
    const { number } = model.body[index];
    const refined = refineForDisplay(operations[index]);
    if (refined.coarseReason !== null) return null;
    let first = true;
    for (const part of refined.operations) {
      const span = wordSpan(baseText, part);
      if (span === false) return null;
      if (span === null) continue;
      if (MARKDOWN.test(span.newText) || hasHiddenProposalSource(span.oldText + span.newText)) return null;
      const located = locate(provenance.leaves, base, span) ?? locateSpanning(provenance.leaves, base, span);
      if (located === null) return null;
      const parent = located.leaf.parent === '$body' ? article : byId.get(located.leaf.parent);
      const node = parent?.children[located.leaf.child];
      if (node?.tag !== '#text' || decodeText(html.slice(node.token.start, node.token.end)) !== located.leaf.text) return null;
      let block = node.parent;
      while (block && block !== article && !BLOCKS.has(block.tag)) block = block.parent;
      placements.push({ number, first, span, node, block, from: located.from, to: located.to, leaf: located.leaf, inexact: located.inexact });
      first = false;
    }
    if (first) return null;
  }
  // One text node may carry several changes; they must not overlap. A text
  // node changed through most of its words folds as rewritten.
  const byNode = new Map();
  for (const placement of placements) byNode.set(placement.node, [...(byNode.get(placement.node) ?? []), placement]);
  const edits = [];
  const folded = new Set();
  for (const [node, list] of byNode) {
    list.sort((a, b) => a.from - b.from || a.to - b.to);
    if (list.some((item, i) => i > 0 && item.from < list[i - 1].to)) return null;
    const text = list[0].leaf.text;
    let after = ''; let cursor = 0;
    for (const item of list) { after += text.slice(cursor, item.from) + item.span.newText; cursor = item.to; }
    after += text.slice(cursor);
    const block = list[0].block;
    const fold = rewritten(text, after) && block && block !== article && block.close;
    // A change located across differently rendered characters is shown only as a rewrite.
    if (!fold && list.some((item) => item.inexact)) return null;
    if (fold) folded.add(block);
    let out = ''; cursor = 0;
    for (const item of list) { out += escapeHtml(text.slice(cursor, item.from)) + changeHtml({ ...item, rewritten: Boolean(fold) }); cursor = item.to; }
    edits.push({ start: node.token.start, end: node.token.end, text: out + escapeHtml(text.slice(cursor)) });
  }
  // A rewritten block keeps the site's own block, labelled, with the old text a tap away.
  for (const block of folded) {
    const was = `<details class="cbr-old"><summary>Show what it said before</summary><div class="cbr-was">${escapeHtml(textOf(block, html).trim())}</div></details>`;
    if (INSIDE_BLOCKS.has(block.tag)) {
      edits.push({ start: block.open.end, end: block.open.end, text: '<span class="cbr-tag">Rewritten</span>' });
      edits.push({ start: block.close.start, end: block.close.start, text: was });
    } else {
      edits.push({ start: block.open.start, end: block.open.start, text: '<div class="cbr-rw"><span class="cbr-tag">Rewritten</span>' });
      edits.push({ start: block.close.end, end: block.close.end, text: `${was}</div>` });
    }
  }
  edits.push({ start: head.close.start, end: head.close.start, text: highlightStyle(model.body.map((change) => change.number), model.anchors[0]) });
  edits.sort((a, b) => b.start - a.start || b.end - a.end);
  let result = html;
  for (const edit of edits) result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  return result;
}

// ---------------------------------------------------------------------------
// Making the built page safe to show: no scripts, no handlers, inert links,
// only the site's own stylesheets and images, inlined.

const REVIEW_STYLE = `
.search,.darkmode,.readermode,.explorer,.graph,.global-graph-outer,.edit-this-page,.note-actions,[class*="suggest-"],.mobile-explorer{display:none!important}
a{cursor:default}
:root{--cbr-acc:#0b6b4b;--cbr-ins-bg:#d9f0e2;--cbr-ins:#0c4a33;--cbr-del-bg:#f6dedb;--cbr-del:#8a2c22;--cbr-soft:#55605a}
:root[saved-theme="dark"]{--cbr-acc:#7fd1a8;--cbr-ins-bg:#2f4a3b;--cbr-ins:#c6edd6;--cbr-del-bg:#4a2c28;--cbr-del:#f3c0b8;--cbr-soft:#a8b5ad}
ins{text-decoration:underline;text-decoration-thickness:2px;text-underline-offset:3px;background:var(--cbr-ins-bg);color:var(--cbr-ins);border-radius:2px;padding:0 1px}
del{text-decoration:line-through;background:var(--cbr-del-bg);color:var(--cbr-del);border-radius:2px;padding:0 1px}
.cbr-c{scroll-margin-top:28vh;border-radius:3px}
.cbr-rw{border-left:3px solid var(--cbr-acc);padding:2px 0 2px 12px;margin:0 0 1em;border-radius:4px}
.cbr-rw>:is(p,h1,h2,h3,h4,h5,h6,blockquote,pre){margin-top:0}
.cbr-tag{display:block;font-size:.72rem;font-weight:700;letter-spacing:.02em;color:var(--cbr-acc);margin:2px 0}
.cbr-old summary{font-size:.8rem;font-weight:600;color:var(--cbr-acc);cursor:pointer;padding:6px 0;list-style:none}
.cbr-old summary::-webkit-details-marker{display:none}
.cbr-was{color:var(--cbr-soft);text-decoration:line-through;text-decoration-color:var(--cbr-del)}
@media (prefers-reduced-motion:no-preference){html{scroll-behavior:smooth}}
`;

// `data-cyberbaser-review="hide"` lets a renderer mark site furniture (a fixed
// phone tab bar, for example) that has no place in the review frame.
const REMOVED = ['script', 'noscript', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'base', 'portal', 'meta[http-equiv]', 'template',
  '[data-cyberbaser-review="hide"]'];
const URL_ATTRIBUTES = new Set(['href', 'src', 'srcset', 'srcdoc', 'action', 'formaction', 'ping', 'poster', 'background', 'data',
  'xlink:href', 'manifest', 'codebase', 'cite', 'longdesc', 'target', 'download', 'lowsrc', 'dynsrc', 'archive', 'usemap']);

function siteRelative(pageSlug, reference) {
  if (typeof reference !== 'string' || reference === '' || /^[a-z][a-z0-9+.-]*:|^\/\//iu.test(reference)) return null;
  let resolved;
  try { resolved = new URL(reference, `http://site.invalid/${pageSlug}`); } catch { return null; }
  if (resolved.origin !== 'http://site.invalid') return null;
  let relative;
  try { relative = decodeURIComponent(resolved.pathname).replace(/^\/+/u, ''); } catch { return null; }
  if (relative === '' || relative.split('/').some((part) => part === '' || part === '.' || part === '..') || /[\\\0]/u.test(relative)) return null;
  return relative;
}

function collect(html) {
  const sheets = []; const images = [];
  new HTMLRewriter()
    .on('link', { element(element) {
      if ((element.getAttribute('rel') ?? '').toLowerCase().split(/\s+/u).includes('stylesheet')) sheets.push(element.getAttribute('href'));
    } })
    .on('img', { element(element) { images.push(element.getAttribute('src')); } })
    .transform(html);
  return { sheets, images };
}

/** Strip and inline. `readAsset(relative, maxBytes)` reads one private-site file. */
export async function prepareSiteFrame({ html, slug, readAsset, colorScheme = 'light' }) {
  const { sheets, images } = collect(html);
  const css = new Map();
  for (const href of sheets) {
    const relative = siteRelative(slug, href);
    if (relative === null || css.has(href) || !relative.endsWith('.css')) continue;
    const bytes = await readAsset(relative, LIMITS.stylesheet);
    if (bytes !== null) css.set(href, { relative, text: bytes.toString('utf8') });
  }
  // The site's own fonts, inlined: the frame may load nothing by address.
  const fonts = new Map(); let fontTotal = 0;
  for (const [href, sheet] of css) {
    let text = sheet.text;
    for (const match of new Set(sheet.text.match(/url\(\s*(['"]?)[^'")]+\1\s*\)/giu) ?? [])) {
      const reference = match.replace(/^url\(\s*(['"]?)/iu, '').replace(/(['"]?)\s*\)$/u, '');
      const relative = siteRelative(sheet.relative, reference);
      const type = relative === null ? undefined : FONT_TYPES[path.extname(relative).toLowerCase()];
      if (type === undefined) continue;
      if (!fonts.has(relative)) {
        const bytes = await readAsset(relative, LIMITS.font);
        if (bytes === null || fontTotal + bytes.length > LIMITS.fonts) { fonts.set(relative, null); continue; }
        fontTotal += bytes.length;
        fonts.set(relative, `data:${type};base64,${bytes.toString('base64')}`);
      }
      const uri = fonts.get(relative);
      if (uri !== null) text = text.split(match).join(`url(${uri})`);
    }
    css.set(href, text.replace(/<\/(style)/giu, '<\\/$1'));
  }
  const data = new Map(); let total = 0;
  for (const src of images) {
    const relative = siteRelative(slug, src);
    const type = relative === null ? undefined : IMAGE_TYPES[path.extname(relative).toLowerCase()];
    if (type === undefined || data.has(src)) continue;
    const bytes = await readAsset(relative, LIMITS.image);
    if (bytes === null || total + bytes.length > LIMITS.images) continue;
    total += bytes.length;
    data.set(src, `data:${type};base64,${bytes.toString('base64')}`);
  }
  let rewriter = new HTMLRewriter()
    .onDocument({ comments(comment) { comment.remove(); } })
    .on('html', { element(element) {
      if (colorScheme === 'dark' || colorScheme === 'light') element.setAttribute('saved-theme', colorScheme);
    } })
    .on('head', { element(element) {
      element.prepend('<meta charset="utf-8"><meta name="referrer" content="no-referrer">', { html: true });
      element.append(`<style>${REVIEW_STYLE}</style>`, { html: true });
    } })
    .on('meta[charset]', { element(element) { element.remove(); } })
    .on('link', { element(element) {
      const href = element.getAttribute('href');
      if (css.has(href) && (element.getAttribute('rel') ?? '').toLowerCase().split(/\s+/u).includes('stylesheet')) {
        element.replace(`<style>${css.get(href)}</style>`, { html: true });
      } else element.remove();
    } })
    .on('form', { element(element) { element.removeAndKeepContent(); } })
    .on('*', { element(element) {
      const isImage = element.tagName === 'img';
      const src = isImage ? element.getAttribute('src') : null;
      for (const [name] of [...element.attributes]) {
        const lower = name.toLowerCase();
        if (lower.startsWith('on') || URL_ATTRIBUTES.has(lower) || lower === 'http-equiv'
          || (lower === 'style' && /url\s*\(|expression\s*\(|@import/iu.test(element.getAttribute(name) ?? ''))) element.removeAttribute(name);
      }
      if (isImage && data.has(src)) element.setAttribute('src', data.get(src));
    } });
  for (const selector of REMOVED) rewriter = rewriter.on(selector, { element(element) { element.remove(); } });
  return rewriter.transform(html);
}

/**
 * The whole decision: the site page with its changes, or the reason the
 * simplified rendering is shown instead. Never throws.
 */
export async function siteReviewFrame({ siteRoot, sourcePath, revision, document, operations, model, colorScheme }) {
  try {
    if (!document || document.reason !== null || typeof document.baseText !== 'string') return { html: null, reason: 'unavailable' };
    const loaded = await loadSitePage({ siteRoot, sourcePath, revision, baseText: document.baseText });
    if (loaded.reason) return { html: null, reason: loaded.reason };
    const page = markSitePage({ html: loaded.html, provenance: loaded.provenance, baseText: document.baseText, operations, model });
    if (page === null) return { html: null, reason: 'unplaceable' };
    const html = await prepareSiteFrame({ html: page, slug: loaded.slug, colorScheme,
      readAsset: (relative, maxBytes) => readContained(siteRoot, relative, maxBytes) });
    return { html, reason: null };
  } catch {
    return { html: null, reason: 'unavailable' };
  }
}

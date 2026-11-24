// The owner's proposal review, shaped like the approved phone prototype:
// the note as the site shows it, inside a locked frame on its own route, and
// Cyberbaser's private panel beside or below it. Pure presentation: nothing
// here reads files, records decisions, or changes what a decision does.
import { Buffer } from 'node:buffer';
import { hasHiddenProposalSource } from './publication-display.js';

export const REWRITE_THRESHOLD = Object.freeze({ minimumWords: 12, changedShare: 0.6 });

const PROPERTIES_REFUSAL = 'It changes the page’s properties (the settings at the top of the note). '
  + 'Cyberbaser can’t put property changes on the page yet, so it can’t be approved here. '
  + 'You can reject it, or make the change yourself.';

export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function reviewIcon(name) {
  const paths = {
    previous: '<path d="m14 6-6 6 6 6"/>',
    next: '<path d="m10 6 6 6-6 6"/>',
    fold: '<path d="m6 9 6 6 6-6"/>',
    lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    check: '<path d="m5 12 5 5 9-10"/>',
  };
  return `<svg class="rv-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths[name]}</svg>`;
}

// ---------------------------------------------------------------------------
// Model: what each exact operation means to the owner.

const visibleOnly = (value) => String(value)
  .replace(/⟦U\+[0-9A-F]{4,6} [A-Z -]+⟧/gu, '')
  .replace(/\p{Cf}/gu, '')
  .replace(/\s+/gu, ' ')
  .trim();

function blockStreams(block) {
  if (!block) return [];
  if (block.items) return block.items.map((item) => item.tokens);
  return [block.tokens ?? []];
}

// What a reader would see of a block: words and their styling, not link
// destinations, not runs of spaces, not zero-width characters.
function readerView(block) {
  if (!block) return null;
  if (block.kind === 'code') return `code:${block.text}`;
  if (block.kind === 'frontmatter') return null;
  return `${block.kind}:${block.level ?? ''}:${blockStreams(block).map((tokens) => tokens
    .map((token) => `${token.type}:${visibleOnly(token.text)}`).join('|')).join('/')}`;
}

function linkTargets(text) {
  const spans = [];
  for (const match of text.matchAll(/\[[^\]\n]*\]\(([^)\s]*)\)/gu)) {
    const start = match.index + match[0].indexOf('](') + 2;
    spans.push({ start, end: start + match[1].length, target: match[1] });
  }
  for (const match of text.matchAll(/\[\[([^\]|\n]+)\|[^\]\n]*\]\]/gu)) {
    spans.push({ start: match.index + 2, end: match.index + 2 + match[1].length, target: match[1] });
  }
  return spans;
}

const inside = (span, outer) => span && outer && outer.start <= span.start && span.end <= outer.end;
const touches = (span, block) => span && block && (span.start < block.end && span.end > block.start
  || (span.start === span.end && block.start <= span.start && span.start <= block.end));

function wordCount(text) {
  return (String(text).match(/\S+/gu) ?? []).length;
}

// A heavily changed paragraph reads better as the new text with the old one
// a tap away. Display only: never used to decide or derive an edit.
export function rewriteShare(tracked) {
  let same = 0; let removed = 0; let added = 0;
  for (const group of tracked?.groups ?? []) {
    for (const run of group.runs) {
      const words = wordCount(run.token.text);
      if (run.kind === 'context') same += words;
      else if (run.kind === 'removed') removed += words;
      else added += words;
    }
  }
  const before = same + removed; const after = same + added;
  if (before + after === 0) return { share: 0, before, after };
  return { share: 1 - (2 * same) / (before + after), before, after };
}

export function isRewritten(row) {
  if (!row?.tracked) return false;
  if (row.tracked.kind === 'block' && row.baseBlock && row.block) return true;
  if (row.tracked.kind !== 'inline') return false;
  const { share, before, after } = rewriteShare(row.tracked);
  return before >= REWRITE_THRESHOLD.minimumWords && after >= REWRITE_THRESHOLD.minimumWords
    && share >= REWRITE_THRESHOLD.changedShare;
}

// Letters, digits, marks and the joiners that keep a word whole.
export const WORD_CHARACTER = /[\p{L}\p{N}\p{M}_'’-]/u;

/**
 * One exact change grown to whole words, for display only. Takes the text
 * before, the old text, the new text and the text after as arrays of code
 * points. Shared ends of old and new become context; a change that starts or
 * ends inside a word takes in the rest of that word on both sides. Returns
 * null when old and new are the same.
 */
export function wholeWordChange(before, old, next, after) {
  let prefix = 0;
  while (prefix < old.length && prefix < next.length && old[prefix] === next[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < old.length - prefix && suffix < next.length - prefix
    && old[old.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix += 1;
  const lead = [...before, ...old.slice(0, prefix)];
  const trail = [...old.slice(old.length - suffix), ...after];
  let oldCore = old.slice(prefix, old.length - suffix);
  let newCore = next.slice(prefix, next.length - suffix);
  if (oldCore.length === 0 && newCore.length === 0) return null;
  const touchesStart = (core) => core.length > 0 && WORD_CHARACTER.test(core[0]);
  const touchesEnd = (core) => core.length > 0 && WORD_CHARACTER.test(core.at(-1));
  while (lead.length && WORD_CHARACTER.test(lead.at(-1)) && (touchesStart(oldCore) || touchesStart(newCore))) {
    const char = lead.pop(); oldCore = [char, ...oldCore]; newCore = [char, ...newCore];
  }
  while (trail.length && WORD_CHARACTER.test(trail[0]) && (touchesEnd(oldCore) || touchesEnd(newCore))) {
    const char = trail.shift(); oldCore = [...oldCore, char]; newCore = [...newCore, char];
  }
  return { lead, trail, oldText: oldCore.join(''), newText: newCore.join('') };
}

function showSpaces(value) {
  return String(value).replace(/ /gu, '·').replace(/\t/gu, '→').replace(/\n/gu, '↵\n');
}

function compact(value, maximum = 48) {
  const text = String(value).replace(/\s+/gu, ' ').trim();
  return text.length <= maximum ? text : `${text.slice(0, maximum - 1).trimEnd()}…`;
}

/**
 * Classify every exact operation once. The same model drives the frame, the
 * panel, the list and the server's must-see rule, so they cannot disagree.
 */
export function reviewModel({ operations, display, document, hiddenUnavailable = false }) {
  const pageAvailable = Boolean(display?.available) && !display.exactOnly;
  const rows = pageAvailable ? display.tracked.rows : [];
  const opRow = new Map();
  if (pageAvailable) for (const [row, numbers] of display.anchors) for (const number of numbers) opRow.set(number, row);
  const baseText = document?.baseText ?? '';
  const candidateText = document?.candidateText ?? '';
  const baseLinks = pageAvailable ? linkTargets(baseText) : [];
  const nextLinks = pageAvailable ? linkTargets(candidateText) : [];
  const baseFront = pageAvailable ? display.file.current.blocks.find((block) => block.kind === 'frontmatter') : null;
  const nextFront = pageAvailable ? display.file.proposed.blocks.find((block) => block.kind === 'frontmatter') : null;
  const changes = operations.map((operation, index) => {
    const number = index + 1;
    const oldText = operation.oldText ?? operation.expected ?? '';
    const newText = operation.replacementText ?? operation.replacement ?? '';
    const hidden = hiddenUnavailable || Boolean(display?.hiddenOperations?.has(number))
      || hasHiddenProposalSource(oldText + newText);
    const change = { number, oldText, newText, hidden, kind: 'visible', anchored: false };
    if (!pageAvailable) return { ...change, kind: hidden ? 'hidden' : 'unshown' };
    const oldPart = display.file.current.segments.find((part) => part.operation === number);
    const nextPart = display.file.proposed.segments.find((part) => part.operation === number);
    if ((baseFront && touches(oldPart, baseFront)) || (nextFront && touches(nextPart, nextFront))) {
      return { ...change, kind: 'properties' };
    }
    if (hidden) return { ...change, kind: 'hidden', anchored: opRow.has(number) };
    const row = opRow.get(number) ?? null;
    const anchored = row !== null;
    const oldLink = baseLinks.find((span) => inside(oldPart, span));
    const nextLink = nextLinks.find((span) => inside(nextPart, span));
    if (oldLink && nextLink) return { ...change, kind: 'link', anchored, before: oldLink.target, after: nextLink.target };
    const inCode = row?.block?.kind === 'code' || row?.baseBlock?.kind === 'code';
    const unseenText = (value) => value.replace(/\p{Cf}/gu, '').replace(/[ \t]+/gu, ' ');
    if (!inCode && unseenText(oldText) === unseenText(newText)) return { ...change, kind: 'spaces', anchored };
    // A broad rewrite has no per-change anchors; the whole page is the change.
    if (row === null && display.tracked.coarse && display.anchors.size === 0) return { ...change, kind: 'visible', anchored };
    if (!row?.block || row.tracked?.kind === 'source'
      || (row.baseBlock && readerView(row.baseBlock) === readerView(row.block))) {
      return { ...change, kind: 'unseen', anchored };
    }
    return { ...change, kind: 'visible', anchored, rewritten: isRewritten(row) };
  });
  const properties = changes.filter((change) => change.kind === 'properties');
  const body = changes.filter((change) => change.kind !== 'properties');
  // When the page itself can't be shown, every change is listed as text in the
  // panel instead; that listing is the review, so it needs no extra step.
  const mustSee = body.filter((change) => change.kind !== 'visible' && change.kind !== 'unshown');
  const unshown = body.filter((change) => change.kind === 'unshown');
  const propertyRows = [];
  if (properties.length > 0) {
    const before = new Map((baseFront?.entries ?? []).map((entry) => [entry.name, entry.value]));
    const after = new Map((nextFront?.entries ?? []).map((entry) => [entry.name, entry.value]));
    const structured = (baseFront?.uninterpreted?.length ?? 0) + (nextFront?.uninterpreted?.length ?? 0) > 0;
    if (!structured && !hasHiddenProposalSource(baseText.slice(baseFront?.start ?? 0, baseFront?.end ?? 0)
      + candidateText.slice(nextFront?.start ?? 0, nextFront?.end ?? 0))) {
      for (const name of new Set([...before.keys(), ...after.keys()])) {
        if (before.get(name) !== after.get(name)) propertyRows.push({ name, before: before.get(name) ?? null, after: after.get(name) ?? null });
      }
    }
  }
  const rewritten = body.filter((change) => change.rewritten);
  const coarse = pageAvailable && display.tracked.coarse && display.anchors.size === 0;
  let title;
  if (properties.length > 0) title = 'This can’t be approved';
  else if (coarse) title = 'Rewritten throughout';
  else if (body.length === 1 && mustSee.length === 1) {
    title = mustSee[0].kind === 'link' ? 'A link would point somewhere new'
      : mustSee[0].kind === 'hidden' ? 'A hidden comment would change'
        : 'A change you can’t see on the page';
  } else if (body.length > 0 && rewritten.length === body.length) {
    title = `${rewritten.length} ${rewritten.length === 1 ? 'change' : 'changes'}, rewritten`;
  } else title = `${changes.length} ${changes.length === 1 ? 'change' : 'changes'}`;
  return {
    pageAvailable, coarse, changes, body, properties, propertyRows, mustSee, unshown, title,
    blocked: properties.length > 0 ? PROPERTIES_REFUSAL : null,
    anchors: body.filter((change) => change.anchored).map((change) => change.number),
  };
}

// ---------------------------------------------------------------------------
// The frame: the note as a site page. Escaped projection only; links are inert.

function tokenHtml(token) {
  const text = escapeHtml(token.text);
  if (token.type === 'code') return `<code>${text}</code>`;
  if (token.type === 'strong') return `<strong>${text}</strong>`;
  if (token.type === 'emphasis') return `<em>${text}</em>`;
  if (token.type === 'link' || token.type === 'wikilink') return `<span class="lnk">${text}</span>`;
  return text;
}

const isLink = (token) => token?.type === 'link' || token?.type === 'wikilink';

function runsHtml(runs) {
  let out = '';
  for (let index = 0; index < runs.length; index += 1) {
    const run = runs[index];
    const next = runs[index + 1];
    if (run.kind === 'removed' && next?.kind === 'added' && isLink(run.token) && isLink(next.token)
      && run.token.text === next.token.text) {
      out += `<span class="lnk dot" title="Where this link goes would change">${escapeHtml(next.token.text)}</span>`;
      index += 1;
      continue;
    }
    if (run.kind === 'context') { out += tokenHtml(run.token); continue; }
    // Mark the words, not the space that travels with them.
    const [, words, space] = /^([\s\S]*?)(\s*)$/u.exec(run.token.text);
    const marked = words === '' ? escapeHtml(space) : `${tokenHtml({ ...run.token, text: words })}`;
    const tag = run.kind === 'added' ? 'ins' : 'del';
    out += words === '' ? marked : `<${tag}>${marked}</${tag}>${escapeHtml(space)}`;
    if (run.kind === 'removed' && next?.kind === 'added' && space === '') out += ' ';
  }
  return out;
}

function headingLevel(block) {
  return Math.min(6, Math.max(2, (block.level ?? 1) + 1));
}

function wrapBlock(block, parts) {
  if (block.kind === 'heading') { const level = headingLevel(block); return `<h${level}>${parts[0]}</h${level}>`; }
  if (block.kind === 'paragraph') return `<p>${parts[0]}</p>`;
  if (block.kind === 'quote') return `<blockquote><p>${parts[0]}</p></blockquote>`;
  if (block.kind === 'code') return `<pre><code>${parts[0]}</code></pre>`;
  if (block.kind === 'rule') return '<hr>';
  if (block.kind === 'list' || block.kind === 'ordered-list') {
    const tag = block.kind === 'list' ? 'ul' : 'ol';
    return `<${tag}>${block.items.map((item, index) => `<li${item.depth > 0 ? ' class="nested"' : ''}>${parts[index] ?? ''}</li>`).join('')}</${tag}>`;
  }
  return null;
}

function plainBlock(block, text) {
  if (block.uninterpreted?.length) return sourceBlock(block, text);
  const parts = block.kind === 'code' ? [escapeHtml(block.text)] : blockStreams(block).map((tokens) => tokens.map(tokenHtml).join(''));
  return wrapBlock(block, parts) ?? sourceBlock(block, text);
}

function sourceBlock(block, text) {
  return `<pre class="src" aria-label="Shown as written">${escapeHtml(text.slice(block.start, block.end).replace(/\n+$/u, ''))}</pre>`;
}

function changeTag(label) {
  return `<span class="tag">${escapeHtml(label)}</span>`;
}

// A raw HTML block (one that opens with a tag) is page markup, not prose.
// Unchanged, it is summarised rather than shown as source.
function isHtmlBlock(block, text) {
  if (!block?.uninterpreted?.includes('inline HTML')) return false;
  const slice = text.slice(block.start, block.end);
  return /^\s*<\/?[A-Za-z][\w-]*(?:[\s/>]|$)/u.test(slice) && !hasHiddenProposalSource(slice);
}

function anchorsHtml(row, model, display) {
  // The first change is highlighted before any navigation.
  return (display.anchors.get(row) ?? []).map((number) => `<span class="anc${number === model.anchors[0] ? ' first' : ''}" id="c${number}"></span>`).join('');
}

// Runs of hidden content, and runs of unchanged HTML blocks, each read as one
// quiet line with a count instead of a stack of identical lines.
const QUIET_LINES = Object.freeze({
  hidden: (count) => (count === 1 ? 'Hidden content · source not shown' : `Hidden content · ${count} blocks · source not shown`),
  html: (count) => (count === 1 ? 'HTML block, unchanged' : `${count} HTML blocks, unchanged`),
  hiddenChanges: (count) => (count === 1 ? 'Hidden content · source not shown' : `Hidden content · ${count} changes · source not shown`),
});

function rowPiece(row, model, document, display) {
  if (row.block?.kind === 'frontmatter' || row.baseBlock?.kind === 'frontmatter') return null;
  if (row.hidden) return { quiet: 'hidden', anchors: anchorsHtml(row, model, display) };
  if (!row.changed && isHtmlBlock(row.block, document.candidateText)) return { quiet: 'html', anchors: '' };
  return { html: rowHtml(row, model, document, display) };
}

function rowsHtml(rows, model, document, display, repeatedTitle) {
  const out = [];
  let run = null;
  const flush = () => {
    if (run) out.push(`<div class="row">${run.anchors}<p class="hid">${QUIET_LINES[run.quiet](run.count)}</p></div>`);
    run = null;
  };
  for (const row of rows) {
    if (row === repeatedTitle) continue;
    const piece = rowPiece(row, model, document, display);
    if (piece === null) continue;
    if (piece.quiet && run?.quiet === piece.quiet) { run.count += 1; run.anchors += piece.anchors; continue; }
    flush();
    if (piece.quiet) run = { quiet: piece.quiet, count: 1, anchors: piece.anchors };
    else out.push(piece.html);
  }
  flush();
  return out.join('');
}

function rowHtml(row, model, document, display) {
  const anchors = anchorsHtml(row, model, display);
  const base = document.baseText; const next = document.candidateText;
  if (!row.changed) return plainBlock(row.block, next);
  if (!row.block) {
    return `<div class="row">${anchors}${row.removed ? '<p class="pt">Text was removed here</p>' : ''}</div>`;
  }
  if (row.deleted) {
    return `<div class="chg rm">${anchors}${changeTag('Removed')}<div class="was">${plainBlock(row.block, base)}</div></div>`;
  }
  const kind = row.tracked?.kind;
  if (kind === 'added') return `<div class="chg add">${anchors}${changeTag('Added')}${plainBlock(row.block, next)}</div>`;
  if (kind === 'inline' && !isRewritten(row)) {
    const parts = row.tracked.groups.map((group) => runsHtml(group.runs));
    const html = wrapBlock(row.block, parts);
    if (html) return `<div class="row mk">${anchors}${html}</div>`;
  }
  const before = row.baseBlock ? plainBlock(row.baseBlock, base) : row.previous?.some((part) => part.length)
    ? `<pre class="src">${escapeHtml(row.previous.join('\n'))}</pre>` : '';
  const label = kind === 'inline' || kind === 'block' ? 'Rewritten' : 'Changed';
  return `<div class="chg rw">${anchors}${changeTag(label)}${plainBlock(row.block, next)}${before
    ? `<details class="old"><summary>Show what it said before</summary><div class="was">${before}</div></details>` : ''}</div>`;
}

function crumbs(sourcePath) {
  const folders = sourcePath.split('/').slice(0, -1);
  if (folders.length === 0) return '';
  return `<p class="crumb">${folders.map((part) => escapeHtml(part.replace(/[-_]+/gu, ' '))).join(' <span aria-hidden="true">›</span> ')}</p>`;
}

export const FRAME_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
  "img-src 'none'",
  "style-src 'unsafe-inline'",
  'sandbox',
].join('; ');

const SCHEMES = Object.freeze({
  light: '--bg:#f8f8f5;--ink:#1d2320;--soft:#55605a;--line:#dfe3df;--acc:#0b6b4b;--ins-bg:#d9f0e2;--ins:#0c4a33;--del-bg:#f6dedb;--del:#8a2c22;--code:#eef0ec;',
  dark: '--bg:#1c2420;--ink:#e4ebe6;--soft:#a8b5ad;--line:#34413a;--acc:#7fd1a8;--ins-bg:#2f4a3b;--ins:#c6edd6;--del-bg:#4a2c28;--del:#f3c0b8;--code:#26302b;',
});

export function schemeCss(colorScheme, selector) {
  if (colorScheme === 'dark') return `${selector}{${SCHEMES.dark}}`;
  if (colorScheme === 'light') return `${selector}{${SCHEMES.light}}`;
  return `${selector}{${SCHEMES.light}}@media (prefers-color-scheme:dark){${selector}{${SCHEMES.dark}}}`;
}

const FRAME_STYLE = `
*{box-sizing:border-box}
html{background:var(--bg);color:var(--ink);font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-text-size-adjust:100%}
body{margin:0}
::selection{background:var(--ins-bg);color:var(--ins)}
main{max-width:42rem;margin:0 auto;padding:16px 18px 48px}
.crumb{font-size:.78rem;color:var(--acc);margin:0 0 6px;text-transform:capitalize}
h1{font-size:1.6rem;line-height:1.2;letter-spacing:-.01em;margin:0 0 14px;text-wrap:balance}
h2,h3,h4,h5,h6{line-height:1.3;margin:1.5em 0 .45em;text-wrap:balance}
h2{font-size:1.2rem;padding-bottom:4px;border-bottom:1px solid var(--line)}
h3{font-size:1.05rem}h4,h5,h6{font-size:1rem}
p,ul,ol,blockquote,pre{margin:0 0 .85em}
ul,ol{padding-left:1.3em}li.nested{margin-left:1.2em}
blockquote{margin-left:0;padding-left:12px;border-left:2px solid var(--line);color:var(--soft)}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.88em;background:var(--code);padding:.1em .3em;border-radius:3px}
pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.85rem;background:var(--code);padding:10px 12px;border-radius:6px;white-space:pre-wrap;overflow-wrap:anywhere}
pre code{background:none;padding:0}
pre.src{color:var(--soft)}
hr{border:0;border-top:1px solid var(--line);margin:1.4em 0}
.lnk{color:var(--acc);font-weight:600;text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:3px}
.lnk.dot{text-decoration:underline dotted 2px;text-underline-offset:4px}
ins{text-decoration:underline;text-decoration-thickness:2px;text-underline-offset:3px;background:var(--ins-bg);color:var(--ins);border-radius:2px;padding:0 1px}
del{text-decoration:line-through;background:var(--del-bg);color:var(--del);border-radius:2px;padding:0 1px}
ins .lnk,del .lnk{color:inherit}
.anc{display:block;height:0;scroll-margin-top:28vh}
.row,.chg{border-radius:4px}
.chg{border-left:3px solid var(--acc);padding:2px 0 2px 12px;margin:0 0 1em}
.chg.rm{border-left-color:var(--del)}
.chg .tag{display:block;font-size:.72rem;font-weight:700;letter-spacing:.02em;color:var(--acc);margin:2px 0}
.chg.rm .tag{color:var(--del)}
.chg>:last-child{margin-bottom:0}
.was{color:var(--soft);text-decoration:line-through;text-decoration-color:var(--del)}
.old summary{font-size:.8rem;font-weight:600;color:var(--acc);cursor:pointer;padding:6px 0;list-style:none}
.old summary::-webkit-details-marker{display:none}
.old[open] summary{margin-bottom:4px}
.hid,.pt{font-size:.82rem;color:var(--soft);font-style:italic;margin:0 0 .85em}
.row:has(>.anc:target) :is(ins,del,.dot){box-shadow:0 0 0 2px var(--acc)}
.chg:has(>.anc:target),.row:has(>.anc:target) .hid,.row:has(>.anc:target) .pt{box-shadow:0 0 0 2px var(--acc);border-radius:4px}
main:not(:has(.anc:target)) .row:has(>.anc.first) :is(ins,del,.dot){box-shadow:0 0 0 2px var(--acc)}
main:not(:has(.anc:target)) .chg:has(>.anc.first){box-shadow:0 0 0 2px var(--acc)}
.unavailable{margin:24px 0;color:var(--soft)}
@media (prefers-reduced-motion:no-preference){html{scroll-behavior:smooth}}
`;

export function frameDocument({ model, display, document, title, sourcePath, colorScheme = 'light', repeatedTitle = null, note = null }) {
  let body;
  if (model.pageAvailable) {
    body = rowsHtml(display.tracked.rows, model, document, display, repeatedTitle);
  } else {
    body = `<p class="unavailable">${escapeHtml(note ?? 'This page can’t be shown here. Every change is listed in the panel.')}</p>`;
  }
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>${schemeCss(colorScheme, 'html')}${FRAME_STYLE}</style>
</head>
<body>
<main>${crumbs(sourcePath)}<h1>${escapeHtml(title)}</h1>${body}</main>
</body>
</html>
`;
}

// One line of source text around a change, cut at a word boundary. A list or
// task marker at the start of the line is structure, not words, so it goes.
function excerptSide(text, side, maximum = 80) {
  const line = side === 'before' ? text.split('\n').at(-1).replace(/^\s*(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/u, '') : text.split('\n')[0];
  if (line.length <= maximum) return escapeHtml(line);
  return side === 'before'
    ? `…${escapeHtml(line.slice(-maximum).replace(/^\S*\s/u, ''))}`
    : `${escapeHtml(line.slice(0, maximum).replace(/\s\S*$/u, ''))}…`;
}

function excerptMark(tag, text) {
  const [, lead, words, trail] = /^(\s*)([\s\S]*?)(\s*)$/u.exec(text);
  return words === '' ? escapeHtml(text) : `${escapeHtml(lead)}<${tag}>${escapeHtml(words)}</${tag}>${escapeHtml(trail)}`;
}

// Punctuation that sits against the word before it.
const HUGS_PREVIOUS = /^[,.;:!?)\]}\u2019\u201D\u2026%]/u;

/**
 * A deleted run followed by an inserted run, shown so neither introduces a
 * space before punctuation: when the new text starts with punctuation, the
 * space the old text began with is part of what was deleted, and no
 * separating space is added. `mark(tag, text)` marks one run.
 */
export function replacementHtml(oldText, newText, mark) {
  if (oldText === '') return newText === '' ? '' : mark('ins', newText);
  if (newText === '') return mark('del', oldText);
  if (HUGS_PREVIOUS.test(newText)) {
    const [, words, trail] = /^([\s\S]*?)(\s*)$/u.exec(oldText);
    const removed = words.trim() === '' ? escapeHtml(oldText) : `<del>${escapeHtml(words)}</del>${escapeHtml(trail)}`;
    return `${removed}${mark('ins', newText)}`;
  }
  const gap = !/\s$/u.test(oldText) && !/^\s/u.test(newText) ? ' ' : '';
  return `${mark('del', oldText)}${gap}${mark('ins', newText)}`;
}

// The exact change at whole words, in its own line of the page source. Needs
// the pinned page text; without it only the exact characters can be shown.
function excerptItem(operation, number, baseBytes) {
  const anchor = `<span class="anc" id="c${number}"></span>`;
  if (hasHiddenProposalSource(`${operation.expected}${operation.replacement}`)) return { quiet: true, html: anchor };
  let change = null;
  if (baseBytes !== null && Number.isSafeInteger(operation.start) && Number.isSafeInteger(operation.end)
    && baseBytes.subarray(operation.start, operation.end).toString('utf8') === operation.expected) {
    change = wholeWordChange(Array.from(baseBytes.subarray(0, operation.start).toString('utf8')), Array.from(operation.expected),
      Array.from(operation.replacement), Array.from(baseBytes.subarray(operation.end).toString('utf8')));
  }
  if (change === null) {
    // No page text: only the exact characters, said plainly.
    const removed = operation.expected ? `<del>${escapeHtml(operation.expected)}</del>` : '';
    const added = operation.replacement ? `<ins>${escapeHtml(operation.replacement)}</ins>` : '';
    return { html: `<div class="row mk">${anchor}<p><code>${removed}</code>${removed && added ? ' → ' : ''}<code>${added}</code></p></div>` };
  }
  const before = change.lead.slice(-400).join('');
  const after = change.trail.slice(0, 400).join('');
  if (hasHiddenProposalSource(before.split('\n').at(-1) + after.split('\n')[0])) return { quiet: true, html: anchor };
  if (/\n/u.test(change.oldText + change.newText)) {
    return { html: `<div class="chg rw">${anchor}<span class="tag">Changed</span><pre class="src">${excerptMark('del', change.oldText)}</pre><pre class="src">${excerptMark('ins', change.newText)}</pre></div>` };
  }
  const marked = replacementHtml(change.oldText, change.newText, excerptMark);
  return { html: `<div class="row mk">${anchor}<p>${excerptSide(before, 'before')}${marked}${excerptSide(after, 'after')}</p></div>` };
}

// After a decision, when the site's page can't be shown: each change in its
// own line of the page, at whole words. Never a reconstructed page.
export function excerptDocument({ operations, title, sourcePath, colorScheme = 'light', baseText = null }) {
  const baseBytes = typeof baseText === 'string' ? Buffer.from(baseText, 'utf8') : null;
  const out = []; let quiet = null;
  const flush = () => {
    if (quiet) out.push(`<div class="row">${quiet.anchors}<p class="hid">${QUIET_LINES.hiddenChanges(quiet.count)}</p></div>`);
    quiet = null;
  };
  operations.forEach((operation, index) => {
    const item = excerptItem(operation, index + 1, baseBytes);
    if (item.quiet) { quiet = quiet ? { count: quiet.count + 1, anchors: quiet.anchors + item.html } : { count: 1, anchors: item.html }; return; }
    flush(); out.push(item.html);
  });
  flush();
  const lede = baseBytes === null
    ? 'The changes you decided on. The page text is no longer kept, so only the exact characters are shown.'
    : 'The changes you decided on, each in its line of the page.';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>${schemeCss(colorScheme, 'html')}${FRAME_STYLE}</style>
</head>
<body>
<main>${crumbs(sourcePath)}<h1>${escapeHtml(title)}</h1><p class="hid">${lede}</p>${out.join('')}</main>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// The owner page: site line, frame, and Cyberbaser's panel.

function changeLabel(change) {
  if (change.hidden) return 'Hidden comment';
  if (change.kind === 'link') return `Link: ${compact(change.before, 22)} → ${compact(change.after, 22)}`;
  if (change.kind === 'spaces') return 'Spacing only';
  if (change.oldText === '') return `Added “${compact(change.newText, 40)}”`;
  if (change.newText === '') return `Removed “${compact(change.oldText, 40)}”`;
  return `${compact(change.oldText, 24)} → ${compact(change.newText, 24)}`;
}

function mustSeeHtml(change) {
  const pair = (before, after, mode = 'text') => {
    const show = (value) => (value === '' ? '<span class="rv-empty">nothing</span>' : escapeHtml(mode === 'spaces' ? showSpaces(value) : value));
    return `<dl class="rv-kv"><dt>Now</dt><dd><code class="rv-o">${show(before)}</code></dd><dt>Proposed</dt><dd><code class="rv-n">${show(after)}</code></dd></dl>`;
  };
  if (change.kind === 'hidden') {
    return `<li><p class="rv-note">A hidden comment in the page source would change. Readers never see it, and Cyberbaser doesn’t show hidden comments.</p></li>`;
  }
  if (change.kind === 'link') {
    return `<li><p class="rv-note">The page would look exactly the same. Only where the link goes would change.</p>${pair(change.before, change.after)}</li>`;
  }
  if (change.kind === 'spaces') {
    return `<li><p class="rv-note">Only spacing changes. Spaces show as ·, tabs as →, line breaks as ↵.</p>${pair(change.oldText, change.newText, 'spaces')}</li>`;
  }
  const lead = change.kind === 'unshown' ? 'The page can’t be shown here, so this is the exact change.' : 'Readers wouldn’t see this on the page.';
  return `<li><p class="rv-note">${lead}</p>${pair(change.oldText, change.newText, 'spaces')}</li>`;
}

function reasonHtml(reason) {
  const text = String(reason ?? '').trim();
  if (text === '') return '';
  if (text.length <= 180) return `<blockquote class="rv-why">${escapeHtml(text)}</blockquote>`;
  return `<details class="rv-why rv-why-long"><summary><span class="rv-why-short">${escapeHtml(compact(text, 150))}</span><span class="rv-more">Read all</span></summary><blockquote>${escapeHtml(text)}</blockquote></details>`;
}

function siteLine(siteTitle) {
  return `<header class="rv-site"><a class="rv-back" href="/owner/review" aria-label="Back to Proposals">${reviewIcon('previous')}</a><b>${escapeHtml(siteTitle)}</b><span>your website</span></header>`;
}

function bar({ count = 0 } = {}) {
  const nav = count > 1
    ? `<button type="button" id="rv-prev" aria-label="Previous change">${reviewIcon('previous')}</button><output id="rv-pos" aria-live="polite">1 of ${count}</output><button type="button" id="rv-next" aria-label="Next change">${reviewIcon('next')}</button>`
    : '';
  return `<div class="rv-bar"><b>Cyberbaser</b><span class="rv-priv">private to you</span><span class="rv-nav">${nav}<button type="button" id="rv-fold" aria-expanded="true" aria-controls="rv-body" aria-label="Hide the panel">${reviewIcon('fold')}</button></span></div>`;
}

function decisionDialog({ queueId, reviewEvidenceDigest, csrfToken, maxReasonBytes, title, version, count, mustSee }) {
  return `<dialog id="decision-dialog" aria-labelledby="decision-dialog-title">
<form id="review-decision-form" class="decision-sheet" data-queue-id="${escapeHtml(queueId)}" data-review-evidence-digest="${escapeHtml(reviewEvidenceDigest)}" data-csrf="${escapeHtml(csrfToken)}" data-max-reason-bytes="${maxReasonBytes}" data-suggestion-label="${escapeHtml(title)}" data-proposal-version="${version}" data-change-count="${count}" data-must-see="${mustSee ? 'true' : 'false'}">
<h2 id="decision-dialog-title">Approve this proposal?</h2>
<label for="decision-reason">Why?</label>
<p class="field-help" id="decision-note-help">A short note, kept with your decision.</p>
<textarea class="decision-reason" id="decision-reason" name="reason" rows="3" maxlength="${maxReasonBytes}" aria-describedby="decision-note-help decision-byte-count" required></textarea>
<span id="decision-byte-count" class="byte-count" aria-live="polite"></span>
<p id="decision-status" class="status" role="status" aria-live="polite" tabindex="-1"></p>
<p id="decision-dialog-copy" class="decision-boundary">This records your decision. The page stays exactly as it is.</p>
<div class="dialog-actions"><button type="button" class="dialog-back" data-dialog-cancel>Cancel</button><button type="button" id="decision-confirm" data-action="approve">Approve</button></div>
</form>
</dialog>`;
}

export function reviewShell({ model, entry, title, siteTitle, senderHtml, frameUrl, csrfToken, maxReasonBytes, version, advisory, detailsHtml, detailsOpen = false }) {
  const { summary } = entry;
  const navCount = model.anchors.length;
  const reason = entry.evidence.proposal.submission.rationale;
  const properties = model.properties.length === 0 ? '' : `<section class="rv-props" aria-label="Page properties"><p class="rv-group">Page properties · ${model.properties.length}</p>${model.propertyRows.length
    ? `<dl class="rv-kv">${model.propertyRows.map((row) => `<dt>${escapeHtml(row.name)}</dt><dd>${row.before === null ? '' : `<del>${escapeHtml(row.before)}</del> `}${row.after === null ? '' : `<ins>${escapeHtml(row.after)}</ins>`}</dd>`).join('')}</dl>`
    : '<p class="rv-note">The settings at the top of the note change. See Details for the exact text.</p>'}</section>`;
  const blocked = model.blocked ? `<p class="rv-note rv-refusal">${escapeHtml(model.blocked)}</p>` : '';
  const mustSee = model.blocked || model.mustSee.length === 0 ? '' : `<ul class="rv-must" aria-label="Changes the page can’t show">${model.mustSee.map(mustSeeHtml).join('')}</ul>`;
  const unshown = model.unshown.length === 0 ? '' : `<ul class="rv-must" aria-label="Changes listed here because the page can’t be shown">${model.unshown.map(mustSeeHtml).join('')}</ul>`;
  const listed = model.body.length > 1 ? `<button type="button" class="rv-link" id="rv-list-toggle" aria-expanded="false" aria-controls="rv-list">See all ${model.body.length} changes</button>
<ol class="rv-list" id="rv-list" hidden>${model.body.map((change) => {
    const label = escapeHtml(changeLabel(change));
    return change.anchored
      ? `<li><a href="${escapeHtml(frameUrl)}#c${change.number}" target="rv-frame" data-change="${change.number}"><i>${change.number}</i><span>${label}</span></a></li>`
      : `<li><span class="rv-unanchored" data-change="${change.number}"><i>${change.number}</i><span>${label}</span></span></li>`;
  }).join('')}</ol>` : '';
  const actions = model.blocked
    ? '<div class="rv-act"><button type="button" data-action="reject" class="rv-sec">Reject</button></div>'
    : model.mustSee.length > 0
      ? `<div class="rv-act"><button type="button" data-action="reject" class="rv-sec">Reject</button><button type="button" id="rv-seen" class="rv-pri">I’ve seen ${model.mustSee.length === 1 ? 'this' : 'these'}</button><button type="button" data-action="approve" class="rv-pri" hidden>Approve</button></div>`
      : '<div class="rv-act"><button type="button" data-action="reject" class="rv-sec">Reject</button><button type="button" data-action="approve" class="rv-pri">Approve</button></div>';
  // The frame opens at the first change, so a phone shows it above the panel.
  const firstChange = model.anchors.length > 0 ? `${frameUrl}#c${model.anchors[0]}` : frameUrl;
  return `<div class="rv-app" id="owner-review-detail" data-anchors="${model.anchors.join(',')}" data-frame="${escapeHtml(frameUrl)}">
${siteLine(siteTitle)}
<main class="rv-page"><iframe id="rv-frame" name="rv-frame" title="${escapeHtml(title)}, as your site shows it" sandbox="" referrerpolicy="no-referrer" loading="eager" src="${escapeHtml(firstChange)}"></iframe></main>
<section class="rv-sheet" id="rv-sheet" aria-label="Cyberbaser, private to you">
${bar({ count: navCount })}
<div class="rv-body" id="rv-body">
${properties}
<h1 class="${model.blocked ? 'rv-blocked' : ''}">${escapeHtml(model.title)}</h1>
<p class="rv-from">${senderHtml}</p>
${advisory}
${reasonHtml(reason)}
${blocked}${mustSee}${unshown}${listed}
${actions}
<noscript><p class="rv-note">Recording a decision needs scripting enabled in this browser.</p></noscript>
<details class="rv-details" id="publication-review-fallback"${detailsOpen ? ' open' : ''}><summary>Details</summary>${detailsHtml}</details>
</div>
</section>
</div>
${decisionDialog({ queueId: summary.queueId, reviewEvidenceDigest: summary.reviewEvidenceDigest, csrfToken, maxReasonBytes, title, version, count: model.changes.length, mustSee: model.mustSee.length > 0 })}`;
}

export function receiptShell({ siteTitle, title, frameUrl, senderHtml, panelHtml, detailsHtml, firstAnchor = null }) {
  const src = firstAnchor === null ? frameUrl : `${frameUrl}#c${firstAnchor}`;
  return `<div class="rv-app rv-receipt" id="owner-decision-detail">
${siteLine(siteTitle)}
<main class="rv-page"><iframe id="rv-frame" name="rv-frame" title="${escapeHtml(title)}, the changes you decided on" sandbox="" referrerpolicy="no-referrer" src="${escapeHtml(src)}"></iframe></main>
<section class="rv-sheet" id="rv-sheet" aria-label="Cyberbaser, private to you">
${bar()}
<div class="rv-body" id="rv-body">
${panelHtml}
<p class="rv-from">${senderHtml}</p>
<details class="rv-details"><summary>Details</summary>${detailsHtml}</details>
</div>
</section>
</div>`;
}

export function noticeShell({ siteTitle, heading, message }) {
  return `<div class="rv-app rv-notice">
${siteLine(siteTitle)}
<main class="rv-page rv-page-empty"></main>
<section class="rv-sheet" aria-label="Cyberbaser, private to you">
${bar()}
<div class="rv-body" id="rv-body"><h1 class="rv-blocked">${escapeHtml(heading)}</h1><p class="rv-note">${escapeHtml(message)}</p><p><a class="rv-link" href="/owner/review">Back to proposals</a></p></div>
</section>
</div>`;
}

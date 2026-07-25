// Reference extraction for the publish boundary.
//
// This module reads markdown and reports what it points at. It never rewrites
// anything: the selector needs references to decide which assets are reachable
// from a published page and which links cross the publish boundary, and R12
// forbids touching file bytes in any publish path.
//
// Code is masked before matching, so a fenced sample containing [[x]] or a
// backticked `![[y]]` is a code sample, not a reference.

const FENCE_OPEN = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/;

/**
 * Replace every code region with spaces of the same length. Offsets and line
 * numbers stay valid, so matches found in the masked text can be sliced out of
 * the original.
 *
 * Fenced blocks (``` and ~~~) are masked whole. Inline spans are masked per
 * line, so an unpaired backtick cannot swallow the rest of the document.
 */
export function maskCode(markdown) {
  const lines = markdown.split('\n');
  let fence = null; // { char, len }
  const out = lines.map((line) => {
    if (fence) {
      const close = line.match(FENCE_OPEN);
      if (close && close[1][0] === fence.char && close[1].length >= fence.len && close[2].trim() === '') fence = null;
      return ' '.repeat(line.length);
    }
    const open = line.match(FENCE_OPEN);
    if (open) {
      fence = { char: open[1][0], len: open[1].length };
      return ' '.repeat(line.length);
    }
    return line.replace(/(`+)(.*?)\1/g, (m) => ' '.repeat(m.length));
  });
  return out.join('\n');
}

function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}

function lineAt(starts, index) {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= index) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
}

const WIKI = /(!?)\[\[([^\[\]\n]+?)\]\]/g;
const MD = /(!?)\[([^\]]*)\]\((<[^>\n]*>|[^)\s]*)(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?\)/g;

/** `target#heading|alias`, `target#^block`, `#heading` (same file), `![[img|200x100]]`. */
function parseWikiInner(inner) {
  const parts = inner.split('|');
  const left = parts[0].trim();
  const params = parts.slice(1).map((p) => p.trim());
  const hash = left.indexOf('#');
  let target = left, heading = null, block = null;
  if (hash >= 0) {
    target = left.slice(0, hash).trim();
    const frag = left.slice(hash + 1).trim();
    if (frag.startsWith('^')) block = frag.slice(1);
    else heading = frag;
  }
  return { target, heading, block, alias: params.length ? params[params.length - 1] : null, params };
}

/**
 * @param {string} markdown
 * @returns {{wikilinks: object[], embeds: object[], mdLinks: object[], mdImages: object[]}}
 *   Every ref carries `raw`, `target`, `line` (1-based) and `index` (offset in
 *   the original text). Wikilinks and embeds also carry `heading`, `block`,
 *   `alias` and `params`; markdown links carry `text`, images carry `alt`.
 */
export function extractRefs(markdown) {
  const src = typeof markdown === 'string' ? markdown : '';
  const masked = maskCode(src);
  const starts = lineStarts(src);
  const refs = { wikilinks: [], embeds: [], mdLinks: [], mdImages: [] };

  for (const m of masked.matchAll(WIKI)) {
    const parsed = parseWikiInner(m[2]);
    const ref = {
      kind: m[1] === '!' ? 'embed' : 'wikilink',
      raw: src.slice(m.index, m.index + m[0].length),
      ...parsed,
      line: lineAt(starts, m.index),
      index: m.index,
    };
    (ref.kind === 'embed' ? refs.embeds : refs.wikilinks).push(ref);
  }

  for (const m of masked.matchAll(MD)) {
    let href = m[3] ?? '';
    if (href.startsWith('<') && href.endsWith('>')) href = href.slice(1, -1);
    const image = m[1] === '!';
    const ref = {
      kind: image ? 'md-image' : 'md-link',
      raw: src.slice(m.index, m.index + m[0].length),
      target: href,
      line: lineAt(starts, m.index),
      index: m.index,
    };
    if (image) { ref.alt = m[2]; refs.mdImages.push(ref); }
    else { ref.text = m[2]; refs.mdLinks.push(ref); }
  }

  return refs;
}

/** All four buckets in one array, source order. Convenience for callers that walk everything. */
export function allRefs(markdown) {
  const r = extractRefs(markdown);
  return [...r.wikilinks, ...r.embeds, ...r.mdLinks, ...r.mdImages].sort((a, b) => a.index - b.index);
}

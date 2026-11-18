// The validator's core: classify the change between two versions of a file.
//
// Contract (R12): the write path never re-serializes, so an honest edit changes
// only the region the author touched. A tool that re-serializes (a CMS, an
// exporter, a sync) leaves fingerprints: mass line churn, escapes the author
// never wrote, constructs silently rewritten or dropped. This detects those.
//
// Verdicts:
//   clean   — nothing beyond the edited region's intent is detectable
//   suspect — normalization fingerprints (mass churn, style rewrites, escapes)
//   damage  — OFM constructs removed/corrupted outside plausible intent
import { inventory, diffInventories, CONSTRUCT_RES } from './constructs.js';
import { changedLinePairs } from './line-pairs.js';
import { makePipeline } from './pipeline.js';

const linkParser = makePipeline();

// Consume only actual removed/added occurrences at matching slots on aligned
// changed lines. A new link elsewhere in the file cannot excuse a removal.
function retargetFindings(delta, pairs) {
  const findings = [];
  for (const name of ['wikilink', 'embed']) {
    if (!delta[name]) continue;
    const { removed, added } = delta[name];
    for (const [before, after] of pairs) {
      const b = [...before.matchAll(CONSTRUCT_RES[name])], a = [...after.matchAll(CONSTRUCT_RES[name])];
      for (let i = 0; i < Math.min(b.length, a.length); i++) {
        const from = b[i][0], to = a[i][0];
        if (from === to) continue;
        const bi = removed.indexOf(from), ai = added.indexOf(to);
        if (bi < 0 || ai < 0) continue;
        removed.splice(bi, 1); added.splice(ai, 1);
        findings.push({ type: `${name}-retargeted`, construct: from, replacement: to, severity: 'info' });
      }
    }
  }
  return findings;
}

// The Markdown parser supplies real inline links, not link-shaped code/prose.
// Match the exact label/destination bytes, allowing only bracket disambiguation
// in the label. URL escapes and all other escaping remain chargeable.
function markdownLabels(src) {
  const labels = [];
  function visit(node) {
    if (node.type === 'link' && src[node.position.start.offset] === '[') {
      const start = node.position.start.offset;
      const labelEnd = node.children.at(-1)?.position.end.offset ?? start + 1;
      const close = src.indexOf('](', labelEnd);
      if (close >= 0 && close < node.position.end.offset) {
        const label = src.slice(start + 1, close);
        const tokens = label.match(/\\[\s\S]|[^\\]/g) ?? [];
        labels.push({
          key: tokens.map((t) => /^\\[\[\]]$/.test(t) ? t[1] : t).join('') + src.slice(close, node.position.end.offset),
          escaped: tokens.filter((t) => /^\\[\[\]]$/.test(t)).length,
          unescaped: tokens.some((t) => t === '[' || t === ']'),
        });
      }
    }
    for (const child of node.children ?? []) visit(child);
  }
  visit(linkParser.parse(src));
  return labels;
}

function disambiguatingEscapes(before, after) {
  const available = new Map();
  for (const label of markdownLabels(before)) {
    const queue = available.get(label.key) ?? [];
    queue.push(label); available.set(label.key, queue);
  }
  let count = 0;
  for (const label of markdownLabels(after)) {
    const previous = available.get(label.key)?.shift();
    if (previous?.unescaped) count += Math.max(0, label.escaped - previous.escaped);
  }
  return count;
}

const ESCAPABLE = /\\([[\]*_#`~|!<>&.\-+(){}])/g;

function lineChurn(before, after) {
  const b = before.split('\n'), a = after.split('\n');
  const bSet = new Map();
  for (const l of b) bSet.set(l, (bSet.get(l) ?? 0) + 1);
  let common = 0;
  for (const l of a) {
    const c = bSet.get(l) ?? 0;
    if (c > 0) { common++; bSet.set(l, c - 1); }
  }
  const total = Math.max(b.length, a.length);
  return total === 0 ? 0 : 1 - common / total;
}

/** Looks like `[[X]]` degraded into `[X](...)` or plain text, `> [!note]` into a bare quote, etc. */
function degradationFindings(delta, after) {
  const findings = [];
  for (const w of delta.wikilink?.removed ?? []) {
    const inner = w.slice(2, -2).split('|')[0].split('#')[0];
    if (inner && (after.includes(`[${inner}](`) || new RegExp(`(?<!\\[)\\[${escapeRe(inner)}\\](?!\\])`).test(after)))
      findings.push({ type: 'wikilink-degraded', construct: w });
  }
  for (const e of delta.embed?.removed ?? []) {
    const inner = e.slice(3, -2).split('|')[0];
    if (inner && after.includes(`![${inner}]`)) findings.push({ type: 'embed-degraded', construct: e });
  }
  for (const c of delta.callout?.removed ?? []) findings.push({ type: 'callout-removed', construct: c.trim() });
  return findings;
}
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function checkChange(before, after) {
  const findings = [];

  // 1. Construct inventory delta.
  const delta = diffInventories(inventory(before), inventory(after));
  if (delta.wikilink || delta.embed) findings.push(...retargetFindings(delta, changedLinePairs(before, after)));
  findings.push(...degradationFindings(delta, after));
  for (const [name, { removed }] of Object.entries(delta)) {
    if (name === 'tag' || name === 'code_fence') continue; // too noisy to treat as damage alone
    for (const r of removed) {
      if (!findings.some((f) => f.severity !== 'info' && (f.construct === r || f.construct === r.trim())))
        findings.push({ type: `${name}-removed`, construct: r });
    }
  }

  // 2. Escape injection: backslash-escapes present in `after` that `before` lacked.
  const bEsc = (before.match(ESCAPABLE) ?? []).length;
  const aEsc = (after.match(ESCAPABLE) ?? []).length;
  const injected = aEsc - bEsc - (aEsc > bEsc + 2 ? disambiguatingEscapes(before, after) : 0);
  if (injected > 2) findings.push({ type: 'escapes-injected', count: injected });

  // 3. Mass churn: a one-region edit doesn't rewrite half the file.
  const churn = lineChurn(before, after);
  if (churn > 0.5 && before.length > 500) findings.push({ type: 'mass-rewrite', churn: +churn.toFixed(2) });

  // 4. List-marker / heading-style normalization fingerprints.
  const bullets = (s) => ({ dash: (s.match(/^[ \t]*- /gm) ?? []).length, star: (s.match(/^[ \t]*\* /gm) ?? []).length });
  const bb = bullets(before), ab = bullets(after);
  if ((bb.star > 3 && ab.star === 0 && ab.dash >= bb.star) || (bb.dash > 3 && ab.dash === 0 && ab.star >= bb.dash))
    findings.push({ type: 'list-marker-normalized' });

  const damage = findings.some((f) => /-degraded$|-removed$/.test(f.type));
  const suspect = findings.some((f) => f.severity !== 'info');
  return {
    verdict: damage ? 'damage' : suspect ? 'suspect' : 'clean',
    findings,
    stats: { churn: +churn.toFixed(3), escapesBefore: bEsc, escapesAfter: aEsc },
  };
}

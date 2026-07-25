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
import { inventory, diffInventories } from './constructs.js';

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
  findings.push(...degradationFindings(delta, after));
  for (const [name, { removed }] of Object.entries(delta)) {
    if (name === 'tag' || name === 'code_fence') continue; // too noisy to treat as damage alone
    for (const r of removed) {
      if (!findings.some((f) => f.construct === r || f.construct === r.trim()))
        findings.push({ type: `${name}-removed`, construct: r });
    }
  }

  // 2. Escape injection: backslash-escapes present in `after` that `before` lacked.
  const bEsc = (before.match(ESCAPABLE) ?? []).length;
  const aEsc = (after.match(ESCAPABLE) ?? []).length;
  if (aEsc > bEsc + 2) findings.push({ type: 'escapes-injected', count: aEsc - bEsc });

  // 3. Mass churn: a one-region edit doesn't rewrite half the file.
  const churn = lineChurn(before, after);
  if (churn > 0.5 && before.length > 500) findings.push({ type: 'mass-rewrite', churn: +churn.toFixed(2) });

  // 4. List-marker / heading-style normalization fingerprints.
  const bullets = (s) => ({ dash: (s.match(/^[ \t]*- /gm) ?? []).length, star: (s.match(/^[ \t]*\* /gm) ?? []).length });
  const bb = bullets(before), ab = bullets(after);
  if ((bb.star > 3 && ab.star === 0 && ab.dash >= bb.star) || (bb.dash > 3 && ab.dash === 0 && ab.star >= bb.dash))
    findings.push({ type: 'list-marker-normalized' });

  const damage = findings.some((f) => /-degraded$|-removed$/.test(f.type));
  const suspect = findings.length > 0;
  return {
    verdict: damage ? 'damage' : suspect ? 'suspect' : 'clean',
    findings,
    stats: { churn: +churn.toFixed(3), escapesBefore: bEsc, escapesAfter: aEsc },
  };
}

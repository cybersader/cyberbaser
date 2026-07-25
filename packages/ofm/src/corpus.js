// Corpus reporter: the R09 gate measurement as a reusable library function.
// Runs the round-trip DIAGNOSTIC over every .md file under a directory and
// reports identity rates, a failure histogram, and per-feature pass rates.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { roundtrip, normEqual } from './pipeline.js';

const SKIP_DIRS = new Set(['.git', '.obsidian', '.trash', 'node_modules']);

export function* mdFiles(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* mdFiles(p);
    else if (name.toLowerCase().endsWith('.md')) yield p;
  }
}

export const FEATURES = {
  wikilink: /(?<!!)\[\[[^\]]+\]\]/,
  embed: /!\[\[[^\]]+\]\]/,
  callout: /^> \[![A-Za-z][\w-]*\]/m,
  table: /^\|.*\|/m,
  math: /\$\$/,
  dataview: /^```dataview/m,
  frontmatter: /^---\n/,
  list: /^[ \t]*([-*+]|\d+[.)]) /m,
  code_fence: /^```/m,
  blockquote: /^>/m,
  footnote: /\[\^[^\]]+\]/,
};

function firstDivergenceClass(orig, out) {
  const o = orig.split('\n'), r = out.split('\n');
  let i = 0;
  while (i < Math.min(o.length, r.length) && o[i] === r[i]) i++;
  const a = o.slice(i, i + 3).join('\n'), b = r.slice(i, i + 3).join('\n');
  if (/\\[[\]*_#`~<>|!.\-+(){}]/.test(b) && !/\\[[\]*_#`~<>|!.\-+(){}]/.test(a)) return 'escape-added';
  if (i === 0 && /^---/.test(o[0] ?? '')) return 'frontmatter';
  if ((/^[ \t]*\*/.test(a) && /^[ \t]*-/.test(b)) || (/^[ \t]*-/.test(a) && /^[ \t]*\*/.test(b))) return 'list-marker';
  if (/^\|/.test(a) || /^\|/.test(b)) return 'table-reflow';
  if (/^>/.test(a) || /^>/.test(b)) return 'blockquote';
  if (/^#/.test(a) && /^#/.test(b)) return 'heading';
  if (/\$/.test(a) || /\$/.test(b)) return 'math';
  return 'other';
}

export function runCorpus(dir) {
  const t0 = performance.now();
  const results = [];
  let parseErrors = 0, maskCollisions = 0;
  for (const p of mdFiles(dir)) {
    const rel = relative(dir, p);
    const src = readFileSync(p, 'utf8');
    const feats = Object.entries(FEATURES).filter(([, re]) => re.test(src)).map(([k]) => k);
    let rec = { file: rel, feats };
    try {
      const { out, maskLeak } = roundtrip(src);
      rec.byteOk = out === src;
      rec.normOk = rec.byteOk || normEqual(out, src);
      rec.maskLeak = maskLeak;
      if (!rec.normOk) rec.class = firstDivergenceClass(src, out);
    } catch (e) {
      if (e.name === 'MaskCollisionError') maskCollisions++;
      else parseErrors++;
      rec.err = e.message;
      rec.byteOk = rec.normOk = false;
    }
    results.push(rec);
  }
  const n = results.length;
  const histo = {};
  for (const r of results) if (!r.normOk && r.class) histo[r.class] = (histo[r.class] ?? 0) + 1;
  const featStats = {};
  for (const f of Object.keys(FEATURES)) {
    const withF = results.filter((r) => r.feats.includes(f));
    if (withF.length)
      featStats[f] = { files: withF.length, byteOk: withF.filter((r) => r.byteOk).length, normOk: withF.filter((r) => r.normOk).length };
  }
  return {
    dir, n,
    byteOk: results.filter((r) => r.byteOk).length,
    normOk: results.filter((r) => r.normOk).length,
    maskLeaks: results.filter((r) => r.maskLeak).length,
    parseErrors, maskCollisions, histo, featStats,
    elapsedSec: +((performance.now() - t0) / 1000).toFixed(1),
    results,
  };
}

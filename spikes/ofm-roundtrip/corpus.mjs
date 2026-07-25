// R09 gate measurement: run pipeline D (mask -> remark -> unmask) over a whole
// corpus of real vault files instead of the 21 hand-written fixtures.
// Usage: node corpus.mjs <vault-dir> [--json out.json]
// Reports byte-identical %, trailing-ws-normalized %, and a failure histogram.
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkStringify from 'remark-stringify';
import remarkGfm from 'remark-gfm';
import remarkFrontmatter from 'remark-frontmatter';
import remarkMath from 'remark-math';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const vaultDir = process.argv[2];
if (!vaultDir) { console.error('usage: node corpus.mjs <vault-dir> [--json out.json]'); process.exit(2); }
const jsonIdx = process.argv.indexOf('--json');
const jsonOut = jsonIdx > -1 ? process.argv[jsonIdx + 1] : null;

// Pipeline D, verbatim from roundtrip.mjs (the 20/21 configuration).
const cfgExtended = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkFrontmatter, ['yaml'])
  .use(remarkMath)
  .use(remarkStringify);

const OFM_PATTERNS = [
  { re: /!\[\[[^\]]+\]\]/g },
  { re: /\[\[[^\]]+\]\]/g },
  { re: /\[![A-Za-z][\w-]*\]/g },
];
function mask(src) {
  const store = [];
  let out = src;
  for (const { re } of OFM_PATTERNS) {
    out = out.replace(re, (m) => { const t = `OFMMASK${store.length}OFMMASK`; store.push(m); return t; });
  }
  return { out, store };
}
function unmask(text, store) {
  let out = text;
  store.forEach((orig, i) => { out = out.replaceAll(`OFMMASK${i}OFMMASK`, orig); });
  return out;
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === '.git' || name === '.obsidian' || name === '.trash' || name === 'node_modules') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (name.toLowerCase().endsWith('.md')) yield p;
  }
}

// Feature detection on the ORIGINAL bytes (drives the at-risk analysis).
const FEATURES = {
  wikilink: /(?<!!)\[\[[^\]]+\]\]/,
  embed: /!\[\[[^\]]+\]\]/,
  callout: /^> \[![A-Za-z][\w-]*\]/m,
  table: /^\|.*\|/m,
  math: /\$\$|(?<![\\$])\$[^$\n]+\$(?!\$)/,
  dataview: /^```dataview/m,
  frontmatter: /^---\n/,
  html_block: /^<(div|img|br|details|iframe|span|table|p|h[1-6])/mi,
  list: /^[ \t]*([-*+]|\d+[.)]) /m,
  code_fence: /^```/m,
  blockquote: /^>/m,
  footnote: /\[\^[^\]]+\]/,
  tag_inline: /(^|\s)#[A-Za-z][\w/-]*/m,
};

// Failure classification: look at the first diverging region.
function classify(orig, out) {
  const o = orig.split('\n'), r = out.split('\n');
  let i = 0;
  while (i < Math.min(o.length, r.length) && o[i] === r[i]) i++;
  const a = o.slice(i, i + 3).join('\n'), b = r.slice(i, i + 3).join('\n');
  const classes = [];
  if (/\\[[\]*_#`~<>|!.\-+(){}]/.test(b) && !/\\[[\]*_#`~<>|!.\-+(){}]/.test(a)) classes.push('escape-added');
  if (i === 0 && /^---/.test(o[0] ?? '')) classes.push('frontmatter');
  if (/^[ \t]*\*/.test(a) && /^[ \t]*-/.test(b) || /^[ \t]*-/.test(a) && /^[ \t]*\*/.test(b)) classes.push('list-marker');
  if (/^\d+\)/.test(a.trim()) && /^\d+\./.test(b.trim())) classes.push('ordered-marker');
  if (/^\|/.test(a) || /^\|/.test(b)) classes.push('table-reflow');
  if (/^>/.test(a) || /^>/.test(b)) classes.push('blockquote');
  if (/^#/.test(a) && /^#/.test(b) && a !== b) classes.push('heading');
  if ((a.match(/ {2,}/) || b.match(/ {2,}/)) && a.replace(/[ \t]+/g, ' ') === b.replace(/[ \t]+/g, ' ')) classes.push('whitespace-only');
  if (a.trim() === '' || b.trim() === '') classes.push('blank-line-structure');
  if (/\$\$|\$/.test(a) || /\$\$|\$/.test(b)) classes.push('math');
  if (/OFMMASK/.test(out)) classes.push('MASK-LEAK');
  if (classes.length === 0) classes.push('other');
  return { line: i + 1, classes, sample: { in: a.slice(0, 200), out: b.slice(0, 200) } };
}

const t0 = performance.now();
const results = [];
let maskCollisions = 0, parseErrors = 0;

for (const p of walk(vaultDir)) {
  const rel = relative(vaultDir, p);
  let src;
  try { src = readFileSync(p, 'utf8'); } catch { continue; }
  if (src.includes('OFMMASK')) maskCollisions++;
  const feats = Object.entries(FEATURES).filter(([, re]) => re.test(src)).map(([k]) => k);
  let out, err = null;
  try {
    const { out: masked, store } = mask(src);
    out = unmask(cfgExtended.processSync(masked).toString(), store);
  } catch (e) { err = e.message; parseErrors++; }
  const byteOk = !err && out === src;
  const normOk = !err && !byteOk && out.replace(/\s+$/gm, '').replace(/\n+$/, '') === src.replace(/\s+$/gm, '').replace(/\n+$/, '');
  const rec = { file: rel, bytes: src.length, feats, byteOk, normOk: byteOk || normOk, err };
  if (!byteOk && !err) rec.diag = classify(src, out);
  results.push(rec);
}
const elapsed = ((performance.now() - t0) / 1000).toFixed(1);

const n = results.length;
const byteOk = results.filter(r => r.byteOk).length;
const normOk = results.filter(r => r.normOk).length;
const fails = results.filter(r => !r.normOk);

const histo = {};
for (const r of fails) for (const c of (r.diag?.classes ?? [r.err ? 'parse-error' : '?'])) histo[c] = (histo[c] || 0) + 1;

// Per-feature pass rates (the "population at risk" view).
const featStats = {};
for (const f of Object.keys(FEATURES)) {
  const withF = results.filter(r => r.feats.includes(f));
  if (!withF.length) continue;
  featStats[f] = { files: withF.length, byteOk: withF.filter(r => r.byteOk).length, normOk: withF.filter(r => r.normOk).length };
}
const plain = results.filter(r => r.feats.filter(f => !['frontmatter', 'list', 'code_fence', 'blockquote', 'table', 'footnote', 'html_block', 'tag_inline'].includes(f)).length === 0);

console.log(`\n=== R09 GATE: corpus round-trip (pipeline D) ===`);
console.log(`corpus: ${vaultDir}`);
console.log(`files: ${n}   elapsed: ${elapsed}s   parse errors: ${parseErrors}   mask-token collisions: ${maskCollisions}`);
console.log(`byte-identical:        ${byteOk}/${n}  (${(100 * byteOk / n).toFixed(2)}%)`);
console.log(`+ trailing-ws-equiv:   ${normOk}/${n}  (${(100 * normOk / n).toFixed(2)}%)`);
console.log(`files with no OFM-specific constructs (wikilink/embed/callout/math/dataview): ${plain.length} (${(100 * plain.length / n).toFixed(1)}%)`);
console.log(`\nfailure histogram (normalized fails, first-divergence class):`);
for (const [c, k] of Object.entries(histo).sort((a, b) => b[1] - a[1])) console.log(`  ${c.padEnd(24)} ${k}`);
console.log(`\nper-feature pass rates (files containing the feature):`);
console.log(`  ${'feature'.padEnd(14)} ${'files'.padStart(6)} ${'byteOk'.padStart(8)} ${'normOk'.padStart(8)}`);
for (const [f, s] of Object.entries(featStats).sort((a, b) => b[1].files - a[1].files))
  console.log(`  ${f.padEnd(14)} ${String(s.files).padStart(6)} ${String(s.byteOk).padStart(8)} ${String(s.normOk).padStart(8)}`);

if (jsonOut) {
  writeFileSync(jsonOut, JSON.stringify({ vaultDir, n, byteOk, normOk, parseErrors, maskCollisions, elapsedSec: +elapsed, histo, featStats, plainCount: plain.length, fails: fails.slice(0, 400) }, null, 2));
  console.log(`\nfull JSON -> ${jsonOut}`);
}

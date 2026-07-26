#!/usr/bin/env node
// cb-linkcheck — internal link checker for a built site.
//
//   cb-linkcheck <siteDir> [--json out] [--max-broken N] [--class-budget class=N,...]
//                          [--base-path <prefix>]
//
// Exit codes: 0 = within budget · 1 = over budget · 2 = usage
// With no budget flags it is report-only, so CI can adopt it before the site is clean.
import { writeFileSync } from 'node:fs';
import { checkSite, CLASS_ORDER } from '../src/check.js';

const argv = process.argv.slice(2);

function usage(msg) {
  if (msg) console.error(`cb-linkcheck: ${msg}`);
  console.error('usage: cb-linkcheck <siteDir> [--json out] [--max-broken N] [--class-budget class=N,...] [--base-path prefix]');
  process.exit(2);
}

const positional = [];
let jsonOut = null;
let maxBroken = null;
let basePath = '';
const classBudget = {};

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--json') jsonOut = argv[++i] ?? usage('--json needs a path');
  else if (a === '--base-path') basePath = argv[++i] ?? usage('--base-path needs a prefix');
  else if (a === '--max-broken') {
    const v = Number(argv[++i]);
    if (!Number.isFinite(v)) usage('--max-broken needs a number');
    maxBroken = v;
  } else if (a === '--class-budget') {
    const spec = argv[++i] ?? usage('--class-budget needs class=N,...');
    for (const part of spec.split(',').filter(Boolean)) {
      const [k, v] = part.split('=');
      const n = Number(v);
      if (!k || !Number.isFinite(n)) usage(`bad --class-budget entry: ${part}`);
      if (!CLASS_ORDER.includes(k)) usage(`unknown class: ${k} (known: ${CLASS_ORDER.join(', ')})`);
      classBudget[k] = n;
    }
  } else if (a === '-h' || a === '--help') usage();
  else if (a.startsWith('-')) usage(`unknown flag: ${a}`);
  else positional.push(a);
}

const siteDir = positional[0];
if (!siteDir || positional.length > 1) usage('exactly one siteDir');

const r = checkSite(siteDir, { basePath });
const pct = r.total ? (100 * r.broken.length) / r.total : 0;

console.log(`site: ${siteDir}`);
console.log(`pages: ${r.pages}  internal links: ${r.total} unique (${r.occurrences} occurrences)`);
console.log(`ok: ${r.ok}  broken: ${r.broken.length} (${pct.toFixed(2)}%)`);

if (r.broken.length) {
  console.log('\nby class');
  const w = Math.max(...Object.keys(r.byClass).map((k) => k.length));
  for (const c of CLASS_ORDER) {
    if (!r.byClass[c]) continue;
    const n = r.byClass[c];
    console.log(`  ${c.padEnd(w)}  ${String(n).padStart(6)}  ${((100 * n) / r.broken.length).toFixed(1)}%`);
  }

  const top = Object.entries(r.byPage).slice(0, 15);
  console.log(`\ntop ${top.length} offending pages (of ${Object.keys(r.byPage).length} with any break)`);
  for (const [p, n] of top) console.log(`  ${String(n).padStart(4)}  ${p}`);

  console.log('\nsample broken links');
  for (const b of r.broken.slice(0, 10)) console.log(`  [${b.class}] ${b.page} -> ${b.href}`);
}

if (jsonOut) {
  writeFileSync(jsonOut, `${JSON.stringify(r, null, 2)}\n`);
  console.log(`\njson -> ${jsonOut}`);
}

const failures = [];
if (maxBroken !== null && r.broken.length > maxBroken) {
  failures.push(`broken ${r.broken.length} > --max-broken ${maxBroken}`);
}
for (const [c, n] of Object.entries(classBudget)) {
  const got = r.byClass[c] ?? 0;
  if (got > n) failures.push(`class ${c}: ${got} > budget ${n}`);
}

if (failures.length) {
  console.error('\nOVER BUDGET');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
process.exit(0);

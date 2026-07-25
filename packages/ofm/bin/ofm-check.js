#!/usr/bin/env node
// ofm-check — the OFM validator CLI.
//
//   ofm-check corpus <dir> [--json <out>]      round-trip diagnostic over a vault
//   ofm-check diff <before.md> <after.md>      classify a change: clean|suspect|damage
//   ofm-check roundtrip <file.md> [...]        per-file diagnostic (prints first divergence)
//
// Exit codes: 0 = clean/ok · 1 = damage (diff) or mask leak (corpus) · 2 = usage
import { readFileSync, writeFileSync } from 'node:fs';
import { runCorpus } from '../src/corpus.js';
import { checkChange } from '../src/check.js';
import { roundtrip, normEqual } from '../src/pipeline.js';

const [cmd, ...args] = process.argv.slice(2);

function usage() {
  console.error('usage: ofm-check corpus <dir> [--json out] | diff <before> <after> [--json out] | roundtrip <file...>');
  process.exit(2);
}

if (cmd === 'corpus') {
  const dir = args[0];
  if (!dir) usage();
  const jsonIdx = args.indexOf('--json');
  const r = runCorpus(dir);
  console.log(`corpus: ${r.dir}`);
  console.log(`files: ${r.n}  elapsed: ${r.elapsedSec}s  parse errors: ${r.parseErrors}  mask collisions: ${r.maskCollisions}  MASK LEAKS: ${r.maskLeaks}`);
  console.log(`byte-identical: ${r.byteOk}/${r.n} (${((100 * r.byteOk) / r.n).toFixed(2)}%)`);
  console.log(`norm-equal:     ${r.normOk}/${r.n} (${((100 * r.normOk) / r.n).toFixed(2)}%)`);
  console.log('histogram:', Object.entries(r.histo).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' '));
  if (jsonIdx > -1) {
    const { results, ...summary } = r;
    writeFileSync(args[jsonIdx + 1], JSON.stringify({ ...summary, fails: results.filter((x) => !x.normOk).slice(0, 500) }, null, 2));
    console.log(`json -> ${args[jsonIdx + 1]}`);
  }
  process.exit(r.maskLeaks > 0 || r.parseErrors > 0 ? 1 : 0);
} else if (cmd === 'diff') {
  const [beforePath, afterPath] = args;
  if (!beforePath || !afterPath) usage();
  const before = readFileSync(beforePath, 'utf8');
  const after = readFileSync(afterPath, 'utf8');
  const r = checkChange(before, after);
  const jsonIdx = args.indexOf('--json');
  if (jsonIdx > -1) writeFileSync(args[jsonIdx + 1], JSON.stringify(r, null, 2));
  console.log(`verdict: ${r.verdict}  (churn ${r.stats.churn}, escapes ${r.stats.escapesBefore}->${r.stats.escapesAfter})`);
  for (const f of r.findings) console.log(`  - ${f.type}${f.construct ? `: ${f.construct}` : ''}${f.count ? `: +${f.count}` : ''}${f.churn ? `: ${f.churn}` : ''}`);
  process.exit(r.verdict === 'damage' ? 1 : 0);
} else if (cmd === 'roundtrip') {
  if (!args.length) usage();
  let worst = 0;
  for (const p of args) {
    const src = readFileSync(p, 'utf8');
    try {
      const { out, maskLeak } = roundtrip(src);
      const status = out === src ? 'byte-identical' : normEqual(out, src) ? 'norm-equal' : 'DIVERGES';
      console.log(`${p}: ${status}${maskLeak ? ' [MASK LEAK]' : ''}`);
      if (status === 'DIVERGES') {
        const o = src.split('\n'), r2 = out.split('\n');
        let i = 0;
        while (i < Math.min(o.length, r2.length) && o[i] === r2[i]) i++;
        console.log(`  line ${i + 1}:`);
        console.log(`   in : ${JSON.stringify(o[i] ?? '')}`);
        console.log(`   out: ${JSON.stringify(r2[i] ?? '')}`);
      }
      if (maskLeak) worst = 1;
    } catch (e) {
      console.log(`${p}: ERROR ${e.message}`);
      worst = 1;
    }
  }
  process.exit(worst);
} else usage();

#!/usr/bin/env node
// cb-trust — classify a proposed contribution into a review route.
//
//   cb-trust <config.yml> --json <change.json> [--out <result.json>]
//
// Prints the tier, route and reasons. Exit code is ALWAYS 0: this classifies,
// it does not gate. Whatever consumes the route decides what to do about it.
// A missing or unreadable config is not an error either — it is the fail-closed
// answer (`full-review`, reason `no-trust-config`), which is the useful one.
import { readFileSync, writeFileSync } from 'node:fs';
import { classify, parseConfig } from '../src/classify.js';

const argv = process.argv.slice(2);

function usage() {
  console.error('usage: cb-trust <config.yml> --json <change.json> [--out <result.json>]');
  process.exit(2);
}

let configPath = null, changePath = null, outPath = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--json') changePath = argv[++i];
  else if (argv[i] === '--out') outPath = argv[++i];
  else if (!configPath) configPath = argv[i];
}
if (!configPath || !changePath) usage();

let config = null;
try {
  config = parseConfig(readFileSync(configPath, 'utf8'));
} catch {
  config = null; // absent config => fail closed, reported below
}

let change;
try {
  change = JSON.parse(readFileSync(changePath, 'utf8'));
} catch (e) {
  console.error(`cb-trust: cannot read change JSON: ${e.message}`);
  process.exit(2);
}

const result = classify(change, config);

console.log(`tier:   ${result.tier}`);
console.log(`route:  ${result.route}`);
console.log('reasons:');
for (const r of result.reasons) console.log(`  - ${r}`);
const c = result.checks;
if (c?.lines) {
  console.log(
    `checks: ofm=${c.ofm.verdict} lines=${c.lines.changed}/${c.lines.cap} files=${c.files.count}/${c.files.cap}` +
    ` deletions=${c.deletions.length} new=${c.newFiles.added.length}(${c.newFiles.disallowed.length} disallowed)` +
    ` frontmatter=[${c.frontmatter.changed.join(',')}] source=${c.source.hasUrl ? 'cited' : 'none'}(+${c.source.netWords}w)`,
  );
  for (const f of c.ofm.findings) console.log(`  ofm: ${f.path}: ${f.type}${f.construct ? ` ${f.construct}` : ''}`);
}

if (outPath) writeFileSync(outPath, JSON.stringify(result, null, 2));
process.exit(0);

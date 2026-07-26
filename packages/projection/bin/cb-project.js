#!/usr/bin/env node
// cb-project <vaultDir> <outDir> [--report path] [--audience name] [--no-verify] [--no-clean]
//
// Exits non-zero on any build failure, so CI stops before a renderer ever sees the tree.

import path from 'node:path';
import { project } from '../src/project.js';

function parseArgs(argv) {
  const positional = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--report') opts.reportPath = path.resolve(argv[++i] ?? '');
    else if (a === '--audience') opts.audience = argv[++i];
    else if (a === '--sample') opts.sampleSize = Number(argv[++i]);
    else if (a === '--no-verify') opts.verify = false;
    else if (a === '--no-clean') opts.clean = false;
    else if (a === '-h' || a === '--help') opts.help = true;
    else if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
    else positional.push(a);
  }
  return { positional, opts };
}

const USAGE = 'usage: cb-project <vaultDir> <outDir> [--report path] [--audience name] [--sample n] [--no-verify] [--no-clean]';

function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`${e.message}\n${USAGE}`);
    process.exit(2);
  }
  const { positional, opts } = parsed;
  if (opts.help || positional.length !== 2) {
    console.error(USAGE);
    process.exit(opts.help ? 0 : 2);
  }

  const [vaultDir, outDir] = positional;
  const started = Date.now();
  let result;
  try {
    result = project(vaultDir, outDir, opts);
  } catch (e) {
    console.error(`projection failed: ${e.message}`);
    process.exit(1);
  }

  const c = result.counts;
  console.log(`pages ${c.pages}  assets ${c.assets}  aliases injected ${c.aliasesInjected}  warnings ${c.warnings}  ${Date.now() - started}ms`);
  if (result.leakTest) {
    console.log(
      `leak test: ${result.leakTest.ok ? 'pass' : 'FAIL'} (${result.leakTest.checked.actual} files checked, ` +
        `${result.leakTest.checked.sampledTitles} denied titles sampled, ${result.leakTest.titleMatchCount} title match(es) reported)`,
    );
  }
  if (result.pathLint) {
    const pl = result.pathLint;
    const byRule = Object.entries(pl.byRule).map(([k, n]) => `${k} ${n}`).join(', ') || 'none';
    console.log(
      `path lint: ${pl.paths} paths, ${pl.violations} violation(s) [${byRule}], ` +
        `${pl.collisionGroups} slug collision group(s) (${pl.caseOnlyCollisionGroups} case-only), ` +
        `${pl.emoji.pathsWithEmoji} path(s) with emoji`,
    );
  }
  if (result.reportPath) console.log(`report: ${result.reportPath}`);

  for (const w of result.warnings.slice(0, 20)) console.warn(`warning [${w.kind}] ${w.path ?? ''} ${w.message ?? ''}`.trim());
  if (result.warnings.length > 20) console.warn(`... ${result.warnings.length - 20} more warnings (see the report)`);

  if (!result.ok) {
    console.error(`\n${result.failures.length} failure(s):`);
    for (const f of result.failures.slice(0, 50)) console.error(`  [${f.kind}] ${f.path ?? ''} ${f.message ?? ''}`.trimEnd());
    if (result.failures.length > 50) console.error(`  ... ${result.failures.length - 50} more`);
    process.exit(1);
  }
}

main();

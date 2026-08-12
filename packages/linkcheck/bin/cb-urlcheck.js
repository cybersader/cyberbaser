#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkUrlContinuity, UrlContinuityError } from '../src/url-continuity.js';

const argv = process.argv.slice(2);

function usage(message = null) {
  if (message !== null) console.error(`cb-urlcheck: ${message}`);
  console.error('usage: cb-urlcheck <previous-sitemap.xml> <candidate-site-dir> [--base-path prefix] [--json out]');
  process.exit(2);
}

const positional = [];
let basePath = '';
let jsonOut = null;
for (let index = 0; index < argv.length; index += 1) {
  const argument = argv[index];
  if (argument === '--base-path') basePath = argv[++index] ?? usage('--base-path needs a prefix');
  else if (argument === '--json') jsonOut = argv[++index] ?? usage('--json needs a path');
  else if (argument === '-h' || argument === '--help') usage();
  else if (argument.startsWith('-')) usage(`unknown flag: ${argument}`);
  else positional.push(argument);
}
if (positional.length !== 2) usage('expected one previous sitemap and one candidate site directory');

const [previousPath, siteDir] = positional;
try {
  const report = checkUrlContinuity({
    previousSitemap: readFileSync(previousPath),
    candidateSitemap: readFileSync(join(siteDir, 'sitemap.xml')),
    siteDir,
    basePath,
  });
  console.log(`origin: ${report.origin}`);
  console.log(`base path: ${report.basePath === '' ? '/' : `/${report.basePath}/`}`);
  console.log(`previous: ${report.counts.previous}  candidate: ${report.counts.candidate}`);
  console.log(`unchanged: ${report.counts.unchanged}  added: ${report.counts.added}  removed: ${report.counts.removed}`);
  console.log(`redirect-covered: ${report.counts.covered}  failures: ${report.counts.failures}`);
  for (const item of report.failures.slice(0, 10)) {
    console.error(`  [${item.code}] ${item.url}`);
  }
  if (jsonOut !== null) writeFileSync(jsonOut, `${JSON.stringify(report, null, 2)}\n`);
  process.exit(report.ok ? 0 : 1);
} catch (error) {
  if (error instanceof UrlContinuityError) {
    console.error(`cb-urlcheck: ${error.code}: ${error.message}`);
  } else if (error?.code === 'ENOENT') {
    console.error(`cb-urlcheck: input-unavailable: ${error.path ?? 'required input'} does not exist`);
  } else {
    console.error('cb-urlcheck: invalid-input: URL continuity inputs could not be checked');
  }
  process.exit(2);
}

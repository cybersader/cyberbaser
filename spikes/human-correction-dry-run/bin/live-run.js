#!/usr/bin/env bun

import { readFile } from 'node:fs/promises';
import { stableStringify } from '../src/case.js';
import { runLiveCorrection } from '../src/live-run.js';
import { buildLiveReviewCard } from '../src/live-review-card.js';

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) {
      throw Object.assign(new Error('arguments must be provided as --name value pairs'), { code: 'invalid-arguments' });
    }
    const name = key.slice(2);
    if (Object.hasOwn(options, name)) {
      throw Object.assign(new Error(`duplicate argument: --${name}`), { code: 'duplicate-argument' });
    }
    options[name] = value;
  }
  return options;
}

async function readJson(file, label) {
  if (!file) throw Object.assign(new Error(`${label} is required`), { code: `missing-${label}` });
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    throw Object.assign(new Error(`${label} must identify readable JSON`), { code: `invalid-${label}` });
  }
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (!options.checkout) throw Object.assign(new Error('checkout is required'), { code: 'missing-checkout' });
  if (!options.commit) throw Object.assign(new Error('commit is required'), { code: 'missing-commit' });
  const format = options.format ?? 'json';
  if (!['json', 'html'].includes(format)) {
    throw Object.assign(new Error('format must be json or html'), { code: 'invalid-format' });
  }

  const caseData = await readJson(options.case, 'case');
  const ownerPolicy = await readJson(options.policy, 'policy');
  const liveRun = await runLiveCorrection({
    caseData,
    checkoutDir: options.checkout,
    pinnedCommit: options.commit,
    ownerPolicy,
    policyRevision: options['policy-revision'] ?? 'owner-supplied-unversioned',
    trustSubject: {
      authorType: options['author-type'] ?? 'anonymous',
      author: options.author ?? '',
    },
    ...(options['base-path'] !== undefined ? { basePath: options['base-path'] } : {}),
    ...(options['quartz-repo'] !== undefined ? { quartzRepository: options['quartz-repo'] } : {}),
  });
  const card = buildLiveReviewCard(liveRun);
  process.stdout.write(format === 'html' ? card.html : card.json);
} catch (error) {
  process.stderr.write(stableStringify({
    error: {
      code: error?.code ?? 'live-run-failed',
      message: error?.message ?? 'live run failed',
    },
  }));
  process.exitCode = 1;
}

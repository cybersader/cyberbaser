#!/usr/bin/env bun

import { stableStringify } from '../src/case.js';
import { parseStrictArgs } from '../src/cli.js';
import { renderPilotAttempt } from '../src/pilot-run.js';
import { recordPilotError } from '../src/pilot-workspace.js';

let attemptId = 'unknown';
try {
  const options = parseStrictArgs(process.argv.slice(2), {
    allowed: ['attempt', 'baseline-site', 'candidate-site'],
    required: ['attempt'],
  });
  attemptId = options.attempt;
  const result = await renderPilotAttempt({
    attemptId,
    ...(options['baseline-site'] !== undefined ? { baselineSite: options['baseline-site'] } : {}),
    ...(options['candidate-site'] !== undefined ? { candidateSite: options['candidate-site'] } : {}),
  });
  process.stdout.write(stableStringify(result));
} catch (error) {
  process.stderr.write(stableStringify(await recordPilotError({ attemptId, error })));
  process.exitCode = 1;
}

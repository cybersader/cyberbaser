#!/usr/bin/env bun

import { stableStringify } from '../src/case.js';
import { parseStrictArgs } from '../src/cli.js';
import { preparePilotAttempt } from '../src/pilot-run.js';
import { recordPilotError } from '../src/pilot-workspace.js';

let attemptId = 'unknown';
try {
  const options = parseStrictArgs(process.argv.slice(2), {
    allowed: ['attempt'],
    required: ['attempt'],
  });
  attemptId = options.attempt;
  process.stdout.write(stableStringify(await preparePilotAttempt({ attemptId })));
} catch (error) {
  process.stderr.write(stableStringify(await recordPilotError({ attemptId, error })));
  process.exitCode = 1;
}

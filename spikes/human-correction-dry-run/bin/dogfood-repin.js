#!/usr/bin/env bun

import { stableStringify } from '../src/case.js';
import { parseStrictArgs } from '../src/cli.js';
import { repinOwnerDogfoodAttempt } from '../src/pilot-run.js';
import { recordPilotError } from '../src/pilot-workspace.js';

let attemptId = 'unknown';
try {
  const options = parseStrictArgs(process.argv.slice(2), {
    allowed: ['attempt', 'checkout', 'authorize-source', 'reason'],
    required: ['attempt', 'checkout', 'authorize-source', 'reason'],
  });
  attemptId = options.attempt;
  process.stdout.write(stableStringify(await repinOwnerDogfoodAttempt({
    attemptId,
    checkoutDir: options.checkout,
    sourceAuthorization: options['authorize-source'],
    reason: options.reason,
  })));
} catch (error) {
  process.stderr.write(stableStringify(await recordPilotError({ attemptId, error })));
  process.exitCode = 1;
}

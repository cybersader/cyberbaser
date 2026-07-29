#!/usr/bin/env bun

import { stableStringify } from '../src/case.js';
import { parseStrictArgs } from '../src/cli.js';
import { initializeAttempt, recordPilotError } from '../src/pilot-workspace.js';

let attemptId = 'unknown';
try {
  const options = parseStrictArgs(process.argv.slice(2), {
    allowed: ['attempt', 'profile', 'checkout', 'source', 'url', 'authorize-source'],
    required: ['attempt', 'profile'],
  });
  attemptId = options.attempt;
  const result = await initializeAttempt({
    attemptId,
    profile: options.profile,
    checkoutDir: options.checkout,
    sourcePath: options.source,
    publicUrl: options.url,
    sourceAuthorization: options['authorize-source'],
  });
  process.stdout.write(stableStringify(result));
} catch (error) {
  process.stderr.write(stableStringify(await recordPilotError({ attemptId, error, attemptScoped: false })));
  process.exitCode = 1;
}

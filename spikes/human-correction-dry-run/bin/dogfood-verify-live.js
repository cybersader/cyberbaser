#!/usr/bin/env bun

import { stableStringify } from '../src/case.js';
import { parseStrictArgs } from '../src/cli.js';
import { verifyPostApplicationLive } from '../src/post-application-verification.js';

try {
  const options = parseStrictArgs(process.argv.slice(2), {
    allowed: ['attempt', 'checkout', 'application-commit', 'deployment-run-id', 'wait-seconds'],
    required: ['attempt', 'checkout', 'application-commit', 'deployment-run-id', 'wait-seconds'],
  });
  process.stdout.write(stableStringify(await verifyPostApplicationLive({
    attemptId: options.attempt,
    checkoutDir: options.checkout,
    applicationCommit: options['application-commit'],
    deploymentRunId: options['deployment-run-id'],
    waitSeconds: options['wait-seconds'],
  })));
} catch (error) {
  process.stderr.write(stableStringify({
    code: error?.code ?? 'post-application-verification-failed',
    message: error?.message ?? 'post-application live verification failed',
    details: error?.details ?? {},
  }));
  process.exitCode = 1;
}

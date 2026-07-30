#!/usr/bin/env bun

import { parseStrictArgs } from '../src/cli.js';
import {
  parseExpiresMinutes,
  prepareDogfoodReaderServer,
} from '../src/dogfood-reader-server.js';
import { validateAttemptId } from '../src/pilot-input.js';

let running;
try {
  const options = parseStrictArgs(process.argv.slice(2), {
    allowed: ['attempt', 'expires-minutes'],
    required: ['attempt'],
  });
  const attemptId = validateAttemptId(options.attempt);
  const expiresMinutes = parseExpiresMinutes(options['expires-minutes']);
  running = await prepareDogfoodReaderServer({ attemptId, expiresMinutes });
  process.stdout.write(`${JSON.stringify({
    status: 'ready',
    url: running.dnsUrl ?? running.ipUrl,
    fallbackUrl: running.dnsUrl ? running.ipUrl : null,
    expiresAt: new Date(running.expiresAt).toISOString(),
    oneShot: true,
    methods: ['GET', 'HEAD'],
    acceptsSubmissions: false,
    byteLength: running.snapshot.byteLength,
    sha256: running.snapshot.sha256,
    warning: 'Treat the random URL as an expiring secret. HTTP is carried inside Tailscale, not browser TLS.',
  })}\n`);
  const outcome = await running.completion;
  process.stdout.write(`${JSON.stringify({ status: 'stopped', reason: outcome.reason })}\n`);
} catch (error) {
  if (running) await running.stop('failed', true).catch(() => {});
  process.stderr.write(`${JSON.stringify({
    code: error?.code ?? 'dogfood-serve-failed',
    message: error?.message ?? 'dogfood form handoff failed',
  })}\n`);
  process.exitCode = 1;
}

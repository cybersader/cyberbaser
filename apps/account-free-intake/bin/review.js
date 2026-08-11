#!/usr/bin/env bun
import { loadConfig, runReviewCommand } from '../src/index.js';

function usage() {
  process.stderr.write('usage: account-free-review --config /absolute/config.json list [--state pending-review|expired] [--format text|html]\n');
  process.stderr.write('       account-free-review --config /absolute/config.json show Q-uuid [--format text|html]\n');
  process.exit(2);
}

const args = process.argv.slice(2);
if (args[0] !== '--config' || typeof args[1] !== 'string') usage();
const configPath = args[1];
const command = args[2];
if (!['list', 'show'].includes(command)) usage();
let index = 3;
let queueId = null;
if (command === 'show') {
  queueId = args[index];
  if (typeof queueId !== 'string' || queueId.startsWith('--')) usage();
  index += 1;
}
let format = 'text';
let state = null;
while (index < args.length) {
  const flag = args[index];
  const value = args[index + 1];
  if (flag === '--format' && ['text', 'html'].includes(value)) format = value;
  else if (flag === '--state' && command === 'list' && ['pending-review', 'expired'].includes(value)) state = value;
  else usage();
  index += 2;
}

try {
  const config = await loadConfig(configPath);
  process.stdout.write(await runReviewCommand({ config, command, queueId, format, state }));
} catch (error) {
  process.stderr.write(`account-free review failed: ${error?.code ?? 'review-error'}\n`);
  process.exit(1);
}

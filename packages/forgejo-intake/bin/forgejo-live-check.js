#!/usr/bin/env bun
// forgejo-live-check — read one real Forgejo pull request through the Lane A
// adapter and report whether it reconstructs as one exact proposal.
//
//   bun packages/forgejo-intake/bin/forgejo-live-check.js \
//     --config <lane-a config json> --checkout <local clone of the Forgejo repo> \
//     --pull <number> [--token-file <mode-0600 file>] [--json]
//
// Exit codes: 0 reconstructed · 2 refused by the adapter (the report says why) · 1 error.
// Read-only: no queue entry, decision, source write, push, or publication.
import path from 'node:path';
import {
  createTokenFileReader,
  formatLiveCheckReport,
  loadForgejoIntakeConfig,
  runForgejoLiveCheck,
} from '../src/live-check.js';

export function parseArguments(argv) {
  const options = { config: null, checkout: null, pull: null, tokenFile: null, json: false };
  const usage = () => { throw new Error('usage: forgejo-live-check --config <file> --checkout <clone> --pull <number> [--token-file <file>] [--json]'); };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = () => {
      index += 1;
      if (index >= argv.length) usage();
      return argv[index];
    };
    if (argument === '--config') options.config = value();
    else if (argument === '--checkout') options.checkout = value();
    else if (argument === '--pull') options.pull = value();
    else if (argument === '--token-file') options.tokenFile = value();
    else if (argument === '--json') options.json = true;
    else usage();
  }
  if (!options.config || !options.checkout || !/^[1-9][0-9]{0,9}$/u.test(options.pull ?? '')) usage();
  return options;
}

if (import.meta.main) {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
  try {
    const config = await loadForgejoIntakeConfig(path.resolve(options.config));
    const outcome = await runForgejoLiveCheck({
      config,
      checkout: path.resolve(options.checkout),
      pullRequestNumber: Number(options.pull),
      getToken: options.tokenFile ? createTokenFileReader(path.resolve(options.tokenFile)) : null,
    });
    process.stdout.write(options.json
      ? `${JSON.stringify({ ...outcome.report, proposalText: outcome.result?.proposalText ?? null }, null, 2)}\n`
      : `${formatLiveCheckReport(outcome.report)}\n`);
    process.exit(outcome.ok ? 0 : 2);
  } catch (error) {
    process.stderr.write(`forgejo-live-check failed: ${error?.code ?? error?.message ?? 'unexpected-error'}\n`);
    process.exit(1);
  }
}

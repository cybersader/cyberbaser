#!/usr/bin/env bun
import { loadConfig, startIntakeRuntime } from '../src/index.js';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--config') {
  process.stderr.write('usage: account-free-intake --config /absolute/config.json\n');
  process.exit(2);
}

let runtime;
try {
  const config = await loadConfig(args[1]);
  runtime = await startIntakeRuntime({ config });
  process.stdout.write(`account-free intake ready on ${runtime.server.hostname}:${runtime.server.port}\n`);

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await runtime.close();
      process.exit(0);
    } catch {
      await runtime.close().catch(() => {});
      process.stderr.write('account-free intake shutdown failed\n');
      process.exit(1);
    }
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
} catch (error) {
  await runtime?.close().catch(() => {});
  process.stderr.write(`account-free intake failed: ${error?.code ?? 'startup-error'}\n`);
  process.exit(1);
}

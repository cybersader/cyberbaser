#!/usr/bin/env bun
import { loadConfig, openIntakeService, startBunServer } from '../src/index.js';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--config') {
  process.stderr.write('usage: account-free-intake --config /absolute/config.json\n');
  process.exit(2);
}

let service;
try {
  const config = await loadConfig(args[1]);
  service = await openIntakeService({ config });
  const server = startBunServer({ config, service });
  process.stdout.write(`account-free intake ready on ${server.hostname}:${server.port}\n`);

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    server.stop(false);
    await service.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
} catch (error) {
  await service?.close().catch(() => {});
  process.stderr.write(`account-free intake failed: ${error?.code ?? 'startup-error'}\n`);
  process.exit(1);
}

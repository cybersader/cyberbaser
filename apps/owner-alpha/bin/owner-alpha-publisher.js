#!/usr/bin/env bun

import { loadOwnerAlphaConfig } from '../src/config.js';
import { startPublisher } from '../src/publisher/server.js';
import { DEFAULT_OWNER_ALPHA_PROJECT_ROOT } from '../src/site.js';
import { storeContextFromConfig } from '../src/store.js';

export async function runPublisherCli({ configFile, socketPath, repository, projectRoot = DEFAULT_OWNER_ALPHA_PROJECT_ROOT }) {
  let publisher;
  let stopRequested = false;
  let stopped;
  const stopping = new Promise((resolve) => { stopped = resolve; });
  const stop = () => { stopRequested = true; stopped(); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    const config = await loadOwnerAlphaConfig(configFile);
    publisher = await startPublisher({ config, context: storeContextFromConfig(config, projectRoot), socketPath, repository });
    if (!stopRequested) process.stdout.write('owner-alpha publisher ready\n');
    await stopping;
  } finally {
    try { await publisher?.close(); }
    finally {
      process.off('SIGTERM', stop);
      process.off('SIGINT', stop);
    }
  }
}

if (import.meta.main) {
  if (process.argv.length !== 5) {
    process.stderr.write('usage: owner-alpha-publisher <config-file> <socket-path> <publisher-repo>\n');
    process.exitCode = 1;
  } else {
    try {
      await runPublisherCli({ configFile: process.argv[2], socketPath: process.argv[3], repository: process.argv[4] });
    } catch {
      process.stderr.write('owner-alpha publisher failed\n');
      process.exitCode = 1;
    }
  }
}

#!/usr/bin/env bun

import { loadOwnerAlphaConfig } from '../src/config.js';
import { createForgeAccess, createGithubAppAccess } from '../src/publisher/forge-access.js';
import { startForgeControl } from '../src/publisher/forge-control.js';
import { startPublisher } from '../src/publisher/server.js';
import { DEFAULT_OWNER_ALPHA_PROJECT_ROOT } from '../src/site.js';
import { storeContextFromConfig } from '../src/store.js';

export async function runPublisherCli({ configFile, socketPath, repository, projectRoot = DEFAULT_OWNER_ALPHA_PROJECT_ROOT, socketGroup = null }) {
  let publisher;
  let stopRequested = false;
  let stopped;
  const stopping = new Promise((resolve) => { stopped = resolve; });
  const stop = () => { stopRequested = true; stopped(); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    const config = await loadOwnerAlphaConfig(configFile);
    publisher = await startPublisher({ config, context: storeContextFromConfig(config, projectRoot), socketPath, repository, socketGroup });
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

// The pasted-token fallback. Run as the publisher's account; the token is read
// from standard input so it never appears in a process list or shell history.
export async function saveTokenCli({ configFile, repository, input = process.stdin }) {
  const config = await loadOwnerAlphaConfig(configFile);
  if (config.forgeAccess?.provider !== 'token') throw new Error('forgeAccess.provider is not "token"');
  let text = '';
  for await (const chunk of input) { text += chunk; if (text.length > 1024) throw new Error('token too long'); }
  const access = createForgeAccess(config);
  const saved = await access.saveToken(text.trim(), repository);
  return saved.repository.fullName;
}

// First-run setup: GitHub sign-in and repository choice only. There is no
// repository yet, so this publisher can list and bind but never push.
export async function runSetupForgeCli({ socketPath, stateDirectory, clientId }) {
  const access = createGithubAppAccess({ clientId, stateDirectory, remoteUrl: null });
  const control = await startForgeControl({ socketPath, forgeAccess: access });
  process.stdout.write('owner-alpha publisher ready for setup\n');
  await new Promise((resolve) => { process.once('SIGTERM', resolve); process.once('SIGINT', resolve); });
  access.close();
  await control.close();
}

if (import.meta.main && process.argv[2] === 'setup') {
  if (process.argv.length !== 6) {
    process.stderr.write('usage: owner-alpha-publisher setup <socket-path> <forge-state-dir> <github-app-client-id>\n');
    process.exitCode = 1;
  } else {
    try { await runSetupForgeCli({ socketPath: process.argv[3], stateDirectory: process.argv[4], clientId: process.argv[5] }); }
    catch { process.stderr.write('owner-alpha publisher failed\n'); process.exitCode = 1; }
  }
} else if (import.meta.main && process.argv[2] === 'save-token') {
  if (process.argv.length !== 5) {
    process.stderr.write('usage: owner-alpha-publisher save-token <config-file> <owner/name>   (token on standard input)\n');
    process.exitCode = 1;
  } else {
    try {
      process.stdout.write(`token saved for ${await saveTokenCli({ configFile: process.argv[3], repository: process.argv[4] })}\n`);
    } catch (error) {
      process.stderr.write(`token not saved: ${error?.code ?? 'error'}\n`);
      process.exitCode = 1;
    }
  }
} else if (import.meta.main) {
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

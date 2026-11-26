#!/usr/bin/env bun
// The one Cyberbaser program. Each mode wraps an existing entry point unchanged;
// this file only selects it, checks the account it runs under, and fixes argv.
import { appRoot, isCompiled } from './runtime.js';
import path from 'node:path';
import { accountProblem } from './accounts.js';
import { platformFor } from './platform/index.js';
import { REACH_USAGE, resolveReach } from '../../apps/owner-alpha/src/core/reach.js';

export const VERSION = '0.1.0';

// Repository-relative entry points, wrapped as they are.
export const ENTRIES = Object.freeze({
  node: 'apps/owner-alpha/src/server.js',
  publisher: 'apps/owner-alpha/bin/owner-alpha-publisher.js',
  intake: 'apps/account-free-intake/bin/server.js',
  pair: 'apps/owner-alpha/bin/cyberbaser-pair.js',
  setup: 'apps/owner-alpha/bin/cyberbaser-setup.js',
});

const HELP = {
  main: `Cyberbaser ${VERSION}: one program for the owner node and its helpers.

Usage: cyberbaser <mode> [arguments]

  node <config>                      Run the owner node (web app, Iroh, review).
  publisher <config> <socket> <repo> Run the publisher, the only part that holds
                                     the forge key. Options: --socket-group <name>
  publisher save-token <config> <owner/name>
                                     Save a pasted token (read from standard input).
  publisher enroll-code              Show a new code to set up the first device
                                     that approves publishing (administrator).
  publisher reset-owners             Remove every device that can publish and show
                                     a new code and recovery code (administrator).
  intake --config <file>             Run the suggestion intake (the node starts it).
  pair <code or link> [--state <file>]
                                     Pair this machine's agent with an owner node.
  install                            Install as a background service (asks for the
                                     admin password once).
  uninstall [--purge]                Remove the service; keeps your data unless --purge.
  status                             Show what is installed and running.
  version                            Print the version.

Run "cyberbaser <mode> --help" for one mode.`,
  node: 'Usage: cyberbaser node <config-file>\nRuns the owner node from one owner-only JSON config. Installed: runs as the "cyberbaser" account.',
  publisher: 'Usage: cyberbaser publisher <config-file> <socket-path> <bare-repository> [--socket-group <group>]\n       cyberbaser publisher save-token <config-file> <owner/name>   (token on standard input)\n       cyberbaser publisher enroll-code | reset-owners   (as administrator: the first-device code, or start over)\nThe only process that holds forge credentials. Installed: runs as the "cyberbaser-publisher" account.',
  intake: 'Usage: cyberbaser intake --config <absolute-config-file>\nThe suggestion intake. The node starts it beside itself; it runs as the node account.',
  pair: 'Usage: cyberbaser pair <code or obsidian:// link> [--state <absolute new file>]\nPairs an agent on this machine with an owner node; confirm the four words on the owner screen.',
  install: `Usage: cyberbaser install [--yes] [--dry-run] [--quartz-seed <archive>] [--port <n>] [--github-client-id <id>] [--github-origin <url>] [--iroh-relay none|n0|<https url>|http://127.0.0.1:<port>/]
         [--reach ${REACH_USAGE}] [--site private|public] [--renderer <dir> --renderer-name <name> --renderer-quartz-commit <sha> --renderer-fingerprint <a,b,c | @file>]
Installs Cyberbaser as a background service. Asks for the admin password once (pkexec or sudo).
Creates the accounts "cyberbaser" (node) and "cyberbaser-publisher" (publisher), owner-only state, and the services.
--github-client-id: a GitHub App you registered by hand (device flow). Without it, setup creates your own app on GitHub.
--reach: phone/agent ingress for first-run setup and the installed node (default: direct).
--site private: the website is the node's own private site; nothing is deployed to the web.
--renderer: the site's own renderer, copied into the node's state and owned by the node account.`,
  uninstall: 'Usage: cyberbaser uninstall [--purge] [--yes] [--dry-run]\nStops and removes the services and program files. Keeps your data and accounts unless --purge.',
  status: 'Usage: cyberbaser status\nShows what is installed, which services run, and the local address.',
};

// Used by the installed services and container entrypoint, not listed in help.
const INTERNAL = Object.freeze(['service-node', 'service-publisher', 'sync-publisher-config', 'sync-container-publisher-config', 'validate-reach']);

function out(text) { process.stdout.write(`${text}\n`); }

// Spawned by the node as `<program> <app>/apps/account-free-intake/bin/server.js --config <file>`.
function spawnedEntry(argument) {
  if (typeof argument !== 'string' || !path.isAbsolute(argument)) return null;
  for (const [mode, entry] of Object.entries(ENTRIES)) {
    if (argument === path.join(appRoot(), entry)) return mode;
  }
  return null;
}

async function runEntry(mode, args) {
  const entry = ENTRIES[mode];
  if (!isCompiled()) {
    // From source: run the entry file itself, exactly as before.
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, '..', '..', entry), ...args],
      { stdio: ['inherit', 'inherit', 'inherit'] });
    process.exitCode = await child.exited;
    return;
  }
  // Compiled: the wrapped module reads process.argv.slice(2) (or [2], [3], ...).
  process.argv.splice(2, process.argv.length - 2, ...args);
  globalThis.__cyberbaserEntry = entry;
  switch (mode) {
    case 'node': await import('../../apps/owner-alpha/src/server.js'); break;
    case 'publisher': await import('../../apps/owner-alpha/bin/owner-alpha-publisher.js'); break;
    case 'intake': await import('../../apps/account-free-intake/bin/server.js'); break;
    case 'pair': await import('../../apps/owner-alpha/bin/cyberbaser-pair.js'); break;
    case 'setup': await import('../../apps/owner-alpha/bin/cyberbaser-setup.js'); break;
    default: throw new Error('unknown entry');
  }
}

// The publisher with a socket group: the same CLI function with one extra option.
async function runPublisherWithGroup(args) {
  const index = args.indexOf('--socket-group');
  const group = args[index + 1];
  const rest = args.filter((_, i) => i !== index && i !== index + 1);
  if (rest.length !== 3 || !group) {
    process.stderr.write(`${HELP.publisher}\n`);
    process.exitCode = 1;
    return;
  }
  const { groupId } = await import('./accounts.js');
  const socketGroup = groupId(group);
  if (socketGroup === null) {
    process.stderr.write('cyberbaser publisher: unknown socket group\n');
    process.exitCode = 1;
    return;
  }
  const { runPublisherCli } = await import('../../apps/owner-alpha/bin/owner-alpha-publisher.js');
  try {
    await runPublisherCli({ configFile: rest[0], socketPath: rest[1], repository: rest[2],
      ...(isCompiled() ? { projectRoot: appRoot() } : {}), socketGroup });
  } catch (error) {
    process.stderr.write(`owner-alpha publisher failed${error?.code ? `: ${error.code}` : ''}\n`);
    process.exitCode = 1;
  }
}

// Signed publish administration, as the publisher account. Root re-runs itself
// as that account, so the files stay the publisher's own.
async function runOwnerAdmin(args) {
  const { LAYOUT } = await import('./platform/linux-systemd.js');
  const directory = args[1] ?? LAYOUT.publisherOwners;
  if (args.length > 2) { process.stderr.write(`${HELP.publisher}\n`); process.exitCode = 1; return; }
  const { enrollCodeCli } = await import('../../apps/owner-alpha/bin/owner-alpha-publisher.js');
  try { await enrollCodeCli({ directory, reset: args[0] === 'reset-owners' }); }
  catch (error) { process.stderr.write(`no code issued${error?.code ? `: ${error.code}` : ''}\n`); process.exitCode = 1; }
}

export async function main(argv) {
  const spawned = spawnedEntry(argv[0]);
  if (spawned !== null) return guarded(spawned, argv.slice(1));
  const [mode = 'help', ...args] = argv;
  if (mode === 'help' || mode === '--help' || mode === '-h') { out(HELP.main); return; }
  if (mode === 'version' || mode === '--version') { out(`cyberbaser ${VERSION} (${process.env.CYBERBASER_BUILD_TARGET ?? 'source'})`); return; }
  if (!Object.hasOwn(HELP, mode) && !INTERNAL.includes(mode)) {
    process.stderr.write(`cyberbaser: unknown mode "${mode}"\n\n${HELP.main}\n`);
    process.exitCode = 2;
    return;
  }
  if (!INTERNAL.includes(mode) && (args.includes('--help') || args.includes('-h'))) { out(HELP[mode]); return; }
  if (mode === 'validate-reach') {
    try {
      if (args.length !== 1) throw new Error('Expected one reach setting.');
      out(resolveReach(args[0]).ipv4 ?? '');
    } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 2; }
    return;
  }
  if (mode === 'service-node') {
    // The installed node service: first-run setup until the config exists.
    const { nodeServiceArgs } = await import('./platform/linux-systemd.js');
    const next = nodeServiceArgs();
    return guarded(next.mode, next.args);
  }
  if (mode === 'service-publisher') {
    // The installed publisher service: setup mode until its config copy exists.
    const problem = accountProblem('publisher');
    if (problem !== null) { process.stderr.write(`cyberbaser publisher: ${problem}\n`); process.exitCode = 1; return; }
    const { runPublisherService } = await import('./platform/linux-systemd.js');
    try { process.exitCode = await runPublisherService({ appRoot: appRoot() }); }
    catch (error) { process.stderr.write(`cyberbaser publisher failed${error?.code ? `: ${error.code}` : ''}\n`); process.exitCode = 1; }
    return;
  }
  if (mode === 'sync-container-publisher-config') {
    try {
      if (args.length !== 0 || process.getuid?.() !== 0) throw new Error('not the config oneshot');
      const { reconcileContainerConfig } = await import('./platform/container-config.js');
      out(await reconcileContainerConfig());
    } catch {
      // Do not log node-controlled config values or contents.
      process.stderr.write('Container publisher config was not reconciled.\n');
      process.exitCode = 1;
    }
    return;
  }
  if (mode === 'sync-publisher-config') {
    const { syncPublisherConfig } = await import('./platform/linux-systemd.js');
    process.exitCode = await syncPublisherConfig();
    return;
  }
  if (mode === 'publisher' && ['enroll-code', 'reset-owners'].includes(args[0]) && process.getuid?.() === 0) {
    // The administrator: run the same command as the publisher account.
    const { userEntry, groupEntry, DEFAULT_ACCOUNTS } = await import('./accounts.js');
    const account = userEntry(DEFAULT_ACCOUNTS.publisher);
    const group = groupEntry(DEFAULT_ACCOUNTS.group);
    if (!account || !group) { process.stderr.write('cyberbaser publisher: not installed on this machine\n'); process.exitCode = 1; return; }
    const { spawnSync } = await import('node:child_process');
    const result = spawnSync('setpriv', ['--reuid', String(account.id), '--regid', String(group.id), '--clear-groups', '--',
      process.execPath, 'publisher', ...args], { stdio: 'inherit', cwd: '/var/lib/cyberbaser-publisher', env: { PATH: '/usr/bin:/bin', HOME: '/var/lib/cyberbaser-publisher' } });
    process.exitCode = result.status ?? 1;
    return;
  }
  if (['install', 'uninstall', 'status'].includes(mode)) {
    const platform = platformFor(process.platform);
    process.exitCode = await platform[mode](args, { programPath: process.execPath, compiled: isCompiled() });
    return;
  }
  return guarded(mode, args);
}

async function guarded(mode, args) {
  const problem = accountProblem(mode);
  if (problem !== null) {
    process.stderr.write(`cyberbaser ${mode}: ${problem}\n`);
    process.exitCode = 1;
    return;
  }
  if (mode === 'publisher' && args.includes('--socket-group')) return runPublisherWithGroup(args);
  if (mode === 'publisher' && ['enroll-code', 'reset-owners'].includes(args[0])) return runOwnerAdmin(args);
  return runEntry(mode, args);
}

if (import.meta.main) await main(process.argv.slice(2));

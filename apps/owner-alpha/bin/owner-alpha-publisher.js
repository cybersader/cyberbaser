#!/usr/bin/env bun

import { loadOwnerAlphaConfig } from '../src/config.js';
import { createForgeAccess, createGithubAppAccess } from '../src/publisher/forge-access.js';
import { startForgeControl } from '../src/publisher/forge-control.js';
import { createMirror } from '../src/publisher/mirror.js';
import { startPublisher } from '../src/publisher/server.js';
import { issueEnrollmentCode, resetOwners } from '../src/publisher/owner-keys.js';
import { startOwnerServices } from '../src/publisher/owner-services.js';
import { qrMatrix } from '../src/qr.js';

// A QR code drawn with half blocks, two modules per character row.
export function qrTerminal(text) {
  const { size, modules } = qrMatrix(text);
  const dark = (y, x) => y >= 0 && y < size && x >= 0 && x < size && Boolean(modules[y][x]);
  const lines = [];
  for (let y = -2; y < size + 2; y += 2) {
    let line = '  ';
    for (let x = -2; x < size + 2; x += 1) {
      const top = dark(y, x);
      const bottom = dark(y + 1, x);
      line += top && bottom ? ' ' : top ? '\u2584' : bottom ? '\u2580' : '\u2588';
    }
    lines.push(line);
  }
  return lines.join('\n');
}
import { DEFAULT_OWNER_ALPHA_PROJECT_ROOT } from '../src/site.js';
import { storeContextFromConfig } from '../src/store.js';

// owners: signed publish (src/publisher/owner-services.js). The owner-key
// directory is the publisher's own state, given here, never read from the config.
export async function runPublisherCli({ configFile, socketPath, repository, projectRoot = DEFAULT_OWNER_ALPHA_PROJECT_ROOT, socketGroup = null,
  forgeOptions = undefined, owners = null }) {
  let publisher;
  let stopRequested = false;
  let stopped;
  const stopping = new Promise((resolve) => { stopped = resolve; });
  const stop = () => { stopRequested = true; stopped(); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    const config = await loadOwnerAlphaConfig(configFile);
    publisher = await startPublisher({ config, context: storeContextFromConfig(config, projectRoot), socketPath, repository, socketGroup,
      owners, ...(forgeOptions === undefined ? {} : { forgeOptions }) });
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

// First-run setup: GitHub sign-in, repository choice, and the mirror the node
// copies its notes from. There is no publication policy yet, so this publisher
// never pushes a job; the only change it may push is an exact starter
// publish.yml the owner approved (see src/publisher/mirror.js). With a mirror
// and a checkout it offers fetch and publish-starter; without, sign-in only.
// With owners (signed publish), the starter file needs the owner's signed
// approval through the owner control socket, and the first device is enrolled
// here, before the node has any config.
export async function runSetupForgeCli({ socketPath, stateDirectory, clientId, mirror = null, checkout = null, socketGroup = null,
  http = undefined, uid = process.getuid(), owners = null }) {
  const access = createGithubAppAccess({ clientId, stateDirectory, remoteUrl: null, ...(http === undefined ? {} : { http }) });
  const held = mirror === null ? null : await createMirror({ directory: mirror, uid, forgeAccess: access });
  const control = await startForgeControl({ socketPath, forgeAccess: access, uid, socketGroup, mirror: held, starterCheckout: checkout,
    starterSigned: owners !== null && (owners.mode ?? 'enforce') === 'enforce' });
  const ownerServices = owners === null ? null
    : await startOwnerServices({ owners, socketPath, uid, socketGroup, mirror: held, starterCheckout: checkout });
  process.stdout.write('owner-alpha publisher ready for setup\n');
  await new Promise((resolve) => { process.once('SIGTERM', resolve); process.once('SIGINT', resolve); });
  access.close();
  await ownerServices?.close();
  await control.close();
}

// Administrator commands, run as the publisher account. They print the code
// on this terminal only; the node never sees it.
export async function enrollCodeCli({ directory, reset = false, out = (line) => process.stdout.write(`${line}\n`) }) {
  const issued = reset ? await resetOwners({ directory }) : await issueEnrollmentCode({ directory });
  if (issued.enrolled) {
    out('A device can already publish. To start over (every device removed), run: cyberbaser publisher reset-owners');
    return issued;
  }
  out('');
  out('Set up the device that will approve publishing. Scan this with it, or type the code:');
  out(qrTerminal(issued.uri));
  out(`  Code: ${issued.code}   (valid for one hour, for one device)`);
  if (issued.recoveryCode) {
    out('');
    out('Your recovery code. Write it down and keep it somewhere safe; it is shown only now.');
    out('If you ever lose every device, it lets you set up a new one:');
    out(`  ${issued.recoveryCode}`);
  }
  out('');
  return issued;
}

if (import.meta.main && process.argv[2] === 'setup') {
  if (process.argv.length !== 6) {
    process.stderr.write('usage: owner-alpha-publisher setup <socket-path> <forge-state-dir> <github-app-client-id>\n');
    process.exitCode = 1;
  } else {
    try { await runSetupForgeCli({ socketPath: process.argv[3], stateDirectory: process.argv[4], clientId: process.argv[5] }); }
    catch { process.stderr.write('owner-alpha publisher failed\n'); process.exitCode = 1; }
  }
} else if (import.meta.main && ['enroll-code', 'reset-owners'].includes(process.argv[2])) {
  if (process.argv.length !== 4) {
    process.stderr.write(`usage: owner-alpha-publisher ${process.argv[2]} <owner-state-dir>\n`);
    process.exitCode = 1;
  } else {
    try { await enrollCodeCli({ directory: process.argv[3], reset: process.argv[2] === 'reset-owners' }); }
    catch (error) { process.stderr.write(`no code issued: ${error?.code ?? 'error'}\n`); process.exitCode = 1; }
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

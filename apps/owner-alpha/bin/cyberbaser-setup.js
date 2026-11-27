#!/usr/bin/env bun
// First-run setup on 127.0.0.1. Prints a one-time setup link; type "l" for a
// new one. When the owner reaches Done it writes the node's config, stops the
// setup server (its links stop working) and starts the node in this same
// process on the same address, adopting the owner's browser session, so the
// owner lands in Cyberbaser signed in. The session is handed over in memory
// only; the node never accepts a setup link.
//
//   bun bin/cyberbaser-setup.js <state-dir> <port> <publisher-socket> <layout.json> [--exit-at-done]
//
// layout.json (written by the installer): { listen, reviewSocket, irohStateDirectory,
// forgeStateDirectory, clientId, configFile, checkout, mirror, relay?, reach?, publication?,
// renderer? }. publication "private-site" makes the private site the website
// step's first choice; renderer is the site's own renderer (installer --renderer). Without
// `checkout` the notes copy is <state-dir>/notes; without `mirror` the node
// clones from GitHub itself (development only).
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { openDeviceStore } from '../src/core/device-store.js';
import { createPairingManager } from '../src/core/pairing.js';
import { irohConfigFromLayout, ownerConfigFromSetup, runFirstRun } from '../src/first-run.js';
import { bindIrohNode, loadNodeSecret, PAIR_ALPN, startIrohCarrier } from '../src/iroh-carrier.js';

const writeConfig = async (file, config) => {
  const { open, rename } = await import('node:fs/promises');
  const temporary = `${file}.${process.pid}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, file);
};

async function runNodeAfterSetup({ configFile, session, pendingStarter = null }) {
  const { runOwnerAlphaServer } = await import('../src/server.js');
  const runtime = await runOwnerAlphaServer({ configFile, adoptSession: session, pendingStarter });
  if (process.env.CYBERBASER_TEST_SESSION_MARK === '1') {
    const { createHash } = await import('node:crypto');
    process.stdout.write(`Owner session from setup: ${createHash('sha256').update(session.sessionToken).digest('hex').slice(0, 8)}\n`);
  }
  process.stdout.write(`Cyberbaser is running: ${runtime.ownerOrigin}/\n`);
  if (runtime.upstream?.current().state === 'unreachable') process.stdout.write('GitHub: cannot reach it now; serving your notes as last copied.\n');
  const stop = async () => { await runtime.stop(true); process.exit(0); };
  runtime.recovery.catch(() => { process.stderr.write('Cyberbaser could not resume an earlier job; see Proposals.\n'); });
  process.once('SIGTERM', () => { void stop(); });
  process.once('SIGINT', () => { void stop(); });
}

if (import.meta.main) {
  const [stateDirectory, portText, publisherSocket, layoutFile, flag] = process.argv.slice(2);
  if (!stateDirectory || !portText || !publisherSocket || !layoutFile || (flag !== undefined && flag !== '--exit-at-done')) {
    process.stderr.write('usage: cyberbaser-setup <state-dir> <port> <publisher-socket> <layout.json> [--exit-at-done]\n');
    process.exit(1);
  }
  const layout = JSON.parse(await readFile(layoutFile, 'utf8'));
  const irohConfig = irohConfigFromLayout(layout);
  const checkout = layout.checkout ?? path.join(path.resolve(stateDirectory), 'notes');
  let carrier = null;
  // Pairing during setup uses the node's own Iroh identity, so a phone paired
  // now is the same node after setup. Commands wait until setup is done.
  const reach = async (ownerId) => {
    const store = await openDeviceStore({ directory: path.join(layout.irohStateDirectory, 'devices'), ownerId,
      parentDirectory: layout.irohStateDirectory });
    const pairing = createPairingManager({ ownerId, store });
    const secretKey = await loadNodeSecret(layout.irohStateDirectory);
    const binding = await bindIrohNode({ secretKey, config: irohConfig, alpns: [PAIR_ALPN] }).finally(() => secretKey.fill(0));
    const refuse = new Proxy({}, { get: () => async () => { throw Object.assign(new Error('setting up'), { code: 'node-setting-up' }); } });
    carrier = startIrohCarrier({ ...binding, commands: refuse, verifier: { forChannel: () => ({}) }, pairing });
    pairing.attachNode({ nodeId: carrier.nodeId, ticket: carrier.ticket });
    return { store, pairing };
  };
  // Only a native install with a selected desktop UID offers the embedded page.
  const setup = await runFirstRun({ stateDirectory: path.resolve(stateDirectory), port: Number(portText), publisherSocket, reach,
    checkout, mirror: layout.mirror ?? null, enrolPort: layout.enrollPort ?? null,
    // Installer --site private: the website step offers the private site first.
    publication: layout.publication === 'private-site' ? 'private-site' : null,
    readerAddress: `http://${layout.listen?.host ?? '127.0.0.1'}:${(layout.listen?.port ?? Number(portText)) + 1}/` });
  process.stdout.write(`Cyberbaser setup: ${setup.setupLink()}\n`);
  const console = createInterface({ input: process.stdin, terminal: false });
  console.on('line', (line) => {
    if (line.trim() !== 'l') return;
    try { process.stdout.write(`Cyberbaser setup: ${setup.setupLink()}\n`); }
    catch { process.stdout.write('Setup is finished.\n'); }
  });
  const { state, session } = await setup.completed;
  const { config, workflowDetected } = ownerConfigFromSetup(state, { ...layout, checkout, publisherSocket });
  await writeConfig(layout.configFile, config);
  process.stdout.write(`Setup complete. Node config: ${layout.configFile}${workflowDetected ? '' : ' (no Pages workflow found; live checks will not confirm)'}\n`);
  console.close();
  await carrier?.close().catch(() => {});
  // The setup server goes away before the node takes the same address, so no setup link answers again.
  setup.stop(true);
  if (flag === '--exit-at-done') process.exit(0);
  try {
    await runNodeAfterSetup({ configFile: layout.configFile, session, pendingStarter: state.notes.starterCommit ?? null });
  } catch (error) {
    // The service restarts and runs the node from the config; the owner signs in with the printed link.
    process.stderr.write(`Cyberbaser could not start after setup${error?.code ? `: ${error.code}` : ''}\n`);
    process.exit(1);
  }
}

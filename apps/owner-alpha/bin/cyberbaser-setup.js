#!/usr/bin/env bun
// First-run setup on 127.0.0.1. Prints a one-time setup link; type "l" for a
// new one. Exits 0 once the owner reaches Done, after writing the node's
// config next to the setup state. An installer that starts the node in this
// same process can instead pass the finished session to runOwnerAlphaServer
// as `adoptSession`, so the owner stays signed in.
//
//   bun bin/cyberbaser-setup.js <state-dir> <port> <publisher-socket> <layout.json>
//
// layout.json (written by the installer): { listen, reviewSocket, irohStateDirectory,
// forgeStateDirectory, clientId, configFile }. The checkout is <state-dir>/notes.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { openDeviceStore } from '../src/core/device-store.js';
import { createPairingManager } from '../src/core/pairing.js';
import { ownerConfigFromSetup, runFirstRun } from '../src/first-run.js';
import { bindEndpoint, loadNodeSecret, PAIR_ALPN, startIrohCarrier } from '../src/iroh-carrier.js';

const writeConfig = async (file, config) => {
  const { open, rename } = await import('node:fs/promises');
  const temporary = `${file}.${process.pid}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, file);
};

if (import.meta.main) {
  const [stateDirectory, portText, publisherSocket, layoutFile] = process.argv.slice(2);
  if (!stateDirectory || !portText || !publisherSocket || !layoutFile) {
    process.stderr.write('usage: cyberbaser-setup <state-dir> <port> <publisher-socket> <layout.json>\n');
    process.exit(1);
  }
  const layout = JSON.parse(await readFile(layoutFile, 'utf8'));
  let carrier = null;
  // Pairing during setup uses the node's own Iroh identity, so a phone paired
  // now is the same node after setup. Commands wait until setup is done.
  const reach = async (ownerId) => {
    const store = await openDeviceStore({ directory: path.join(layout.irohStateDirectory, 'devices'), ownerId,
      parentDirectory: layout.irohStateDirectory });
    const pairing = createPairingManager({ ownerId, store });
    const secretKey = await loadNodeSecret(layout.irohStateDirectory);
    const endpoint = await bindEndpoint({ secretKey, relay: layout.relay ?? 'n0', bindAddress: null, alpns: [PAIR_ALPN] });
    secretKey.fill(0);
    const refuse = new Proxy({}, { get: () => async () => { throw Object.assign(new Error('setting up'), { code: 'node-setting-up' }); } });
    carrier = startIrohCarrier({ endpoint, commands: refuse, verifier: { forChannel: () => ({}) }, pairing, relay: layout.relay ?? 'n0' });
    pairing.attachNode({ nodeId: carrier.nodeId, ticket: carrier.ticket });
    return { store, pairing };
  };
  const setup = await runFirstRun({ stateDirectory: path.resolve(stateDirectory), port: Number(portText), publisherSocket, reach });
  process.stdout.write(`Cyberbaser setup: ${setup.setupLink()}\n`);
  const console = createInterface({ input: process.stdin, terminal: false });
  console.on('line', (line) => {
    if (line.trim() !== 'l') return;
    try { process.stdout.write(`Cyberbaser setup: ${setup.setupLink()}\n`); }
    catch { process.stdout.write('Setup is finished.\n'); }
  });
  const { state } = await setup.completed;
  const { config, workflowDetected } = ownerConfigFromSetup(state, { ...layout, checkout: path.join(path.resolve(stateDirectory), 'notes'),
    publisherSocket });
  await writeConfig(layout.configFile, config);
  process.stdout.write(`Setup complete. Node config: ${layout.configFile}${workflowDetected ? '' : ' (no Pages workflow found; live checks will not confirm)'}\n`);
  console.close();
  await carrier?.close().catch(() => {});
  setup.stop(true);
  process.exit(0);
}

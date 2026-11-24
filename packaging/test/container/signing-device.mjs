// A stand-in for the owner's signing device in the container setup test (the
// Obsidian plugin will do this). It reaches the publisher through the owner
// control socket the way the node relays it, so it runs as the node account.
// Its key lives in a state file; synthetic keys only.
//   BUN_BE_BUN=1 cyberbaser signing-device.mjs <command> ...
// Prints one JSON line.
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createStarterPublisher } from '/src/apps/owner-alpha/src/first-run.js';
import { loadOwnerAlphaConfig } from '/src/apps/owner-alpha/src/config.js';
import { attachOwnerApproval, pipelineArtifactPaths } from '/src/apps/owner-alpha/src/pipeline.js';
import { ownerRequest } from '/src/apps/owner-alpha/src/publisher/owner-control.js';
import { storeContextFromConfig } from '/src/apps/owner-alpha/src/store.js';
import { changeKeys, createDevice, enroll, recover, signPublish, verifyReceipt } from '/src/apps/owner-alpha/test/signed-device.js';

const SOCKET = '/run/cyberbaser-publisher/publisher.sock';
const REMOTE = 'https://github.com/cybersader/cyberbase.git';
const CHECKOUT = '/var/lib/cyberbaser-shared/notes/notes';
const [command, ...args] = process.argv.slice(2);

function load(file) {
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  const device = createDevice({ keyId: saved.keyId, label: saved.label, seed: Buffer.from(saved.seed, 'base64') });
  device.publisher = saved.publisher;
  return device;
}
function save(file, device) {
  writeFileSync(file, JSON.stringify({ keyId: device.keyId, label: device.key.label, seed: device.seed.toString('base64'), publisher: device.publisher }),
    { mode: 0o600 });
}
const done = (value) => { process.stdout.write(`${JSON.stringify(value)}\n`); process.exit(0); };
const refused = (error) => ({ ok: false, code: error?.code ?? String(error?.message ?? error) });

async function starter(device, folders) {
  let receipt = null;
  const publisher = createStarterPublisher({ checkout: CHECKOUT, publish: async (commit) => {
    const record = await signPublish(device, { socketPath: SOCKET, repository: CHECKOUT, commit, remote: REMOTE, branch: 'main' });
    ({ receipt } = await ownerRequest({ socketPath: SOCKET, op: 'publish-starter', commit, record }));
  } });
  const { commit } = await publisher.publish({ repository: 'cybersader/cyberbase', folders });
  return { ok: true, commit, receiptVerified: device.publisher !== null && verifyReceipt(device, receipt) };
}

try {
  switch (command) {
    case 'enroll': { // <code> <state> <keyId>
      const device = createDevice({ keyId: args[2], label: 'Synthetic phone' });
      const result = await enroll(device, { socketPath: SOCKET, code: args[0] });
      save(args[1], device);
      done({ ok: true, keyId: result.keyId, publisher: device.publisher });
      break;
    }
    case 'forged-enroll': { // a code the node made up
      try { await enroll(createDevice({ keyId: 'node-key' }), { socketPath: SOCKET, code: args[0] }); done({ ok: true }); }
      catch (error) { done(refused(error)); }
      break;
    }
    case 'starter': // <state> <folder>
      done(await starter(load(args[0]), [args[1]]));
      break;
    case 'starter-forged': { // the node signs with a key of its own
      const node = createDevice({ keyId: 'phone' });
      try { done(await starter(node, [args[0]])); } catch (error) { done(refused(error)); }
      break;
    }
    case 'sign-job': { // <state> <config> <jobId>: attach the device's approval to a waiting job
      const device = load(args[0]);
      const config = await loadOwnerAlphaConfig(args[1]);
      const context = storeContextFromConfig(config, '/opt/cyberbaser');
      const committed = JSON.parse(readFileSync(`${context.storeRoot}/${pipelineArtifactPaths(args[2]).committed}`, 'utf8')).result.commit;
      const record = await signPublish(device, { socketPath: SOCKET, repository: config.repository.checkout, commit: committed,
        remote: config.repository.remote.url, branch: config.repository.branch });
      await attachOwnerApproval({ context, config, jobId: args[2], record });
      done({ ok: true, commit: committed });
      break;
    }
    case 'forge-job': { // <config> <jobId>: the node attaches an approval signed by its own key
      const config = await loadOwnerAlphaConfig(args[0]);
      const context = storeContextFromConfig(config, '/opt/cyberbaser');
      const committed = JSON.parse(readFileSync(`${context.storeRoot}/${pipelineArtifactPaths(args[1]).committed}`, 'utf8')).result.commit;
      const record = await signPublish(createDevice({ keyId: 'phone' }), { socketPath: SOCKET, repository: config.repository.checkout,
        commit: committed, remote: config.repository.remote.url, branch: config.repository.branch });
      await attachOwnerApproval({ context, config, jobId: args[1], record });
      done({ ok: true });
      break;
    }
    case 'add': { // <state> <new-state> <keyId>
      const device = load(args[0]);
      const added = createDevice({ keyId: args[2], label: 'Synthetic laptop' });
      added.publisher = device.publisher;
      try { await changeKeys(device, { socketPath: SOCKET, kind: 'key-add', subject: { key: added.key } }); save(args[1], added); done({ ok: true }); }
      catch (error) { done(refused(error)); }
      break;
    }
    case 'revoke': { // <state> <keyId>
      try { await changeKeys(load(args[0]), { socketPath: SOCKET, kind: 'key-revoke', subject: { keyId: args[1] } }); done({ ok: true }); }
      catch (error) { done(refused(error)); }
      break;
    }
    case 'recover': { // <recovery code> <new-state> <keyId>
      const fresh = createDevice({ keyId: args[2], label: 'Replacement phone', seed: randomBytes(32) });
      try {
        await recover(args[0], fresh, { socketPath: SOCKET });
        fresh.publisher = (await ownerRequest({ socketPath: SOCKET, op: 'challenge' })).publisher;
        save(args[1], fresh);
        done({ ok: true });
      } catch (error) { done(refused(error)); }
      break;
    }
    case 'devices': {
      const list = await ownerRequest({ socketPath: SOCKET, op: 'keys' });
      done({ ok: true, active: list.body.keys.filter((key) => key.revokedAt === null).map((key) => key.keyId) });
      break;
    }
    default: done({ ok: false, code: 'usage' });
  }
} catch (error) {
  done(refused(error));
}

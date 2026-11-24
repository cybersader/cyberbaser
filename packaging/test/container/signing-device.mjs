// Two roles in the container setup test, both run as the node account:
//   - a stand-in signing device (plain Ed25519, the same format as the plugin;
//     apps/owner-alpha/test/signed-device.js) that reaches the publisher
//     through the owner control socket the way the node relays it; and
//   - a compromised node, which may attach any approval to any job, move its
//     own job state, and ask the publisher to push (it owns its job store).
//   BUN_BE_BUN=1 cyberbaser signing-device.mjs <command> ...
// Prints one JSON line. Synthetic keys only.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadOwnerAlphaConfig } from '/src/apps/owner-alpha/src/config.js';
import { loadDurableJob, transitionDurableJob } from '/src/apps/owner-alpha/src/job-state.js';
import { attachOwnerApproval, createSaveHandler, pipelineArtifactPaths } from '/src/apps/owner-alpha/src/pipeline.js';
import { requestPublication } from '/src/apps/owner-alpha/src/publisher/client.js';
import { forgeRequest } from '/src/apps/owner-alpha/src/publisher/forge-control.js';
import { ownerRequest } from '/src/apps/owner-alpha/src/publisher/owner-control.js';
import { describePublish, gitIn, publishIntent } from '/src/apps/owner-alpha/src/signed-publish.js';
import { storeContextFromConfig } from '/src/apps/owner-alpha/src/store.js';
import { changeKeys, createDevice, enroll, recover, signPublish } from '/src/apps/owner-alpha/test/signed-device.js';

const SOCKET = '/run/cyberbaser-publisher/publisher.sock';
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

async function opened(configFile) {
  const config = await loadOwnerAlphaConfig(configFile);
  return { config, context: storeContextFromConfig(config, '/opt/cyberbaser') };
}
const committedOf = (context, jobId) => JSON.parse(readFileSync(path.join(context.storeRoot, pipelineArtifactPaths(jobId).committed), 'utf8')).result.commit;
function git(cwd, args, input = undefined, env = {}) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', input, env: { ...process.env, ...env } });
  if (result.status !== 0) throw new Error(`git ${args[0]}: ${result.stderr}`);
  return result.stdout.trim();
}

// The compromised node's move: put `record` on a waiting job, mark the job as
// pushing, ask the publisher to push it, then put everything back.
async function attempt(configFile, jobId, record) {
  const { config, context } = await opened(configFile);
  const before = await loadDurableJob(context, jobId);
  if (before.state !== 'awaiting-approval') return { ok: false, code: `job-is-${before.state}` };
  await attachOwnerApproval({ context, config, jobId, record });
  await transitionDurableJob(context, jobId, 'pushing', { at: new Date().toISOString(), reason: 'container-test-attack' });
  let outcome;
  try {
    outcome = { ok: true, pushed: await requestPublication({ socketPath: config.publisher.socketPath, jobId, timeoutMs: 60_000 }) };
  } catch (error) {
    outcome = { ok: false, code: error?.code ?? 'failed' };
  }
  // Pushed: the job stays at pushing with the publisher's receipt; the node's
  // recovery carries it on. Refused: everything goes back to waiting.
  if (outcome.ok) return outcome;
  rmSync(path.join(context.storeRoot, pipelineArtifactPaths(jobId).ownerApproval), { force: true });
  await transitionDurableJob(context, jobId, 'awaiting-approval', { at: new Date().toISOString(), reason: 'container-test-attack-undone' });
  return outcome;
}

try {
  switch (command) {
    case 'publisher': // the publisher's key, as a scanned code carries it
      done({ ok: true, publisher: (await ownerRequest({ socketPath: SOCKET, op: 'challenge' })).publisher });
      break;
    case 'forged-enroll': { // a code the node made up, or a used one
      try { await enroll(createDevice({ keyId: 'node-key' }), { socketPath: SOCKET, code: args[0] }); done({ ok: true }); }
      catch (error) { done(refused(error)); }
      break;
    }
    case 'job-commit': { // <config> <jobId>
      const { context } = await opened(args[0]);
      done({ ok: true, commit: committedOf(context, args[1]), state: (await loadDurableJob(context, args[1])).state });
      break;
    }
    case 'intent': { // <config> <commit>: a publish intent for one commit with a fresh publisher number (as the relay builds it)
      const { config } = await opened(args[0]);
      const description = await describePublish({ git: gitIn(config.repository.checkout), commit: args[1],
        remote: config.repository.remote.url, branch: config.repository.branch });
      const challenge = await ownerRequest({ socketPath: SOCKET, op: 'challenge' });
      done({ ok: true, intent: publishIntent({ challenge, keyId: 'signing-device', description }) });
      break;
    }
    case 'other-commit': { // <config> <jobId>: another commit on the same base that changes a different note
      const { config, context } = await opened(args[0]);
      const checkout = config.repository.checkout;
      const base = git(checkout, ['rev-parse', `${committedOf(context, args[1])}^`]);
      const index = path.join('/tmp', `cb-other-${randomBytes(4).toString('hex')}.index`);
      const env = { GIT_INDEX_FILE: index };
      git(checkout, ['read-tree', base], undefined, env);
      const blob = git(checkout, ['hash-object', '-w', '--stdin'], '# Tulips\n\nPlant tulips whenever.\n');
      git(checkout, ['update-index', '--cacheinfo', `100644,${blob},Garden/Tulips.md`], undefined, env);
      const tree = git(checkout, ['write-tree'], undefined, env);
      rmSync(index, { force: true });
      const commit = git(checkout, ['commit-tree', tree, '-p', base, '-m', 'Something the owner did not ask for'],
        undefined, { GIT_AUTHOR_NAME: 'cybersader', GIT_AUTHOR_EMAIL: 'x@example.invalid', GIT_COMMITTER_NAME: 'cybersader',
          GIT_COMMITTER_EMAIL: 'x@example.invalid' });
      done({ ok: true, commit });
      break;
    }
    case 'attempt': { // <config> <jobId> <record-file>
      done(await attempt(args[0], args[1], JSON.parse(readFileSync(args[2], 'utf8'))));
      break;
    }
    case 'attempt-forged': { // <config> <jobId>: the node signs with its own key under the phone's key ID
      const { config, context } = await opened(args[0]);
      const keys = (await ownerRequest({ socketPath: SOCKET, op: 'keys' })).body.keys.filter((key) => key.revokedAt === null);
      const node = createDevice({ keyId: keys[0]?.keyId ?? 'phone' });
      const record = await signPublish(node, { socketPath: SOCKET, repository: config.repository.checkout,
        commit: committedOf(context, args[1]), remote: config.repository.remote.url, branch: config.repository.branch });
      done(await attempt(args[0], args[1], record));
      break;
    }
    case 'sign-job': { // <state> <config> <jobId>: the stand-in device approves exactly the job's commit; the node attaches it
      const device = load(args[0]);
      const { config, context } = await opened(args[1]);
      const commit = committedOf(context, args[2]);
      const record = await signPublish(device, { socketPath: SOCKET, repository: config.repository.checkout, commit,
        remote: config.repository.remote.url, branch: config.repository.branch });
      await attachOwnerApproval({ context, config, jobId: args[2], record });
      done({ ok: true, commit });
      break;
    }
    case 'starter-unsigned': { // <commit>: the node asks the forge relay to push the starter with no signature
      try { await forgeRequest({ socketPath: SOCKET, op: 'publish-starter', commit: args[0] }); done({ ok: true }); }
      catch (error) { done(refused(error)); }
      break;
    }
    case 'starter-forged': { // <config> <commit>: the node signs the starter with a key of its own
      const { config } = await opened(args[0]);
      try {
        const record = await signPublish(createDevice({ keyId: 'phone' }), { socketPath: SOCKET, repository: config.repository.checkout,
          commit: args[1], remote: config.repository.remote.url, branch: config.repository.branch });
        await ownerRequest({ socketPath: SOCKET, op: 'publish-starter', commit: args[1], record });
        done({ ok: true });
      } catch (error) { done(refused(error)); }
      break;
    }
    case 'sign-record': { // <state> <config> <jobId>: the stand-in device's approval for exactly the job's commit
      const device = load(args[0]);
      const { config, context } = await opened(args[1]);
      done({ ok: true, record: await signPublish(device, { socketPath: SOCKET, repository: config.repository.checkout,
        commit: committedOf(context, args[2]), remote: config.repository.remote.url, branch: config.repository.branch }) });
      break;
    }
    case 'owner-save': { // <config> <jobId> <note> <old> <new>: one owner Save job (checks stubbed, as save-job.mjs)
      const config = await loadOwnerAlphaConfig(args[0]);
      const note = args[2];
      const text = readFileSync(path.join(config.repository.checkout, note), 'utf8');
      if (!text.includes(args[3])) done({ ok: false, code: 'old-text-missing' });
      const save = createSaveHandler({ config, projectRoot: '/opt/cyberbaser', dependencies: {
        async runPreApplyChecks() { return { ok: true, rendered: { witnesses: { old: 'old sentence.', new: 'new sentence.' } } }; } } });
      const result = await save.startEdit({ jobId: args[1], renderer: { relativePath: note, slug: note.replace(/\.md$/u, '') },
        editedText: text.replace(args[3], args[4]) }).completion;
      done({ ok: true, state: result?.state ?? null, failure: result?.failure?.code ?? null });
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

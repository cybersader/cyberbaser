#!/usr/bin/env bun
// A disposable owner node for the phone-step harness run: synthetic Git vault,
// local bare remote, simulated build/deploy/live checks, proposal review on,
// owner publication of one workspace note, Iroh on through the given relay.
// Prints one JSON line, runs until stdin closes, then removes everything.
// Usage: bun node-fixture.js <relay: n0 | http://127.0.0.1:PORT/> <port> <workspace-text-file>
//
// Signing: the publisher's real owner services (owner-key list, approval gate,
// owner-control socket; apps/owner-alpha/src/publisher/owner-services.js) run
// in a disposable directory, and the node relays to them over that socket.
// The first line carries the one-time enrolment link from the publisher's own
// log. An "approval" line on stdin asks the phone to approve one publish of the
// workspace note; the fixture prints the publisher gate's verdict on the
// signature it gets back (key, signature, nonce, target; no Git push here).
import { chmod, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAgentProposalRehearsal, PUBLICATION_MAPPING_ID } from '../../../owner-alpha/bin/agent-proposal-rehearsal.js';
import { AGENT_REHEARSAL_DELIVERY_PATH } from '../../../owner-alpha/bin/suggestions-rehearsal-fixture.js';
import { publisherSigningFromSocket } from '../../../owner-alpha/src/core/approvals.js';
import { ownerRequest } from '../../../owner-alpha/src/publisher/owner-control.js';
import { startOwnerServices } from '../../../owner-alpha/src/publisher/owner-services.js';
import { publishIntent } from './stub-publisher.js';

const [relay, port, workspaceFile] = process.argv.slice(2);
const before = { source: 'synthetic-workspace', path: AGENT_REHEARSAL_DELIVERY_PATH,
  text: '---\ntitle: Workspace note\n---\n\n# Workspace note\n\nStore the notes in the blue folder.\n' };
const after = { ...before, text: before.text.replace('blue folder', 'green binder') };
const workspaceText = await readFile(workspaceFile, 'utf8');

const publisherRoot = await mkdtemp(path.join(os.tmpdir(), 'cb-phone-publisher-'));
await chmod(publisherRoot, 0o700);
const ipc = path.join(publisherRoot, 'ipc');
await mkdir(ipc, { mode: 0o700 });
const socketPath = path.join(ipc, 'publisher.sock');
const publisherLog = [];
const services = await startOwnerServices({ owners: { directory: path.join(publisherRoot, 'owners'), mode: 'enforce' }, socketPath,
  uid: process.getuid(), log: (line) => publisherLog.push(line) });
const enrolLink = publisherLog.map((line) => /scan: (\S+)$/u.exec(line)?.[1]).find(Boolean);
const remote = 'https://github.com/example/vault.git';

// The workspace note is not bound up front: the phone's first Publish asks the
// owner to link it on the Devices page. A "sync" line on stdin then delivers the
// phone's text to the node's workspace copy, as a sync would.
const fixture = await createAgentProposalRehearsal({ port: Number(port), before, after, iroh: relay,
  publication: { workspaceText, bind: false }, publisherSigning: publisherSigningFromSocket({ socketPath, ownerRequest }) });
let closing = false;
async function stop() {
  if (closing) return;
  closing = true;
  await fixture.cleanup().catch((error) => console.error(`cleanup: ${error.message}`));
  await services.close().catch(() => {});
  await rm(publisherRoot, { recursive: true, force: true });
  process.exit(0);
}
console.log(JSON.stringify({ ownerOrigin: fixture.runtime.ownerOrigin, signInUrl: fixture.issueSignInUrl(),
  deliveryPath: AGENT_REHEARSAL_DELIVERY_PATH, mappingId: PUBLICATION_MAPPING_ID, agentQueueId: fixture.queueId, root: fixture.root,
  signing: { publisher: services.ownerKeys.publisher, enrolLink, verifier: 'real publisher owner services' } }));

async function askApproval() {
  const old = Buffer.from(workspaceText);
  const next = Buffer.from(workspaceText.replace('red folder', 'green binder'));
  const challenge = await ownerRequest({ socketPath, op: 'challenge' });
  const intent = publishIntent({ publisher: challenge.publisher, nonce: challenge.nonce, path: AGENT_REHEARSAL_DELIVERY_PATH,
    before: old, after: next, remote });
  intent.issuedAt = challenge.issuedAt;
  intent.expiresAt = challenge.expiresAt;
  const asked = fixture.runtime.approvals.request({ askedBy: 'Desktop browser', intent,
    files: [{ path: AGENT_REHEARSAL_DELIVERY_PATH, before: old.toString('base64'), after: next.toString('base64') }] });
  console.log(JSON.stringify({ approvalRequested: asked.requestId }));
  try {
    const signed = await asked.result;
    const authorization = await services.gate.authorize(signed, { remote, branch: 'main' });
    console.log(JSON.stringify({ approvalVerified: authorization.admitted?.keyId === signed.intent.keyId, keyId: signed.intent.keyId }));
  } catch (error) {
    console.log(JSON.stringify({ approvalVerified: false, code: error?.code ?? 'failed' }));
  }
}

process.stdin.on('data', async (chunk) => {
  const text = chunk.toString();
  if (text.includes('sync')) { await fixture.syncWorkspace(); console.log(JSON.stringify({ synced: true })); }
  if (text.includes('approval')) void askApproval();
  if (text.includes('keys')) console.log(JSON.stringify({ keys: (await services.ownerKeys.list()).body.keys }));
});
process.stdin.on('end', stop);
process.on('SIGTERM', stop);

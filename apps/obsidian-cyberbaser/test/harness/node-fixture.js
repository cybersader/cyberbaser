#!/usr/bin/env bun
// A disposable owner node for the phone-step harness run: synthetic Git vault,
// local bare remote, simulated build/deploy/live checks, proposal review on,
// owner publication of one workspace note, Iroh on through the given relay.
// Prints one JSON line, runs until stdin closes, then removes everything.
// Usage: bun node-fixture.js <relay: n0 | http://127.0.0.1:PORT/> <port> <workspace-text-file>
import { readFile } from 'node:fs/promises';
import { createAgentProposalRehearsal, PUBLICATION_MAPPING_ID } from '../../../owner-alpha/bin/agent-proposal-rehearsal.js';
import { AGENT_REHEARSAL_DELIVERY_PATH } from '../../../owner-alpha/bin/suggestions-rehearsal-fixture.js';

const [relay, port, workspaceFile] = process.argv.slice(2);
const before = { source: 'synthetic-workspace', path: AGENT_REHEARSAL_DELIVERY_PATH,
  text: '---\ntitle: Workspace note\n---\n\n# Workspace note\n\nStore the notes in the blue folder.\n' };
const after = { ...before, text: before.text.replace('blue folder', 'green binder') };
const workspaceText = await readFile(workspaceFile, 'utf8');
// The workspace note is not bound up front: the phone's first Publish asks the
// owner to link it on the Devices page. A "sync" line on stdin then delivers the
// phone's text to the node's workspace copy, as a sync would.
const fixture = await createAgentProposalRehearsal({ port: Number(port), before, after, iroh: relay, publication: { workspaceText, bind: false } });
let closing = false;
async function stop() {
  if (closing) return;
  closing = true;
  await fixture.cleanup().catch((error) => console.error(`cleanup: ${error.message}`));
  process.exit(0);
}
console.log(JSON.stringify({ ownerOrigin: fixture.runtime.ownerOrigin, signInUrl: fixture.issueSignInUrl(),
  deliveryPath: AGENT_REHEARSAL_DELIVERY_PATH, mappingId: PUBLICATION_MAPPING_ID, agentQueueId: fixture.queueId, root: fixture.root }));
process.stdin.on('data', async (chunk) => {
  if (chunk.toString().includes('sync')) { await fixture.syncWorkspace(); console.log(JSON.stringify({ synced: true })); }
});
process.stdin.on('end', stop);
process.on('SIGTERM', stop);

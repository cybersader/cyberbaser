import { expect, test } from 'bun:test';
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyChangeSetProposal } from '@cyberbaser/proposal';
import { AGENT_LABEL, createAgentProposalRehearsal, runAgentChild } from '../bin/agent-proposal-rehearsal.js';
import { generateKey } from '../bin/owner-alpha-keys.js';
import { AGENT_REHEARSAL_DELIVERY_PATH, createSuggestionsFixture, startSuggestionsRehearsal } from '../bin/suggestions-rehearsal-fixture.js';

const projectRoot = path.resolve(import.meta.dir, '../../..');
const capture = (text) => ({ source: 'workspace-fixture', path: 'draft.md', text });
const before = '---\ntitle: Workspace note\n---\n\n# Workspace note\n\nStore the notes in the blue folder.\n';
const after = before.replace('blue folder', 'green binder');

function freePorts() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const listeners = [];
    try {
      const port = 48500 + Math.floor(Math.random() * 7000);
      for (let offset = 0; offset < 3; offset += 1) listeners.push(Bun.serve({ hostname: '127.0.0.1', port: port + offset, fetch: () => new Response('reserved') }));
      return port;
    } catch { /* try a different loopback port triple */ }
    finally { for (const listener of listeners) listener.stop(true); }
  }
  throw new Error('no free loopback port triple');
}

async function ownerSession(fixture) {
  const login = await fetch(fixture.issueSignInUrl(), { redirect: 'manual', signal: AbortSignal.timeout(5000) });
  expect(login.status).toBe(303);
  const cookie = login.headers.get('set-cookie')?.split(';', 1)[0];
  expect(cookie).toBeTruthy();
  return (route, body) => fetch(`${fixture.ownerOrigin}${route}`, { redirect: 'error', signal: AbortSignal.timeout(5000),
    headers: { Cookie: cookie, Origin: fixture.ownerOrigin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
}

async function approve(owner, queueId) {
  const detail = await owner(`/owner/review/${queueId}`);
  expect(detail.status).toBe(200);
  const html = await detail.text();
  expect(html).toContain(`From ${AGENT_LABEL}, an agent`);
  expect(html).toContain('Build and publication simulated. No public changes.');
  const csrf = html.match(/data-csrf="([^"]+)"/u)?.[1];
  const reviewEvidenceDigest = html.match(/data-review-evidence-digest="([^"]+)"/u)?.[1];
  expect(csrf).toBeTruthy();
  expect(reviewEvidenceDigest).toBeTruthy();
  const approval = await owner(`/api/review/${queueId}/decision`, { queueId, reviewEvidenceDigest, csrf,
    action: 'approve', reason: 'Approve this disposable exact change.' });
  expect(approval.status, await approval.text()).toBe(201);
  return csrf;
}

test('agent child reaches real inbox; unchanged and wrong keys cannot add work; only owner Apply pushes', async () => {
  const fixture = await createAgentProposalRehearsal({ port: freePorts(), before: capture(before), after: capture(after) });
  const delivery = path.join(fixture.checkout, AGENT_REHEARSAL_DELIVERY_PATH);
  try {
    const owner = await ownerSession(fixture);
    const list = async () => (await (await owner('/api/review')).json()).actionable;
    const [item] = await list();
    expect(item.summary).toMatchObject({ queueId: fixture.queueId, lane: 'lane-signed',
      submitter: { ...fixture.entry.actor, keyId: fixture.entry.keyId } });
    await writeFile(fixture.agent.capture, JSON.stringify(capture(before)));
    expect(await runAgentChild(fixture.agent)).toEqual({ code: 0, stdout: 'Unchanged; nothing submitted.', stderr: '' });
    await writeFile(fixture.agent.capture, JSON.stringify(capture(after)));
    const wrongKey = path.join(path.dirname(fixture.agent.key), 'wrong.json');
    await generateKey({ label: 'Unenrolled key', kind: 'agent', grants: ['propose'], file: wrongKey });
    expect(await runAgentChild({ ...fixture.agent, key: wrongKey })).toEqual({ code: 1, stdout: '', stderr: 'proposal-submission-refused' });
    expect(await list()).toHaveLength(1);

    const propertiesEdit = before.replace('title: Workspace note', 'title: Changed title');
    await writeFile(fixture.agent.capture, JSON.stringify(capture(propertiesEdit)));
    const props = await runAgentChild(fixture.agent);
    expect(props.code).toBe(0);
    expect(props.stderr).toContain('changes properties and cannot be applied');
    const propertiesId = JSON.parse(props.stdout).queueId;
    expect((await list()).map(({ summary }) => summary.queueId)).toContain(propertiesId);
    await approve(owner, propertiesId);
    const propertiesDecision = await (await owner(`/api/decisions/${propertiesId}`)).json();
    expect(propertiesDecision.application).toMatchObject({ state: 'unapplicable', reason: 'frontmatter-change' });

    const csrf = await approve(owner, fixture.queueId);
    expect(await readFile(delivery, 'utf8')).toBe(before);
    const baseHead = await fixture.git(fixture.remote, ['rev-parse', 'HEAD']);
    const apply = await owner(`/api/review/${fixture.queueId}/apply`, { queueId: fixture.queueId, csrf });
    expect(apply.status, await apply.clone().text()).toBe(202);
    const job = await apply.json();
    let state;
    for (let n = 0; n < 150; n += 1) {
      state = await (await owner(job.jsonUrl)).json();
      if (['completed', 'failed', 'blocked-pre-apply', 'manual-intervention', 'deployment-failed'].includes(state.state)) break;
      await Bun.sleep(50);
    }
    expect(state.state, JSON.stringify(state.failure)).toBe('completed');
    expect(await readFile(delivery, 'utf8')).toBe(after);
    const head = await fixture.git(fixture.remote, ['rev-parse', 'HEAD']);
    expect(head).not.toBe(baseHead);
    expect(head).toBe(await fixture.git(fixture.checkout, ['rev-parse', 'HEAD']));
    const jobHtml = await (await owner(job.statusUrl)).text();
    expect(jobHtml).toContain('Local rehearsal complete');
    expect(jobHtml).toContain('Simulating live confirmation');
  } finally { await fixture.cleanup(); }
  await expect(lstat(fixture.root)).rejects.toMatchObject({ code: 'ENOENT' });
}, 20_000);

test('LF workspace capture applied to a CRLF base produces only exact CRLF changes', async () => {
  const crlf = before.replaceAll('\n', '\r\n');
  const lfEdit = after.replace('green binder.', 'green binder.\nKeep that binder handy.');
  const fixture = await createAgentProposalRehearsal({ port: freePorts(), before: capture(crlf), after: capture(lfEdit) });
  try {
    const owner = await ownerSession(fixture);
    const detail = await (await owner(`/api/review/${fixture.queueId}`)).json();
    expect(detail.summary.submitter.label).toBe(AGENT_LABEL);
    const actual = applyChangeSetProposal(Buffer.from(crlf), detail.evidence.proposal);
    expect(actual.equals(Buffer.from(lfEdit.replaceAll('\n', '\r\n')))).toBe(true);
    expect(await readFile(path.join(fixture.checkout, AGENT_REHEARSAL_DELIVERY_PATH), 'utf8')).toBe(crlf);
  } finally { await fixture.cleanup(); }
}, 15_000);

test('launcher headless mode reaches authenticated owner review and removes its temporary directory', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-launch-test-'));
  try {
    const child = Bun.spawn([process.execPath, 'run', '--cwd', 'docs', 'review:agent-proposal', '--headless', '--port', String(freePorts())], {
      cwd: projectRoot, env: { ...process.env, TMPDIR: root }, stdout: 'pipe', stderr: 'pipe',
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stderr).toBe(0);
    expect(stdout).toMatch(/Verified Q-[0-9a-f-]+ in the owner inbox as Workspace Draft Agent; temporary directory removed\./u);
    expect(await readdir(root)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 20_000);

test('agent rehearsal refuses an external configured socket or Git destination before the runtime starts', async () => {
  const fixture = await createSuggestionsFixture({ port: freePorts(), agentBase: before });
  try {
    const config = { ...fixture.config, signedRequestSocket: '/tmp/outside-rehearsal.sock' };
    await writeFile(fixture.configFile, JSON.stringify(config));
    await expect(startSuggestionsRehearsal(fixture, { simulatedRender: true })).rejects.toThrow('socket containment refused');
    config.signedRequestSocket = path.join(fixture.root, 'signed.sock');
    await writeFile(fixture.configFile, JSON.stringify(config));
    await fixture.git(fixture.checkout, ['remote', 'set-url', '--push', 'origin', '/tmp/outside-rehearsal.git']);
    await expect(startSuggestionsRehearsal(fixture, { simulatedRender: true })).rejects.toThrow('remote containment refused');
  } finally { await fixture.cleanup(); }
});

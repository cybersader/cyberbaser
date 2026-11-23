import { expect, test } from 'bun:test';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { AGENT_LABEL, createAgentProposalRehearsal } from '../bin/agent-proposal-rehearsal.js';
import { agentProcessEnvironment } from '../bin/agent-propose.js';
import { AGENT_REHEARSAL_DELIVERY_PATH } from '../bin/suggestions-rehearsal-fixture.js';

// Pair a real agent CLI over Iroh, confirm on the owner route, submit a
// proposal over Iroh into the real queue, revoke, and see the next one refused.
// 'none' runs on loopback with direct paths only. 'n0' goes through n0's public
// relay and runs only with CYBERBASER_IROH_RELAY_TEST=1.

const capture = (text) => ({ source: 'workspace-fixture', path: 'draft.md', text });
const before = '---\ntitle: Workspace note\n---\n\n# Workspace note\n\nStore the notes in the blue folder.\n';
const after = before.replace('blue folder', 'green binder');
const bin = (name) => path.join(import.meta.dir, '..', 'bin', name);

function freePorts() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const listeners = [];
    try {
      const port = 48500 + Math.floor(Math.random() * 7000);
      for (let offset = 0; offset < 3; offset += 1) listeners.push(Bun.serve({ hostname: '127.0.0.1', port: port + offset, fetch: () => new Response('reserved') }));
      return port;
    } catch { /* try another */ }
    finally { for (const listener of listeners) listener.stop(true); }
  }
  throw new Error('no free loopback port triple');
}

async function ownerSession(fixture) {
  const login = await fetch(fixture.issueSignInUrl(), { redirect: 'manual', signal: AbortSignal.timeout(5000) });
  const cookie = login.headers.get('set-cookie')?.split(';', 1)[0];
  expect(cookie).toBeTruthy();
  const call = (route, body) => fetch(`${fixture.ownerOrigin}${route}`, { redirect: 'error', signal: AbortSignal.timeout(10_000),
    headers: { Cookie: cookie, Origin: fixture.ownerOrigin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
  const page = await call('/owner/devices');
  expect(page.status).toBe(200);
  const csrf = (await page.text()).match(/data-csrf="([^"]+)"/u)?.[1];
  expect(csrf).toBeTruthy();
  return { call, csrf };
}

function spawn(args) {
  return Bun.spawn([process.execPath, ...args], { env: agentProcessEnvironment(), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
}

async function propose(fixture, stateFile) {
  const { capture: file, checkout } = fixture.agent;
  const child = spawn([bin('agent-propose.js'), file, AGENT_REHEARSAL_DELIVERY_PATH, checkout, stateFile, 'iroh']);
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

async function waitFor(check, ms = 60_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await Bun.sleep(150);
  }
  throw new Error('timed out');
}

export async function pairSubmitRevoke(relay) {
  const timings = {};
  const fixture = await createAgentProposalRehearsal({ port: freePorts(), before: capture(before), after: capture(after), iroh: relay });
  try {
    const { call, csrf } = await ownerSession(fixture);
    const stateFile = path.join(fixture.root, 'agent', 'paired.json');

    // Refusals before anything happens: an agent asking for more than propose, no CSRF.
    expect((await call('/owner/devices/pair', { kind: 'agent', access: 'full', label: 'Greedy', csrf })).status).toBe(409);
    expect((await call('/owner/devices/pair', { kind: 'agent', access: 'propose', label: 'NoCsrf', csrf: 'A'.repeat(43) })).status).toBe(403);

    let t = performance.now();
    const started = await (await call('/owner/devices/pair', { kind: 'agent', access: 'propose', label: 'Iroh agent', csrf })).json();
    expect(started.code.startsWith('cb1.')).toBe(true);
    const child = spawn([bin('cyberbaser-pair.js'), started.code, '--state', stateFile]);
    const stdout = new Response(child.stdout).text();
    const pending = await waitFor(async () => {
      const state = await (await call('/owner/devices/state')).json();
      return state.pairings.find((item) => item.enrollmentId === started.enrollmentId && item.state === 'awaiting');
    });
    timings.attemptMs = Math.round(performance.now() - t);
    // Nothing is enrolled before Confirm.
    await expect(lstat(stateFile)).rejects.toThrow();
    expect((await (await call('/owner/devices/state')).json()).devices.some((d) => d.label === 'Iroh agent')).toBe(false);
    // Confirm requires the session's CSRF and accepts no grants.
    expect((await call('/owner/devices/confirm', { enrollmentId: started.enrollmentId, words: pending.words, grants: ['publish'], csrf })).status).toBe(400);
    const confirmed = await call('/owner/devices/confirm', { enrollmentId: started.enrollmentId, words: pending.words, csrf });
    expect(confirmed.status).toBe(200);
    expect(await child.exited).toBe(0);
    const printed = await stdout;
    expect(printed).toContain(`Check that your owner screen shows: ${pending.words.join(' ')}`);
    timings.pairMs = Math.round(performance.now() - t);
    const devices = (await (await call('/owner/devices/state')).json()).devices;
    const paired = devices.find((d) => d.label === 'Iroh agent');
    expect(paired).toMatchObject({ kind: 'agent', grants: ['propose'], revoked: false, paired: true });

    // Reusing the same code enrols nothing.
    const reuse = spawn([bin('cyberbaser-pair.js'), started.code, '--state', path.join(fixture.root, 'agent', 'second.json')]);
    expect(await reuse.exited).toBe(1);

    t = performance.now();
    const submitted = await propose(fixture, stateFile);
    timings.submitMs = Math.round(performance.now() - t);
    expect(submitted.code, submitted.stderr).toBe(0);
    const { queueId } = JSON.parse(submitted.stdout);
    const list = (await (await call('/api/review')).json()).actionable;
    const item = list.find(({ summary }) => summary.queueId === queueId);
    expect(item.summary.submitter.label).toBe('Iroh agent');
    expect(item.summary.submitter.keyId).toBe(paired.keyId);
    expect(list.some(({ summary }) => summary.submitter.label === AGENT_LABEL)).toBe(true); // the Unix socket still works

    expect((await call('/owner/devices/revoke', { keyId: paired.keyId, csrf })).status).toBe(200);
    const refused = await propose(fixture, stateFile);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toBe('proposal-submission-refused');
    const afterRevoke = (await (await call('/api/review')).json()).actionable;
    expect(afterRevoke.length).toBe(list.length);
    // Revocation survives in the private store.
    expect((await (await call('/owner/devices/state')).json()).devices.find((d) => d.keyId === paired.keyId).revoked).toBe(true);
    return timings;
  } finally {
    await fixture.cleanup();
  }
}

test('loopback Iroh: pair with the real CLI, confirm, submit into the queue, revoke, refused', async () => {
  const timings = await pairSubmitRevoke('none');
  console.log(`loopback timings ${JSON.stringify(timings)}`);
}, 120_000);

test.skipIf(process.env.CYBERBASER_IROH_RELAY_TEST !== '1')('n0 public relay: pair, submit, revoke (opt-in)', async () => {
  const timings = await pairSubmitRevoke('n0');
  console.log(`n0 relay timings ${JSON.stringify(timings)}`);
}, 180_000);

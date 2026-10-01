#!/usr/bin/env bun
import { chmod, lstat, mkdir, open, readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockupServer } from '../src/server.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const STATUS_DIR = path.join(ROOT, '.workspace', 'proposal-review-mockup');
const STATUS_FILE = path.join(STATUS_DIR, 'status.json');
const rawPort = process.env.CYBERBASER_PROPOSAL_MOCKUP_PORT ?? '4328';
const port = Number(rawPort);
if (!/^[0-9]+$/u.test(rawPort) || !Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new TypeError('CYBERBASER_PROPOSAL_MOCKUP_PORT must be an integer from 1024 through 65535');
const noOpen = process.env.CYBERBASER_PROPOSAL_MOCKUP_NO_OPEN === '1';

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}
async function inspectStatus() {
  let handle;
  try {
    handle = await open(STATUS_FILE, 'r');
    const [content, stats] = await Promise.all([handle.readFile('utf8'), handle.stat({ bigint: true })]);
    const value = JSON.parse(content);
    if (!Number.isSafeInteger(value.pid)) throw new Error('status PID is invalid');
    return { value, identity: { dev: stats.dev, ino: stats.ino } };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new Error('mockup status file is unreadable or invalid');
  } finally {
    await handle?.close();
  }
}
async function removeObservedStaleStatus(observed) {
  let current;
  try {
    current = await lstat(STATUS_FILE, { bigint: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (current.dev !== observed.identity.dev || current.ino !== observed.identity.ino) return;
  try { await rm(STATUS_FILE); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
}
async function claimStatus() {
  await mkdir(STATUS_DIR, { recursive: true, mode: 0o700 });
  await chmod(STATUS_DIR, 0o700);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const claimToken = randomUUID();
    try {
      const handle = await open(STATUS_FILE, 'wx', 0o600);
      const starting = { state: 'starting', pid: process.pid, claimToken, port, evidenceClass: 'static-design-only' };
      await handle.writeFile(`${JSON.stringify(starting, null, 2)}\n`, 'utf8');
      await handle.sync();
      await chmod(STATUS_FILE, 0o600);
      return { handle, claimToken };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const observed = await inspectStatus();
      if (observed === null) continue;
      if (observed.value.pid !== process.pid && alive(observed.value.pid)) throw new Error(`mockup status is owned by live PID ${observed.value.pid}`);
      await removeObservedStaleStatus(observed);
    }
  }
  throw new Error('could not claim mockup status ownership');
}
async function updateOwnedStatus(claim, value) {
  const observed = await inspectStatus();
  if (observed?.value.pid !== process.pid || observed.value.claimToken !== claim.claimToken) throw new Error('mockup status ownership changed during startup');
  await claim.handle.truncate(0);
  await claim.handle.write(`${JSON.stringify({ ...value, claimToken: claim.claimToken }, null, 2)}\n`, 0, 'utf8');
  await claim.handle.sync();
  const confirmed = await inspectStatus();
  if (confirmed?.value.pid !== process.pid || confirmed.value.claimToken !== claim.claimToken) throw new Error('mockup status update lost ownership');
}
async function removeOwnedStatus(claim) {
  try {
    const value = JSON.parse(await readFile(STATUS_FILE, 'utf8'));
    if (value.pid === process.pid && value.claimToken === claim?.claimToken) await rm(STATUS_FILE);
  } catch (error) {
    if (error?.code !== 'ENOENT') process.stderr.write(`Mockup status cleanup warning: ${error.message}\n`);
  } finally {
    await claim?.handle?.close();
  }
}
async function openBrowser(url) {
  const child = Bun.spawn(['xdg-open', url], { stdout: 'ignore', stderr: 'pipe' });
  const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(stderr.trim() || `xdg-open exited ${code}`);
}

let server;
let claim;
let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  server?.stop(true);
  await removeOwnedStatus(claim);
  process.exit(code);
}
process.once('SIGINT', () => { void stop(0); });
process.once('SIGTERM', () => { void stop(0); });
try {
  claim = await claimStatus();
  server = await startMockupServer({ port });
  await updateOwnedStatus(claim, { state: 'ready', pid: process.pid, url: server.url, startedAt: new Date().toISOString(), evidenceClass: 'static-design-only' });
  process.stdout.write(`Static proposal review mockup ready: ${server.url}\n`);
  process.stdout.write('Controls are memory-only. No decision or source effect can occur. Press Ctrl-C to stop.\n');
  if (!noOpen) await openBrowser(server.url);
  await new Promise(() => {});
} catch (error) {
  process.stderr.write(`Static proposal review mockup failed: ${error?.message ?? 'unexpected error'}\n`);
  await stop(1);
}

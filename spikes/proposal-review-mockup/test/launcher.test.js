import { afterEach, expect, test } from 'bun:test';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { MOCKUP_HOST } from '../src/server.js';

const ROOT = path.resolve(import.meta.dir, '../../..');
const LAUNCHER = path.join(ROOT, 'spikes', 'proposal-review-mockup', 'bin', 'launch.js');
const STATUS_DIR = path.join(ROOT, '.workspace', 'proposal-review-mockup');
const STATUS_FILE = path.join(STATUS_DIR, 'status.json');
const children = new Set();

// A launcher the maintainer is running right now legitimately owns the status claim.
// These tests must neither fail against it nor overwrite it, so they skip instead.
const foreignOwner = await (async () => {
  let value;
  try { value = JSON.parse(await readFile(STATUS_FILE, 'utf8')); } catch { return null; }
  if (!Number.isSafeInteger(value?.pid) || value.pid < 1) return null;
  try { process.kill(value.pid, 0); return value.pid; } catch (error) { return error?.code === 'EPERM' ? value.pid : null; }
})();
if (foreignOwner !== null) {
  process.stderr.write(`launcher tests skipped: mockup status is owned by live PID ${foreignOwner}\n`);
}
const launcherTest = test.skipIf(foreignOwner !== null);

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', reject);
    probe.listen(0, MOCKUP_HOST, () => {
      const { port } = probe.address();
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}
function launch(port) {
  const child = Bun.spawn(['bun', LAUNCHER], {
    cwd: ROOT,
    env: { ...process.env, CYBERBASER_PROPOSAL_MOCKUP_NO_OPEN: '1', CYBERBASER_PROPOSAL_MOCKUP_PORT: String(port) },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  children.add(child);
  void child.exited.then(() => children.delete(child));
  return child;
}
async function waitForStatus(predicate, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = JSON.parse(await readFile(STATUS_FILE, 'utf8'));
      if (predicate(value)) return value;
    } catch (error) {
      if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for launcher status');
}
async function waitForExit(child, timeoutMs = 8_000) {
  return Promise.race([
    child.exited,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timed out waiting for launcher exit')), timeoutMs)),
  ]);
}
async function statusExists() {
  try { await readFile(STATUS_FILE); return true; } catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}
async function clearStaleStatus() {
  let value;
  try { value = JSON.parse(await readFile(STATUS_FILE, 'utf8')); } catch (error) {
    if (error?.code === 'ENOENT') return;
    await rm(STATUS_FILE, { force: true });
    return;
  }
  const alive = (() => {
    if (!Number.isSafeInteger(value.pid) || value.pid < 1) return false;
    try { process.kill(value.pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
  })();
  if (!alive) await rm(STATUS_FILE, { force: true });
}

afterEach(async () => {
  const active = [...children];
  for (const child of active) {
    try { child.kill('SIGTERM'); } catch {}
  }
  await Promise.allSettled(active.map((child) => child.exited));
  children.clear();
  const existing = await (async () => {
    try { return JSON.parse(await readFile(STATUS_FILE, 'utf8')); } catch { return null; }
  })();
  if (existing && (!Number.isSafeInteger(existing.pid) || active.some((child) => child.pid === existing.pid))) await rm(STATUS_FILE, { force: true });
});

launcherTest('concurrent different-port launchers make one exclusive live claim and preserve cleanup ownership', async () => {
  await clearStaleStatus();
  expect(await statusExists()).toBe(false);
  const [portA, portB] = await Promise.all([freePort(), freePort()]);
  const first = launch(portA);
  const second = launch(portB);
  const ready = await waitForStatus((value) => value.state === 'ready' && [first.pid, second.pid].includes(value.pid));
  expect(ready.claimToken).toBeString();
  expect(ready.url === `http://${MOCKUP_HOST}:${portA}/` || ready.url === `http://${MOCKUP_HOST}:${portB}/`).toBe(true);
  const winner = ready.pid === first.pid ? first : second;
  const loser = winner === first ? second : first;
  expect(await waitForExit(loser)).not.toBe(0);
  const loserError = await new Response(loser.stderr).text();
  expect(loserError).toContain(`mockup status is owned by live PID ${winner.pid}`);
  winner.kill('SIGTERM');
  expect(await waitForExit(winner)).toBe(0);
  expect(await statusExists()).toBe(false);
}, 30_000);

launcherTest('a dead stale status owner is recovered and the new owner removes only its claim', async () => {
  await mkdir(STATUS_DIR, { recursive: true, mode: 0o700 });
  await chmod(STATUS_DIR, 0o700);
  await writeFile(STATUS_FILE, `${JSON.stringify({ state: 'ready', pid: 999_999_999, claimToken: 'stale-test-owner' })}\n`, { mode: 0o600 });
  const port = await freePort();
  const child = launch(port);
  const ready = await waitForStatus((value) => value.state === 'ready' && value.pid === child.pid);
  expect(ready.claimToken).not.toBe('stale-test-owner');
  child.kill('SIGTERM');
  expect(await waitForExit(child)).toBe(0);
  expect(await statusExists()).toBe(false);
}, 30_000);

launcherTest('startup failure releases the exclusive status claim', async () => {
  await clearStaleStatus();
  expect(await statusExists()).toBe(false);
  const occupiedPort = await freePort();
  const occupied = net.createServer();
  await new Promise((resolve, reject) => {
    occupied.once('error', reject);
    occupied.listen(occupiedPort, MOCKUP_HOST, resolve);
  });
  try {
    const child = launch(occupiedPort);
    expect(await waitForExit(child)).not.toBe(0);
    expect(await statusExists()).toBe(false);
  } finally {
    await new Promise((resolve) => occupied.close(resolve));
  }
}, 30_000);

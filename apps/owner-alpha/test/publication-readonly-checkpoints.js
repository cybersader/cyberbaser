// Narrow opt-in evidence for the six read-only integration cases, not a test runner.
// Ownership validation follows publication-rehearsal-harness.js without inventing
// that helper's rehearsal checkout/listener bindings for these smaller fixtures.
import { createHash } from 'node:crypto';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const CASE_IDS = Object.freeze(['runtime-prepare', 'runtime-deny', 'runtime-entry-expiry',
  'runtime-byte-capacity', 'server-full-page', 'server-deny']);
const STAGES = Object.freeze(['test', 'fixture-setup', 'action', 'cleanup']);
const ownedRoots = new Map();
const refused = () => { throw new Error('publication-review-checkpoint-refused'); };

async function privateDirectory(directory) {
  const metadata = await lstat(directory);
  if (!path.isAbsolute(directory) || !metadata.isDirectory() || metadata.isSymbolicLink()
    || metadata.uid !== process.getuid() || (metadata.mode & 0o777) !== 0o700
    || await realpath(directory) !== directory) refused();
}

async function createRecord(directory, name, record) {
  await privateDirectory(directory);
  const handle = await open(path.join(directory, name), 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  const parent = await open(directory, 'r');
  try { await parent.sync(); } finally { await parent.close(); }
}

async function rootIdentity(root) {
  const metadata = await lstat(root, { bigint: true });
  if (!path.isAbsolute(root) || path.dirname(root) !== await realpath(os.tmpdir())
    || !path.basename(root).startsWith('publication-runtime-') || !metadata.isDirectory()
    || metadata.isSymbolicLink() || metadata.uid !== BigInt(process.getuid())
    || (metadata.mode & 0o777n) !== 0o700n || await realpath(root) !== root) refused();
  return { root, realpath: await realpath(root), device: metadata.dev.toString(),
    inode: metadata.ino.toString(), uid: Number(metadata.uid), mode: '0700' };
}

async function runnerIdentity() {
  const stat = await readFile('/proc/self/stat', 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/u);
  if (Number(stat.slice(0, stat.indexOf(' '))) !== process.pid || !/^\d+$/u.test(fields[19])) refused();
  const cgroup = (await readFile('/proc/self/cgroup', 'utf8')).split('\n').find((line) => line.startsWith('0::'))?.slice(3);
  if (!cgroup?.startsWith('/')) refused();
  return { pid: process.pid, ppid: Number(fields[1]), startTicks: fields[19],
    cwd: await realpath('/proc/self/cwd'), executable: await realpath('/proc/self/exe'),
    cmdlineSha256: createHash('sha256').update(await readFile('/proc/self/cmdline')).digest('hex'),
    cgroup: { path: cgroup, classification: 'shared-or-unproven', stoppable: false } };
}

async function mark(trace, stage, edge, outcome = null, extra = {}) {
  if (!CASE_IDS.includes(trace.id) || !STAGES.includes(stage) || !['start', 'end'].includes(edge)
    || ![null, 'passed', 'failed'].includes(outcome)) refused();
  await createRecord(trace.directory, `${trace.id}-${stage}-${edge}.json`, {
    schemaVersion: 1, caseId: trace.id, stage, edge, outcome,
    recordedUtc: new Date().toISOString(), runner: trace.runner, ...extra,
  });
  console.error(`publication-review-checkpoint ${trace.id} ${stage}.${edge}${outcome ? ` ${outcome}` : ''}`);
}

async function stage(trace, name, operation) {
  await mark(trace, name, 'start');
  let ok = false;
  try { const result = await operation(); ok = true; return result; }
  finally { await mark(trace, name, 'end', ok ? 'passed' : 'failed'); }
}

/** Preserve the tests' existing afterEach removal, adding evidence only for owned roots. */
export async function cleanupPublicationReviewFixture(root, remove) {
  const trace = ownedRoots.get(root);
  if (!trace) return remove();
  let removed = false; let cleanupPassed = false;
  try {
    await stage(trace, 'cleanup', async () => {
      let identity;
      try { identity = await rootIdentity(root); }
      catch (error) { if (error?.code !== 'ENOENT') throw error; }
      if (identity) {
        if (!trace.root || JSON.stringify(identity) !== JSON.stringify(trace.root)) refused();
        await remove();
      }
      try { await lstat(root); refused(); }
      catch (error) { if (error?.code !== 'ENOENT') throw error; }
      removed = true;
    });
    cleanupPassed = true;
  } finally {
    await mark(trace, 'test', 'end', trace.bodyPassed && cleanupPassed && removed ? 'passed' : 'failed', { rootAbsent: removed });
    ownedRoots.delete(root);
  }
}

/** Setup receives one awaited callback that must run before the fixture's first Git call. */
export async function publicationReviewCase(id, setup, action) {
  if (!CASE_IDS.includes(id)) refused();
  const directory = process.env.CYBERBASER_PUBLICATION_TEST_EVIDENCE;
  if (!directory) return action(await setup(undefined));
  const trace = { id, directory, runner: await runnerIdentity(), root: null, allocated: false, bodyPassed: false };
  await mark(trace, 'test', 'start');
  const onRoot = async (root) => {
    if (trace.allocated) refused();
    trace.allocated = true;
    // Register before validation/persistence so afterEach can confirm the fixture's
    // immediate callback-failure cleanup instead of silently losing its root.
    ownedRoots.set(root, trace);
    trace.root = await rootIdentity(root);
    await createRecord(directory, `ownership-${id}.json`, { schemaVersion: 1, caseId: id,
      recordedUtc: new Date().toISOString(), fixture: trace.root, runner: trace.runner,
      boundary: 'root allocated and registered for cleanup; no Git or fixture setup has run' });
  };
  try {
    const fixture = await stage(trace, 'fixture-setup', () => setup(onRoot));
    await stage(trace, 'action', () => action(fixture));
    trace.bodyPassed = true;
  } finally {
    // Roots normally close through existing afterEach. A failure before allocation
    // has nothing to remove but still receives explicit terminal failure evidence.
    if (!trace.allocated) {
      await stage(trace, 'cleanup', async () => {});
      await mark(trace, 'test', 'end', trace.bodyPassed ? 'passed' : 'failed', { rootAbsent: true });
    }
  }
}

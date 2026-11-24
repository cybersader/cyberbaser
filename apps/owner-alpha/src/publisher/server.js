import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, realpath, unlink } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { validateOwnerAlphaConfig } from '../config.js';
import { OwnerAlphaError, fail } from '../errors.js';
import { validateJobId } from '../job-state.js';
import { createJobPublisher } from '../pipeline.js';
import { createPublisherStoreContext } from '../store.js';
import { READ_TIMEOUT_MS, REJECTION_CODES, readFrame, restrictSocket, validSocketGroup, validSocketPath } from './protocol.js';
import { FORGE_PROBLEMS, createForgeAccess } from './forge-access.js';
import { startForgeControl } from './forge-control.js';
import { createMirror } from './mirror.js';
import { createIsolatedPush } from './repository.js';
import { startOwnerServices } from './owner-services.js';
export { OWNER_FILES } from './owner-keys.js';

async function socketStat(socketPath) {
  try { return await lstat(socketPath, { bigint: true }); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

function unchanged(left, right) {
  return right !== null && left.dev === right.dev && left.ino === right.ino && left.ctimeNs === right.ctimeNs;
}

// With a socket group (an installed setup where the node runs under another
// account), the directory may let exactly that group reach the socket by name:
// mode 0710, never listable, never writable by the group.
async function assertPrivateDirectory(directory, uid, socketGroup = null) {
  const metadata = await lstat(directory, { bigint: true });
  const shared = socketGroup !== null;
  if (!metadata.isDirectory() || metadata.uid !== uid
    || (metadata.mode & 0o7777n) !== (shared ? 0o710n : 0o700n)
    || (shared && metadata.gid !== BigInt(socketGroup))
    || await realpath(directory) !== directory) {
    fail('publisher-unsafe-socket', shared
      ? 'publisher socket needs a real parent directory owned by the publisher, mode 0710, in the socket group'
      : 'publisher socket needs an owner-only real parent directory');
  }
  return metadata;
}


function refuseOccupied() {
  fail('publisher-socket-in-use', 'existing publisher socket path was not proven stale');
}

async function lockSocketOwner(handle) {
  // flock locks the inherited file description, so the lock stays with our
  // open handle after the helper exits. The kernel releases it on process death.
  const code = await new Promise((resolve, reject) => {
    const child = spawn('flock', ['--exclusive', '--nonblock', '--conflict-exit-code', '75', '3'], {
      stdio: ['ignore', 'ignore', 'ignore', handle.fd],
    });
    child.once('error', reject);
    child.once('exit', resolve);
  });
  if (code === 75) refuseOccupied();
  if (code !== 0) fail('publisher-start-failed', 'publisher could not acquire its socket ownership lock');
}

function fingerprint(metadata) {
  return `${metadata.dev}:${metadata.ino}:${metadata.ctimeNs}\n`;
}

async function clearStaleSocket(address, uid, ownerFile) {
  const present = await socketStat(address);
  if (present === null) return;
  const marker = Buffer.alloc(128);
  const { bytesRead } = await ownerFile.read(marker, 0, marker.length, 0);
  // Bun reports the same ENOENT for dead, busy and access-denied sockets.
  // Recover only our recorded inode, and only while holding its lifetime lock.
  if (!present.isSocket() || present.uid !== uid || present.nlink !== 1n
    || marker.subarray(0, bytesRead).toString('utf8') !== fingerprint(present)
    || !unchanged(present, await socketStat(address))) refuseOccupied();
  await unlink(address);
}

function listen(server, address) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ path: address, backlog: 8 }, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

// JSON.parse alone collapses duplicate member names. The only admissible object
// has exactly two scalar members; JSON.parse still enforces JSON escape grammar.
const STRING = String.raw`"(?:[^"\\]|\\.)*"`;
const MEMBER = `${STRING}\\s*:\\s*(?:${STRING}|[-0-9.eE+]+)`;
const TWO_MEMBERS = new RegExp(`^\\s*\\{\\s*${MEMBER}\\s*,\\s*${MEMBER}\\s*\\}\\s*$`, 'u');

function parseRequest(text) {
  if (!TWO_MEMBERS.test(text)) return null;
  try {
    const request = JSON.parse(text);
    if (request.v !== 1 || !Object.hasOwn(request, 'jobId') || Object.keys(request).length !== 2) return null;
    return validateJobId(request.jobId);
  } catch {
    return null;
  }
}

function rejectionCode(error) {
  if (!(error instanceof OwnerAlphaError)) return 'publisher-failed';
  if (error.code === 'owner-busy') return 'owner-approval-expired';
  if (error.code === 'artifact-not-found') return 'publisher-job-not-found';
  if (Object.hasOwn(FORGE_PROBLEMS, error.code)) return 'forge-access-unavailable';
  return REJECTION_CODES.includes(error.code) ? error.code : 'publisher-failed';
}

// owners (signed publish, owner-services.js): { directory, mode, enrollPort, nodeUid }.
// Its directory is the publisher's own state, given here and never read from config.
export async function startPublisher({ config, context, socketPath, repository, forgeAccess, forgeOptions, socketGroup = null, mirrorOptions = null,
  owners = null, log = undefined } = {}) {
  if (!validSocketPath(socketPath) || typeof process.getuid !== 'function' || !validSocketGroup(socketGroup)) {
    fail('publisher-unsafe-socket', 'publisher needs a private local Unix socket');
  }
  const uid = BigInt(process.getuid());
  const directory = path.dirname(socketPath);
  config = validateOwnerAlphaConfig(config);
  let publish;
  let active = null;
  let ready = false;
  let closing;
  let ownedSocket;
  let forgeControl = null;
  let ownerServices = null;
  const server = net.createServer((socket) => {
    socket.on('error', () => socket.destroy());
    const reply = (response) => socket.end(`${JSON.stringify(response)}\n`, () => socket.destroy());
    if (!ready) return socket.destroy();
    if (active !== null) return reply({ ok: false, code: 'publisher-busy' });
    const request = { socket, task: null };
    active = request;
    function release() {
      if (active === request) active = null;
    }
    function refuse(code) {
      clearTimeout(timer);
      stopReading();
      release();
      reply({ ok: false, code });
    }
    const timer = setTimeout(() => refuse('publisher-request-timeout'), READ_TIMEOUT_MS);
    const stopReading = readFrame(socket, (text) => {
      const jobId = parseRequest(text);
      if (jobId === null) return refuse('publisher-invalid-request');
      clearTimeout(timer);
      // Once this line is accepted, later bytes are never parsed. They cannot
      // affect the sole input (jobId), which is checked against durable evidence.
      request.task = (async () => {
        let response;
        try { response = { ok: true, status: await publish(jobId) }; }
        catch (error) { response = { ok: false, code: rejectionCode(error) }; }
        release();
        if (!socket.destroyed) reply(response);
      })();
    }, () => refuse('publisher-invalid-request'));
    function disconnected() {
      clearTimeout(timer);
      if (request.task === null) release();
    }
    socket.once('end', disconnected);
    socket.once('close', disconnected);
  });
  // Do not let an OS diagnostic (which can contain a socket path) reach logs.
  server.on('error', () => {});
  let ownerFile;
  try {
    const parent = await assertPrivateDirectory(directory, uid, socketGroup);
    const ownerPath = `${socketPath}.lock`;
    ownerFile = await open(ownerPath, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    const file = await ownerFile.stat({ bigint: true });
    if (!file.isFile() || file.nlink !== 1n || file.uid !== uid || (file.mode & 0o7777n) !== 0o600n) {
      fail('publisher-unsafe-socket', 'publisher socket ownership record must be a private regular file');
    }
    await lockSocketOwner(ownerFile);
    const lockedParent = await assertPrivateDirectory(directory, uid, socketGroup);
    const lockedFile = await socketStat(ownerPath);
    if (parent.dev !== lockedParent.dev || parent.ino !== lockedParent.ino
      || lockedFile === null || file.dev !== lockedFile.dev || file.ino !== lockedFile.ino) {
      fail('publisher-unsafe-socket', 'publisher socket directory or ownership record changed during startup');
    }
    await clearStaleSocket(socketPath, uid, ownerFile);
    const checkout = config.repository.checkout;
    const publisherContext = await createPublisherStoreContext(context, checkout);
    // Undefined means "from config"; null means this publisher pushes with no forge credential.
    forgeAccess = forgeAccess === undefined ? createForgeAccess(config, forgeOptions) : forgeAccess;
    // The mirror the node reads the remote branch from (config.publisher.mirror).
    const mirrorPath = config.publisher?.mirror ?? null;
    const mirror = mirrorPath === null || forgeAccess === null ? null
      : await createMirror({ directory: mirrorPath, uid: Number(uid), forgeAccess, ...(mirrorOptions ?? {}) });
    const pushCommit = await createIsolatedPush({ repository, checkout, uid: Number(uid), forgeAccess,
      onPushed: mirror === null ? null : (pushed) => mirror.adoptPack(pushed) });
    if (owners !== null) {
      ownerServices = await startOwnerServices({ owners, socketPath, uid: Number(uid), socketGroup,
        ...(log === undefined ? {} : { log }) });
    }
    // The caller holds the pipeline mutation lock; taking it here would deadlock.
    publish = createJobPublisher({ config, context: publisherContext, pushCommit, bindCommitMessage: true,
      approvalGate: ownerServices?.gate ?? null });
    await listen(server, socketPath);
    ownedSocket = await restrictSocket(socketPath, Number(uid), socketGroup);
    await ownerFile.truncate(0);
    await ownerFile.writeFile(fingerprint(ownedSocket));
    await ownerFile.sync();
    if (forgeAccess !== null) forgeControl = await startForgeControl({ socketPath, forgeAccess, uid: Number(uid), socketGroup, mirror });
    ready = true;
  } catch (error) {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    await ownerServices?.close();
    forgeAccess?.close?.();
    await ownerFile?.close();
    if (error instanceof OwnerAlphaError && [
      'publisher-unsafe-socket', 'publisher-socket-in-use', 'publisher-unsafe-repository', 'publisher-unsafe-store',
      'publisher-unsafe-mirror', 'publisher-unsafe-owner-state',
    ].includes(error.code)) throw error;
    fail('publisher-start-failed', 'publisher Unix socket could not start');
  }

  return Object.freeze({ close() {
    closing ??= (async () => {
      ready = false;
      forgeAccess?.close?.();
      const forgeClosed = forgeControl?.close();
      const ownersClosed = ownerServices?.close();
      const idle = new Promise((resolve) => server.close(resolve));
      const pending = active;
      if (pending?.task === null) pending.socket.destroy();
      try {
        await pending?.task;
        await idle;
        await forgeClosed;
        await ownersClosed;
        // net.Server normally removes the socket itself. Don't unlink a successor.
        if (unchanged(ownedSocket, await socketStat(socketPath))) await unlink(socketPath);
      } finally {
        await ownerFile.close();
      }
    })();
    return closing;
  } });
}

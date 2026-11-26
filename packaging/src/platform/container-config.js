// The container reconciler sees only two dedicated config volume roots. Their
// ancestors are fixed directories on the immutable image, not node state.
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { MAX_CONFIG_BYTES, validateOwnerAlphaConfig } from '../../../apps/owner-alpha/src/config.js';

export const CONTAINER_CONFIG = '/var/lib/cyberbaser-publisher-config/owner-alpha.json';
const SOURCE_DIRECTORY = '/var/lib/cyberbaser/config';
const DESTINATION_DIRECTORY = '/var/lib/cyberbaser-publisher-config';
const FILE = 'owner-alpha.json';
const NODE = 65532;
const PUBLISHER = 65533;
const SHARE = 65530;
const OPEN_PRIVATE = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

async function openDirectory(directory, uid, gid) {
  const handle = await open(directory, OPEN_PRIVATE | constants.O_DIRECTORY);
  try {
    const stat = await handle.stat();
    if (stat.uid !== uid || stat.gid !== gid || (stat.mode & 0o7777) !== 0o700) throw new Error('unsafe config directory');
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function readPrivate(file, uid, gid) {
  let handle;
  try { handle = await open(file, OPEN_PRIVATE); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== uid || stat.gid !== gid
      || (stat.mode & 0o7777) !== 0o600 || stat.size > MAX_CONFIG_BYTES) throw new Error('unsafe config file');
    // Bound the read even if the node changes the length after fstat.
    const bytes = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await handle.read(bytes, size, bytes.length - size, size);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    if (size > MAX_CONFIG_BYTES) throw new Error('oversized config file');
    return bytes.subarray(0, size);
  } finally { await handle.close(); }
}

function validateContainerPolicy(bytes) {
  const config = validateOwnerAlphaConfig(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  // Never let the node select a publisher-private filesystem path or a forge
  // credential provider. This image's supported publication form is private.
  if (config.workflow.provider !== 'private-site' || config.repository.checkout !== '/var/lib/cyberbaser-shared/notes/notes'
    || config.workspace.store !== '.workspace/owner-alpha/store'
    || config.publisher?.socketPath !== '/run/cyberbaser-publisher/publisher.sock'
    || config.publisher?.mirror !== '/var/lib/cyberbaser-shared/mirror/notes.git'
    || config.forgeAccess?.provider !== 'github-app' || config.forgeAccess?.stateDirectory !== '/var/lib/cyberbaser-publisher/forge') {
    throw new Error('config does not match the container publisher layout');
  }
}

// Internal parameters exist for focused filesystem tests, not CLI flags.
// Host supervisor serializes calls and owns restart and its acknowledgement.
export async function reconcileContainerConfig({ source = SOURCE_DIRECTORY, destination = DESTINATION_DIRECTORY,
  nodeUid = NODE, publisherUid = PUBLISHER, gid = SHARE } = {}) {
  const from = await openDirectory(source, nodeUid, gid);
  let to;
  try {
    to = await openDirectory(destination, publisherUid, gid);
    // Both directories stay open through the complete operation; no future
    // lookup follows a renamed or symlinked directory from the original path.
    const input = `/proc/self/fd/${from.fd}/${FILE}`;
    const outputDir = `/proc/self/fd/${to.fd}`;
    const output = `${outputDir}/${FILE}`;
    const before = await readPrivate(output, publisherUid, gid);
    const bytes = await readPrivate(input, nodeUid, gid);
    if (bytes === null) {
      if (before !== null) throw new Error('node config disappeared after setup');
      return 'missing';
    }
    validateContainerPolicy(bytes);
    if (!before?.equals(bytes)) {
      const temp = `${outputDir}/.config-${randomUUID()}`;
      const file = await open(temp, 'wx', 0o600);
      try {
        try {
          await file.writeFile(bytes);
          await file.chown(publisherUid, gid);
          await file.sync();
        } finally { await file.close(); }
        await rename(temp, output);
        await to.sync();
      } finally { await unlink(temp).catch((error) => { if (error.code !== 'ENOENT') throw error; }); }
    }
    return createHash('sha256').update(bytes).digest('hex');
  } finally {
    await to?.close();
    await from.close();
  }
}

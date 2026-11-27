import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { createDeviceKeyRegistry, createLiveDeviceKeyRegistry, isKeyId } from './device-keys.js';
import { readPrivateKeyJson } from './device-key-files.js';

// Devices and agents the owner paired, kept as create-once records in one
// owner-only directory outside the vault:
//   <keyId>.key.json      the enrolled registry entry, written once
//   <keyId>.revoked.json  the revocation, written once and never removed
// A key with a revocation record never verifies again, whatever else changes.
// Records from the optional static registry file are merged in read-only.

const KEY_SUFFIX = '.key.json';
const REVOKED_SUFFIX = '.revoked.json';
const MAX_RECORD_BYTES = 4096;
const YEAR_MS = 365 * 86_400_000;

async function privateDirectory(directory, { create = true } = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || path.normalize(directory) !== directory) {
    throw new Error('device store path must be absolute and normalized');
  }
  if (create) await mkdir(directory, { recursive: false, mode: 0o700 }).catch((error) => { if (error?.code !== 'EEXIST') throw error; });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o7777) !== 0o700
    || await realpath(directory) !== directory) throw new Error('device store must be an owner-only real directory');
}

async function syncDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
  try { await handle.sync(); } finally { await handle.close(); }
}

// Write a temporary file, flush it, then hard-link it into place. link() fails
// if the name exists, so a record is created exactly once and never replaced.
async function createOnce(directory, name, value) {
  const temporary = path.join(directory, `.tmp-${randomUUID()}`);
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
    await handle.sync();
  } finally { await handle.close(); }
  try {
    await link(temporary, path.join(directory, name));
  } finally {
    await rm(temporary, { force: true });
  }
  await syncDirectory(directory);
}

async function readRecords(directory) {
  const keys = [];
  const revoked = new Set();
  for (const name of (await readdir(directory)).sort()) {
    if (name.startsWith('.tmp-')) { await rm(path.join(directory, name), { force: true }); continue; }
    if (name.endsWith(KEY_SUFFIX)) {
      const entry = await readPrivateKeyJson(path.join(directory, name), MAX_RECORD_BYTES);
      if (entry?.keyId !== name.slice(0, -KEY_SUFFIX.length)) throw new Error('device record name mismatch');
      keys.push(entry);
    } else if (name.endsWith(REVOKED_SUFFIX)) {
      const record = await readPrivateKeyJson(path.join(directory, name), MAX_RECORD_BYTES);
      const keyId = name.slice(0, -REVOKED_SUFFIX.length);
      if (record?.keyId !== keyId || !isKeyId(keyId)) throw new Error('revocation record name mismatch');
      revoked.add(keyId);
    } else throw new Error('unexpected file in device store');
  }
  return { keys, revoked };
}

function merged(ownerId, staticEntries, records) {
  const entries = [...staticEntries, ...records.keys].map((entry) => (
    records.revoked.has(entry.keyId) ? { ...entry, revoked: true } : entry));
  return { ownerId, entries };
}

function publicView(key) {
  return Object.freeze({ keyId: key.keyId, kind: key.actor.kind, label: key.actor.label, grants: [...key.grants],
    revoked: key.revoked, notAfter: key.notAfter, paired: key.irohNodeId !== null });
}

export async function openDeviceStore({ directory, ownerId, staticInput = null, clock = Date.now, onRevoke = () => {}, parentDirectory = null }) {
  if (parentDirectory !== null) {
    if (path.dirname(directory) !== parentDirectory) throw new Error('device store must sit in the Iroh state directory');
    await privateDirectory(parentDirectory, { create: false });
  }
  await privateDirectory(directory);
  const staticEntries = staticInput === null ? [] : [...staticInput.entries];
  if (staticInput !== null && staticInput.ownerId !== ownerId) throw new Error('registry owner mismatch');
  let records = await readRecords(directory);
  const live = createLiveDeviceKeyRegistry(merged(ownerId, staticEntries, records));
  let queue = Promise.resolve();
  const serial = (task) => {
    const next = queue.then(task);
    queue = next.catch(() => {});
    return next;
  };
  let revokeListener = onRevoke;

  return Object.freeze({
    registry: live.registry,
    directory,
    list: () => live.registry.entries().map((key) => publicView(live.registry.find(key.keyId))),
    setRevokeListener(listener) { revokeListener = listener; },

    enrol({ kind, label, grants, publicKey, irohNodeId }) {
      return serial(async () => {
        const keyId = `${kind === 'agent' ? 'agent' : 'device'}-${randomUUID()}`;
        const notBefore = clock();
        const entry = { keyId, publicKey, actor: { kind, id: keyId, label }, grants: [...grants],
          notBefore, notAfter: notBefore + YEAR_MS, revoked: false, irohNodeId };
        const next = { keys: [...records.keys, entry], revoked: records.revoked };
        // Validate the whole next set (agent grant limit, unique public key,
        // curve point) before anything is written.
        createDeviceKeyRegistry(merged(ownerId, staticEntries, next));
        await createOnce(directory, `${keyId}${KEY_SUFFIX}`, entry);
        records = next;
        live.replace(merged(ownerId, staticEntries, records));
        return Object.freeze({ keyId });
      });
    },

    revoke(keyId) {
      return serial(async () => {
        const key = isKeyId(keyId) ? live.registry.find(keyId) : null;
        if (!key) throw new Error('unknown device');
        if (!records.revoked.has(keyId)) {
          await createOnce(directory, `${keyId}${REVOKED_SUFFIX}`, { keyId, revokedAt: clock() })
            .catch((error) => { if (error?.code !== 'EEXIST') throw error; });
          records = { keys: records.keys, revoked: new Set([...records.revoked, keyId]) };
          live.replace(merged(ownerId, staticEntries, records));
        }
        try { revokeListener(key); } catch { /* closing connections is best effort */ }
      });
    },
  });
}

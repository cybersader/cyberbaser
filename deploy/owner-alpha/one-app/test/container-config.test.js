import { expect, test } from 'bun:test';
import { chmod, link, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ownerConfigFromSetup } from '../../../../apps/owner-alpha/src/first-run.js';
import { reconcileContainerConfig } from '../../../../packaging/src/platform/container-config.js';
import { LAYOUT } from '../../../../packaging/src/platform/linux-systemd.js';

function valid() {
  return structuredClone(ownerConfigFromSetup({ repository: 'lab-owner/lab-notes', forgeApp: { clientId: 'Iv1.labTest1234' },
    notes: { branch: 'main' }, website: { source: 'private' } }, {
    listen: { host: '127.0.0.1', port: 4317 }, reviewSocket: `${LAYOUT.nodeRun}/review.sock`,
    checkout: `${LAYOUT.notes}/notes`, publisherSocket: LAYOUT.publisherSocket, mirror: LAYOUT.mirror,
    irohStateDirectory: `${LAYOUT.nodeHome}/iroh`, forgeStateDirectory: LAYOUT.publisherForge, relay: 'none', reach: 'relay-only',
  }).config);
}

async function isolated(run) {
  const root = await mkdtemp(path.join(tmpdir(), 'one-app-config-test-'));
  const source = path.join(root, 'in');
  const destination = path.join(root, 'out');
  const input = path.join(source, 'owner-alpha.json');
  const output = path.join(destination, 'owner-alpha.json');
  await mkdir(source, { mode: 0o700 });
  await mkdir(destination, { mode: 0o700 });
  const sync = (options) => reconcileContainerConfig({ source, destination, nodeUid: process.getuid(), publisherUid: process.getuid(), gid: process.getgid(), ...options });
  const put = (bytes, mode = 0o600) => writeFile(input, bytes, { mode, flag: 'wx' });
  try { await run({ root, source, input, output, sync, put }); } finally { await rm(root, { recursive: true, force: true }); }
}

test('config absence starts in setup; a valid snapshot is copied exactly and is idempotent', () => isolated(async ({ input, output, sync, put }) => {
  expect(await sync()).toBe('missing');
  const bytes = `${JSON.stringify(valid(), null, 2)}\n`;
  await put(bytes);
  const digest = await sync();
  expect(digest).toMatch(/^[0-9a-f]{64}$/u);
  const prior = await stat(output);
  expect(prior.mode & 0o777).toBe(0o600);
  expect(await readFile(output, 'utf8')).toBe(bytes);
  expect(await sync()).toBe(digest);
  expect((await stat(output)).ino).toBe(prior.ino);
  await rm(input);
  await expect(sync()).rejects.toThrow('disappeared');
  expect(await readFile(output, 'utf8')).toBe(bytes);
}));

test('wrong shape, publisher-private path override and bad UTF-8 cannot replace last good config', () => isolated(async ({ input, output, sync, put }) => {
  const raw = valid();
  await put(JSON.stringify(raw));
  await sync();
  const old = await readFile(output, 'utf8');
  raw.forgeAccess.stateDirectory = '/somewhere-else';
  for (const bad of ['{', '{}', JSON.stringify(raw), Buffer.from([0xff])]) {
    await rm(input);
    await put(bad);
    await expect(sync()).rejects.toThrow();
    expect(await readFile(output, 'utf8')).toBe(old);
  }
}));

test('reject symlinked directory, symlinked or hard-linked file, public mode and oversized body', () => isolated(async ({ root, source, input, output, sync, put }) => {
  const target = `${input}.target`;
  await writeFile(target, JSON.stringify(valid()), { mode: 0o600 });
  await symlink(target, input);
  await expect(sync()).rejects.toThrow();
  await rm(input);
  await link(target, input);
  await expect(sync()).rejects.toThrow('unsafe config file');
  await rm(input);
  await put('{}');
  await chmod(input, 0o644);
  await expect(sync()).rejects.toThrow('unsafe config file');
  await rm(input);
  await put(Buffer.alloc(256 * 1024 + 1));
  await expect(sync()).rejects.toThrow('unsafe config file');
  await rm(input);
  await put(JSON.stringify(valid()));
  const displaced = path.join(root, 'displaced');
  await rename(source, displaced);
  await symlink(displaced, source);
  await expect(sync()).rejects.toThrow();
  await expect(stat(output)).rejects.toThrow();
}));

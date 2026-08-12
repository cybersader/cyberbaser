import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stageIntakeConfig } from '../stage-config.js';

const cleanup = [];

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'account-free-intake-stage-'));
  cleanup.push(root);
  const bindingsRoot = path.join(root, 'bindings');
  const gitDir = path.join(root, 'objects.git');
  const queueRoot = path.join(root, 'queue');
  const runtime = path.join(root, 'run');
  const source = path.join(root, 'source.json');
  const destination = path.join(runtime, 'active.json');
  await mkdir(bindingsRoot, { mode: 0o700 });
  await mkdir(gitDir, { mode: 0o700 });
  await mkdir(runtime, { mode: 0o700 });
  await chmod(runtime, 0o700);
  const config = {
    schemaVersion: 1,
    enabled: true,
    publicOrigin: 'https://intake.example.invalid',
    listen: { host: '0.0.0.0', port: 8080 },
    allowedFormOrigins: ['https://wiki.example.invalid'],
    repository: 'https://forge.example.invalid/owner/wiki.git',
    bindingsRoot,
    gitDir,
    queue: {
      root: queueRoot,
      maxPendingEntries: 1000,
      maxRetainedBytes: 268435456,
      maxPendingPerSource: 25,
      pendingRetentionMs: 2592000000,
      expiredGraceMs: 604800000,
    },
    limits: {
      maxBodyBytes: 98304,
      requestTimeoutMs: 5000,
      maxConcurrentRequests: 4,
      tokenBucketCapacity: 20,
      tokenBucketRefillPerSecond: 1,
    },
  };
  const bytes = `${JSON.stringify(config, null, 2)}\n`;
  await writeFile(source, bytes, { mode: 0o400 });
  await chmod(source, 0o400);
  return { root, bindingsRoot, gitDir, queueRoot, runtime, source, destination, config, bytes };
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((target) => rm(target, { recursive: true, force: true })));
});

describe('account-free intake config staging', () => {
  test('copies an unchanged read-only source into one private validated active file', async () => {
    const item = await fixture();
    const config = await stageIntakeConfig({ source: item.source, destination: item.destination });

    expect(config.publicOrigin).toBe(item.config.publicOrigin);
    expect(config.queue.root).toBe(item.queueRoot);
    expect(await readFile(item.destination, 'utf8')).toBe(item.bytes);
    const metadata = await lstat(item.destination);
    expect(metadata.isFile()).toBe(true);
    expect(metadata.nlink).toBe(1);
    expect(metadata.mode & 0o777).toBe(0o600);
    expect(metadata.uid).toBe(process.getuid());
    expect(metadata.gid).toBe(process.getgid());
  });

  test('rejects writable or symlinked source configuration', async () => {
    const writable = await fixture();
    await chmod(writable.source, 0o600);
    await expect(stageIntakeConfig({ source: writable.source, destination: writable.destination }))
      .rejects.toThrow('source config must have no write permission bits');

    const linked = await fixture();
    const alias = path.join(linked.root, 'alias.json');
    await symlink(linked.source, alias);
    await expect(stageIntakeConfig({ source: alias, destination: linked.destination }))
      .rejects.toThrow('source config must not be a symlink');
  });

  test('rejects a pre-existing destination and an unsafe runtime directory', async () => {
    const occupied = await fixture();
    await writeFile(occupied.destination, '{}\n', { mode: 0o600 });
    await expect(stageIntakeConfig({ source: occupied.source, destination: occupied.destination }))
      .rejects.toThrow('active config destination must be absent before staging');

    const broad = await fixture();
    await chmod(broad.runtime, 0o755);
    await expect(stageIntakeConfig({ source: broad.source, destination: broad.destination }))
      .rejects.toThrow('active config parent must have mode 0700');
  });

  test('removes a staged file when the fixed container paths are not exact', async () => {
    const item = await fixture();
    await expect(stageIntakeConfig({
      source: item.source,
      destination: item.destination,
      requireContainerContract: true,
    })).rejects.toThrow('container config paths do not match the fixed mount contract');
    await expect(lstat(item.destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

import { afterEach, expect, test } from 'bun:test';
import { chmod, lstat, mkdir, mkdtemp, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inspectRendererSource, installRenderer, parseFingerprint } from '../src/renderer-install.js';
import { UNIT_TEXTS } from '../src/units.js';

// install --renderer: the site's own renderer is checked, copied whole into the
// node's state and handed to the node account with no group/other write.
// Here the "node account" is this user, so no root is needed.

const cleanup = [];
afterEach(async () => { for (const dir of cleanup.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function renderer() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cb-renderer-install-'));
  cleanup.push(root);
  const source = path.join(root, 'source');
  await mkdir(path.join(source, 'node_modules', '.bin'), { recursive: true });
  await mkdir(path.join(source, 'quartz', 'components'), { recursive: true });
  await mkdir(path.join(source, '.quartz-cache'));
  await writeFile(path.join(source, 'build'), '#!/usr/bin/env bash\necho build\n', { mode: 0o700 });
  await writeFile(path.join(source, 'quartz.config.ts'), 'export default {}\n', { mode: 0o666 });
  await writeFile(path.join(source, 'quartz', 'components', 'Hero.tsx'), 'x\n');
  await writeFile(path.join(source, 'node_modules', 'tool.js'), 'x\n');
  await writeFile(path.join(source, '.quartz-cache', 'big'), 'cache\n');
  await chmod(path.join(source, 'quartz.config.ts'), 0o666);
  await symlink('../tool.js', path.join(source, 'node_modules', '.bin', 'tool'));
  const parent = path.join(root, 'renderers');
  await mkdir(parent, { mode: 0o700 });
  return { root, source, parent };
}

test('the fingerprint is a list or a file, plain relative paths, with build', async () => {
  expect(parseFingerprint('quartz.config.ts, build ,quartz/components/')).toEqual(['build', 'quartz.config.ts', 'quartz/components']);
  const { root } = await renderer();
  await writeFile(path.join(root, 'fp.txt'), '# identity\nbuild\nquartz.config.ts\n');
  expect(parseFingerprint(`@${path.join(root, 'fp.txt')}`)).toEqual(['build', 'quartz.config.ts']);
  expect(() => parseFingerprint('quartz.config.ts')).toThrow(/build/u);
  expect(() => parseFingerprint('build,../x')).toThrow();
  expect(() => parseFingerprint('build,/etc/passwd')).toThrow();
  expect(() => parseFingerprint('build,quartz,quartz/components')).toThrow(/contain/u);
});

test('the copy belongs to the node, has no group/other write, keeps inner links and skips the build cache', async () => {
  const { source, parent } = await renderer();
  const result = await installRenderer({ source, name: 'cyberchief', quartzCommit: '4923affa7722dfc751f1074348e6dad214fe0c08',
    fingerprint: ['build', 'quartz.config.ts', 'quartz/components'], parent, owner: process.getuid(), group: process.getgid() });
  expect(result.directory).toBe(path.join(parent, 'cyberchief'));
  const top = await lstat(result.directory);
  expect(top.isDirectory() && !top.isSymbolicLink()).toBe(true);
  expect(top.mode & 0o022).toBe(0);
  expect((await lstat(path.join(result.directory, 'quartz.config.ts'))).mode & 0o022).toBe(0);
  expect((await lstat(path.join(result.directory, 'build'))).mode & 0o100).toBe(0o100);
  expect(await readlink(path.join(result.directory, 'node_modules', '.bin', 'tool'))).toBe('../tool.js');
  expect(await lstat(path.join(result.directory, '.quartz-cache')).catch(() => null)).toBeNull();
  // Again: swapped in whole, nothing left behind.
  await installRenderer({ source, name: 'cyberchief', quartzCommit: 'x', fingerprint: ['build'], parent, owner: process.getuid(), group: process.getgid() });
  const { readdir } = await import('node:fs/promises');
  expect(await readdir(parent)).toEqual(['cyberchief']);
});

test('a renderer that is a link, lacks build, or links outside itself is refused', async () => {
  const { root, source, parent } = await renderer();
  await symlink(source, path.join(root, 'alias'));
  expect(() => inspectRendererSource(path.join(root, 'alias'), {})).toThrow(/link/u);
  await symlink('/etc/passwd', path.join(source, 'escape'));
  expect(() => inspectRendererSource(source, {})).toThrow(/leaves/u);
  await rm(path.join(source, 'escape'));
  expect(() => inspectRendererSource(source, { fingerprint: ['build', 'missing.ts'] })).toThrow(/missing/u);
  await chmod(path.join(source, 'build'), 0o600);
  expect(() => inspectRendererSource(source, {})).toThrow(/executable build/u);
  await expect(installRenderer({ source, name: 'quartz-cyberbase', quartzCommit: 'x', fingerprint: ['build'], parent, owner: 0, group: 0 }))
    .rejects.toThrow(/name/u);
});

test('the node may make only user and network namespaces (offline renderer builds); the publisher none', () => {
  expect(UNIT_TEXTS['cyberbaser-node.service']).toContain('RestrictNamespaces=user net');
  expect(UNIT_TEXTS['cyberbaser-publisher.service']).toContain('RestrictNamespaces=yes');
});

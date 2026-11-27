import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { link, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { copySiteOutput, readSiteFile } from '../src/site-files.js';

const roots = [];
afterEach(() => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'owner-site-files-'));
  roots.push(root);
  const staging = path.join(root, 'stage');
  const candidate = path.join(root, 'candidate');
  await mkdir(path.join(staging, 'assets'), { recursive: true });
  return { root, staging, candidate };
}

test('copies regular bytes to private, independent inodes', async () => {
  const { staging, candidate } = await fixture();
  const source = path.join(staging, 'assets', 'page.html');
  const output = path.join(candidate, 'assets', 'page.html');
  const pages = Buffer.alloc(300_000, 'a');
  await writeFile(source, pages, { mode: 0o777 });
  await copySiteOutput(staging, candidate);
  const original = await stat(source);
  const copy = await stat(output);
  expect(copy.ino).not.toBe(original.ino);
  expect(copy.nlink).toBe(1);
  expect(copy.mode & 0o777).toBe(0o600);
  expect((await stat(candidate)).mode & 0o777).toBe(0o700);
  await writeFile(source, 'different staging bytes');
  expect(await readFile(output)).toEqual(pages);
  expect(await readSiteFile(candidate, ['assets', 'page.html'])).toEqual(pages);
});

test.each(['symlink', 'directory symlink', 'fifo', 'hardlink'])('refuses a %s in staging', async (kind) => {
  const { root, staging, candidate } = await fixture();
  const file = path.join(root, 'ordinary');
  const target = path.join(staging, 'assets', 'entry');
  await writeFile(file, 'synthetic bytes');
  if (kind === 'symlink') await symlink(file, target);
  if (kind === 'directory symlink') await symlink(root, target);
  if (kind === 'fifo') expect(spawnSync('/usr/bin/mkfifo', [target]).status).toBe(0);
  if (kind === 'hardlink') await link(file, target);
  await expect(copySiteOutput(staging, candidate)).rejects.toHaveProperty('code', 'site-output-copy-failed');
  await expect(readSiteFile(staging, ['assets', 'entry'])).rejects.toHaveProperty('code', 'EINVAL');
});

test.each([
  ['per-file bytes', { fileBytes: 2 }],
  ['total bytes', { bytes: 5 }],
  ['entry count', { entries: 2 }],
  ['depth', { depth: 0 }],
])('bounds %s before promotion', async (_, threshold) => {
  const { staging, candidate } = await fixture();
  await writeFile(path.join(staging, 'assets', 'one'), 'abc');
  await writeFile(path.join(staging, 'assets', 'two'), 'xyz');
  await expect(copySiteOutput(staging, candidate, { fileBytes: 10, bytes: 10, entries: 10, depth: 10, ...threshold }))
    .rejects.toHaveProperty('code', 'site-output-limit');
});

test('reader never follows an ancestor swapped to a symlink during a read', async () => {
  const { root, staging } = await fixture();
  const assets = path.join(staging, 'assets');
  const parked = path.join(staging, 'parked');
  const outside = path.join(root, 'outside');
  await mkdir(outside);
  await writeFile(path.join(assets, 'page.html'), 'approved site bytes');
  await writeFile(path.join(outside, 'page.html'), 'unrelated synthetic bytes');
  async function swaps() {
    for (let i = 0; i < 45; ++i) {
      await rename(assets, parked);
      await symlink(outside, assets);
      await rm(assets);
      await rename(parked, assets);
    }
  }
  async function reads() {
    for (let i = 0; i < 45; ++i) {
      const bytes = await readSiteFile(staging, ['assets', 'page.html']).catch((error) => {
        expect(['ENOENT', 'ENOTDIR', 'ELOOP']).toContain(error.code);
        return null;
      });
      if (bytes !== null) expect(bytes.toString()).toBe('approved site bytes');
    }
  }
  await Promise.all([swaps(), reads(), reads()]);
  expect((await readSiteFile(staging, ['assets', 'page.html'])).toString()).toBe('approved site bytes');
});

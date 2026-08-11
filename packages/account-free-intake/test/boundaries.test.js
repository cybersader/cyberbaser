import { expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computePageId,
  prepareSourceBindingManifest,
} from '../src/index.js';
import { sha256Digest } from '../src/contract.js';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

async function filesBelow(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'bun.lock') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(path));
    else files.push(path);
  }
  return files;
}

test('source identity accepts opaque immutable revisions while page IDs bind exact values', () => {
  const source = {
    repository: 'https://forge.example/owner/wiki.git',
    revision: 'immutable:renderer-retained-snapshot:2026-08-10T12:34:56Z',
  };
  const bytes = Buffer.from('# Page\n');
  const manifest = prepareSourceBindingManifest({
    source,
    publication: {
      publishPolicyDigest: sha256Digest(Buffer.from('policy')),
      selectedTreeDigest: sha256Digest(Buffer.from('tree')),
    },
    renderer: { name: 'renderer', revision: 'renderer-release:v1' },
    trustPolicy: { status: 'missing', digest: null },
    pages: [{ path: 'Page.md', byteLength: bytes.length, digest: sha256Digest(bytes) }],
  });
  expect(manifest.source.revision).toBe(source.revision);
  expect(manifest.pages[0].pageId).toBe(computePageId({ ...source, path: 'Page.md' }));
});

test('package contains no stale pre-approval source-binding vocabulary', async () => {
  const forbidden = [
    `publication${'Id'}`,
    `cyberbaser-${'correction-intent'}`,
    `cyberbaser-publication-source-${'bindings'}`,
    `ACCOUNT_FREE_INTAKE_${'MAX'}`,
  ];
  const hits = [];
  for (const path of await filesBelow(PACKAGE_ROOT)) {
    const text = await readFile(path, 'utf8');
    for (const term of forbidden) {
      if (text.includes(term)) hits.push({ path, term });
    }
  }
  expect(hits).toEqual([]);
});

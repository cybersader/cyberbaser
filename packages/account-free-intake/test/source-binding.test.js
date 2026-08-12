import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AccountFreeIntakeError,
  computePageId,
  createRetainedSourceBindingResolver,
  parseSourceBindingManifest,
  prepareSourceBindingManifest,
  retainedManifestFilename,
  serializeSourceBindingManifest,
  sourceBindingDigest,
  validateSourceBindingManifest,
} from '../src/index.js';
import { sha256Digest } from '../src/contract.js';
import { REPOSITORY, RENDERER_REVISION } from './fixtures.js';

const REVISION = '1111111111111111111111111111111111111111';
const POLICY_DIGEST = sha256Digest(Buffer.from('publish policy'));
const TREE_DIGEST = sha256Digest(Buffer.from('selected tree'));
const TRUST_DIGEST = sha256Digest(Buffer.from('trusted: []\n'));

function manifest() {
  return prepareSourceBindingManifest({
    source: { repository: REPOSITORY, revision: REVISION },
    publication: {
      publishPolicyDigest: POLICY_DIGEST,
      selectedTreeDigest: TREE_DIGEST,
    },
    renderer: { name: 'quartz-cyberbase', revision: RENDERER_REVISION },
    trustPolicy: { status: 'valid', digest: TRUST_DIGEST },
    pages: [
      { path: 'z-last.md', byteLength: 7, digest: sha256Digest(Buffer.from('z page\n')) },
      { path: 'docs/first.md', byteLength: 6, digest: sha256Digest(Buffer.from('first\n')) },
    ],
  });
}

async function expectCode(callback, code) {
  try {
    await callback();
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(AccountFreeIntakeError);
    expect(error.code).toBe(code);
  }
}

test('page IDs are deterministic opaque source identities', () => {
  const pageId = computePageId({
    repository: REPOSITORY,
    revision: REVISION,
    path: 'docs/first.md',
  });
  expect(pageId).toBe('page-v1:G2diQT1Iqo71iP-aXy2oZu2xRMGkUMgIS_OJ_QVe9KY');
  expect(computePageId({ repository: REPOSITORY, revision: REVISION, path: 'docs/first.md' })).toBe(pageId);
  expect(computePageId({ repository: REPOSITORY, revision: REVISION, path: 'docs/other.md' })).not.toBe(pageId);
});

test('publication manifest has fixed order, sorted unique pages, one LF, and stable digest', () => {
  const value = manifest();
  expect(value.pages.map((page) => page.path)).toEqual(['docs/first.md', 'z-last.md']);
  expect(Object.isFrozen(value.pages[0])).toBe(true);
  const text = serializeSourceBindingManifest(value);
  expect(text.endsWith('\n')).toBe(true);
  expect(text.endsWith('\n\n')).toBe(false);
  expect(parseSourceBindingManifest(text)).toEqual(value);
  expect(sourceBindingDigest(value)).toBe('sha-256=:dnsUaEW9sPCjZ7UCItxthnrYHexoGDDHGauNk5ois8w=:');
  expect(() => parseSourceBindingManifest(JSON.stringify(value, null, 2))).toThrow(AccountFreeIntakeError);
});

test('manifest rejects contradictory page IDs, duplicate paths, and noncanonical order', () => {
  const value = structuredClone(manifest());
  value.pages[0].pageId = value.pages[1].pageId;
  expect(() => validateSourceBindingManifest(value)).toThrow(AccountFreeIntakeError);

  const duplicate = structuredClone(manifest());
  duplicate.pages[1] = { ...duplicate.pages[0] };
  expect(() => validateSourceBindingManifest(duplicate)).toThrow(AccountFreeIntakeError);

  const reversed = structuredClone(manifest());
  reversed.pages.reverse();
  expect(() => validateSourceBindingManifest(reversed)).toThrow(AccountFreeIntakeError);
});

test('retained resolver uses exact binding digest and page ID with no current fallback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cyberbaser-bindings-'));
  try {
    const value = manifest();
    const digest = sourceBindingDigest(value);
    await writeFile(join(root, retainedManifestFilename(digest)), serializeSourceBindingManifest(value), { mode: 0o600 });
    const resolver = createRetainedSourceBindingResolver({ manifestRoot: root });
    const resolved = await resolver.resolve(digest, value.pages[0].pageId);
    expect(resolved.bindingDigest).toBe(digest);
    expect(resolved.page.path).toBe('docs/first.md');
    expect(Object.isFrozen(resolved.manifest)).toBe(true);

    const absentDigest = sha256Digest(Buffer.from('newest manifest not retained'));
    await expectCode(() => resolver.resolve(absentDigest, value.pages[0].pageId), 'stale-publication');
    const absentPage = computePageId({ repository: REPOSITORY, revision: REVISION, path: 'docs/absent.md' });
    await expectCode(() => resolver.resolve(digest, absentPage), 'unresolvable-binding');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('retained resolver rejects digest contradiction', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cyberbaser-bindings-'));
  try {
    const manifests = join(root, 'manifests');
    await mkdir(manifests);
    const value = manifest();
    const digest = sourceBindingDigest(value);
    const tampered = structuredClone(value);
    tampered.renderer.name = 'other-renderer';
    await writeFile(join(manifests, retainedManifestFilename(digest)), serializeSourceBindingManifest(tampered));
    const resolver = createRetainedSourceBindingResolver({ manifestRoot: manifests });
    await expectCode(() => resolver.resolve(digest, value.pages[0].pageId), 'unresolvable-binding');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('retained resolver rejects a symlinked manifest root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cyberbaser-bindings-'));
  try {
    const manifests = join(root, 'manifests');
    const alias = join(root, 'alias');
    await mkdir(manifests);
    await symlink(manifests, alias);
    const value = manifest();
    const digest = sourceBindingDigest(value);
    const resolver = createRetainedSourceBindingResolver({ manifestRoot: alias });
    await expectCode(() => resolver.resolve(digest, value.pages[0].pageId), 'invalid-binding-root');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

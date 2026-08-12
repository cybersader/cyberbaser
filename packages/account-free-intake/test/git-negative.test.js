import { expect, test } from 'bun:test';
import {
  AccountFreeIntakeError,
  createBareGitObjectResolver,
  sourceBindingDigest,
  validateSourceBindingManifest,
} from '../src/index.js';
import { createBareFixture } from './fixtures.js';

function bindingFor(fixture) {
  return {
    bindingDigest: sourceBindingDigest(fixture.manifest),
    manifest: fixture.manifest,
    page: fixture.page,
  };
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

test('bare resolver binds its configured repository identity', async () => {
  const fixture = await createBareFixture();
  try {
    const resolver = createBareGitObjectResolver({
      gitDirectory: fixture.bare,
      repository: 'https://forge.example:8443/owner/other.git',
    });
    await expectCode(() => resolver.resolve(bindingFor(fixture)), 'repository-binding-mismatch');
  } finally {
    await fixture.cleanup();
  }
});

test('bare resolver refuses a worktree even when it contains the exact commit', async () => {
  const fixture = await createBareFixture();
  try {
    const resolver = createBareGitObjectResolver({
      gitDirectory: `${fixture.checkout}/.git`,
      repository: fixture.manifest.source.repository,
    });
    await expectCode(() => resolver.resolve(bindingFor(fixture)), 'git-repository-not-bare');
  } finally {
    await fixture.cleanup();
  }
});

test('bare resolver binds malformed policy status at the exact revision', async () => {
  const fixture = await createBareFixture({ policyText: 'trusted: [\n' });
  try {
    const manifest = validateSourceBindingManifest({
      ...fixture.manifest,
      trustPolicy: { status: 'malformed', digest: null },
    });
    const resolver = createBareGitObjectResolver({
      gitDirectory: fixture.bare,
      repository: fixture.manifest.source.repository,
    });
    const result = await resolver.resolve({
      bindingDigest: sourceBindingDigest(manifest),
      manifest,
      page: manifest.pages[0],
    });
    expect(result.policy).toEqual({ status: 'malformed', digest: null, config: null });
  } finally {
    await fixture.cleanup();
  }
});

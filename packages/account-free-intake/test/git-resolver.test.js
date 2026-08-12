import { expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  AccountFreeIntakeError,
  createBareGitObjectResolver,
  sourceBindingDigest,
  validateSourceBindingManifest,
} from '../src/index.js';
import { sha256Digest } from '../src/contract.js';
import { createBareFixture } from './fixtures.js';

const exec = promisify(execFile);

async function expectCode(callback, code) {
  try {
    await callback();
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(AccountFreeIntakeError);
    expect(error.code).toBe(code);
  }
}

function bindingFor(fixture, manifest = fixture.manifest) {
  return {
    bindingDigest: sourceBindingDigest(manifest),
    manifest,
    page: manifest.pages[0],
  };
}

test('bare resolver reads exact historical commit bytes and policy without Git mutation or network', async () => {
  const fixture = await createBareFixture();
  try {
    const calls = [];
    const resolver = createBareGitObjectResolver({
      gitDirectory: fixture.bare,
      repository: fixture.manifest.source.repository,
      execute: async ({ command, args, maxBytes, env }) => {
        calls.push({ args: [...args], env });
        try {
          const { stdout } = await exec(command, args, {
            encoding: 'buffer',
            env,
            maxBuffer: maxBytes,
          });
          return { stdout, exitCode: 0 };
        } catch (error) {
          return { stdout: error.stdout ?? Buffer.alloc(0), exitCode: Number(error.code) || 1 };
        }
      },
    });
    const refsBefore = await fixture.bareGit(['for-each-ref', '--format=%(refname):%(objectname)']);
    const result = await resolver.resolve(bindingFor(fixture));
    const refsAfter = await fixture.bareGit(['for-each-ref', '--format=%(refname):%(objectname)']);

    expect(result.baseBytes).toEqual(fixture.baseBytes);
    expect(result.baseBytes).not.toEqual(fixture.nextBytes);
    expect(result.policy.status).toBe('valid');
    expect(result.policy.digest).toBe(fixture.manifest.trustPolicy.digest);
    expect(refsAfter).toBe(refsBefore);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(({ env }) => env.GIT_OPTIONAL_LOCKS === '0')).toBe(true);
    expect(calls.every(({ env }) => env.GIT_TERMINAL_PROMPT === '0')).toBe(true);
    expect(calls.every(({ env }) => env.GIT_NO_LAZY_FETCH === '1')).toBe(true);
    const allArguments = calls.flatMap(({ args }) => args);
    expect(allArguments.some((argument) => argument === 'cat-file')).toBe(true);
    expect(allArguments.some((argument) => argument === 'ls-tree')).toBe(true);
    expect(allArguments.some((argument) => ['fetch', 'push', 'update-ref', 'checkout', 'worktree'].includes(argument))).toBe(false);
  } finally {
    await fixture.cleanup();
  }
});

test('bare resolver rejects a manifest for a different configured repository', async () => {
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

test('bare resolver rejects source length/digest contradictions', async () => {
  const fixture = await createBareFixture();
  try {
    const resolver = createBareGitObjectResolver({
      gitDirectory: fixture.bare,
      repository: fixture.manifest.source.repository,
    });
    const tampered = structuredClone(fixture.manifest);
    tampered.pages[0].digest = sha256Digest(Buffer.from('different bytes'));
    const manifest = validateSourceBindingManifest(tampered);
    await expectCode(() => resolver.resolve(bindingFor(fixture, manifest)), 'source-binding-mismatch');
  } finally {
    await fixture.cleanup();
  }
});

test('bare resolver binds trust policy status and digest to the same revision', async () => {
  const fixture = await createBareFixture();
  try {
    const resolver = createBareGitObjectResolver({
      gitDirectory: fixture.bare,
      repository: fixture.manifest.source.repository,
    });
    const tampered = structuredClone(fixture.manifest);
    tampered.trustPolicy.digest = sha256Digest(Buffer.from('different policy'));
    const manifest = validateSourceBindingManifest(tampered);
    await expectCode(() => resolver.resolve(bindingFor(fixture, manifest)), 'trust-policy-binding-mismatch');
  } finally {
    await fixture.cleanup();
  }
});

test('bare resolver reports a missing trust policy only when the bound revision is missing it', async () => {
  const fixture = await createBareFixture({ policyText: null });
  try {
    const resolver = createBareGitObjectResolver({
      gitDirectory: fixture.bare,
      repository: fixture.manifest.source.repository,
    });
    const result = await resolver.resolve(bindingFor(fixture));
    expect(result.policy).toEqual({ status: 'missing', digest: null, config: null });
  } finally {
    await fixture.cleanup();
  }
});

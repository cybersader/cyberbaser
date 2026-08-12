import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateConfig, validateRuntimePaths } from '../src/config.js';
import { configInput } from './helpers.js';

const ROOT = '/srv/cyberbaser/account-free';

describe('strict credential-free configuration', () => {
  test('normalizes only the exact locked schema', () => {
    const config = validateConfig(configInput(ROOT));
    expect(config.publicHost).toBe('intake.example');
    expect(config.repository).toBe('https://forge.example:8443/owner/wiki.git');
    expect(config.queue.pendingRetentionDays).toBe(30);
    expect(config.queue.expiredGraceDays).toBe(7);
    expect(Object.isFrozen(config)).toBeTrue();
  });

  test('requires explicit enablement and rejects unknown credential fields', () => {
    expect(() => validateConfig(configInput(ROOT, { enabled: false }))).toThrow(/literal true/);
    expect(() => validateConfig({ ...configInput(ROOT), token: 'secret' })).toThrow(/unknown field token/);
    expect(() => validateConfig({ ...configInput(ROOT), forwardedHeader: 'x-forwarded-host' })).toThrow(/unknown field forwardedHeader/);
  });

  test('rejects credentialed or non-HTTPS origins and repositories', () => {
    expect(() => validateConfig(configInput(ROOT, {
      publicOrigin: 'http://intake.example',
    }))).toThrow(/HTTPS origin/);
    expect(() => validateConfig(configInput(ROOT, {
      allowedFormOrigins: ['https://user:pass@wiki.example'],
    }))).toThrow(/credential-free HTTPS origin/);
    expect(() => validateConfig(configInput(ROOT, {
      repository: 'https://user:pass@forge.example/owner/wiki.git',
    }))).toThrow(/credential-free HTTPS repository/);
  });

  test('does not permit weakening the fixed public abuse bounds', () => {
    const input = configInput(ROOT);
    input.limits.maxBodyBytes += 1;
    expect(() => validateConfig(input)).toThrow(/must be 98304/);
  });

  test('requires normalized absolute in-container paths', () => {
    expect(() => validateConfig(configInput(ROOT, { bindingsRoot: '../bindings' }))).toThrow(/normalized absolute path/);
  });

  test('rejects symlinked runtime path components before opening the service', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'cyberbaser-intake-config-'));
    try {
      const realBindings = path.join(root, 'real-bindings');
      const gitDir = path.join(root, 'objects.git');
      await mkdir(realBindings);
      await mkdir(gitDir);
      await symlink(realBindings, path.join(root, 'bindings'));
      const config = validateConfig(configInput(root));
      await expect(validateRuntimePaths(config)).rejects.toThrow(/symlink components/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

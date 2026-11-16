import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isPrivateNetworkIpv4Host, validateConfig, validateRuntimePaths } from '../src/config.js';
import { configInput } from './helpers.js';

const ROOT = '/srv/cyberbaser/account-free';

describe('strict credential-free configuration', () => {
  test('normalizes only the exact locked schema', () => {
    const config = validateConfig(configInput(ROOT));
    expect(config.publicHost).toBe('intake.example');
    expect(config.repository).toBe('https://forge.example:8443/owner/wiki.git');
    expect(config.queue.pendingRetentionDays).toBe(30);
    expect(config.queue.expiredGraceDays).toBe(7);
    expect(config.reviewIpc).toEqual({
      enabled: false,
      socketPath: null,
      requestTimeoutMs: 5000,
      maxConcurrentRequests: 4,
      maxListEntries: 100,
    });
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
    }))).toThrow(/private numeric IPv4 address/);
    expect(() => validateConfig(configInput(ROOT, {
      allowedFormOrigins: ['https://user:pass@wiki.example'],
    }))).toThrow(/credential-free HTTPS origin/);
    expect(() => validateConfig(configInput(ROOT, {
      repository: 'https://user:pass@forge.example/owner/wiki.git',
    }))).toThrow(/credential-free HTTPS repository/);
    expect(() => validateConfig(configInput(ROOT, {
      listen: { host: '127.0.0.1', port: 8080 },
    }))).toThrow(/listen.host must be 0.0.0.0/);
  });

  test('serves the owner-local form on one exact private-network HTTP origin', () => {
    const config = validateConfig(configInput(ROOT, {
      publicOrigin: 'http://127.0.0.1:4319',
      listen: { host: '127.0.0.1', port: 4319 },
      allowedFormOrigins: ['http://127.0.0.1:4318'],
    }));
    expect(config.publicOrigin).toBe('http://127.0.0.1:4319');
    expect(config.publicHost).toBe('127.0.0.1:4319');
    expect(config.listen).toEqual({ host: '127.0.0.1', port: 4319 });
    expect(config.allowedFormOrigins).toEqual(['http://127.0.0.1:4318']);
    expect(isPrivateNetworkIpv4Host('100.100.100.100')).toBe(true);
    expect(isPrivateNetworkIpv4Host('127.0.0.0')).toBe(false);
    expect(isPrivateNetworkIpv4Host('8.8.8.8')).toBe(false);

    for (const [overrides, message] of [
      [{ publicOrigin: 'http://8.8.8.8:4319', listen: { host: '8.8.8.8', port: 4319 } }, /private numeric IPv4 address/],
      [{ publicOrigin: 'http://127.0.0.1', listen: { host: '127.0.0.1', port: 80 } }, /private numeric IPv4 address/],
      [{ publicOrigin: 'http://127.0.0.1:4319', listen: { host: '0.0.0.0', port: 4319 } }, /bind exactly/],
      [{ publicOrigin: 'http://127.0.0.1:4319', listen: { host: '127.0.0.1', port: 4320 } }, /bind exactly/],
      [{ publicOrigin: 'http://127.0.0.1:4319', listen: { host: '127.0.0.1', port: 4319 }, allowedFormOrigins: ['http://wiki.internal:4318'] }, /private numeric IPv4 address/],
    ]) {
      expect(() => validateConfig(configInput(ROOT, overrides))).toThrow(message);
    }
  });

  test('does not permit weakening the fixed public abuse bounds', () => {
    const input = configInput(ROOT);
    input.limits.maxBodyBytes += 1;
    expect(() => validateConfig(input)).toThrow(/must be 98304/);
  });

  test('requires normalized absolute in-container paths', () => {
    expect(() => validateConfig(configInput(ROOT, { bindingsRoot: '../bindings' }))).toThrow(/normalized absolute path/);
    expect(() => validateConfig(configInput(ROOT, {
      reviewIpc: {
        enabled: true,
        socketPath: '../review.sock',
        requestTimeoutMs: 5000,
        maxConcurrentRequests: 4,
        maxListEntries: 100,
      },
    }))).toThrow(/normalized absolute path/);
  });

  test('requires the exact bounded review IPC branch', () => {
    const enabled = validateConfig(configInput(ROOT, {
      reviewIpc: {
        enabled: true,
        socketPath: '/run/cyberbaser/review.sock',
        requestTimeoutMs: 5000,
        maxConcurrentRequests: 4,
        maxListEntries: 100,
      },
    }));
    expect(enabled.reviewIpc.socketPath).toBe('/run/cyberbaser/review.sock');
    expect(() => validateConfig(configInput(ROOT, {
      reviewIpc: {
        enabled: false,
        socketPath: '/run/cyberbaser/review.sock',
        requestTimeoutMs: 5000,
        maxConcurrentRequests: 4,
        maxListEntries: 100,
      },
    }))).toThrow(/must be null/);
    expect(() => validateConfig(configInput(ROOT, {
      reviewIpc: {
        enabled: true,
        socketPath: '/review.sock',
        requestTimeoutMs: 5000,
        maxConcurrentRequests: 4,
        maxListEntries: 100,
      },
    }))).toThrow(/parent must not be a filesystem root/);
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

describe('forge watcher configuration', () => {
  const forgejo = {
    enabled: true,
    apiBaseUrl: 'https://forge.home.arpa:8443/api/v1',
    repository: { url: 'https://forge.home.arpa:8443/owner/wiki.git', owner: 'owner', name: 'wiki', baseBranch: 'main' },
    cloneDir: '/srv/cyberbaser/forge-clone',
    pollIntervalMs: 60_000,
    tokenFile: null,
  };

  test('is optional, may be disabled with one key, and normalizes the enabled block', () => {
    expect(validateConfig(configInput(ROOT)).forgejo).toBeNull();
    expect(validateConfig(configInput(ROOT, { forgejo: null })).forgejo).toBeNull();
    expect(validateConfig(configInput(ROOT, { forgejo: { enabled: false } })).forgejo).toEqual({ enabled: false });
    const config = validateConfig(configInput(ROOT, { forgejo }));
    expect(config.forgejo).toEqual(forgejo);
    expect(config.listen).toEqual({ host: '0.0.0.0', port: 8080 });
  });

  test('lets the public form be off when the watcher is on, and refuses a service with no input at all', () => {
    const formOff = validateConfig(configInput(ROOT, { listen: null, publicOrigin: null, allowedFormOrigins: [], forgejo }));
    expect(formOff.listen).toBeNull();
    expect(formOff.publicOrigin).toBeNull();
    expect(formOff.publicHost).toBeNull();
    expect(formOff.allowedFormOrigins).toEqual([]);
    expect(() => validateConfig(configInput(ROOT, { listen: null, publicOrigin: null, allowedFormOrigins: [] }))).toThrow(/listen may be null only/);
    expect(() => validateConfig(configInput(ROOT, { listen: null, allowedFormOrigins: [], forgejo }))).toThrow(/publicOrigin must be null/);
    expect(() => validateConfig(configInput(ROOT, { listen: null, publicOrigin: null, forgejo }))).toThrow(/allowedFormOrigins must be empty/);
  });

  test('rejects an inconsistent or unsafe watcher block', () => {
    const cases = [
      [{ ...forgejo, apiBaseUrl: 'https://other.example/api/v1' }, /same-origin/],
      [{ ...forgejo, apiBaseUrl: 'https://forge.home.arpa:8443/api/v2' }, /same-origin/],
      [{ ...forgejo, repository: { ...forgejo.repository, name: 'other' } }, /match forgejo.repository.owner/],
      [{ ...forgejo, repository: { ...forgejo.repository, url: 'http://forge.home.arpa:8443/owner/wiki.git' } }, /HTTPS/],
      [{ ...forgejo, repository: { ...forgejo.repository, baseBranch: 'main..x' } }, /baseBranch/],
      [{ ...forgejo, pollIntervalMs: 1000 }, /pollIntervalMs/],
      [{ ...forgejo, cloneDir: 'relative/clone' }, /cloneDir/],
      [{ ...forgejo, tokenFile: 'token' }, /tokenFile/],
      [{ ...forgejo, extra: true }, /unknown field/],
      [{ enabled: 'yes' }, /forgejo/],
    ];
    for (const [block, pattern] of cases) {
      expect(() => validateConfig(configInput(ROOT, { forgejo: block }))).toThrow(pattern);
    }
  });
});

describe('optional public intake protections', () => {
  const botCheck = { provider: 'turnstile', secretFile: '/run/secrets/turnstile', expectedHostnames: ['wiki.example'], expectedAction: 'suggest-correction', timeoutMs: 3000 };
  const clientAddress = { source: 'header', header: 'cf-connecting-ip', trustedPeers: ['10.0.0.0/8', '2001:db8::/32'] };

  test('older exact configs load with bot check off, socket authority and default layered quotas', () => {
    const config = validateConfig(configInput(ROOT));
    expect(config.botCheck).toBeNull();
    expect(config.clientAddress).toEqual({ source: 'socket' });
    expect(config.limits).toMatchObject({ perSenderCapacity: 3, perSenderRefillPerHour: 3, perNetworkCapacity: 10, perNetworkRefillPerDay: 10, perPageCapacity: 2, perPageRefillPerDay: 2 });
    expect(validateConfig(configInput(ROOT, { botCheck: null })).botCheck).toBeNull();
  });

  test('enabled bot and trusted proxy settings are exact and deeply frozen without freezing input arrays', () => {
    const input = configInput(ROOT, { botCheck: structuredClone(botCheck), clientAddress: structuredClone(clientAddress) });
    const config = validateConfig(input);
    expect(config.botCheck).toEqual(botCheck);
    expect(config.clientAddress).toEqual(clientAddress);
    expect(Object.isFrozen(config.botCheck.expectedHostnames)).toBe(true);
    expect(Object.isFrozen(config.clientAddress.trustedPeers)).toBe(true);
    expect(Object.isFrozen(input.botCheck.expectedHostnames)).toBe(false);
  });

  test.each([
    { ...botCheck, provider: 'other' }, { ...botCheck, secretFile: 'relative' },
    { ...botCheck, expectedHostnames: [] }, { ...botCheck, expectedHostnames: ['https://wiki.example'] },
    { ...botCheck, expectedHostnames: ['Wiki.example'] }, { ...botCheck, expectedHostnames: ['wiki.example:443'] },
    { ...botCheck, expectedHostnames: ['wiki.example', 'wiki.example'] },
    { ...botCheck, expectedHostnames: ['bad..example'] }, { ...botCheck, expectedAction: 'login' },
    { ...botCheck, timeoutMs: 0 }, { ...botCheck, timeoutMs: 3001 }, { ...botCheck, secret: 'must-not-be-configured' },
    { provider: 'turnstile' }, false,
  ])('rejects incomplete or unsafe bot settings', (block) => {
    expect(() => validateConfig(configInput(ROOT, { botCheck: block }))).toThrow();
  });

  test.each([
    null, { source: 'other' }, { source: 'socket', header: 'cf-connecting-ip' },
    { ...clientAddress, header: 'x-real-ip,other' }, { ...clientAddress, trustedPeers: [] },
    { ...clientAddress, trustedPeers: ['not-a-cidr'] }, { ...clientAddress, trustedPeers: ['192.0.2.0/33'] },
    { ...clientAddress, trustedPeers: ['2001:db8::/129'] }, { ...clientAddress, trustedPeers: ['::ffff:10.0.0.0/129'] },
    { ...clientAddress, extra: true },
  ])('rejects ambiguous or unsafe client-address settings', (block) => {
    expect(() => validateConfig(configInput(ROOT, { clientAddress: block }))).toThrow();
  });

  test('layered limits accept bounded positive integers only and retain unknown-key rejection', () => {
    const keys = ['perSenderCapacity', 'perSenderRefillPerHour', 'perNetworkCapacity', 'perNetworkRefillPerDay', 'perPageCapacity', 'perPageRefillPerDay'];
    for (const key of keys) {
      for (const value of [0, -1, 1.5, '3', null, 1_000_001, Number.MAX_SAFE_INTEGER + 1]) {
        const input = configInput(ROOT);
        input.limits[key] = value;
        expect(() => validateConfig(input)).toThrow(/integer from 1 through 1000000/);
      }
      const input = configInput(ROOT);
      input.limits[key] = 7;
      expect(validateConfig(input).limits[key]).toBe(7);
    }
    const input = configInput(ROOT);
    input.limits.perUnknownCapacity = 5;
    expect(() => validateConfig(input)).toThrow(/unknown field/);
  });
});

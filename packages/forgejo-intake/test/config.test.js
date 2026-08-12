import { describe, expect, test } from 'bun:test';
import { validateForgejoIntakeConfig } from '../src/index.js';
import { CONFIG, expectCode } from './fixtures.js';

describe('validateForgejoIntakeConfig', () => {
  test('normalizes and deeply freezes one same-origin configuration', () => {
    const config = validateForgejoIntakeConfig(CONFIG);
    expect(config).toEqual({
      schemaVersion: 1,
      forgejo: {
        apiBaseUrl: 'https://forge.example:8443/api/v1',
        origin: 'https://forge.example:8443',
      },
      repository: {
        url: 'https://forge.example:8443/owner/wiki.git',
        owner: 'owner',
        name: 'wiki',
        fullName: 'owner/wiki',
        baseBranch: 'main',
      },
    });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.forgejo)).toBe(true);
    expect(Object.isFrozen(config.repository)).toBe(true);
  });

  test('rejects unknown and missing durable fields', () => {
    expectCode(() => validateForgejoIntakeConfig({ ...CONFIG, token: 'secret' }), 'unknown-field');
    expectCode(() => validateForgejoIntakeConfig({
      ...CONFIG,
      repository: { ...CONFIG.repository, checkout: '/tmp/wiki' },
    }), 'unknown-field');
    const { forgejo: _forgejo, ...missing } = CONFIG;
    expectCode(() => validateForgejoIntakeConfig(missing), 'missing-field');
  });

  test('rejects credentials, aliases, delimiters, and default-port spellings', () => {
    for (const apiBaseUrl of [
      'http://forge.example:8443/api/v1',
      'https://user:pass@forge.example:8443/api/v1',
      'https://forge.example.:8443/api/v1',
      'https://forge.example:443/api/v1',
      'https://forge.example:8443/api/v1?',
      'https://forge.example:8443/api/v1#',
      'https://forge.example:8443/api/%76%31',
      'https://forge.example:8443/sub/api/v1',
    ]) {
      expectCode(() => validateForgejoIntakeConfig({
        ...CONFIG,
        forgejo: { apiBaseUrl },
      }), apiBaseUrl.includes('/sub/') ? 'forgejo-origin-mismatch' : undefined);
    }
  });

  test('rejects cross-origin and repository identity contradictions', () => {
    expectCode(() => validateForgejoIntakeConfig({
      ...CONFIG,
      forgejo: { apiBaseUrl: 'https://other.example/api/v1' },
    }), 'forgejo-origin-mismatch');
    expectCode(() => validateForgejoIntakeConfig({
      ...CONFIG,
      repository: { ...CONFIG.repository, url: 'https://forge.example:8443/owner/other.git' },
    }), 'repository-url-mismatch');
    expectCode(() => validateForgejoIntakeConfig({
      ...CONFIG,
      repository: { ...CONFIG.repository, url: 'https://forge.example:8443/owner%2Fwiki.git' },
    }), 'noncanonical-url');
  });

  test('rejects unsafe identifiers and branch names', () => {
    for (const owner of ['', '.hidden', 'owner.', 'owner/name', 'a'.repeat(101)]) {
      expectCode(() => validateForgejoIntakeConfig({
        ...CONFIG,
        repository: { ...CONFIG.repository, owner },
      }), 'invalid-forgejo-identifier');
    }
    for (const baseBranch of [
      '-main', '/main', 'main/', 'main.', 'main..next', 'main@{1}',
      'main//next', 'main lock', 'topic/.lock', 'topic\\name',
    ]) {
      expectCode(() => validateForgejoIntakeConfig({
        ...CONFIG,
        repository: { ...CONFIG.repository, baseBranch },
      }), 'invalid-git-branch');
    }
  });
});

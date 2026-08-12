import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  OwnerAlphaError,
  computePolicyRevision,
  loadOwnerAlphaConfig,
  policyDocument,
  validateOwnerAlphaConfig,
} from '../src/index.js';

const APP_ROOT = path.resolve(import.meta.dir, '..');
const EXAMPLE = path.join(APP_ROOT, 'owner-alpha.example.json');
const FORGEJO_EXAMPLE = path.join(APP_ROOT, 'owner-alpha.forgejo.example.json');
const GITHUB_POLICY_REVISION = 'sha256:e740f0cf94abb24d230a56b7290a808ddad81d7836d8a5eefaa7aee3d83a2c22';
const cleanup = [];

async function exampleConfig() {
  return JSON.parse(await readFile(EXAMPLE, 'utf8'));
}

async function forgejoExampleConfig() {
  return JSON.parse(await readFile(FORGEJO_EXAMPLE, 'utf8'));
}

function expectCode(action, code) {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(OwnerAlphaError);
    expect(error.code).toBe(code);
    return error;
  }
  throw new Error(`expected OwnerAlphaError(${code})`);
}

async function expectCodeAsync(action, code) {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(OwnerAlphaError);
    expect(error.code).toBe(code);
    return error;
  }
  throw new Error(`expected OwnerAlphaError(${code})`);
}

function variant(raw, change) {
  const copy = structuredClone(raw);
  change(copy);
  return copy;
}

// The WP3 self-hosted fixture cannot bind privileged ports, so its Forgejo
// instance and published site both carry an explicit non-default port.
function portedFixture(copy) {
  copy.repository.remote.url = 'https://127.0.0.2:8443/wp3-owner/fixture.git';
  copy.owner.identity = 'wp3-owner';
  copy.workflow.apiBaseUrl = 'https://127.0.0.2:8443/api/v1';
  copy.workflow.repository = 'wp3-owner/fixture';
  copy.live.baseUrl = 'https://127.0.0.3:8443/';
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((target) => rm(target, { recursive: true, force: true })));
});

describe('strict one-Save private owner config', () => {
  test('loads, normalizes, and deeply freezes the tracked example without mutation', async () => {
    const raw = await exampleConfig();
    const before = structuredClone(raw);
    const config = validateOwnerAlphaConfig(raw);

    expect(raw).toEqual(before);
    expect(config.listen).toEqual({ host: '127.0.0.1', port: 4317, readerPort: 4318 });
    expect(config.repository.checkout).toBe('/absolute/path/to/cyberbase');
    expect(config.repository.remote.url).toBe('https://github.com/cybersader/cyberbase.git');
    expect(config.owner).toEqual({
      identity: 'cybersader',
      allowedTrustRoutes: ['auto-merge', 'quick-review'],
    });
    expect(config.live.baseUrl).toBe('https://cybersader.github.io/cyberbase/');
    expect(config.workflow).toEqual({
      provider: 'github-actions',
      repository: 'cybersader/cyberbase',
      name: 'Publish vault site',
      path: '.github/workflows/publish-site.yml',
      event: 'push',
      branch: 'main',
      jobs: ['build', 'deploy'],
      environment: 'github-pages',
    });
    expect(config.workspace).toEqual({
      root: '.workspace/owner-alpha',
      store: '.workspace/owner-alpha/store',
      site: '.workspace/owner-alpha/site',
      cache: '.workspace/owner-alpha/cache',
    });
    expect(config.limits.maxChangedBytes).toBe(65536);
    expect(config.limits.maxChangedLines).toBe(60);
    expect(config.checks.allowedOfmVerdicts).toEqual(['clean']);
    expect(config.git).toEqual({
      autoCommit: true,
      autoPush: true,
      useHooks: true,
      commitMessagePrefix: 'owner-alpha:',
    });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.workflow.jobs)).toBe(true);
    expect(Object.isFrozen(config.checks.allowedOfmVerdicts)).toBe(true);

    const root = await mkdtemp(path.join(os.tmpdir(), 'owner-alpha-private-config-'));
    cleanup.push(root);
    const privateConfig = path.join(root, 'owner-alpha.local.json');
    await writeFile(privateConfig, await readFile(EXAMPLE), { mode: 0o600 });
    expect(await loadOwnerAlphaConfig(privateConfig)).toEqual(config);
  });

  test('accepts one exact private numeric IPv4 host and a valid explicit port', async () => {
    const raw = await exampleConfig();
    for (const host of ['127.0.0.1', '10.20.30.40', '172.16.0.5', '192.168.1.50', '100.100.100.100']) {
      const config = validateOwnerAlphaConfig(variant(raw, (copy) => { copy.listen.host = host; }));
      expect(config.listen).toEqual({ host, port: 4317, readerPort: 4318 });
    }
    for (const host of ['localhost', '::1', '0.0.0.0', '::', 'LOCALHOST', '8.8.8.8', '169.254.1.1', '100.64.0.0', '2130706433', '127.1']) {
      expectCode(
        () => validateOwnerAlphaConfig(variant(raw, (copy) => { copy.listen.host = host; })),
        'private-network-host-required',
      );
    }
    for (const port of [0, -1, 65536, 4317.5, '4317']) {
      expectCode(
        () => validateOwnerAlphaConfig(variant(raw, (copy) => { copy.listen.port = port; })),
        'invalid-config',
      );
    }
    for (const port of [80, 79]) {
      expectCode(
        () => validateOwnerAlphaConfig(variant(raw, (copy) => {
          copy.listen.port = port;
          delete copy.listen.readerPort;
        })),
        'default-http-port-forbidden',
      );
    }
  });

  test('changing only the private listen host changes the durable policy revision', async () => {
    const raw = await exampleConfig();
    const loopback = computePolicyRevision(validateOwnerAlphaConfig(raw));
    const tailnet = computePolicyRevision(validateOwnerAlphaConfig(
      variant(raw, (copy) => { copy.listen.host = '100.100.100.100'; }),
    ));
    expect(loopback).not.toBe(tailnet);
  });

  test('rejects unknown and missing keys at every schema boundary', async () => {
    const raw = await exampleConfig();
    const unknownVariants = [
      variant(raw, (copy) => { copy.surprise = true; }),
      variant(raw, (copy) => { copy.repository.surprise = true; }),
      variant(raw, (copy) => { copy.repository.remote.surprise = true; }),
      variant(raw, (copy) => { copy.owner.surprise = true; }),
      variant(raw, (copy) => { copy.workflow.surprise = true; }),
      variant(raw, (copy) => { copy.workspace.surprise = true; }),
      variant(raw, (copy) => { copy.paths.surprise = true; }),
      variant(raw, (copy) => { copy.limits.surprise = true; }),
      variant(raw, (copy) => { copy.checks.surprise = true; }),
      variant(raw, (copy) => { copy.git.surprise = true; }),
    ];
    for (const candidate of unknownVariants) {
      expectCode(() => validateOwnerAlphaConfig(candidate), 'unknown-config-key');
    }

    for (const [section, key] of [
      [null, 'live'],
      ['repository', 'checkout'],
      ['owner', 'identity'],
      ['workflow', 'name'],
      ['workspace', 'cache'],
      ['paths', 'exclude'],
      ['limits', 'maxChangedLines'],
      ['checks', 'requireRenderedWitness'],
      ['git', 'autoPush'],
    ]) {
      const candidate = structuredClone(raw);
      delete (section ? candidate[section] : candidate)[key];
      expectCode(() => validateOwnerAlphaConfig(candidate), 'missing-config-key');
    }
  });

  test('binds a normalized absolute checkout and an exact credential-free GitHub remote', async () => {
    const raw = await exampleConfig();
    for (const checkout of ['relative/cyberbase', '/tmp/../cyberbase', '/tmp/cyberbase/', 'C:\\cyberbase']) {
      expectCode(
        () => validateOwnerAlphaConfig(variant(raw, (copy) => { copy.repository.checkout = checkout; })),
        'invalid-config-path',
      );
    }
    for (const url of [
      'http://github.com/cybersader/cyberbase.git',
      'https://gitlab.com/cybersader/cyberbase.git',
      'https://github.com/cybersader/cyberbase',
      'https://github.com/cybersader/cyberbase.git?ref=main',
      'https://github.com:443/cybersader/cyberbase.git',
    ]) {
      expectCode(
        () => validateOwnerAlphaConfig(variant(raw, (copy) => { copy.repository.remote.url = url; })),
        'invalid-config-url',
      );
    }
    for (const branch of ['main..backup', '.hidden', 'topic/.hidden', 'topic.lock', 'main~1', 'main:next']) {
      expectCode(
        () => validateOwnerAlphaConfig(variant(raw, (copy) => {
          copy.repository.branch = branch;
          copy.workflow.branch = branch;
        })),
        'invalid-config-ref',
      );
    }
  });

  test('binds owner identity and permits only auto-merge plus optional quick-review', async () => {
    const raw = await exampleConfig();
    expectCode(
      () => validateOwnerAlphaConfig(variant(raw, (copy) => { copy.owner.identity = 'another-owner'; })),
      'owner-identity-mismatch',
    );
    for (const route of ['full-review', 'reject', 'AUTO-MERGE']) {
      expectCode(
        () => validateOwnerAlphaConfig(variant(raw, (copy) => {
          copy.owner.allowedTrustRoutes = ['auto-merge', route];
        })),
        'unknown-trust-route',
      );
    }
    expectCode(
      () => validateOwnerAlphaConfig(variant(raw, (copy) => {
        copy.owner.allowedTrustRoutes = ['quick-review'];
      })),
      'invalid-trust-policy',
    );
    expectCode(
      () => validateOwnerAlphaConfig(variant(raw, (copy) => {
        copy.owner.allowedTrustRoutes = ['auto-merge', 'auto-merge'];
      })),
      'invalid-config',
    );
    expect(validateOwnerAlphaConfig(variant(raw, (copy) => {
      copy.owner.allowedTrustRoutes = ['auto-merge'];
    })).owner.allowedTrustRoutes).toEqual(['auto-merge']);
  });

  test('rejects mismatched live, repository, branch, and workflow publication identity', async () => {
    const raw = await exampleConfig();
    expectCode(
      () => validateOwnerAlphaConfig(variant(raw, (copy) => {
        copy.live.baseUrl = 'https://cybersader.github.io/other/';
      })),
      'live-origin-mismatch',
    );
    expectCode(
      () => validateOwnerAlphaConfig(variant(raw, (copy) => {
        copy.live.baseUrl = 'https://example.test/cyberbase/';
      })),
      'live-origin-mismatch',
    );
    expectCode(
      () => validateOwnerAlphaConfig(variant(raw, (copy) => {
        copy.workflow.repository = 'cybersader/other';
      })),
      'workflow-repository-mismatch',
    );
    expectCode(
      () => validateOwnerAlphaConfig(variant(raw, (copy) => { copy.workflow.branch = 'release'; })),
      'workflow-branch-mismatch',
    );
    for (const workflowPath of [
      'publish-site.yml',
      '.github/publish-site.yml',
      '.github/workflows/publish-site.yaml',
      '.github/workflows/../publish-site.yml',
      '/.github/workflows/publish-site.yml',
    ]) {
      expectCode(
        () => validateOwnerAlphaConfig(variant(raw, (copy) => { copy.workflow.path = workflowPath; })),
        'invalid-config-path',
      );
    }
    for (const [field, value] of [
      ['event', 'workflow_dispatch'],
      ['environment', 'production'],
    ]) {
      expectCode(
        () => validateOwnerAlphaConfig(variant(raw, (copy) => { copy.workflow[field] = value; })),
        'invalid-config',
      );
    }
    expectCode(
      () => validateOwnerAlphaConfig(variant(raw, (copy) => { copy.workflow.jobs = []; })),
      'invalid-config',
    );
    expectCode(
      () => validateOwnerAlphaConfig(variant(raw, (copy) => {
        copy.workflow.jobs = ['build', 'build'];
      })),
      'invalid-config',
    );
  });

  test('contains private workspace paths and protects Git and workspace metadata', async () => {
    const raw = await exampleConfig();
    expectCode(
      () => validateOwnerAlphaConfig(variant(raw, (copy) => {
        copy.workspace.root = '.workspace/private-owner';
      })),
      'invalid-workspace-root',
    );
    for (const [field, value] of [
      ['store', '.workspace/store'],
      ['site', '.workspace/owner-alpha'],
      ['cache', '../cache'],
    ]) {
      expectCode(
        () => validateOwnerAlphaConfig(variant(raw, (copy) => { copy.workspace[field] = value; })),
        field === 'cache' ? 'invalid-config-path' : 'workspace-path-outside-root',
      );
    }
    expectCode(
      () => validateOwnerAlphaConfig(variant(raw, (copy) => {
        copy.workspace.cache = copy.workspace.site;
      })),
      'invalid-config-path',
    );
    expectCode(
      () => validateOwnerAlphaConfig(variant(raw, (copy) => { copy.paths.include = ['../**/*.md']; })),
      'invalid-config-path',
    );
    expectCode(
      () => validateOwnerAlphaConfig(variant(raw, (copy) => { copy.paths.include = []; })),
      'invalid-config',
    );
    for (const required of ['.git/**', '.workspace/**']) {
      expectCode(
        () => validateOwnerAlphaConfig(variant(raw, (copy) => {
          copy.paths.exclude = copy.paths.exclude.filter((entry) => entry !== required);
        })),
        'missing-safety-exclude',
      );
    }
  });

  test('enforces complete and internally consistent byte, line, artifact, and timeout limits', async () => {
    const raw = await exampleConfig();
    const invalidChanges = [
      (copy) => { copy.limits.maxReplacementBytes = copy.limits.maxChangedBytes + 1; },
      (copy) => { copy.limits.maxChangedBytes = copy.limits.maxSourceBytes + 1; },
      (copy) => { copy.limits.maxSourceBytes = copy.limits.maxArtifactBytes + 1; },
      (copy) => { copy.limits.requestTimeoutMs = copy.limits.networkTimeoutMs + 1; },
    ];
    for (const change of invalidChanges) {
      expectCode(() => validateOwnerAlphaConfig(variant(raw, change)), 'invalid-limit-policy');
    }
    for (const [field, value] of [
      ['maxSourceBytes', 0],
      ['maxReplacementBytes', -1],
      ['maxChangedBytes', 1.5],
      ['maxChangedLines', '500'],
      ['maxArtifactBytes', Number.MAX_SAFE_INTEGER + 1],
      ['requestTimeoutMs', 0],
      ['networkTimeoutMs', null],
    ]) {
      expectCode(
        () => validateOwnerAlphaConfig(variant(raw, (copy) => { copy.limits[field] = value; })),
        'invalid-config',
      );
    }
  });

  test('allows only clean or suspect OFM and requires every fail-closed witness', async () => {
    const raw = await exampleConfig();
    for (const verdict of ['damage', 'unknown', 'CLEAN']) {
      expectCode(
        () => validateOwnerAlphaConfig(variant(raw, (copy) => {
          copy.checks.allowedOfmVerdicts = ['clean', verdict];
        })),
        'unknown-ofm-verdict',
      );
    }
    expectCode(
      () => validateOwnerAlphaConfig(variant(raw, (copy) => {
        copy.checks.allowedOfmVerdicts = ['suspect'];
      })),
      'invalid-check-policy',
    );
    for (const key of [
      'requirePublishedSource',
      'requireProjectionVerification',
      'requireNoNewBrokenLinks',
      'requireRenderedWitness',
    ]) {
      expectCode(
        () => validateOwnerAlphaConfig(variant(raw, (copy) => { copy.checks[key] = false; })),
        'missing-safety-check',
      );
      expectCode(
        () => validateOwnerAlphaConfig(variant(raw, (copy) => { copy.checks[key] = 1; })),
        'invalid-config',
      );
    }
  });

  test('binds explicit Git automation and rejects unsafe or inconsistent values', async () => {
    const raw = await exampleConfig();
    for (const field of ['autoCommit', 'autoPush', 'useHooks']) {
      expectCode(
        () => validateOwnerAlphaConfig(variant(raw, (copy) => { copy.git[field] = 'true'; })),
        'invalid-config',
      );
    }
    expectCode(
      () => validateOwnerAlphaConfig(variant(raw, (copy) => {
        copy.git.autoCommit = false;
        copy.git.autoPush = true;
      })),
      'invalid-git-policy',
    );
    for (const prefix of ['', ' owner-alpha:', 'owner-alpha: ', 'owner-alpha:\n']) {
      expectCode(
        () => validateOwnerAlphaConfig(variant(raw, (copy) => {
          copy.git.commitMessagePrefix = prefix;
        })),
        'invalid-config',
      );
    }
    expect(validateOwnerAlphaConfig(variant(raw, (copy) => {
      copy.git.autoCommit = false;
      copy.git.autoPush = false;
      copy.git.useHooks = false;
    })).git).toEqual({
      autoCommit: false,
      autoPush: false,
      useHooks: false,
      commitMessagePrefix: 'owner-alpha:',
    });
  });

  test('rejects credential fields and credential-bearing values before persistence', async () => {
    const raw = await exampleConfig();
    expectCode(() => validateOwnerAlphaConfig({ ...raw, accessToken: 'not-even-used' }), 'credentials-forbidden');
    expectCode(
      () => validateOwnerAlphaConfig(variant(raw, (copy) => {
        copy.repository.remote.url = 'https://owner:password@github.com/a/b.git';
      })),
      'credentials-forbidden',
    );
    expectCode(
      () => validateOwnerAlphaConfig(variant(raw, (copy) => {
        copy.live.baseUrl = 'https://cybersader.github.io/cyberbase/?token=abc';
      })),
      'invalid-config-url',
    );
  });
});

describe('strict Forgejo Actions provider config', () => {
  test('loads and normalizes the tracked Forgejo example as a separate provider branch', async () => {
    const raw = await forgejoExampleConfig();
    const config = validateOwnerAlphaConfig(raw);
    expect(config.repository.remote.url).toBe('https://forgejo.example/owner/repository.git');
    expect(config.owner.identity).toBe('owner');
    expect(config.live.baseUrl).toBe('https://published.example/site/');
    expect(config.workflow).toEqual({
      provider: 'forgejo-actions',
      apiBaseUrl: 'https://forgejo.example/api/v1',
      repository: 'owner/repository',
      path: '.forgejo/workflows/publish-site.yml',
      event: 'push',
      branch: 'main',
      jobs: ['build', 'deploy'],
      deploymentJob: 'deploy',
    });
    expect(config.workflow).not.toHaveProperty('name');
    expect(config.workflow).not.toHaveProperty('environment');
  });

  test('rejects provider-specific unknown keys and unsupported providers', async () => {
    const raw = await forgejoExampleConfig();
    for (const key of ['name', 'environment']) {
      expectCode(() => validateOwnerAlphaConfig(variant(raw, (copy) => {
        copy.workflow[key] = 'github-only';
      })), 'unknown-config-key');
    }
    expectCode(() => validateOwnerAlphaConfig(variant(raw, (copy) => {
      copy.workflow.provider = 'gitea-actions';
    })), 'unsupported-deployment-provider');
  });

  test('binds the remote, API origin, repository slug, owner, branch, and workflow directory', async () => {
    const raw = await forgejoExampleConfig();
    const cases = [
      ['forgejo-api-mismatch', (copy) => { copy.workflow.apiBaseUrl = 'https://other.example/api/v1'; }],
      ['forgejo-api-mismatch', (copy) => { copy.workflow.apiBaseUrl = 'https://forgejo.example/api/v2'; }],
      ['workflow-repository-mismatch', (copy) => { copy.workflow.repository = 'owner/other'; }],
      ['owner-identity-mismatch', (copy) => { copy.owner.identity = 'other'; }],
      ['workflow-branch-mismatch', (copy) => { copy.workflow.branch = 'release'; }],
      ['invalid-config-path', (copy) => { copy.workflow.path = '.github/workflows/publish-site.yml'; }],
      ['invalid-config-path', (copy) => { copy.workflow.path = '.forgejo/workflows/publish-site.yaml'; }],
      ['invalid-config-path', (copy) => { copy.workflow.path = '.forgejo/workflows/publish-site..yml'; }],
    ];
    for (const [code, change] of cases) {
      expectCode(() => validateOwnerAlphaConfig(variant(raw, change)), code);
    }
  });

  test('rejects ports, subpaths, credentials, encoded or nested repository paths, and trailing dots', async () => {
    const raw = await forgejoExampleConfig();
    for (const url of [
      'https://forgejo.example:443/owner/repository.git',
      'https://forgejo.example/git/owner/repository.git',
      'https://forgejo.example/owner%2Frepository.git',
      'https://forgejo.example/owner/repository.git?x=1',
      'https://forgejo.example/owner/repository.git#x',
      'https://user:pass@forgejo.example/owner/repository.git',
      'https://forgejo.example/owner./repository.git',
      'https://forgejo.example/owner/repository..git',
    ]) {
      const expected = url.includes('user:pass') ? 'credentials-forbidden' : 'invalid-config-url';
      expectCode(() => validateOwnerAlphaConfig(variant(raw, (copy) => {
        copy.repository.remote.url = url;
      })), expected);
    }
    for (const url of [
      'https://forgejo.example:443/api/v1',
      'https://forgejo.example/install/api/v1',
      'https://forgejo.example/api/v1/',
    ]) {
      expectCode(() => validateOwnerAlphaConfig(variant(raw, (copy) => {
        copy.workflow.apiBaseUrl = url;
      })), url.includes(':443') ? 'invalid-config-url' : 'forgejo-api-mismatch');
    }
  });

  test('accepts an independent canonical HTTPS live URL ending in slash and exact deployment job membership', async () => {
    const raw = await forgejoExampleConfig();
    expect(validateOwnerAlphaConfig(variant(raw, (copy) => {
      copy.live.baseUrl = 'https://elsewhere.example/';
    })).live.baseUrl).toBe('https://elsewhere.example/');
    for (const url of [
      'https://published.example/site',
      'https://published.example:443/site/',
      'http://published.example/site/',
      'https://user@published.example/site/',
    ]) {
      const expected = 'invalid-config-url';
      expectCode(() => validateOwnerAlphaConfig(variant(raw, (copy) => {
        copy.live.baseUrl = url;
      })), expected);
    }
    for (const change of [
      (copy) => { copy.workflow.jobs = []; },
      (copy) => { copy.workflow.jobs = ['build', 'build']; },
      (copy) => { copy.workflow.deploymentJob = 'release'; },
    ]) {
      expectCode(() => validateOwnerAlphaConfig(variant(raw, change)), 'invalid-config');
    }
  });

  test('accepts a self-hosted instance on an explicit non-default port across remote, API, and live URLs', async () => {
    const raw = await forgejoExampleConfig();
    const config = validateOwnerAlphaConfig(variant(raw, portedFixture));
    expect(config.repository.remote.url).toBe('https://127.0.0.2:8443/wp3-owner/fixture.git');
    expect(config.workflow.apiBaseUrl).toBe('https://127.0.0.2:8443/api/v1');
    expect(config.workflow.repository).toBe('wp3-owner/fixture');
    expect(config.owner.identity).toBe('wp3-owner');
    expect(config.live.baseUrl).toBe('https://127.0.0.3:8443/');
    expect(new URL(config.workflow.apiBaseUrl).origin)
      .toBe(new URL(config.repository.remote.url).origin);
  });

  test('binds the explicit port itself, so a port-only origin difference fails closed', async () => {
    const raw = await forgejoExampleConfig();
    for (const apiBaseUrl of [
      'https://127.0.0.2:9443/api/v1',
      'https://127.0.0.2/api/v1',
    ]) {
      expectCode(() => validateOwnerAlphaConfig(variant(raw, (copy) => {
        portedFixture(copy);
        copy.workflow.apiBaseUrl = apiBaseUrl;
      })), 'forgejo-api-mismatch');
    }
    expectCode(() => validateOwnerAlphaConfig(variant(raw, (copy) => {
      portedFixture(copy);
      copy.repository.remote.url = 'https://127.0.0.2:9443/wp3-owner/fixture.git';
    })), 'forgejo-api-mismatch');
  });

  test('still rejects an explicit :443 because it is not the canonical serialization', async () => {
    const raw = await forgejoExampleConfig();
    const cases = [
      (copy) => { copy.repository.remote.url = 'https://127.0.0.2:443/wp3-owner/fixture.git'; },
      (copy) => { copy.workflow.apiBaseUrl = 'https://127.0.0.2:443/api/v1'; },
      (copy) => { copy.live.baseUrl = 'https://127.0.0.3:443/'; },
    ];
    for (const change of cases) {
      expectCode(() => validateOwnerAlphaConfig(variant(raw, (copy) => {
        portedFixture(copy);
        change(copy);
      })), 'invalid-config-url');
    }
  });

  test('keeps the GitHub Actions provider portless in every URL position', async () => {
    const raw = await exampleConfig();
    for (const change of [
      (copy) => { copy.repository.remote.url = 'https://github.com:8443/cybersader/cyberbase.git'; },
      (copy) => { copy.repository.remote.url = 'https://github.com:443/cybersader/cyberbase.git'; },
      (copy) => { copy.live.baseUrl = 'https://cybersader.github.io:8443/cyberbase/'; },
      (copy) => { copy.live.baseUrl = 'https://cybersader.github.io:443/cyberbase/'; },
    ]) {
      expectCode(() => validateOwnerAlphaConfig(variant(raw, change)), 'invalid-config-url');
    }
  });
});

describe('policy revision', () => {
  test('is canonical SHA-256, binds both loopback origins, and excludes the local checkout', async () => {
    const raw = await exampleConfig();
    const original = computePolicyRevision(raw);
    expect(original).toBe(GITHUB_POLICY_REVISION);
    expect(policyDocument(raw)).toEqual(JSON.parse('{"schemaVersion":1,"listen":{"host":"127.0.0.1","port":4317,"readerPort":4318},"repository":{"remote":{"name":"origin","url":"https://github.com/cybersader/cyberbase.git"},"branch":"main"},"owner":{"identity":"cybersader","allowedTrustRoutes":["auto-merge","quick-review"]},"live":{"baseUrl":"https://cybersader.github.io/cyberbase/"},"workflow":{"provider":"github-actions","repository":"cybersader/cyberbase","name":"Publish vault site","path":".github/workflows/publish-site.yml","event":"push","branch":"main","jobs":["build","deploy"],"environment":"github-pages"},"workspace":{"root":".workspace/owner-alpha","store":".workspace/owner-alpha/store","site":".workspace/owner-alpha/site","cache":".workspace/owner-alpha/cache"},"paths":{"include":["**/*.md"],"exclude":[".git/**",".workspace/**"]},"limits":{"maxSourceBytes":2097152,"maxReplacementBytes":65536,"maxChangedBytes":65536,"maxChangedLines":60,"maxArtifactBytes":8388608,"requestTimeoutMs":30000,"networkTimeoutMs":900000},"checks":{"allowedOfmVerdicts":["clean"],"requirePublishedSource":true,"requireProjectionVerification":true,"requireNoNewBrokenLinks":true,"requireRenderedWitness":true},"git":{"autoCommit":true,"autoPush":true,"useHooks":true,"commitMessagePrefix":"owner-alpha:"}}'));

    const moved = variant(raw, (copy) => {
      copy.repository.checkout = '/different/owner/machine/cyberbase';
    });
    expect(computePolicyRevision(moved)).toBe(original);
    expect(computePolicyRevision(variant(raw, (copy) => { copy.listen.port = 5555; })))
      .not.toBe(original);

    const document = policyDocument(raw);
    expect(document.listen).toEqual({ host: '127.0.0.1', port: 4317, readerPort: 4318 });
    expect(document.repository.checkout).toBeUndefined();
    expect(Object.keys(document)).toEqual([
      'schemaVersion',
      'listen',
      'repository',
      'owner',
      'live',
      'workflow',
      'workspace',
      'paths',
      'limits',
      'checks',
      'git',
    ]);
  });

  test('canonicalizes policy sets but preserves exact ordered workflow jobs', async () => {
    const raw = await exampleConfig();
    const original = computePolicyRevision(raw);
    const reorderedSets = variant(raw, (copy) => {
      copy.owner.allowedTrustRoutes.reverse();
      copy.paths.exclude.reverse();
      copy.checks.allowedOfmVerdicts.reverse();
    });
    expect(computePolicyRevision(reorderedSets)).toBe(original);

    const reorderedJobs = variant(raw, (copy) => { copy.workflow.jobs.reverse(); });
    expect(validateOwnerAlphaConfig(reorderedJobs).workflow.jobs).toEqual(['deploy', 'build']);
    expect(computePolicyRevision(reorderedJobs)).not.toBe(original);
  });

  test('changes for every independently configurable authority-relevant field group', async () => {
    const raw = await exampleConfig();
    const original = computePolicyRevision(raw);
    const changes = [
      (copy) => { copy.repository.remote.name = 'upstream'; },
      (copy) => {
        copy.repository.branch = 'release';
        copy.workflow.branch = 'release';
      },
      (copy) => { copy.owner.allowedTrustRoutes = ['auto-merge']; },
      (copy) => { copy.workflow.name = 'Publish owner site'; },
      (copy) => { copy.workflow.path = '.github/workflows/publish-owner.yml'; },
      (copy) => { copy.workflow.jobs = ['build', 'verify', 'deploy']; },
      (copy) => { copy.workspace.site = '.workspace/owner-alpha/rendered-site'; },
      (copy) => { copy.paths.include = ['docs/**/*.md']; },
      (copy) => { copy.limits.maxSourceBytes += 1; },
      (copy) => { copy.limits.maxReplacementBytes -= 1; },
      (copy) => { copy.limits.maxChangedBytes += 1; },
      (copy) => { copy.limits.maxChangedLines += 1; },
      (copy) => { copy.limits.maxArtifactBytes += 1; },
      (copy) => { copy.limits.requestTimeoutMs += 1; },
      (copy) => { copy.limits.networkTimeoutMs += 1; },
      (copy) => { copy.checks.allowedOfmVerdicts = ['clean', 'suspect']; },
      (copy) => { copy.git.autoPush = false; },
      (copy) => { copy.git.useHooks = false; },
      (copy) => { copy.git.commitMessagePrefix = 'owner-save:'; },
      (copy) => {
        copy.repository.remote.url = 'https://github.com/cybersader/cyberbase-preview.git';
        copy.workflow.repository = 'cybersader/cyberbase-preview';
        copy.live.baseUrl = 'https://cybersader.github.io/cyberbase-preview/';
      },
    ];

    for (const change of changes) {
      expect(computePolicyRevision(variant(raw, change))).not.toBe(original);
    }
  });
});

describe('config file safety', () => {
  test('rejects symlinked, oversized, and malformed local config files', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'owner-alpha-config-'));
    cleanup.push(root);
    const target = path.join(root, 'target.json');
    const linked = path.join(root, 'owner-alpha.local.json');
    await writeFile(target, await readFile(EXAMPLE));
    await symlink(target, linked);
    await expectCodeAsync(() => loadOwnerAlphaConfig(linked), 'config-symlink-rejected');

    const malformed = path.join(root, 'malformed.json');
    await writeFile(malformed, '{ nope', { encoding: 'utf8', mode: 0o600 });
    await expectCodeAsync(() => loadOwnerAlphaConfig(malformed), 'invalid-config-json');

    const oversized = path.join(root, 'oversized.json');
    await writeFile(oversized, ' '.repeat(256 * 1024 + 1), { encoding: 'utf8', mode: 0o600 });
    await expectCodeAsync(() => loadOwnerAlphaConfig(oversized), 'config-too-large');

    const permissive = path.join(root, 'permissive.json');
    await writeFile(permissive, await readFile(EXAMPLE), { mode: 0o600 });
    await chmod(permissive, 0o644);
    await expectCodeAsync(
      () => loadOwnerAlphaConfig(permissive),
      'config-permissions-too-open',
    );
  });
});

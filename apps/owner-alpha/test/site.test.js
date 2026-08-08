import { afterEach, describe, expect, test } from 'bun:test';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { project } from '@cyberbaser/projection';
import { OwnerAlphaError } from '../src/errors.js';
import {
  PINNED_QUARTZ_COMMIT,
  PINNED_QUARTZ_REF,
  PINNED_QUARTZ_REPOSITORY,
} from '../src/quartz-renderer.js';
import {
  OWNER_SITE_MANIFEST_FILENAME,
  ensureOwnerSite,
  rebuildOwnerSite,
} from '../src/site.js';

const cleanup = [];
const HEAD = 'a'.repeat(40);
const RESOURCE_ROOTS = [
  'apps/owner-alpha/src',
  'apps/owner-alpha/public',
  'renderers/quartz-cyberbase',
  'packages/correction/src',
  'packages/linkcheck/src',
  'packages/ofm/src',
  'packages/projection/src',
  'packages/publish/src',
  'packages/trust/src',
];

async function temporary(name) {
  const root = await mkdtemp(path.join(os.tmpdir(), `owner-alpha-site-${name}-`));
  cleanup.push(root);
  return root;
}

async function write(root, relativePath, contents) {
  const file = path.join(root, ...relativePath.split('/'));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents);
  return file;
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((target) => rm(target, { recursive: true, force: true })));
});

async function expectCode(action, code) {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(OwnerAlphaError);
    expect(error.code).toBe(code);
    return error;
  }
  throw new Error(`expected OwnerAlphaError(${code})`);
}

function config(checkout) {
  return {
    schemaVersion: 1,
    listen: { host: '127.0.0.1', port: 4317 },
    repository: {
      checkout,
      remote: {
        name: 'origin',
        url: 'https://github.com/cybersader/cyberbase.git',
      },
      branch: 'main',
    },
    owner: {
      identity: 'cybersader',
      allowedTrustRoutes: ['auto-merge', 'quick-review'],
    },
    live: { baseUrl: 'https://cybersader.github.io/cyberbase/' },
    workflow: {
      provider: 'github-actions',
      repository: 'cybersader/cyberbase',
      name: 'Publish vault site',
      path: '.github/workflows/publish-site.yml',
      event: 'push',
      branch: 'main',
      jobs: ['build', 'deploy'],
      environment: 'github-pages',
    },
    workspace: {
      root: '.workspace/owner-alpha',
      store: '.workspace/owner-alpha/store',
      site: '.workspace/owner-alpha/site',
      cache: '.workspace/owner-alpha/cache',
    },
    paths: {
      include: ['**/*.md'],
      exclude: ['.git/**', '.workspace/**'],
    },
    limits: {
      maxSourceBytes: 2_097_152,
      maxReplacementBytes: 65_536,
      maxChangedBytes: 65_536,
      maxChangedLines: 60,
      maxArtifactBytes: 8_388_608,
      requestTimeoutMs: 30_000,
      networkTimeoutMs: 900_000,
    },
    checks: {
      allowedOfmVerdicts: ['clean'],
      requirePublishedSource: true,
      requireProjectionVerification: true,
      requireNoNewBrokenLinks: true,
      requireRenderedWitness: true,
    },
    git: {
      autoCommit: true,
      autoPush: true,
      useHooks: true,
      commitMessagePrefix: 'owner-alpha:',
    },
  };
}

async function fixture(name) {
  const root = await temporary(name);
  const projectRoot = path.join(root, 'cyberbaser');
  const checkout = path.join(root, 'cyberbase');
  await mkdir(projectRoot, { recursive: true });
  for (const relativeRoot of RESOURCE_ROOTS) {
    await write(projectRoot, `${relativeRoot}/resource.txt`, `${relativeRoot}\n`);
  }
  await mkdir(checkout, { recursive: true });
  await write(checkout, 'publish.yml', 'allow:\n  - "pub/**"\n');
  await write(checkout, 'pub/Page.md', '# Public page\n\nCanonical owner bytes.\n');
  await write(checkout, 'private/Secret.md', '# Private page\n\nMust not publish.\n');
  return { root, projectRoot, checkout, config: config(checkout) };
}

function ready(checkout, head = HEAD) {
  return {
    root: checkout,
    head,
    branch: 'main',
    origin: 'https://github.com/cybersader/cyberbase.git',
  };
}

function fixtureRenderer(observe = () => {}) {
  return async ({ contentDir, outputDir, workspaceDir, editLinkMode, ownerOrigin }) => {
    observe({ contentDir, outputDir, workspaceDir, editLinkMode, ownerOrigin });
    const markdown = await readFile(path.join(contentDir, 'pub', 'Page.md'), 'utf8');
    await mkdir(path.join(outputDir, 'pub'), { recursive: true });
    await writeFile(
      path.join(outputDir, 'index.html'),
      '<!doctype html><html><body><a href="/cyberbase/pub/Page">Page</a></body></html>',
    );
    await writeFile(
      path.join(outputDir, 'pub', 'Page.html'),
      `<!doctype html><html><body><main>${markdown}</main><a href="./missing">inherited debt</a></body></html>`,
    );
    return {
      renderer: 'quartz-cyberbase',
      revision: PINNED_QUARTZ_COMMIT,
      tag: PINNED_QUARTZ_REF,
      outputDir,
    };
  };
}

describe('local owner site rebuild', () => {
  test('projects exact public bytes, reuses the configured Quartz cache, records a HEAD-bound manifest, and replaces only after validation', async () => {
    const setup = await fixture('success');
    const canonicalBefore = await readFile(path.join(setup.checkout, 'pub', 'Page.md'));
    const siteRoot = path.join(setup.projectRoot, '.workspace', 'owner-alpha', 'site');
    await write(siteRoot, 'old.txt', 'previous complete site');
    const renderCalls = [];
    let readinessChecks = 0;

    const result = await rebuildOwnerSite({
      config: setup.config,
      projectRoot: setup.projectRoot,
      renderer: fixtureRenderer((call) => renderCalls.push(call)),
    }, {
      assertCheckoutReady: async () => {
        readinessChecks += 1;
        return ready(setup.checkout);
      },
      createBuildId: () => 'build-success',
      now: () => new Date('2026-07-31T12:00:00.000Z'),
    });

    expect(result.ok).toBe(true);
    expect(result.publication.replacedExisting).toBe(true);
    expect(readinessChecks).toBe(2);
    expect(renderCalls).toHaveLength(1);
    expect(renderCalls[0].workspaceDir).toBe(
      path.join(setup.projectRoot, '.workspace', 'owner-alpha', 'cache', 'quartz-owner'),
    );
    expect(renderCalls[0].editLinkMode).toBe('owner');
    expect(renderCalls[0].ownerOrigin).toBe('http://127.0.0.1:4317');
    expect(await exists(path.join(renderCalls[0].contentDir, 'private', 'Secret.md'))).toBe(false);
    expect(await exists(path.join(siteRoot, 'old.txt'))).toBe(false);
    expect(await exists(path.join(siteRoot, 'index.html'))).toBe(true);
    expect((await readFile(path.join(setup.checkout, 'pub', 'Page.md'))).equals(canonicalBefore)).toBe(true);

    const manifest = JSON.parse(await readFile(path.join(siteRoot, OWNER_SITE_MANIFEST_FILENAME), 'utf8'));
    expect(manifest).toEqual(result.manifest);
    expect(manifest.generatedAt).toBe('2026-07-31T12:00:00.000Z');
    expect(manifest.source.head).toBe(HEAD);
    expect(manifest.policyRevision).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(manifest.publication).toMatchObject({
      audience: 'public',
      selectedFiles: 1,
      selectedPages: 1,
      selectedAssets: 0,
    });
    expect(manifest.projection.bytePreserving).toMatchObject({
      ok: true,
      files: 1,
      bytes: canonicalBefore.length,
    });
    expect(manifest.projection.bytePreserving.sourceDigest)
      .toBe(manifest.projection.bytePreserving.projectedDigest);
    expect(manifest.renderer).toMatchObject({
      name: 'quartz-cyberbase',
      revision: PINNED_QUARTZ_COMMIT,
      tag: PINNED_QUARTZ_REF,
      repository: PINNED_QUARTZ_REPOSITORY,
      editLinkMode: 'owner',
      ownerOrigin: 'http://127.0.0.1:4317',
    });
    expect(manifest.renderer.resources.digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(manifest.site.outputTree).toMatchObject({ files: 2 });
    expect(manifest.site.outputTree.digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(manifest.links).toMatchObject({ pages: 2, broken: 1 });
    expect(await exists(path.join(setup.projectRoot, '.workspace', 'owner-alpha', 'cache', 'site-builds', 'build-success'))).toBe(false);
  });

  test('reuses a complete site bound to the current HEAD and policy without rendering again', async () => {
    const setup = await fixture('reuse');
    await rebuildOwnerSite({
      config: setup.config,
      projectRoot: setup.projectRoot,
      renderer: fixtureRenderer(),
    }, {
      assertCheckoutReady: async () => ready(setup.checkout),
      createBuildId: () => 'build-reuse',
      now: () => new Date('2026-07-31T12:00:00.000Z'),
    });

    let readinessChecks = 0;
    const reused = await ensureOwnerSite({
      config: setup.config,
      projectRoot: setup.projectRoot,
      renderer: async () => {
        throw new Error('renderer must not run for a current verified site');
      },
    }, {
      assertCheckoutReady: async () => {
        readinessChecks += 1;
        return ready(setup.checkout);
      },
    });

    expect(reused.ok).toBe(true);
    expect(reused.reused).toBe(true);
    expect(reused.publication).toEqual({ replacedExisting: false, reusedExisting: true });
    expect(reused.manifest.source.head).toBe(HEAD);
    expect(readinessChecks).toBe(2);
  });

  test('rebuilds with the new exact owner origin when only the listen host changes', async () => {
    const setup = await fixture('host-change-rebuild');
    await rebuildOwnerSite({
      config: setup.config,
      projectRoot: setup.projectRoot,
      renderer: fixtureRenderer(),
    }, {
      assertCheckoutReady: async () => ready(setup.checkout),
      createBuildId: () => 'build-loopback-origin',
    });

    const rebound = {
      ...setup.config,
      listen: { host: '100.100.100.100', port: 4317, readerPort: 4318 },
    };
    const renders = [];
    const rebuilt = await ensureOwnerSite({
      config: rebound,
      projectRoot: setup.projectRoot,
      renderer: fixtureRenderer((call) => renders.push(call)),
    }, {
      assertCheckoutReady: async () => ready(setup.checkout),
      createBuildId: () => 'build-private-origin',
    });

    expect(rebuilt.reused).not.toBe(true);
    expect(renders).toHaveLength(1);
    expect(renders[0].ownerOrigin).toBe('http://100.100.100.100:4317');
    expect(rebuilt.manifest.renderer.ownerOrigin).toBe('http://100.100.100.100:4317');
  });

  test('rebuilds instead of reusing when rendered output bytes change', async () => {
    const setup = await fixture('reuse-output-tamper');
    await rebuildOwnerSite({
      config: setup.config,
      projectRoot: setup.projectRoot,
      renderer: fixtureRenderer(),
    }, {
      assertCheckoutReady: async () => ready(setup.checkout),
      createBuildId: () => 'build-output-original',
    });
    const siteRoot = path.join(setup.projectRoot, '.workspace', 'owner-alpha', 'site');
    await writeFile(path.join(siteRoot, 'index.html'), '<!doctype html><html><body>Tampered</body></html>');
    let renders = 0;
    const rebuilt = await ensureOwnerSite({
      config: setup.config,
      projectRoot: setup.projectRoot,
      renderer: fixtureRenderer(() => { renders += 1; }),
    }, {
      assertCheckoutReady: async () => ready(setup.checkout),
      createBuildId: () => 'build-output-replacement',
    });
    expect(rebuilt.reused).not.toBe(true);
    expect(renders).toBe(1);
  });

  test('rebuilds instead of reusing when executable resource bytes change', async () => {
    const setup = await fixture('reuse-resource-tamper');
    await rebuildOwnerSite({
      config: setup.config,
      projectRoot: setup.projectRoot,
      renderer: fixtureRenderer(),
    }, {
      assertCheckoutReady: async () => ready(setup.checkout),
      createBuildId: () => 'build-resource-original',
    });
    await writeFile(
      path.join(setup.projectRoot, 'apps', 'owner-alpha', 'src', 'resource.txt'),
      'changed runtime resource\n',
    );
    let renders = 0;
    const rebuilt = await ensureOwnerSite({
      config: setup.config,
      projectRoot: setup.projectRoot,
      renderer: fixtureRenderer(() => { renders += 1; }),
    }, {
      assertCheckoutReady: async () => ready(setup.checkout),
      createBuildId: () => 'build-resource-replacement',
    });
    expect(rebuilt.reused).not.toBe(true);
    expect(renders).toBe(1);
  });

  test('detects projection byte changes before rendering and leaves the previous site untouched', async () => {
    const setup = await fixture('projection-tamper');
    const siteRoot = path.join(setup.projectRoot, '.workspace', 'owner-alpha', 'site');
    await write(siteRoot, 'sentinel.txt', 'previous site remains');
    let rendered = false;

    await expectCode(() => rebuildOwnerSite({
      config: setup.config,
      projectRoot: setup.projectRoot,
      renderer: async () => {
        rendered = true;
      },
    }, {
      assertCheckoutReady: async () => ready(setup.checkout),
      project: async (...args) => {
        const result = project(...args);
        await writeFile(path.join(args[1], 'pub', 'Page.md'), 'tampered projection');
        return result;
      },
      createBuildId: () => 'build-tamper',
    }), 'projected-bytes-changed');

    expect(rendered).toBe(false);
    expect(await readFile(path.join(siteRoot, 'sentinel.txt'), 'utf8')).toBe('previous site remains');
  });

  test('requires complete HTML and a coherent linkcheck baseline before replacing the configured site', async () => {
    const setup = await fixture('invalid-html');
    const siteRoot = path.join(setup.projectRoot, '.workspace', 'owner-alpha', 'site');
    await write(siteRoot, 'sentinel.txt', 'previous site remains');

    await expectCode(() => rebuildOwnerSite({
      config: setup.config,
      projectRoot: setup.projectRoot,
      renderer: async ({ outputDir }) => {
        await mkdir(outputDir, { recursive: true });
        await writeFile(path.join(outputDir, 'index.html'), '<main>incomplete fragment</main>');
        return {
          renderer: 'quartz-cyberbase',
          revision: PINNED_QUARTZ_COMMIT,
          tag: PINNED_QUARTZ_REF,
          outputDir,
        };
      },
    }, {
      assertCheckoutReady: async () => ready(setup.checkout),
      createBuildId: () => 'build-invalid-html',
    }), 'site-html-invalid');

    expect(await readFile(path.join(siteRoot, 'sentinel.txt'), 'utf8')).toBe('previous site remains');
  });

  test('rejects symlinked configured cache paths before checkout inspection or rendering', async () => {
    const setup = await fixture('cache-symlink');
    const workspace = path.join(setup.projectRoot, '.workspace', 'owner-alpha');
    const outside = path.join(setup.root, 'outside-cache');
    await mkdir(workspace, { recursive: true });
    await mkdir(outside, { recursive: true });
    await symlink(outside, path.join(workspace, 'cache'));
    let checkoutInspected = false;

    await expectCode(() => rebuildOwnerSite({
      config: setup.config,
      projectRoot: setup.projectRoot,
      renderer: fixtureRenderer(),
    }, {
      assertCheckoutReady: async () => {
        checkoutInspected = true;
        return ready(setup.checkout);
      },
    }), 'site-symlink-rejected');

    expect(checkoutInspected).toBe(false);
  });

  test('does not publish a valid candidate if HEAD changes during the build', async () => {
    const setup = await fixture('head-change');
    const siteRoot = path.join(setup.projectRoot, '.workspace', 'owner-alpha', 'site');
    await write(siteRoot, 'sentinel.txt', 'previous site remains');
    let calls = 0;

    await expectCode(() => rebuildOwnerSite({
      config: setup.config,
      projectRoot: setup.projectRoot,
      renderer: fixtureRenderer(),
    }, {
      assertCheckoutReady: async () => {
        calls += 1;
        return ready(setup.checkout, calls === 1 ? HEAD : 'b'.repeat(40));
      },
      createBuildId: () => 'build-head-change',
    }), 'site-checkout-changed');

    expect(calls).toBe(2);
    expect(await readFile(path.join(siteRoot, 'sentinel.txt'), 'utf8')).toBe('previous site remains');
  });
});

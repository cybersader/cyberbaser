// The owner's renderer slot: config validation, the manifest's renderer
// identity, symlink and permission refusals, and the offline build contract.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computePolicyRevision, validateOwnerAlphaConfig } from '../src/config.js';
import { OwnerAlphaError } from '../src/errors.js';
import { PINNED_QUARTZ_COMMIT, PINNED_QUARTZ_REF, PINNED_QUARTZ_REPOSITORY } from '../src/quartz-renderer.js';
import { assertRendererDirectory, createConfiguredRenderer, rendererIdentity } from '../src/renderer-slot.js';
import { loadSitePage } from '../src/site-review-page.js';
import { createReaderHandler } from '../src/server.js';
import { OWNER_SITE_MANIFEST_FILENAME, ensureOwnerSite, rebuildOwnerSite, reuseOwnerSite } from '../src/site.js';

const cleanup = [];
let launcherRoot;
let launcher;
beforeAll(async () => {
  launcherRoot = await mkdtemp(path.join(os.tmpdir(), 'owner-alpha-launcher-'));
  launcher = path.join(launcherRoot, 'render-offline');
  const source = fileURLToPath(new URL('../../../deploy/owner-alpha/one-app/render-offline.c', import.meta.url));
  const result = spawnSync('cc', ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', source, '-o', launcher]);
  if (result.status !== 0) throw new Error(String(result.stderr || result.error));
});
afterAll(() => launcherRoot && rm(launcherRoot, { recursive: true, force: true }));

const configured = (setup) => createConfiguredRenderer(validateOwnerAlphaConfig(setup.config).renderer, { launcher });

const HEAD = 'b'.repeat(40);
const RESOURCE_ROOTS = ['apps/owner-alpha/src', 'apps/owner-alpha/public', 'renderers/quartz-cyberbase',
  ...['correction', 'linkcheck', 'ofm', 'projection', 'proposal', 'proposal-queue', 'proposal-review', 'publish', 'trust'].map((name) => `packages/${name}/src`)];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((target) => rm(target, { recursive: true, force: true })));
});

async function temporary(name) {
  const root = await mkdtemp(path.join(os.tmpdir(), `owner-alpha-slot-${name}-`));
  cleanup.push(root);
  return root;
}

async function write(root, relativePath, contents, mode) {
  const file = path.join(root, ...relativePath.split('/'));
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, contents, mode === undefined ? undefined : { mode });
  return file;
}

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

function baseConfig(checkout) {
  return {
    schemaVersion: 1,
    listen: { host: '127.0.0.1', port: 4317 },
    proposalReview: { enabled: false, socketPath: null, requestTimeoutMs: 5000, maxListEntries: 100 },
    repository: { checkout, remote: { name: 'origin', url: 'https://github.com/cybersader/cyberbase.git' }, branch: 'main' },
    owner: { identity: 'cybersader', allowedTrustRoutes: ['auto-merge', 'quick-review'] },
    live: { baseUrl: 'https://cybersader.github.io/cyberbase/' },
    workflow: { provider: 'github-actions', repository: 'cybersader/cyberbase', name: 'Publish vault site',
      path: '.github/workflows/publish-site.yml', event: 'push', branch: 'main', jobs: ['build', 'deploy'], environment: 'github-pages' },
    workspace: { root: '.workspace/owner-alpha', store: '.workspace/owner-alpha/store', site: '.workspace/owner-alpha/site', cache: '.workspace/owner-alpha/cache' },
    paths: { include: ['**/*.md'], exclude: ['.git/**', '.workspace/**'] },
    limits: { maxSourceBytes: 2_097_152, maxReplacementBytes: 65_536, maxChangedBytes: 65_536, maxChangedLines: 60,
      maxArtifactBytes: 8_388_608, requestTimeoutMs: 30_000, networkTimeoutMs: 900_000 },
    checks: { allowedOfmVerdicts: ['clean'], requirePublishedSource: true, requireProjectionVerification: true,
      requireNoNewBrokenLinks: true, requireRenderedWitness: true },
    git: { autoCommit: true, autoPush: true, useHooks: true, commitMessagePrefix: 'owner-alpha:' },
  };
}

// A renderer that follows the contract: build <contentDir> <outDir>. It also
// records its environment and the network interfaces it could see.
const BUILD = `#!/usr/bin/env bash
set -euo pipefail
[ $# -eq 2 ] || exit 2
content="$1"; out="$2"
rm -rf "$out"; mkdir -p "$out/pub"
page="$(cat "$content/pub/Page.md")"
printf '<!doctype html><html><body><a href="/cyberbase/pub/Page">Page</a></body></html>' > "$out/index.html"
printf '<!doctype html><html><head><link rel="stylesheet" href="../site.css"></head><body><article class="popover-hint">%s</article></body></html>' "$page" > "$out/pub/Page.html"
printf 'body{color:#eee}' > "$out/site.css"
{ echo "prov=\${CYBERBASER_SOURCE_PROVENANCE:-}"; echo "mode=\${CYBERBASER_EDIT_LINK_MODE:-}"; echo "origin=\${CYBERBASER_OWNER_ORIGIN:-}";
  echo "offline=\${npm_config_offline:-}"; echo "ci=\${CI:-}"; echo "report=\${CYBERBASER_PROVENANCE_REPORT:-}"; } > "$PWD/build-env.txt"
awk 'NR>2 { sub(":", "", $1); print $1 }' /proc/net/dev > "$PWD/build-net.txt"
`;

async function fixture(name, { renderer: rendererOverrides = {} } = {}) {
  const root = await temporary(name);
  const projectRoot = path.join(root, 'cyberbaser');
  const checkout = path.join(root, 'vault');
  const rendererRoot = path.join(root, 'renderers', 'cyberchief');
  for (const relativeRoot of RESOURCE_ROOTS) await write(projectRoot, `${relativeRoot}/resource.txt`, `${relativeRoot}\n`);
  await write(checkout, 'publish.yml', 'allow:\n  - "pub/**"\n');
  await write(checkout, 'pub/Page.md', '# Public page\n\nCanonical owner bytes.\n');
  await mkdir(rendererRoot, { recursive: true, mode: 0o700 });
  await write(rendererRoot, 'build', BUILD, 0o700);
  await write(rendererRoot, 'quartz.config.ts', 'export default {}\n');
  await write(rendererRoot, 'components/Hero.tsx', 'export const Hero = 1\n');
  const renderer = { name: 'cyberchief', directory: rendererRoot, quartzCommit: PINNED_QUARTZ_COMMIT,
    fingerprint: ['build', 'components', 'quartz.config.ts'], ...rendererOverrides };
  return { root, projectRoot, checkout, rendererRoot, renderer, config: { ...baseConfig(checkout), renderer } };
}

const ready = (checkout) => async () => ({ root: checkout, head: HEAD, branch: 'main', origin: 'https://github.com/cybersader/cyberbase.git' });
const siteRootOf = (setup) => path.join(setup.projectRoot, '.workspace', 'owner-alpha', 'site');

describe('renderer slot config', () => {
  test('a configured renderer is validated and normalized; the bundled one stays the default', async () => {
    const setup = await fixture('config');
    const config = validateOwnerAlphaConfig(setup.config);
    expect(config.renderer).toEqual({ name: 'cyberchief', directory: setup.rendererRoot, quartzCommit: PINNED_QUARTZ_COMMIT,
      fingerprint: ['build', 'components', 'quartz.config.ts'] });
    expect(rendererIdentity(config)).toEqual({ name: 'cyberchief', revision: PINNED_QUARTZ_COMMIT, tag: PINNED_QUARTZ_REF,
      repository: PINNED_QUARTZ_REPOSITORY, directory: setup.rendererRoot });
    const bundled = validateOwnerAlphaConfig(baseConfig(setup.checkout));
    expect(bundled.renderer).toBeUndefined();
    expect(rendererIdentity(bundled)).toEqual({ name: 'quartz-cyberbase', revision: PINNED_QUARTZ_COMMIT, tag: PINNED_QUARTZ_REF,
      repository: PINNED_QUARTZ_REPOSITORY, directory: undefined });
    // Local build routing: the publication policy revision does not move.
    expect(computePolicyRevision(setup.config)).toBe(computePolicyRevision(baseConfig(setup.checkout)));
  });

  test('refuses unsafe or unsupported renderer settings', async () => {
    const setup = await fixture('config-refusals');
    const withRenderer = (renderer) => () => validateOwnerAlphaConfig({ ...setup.config, renderer: { ...setup.renderer, ...renderer } });
    await expectCode(withRenderer({ name: 'quartz-cyberbase' }), 'invalid-config');
    await expectCode(withRenderer({ name: 'Cyber Chief' }), 'invalid-config');
    await expectCode(withRenderer({ directory: 'renderers/cyberchief' }), 'invalid-config-path');
    await expectCode(withRenderer({ directory: `${setup.rendererRoot}/` }), 'invalid-config-path');
    await expectCode(withRenderer({ directory: `${setup.root}/x/../renderers/cyberchief` }), 'invalid-config-path');
    await expectCode(withRenderer({ directory: path.join(setup.checkout, 'site') }), 'renderer-checkout-overlap');
    await expectCode(withRenderer({ directory: setup.root }), 'renderer-checkout-overlap');
    await expectCode(withRenderer({ quartzCommit: 'c'.repeat(40) }), 'renderer-quartz-unsupported');
    await expectCode(withRenderer({ quartzCommit: 'v4.5.2' }), 'invalid-config');
    await expectCode(withRenderer({ fingerprint: [] }), 'invalid-config');
    await expectCode(withRenderer({ fingerprint: ['quartz.config.ts'] }), 'invalid-config');
    await expectCode(withRenderer({ fingerprint: ['build', '../outside'] }), 'invalid-config-path');
    await expectCode(withRenderer({ fingerprint: ['build', '/etc/passwd'] }), 'invalid-config-path');
    await expectCode(withRenderer({ fingerprint: ['build', 'components/*'] }), 'invalid-config-path');
    await expectCode(withRenderer({ fingerprint: ['build', 'build'] }), 'invalid-config');
    await expectCode(withRenderer({ fingerprint: ['build', 'components', 'components/Hero.tsx'] }), 'invalid-config');
    await expectCode(() => validateOwnerAlphaConfig({ ...setup.config, renderer: { ...setup.renderer, command: 'rm -rf /' } }), 'unknown-config-key');
    const { fingerprint, ...missing } = setup.renderer;
    expect(fingerprint).toBeArray();
    await expectCode(() => validateOwnerAlphaConfig({ ...setup.config, renderer: missing }), 'missing-config-key');
  });
});

describe('renderer slot directory checks', () => {
  test('a symlinked renderer directory, a symlink on the way, or a symlinked build entry is refused', async () => {
    const setup = await fixture('symlinks');
    const alias = path.join(setup.root, 'alias');
    await symlink(setup.rendererRoot, alias);
    await expectCode(() => assertRendererDirectory({ ...setup.renderer, directory: alias }), 'renderer-symlink-rejected');
    const parentAlias = path.join(setup.root, 'parent-alias');
    await symlink(path.join(setup.root, 'renderers'), parentAlias);
    await expectCode(() => assertRendererDirectory({ ...setup.renderer, directory: path.join(parentAlias, 'cyberchief') }), 'renderer-symlink-rejected');
    const linked = path.join(setup.root, 'linked');
    await mkdir(linked, { mode: 0o700 });
    await symlink(path.join(setup.rendererRoot, 'build'), path.join(linked, 'build'));
    await expectCode(() => assertRendererDirectory({ ...setup.renderer, directory: linked }), 'renderer-symlink-rejected');
  });

  test('a renderer others can write, a missing or non-executable build entry is refused', async () => {
    const setup = await fixture('permissions');
    expect(await assertRendererDirectory(setup.renderer)).toBe(setup.rendererRoot);
    await chmod(setup.rendererRoot, 0o770);
    await expectCode(() => assertRendererDirectory(setup.renderer), 'renderer-permissions-too-open');
    await chmod(setup.rendererRoot, 0o700);
    await chmod(path.join(setup.rendererRoot, 'build'), 0o722);
    await expectCode(() => assertRendererDirectory(setup.renderer), 'renderer-permissions-too-open');
    await chmod(path.join(setup.rendererRoot, 'build'), 0o600);
    await expectCode(() => assertRendererDirectory(setup.renderer), 'renderer-build-missing');
    await rm(path.join(setup.rendererRoot, 'build'));
    await expectCode(() => assertRendererDirectory(setup.renderer), 'renderer-build-missing');
    await expectCode(() => assertRendererDirectory({ ...setup.renderer, directory: path.join(setup.root, 'nowhere') }), 'renderer-directory-unavailable');
  });

  test('a symlink inside a fingerprinted folder stops the site build before rendering', async () => {
    const setup = await fixture('fingerprint-symlink');
    await symlink('/etc/hostname', path.join(setup.rendererRoot, 'components', 'evil.tsx'));
    await expectCode(() => rebuildOwnerSite({ config: setup.config, projectRoot: setup.projectRoot,
      renderer: async () => { throw new Error('must not render'); } }, { assertCheckoutReady: ready(setup.checkout) }), 'site-symlink-rejected');
  });
});

describe('building through the renderer slot', () => {
  test('builds offline through the configured renderer and records its identity in the manifest', async () => {
    const setup = await fixture('build');
    const result = await rebuildOwnerSite({ config: setup.config, projectRoot: setup.projectRoot, renderer: configured(setup) },
      { assertCheckoutReady: ready(setup.checkout), createBuildId: () => 'build-slot' });
    expect(result.ok).toBe(true);
    const manifest = JSON.parse(await readFile(path.join(siteRootOf(setup), OWNER_SITE_MANIFEST_FILENAME), 'utf8'));
    expect(manifest.renderer).toMatchObject({ name: 'cyberchief', revision: PINNED_QUARTZ_COMMIT, tag: PINNED_QUARTZ_REF,
      repository: PINNED_QUARTZ_REPOSITORY, directory: setup.rendererRoot, editLinkMode: 'owner', ownerOrigin: 'http://127.0.0.1:4317' });
    // The bundled renderer's files are not part of this identity; the slot's fingerprint is.
    expect(manifest.renderer.resources.files).toBe(RESOURCE_ROOTS.length - 1 + 3);
    const env = await readFile(path.join(result.rendererWorkspace, 'build-env.txt'), 'utf8');
    expect(env).toContain('prov=enabled\n');
    expect(env).toContain('mode=owner\n');
    expect(env).toContain('origin=http://127.0.0.1:4317\n');
    expect(env).toContain('offline=true\n');
    expect(env).toContain('ci=\n');
    expect(env).toMatch(/report=\/.+provenance-skipped\.json\n/u);
    // No network inside the build: only a loopback interface.
    expect((await readFile(path.join(result.rendererWorkspace, 'build-net.txt'), 'utf8')).trim().split('\n')).toEqual(['lo']);
    expect(await readFile(path.join(siteRootOf(setup), 'pub', 'Page.html'), 'utf8')).toContain('Canonical owner bytes.');

    // A current site is reused while the renderer is unchanged.
    expect((await reuseOwnerSite({ config: setup.config, projectRoot: setup.projectRoot }, { assertCheckoutReady: ready(setup.checkout) }))?.reused).toBe(true);
    // A changed fingerprinted file invalidates it.
    await writeFile(path.join(setup.rendererRoot, 'components', 'Hero.tsx'), 'export const Hero = 2\n');
    expect(await reuseOwnerSite({ config: setup.config, projectRoot: setup.projectRoot }, { assertCheckoutReady: ready(setup.checkout) })).toBeNull();
  });

  test.each(['native', 'container'])('%s reaps the renderer tree before serving the exact digested site', async (mode) => {
    const setup = await fixture(`descendant-${mode}`);
    const previous = process.env.CYBERBASER_RENDERER_ISOLATION;
    if (mode === 'container') process.env.CYBERBASER_RENDERER_ISOLATION = 'socket-filter';
    else delete process.env.CYBERBASER_RENDERER_ISOLATION;
    try {
      await writeFile(path.join(setup.rendererRoot, 'build'), `${BUILD}
/usr/bin/setsid /usr/bin/bash -c '
  exec 9>"$1/site.css"
  printf "body{color:#eee}" >&9
  printf "%s" "$$" > "$2"
  /usr/bin/sleep 3
  printf "late fixture bytes" >&9
' fixture "$out" "$PWD/descendant.pid" </dev/null >/dev/null 2>&1 &
for (( i=0; i<500; i++ )); do
  [ -s "$PWD/descendant.pid" ] && exit 0
  sleep .01
done
exit 1
`);
      const result = await rebuildOwnerSite({ config: setup.config, projectRoot: setup.projectRoot, renderer: configured(setup) },
        { assertCheckoutReady: ready(setup.checkout), createBuildId: () => `build-descendant-${mode}` });
      const pid = Number(await readFile(path.join(result.rendererWorkspace, 'descendant.pid'), 'utf8'));
      expect(pid).toBeGreaterThan(1);
      await expect(lstat(`/proc/${pid}`)).rejects.toHaveProperty('code', 'ENOENT');

      const siteRoot = siteRootOf(setup);
      const config = validateOwnerAlphaConfig(setup.config);
      const host = `${config.listen.host}:${config.listen.readerPort}`;
      const reader = createReaderHandler({ config, siteRoot, hasOwnerSession: () => true });
      const served = await reader(new Request(`http://${host}/cyberbase/site.css`, { headers: { Host: host } }));
      expect(served.status).toBe(200);
      const css = Buffer.from(await served.arrayBuffer());
      expect(css.toString()).toBe('body{color:#eee}');
      const hash = createHash('sha256');
      for (const name of ['index.html', 'pub/Page.html', 'site.css']) {
        const bytes = name === 'site.css' ? css : await readFile(path.join(siteRoot, name));
        hash.update(`${name}\0${bytes.length}\0`).update(bytes);
      }
      expect(result.manifest.site.outputTree.digest).toBe(`sha256:${hash.digest('hex')}`);
    } finally {
      if (previous === undefined) delete process.env.CYBERBASER_RENDERER_ISOLATION;
      else process.env.CYBERBASER_RENDERER_ISOLATION = previous;
    }
  });

  test('a manifest from another renderer is never reused, here or by the review page', async () => {
    const setup = await fixture('switch');
    await rebuildOwnerSite({ config: setup.config, projectRoot: setup.projectRoot, renderer: configured(setup) },
      { assertCheckoutReady: ready(setup.checkout), createBuildId: () => 'build-one' });
    const other = { ...setup.config, renderer: { ...setup.renderer, name: 'cyberchief-two' } };
    expect(await reuseOwnerSite({ config: other, projectRoot: setup.projectRoot }, { assertCheckoutReady: ready(setup.checkout) })).toBeNull();
    // Switching back to the bundled renderer does not reuse it either.
    expect(await reuseOwnerSite({ config: baseConfig(setup.checkout), projectRoot: setup.projectRoot },
      { assertCheckoutReady: ready(setup.checkout) }).catch((error) => error.code)).toBeNull();
    const page = { siteRoot: siteRootOf(setup), sourcePath: 'pub/Page.md', revision: HEAD, baseText: '# Public page\n\nCanonical owner bytes.\n' };
    expect((await loadSitePage(page)).reason).toBe('unavailable');
    expect((await loadSitePage({ ...page, rendererName: 'cyberchief-two' })).reason).toBe('unavailable');
    // The right name gets past the manifest (the fake build writes no provenance).
    expect((await loadSitePage({ ...page, rendererName: 'cyberchief', revision: 'c'.repeat(40) })).reason).toBe('changed');
  });

  test('a renderer result that names another renderer is refused and the old site stays', async () => {
    const setup = await fixture('identity');
    await write(siteRootOf(setup), 'sentinel.txt', 'previous site');
    const lying = async ({ outputDir }) => {
      await mkdir(path.join(outputDir, 'pub'), { recursive: true });
      await writeFile(path.join(outputDir, 'index.html'), '<!doctype html><html><body>x</body></html>');
      return { renderer: 'quartz-cyberbase', revision: PINNED_QUARTZ_COMMIT, tag: PINNED_QUARTZ_REF, outputDir };
    };
    await expectCode(() => rebuildOwnerSite({ config: setup.config, projectRoot: setup.projectRoot, renderer: lying },
      { assertCheckoutReady: ready(setup.checkout), createBuildId: () => 'build-lie' }), 'site-renderer-identity-mismatch');
    const wrongCommit = async (input) => ({ ...await lying(input), renderer: 'cyberchief', revision: 'c'.repeat(40) });
    await expectCode(() => rebuildOwnerSite({ config: setup.config, projectRoot: setup.projectRoot, renderer: wrongCommit },
      { assertCheckoutReady: ready(setup.checkout), createBuildId: () => 'build-commit' }), 'site-renderer-identity-mismatch');
    expect(await readFile(path.join(siteRootOf(setup), 'sentinel.txt'), 'utf8')).toBe('previous site');
  });

  test('the working renderer can patch files without changing the installed fingerprint', async () => {
    const setup = await fixture('self-modifying');
    const original = path.join(setup.rendererRoot, 'quartz.config.ts');
    const bytes = await readFile(original);
    await writeFile(path.join(setup.rendererRoot, 'build'), `${BUILD}
copy="$(dirname "$0")"
mkdir -p "$copy/quartz/.quartz-cache"
printf 'patch applied' >> "$copy/quartz.config.ts"
`);
    const site = await ensureOwnerSite({ config: setup.config, projectRoot: setup.projectRoot, renderer: configured(setup) },
      { assertCheckoutReady: ready(setup.checkout), createBuildId: () => 'build-self' });
    expect(site.ok).toBe(true);
    expect(await readFile(original)).toEqual(bytes);
    await expect(lstat(path.join(setup.rendererRoot, 'quartz', '.quartz-cache'))).rejects.toHaveProperty('code', 'ENOENT');
    expect((await readdir(site.rendererWorkspace)).filter((name) => name.startsWith('renderer-copy-'))).toEqual([]);
  });

  test('the renderer directory may not sit inside the project or its workspace, and the form needs the bundled renderer', async () => {
    const setup = await fixture('overlap');
    const inside = path.join(setup.projectRoot, 'renderers', 'mine');
    await mkdir(inside, { recursive: true, mode: 0o700 });
    await expectCode(() => rebuildOwnerSite({ config: { ...setup.config, renderer: { ...setup.renderer, directory: inside } }, projectRoot: setup.projectRoot },
      { assertCheckoutReady: ready(setup.checkout) }), 'renderer-build-missing');
    await write(inside, 'build', BUILD, 0o700);
    await write(inside, 'quartz.config.ts', 'x');
    await write(inside, 'components/a.tsx', 'x');
    await expectCode(() => rebuildOwnerSite({ config: { ...setup.config, renderer: { ...setup.renderer, directory: inside } }, projectRoot: setup.projectRoot },
      { assertCheckoutReady: ready(setup.checkout) }), 'renderer-workspace-overlap');
    const render = createConfiguredRenderer(validateOwnerAlphaConfig(setup.config).renderer);
    await expectCode(() => render({ contentDir: setup.checkout, outputDir: path.join(setup.root, 'out'), workspaceDir: path.join(setup.root, 'ws'),
      ownerOrigin: 'http://127.0.0.1:4317', suggestions: { intakeOrigin: 'http://127.0.0.1:4318' } }), 'renderer-form-unsupported');
    await expectCode(() => render({ contentDir: setup.checkout, outputDir: path.join(setup.rendererRoot, 'out'), workspaceDir: path.join(setup.root, 'ws'),
      ownerOrigin: 'http://127.0.0.1:4317' }), 'renderer-path-overlap');
  });
});

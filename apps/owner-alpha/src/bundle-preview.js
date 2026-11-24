// Route C on the site's own design: a new page from a bundle, built by the
// owner's configured renderer in a private build of just the bundle's files
// (its note, folder index and images), then shown like any site page in the
// review frame: scripts and links removed, stylesheets, fonts and images
// inlined, nothing loaded by address. The whole page is new, so it carries a
// "New page at" banner instead of change marks. Anything that does not work
// returns null and the simplified rendering is shown instead.
//
// Only for a configured renderer (renderer-slot.js): its builds run offline
// and one at a time with the site build. The bundled renderer keeps the
// simplified rendering for bundles.
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createConfiguredRenderer, rendererIdentity } from './renderer-slot.js';
import { readBuiltSitePage, sitePageSlug } from './site-review-page.js';

const BUNDLE_ID_RE = /^bundle-[0-9a-f-]{36}$/u;
const CACHE_ENTRIES = 8;
// Bundle images may be up to 5 MiB each, four per bundle.
const IMAGE_LIMITS = Object.freeze({ image: 5 * 1024 * 1024, images: 20 * 1024 * 1024 });

function safeRelative(value) {
  return typeof value === 'string' && value !== '' && !value.startsWith('/') && !value.includes('\\') && !/\p{Cc}/u.test(value)
    && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

/**
 * previewBundle({ bundleId, index, bundle, record, readImage, colorScheme })
 * -> Promise<string | null>. `readImage(path)` returns { bytes } already
 * checked against the bundle.
 */
export function createBundlePreview({ config, projectRoot, render = null }) {
  if (!config?.renderer) return null;
  const identity = rendererIdentity(config);
  const build = render ?? createConfiguredRenderer(config.renderer);
  const cacheRoot = path.resolve(projectRoot, config.workspace.cache, 'bundle-previews');
  const ownerOrigin = `http://${config.listen.host}:${config.listen.port}`;
  const cache = new Map();

  async function produce({ bundleId, index, bundle, record, readImage, colorScheme }) {
    const addition = record.publicAdditions[index];
    const note = addition && bundle.files.find((file) => file.path === addition.path && file.kind === 'create');
    if (!note) return null;
    const files = bundle.files.filter((file) => file.kind === 'create' || file.kind === 'create-asset');
    if (!files.every((file) => safeRelative(file.path))) return null;
    const root = path.join(cacheRoot, bundleId);
    const content = path.join(root, 'content');
    const site = path.join(root, 'site');
    await rm(root, { recursive: true, force: true });
    await mkdir(content, { recursive: true, mode: 0o700 });
    try {
      for (const file of files) {
        const target = path.join(content, ...file.path.split('/'));
        await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        const bytes = file.kind === 'create' ? Buffer.from(file.text, 'utf8') : Buffer.from((await readImage(file.path)).bytes);
        await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
      }
      const result = await build({ contentDir: content, outputDir: site, workspaceDir: path.join(root, 'work'), ownerOrigin });
      if (result?.renderer !== identity.name || result.revision !== identity.revision) return null;
      const slug = sitePageSlug(note.path, note.text);
      if (slug === null) return null;
      return await readBuiltSitePage({ siteRoot: site, slug, colorScheme, imageLimits: IMAGE_LIMITS,
        banner: { label: 'New page at', address: addition.address } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  return async function previewBundle(input) {
    if (!BUNDLE_ID_RE.test(input?.bundleId ?? '') || !Number.isSafeInteger(input.index) || input.index < 0) return null;
    // A bundle never changes; its preview is kept for the life of this process.
    const key = `${input.bundleId}/${input.index}/${input.colorScheme ?? ''}`;
    if (!cache.has(key)) {
      const pending = produce(input).catch(() => null);
      cache.set(key, pending);
      while (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value);
      if (await pending === null) cache.delete(key);
    }
    return cache.get(key) ?? null;
  };
}

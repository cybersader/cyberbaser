// Route C on the site's own design: a new page from a bundle, built by the
// owner's configured renderer in a private build of the whole public
// selection of the vault at the bundle's base commit with the bundle's new
// files (its note, folder index and images) added, so the renderer sees the
// same folder notes, author notes, links and images as a full site build.
// The page is then shown like any site page in the review frame: scripts and
// links removed, stylesheets, fonts and images inlined, nothing loaded by
// address. The whole page is new, so it carries a "New page at" banner
// instead of change marks. Anything that does not work (the checkout is not
// at the bundle's base, a new file would replace an existing path, the build
// fails) returns null and the simplified rendering is shown instead.
//
// Only for a configured renderer (renderer-slot.js): its builds run offline
// and one at a time with the site build. The bundled renderer keeps the
// simplified rendering for bundles.
//
// Address check: the page is looked up at the address the device, the node
// and the approval sheet all computed (the vault's address style,
// .cyberbaser/site.yml). When the build succeeds but has no page there, the
// renderer addresses pages differently: the preview answers
// { refused: 'address-mismatch' } so the bundle is refused rather than signed
// for an address the site will not have.
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { project as projectContent, verifyProjection } from '@cyberbaser/projection';
import { addressFor, parseFrontmatter, readAddressStyle, renderSlug, select } from '@cyberbaser/publish';

const parseSlug = (text) => parseFrontmatter(text).data?.slug;
import { createConfiguredRenderer, rendererIdentity } from './renderer-slot.js';
import { verifyBytePreservingProjection } from './site.js';
import { assertCheckoutReady } from './source.js';
import { readBuiltSitePage, sitePageSlug } from './site-review-page.js';

const BUNDLE_ID_RE = /^bundle-[0-9a-f-]{36}$/u;
const COMMIT_RE = /^[0-9a-f]{40}$/u;
const CACHE_ENTRIES = 8;
// Bundle images may be up to 5 MiB each, four per bundle.
const IMAGE_LIMITS = Object.freeze({ image: 5 * 1024 * 1024, images: 20 * 1024 * 1024 });

function safeRelative(value) {
  return typeof value === 'string' && value !== '' && !value.startsWith('/') && !value.includes('\\') && !/\p{Cc}/u.test(value)
    && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

/** Every file under a directory, as "/"-separated paths relative to it. */
async function listFiles(root, prefix = '') {
  const out = [];
  for (const entry of await readdir(path.join(root, ...prefix.split('/').filter(Boolean)), { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...await listFiles(root, relative));
    else if (entry.isFile()) out.push(relative);
  }
  return out;
}

async function exists(target) {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * previewBundle({ bundleId, index, bundle, record, readImage, colorScheme })
 * -> Promise<string | null>. `readImage(path)` returns { bytes } already
 * checked against the bundle. `dependencies` may replace the checkout
 * readiness check (tests); selection and projection are the site build's own.
 */
export function createBundlePreview({ config, projectRoot, render = null, dependencies = {} }) {
  if (!config?.renderer) return null;
  const identity = rendererIdentity(config);
  const build = render ?? createConfiguredRenderer(config.renderer);
  const cacheRoot = path.resolve(projectRoot, config.workspace.cache, 'bundle-previews');
  const ownerOrigin = `http://${config.listen.host}:${config.listen.port}`;
  const cache = new Map();
  const checkCheckout = dependencies.assertCheckoutReady ?? assertCheckoutReady;
  const log = typeof dependencies.log === 'function' ? dependencies.log : () => {};

  async function produce({ bundleId, index, bundle, record, readImage, colorScheme }) {
    const skip = (reason) => { log(`bundle preview not built: ${reason}`); return null; };
    const addition = record.publicAdditions[index];
    const note = addition && bundle.files.find((file) => file.path === addition.path && file.kind === 'create');
    if (!note) return skip('note');
    const files = bundle.files.filter((file) => file.kind === 'create' || file.kind === 'create-asset');
    if (!files.every((file) => safeRelative(file.path))) return skip('unsafe-path');
    const base = bundle.source?.revision;
    if (typeof base !== 'string' || !COMMIT_RE.test(base)) return skip('no-base');
    // Preview on exactly the base the bundle was made against, never another.
    const checkout = await checkCheckout(config);
    if (checkout?.head !== base || typeof checkout.root !== 'string' || !path.isAbsolute(checkout.root)) return skip('checkout-not-at-base');
    // New files only: a path that exists at the base, published or not, is a refusal.
    for (const file of files) {
      if (await exists(path.join(checkout.root, ...file.path.split('/')))) return skip('path-exists');
    }
    // Its own directory per build: two previews of one bundle (the check before
    // signing and the review page) may run at once.
    await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
    const root = await mkdtemp(path.join(cacheRoot, `${bundleId}-`));
    const content = path.join(root, 'content');
    const site = path.join(root, 'site');
    try {
      // The site build's own public selection, projected byte for byte.
      const selection = await select(checkout.root, { audience: 'public' });
      if (!Array.isArray(selection?.published) || selection.published.length === 0) return skip('nothing-published');
      const projection = await projectContent(checkout.root, content, { audience: 'public', selectResult: selection,
        lowercase: false, verify: true, writeReport: false });
      if (projection?.ok !== true) return skip('projection');
      if ((await verifyProjection(checkout.root, content, selection, { lowercase: false }))?.ok !== true) return skip('projection-verify');
      await verifyBytePreservingProjection(checkout.root, content, selection.published);
      for (const file of files) {
        const target = path.join(content, ...file.path.split('/'));
        await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        const bytes = file.kind === 'create' ? Buffer.from(file.text, 'utf8') : Buffer.from((await readImage(file.path)).bytes);
        await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
      }
      const result = await build({ contentDir: content, outputDir: site, workspaceDir: path.join(root, 'work'), ownerOrigin });
      if (result?.renderer !== identity.name || result.revision !== identity.revision) return skip('renderer-identity');
      const siteYml = await readFile(path.join(checkout.root, '.cyberbaser', 'site.yml'), 'utf8').catch(() => null);
      const style = readAddressStyle(siteYml);
      if (!style.ok) return skip('address-style-unknown');
      // Where the renderer draws the note: a folder note may be its folder's
      // page ("<folder>/index") or a page ("<folder>"), depending on the other
      // files of this same build (renderSlug, the Cyberchief FolderNotes rule).
      // An explicit slug: moves the page and is used as written.
      const slug = typeof parseSlug(note.text) === 'string'
        ? sitePageSlug(note.path, note.text, style.style)
        : renderSlug(note.path, await listFiles(content), style.style);
      if (slug === null) return skip('no-slug');
      // The address everyone was shown must be the one this computes, and the built page must be there.
      const expected = addressFor(note.path, typeof parseSlug(note.text) === 'string' ? parseSlug(note.text) : null, style.style);
      if (expected !== addition.address || !(await exists(path.join(site, ...`${slug}.html`.split('/'))))) {
        return { refused: 'address-mismatch' };
      }
      return await readBuiltSitePage({ siteRoot: site, slug, colorScheme, imageLimits: IMAGE_LIMITS,
        banner: { label: 'New page at', address: addition.address } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  // Returns the framed page (a string), { refused: 'address-mismatch' }, or null (simplified rendering).
  return async function previewBundle(input) {
    if (!BUNDLE_ID_RE.test(input?.bundleId ?? '') || !Number.isSafeInteger(input.index) || input.index < 0) return null;
    // A bundle never changes; its preview is kept for the life of this process.
    const key = `${input.bundleId}/${input.bundle?.source?.revision ?? ''}/${input.index}/${input.colorScheme ?? ''}`;
    if (!cache.has(key)) {
      const pending = produce(input).catch((error) => { log(`bundle preview failed: ${error?.code ?? error?.message ?? 'failed'}${error?.details ? `; exit ${error.details.exitCode}; ${String(error.details.stderr ?? '').slice(-1200)} | ${String(error.details.stdout ?? '').slice(-800)}` : ''}`); return null; });
      cache.set(key, pending);
      while (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value);
      if (await pending === null) cache.delete(key);
    }
    return cache.get(key) ?? null;
  };
}

// Internal link checker for a built static site.
//
// Input is the output directory of any renderer; the checker never imports renderer
// internals and never reads the source vault. It answers one question per link:
// does something on disk satisfy this href from the page that emitted it?

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative, sep, extname } from 'node:path';

const HREF_RE = /\shref\s*=\s*"([^"]*)"/gi;
const IMG_RE = /<img\b[^>]*?\ssrc\s*=\s*"([^"]*)"/gi;

// Schemes and shapes that are never checked against the local filesystem.
const SKIP_SCHEME_RE = /^(?:[a-z][a-z0-9+.-]*:)?\/\//i;
const SKIP_PROTOCOL_RE = /^(?:mailto|tel|javascript|data|sms|ftp|file|about|blob|obsidian):/i;

const ASSET_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.avif', '.bmp', '.ico',
  '.pdf', '.mp4', '.webm', '.mov', '.mp3', '.wav', '.ogg',
  '.css', '.js', '.mjs', '.json', '.xml', '.txt', '.csv',
  '.zip', '.gz', '.tar', '.7z', '.woff', '.woff2', '.ttf', '.otf',
  '.xlsx', '.docx', '.pptx', '.canvas', '.base',
]);

const PAGE_EXT = new Set(['', '.html', '.htm', '.md']);

export function htmlFiles(dir) {
  const out = [];
  const walk = (d) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '.git') continue;
        walk(p);
      } else if (e.isFile() && /\.html?$/i.test(e.name)) {
        out.push(p);
      }
    }
  };
  walk(dir);
  return out;
}

export function isExternal(href) {
  const h = href.trim();
  if (!h) return true;
  if (h.startsWith('#')) return true;
  if (SKIP_SCHEME_RE.test(h)) return true;
  if (SKIP_PROTOCOL_RE.test(h)) return true;
  return false;
}

// Strip the fragment and query, then percent-decode. Quartz emits raw UTF-8 in most
// hrefs but percent-encodes some (the "Edit this page" style links), so both shapes
// have to normalize to the same on-disk name before the existence test.
export function normalizeHref(href) {
  let h = href.trim();
  const hash = h.indexOf('#');
  if (hash > -1) h = h.slice(0, hash);
  const q = h.indexOf('?');
  if (q > -1) h = h.slice(0, q);
  if (!h) return null;
  try {
    return decodeURIComponent(h);
  } catch {
    return h;
  }
}

function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

// A link resolves if the literal path is a file, or the .html sibling exists, or the
// path is a directory served by its index.html. Directories without an index do not
// count: a static host would 404 them.
export function resolveLink(siteDir, pageFile, decoded, basePath = '') {
  const isRoot = decoded.startsWith('/');
  const base = isRoot ? siteDir : dirname(pageFile);
  let raw = isRoot ? decoded.slice(1) : decoded;
  // A root-absolute href on a site served from a subpath (GitHub Pages project sites)
  // carries the deploy prefix, which is not part of the output directory.
  if (isRoot && basePath && (raw === basePath || raw.startsWith(`${basePath}/`))) {
    raw = raw.slice(basePath.length).replace(/^\//, '');
  }
  const target = resolve(base, raw);
  if (isFile(target)) return target;
  if (isFile(`${target}.html`)) return `${target}.html`;
  if (isFile(join(target, 'index.html'))) return join(target, 'index.html');
  return null;
}

export function classify(decoded) {
  if (decoded.includes('_attachments')) return 'relative-attachment';
  const ext = extname(decoded).toLowerCase();
  if (ASSET_EXT.has(ext)) return 'missing-asset';
  if (PAGE_EXT.has(ext)) return 'missing-page';
  return 'other';
}

const CLASS_ORDER = ['relative-attachment', 'missing-page', 'missing-asset', 'other'];

function relPage(siteDir, file) {
  return relative(siteDir, file).split(sep).join('/');
}

/**
 * Check every internal link in a built site.
 *
 * @param {string} siteDir  directory containing the built HTML
 * @param {object} [opts]
 * @param {(string|RegExp)[]} [opts.ignore]  hrefs matching any entry are not checked
 * @param {string} [opts.basePath]  deploy subpath stripped from root-absolute hrefs
 * @returns {{total:number, ok:number, occurrences:number, pages:number,
 *            broken:{page:string,href:string,decoded:string,class:string}[],
 *            byClass:Record<string,number>, byPage:Record<string,number>}}
 *
 * `total` and `ok` count unique (page, href) pairs so a link repeated in a nav block
 * is one finding, not fifty; `occurrences` keeps the raw attribute count.
 */
export function checkSite(siteDir, opts = {}) {
  const root = resolve(siteDir);
  const ignore = opts.ignore ?? [];
  const basePath = (opts.basePath ?? '').replace(/^\/+|\/+$/g, '');
  const skip = (h) => ignore.some((m) => (typeof m === 'string' ? h.includes(m) : m.test(h)));

  const files = htmlFiles(root);
  const broken = [];
  let total = 0;
  let ok = 0;
  let occurrences = 0;

  for (const file of files) {
    const html = readFileSync(file, 'utf8');
    const page = relPage(root, file);
    const seen = new Map();

    for (const re of [HREF_RE, IMG_RE]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(html)) !== null) {
        const href = m[1];
        if (isExternal(href) || skip(href)) continue;
        const decoded = normalizeHref(href);
        if (decoded === null) continue;
        occurrences++;
        if (!seen.has(href)) seen.set(href, decoded);
      }
    }

    for (const [href, decoded] of [...seen.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      total++;
      if (resolveLink(root, file, decoded, basePath)) ok++;
      else broken.push({ page, href, decoded, class: classify(decoded) });
    }
  }

  broken.sort((a, b) => {
    const ca = CLASS_ORDER.indexOf(a.class);
    const cb = CLASS_ORDER.indexOf(b.class);
    if (ca !== cb) return ca - cb;
    if (a.page !== b.page) return a.page < b.page ? -1 : 1;
    return a.href < b.href ? -1 : 1;
  });

  const byClass = {};
  for (const c of CLASS_ORDER) {
    const n = broken.filter((b) => b.class === c).length;
    if (n) byClass[c] = n;
  }

  const counts = new Map();
  for (const b of broken) counts.set(b.page, (counts.get(b.page) ?? 0) + 1);
  const byPage = {};
  for (const [p, n] of [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))) {
    byPage[p] = n;
  }

  return { total, ok, occurrences, pages: files.length, broken, byClass, byPage };
}

export { CLASS_ORDER };

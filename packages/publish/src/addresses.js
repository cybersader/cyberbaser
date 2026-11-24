/**
 * Web addresses: how a renderer turns a vault path into the address a reader
 * types. One pure function, used by every layer that names an address before
 * the site is built: the device ("New public page: /address" and the form's
 * preview), the node (a bundle's public additions), and the owner's review
 * page (which built page to show). Each reads the vault's own
 * `.cyberbaser/site.yml`, so they agree with each other and with the renderer.
 *
 * Styles (`addresses:` in site.yml, under `site:` or at the top level):
 *   quartz            (default) stock Quartz 4.5.2 slugifyFilePath: per path
 *                     segment, whitespace -> "-", "&" -> "-and-", "%" ->
 *                     "-percent", "?" and "#" removed; case kept; ".md"
 *                     dropped; a final "_index" is "index".
 *   lowercase-hyphen  the Cyberchief renderer's rule (its patched
 *                     quartz/util/path.ts sluggifySegment), per path segment:
 *                     accents stripped (NFKD, combining marks dropped),
 *                     lower-cased, "&" -> "and", "%" -> "percent",
 *                     apostrophes dropped, every other run of characters that
 *                     is not a letter or digit -> one "-", trimmed. Letters of
 *                     any script are kept. A known file extension is kept,
 *                     lower-cased; ".md" is dropped; any other dot is part of
 *                     the name ("NIST CSF 2.0" -> nist-csf-2-0).
 *                     "Leadership & strategy/Questions to ask a new CISO.md"
 *                       -> /leadership-and-strategy/questions-to-ask-a-new-ciso
 *
 * A renderer that addresses pages differently must say so here, or the node's
 * preview check refuses the bundle (`address-mismatch`).
 */
import yaml from 'js-yaml';

export const ADDRESS_STYLES = Object.freeze(['quartz', 'lowercase-hyphen']);
export const DEFAULT_ADDRESS_STYLE = 'quartz';

// The Cyberchief renderer's list: only these count as file extensions.
const KNOWN_EXTENSION = /^\.(md|html?|png|jpe?g|gif|bmp|svg|webp|avif|ico|tiff?|mp4|webm|ogv|mov|mkv|mp3|wav|m4a|ogg|oga|3gp|flac|pdf|css|js|mjs|json|xml|txt|csv|tsv|zip|woff2?|ttf|otf|canvas|base|docx?|xlsx?|pptx?|ya?ml)$/iu;

const SEGMENT = Object.freeze({
  quartz: (part) => part.replace(/\s/gu, '-').replace(/&/gu, '-and-').replace(/%/gu, '-percent').replace(/\?/gu, '').replace(/#/gu, ''),
  'lowercase-hyphen': (part) => part.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase()
    .replace(/&/gu, ' and ').replace(/%/gu, ' percent ').replace(/['‘’`]/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/gu, ''),
});

function segmentRule(style) {
  const rule = SEGMENT[style];
  if (!rule) throw new TypeError(`unknown address style ${style}`);
  return rule;
}

/**
 * The renderer's slug for any vault file (no leading slash): a note without
 * ".md", a file with its extension. Null when the path is unsafe or a segment
 * would be empty.
 */
export function fileSlug(vaultPath, style = DEFAULT_ADDRESS_STYLE) {
  const segment = segmentRule(style);
  if (typeof vaultPath !== 'string' || /\0/u.test(vaultPath) || (style === 'quartz' && vaultPath.includes('\\'))) return null;
  const trimmed = vaultPath.normalize('NFC').replace(/^\.\//u, '').replace(/^\/+|\/+$/gu, '');
  const parts = trimmed.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return null;
  let last = parts.pop();
  let extension = '';
  if (style === 'quartz') {
    if (/\.md$/iu.test(last)) last = last.slice(0, -3);
    else { const found = /\.[A-Za-z0-9]+$/u.exec(last); if (found) { extension = found[0]; last = last.slice(0, -extension.length); } }
  } else {
    const found = /\.[^./]+$/u.exec(last);
    if (found && KNOWN_EXTENSION.test(found[0])) {
      last = last.slice(0, -found[0].length);
      extension = /^\.(md|html?)$/iu.test(found[0]) ? '' : found[0].toLowerCase();
    }
  }
  const slug = [...parts, last].map(segment).join('/').replace(/(^|\/)_index$/u, '$1index');
  if (slug.split('/').some((part) => part === '' || part === '.' || part === '..')) return null;
  return `${slug}${extension}`;
}

/** The page slug (no leading slash, no extension) for a Markdown vault path, or null. */
export function pageSlug(vaultPath, style = DEFAULT_ADDRESS_STYLE) {
  if (typeof vaultPath !== 'string' || !/\.md$/iu.test(vaultPath.replace(/\/+$/u, ''))) {
    // A path without .md is treated as a note path (an explicit slug: names a page).
    return typeof vaultPath === 'string' ? fileSlug(`${vaultPath.replace(/\/+$/u, '')}.md`, style) : null;
  }
  return fileSlug(vaultPath, style);
}

/**
 * The address for a page: `/topic/note`, `/topic/` for a folder note, `/` for
 * the home page. slug: the page's own `slug:` property, which moves it (the
 * same rule applies to it).
 */
export function addressFor(vaultPath, slug = null, style = DEFAULT_ADDRESS_STYLE) {
  const own = typeof slug === 'string' ? slugTargetPath(slug) : null;
  const slugged = pageSlug(own ?? vaultPath, style);
  if (slugged === null) return null;
  if (slugged === 'index') return '/';
  return `/${slugged.endsWith('/index') ? slugged.slice(0, -'index'.length) : slugged}`;
}

/** A tag's slug: every segment by the same rule (the renderer's slugTag). */
export function tagSlug(tag, style = DEFAULT_ADDRESS_STYLE) {
  const segment = segmentRule(style);
  if (typeof tag !== 'string') return null;
  return tag.split('/').map(segment).join('/');
}

/** The vault path an explicit `slug:` names (`slug: index` is the home page), or null when unsafe. */
export function slugTargetPath(slug) {
  if (typeof slug !== 'string') return null;
  const s = slug.trim().replace(/^\/+|\/+$/gu, '').replace(/\.(md|html)$/iu, '');
  if (s === '' || s.includes('\\') || /[\u0000-\u001F\u007F]/u.test(s)) return null;
  if (s.split('/').some((x) => x === '' || x === '.' || x === '..' || x.trim() !== x)) return null;
  return `${s}.md`;
}

/**
 * The address style a vault's `.cyberbaser/site.yml` declares, under `site:`
 * (as Cyberchief writes it) or at the top level. text: the file's text, or
 * null when there is none (the default). Returns { ok: true, style } or
 * { ok: false, error } for a value this code does not know, or two places
 * that disagree, so every layer fails closed the same way instead of guessing.
 */
export function readAddressStyle(text) {
  if (text === null || text === undefined) return { ok: true, style: DEFAULT_ADDRESS_STYLE };
  let raw;
  try { raw = yaml.load(String(text), { schema: yaml.CORE_SCHEMA }); } catch {
    return { ok: false, error: '.cyberbaser/site.yml is not valid YAML.' };
  }
  const isMap = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const values = [isMap(raw) ? raw.addresses : undefined, isMap(raw) && isMap(raw.site) ? raw.site.addresses : undefined]
    .filter((value) => value !== undefined && value !== null);
  if (values.length === 0) return { ok: true, style: DEFAULT_ADDRESS_STYLE };
  if (values.length === 2 && values[0] !== values[1]) {
    return { ok: false, error: '.cyberbaser/site.yml gives two different address styles; keep one, under site:.' };
  }
  if (!ADDRESS_STYLES.includes(values[0])) {
    return { ok: false, error: `.cyberbaser/site.yml says addresses: ${JSON.stringify(values[0])}; use one of: ${ADDRESS_STYLES.join(', ')}.` };
  }
  return { ok: true, style: values[0] };
}

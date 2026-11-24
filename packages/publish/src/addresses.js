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
 *                     Input is NFC-normalised first, so composed and
 *                     decomposed accents give one address.
 *                     Folder notes: a note whose name (minus .md) is "index"
 *                     or equals its folder's name, compared as address
 *                     segments ("Topic/Topic.md", "Risk & governance/risk and
 *                     governance.md"), is that folder's note and has the
 *                     folder's address. Other files (images) keep their own
 *                     path. The address has no leading or trailing "/" in
 *                     addressOf ("" is the home page); addressFor writes it
 *                     with one leading "/" ("/topic", "/" for home), never a
 *                     trailing one. Where the renderer draws a folder note
 *                     (a folder page "<folder>/index" or a page "<folder>")
 *                     depends on the other files: renderSlug(). Two files with
 *                     one address are refused (addressCollisions,
 *                     create-address-collision). Test cases: the Cyberchief
 *                     renderer's site/address-rule.cases.json, copied to
 *                     test/fixtures/.
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
  'lowercase-hyphen': (part) => part.normalize('NFC').normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase()
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
  let note = true;
  if (style === 'quartz') {
    if (/\.md$/iu.test(last)) last = last.slice(0, -3);
    else { const found = /\.[A-Za-z0-9]+$/u.exec(last); if (found) { extension = found[0]; last = last.slice(0, -extension.length); } }
  } else {
    const found = /\.[^./]+$/u.exec(last);
    if (found && KNOWN_EXTENSION.test(found[0])) {
      last = last.slice(0, -found[0].length);
      note = /^\.md$/iu.test(found[0]);
      extension = /^\.(md|html?)$/iu.test(found[0]) ? '' : found[0].toLowerCase();
    }
  }
  let slug = [...parts, last].map(segment).join('/').replace(/(^|\/)_index$/u, '$1index');
  if (slug.split('/').some((part) => part === '' || part === '.' || part === '..')) return null;
  // A same-name folder note ("Topic/Post/Post.md") takes its folder's slug.
  if (style === 'lowercase-hyphen' && note) slug = collapseFolderNote(slug);
  return `${slug}${extension}`;
}

/** "a/b/b" -> "a/b" (segments already slugged); anything else unchanged. */
function collapseFolderNote(slug) {
  const segments = slug.split('/');
  const last = segments.at(-1);
  if (segments.length < 2 || last === 'index') return slug;
  return last === segments.at(-2) ? segments.slice(0, -1).join('/') : slug;
}

/** One path segment's address form, by the style (the renderer's sluggifySegment). */
export function addressSegment(name, style = DEFAULT_ADDRESS_STYLE) {
  return segmentRule(style)(String(name).normalize('NFC'));
}

/**
 * Is this vault path a folder note? quartz: "index.md" (or "_index.md") in
 * any folder. lowercase-hyphen: also a note whose name equals its folder's
 * name as an address segment ("Topic/Topic.md", "Café/café.md",
 * "Risk & governance/Risk and governance.md").
 */
export function isFolderNotePath(vaultPath, style = DEFAULT_ADDRESS_STYLE) {
  if (typeof vaultPath !== 'string') return false;
  const parts = vaultPath.normalize('NFC').replace(/^\/+|\/+$/gu, '').split('/');
  const file = parts.pop() ?? '';
  if (!/\.md$/iu.test(file)) return false;
  const stem = file.slice(0, -3);
  const segment = segmentRule(style);
  if (/^_?index$/iu.test(stem) || (style === 'lowercase-hyphen' && segment(stem) === 'index')) return true;
  if (style !== 'lowercase-hyphen' || parts.length === 0) return false;
  const a = segment(stem);
  return a !== '' && a === segment(parts.at(-1));
}

/**
 * The address of any vault file, as the renderer's addressOf: no leading or
 * trailing "/", "" for the home page; a folder note has its folder's address;
 * other files keep their extension. Never depends on other files. Null when
 * the path is unsafe or has no address.
 */
export function addressOf(vaultPath, style = DEFAULT_ADDRESS_STYLE) {
  const slug = fileSlug(vaultPath, style);
  if (slug === null) return null;
  if (slug === 'index') return '';
  return slug.endsWith('/index') ? slug.slice(0, -'/index'.length) : slug;
}

/**
 * The slug the renderer draws one file under, given every file of the build
 * (the Cyberchief renderer's renderSlugs, site/plugins/FolderNotes.ts): as
 * fileSlug, except that in lowercase-hyphen a same-name folder note of a
 * top-level folder, or whose folder holds another note at any depth, is
 * drawn as that folder's page, "<folder>/index". The built file is
 * "<slug>.html". The address is the same either way.
 */
export function renderSlugs(files, style = DEFAULT_ADDRESS_STYLE) {
  const list = [...files];
  const noteSlugs = list.filter((f) => /\.md$/iu.test(f)).map((f) => fileSlug(f, style)).filter((s) => s !== null);
  const out = new Map();
  for (const file of list) {
    let slug = fileSlug(file, style);
    if (slug === null) continue;
    if (style === 'lowercase-hyphen' && /\.md$/iu.test(file) && isFolderNotePath(file, style) && !slug.endsWith('index')) {
      const topLevel = !slug.includes('/');
      const inside = noteSlugs.some((other) => other.startsWith(`${slug}/`));
      if (topLevel || inside) slug = `${slug}/index`;
    }
    out.set(file, slug);
  }
  return out;
}

/** One file's render slug among these files (renderSlugs), or null. */
export function renderSlug(vaultPath, files, style = DEFAULT_ADDRESS_STYLE) {
  const all = [...files];
  if (!all.includes(vaultPath)) all.push(vaultPath);
  return renderSlugs(all, style).get(vaultPath) ?? null;
}

/**
 * Files that would share one address (addressOf): [{ address, files }],
 * sorted by address, files sorted. The renderer refuses to build these, and
 * a bundle that would add one is refused (create-address-collision).
 */
export function addressCollisions(files, style = DEFAULT_ADDRESS_STYLE) {
  const byAddress = new Map();
  for (const file of files) {
    const address = addressOf(file, style);
    if (address === null) continue;
    byAddress.set(address, [...(byAddress.get(address) ?? []), file]);
  }
  return [...byAddress.entries()].filter(([, group]) => group.length > 1)
    .map(([address, group]) => ({ address, files: [...group].sort() }))
    .sort((a, b) => a.address.localeCompare(b.address));
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
 * The address for a page, as shown to people: `/topic/note`, `/` for the home
 * page; a folder note is `/topic/` in quartz and `/topic` in
 * lowercase-hyphen (its addressOf with one leading "/"). slug: the page's own
 * `slug:` property, which moves it (the same rule applies to it).
 */
export function addressFor(vaultPath, slug = null, style = DEFAULT_ADDRESS_STYLE) {
  const own = typeof slug === 'string' ? slugTargetPath(slug) : null;
  const slugged = pageSlug(own ?? vaultPath, style);
  if (slugged === null) return null;
  if (slugged === 'index') return '/';
  if (style === 'lowercase-hyphen') return `/${slugged.endsWith('/index') ? slugged.slice(0, -'/index'.length) : slugged}`;
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

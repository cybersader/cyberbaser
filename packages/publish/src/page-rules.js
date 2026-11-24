// The per-page publication rules, pure and environment-neutral: the selector
// (select.js) uses them for a whole vault, and the owner's writing device uses
// them for one note against its own copy of publish.yml, so it can work out on
// its own whether a new page goes public and at which address.
//
// Precedence for one Markdown file (rule numbers as in select.js):
//   1.  `cb-publish: false` (or legacy `publish: false`)  -> never published.
//   1b. a marker named in `exclude_when` is true            -> not published.
//       Default `exclude_when: [draft, sample]`. Beats allow globs and
//       `cb-publish: true`: a draft never leaves the vault.
//   2.  `cb-publish: true`  -> published; outside the allowlist it needs `slug:`.
//   3.  path matches an allow glob -> published.
//   4.  otherwise -> not published.
import yaml from 'js-yaml';
import { findFrontmatterInText } from '../../correction/src/frontmatter.js';
import { sluggify } from './paths.js';

export const CONFIG_FILENAME = 'publish.yml';
export const DEFAULT_EXCLUDE_WHEN = Object.freeze(['draft', 'sample']);

export const RULES = Object.freeze({
  DENY_FLAG: 'rule-1-publish-false',
  EXCLUDED_MARKER: 'rule-1b-excluded-marker',
  PUBLISH_FLAG: 'rule-2-publish-true',
  MISSING_SLUG: 'rule-2-missing-slug',
  ALLOWLIST: 'rule-3-allowlist',
  DEFAULT_DENY: 'rule-4-default-deny',
  ASSET_REACHABLE: 'rule-5-asset-reachable',
  ASSET_UNREACHABLE: 'rule-5-asset-unreachable',
  FRONTMATTER_ERROR: 'frontmatter-unparseable',
});

const normalize = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const dirOf = (p) => { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); };

/**
 * A folder allowlist, not a general glob engine. `cyber` and `cyber/**` both
 * mean "everything under cyber/"; `*` stops at a separator, `**` crosses one.
 */
export function globToRegExp(glob) {
  const g = normalize(glob).replace(/\/+$/, '');
  if (!/[*?]/.test(g)) return new RegExp(`^${escapeRe(g)}(?:/.*)?$`);
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        const prevSlash = i === 0 || g[i - 1] === '/';
        const nextSlash = g[i + 2] === '/';
        if (prevSlash && nextSlash) { re += '(?:.*/)?'; i += 2; }
        else { re += '.*'; i += 1; }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += escapeRe(c);
  }
  return new RegExp(`^${re}$`);
}

function describe(v) {
  if (v === null) return 'null';
  if (v === undefined) return 'an empty document';
  if (Array.isArray(v)) return 'a list';
  return typeof v;
}

/**
 * Resolve parsed `publish.yml` for one audience. v1 only ever passes `public`;
 * the `audiences:` map is parsed now so v2 can emit one artifact per audience
 * without changing the call site.
 */
export function resolveConfig(config, audience = 'public') {
  if (config === null || config === undefined || typeof config !== 'object' || Array.isArray(config)) {
    return {
      ok: false,
      error: {
        code: 'config-empty',
        message: `${CONFIG_FILENAME} must be a YAML mapping with an \`allow:\` list; got ${describe(config)}. Failing closed: nothing publishes.`,
      },
    };
  }
  const allow = [];
  const invalid = (message) => ({ ok: false, error: { code: 'config-invalid', message } });

  const collect = (value, where) => {
    if (value === undefined) return null;
    if (!Array.isArray(value)) return invalid(`\`${where}\` must be a list of path globs.`);
    for (const g of value) {
      if (typeof g !== 'string' || g.trim() === '') return invalid(`\`${where}\` entries must be non-empty strings.`);
      allow.push(g.trim());
    }
    return null;
  };

  const topErr = collect(config.allow, 'allow');
  if (topErr) return topErr;

  if (config.audiences !== undefined) {
    const map = config.audiences;
    if (map === null || typeof map !== 'object' || Array.isArray(map)) return invalid('`audiences` must be a mapping of audience name to allow list.');
    const entry = map[audience];
    if (entry !== undefined) {
      const list = Array.isArray(entry) ? entry : entry && typeof entry === 'object' ? entry.allow : undefined;
      if (list === undefined && !Array.isArray(entry)) return invalid(`\`audiences.${audience}\` must be a list or a mapping with an \`allow:\` list.`);
      const audErr = collect(list, `audiences.${audience}.allow`);
      if (audErr) return audErr;
    }
  }

  let excludeWhen = [...DEFAULT_EXCLUDE_WHEN];
  if (config.exclude_when !== undefined) {
    const value = config.exclude_when;
    if (!Array.isArray(value) || value.some((key) => typeof key !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(key))) {
      return invalid('`exclude_when` must be a list of property names, for example `[draft, sample]`.');
    }
    excludeWhen = [...new Set(value)];
  }

  return { ok: true, allow, patterns: allow.map(globToRegExp), excludeWhen };
}

/** Parse publish.yml text and resolve it; the same fail-closed result shape. */
export function resolveConfigText(text, audience = 'public') {
  if (typeof text !== 'string') return { ok: false, error: { code: 'config-missing', message: `${CONFIG_FILENAME} is missing. Failing closed: nothing publishes.` } };
  let config;
  try { config = yaml.load(text); } catch (e) {
    return { ok: false, error: { code: 'config-unparseable', message: `${CONFIG_FILENAME} is not valid YAML (${e.message}). Failing closed: nothing publishes.` } };
  }
  return resolveConfig(config, audience);
}

export function parseFrontmatter(content, { requireMapping = false } = {}) {
  if (typeof content !== 'string') return { data: {} };
  const frontmatter = findFrontmatterInText(content);
  if (frontmatter.kind !== 'block') return { data: {} };
  try {
    const data = yaml.load(frontmatter.yamlText);
    if (requireMapping && (!data || Object.getPrototypeOf(data) !== Object.prototype)) {
      return { data: {}, error: 'frontmatter is not a mapping' };
    }
    if (data === null || data === undefined) return { data: {} };
    if (typeof data !== 'object' || Array.isArray(data)) return { data: {}, error: 'frontmatter is not a mapping' };
    return { data };
  } catch (e) {
    return { data: {}, error: e.message };
  }
}

/** Only real booleans, plus the string forms an Obsidian property editor can write. */
export function readPublishFlag(value) {
  if (value === undefined) return { flag: null };
  if (value === true || value === false) return { flag: value };
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'true' || v === 'yes') return { flag: true };
    if (v === 'false' || v === 'no') return { flag: false };
  }
  return { flag: null, invalid: true };
}

/**
 * Rules 1 to 4 for one Markdown file, given resolveConfig(...).
 * Returns { published, rule, reason, slug, error? } where error is
 * { code, message } for a fail-closed denial the selector reports.
 */
export function classifyPage(path, text, resolved) {
  const p = normalize(path);
  if (!resolved?.ok) return { published: false, rule: RULES.DEFAULT_DENY, reason: 'publish.yml is missing or invalid', slug: null };
  const fm = parseFrontmatter(typeof text === 'string' ? text : '');
  if (fm.error) {
    return { published: false, rule: RULES.FRONTMATTER_ERROR, reason: 'frontmatter could not be parsed', slug: null,
      error: { code: RULES.FRONTMATTER_ERROR, message: `unreadable frontmatter (${fm.error}); failing closed` } };
  }
  // Key namespacing (2026-07-25, R15): grants are read only from the
  // cyberbaser-owned `cb-publish:`; denies are read from either key.
  const grantRead = readPublishFlag(fm.data['cb-publish']);
  if (grantRead.invalid) {
    return { published: false, rule: RULES.DEFAULT_DENY, reason: 'invalid `cb-publish:` value', slug: null,
      error: { code: 'invalid-publish-value', message: `\`cb-publish:\` must be true or false, got ${JSON.stringify(fm.data['cb-publish'])}; failing closed` } };
  }
  const legacyDeny = readPublishFlag(fm.data.publish).flag === false;
  const flag = grantRead.flag === false || legacyDeny ? false : grantRead.flag;
  if (flag === false) return { published: false, rule: RULES.DENY_FLAG, reason: '`cb-publish: false` (or legacy `publish: false`) beats every grant', slug: null };

  // A marker that is set, or set to anything other than a clear "no", keeps
  // the page out: an unreadable draft flag fails closed.
  const marker = (resolved.excludeWhen ?? DEFAULT_EXCLUDE_WHEN).find((key) => {
    if (!Object.hasOwn(fm.data, key)) return false;
    const read = readPublishFlag(fm.data[key]);
    return read.flag !== false && fm.data[key] !== null;
  });
  if (marker !== undefined) return { published: false, rule: RULES.EXCLUDED_MARKER, reason: `\`${marker}:\` keeps this page out of the site`, slug: null, marker };

  const inAllow = resolved.patterns.some((r) => r.test(p));
  const slug = typeof fm.data.slug === 'string' && fm.data.slug.trim() !== '' ? fm.data.slug.trim() : null;
  if (flag === true) {
    if (!inAllow && !slug) {
      return { published: false, rule: RULES.MISSING_SLUG, reason: 'published out of a non-allowlisted folder without a slug', slug: null,
        error: { code: RULES.MISSING_SLUG, message: `\`cb-publish: true\` outside the allowlist requires an explicit \`slug:\`; the generated URL would name the folder "${dirOf(p) || '/'}"` } };
    }
    return { published: true, rule: RULES.PUBLISH_FLAG, slug };
  }
  if (inAllow) return { published: true, rule: RULES.ALLOWLIST, slug };
  return { published: false, rule: RULES.DEFAULT_DENY, reason: 'no allowlist match and no `publish: true`', slug: null };
}

/** The page path an explicit `slug:` addresses (`slug: index` is the home page); null when unsafe. */
export function slugPage(slug) {
  if (typeof slug !== 'string') return null;
  const s = slug.trim().replace(/^\/+|\/+$/g, '').replace(/\.(md|html)$/i, '');
  if (s === '' || s.includes('\\') || /[\u0000-\u001F\u007F]/.test(s)) return null;
  const parts = s.split('/');
  if (parts.some((x) => x === '' || x === '.' || x === '..' || x.trim() !== x)) return null;
  return `${s}.md`;
}

/**
 * The public address a reader types for a published page: `/topic/sub/note`,
 * `/topic/sub/` for a folder note, `/` for the home page. Same slug rules as
 * the renderer (Quartz sluggify, case kept).
 */
export function publicAddress(path, slug = null) {
  const page = (slug === null ? null : slugPage(slug)) ?? normalize(path);
  const slugged = sluggify(page, false);
  if (slugged === 'index') return '/';
  return `/${slugged.endsWith('/index') ? slugged.slice(0, -'index'.length) : slugged}`;
}

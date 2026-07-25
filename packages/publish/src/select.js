// The publish-boundary selector: default-deny, deny-wins, audience-parameterized.
//
// It answers one question per file: does this path leave the vault? It returns
// paths and a report. It never reads a decision out of file contents beyond
// frontmatter, never rewrites bytes, and never writes anything to disk. Byte
// identity between a published file and its vault source is a hard invariant
// (R12), and the cheapest way to hold it is to never be in the content path.
//
// Precedence, evaluated per markdown file:
//   1. `publish: false`            -> never published. Beats everything.
//   2. `publish: true`             -> published. Outside the allowlist an
//                                     explicit `slug:` is required, else ERROR
//                                     (the URL would name the private folder).
//   3. path matches an allow glob  -> published.
//   4. otherwise                   -> not published.
//   5. non-markdown assets         -> published only if a published page
//                                     references them. Never by path.

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { extractRefs } from './links.js';

export const CONFIG_FILENAME = 'publish.yml';
export const MARKDOWN_EXTENSIONS = new Set(['.md']);
export const DEFAULT_IGNORED_DIRS = new Set(['.git', '.obsidian', '.trash', 'node_modules']);

export const RULES = {
  DENY_FLAG: 'rule-1-publish-false',
  PUBLISH_FLAG: 'rule-2-publish-true',
  MISSING_SLUG: 'rule-2-missing-slug',
  ALLOWLIST: 'rule-3-allowlist',
  DEFAULT_DENY: 'rule-4-default-deny',
  ASSET_REACHABLE: 'rule-5-asset-reachable',
  ASSET_UNREACHABLE: 'rule-5-asset-unreachable',
  FRONTMATTER_ERROR: 'frontmatter-unparseable',
};

// ---------------------------------------------------------------- paths, globs

const normalize = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
const extOf = (p) => {
  const base = p.slice(p.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot).toLowerCase();
};
export const isMarkdown = (p) => MARKDOWN_EXTENSIONS.has(extOf(p));
const dirOf = (p) => { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); };
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function joinRel(base, rel) {
  const parts = [];
  for (const seg of `${base ? `${base}/` : ''}${rel}`.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

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

const matchesAny = (p, regexes) => regexes.some((r) => r.test(p));

// --------------------------------------------------------------------- config

function describe(v) {
  if (v === null) return 'null';
  if (v === undefined) return 'an empty document';
  if (Array.isArray(v)) return 'a list';
  return typeof v;
}

/**
 * Resolve `publish.yml` for one audience. v1 only ever passes `public`; the
 * `audiences:` map is parsed now so v2 can emit one artifact per audience
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

  return { ok: true, allow, patterns: allow.map(globToRegExp) };
}

// ---------------------------------------------------------------- frontmatter

const FRONTMATTER = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export function parseFrontmatter(content) {
  const m = typeof content === 'string' ? content.match(FRONTMATTER) : null;
  if (!m) return { data: {} };
  try {
    const data = yaml.load(m[1]);
    if (data === null || data === undefined) return { data: {} };
    if (typeof data !== 'object' || Array.isArray(data)) return { data: {}, error: 'frontmatter is not a mapping' };
    return { data };
  } catch (e) {
    return { data: {}, error: e.message };
  }
}

/** Only real booleans, plus the string forms an Obsidian property editor can write. */
function readPublishFlag(value) {
  if (value === undefined) return { flag: null };
  if (value === true || value === false) return { flag: value };
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'true' || v === 'yes') return { flag: true };
    if (v === 'false' || v === 'no') return { flag: false };
  }
  return { flag: null, invalid: true };
}

// ----------------------------------------------------------------- resolution

function buildIndex(fileMap) {
  const byPath = new Set(Object.keys(fileMap));
  const byBasename = new Map();
  for (const p of byPath) {
    const base = p.slice(p.lastIndexOf('/') + 1);
    if (!byBasename.has(base)) byBasename.set(base, []);
    byBasename.get(base).push(p);
  }
  return { byPath, byBasename };
}

const EXTERNAL = /^(?:[a-z][a-z0-9+.\-]*:|\/\/)/i;

/** Markdown link/image href -> vault path, or null for external, in-page or dangling. */
function resolveHref(href, fromPath, index) {
  if (!href) return null;
  let h = href.trim();
  if (h === '' || h.startsWith('#') || EXTERNAL.test(h)) return null;
  h = h.split('#')[0].split('?')[0];
  if (h === '') return null;
  try { h = decodeURIComponent(h); } catch { /* keep the raw form */ }
  const rootRelative = href.trim().startsWith('/');
  const candidates = rootRelative
    ? [normalize(h)]
    : [joinRel(dirOf(fromPath), h), normalize(h)];
  for (const c of candidates) if (index.byPath.has(c)) return c;
  return null;
}

/** Obsidian wikilink target -> vault path: exact path, then relative, then unique basename. */
function resolveWiki(target, fromPath, index) {
  const t = normalize(String(target ?? '').trim());
  if (t === '') return null;
  const withMd = isMarkdown(t) ? null : `${t}.md`;
  const direct = [t, withMd, joinRel(dirOf(fromPath), t), withMd ? joinRel(dirOf(fromPath), withMd) : null];
  for (const c of direct) if (c && index.byPath.has(c)) return c;

  const base = t.slice(t.lastIndexOf('/') + 1);
  for (const name of [base, withMd ? `${base}.md` : null]) {
    if (!name) continue;
    const hits = (index.byBasename.get(name) ?? []).filter((p) => t.includes('/') ? p.endsWith(`/${t}`) || p === t : true);
    if (hits.length) return hits.slice().sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))[0];
  }
  return null;
}

// ------------------------------------------------------------------- selector

function emptyReport(audience) {
  return {
    audience,
    config: { allow: [] },
    counts: { pages: 0, assets: 0, denied: 0, errors: 0, strippedLinks: 0, crossBoundaryEmbeds: 0 },
    published: { pages: [], assets: [] },
    granted: {},
    slugs: {},
    assets: [],
    strippedLinks: [],
    crossBoundaryEmbeds: [],
    denied: [],
    errors: [],
  };
}

/**
 * @param {Object<string, string|null>} fileMap vault-relative path -> markdown
 *   text. Non-markdown files map to null: the selector never needs their bytes.
 * @param {object} config parsed publish.yml
 * @param {{audience?: string}} opts
 * @returns {{published: string[], errors: object[], report: object}}
 */
export function selectFiles(fileMap, config, opts = {}) {
  const audience = opts.audience ?? 'public';
  const report = emptyReport(audience);
  const errors = report.errors;

  const files = {};
  for (const [k, v] of Object.entries(fileMap ?? {})) files[normalize(k)] = v;

  const cfg = resolveConfig(config, audience);
  if (!cfg.ok) {
    errors.push(cfg.error);
    report.counts.errors = errors.length;
    return { published: [], errors, report };
  }
  report.config.allow = cfg.allow;

  const index = buildIndex(files);
  const publishedPages = new Set();
  const deny = (path, rule, reason) => report.denied.push({ path, rule, reason });

  // Rules 1-4, markdown only.
  for (const p of Object.keys(files).sort()) {
    if (!isMarkdown(p)) continue;
    const content = typeof files[p] === 'string' ? files[p] : '';
    const fm = parseFrontmatter(content);
    if (fm.error) {
      errors.push({ code: RULES.FRONTMATTER_ERROR, path: p, message: `unreadable frontmatter (${fm.error}); failing closed` });
      deny(p, RULES.FRONTMATTER_ERROR, 'frontmatter could not be parsed');
      continue;
    }
    // Key namespacing (2026-07-25, R15): the real vault has 587 files carrying
    // stale `publish: true` from an earlier publishing era — including daily
    // notes and journals — so the bare key cannot be trusted as ALLOW intent.
    // Grants are read only from the cyberbaser-owned `cb-publish:`; denies are
    // read from either key, because noise in the deny direction is harmless.
    const grantRead = readPublishFlag(fm.data['cb-publish']);
    if (grantRead.invalid) {
      errors.push({ code: 'invalid-publish-value', path: p, message: `\`cb-publish:\` must be true or false, got ${JSON.stringify(fm.data['cb-publish'])}; failing closed` });
      deny(p, RULES.DEFAULT_DENY, 'invalid `cb-publish:` value');
      continue;
    }
    const legacyDeny = readPublishFlag(fm.data.publish).flag === false;
    const flag = grantRead.flag === false || legacyDeny ? false : grantRead.flag;

    if (flag === false) { deny(p, RULES.DENY_FLAG, '`cb-publish: false` (or legacy `publish: false`) beats every grant'); continue; }

    const inAllow = matchesAny(p, cfg.patterns);
    const slug = typeof fm.data.slug === 'string' && fm.data.slug.trim() !== '' ? fm.data.slug.trim() : null;

    if (flag === true) {
      if (!inAllow && !slug) {
        errors.push({
          code: RULES.MISSING_SLUG,
          path: p,
          message: `\`cb-publish: true\` outside the allowlist requires an explicit \`slug:\`; the generated URL would name the folder "${dirOf(p) || '/'}"`,
        });
        deny(p, RULES.MISSING_SLUG, 'published out of a non-allowlisted folder without a slug');
        continue;
      }
      publishedPages.add(p);
      report.granted[p] = RULES.PUBLISH_FLAG;
      if (slug) report.slugs[p] = slug;
      continue;
    }

    if (inAllow) {
      publishedPages.add(p);
      report.granted[p] = RULES.ALLOWLIST;
      if (slug) report.slugs[p] = slug;
      continue;
    }
    deny(p, RULES.DEFAULT_DENY, 'no allowlist match and no `publish: true`');
  }

  // Rule 5 plus the boundary report. Reachability is computed from published
  // pages only, so an asset a private page references stays private, and a
  // shared asset one published page references is emitted.
  const assetRefs = new Map();
  const noteRef = (target, ref, source) => {
    if (!assetRefs.has(target)) assetRefs.set(target, []);
    assetRefs.get(target).push({ source, line: ref.line, kind: ref.kind, raw: ref.raw });
  };

  for (const p of [...publishedPages].sort()) {
    const content = typeof files[p] === 'string' ? files[p] : '';
    const refs = extractRefs(content);

    for (const ref of refs.embeds) {
      const target = resolveWiki(ref.target, p, index);
      if (!target) continue;
      if (isMarkdown(target)) {
        if (!publishedPages.has(target)) {
          report.crossBoundaryEmbeds.push({ source: p, target, line: ref.line, raw: ref.raw });
          errors.push({
            code: 'cross-boundary-embed',
            path: p,
            message: `embed of unpublished "${target}" at line ${ref.line} would inline private content into public output`,
          });
        }
        continue;
      }
      noteRef(target, ref, p);
    }

    for (const ref of [...refs.mdImages, ...refs.mdLinks]) {
      const target = resolveHref(ref.target, p, index);
      if (!target) continue;
      if (isMarkdown(target)) {
        if (!publishedPages.has(target)) report.strippedLinks.push({ source: p, target, line: ref.line, raw: ref.raw, kind: ref.kind, targetKind: 'page' });
        continue;
      }
      noteRef(target, ref, p);
    }

    for (const ref of refs.wikilinks) {
      const target = resolveWiki(ref.target, p, index);
      if (!target || publishedPages.has(target)) continue;
      report.strippedLinks.push({
        source: p,
        target,
        line: ref.line,
        raw: ref.raw,
        kind: ref.kind,
        alias: ref.alias,
        targetKind: isMarkdown(target) ? 'page' : 'asset',
      });
    }
  }

  const publishedAssets = new Set();
  for (const p of Object.keys(files).sort()) {
    if (isMarkdown(p)) continue;
    const refs = assetRefs.get(p);
    if (refs && refs.length) {
      publishedAssets.add(p);
      report.granted[p] = RULES.ASSET_REACHABLE;
      report.assets.push({ path: p, rule: RULES.ASSET_REACHABLE, referencedBy: refs });
    } else {
      deny(p, RULES.ASSET_UNREACHABLE, 'no published page references this asset');
    }
  }

  report.published.pages = [...publishedPages].sort();
  report.published.assets = [...publishedAssets].sort();
  report.strippedLinks.sort((a, b) => a.source.localeCompare(b.source) || a.line - b.line);
  report.denied.sort((a, b) => a.path.localeCompare(b.path));
  report.counts = {
    pages: report.published.pages.length,
    assets: report.published.assets.length,
    denied: report.denied.length,
    errors: errors.length,
    strippedLinks: report.strippedLinks.length,
    crossBoundaryEmbeds: report.crossBoundaryEmbeds.length,
  };

  const published = [...report.published.pages, ...report.published.assets].sort();
  return { published, errors, report };
}

// --------------------------------------------------------------- vault reader

function walk(root, ignoreDirs) {
  const out = {};
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    let entries;
    try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); }
    catch { continue; }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!ignoreDirs.has(e.name)) stack.push(r); }
      else if (e.isFile()) out[r] = isMarkdown(r) ? fs.readFileSync(path.join(root, r), 'utf8') : null;
    }
  }
  return out;
}

/**
 * Select the published set for a vault on disk. Read-only: no file is written,
 * moved or rewritten, and `published` is a list of vault-relative source paths.
 *
 * A missing, unreadable or unparseable publish.yml fails closed: nothing
 * publishes and the reason is in `errors`.
 *
 * @param {string} vaultDir
 * @param {{audience?: string, ignoreDirs?: Iterable<string>}} opts
 */
export function select(vaultDir, opts = {}) {
  const audience = opts.audience ?? 'public';
  const ignoreDirs = new Set(opts.ignoreDirs ?? DEFAULT_IGNORED_DIRS);
  const configPath = path.join(vaultDir, CONFIG_FILENAME);

  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (e) {
    const report = emptyReport(audience);
    report.errors.push({
      code: e.code === 'ENOENT' ? 'config-missing' : 'config-unreadable',
      path: CONFIG_FILENAME,
      message: `${configPath} could not be read (${e.code ?? e.message}). Failing closed: nothing publishes.`,
    });
    report.counts.errors = 1;
    return { published: [], errors: report.errors, report };
  }

  let config;
  try {
    config = yaml.load(raw);
  } catch (e) {
    const report = emptyReport(audience);
    report.errors.push({ code: 'config-unparseable', path: CONFIG_FILENAME, message: `${CONFIG_FILENAME} is not valid YAML (${e.message}). Failing closed: nothing publishes.` });
    report.counts.errors = 1;
    return { published: [], errors: report.errors, report };
  }

  const files = walk(vaultDir, ignoreDirs);
  delete files[CONFIG_FILENAME];
  return selectFiles(files, config, { audience });
}

export default select;

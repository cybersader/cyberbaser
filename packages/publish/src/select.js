// The publish-boundary selector: default-deny, deny-wins, audience-parameterized.
//
// It answers one question per file: does this path leave the vault? It returns
// paths and a report. It never reads a decision out of file contents beyond
// frontmatter, never rewrites bytes, and never writes anything to disk. Byte
// identity between a published file and its vault source is a hard invariant
// (R12), and the cheapest way to hold it is to never be in the content path.
//
// Precedence, evaluated per markdown file (page-rules.js holds rules 1-4):
//   1. `publish: false`            -> never published. Beats everything.
//   1b. `exclude_when` marker set  -> not published (default: draft, sample).
//                                     Beats allow globs and `publish: true`.
//   2. `publish: true`             -> published. Outside the allowlist an
//                                     explicit `slug:` is required, else ERROR
//                                     (the URL would name the private folder).
//   3. path matches an allow glob  -> published.
//   4. otherwise                   -> not published.
//   5. non-markdown assets         -> published only if a published page
//                                     references them (body links and embeds,
//                                     or a property naming the image from the
//                                     vault root or the note's own folder:
//                                     property-refs.js). Never by path.

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { extractRefs } from './links.js';
import { propertyImageRefs, resolvePropertyImage } from './property-refs.js';
import { CONFIG_FILENAME, RULES, classifyPage, globToRegExp, parseFrontmatter, resolveConfig } from './page-rules.js';

export { CONFIG_FILENAME, RULES, globToRegExp, parseFrontmatter, resolveConfig };
export const MARKDOWN_EXTENSIONS = new Set(['.md']);
export const DEFAULT_IGNORED_DIRS = new Set(['.git', '.obsidian', '.trash', 'node_modules']);

// ---------------------------------------------------------------- paths, globs

const normalize = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
const extOf = (p) => {
  const base = p.slice(p.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot).toLowerCase();
};
export const isMarkdown = (p) => MARKDOWN_EXTENSIONS.has(extOf(p));
const dirOf = (p) => { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); };

function joinRel(base, rel) {
  const parts = [];
  for (const seg of `${base ? `${base}/` : ''}${rel}`.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
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

/**
 * The non-Markdown files one note references, resolved against the vault's
 * paths the way the selector does: body embeds, markdown images and links,
 * HTML src, and images named by a property. For callers that check one
 * change rather than select a whole vault (the publisher's bundle rules).
 */
export function noteAssetTargets(notePath, content, paths) {
  const index = buildIndex(Object.fromEntries([...paths].map((p) => [normalize(p), null])));
  const from = normalize(notePath);
  const text = typeof content === 'string' ? content : '';
  const refs = extractRefs(text);
  const out = new Set();
  for (const ref of refs.embeds) { const t = resolveWiki(ref.target, from, index); if (t && !isMarkdown(t)) out.add(t); }
  for (const ref of [...refs.mdImages, ...refs.mdLinks, ...refs.htmlSrcs]) { const t = resolveHref(ref.target, from, index); if (t && !isMarkdown(t)) out.add(t); }
  for (const ref of propertyImageRefs(text, from)) {
    const t = resolvePropertyImage(ref, (p) => index.byPath.has(p) && !isMarkdown(p));
    if (t) out.add(t);
  }
  return [...out].sort();
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
    const verdict = classifyPage(p, content, cfg);
    if (verdict.error) errors.push({ code: verdict.error.code, path: p, message: verdict.error.message });
    if (!verdict.published) { deny(p, verdict.rule, verdict.reason); continue; }
    publishedPages.add(p);
    report.granted[p] = verdict.rule;
    if (verdict.slug) report.slugs[p] = verdict.slug;
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

    for (const ref of [...refs.mdImages, ...refs.mdLinks, ...refs.htmlSrcs]) {
      const target = resolveHref(ref.target, p, index);
      if (!target) continue;
      if (isMarkdown(target)) {
        if (!publishedPages.has(target)) report.strippedLinks.push({ source: p, target, line: ref.line, raw: ref.raw, kind: ref.kind, targetKind: 'page' });
        continue;
      }
      noteRef(target, ref, p);
    }

    // Images named by a property (`cover: posts/x.png`): from the vault root,
    // then from the note's own folder (property-refs.js). Never by file name.
    for (const ref of propertyImageRefs(content, p)) {
      const target = resolvePropertyImage(ref, (c) => index.byPath.has(c) && !isMarkdown(c));
      if (target) noteRef(target, ref, p);
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

/**
 * Select from an in-memory tree, for callers that read a Git commit rather
 * than a directory. `publishYml` is the raw publish.yml text, or null when the
 * commit has none. Same fail-closed rules as select().
 *
 * @param {Object<string, string|null>} fileMap
 * @param {string|null} publishYml
 * @param {{audience?: string}} opts
 */
export function selectTree(fileMap, publishYml, opts = {}) {
  const audience = opts.audience ?? 'public';
  const closed = (code, message) => {
    const report = emptyReport(audience);
    report.errors.push({ code, path: CONFIG_FILENAME, message });
    report.counts.errors = 1;
    return { published: [], errors: report.errors, report };
  };
  if (typeof publishYml !== 'string') return closed('config-missing', `${CONFIG_FILENAME} is missing. Failing closed: nothing publishes.`);
  let config;
  try { config = yaml.load(publishYml); } catch (e) {
    return closed('config-unparseable', `${CONFIG_FILENAME} is not valid YAML (${e.message}). Failing closed: nothing publishes.`);
  }
  const files = { ...fileMap };
  delete files[CONFIG_FILENAME];
  return selectFiles(files, config, { audience });
}

export default select;

/**
 * The vault projection: the build step between the publish selector and any renderer.
 *
 * Canonical design: docs/src/content/docs/research/proposal-renderer-urls.md, D2 (URL
 * contract) and D3 ("the projection step", where lowercasing lives).
 *
 * It takes files and produces files. It knows nothing about Quartz, Astro or any other
 * spoke, and it must never learn: this is the designated home for every "the renderer
 * does the wrong thing" fix, so that forking a renderer never becomes tempting.
 *
 * What it does, in order:
 *   1. Runs the selector. A config error (missing/unparseable publish.yml) fails the
 *      build. A rule error on a file that did not publish is a warning: the selector
 *      already failed those closed, and they are not in the output.
 *   2. Pre-flights frontmatter on every published page. Quartz has no per-file error
 *      isolation (R14): one unparseable YAML frontmatter aborts the entire build with a
 *      stack trace and no filename. We fail earlier, with the filenames.
 *   3. Copies published pages and assets to lowercased paths. On a case change the
 *      natural-case path goes into the projected copy's `aliases:` so both URLs resolve.
 *      That frontmatter edit is the only content transform allowed here, it happens on
 *      the projected copy only, and the body bytes stay byte-identical (R12 applies to
 *      the vault and the write path; a render input is disposable).
 *   4. Fails on case collisions (two source paths that lowercase to one output path,
 *      which is silent data loss with no error message from any renderer).
 *   5. Lints frontmatter-derived paths (tags, aliases, slug) for characters that are
 *      illegal in file paths. Warnings in v1, because renderers vary in which of these
 *      they turn into an output path.
 *   6. Verifies the boundary after the copy: nothing under the output tree may come from
 *      a path the selector denied.
 */

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { select } from '@cyberbaser/publish';
import { parseFrontmatter } from '@cyberbaser/publish/src/select.js';

// Mirrors select.js. Kept local rather than imported so the two can never disagree
// silently about what a match *span* is: the projection slices bytes on this match.
const FRONTMATTER = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

const MARKDOWN = /\.md$/i;

/** Illegal in a Windows path segment. `/` is excluded: it is legal in a nested tag. */
const PATH_HOSTILE = ['<', '>', ':', '"', '|', '?', '*', '\\'];
const CONTROL = /[\u0000-\u001F\u007F]/;

export const REPORT_FILENAME = 'projection-report.json';

// ------------------------------------------------------------------ path helpers

const normalize = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');

/**
 * The projected path: lowercased path segments, nothing else. Spaces, `&`, `%` and
 * non-Latin scripts survive untouched; the renderer's own slugifier handles them, and
 * running our own rename here would be a second naming authority. Case is different:
 * GitHub Pages serves from Linux, so `/Threat-Modeling` and `/threat-modeling` are two
 * URLs, and no candidate renderer lowercases. That is why this step exists.
 *
 * Deliberately not NFC-normalized: that would change bytes beyond case, which is a
 * rename. The path lint in @cyberbaser/publish reports NFD paths instead.
 */
export function projectedPath(vaultPath, lowercase = true) {
  const n = normalize(vaultPath);
  if (!lowercase) return n;
  return n
    .split('/')
    .map((segment) => segment.toLowerCase())
    .join('/');
}

/** The alias to inject for a page whose path changed case: the natural-case path, no extension. */
export function naturalCaseAlias(vaultPath) {
  return normalize(vaultPath).replace(MARKDOWN, '');
}

const isMarkdown = (p) => MARKDOWN.test(p);

function walkFiles(root) {
  const out = [];
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) stack.push(r);
      else if (e.isFile()) out.push(r);
    }
  }
  return out.sort();
}

// -------------------------------------------------------------------- pre-flight

/**
 * Parse the frontmatter of every published page with the same tolerance the selector
 * uses. Any page that fails is a build failure, named.
 *
 * @returns {{failures: Array<{path: string, message: string}>, frontmatter: Map<string, object>}}
 */
export function preflightFrontmatter(vaultDir, pages) {
  const failures = [];
  const frontmatter = new Map();
  for (const p of pages) {
    let text;
    try {
      text = fs.readFileSync(path.join(vaultDir, p), 'utf8');
    } catch (e) {
      failures.push({ path: p, message: `published page could not be read (${e.code ?? e.message})` });
      continue;
    }
    const fm = parseFrontmatter(text);
    if (fm.error) {
      failures.push({ path: p, message: `unparseable frontmatter (${fm.error})` });
      continue;
    }
    frontmatter.set(p, fm.data);
  }
  return { failures, frontmatter };
}

// --------------------------------------------------------------- collision guard

/**
 * Two source paths that lowercase to one projected path. One silently overwrites the
 * other and no renderer reports it, so it fails the build here.
 */
export function findCaseCollisions(sourcePaths, lowercase = true) {
  const byProjected = new Map();
  for (const p of sourcePaths) {
    const key = projectedPath(p, lowercase);
    if (!byProjected.has(key)) byProjected.set(key, []);
    byProjected.get(key).push(p);
  }
  return [...byProjected.entries()]
    .filter(([, sources]) => sources.length > 1)
    .map(([projected, sources]) => ({ projected, sources: sources.slice().sort() }))
    .sort((a, b) => a.projected.localeCompare(b.projected));
}

// ------------------------------------------------------------ derived-path lint

function hostileChars(value) {
  const s = String(value);
  const found = PATH_HOSTILE.filter((c) => s.includes(c));
  if (CONTROL.test(s)) found.push('<control>');
  return found;
}

/**
 * Frontmatter values that renderers turn into output paths: `tags` (Quartz emits a page
 * per tag), `aliases` (a redirect stub per alias) and `slug`. A URL pasted into a tags
 * array becomes an output path containing `:` and `//`, which is un-checkout-able on
 * Windows (R14 spike finding). Warnings in v1, not failures: which of these becomes a
 * path is renderer-specific, and this step must not encode one renderer's rules.
 */
export function lintDerivedPaths(frontmatter) {
  const warnings = [];
  for (const [p, data] of frontmatter) {
    if (!data || typeof data !== 'object') continue;
    for (const key of ['tags', 'aliases', 'alias', 'slug', 'permalink']) {
      const raw = data[key];
      if (raw === undefined || raw === null) continue;
      const values = Array.isArray(raw) ? raw : [raw];
      for (const v of values) {
        if (typeof v !== 'string' && typeof v !== 'number') continue;
        const chars = hostileChars(v);
        if (chars.length === 0) continue;
        warnings.push({
          kind: 'derived-path',
          path: p,
          key,
          value: String(v),
          chars,
          message: `\`${key}:\` value ${JSON.stringify(String(v))} contains ${chars.join(' ')}, illegal in a file path if the renderer derives one from it`,
        });
      }
    }
  }
  return warnings;
}

// ------------------------------------------------------------- alias injection

function toStringList(value) {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.filter((v) => typeof v === 'string' || typeof v === 'number').map((v) => String(v));
}

/** `aliases:` and its block, from the frontmatter's raw lines. Returns [start, end). */
function aliasesRegion(lines) {
  const start = lines.findIndex((l) => /^aliases[ \t]*:/.test(l));
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length) {
    const l = lines[end];
    if (l.trim() === '' || /^[ \t]/.test(l) || /^-([ \t]|$)/.test(l)) end += 1;
    else break;
  }
  return [start, end];
}

/**
 * Add `alias` to the projected copy's `aliases:` list. Frontmatter only: the bytes after
 * the frontmatter block are carried over untouched, so the body is byte-identical to the
 * vault source. Existing aliases are preserved (re-emitted as a block list).
 *
 * @param {Buffer} buf source file bytes
 * @param {string} alias
 * @returns {{buffer: Buffer, injected: boolean, existing: string[], reason?: string}}
 */
export function injectAlias(buf, alias) {
  const text = buf.toString('utf8');
  const m = text.match(FRONTMATTER);

  if (!m) {
    const block = yaml.dump({ aliases: [alias] }, { lineWidth: -1 });
    return {
      buffer: Buffer.concat([Buffer.from(`---\n${block}---\n`, 'utf8'), buf]),
      injected: true,
      existing: [],
      created: true,
    };
  }

  // The regex is anchored, so the matched text is the file's byte prefix -- unless the
  // file is not valid UTF-8, in which case decoding lost bytes and slicing would corrupt
  // the body. Check rather than assume; a lost alias is recoverable, a corrupt body is not.
  const prefix = Buffer.from(m[0], 'utf8');
  if (!buf.subarray(0, prefix.length).equals(prefix)) {
    return { buffer: buf, injected: false, existing: [], reason: 'file is not valid UTF-8; frontmatter left untouched' };
  }

  const parsed = parseFrontmatter(text);
  if (parsed.error) return { buffer: buf, injected: false, existing: [], reason: `unparseable frontmatter (${parsed.error})` };

  const existing = toStringList(parsed.data.aliases);
  if (existing.includes(alias)) return { buffer: buf, injected: false, existing, reason: 'alias already present' };

  const block = yaml.dump({ aliases: [...existing, alias] }, { lineWidth: -1 });
  const lines = m[1].split('\n').map((l) => l.replace(/\r$/, ''));
  const region = 'aliases' in (parsed.data ?? {}) ? aliasesRegion(lines) : null;
  const kept = region ? [...lines.slice(0, region[0]), ...lines.slice(region[1])] : lines;
  const head = kept.join('\n').replace(/[ \t\n]+$/, '');
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  const rewritten = `${bom}---\n${head ? `${head}\n` : ''}${block}---\n`;

  return {
    buffer: Buffer.concat([Buffer.from(rewritten, 'utf8'), buf.subarray(prefix.length)]),
    injected: true,
    existing,
  };
}

// ------------------------------------------------------------------- leak test

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sample(list, n, seed = 0x1f2e3d4c) {
  if (list.length <= n) return [...list];
  const rand = mulberry32(seed);
  const picked = new Set();
  while (picked.size < n) picked.add(Math.floor(rand() * list.length));
  return [...picked].sort((a, b) => a - b).map((i) => list[i]);
}

function titleOf(vaultDir, p) {
  try {
    const fm = parseFrontmatter(fs.readFileSync(path.join(vaultDir, p), 'utf8'));
    const t = fm.data?.title;
    if (typeof t === 'string' && t.trim() !== '') return t.trim();
  } catch { /* fall through to the filename */ }
  const base = p.slice(p.lastIndexOf('/') + 1);
  return base.replace(MARKDOWN, '');
}

/**
 * The boundary check, run after the copy rather than trusted from the plan.
 *
 * Path leaks fail the build: every file under the output tree must be the projection of
 * a published source path.
 *
 * Title matches do NOT fail the build, and that is deliberate. Bodies are copied byte for
 * byte, so a published page that links to a private note still contains that note's title
 * in its text (the selector counts those as stripped links). Failing on a substring match
 * would fail every real vault. They are reported so a human can look.
 *
 * @param {object} selectResult the `{published, errors, report}` the copy was driven from
 */
export function verifyProjection(vaultDir, outDir, selectResult, opts = {}) {
  const sampleSize = opts.sampleSize ?? 20;
  const lowercase = opts.lowercase ?? false;
  const pages = selectResult.report.published.pages;
  const assets = selectResult.report.published.assets;
  const expected = new Set([...pages, ...assets].map((p) => projectedPath(p, lowercase)));
  const actual = new Set(walkFiles(outDir));

  const unexpected = [...actual].filter((p) => !expected.has(p)).sort();
  const missing = [...expected].filter((p) => !actual.has(p)).sort();

  const denied = (selectResult.report.denied ?? []).map((d) => d.path);
  const deniedPresent = denied
    .filter((p) => actual.has(projectedPath(p, lowercase)) && !expected.has(projectedPath(p, lowercase)))
    .map((p) => ({ source: p, projected: projectedPath(p, lowercase) }));

  const deniedMarkdown = denied.filter(isMarkdown).sort();
  const sampled = sample(deniedMarkdown, sampleSize).map((p) => ({ path: p, title: titleOf(vaultDir, p) }));

  const projectedText = [...actual].filter(isMarkdown);
  const titleMatches = [];
  if (sampled.length) {
    for (const rel of projectedText) {
      let text;
      try {
        text = fs.readFileSync(path.join(outDir, rel), 'utf8');
      } catch {
        continue;
      }
      for (const s of sampled) {
        if (s.title && text.includes(s.title)) titleMatches.push({ deniedPath: s.path, title: s.title, foundIn: rel });
      }
    }
  }

  const ok = unexpected.length === 0 && missing.length === 0 && deniedPresent.length === 0;
  return {
    ok,
    checked: { expected: expected.size, actual: actual.size, deniedPaths: denied.length, sampledTitles: sampled.length },
    unexpected,
    missing,
    deniedPresent,
    sampledTitles: sampled,
    titleMatches,
    titleMatchCount: titleMatches.length,
    note: 'titleMatches are reported, not failed on: bodies are copied byte-identical, so a stripped link to a private note still carries its title.',
  };
}

// -------------------------------------------------------------------- projection

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function assertSafeOutDir(vaultDir, outDir) {
  const v = path.resolve(vaultDir);
  const o = path.resolve(outDir);
  if (o === path.parse(o).root) throw new Error(`refusing to use the filesystem root as outDir (${o})`);
  if (o === v) throw new Error('outDir must not be the vault itself');
  if (v.startsWith(`${o}${path.sep}`)) throw new Error(`outDir ${o} contains the vault ${v}; refusing to clean it`);
}

/**
 * Project a vault into a renderer-agnostic content tree.
 *
 * @param {string} vaultDir
 * @param {string} outDir            the content tree to write (cleaned first by default)
 * @param {object} opts
 * @param {string} [opts.audience='public']
 * @param {object} [opts.selectResult] pre-computed selector output (tests, and reuse)
 * @param {boolean} [opts.clean=true]
 * @param {boolean} [opts.verify=true]
 * @param {string}  [opts.reportPath]  defaults to `<parent of outDir>/projection-report.json`
 * @param {boolean} [opts.writeReport=true]
 * @returns {{ok: boolean, failures: object[], warnings: object[], counts: object, report: object}}
 */
export function project(vaultDir, outDir, opts = {}) {
  const startedAt = Date.now();
  const audience = opts.audience ?? 'public';
  // v0 deploys verbatim paths: zero case collisions measured in the vault, the URL
  // freeze has not happened, and lowercased pages beside natural-case assets would
  // break relative references. D2's lowercase moves to projection v2 with an asset
  // alias story (R16).
  const lowercase = opts.lowercase ?? false;
  const verify = opts.verify !== false;
  const clean = opts.clean !== false;
  const writeReport = opts.writeReport !== false;
  const reportPath = opts.reportPath ?? path.join(path.dirname(path.resolve(outDir)), REPORT_FILENAME);

  const failures = [];
  const warnings = [];
  const aliases = [];
  let leakTest = null;
  let counts = { pages: 0, assets: 0, aliasesInjected: 0, aliasesSkipped: 0, caseChangedPages: 0, caseChangedAssets: 0, warnings: 0 };

  const finish = () => {
    counts.warnings = warnings.length;
    const report = {
      generatedAt: new Date().toISOString(),
      ok: failures.length === 0,
      vaultDir: path.resolve(vaultDir),
      outDir: path.resolve(outDir),
      audience,
      durationMs: Date.now() - startedAt,
      counts,
      failures,
      warnings,
      aliases,
      leakTest,
      selectCounts: selectResult?.report?.counts ?? null,
    };
    if (writeReport) {
      try {
        ensureDir(path.dirname(reportPath));
        fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
      } catch (e) {
        warnings.push({ kind: 'report', message: `could not write ${reportPath} (${e.message})` });
      }
    }
    return { ok: report.ok, failures, warnings, counts, aliases, leakTest, reportPath: writeReport ? reportPath : null, report, selectResult };
  };

  const selectResult = opts.selectResult ?? select(vaultDir, { audience });

  // 1. Config errors fail closed and fail the build. Rule errors are about files that did
  //    not publish, so they are warnings -- unless one names a file that did.
  const publishedSet = new Set(selectResult.report.published.pages.concat(selectResult.report.published.assets));
  for (const e of selectResult.errors ?? []) {
    if (String(e.code ?? '').startsWith('config-')) failures.push({ kind: 'config', ...e });
    else if (e.path && publishedSet.has(e.path)) failures.push({ kind: 'select', ...e });
    else warnings.push({ kind: 'select', ...e });
  }
  if (failures.length) return finish();

  const pages = selectResult.report.published.pages;
  const assets = selectResult.report.published.assets;
  counts.pages = pages.length;
  counts.assets = assets.length;

  // 2. Pre-flight: one bad YAML frontmatter aborts a whole Quartz build with no filename.
  const pre = preflightFrontmatter(vaultDir, pages);
  for (const f of pre.failures) failures.push({ kind: 'preflight', ...f });

  // 4. Case collisions are silent data loss; check before writing anything.
  const collisions = findCaseCollisions([...pages, ...assets], lowercase);
  for (const c of collisions) {
    failures.push({
      kind: 'case-collision',
      path: c.projected,
      sources: c.sources,
      message: `${c.sources.length} source paths project to "${c.projected}": ${c.sources.join(', ')}`,
    });
  }

  // 5. Derived-path lint (warnings only).
  warnings.push(...lintDerivedPaths(pre.frontmatter));

  if (failures.length) return finish();

  // 3. Copy.
  assertSafeOutDir(vaultDir, outDir);
  if (clean) fs.rmSync(outDir, { recursive: true, force: true });
  ensureDir(outDir);

  for (const p of pages) {
    const target = projectedPath(p, lowercase);
    const dst = path.join(outDir, target);
    ensureDir(path.dirname(dst));
    if (target === p) {
      fs.copyFileSync(path.join(vaultDir, p), dst);
      continue;
    }
    counts.caseChangedPages += 1;
    const alias = naturalCaseAlias(p);
    const result = injectAlias(fs.readFileSync(path.join(vaultDir, p)), alias);
    fs.writeFileSync(dst, result.buffer);
    if (result.injected) {
      counts.aliasesInjected += 1;
      aliases.push({ source: p, projected: target, alias, existingAliases: result.existing.length, created: Boolean(result.created) });
    } else {
      counts.aliasesSkipped += 1;
      warnings.push({ kind: 'alias-skipped', path: p, alias, message: result.reason ?? 'alias not injected' });
    }
  }

  for (const p of assets) {
    const target = projectedPath(p, lowercase);
    const dst = path.join(outDir, target);
    ensureDir(path.dirname(dst));
    fs.copyFileSync(path.join(vaultDir, p), dst);
    if (target !== p) counts.caseChangedAssets += 1;
  }

  // An asset has no frontmatter, so it has no alias mechanism: a body reference that
  // spells its name in natural case will 404 on a case-sensitive host. Pages are covered
  // by the injected alias stub; assets are not. Report the exposure rather than rename.
  if (counts.caseChangedAssets > 0) {
    warnings.push({
      kind: 'asset-case-change',
      count: counts.caseChangedAssets,
      message: `${counts.caseChangedAssets} assets were lowercased and have no alias mechanism; natural-case references to them can 404 on a case-sensitive host`,
    });
  }

  // 6. Boundary check on what actually landed on disk.
  if (verify) {
    leakTest = verifyProjection(vaultDir, outDir, selectResult, { sampleSize: opts.sampleSize, lowercase });
    if (!leakTest.ok) {
      failures.push({
        kind: 'leak',
        message: `projection boundary check failed: ${leakTest.unexpected.length} unexpected file(s), ${leakTest.missing.length} missing, ${leakTest.deniedPresent.length} denied path(s) present`,
        unexpected: leakTest.unexpected.slice(0, 25),
        missing: leakTest.missing.slice(0, 25),
        deniedPresent: leakTest.deniedPresent.slice(0, 25),
      });
    }
  }

  return finish();
}

export default project;

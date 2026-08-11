// Compare renderer-emitted canonical URL inventories without consulting source files.
// Removed URLs survive only through direct, static alias redirects in candidate output.

import { readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { normalizeHref, resolveLink } from './check.js';

const LOC_RE = /<loc(?:\s[^>]*)?>([\s\S]*?)<\/loc\s*>/giu;
const LOC_OPEN_RE = /<loc(?:\s[^>]*)?>/giu;
const HEAD_RE = /<head\b[^>]*>([\s\S]*?)<\/head\s*>/giu;
const INERT_HTML_RE = /<!--[\s\S]*?-->|<(?:script|style|template|noscript)\b[^>]*>[\s\S]*?<\/(?:script|style|template|noscript)\s*>/giu;
const TAG_RE = /<(?:link|meta)\b[^>]*>/giu;
const ATTRIBUTE_RE = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gu;

export class UrlContinuityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'UrlContinuityError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new UrlContinuityError(code, message);
}

function exactText(value, label) {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) {
    try {
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(value);
    } catch {
      fail('invalid-sitemap', `${label} must be valid UTF-8`);
    }
  }
  fail('invalid-sitemap', `${label} must be text or bytes`);
}

function xmlCodePoint(value, radix) {
  const codePoint = Number.parseInt(value, radix);
  const allowed = codePoint === 0x9
    || codePoint === 0xa
    || codePoint === 0xd
    || (codePoint >= 0x20 && codePoint <= 0xd7ff)
    || (codePoint >= 0xe000 && codePoint <= 0xfffd)
    || (codePoint >= 0x10000 && codePoint <= 0x10ffff);
  if (!allowed) fail('invalid-sitemap', 'sitemap loc contains an invalid XML character reference');
  return String.fromCodePoint(codePoint);
}

function decodeXmlText(value) {
  if (/&(?!(?:#[0-9]+|#x[0-9A-Fa-f]+|amp|lt|gt|quot|apos);)/u.test(value)) {
    fail('invalid-sitemap', 'sitemap loc contains an unknown or unescaped XML entity');
  }
  return value.replace(/&(?:#([0-9]+)|#x([0-9A-Fa-f]+)|amp|lt|gt|quot|apos);/gu, (entity, decimal, hex) => {
    if (decimal !== undefined) return xmlCodePoint(decimal, 10);
    if (hex !== undefined) return xmlCodePoint(hex, 16);
    if (entity === '&amp;') return '&';
    if (entity === '&lt;') return '<';
    if (entity === '&gt;') return '>';
    if (entity === '&quot;') return '"';
    if (entity === '&apos;') return "'";
    return entity;
  });
}

function normalizeBasePath(value) {
  if (value === undefined) return '';
  if (typeof value !== 'string') fail('invalid-base-path', 'basePath must be a string');
  const normalized = value.replace(/^\/+|\/+$/gu, '');
  if (
    normalized.includes('\\')
    || normalized.includes('\0')
    || normalized.split('/').some((segment) => segment === '.' || segment === '..')
  ) {
    fail('invalid-base-path', 'basePath must be a normalized URL path prefix');
  }
  return normalized;
}

function withinBasePath(url, basePath) {
  if (basePath === '') return true;
  const prefix = `/${basePath}`;
  return url.pathname === prefix || url.pathname.startsWith(`${prefix}/`);
}

export function parseSitemap(value, { label = 'sitemap', origin = null, basePath = '' } = {}) {
  const text = exactText(value, label);
  const content = text.replace(/<!--[\s\S]*?-->/gu, '');
  if (content.includes('<!--')) fail('invalid-sitemap', `${label} contains an unclosed XML comment`);
  const urlsetOpenings = content.match(/<urlset(?:\s[^>]*)?>/giu)?.length ?? 0;
  const urlsetClosings = content.match(/<\/urlset\s*>/giu)?.length ?? 0;
  const root = /<urlset(?:\s[^>]*)?>([\s\S]*?)<\/urlset\s*>/iu.exec(content);
  if (urlsetOpenings !== 1 || urlsetClosings !== 1 || root === null) {
    fail('invalid-sitemap', `${label} must contain one urlset root`);
  }
  const beforeRoot = content.slice(0, root.index).trim();
  const afterRoot = content.slice(root.index + root[0].length).trim();
  if ((beforeRoot !== '' && !/^<\?xml\s[\s\S]*?\?>$/iu.test(beforeRoot)) || afterRoot !== '') {
    fail('invalid-sitemap', `${label} contains content outside its urlset root`);
  }
  const inventory = root[1];
  const locOpenings = inventory.match(LOC_OPEN_RE)?.length ?? 0;
  const normalizedBasePath = normalizeBasePath(basePath);
  const urls = [];
  const seen = new Set();
  LOC_RE.lastIndex = 0;
  let match;
  while ((match = LOC_RE.exec(inventory)) !== null) {
    const raw = decodeXmlText(match[1].trim());
    if (raw === '') fail('invalid-sitemap', `${label} contains an empty loc`);
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      fail('invalid-sitemap', `${label} contains an invalid absolute URL`);
    }
    if (
      parsed.protocol !== 'https:'
      || parsed.username !== ''
      || parsed.password !== ''
      || parsed.search !== ''
      || parsed.hash !== ''
    ) {
      fail('invalid-sitemap', `${label} loc values must be credential-free query-free HTTPS URLs`);
    }
    if (parsed.href !== raw) {
      fail('invalid-sitemap', `${label} loc values must use their canonical absolute URL encoding`);
    }
    if (/%(?![0-9a-f]{2})/iu.test(parsed.pathname) || /%(?:00|2f|5c)/iu.test(parsed.pathname)) {
      fail('invalid-sitemap', `${label} loc contains an unsafe or malformed percent escape`);
    }
    if (origin !== null && parsed.origin !== origin) {
      fail('origin-mismatch', `${label} contains a URL from another origin`);
    }
    if (!withinBasePath(parsed, normalizedBasePath)) {
      fail('outside-base-path', `${label} contains a URL outside the configured base path`);
    }
    const canonical = parsed.href;
    if (seen.has(canonical)) fail('duplicate-sitemap-url', `${label} contains a duplicate URL`);
    seen.add(canonical);
    urls.push(canonical);
  }
  if (locOpenings !== urls.length) fail('invalid-sitemap', `${label} contains an unclosed loc`);
  if (urls.length === 0) fail('invalid-sitemap', `${label} must contain at least one loc`);
  urls.sort();
  const firstOrigin = new URL(urls[0]).origin;
  if (urls.some((url) => new URL(url).origin !== firstOrigin)) {
    fail('origin-mismatch', `${label} must contain URLs from one origin`);
  }
  return Object.freeze({ origin: firstOrigin, urls: Object.freeze(urls) });
}

function attributes(tag) {
  const values = {};
  ATTRIBUTE_RE.lastIndex = 0;
  let match;
  while ((match = ATTRIBUTE_RE.exec(tag)) !== null) {
    const name = match[1].toLowerCase();
    if (Object.hasOwn(values, name)) fail('invalid-redirect-stub', `redirect tag repeats ${name}`);
    values[name] = match[2] ?? match[3] ?? match[4] ?? '';
  }
  return values;
}

function tokenList(value) {
  return value.toLowerCase().split(/[\s,]+/u).filter(Boolean);
}

function redirectEvidence(html) {
  HEAD_RE.lastIndex = 0;
  const heads = [...html.matchAll(HEAD_RE)];
  if (heads.length !== 1) fail('invalid-redirect-stub', 'redirect output must contain one head element');
  const head = heads[0][1].replace(INERT_HTML_RE, '');
  if (head.includes('<!--')) fail('invalid-redirect-stub', 'redirect output contains an unclosed HTML comment');
  const canonicals = [];
  const refreshes = [];
  let canonicalClaims = 0;
  let refreshClaims = 0;
  let noindex = false;
  TAG_RE.lastIndex = 0;
  let match;
  while ((match = TAG_RE.exec(head)) !== null) {
    const tag = match[0];
    const attrs = attributes(tag);
    if (/^<link\b/iu.test(tag) && tokenList(attrs.rel ?? '').includes('canonical')) {
      canonicalClaims += 1;
      if (typeof attrs.href === 'string' && attrs.href !== '') canonicals.push(attrs.href);
    }
    if (/^<meta\b/iu.test(tag) && (attrs.name ?? '').toLowerCase() === 'robots') {
      if (tokenList(attrs.content ?? '').includes('noindex')) noindex = true;
    }
    if (/^<meta\b/iu.test(tag) && (attrs['http-equiv'] ?? '').toLowerCase() === 'refresh') {
      refreshClaims += 1;
      const refresh = (attrs.content ?? '').match(/^\s*0\s*;\s*url\s*=\s*(.*?)\s*$/iu);
      if (refresh?.[1]) refreshes.push(refresh[1].replace(/^(?:"(.*)"|'(.*)')$/u, '$1$2'));
    }
  }
  return { canonicals, refreshes, canonicalClaims, refreshClaims, noindex };
}

function isRedirectOutput(file) {
  try {
    const html = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(file));
    return redirectEvidence(html).refreshClaims > 0;
  } catch {
    return false;
  }
}

function routeFile(siteDir, url, basePath) {
  const decoded = normalizeHref(new URL(url).pathname);
  if (decoded === null) return null;
  const root = resolve(siteDir);
  const file = resolveLink(root, join(root, 'index.html'), decoded, basePath);
  if (file === null) return null;
  let routePath = decoded.slice(1);
  if (basePath && (routePath === basePath || routePath.startsWith(`${basePath}/`))) {
    routePath = routePath.slice(basePath.length).replace(/^\//u, '');
  }
  if ((routePath === '' || decoded.endsWith('/')) && resolve(file) !== resolve(root, routePath, 'index.html')) {
    return null;
  }
  const rel = relative(root, file);
  if (rel === '..' || rel.startsWith(`..${sep}`)) fail('outside-site-root', 'resolved route escapes the candidate site directory');
  return { file, relative: rel.split(sep).join('/') };
}

function resolvedTarget(raw, fromUrl, origin, basePath) {
  let target;
  try {
    target = new URL(raw, fromUrl);
  } catch {
    return null;
  }
  if (
    target.origin !== origin
    || target.search !== ''
    || target.hash !== ''
    || !withinBasePath(target, basePath)
  ) return null;
  return target.href;
}

function failure(url, code, output = null, target = null) {
  return Object.freeze({ url, code, output, target });
}

function inspectRemovedUrl({ url, siteDir, basePath, origin, candidateSet }) {
  const route = routeFile(siteDir, url, basePath);
  if (route === null) return failure(url, 'missing-redirect-stub');
  let html;
  try {
    html = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(route.file));
  } catch {
    return failure(url, 'invalid-redirect-stub', route.relative);
  }
  let evidence;
  try {
    evidence = redirectEvidence(html);
  } catch {
    return failure(url, 'invalid-redirect-stub', route.relative);
  }
  if (!evidence.noindex) return failure(url, 'redirect-noindex-missing', route.relative);
  if (evidence.canonicalClaims !== 1 || evidence.canonicals.length !== 1) {
    return failure(url, 'redirect-canonical-missing', route.relative);
  }
  if (evidence.refreshClaims !== 1 || evidence.refreshes.length !== 1) {
    return failure(url, 'redirect-refresh-missing', route.relative);
  }
  const canonical = resolvedTarget(evidence.canonicals[0], url, origin, basePath);
  const refresh = resolvedTarget(evidence.refreshes[0], url, origin, basePath);
  if (canonical === null || refresh === null) return failure(url, 'redirect-target-invalid', route.relative);
  if (canonical !== refresh) return failure(url, 'redirect-target-mismatch', route.relative);
  if (!candidateSet.has(canonical)) return failure(url, 'redirect-target-not-canonical', route.relative, canonical);
  const targetRoute = routeFile(siteDir, canonical, basePath);
  if (targetRoute === null) return failure(url, 'redirect-target-not-canonical', route.relative, canonical);
  if (isRedirectOutput(targetRoute.file)) return failure(url, 'redirect-chain', route.relative, canonical);
  return Object.freeze({ url, target: canonical, output: route.relative });
}

export function checkUrlContinuity({
  previousSitemap,
  candidateSitemap,
  siteDir,
  basePath = '',
} = {}) {
  if (typeof siteDir !== 'string' || siteDir === '') fail('invalid-site-directory', 'siteDir must be a path');
  const normalizedBasePath = normalizeBasePath(basePath);
  const candidate = parseSitemap(candidateSitemap, {
    label: 'candidate sitemap',
    basePath: normalizedBasePath,
  });
  const previous = parseSitemap(previousSitemap, {
    label: 'previous sitemap',
    origin: candidate.origin,
    basePath: normalizedBasePath,
  });
  const previousSet = new Set(previous.urls);
  const candidateSet = new Set(candidate.urls);
  const unchanged = previous.urls.filter((url) => candidateSet.has(url));
  const added = candidate.urls.filter((url) => !previousSet.has(url));
  const removed = previous.urls.filter((url) => !candidateSet.has(url));
  const failures = [];
  for (const url of candidate.urls) {
    const route = routeFile(siteDir, url, normalizedBasePath);
    if (route === null) failures.push(failure(url, 'candidate-route-missing'));
    else if (isRedirectOutput(route.file)) failures.push(failure(url, 'candidate-route-is-redirect', route.relative));
  }
  const covered = [];
  for (const url of removed) {
    const result = inspectRemovedUrl({
      url,
      siteDir,
      basePath: normalizedBasePath,
      origin: candidate.origin,
      candidateSet,
    });
    if (Object.hasOwn(result, 'code')) failures.push(result);
    else covered.push(result);
  }
  failures.sort((left, right) => left.url.localeCompare(right.url) || left.code.localeCompare(right.code));
  covered.sort((left, right) => left.url.localeCompare(right.url));
  return Object.freeze({
    schemaVersion: 1,
    artifactType: 'cyberbaser-url-continuity-report',
    ok: failures.length === 0,
    origin: candidate.origin,
    basePath: normalizedBasePath,
    counts: Object.freeze({
      previous: previous.urls.length,
      candidate: candidate.urls.length,
      unchanged: unchanged.length,
      added: added.length,
      removed: removed.length,
      covered: covered.length,
      failures: failures.length,
    }),
    added: Object.freeze(added),
    removed: Object.freeze(removed),
    covered: Object.freeze(covered),
    failures: Object.freeze(failures),
  });
}

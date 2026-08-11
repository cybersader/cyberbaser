import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkUrlContinuity, parseSitemap, UrlContinuityError } from '../src/index.js';

const ORIGIN = 'https://example.invalid';
const BASE_PATH = 'cyberbase';
const CLI = resolve(import.meta.dir, '../bin/cb-urlcheck.js');
let site;

function sitemap(paths, origin = ORIGIN) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset>\n${paths.map((path) => `  <url><loc>${origin}${path}</loc></url>`).join('\n')}\n</urlset>\n`;
}

function outputPath(pathname) {
  let path = decodeURIComponent(pathname);
  const prefix = `/${BASE_PATH}`;
  if (path === prefix || path === `${prefix}/`) return join(site, 'index.html');
  path = path.slice(prefix.length).replace(/^\//u, '');
  return path.endsWith('/') ? join(site, path, 'index.html') : join(site, `${path}.html`);
}

function writeRoute(pathname, html = '<h1>canonical</h1>') {
  const file = outputPath(pathname);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, html);
  return file;
}

function aliasHtml(target, {
  canonical = target,
  refresh = target,
  noindex = true,
} = {}) {
  return `<!doctype html><html><head>
<link href="${canonical}" rel="canonical">
${noindex ? '<meta content="noindex" name="robots">' : ''}
<meta content="0; url=${refresh}" http-equiv="refresh">
</head></html>`;
}

function check(previousPaths, candidatePaths) {
  const candidate = sitemap(candidatePaths);
  writeFileSync(join(site, 'sitemap.xml'), candidate);
  return checkUrlContinuity({
    previousSitemap: sitemap(previousPaths),
    candidateSitemap: candidate,
    siteDir: site,
    basePath: BASE_PATH,
  });
}

function expectCode(fn, code) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(UrlContinuityError);
    expect(error.code).toBe(code);
    return;
  }
  throw new Error(`expected UrlContinuityError(${code})`);
}

beforeEach(() => {
  site = mkdtempSync(join(tmpdir(), 'cb-url-continuity-'));
});

afterEach(() => rmSync(site, { recursive: true, force: true }));

test('unchanged and added canonical URLs pass with deterministic counts', () => {
  writeRoute('/cyberbase/');
  writeRoute('/cyberbase/Guide');
  const result = check(['/cyberbase/'], ['/cyberbase/', '/cyberbase/Guide']);

  expect(result.ok).toBe(true);
  expect(result.counts).toEqual({
    previous: 1,
    candidate: 2,
    unchanged: 1,
    added: 1,
    removed: 0,
    covered: 0,
    failures: 0,
  });
  expect(result.added).toEqual([`${ORIGIN}/cyberbase/Guide`]);
});

test('a removed canonical URL fails when no old route remains', () => {
  writeRoute('/cyberbase/New');
  const result = check(['/cyberbase/Old'], ['/cyberbase/New']);
  expect(result.ok).toBe(false);
  expect(result.failures).toEqual([{
    url: `${ORIGIN}/cyberbase/Old`,
    code: 'missing-redirect-stub',
    output: null,
    target: null,
  }]);
});

test('a removed URL passes only with a direct noindex canonical refresh stub', () => {
  writeRoute('/cyberbase/New');
  writeRoute('/cyberbase/Old', aliasHtml('/cyberbase/New'));
  const result = check(['/cyberbase/Old'], ['/cyberbase/New']);

  expect(result.ok).toBe(true);
  expect(result.covered).toEqual([{
    url: `${ORIGIN}/cyberbase/Old`,
    target: `${ORIGIN}/cyberbase/New`,
    output: 'Old.html',
  }]);
});

test('arbitrary content and commented redirect tags are not accepted as redirects', () => {
  writeRoute('/cyberbase/New');
  writeRoute('/cyberbase/Old', '<h1>not a redirect</h1>');
  expect(check(['/cyberbase/Old'], ['/cyberbase/New']).failures[0].code)
    .toBe('invalid-redirect-stub');

  writeRoute('/cyberbase/Old', `<!doctype html><html><head>
<meta name="robots" content="noindex">
<!-- <link rel="canonical" href="/cyberbase/New">
<meta http-equiv="refresh" content="0; url=/cyberbase/New"> -->
</head></html>`);
  expect(check(['/cyberbase/Old'], ['/cyberbase/New']).failures[0].code)
    .toBe('redirect-canonical-missing');

  writeRoute('/cyberbase/Old', aliasHtml('/cyberbase/New').replace(
    '</head>',
    '<link rel="canonical"></head>',
  ));
  expect(check(['/cyberbase/Old'], ['/cyberbase/New']).failures[0].code)
    .toBe('redirect-canonical-missing');

  writeRoute('/cyberbase/Old', aliasHtml('/cyberbase/New').replace(
    '</head>',
    '<meta http-equiv="refresh" content="later"></head>',
  ));
  expect(check(['/cyberbase/Old'], ['/cyberbase/New']).failures[0].code)
    .toBe('redirect-refresh-missing');
});

test.each([
  ['missing noindex', aliasHtml('/cyberbase/New', { noindex: false }), 'redirect-noindex-missing'],
  ['mismatched targets', aliasHtml('/cyberbase/New', { refresh: '/cyberbase/Other' }), 'redirect-target-mismatch'],
  ['cross-origin target', aliasHtml('https://other.invalid/cyberbase/New'), 'redirect-target-invalid'],
  ['query target', aliasHtml('/cyberbase/New?from=old'), 'redirect-target-invalid'],
])('%s fails closed', (_, html, code) => {
  writeRoute('/cyberbase/New');
  writeRoute('/cyberbase/Old', html);
  expect(check(['/cyberbase/Old'], ['/cyberbase/New']).failures[0].code).toBe(code);
});

test('redirect chains fail even when the intermediate route appears in the candidate sitemap', () => {
  writeRoute('/cyberbase/New');
  writeRoute('/cyberbase/Middle', aliasHtml('/cyberbase/New'));
  writeRoute('/cyberbase/Old', aliasHtml('/cyberbase/Middle'));
  const codes = check(['/cyberbase/Old'], ['/cyberbase/Middle', '/cyberbase/New'])
    .failures.map(({ code }) => code);
  expect(codes).toContain('candidate-route-is-redirect');
  expect(codes).toContain('redirect-chain');
});

test('case-only renames require the exact old-case alias route', () => {
  writeRoute('/cyberbase/new');
  expect(check(['/cyberbase/New'], ['/cyberbase/new']).failures[0].code)
    .toBe('missing-redirect-stub');

  writeRoute('/cyberbase/New', aliasHtml('/cyberbase/new'));
  expect(check(['/cyberbase/New'], ['/cyberbase/new']).ok).toBe(true);
});

test('percent-encoded Unicode and directory index routes resolve on disk', () => {
  const encoded = '/cyberbase/%F0%9F%93%81-Notes/Page';
  writeRoute('/cyberbase/Section/');
  writeRoute(encoded);
  const result = check([encoded], [encoded, '/cyberbase/Section/']);
  expect(result.ok).toBe(true);
  expect(result.counts.candidate).toBe(2);
});

test('candidate sitemap routes must exist at the emitted route shape', () => {
  let result = check(['/cyberbase/Missing'], ['/cyberbase/Missing']);
  expect(result.ok).toBe(false);
  expect(result.failures[0].code).toBe('candidate-route-missing');

  writeRoute('/cyberbase/Section');
  result = check(['/cyberbase/Section/'], ['/cyberbase/Section/']);
  expect(result.ok).toBe(false);
  expect(result.failures[0].code).toBe('candidate-route-missing');
});

test('malformed, duplicate, mixed-origin, and out-of-prefix inventories fail before comparison', () => {
  expectCode(() => parseSitemap('<urlset></urlset>'), 'invalid-sitemap');
  expectCode(() => parseSitemap(sitemap(['/cyberbase/A', '/cyberbase/A'])), 'duplicate-sitemap-url');
  expectCode(() => parseSitemap(`
    <urlset><loc>${ORIGIN}/cyberbase/A</loc><loc>https://other.invalid/cyberbase/B</loc></urlset>
  `), 'origin-mismatch');
  expectCode(
    () => parseSitemap(sitemap(['/outside/A']), { basePath: BASE_PATH }),
    'outside-base-path',
  );
  expectCode(() => parseSitemap(sitemap(['/cyberbase/A?query=1'])), 'invalid-sitemap');
  expectCode(() => parseSitemap(sitemap(['/cyberbase/%ZZ'])), 'invalid-sitemap');
  expectCode(() => parseSitemap(sitemap(['/cyberbase/A%2FB'])), 'invalid-sitemap');
  expectCode(() => parseSitemap(sitemap(['/cyberbase/A/../B'])), 'invalid-sitemap');
  expect(parseSitemap(`<urlset><url><loc>${ORIGIN}/cyberbase/A&amp;B</loc></url></urlset>`).urls)
    .toEqual([`${ORIGIN}/cyberbase/A&B`]);
  expect(parseSitemap(`<urlset><url><loc>${ORIGIN}/cyberbase/A&#x2F;B</loc></url></urlset>`).urls)
    .toEqual([`${ORIGIN}/cyberbase/A/B`]);
  expectCode(
    () => parseSitemap(`<urlset><url><loc>${ORIGIN}/cyberbase/A&AMP;B</loc></url></urlset>`),
    'invalid-sitemap',
  );
  expectCode(
    () => parseSitemap(`<urlset><url><loc>${ORIGIN}/cyberbase/A</url></urlset>`),
    'invalid-sitemap',
  );
  expectCode(
    () => parseSitemap(`<urlset><url><loc>${ORIGIN}/cyberbase/&#1114112;</loc></url></urlset>`),
    'invalid-sitemap',
  );
  expectCode(
    () => parseSitemap(`<urlset></urlset><loc>${ORIGIN}/cyberbase/A</loc>`),
    'invalid-sitemap',
  );
});

test('reports and serialization are deterministic regardless of sitemap order', () => {
  writeRoute('/cyberbase/A');
  writeRoute('/cyberbase/B');
  const first = checkUrlContinuity({
    previousSitemap: sitemap(['/cyberbase/B', '/cyberbase/A']),
    candidateSitemap: sitemap(['/cyberbase/A', '/cyberbase/B']),
    siteDir: site,
    basePath: BASE_PATH,
  });
  const second = checkUrlContinuity({
    previousSitemap: sitemap(['/cyberbase/A', '/cyberbase/B']),
    candidateSitemap: sitemap(['/cyberbase/B', '/cyberbase/A']),
    siteDir: site,
    basePath: BASE_PATH,
  });
  expect(JSON.stringify(first)).toBe(JSON.stringify(second));
});

test('CLI returns 0 for continuity, 1 for uncovered removal, and 2 for invalid input', () => {
  const previous = join(site, 'previous.xml');
  const report = join(site, 'report.json');
  writeFileSync(previous, sitemap(['/cyberbase/Old']));
  writeRoute('/cyberbase/New');
  writeRoute('/cyberbase/Old', aliasHtml('/cyberbase/New'));
  writeFileSync(join(site, 'sitemap.xml'), sitemap(['/cyberbase/New']));

  const pass = spawnSync('bun', [CLI, previous, site, '--base-path', BASE_PATH, '--json', report]);
  expect(pass.status).toBe(0);
  expect(JSON.parse(readFileSync(report, 'utf8')).ok).toBe(true);

  rmSync(outputPath('/cyberbase/Old'));
  const fail = spawnSync('bun', [CLI, previous, site, '--base-path', BASE_PATH]);
  expect(fail.status).toBe(1);

  const invalid = spawnSync('bun', [CLI, join(site, 'absent.xml'), site]);
  expect(invalid.status).toBe(2);
});

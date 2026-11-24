import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateOwnerAlphaConfig } from '../src/config.js';
import { createOwnerAlphaHandler, createReaderHandler } from '../src/server.js';
import { configuredSiteBase, declaredSiteBase, readSiteBase } from '../src/site-base.js';

// The owner's private reader serves the built site at the path it is built
// for, derived from the vault's own settings, never a fixed product name.

const EXAMPLE = path.resolve(import.meta.dir, '../owner-alpha.example.json');
const cleanup = [];
afterEach(async () => { for (const dir of cleanup.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function config(checkout = null) {
  const raw = JSON.parse(await readFile(EXAMPLE, 'utf8'));
  if (checkout !== null) raw.repository.checkout = checkout;
  return validateOwnerAlphaConfig(raw);
}

async function tempDir(prefix) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanup.push(dir);
  return dir;
}

test('Cyberbase default: no site.yml base, so the path of live.baseUrl (/cyberbase/)', async () => {
  const checkout = await tempDir('site-base-vault-');
  const c = await config(checkout);
  expect(c.live.baseUrl).toBe('https://cybersader.github.io/cyberbase/');
  expect(configuredSiteBase(c)).toBe('/cyberbase/');
  expect(await readSiteBase(c)).toBe('/cyberbase/');
  await mkdir(path.join(checkout, '.cyberbaser'));
  await writeFile(path.join(checkout, '.cyberbaser/site.yml'), 'site:\n  title: Cyberchief\n  addresses: lowercase-hyphen\n');
  expect(await readSiteBase(c)).toBe('/cyberbase/');
});

test('a vault that declares site.baseUrl is served at that path', async () => {
  expect(declaredSiteBase('site:\n  baseUrl: cyberchief.me\n')).toBe('/');
  expect(declaredSiteBase('site:\n  baseUrl: example.org/notes/team/\n')).toBe('/notes/team/');
  expect(declaredSiteBase('site:\n  title: Only a title\n')).toBeNull();
  expect(declaredSiteBase(null)).toBeNull();
  for (const bad of ['site:\n  baseUrl: https://cyberchief.me\n', 'site:\n  baseUrl: host.org/../x\n', 'site:\n  baseUrl: 5\n', 'site: [', 'site:\n  baseUrl: host.org/a b\n']) {
    expect(() => declaredSiteBase(bad)).toThrow(expect.objectContaining({ code: 'site-base-invalid' }));
  }
  const checkout = await tempDir('site-base-vault-');
  await mkdir(path.join(checkout, '.cyberbaser'));
  await writeFile(path.join(checkout, '.cyberbaser/site.yml'), 'site:\n  title: Cyberchief\n  baseUrl: cyberchief.me/field-notes\n');
  expect(await readSiteBase(await config(checkout))).toBe('/field-notes/');
});

const READER = 'http://127.0.0.1:4318';
const get = (fetch, pathname) => fetch(new Request(`${READER}${pathname}`, { headers: { Host: '127.0.0.1:4318', Accept: 'text/html' } }));

async function site() {
  const siteRoot = await tempDir('site-base-site-');
  await mkdir(path.join(siteRoot, 'notes'));
  await writeFile(path.join(siteRoot, 'index.html'), '<h1>Home</h1>');
  await writeFile(path.join(siteRoot, 'notes', 'page.html'), '<h1>Page</h1>');
  return siteRoot;
}

test('reader: default stays at /cyberbase/', async () => {
  const fetch = createReaderHandler({ config: await config(), siteRoot: await site() });
  expect((await get(fetch, '/')).headers.get('location')).toBe('/cyberbase/');
  expect((await get(fetch, '/cyberbase')).headers.get('location')).toBe('/cyberbase/');
  expect(await (await get(fetch, '/cyberbase/notes/page')).text()).toBe('<h1>Page</h1>');
  expect((await get(fetch, '/notes/page')).status).toBe(404);
});

test('reader: a derived base path serves there and nowhere else', async () => {
  const siteRoot = await site();
  const nested = createReaderHandler({ config: await config(), siteRoot, siteBase: '/field-notes/' });
  expect((await get(nested, '/')).headers.get('location')).toBe('/field-notes/');
  expect((await get(nested, '/field-notes')).headers.get('location')).toBe('/field-notes/');
  expect(await (await get(nested, '/field-notes/notes/page')).text()).toBe('<h1>Page</h1>');
  expect((await get(nested, '/cyberbase/notes/page')).status).toBe(404);
  const missing = await get(nested, '/field-notes/missing');
  expect(missing.status).toBe(404);
  expect(await missing.text()).toContain('href="/field-notes/"');

  const root = createReaderHandler({ config: await config(), siteRoot, siteBase: '/' });
  expect(await (await get(root, '/')).text()).toBe('<h1>Home</h1>');
  expect(await (await get(root, '/notes/page')).text()).toBe('<h1>Page</h1>');
  expect((await get(root, '/cyberbase/')).status).toBe(404);

  // Owner pages link to the same home.
  const deps = { createEditSession: async () => ({}), saveEdit: async () => ({}), lookupJob: async () => null, createJobId: () => 'OA-x' };
  expect(createOwnerAlphaHandler({ config: await config(), ...deps }).readerHome).toBe('http://127.0.0.1:4318/cyberbase/');
  expect(createOwnerAlphaHandler({ config: await config(), siteBase: '/', ...deps }).readerHome).toBe('http://127.0.0.1:4318/');

  const c = await config();
  for (const bad of ['cyberbase', '/cyberbase', '/a/../', '/./', '//']) {
    expect(() => createReaderHandler({ config: c, siteRoot, siteBase: bad })).toThrow(TypeError);
  }
});

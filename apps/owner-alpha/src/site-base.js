// Where the owner's private reader serves the built site: the same path the
// site is built for. One rule for every vault (no fixed product name):
//
//   1. the vault's own `.cyberbaser/site.yml` `site.baseUrl` (host[/path],
//      the base the quartz-cyberbase renderer builds with), when declared;
//   2. otherwise the path of the configured public site, `live.baseUrl`, which
//      the owner-site build already uses as its link-check base.
//
// The answer is "/" for a site at a domain root or "/a/b/" with both slashes.
// Cyberbase (live.baseUrl https://cybersader.github.io/cyberbase/) stays at
// "/cyberbase/".
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';
import { fail } from './errors.js';

const SITE_CONFIG = path.join('.cyberbaser', 'site.yml');
const SEGMENT = /^[A-Za-z0-9._~-]+$/u;

function normalizedBase(pathname, source) {
  const segments = pathname.split('/').filter((segment) => segment !== '');
  if (segments.some((segment) => !SEGMENT.test(segment) || segment === '.' || segment === '..')) {
    fail('site-base-invalid', `${source} has a path the private reader cannot serve`);
  }
  return segments.length === 0 ? '/' : `/${segments.join('/')}/`;
}

/** The base path from the configured public site address (live.baseUrl). */
export function configuredSiteBase(config) {
  let url;
  try { url = new URL(config?.live?.baseUrl); } catch { fail('site-base-invalid', 'live.baseUrl must be an absolute URL'); }
  return normalizedBase(url.pathname, 'live.baseUrl');
}

/**
 * The base path declared by the vault's site.yml text (site.baseUrl, host[/path]
 * or an http(s):// address), or null when the file declares none. An unreadable or
 * malformed declaration fails closed rather than guessing.
 */
export function declaredSiteBase(text) {
  if (text === null || text === undefined) return null;
  let parsed;
  try { parsed = yaml.load(String(text), { schema: yaml.CORE_SCHEMA }); } catch {
    fail('site-base-invalid', '.cyberbaser/site.yml is not valid YAML');
  }
  const declared = parsed?.site?.baseUrl;
  if (declared === undefined || declared === null) return null;
  // An https:// (or http://) address is read for its path, as Cyberchief writes it ("https://cyberchief.me/").
  if (typeof declared === 'string' && /^https?:\/\//iu.test(declared.trim())) {
    let url;
    try { url = new URL(declared.trim()); } catch { fail('site-base-invalid', 'site.baseUrl is not a valid address'); }
    if (url.username || url.password || url.search || url.hash) fail('site-base-invalid', 'site.baseUrl must be host[/path]');
    return normalizedBase(url.pathname, 'site.baseUrl');
  }
  if (typeof declared !== 'string' || declared.trim() === '' || /^[a-z][a-z0-9+.-]*:/iu.test(declared.trim())) {
    fail('site-base-invalid', 'site.baseUrl must be host[/path], or an https:// address');
  }
  const value = declared.trim();
  const slash = value.indexOf('/');
  return normalizedBase(slash < 0 ? '' : value.slice(slash), 'site.baseUrl');
}

/** The private reader's base path for this config and its vault checkout. */
export async function readSiteBase(config) {
  let text = null;
  try {
    text = await readFile(path.join(config.repository.checkout, SITE_CONFIG), 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
  }
  return declaredSiteBase(text) ?? configuredSiteBase(config);
}

import { posix as path } from 'node:path';
import { isSafeSegment } from './tree.js';

export const HOME = 'index.html';
export const CATALOG = 'notes/index.html';
export const CSS = 'reader.css';
export const MANIFEST = 'notes.json';
export const noteStem = (name) => name.replace(/\.md$/i, '');
const stripHtml = (name) => name.replace(/\.html$/i, '');

export function noteRoute(source, slug) {
  const hasSlug = slug !== undefined && slug !== null;
  const name = hasSlug && typeof slug === 'string'
    ? slug.trim().replace(/^\/+|\/+$/g, '').replace(/\.(md|html)$/i, '')
    : noteStem(source);
  if ((hasSlug && typeof slug !== 'string') || !name.split('/').every(isSafeSegment)) {
    throw new Error(`invalid note route for ${JSON.stringify(source)}`);
  }
  return { name, file: name === 'index' ? HOME : `notes/${name}.html` };
}

export function urlPath(file) {
  return file.split('/').map(encodeURIComponent).join('/');
}

export function relativeUrl(from, to) {
  const href = urlPath(path.relative(path.dirname(from), to));
  return href.startsWith('../') ? href : `./${href}`;
}

export function assertDistinctOutputs(files) {
  const seen = new Set();
  for (const file of files) {
    if (seen.has(file)) throw new Error(`duplicate output route: ${JSON.stringify(file)}`);
    seen.add(file);
  }
  for (const file of seen) {
    for (let parent = path.dirname(file); parent !== '.'; parent = path.dirname(parent)) {
      if (seen.has(parent)) throw new Error(`output file conflicts with directory: ${JSON.stringify(parent)}`);
    }
  }
}

// Keep ambiguity as a distinct outcome, even if it came from case-folding.
const AMBIGUOUS = Symbol('ambiguous');
function indexBy(entries) {
  const exact = new Map();
  const folded = new Map();
  function put(map, key, value) {
    if (map.has(key) && map.get(key) !== value) map.set(key, AMBIGUOUS);
    else map.set(key, value);
  }
  for (const [key, value] of entries) {
    if (typeof key !== 'string' || !key) continue;
    put(exact, key, value);
    put(folded, key.toLowerCase(), value);
  }
  return (key) => exact.get(key) ?? folded.get(key.toLowerCase());
}

function parseLocal(target, source) {
  if (target.startsWith('//') || /[\\\u0000-\u001f\u007f]/u.test(target)) return null;
  const hash = target.indexOf('#');
  const anchor = hash === -1 ? '' : target.slice(hash + 1);
  const rawPath = (hash === -1 ? target : target.slice(0, hash)).split('?')[0];
  if (!rawPath) return { self: true, anchor };

  const rooted = rawPath.startsWith('/');
  const segments = (rooted ? rawPath.slice(1) : rawPath).split('/');
  const directed = rooted || segments.some((segment) => segment === '.' || segment === '..');
  const base = rooted ? [] : source.split('/').slice(0, -1);
  const decoded = [];
  for (const segment of segments) {
    if (segment === '.' || segment === '..') {
      if (segment === '..' && !base.length) return null;
      if (segment === '..') base.pop();
      continue;
    }
    let part;
    // A bare percent is valid in an OFM name. A valid percent escape is interpreted
    // once, as for Markdown. Encoded delimiters or dot segments are never accepted.
    try { part = decodeURIComponent(segment.replace(/%(?![0-9a-f]{2})/gi, '%25')); }
    catch { return null; }
    if (!isSafeSegment(part) || part.includes('/')) return null;
    base.push(part);
    decoded.push(part);
  }
  return { anchor, directed, local: base.join('/'), name: decoded.join('/') };
}

function externalLink(target) {
  if (!/^https?:\/\//i.test(target) || /[\\\s\u0000-\u001f\u007f]/u.test(target)) return undefined;
  try {
    const url = new URL(target);
    if (url.hostname && !url.username && !url.password) return url.href;
  } catch { /* malformed URL */ }
  return undefined;
}

function fragment(page, raw) {
  if (!raw) return '';
  let label;
  try { label = decodeURIComponent(raw); } catch { return ''; }
  return `#${encodeURIComponent(page.anchors.get(label) ?? page.anchors.get(headingKey(label)) ?? label)}`;
}

export function headingKey(label) {
  return label.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}\p{M}_-]+/gu, '-').replace(/^-+|-+$/g, '') || 'section';
}

export function makeResolver(notes, assets) {
  const bySource = indexBy(notes.map((note) => [note.source, note]));
  const byStem = indexBy(notes.map((note) => [noteStem(note.source), note]));
  const byRouteName = indexBy(notes.map((note) => [note.name, note]));
  const byWikiName = indexBy(notes.flatMap((note) =>
    [path.basename(noteStem(note.source)), note.name, note.title, ...note.aliases].map((key) => [key, note])));
  const byAsset = indexBy(assets.map((asset) => [asset.relative, asset]));
  const byAssetName = indexBy(assets.map((asset) => [path.basename(asset.relative), asset]));

  return (from, target, kind) => {
    if (!target) return undefined;
    const isImage = kind === 'image' || kind === 'wiki-image';
    const wiki = kind === 'wiki' || kind === 'wiki-image';
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) {
      const url = !isImage && !wiki ? externalLink(target) : undefined;
      return url ? { url, image: false, external: true } : undefined;
    }
    const local = parseLocal(target, from.source);
    if (!local) return undefined;
    if (local.self) {
      return !isImage && local.anchor ? { url: fragment(from, local.anchor), image: false } : undefined;
    }

    const asset = byAsset(local.local) ?? (wiki && !local.directed
      ? byAsset(local.name) ?? byAssetName(local.name) : undefined);
    if (asset && asset !== AMBIGUOUS) {
      return { url: relativeUrl(from.file, asset.file), image: isImage };
    }
    if (kind === 'image') return undefined;

    const findNote = (name) => bySource(name) ?? byStem(name) ?? byRouteName(stripHtml(name));
    const note = findNote(local.local) ?? (wiki && !local.directed
      ? findNote(local.name) ?? byWikiName(noteStem(local.name)) : undefined);
    return note && note !== AMBIGUOUS
      ? { url: relativeUrl(from.file, note.file) + fragment(note, local.anchor), image: false }
      : undefined;
  };
}

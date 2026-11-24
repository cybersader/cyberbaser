// Images a note names in its properties (2026-11-24).
//
// One rule, used by the selector (which images go public), the owner node's
// bundle check (`asset-unreferenced`), the publisher's own re-check and the
// writing device (which images to send):
//
//   A top-level property whose value is one text naming an image
//   (`cover: from-the-field/x-cover.png`, optionally as
//   `"[[from-the-field/x-cover.png]]"`) references the first file that exists
//   of: that path from the vault root, then that path from the note's own
//   folder (`cover: x-cover.png` in "Topic/X/X.md" is "Topic/X/x-cover.png").
//   This is Obsidian's order, minus its third step ("the only file of that
//   name anywhere"): that step is refused because its answer can change when
//   a file is added somewhere else. The Cyberchief renderer resolves image
//   properties by the same two steps (site/components/cc.ts vaultFile).
//
// Why this rule and not "fields the site model types as image": publish.yml
// alone decides what is public, so the selector must not read the site model,
// and the public site build and vaults without a model (Cyberbase) need the
// same answer. Why these two steps and no name lookup: both are fixed by the
// note's own path, so the answer never depends on unrelated files. Pure, no
// Node imports: the plugin uses it too.
import { parseFrontmatter } from './page-rules.js';

export const PROPERTY_IMAGE_EXTENSIONS = Object.freeze(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg']);
const REMOTE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu;

/** A property value -> vault path it names as an image, or null. */
export function propertyImagePath(value) {
  if (typeof value !== 'string') return null;
  let p = value.trim();
  const wiki = /^!?\[\[([^\]\n]*)\]\]$/u.exec(p);
  if (wiki) p = wiki[1].split('|')[0].trim();
  if (p === '' || REMOTE.test(p) || p.includes('\\') || /[\u0000-\u001F\u007F#?]/u.test(p)) return null;
  p = p.replace(/^\/+/u, '');
  const segments = p.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return null;
  const dot = p.lastIndexOf('.');
  const extension = dot < 0 ? '' : p.slice(dot + 1).toLowerCase();
  return PROPERTY_IMAGE_EXTENSIONS.includes(extension) ? p : null;
}

/** "Topic/X/X.md" -> "Topic/X"; "" at the vault root. */
const folderOf = (path) => (typeof path === 'string' && path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/**
 * The vault paths a property image may be, in order: from the vault root,
 * then from the note's own folder (when notePath is given and it differs).
 */
export function propertyImageCandidates(target, notePath = null) {
  const out = [target];
  const folder = folderOf(notePath);
  if (folder !== '') {
    const relative = `${folder}/${target}`;
    if (!out.includes(relative)) out.push(relative);
  }
  return out;
}

/**
 * Every image a note's top-level properties name: [{ key, target, candidates,
 * line, kind: 'property', raw }]. target: the value as a path; candidates:
 * where it may be (propertyImageCandidates). Which exists is the caller's
 * check (resolvePropertyImage). Unreadable properties name nothing.
 */
export function propertyImageRefs(text, notePath = null) {
  const fm = parseFrontmatter(typeof text === 'string' ? text : '');
  if (fm.error) return [];
  const lines = typeof text === 'string' ? text.split('\n') : [];
  const refs = [];
  for (const [key, value] of Object.entries(fm.data)) {
    const target = propertyImagePath(value);
    if (target === null) continue;
    const at = lines.findIndex((line, i) => i > 0 && line.startsWith(`${key}:`));
    refs.push({ key, target, candidates: propertyImageCandidates(target, notePath), line: at < 0 ? 1 : at + 1, kind: 'property', raw: `${key}: ${value}` });
  }
  return refs;
}

/** The first candidate of a ref that exists (exists(path) -> boolean), or null. */
export function resolvePropertyImage(ref, exists) {
  return (ref.candidates ?? [ref.target]).find((candidate) => exists(candidate)) ?? null;
}

/** The existing images a note names in its properties. exists(path) -> boolean; notePath: the note's vault path. */
export function propertyImages(text, exists, notePath = null) {
  const out = [];
  for (const ref of propertyImageRefs(text, notePath)) {
    const found = resolvePropertyImage(ref, exists);
    if (found !== null && !out.includes(found)) out.push(found);
  }
  return out;
}

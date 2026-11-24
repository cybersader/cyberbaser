// Images a note names in its properties (2026-11-24).
//
// One rule, used by the selector (which images go public), the owner node's
// bundle check (`asset-unreferenced`), the publisher's own re-check and the
// writing device (which images to send):
//
//   A top-level property whose value is one text naming an image by its path
//   from the vault root (`cover: from-the-field/x-cover.png`, optionally as
//   `"[[from-the-field/x-cover.png]]"`) references that image, when a file
//   exists at exactly that path.
//
// Why this rule and not "fields the site model types as image": publish.yml
// alone decides what is public, so the selector must not read the site model,
// and the public site build and vaults without a model (Cyberbase) need the
// same answer. Why exact vault paths only: that is how renderers read these
// properties (Quartz's cover/image, the Cyberchief renderer's cover, avatar
// and portrait), so a note-relative or basename guess would publish a file
// the page never shows. Pure, no Node imports: the plugin uses it too.
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

/**
 * Every image path a note's top-level properties name: [{ key, target, line,
 * kind: 'property', raw }]. Existence is the caller's check (the vault tree).
 * Unreadable properties name nothing.
 */
export function propertyImageRefs(text) {
  const fm = parseFrontmatter(typeof text === 'string' ? text : '');
  if (fm.error) return [];
  const lines = typeof text === 'string' ? text.split('\n') : [];
  const refs = [];
  for (const [key, value] of Object.entries(fm.data)) {
    const target = propertyImagePath(value);
    if (target === null) continue;
    const at = lines.findIndex((line, i) => i > 0 && line.startsWith(`${key}:`));
    refs.push({ key, target, line: at < 0 ? 1 : at + 1, kind: 'property', raw: `${key}: ${value}` });
  }
  return refs;
}

/** The existing images a note names in its properties. exists(path) -> boolean. */
export function propertyImages(text, exists) {
  const out = [];
  for (const ref of propertyImageRefs(text)) if (exists(ref.target) && !out.includes(ref.target)) out.push(ref.target);
  return out;
}

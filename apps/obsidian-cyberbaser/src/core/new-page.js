// Publishing a new page from this device (design: new notes and images
// through the gate, 2026-11-24). Pure, no Obsidian: main.js only reads files.
//
// The device works out on its own, from its own copy of publish.yml and the
// note's properties, whether a note would go public and at which address. It
// uses the same rules as the selector (packages/publish/src/page-rules.js).
//
// Photos: before anything is sent, every embedded image is cleaned of the
// place it was taken (stripLocation). The cleaned bytes are what the node
// receives and what this device later hashes and signs; the node and the
// publisher refuse any image that still carries a location.
import { classifyPage, publicAddress, resolveConfigText } from '../../../../packages/publish/src/page-rules.js';
import { checkAsset, imageEmbeds, MediaError, stripLocation } from '../../../../packages/media-check/src/index.js';
import { findFrontmatterInText } from '../../../../packages/correction/src/frontmatter.js';
import yaml from 'js-yaml';

export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_BUNDLE_BYTES = 12 * 1024 * 1024;
const REMOTE = /^\s*(?:[a-z][a-z0-9+.-]*:|\/\/)/iu;

/** { published, address, draft, marker, rule } for one note under the vault's publish.yml text. */
export function notePublicStatus({ path, text, publishYml }) {
  const resolved = resolveConfigText(publishYml);
  if (!resolved.ok) return { published: false, address: null, draft: false, marker: null, rule: 'config-unavailable' };
  const verdict = classifyPage(path, text, resolved);
  return {
    published: verdict.published,
    address: verdict.published ? publicAddress(path, verdict.slug) : null,
    draft: verdict.marker !== undefined,
    marker: verdict.marker ?? null,
    rule: verdict.rule,
  };
}

/**
 * The vault images a note embeds. resolve(target, fromPath) -> vault path or
 * null (Obsidian's link resolution); remote images are reported so the owner
 * can fix them before anything is sent.
 */
export function embeddedImages({ path, text, resolve }) {
  const local = [];
  const remote = [];
  for (const embed of imageEmbeds(text)) {
    if (REMOTE.test(embed.target)) { remote.push(embed.raw); continue; }
    const target = String(embed.target).split('|')[0].split('#')[0].trim();
    const resolved = resolve(target, path);
    if (typeof resolved === 'string' && !/\.md$/iu.test(resolved) && !local.includes(resolved)) local.push(resolved);
  }
  return { local, remote };
}

/**
 * Clean and check each image. images: [{ path, bytes }] straight from the
 * vault. Returns [{ path, bytes, size, type, cleaned, refused }] where refused
 * is a failure code (asset-type-refused, asset-type-mismatch, asset-too-large,
 * image-has-location) or null.
 */
export function prepareImages(images) {
  return images.map(({ path, bytes }) => {
    const original = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let cleaned = original;
    let changed = false;
    try {
      const result = stripLocation(original);
      cleaned = result.bytes;
      changed = result.changed;
    } catch (error) {
      return { path, bytes: original, size: original.length, type: null, cleaned: false,
        refused: error instanceof MediaError ? error.code : 'asset-type-refused' };
    }
    const verdict = checkAsset(path, cleaned);
    return { path, bytes: cleaned, size: cleaned.length, type: verdict.ok ? verdict.mediaType : null, cleaned: changed,
      refused: verdict.ok ? null : verdict.code };
  });
}

/** Why a new page cannot be sent yet, or null. Checked before anything leaves the device. */
export function newPageProblem({ status, images, remote }) {
  if (status.draft) return 'note-is-draft';
  if (!status.published) return 'create-outside-publication';
  if (remote.length > 0) return 'remote-image-refused';
  if (images.length > MAX_IMAGES) return 'bundle-file-count';
  const refused = images.find((image) => image.refused !== null);
  if (refused) return refused.refused;
  if (images.reduce((sum, image) => sum + image.size, 0) > MAX_BUNDLE_BYTES) return 'bundle-too-large';
  return null;
}

const DRAFT_ON = /^(draft:[ \t]*)(?:true|True|TRUE|yes|Yes|YES|on|On|ON)([ \t]*(?:#.*)?)$/gmu;

/**
 * The note's text with Draft turned off, for "Publish to your site": the one
 * `draft: true` line becomes `draft: false` and every other byte stays as it
 * was. This text is what is sent, and so what the owner signs: turning Draft
 * off is part of the same approved change. Null when the note has no single
 * plain `draft: true` line to change.
 */
export function withDraftOff(text) {
  const block = findFrontmatterInText(text);
  if (block.kind !== 'block') return null;
  const start = text.indexOf(block.yamlText, block.textRange.start);
  if (start < 0) return null;
  const matches = [...block.yamlText.matchAll(DRAFT_ON)];
  if (matches.length !== 1) return null;
  const at = start + matches[0].index;
  const next = `${text.slice(0, at)}${matches[0][1]}false${matches[0][2]}${text.slice(at + matches[0][0].length)}`;
  // Only draft changed, and it now reads as false.
  let before;
  let after;
  try {
    before = yaml.load(block.yamlText, { schema: yaml.CORE_SCHEMA });
    after = yaml.load(findFrontmatterInText(next).yamlText, { schema: yaml.CORE_SCHEMA });
  } catch { return null; }
  if (after?.draft !== false || JSON.stringify({ ...before, draft: false }) !== JSON.stringify(after)) return null;
  return next;
}

/**
 * What Publish does with a draft: its draft-off text and whether that would
 * go public. { text, status } or null when Draft cannot be turned off here.
 */
export function draftPublishPlan({ path, text, publishYml }) {
  const local = notePublicStatus({ path, text, publishYml });
  if (local.marker !== 'draft') return null;
  const next = withDraftOff(text);
  if (next === null) return null;
  const status = notePublicStatus({ path, text: next, publishYml });
  return status.published ? { text: next, status } : null;
}

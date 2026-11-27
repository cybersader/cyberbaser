// The publisher's own rules for a page-bundle commit, on top of the signed
// intent check (checkCommit), which stays unchanged and always runs first.
//
// The publisher does not trust the node's account of a bundle, so from its
// own validated copy of the Git objects it checks every file the commit adds:
// a safe path that is not hidden and not publish.yml, no case collision with a
// path or folder already at the base, and, for an image, a real PNG, JPEG,
// WebP or GIF that matches its name, ends where its structure ends, and no
// longer records where it was taken, and that a note in the same commit shows
// it (in its text, or named by its vault path in a property such as `cover:`;
// noteAssetTargets, the selector's own rule). Nothing is deleted; at most one
// note is edited, two are added and four images are added.
import { caseKey, lintPath, noteAssetTargets } from '../../../../packages/publish/src/index.js';
import { checkAsset } from '../../../../packages/media-check/src/index.js';
import { checkCommit } from '../../../../packages/signed-intent/src/index.js';
import { OwnerAlphaError } from '../errors.js';

const APPROVAL_MISMATCH = 'The change does not match what your device approved, so nothing was published.';

export const BUNDLE_PUBLISH_CODES = Object.freeze(['create-path-refused', 'selection-config-change-refused',
  'create-path-case-collision', 'asset-type-refused', 'asset-type-mismatch', 'asset-too-large', 'image-has-location',
  'bundle-file-count', 'capture-base-moved', 'asset-unreferenced']);

const RAW = /^:(\d{6}) (\d{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ([ADMT])$/u;
const refuse = (code, path = null) => Object.freeze({ ok: false, code, ...(path === null ? {} : { path }) });

/** git(args) -> Buffer over the publisher's checked object store. */
export async function checkBundleCommit(git, base, commit) {
  let diff;
  let listing;
  try {
    diff = (await git(['diff-tree', '-r', '-z', '--no-renames', '--no-commit-id', '--raw', base, commit])).toString('utf8').split('\0');
    listing = (await git(['ls-tree', '-r', '-z', '--name-only', '--full-tree', base])).toString('utf8').split('\0').filter(Boolean);
  } catch {
    return refuse('create-path-refused');
  }
  if (diff.at(-1) === '') diff.pop();
  const keys = new Map();
  for (const existing of listing) {
    const segments = existing.split('/');
    for (let i = 1; i <= segments.length; i += 1) {
      const prefix = segments.slice(0, i).join('/');
      if (!keys.has(caseKey(prefix))) keys.set(caseKey(prefix), prefix);
    }
  }
  const counts = { A: 0, M: 0, images: 0 };
  const notes = [];
  const images = [];
  for (let i = 0; i < diff.length; i += 2) {
    const match = RAW.exec(diff[i]);
    const path = diff[i + 1];
    if (match === null || typeof path !== 'string') return refuse('create-path-refused');
    const [, , newMode, , newId, status] = match;
    if (path.split('/').some((segment) => segment.startsWith('.'))) return refuse('create-path-refused', path);
    if (path === 'publish.yml') return refuse('selection-config-change-refused', path);
    if (status === 'M') {
      if (!/\.md$/u.test(path)) return refuse('create-path-refused', path);
      counts.M += 1;
      notes.push({ path, oid: newId });
      continue;
    }
    if (status !== 'A' || newMode !== '100644') return refuse('bundle-file-count', path);
    if (lintPath(path).length > 0) return refuse('create-path-refused', path);
    const segments = path.split('/');
    for (let j = 1; j <= segments.length; j += 1) {
      const prefix = segments.slice(0, j).join('/');
      const holder = keys.get(caseKey(prefix));
      if (holder !== undefined && holder !== prefix) return refuse('create-path-case-collision', path);
    }
    if (/\.md$/u.test(path)) { counts.A += 1; notes.push({ path, oid: newId }); continue; }
    let bytes;
    try { bytes = await git(['cat-file', 'blob', newId]); } catch { return refuse('asset-type-refused', path); }
    const verdict = checkAsset(path, new Uint8Array(bytes));
    if (!verdict.ok) return refuse(verdict.code, path);
    counts.images += 1;
    images.push(path);
  }
  if (counts.M > 1 || counts.A > 2 || counts.images > 4 || counts.M + counts.A === 0) return refuse('bundle-file-count');
  if (images.length > 0) {
    let paths;
    const shown = new Set();
    try {
      paths = (await git(['ls-tree', '-r', '-z', '--name-only', '--full-tree', commit])).toString('utf8').split('\0').filter(Boolean);
      for (const note of notes) {
        const text = new TextDecoder('utf-8').decode(await git(['cat-file', 'blob', note.oid]));
        for (const target of noteAssetTargets(note.path, text, paths)) shown.add(target);
      }
    } catch {
      return refuse('create-path-refused');
    }
    const lonely = images.find((image) => !shown.has(image));
    if (lonely !== undefined) return refuse('asset-unreferenced', lonely);
  }
  return Object.freeze({ ok: true });
}

/**
 * Everything the publisher checks before it pushes a bundle, from its own
 * object store: the one parent is the remote head, the signed intent matches
 * the commit exactly (checkCommit, enforced whatever the gate's rollout mode),
 * and the bundle rules above pass. Throws OwnerAlphaError; returns nothing.
 * admitted: the gate's admitted approval (never null for a bundle).
 */
export async function verifyBundleForPush({ git, head, commit, admitted }) {
  if (admitted === null || admitted === undefined) throw new OwnerAlphaError('owner-approval-missing', 'a page bundle needs the owner\'s signed approval');
  let raw;
  try { raw = (await git(['cat-file', 'commit', commit])).toString('utf8'); } catch {
    throw new OwnerAlphaError('owner-approval-mismatch', APPROVAL_MISMATCH, { reason: 'commit-unreadable' });
  }
  const parents = raw.split('\n\n')[0].split('\n').filter((line) => line.startsWith('parent '));
  if (parents.length !== 1 || parents[0] !== `parent ${head}`) throw new OwnerAlphaError('capture-base-moved', 'your notes changed on GitHub meanwhile');
  const signed = await checkCommit(git, admitted.intent, commit);
  if (!signed.ok) throw new OwnerAlphaError('owner-approval-mismatch', APPROVAL_MISMATCH, { reason: signed.code, path: signed.path ?? null });
  const rules = await checkBundleCommit(git, head, commit);
  if (!rules.ok) throw new OwnerAlphaError(rules.code, 'the page bundle breaks a publishing rule', { path: rules.path ?? null });
}

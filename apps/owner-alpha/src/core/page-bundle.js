// Node side of a page bundle (design: new notes and images through the gate,
// 2026-11-24): check it against the pinned base tree, then build its commit
// from Git objects alone.
//
// Checks run at capture and again before the commit is offered for signature.
// The commit is create-once: new blobs are written with hash-object, staged
// into a private index read from the base tree, and committed with one parent
// equal to the base. No ref moves, the working tree and every existing file
// stay untouched, and the publisher re-checks the commit on its own.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { bundleCandidates, validatePageBundle } from '../../../../packages/proposal/src/page-bundle.js';
import { caseKey, lintPath, publicAddress, selectTree, slugKey } from '../../../../packages/publish/src/index.js';
import { checkAsset, remoteImageEmbeds } from '../../../../packages/media-check/src/index.js';
import { fail } from '../errors.js';

export const BUNDLE_CODES = Object.freeze([
  'create-path-refused', 'selection-config-change-refused', 'create-path-exists', 'create-path-case-collision',
  'create-parent-is-file', 'create-address-collision', 'create-outside-publication', 'capture-base-moved',
  'asset-type-refused', 'asset-type-mismatch', 'asset-too-large', 'bundle-too-large', 'asset-unreferenced',
  'remote-image-refused', 'image-has-location', 'public-set-removal-refused', 'address-changed',
  'public-set-change-unlisted', 'capture-base-unavailable', 'capture-too-large',
]);

const SELECTION_CONFIG = new Set(['publish.yml']);
const OID = /^[0-9a-f]{40}$/u;

function cleanGitEnv(extra = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return { ...env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ASKPASS: '/bin/false', ...extra };
}

/** git(args, { input, env }) -> Buffer, in one repository, hooks off, no ambient Git environment. */
export function bundleGit(repository) {
  return (args, { input = null, env = {} } = {}) => new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', repository, '-c', 'core.hooksPath=/dev/null', ...args],
      { env: cleanGitEnv(env), stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks = [];
    let size = 0;
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > 256 * 1024 * 1024) child.kill('SIGKILL');
      else chunks.push(chunk);
    });
    child.once('error', reject);
    child.once('close', (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`git ${args[0]} failed`))));
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

/** Every blob at a commit: Map path -> { mode, oid }. Submodules and symlinks are kept as entries. */
export async function readBaseTree(git, revision) {
  if (!OID.test(revision ?? '')) fail('capture-base-unavailable', 'the base commit is not one commit ID');
  const listing = (await git(['ls-tree', '-r', '-z', '--full-tree', revision])).toString('utf8').split('\0');
  const entries = new Map();
  for (const line of listing) {
    if (line === '') continue;
    const match = /^(\d{6}) (blob|commit|tree) ([0-9a-f]{40})\t(.+)$/su.exec(line);
    if (match === null) fail('capture-base-unavailable', 'the base tree is unreadable');
    entries.set(match[4], { mode: match[1], type: match[2], oid: match[3] });
  }
  return entries;
}

/** Map path -> Buffer for many blobs in one cat-file --batch call. */
export async function readBlobs(git, oids, maxBytes = 64 * 1024 * 1024) {
  const unique = [...new Set(oids)];
  if (unique.length === 0) return new Map();
  const out = await git(['cat-file', '--batch'], { input: `${unique.join('\n')}\n` });
  const blobs = new Map();
  let at = 0;
  let total = 0;
  for (const oid of unique) {
    const newline = out.indexOf(10, at);
    const header = out.subarray(at, newline).toString('utf8');
    const match = /^([0-9a-f]{40}) blob (\d+)$/u.exec(header);
    if (newline < 0 || match === null || match[1] !== oid) fail('capture-base-unavailable', 'a base file is unreadable');
    const size = Number(match[2]);
    total += size;
    if (total > maxBytes) fail('capture-base-unavailable', 'the vault is too large to check here');
    blobs.set(oid, out.subarray(newline + 1, newline + 1 + size));
    at = newline + 1 + size + 1;
  }
  return blobs;
}

const isMarkdown = (p) => /\.md$/iu.test(p);
const decoder = new TextDecoder('utf-8', { fatal: false });

/** The vault as the selector sees it: Markdown text, other files null. */
async function selectorView(git, tree) {
  const markdown = [...tree].filter(([p, entry]) => entry.type === 'blob' && (isMarkdown(p) || p === 'publish.yml'));
  const blobs = await readBlobs(git, markdown.map(([, entry]) => entry.oid));
  const files = {};
  for (const [p, entry] of tree) {
    if (entry.type !== 'blob') continue;
    files[p] = isMarkdown(p) || p === 'publish.yml' ? decoder.decode(blobs.get(entry.oid)) : null;
  }
  return files;
}

function pageTarget(source, slug) {
  if (typeof slug !== 'string') return source;
  const s = slug.trim().replace(/^\/+|\/+$/g, '').replace(/\.(md|html)$/i, '');
  return s === '' || s.split('/').some((x) => x === '' || x === '.' || x === '..') ? source : `${s}.md`;
}

function addresses(selection) {
  const map = new Map();
  for (const page of selection.report.published.pages) map.set(page, pageTarget(page, selection.report.slugs[page]));
  for (const asset of selection.report.published.assets) map.set(asset, asset);
  return map;
}

function checkPath(file) {
  const segments = file.path.split('/');
  if (segments.some((segment) => segment.startsWith('.'))) fail('create-path-refused', 'a hidden folder or file cannot be added', { path: file.path });
  if (SELECTION_CONFIG.has(file.path)) fail('selection-config-change-refused', 'publish.yml is changed only on its own', { path: file.path });
  if (file.kind !== 'modify' && lintPath(file.path).length > 0) fail('create-path-refused', 'this file name is not safe on every system', { path: file.path });
}

function checkPlacement(file, tree, baseKeys) {
  if (file.kind === 'modify') {
    const entry = tree.get(file.path);
    if (entry === undefined || entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) {
      fail('capture-base-unavailable', 'the vault has no committed copy of this note', { path: file.path });
    }
    return;
  }
  if (tree.has(file.path)) fail('create-path-exists', 'a file already exists at this path', { path: file.path });
  const segments = file.path.split('/');
  for (let i = 1; i < segments.length; i += 1) {
    const prefix = segments.slice(0, i).join('/');
    if (tree.has(prefix)) fail('create-parent-is-file', 'a folder on this path is a file in the vault', { path: file.path });
  }
  // The new path and every folder on it, against every path and folder at base.
  for (let i = 1; i <= segments.length; i += 1) {
    const prefix = segments.slice(0, i).join('/');
    const holder = baseKeys.get(caseKey(prefix));
    if (holder !== undefined && holder !== prefix) {
      fail('create-path-case-collision', 'a path differing only in capital letters already exists', { path: file.path, existing: holder });
    }
  }
}

function caseKeys(tree) {
  const keys = new Map();
  for (const p of tree.keys()) {
    const segments = p.split('/');
    for (let i = 1; i <= segments.length; i += 1) {
      const prefix = segments.slice(0, i).join('/');
      if (!keys.has(caseKey(prefix))) keys.set(caseKey(prefix), prefix);
    }
  }
  return keys;
}

const embedCounts = (text) => {
  const counts = new Map();
  for (const embed of remoteImageEmbeds(text)) counts.set(embed.raw, (counts.get(embed.raw) ?? 0) + 1);
  return counts;
};

function checkRemoteImages(file, candidate, base) {
  const after = embedCounts(decoder.decode(candidate));
  const before = base === null ? new Map() : embedCounts(decoder.decode(base));
  for (const [raw, count] of after) {
    if (count > (before.get(raw) ?? 0)) fail('remote-image-refused', 'an image would load from another site', { path: file.path });
  }
}

/**
 * Check one bundle against the base tree it is pinned to.
 *   git: bundleGit(checkout); head: the publication branch head now;
 *   readAsset(path, binding) -> image bytes; maxSourceBytes: the vault limit.
 * Returns { bundle, base, tree, candidates, publicAdditions, images }.
 */
export async function checkPageBundle({ bundle: input, git, head, readAsset, maxSourceBytes }) {
  const bundle = validatePageBundle(input);
  const base = bundle.source.revision;
  if (head !== base) fail('capture-base-moved', 'the vault changed since this was prepared; send it again');
  const tree = await readBaseTree(git, base);
  const baseKeys = caseKeys(tree);
  for (const file of bundle.files) {
    checkPath(file);
    checkPlacement(file, tree, baseKeys);
    if (file.kind === 'create' && file.candidate.byteLength > maxSourceBytes) fail('capture-too-large', 'the note is larger than this vault accepts');
  }
  const modifyBases = new Map();
  for (const file of bundle.files.filter((entry) => entry.kind === 'modify')) {
    const blobs = await readBlobs(git, [tree.get(file.path).oid]);
    modifyBases.set(file.path, blobs.get(tree.get(file.path).oid));
  }
  let candidates;
  try {
    candidates = await bundleCandidates(bundle, {
      readBase: (p) => modifyBases.get(p),
      readAsset: async (p, binding) => {
        const bytes = await readAsset(p, binding);
        if (!(bytes instanceof Uint8Array)) fail('asset-type-refused', 'the image was not received', { path: p });
        return bytes;
      },
    });
  } catch (error) {
    if (BUNDLE_CODES.includes(error?.code)) throw error;
    fail('capture-base-unavailable', 'the bundle does not match the vault', { reason: error?.code ?? 'unknown' });
  }

  const images = [];
  for (const file of bundle.files) {
    const bytes = candidates.get(file.path);
    if (file.kind === 'create-asset') {
      const verdict = checkAsset(file.path, bytes);
      if (!verdict.ok) fail(verdict.code, 'this image cannot be added', { path: file.path });
      if (verdict.mediaType !== file.mediaType) fail('asset-type-mismatch', 'the image type does not match its name', { path: file.path });
      images.push({ path: file.path, mediaType: file.mediaType, byteLength: bytes.length });
    } else {
      checkRemoteImages(file, bytes, file.kind === 'modify' ? modifyBases.get(file.path) : null);
    }
  }

  // The public set before and after, on the whole tree.
  const view = await selectorView(git, tree);
  const publishYml = view['publish.yml'] ?? null;
  const before = selectTree(view, publishYml);
  const afterView = { ...view };
  for (const file of bundle.files) afterView[file.path] = isMarkdown(file.path) ? decoder.decode(candidates.get(file.path)) : null;
  const after = selectTree(afterView, publishYml);
  const beforeSet = new Set(before.published);
  const afterSet = new Set(after.published);
  const created = new Set(bundle.files.filter((file) => file.kind !== 'modify').map((file) => file.path));
  const pages = bundle.files.filter((file) => file.kind !== 'create-asset').map((file) => file.path);

  for (const file of bundle.files) {
    if (file.kind === 'create' && !afterSet.has(file.path)) {
      const denied = after.report.denied.find((entry) => entry.path === file.path);
      fail('create-outside-publication', 'this new note would not be on your site, so it is not sent', { path: file.path, rule: denied?.rule ?? null });
    }
    if (file.kind === 'modify' && (!beforeSet.has(file.path) || !afterSet.has(file.path))) {
      fail('create-outside-publication', 'the edited note is not on your site', { path: file.path });
    }
    if (file.kind === 'create-asset') {
      const reached = after.report.assets.find((entry) => entry.path === file.path);
      if (!reached || !reached.referencedBy.some((ref) => pages.includes(ref.source))) {
        fail('asset-unreferenced', 'no page in this change shows this image', { path: file.path });
      }
    }
  }
  const removed = before.published.filter((source) => !afterSet.has(source));
  if (removed.length > 0) fail('public-set-removal-refused', 'this change would take pages off your site', { removed: removed.slice(0, 20) });
  const unlisted = after.published.filter((source) => !beforeSet.has(source) && !created.has(source));
  if (unlisted.length > 0) fail('public-set-change-unlisted', 'this change would publish files it does not add', { added: unlisted.slice(0, 20) });

  const beforeAddresses = addresses(before);
  const afterAddresses = addresses(after);
  for (const [source, address] of beforeAddresses) {
    if (afterAddresses.get(source) !== address) fail('address-changed', 'this change would move a page to another address', { path: source });
  }
  const taken = new Map();
  for (const [source, address] of afterAddresses) {
    if (created.has(source)) continue;
    taken.set(slugKey(address, true), source);
  }
  for (const source of created) {
    if (!afterAddresses.has(source)) continue;
    const key = slugKey(afterAddresses.get(source), true);
    if (taken.has(key)) fail('create-address-collision', 'another page already uses this address', { path: source, existing: taken.get(source) ?? taken.get(key) });
    taken.set(key, source);
  }

  const publicAdditions = bundle.files.filter((file) => file.kind === 'create')
    .map((file) => ({ path: file.path, address: publicAddress(file.path, after.report.slugs[file.path] ?? null) }));
  return Object.freeze({ bundle, base, tree, candidates, publicAdditions, images });
}

/**
 * The bundle's commit, from Git objects alone: base tree in a private index,
 * new and changed blobs added, one parent equal to the base. Returns the
 * commit ID. Moves no ref, touches no working tree.
 */
export async function buildBundleCommit({ git, checked, message, author, committer = author, time }) {
  if (typeof message !== 'string' || !message.endsWith('\n') || message.length > 4000) throw new TypeError('commit message must end with a newline');
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'cyberbaser-bundle-'));
  const env = { GIT_INDEX_FILE: path.join(scratch, 'index') };
  try {
    await git(['read-tree', checked.base], { env });
    for (const file of checked.bundle.files) {
      const oid = (await git(['hash-object', '-w', '--stdin'], { input: checked.candidates.get(file.path) })).toString('utf8').trim();
      if (!OID.test(oid)) throw new Error('hash-object');
      const mode = file.kind === 'modify' ? checked.tree.get(file.path).mode : '100644';
      await git(['update-index', '--add', '--cacheinfo', `${mode},${oid},${file.path}`], { env });
    }
    const tree = (await git(['write-tree'], { env })).toString('utf8').trim();
    const stamp = `${time} +0000`;
    const commit = (await git(['commit-tree', tree, '-p', checked.base, '-F', '-'], { input: message, env: {
      GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email, GIT_AUTHOR_DATE: stamp,
      GIT_COMMITTER_NAME: committer.name, GIT_COMMITTER_EMAIL: committer.email, GIT_COMMITTER_DATE: stamp,
    } })).toString('utf8').trim();
    if (!OID.test(commit)) throw new Error('commit-tree');
    return commit;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** A plain commit message for a bundle: what it adds, in one line. */
export function bundleCommitMessage(checked) {
  const notes = checked.publicAdditions.map((entry) => entry.path);
  const edited = checked.bundle.files.filter((file) => file.kind === 'modify').map((file) => file.path);
  const subject = notes.length > 0 ? `Add ${notes.map((p) => p.split('/').at(-1).replace(/\.md$/iu, '')).join(', ')}` : `Edit ${edited[0]}`;
  const images = checked.images.length === 0 ? '' : ` with ${checked.images.length} image${checked.images.length === 1 ? '' : 's'}`;
  return `${subject.slice(0, 200)}${images}\n`;
}

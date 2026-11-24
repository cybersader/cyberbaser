// A page bundle: one main note (new or edited), at most one new folder note,
// and a few new images, bound to one pinned base commit (design: new notes and
// images through the gate, 2026-11-24).
//
// Every file is either an exact splice of an existing file (`modify`, the same
// operations as a v2 change set) or a create-once file (`create` for Markdown,
// `create-asset` for an image). Created text travels inside the artifact;
// image bytes do not (they exceed every carrier and queue limit) and are bound
// by length and SHA-256 instead, then supplied separately for verification.
//
// This is its own artifact type and schema version, so a consumer that knows
// only the one-file change set refuses a bundle instead of reading files[0].
import { createHash } from 'node:crypto';
import {
  ProposalError, requireExactKeys, requireProposalId, requireSafeInteger, requireDigest,
  normalizeSubmission, decodeUtf8, utf8Bytes, deepFreeze,
} from './proposal.js';
import { CHANGE_SET_MAX_FILE_BYTES, constructCandidate, normalizeOperations } from './change-set.js';

export const PAGE_BUNDLE_SCHEMA_VERSION = 3;
export const PAGE_BUNDLE_ARTIFACT_TYPE = 'cyberbaser-page-bundle';
export const PAGE_BUNDLE_LIMITS = Object.freeze({
  maxModify: 1,
  maxCreate: 2,
  maxAssets: 4,
  maxAssetBytes: 5 * 1024 * 1024,
  maxBundleBytes: 12 * 1024 * 1024,
  maxNoteBytes: CHANGE_SET_MAX_FILE_BYTES,
  maxArtifactBytes: 6 * 1024 * 1024,
  maxPathBytes: 1024,
});
export const BUNDLE_KINDS = Object.freeze(['modify', 'create', 'create-asset']);
export const ASSET_MEDIA_TYPES = Object.freeze({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' });

const TOP_KEYS = ['schemaVersion', 'artifactType', 'bundleId', 'source', 'files', 'submission'];
const KEYS = Object.freeze({
  modify: ['path', 'kind', 'base', 'operations', 'candidate'],
  create: ['path', 'kind', 'text', 'candidate'],
  'create-asset': ['path', 'kind', 'mediaType', 'candidate'],
});
const fail = (code, message) => { throw new ProposalError(code, message); };
const hash = (bytes) => `sha-256=:${createHash('sha256').update(bytes).digest('base64')}:`;
const canonical = (value) => `${JSON.stringify(value)}\n`;
const extension = (path) => {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
};
const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** Repository-relative POSIX path with no empty, dot, `..`, control or backslash segment. */
export function requireBundlePath(value) {
  if (typeof value !== 'string' || value.length === 0 || /[\p{Cc}\p{Cs}]/u.test(value)) fail('create-path-refused', 'path must be plain text');
  utf8Bytes(value, 'path', { nonEmpty: true, maxBytes: PAGE_BUNDLE_LIMITS.maxPathBytes, rejectControls: true });
  if (value.normalize('NFC') !== value || value.startsWith('/') || /[\\\p{Cc}\p{Cs}\u2028\u2029]/u.test(value)) {
    fail('create-path-refused', 'path must be a normalized repository-relative POSIX path');
  }
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    fail('create-path-refused', 'path contains an empty, dot or parent segment');
  }
  return value;
}

function binding(value, label, max) {
  requireExactKeys(value, ['byteLength', 'digest'], label);
  const byteLength = requireSafeInteger(value.byteLength, `${label}.byteLength`);
  if (byteLength > max) fail(max === PAGE_BUNDLE_LIMITS.maxAssetBytes ? 'asset-too-large' : 'file-too-large', `${label} is too large`);
  return { byteLength, digest: requireDigest(value.digest, `${label}.digest`) };
}

function normalizeFile(value) {
  if (value === null || typeof value !== 'object' || !BUNDLE_KINDS.includes(value.kind)) fail('invalid-file-kind', 'file kind must be modify, create or create-asset');
  requireExactKeys(value, KEYS[value.kind], `bundle ${value.kind}`);
  const path = requireBundlePath(value.path);
  if (value.kind === 'modify') {
    if (extension(path) !== 'md') fail('invalid-source-path', 'only Markdown files can be modified');
    const base = binding(value.base, 'base', CHANGE_SET_MAX_FILE_BYTES);
    const { operations, candidateLength } = normalizeOperations(value.operations, base.byteLength);
    const candidate = binding(value.candidate, 'candidate', CHANGE_SET_MAX_FILE_BYTES);
    if (candidate.byteLength !== candidateLength) fail('candidate-length-mismatch', 'candidate length does not match the declared operations');
    if (candidate.digest === base.digest) fail('no-op-proposal', 'a modified file must change');
    return { path, kind: 'modify', base, operations, candidate };
  }
  if (value.kind === 'create') {
    if (extension(path) !== 'md') fail('create-path-refused', 'a created note must be a .md file');
    const bytes = utf8Bytes(value.text, 'create.text', { maxBytes: PAGE_BUNDLE_LIMITS.maxNoteBytes });
    if (bytes.length === 0) fail('create-empty', 'a created note must not be empty');
    if (value.text.startsWith('\uFEFF')) fail('utf8-bom', 'a created note must not begin with a BOM');
    const candidate = binding(value.candidate, 'candidate', PAGE_BUNDLE_LIMITS.maxNoteBytes);
    if (candidate.byteLength !== bytes.length || candidate.digest !== hash(bytes)) fail('candidate-digest-mismatch', 'created text does not match its binding');
    return { path, kind: 'create', text: value.text, candidate };
  }
  const expected = ASSET_MEDIA_TYPES[extension(path)];
  if (expected === undefined) fail('asset-type-refused', 'only PNG, JPEG, WebP and GIF images can be added');
  if (typeof value.mediaType !== 'string' || !Object.values(ASSET_MEDIA_TYPES).includes(value.mediaType)) fail('asset-type-refused', 'unsupported media type');
  if (value.mediaType !== expected) fail('asset-type-mismatch', 'media type does not match the file name');
  const candidate = binding(value.candidate, 'candidate', PAGE_BUNDLE_LIMITS.maxAssetBytes);
  if (candidate.byteLength === 0) fail('asset-type-refused', 'an image must not be empty');
  return { path, kind: 'create-asset', mediaType: value.mediaType, candidate };
}

// Folder notes, by the rule of packages/publish/src/addresses.js
// (isFolderNotePath, lowercase-hyphen): a note named "index", or named like
// its folder when both are compared as address segments. Kept here so this
// contract stays free of other packages; a test pins it to addresses.js.
const addressSegment = (name) => String(name).normalize('NFC').normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase()
  .replace(/&/gu, ' and ').replace(/%/gu, ' percent ').replace(/['‘’`]/gu, '')
  .replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/gu, '');

/** Is this note path a folder note ("X/index.md" or "X/X.md")? */
export function isFolderNoteFile(notePath) {
  const parts = notePath.split('/');
  const file = parts.pop();
  if (!/\.md$/iu.test(file)) return false;
  const stem = addressSegment(file.slice(0, -3));
  if (stem === 'index') return true;
  return parts.length > 0 && stem !== '' && stem === addressSegment(parts.at(-1));
}

/** The folder a note is filed in: its own folder, or for a folder note the folder around it. */
const containerOf = (notePath) => (isFolderNoteFile(notePath) ? dirOf(dirOf(notePath)) : dirOf(notePath));
const isFolderNoteOf = (notePath, folder) => isFolderNoteFile(notePath) && dirOf(notePath) === folder;

function normalizeFiles(values) {
  if (!Array.isArray(values) || values.length === 0) fail('bundle-file-count', 'a bundle needs at least one file');
  const files = [];
  for (const value of values) files.push(normalizeFile(value));
  const count = (kind) => files.filter((file) => file.kind === kind).length;
  if (count('modify') > PAGE_BUNDLE_LIMITS.maxModify || count('create') > PAGE_BUNDLE_LIMITS.maxCreate
    || count('create-asset') > PAGE_BUNDLE_LIMITS.maxAssets) fail('bundle-file-count', 'at most 1 edited note, 2 new notes and 4 images');
  if (count('modify') + count('create') === 0) fail('bundle-file-count', 'a bundle needs a page');
  for (let i = 1; i < files.length; i += 1) {
    if (!(files[i - 1].path < files[i].path)) fail('noncanonical-order', 'files must be sorted by path and unique');
  }
  const paths = new Set(files.map((file) => file.path));
  for (const file of files) {
    const segments = file.path.split('/');
    for (let i = 1; i < segments.length; i += 1) {
      if (paths.has(segments.slice(0, i).join('/'))) fail('create-parent-is-file', 'a path in the bundle is the parent of another');
    }
  }
  // Two new notes only as a note plus the new folder note of the folder it
  // sits in, in either form: "a/x.md" + "a/index.md", or a note that is its
  // own folder's note ("Topic/Post/Post.md") + "Topic/Topic.md" (or
  // "Topic/index.md").
  const creates = files.filter((file) => file.kind === 'create');
  if (creates.length === 2) {
    const [a, b] = creates.map((file) => file.path);
    if (!(isFolderNoteOf(a, containerOf(b)) || isFolderNoteOf(b, containerOf(a)))) {
      fail('bundle-file-count', 'a second new note must be the folder note of the first note\'s folder');
    }
  }
  const total = files.reduce((sum, file) => sum + file.candidate.byteLength, 0);
  if (total > PAGE_BUNDLE_LIMITS.maxBundleBytes) fail('bundle-too-large', 'the bundle exceeds 12 MiB');
  return files;
}

function normalizeBundleSource(value) {
  requireExactKeys(value, ['repository', 'revision'], 'source');
  utf8Bytes(value.repository, 'source.repository', { nonEmpty: true, maxBytes: 2048, rejectControls: true });
  if (typeof value.revision !== 'string' || !/^[0-9a-f]{40}$/u.test(value.revision)) fail('invalid-source-revision', 'source.revision must be one commit ID');
  return { repository: value.repository, revision: value.revision };
}

export function validatePageBundle(value) {
  requireExactKeys(value, TOP_KEYS, 'page bundle');
  if (value.schemaVersion !== PAGE_BUNDLE_SCHEMA_VERSION) fail('unsupported-schema', 'expected page bundle schemaVersion 3');
  if (value.artifactType !== PAGE_BUNDLE_ARTIFACT_TYPE) fail('invalid-artifact-type', 'expected cyberbaser-page-bundle');
  const bundle = {
    schemaVersion: PAGE_BUNDLE_SCHEMA_VERSION,
    artifactType: PAGE_BUNDLE_ARTIFACT_TYPE,
    bundleId: requireProposalId(value.bundleId),
    source: normalizeBundleSource(value.source),
    files: normalizeFiles(value.files),
    submission: normalizeSubmission(value.submission),
  };
  if (Buffer.byteLength(canonical(bundle)) > PAGE_BUNDLE_LIMITS.maxArtifactBytes) fail('proposal-too-large', 'the bundle artifact is too large');
  return deepFreeze(bundle);
}

export function serializePageBundle(value) {
  return canonical(validatePageBundle(value));
}

export function pageBundleDigest(value) {
  return hash(Buffer.from(serializePageBundle(value)));
}

export function parsePageBundle(text) {
  if (typeof text !== 'string' && !(text instanceof Uint8Array)) fail('invalid-bytes', 'bundle must be text');
  const bytes = typeof text === 'string' ? Buffer.from(text) : Buffer.from(text);
  if (bytes.length > PAGE_BUNDLE_LIMITS.maxArtifactBytes) fail('proposal-too-large', 'the bundle artifact is too large');
  const decoded = decodeUtf8(bytes, 'bundle');
  let value;
  try { value = JSON.parse(decoded); } catch { fail('malformed-json', 'bundle is not valid JSON'); }
  const bundle = validatePageBundle(value);
  if (canonical(bundle) !== decoded) fail('noncanonical-proposal', 'bundle requires compact fixed-order JSON and one final LF');
  return bundle;
}

/**
 * Input: { bundleId, source: {repository, revision}, submission,
 *   modify?: { path, baseBytes, operations },
 *   creates: [{ path, text }], assets: [{ path, mediaType, bytes }] }.
 */
export function createPageBundle(input) {
  requireExactKeys(input, ['bundleId', 'source', 'submission', 'modify', 'creates', 'assets'], 'page bundle input');
  const files = [];
  if (input.modify !== null) {
    requireExactKeys(input.modify, ['path', 'baseBytes', 'operations'], 'modify input');
    const base = Buffer.from(input.modify.baseBytes);
    const { operations } = normalizeOperations(input.modify.operations, base.length);
    const candidate = constructCandidate(base, operations);
    files.push({ path: input.modify.path, kind: 'modify', base: { byteLength: base.length, digest: hash(base) }, operations,
      candidate: { byteLength: candidate.length, digest: hash(candidate) } });
  }
  for (const create of input.creates) {
    const bytes = Buffer.from(String(create.text), 'utf8');
    files.push({ path: create.path, kind: 'create', text: create.text, candidate: { byteLength: bytes.length, digest: hash(bytes) } });
  }
  for (const asset of input.assets) {
    const bytes = Buffer.from(asset.bytes);
    files.push({ path: asset.path, kind: 'create-asset', mediaType: asset.mediaType, candidate: { byteLength: bytes.length, digest: hash(bytes) } });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return validatePageBundle({ schemaVersion: PAGE_BUNDLE_SCHEMA_VERSION, artifactType: PAGE_BUNDLE_ARTIFACT_TYPE,
    bundleId: input.bundleId, source: input.source, files, submission: input.submission });
}

/**
 * The exact bytes of every file after the bundle, checked against its
 * bindings. readBase(path) -> bytes of the file at the pinned base (modify
 * only); readAsset(path, binding) -> the image bytes. Returns Map path -> Buffer.
 */
export async function bundleCandidates(value, { readBase, readAsset }) {
  const bundle = validatePageBundle(value);
  const out = new Map();
  for (const file of bundle.files) {
    let bytes;
    if (file.kind === 'create') bytes = Buffer.from(file.text, 'utf8');
    else if (file.kind === 'create-asset') {
      bytes = Buffer.from(await readAsset(file.path, file.candidate));
    } else {
      const base = Buffer.from(await readBase(file.path));
      if (base.length !== file.base.byteLength || hash(base) !== file.base.digest) fail('base-digest-mismatch', 'base bytes do not match');
      decodeUtf8(base, 'base');
      bytes = constructCandidate(base, file.operations);
    }
    if (bytes.length !== file.candidate.byteLength || hash(bytes) !== file.candidate.digest) {
      fail('candidate-digest-mismatch', `${file.path} does not match its binding`);
    }
    out.set(file.path, bytes);
  }
  return out;
}

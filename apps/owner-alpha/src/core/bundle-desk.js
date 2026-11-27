// Where page bundles wait on the node: images arriving in chunks, bundles a
// propose-only device or agent sent for the owner's review, and bundles whose
// commit waits for the owner's signature.
//
//   review    sent by a device that may only propose; the owner looks at it on
//             the node's review page and approves or declines it there.
//   signing   its commit is built and offered to the owner's signing device;
//             only that signature, checked by the publisher, publishes it.
//   published / declined / stale   final.
//
// Nothing here can publish. The publisher re-checks every commit against the
// signed intent and its own bundle rules (publisher/bundle-publish.js).
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { deriveContiguousCorrection } from '../../../../packages/correction/src/index.js';
import { ASSET_MEDIA_TYPES, createPageBundle, PAGE_BUNDLE_LIMITS, parsePageBundle, serializePageBundle } from '../../../../packages/proposal/src/page-bundle.js';
import { fail, OwnerAlphaError } from '../errors.js';
import { isPlainObject } from '../json.js';
import { spellWorkspaceCandidate } from '../owner-publication.js';
import { buildBundleCommit, bundleCommitMessage, checkPageBundle, readBaseTree, readBlobs } from './page-bundle.js';

export const ASSET_CHUNK_BYTES = 256 * 1024;
export const STAGING_TTL_MS = 15 * 60_000;
const BUNDLE_ID = /^bundle-[0-9a-f-]{36}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const B64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const STATES = Object.freeze(['review', 'signing', 'published', 'declined', 'stale']);

const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');
const digestOf = (bytes) => `sha-256=:${createHash('sha256').update(bytes).digest('base64')}:`;
const extension = (p) => p.slice(p.lastIndexOf('.') + 1).toLowerCase();

/**
 * Images sent in chunks, held in memory per device until a bundle uses them.
 * stage({ keyId, sha256, size, offset, data }) -> { received, complete }.
 */
export function createAssetStaging({ clock = Date.now, maxPerKey = PAGE_BUNDLE_LIMITS.maxAssets, maxKeys = 4 } = {}) {
  const byKey = new Map(); // keyId -> Map sha256 -> { size, parts, received, touched }
  const sweep = () => {
    const now = clock();
    for (const [keyId, assets] of byKey) {
      for (const [sha, entry] of assets) if (now - entry.touched > STAGING_TTL_MS) assets.delete(sha);
      if (assets.size === 0) byKey.delete(keyId);
    }
  };
  return Object.freeze({
    stage({ keyId, sha256, size, offset, data }) {
      sweep();
      if (!SHA256.test(sha256 ?? '') || !Number.isSafeInteger(size) || size < 1 || size > PAGE_BUNDLE_LIMITS.maxAssetBytes) {
        fail('asset-too-large', 'an image may be at most 5 MiB');
      }
      if (typeof data !== 'string' || !B64.test(data)) fail('invalid-command-input', 'data must be base64');
      const bytes = Buffer.from(data, 'base64');
      if (bytes.length === 0 || bytes.length > ASSET_CHUNK_BYTES) fail('invalid-command-input', 'a chunk is 1 byte to 256 KiB');
      let assets = byKey.get(keyId);
      if (!assets) {
        if (byKey.size >= maxKeys) fail('proposal-budget-exhausted', 'too many images are arriving');
        assets = new Map();
        byKey.set(keyId, assets);
      }
      let entry = assets.get(sha256);
      if (!entry) {
        if (offset !== 0) fail('invalid-command-input', 'an image starts at offset 0');
        if (assets.size >= maxPerKey) fail('bundle-too-large', 'at most 4 images at a time');
        entry = { size, parts: [], received: 0, touched: clock() };
        assets.set(sha256, entry);
      }
      if (entry.size !== size || offset !== entry.received) fail('invalid-command-input', 'chunks must arrive in order');
      if (entry.received + bytes.length > size) fail('asset-too-large', 'more bytes than announced');
      entry.parts.push(bytes);
      entry.received += bytes.length;
      entry.touched = clock();
      const complete = entry.received === size;
      if (complete && sha256Hex(Buffer.concat(entry.parts)) !== sha256) {
        assets.delete(sha256);
        fail('invalid-command-input', 'the image does not match its SHA-256');
      }
      return { received: entry.received, complete };
    },
    /** The complete image, or null. */
    take(keyId, sha256) {
      sweep();
      const entry = byKey.get(keyId)?.get(sha256);
      if (!entry || entry.received !== entry.size) return null;
      return Buffer.concat(entry.parts);
    },
    release(keyId, sha256) { byKey.get(keyId)?.delete(sha256); },
  });
}

function textInput(value, label, maxBytes) {
  if (!isPlainObject(value) || Object.keys(value).sort().join(',') !== 'path,text') fail('invalid-command-input', `${label} needs path and text`);
  if (typeof value.path !== 'string' || value.path.length > 1024 || !/\.md$/u.test(value.path)) fail('create-path-refused', `${label} must be a .md path`);
  if (typeof value.text !== 'string' || Buffer.byteLength(value.text) > maxBytes) fail('capture-too-large', 'the note is larger than this vault accepts');
  return { path: value.path, text: value.text };
}

/** { main: {path, text}, folderIndex?: {path, text}, assets: [{path, sha256}] } */
export function validateBundleInput(input, maxSourceBytes) {
  if (!isPlainObject(input)) fail('invalid-command-input', 'a page bundle needs main and assets');
  const keys = Object.keys(input).sort();
  if (!['assets,main', 'assets,folderIndex,main'].includes(keys.join(','))) fail('invalid-command-input', 'a page bundle accepts main, folderIndex and assets');
  const main = textInput(input.main, 'main', maxSourceBytes);
  const folderIndex = input.folderIndex === undefined ? null : textInput(input.folderIndex, 'folderIndex', maxSourceBytes);
  if (!Array.isArray(input.assets) || input.assets.length > PAGE_BUNDLE_LIMITS.maxAssets) fail('bundle-file-count', 'at most 4 images');
  const assets = input.assets.map((asset) => {
    if (!isPlainObject(asset) || Object.keys(asset).sort().join(',') !== 'path,sha256' || typeof asset.path !== 'string'
      || asset.path.length > 1024 || !SHA256.test(asset.sha256 ?? '')) fail('invalid-command-input', 'each image needs path and sha256');
    if (ASSET_MEDIA_TYPES[extension(asset.path)] === undefined) fail('asset-type-refused', 'only PNG, JPEG, WebP and GIF images can be added');
    return { path: asset.path, sha256: asset.sha256 };
  });
  return { main, folderIndex, assets };
}

/**
 * The desk. git: bundleGit(checkout); branchHead() -> commit;
 * store: directory for bundle records (owner-only, outside the vault).
 */
export async function openBundleDesk({ config, git, branchHead, directory, staging = createAssetStaging(), clock = Date.now,
  author = null }) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = (bundleId) => path.join(directory, `${bundleId}.json`);
  const maxSourceBytes = config.limits.maxSourceBytes;

  async function save(record) {
    if (!BUNDLE_ID.test(record.bundleId) || !STATES.includes(record.state)) throw new TypeError('invalid bundle record');
    const target = file(record.bundleId);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, target);
    return record;
  }

  async function load(bundleId) {
    if (typeof bundleId !== 'string' || !BUNDLE_ID.test(bundleId)) fail('bundle-not-found', 'no such bundle');
    let record;
    try { record = JSON.parse(await readFile(file(bundleId), 'utf8')); } catch { fail('bundle-not-found', 'no such bundle'); }
    if (record?.v !== 1 || record.bundleId !== bundleId || !STATES.includes(record.state)) fail('bundle-not-found', 'no such bundle');
    return record;
  }

  // Image bytes from the node's own object store, checked against the record.
  async function assetReader(record) {
    const blobs = await readBlobs(git, Object.values(record.assets), 6 * PAGE_BUNDLE_LIMITS.maxAssetBytes);
    return async (p, binding) => {
      const bytes = blobs.get(record.assets[p]);
      if (!bytes || bytes.length !== binding.byteLength || digestOf(bytes) !== binding.digest) fail('asset-type-refused', 'the stored image is missing or changed');
      return bytes;
    };
  }

  async function checkRecord(record) {
    const bundle = parsePageBundle(record.bundleText);
    return checkPageBundle({ bundle, git, head: await branchHead(), readAsset: await assetReader(record), maxSourceBytes });
  }

  async function commitFor(record, checked) {
    const who = author ?? { name: 'Cyberbaser', email: 'owner@cyberbaser.invalid' };
    const commit = await buildBundleCommit({ git, checked, message: bundleCommitMessage(checked), author: who,
      time: Math.floor(clock() / 1000) });
    return save({ ...record, state: 'signing', commit, publicAdditions: checked.publicAdditions, images: checked.images, updatedAt: clock() });
  }

  async function build(input, principal) {
    const request = validateBundleInput(input, maxSourceBytes);
    const base = await branchHead();
    const tree = await readBaseTree(git, base);
    const assets = request.assets.map((asset) => {
      const bytes = staging.take(principal.keyId, asset.sha256);
      if (bytes === null) fail('asset-type-refused', 'the image did not arrive; send it again', { path: asset.path });
      return { path: asset.path, mediaType: ASSET_MEDIA_TYPES[extension(asset.path)], bytes };
    });
    const creates = [];
    let modify = null;
    for (const note of [request.main, request.folderIndex].filter(Boolean)) {
      const entry = tree.get(note.path);
      if (entry === undefined || note === request.folderIndex) { creates.push(note); continue; }
      if (entry.type !== 'blob') fail('create-parent-is-file', 'this path is a folder in the vault');
      const baseBytes = (await readBlobs(git, [entry.oid])).get(entry.oid);
      let text;
      try { text = spellWorkspaceCandidate(baseBytes, note.text); } catch { fail('delivery-not-round-trippable', 'the note cannot be matched to the vault text exactly'); }
      if (Buffer.from(text).equals(baseBytes)) continue;
      const change = deriveContiguousCorrection(baseBytes, text);
      modify = { path: note.path, baseBytes, operations: [{ operationId: 'device-edit', start: change.start, end: change.end,
        expected: change.expectedOldBytes.toString('utf8'), replacement: change.replacementBytes.toString('utf8') }] };
    }
    if (creates.length === 0 && modify === null) return null;
    const at = clock();
    const bundle = createPageBundle({ bundleId: `bundle-${randomUUID()}`, modify, creates, assets,
      source: { repository: config.repository.remote.url, revision: base },
      submission: { submittedAt: new Date(at).toISOString().replace(/\.\d{3}Z$/u, 'Z'),
        rationale: 'A new page sent from a paired device.', evidence: [], identityClaim: null } });
    const byPath = new Map(assets.map((asset) => [asset.path, asset.bytes]));
    const checked = await checkPageBundle({ bundle, git, head: await branchHead(), maxSourceBytes,
      readAsset: (p) => byPath.get(p) });
    // Only checked images enter the object store, as loose blobs no ref names.
    const stored = {};
    for (const asset of assets) {
      stored[asset.path] = (await git(['hash-object', '-w', '--stdin'], { input: asset.bytes })).toString('utf8').trim();
      staging.release(principal.keyId, sha256Hex(asset.bytes));
    }
    return { bundle, checked, stored, at };
  }

  return Object.freeze({
    staging,

    /**
     * mode 'owner': an owner device allowed to publish; the commit goes
     * straight to its signature. mode 'propose': waits for the owner's review.
     */
    async submit(input, principal, mode) {
      const built = await build(input, principal);
      if (built === null) return { unchanged: true };
      const { bundle, checked, stored, at } = built;
      const submitter = { kind: principal.actor.kind, id: principal.actor.id, label: principal.actor.label, keyId: principal.keyId };
      const record = await save({ v: 1, bundleId: bundle.bundleId, state: 'review', bundleText: serializePageBundle(bundle),
        assets: stored, submitter, receivedAt: at, updatedAt: at, commit: null, publicAdditions: checked.publicAdditions,
        images: checked.images, reason: null });
      if (mode !== 'owner') return { bundleId: record.bundleId, state: 'review', publicAdditions: record.publicAdditions };
      const signing = await commitFor(record, checked);
      return { bundleId: signing.bundleId, state: 'signing', publicAdditions: signing.publicAdditions };
    },

    load,

    async list(states = STATES) {
      const names = (await readdir(directory)).filter((name) => /^bundle-[0-9a-f-]{36}\.json$/u.test(name)).sort();
      const out = [];
      for (const name of names) {
        try {
          const record = await load(name.slice(0, -5));
          if (states.includes(record.state)) out.push(record);
        } catch { /* skip unreadable */ }
      }
      return out;
    },

    /** The owner approves a reviewed bundle on the node: checked again, then its commit waits for the signature. */
    async approve(bundleId) {
      const record = await load(bundleId);
      if (record.state !== 'review') fail('bundle-not-reviewable', 'this bundle is not waiting for review');
      let checked;
      try { checked = await checkRecord(record); } catch (error) {
        if (error instanceof OwnerAlphaError && error.code === 'capture-base-moved') await save({ ...record, state: 'stale', reason: error.code, updatedAt: clock() });
        throw error;
      }
      const signing = await commitFor(record, checked);
      return { bundleId, state: signing.state, publicAdditions: signing.publicAdditions };
    },

    async decline(bundleId, reason = 'declined') {
      const record = await load(bundleId);
      if (!['review', 'signing'].includes(record.state)) fail('bundle-not-reviewable', 'this bundle is already decided');
      await save({ ...record, state: 'declined', reason, updatedAt: clock() });
      return { bundleId, state: 'declined' };
    },

    /**
     * The device that sent a bundle takes it back before it is signed. Only
     * that device (its pairing key), only while it waits for review or for the
     * signature. A withdrawn bundle is final: never offered, never pushed.
     */
    async withdraw(bundleId, keyId) {
      const record = await load(bundleId);
      if (typeof keyId !== 'string' || record.submitter?.keyId !== keyId) fail('bundle-not-found', 'no such bundle');
      if (record.state === 'declined' && record.reason === 'withdrawn') return { bundleId, state: 'withdrawn' };
      if (!['review', 'signing'].includes(record.state)) fail('bundle-not-reviewable', 'this bundle is already decided');
      await save({ ...record, state: 'declined', reason: 'withdrawn', updatedAt: clock() });
      return { bundleId, state: 'withdrawn' };
    },

    // pushed: the publisher's answer ({ commit, branch, receipt }), kept so a
    // restart can still record the bundle's job (job-approvals.js).
    async markPublished(bundleId, commit, pushed = null) {
      const record = await load(bundleId);
      if (record.state !== 'signing' || record.commit !== commit) fail('bundle-not-reviewable', 'this bundle is not waiting for its signature');
      const kept = isPlainObject(pushed) && pushed.commit === commit
        ? { pushed: { commit, branch: pushed.branch, ...(pushed.receipt === undefined ? {} : { receipt: pushed.receipt }) } } : {};
      await save({ ...record, state: 'published', ...kept, updatedAt: clock() });
    },

    async markStale(bundleId, reason) {
      const record = await load(bundleId);
      if (['published', 'declined'].includes(record.state)) return;
      await save({ ...record, state: 'stale', reason, updatedAt: clock() });
    },

    /** The image bytes of one bundle file, for the review page; checked against the bundle. */
    async readImage(bundleId, imagePath) {
      const record = await load(bundleId);
      const bundle = parsePageBundle(record.bundleText);
      const file = bundle.files.find((entry) => entry.path === imagePath && entry.kind === 'create-asset');
      if (!file) fail('bundle-not-found', 'no such image');
      const read = await assetReader(record);
      return { bytes: await read(imagePath, file.candidate), mediaType: file.mediaType };
    },
  });
}

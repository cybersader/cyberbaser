import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  asBuffer,
  canonicalHttpsUrl,
  canonicalText,
  decodeUtf8,
  deepFreeze,
  DIGEST_RE,
  fail,
  PAGE_ID_RE,
  requireDigest,
  requireExactKeys,
  requireSafeInteger,
  requireSourcePath,
  requireString,
  sha256Digest,
  SOURCE_BINDING_ARTIFACT_TYPE,
  SOURCE_BINDING_MAX_BYTES,
  SOURCE_BINDING_MAX_PAGES,
  SOURCE_BINDING_SCHEMA_VERSION,
} from './contract.js';

const TOP_LEVEL_KEYS = [
  'schemaVersion',
  'artifactType',
  'source',
  'publication',
  'renderer',
  'trustPolicy',
  'pages',
];
const SOURCE_KEYS = ['repository', 'revision'];
const PUBLICATION_KEYS = ['publishPolicyDigest', 'selectedTreeDigest'];
const RENDERER_KEYS = ['name', 'revision'];
const TRUST_POLICY_KEYS = ['status', 'digest'];
const PAGE_KEYS = ['pageId', 'path', 'byteLength', 'digest'];
const PREPARE_KEYS = ['source', 'publication', 'renderer', 'trustPolicy', 'pages'];
const PREPARE_PAGE_KEYS = ['path', 'byteLength', 'digest'];
const REVISION_MAX_BYTES = 1024;
const RENDERER_NAME_MAX_BYTES = 128;

function lengthPrefixedTuple(values) {
  const parts = [];
  for (const value of values) {
    const bytes = Buffer.from(value, 'utf8');
    if (bytes.length > 0xffff_ffff) fail('page-id-input-too-large', 'page ID input is too large');
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.length);
    parts.push(length, bytes);
  }
  return Buffer.concat(parts);
}

function normalizeSource(value) {
  requireExactKeys(value, SOURCE_KEYS, 'source');
  return {
    repository: canonicalHttpsUrl(value.repository, 'source.repository', {
      repository: true,
      forbidQueryAndFragment: true,
    }),
    revision: requireString(value.revision, 'source.revision', {
      maxBytes: REVISION_MAX_BYTES,
      rejectControls: true,
    }),
  };
}

function normalizePublication(value) {
  requireExactKeys(value, PUBLICATION_KEYS, 'publication');
  return {
    publishPolicyDigest: requireDigest(
      value.publishPolicyDigest,
      'publication.publishPolicyDigest',
    ),
    selectedTreeDigest: requireDigest(
      value.selectedTreeDigest,
      'publication.selectedTreeDigest',
    ),
  };
}

function normalizeRenderer(value) {
  requireExactKeys(value, RENDERER_KEYS, 'renderer');
  return {
    name: requireString(value.name, 'renderer.name', {
      maxBytes: RENDERER_NAME_MAX_BYTES,
      rejectControls: true,
    }),
    revision: requireString(value.revision, 'renderer.revision', {
      maxBytes: REVISION_MAX_BYTES,
      rejectControls: true,
    }),
  };
}

function normalizeTrustPolicy(value) {
  requireExactKeys(value, TRUST_POLICY_KEYS, 'trustPolicy');
  if (!['valid', 'missing', 'malformed'].includes(value.status)) {
    fail('invalid-trust-policy-status', 'trustPolicy.status must be valid, missing, or malformed');
  }
  if (value.status === 'valid') {
    return { status: 'valid', digest: requireDigest(value.digest, 'trustPolicy.digest') };
  }
  if (value.digest !== null) {
    fail('invalid-trust-policy-evidence', 'missing or malformed trust policy must use null digest');
  }
  return { status: value.status, digest: null };
}

export function computePageId({ repository, revision, path: pagePath } = {}) {
  const source = normalizeSource({ repository, revision });
  const normalizedPath = requireSourcePath(pagePath, 'path');
  const digest = sha256Digest(lengthPrefixedTuple([
    'cyberbaser-page-v1',
    source.repository,
    source.revision,
    normalizedPath,
  ]));
  const encoded = digest.match(DIGEST_RE)[1];
  return `page-v1:${Buffer.from(encoded, 'base64').toString('base64url')}`;
}

function normalizePage(value, source, index) {
  requireExactKeys(value, PAGE_KEYS, `pages[${index}]`);
  if (typeof value.pageId !== 'string' || !PAGE_ID_RE.test(value.pageId)) {
    fail('invalid-page-id', `pages[${index}].pageId must be a canonical page-v1 identifier`);
  }
  const normalizedPath = requireSourcePath(value.path, `pages[${index}].path`);
  if (value.pageId !== computePageId({ ...source, path: normalizedPath })) {
    fail('page-id-mismatch', `pages[${index}].pageId does not match repository, revision, and path`);
  }
  return {
    pageId: value.pageId,
    path: normalizedPath,
    byteLength: requireSafeInteger(value.byteLength, `pages[${index}].byteLength`),
    digest: requireDigest(value.digest, `pages[${index}].digest`),
  };
}

function comparePaths(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function enforcePages(pages) {
  if (!Array.isArray(pages) || pages.length === 0 || pages.length > SOURCE_BINDING_MAX_PAGES) {
    fail('invalid-pages', `pages must contain 1-${SOURCE_BINDING_MAX_PAGES} entries`);
  }
  const paths = new Set();
  const ids = new Set();
  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index];
    if (paths.has(page.path)) fail('duplicate-source-path', 'pages contain a duplicate path');
    if (ids.has(page.pageId)) fail('duplicate-page-id', 'pages contain a duplicate pageId');
    if (index > 0 && comparePaths(pages[index - 1].path, page.path) >= 0) {
      fail('noncanonical-page-order', 'pages must be sorted by path in ascending UTF-8 byte order');
    }
    paths.add(page.path);
    ids.add(page.pageId);
  }
}

export function validateSourceBindingManifest(value) {
  requireExactKeys(value, TOP_LEVEL_KEYS, 'source binding manifest');
  if (value.schemaVersion !== SOURCE_BINDING_SCHEMA_VERSION) {
    fail('unsupported-schema', `unsupported source binding schemaVersion ${JSON.stringify(value.schemaVersion)}`);
  }
  if (value.artifactType !== SOURCE_BINDING_ARTIFACT_TYPE) {
    fail('invalid-artifact-type', `artifactType must be ${SOURCE_BINDING_ARTIFACT_TYPE}`);
  }
  const source = normalizeSource(value.source);
  const pages = Array.isArray(value.pages)
    ? value.pages.map((page, index) => normalizePage(page, source, index))
    : value.pages;
  enforcePages(pages);
  const normalized = {
    schemaVersion: SOURCE_BINDING_SCHEMA_VERSION,
    artifactType: SOURCE_BINDING_ARTIFACT_TYPE,
    source,
    publication: normalizePublication(value.publication),
    renderer: normalizeRenderer(value.renderer),
    trustPolicy: normalizeTrustPolicy(value.trustPolicy),
    pages,
  };
  const size = Buffer.byteLength(canonicalText(normalized), 'utf8');
  if (size > SOURCE_BINDING_MAX_BYTES) {
    fail('source-binding-too-large', `source binding manifest exceeds ${SOURCE_BINDING_MAX_BYTES} bytes`, {
      maximum: SOURCE_BINDING_MAX_BYTES,
      actual: size,
    });
  }
  return deepFreeze(normalized);
}

export function prepareSourceBindingManifest(input) {
  requireExactKeys(input, PREPARE_KEYS, 'source binding input');
  const source = normalizeSource(input.source);
  if (!Array.isArray(input.pages)) fail('invalid-pages', 'source binding input pages must be an array');
  const pages = input.pages.map((page, index) => {
    requireExactKeys(page, PREPARE_PAGE_KEYS, `source binding input pages[${index}]`);
    const normalizedPath = requireSourcePath(page.path, `source binding input pages[${index}].path`);
    return {
      pageId: computePageId({ ...source, path: normalizedPath }),
      path: normalizedPath,
      byteLength: page.byteLength,
      digest: page.digest,
    };
  }).sort((left, right) => comparePaths(left.path, right.path));
  return validateSourceBindingManifest({
    schemaVersion: SOURCE_BINDING_SCHEMA_VERSION,
    artifactType: SOURCE_BINDING_ARTIFACT_TYPE,
    source,
    publication: input.publication,
    renderer: input.renderer,
    trustPolicy: input.trustPolicy,
    pages,
  });
}

export function serializeSourceBindingManifest(value) {
  return canonicalText(validateSourceBindingManifest(value));
}

export function parseSourceBindingManifest(value) {
  const bytes = asBuffer(value, 'source binding manifest');
  if (bytes.length === 0) fail('empty-source-binding', 'source binding manifest must not be empty');
  if (bytes.length > SOURCE_BINDING_MAX_BYTES) {
    fail('source-binding-too-large', `source binding manifest exceeds ${SOURCE_BINDING_MAX_BYTES} bytes`);
  }
  const text = decodeUtf8(bytes, 'source binding manifest');
  if (text.startsWith('﻿')) fail('utf8-bom', 'source binding manifest must not begin with a UTF-8 BOM');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    fail('malformed-json', `source binding manifest is not valid JSON: ${error.message}`);
  }
  const manifest = validateSourceBindingManifest(parsed);
  if (text !== serializeSourceBindingManifest(manifest)) {
    fail('noncanonical-source-binding', 'source binding manifest must use fixed-order compact JSON followed by one LF');
  }
  return manifest;
}

export function sourceBindingDigest(value) {
  return sha256Digest(Buffer.from(serializeSourceBindingManifest(value), 'utf8'));
}

export function retainedManifestFilename(bindingDigest) {
  const digest = requireDigest(bindingDigest, 'bindingDigest');
  const encoded = digest.match(DIGEST_RE)[1];
  return `binding-v1-${Buffer.from(encoded, 'base64').toString('base64url')}.json`;
}

async function inspectRoot(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || path.normalize(root) !== root) {
    fail('invalid-binding-root', 'manifestRoot must be one normalized absolute path');
  }
  let metadata;
  try {
    metadata = await lstat(root);
  } catch {
    fail('binding-root-unavailable', 'source binding manifest root is unavailable');
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    fail('invalid-binding-root', 'source binding manifest root must be a real directory');
  }
  if (await realpath(root) !== root) {
    fail('invalid-binding-root', 'source binding manifest root must not use symlink path components');
  }
  return root;
}

export function createRetainedSourceBindingResolver({ manifestRoot } = {}) {
  async function resolve(bindingDigest, pageId) {
    const digest = requireDigest(bindingDigest, 'bindingDigest');
    if (typeof pageId !== 'string' || !PAGE_ID_RE.test(pageId)) {
      fail('unresolvable-binding', 'publication binding could not be resolved');
    }
    const inspectedRoot = await inspectRoot(manifestRoot);
    const file = path.join(inspectedRoot, retainedManifestFilename(digest));
    let handle;
    try {
      handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > SOURCE_BINDING_MAX_BYTES) {
        fail('unresolvable-binding', 'publication binding could not be resolved');
      }
      const bytes = Buffer.alloc(metadata.size);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      const extra = Buffer.alloc(1);
      const { bytesRead: extraBytesRead } = await handle.read(
        extra,
        0,
        1,
        metadata.size,
      );
      if (bytesRead !== metadata.size || extraBytesRead !== 0) {
        fail('unresolvable-binding', 'publication binding could not be resolved');
      }
      const manifest = parseSourceBindingManifest(bytes);
      if (sourceBindingDigest(manifest) !== digest) {
        fail('unresolvable-binding', 'publication binding could not be resolved');
      }
      const page = manifest.pages.find((candidate) => candidate.pageId === pageId);
      if (!page) fail('unresolvable-binding', 'publication binding could not be resolved');
      return deepFreeze({ bindingDigest: digest, manifest, page });
    } catch (error) {
      if (error?.code === 'ENOENT') fail('stale-publication', 'the exact publication binding is no longer retained');
      if (error?.name === 'AccountFreeIntakeError') throw error;
      fail('unresolvable-binding', 'publication binding could not be resolved');
    } finally {
      await handle?.close();
    }
  }

  return Object.freeze({ resolve });
}

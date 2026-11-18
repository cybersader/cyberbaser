import { createHash } from 'node:crypto';
import { computePolicyRevision, validateOwnerAlphaConfig } from './config.js';
import { fail } from './errors.js';
import { canonicalJson, deepFreeze, isPlainObject } from './json.js';
import { applyEditorOperation, deriveEditorOperation, validateEditSession } from './operation.js';
import {
  createEditSession as defaultCreateEditSession, EDIT_SESSION_ARTIFACT_TYPE,
  EDIT_SESSION_SCHEMA_VERSION, liveUrlForSlug, pathMatchesPolicy,
} from './source.js';

export const OWNER_PUBLICATION_SCHEMA_VERSION = 1;
export const OWNER_PUBLICATION_ARTIFACT_TYPE = 'owner-alpha-prepared-publication';
const NOTE_KEYS = ['identity', 'path', 'version', 'byteLength', 'digest', 'text', 'bytesBase64'];
const SOURCE_KEYS = ['identity', 'path', 'version', 'byteLength', 'digest'];
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function exactRecord(value, keys, code) {
  if (!isPlainObject(value)
    || Reflect.ownKeys(value).length !== keys.length
    || keys.some((key) => !Object.hasOwn(value, key)
      || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) {
    fail(code, 'publication evidence must contain exactly the declared data fields');
  }
}

function digest(bytes) {
  // Same canonical content-digest spelling as source.js and operation.js.
  return `sha-256=:${createHash('sha256').update(bytes).digest('base64')}:`;
}

function configuredMapping(config, mappingId) {
  if (!config.ownerPublication.enabled) {
    fail('owner-publication-disabled', 'owner publication input is not configured');
  }
  const mapping = config.ownerPublication.mappings.find((entry) => entry.id === mappingId);
  if (!mapping) fail('publication-mapping-not-found', 'mapping id is not configured for owner publication');
  pathMatchesPolicy(mapping.relativePath, config.paths);
  return mapping;
}

function sourceReference(note) {
  return deepFreeze(Object.fromEntries(SOURCE_KEYS.map((key) => [key, note[key]])));
}

function assertSourceReference(value, mapping, maximum) {
  exactRecord(value, SOURCE_KEYS, 'invalid-authoring-reference');
  if (value.identity !== mapping.source.identity || value.path !== mapping.source.path) {
    fail('authoring-source-binding-mismatch', 'authoring evidence does not identify the configured source');
  }
  if (!Number.isSafeInteger(value.version) || value.version <= 0) {
    fail('invalid-authoring-version', 'authoring evidence requires a positive coherent version');
  }
  if (!Number.isSafeInteger(value.byteLength) || value.byteLength < 0) {
    fail('invalid-authoring-length', 'authoring evidence requires an exact non-negative byte count');
  }
  if (value.byteLength > maximum) fail('authoring-source-too-large', 'authoring evidence exceeds the source byte limit');
  if (typeof value.digest !== 'string' || !/^sha-256=:[A-Za-z0-9+/]{43}=:$/u.test(value.digest)
    || Buffer.from(value.digest.slice(9, -1), 'base64').toString('base64') !== value.digest.slice(9, -1)) {
    fail('invalid-authoring-digest', 'authoring evidence requires one canonical SHA-256 content digest');
  }
}

function validateNote(value, mapping, maximum) {
  exactRecord(value, NOTE_KEYS, 'invalid-authoring-note');
  const reference = sourceReference(value);
  assertSourceReference(reference, mapping, maximum);
  if (typeof value.text !== 'string' || !value.text.isWellFormed()) {
    fail('invalid-authoring-utf8', 'authoring evidence requires exact well-formed UTF-8 text');
  }
  if (typeof value.bytesBase64 !== 'string') {
    fail('invalid-authoring-bytes', 'authoring evidence requires canonical base64 bytes');
  }
  if (value.text.length > maximum
    || value.bytesBase64.length > 4 * Math.ceil(maximum / 3)) {
    fail('authoring-source-too-large', 'authoring evidence exceeds the source byte limit');
  }
  if (value.bytesBase64.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value.bytesBase64)) {
    fail('invalid-authoring-bytes', 'authoring evidence requires canonical base64 bytes');
  }
  const bytes = Buffer.from(value.bytesBase64, 'base64');
  if (bytes.toString('base64') !== value.bytesBase64) {
    fail('invalid-authoring-bytes', 'authoring evidence requires canonical base64 bytes');
  }
  if (bytes.length > maximum) fail('authoring-source-too-large', 'authoring evidence exceeds the source byte limit');
  let text;
  try {
    text = UTF8_DECODER.decode(bytes);
  } catch {
    fail('invalid-authoring-utf8', 'authoring evidence bytes must be valid UTF-8');
  }
  if (text !== value.text || !Buffer.from(value.text, 'utf8').equals(bytes)
    || bytes.length !== value.byteLength || digest(bytes) !== value.digest) {
    fail('authoring-source-integrity-mismatch', 'authoring text, bytes, length and digest must identify one exact note');
  }
  return deepFreeze({ ...reference, text, bytesBase64: bytes.toString('base64') });
}

async function readConfiguredNote(config, mapping, readNote) {
  if (typeof readNote !== 'function') fail('authoring-reader-required', 'an approved coherent authoring reader must be injected');
  let result;
  try {
    // The reader must bind these bytes to its completed in-memory revision.
    // Digest agreement alone cannot prove coherence of in-place disk writes.
    result = await readNote(mapping);
  } catch {
    // Never propagate provider errors, bodies, permission details or credentials.
    fail('authoring-read-failed', 'configured authoring note could not be read coherently');
  }
  return validateNote(result, mapping, config.limits.maxSourceBytes);
}

/** readNote(configuredMapping) -> {identity,path,version,byteLength,digest,text,bytesBase64}.
 * No default network/disk reader exists. Only approved coherent readers or synthetic
 * fixtures may be injected. The returned JSON-compatible evidence is deeply frozen.
 */
export async function readAuthoringSource({ config: configInput, mappingId, readNote }) {
  const config = validateOwnerAlphaConfig(configInput);
  return readConfiguredNote(config, configuredMapping(config, mappingId), readNote);
}

function snapshotEditSession(value) {
  try {
    exactRecord(value, ['schemaVersion', 'artifactType', 'relativePath', 'slug', 'liveUrl', 'baseCommit', 'policyRevision', 'source'], 'invalid-edit-session');
    exactRecord(value.source, ['text', 'bytesBase64', 'byteLength', 'digest', 'gitMode', 'gitObjectId', 'frontmatter'], 'invalid-edit-session');
    if (value.schemaVersion !== EDIT_SESSION_SCHEMA_VERSION || value.artifactType !== EDIT_SESSION_ARTIFACT_TYPE
      || ['relativePath', 'slug', 'liveUrl', 'baseCommit', 'policyRevision'].some((key) => typeof value[key] !== 'string')
      || ['text', 'bytesBase64', 'digest', 'gitMode', 'gitObjectId'].some((key) => typeof value.source[key] !== 'string')
      || !Number.isSafeInteger(value.source.byteLength) || value.source.byteLength < 0
      || !['100644', '100755'].includes(value.source.gitMode)
      || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value.source.gitObjectId)) {
      fail('invalid-edit-session', 'publication requires the closed ordinary edit-session contract');
    }
    if (value.source.frontmatter !== null) {
      exactRecord(value.source.frontmatter, ['start', 'end'], 'invalid-edit-session');
      if (!Number.isSafeInteger(value.source.frontmatter.start) || !Number.isSafeInteger(value.source.frontmatter.end)) {
        fail('invalid-edit-session', 'publication edit-session frontmatter must contain exact byte offsets');
      }
    }
    return structuredClone(value);
  } catch {
    // Accessors, proxies and non-cloneable values never expose raw caller errors.
    fail('invalid-edit-session', 'publication requires one closed cloneable ordinary edit session');
  }
}

// Shared capture checks retain the writer's validation order. Capturing alone is
// not an unchanged verdict: the full operation session validator must run first.
async function capturePublicationInputs({
  config: configInput, mappingId, readNote, session: suppliedSession,
  createEditSession = defaultCreateEditSession,
}) {
  const config = validateOwnerAlphaConfig(configInput);
  const mapping = configuredMapping(config, mappingId);
  const policyRevision = computePolicyRevision(config);
  const note = await readConfiguredNote(config, mapping, readNote);
  const session = snapshotEditSession(suppliedSession ?? await createEditSession({
    config, renderer: { relativePath: mapping.relativePath, slug: mapping.slug },
  }));
  if (!isPlainObject(session) || session.relativePath !== mapping.relativePath
    || session.slug !== mapping.slug || session.liveUrl !== liveUrlForSlug(config.live.baseUrl, mapping.slug)
    || session.policyRevision !== policyRevision) {
    fail('publication-session-binding-mismatch', 'edit session must match the configured mapping and current policy');
  }
  if (!isPlainObject(session.source) || typeof session.source.text !== 'string'
    || !session.source.text.isWellFormed()) {
    fail('invalid-edit-session', 'publication requires exact well-formed edit-session text');
  }
  if (session.source.text.length > config.limits.maxSourceBytes
    || typeof session.source.bytesBase64 !== 'string'
    || session.source.bytesBase64.length > 4 * Math.ceil(config.limits.maxSourceBytes / 3)) {
    fail('publication-session-too-large', 'edit session exceeds the source byte limit');
  }
  if (note.text.startsWith('﻿') || session.source.text.startsWith('﻿')) {
    fail('publication-bom-unsupported', 'owner publication does not support BOM-prefixed Markdown');
  }
  return deepFreeze({ config, mapping, policyRevision, note, session });
}

/** One detached capture for review. The unchanged view has no upstream binding,
 * operation or authority; changed captures still go through ordinary preparation.
 */
export async function captureOwnerPublicationReview(input) {
  const { config, note, session } = await capturePublicationInputs(input);
  const { base } = validateEditSession(session);
  if (base.length > config.limits.maxSourceBytes) {
    fail('publication-session-too-large', 'edit session exceeds the source byte limit');
  }
  const unchanged = base.toString('base64') === note.bytesBase64;
  return deepFreeze({ note, session, view: unchanged ? {
    relativePath: session.relativePath, text: note.text, baseCommit: session.baseCommit,
    byteLength: note.byteLength, digest: note.digest,
  } : null });
}

/** Effect-free preparation only: no Save job, store, render or source application.
 * createEditSession defaults to the existing read-only Git-bound implementation.
 * A supplied session is reused only after mapping/policy and exact-byte validation.
 */
export async function prepareOwnerPublication(input) {
  const { config, mapping, policyRevision, note, session } = await capturePublicationInputs(input);
  const operation = deriveEditorOperation({ session, editedText: note.text, config });
  const bytes = applyEditorOperation(session, operation);
  if (bytes.toString('base64') !== note.bytesBase64 || digest(bytes) !== note.digest) {
    fail('publication-candidate-mismatch', 'exact operation must reproduce the captured authoring bytes');
  }
  const prepared = {
    schemaVersion: OWNER_PUBLICATION_SCHEMA_VERSION,
    artifactType: OWNER_PUBLICATION_ARTIFACT_TYPE,
    reference: { mapping, policyRevision, source: sourceReference(note) },
    session,
    operation,
    candidate: { text: note.text, bytesBase64: note.bytesBase64, byteLength: bytes.length, digest: note.digest },
  };
  if (Buffer.byteLength(canonicalJson(prepared), 'utf8') > config.limits.maxArtifactBytes) {
    fail('publication-artifact-too-large', 'prepared publication exceeds the artifact byte limit');
  }
  return deepFreeze(prepared);
}

/** Source-only later Publish gate. A reference is comparison evidence, not authority.
 * Re-check Git base/cleanliness, the stored candidate and owner intent separately.
 */
export async function revalidateOwnerPublicationSource({ config: configInput, reference, readNote }) {
  const config = validateOwnerAlphaConfig(configInput);
  exactRecord(reference, ['mapping', 'policyRevision', 'source'], 'invalid-publication-reference');
  exactRecord(reference.mapping, ['id', 'source', 'relativePath', 'slug'], 'invalid-publication-reference');
  exactRecord(reference.mapping.source, ['identity', 'path'], 'invalid-publication-reference');
  const mapping = configuredMapping(config, reference.mapping.id);
  if (reference.policyRevision !== computePolicyRevision(config)
    || canonicalJson(reference.mapping) !== canonicalJson(mapping)) {
    fail('publication-policy-mismatch', 'publication reference no longer matches the configured mapping and policy');
  }
  // Copy the expected reference before awaiting the reader, including reloaded JSON.
  assertSourceReference(reference.source, mapping, config.limits.maxSourceBytes);
  const expected = sourceReference(reference.source);
  const current = sourceReference(await readConfiguredNote(config, mapping, readNote));
  if (canonicalJson(current) !== canonicalJson(expected)) {
    fail('authoring-source-stale', 'configured authoring source changed since candidate preparation');
  }
  return current;
}

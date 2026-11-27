import { createHash } from 'node:crypto';
import { findFrontmatterInText } from '../../../packages/correction/src/frontmatter.js';
import { computePolicyRevision, validateOwnerAlphaConfig } from './config.js';
import { fail } from './errors.js';
import { canonicalJson, deepFreeze, isPlainObject } from './json.js';
import { applyEditorOperation, deriveEditorOperation, hasAdjacentFrontmatter, validateEditSession } from './operation.js';
import {
  createEditSession as defaultCreateEditSession, EDIT_SESSION_ARTIFACT_TYPE,
  EDIT_SESSION_SCHEMA_VERSION, liveUrlForSlug, pathMatchesPolicy,
} from './source.js';

export const OWNER_PUBLICATION_SCHEMA_VERSION = 1;
export const OWNER_PUBLICATION_ARTIFACT_TYPE = 'owner-alpha-prepared-publication';
const NOTE_KEYS = ['identity', 'path', 'byteLength', 'digest', 'text', 'bytesBase64'];
const BINDING_KEYS = ['identity', 'path', 'byteLength', 'digest'];
const WORKSPACE_BINDING_KEYS = ['identity', 'path', 'foldedTextDigest'];
export const WORKSPACE_READER_FAILURES = Object.freeze({
  'not-found': 'workspace note is unavailable',
  moved: 'workspace note moved during capture',
  'pending-erasure': 'workspace note is pending erasure',
  'out-of-scope': 'workspace note is outside the reader scope',
  'unsupported-type': 'workspace note type is unsupported',
  'over-budget': 'workspace note exceeds the reader budget',
});
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function exactRecord(value, keys, code) {
  if (!isPlainObject(value)
    || Reflect.ownKeys(value).length !== keys.length
    || keys.some((key) => !Object.hasOwn(value, key)
      || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) {
    fail(code, 'publication evidence must contain exactly the declared data fields');
  }
}

export function publicationDigest(bytes) {
  // Same canonical content-digest spelling as source.js and operation.js.
  return `sha-256=:${createHash('sha256').update(bytes).digest('base64')}:`;
}

export function isPublicationDigest(value) {
  return typeof value === 'string' && value.length === 54 && /^sha-256=:[A-Za-z0-9+/]{43}=:$/u.test(value)
    && Buffer.from(value.slice(9, -1), 'base64').toString('base64') === value.slice(9, -1);
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

export function validatePublicationAttribution(value) {
  if (value === 'unknown') return value;
  if (!Array.isArray(value) || value.length > 32 || Reflect.ownKeys(value).length !== value.length + 1) {
    fail('invalid-authoring-attribution', 'authoring attribution requires at most 32 opaque references or unknown');
  }
  const refs = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    const reference = descriptor?.value;
    if (typeof reference !== 'string' || !reference.isWellFormed() || /\p{Cc}/u.test(reference)
      || reference.length === 0 || Buffer.byteLength(reference, 'utf8') > 256) {
      fail('invalid-authoring-attribution', 'authoring attribution references must be bounded exact strings');
    }
    refs.push(reference);
  }
  return deepFreeze(refs);
}

function sourceReference(note, workspace = false) {
  const keys = workspace ? WORKSPACE_BINDING_KEYS : BINDING_KEYS;
  return deepFreeze({ ...Object.fromEntries(keys.map((key) => [key, note[key]])),
    version: Object.hasOwn(note, 'version') ? note.version : 0,
    attribution: Object.hasOwn(note, 'attribution') ? validatePublicationAttribution(note.attribution) : 'unknown' });
}

export function assertSourceReference(value, mapping, maximum) {
  const workspace = mapping.source.kind === 'workspace';
  if (workspace && !Object.hasOwn(value ?? {}, 'foldedTextDigest') && Object.hasOwn(value ?? {}, 'digest')) {
    fail('workspace-snapshot-incompatible', 'workspace draft predates folded text binding and must be prepared again');
  }
  exactRecord(value, [...(workspace ? WORKSPACE_BINDING_KEYS : BINDING_KEYS), 'version',
    ...(Object.hasOwn(value ?? {}, 'attribution') ? ['attribution'] : [])], 'invalid-authoring-reference');
  if (value.identity !== mapping.source.identity || value.path !== mapping.source.path) {
    fail('authoring-source-binding-mismatch', 'authoring evidence does not identify the configured source');
  }
  if (!Number.isSafeInteger(value.version) || value.version < 0) {
    fail('invalid-authoring-version', 'authoring version, when present, must be a non-negative safe integer');
  }
  if (!workspace && (!Number.isSafeInteger(value.byteLength) || value.byteLength < 0)) {
    fail('invalid-authoring-length', 'authoring evidence requires an exact non-negative byte count');
  }
  if (value.byteLength > maximum) fail('authoring-source-too-large', 'authoring evidence exceeds the source byte limit');
  if (Object.hasOwn(value, 'attribution')) validatePublicationAttribution(value.attribution);
  if (!isPublicationDigest(workspace ? value.foldedTextDigest : value.digest)) {
    fail('invalid-authoring-digest', 'authoring evidence requires one canonical SHA-256 content digest');
  }
}

function validateNote(value, mapping, maximum) {
  exactRecord(value, [...NOTE_KEYS, ...['version', 'attribution'].filter((key) => Object.hasOwn(value ?? {}, key))], 'invalid-authoring-note');
  const workspace = mapping.source.kind === 'workspace';
  const reference = sourceReference(value);
  if (workspace) {
    if (typeof value.text === 'string' && !value.text.isWellFormed()) roundTripRefusal('invalid-utf8');
    if (!Number.isSafeInteger(value.byteLength) || value.byteLength < 0) {
      fail('invalid-authoring-length', 'authoring evidence requires an exact non-negative byte count');
    }
    if (value.byteLength > maximum) fail('authoring-source-too-large', 'authoring evidence exceeds the source byte limit');
  } else assertSourceReference(reference, mapping, maximum);
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
    if (workspace) roundTripRefusal('invalid-utf8');
    fail('invalid-authoring-utf8', 'authoring evidence bytes must be valid UTF-8');
  }
  const digest = publicationDigest(bytes);
  if (text !== value.text || !Buffer.from(value.text, 'utf8').equals(bytes)
    || bytes.length !== value.byteLength || (!workspace && digest !== value.digest)) {
    fail('authoring-source-integrity-mismatch', 'authoring text, bytes, length and digest must identify one exact note');
  }
  const note = { ...reference, digest, text, bytesBase64: bytes.toString('base64') };
  if (workspace) {
    note.foldedTextDigest = foldedWorkspaceDigest(text);
    assertSourceReference(sourceReference(note, true), mapping, maximum);
  }
  return deepFreeze(note);
}

async function readConfiguredNote(config, mapping, readNote) {
  if (typeof readNote !== 'function') fail('authoring-reader-required', 'an approved coherent authoring reader must be injected');
  let result;
  try {
    // The reader must bind these bytes to its completed in-memory revision.
    // Digest agreement alone cannot prove coherence of in-place disk writes.
    result = await readNote(mapping);
  } catch (error) {
    // Copy only recognized own data codes, never provider getters or diagnostics.
    let code;
    try { code = Object.getOwnPropertyDescriptor(error ?? {}, 'code')?.value; } catch { /* Unknown provider error. */ }
    if (typeof code === 'string' && Object.hasOwn(WORKSPACE_READER_FAILURES, code)) {
      fail(code, WORKSPACE_READER_FAILURES[code]);
    }
    fail('authoring-read-failed', 'configured authoring note could not be read coherently');
  }
  return validateNote(result, mapping, config.limits.maxSourceBytes);
}

/** readNote(configuredMapping) -> {identity,path,version?,byteLength,digest,text,bytesBase64,attribution?}.
 * No default network/disk reader exists. Only approved coherent readers or synthetic
 * fixtures may be injected. The returned JSON-compatible evidence is deeply frozen.
 */
export async function readAuthoringSource({ config: configInput, mappingId, readNote }) {
  const config = validateOwnerAlphaConfig(configInput);
  return readConfiguredNote(config, configuredMapping(config, mappingId), readNote);
}

function roundTripRefusal(reason) {
  fail('delivery-not-round-trippable', 'workspace text cannot round-trip through exact UTF-8', { reason });
}

/** The folded digest binds content, never the vault byte spelling. */
export function foldWorkspaceText(value) {
  let text;
  if (typeof value === 'string') {
    if (!value.isWellFormed()) roundTripRefusal('invalid-utf8');
    text = value;
  } else {
    try { text = UTF8_DECODER.decode(value); } catch { roundTripRefusal('invalid-utf8'); }
    if (!Buffer.from(text, 'utf8').equals(value)) roundTripRefusal('invalid-utf8');
  }
  if (text.startsWith('\uFEFF')) text = text.slice(1);
  if (text.includes('\uFEFF')) roundTripRefusal('byte-order-mark');
  return text.replace(/\r\n?/gu, '\n');
}

export function foldedWorkspaceDigest(value) {
  return publicationDigest(Buffer.from(foldWorkspaceText(value), 'utf8'));
}

export function assertWorkspaceDeliveryRoundTrip(bytes) {
  const folded = foldWorkspaceText(bytes);
  // Refuse every lone CR in a delivery file rather than guess whether a moved
  // or ambiguously aligned line carrying one was untouched by the editor.
  if (/\r(?!\n)/u.test(UTF8_DECODER.decode(bytes))) roundTripRefusal('lone-carriage-return');
  return folded;
}

export function assertFoldedWorkspaceNote(foldedBase, foldedText) {
  // Divisibility is only a pre-check. Compare each full copy without allocating
  // a second document or mistaking an equal-length edit for a duplicate.
  if (foldedBase.length > 0 && foldedText.length >= 2 * foldedBase.length
    && foldedText.length % foldedBase.length === 0) {
    const repeats = foldedText.length / foldedBase.length;
    let offset = 0;
    while (offset < foldedText.length && foldedText.startsWith(foldedBase, offset)) offset += foldedBase.length;
    if (offset === foldedText.length) fail('workspace-text-repeated', 'workspace note repeats the vault text', { repeats });
  }

  // Treat an unclosed leading block or a second complete adjacent block as
  // unsafe without guessing YAML values in this write path.
  const leading = findFrontmatterInText(foldedText);
  if (leading.kind === 'none') return;
  const invalid = () => fail('workspace-properties-invalid', 'workspace note has invalid frontmatter structure');
  if (leading.reason === 'unclosed' || hasAdjacentFrontmatter(foldedText, leading)) invalid();
}

function linesWithTerminators(text) {
  const lines = [];
  for (const [line] of text.matchAll(/[^\r\n]*(?:\r\n|\n|$)/gu)) {
    if (line === '') continue;
    const end = line.endsWith('\r\n') ? '\r\n' : line.endsWith('\n') ? '\n' : '';
    lines.push({ text: end === '' ? line : line.slice(0, -end.length), end });
  }
  return lines;
}

// Match unchanged lines in order. Common outer lines are skipped before the
// bounded LCS so a tiny edit in a long note does not pay a quadratic cost.
function matchedLines(before, after) {
  const equal = (i, j) => before[i].text === after[j].text && !!before[i].end === !!after[j].end;
  const matches = [];
  let start = 0;
  let n = before.length;
  let m = after.length;
  while (start < n && start < m && equal(start, start)) {
    matches.push([start, start]); start += 1;
  }
  const end = [];
  while (n > start && m > start && equal(n - 1, m - 1)) end.push([--n, --m]);
  const width = m - start + 1;
  if ((n - start + 1) * width > 1_000_000) {
    fail('workspace-diff-too-complex', 'workspace edit is too dispersed to align exact vault lines safely');
  }
  const grid = new Uint32Array((n - start + 1) * width);
  const index = (i, j) => (i - start) * width + j - start;
  for (let i = n - 1; i >= start; i -= 1) {
    for (let j = m - 1; j >= start; j -= 1) {
      grid[index(i, j)] = equal(i, j) ? grid[index(i + 1, j + 1)] + 1
        : Math.max(grid[index(i + 1, j)], grid[index(i, j + 1)]);
    }
  }
  let i = start;
  let j = start;
  while (i < n && j < m) {
    if (equal(i, j)) matches.push([i++, j++]);
    else if (grid[index(i + 1, j)] >= grid[index(i, j + 1)]) i += 1;
    else j += 1;
  }
  return matches.concat(end.reverse());
}

/** Translate the folded edit into the vault spelling, not a reserialization. */
export function spellWorkspaceCandidate(base, desiredText) {
  const foldedBase = assertWorkspaceDeliveryRoundTrip(base);
  const foldedDesired = foldWorkspaceText(desiredText);
  const raw = UTF8_DECODER.decode(base);
  if (foldedBase === foldedDesired) return raw;
  const bom = raw.startsWith('\uFEFF') ? '\uFEFF' : '';
  const before = linesWithTerminators(raw.slice(bom.length));
  const after = linesWithTerminators(foldedDesired);
  const firstTerminator = before.find((line) => line.end)?.end ?? '\n';
  const parts = [bom];
  let priorVaultTerminator;
  let oldIndex = 0;
  let newIndex = 0;
  for (const [oldMatch, newMatch] of [...matchedLines(before, after), [before.length, after.length]]) {
    for (; newIndex < newMatch; newIndex += 1) {
      const next = after[newIndex];
      // Pair rewritten lines with their original terminators. A truly new
      // break borrows the nearest preceding vault terminator, then the first
      // vault terminator, then LF when the vault file had none.
      const old = oldIndex < oldMatch ? before[oldIndex++] : undefined;
      parts.push(next.text, next.end ? old?.end || priorVaultTerminator || firstTerminator : '');
      if (old?.end) priorVaultTerminator = old.end;
    }
    if (oldMatch < before.length) {
      const line = before[oldMatch];
      parts.push(line.text, line.end);
      if (line.end) priorVaultTerminator = line.end;
    }
    oldIndex = oldMatch + 1;
    newIndex = newMatch + 1;
  }
  const candidate = parts.join('');
  if (foldWorkspaceText(candidate) !== foldedDesired) fail('publication-candidate-mismatch', 'exact workspace change could not reproduce the folded capture');
  return candidate;
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
  createEditSession = defaultCreateEditSession, expectedDigest, workspaceBaseline, workspaceNoteGate, workspaceGate,
}) {
  const config = validateOwnerAlphaConfig(configInput);
  const mapping = configuredMapping(config, mappingId);
  const policyRevision = computePolicyRevision(config);
  const workspace = mapping.source.kind === 'workspace';
  if (workspace && workspaceBaseline === undefined) {
    fail('workspace-unbound', 'workspace note must be explicitly bound to the vault before publication');
  }
  const note = await readConfiguredNote(config, mapping, readNote);
  // The caller may supply an advisory version, but only exact text identifies it.
  if (expectedDigest !== undefined && expectedDigest !== (workspace ? note.foldedTextDigest : note.digest)) {
    fail('publication-expected-source-mismatch', 'the captured note does not match the expected revision');
  }
  await workspaceNoteGate?.(note);
  const session = snapshotEditSession(suppliedSession ?? await createEditSession({
    config, renderer: { relativePath: mapping.relativePath, slug: mapping.slug },
    ...(workspace ? { workspacePublication: true } : {}),
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
  if (workspace) {
    const folded = assertWorkspaceDeliveryRoundTrip(Buffer.from(session.source.bytesBase64, 'base64'));
    if (publicationDigest(Buffer.from(folded)) !== workspaceBaseline.foldedTextDigest) {
      fail('delivery-moved-since-baseline', 'vault delivery no longer matches its workspace baseline');
    }
    assertFoldedWorkspaceNote(folded, foldWorkspaceText(note.text));
  }
  await workspaceGate?.({ config, mapping, note, session });
  if (!workspace && (note.text.startsWith('\uFEFF') || session.source.text.startsWith('\uFEFF'))) {
    fail('publication-bom-unsupported', 'owner publication does not support BOM-prefixed Markdown');
  }
  return deepFreeze({ config, mapping, policyRevision, note, session, workspace });
}

/** One detached capture for review. The unchanged view has no upstream binding,
 * operation or authority; changed captures still go through ordinary preparation.
 */
export async function captureOwnerPublicationReview(input) {
  const { config, note, session, workspace } = await capturePublicationInputs(input);
  const { base } = validateEditSession(session, { workspacePublication: workspace });
  if (base.length > config.limits.maxSourceBytes) {
    fail('publication-session-too-large', 'edit session exceeds the source byte limit');
  }
  const unchanged = workspace ? foldedWorkspaceDigest(base) === note.foldedTextDigest : base.toString('base64') === note.bytesBase64;
  if (unchanged && workspace) await input.workspaceNoteGate?.(session.source);
  return deepFreeze({ note, session, view: unchanged ? {
    relativePath: session.relativePath, text: session.source.text, baseCommit: session.baseCommit,
    byteLength: session.source.byteLength, ...(workspace ? { foldedTextDigest: note.foldedTextDigest } : { digest: note.digest }),
  } : null });
}

/** Effect-free preparation only: no Save job, store, render or source application.
 * createEditSession defaults to the existing read-only Git-bound implementation.
 * A supplied session is reused only after mapping/policy and exact-byte validation.
 */
export async function prepareOwnerPublication(input) {
  const { config, mapping, policyRevision, note, session, workspace } = await capturePublicationInputs(input);
  const base = Buffer.from(session.source.bytesBase64, 'base64');
  const text = workspace ? spellWorkspaceCandidate(base, note.text) : note.text;
  const operation = deriveEditorOperation({ session, editedText: text, config, workspacePublication: workspace, ownerPublication: true });
  const bytes = applyEditorOperation(session, operation, { workspacePublication: workspace, allowProperties: workspace && config.owner.allowProperties });
  const digest = publicationDigest(bytes);
  const foldedCandidate = workspace ? foldWorkspaceText(bytes) : undefined;
  if (!bytes.equals(Buffer.from(text)) || (workspace ? foldedCandidate !== foldWorkspaceText(note.text) : digest !== note.digest)) {
    fail('publication-candidate-mismatch', 'exact operation must reproduce the captured authoring content');
  }
  if (workspace) await input.workspaceNoteGate?.({ text });
  const prepared = {
    schemaVersion: OWNER_PUBLICATION_SCHEMA_VERSION,
    artifactType: OWNER_PUBLICATION_ARTIFACT_TYPE,
    reference: { mapping, policyRevision, source: sourceReference(note, workspace),
      ...(input.workspaceBaseline === undefined ? {} : { workspaceBaseline: input.workspaceBaseline }) },
    session,
    operation,
    candidate: { text, bytesBase64: bytes.toString('base64'), byteLength: bytes.length, digest },
  };
  if (Buffer.byteLength(canonicalJson(prepared), 'utf8') > config.limits.maxArtifactBytes) {
    fail('publication-artifact-too-large', 'prepared publication exceeds the artifact byte limit');
  }
  return deepFreeze(prepared);
}

/** Source-only later Publish gate. A reference is comparison evidence, not authority.
 * Re-check Git base/cleanliness, the stored candidate and owner intent separately.
 */
export async function revalidateOwnerPublicationSource({ config: configInput, reference, readNote, checkNote }) {
  const config = validateOwnerAlphaConfig(configInput);
  exactRecord(reference, ['mapping', 'policyRevision', 'source',
    ...(Object.hasOwn(reference ?? {}, 'workspaceBaseline') ? ['workspaceBaseline'] : [])], 'invalid-publication-reference');
  exactRecord(reference.mapping, ['id', 'source', 'relativePath', 'slug'], 'invalid-publication-reference');
  exactRecord(reference.mapping.source, ['identity', 'path',
    ...(Object.hasOwn(reference.mapping.source ?? {}, 'kind') ? ['kind'] : [])], 'invalid-publication-reference');
  const mapping = configuredMapping(config, reference.mapping.id);
  if (reference.policyRevision !== computePolicyRevision(config)
    || canonicalJson(reference.mapping) !== canonicalJson(mapping)) {
    fail('publication-policy-mismatch', 'publication reference no longer matches the configured mapping and policy');
  }
  // Copy the expected reference before awaiting the reader, including reloaded JSON.
  assertSourceReference(reference.source, mapping, config.limits.maxSourceBytes);
  const workspace = mapping.source.kind === 'workspace';
  const expected = sourceReference(reference.source, workspace);
  const note = await readConfiguredNote(config, mapping, readNote);
  await checkNote?.(note);
  const current = sourceReference(note, workspace);
  if ((workspace ? WORKSPACE_BINDING_KEYS : BINDING_KEYS).some((key) => current[key] !== expected[key])) {
    fail('authoring-source-stale', 'configured authoring source changed since candidate preparation');
  }
  return current;
}

// This device as an owner signing device: it approves publishes with its own
// key, which the publisher checks on its own (design/signed-publish.mdx).
//
// Format: @cyberbaser/signed-intent v1 (packages/signed-intent/README.md).
// intent.js there is environment-neutral; everything else here is WebCrypto,
// so it runs in Obsidian desktop and mobile.
//
// Three rules this file keeps:
//   - The signing key is its own non-extractable Ed25519 key, separate from the
//     pairing key, kept in this app's IndexedDB (never data.json, which syncs).
//   - What the owner sees is built here, from the intent and from file bytes
//     whose SHA-256 the intent fixes. Nothing the node says separately is shown.
//   - Nothing is signed without a real tap in this plugin's own dialog (tap.js).
import { canonicalJson, intentBytes, validateIntent } from '../../../../packages/signed-intent/src/intent.js';
import { fromBase64, hex, toBase64, utf8 } from './wire.js';
import { checkAsset } from '../../../../packages/media-check/src/index.js';
import { notePublicStatus } from './new-page.js';
import { parseFrontmatter } from '../../../../packages/publish/src/page-rules.js';
import { propertyImageRefs } from '../../../../packages/publish/src/property-refs.js';
import yaml from 'js-yaml';

export const ENROL_LINK_ACTION = 'cyberbaser-enrol';
export const ED25519_APPROVAL_DOMAIN = 'cyberbaser.publish-approval.ed25519.v1\n';
const ENROLL_PROOF_DOMAIN = 'cyberbaser.enroll-proof.v1';
const ENROLL_CONFIRM_DOMAIN = 'cyberbaser.enroll-confirm.v1';
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const ENROL_CODE_BYTES = 20;
const MAX_LIFETIME_MS = 15 * 60_000;

const subtle = () => globalThis.crypto.subtle;

export function b64url(bytes) {
  return toBase64(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

export function fromB64url(text, length) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/u.test(text)) return null;
  const padded = text.replaceAll('-', '+').replaceAll('_', '/');
  let bytes;
  try { bytes = fromBase64(padded + '='.repeat((4 - (padded.length % 4)) % 4)); } catch { return null; }
  return (length === undefined || bytes.length === length) && b64url(bytes) === text ? bytes : null;
}

export async function sha256(bytes) {
  return new Uint8Array(await subtle().digest('SHA-256', bytes));
}

async function hmac(secret, text) {
  const key = await subtle().importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle().sign('HMAC', key, utf8(text)));
}

function sameBytes(left, right) {
  if (!left || !right || left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left[i] ^ right[i];
  return diff === 0;
}

// ---- The one-time enrolment code ----

/** Crockford base32 as people read it: case-insensitive, I/L are 1, O is 0, dashes and spaces ignored. */
export function parseCode(text, byteLength = ENROL_CODE_BYTES) {
  if (typeof text !== 'string') return null;
  const clean = text.toUpperCase().replace(/[\s-]/gu, '').replace(/[IL]/gu, '1').replace(/O/gu, '0');
  if (clean.length !== Math.ceil((byteLength * 8) / 5) || [...clean].some((c) => !CROCKFORD.includes(c))) return null;
  let bits = 0; let value = 0; const out = [];
  for (const c of clean) {
    value = ((value << 5) | CROCKFORD.indexOf(c)) & 0xffff;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  // Trailing bits must be zero, so one code has exactly one spelling.
  if (bits > 0 && (value & ((1 << bits) - 1)) !== 0) return null;
  return out.length === byteLength ? new Uint8Array(out) : null;
}

/**
 * The code the publisher shows, in any of the forms it may arrive in:
 *   cyberbaser-enroll:v1?publisher=<64 hex>&code=<code>   (installer QR / text)
 *   obsidian://cyberbaser-enrol?publisher=…&code=…         (link opened by the OS)
 *   { publisher, code }                                    (Obsidian's link handler)
 */
export function parseEnrolCode(input) {
  let params = null;
  if (input && typeof input === 'object') params = input;
  else if (typeof input === 'string' && input.length <= 512) {
    const text = input.trim();
    const match = /^(?:cyberbaser-enroll:v1|obsidian:\/\/cyberbaser-enrol)\?(.+)$/u.exec(text);
    if (match) params = Object.fromEntries(new URLSearchParams(match[1]));
  }
  const publisher = params?.publisher;
  if (typeof publisher !== 'string' || !/^[0-9a-f]{64}$/u.test(publisher)) return null;
  const secret = parseCode(params.code);
  return secret ? { publisher, secret } : null;
}

export function enrolLink(publisher, code) {
  return `obsidian://${ENROL_LINK_ACTION}?publisher=${publisher}&code=${encodeURIComponent(code)}`;
}

export function enrollProof(secret, publisher, key) {
  return hmac(secret, `${ENROLL_PROOF_DOMAIN}\n${publisher}\n${canonicalJson(key)}`).then(b64url);
}

export function enrollConfirm(secret, publisher, digestHex) {
  return hmac(secret, `${ENROLL_CONFIRM_DOMAIN}\n${publisher}\n${digestHex}`).then(b64url);
}

export function confirmMatches(expected, received) {
  return sameBytes(fromB64url(expected, 32), fromB64url(received, 32));
}

/** The fingerprint both screens show: first 16 hex of SHA-256(canonical key), four groups. */
export async function keyFingerprint(key) {
  return hex(await sha256(utf8(canonicalJson(key)))).slice(0, 16).match(/.{4}/gu).join(' ');
}

// ---- Keys and signatures ----

export async function createSigningKey() {
  const pair = await subtle().generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
  const publicKey = b64url(new Uint8Array(await subtle().exportKey('raw', pair.publicKey)));
  return { privateKey: pair.privateKey, publicKey };
}

export async function intentDigest(intent) {
  return sha256(intentBytes(intent));
}

/** { type: 'ed25519', signature } over the approval domain line plus the 32-byte digest. */
export async function approvalFor(privateKey, digest) {
  const message = new Uint8Array([...utf8(ED25519_APPROVAL_DOMAIN), ...digest]);
  return { type: 'ed25519', signature: b64url(new Uint8Array(await subtle().sign({ name: 'Ed25519' }, privateKey, message))) };
}

/** The intent this device signs for enrolment, with its proof of the code. */
export async function enrolIntent({ publisher, secret, key, nonce, now, expiresAt }) {
  const issuedAt = now;
  const until = Math.min(expiresAt, now + MAX_LIFETIME_MS);
  return validateIntent({ v: 1, kind: 'enroll', publisher, keyId: key.keyId, nonce, issuedAt, expiresAt: until,
    subject: { key, proof: await enrollProof(secret, publisher, key) } });
}

// ---- Where the signing key lives ----

const DATABASE = 'cyberbaser-signing';
const STORE = 'keys';
const RECORD_KEYS = ['version', 'keyId', 'label', 'publicKey', 'privateKey', 'publisher', 'fingerprint', 'enrolledAt'];

export function validSigning(record) {
  return record !== null && typeof record === 'object' && RECORD_KEYS.every((key) => Object.hasOwn(record, key))
    && record.version === 1 && /^[A-Za-z0-9._-]{1,128}$/u.test(record.keyId) && typeof record.label === 'string'
    && fromB64url(record.publicKey, 32) !== null && /^[0-9a-f]{64}$/u.test(record.publisher)
    && record.privateKey !== null && typeof record.privateKey === 'object';
}

export function createSigningStore(backend, scope) {
  if (typeof scope !== 'string' || scope.length === 0) throw new TypeError('signing store needs a vault scope');
  return Object.freeze({
    async load() { const record = await backend.get(scope); return validSigning(record) ? record : null; },
    async save(record) { if (!validSigning(record)) throw new TypeError('invalid signing record'); await backend.put(scope, record); },
    async clear() { await backend.delete(scope); },
  });
}

export function signingDatabase() {
  return { database: DATABASE, store: STORE };
}

// ---- What the owner is asked to approve ----

export class ApprovalProblem extends Error {
  constructor(reason) { super(reason); this.reason = reason; }
}

const TEXT = new TextDecoder('utf-8', { fatal: true });
function decodeText(bytes) {
  if (bytes === null) return '';
  try { return TEXT.decode(bytes); } catch { return null; }
}

const noteTitle = (path) => path.split('/').at(-1).replace(/\.md$/iu, '');
const oneLine = (value) => value.replace(/\s+/gu, ' ').trim();

/**
 * The site's own name, from this device's .cyberbaser/site.yml (`site.title`,
 * or `title` at the top), or null. Read on the device, never from the node.
 */
export function siteName(siteYml) {
  if (typeof siteYml !== 'string') return null;
  let raw;
  try { raw = yaml.load(siteYml, { schema: yaml.CORE_SCHEMA }); } catch { return null; }
  const isMap = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const value = [isMap(raw) && isMap(raw.site) ? raw.site.title : undefined, isMap(raw) ? raw.title : undefined]
    .find((candidate) => typeof candidate === 'string' && oneLine(candidate) !== '');
  return value === undefined ? null : oneLine(value).slice(0, 80);
}

/**
 * What a new page shows on the approval sheet, read from the exact text being
 * signed: its title and summary (the `title` and `description` properties, as
 * the selector parses them) and the cover, the first property that names one of
 * the images in this same change. images: Map(path -> signed bytes). Values are
 * plain strings; nothing is interpreted as markup.
 */
export function pageDetails(path, text, images = new Map()) {
  const fm = parseFrontmatter(text);
  const data = fm.error ? {} : fm.data;
  const pick = (value) => (typeof value === 'string' && oneLine(value) !== '' ? oneLine(value) : null);
  const coverPath = propertyImageRefs(text).map((ref) => ref.target).find((target) => images.has(target)) ?? null;
  return { title: pick(data.title) ?? noteTitle(path), description: pick(data.description), cover: coverPath };
}

/** "1 new page with 1 photo", "2 new pages", "1 photo". */
export function bundleCountLine(pages, photos) {
  const part = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  if (pages === 0) return part(photos, 'new photo', 'new photos');
  return photos === 0 ? part(pages, 'new page', 'new pages') : `${part(pages, 'new page', 'new pages')} with ${part(photos, 'photo', 'photos')}`;
}

// Whole words and the spaces between them, so a change never shows half a word.
function words(text) {
  return text.match(/\s+|[^\s]+/gu) ?? [];
}

const CONTEXT_WORDS = 12;
const MAX_LCS_CELLS = 2_000_000;

/** A short word-level preview: [{ kind: 'same' | 'gap' | 'removed' | 'added', text }]. */
export function wordPreview(beforeText, afterText) {
  const a = words(beforeText);
  const b = words(afterText);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length; let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA -= 1; endB -= 1; }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  let ops = [];
  if (midA.length * midB.length <= MAX_LCS_CELLS) {
    // Longest common subsequence over words, then walk it.
    const rows = midA.length + 1; const cols = midB.length + 1;
    const table = new Uint32Array(rows * cols);
    for (let i = midA.length - 1; i >= 0; i -= 1) {
      for (let j = midB.length - 1; j >= 0; j -= 1) {
        table[i * cols + j] = midA[i] === midB[j] ? table[(i + 1) * cols + j + 1] + 1
          : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1]);
      }
    }
    let i = 0; let j = 0;
    while (i < midA.length || j < midB.length) {
      if (i < midA.length && j < midB.length && midA[i] === midB[j]) { ops.push(['same', midA[i]]); i += 1; j += 1; }
      // Removed words first, so a replacement reads "old, then new".
      else if (i < midA.length && (j === midB.length || table[(i + 1) * cols + j] >= table[i * cols + j + 1])) { ops.push(['removed', midA[i]]); i += 1; }
      else { ops.push(['added', midB[j]]); j += 1; }
    }
  } else {
    ops = [...midA.map((w) => ['removed', w]), ...midB.map((w) => ['added', w])];
  }
  // Context stays on the changed line: back to the previous line break and on
  // to the next, at most CONTEXT_WORDS words each way.
  const isWord = (token) => !/^\s/u.test(token);
  let from = start;
  for (let seen = 0; from > 0 && !a[from - 1].includes('\n') && seen < CONTEXT_WORDS; from -= 1) if (isWord(a[from - 1])) seen += 1;
  let to = endB;
  for (let seen = 0; to < b.length && !b[to].includes('\n') && seen < CONTEXT_WORDS; to += 1) if (isWord(b[to])) seen += 1;
  const before = a.slice(from, start);
  const after = b.slice(endB, to);
  const parts = [];
  const push = (kind, text) => {
    if (text === '') return;
    const last = parts.at(-1);
    if (last?.kind === kind) last.text += text; else parts.push({ kind, text });
  };
  if (from > 0 && !a[from - 1].includes('\n')) push('gap', '…');
  for (const w of before) push('same', w);
  // Long unchanged runs inside the change shrink to their ends.
  let run = [];
  const flush = () => {
    if (run.length > CONTEXT_WORDS * 2) { for (const w of run.slice(0, CONTEXT_WORDS)) push('same', w); push('gap', '…'); for (const w of run.slice(-CONTEXT_WORDS)) push('same', w); }
    else for (const w of run) push('same', w);
    run = [];
  };
  for (const [kind, w] of ops) {
    if (kind === 'same') { run.push(w); continue; }
    flush();
    push(kind, w);
  }
  flush();
  for (const w of after) push('same', w);
  if (to < b.length && !b[to].includes('\n')) push('gap', '…');
  return parts;
}

function sideBytes(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new ApprovalProblem('approval-invalid');
  }
  return fromBase64(value);
}

/**
 * Check one waiting request from the node and build what the owner sees.
 * Throws ApprovalProblem for anything that does not add up. The summary uses
 * only the intent and bytes whose hashes the intent itself fixes.
 */
export async function prepareApproval({ request, signing, now, publishYml = null, siteYml = null, readChunk = null }) {
  if (!request || typeof request !== 'object' || typeof request.requestId !== 'string') throw new ApprovalProblem('approval-invalid');
  let template;
  try { template = validateIntent({ ...request.intent, keyId: signing.keyId }); } catch { throw new ApprovalProblem('approval-invalid'); }
  if (template.kind !== 'publish') throw new ApprovalProblem('approval-invalid');
  // Only the publisher this device enrolled with; a node cannot redirect.
  if (template.publisher !== signing.publisher) throw new ApprovalProblem('approval-wrong-publisher');
  if (template.expiresAt <= now) throw new ApprovalProblem('approval-expired');
  const files = Array.isArray(request.files) ? request.files : [];
  if (files.length !== template.changes.length) throw new ApprovalProblem('approval-invalid');
  const shown = [];
  const newPages = [];
  const imageBytes = new Map();
  const pageTexts = new Map();
  let newImages = 0;
  for (const [index, change] of template.changes.entries()) {
    const file = files[index];
    if (!file || file.path !== change.path) throw new ApprovalProblem('approval-invalid');
    const sides = {};
    for (const side of ['before', 'after']) {
      let bytes;
      // A new image read in chunks: this device fetches every byte and hashes it.
      if (side === 'after' && file.after === 'chunked') {
        if (change.before !== null || change.after === null || typeof readChunk !== 'function') throw new ApprovalProblem('approval-invalid');
        bytes = await readChunk(change.path);
        if (!(bytes instanceof Uint8Array)) throw new ApprovalProblem('approval-bytes-mismatch');
      } else bytes = sideBytes(file[side] ?? null);
      if ((change[side] === null) !== (bytes === null)) throw new ApprovalProblem('approval-bytes-mismatch');
      if (bytes !== null && hex(await sha256(bytes)) !== change[side].sha256) throw new ApprovalProblem('approval-bytes-mismatch');
      sides[side] = bytes;
    }
    const before = decodeText(sides.before);
    const after = decodeText(sides.after);
    const kind = change.before === null ? 'added' : change.after === null ? 'deleted' : 'edited';
    const markdown = /\.md$/iu.test(change.path);
    // A new file goes public: work out on this device, from its own copy of
    // publish.yml, which pages that makes and where. Never the node's word.
    if (kind === 'added' && markdown) {
      if (typeof publishYml !== 'string') throw new ApprovalProblem('approval-public-unknown');
      if (after === null) throw new ApprovalProblem('approval-invalid');
      const status = notePublicStatus({ path: change.path, text: after, publishYml, siteYml });
      if (status.rule === 'address-style-unknown') throw new ApprovalProblem('approval-public-unknown');
      if (!status.published) throw new ApprovalProblem('approval-private-note');
      newPages.push({ path: change.path, address: status.address });
      pageTexts.set(change.path, after);
    } else if (kind === 'added' && change.path !== 'publish.yml') {
      const asset = checkAsset(change.path, sides.after);
      if (!asset.ok) throw new ApprovalProblem('approval-image-refused');
      imageBytes.set(change.path, { bytes: sides.after, mediaType: asset.mediaType });
      newImages += 1;
    }
    const binary = kind === 'added' && !markdown && change.path !== 'publish.yml';
    shown.push({ path: change.path, title: noteTitle(change.path), kind,
      preview: binary || before === null || after === null ? null : wordPreview(before, after),
      ...(binary ? { image: true, byteLength: sides.after.length } : {}),
      modeChanged: change.before !== null && change.after !== null && change.before.mode !== change.after.mode });
  }
  // The node's list of new public pages must be exactly what this device found.
  const claimed = Array.isArray(request.publicAdditions) ? request.publicAdditions : [];
  const key = (list) => JSON.stringify(list.map((entry) => [entry?.path, entry?.address]).sort());
  if (key(claimed) !== key(newPages)) throw new ApprovalProblem('approval-public-mismatch');
  // What each new page looks like, from the same signed bytes: title, summary,
  // cover photo (its exact signed bytes), and the exact text, for "Show exact text".
  const images = new Map([...imageBytes].map(([path, value]) => [path, value.bytes]));
  const pages = newPages.map(({ path, address }) => {
    const text = pageTexts.get(path);
    const details = pageDetails(path, text, images);
    const cover = details.cover === null ? null : Object.freeze({ path: details.cover, ...imageBytes.get(details.cover) });
    return Object.freeze({ path, address, title: details.title, description: details.description, cover, text });
  });
  const covers = new Set(pages.map((page) => page.cover?.path).filter(Boolean));
  const photos = [...imageBytes].filter(([path]) => !covers.has(path))
    .map(([path, value]) => Object.freeze({ path, ...value }));
  const remote = template.target.remote;
  const repository = /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/u.exec(remote)?.[1] ?? remote.replace(/^https:\/\//u, '');
  return Object.freeze({
    // Who asked is the node's word, so it is not shown.
    requestId: request.requestId,
    template,
    summary: Object.freeze({
      repository, remote, branch: template.target.branch, files: shown,
      message: template.commit.message.trimEnd(),
      changesBuild: template.changes.some((change) => change.path.startsWith('.github/')),
      expiresAt: template.expiresAt,
      // "New public page: /address, plus N images", shown as its own line.
      newPages: Object.freeze(newPages), newImages,
      // The sheet for page bundles: the site's name (this device's site.yml),
      // "1 new page with 1 photo", and each page as it will read.
      site: siteName(siteYml),
      counts: newPages.length + newImages === 0 ? null : bundleCountLine(newPages.length, newImages),
      pages: Object.freeze(pages), photos: Object.freeze(photos),
    }),
  });
}

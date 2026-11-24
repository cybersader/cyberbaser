// After a page bundle is pushed: the evidence its durable job starts from.
//
// A bundle is checked, signed and pushed outside the edit pipeline (the bundle
// desk and the publisher's publish-bundle). Once the publisher reports the
// push, the node records it as an ordinary durable job that begins at
// `pushed` and then runs the same deployment watch, a live check for each new
// page and image, and the local rebuild as any edit (pipeline.js). Everything
// here is read from the pushed commit's own Git objects, never from the
// device's copy.
import { createHash } from 'node:crypto';
import { fileSlug, readAddressStyle } from '../../../packages/publish/src/index.js';
import { findFrontmatterInText } from '../../../packages/correction/src/frontmatter.js';
import { fail } from './errors.js';
import { deepFreeze, isPlainObject } from './json.js';
import { witnessDigest } from './live-confirm.js';
import { liveUrlForSlug } from './source.js';

export const PAGE_BUNDLE_ORIGIN = 'page-bundle';
const OID = /^[0-9a-f]{40}$/u;
const BUNDLE_ID = /^bundle-[0-9a-f-]{36}$/u;
const SITE_CONFIG = '.cyberbaser/site.yml';

/** The durable job that follows one bundle after its push. */
export function bundleJobId(bundleId) {
  if (typeof bundleId !== 'string' || !BUNDLE_ID.test(bundleId)) fail('invalid-job-id', 'not a bundle id');
  return `OA-${bundleId}`;
}

// The note's own title (front matter `title:`), else its file name: the text a
// reader sees at the top of the new page.
export function pageWitness(text, vaultPath) {
  const found = findFrontmatterInText(text);
  const line = found.yamlText?.match(/^title:[ \t]*([^\r\n]+)$/mu)?.[1];
  const title = line?.trim().replace(/^(["'])(.*)\1$/u, '$2').trim();
  const fallback = vaultPath.split('/').at(-1).replace(/\.md$/iu, '').trim();
  const witness = (title || fallback).replace(/\s+/gu, ' ');
  if (witness === '' || /\p{Cc}/u.test(witness)) fail('live-witness-evidence-missing', 'the new page has no visible title to check');
  return witness;
}

function addressToSlug(address) {
  if (typeof address !== 'string' || !address.startsWith('/')) fail('invalid-live-url', 'a new page has no address');
  const trimmed = address.slice(1);
  if (trimmed === '') return 'index';
  return trimmed.endsWith('/') ? `${trimmed}index` : trimmed;
}

function fileUrl(baseUrl, slug) {
  const encoded = slug.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  return new URL(encoded, baseUrl).toString();
}

/**
 * { session, committed, pushed } for one published bundle record.
 * record: the bundle desk's record (commit, publicAdditions, images, bundleId).
 * result: the publisher's publish-bundle answer ({ commit, branch, receipt }).
 * git(args) -> Buffer, reading the node's checkout objects.
 */
export async function pushedBundleEvidence({ config, record, result, git }) {
  if (!isPlainObject(record) || !OID.test(record.commit ?? '') || !Array.isArray(record.publicAdditions) || !Array.isArray(record.images)) {
    fail('bundle-not-reviewable', 'the bundle record is incomplete');
  }
  if (!isPlainObject(result) || result.commit !== record.commit || result.branch !== config.repository.branch) {
    fail('publisher-receipt-mismatch', 'the publisher pushed a different commit or branch than the bundle');
  }
  const blob = async (p) => git(['cat-file', 'blob', `${record.commit}:${p}`]);
  const base = (await git(['rev-parse', '--verify', `${record.commit}^1`])).toString('utf8').trim();
  if (!OID.test(base)) fail('commit-unreadable', 'the bundle commit has no parent');
  const siteYml = await blob(SITE_CONFIG).then((bytes) => bytes.toString('utf8'), () => null);
  const style = readAddressStyle(siteYml);
  if (!style.ok) fail('address-style-unknown', 'this vault names an address style Cyberbaser does not know');
  const baseUrl = config.live.baseUrl;
  const pages = [];
  for (const addition of record.publicAdditions) {
    if (!isPlainObject(addition) || typeof addition.path !== 'string') fail('bundle-not-reviewable', 'a new page entry is invalid');
    const witness = pageWitness((await blob(addition.path)).toString('utf8'), addition.path);
    pages.push({ path: addition.path, address: addition.address, liveUrl: liveUrlForSlug(baseUrl, addressToSlug(addition.address)),
      witness, witnessDigest: witnessDigest(witness) });
  }
  const images = [];
  for (const image of record.images) {
    const bytes = await blob(image.path);
    const slug = fileSlug(image.path, style.style);
    if (slug === null) fail('create-path-refused', 'an image has no web address', { path: image.path });
    images.push({ path: image.path, url: fileUrl(baseUrl, slug), byteLength: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  if (pages.length + images.length === 0) return null;
  const receipt = result.receipt === undefined || result.receipt === null ? {}
    : { publisherReceiptBase64: Buffer.from(JSON.stringify(result.receipt), 'utf8').toString('base64') };
  return deepFreeze({
    session: {
      origin: { type: PAGE_BUNDLE_ORIGIN, bundleId: record.bundleId, commit: record.commit, base },
      relativePath: pages[0]?.path ?? images[0].path,
      pages,
      images,
    },
    committed: { status: 'committed', commit: record.commit, base, origin: PAGE_BUNDLE_ORIGIN, bundleId: record.bundleId },
    pushed: { status: 'pushed', commit: record.commit, remoteRef: record.commit, branch: config.repository.branch,
      remote: config.repository.remote.name, origin: PAGE_BUNDLE_ORIGIN, ...receipt },
  });
}

/** The bundle session a job stores, checked before anything reads it. */
export function validateBundleSession(session) {
  const origin = session?.origin;
  if (!isPlainObject(session) || !isPlainObject(origin) || origin.type !== PAGE_BUNDLE_ORIGIN
    || !BUNDLE_ID.test(origin.bundleId ?? '') || !OID.test(origin.commit ?? '') || !OID.test(origin.base ?? '')
    || typeof session.relativePath !== 'string' || !Array.isArray(session.pages) || !Array.isArray(session.images)
    || session.pages.length + session.images.length === 0
    || session.pages.some((page) => typeof page?.liveUrl !== 'string' || typeof page.witness !== 'string'
      || page.witnessDigest !== witnessDigest(page.witness))
    || session.images.some((image) => typeof image?.url !== 'string' || !Number.isSafeInteger(image.byteLength)
      || !/^[0-9a-f]{64}$/u.test(image.sha256 ?? ''))) {
    fail('invalid-bundle-session', 'the bundle job evidence is invalid');
  }
  return session;
}

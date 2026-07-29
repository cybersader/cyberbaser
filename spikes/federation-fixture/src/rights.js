import {
  FIXED_CLOCK,
  RIGHTS_MODES,
  deepFreeze,
  parseSha256Digest,
  sha256Digest,
  verifySha256Digest,
} from './contracts.js';

export const MIRROR_AUTHORITY_SCOPE = 'licensed-copy-only';

export class RightsPolicyError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'RightsPolicyError';
    this.code = code;
    this.details = details;
  }
}

function requireRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RightsPolicyError('invalid-record', `${label} must be an object`);
  }
  return value;
}

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RightsPolicyError('invalid-string', `${label} must be a non-empty string`);
  }
  return value;
}

function publisherOrigin(value, label) {
  const text = requireNonEmptyString(value, label);
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new RightsPolicyError('invalid-publisher', `${label} must be an absolute HTTPS origin`);
  }
  if (
    url.protocol !== 'https:'
    || url.username
    || url.password
    || url.pathname !== '/'
    || url.search
    || url.hash
  ) {
    throw new RightsPolicyError('invalid-publisher', `${label} must be an absolute HTTPS origin`);
  }
  return url.origin;
}

function ownedUrl(value, owner, label) {
  const text = requireNonEmptyString(value, label);
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new RightsPolicyError('invalid-url', `${label} must be an absolute HTTPS URL`);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.origin !== owner) {
    throw new RightsPolicyError('invalid-url', `${label} must be an uncredentialed HTTPS URL owned by ${owner}`);
  }
  return url.href;
}

function absoluteHttpsUrl(value, label) {
  const text = requireNonEmptyString(value, label);
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new RightsPolicyError('invalid-url', `${label} must be an absolute HTTPS URL`);
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new RightsPolicyError('invalid-url', `${label} must be an uncredentialed HTTPS URL`);
  }
  return url.href;
}

function exactBytes(value, label) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new RightsPolicyError('invalid-bytes', `${label} must be a Buffer or Uint8Array`);
}

function normalizeTimestamp(value, label) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new RightsPolicyError('invalid-timestamp', `${label} must be an ISO-8601 timestamp`);
  }
  return value;
}

function normalizeRights(rights, sourceUrl) {
  requireRecord(rights, 'source.rights');
  if (!RIGHTS_MODES.includes(rights.mode)) {
    throw new RightsPolicyError('invalid-rights-mode', `source.rights.mode must be one of ${RIGHTS_MODES.join(', ')}`);
  }
  const normalized = {
    mode: rights.mode,
    summary: requireNonEmptyString(rights.summary, 'source.rights.summary'),
  };
  if (rights.license !== undefined && rights.license !== null) {
    normalized.license = absoluteHttpsUrl(rights.license, 'source.rights.license');
  }
  if (rights.source !== undefined && rights.source !== null) {
    normalized.source = absoluteHttpsUrl(rights.source, 'source.rights.source');
  }
  if (rights.attribution !== undefined && rights.attribution !== null) {
    normalized.attribution = requireNonEmptyString(rights.attribution, 'source.rights.attribution');
  }
  if (normalized.source !== undefined && normalized.source !== sourceUrl) {
    throw new RightsPolicyError('rights-source-mismatch', 'source.rights.source must identify the exact owner URL being considered');
  }
  return normalized;
}

function normalizeSource(source) {
  requireRecord(source, 'source');
  const publisher = publisherOrigin(source.publisher, 'source.publisher');
  const url = ownedUrl(source.url, publisher, 'source.url');
  return {
    publisher,
    url,
    revision: source.revision === undefined || source.revision === null
      ? null
      : requireNonEmptyString(source.revision, 'source.revision'),
    digest: requireNonEmptyString(source.digest, 'source.digest'),
    byteLength: source.byteLength,
    rights: normalizeRights(source.rights, url),
  };
}

function linkOnlyDecision(source) {
  return deepFreeze({
    decision: 'link-only',
    permitted: false,
    bodyCopied: false,
    directOwnerUrl: source.url,
    sourcePublisher: source.publisher,
    rights: source.rights,
    warning: source.rights.mode === 'link-only'
      ? 'The owner permits linking but has not granted republication rights.'
      : 'No compatible licensed-reuse grant was verified; retain only the direct owner link.',
    authority: {
      source: {
        publisher: source.publisher,
        url: source.url,
        scope: 'source-publication',
      },
      sourceAuthorityTransferred: false,
    },
  });
}

/**
 * Decide whether a source representation may be republished by a different
 * fixture origin. Only an explicit `licensed-reuse` grant can produce bytes.
 * Every other rights mode returns a metadata-only direct-link decision.
 */
export function planRepublication({
  source,
  destination = null,
  sourceBytes = null,
  mirrorBytes = null,
  retrievedAt = null,
  modifications = [],
  clock = FIXED_CLOCK,
} = {}) {
  const normalizedSource = normalizeSource(source);
  if (normalizedSource.rights.mode !== 'licensed-reuse') return linkOnlyDecision(normalizedSource);

  requireRecord(destination, 'destination');
  const mirrorPublisher = publisherOrigin(destination.publisher, 'destination.publisher');
  const mirrorUrl = ownedUrl(destination.url, mirrorPublisher, 'destination.url');
  if (mirrorPublisher === normalizedSource.publisher) {
    throw new RightsPolicyError('mirror-owner-not-independent', 'the licensed mirror must remain a separately owned publication');
  }

  if (!parseSha256Digest(normalizedSource.digest)) {
    throw new RightsPolicyError('invalid-source-digest', 'source.digest must be an RFC-9530-style SHA-256 digest');
  }
  if (!Number.isSafeInteger(normalizedSource.byteLength) || normalizedSource.byteLength < 0) {
    throw new RightsPolicyError('invalid-source-length', 'source.byteLength must be a non-negative safe integer');
  }
  if (!normalizedSource.rights.license || !normalizedSource.rights.attribution) {
    throw new RightsPolicyError('incomplete-license', 'licensed reuse requires an HTTPS license URL and non-empty attribution');
  }

  const exactSourceBytes = exactBytes(sourceBytes, 'sourceBytes');
  if (exactSourceBytes.byteLength !== normalizedSource.byteLength) {
    throw new RightsPolicyError('source-length-mismatch', 'sourceBytes do not match the declared source byte length');
  }
  if (!verifySha256Digest(exactSourceBytes, normalizedSource.digest)) {
    throw new RightsPolicyError('source-digest-mismatch', 'sourceBytes do not match the declared source digest');
  }

  const exactMirrorBytes = mirrorBytes === null
    ? Buffer.from(exactSourceBytes)
    : exactBytes(mirrorBytes, 'mirrorBytes');
  if (!Array.isArray(modifications) || modifications.some((entry) => typeof entry !== 'string' || entry.trim() === '')) {
    throw new RightsPolicyError('invalid-modifications', 'modifications must be an array of non-empty strings');
  }

  const observedAt = normalizeTimestamp(retrievedAt ?? clock?.now?.(), 'retrievedAt');
  const mirror = deepFreeze({
    kind: 'licensed-mirror',
    publisher: mirrorPublisher,
    url: mirrorUrl,
    revision: requireNonEmptyString(destination.revision, 'destination.revision'),
    byteLength: exactMirrorBytes.byteLength,
    digest: sha256Digest(exactMirrorBytes),
    rights: {
      mode: 'licensed-reuse',
      summary: normalizedSource.rights.summary,
      license: normalizedSource.rights.license,
      attribution: normalizedSource.rights.attribution,
      source: normalizedSource.url,
    },
    provenance: {
      sourcePublisher: normalizedSource.publisher,
      sourceUrl: normalizedSource.url,
      sourceRevision: normalizedSource.revision,
      sourceDigest: normalizedSource.digest,
      sourceByteLength: normalizedSource.byteLength,
      retrievedAt: observedAt,
      modifications: [...modifications],
    },
    authority: {
      mirror: {
        publisher: mirrorPublisher,
        url: mirrorUrl,
        scope: MIRROR_AUTHORITY_SCOPE,
      },
      source: {
        publisher: normalizedSource.publisher,
        url: normalizedSource.url,
        scope: 'source-publication',
      },
      sourceAuthorityTransferred: false,
    },
  });

  const verification = verifyLicensedMirrorProvenance(mirror, {
    sourceBytes: exactSourceBytes,
    mirrorBytes: exactMirrorBytes,
  });
  if (!verification.ok) {
    throw new RightsPolicyError('invalid-mirror-provenance', 'licensed mirror provenance did not verify', {
      errors: verification.errors,
    });
  }

  return {
    decision: 'licensed-mirror',
    permitted: true,
    bodyCopied: true,
    mirror,
    publicationBytes: Buffer.from(exactMirrorBytes),
  };
}

/** Verify both the source fixity claim and the separately owned mirror bytes. */
export function verifyLicensedMirrorProvenance(mirror, { sourceBytes, mirrorBytes } = {}) {
  const errors = [];
  const add = (path, code, message) => errors.push({ path, code, message });

  if (!mirror || typeof mirror !== 'object' || Array.isArray(mirror)) {
    add('$', 'type', 'mirror must be an object');
    return { ok: false, errors };
  }
  if (mirror.kind !== 'licensed-mirror') add('$.kind', 'kind', 'must equal licensed-mirror');

  let publisher = null;
  let sourcePublisher = null;
  let mirrorUrl = null;
  let sourceUrl = null;
  try { publisher = publisherOrigin(mirror.publisher, 'mirror.publisher'); } catch (error) { add('$.publisher', error.code, error.message); }
  try { sourcePublisher = publisherOrigin(mirror.provenance?.sourcePublisher, 'mirror.provenance.sourcePublisher'); } catch (error) { add('$.provenance.sourcePublisher', error.code, error.message); }
  if (publisher) {
    try { mirrorUrl = ownedUrl(mirror.url, publisher, 'mirror.url'); } catch (error) { add('$.url', error.code, error.message); }
  }
  if (sourcePublisher) {
    try { sourceUrl = ownedUrl(mirror.provenance?.sourceUrl, sourcePublisher, 'mirror.provenance.sourceUrl'); } catch (error) { add('$.provenance.sourceUrl', error.code, error.message); }
  }
  if (publisher && sourcePublisher && publisher === sourcePublisher) {
    add('$.publisher', 'authority-separation', 'mirror and source publishers must remain distinct');
  }

  if (mirror.authority?.sourceAuthorityTransferred !== false) {
    add('$.authority.sourceAuthorityTransferred', 'authority-transfer', 'must be explicitly false');
  }
  if (
    mirror.authority?.mirror?.publisher !== publisher
    || mirror.authority?.mirror?.url !== mirrorUrl
    || mirror.authority?.mirror?.scope !== MIRROR_AUTHORITY_SCOPE
  ) {
    add('$.authority.mirror', 'mirror-authority', 'must describe only the mirror publisher and URL');
  }
  if (
    mirror.authority?.source?.publisher !== sourcePublisher
    || mirror.authority?.source?.url !== sourceUrl
    || mirror.authority?.source?.scope !== 'source-publication'
  ) {
    add('$.authority.source', 'source-authority', 'must preserve the original publisher and owner URL');
  }

  const sourceDigest = mirror.provenance?.sourceDigest;
  const sourceLength = mirror.provenance?.sourceByteLength;
  if (!parseSha256Digest(sourceDigest)) add('$.provenance.sourceDigest', 'digest', 'must be an RFC-9530-style SHA-256 digest');
  if (!Number.isSafeInteger(sourceLength) || sourceLength < 0) add('$.provenance.sourceByteLength', 'byte-length', 'must be a non-negative safe integer');
  if (mirror.provenance?.sourceRevision !== null && (typeof mirror.provenance?.sourceRevision !== 'string' || mirror.provenance.sourceRevision === '')) {
    add('$.provenance.sourceRevision', 'revision', 'must be a non-empty string or null');
  }
  if (typeof mirror.provenance?.retrievedAt !== 'string' || Number.isNaN(Date.parse(mirror.provenance.retrievedAt))) {
    add('$.provenance.retrievedAt', 'timestamp', 'must be an ISO-8601 timestamp');
  }
  if (!Array.isArray(mirror.provenance?.modifications) || mirror.provenance.modifications.some((entry) => typeof entry !== 'string' || entry === '')) {
    add('$.provenance.modifications', 'modifications', 'must be an array of non-empty strings');
  }

  if (mirror.rights?.mode !== 'licensed-reuse') add('$.rights.mode', 'rights-mode', 'must equal licensed-reuse');
  if (mirror.rights?.source !== sourceUrl) add('$.rights.source', 'rights-source', 'must equal the exact source owner URL');
  try { absoluteHttpsUrl(mirror.rights?.license, 'mirror.rights.license'); } catch (error) { add('$.rights.license', error.code, error.message); }
  if (typeof mirror.rights?.attribution !== 'string' || mirror.rights.attribution.trim() === '') {
    add('$.rights.attribution', 'attribution', 'must be non-empty');
  }

  let exactSourceBytes = null;
  let exactMirrorBytes = null;
  try { exactSourceBytes = exactBytes(sourceBytes, 'sourceBytes'); } catch (error) { add('$<sourceBytes>', error.code, error.message); }
  try { exactMirrorBytes = exactBytes(mirrorBytes, 'mirrorBytes'); } catch (error) { add('$<mirrorBytes>', error.code, error.message); }

  if (exactSourceBytes) {
    if (exactSourceBytes.byteLength !== sourceLength) add('$<sourceBytes>', 'source-length-mismatch', 'bytes do not match sourceByteLength');
    if (parseSha256Digest(sourceDigest) && !verifySha256Digest(exactSourceBytes, sourceDigest)) {
      add('$<sourceBytes>', 'source-digest-mismatch', 'bytes do not match sourceDigest');
    }
  }
  if (!Number.isSafeInteger(mirror.byteLength) || mirror.byteLength < 0) add('$.byteLength', 'byte-length', 'must be a non-negative safe integer');
  if (!parseSha256Digest(mirror.digest)) add('$.digest', 'digest', 'must be an RFC-9530-style SHA-256 digest');
  if (exactMirrorBytes) {
    if (exactMirrorBytes.byteLength !== mirror.byteLength) add('$<mirrorBytes>', 'mirror-length-mismatch', 'bytes do not match mirror.byteLength');
    if (parseSha256Digest(mirror.digest) && !verifySha256Digest(exactMirrorBytes, mirror.digest)) {
      add('$<mirrorBytes>', 'mirror-digest-mismatch', 'bytes do not match mirror.digest');
    }
  }

  return { ok: errors.length === 0, errors };
}

export function assertLicensedMirrorProvenance(mirror, bytes) {
  const result = verifyLicensedMirrorProvenance(mirror, bytes);
  if (!result.ok) {
    throw new RightsPolicyError('invalid-mirror-provenance', 'licensed mirror provenance did not verify', {
      errors: result.errors,
    });
  }
  return mirror;
}

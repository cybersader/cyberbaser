import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Fixture-only profile identifier. It is deliberately a URN rather than a live
 * profile URL, so this spike cannot accidentally become a runtime authority.
 */
export const FIXTURE_PROFILE_URN = 'urn:cyberbaser:fixture:federation:2026-07-27';

/** Every generated or observed timestamp in the fixture is injected from here. */
export const FIXED_NOW = '2026-07-27T12:00:00.000Z';
export const FIXED_CLOCK = Object.freeze({
  now: () => FIXED_NOW,
  date: () => new Date(FIXED_NOW),
});

export const DIGEST_ALGORITHM = 'sha-256';
export const INVENTORY_RULE = 'complete-served-snapshot-excluding-only-the-inventory-itself';

export const RIGHTS_MODES = Object.freeze([
  'owner-published',
  'licensed-reuse',
  'link-only',
  'unknown',
]);

export const HISTORY_MODES = Object.freeze([
  'snapshot-only',
  'retained-revisions',
]);

export const OBSERVATION_STATES = Object.freeze([
  'current',
  'stale',
  'unavailable',
  'deleted',
]);

/** RFC 9264 extension attributes used to retain source qualification. */
export const LINKSET_EVIDENCE = Object.freeze({
  issuer: 'cb-issuer',
  assertionId: 'cb-assertion-id',
  observedAt: 'cb-observed-at',
  sourceDigest: 'cb-source-digest',
  rationale: 'cb-rationale',
  evidence: 'cb-evidence',
});

export const RELATIONS = Object.freeze({
  describedBy: 'describedby',
  item: 'item',
  related: 'related',
  exactMatch: 'http://www.w3.org/2004/02/skos/core#exactMatch',
  closeMatch: 'http://www.w3.org/2004/02/skos/core#closeMatch',
  annotation: `${FIXTURE_PROFILE_URN}:annotation`,
  collection: `${FIXTURE_PROFILE_URN}:collection`,
  mirror: `${FIXTURE_PROFILE_URN}:mirror`,
});

/** Relations the fixture crawler may follow. Unknown metadata remains inert. */
export const DEFAULT_RELATION_ALLOWLIST = Object.freeze([
  RELATIONS.describedBy,
  RELATIONS.item,
  RELATIONS.related,
  RELATIONS.exactMatch,
  RELATIONS.closeMatch,
  RELATIONS.annotation,
  RELATIONS.collection,
  RELATIONS.mirror,
]);

/**
 * Small enough to terminate malicious fixture cycles quickly while still
 * allowing all five origins and the Atlas/Cautious recursion to be exercised.
 */
export const DEFAULT_CRAWL_BUDGETS = Object.freeze({
  maxDepth: 4,
  maxOrigins: 5,
  maxUrls: 64,
  maxRedirects: 8,
  maxResponseBytes: 512 * 1024,
  maxTotalBytes: 4 * 1024 * 1024,
  maxDecompressedBytes: 1024 * 1024,
  maxParserBytes: 512 * 1024,
  maxParserMs: 250,
  maxWallTimeMs: 5_000,
  maxConcurrency: 3,
});

export const CRAWL_BUDGET_KEYS = Object.freeze(Object.keys(DEFAULT_CRAWL_BUDGETS));

/** Human-readable field contracts used by tests and cache exporters. */
export const ASSERTION_SHAPE = Object.freeze({
  required: Object.freeze([
    'assertionId',
    'issuer',
    'subject',
    'relation',
    'target',
    'rationale',
    'evidence',
  ]),
  evidenceRequired: Object.freeze([
    'sourceUrl',
    'sourceDigest',
    'targetRevision',
    'targetDigest',
    'observedAt',
  ]),
});

export const CACHE_RECORD_SHAPE = Object.freeze({
  required: Object.freeze([
    'publisher',
    'issuer',
    'assertionId',
    'fetchedUrl',
    'discoveryChain',
    'sourceDigest',
    'observation',
    'rights',
    'rawArtifact',
    'assertion',
  ]),
  observationRequired: Object.freeze([
    'state',
    'observedAt',
    'verifiedAt',
    'httpStatus',
  ]),
  rawArtifactRequired: Object.freeze([
    'url',
    'mediaType',
    'byteLength',
    'digest',
    'fetchedAt',
  ]),
});

export function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return value;
  if (seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) deepFreeze(value[key], seen);
  return Object.freeze(value);
}

function canonicalize(value, at, seen) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${at} contains a non-finite number`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object') throw new TypeError(`${at} contains unsupported JSON value ${typeof value}`);
  if (seen.has(value)) throw new TypeError(`${at} contains a cycle`);
  seen.add(value);

  if (Array.isArray(value)) {
    const result = value.map((entry, index) => canonicalize(entry, `${at}[${index}]`, seen));
    seen.delete(value);
    return result;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${at} must contain only plain JSON objects`);
  }

  const result = {};
  for (const key of Object.keys(value).sort()) {
    const entry = value[key];
    if (entry === undefined) throw new TypeError(`${at}.${key} is undefined`);
    result[key] = canonicalize(entry, `${at}.${key}`, seen);
  }
  seen.delete(value);
  return result;
}

/** Recursively sorts object keys, preserves array order, uses two spaces, and appends one LF. */
export function stableStringify(value) {
  return `${JSON.stringify(canonicalize(value, '$', new WeakSet()), null, 2)}\n`;
}

export function stableJsonBytes(value) {
  return Buffer.from(stableStringify(value), 'utf8');
}

function toBytes(value) {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  throw new TypeError('digest input must be a string, Buffer, Uint8Array, or ArrayBuffer');
}

/** RFC 9530 Digest Fields shape, fixed to SHA-256: `sha-256=:<base64>:`. */
export function sha256Digest(value) {
  const base64 = createHash('sha256').update(toBytes(value)).digest('base64');
  return `${DIGEST_ALGORITHM}=:${base64}:`;
}

export function parseSha256Digest(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^sha-256=:([A-Za-z0-9+/]{43}=):$/);
  if (!match) return null;
  const bytes = Buffer.from(match[1], 'base64');
  return bytes.length === 32 ? bytes : null;
}

export function verifySha256Digest(value, expected) {
  const expectedBytes = parseSha256Digest(expected);
  if (!expectedBytes) return false;
  const actual = createHash('sha256').update(toBytes(value)).digest();
  return timingSafeEqual(actual, expectedBytes);
}

function issue(errors, path, code, message) {
  errors.push({ path, code, message });
}

function validation(errors) {
  return { ok: errors.length === 0, errors };
}

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireRecord(value, path, errors) {
  if (isRecord(value)) return true;
  issue(errors, path, 'type', 'must be a JSON object');
  return false;
}

function requireFields(value, fields, path, errors) {
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) issue(errors, `${path}.${field}`, 'required', 'field is required');
  }
}

function asHttpsUrl(value, path, errors, options = {}) {
  if (typeof value !== 'string') {
    issue(errors, path, 'url-type', 'must be an absolute HTTPS URL string');
    return null;
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    issue(errors, path, 'url-invalid', 'must be an absolute HTTPS URL');
    return null;
  }
  if (url.protocol !== 'https:') issue(errors, path, 'url-scheme', 'must use HTTPS');
  if (url.username || url.password) issue(errors, path, 'url-credentials', 'must not contain credentials');
  if (!options.allowFragment && url.hash) issue(errors, path, 'url-fragment', 'must not contain a fragment');
  if (options.origin && url.origin !== options.origin) {
    issue(errors, path, 'url-owner', `must be controlled by ${options.origin}`);
  }
  if (options.allowedOrigins && !options.allowedOrigins.includes(url.origin)) {
    issue(errors, path, 'url-fixture-origin', `origin ${url.origin} is not in the fixture topology`);
  }
  return url;
}

function asPublisherOrigin(value, path, errors) {
  const url = asHttpsUrl(value, path, errors);
  if (!url) return null;
  if (url.pathname !== '/' || url.search || url.hash) {
    issue(errors, path, 'publisher-origin', 'publisher must be an HTTPS origin with no path, query, or fragment');
  }
  return url.origin;
}

function validateTimestamp(value, path, errors, expectedTime = null) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    issue(errors, path, 'timestamp', 'must be an ISO-8601 timestamp string');
    return;
  }
  if (expectedTime !== null && value !== expectedTime) {
    issue(errors, path, 'fixed-clock', `must equal the injected fixture time ${expectedTime}`);
  }
}

function validateSortedUniqueStrings(value, path, errors, { nonEmpty = false } = {}) {
  if (!Array.isArray(value)) {
    issue(errors, path, 'array', 'must be an array');
    return;
  }
  if (nonEmpty && value.length === 0) issue(errors, path, 'non-empty', 'must not be empty');
  if (value.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
    issue(errors, path, 'string-array', 'must contain only non-empty strings');
    return;
  }
  const sorted = [...value].sort();
  if (new Set(value).size !== value.length) issue(errors, path, 'unique', 'must not contain duplicates');
  if (value.some((entry, index) => entry !== sorted[index])) issue(errors, path, 'sorted', 'must be sorted lexically');
}

function validateRights(value, path, errors) {
  if (!requireRecord(value, path, errors)) return;
  requireFields(value, ['mode', 'summary'], path, errors);
  if (!RIGHTS_MODES.includes(value.mode)) {
    issue(errors, `${path}.mode`, 'rights-mode', `must be one of ${RIGHTS_MODES.join(', ')}`);
  }
  if (typeof value.summary !== 'string' || value.summary.trim() === '') {
    issue(errors, `${path}.summary`, 'rights-summary', 'must be a non-empty string');
  }
  if (value.license !== undefined && value.license !== null) asHttpsUrl(value.license, `${path}.license`, errors);
  if (value.source !== undefined && value.source !== null) asHttpsUrl(value.source, `${path}.source`, errors);
  if (value.attribution !== undefined && value.attribution !== null && typeof value.attribution !== 'string') {
    issue(errors, `${path}.attribution`, 'rights-attribution', 'must be a string or null');
  }
}

export function validateDescriptor(value, options = {}) {
  const errors = [];
  if (!requireRecord(value, '$', errors)) return validation(errors);
  requireFields(value, ['profile', 'publisher', 'homepage', 'inventory', 'linksets', 'policies', 'capabilities'], '$', errors);

  if (value.profile !== FIXTURE_PROFILE_URN) {
    issue(errors, '$.profile', 'profile', `must equal ${FIXTURE_PROFILE_URN}`);
  }

  const publisher = asPublisherOrigin(value.publisher, '$.publisher', errors);
  if (options.publisher && publisher !== options.publisher) {
    issue(errors, '$.publisher', 'publisher-mismatch', `must equal ${options.publisher}`);
  }
  if (publisher) {
    asHttpsUrl(value.homepage, '$.homepage', errors, { origin: publisher });
    asHttpsUrl(value.inventory, '$.inventory', errors, { origin: publisher });
  }

  if (!Array.isArray(value.linksets) || value.linksets.length === 0) {
    issue(errors, '$.linksets', 'linksets', 'must be a non-empty array');
  } else if (publisher) {
    for (const [index, linkset] of value.linksets.entries()) {
      asHttpsUrl(linkset, `$.linksets[${index}]`, errors, { origin: publisher });
    }
    validateSortedUniqueStrings(value.linksets, '$.linksets', errors, { nonEmpty: true });
  }

  if (requireRecord(value.policies, '$.policies', errors)) {
    requireFields(value.policies, ['rights', 'history'], '$.policies', errors);
    validateRights(value.policies.rights, '$.policies.rights', errors);
    if (requireRecord(value.policies.history, '$.policies.history', errors)) {
      requireFields(value.policies.history, ['mode', 'summary'], '$.policies.history', errors);
      if (!HISTORY_MODES.includes(value.policies.history.mode)) {
        issue(errors, '$.policies.history.mode', 'history-mode', `must be one of ${HISTORY_MODES.join(', ')}`);
      }
      if (typeof value.policies.history.summary !== 'string' || value.policies.history.summary.trim() === '') {
        issue(errors, '$.policies.history.summary', 'history-summary', 'must be a non-empty string');
      }
    }
  }

  validateSortedUniqueStrings(value.capabilities, '$.capabilities', errors, { nonEmpty: true });
  if (Array.isArray(value.capabilities)) {
    for (const capability of ['complete-inventory', 'describedby', 'linkset']) {
      if (!value.capabilities.includes(capability)) {
        issue(errors, '$.capabilities', 'capability-required', `must exercise ${capability}`);
      }
    }
  }

  return validation(errors);
}

export function validateInventory(value, options = {}) {
  const errors = [];
  if (!requireRecord(value, '$', errors)) return validation(errors);
  requireFields(value, ['profile', 'publisher', 'inventory', 'generatedAt', 'complete', 'items'], '$', errors);

  if (value.profile !== FIXTURE_PROFILE_URN) issue(errors, '$.profile', 'profile', `must equal ${FIXTURE_PROFILE_URN}`);
  const publisher = asPublisherOrigin(value.publisher, '$.publisher', errors);
  const inventoryUrl = publisher
    ? asHttpsUrl(value.inventory, '$.inventory', errors, { origin: publisher })
    : null;
  validateTimestamp(value.generatedAt, '$.generatedAt', errors, options.expectedTime ?? FIXED_NOW);
  if (value.complete !== true) issue(errors, '$.complete', 'inventory-complete', 'must be true');

  if (!Array.isArray(value.items)) {
    issue(errors, '$.items', 'items', 'must be an array');
    return validation(errors);
  }

  const urls = [];
  for (const [index, item] of value.items.entries()) {
    const path = `$.items[${index}]`;
    if (!requireRecord(item, path, errors)) continue;
    requireFields(item, ['url', 'byteLength', 'digest', 'mediaType', 'rights'], path, errors);
    const url = publisher ? asHttpsUrl(item.url, `${path}.url`, errors, { origin: publisher }) : null;
    if (url) urls.push(url.href);
    if (inventoryUrl && url?.href === inventoryUrl.href) {
      issue(errors, `${path}.url`, 'inventory-self', 'the complete inventory excludes only itself and must not list itself');
    }
    if (!Number.isSafeInteger(item.byteLength) || item.byteLength < 0) {
      issue(errors, `${path}.byteLength`, 'byte-length', 'must be a non-negative safe integer');
    }
    if (!parseSha256Digest(item.digest)) {
      issue(errors, `${path}.digest`, 'digest', 'must be an RFC-9530-style SHA-256 digest');
    }
    if (typeof item.mediaType !== 'string' || item.mediaType.trim() === '') {
      issue(errors, `${path}.mediaType`, 'media-type', 'must be a non-empty media type');
    }
    validateRights(item.rights, `${path}.rights`, errors);
  }

  const sorted = [...urls].sort();
  if (new Set(urls).size !== urls.length) issue(errors, '$.items', 'inventory-unique', 'item URLs must be unique');
  if (urls.some((url, index) => url !== sorted[index])) {
    issue(errors, '$.items', 'inventory-sorted', 'items must be sorted by absolute URL');
  }

  if (inventoryUrl && options.inventoryUrl && inventoryUrl.href !== options.inventoryUrl) {
    issue(errors, '$.inventory', 'inventory-url', `must equal ${options.inventoryUrl}`);
  }

  if (options.servedUrls) {
    const served = [...new Set(options.servedUrls)].sort();
    if (inventoryUrl && !served.includes(inventoryUrl.href)) {
      issue(errors, '$.items', 'inventory-served-self', 'servedUrls must include the inventory artifact itself');
    }
    const expected = served.filter((url) => !inventoryUrl || url !== inventoryUrl.href);
    const missing = expected.filter((url) => !urls.includes(url));
    const unexpected = urls.filter((url) => !expected.includes(url));
    if (missing.length || unexpected.length) {
      issue(
        errors,
        '$.items',
        'inventory-snapshot',
        `must list every served artifact except itself (missing: ${missing.join(', ') || 'none'}; unexpected: ${unexpected.join(', ') || 'none'})`,
      );
    }
  }

  return validation(errors);
}

function relationNameIsValid(value) {
  if (/^[a-z][a-z0-9.!#$%&'*+\-^_`|~]*$/i.test(value)) return true;
  try {
    const url = new URL(value);
    return Boolean(url.protocol);
  } catch {
    return value.startsWith('urn:');
  }
}

function validateI18nArray(value, path, errors) {
  if (!Array.isArray(value) || value.length === 0) {
    issue(errors, path, 'i18n-array', 'must be a non-empty array');
    return;
  }
  for (const [index, entry] of value.entries()) {
    if (!requireRecord(entry, `${path}[${index}]`, errors)) continue;
    if (typeof entry.value !== 'string') issue(errors, `${path}[${index}].value`, 'i18n-value', 'must be a string');
    if (entry.language !== undefined && typeof entry.language !== 'string') {
      issue(errors, `${path}[${index}].language`, 'i18n-language', 'must be a string');
    }
  }
}

function oneStringAttribute(target, name, path, errors) {
  const value = target[name];
  const attributePath = `${path}.${name}`;
  if (!Array.isArray(value) || value.length !== 1 || typeof value[0] !== 'string' || value[0] === '') {
    issue(errors, attributePath, 'evidence-attribute', 'must be an array containing exactly one non-empty string');
    return null;
  }
  return value[0];
}

function targetSortKey(target) {
  const assertion = Array.isArray(target?.[LINKSET_EVIDENCE.assertionId])
    ? target[LINKSET_EVIDENCE.assertionId][0] ?? ''
    : '';
  return `${target?.href ?? ''} ${assertion}`;
}

export function validateLinkset(value, options = {}) {
  const errors = [];
  if (!requireRecord(value, '$', errors)) return validation(errors);
  const topKeys = Object.keys(value);
  if (topKeys.length !== 1 || topKeys[0] !== 'linkset') {
    issue(errors, '$', 'rfc9264-top-level', 'application/linkset+json must have linkset as its sole top-level member');
  }
  if (!Array.isArray(value.linkset)) {
    issue(errors, '$.linkset', 'linkset-array', 'must be an array');
    return validation(errors);
  }

  const publisher = options.publisher
    ? asPublisherOrigin(options.publisher, '$<publisher>', errors)
    : null;
  const allowedOrigins = options.allowedOrigins ?? null;
  const anchors = [];

  for (const [contextIndex, context] of value.linkset.entries()) {
    const contextPath = `$.linkset[${contextIndex}]`;
    if (!requireRecord(context, contextPath, errors)) continue;
    const anchor = asHttpsUrl(context.anchor, `${contextPath}.anchor`, errors, { allowedOrigins });
    if (anchor) anchors.push(anchor.href);
    const relations = Object.keys(context).filter((key) => key !== 'anchor');
    if (relations.length === 0) issue(errors, contextPath, 'linkset-relations', 'must contain at least one relation member');

    for (const relation of relations) {
      const relationPath = `${contextPath}[${JSON.stringify(relation)}]`;
      if (!relationNameIsValid(relation)) issue(errors, relationPath, 'relation-name', 'must be a registered token or absolute relation URI');
      const targets = context[relation];
      if (!Array.isArray(targets) || targets.length === 0) {
        issue(errors, relationPath, 'target-array', 'relation value must be a non-empty array');
        continue;
      }

      const keys = targets.map(targetSortKey);
      const sortedKeys = [...keys].sort();
      if (keys.some((key, index) => key !== sortedKeys[index])) {
        issue(errors, relationPath, 'target-sorted', 'targets must be sorted by href then assertion ID');
      }

      for (const [targetIndex, target] of targets.entries()) {
        const targetPath = `${relationPath}[${targetIndex}]`;
        if (!requireRecord(target, targetPath, errors)) continue;
        asHttpsUrl(target.href, `${targetPath}.href`, errors, { allowedOrigins });

        for (const [name, attribute] of Object.entries(target)) {
          if (name === 'href') continue;
          if (['media', 'title', 'type'].includes(name)) {
            if (typeof attribute !== 'string') issue(errors, `${targetPath}.${name}`, 'standard-attribute', 'must be a string');
          } else if (name === 'hreflang') {
            if (!Array.isArray(attribute) || attribute.some((entry) => typeof entry !== 'string')) {
              issue(errors, `${targetPath}.hreflang`, 'hreflang', 'must be an array of strings');
            }
          } else if (name.endsWith('*')) {
            validateI18nArray(attribute, `${targetPath}.${name}`, errors);
          } else if (!Array.isArray(attribute) || attribute.some((entry) => typeof entry !== 'string')) {
            issue(errors, `${targetPath}.${name}`, 'extension-attribute', 'RFC 9264 extension attributes must be arrays of strings');
          }
        }

        const issuer = oneStringAttribute(target, LINKSET_EVIDENCE.issuer, targetPath, errors);
        const assertionId = oneStringAttribute(target, LINKSET_EVIDENCE.assertionId, targetPath, errors);
        const observedAt = oneStringAttribute(target, LINKSET_EVIDENCE.observedAt, targetPath, errors);
        const sourceDigest = oneStringAttribute(target, LINKSET_EVIDENCE.sourceDigest, targetPath, errors);

        const issuerOrigin = issuer ? asPublisherOrigin(issuer, `${targetPath}.${LINKSET_EVIDENCE.issuer}[0]`, errors) : null;
        if (publisher && issuerOrigin && issuerOrigin !== publisher) {
          issue(errors, `${targetPath}.${LINKSET_EVIDENCE.issuer}[0]`, 'issuer-publisher', `must equal Linkset publisher ${publisher}`);
        }
        if (assertionId && issuerOrigin) {
          asHttpsUrl(assertionId, `${targetPath}.${LINKSET_EVIDENCE.assertionId}[0]`, errors, {
            origin: issuerOrigin,
            allowFragment: true,
          });
        }
        if (observedAt) validateTimestamp(observedAt, `${targetPath}.${LINKSET_EVIDENCE.observedAt}[0]`, errors, options.expectedTime ?? FIXED_NOW);
        if (sourceDigest && !parseSha256Digest(sourceDigest)) {
          issue(errors, `${targetPath}.${LINKSET_EVIDENCE.sourceDigest}[0]`, 'digest', 'must be an RFC-9530-style SHA-256 digest');
        }
      }
    }
  }

  const sortedAnchors = [...anchors].sort();
  if (anchors.some((anchor, index) => anchor !== sortedAnchors[index])) {
    issue(errors, '$.linkset', 'contexts-sorted', 'link contexts must be sorted by anchor');
  }

  return validation(errors);
}

export function validateAssertion(value, options = {}) {
  const errors = [];
  if (!requireRecord(value, '$', errors)) return validation(errors);
  requireFields(value, ASSERTION_SHAPE.required, '$', errors);

  const issuer = asPublisherOrigin(value.issuer, '$.issuer', errors);
  if (issuer) {
    asHttpsUrl(value.assertionId, '$.assertionId', errors, { origin: issuer, allowFragment: true });
  }
  asHttpsUrl(value.subject, '$.subject', errors, { allowedOrigins: options.allowedOrigins });
  asHttpsUrl(value.target, '$.target', errors, { allowedOrigins: options.allowedOrigins });
  if (typeof value.relation !== 'string' || !relationNameIsValid(value.relation)) {
    issue(errors, '$.relation', 'relation', 'must be a registered relation token or absolute relation URI');
  }
  if (value.rationale !== null && (typeof value.rationale !== 'string' || value.rationale.trim() === '')) {
    issue(errors, '$.rationale', 'rationale', 'must be a non-empty string or null');
  }

  if (requireRecord(value.evidence, '$.evidence', errors)) {
    requireFields(value.evidence, ASSERTION_SHAPE.evidenceRequired, '$.evidence', errors);
    asHttpsUrl(value.evidence.sourceUrl, '$.evidence.sourceUrl', errors, { allowedOrigins: options.allowedOrigins });
    if (!parseSha256Digest(value.evidence.sourceDigest)) {
      issue(errors, '$.evidence.sourceDigest', 'digest', 'must be an RFC-9530-style SHA-256 digest');
    }
    if (value.evidence.targetRevision !== null && typeof value.evidence.targetRevision !== 'string') {
      issue(errors, '$.evidence.targetRevision', 'target-revision', 'must be a string or null');
    }
    if (value.evidence.targetDigest !== null && !parseSha256Digest(value.evidence.targetDigest)) {
      issue(errors, '$.evidence.targetDigest', 'target-digest', 'must be an RFC-9530-style SHA-256 digest or null');
    }
    validateTimestamp(value.evidence.observedAt, '$.evidence.observedAt', errors, options.expectedTime ?? FIXED_NOW);
  }

  return validation(errors);
}

export function validateCacheRecord(value, options = {}) {
  const errors = [];
  if (!requireRecord(value, '$', errors)) return validation(errors);
  requireFields(value, CACHE_RECORD_SHAPE.required, '$', errors);

  const publisher = asPublisherOrigin(value.publisher, '$.publisher', errors);
  const issuer = asPublisherOrigin(value.issuer, '$.issuer', errors);
  if (issuer) asHttpsUrl(value.assertionId, '$.assertionId', errors, { origin: issuer, allowFragment: true });
  if (publisher) asHttpsUrl(value.fetchedUrl, '$.fetchedUrl', errors, { origin: publisher });

  if (!Array.isArray(value.discoveryChain) || value.discoveryChain.length === 0) {
    issue(errors, '$.discoveryChain', 'discovery-chain', 'must be a non-empty array of absolute logical URLs');
  } else {
    for (const [index, url] of value.discoveryChain.entries()) {
      asHttpsUrl(url, `$.discoveryChain[${index}]`, errors, { allowedOrigins: options.allowedOrigins });
    }
  }

  if (!parseSha256Digest(value.sourceDigest)) issue(errors, '$.sourceDigest', 'digest', 'must be an RFC-9530-style SHA-256 digest');

  if (requireRecord(value.observation, '$.observation', errors)) {
    requireFields(value.observation, CACHE_RECORD_SHAPE.observationRequired, '$.observation', errors);
    if (!OBSERVATION_STATES.includes(value.observation.state)) {
      issue(errors, '$.observation.state', 'observation-state', `must be one of ${OBSERVATION_STATES.join(', ')}`);
    }
    validateTimestamp(value.observation.observedAt, '$.observation.observedAt', errors, options.expectedTime ?? FIXED_NOW);
    validateTimestamp(value.observation.verifiedAt, '$.observation.verifiedAt', errors, options.expectedTime ?? FIXED_NOW);
    const status = value.observation.httpStatus;
    if (status !== null && (!Number.isInteger(status) || status < 100 || status > 599)) {
      issue(errors, '$.observation.httpStatus', 'http-status', 'must be an HTTP status integer or null');
    }
    if (value.observation.state === 'deleted' && status !== 410) {
      issue(errors, '$.observation.httpStatus', 'deletion-evidence', 'owner-qualified deletion requires HTTP 410');
    }
    if (value.observation.state === 'current' && !(Number.isInteger(status) && status >= 200 && status < 300)) {
      issue(errors, '$.observation.httpStatus', 'current-status', 'a current observation requires a 2xx status');
    }
  }

  validateRights(value.rights, '$.rights', errors);

  if (requireRecord(value.rawArtifact, '$.rawArtifact', errors)) {
    requireFields(value.rawArtifact, CACHE_RECORD_SHAPE.rawArtifactRequired, '$.rawArtifact', errors);
    if (publisher) asHttpsUrl(value.rawArtifact.url, '$.rawArtifact.url', errors, { origin: publisher });
    if (value.rawArtifact.url !== value.fetchedUrl) issue(errors, '$.rawArtifact.url', 'artifact-url', 'must equal fetchedUrl');
    if (typeof value.rawArtifact.mediaType !== 'string' || value.rawArtifact.mediaType.trim() === '') {
      issue(errors, '$.rawArtifact.mediaType', 'media-type', 'must be a non-empty media type');
    }
    if (!Number.isSafeInteger(value.rawArtifact.byteLength) || value.rawArtifact.byteLength < 0) {
      issue(errors, '$.rawArtifact.byteLength', 'byte-length', 'must be a non-negative safe integer');
    }
    if (!parseSha256Digest(value.rawArtifact.digest)) {
      issue(errors, '$.rawArtifact.digest', 'digest', 'must be an RFC-9530-style SHA-256 digest');
    }
    if (value.rawArtifact.digest !== value.sourceDigest) {
      issue(errors, '$.rawArtifact.digest', 'source-digest', 'must equal sourceDigest');
    }
    validateTimestamp(value.rawArtifact.fetchedAt, '$.rawArtifact.fetchedAt', errors, options.expectedTime ?? FIXED_NOW);
  }

  const assertionResult = validateAssertion(value.assertion, options);
  for (const error of assertionResult.errors) issue(errors, `$.assertion${error.path.slice(1)}`, error.code, error.message);
  if (isRecord(value.assertion)) {
    if (value.assertion.issuer !== value.issuer) issue(errors, '$.assertion.issuer', 'cache-issuer', 'must equal cache record issuer');
    if (value.assertion.assertionId !== value.assertionId) issue(errors, '$.assertion.assertionId', 'cache-assertion-id', 'must equal cache record assertionId');
    if (value.assertion.evidence?.sourceUrl !== value.fetchedUrl) issue(errors, '$.assertion.evidence.sourceUrl', 'cache-source-url', 'must equal fetchedUrl');
    if (value.assertion.evidence?.sourceDigest !== value.sourceDigest) issue(errors, '$.assertion.evidence.sourceDigest', 'cache-source-digest', 'must equal sourceDigest');
  }

  return validation(errors);
}

export class ContractValidationError extends Error {
  constructor(kind, errors) {
    super(`${kind} failed contract validation: ${errors.map((error) => `${error.path} ${error.message}`).join('; ')}`);
    this.name = 'ContractValidationError';
    this.kind = kind;
    this.errors = errors;
  }
}

export function assertValid(kind, result) {
  if (!result?.ok) throw new ContractValidationError(kind, result?.errors ?? [{ path: '$', code: 'invalid-result', message: 'validator returned no result' }]);
  return result;
}

/** Source-qualified key: endpoint equality alone can never merge competing assertions. */
export function assertionKey(value) {
  return JSON.stringify([
    value?.issuer ?? null,
    value?.assertionId ?? null,
    value?.evidence?.sourceDigest ?? null,
  ]);
}

/** Includes fetched publication provenance as well as assertion identity. */
export function cacheRecordKey(value) {
  return JSON.stringify([
    value?.publisher ?? null,
    value?.issuer ?? null,
    value?.assertionId ?? null,
    value?.fetchedUrl ?? null,
    value?.sourceDigest ?? null,
  ]);
}

export function normalizeCrawlBudgets(overrides = {}) {
  if (!isRecord(overrides)) throw new TypeError('crawl budget overrides must be an object');
  for (const key of Object.keys(overrides)) {
    if (!CRAWL_BUDGET_KEYS.includes(key)) throw new TypeError(`unknown crawl budget ${key}`);
    if (!Number.isSafeInteger(overrides[key]) || overrides[key] <= 0) {
      throw new TypeError(`crawl budget ${key} must be a positive safe integer`);
    }
  }
  return Object.freeze({ ...DEFAULT_CRAWL_BUDGETS, ...overrides });
}

import {
  CRAWL_BUDGET_KEYS,
  DEFAULT_RELATION_ALLOWLIST,
  FIXED_CLOCK,
  FIXTURE_PROFILE_URN,
  LINKSET_EVIDENCE,
  RELATIONS,
  RIGHTS_MODES,
  assertValid,
  cacheRecordKey,
  normalizeCrawlBudgets,
  parseSha256Digest,
  sha256Digest,
  validateCacheRecord,
  validateDescriptor,
  validateInventory,
  validateLinkset,
} from './contracts.js';
import { normalizeCacheRecords } from './cache.js';
import { FIXTURE_ORIGINS } from './topology.js';
import { TransportLimitError } from './transport.js';

const STRUCTURAL_RELATIONS = Object.freeze({
  inventory: `${FIXTURE_PROFILE_URN}:complete-inventory`,
  linkset: `${FIXTURE_PROFILE_URN}:linkset`,
});

function normalizeRelationAllowlist(input) {
  if (!Array.isArray(input) || input.length === 0) {
    throw new TypeError('crawler relation allowlist must be a non-empty array');
  }
  if (input.some((relation) => typeof relation !== 'string' || relation.length === 0)) {
    throw new TypeError('crawler relation allowlist must contain non-empty strings');
  }
  return Object.freeze([...new Set(input)].sort());
}

function normalizeSeed(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`crawl seed must be an absolute URL: ${String(value)}`);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new TypeError(`crawl seed must be a credential-free HTTPS URL without a fragment: ${String(value)}`);
  }
  return url.href;
}

function contentType(headers) {
  return (headers.get('content-type') ?? 'application/octet-stream').split(';', 1)[0].trim().toLowerCase();
}

function splitLinkHeader(value) {
  const parts = [];
  let start = 0;
  let quoted = false;
  let angled = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '"') quoted = !quoted;
    else if (!quoted && character === '<') angled = true;
    else if (!quoted && character === '>') angled = false;
    else if (!quoted && !angled && character === ',') {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(value.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

function parseLinkHeader(value) {
  if (!value) return [];
  const links = [];
  for (const part of splitLinkHeader(value)) {
    const target = part.match(/^<([^>]*)>/)?.[1];
    if (!target) continue;
    const attributes = {};
    const parameters = part.slice(part.indexOf('>') + 1).split(';');
    for (const parameter of parameters) {
      const match = parameter.trim().match(/^([^=\s]+)\s*=\s*(?:"((?:\\.|[^"])*)"|([^\s]+))$/);
      if (!match) continue;
      attributes[match[1].toLowerCase()] = (match[2] ?? match[3]).replace(/\\"/g, '"');
    }
    const relations = (attributes.rel ?? '').split(/\s+/).filter(Boolean);
    for (const relation of relations) links.push({ href: target, relation, source: 'http-link' });
  }
  return links;
}

function htmlAttributes(tag) {
  const attributes = {};
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let match;
  while ((match = pattern.exec(tag)) !== null) {
    attributes[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? '';
  }
  return attributes;
}

function parseHtmlLinks(value) {
  const links = [];
  const tags = value.match(/<(?:a|link)\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    const attributes = htmlAttributes(tag);
    if (!attributes.href || !attributes.rel) continue;
    for (const relation of attributes.rel.split(/\s+/).filter(Boolean)) {
      links.push({ href: attributes.href, relation, source: 'html-rel' });
    }
  }
  return links;
}

function hasEncodedTraversal(value) {
  const path = String(value).split(/[?#]/, 1)[0];
  if (!/%[0-9a-f]{2}/i.test(path)) return false;
  try {
    const decoded = decodeURIComponent(path);
    return decoded.split('/').some((segment) => segment === '.' || segment === '..')
      || decoded.includes('\\')
      || decoded.includes('\0');
  } catch {
    return true;
  }
}

function resolveDiscovery(href, baseUrl) {
  if (typeof href !== 'string' || href.length === 0 || hasEncodedTraversal(href)) return null;
  try {
    const url = new URL(href, baseUrl);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

function oneExtension(target, name) {
  const value = target?.[name];
  return Array.isArray(value) && typeof value[0] === 'string' ? value[0] : null;
}

function parseEvidencePayload(target) {
  const raw = oneExtension(target, LINKSET_EVIDENCE.evidence);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return { targetRevision: raw };
  }
}

function rightsFromTarget(target) {
  const mode = oneExtension(target, 'cb-rights-mode');
  const summary = oneExtension(target, 'cb-rights-summary');
  const license = oneExtension(target, 'cb-rights-license');
  const source = oneExtension(target, 'cb-rights-source');
  if (!RIGHTS_MODES.includes(mode) || !summary) return null;
  const rights = { mode, summary };
  if (license) rights.license = license;
  if (source) rights.source = source;
  return rights;
}

function linksetClaims(document, artifact, clock) {
  const claims = [];
  const linksetDigest = sha256Digest(artifact.body);
  for (const context of document.linkset) {
    for (const [relation, targets] of Object.entries(context)) {
      if (relation === 'anchor' || !Array.isArray(targets)) continue;
      for (const target of targets) {
        const issuer = oneExtension(target, LINKSET_EVIDENCE.issuer);
        const assertionId = oneExtension(target, LINKSET_EVIDENCE.assertionId);
        const observedAt = oneExtension(target, LINKSET_EVIDENCE.observedAt) ?? clock.now();
        const sourceDigest = oneExtension(target, LINKSET_EVIDENCE.sourceDigest);
        const payload = parseEvidencePayload(target);
        if (!issuer || !assertionId || !sourceDigest || typeof payload.sourceUrl !== 'string' || typeof target.href !== 'string') continue;
        const targetDigest = parseSha256Digest(payload.targetDigest ?? payload.digest)
          ? payload.targetDigest ?? payload.digest
          : null;
        claims.push({
          publisher: new URL(artifact.url).origin,
          issuer,
          assertionId,
          subject: context.anchor,
          relation,
          target: target.href,
          rationale: oneExtension(target, LINKSET_EVIDENCE.rationale),
          sourceUrl: payload.sourceUrl,
          sourceDigest,
          targetRevision: payload.targetRevision ?? payload.revision ?? null,
          targetDigest,
          observedAt,
          rightsHint: rightsFromTarget(target),
          linkset: {
            url: artifact.url,
            digest: linksetDigest,
            mediaType: artifact.mediaType,
            byteLength: artifact.body.byteLength,
            discoveryChain: artifact.discoveryChain,
          },
        });
      }
    }
  }
  return claims;
}

function parseJsonArtifact(value, artifact, allowedOrigins, clock) {
  const discoveries = [];
  const claims = [];
  const rights = [];

  if (value?.profile === FIXTURE_PROFILE_URN && value?.inventory && value?.linksets && value?.policies) {
    assertValid('descriptor', validateDescriptor(value, { publisher: new URL(artifact.url).origin }));
    discoveries.push({ href: value.inventory, relation: STRUCTURAL_RELATIONS.inventory, source: 'descriptor' });
    for (const href of value.linksets) discoveries.push({ href, relation: STRUCTURAL_RELATIONS.linkset, source: 'descriptor' });
    rights.push({ origin: value.publisher, rights: value.policies.rights });
    return { kind: 'descriptor', discoveries, claims, rights };
  }

  if (value?.profile === FIXTURE_PROFILE_URN && value?.complete === true && Array.isArray(value?.items)) {
    assertValid('inventory', validateInventory(value, { expectedTime: clock.now() }));
    for (const item of value.items) {
      discoveries.push({ href: item.url, relation: RELATIONS.item, source: 'inventory' });
      rights.push({ url: item.url, rights: item.rights });
    }
    return { kind: 'inventory', discoveries, claims, rights };
  }

  if (value && Object.keys(value).length === 1 && Array.isArray(value.linkset)) {
    assertValid('Linkset', validateLinkset(value, {
      publisher: new URL(artifact.url).origin,
      allowedOrigins,
      expectedTime: clock.now(),
    }));
    for (const context of value.linkset) {
      for (const [relation, targets] of Object.entries(context)) {
        if (relation === 'anchor' || !Array.isArray(targets)) continue;
        for (const target of targets) {
          if (typeof target.href === 'string') discoveries.push({ href: target.href, relation, source: 'linkset' });
        }
      }
    }
    claims.push(...linksetClaims(value, artifact, clock));
    return { kind: 'linkset', discoveries, claims, rights };
  }

  return { kind: 'json', discoveries, claims, rights };
}

function parseArtifact(artifact, { allowedOrigins, clock }) {
  const discoveries = parseLinkHeader(artifact.headers.get('link'));
  const claims = [];
  const rights = [];
  let kind = 'opaque';

  if (artifact.mediaType === 'text/html' || artifact.mediaType === 'application/xhtml+xml') {
    kind = 'html';
    discoveries.push(...parseHtmlLinks(artifact.body.toString('utf8')));
  } else if (artifact.mediaType === 'application/json' || artifact.mediaType === 'application/linkset+json' || artifact.mediaType.endsWith('+json')) {
    const value = JSON.parse(artifact.body.toString('utf8'));
    const parsed = parseJsonArtifact(value, artifact, allowedOrigins, clock);
    kind = parsed.kind;
    discoveries.push(...parsed.discoveries);
    claims.push(...parsed.claims);
    rights.push(...parsed.rights);
  }
  return { kind, discoveries, claims, rights };
}

function materializeClaimRecords(claims, artifacts, rightsByUrl, rightsByOrigin, clock, allowedOrigins, errors) {
  const artifactByUrl = new Map();
  for (const artifact of artifacts) {
    const existing = artifactByUrl.get(artifact.url);
    if (!existing || artifact.discoveryChain.length < existing.discoveryChain.length) artifactByUrl.set(artifact.url, artifact);
  }

  const records = [];
  for (const claim of claims) {
    const source = artifactByUrl.get(claim.sourceUrl);
    if (!source || source.status < 200 || source.status >= 300) {
      errors.push({
        url: claim.linkset.url,
        code: 'source-unavailable',
        message: `assertion source ${claim.sourceUrl} was not fetched successfully`,
      });
      continue;
    }
    const exactDigest = sha256Digest(source.body);
    if (exactDigest !== claim.sourceDigest) {
      errors.push({
        url: claim.sourceUrl,
        code: 'source-digest-mismatch',
        message: `assertion ${claim.assertionId} does not match the fetched source bytes`,
      });
      continue;
    }
    const publisher = new URL(claim.sourceUrl).origin;
    const rights = rightsByUrl.get(claim.sourceUrl)
      ?? claim.rightsHint
      ?? rightsByOrigin.get(publisher)
      ?? {
        mode: 'unknown',
        summary: 'No machine-readable reuse grant was supplied for this source artifact.',
      };
    const assertion = {
      assertionId: claim.assertionId,
      issuer: claim.issuer,
      subject: claim.subject,
      relation: claim.relation,
      target: claim.target,
      rationale: claim.rationale,
      evidence: {
        sourceUrl: claim.sourceUrl,
        sourceDigest: claim.sourceDigest,
        targetRevision: claim.targetRevision,
        targetDigest: claim.targetDigest,
        observedAt: claim.observedAt,
      },
    };
    const record = {
      publisher,
      issuer: claim.issuer,
      assertionId: claim.assertionId,
      fetchedUrl: claim.sourceUrl,
      discoveryChain: source.discoveryChain,
      sourceDigest: claim.sourceDigest,
      observation: {
        state: 'current',
        observedAt: claim.observedAt,
        verifiedAt: clock.now(),
        httpStatus: source.status,
      },
      rights,
      rawArtifact: {
        url: claim.sourceUrl,
        mediaType: source.mediaType,
        byteLength: source.body.byteLength,
        digest: claim.sourceDigest,
        fetchedAt: clock.now(),
      },
      assertionPublication: claim.linkset,
      assertion,
    };
    try {
      assertValid('cache record', validateCacheRecord(record, {
        allowedOrigins,
        expectedTime: clock.now(),
      }));
      records.push(record);
    } catch (error) {
      errors.push(errorSummary(error, claim.linkset.url));
    }
  }
  return records;
}

function budgetReport(limits, usage, stoppedBy) {
  const report = {};
  for (const key of CRAWL_BUDGET_KEYS) {
    report[key] = {
      limit: limits[key],
      used: usage[key],
      exhausted: stoppedBy.has(key),
    };
  }
  return report;
}

function errorSummary(error, url) {
  return {
    url,
    code: error?.code ?? error?.name ?? 'error',
    message: error?.message ?? String(error),
  };
}

/**
 * Crawl only from caller-selected seeds. Structural descriptor fields are fixed
 * profile semantics; every metadata relation remains inert unless allowlisted.
 */
export async function crawlSeeds(seeds, {
  transport,
  cache = null,
  relationAllowlist = DEFAULT_RELATION_ALLOWLIST,
  budgets: budgetOverrides = {},
  clock = FIXED_CLOCK,
  allowedOrigins = FIXTURE_ORIGINS,
  monotonicNow = () => performance.now(),
} = {}) {
  if (!transport || typeof transport.get !== 'function') throw new TypeError('crawler requires a transport with get()');
  if (cache !== null && typeof cache.putMany !== 'function') throw new TypeError('crawler cache must expose putMany()');
  if (!clock || typeof clock.now !== 'function') throw new TypeError('crawler clock must expose now()');
  if (typeof monotonicNow !== 'function') throw new TypeError('crawler monotonicNow must be a function');
  const limits = normalizeCrawlBudgets(budgetOverrides);
  const allowlist = normalizeRelationAllowlist(relationAllowlist);
  const allow = new Set(allowlist);
  const normalizedSeeds = [...new Set(seeds.map(normalizeSeed))].sort();
  if (normalizedSeeds.length === 0) throw new TypeError('crawler requires at least one seed');

  const queue = [];
  const scheduled = new Set();
  const allUrls = new Set();
  const origins = new Set();
  const stoppedBy = new Set();
  const discoveries = [];
  const skippedDiscoveries = [];
  const artifacts = [];
  const errors = [];
  const pendingClaims = [];
  const rightsByUrl = new Map();
  const rightsByOrigin = new Map();
  let redirectCount = 0;
  const startedAt = monotonicNow();
  const usage = Object.fromEntries(CRAWL_BUDGET_KEYS.map((key) => [key, 0]));

  function stop(key) {
    stoppedBy.add(key);
  }

  function enqueue(url, depth, chain, metadata) {
    if (scheduled.has(url)) return false;
    if (depth > limits.maxDepth) {
      stop('maxDepth');
      skippedDiscoveries.push({ ...metadata, to: url, reason: 'maxDepth' });
      return false;
    }
    const origin = new URL(url).origin;
    if (!origins.has(origin) && origins.size >= limits.maxOrigins) {
      stop('maxOrigins');
      skippedDiscoveries.push({ ...metadata, to: url, reason: 'maxOrigins' });
      return false;
    }
    if (allUrls.size >= limits.maxUrls) {
      stop('maxUrls');
      skippedDiscoveries.push({ ...metadata, to: url, reason: 'maxUrls' });
      return false;
    }
    origins.add(origin);
    scheduled.add(url);
    allUrls.add(url);
    queue.push({ url, depth, chain, metadata });
    return true;
  }

  for (const seed of normalizedSeeds) enqueue(seed, 0, [seed], { from: null, relation: 'seed', source: 'seed' });

  while (queue.length > 0) {
    const elapsed = monotonicNow() - startedAt;
    if (elapsed > limits.maxWallTimeMs) {
      stop('maxWallTimeMs');
      break;
    }
    if (usage.maxTotalBytes >= limits.maxTotalBytes) {
      stop('maxTotalBytes');
      break;
    }

    const remainingTotalBytes = limits.maxTotalBytes - usage.maxTotalBytes;
    const batchSize = Math.min(limits.maxConcurrency, queue.length, remainingTotalBytes);
    const batch = queue.splice(0, batchSize);
    const perRequestTotalBytes = Math.max(1, Math.floor(remainingTotalBytes / batch.length));
    usage.maxConcurrency = Math.max(usage.maxConcurrency, batch.length);
    const results = await Promise.all(batch.map(async (entry) => {
      try {
        const response = await transport.get(entry.url, {
          maxRedirects: limits.maxRedirects,
          maxResponseBytes: limits.maxResponseBytes,
          maxDecompressedBytes: limits.maxDecompressedBytes,
          maxTotalBytes: perRequestTotalBytes,
          maxWallTimeMs: Math.max(1, limits.maxWallTimeMs - Math.floor(monotonicNow() - startedAt)),
          onRedirect({ to }) {
            if (redirectCount >= limits.maxRedirects) {
              throw new TransportLimitError('maxRedirects', `crawl would exceed ${limits.maxRedirects} redirects`);
            }
            redirectCount += 1;
            usage.maxRedirects = redirectCount;
            const origin = new URL(to).origin;
            if (!origins.has(origin) && origins.size >= limits.maxOrigins) {
              throw new TransportLimitError('maxOrigins', `redirect would exceed ${limits.maxOrigins} origins`);
            }
            if (!allUrls.has(to) && allUrls.size >= limits.maxUrls) {
              throw new TransportLimitError('maxUrls', `redirect would exceed ${limits.maxUrls} URLs`);
            }
            origins.add(origin);
            allUrls.add(to);
          },
        });
        return { entry, response };
      } catch (error) {
        return { entry, error };
      }
    }));

    for (const result of results) {
      const { entry } = result;
      usage.maxDepth = Math.max(usage.maxDepth, entry.depth);
      if (result.error) {
        if (CRAWL_BUDGET_KEYS.includes(result.error.code)) stop(result.error.code);
        errors.push(errorSummary(result.error, entry.url));
        continue;
      }

      const response = result.response;
      if (response.redirects.length > limits.maxRedirects) {
        stop('maxRedirects');
        errors.push(errorSummary(new TransportLimitError('maxRedirects', 'crawl redirect budget exceeded'), entry.url));
        continue;
      }
      usage.maxResponseBytes = Math.max(usage.maxResponseBytes, response.byteLength);
      usage.maxDecompressedBytes = Math.max(usage.maxDecompressedBytes, response.decompressedByteLength);
      if (response.byteLength > limits.maxResponseBytes) {
        stop('maxResponseBytes');
        continue;
      }
      if (response.decompressedByteLength > limits.maxDecompressedBytes) {
        stop('maxDecompressedBytes');
        continue;
      }
      if (usage.maxTotalBytes + response.decompressedByteLength > limits.maxTotalBytes) {
        stop('maxTotalBytes');
        break;
      }
      usage.maxTotalBytes += response.decompressedByteLength;

      const artifact = {
        requestedUrl: entry.url,
        url: response.url,
        discoveryChain: entry.chain,
        depth: entry.depth,
        status: response.status,
        mediaType: contentType(response.headers),
        headers: response.headers,
        body: response.body,
        byteLength: response.byteLength,
        decompressedByteLength: response.decompressedByteLength,
        redirects: response.redirects,
        kind: 'unparsed',
      };
      artifacts.push(artifact);
      if (!response.ok) continue;

      if (response.body.byteLength > limits.maxParserBytes) {
        stop('maxParserBytes');
        errors.push(errorSummary(new TransportLimitError('maxParserBytes', `parser input exceeds ${limits.maxParserBytes} bytes`), response.url));
        continue;
      }
      usage.maxParserBytes = Math.max(usage.maxParserBytes, response.body.byteLength);
      const parseStartedAt = monotonicNow();
      let parsed;
      try {
        parsed = parseArtifact(artifact, { allowedOrigins, clock });
      } catch (error) {
        errors.push(errorSummary(error, response.url));
        continue;
      }
      const parserMs = Math.max(0, Math.ceil(monotonicNow() - parseStartedAt));
      usage.maxParserMs = Math.max(usage.maxParserMs, parserMs);
      if (parserMs > limits.maxParserMs) {
        stop('maxParserMs');
        errors.push(errorSummary(new TransportLimitError('maxParserMs', `parser exceeded ${limits.maxParserMs} ms`), response.url));
        continue;
      }
      artifact.kind = parsed.kind;

      pendingClaims.push(...parsed.claims.filter((claim) => allow.has(claim.relation)));
      for (const entry of parsed.rights) {
        if (entry.url) rightsByUrl.set(entry.url, entry.rights);
        if (entry.origin) rightsByOrigin.set(entry.origin, entry.rights);
      }

      const candidates = parsed.discoveries
        .map((discovery) => ({ ...discovery, href: resolveDiscovery(discovery.href, response.url) }))
        .filter((discovery) => discovery.href !== null)
        .sort((a, b) => a.href.localeCompare(b.href) || a.relation.localeCompare(b.relation));
      for (const discovery of candidates) {
        const structural = discovery.relation === STRUCTURAL_RELATIONS.inventory
          || discovery.relation === STRUCTURAL_RELATIONS.linkset;
        if (!structural && !allow.has(discovery.relation)) {
          skippedDiscoveries.push({
            from: response.url,
            to: discovery.href,
            relation: discovery.relation,
            source: discovery.source,
            reason: 'relation-not-allowlisted',
          });
          continue;
        }
        const metadata = {
          from: response.url,
          relation: discovery.relation,
          source: discovery.source,
        };
        const followed = enqueue(discovery.href, entry.depth + 1, [...entry.chain, discovery.href], metadata);
        discoveries.push({ ...metadata, to: discovery.href, followed });
      }
    }
  }

  usage.maxOrigins = origins.size;
  usage.maxUrls = allUrls.size;
  usage.maxWallTimeMs = Math.max(0, Math.ceil(monotonicNow() - startedAt));
  if (usage.maxWallTimeMs > limits.maxWallTimeMs) stop('maxWallTimeMs');
  const materializedRecords = materializeClaimRecords(
    pendingClaims,
    artifacts,
    rightsByUrl,
    rightsByOrigin,
    clock,
    allowedOrigins,
    errors,
  );
  const normalizedRecords = normalizeCacheRecords(materializedRecords, {
    allowedOrigins,
    expectedTime: clock.now(),
  });
  if (cache) await cache.putMany(normalizedRecords);

  const stopped = CRAWL_BUDGET_KEYS.filter((key) => stoppedBy.has(key));
  return {
    profile: FIXTURE_PROFILE_URN,
    crawledAt: clock.now(),
    seeds: normalizedSeeds,
    relationAllowlist: allowlist,
    budgets: budgetReport(limits, usage, stoppedBy),
    stoppedBy: stopped,
    complete: queue.length === 0 && stopped.length === 0 && errors.length === 0,
    origins: [...origins].sort(),
    visitedUrls: artifacts.map((artifact) => artifact.requestedUrl).sort(),
    artifacts: artifacts
      .sort((a, b) => a.requestedUrl.localeCompare(b.requestedUrl))
      .map((artifact) => ({
        requestedUrl: artifact.requestedUrl,
        url: artifact.url,
        depth: artifact.depth,
        status: artifact.status,
        mediaType: artifact.mediaType,
        byteLength: artifact.byteLength,
        decompressedByteLength: artifact.decompressedByteLength,
        kind: artifact.kind,
        redirects: artifact.redirects,
        discoveryChain: artifact.discoveryChain,
      })),
    discoveries: discoveries.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.relation.localeCompare(b.relation)),
    skippedDiscoveries: skippedDiscoveries.sort((a, b) => String(a.from).localeCompare(String(b.from)) || a.to.localeCompare(b.to) || a.reason.localeCompare(b.reason)),
    records: normalizedRecords.sort((a, b) => cacheRecordKey(a).localeCompare(cacheRecordKey(b))),
    errors: errors.sort((a, b) => a.url.localeCompare(b.url) || a.code.localeCompare(b.code) || a.message.localeCompare(b.message)),
  };
}

export class FederationCrawler {
  constructor(options = {}) {
    this.options = { ...options };
  }

  crawl(seeds, overrides = {}) {
    return crawlSeeds(seeds, { ...this.options, ...overrides });
  }
}

export { STRUCTURAL_RELATIONS };

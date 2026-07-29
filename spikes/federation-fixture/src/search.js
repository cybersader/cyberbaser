import {
  FIXED_NOW,
  RELATIONS,
  cacheRecordKey,
  deepFreeze,
} from './contracts.js';
import { isFixtureLogicalUrl } from './topology.js';

export const SEARCH_CORPUS_POLICY = 'all supplied public cache records, grouped by direct owner URL without identity merging';

export const SEARCH_PROVIDERS = deepFreeze({
  'recent-owner-revisions': {
    id: 'recent-owner-revisions',
    label: 'Recent owner revisions',
    corpusPolicy: SEARCH_CORPUS_POLICY,
    rankingPolicy: 'query matches first, then the newest revision evidence issued by the direct URL owner',
  },
  'cautious-evidence-first': {
    id: 'cautious-evidence-first',
    label: 'Cautious collection and annotation evidence',
    corpusPolicy: SEARCH_CORPUS_POLICY,
    rankingPolicy: 'query matches first, then Cautious annotation evidence, then Cautious collection evidence',
  },
});

function timestamp(value) {
  if (typeof value !== 'string') return null;
  const epoch = Date.parse(value);
  return Number.isNaN(epoch) ? null : { value, epoch };
}

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function cleanKeywords(value) {
  return Array.isArray(value)
    ? value.filter((entry) => typeof entry === 'string' && entry.trim() !== '').map((entry) => entry.trim())
    : [];
}

function queryTokens(query) {
  const normalized = cleanText(query).toLocaleLowerCase('en-US');
  return normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
}

function directOwnerUrl(record) {
  const candidates = [
    record?.search?.directOwnerUrl,
    record?.directOwnerUrl,
    record?.assertion?.target,
    record?.assertion?.subject,
  ];
  return candidates.find((value) => isFixtureLogicalUrl(value)) ?? null;
}

function fallbackTitle(url) {
  const pathname = new URL(url).pathname;
  const leaf = pathname.split('/').filter(Boolean).at(-1) ?? new URL(url).hostname;
  return decodeURIComponent(leaf).replace(/[-_.]+/g, ' ').trim() || url;
}

function visibleDocument(record, url) {
  const search = record?.search ?? {};
  const title = cleanText(search.title) || cleanText(record?.title) || fallbackTitle(url);
  const summary = cleanText(search.summary) || cleanText(record?.summary) || cleanText(record?.assertion?.rationale);
  const keywords = [...cleanKeywords(search.keywords), ...cleanKeywords(record?.keywords)];
  return {
    title,
    summary,
    keywords,
    text: [
      title,
      summary,
      ...keywords,
      url,
      cleanText(record?.assertion?.relation),
      cleanText(record?.assertion?.rationale),
    ].join('\n').toLocaleLowerCase('en-US'),
  };
}

function ownerRevision(record, url) {
  const owner = new URL(url).origin;
  const explicit = record?.search?.ownerRevision;
  if (explicit && typeof explicit === 'object' && !Array.isArray(explicit)) {
    const observed = timestamp(explicit.observedAt);
    if (explicit.publisher === owner && observed) {
      return {
        publisher: owner,
        revision: typeof explicit.revision === 'string' ? explicit.revision : null,
        digest: typeof explicit.digest === 'string' ? explicit.digest : null,
        observedAt: observed.value,
        epoch: observed.epoch,
        source: 'explicit-owner-revision',
      };
    }
  }

  if (record?.publisher === owner) {
    const observed = timestamp(record?.observation?.observedAt);
    if (observed) {
      return {
        publisher: owner,
        revision: typeof record?.assertion?.evidence?.targetRevision === 'string'
          ? record.assertion.evidence.targetRevision
          : null,
        digest: typeof record?.assertion?.evidence?.targetDigest === 'string'
          ? record.assertion.evidence.targetDigest
          : null,
        observedAt: observed.value,
        epoch: observed.epoch,
        source: 'owner-publication-observation',
      };
    }
  }
  return null;
}

function isCautiousEvidence(record, relation) {
  return record?.issuer === 'https://cautious.test' && record?.assertion?.relation === relation;
}

function provenance(record) {
  return {
    key: cacheRecordKey(record),
    publisher: record?.publisher ?? null,
    issuer: record?.issuer ?? null,
    assertionId: record?.assertionId ?? null,
    fetchedUrl: record?.fetchedUrl ?? null,
    sourceDigest: record?.sourceDigest ?? null,
    discoveryChain: Array.isArray(record?.discoveryChain) ? [...record.discoveryChain] : [],
    observationState: record?.observation?.state ?? null,
    observedAt: record?.observation?.observedAt ?? null,
    verifiedAt: record?.observation?.verifiedAt ?? null,
    relation: record?.assertion?.relation ?? null,
  };
}

function buildCorpus(records, query) {
  if (!Array.isArray(records)) throw new TypeError('search records must be an array');
  const tokens = queryTokens(query);
  const groups = new Map();

  for (const record of records) {
    const url = directOwnerUrl(record);
    if (!url) continue;
    const document = visibleDocument(record, url);
    const matchedTokens = tokens.filter((token) => document.text.includes(token));
    if (tokens.length > 0 && matchedTokens.length === 0) continue;

    let group = groups.get(url);
    if (!group) {
      group = {
        identity: url,
        directOwnerUrl: url,
        documents: [],
        records: [],
        matchedTokens: new Set(),
        ownerRevisions: [],
      };
      groups.set(url, group);
    }
    group.documents.push(document);
    group.records.push(record);
    for (const token of matchedTokens) group.matchedTokens.add(token);
    const revision = ownerRevision(record, url);
    if (revision) group.ownerRevisions.push(revision);
  }

  return [...groups.values()].map((group) => {
    group.documents.sort((left, right) => (
      left.title.localeCompare(right.title)
      || left.summary.localeCompare(right.summary)
    ));
    group.ownerRevisions.sort((left, right) => right.epoch - left.epoch || left.source.localeCompare(right.source));
    const sourceRecords = group.records
      .map(provenance)
      .sort((left, right) => left.key.localeCompare(right.key));
    return {
      identity: group.identity,
      directOwnerUrl: group.directOwnerUrl,
      title: group.documents[0]?.title ?? fallbackTitle(group.directOwnerUrl),
      summary: group.documents.find((entry) => entry.summary)?.summary ?? '',
      matchedTokens: [...group.matchedTokens].sort(),
      newestOwnerRevision: group.ownerRevisions[0] ?? null,
      cautiousAnnotations: group.records.filter((record) => isCautiousEvidence(record, RELATIONS.annotation)).length,
      cautiousCollections: group.records.filter((record) => isCautiousEvidence(record, RELATIONS.collection)).length,
      currentObservations: group.records.filter((record) => record?.observation?.state === 'current').length,
      staleObservations: group.records.filter((record) => record?.observation?.state === 'stale').length,
      provenance: sourceRecords,
    };
  });
}

function compareRecent(left, right) {
  return (
    right.matchedTokens.length - left.matchedTokens.length
    || (right.newestOwnerRevision?.epoch ?? 0) - (left.newestOwnerRevision?.epoch ?? 0)
    || right.currentObservations - left.currentObservations
    || left.directOwnerUrl.localeCompare(right.directOwnerUrl)
  );
}

function compareCautious(left, right) {
  return (
    right.matchedTokens.length - left.matchedTokens.length
    || right.cautiousAnnotations - left.cautiousAnnotations
    || right.cautiousCollections - left.cautiousCollections
    || (right.newestOwnerRevision?.epoch ?? 0) - (left.newestOwnerRevision?.epoch ?? 0)
    || left.directOwnerUrl.localeCompare(right.directOwnerUrl)
  );
}

function assertCrawlTime(value) {
  if (!timestamp(value)) throw new TypeError('crawlTime must be an ISO-8601 timestamp');
  return value;
}

/**
 * Run one visible ranking policy over exactly the supplied cache export. The
 * candidate identity set is built once and is independent of provider choice.
 */
export function searchWithProvider(records, query, {
  provider = 'recent-owner-revisions',
  crawlTime = FIXED_NOW,
} = {}) {
  const definition = SEARCH_PROVIDERS[provider];
  if (!definition) throw new TypeError(`unknown search provider ${String(provider)}`);
  const observedAt = assertCrawlTime(crawlTime);
  const corpus = buildCorpus(records, query);
  const comparator = provider === 'recent-owner-revisions' ? compareRecent : compareCautious;
  const ranked = [...corpus].sort(comparator);
  const corpusSummary = {
    policy: definition.corpusPolicy,
    suppliedRecordCount: records.length,
    resultIdentityCount: corpus.length,
  };

  return ranked.map((entry, index) => deepFreeze({
    identity: entry.identity,
    directOwnerUrl: entry.directOwnerUrl,
    title: entry.title,
    summary: entry.summary,
    provider: {
      id: definition.id,
      label: definition.label,
    },
    corpusPolicy: definition.corpusPolicy,
    corpus: corpusSummary,
    rankingPolicy: definition.rankingPolicy,
    rank: index + 1,
    signals: {
      queryMatches: entry.matchedTokens,
      newestOwnerRevision: entry.newestOwnerRevision
        ? {
          publisher: entry.newestOwnerRevision.publisher,
          revision: entry.newestOwnerRevision.revision,
          digest: entry.newestOwnerRevision.digest,
          observedAt: entry.newestOwnerRevision.observedAt,
          source: entry.newestOwnerRevision.source,
        }
        : null,
      cautiousAnnotationEvidence: entry.cautiousAnnotations,
      cautiousCollectionEvidence: entry.cautiousCollections,
      currentObservations: entry.currentObservations,
      staleObservations: entry.staleObservations,
    },
    crawlTime: observedAt,
    provenance: entry.provenance,
  }));
}

export function searchRecentOwnerRevisions(records, query, options = {}) {
  return searchWithProvider(records, query, { ...options, provider: 'recent-owner-revisions' });
}

export function searchCautiousEvidence(records, query, options = {}) {
  return searchWithProvider(records, query, { ...options, provider: 'cautious-evidence-first' });
}

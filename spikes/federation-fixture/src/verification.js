import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FIXED_NOW,
  FIXTURE_PROFILE_URN,
  RELATIONS,
  sha256Digest,
  stableStringify,
} from './contracts.js';
import {
  JsonCache,
  refreshCacheObservations,
} from './cache.js';
import { crawlSeeds } from './crawler.js';
import {
  AUTHORED_BASE_IDS,
  AUTHORED_FIXTURE_ROOT,
  buildAuthoredPublications,
} from './producer-authored.js';
import {
  PROJECTED_BASE_IDS,
  PROJECTED_FIXTURE_ROOT,
  buildProjectedPublications,
} from './producer-projection.js';
import {
  ProposalValidationError,
  applyByteSplices,
  createProposalReceiver,
} from './proposal.js';
import {
  SEARCH_PROVIDERS,
  searchCautiousEvidence,
  searchRecentOwnerRevisions,
} from './search.js';
import { startFixtureServers } from './server.js';
import { FixtureTransport } from './transport.js';
import {
  FIXTURE_BASES,
  FIXTURE_ORIGINS,
  fixtureUrls,
} from './topology.js';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const SPIKE_ROOT = dirname(MODULE_DIR);

function walkRelativeFiles(root) {
  const files = [];
  const stack = [''];
  while (stack.length) {
    const relative = stack.pop();
    const entries = readdirSync(join(root, relative), { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) stack.push(child);
      else if (entry.isFile()) files.push(child);
    }
  }
  return files.sort();
}

function canaryValues() {
  const manifests = [
    ...PROJECTED_BASE_IDS.map((id) => join(PROJECTED_FIXTURE_ROOT, id, 'private/canaries.json')),
    ...AUTHORED_BASE_IDS.map((id) => join(AUTHORED_FIXTURE_ROOT, id, 'private/canaries.json')),
  ].map((path) => JSON.parse(readFileSync(path, 'utf8')));
  return manifests.flatMap((manifest) => Object.values(manifest));
}

function canaryHitCount(values, surfaces) {
  return values.filter((value) => surfaces.some((surface) => surface.includes(value))).length;
}

function searchRecords(records) {
  const exact = records.find((record) => record.assertion.relation === RELATIONS.exactMatch);
  const close = records.find((record) => record.assertion.relation === RELATIONS.closeMatch);
  const annotation = records.find((record) => record.assertion.relation === RELATIONS.annotation);
  if (!exact || !close || !annotation) throw new Error('crawl did not retain exact, close, and annotation evidence for search verification');
  return [
    {
      ...exact,
      search: {
        directOwnerUrl: fixtureUrls('fungi').pages.primary,
        title: 'Golden chanterelle',
        summary: 'Owner species entry.',
        keywords: ['chanterelle'],
        ownerRevision: {
          publisher: 'https://fungi.test',
          revision: 'fungi-r11',
          digest: exact.assertion.evidence.targetDigest,
          observedAt: '2026-07-27T11:45:00.000Z',
        },
      },
    },
    {
      ...close,
      search: {
        directOwnerUrl: fixtureUrls('forage').pages.primary,
        title: 'Chanterelle field guide',
        summary: 'Regional owner field guide.',
        keywords: ['chanterelle'],
        ownerRevision: {
          publisher: 'https://forage.test',
          revision: 'forage-r4',
          digest: close.assertion.evidence.targetDigest,
          observedAt: '2026-07-27T08:00:00.000Z',
        },
      },
    },
    {
      ...annotation,
      search: {
        directOwnerUrl: fixtureUrls('forage').pages.primary,
        title: 'Chanterelle field guide annotation',
        summary: 'Cautious annotation evidence.',
        keywords: ['chanterelle'],
      },
    },
  ];
}

function staleProposalResult() {
  const base = Buffer.from('# Chanterelle\n\nCorrect teh typo without rewriting.\n', 'utf8');
  const start = base.indexOf(Buffer.from('teh'));
  const proposal = {
    proposalId: 'https://atlas.test/proposals/verifier-stale-byte',
    target: {
      url: fixtureUrls('fungi').pages.primary,
      byteLength: base.byteLength,
      digest: sha256Digest(base),
    },
    splices: [{ start, end: start + 3, insert: Buffer.from('the', 'utf8') }],
  };
  const stale = Buffer.from(base);
  stale[start] = 'x'.charCodeAt(0);
  const calls = { apply: 0, ofm: 0, trust: 0 };
  const receive = createProposalReceiver({
    applySplicesFn(...args) {
      calls.apply += 1;
      return applyByteSplices(...args);
    },
    ofmCheckFn() {
      calls.ofm += 1;
      return { verdict: 'clean' };
    },
    trustClassifyFn() {
      calls.trust += 1;
      return { tier: 'agent', route: 'auto-merge' };
    },
  });
  let error = null;
  try {
    receive({
      proposal,
      receiver: {
        publisher: 'https://fungi.test',
        targetUrl: fixtureUrls('fungi').pages.primary,
        path: 'species/chanterelle.md',
        currentBytes: stale,
        contributor: { id: 'fixture-agent', type: 'agent' },
        trustConfig: {},
      },
    });
  } catch (caught) {
    error = caught;
  }
  return {
    rejected: error instanceof ProposalValidationError,
    code: error?.code ?? null,
    phase: error?.phase ?? null,
    calls,
    rebased: false,
  };
}

function failureSummary(error) {
  return {
    code: error?.code ?? error?.name ?? 'error',
    message: error?.message ?? String(error),
  };
}

/**
 * Authoritative bounded fixture verifier. Every output field is independent of
 * temporary paths, loopback ports, timing measurements, and object insertion order.
 */
export async function runFederationVerification() {
  let projected;
  let authored;
  let servers;
  const cacheRoots = [];
  const report = {
    complete: false,
    profile: FIXTURE_PROFILE_URN,
    fixedClock: FIXED_NOW,
    origins: {
      count: FIXTURE_ORIGINS.length,
      values: [...FIXTURE_ORIGINS],
    },
    producerPaths: {
      authored: [...AUTHORED_BASE_IDS],
      projection: [...PROJECTED_BASE_IDS],
    },
    searchProviders: Object.keys(SEARCH_PROVIDERS).sort(),
    crawl: null,
    cacheRebuild: null,
    privateCanaries: null,
    deletion: null,
    conflictingMappings: null,
    staleProposal: null,
    errors: [],
  };

  try {
    projected = buildProjectedPublications();
    authored = buildAuthoredPublications({ externalEvidence: projected.observedTargets });
    const publications = { ...projected.publications, ...authored.publications };
    servers = await startFixtureServers({ roots: { ...projected.roots, ...authored.roots } });
    const transport = new FixtureTransport({ topology: servers.topology });
    const seeds = FIXTURE_BASES.map((base) => fixtureUrls(base).homepage);

    const firstCacheRoot = mkdtempSync(join(tmpdir(), 'cb-federation-verify-cache-a-'));
    cacheRoots.push(firstCacheRoot);
    const firstCache = new JsonCache(firstCacheRoot);
    const firstCrawl = await crawlSeeds(seeds, { transport, cache: firstCache });
    const firstBytes = await firstCache.exportBytes();
    await firstCache.clear();

    const rebuiltCacheRoot = mkdtempSync(join(tmpdir(), 'cb-federation-verify-cache-b-'));
    cacheRoots.push(rebuiltCacheRoot);
    const rebuiltCache = new JsonCache(rebuiltCacheRoot);
    const rebuiltCrawl = await crawlSeeds([...seeds].reverse(), { transport, cache: rebuiltCache });
    const rebuiltBytes = await rebuiltCache.exportBytes();
    const cacheDeterministic = firstBytes.equals(rebuiltBytes);

    report.crawl = {
      complete: firstCrawl.complete && rebuiltCrawl.complete,
      origins: firstCrawl.origins.length,
      records: firstCrawl.records.length,
      stoppedBy: [...firstCrawl.stoppedBy],
      visitedUrls: firstCrawl.visitedUrls.length,
    };
    report.cacheRebuild = {
      deterministic: cacheDeterministic,
      records: firstCrawl.records.length,
    };

    const recordsForSearch = searchRecords(firstCrawl.records);
    const recent = searchRecentOwnerRevisions(recordsForSearch, 'chanterelle', { crawlTime: FIXED_NOW });
    const cautious = searchCautiousEvidence(recordsForSearch, 'chanterelle', { crawlTime: FIXED_NOW });
    report.searchProviders = [
      {
        id: 'cautious-evidence-first',
        topDirectOwnerUrl: cautious[0]?.directOwnerUrl ?? null,
      },
      {
        id: 'recent-owner-revisions',
        topDirectOwnerUrl: recent[0]?.directOwnerUrl ?? null,
      },
    ];

    const subject = fixtureUrls('fungi').pages.primary;
    const target = fixtureUrls('forage').pages.primary;
    const conflicting = firstCrawl.records.filter((record) => (
      record.assertion.subject === subject
      && record.assertion.target === target
      && [RELATIONS.exactMatch, RELATIONS.closeMatch].includes(record.assertion.relation)
    ));
    report.conflictingMappings = {
      count: conflicting.length,
      issuers: conflicting.map((record) => record.issuer).sort(),
      relations: conflicting.map((record) => record.assertion.relation).sort(),
      sourceQualified: conflicting.every((record) => (
        record.assertion.rationale
        && record.assertion.evidence.targetRevision
        && record.assertion.evidence.targetDigest
        && record.assertion.evidence.observedAt === FIXED_NOW
      )),
    };

    const deletionUrl = fixtureUrls('atlas').pages.primary;
    const priorAtlas = firstCrawl.records.filter((record) => record.fetchedUrl === deletionUrl);
    const inventoryWithoutDeleted = {
      ...publications.atlas.inventory,
      items: publications.atlas.inventory.items.filter((item) => item.url !== deletionUrl),
    };
    servers.byId.atlas.setRoute('/catalog/current.json', { json: inventoryWithoutDeleted });
    servers.byId.atlas.setRoute('/collections/beginner-field-set.html', { status: 410, body: 'gone\n' });
    const deletionInventory = JSON.parse((await transport.get(fixtureUrls('atlas').inventory)).body.toString('utf8'));
    const deletedRecords = await refreshCacheObservations(priorAtlas, { transport });
    report.deletion = {
      inventoryRemoved: !deletionInventory.items.some((item) => item.url === deletionUrl),
      ownerQualified: deletedRecords.length > 0 && deletedRecords.every((record) => (
        record.publisher === 'https://atlas.test'
        && record.fetchedUrl === deletionUrl
        && record.observation.state === 'deleted'
        && record.observation.httpStatus === 410
      )),
      records: deletedRecords.length,
      state: deletedRecords.length > 0 && deletedRecords.every((record) => record.observation.state === 'deleted')
        ? 'deleted'
        : 'unexpected',
    };

    report.staleProposal = staleProposalResult();

    const canaries = canaryValues();
    const surfaces = [];
    for (const base of FIXTURE_BASES) {
      const publication = publications[base.id];
      for (const relative of walkRelativeFiles(publication.publicRoot)) {
        surfaces.push(relative);
        surfaces.push(readFileSync(join(publication.publicRoot, relative)).toString('utf8'));
      }
      surfaces.push(stableStringify(publication.descriptor));
      surfaces.push(stableStringify(publication.inventory));
      surfaces.push(stableStringify(publication.linkset));
    }
    surfaces.push(stableStringify(firstCrawl));
    surfaces.push(firstBytes.toString('utf8'));
    surfaces.push(stableStringify(recent));
    surfaces.push(stableStringify(cautious));
    report.privateCanaries = {
      count: canaries.length,
      hits: canaryHitCount(canaries, surfaces),
    };

    const providerIdentityPreserved = stableStringify(recent.map((entry) => entry.identity).sort())
      === stableStringify(cautious.map((entry) => entry.identity).sort());
    const providerOrderChanged = recent.map((entry) => entry.identity).join('\n')
      !== cautious.map((entry) => entry.identity).join('\n');
    report.complete = Boolean(
      report.origins.count === 5
      && report.producerPaths.projection.length === 3
      && report.producerPaths.authored.length === 2
      && report.crawl.complete
      && report.crawl.origins === 5
      && report.cacheRebuild.deterministic
      && report.privateCanaries.count === 55
      && report.privateCanaries.hits === 0
      && report.deletion.inventoryRemoved
      && report.deletion.ownerQualified
      && report.conflictingMappings.count === 2
      && report.conflictingMappings.sourceQualified
      && report.staleProposal.rejected
      && report.staleProposal.code === 'target-digest-mismatch'
      && report.staleProposal.calls.apply === 0
      && report.staleProposal.calls.ofm === 0
      && report.staleProposal.calls.trust === 0
      && providerIdentityPreserved
      && providerOrderChanged
    );
    if (!report.complete) report.errors.push({ code: 'bounded-claim-incomplete', message: 'one or more bounded fixture assertions did not pass' });
  } catch (error) {
    report.errors.push(failureSummary(error));
  } finally {
    if (servers) await servers.stopAll();
    authored?.cleanup();
    projected?.cleanup();
    for (const root of cacheRoots) rmSync(root, { recursive: true, force: true });
  }

  return report;
}

export { SPIKE_ROOT };

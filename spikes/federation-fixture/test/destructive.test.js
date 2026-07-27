import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CRAWL_BUDGET_KEYS,
  FIXED_NOW,
  RELATIONS,
  sha256Digest,
  stableStringify,
} from '../src/contracts.js';
import {
  JsonCache,
  refreshCacheObservations,
} from '../src/cache.js';
import { crawlSeeds } from '../src/crawler.js';
import { buildAuthoredPublications } from '../src/producer-authored.js';
import { buildProjectedPublications } from '../src/producer-projection.js';
import {
  planRepublication,
  verifyLicensedMirrorProvenance,
} from '../src/rights.js';
import {
  searchCautiousEvidence,
  searchRecentOwnerRevisions,
} from '../src/search.js';
import {
  ProposalValidationError,
  applyByteSplices,
  createProposalReceiver,
} from '../src/proposal.js';
import { startFixtureServers } from '../src/server.js';
import { FixtureTransport } from '../src/transport.js';
import {
  FIXTURE_BASES,
  fixtureUrls,
} from '../src/topology.js';

const activeHarnesses = [];
const temporaryRoots = [];

function temporaryDirectory(label) {
  const root = mkdtempSync(join(tmpdir(), `cb-federation-destructive-${label}-`));
  temporaryRoots.push(root);
  return root;
}

async function createProducedHarness() {
  const projected = buildProjectedPublications();
  const authored = buildAuthoredPublications({ externalEvidence: projected.observedTargets });
  let servers;
  try {
    servers = await startFixtureServers({ roots: { ...projected.roots, ...authored.roots } });
  } catch (error) {
    authored.cleanup();
    projected.cleanup();
    throw error;
  }
  const harness = {
    projected,
    authored,
    publications: { ...projected.publications, ...authored.publications },
    ...servers,
    transport: new FixtureTransport({ topology: servers.topology }),
    async cleanup() {
      await servers.stopAll();
      authored.cleanup();
      projected.cleanup();
    },
  };
  activeHarnesses.push(harness);
  return harness;
}

function fileBytes(publication, logicalUrl) {
  const url = new URL(logicalUrl);
  const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  return readFileSync(join(publication.publicRoot, relative));
}

function directSubjectLinks(html) {
  return [...html.matchAll(/href="(https:\/\/(?:fungi|forage|toxins)\.test\/[^"#]*)"/g)]
    .map((match) => match[1]);
}

function withoutInventoryItem(publication, url) {
  return {
    ...publication.inventory,
    items: publication.inventory.items.filter((item) => item.url !== url),
  };
}

function proposalFixture() {
  const base = Buffer.from('# Chanterelle\n\nCorrect teh typo without rewriting.\n', 'utf8');
  const start = base.indexOf(Buffer.from('teh'));
  return {
    base,
    proposal: {
      proposalId: 'https://atlas.test/proposals/stale-exact-byte',
      target: {
        url: fixtureUrls('fungi').pages.primary,
        byteLength: base.byteLength,
        digest: sha256Digest(base),
      },
      splices: [{
        start,
        end: start + 3,
        insert: Buffer.from('the', 'utf8'),
      }],
    },
  };
}

afterEach(async () => {
  await Promise.allSettled(activeHarnesses.splice(0).map((harness) => harness.cleanup()));
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('destructive federation behavior', () => {
  test('direct owner navigation survives removal of optional federation services', async () => {
    const harness = await createProducedHarness();
    const cache = new JsonCache(temporaryDirectory('direct-links-cache'));
    await cache.initialize();
    await cache.clear();
    expect(existsSync(cache.root)).toBe(false);

    for (const base of FIXTURE_BASES) {
      harness.byId[base.id].setRoute(base.descriptorPath, 503);
      harness.byId[base.id].setRoute(base.inventoryPath, 503);
      for (const linksetPath of base.linksetPaths) harness.byId[base.id].setRoute(linksetPath, 503);
    }
    await harness.stop('atlas');
    await harness.stop('cautious');

    const ownerPages = [
      fixtureUrls('fungi').pages.primary,
      fixtureUrls('forage').pages.primary,
      fixtureUrls('toxins').pages.primary,
    ];
    const navigated = [];
    for (const ownerPage of ownerPages) {
      const page = await harness.transport.get(ownerPage);
      expect(page.status).toBe(200);
      for (const directUrl of directSubjectLinks(page.body.toString('utf8'))) {
        const direct = await harness.transport.get(directUrl);
        expect(direct.status).toBe(200);
        expect(new URL(direct.url).origin).toBe(new URL(directUrl).origin);
        navigated.push(directUrl);
      }
    }
    expect(new Set(navigated).size).toBeGreaterThanOrEqual(3);

    for (const id of ['fungi', 'forage', 'toxins']) {
      expect((await harness.transport.get(fixtureUrls(id).descriptor)).status).toBe(503);
      expect((await harness.transport.get(fixtureUrls(id).inventory)).status).toBe(503);
      expect((await harness.transport.get(fixtureUrls(id).linksets[0])).status).toBe(503);
    }
    await expect(harness.transport.get(fixtureUrls('atlas').homepage)).rejects.toMatchObject({ code: 'network' });
    await expect(harness.transport.get(fixtureUrls('cautious').homepage)).rejects.toMatchObject({ code: 'network' });
    expect(searchRecentOwnerRevisions([], 'chanterelle')).toEqual([]);
    expect(searchCautiousEvidence([], 'chanterelle')).toEqual([]);
  });

  test('deleting the disposable cache and rebuilding from the same seeds is byte-deterministic', async () => {
    const harness = await createProducedHarness();
    const cacheRoot = temporaryDirectory('cache-rebuild');
    const seeds = FIXTURE_BASES.map((base) => fixtureUrls(base).homepage);

    const first = new JsonCache(cacheRoot);
    const firstCrawl = await crawlSeeds(seeds, { transport: harness.transport, cache: first });
    expect(firstCrawl.complete).toBe(true);
    const firstBytes = await first.exportBytes();
    await first.clear();
    expect(existsSync(cacheRoot)).toBe(false);

    const rebuilt = new JsonCache(cacheRoot);
    const rebuiltCrawl = await crawlSeeds([...seeds].reverse(), { transport: harness.transport, cache: rebuilt });
    expect(rebuiltCrawl.complete).toBe(true);
    const rebuiltBytes = await rebuilt.exportBytes();
    expect(rebuiltBytes.equals(firstBytes)).toBe(true);
    expect(rebuiltCrawl.records.length).toBe(firstCrawl.records.length);
  });

  test('Atlas exact and Cautious close mappings retain source-qualified disagreement', async () => {
    const harness = await createProducedHarness();
    const crawl = await crawlSeeds(FIXTURE_BASES.map((base) => fixtureUrls(base).homepage), {
      transport: harness.transport,
    });
    expect(crawl.complete).toBe(true);

    const subject = fixtureUrls('fungi').pages.primary;
    const target = fixtureUrls('forage').pages.primary;
    const disagreement = crawl.records.filter((record) => (
      record.assertion.subject === subject
      && record.assertion.target === target
      && [RELATIONS.exactMatch, RELATIONS.closeMatch].includes(record.assertion.relation)
    ));
    expect(disagreement).toHaveLength(2);
    expect(disagreement.map((record) => record.issuer).sort()).toEqual([
      'https://atlas.test',
      'https://cautious.test',
    ]);
    expect(disagreement.map((record) => record.assertion.relation).sort()).toEqual([
      RELATIONS.closeMatch,
      RELATIONS.exactMatch,
    ].sort());
    for (const record of disagreement) {
      expect(record.assertion.rationale).not.toBeNull();
      expect(record.assertion.evidence.targetRevision).not.toBeNull();
      expect(record.assertion.evidence.targetDigest).toMatch(/^sha-256=:/);
      expect(record.assertion.evidence.observedAt).toBe(FIXED_NOW);
      expect(record.sourceDigest).toBe(record.assertion.evidence.sourceDigest);
      expect(record.assertionPublication.digest).toMatch(/^sha-256=:/);
    }
  });

  test('a complete owner inventory recovers artifacts when no incremental hint names them', async () => {
    const harness = await createProducedHarness();
    const homepage = await harness.transport.get(fixtureUrls('fungi').homepage);
    expect(homepage.headers.get('link')).toBeNull();
    expect(homepage.headers.get('etag')).toBeNull();
    expect(homepage.body.toString('utf8')).not.toContain('change-list');

    harness.byId.fungi.setRoute(fixtureUrls('fungi').linksets[0].replace('https://fungi.test', ''), 404);
    const crawl = await crawlSeeds([fixtureUrls('fungi').homepage], {
      transport: harness.transport,
      relationAllowlist: [RELATIONS.describedBy, RELATIONS.item],
    });
    const inventoryDiscoveries = crawl.discoveries.filter((entry) => entry.source === 'inventory' && entry.followed);
    expect(inventoryDiscoveries.length).toBeGreaterThan(0);
    expect(crawl.visitedUrls).toContain(fixtureUrls('fungi').pages.primary);
    expect(crawl.visitedUrls).toContain(fixtureUrls('fungi').pages.secondary);
    expect(crawl.visitedUrls).toContain(fixtureUrls('fungi').pages.mirrorSource);
  });

  test('inventory removal plus an exact owner 410 produces owner-qualified deletion', async () => {
    const harness = await createProducedHarness();
    const initial = await crawlSeeds(FIXTURE_BASES.map((base) => fixtureUrls(base).homepage), {
      transport: harness.transport,
    });
    const sourceUrl = fixtureUrls('atlas').pages.primary;
    const prior = initial.records.filter((record) => record.fetchedUrl === sourceUrl);
    expect(prior.length).toBeGreaterThan(0);

    harness.byId.atlas.setRoute('/catalog/current.json', {
      json: withoutInventoryItem(harness.publications.atlas, sourceUrl),
    });
    harness.byId.atlas.setRoute('/collections/beginner-field-set.html', { status: 410, body: 'gone\n' });
    const inventory = await harness.transport.get(fixtureUrls('atlas').inventory);
    expect(JSON.parse(inventory.body.toString('utf8')).items.some((item) => item.url === sourceUrl)).toBe(false);

    const refreshed = await refreshCacheObservations(prior, { transport: harness.transport });
    expect(refreshed.every((record) => record.publisher === 'https://atlas.test')).toBe(true);
    expect(refreshed.every((record) => record.observation.state === 'deleted')).toBe(true);
    expect(refreshed.every((record) => record.observation.httpStatus === 410)).toBe(true);
  });

  test('changed bytes and transient outage become stale or unavailable, never deleted', async () => {
    const harness = await createProducedHarness();
    const initial = await crawlSeeds(FIXTURE_BASES.map((base) => fixtureUrls(base).homepage), {
      transport: harness.transport,
    });
    const sourceUrl = fixtureUrls('cautious').pages.primary;
    const prior = initial.records.filter((record) => record.fetchedUrl === sourceUrl);
    expect(prior.length).toBeGreaterThan(0);

    harness.byId.cautious.setRoute('/crawl/snapshot.json', {
      json: withoutInventoryItem(harness.publications.cautious, sourceUrl),
    });
    const original = fileBytes(harness.publications.cautious, sourceUrl);
    const mutated = Buffer.from(original);
    mutated[mutated.byteLength - 2] = mutated[mutated.byteLength - 2] === 0x20 ? 0x21 : 0x20;
    expect(mutated.byteLength).toBe(original.byteLength);
    harness.byId.cautious.setRoute('/collections/conservative-field-set.html', { body: mutated, mediaType: 'text/html; charset=utf-8' });
    const stale = await refreshCacheObservations(prior, { transport: harness.transport });
    expect(stale.every((record) => record.observation.state === 'stale')).toBe(true);
    expect(stale.some((record) => record.observation.state === 'deleted')).toBe(false);

    harness.byId.cautious.setRoute('/collections/conservative-field-set.html', { status: 503, body: 'temporary outage\n' });
    const unavailable = await refreshCacheObservations(prior, { transport: harness.transport });
    expect(unavailable.every((record) => record.observation.state === 'unavailable')).toBe(true);
    expect(unavailable.every((record) => record.observation.httpStatus === 503)).toBe(true);
    expect(unavailable.some((record) => record.observation.state === 'deleted')).toBe(false);
  });

  test('licensed mirrors retain source authority while incompatible rights remain link-only', async () => {
    const harness = await createProducedHarness();
    const fungiUrl = fixtureUrls('fungi').pages.mirrorSource;
    const atlasUrl = fixtureUrls('atlas').pages.mirror;
    const sourceBytes = fileBytes(harness.publications.fungi, fungiUrl);
    const mirrorBytes = fileBytes(harness.publications.atlas, atlasUrl);
    const sourceItem = harness.publications.fungi.inventory.items.find((item) => item.url === fungiUrl);
    const mirrorItem = harness.publications.atlas.inventory.items.find((item) => item.url === atlasUrl);
    const mirrorDecision = planRepublication({
      source: {
        publisher: 'https://fungi.test',
        url: fungiUrl,
        revision: 'fungi-comparison-r1',
        digest: sourceItem.digest,
        byteLength: sourceItem.byteLength,
        rights: mirrorItem.rights,
      },
      destination: {
        publisher: 'https://atlas.test',
        url: atlasUrl,
        revision: 'atlas-mirror-r1',
      },
      sourceBytes,
      mirrorBytes,
      retrievedAt: FIXED_NOW,
    });
    expect(mirrorDecision.decision).toBe('licensed-mirror');
    expect(mirrorDecision.mirror.authority.sourceAuthorityTransferred).toBe(false);
    expect(verifyLicensedMirrorProvenance(mirrorDecision.mirror, { sourceBytes, mirrorBytes })).toEqual({ ok: true, errors: [] });

    const toxinsUrl = fixtureUrls('toxins').pages.primary;
    const toxinsBytes = fileBytes(harness.publications.toxins, toxinsUrl);
    const toxinsItem = harness.publications.toxins.inventory.items.find((item) => item.url === toxinsUrl);
    const linkOnly = planRepublication({
      source: {
        publisher: 'https://toxins.test',
        url: toxinsUrl,
        revision: 'toxins-false-chanterelle-r2',
        digest: toxinsItem.digest,
        byteLength: toxinsItem.byteLength,
        rights: toxinsItem.rights,
      },
      destination: {
        publisher: 'https://atlas.test',
        url: 'https://atlas.test/mirrors/toxins/false-chanterelle.html',
        revision: 'must-not-exist',
      },
      sourceBytes: toxinsBytes,
      mirrorBytes: toxinsBytes,
    });
    expect(linkOnly).toMatchObject({ decision: 'link-only', permitted: false, bodyCopied: false });
    expect(linkOnly.directOwnerUrl).toBe(toxinsUrl);
    expect(linkOnly).not.toHaveProperty('publicationBytes');
    expect(stableStringify(linkOnly)).not.toContain('This body is link-only fixture content.');
  });

  test('the Atlas/Cautious recursion terminates and reports every declared budget', async () => {
    const harness = await createProducedHarness();
    const result = await crawlSeeds([
      fixtureUrls('atlas').homepage,
      fixtureUrls('cautious').homepage,
    ], { transport: harness.transport });
    expect(result.complete).toBe(false);
    expect(result.stoppedBy).toEqual(['maxDepth']);
    expect(result.budgets.maxDepth.exhausted).toBe(true);
    expect(Object.keys(result.budgets)).toEqual(CRAWL_BUDGET_KEYS);
    expect(new Set(result.visitedUrls).size).toBe(result.visitedUrls.length);
    expect(result.visitedUrls).toContain(fixtureUrls('atlas').pages.primary);
    expect(result.visitedUrls).toContain(fixtureUrls('cautious').pages.primary);
    expect(result.budgets.maxConcurrency.used).toBeLessThanOrEqual(result.budgets.maxConcurrency.limit);
  });

  test('each stopping budget reports its exhausted key and concurrency remains a cap', async () => {
    const harness = await createProducedHarness();
    const atlasSeed = fixtureUrls('atlas').homepage;
    const cases = [
      ['maxDepth', { maxDepth: 1 }],
      ['maxOrigins', { maxOrigins: 1 }],
      ['maxUrls', { maxUrls: 1 }],
      ['maxResponseBytes', { maxResponseBytes: 32 }],
      ['maxTotalBytes', { maxTotalBytes: 32 }],
      ['maxDecompressedBytes', { maxDecompressedBytes: 32 }],
      ['maxParserBytes', { maxParserBytes: 32 }],
    ];
    for (const [key, budgets] of cases) {
      const result = await crawlSeeds([atlasSeed], { transport: harness.transport, budgets });
      expect(result.complete).toBe(false);
      expect(result.stoppedBy).toContain(key);
      expect(result.budgets[key].exhausted).toBe(true);
      expect(result.budgets[key].limit).toBe(budgets[key]);
    }

    harness.byId.atlas.setRoute('/redirect-one', { status: 302, location: '/redirect-two' });
    harness.byId.atlas.setRoute('/redirect-two', { status: 302, location: '/' });
    const redirects = await crawlSeeds(['https://atlas.test/redirect-one'], {
      transport: harness.transport,
      budgets: { maxRedirects: 1 },
    });
    expect(redirects.stoppedBy).toContain('maxRedirects');
    expect(redirects.budgets.maxRedirects.exhausted).toBe(true);

    let parserTick = 0;
    const parser = await crawlSeeds([atlasSeed], {
      transport: harness.transport,
      budgets: { maxParserMs: 1 },
      monotonicNow: () => {
        parserTick += 2;
        return parserTick;
      },
    });
    expect(parser.stoppedBy).toContain('maxParserMs');
    expect(parser.budgets.maxParserMs.exhausted).toBe(true);

    let wallTick = 0;
    const wall = await crawlSeeds([atlasSeed], {
      transport: harness.transport,
      budgets: { maxWallTimeMs: 1 },
      monotonicNow: () => {
        wallTick += 2;
        return wallTick;
      },
    });
    expect(wall.stoppedBy).toContain('maxWallTimeMs');
    expect(wall.budgets.maxWallTimeMs.exhausted).toBe(true);

    const concurrency = await crawlSeeds(FIXTURE_BASES.map((base) => fixtureUrls(base).homepage), {
      transport: harness.transport,
      budgets: { maxConcurrency: 2 },
    });
    expect(concurrency.budgets.maxConcurrency.limit).toBe(2);
    expect(concurrency.budgets.maxConcurrency.used).toBeLessThanOrEqual(2);
    expect(concurrency.budgets.maxConcurrency.exhausted).toBe(false);
  });

  test('switching visible search providers changes ranking but not identities or direct URLs', async () => {
    const harness = await createProducedHarness();
    const crawl = await crawlSeeds(FIXTURE_BASES.map((base) => fixtureUrls(base).homepage), {
      transport: harness.transport,
    });
    const atlasExact = crawl.records.find((record) => record.assertion.relation === RELATIONS.exactMatch);
    const cautiousClose = crawl.records.find((record) => record.assertion.relation === RELATIONS.closeMatch);
    const cautiousAnnotation = crawl.records.find((record) => record.assertion.relation === RELATIONS.annotation);
    expect(atlasExact).toBeDefined();
    expect(cautiousClose).toBeDefined();
    expect(cautiousAnnotation).toBeDefined();

    const records = [
      {
        ...atlasExact,
        search: {
          directOwnerUrl: fixtureUrls('fungi').pages.primary,
          title: 'Golden chanterelle',
          summary: 'Owner species entry.',
          keywords: ['chanterelle'],
          ownerRevision: {
            publisher: 'https://fungi.test',
            revision: 'fungi-r11',
            digest: atlasExact.assertion.evidence.targetDigest,
            observedAt: '2026-07-27T11:45:00.000Z',
          },
        },
      },
      {
        ...cautiousClose,
        search: {
          directOwnerUrl: fixtureUrls('forage').pages.primary,
          title: 'Chanterelle field guide',
          summary: 'Regional owner field guide.',
          keywords: ['chanterelle'],
          ownerRevision: {
            publisher: 'https://forage.test',
            revision: 'forage-r4',
            digest: cautiousClose.assertion.evidence.targetDigest,
            observedAt: '2026-07-27T08:00:00.000Z',
          },
        },
      },
      {
        ...cautiousAnnotation,
        search: {
          directOwnerUrl: fixtureUrls('forage').pages.primary,
          title: 'Chanterelle field guide annotation',
          summary: 'Cautious annotation evidence.',
          keywords: ['chanterelle'],
        },
      },
    ];
    const recent = searchRecentOwnerRevisions(records, 'chanterelle', { crawlTime: FIXED_NOW });
    const cautiousFirst = searchCautiousEvidence(records, 'chanterelle', { crawlTime: FIXED_NOW });
    expect(recent.map((result) => result.directOwnerUrl)).toEqual([
      fixtureUrls('fungi').pages.primary,
      fixtureUrls('forage').pages.primary,
    ]);
    expect(cautiousFirst.map((result) => result.directOwnerUrl)).toEqual([
      fixtureUrls('forage').pages.primary,
      fixtureUrls('fungi').pages.primary,
    ]);
    expect(new Set(recent.map((result) => result.identity))).toEqual(new Set(cautiousFirst.map((result) => result.identity)));
    expect(recent.every((result) => result.rankingPolicy.includes('revision'))).toBe(true);
    expect(cautiousFirst.every((result) => result.rankingPolicy.includes('Cautious'))).toBe(true);
    expect(recent.every((result) => result.directOwnerUrl === result.identity)).toBe(true);
    expect(cautiousFirst.every((result) => result.directOwnerUrl === result.identity)).toBe(true);
  });

  test('same-length stale proposal bytes fail before apply, OFM, trust, or rebase', () => {
    const { base, proposal } = proposalFixture();
    const staleBytes = Buffer.from(base);
    staleBytes[staleBytes.indexOf(Buffer.from('teh'))] = 'x'.charCodeAt(0);
    expect(staleBytes.byteLength).toBe(proposal.target.byteLength);
    expect(sha256Digest(staleBytes)).not.toBe(proposal.target.digest);
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

    let failure;
    try {
      receive({
        proposal,
        receiver: {
          publisher: 'https://fungi.test',
          targetUrl: fixtureUrls('fungi').pages.primary,
          path: 'species/chanterelle.md',
          currentBytes: staleBytes,
          contributor: { id: 'fixture-agent', type: 'agent' },
          trustConfig: {},
        },
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ProposalValidationError);
    expect(failure).toMatchObject({ code: 'target-digest-mismatch', phase: 'precondition' });
    expect(calls).toEqual({ apply: 0, ofm: 0, trust: 0 });
    expect(failure.details).not.toHaveProperty('rebase');
  });
});

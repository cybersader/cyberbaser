import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  DEFAULT_CRAWL_BUDGETS,
  FIXED_NOW,
  FIXTURE_PROFILE_URN,
  LINKSET_EVIDENCE,
  RELATIONS,
  cacheRecordKey,
  sha256Digest,
} from '../src/contracts.js';
import { JsonCache } from '../src/cache.js';
import { crawlSeeds } from '../src/crawler.js';
import { buildAuthoredPublications } from '../src/producer-authored.js';
import { buildProjectedPublications } from '../src/producer-projection.js';
import { startFixtureServers } from '../src/server.js';
import {
  FixtureTransport,
  PublicHttpTransport,
  TransportLimitError,
  TransportPolicyError,
  isPublicIpAddress,
} from '../src/transport.js';
import {
  FIXTURE_BASES,
  fixtureUrls,
} from '../src/topology.js';

const temporaryRoots = [];
const runningHarnesses = [];

function temporaryDirectory(label) {
  const root = mkdtempSync(join(tmpdir(), `cb-federation-${label}-`));
  temporaryRoots.push(root);
  return root;
}

function write(root, path, value) {
  const target = join(root, path.replace(/^\//, ''));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, value);
}

function homepageHtml(base) {
  return `<!doctype html><title>${base.label}</title><link rel="describedby" href="${base.descriptorPath}"><main>${base.id}</main>`;
}

function evidence(issuer, id, rationale, targetRevision) {
  const base = FIXTURE_BASES.find((candidate) => candidate.logicalOrigin === issuer);
  const sourceUrl = `${issuer}/`;
  return {
    [LINKSET_EVIDENCE.assertionId]: [`${issuer}/assertions/${id}`],
    [LINKSET_EVIDENCE.issuer]: [issuer],
    [LINKSET_EVIDENCE.observedAt]: [FIXED_NOW],
    [LINKSET_EVIDENCE.sourceDigest]: [sha256Digest(homepageHtml(base))],
    [LINKSET_EVIDENCE.rationale]: [rationale],
    [LINKSET_EVIDENCE.evidence]: [JSON.stringify({
      sourceUrl,
      targetRevision,
      targetDigest: sha256Digest(`target:${targetRevision}`),
    })],
    'cb-rights-mode': ['owner-published'],
    'cb-rights-summary': [`${issuer} publishes this fixture assertion.`],
  };
}

function sortedTargets(targets) {
  return [...targets].sort((a, b) => {
    const aId = a[LINKSET_EVIDENCE.assertionId][0];
    const bId = b[LINKSET_EVIDENCE.assertionId][0];
    return a.href.localeCompare(b.href) || aId.localeCompare(bId);
  });
}

function linksetFor(base) {
  const fungi = fixtureUrls('fungi');
  const forage = fixtureUrls('forage');
  const toxins = fixtureUrls('toxins');
  const atlas = fixtureUrls('atlas');
  const cautious = fixtureUrls('cautious');
  if (base.id === 'atlas') {
    return {
      linkset: [
        {
          anchor: fungi.pages.primary,
          [RELATIONS.exactMatch]: sortedTargets([
            {
              href: forage.pages.primary,
              ...evidence(base.logicalOrigin, 'fungi-forage', 'Atlas considers the pages exact peers.', 'forage-r17'),
            },
          ]),
          [RELATIONS.related]: sortedTargets([
            {
              href: cautious.homepage,
              ...evidence(base.logicalOrigin, 'cautious-cycle', 'Atlas points to a competing collection.', 'cautious-r4'),
            },
          ]),
          'urn:cyberbaser:fixture:unknown-relation': sortedTargets([
            {
              href: toxins.pages.secondary,
              ...evidence(base.logicalOrigin, 'unknown-inert', 'This unknown relation must remain inert.', 'toxins-r2'),
            },
          ]),
        },
      ],
    };
  }
  if (base.id === 'cautious') {
    return {
      linkset: [
        {
          anchor: fungi.pages.primary,
          [RELATIONS.exactMatch]: sortedTargets([
            {
              href: forage.pages.primary,
              ...evidence(base.logicalOrigin, 'fungi-forage', 'Cautious preserves the endpoint but disputes Atlas reasoning.', 'forage-r16'),
            },
          ]),
          [RELATIONS.related]: sortedTargets([
            {
              href: atlas.homepage,
              ...evidence(base.logicalOrigin, 'atlas-cycle', 'Cautious links back to Atlas for comparison.', 'atlas-r9'),
            },
          ]),
        },
      ],
    };
  }
  return { linkset: [] };
}

function descriptorFor(base) {
  const urls = fixtureUrls(base);
  return {
    profile: FIXTURE_PROFILE_URN,
    publisher: base.logicalOrigin,
    homepage: urls.homepage,
    inventory: urls.inventory,
    linksets: urls.linksets,
    policies: {
      rights: {
        mode: base.defaultRights,
        summary: `${base.label} fixture publication rights.`,
      },
      history: {
        mode: 'snapshot-only',
        summary: 'This fixture exposes only its current deterministic snapshot.',
      },
    },
    capabilities: base.capabilities,
  };
}

function inventoryFor(base) {
  const urls = fixtureUrls(base);
  return {
    profile: FIXTURE_PROFILE_URN,
    publisher: base.logicalOrigin,
    inventory: urls.inventory,
    generatedAt: FIXED_NOW,
    complete: true,
    items: [],
  };
}

async function createHarness() {
  const roots = {};
  const routeOverlays = {};
  for (const base of FIXTURE_BASES) {
    const root = temporaryDirectory(base.id);
    roots[base.id] = root;
    write(root, '/index.html', homepageHtml(base));
    for (const path of Object.values(base.pages)) write(root, path, `<title>${base.id}</title><main>${path}</main>`);
    routeOverlays[base.id] = {
      [base.descriptorPath]: { json: descriptorFor(base) },
      [base.inventoryPath]: { json: inventoryFor(base) },
      [base.linksetPaths[0]]: {
        body: JSON.stringify(linksetFor(base), null, 2),
        mediaType: 'application/linkset+json; charset=utf-8',
      },
    };
  }
  const servers = await startFixtureServers({ roots, routeOverlays });
  const transport = new FixtureTransport({ topology: servers.topology });
  const harness = { ...servers, transport, roots };
  runningHarnesses.push(harness);
  return harness;
}

afterEach(async () => {
  await Promise.allSettled(runningHarnesses.splice(0).map((harness) => harness.stopAll()));
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('five independent fixture origins', () => {
  test('serve safe GET/HEAD paths on distinct ephemeral loopback ports', async () => {
    const harness = await createHarness();
    expect(harness.servers).toHaveLength(5);
    expect(new Set(harness.servers.map((server) => server.physicalOrigin)).size).toBe(5);
    expect(new Set(harness.servers.map((server) => server.root)).size).toBe(5);

    for (const base of FIXTURE_BASES) {
      const get = await harness.transport.get(base.logicalOrigin);
      const head = await harness.transport.head(base.logicalOrigin);
      expect(get.status).toBe(200);
      expect(get.body.toString('utf8')).toContain(`<main>${base.id}</main>`);
      expect(head.status).toBe(200);
      expect(head.body.byteLength).toBe(0);
      expect(Number(head.headers.get('content-length'))).toBe(get.body.byteLength);
    }
  });

  test('rejects unsafe methods, traversal, and a symlink that escapes one publisher root', async () => {
    const harness = await createHarness();
    const fungi = harness.byId.fungi;
    const outside = join(temporaryDirectory('outside'), 'secret.txt');
    writeFileSync(outside, 'must not be served');
    symlinkSync(outside, join(fungi.root, 'escape.txt'));

    const post = await fetch(`${fungi.physicalOrigin}/`, { method: 'POST' });
    const traversal = await fetch(`${fungi.physicalOrigin}/%2e%2e%2findex.html`, { redirect: 'manual' });
    const escaped = await fetch(`${fungi.physicalOrigin}/escape.txt`);
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET, HEAD');
    expect(traversal.status).not.toBe(200);
    expect(escaped.status).toBe(403);
  });

  test('route overlays are mutable and each origin can stop independently', async () => {
    const harness = await createHarness();
    harness.byId.atlas.setRoute('/temporary-redirect', {
      status: 302,
      location: 'https://cautious.test/',
    });
    harness.byId.toxins.setRoute('/removed', { status: 410, body: 'gone' });

    const redirected = await harness.transport.get('https://atlas.test/temporary-redirect');
    const removed = await harness.transport.get('https://toxins.test/removed');
    expect(redirected.url).toBe('https://cautious.test/');
    expect(redirected.redirects).toEqual([{
      from: 'https://atlas.test/temporary-redirect',
      to: 'https://cautious.test/',
      status: 302,
    }]);
    expect(removed.status).toBe(410);

    await harness.stop('fungi');
    await expect(harness.transport.get('https://fungi.test/')).rejects.toMatchObject({ code: 'network' });
    expect((await harness.transport.get('https://forage.test/')).status).toBe(200);
  });

  test('FixtureTransport accepts only exact logical fixture origins and enforces limits', async () => {
    const harness = await createHarness();
    await expect(harness.transport.get('https://sixth.test/')).rejects.toBeInstanceOf(TransportPolicyError);
    await expect(harness.transport.get('https://user:pass@fungi.test/')).rejects.toMatchObject({ code: 'url-credentials' });
    await expect(harness.transport.get('http://fungi.test/')).rejects.toMatchObject({ code: 'url-scheme' });
    await expect(harness.transport.get('https://fungi.test/%2e%2e%2fsecret')).rejects.toMatchObject({ code: 'url-path' });
    await expect(harness.transport.get('https://fungi.test/', { maxResponseBytes: 4 })).rejects.toBeInstanceOf(TransportLimitError);
  });
});

describe('bounded discovery and deletable source-qualified cache', () => {
  test('discovers from chosen seeds, terminates cycles, and keeps competing mappings distinct', async () => {
    const harness = await createHarness();
    const cacheRoot = temporaryDirectory('cache');
    const cache = new JsonCache(cacheRoot);
    const seeds = [fixtureUrls('atlas').homepage, fixtureUrls('cautious').homepage];
    const result = await crawlSeeds(seeds, { transport: harness.transport, cache });

    expect(result.complete).toBe(true);
    expect(result.stoppedBy).toEqual([]);
    expect(Object.keys(result.budgets)).toEqual(Object.keys(DEFAULT_CRAWL_BUDGETS));
    expect(result.budgets.maxConcurrency.used).toBeLessThanOrEqual(DEFAULT_CRAWL_BUDGETS.maxConcurrency);
    expect(new Set(result.visitedUrls).size).toBe(result.visitedUrls.length);
    expect(result.visitedUrls).toContain(fixtureUrls('atlas').descriptor);
    expect(result.visitedUrls).toContain(fixtureUrls('cautious').descriptor);

    const unknown = result.skippedDiscoveries.find((entry) => entry.relation === 'urn:cyberbaser:fixture:unknown-relation');
    expect(unknown).toMatchObject({ reason: 'relation-not-allowlisted' });
    expect(result.visitedUrls).not.toContain(fixtureUrls('toxins').pages.secondary);

    const competing = result.records.filter((record) => (
      record.assertion.subject === fixtureUrls('fungi').pages.primary
      && record.assertion.relation === RELATIONS.exactMatch
      && record.assertion.target === fixtureUrls('forage').pages.primary
    ));
    expect(competing).toHaveLength(2);
    expect(competing.map((record) => record.issuer).sort()).toEqual([
      'https://atlas.test',
      'https://cautious.test',
    ]);
    expect(new Set(competing.map(cacheRecordKey)).size).toBe(2);
    expect(competing.map((record) => record.assertion.rationale).sort()).toEqual([
      'Atlas considers the pages exact peers.',
      'Cautious preserves the endpoint but disputes Atlas reasoning.',
    ]);
  });

  test('crawls all five independently produced publications with verified source artifacts', async () => {
    const projected = buildProjectedPublications();
    const authored = buildAuthoredPublications({ externalEvidence: projected.observedTargets });
    let servers;
    try {
      servers = await startFixtureServers({ roots: { ...projected.roots, ...authored.roots } });
      runningHarnesses.push(servers);
      const transport = new FixtureTransport({ topology: servers.topology });
      const result = await crawlSeeds(FIXTURE_BASES.map((base) => fixtureUrls(base).homepage), { transport });
      expect(result.complete).toBe(true);
      expect(result.stoppedBy).toEqual([]);
      expect(result.errors).toEqual([]);
      expect(result.origins).toEqual(FIXTURE_BASES.map((base) => base.logicalOrigin).sort());
      expect(result.records.length).toBeGreaterThan(0);
      for (const record of result.records) {
        expect(record.fetchedUrl).toBe(record.assertion.evidence.sourceUrl);
        expect(record.sourceDigest).toBe(record.assertion.evidence.sourceDigest);
        expect(record.rawArtifact.digest).toBe(record.sourceDigest);
        expect(record.assertionPublication.url).toContain('.json');
      }
      expect(result.records.some((record) => record.rights.mode === 'link-only')).toBe(true);
    } finally {
      await servers?.stopAll();
      authored.cleanup();
      projected.cleanup();
    }
  });

  test('deleting the cache root and recrawling from the same seeds and clock is byte-deterministic', async () => {
    const harness = await createHarness();
    const cacheRoot = temporaryDirectory('rebuild-cache');
    const seeds = [fixtureUrls('atlas').homepage, fixtureUrls('cautious').homepage];

    const first = new JsonCache(cacheRoot);
    await crawlSeeds(seeds, { transport: harness.transport, cache: first });
    const firstBytes = await first.exportBytes();
    await first.clear();
    expect(existsSync(cacheRoot)).toBe(false);

    const rebuilt = new JsonCache(cacheRoot);
    await crawlSeeds([...seeds].reverse(), { transport: harness.transport, cache: rebuilt });
    const rebuiltBytes = await rebuilt.exportBytes();
    expect(rebuiltBytes.equals(firstBytes)).toBe(true);
  });

  test('URL and depth budgets stop discovery and report the exact exhausted keys', async () => {
    const harness = await createHarness();
    const urlResult = await crawlSeeds([fixtureUrls('atlas').homepage], {
      transport: harness.transport,
      budgets: { maxUrls: 2 },
    });
    expect(urlResult.complete).toBe(false);
    expect(urlResult.stoppedBy).toContain('maxUrls');
    expect(urlResult.budgets.maxUrls).toEqual({ limit: 2, used: 2, exhausted: true });
    expect(urlResult.visitedUrls.length).toBeLessThanOrEqual(2);

    const depthResult = await crawlSeeds([fixtureUrls('atlas').homepage], {
      transport: harness.transport,
      budgets: { maxDepth: 1 },
    });
    expect(depthResult.complete).toBe(false);
    expect(depthResult.stoppedBy).toContain('maxDepth');
    expect(depthResult.budgets.maxDepth).toEqual({ limit: 1, used: 1, exhausted: true });

    harness.byId.atlas.setRoute('/redirect-one', { status: 302, location: '/redirect-two' });
    harness.byId.atlas.setRoute('/redirect-two', { status: 302, location: '/' });
    const redirectResult = await crawlSeeds(['https://atlas.test/redirect-one'], {
      transport: harness.transport,
      budgets: { maxRedirects: 1 },
    });
    expect(redirectResult.complete).toBe(false);
    expect(redirectResult.stoppedBy).toContain('maxRedirects');
    expect(redirectResult.budgets.maxRedirects).toEqual({ limit: 1, used: 1, exhausted: true });
  });
});

describe('structurally separate public HTTP policy', () => {
  test('recognizes public and non-public IPv4 and IPv6 literals', () => {
    expect(isPublicIpAddress('8.8.8.8')).toBe(true);
    expect(isPublicIpAddress('127.0.0.1')).toBe(false);
    expect(isPublicIpAddress('192.0.2.8')).toBe(false);
    expect(isPublicIpAddress('2606:4700:4700::1111')).toBe(true);
    expect(isPublicIpAddress('::1')).toBe(false);
    expect(isPublicIpAddress('fc00::1')).toBe(false);
  });

  test('blocks insecure, credentialed, reserved-name, and private-address requests before request dispatch', async () => {
    let requests = 0;
    let resolutions = 0;
    const transport = new PublicHttpTransport({
      resolve: async () => {
        resolutions += 1;
        return [{ address: '127.0.0.1', family: 4 }];
      },
      request: async () => {
        requests += 1;
        return new Response('unexpected');
      },
    });

    await expect(transport.get('http://public.cyberbaser.dev/')).rejects.toMatchObject({ code: 'url-scheme' });
    await expect(transport.get('https://user:secret@public.cyberbaser.dev/')).rejects.toMatchObject({ code: 'url-credentials' });
    await expect(transport.get('https://fungi.test/')).rejects.toMatchObject({ code: 'reserved-hostname' });
    await expect(transport.get('https://private.cyberbaser.dev/')).rejects.toMatchObject({ code: 'blocked-address' });
    await expect(transport.get('https://[::1]/')).rejects.toMatchObject({ code: 'blocked-address' });
    expect(resolutions).toBe(1);
    expect(requests).toBe(0);
  });

  test('passes validated addresses to an injected requester and sends no ambient credentials', async () => {
    const calls = [];
    const transport = new PublicHttpTransport({
      resolve: async () => [{ address: '93.184.216.34', family: 4 }],
      request: async (url, init, context) => {
        calls.push({ url, init, context });
        return new Response('public artifact', {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        });
      },
    });

    const response = await transport.get('https://public.cyberbaser.dev/artifact');
    expect(response.status).toBe(200);
    expect(response.body.toString('utf8')).toBe('public artifact');
    expect(calls).toHaveLength(1);
    expect(calls[0].init.credentials).toBe('omit');
    expect(calls[0].init.redirect).toBe('manual');
    expect(calls[0].init.headers.get('authorization')).toBeNull();
    expect(calls[0].init.headers.get('cookie')).toBeNull();
    expect(calls[0].context).toMatchObject({
      kind: 'public',
      requireAddressPinning: true,
      addresses: [{ address: '93.184.216.34', family: 4 }],
    });

    await expect(transport.get('https://public.cyberbaser.dev/', {
      headers: { cookie: 'ambient=true' },
    })).rejects.toMatchObject({ code: 'ambient-credentials' });
    expect(calls).toHaveLength(1);
  });

  test('enforces wall-time limits across DNS and streamed response bodies', async () => {
    const stalledDns = new PublicHttpTransport({
      limits: { maxWallTimeMs: 20 },
      resolve: async () => new Promise(() => {}),
      request: async () => new Response('unexpected'),
    });
    await expect(stalledDns.get('https://slow-dns.cyberbaser.dev/')).rejects.toMatchObject({
      code: 'maxWallTimeMs',
    });

    const slowBody = new PublicHttpTransport({
      limits: { maxWallTimeMs: 20 },
      resolve: async () => [{ address: '93.184.216.34', family: 4 }],
      request: async () => new Response(new ReadableStream({
        async pull(controller) {
          await Bun.sleep(100);
          try {
            controller.enqueue(new TextEncoder().encode('late'));
            controller.close();
          } catch {
            // The transport cancels the stream when its deadline expires.
          }
        },
      })),
    });
    await expect(slowBody.get('https://slow-body.cyberbaser.dev/')).rejects.toMatchObject({
      code: 'maxWallTimeMs',
    });
  });

  test('revalidates a redirect destination and blocks private DNS without a second request', async () => {
    const requests = [];
    const resolutions = [];
    const transport = new PublicHttpTransport({
      resolve: async (hostname) => {
        resolutions.push(hostname);
        return hostname === 'redirect.cyberbaser.dev'
          ? [{ address: '93.184.216.34', family: 4 }]
          : [{ address: '10.0.0.8', family: 4 }];
      },
      request: async (url) => {
        requests.push(url);
        return new Response(null, {
          status: 302,
          headers: { location: 'https://private.cyberbaser.dev/secret' },
        });
      },
    });

    await expect(transport.get('https://redirect.cyberbaser.dev/start')).rejects.toMatchObject({
      code: 'blocked-address',
    });
    expect(requests).toEqual(['https://redirect.cyberbaser.dev/start']);
    expect(resolutions).toEqual(['redirect.cyberbaser.dev', 'private.cyberbaser.dev']);
  });
});

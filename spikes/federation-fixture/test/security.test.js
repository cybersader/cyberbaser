import { afterEach, describe, expect, test } from 'bun:test';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FIXED_NOW,
  stableStringify,
} from '../src/contracts.js';
import { JsonCache } from '../src/cache.js';
import { crawlSeeds } from '../src/crawler.js';
import {
  AUTHORED_BASE_IDS,
  AUTHORED_FIXTURE_ROOT,
  buildAuthoredPublications,
} from '../src/producer-authored.js';
import {
  PROJECTED_BASE_IDS,
  PROJECTED_FIXTURE_ROOT,
  buildProjectedPublications,
} from '../src/producer-projection.js';
import {
  searchCautiousEvidence,
  searchRecentOwnerRevisions,
} from '../src/search.js';
import {
  safeRequestPath,
  startFixtureServers,
} from '../src/server.js';
import {
  FixtureTransport,
  PublicHttpTransport,
  TransportPolicyError,
} from '../src/transport.js';
import {
  FIXTURE_BASES,
  FIXTURE_ORIGINS,
  fixtureUrls,
} from '../src/topology.js';
import { runFederationVerification } from '../src/verification.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const activeHarnesses = [];
const temporaryRoots = [];

function temporaryDirectory(label) {
  const root = mkdtempSync(join(tmpdir(), `cb-federation-security-${label}-`));
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

function canaryManifests() {
  return [
    ...PROJECTED_BASE_IDS.map((id) => JSON.parse(readFileSync(join(PROJECTED_FIXTURE_ROOT, id, 'private/canaries.json'), 'utf8'))),
    ...AUTHORED_BASE_IDS.map((id) => JSON.parse(readFileSync(join(AUTHORED_FIXTURE_ROOT, id, 'private/canaries.json'), 'utf8'))),
  ];
}

function canaryProbes(manifests) {
  const probes = new Set();
  for (const manifest of manifests) {
    for (const [kind, value] of Object.entries(manifest)) {
      probes.add(value);
      if (kind === 'encoded') probes.add(decodeURIComponent(value));
      if (kind === 'base64') probes.add(Buffer.from(value, 'base64').toString('utf8'));
      if (kind === 'path') probes.add(basename(value));
    }
  }
  return [...probes].sort();
}

function scanSurface(name, value, probes) {
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
  return probes.filter((probe) => text.includes(probe)).map((probe) => ({ name, probe }));
}

afterEach(async () => {
  await Promise.allSettled(activeHarnesses.splice(0).map((harness) => harness.cleanup()));
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('public transport SSRF policy through injected fakes', () => {
  test('private, reserved, mixed, literal, and reserved-name destinations never reach the requester', async () => {
    const blockedAddresses = [
      '0.0.0.1',
      '10.0.0.8',
      '100.64.0.1',
      '127.0.0.1',
      '169.254.169.254',
      '172.16.0.1',
      '192.0.2.8',
      '192.168.1.1',
      '198.18.0.1',
      '198.51.100.9',
      '203.0.113.9',
      '224.0.0.1',
      '240.0.0.1',
      '::1',
      '64:ff9b::1',
      '100::1',
      '2001:db8::1',
      'fc00::1',
      'fe80::1',
      'ff00::1',
      '::ffff:127.0.0.1',
    ];
    let requests = 0;
    let resolutions = 0;
    const transport = new PublicHttpTransport({
      resolve: async (hostname) => {
        resolutions += 1;
        const index = Number(hostname.match(/^blocked-(\d+)\./)?.[1]);
        if (hostname === 'mixed.cyberbaser.dev') {
          return [
            { address: '93.184.216.34', family: 4 },
            { address: '10.0.0.4', family: 4 },
          ];
        }
        const address = blockedAddresses[index];
        return [{ address, family: address.includes(':') ? 6 : 4 }];
      },
      request: async () => {
        requests += 1;
        return new Response('must not run');
      },
    });

    for (const [index] of blockedAddresses.entries()) {
      await expect(transport.get(`https://blocked-${index}.cyberbaser.dev/`)).rejects.toMatchObject({ code: 'blocked-address' });
    }
    await expect(transport.get('https://mixed.cyberbaser.dev/')).rejects.toMatchObject({ code: 'blocked-address' });
    await expect(transport.get('https://127.0.0.1/')).rejects.toMatchObject({ code: 'blocked-address' });
    await expect(transport.get('https://[::1]/')).rejects.toMatchObject({ code: 'blocked-address' });
    for (const reserved of [
      'https://localhost/',
      'https://single-label/',
      'https://fungi.test/',
      'https://service.local/',
      'https://service.internal/',
      'https://example.com/',
    ]) {
      await expect(transport.get(reserved)).rejects.toMatchObject({ code: 'reserved-hostname' });
    }
    expect(resolutions).toBe(blockedAddresses.length + 1);
    expect(requests).toBe(0);
  });

  test('validated public addresses are pinned and every redirect destination is revalidated', async () => {
    const requests = [];
    const resolutions = [];
    const transport = new PublicHttpTransport({
      resolve: async (hostname) => {
        resolutions.push(hostname);
        return hostname === 'start.cyberbaser.dev'
          ? [{ address: '93.184.216.34', family: 4 }]
          : [{ address: '10.0.0.9', family: 4 }];
      },
      request: async (url, init, context) => {
        requests.push({ url, init, context });
        return new Response(null, {
          status: 302,
          headers: { location: 'https://redirect-private.cyberbaser.dev/secret' },
        });
      },
    });

    await expect(transport.get('https://start.cyberbaser.dev/path')).rejects.toMatchObject({ code: 'blocked-address' });
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('https://start.cyberbaser.dev/path');
    expect(requests[0].init.redirect).toBe('manual');
    expect(requests[0].init.credentials).toBe('omit');
    expect(requests[0].context).toMatchObject({
      kind: 'public',
      requireAddressPinning: true,
      addresses: [{ address: '93.184.216.34', family: 4 }],
    });
    expect(resolutions).toEqual(['start.cyberbaser.dev', 'redirect-private.cyberbaser.dev']);
  });
});

describe('fixture-only transport and server path boundaries', () => {
  test('FixtureTransport accepts only the five exact logical HTTPS origins', async () => {
    const harness = await createProducedHarness();
    for (const origin of FIXTURE_ORIGINS) expect((await harness.transport.get(origin)).status).toBe(200);

    const rejected = [
      'http://fungi.test/',
      'https://fungi.test:444/',
      'https://sub.fungi.test/',
      'https://fungi.test.evil.example/',
      'https://sixth.test/',
      'https://user:pass@fungi.test/',
      'https://fungi.test/#fragment',
      'https://127.0.0.1/',
    ];
    for (const url of rejected) await expect(harness.transport.get(url)).rejects.toBeInstanceOf(TransportPolicyError);

    expect(() => new FixtureTransport({
      logicalToPhysical: { 'https://sixth.test': 'http://127.0.0.1:1234' },
    })).toThrow(TypeError);
    expect(() => new FixtureTransport({
      logicalToPhysical: { 'https://fungi.test': 'http://10.0.0.1:1234' },
    })).toThrow(TypeError);
  });

  test('decoded, encoded, double-encoded, backslash, NUL, and symlink traversal cannot escape a publisher root', async () => {
    const harness = await createProducedHarness();
    const outsideRoot = temporaryDirectory('outside');
    const outside = join(outsideRoot, 'private.txt');
    writeFileSync(outside, 'PRIVATE-SERVER-ESCAPE-CANARY\n');
    symlinkSync(outside, join(harness.byId.fungi.root, 'escape.txt'));

    for (const unsafe of [
      'https://fungi.test/../secret',
      'https://fungi.test/%2e%2e%2fsecret',
      'https://fungi.test/%252e%252e%252fsecret',
      'https://fungi.test/%2e%2e%5csecret',
      'https://fungi.test/%00secret',
      'https://fungi.test/%zz',
    ]) {
      expect(() => safeRequestPath(unsafe)).toThrow();
      try {
        const response = await harness.transport.get(unsafe);
        expect(response.status).not.toBe(200);
      } catch (error) {
        expect(error).toMatchObject({ code: 'url-path' });
      }
    }

    const escaped = await fetch(`${harness.byId.fungi.physicalOrigin}/escape.txt`);
    expect(escaped.status).toBe(403);
    expect(await escaped.text()).not.toContain('PRIVATE-SERVER-ESCAPE-CANARY');

    for (const rawPath of [
      '/%2e%2e%2findex.html',
      '/%252e%252e%252findex.html',
      '/%2e%2e%5cindex.html',
      '/%00index.html',
    ]) {
      const response = await fetch(`${harness.byId.fungi.physicalOrigin}${rawPath}`, { redirect: 'manual' });
      expect(response.status).not.toBe(200);
    }
  });
});

describe('private canary non-disclosure', () => {
  test('all private canary classes have zero hits across publications, federation views, responses, and verifier output', async () => {
    const harness = await createProducedHarness();
    const manifests = canaryManifests();
    expect(manifests).toHaveLength(5);
    expect(manifests.flatMap((manifest) => Object.values(manifest))).toHaveLength(55);
    const probes = canaryProbes(manifests);
    const surfaces = [];

    for (const base of FIXTURE_BASES) {
      const publication = harness.publications[base.id];
      for (const relative of walkRelativeFiles(publication.publicRoot)) {
        surfaces.push([`publication-path:${base.id}`, relative]);
        surfaces.push([`publication-body:${base.id}:${relative}`, readFileSync(join(publication.publicRoot, relative))]);
      }
      surfaces.push([`descriptor:${base.id}`, stableStringify(publication.descriptor)]);
      surfaces.push([`inventory:${base.id}`, stableStringify(publication.inventory)]);
      surfaces.push([`linkset:${base.id}`, stableStringify(publication.linkset)]);
    }

    const cache = new JsonCache(temporaryDirectory('canary-cache'));
    const crawl = await crawlSeeds(FIXTURE_BASES.map((base) => fixtureUrls(base).homepage), {
      transport: harness.transport,
      cache,
    });
    expect(crawl.complete).toBe(true);
    surfaces.push(['crawl', stableStringify(crawl)]);
    surfaces.push(['cache', await cache.exportBytes()]);
    surfaces.push(['search-recent', stableStringify(searchRecentOwnerRevisions(crawl.records, '', { crawlTime: FIXED_NOW }))]);
    surfaces.push(['search-cautious', stableStringify(searchCautiousEvidence(crawl.records, '', { crawlTime: FIXED_NOW }))]);

    const atlasMirror = fixtureUrls('atlas').pages.mirror;
    surfaces.push(['mirror', readFileSync(join(
      harness.publications.atlas.publicRoot,
      new URL(atlasMirror).pathname.slice(1),
    ))]);

    for (const base of FIXTURE_BASES) {
      const urls = [fixtureUrls(base).inventory, ...harness.publications[base.id].inventory.items.map((item) => item.url)];
      for (const url of urls) {
        const response = await harness.transport.get(url);
        surfaces.push([`response-headers:${url}`, JSON.stringify([...response.headers.entries()].sort())]);
        surfaces.push([`response-body:${url}`, response.body]);
      }
    }

    const verifierReport = await runFederationVerification();
    expect(verifierReport.complete).toBe(true);
    expect(verifierReport.privateCanaries).toEqual({ count: 55, hits: 0 });
    surfaces.push(['verifier-report', stableStringify(verifierReport)]);

    const hits = surfaces.flatMap(([name, value]) => scanSurface(name, value, probes));
    expect(hits).toEqual([]);
  });
});

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FIXED_NOW,
  LINKSET_EVIDENCE,
  RELATIONS,
  assertValid,
  stableJsonBytes,
  validateDescriptor,
  validateInventory,
  validateLinkset,
  verifySha256Digest,
} from '../src/contracts.js';
import {
  AUTHORED_BASE_IDS,
  AUTHORED_FIXTURE_ROOT,
  authoredJsonBytes,
  buildAuthoredPublications,
} from '../src/producer-authored.js';
import {
  PROJECTED_BASE_IDS,
  PROJECTED_FIXTURE_ROOT,
  buildProjectedPublications,
} from '../src/producer-projection.js';
import {
  FIXTURE_BASES,
  FIXTURE_BASE_BY_ID,
  FIXTURE_DESCRIPTOR_PATHS,
  FIXTURE_ORIGINS,
  fixtureUrls,
} from '../src/topology.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SPIKE_ROOT = path.resolve(TEST_DIR, '..');

let projected;
let authored;
let publications;
let publicRoots;

function walkRelativeFiles(root) {
  const files = [];
  const stack = [''];
  while (stack.length) {
    const relative = stack.pop();
    const entries = fs.readdirSync(path.join(root, relative), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) stack.push(child);
      else if (entry.isFile()) files.push(child);
    }
  }
  return files.sort();
}

function artifactUrl(base, relative) {
  return relative === 'index.html' ? fixtureUrls(base).homepage : new URL(`/${relative}`, base.logicalOrigin).href;
}

function artifactPath(root, url) {
  const parsed = new URL(url);
  return path.join(root, parsed.pathname === '/' ? 'index.html' : parsed.pathname.slice(1));
}

function readJson(root, fixturePath) {
  return JSON.parse(fs.readFileSync(path.join(root, fixturePath.replace(/^\//, '')), 'utf8'));
}

function claimsOf(linkset) {
  const claims = [];
  for (const context of linkset.linkset) {
    for (const [relation, targets] of Object.entries(context)) {
      if (relation === 'anchor') continue;
      for (const target of targets) {
        claims.push({
          subject: context.anchor,
          relation,
          target: target.href,
          issuer: target[LINKSET_EVIDENCE.issuer][0],
          assertionId: target[LINKSET_EVIDENCE.assertionId][0],
          observedAt: target[LINKSET_EVIDENCE.observedAt][0],
          sourceDigest: target[LINKSET_EVIDENCE.sourceDigest][0],
          rationale: target[LINKSET_EVIDENCE.rationale]?.[0] ?? null,
          rights: {
            mode: target['cb-rights-mode']?.[0] ?? null,
            summary: target['cb-rights-summary']?.[0] ?? null,
            license: target['cb-rights-license']?.[0] ?? null,
            source: target['cb-rights-source']?.[0] ?? null,
          },
          evidence: JSON.parse(target[LINKSET_EVIDENCE.evidence][0]),
        });
      }
    }
  }
  return claims;
}

function rootForUrl(url) {
  return publicRoots[new URL(url).origin];
}

function publicationSnapshot(root) {
  return Object.fromEntries(walkRelativeFiles(root).map((relative) => [
    relative,
    fs.readFileSync(path.join(root, relative)).toString('base64'),
  ]));
}

function allTextUnder(root) {
  return walkRelativeFiles(root)
    .map((relative) => fs.readFileSync(path.join(root, relative)).toString('utf8'))
    .join('\n');
}

function flattenStrings(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(flattenStrings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(flattenStrings);
  return [];
}

beforeAll(() => {
  projected = buildProjectedPublications();
  authored = buildAuthoredPublications({ externalEvidence: projected.observedTargets });
  publications = { ...projected.publications, ...authored.publications };
  publicRoots = Object.fromEntries(FIXTURE_BASES.map((base) => [base.logicalOrigin, publications[base.id].publicRoot]));
});

afterAll(() => {
  authored?.cleanup();
  projected?.cleanup();
});

describe('independent producer boundaries', () => {
  test('Fungi, Forage, and Atlas cross publish selection and projection boundaries', () => {
    for (const id of PROJECTED_BASE_IDS) {
      const publication = publications[id];
      expect(publication.sourceRoot).toBe(path.join(PROJECTED_FIXTURE_ROOT, id));
      expect(publication.selected.errors).toEqual([]);
      expect(publication.selected.published).toEqual(publication.memorySelection.published);
      expect(publication.projection.ok).toBe(true);
      expect(publication.boundary.ok).toBe(true);
      expect(publication.boundary.sampledTitles).toEqual([]);
      expect(publication.validation.links.broken).toEqual([]);
      expect(walkRelativeFiles(publication.publicRoot).some((relative) => relative.endsWith('.md'))).toBe(false);
      expect(publication.selected.report.denied.some((entry) => entry.path.startsWith('private/'))).toBe(true);
    }

    const fungiRefs = publications.fungi.references['species/chanterelle.md'];
    const atlasRefs = publications.atlas.references['collections/beginner-field-set.md'];
    expect(fungiRefs.embeds.map((entry) => entry.target)).toContain('/assets/chanterelle-comparison.svg');
    expect(atlasRefs.embeds.map((entry) => entry.target)).toContain('/mirrors/fungi/chanterelle-comparison.svg');
  });

  test('Toxins and Cautious use a separate authored serializer and public-only source trees', () => {
    const projectionSource = fs.readFileSync(path.join(SPIKE_ROOT, 'src/producer-projection.js'), 'utf8');
    const authoredSource = fs.readFileSync(path.join(SPIKE_ROOT, 'src/producer-authored.js'), 'utf8');
    expect(projectionSource).toContain('@cyberbaser/publish');
    expect(projectionSource).toContain('@cyberbaser/projection');
    expect(projectionSource).toContain('@cyberbaser/linkcheck');
    expect(authoredSource).not.toContain('producer-projection');
    expect(authoredSource).not.toContain('stableJsonBytes');
    expect(authoredSource).not.toContain('sha256Digest');
    expect(authoredSource).not.toContain('@cyberbaser/publish');
    expect(authoredSource).not.toContain('@cyberbaser/projection');

    const sample = { z: 1, a: { y: 2, b: 3 } };
    expect(authoredJsonBytes(sample).equals(stableJsonBytes(sample))).toBe(true);
    expect(authoredJsonBytes(sample)).not.toBe(stableJsonBytes(sample));

    for (const id of AUTHORED_BASE_IDS) {
      const publication = publications[id];
      expect(publication.sourceRoot).toBe(path.join(AUTHORED_FIXTURE_ROOT, id, 'public'));
      expect(publication.privateRoot).toBe(path.join(AUTHORED_FIXTURE_ROOT, id, 'private'));
      expect(publication.sourceRoot.startsWith(publication.privateRoot)).toBe(false);
      expect(publication.validation.links.broken).toEqual([]);
    }
  });

  test('each producer reads its own fixture root and writes only temporary outputs', () => {
    const sourceRoots = FIXTURE_BASES.map((base) => publications[base.id].sourceRoot);
    expect(new Set(sourceRoots).size).toBe(5);
    for (const base of FIXTURE_BASES) {
      const publication = publications[base.id];
      expect(publication.publicRoot.startsWith(os.tmpdir())).toBe(true);
      expect(publication.publicRoot.startsWith(publication.sourceRoot)).toBe(false);
      expect(fs.existsSync(path.join(publication.sourceRoot, base.descriptorPath.replace(/^\//, '')))).toBe(false);
    }
  });

  test('a second build has byte-identical publication trees', () => {
    const againProjected = buildProjectedPublications();
    const againAuthored = buildAuthoredPublications({ externalEvidence: againProjected.observedTargets });
    try {
      for (const id of PROJECTED_BASE_IDS) {
        expect(publicationSnapshot(againProjected.roots[id])).toEqual(publicationSnapshot(projected.roots[id]));
      }
      for (const id of AUTHORED_BASE_IDS) {
        expect(publicationSnapshot(againAuthored.roots[id])).toEqual(publicationSnapshot(authored.roots[id]));
      }
    } finally {
      againAuthored.cleanup();
      againProjected.cleanup();
    }
  });
});

describe('five-origin profile artifacts', () => {
  test('all five arbitrary descriptor paths are distinct, advertised, and valid', () => {
    expect(new Set(FIXTURE_DESCRIPTOR_PATHS).size).toBe(5);
    for (const base of FIXTURE_BASES) {
      expect(base.descriptorPath.startsWith('/.well-known/')).toBe(false);
      const root = publicRoots[base.logicalOrigin];
      const homepage = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
      expect(homepage).toContain(`rel="describedby" href="${base.descriptorPath}"`);
      const descriptor = readJson(root, base.descriptorPath);
      assertValid(`${base.id} descriptor`, validateDescriptor(descriptor, { publisher: base.logicalOrigin }));
      expect(descriptor.homepage).toBe(fixtureUrls(base).homepage);
      expect(descriptor.inventory).toBe(fixtureUrls(base).inventory);
      expect(descriptor.linksets).toEqual([...fixtureUrls(base).linksets].sort());
    }
  });

  test('each complete inventory is the exact served snapshot except itself', () => {
    for (const base of FIXTURE_BASES) {
      const root = publicRoots[base.logicalOrigin];
      const inventory = readJson(root, base.inventoryPath);
      const files = walkRelativeFiles(root);
      const servedUrls = files.map((relative) => artifactUrl(base, relative)).sort();
      const expectedItems = servedUrls.filter((url) => url !== fixtureUrls(base).inventory);
      expect(inventory.complete).toBe(true);
      expect(inventory.generatedAt).toBe(FIXED_NOW);
      expect(inventory.items.map((item) => item.url)).toEqual(expectedItems);
      assertValid(`${base.id} inventory`, validateInventory(inventory, {
        inventoryUrl: fixtureUrls(base).inventory,
        servedUrls,
        expectedTime: FIXED_NOW,
      }));

      for (const item of inventory.items) {
        const bytes = fs.readFileSync(artifactPath(root, item.url));
        expect(item.byteLength).toBe(bytes.byteLength);
        expect(verifySha256Digest(bytes, item.digest)).toBe(true);
      }
    }
  });

  test('every Linkset uses RFC 9264 shape and verifiable source-qualified evidence', () => {
    for (const base of FIXTURE_BASES) {
      const root = publicRoots[base.logicalOrigin];
      const linkset = readJson(root, base.linksetPaths[0]);
      expect(Object.keys(linkset)).toEqual(['linkset']);
      assertValid(`${base.id} Linkset`, validateLinkset(linkset, {
        publisher: base.logicalOrigin,
        allowedOrigins: FIXTURE_ORIGINS,
        expectedTime: FIXED_NOW,
      }));

      for (const claim of claimsOf(linkset)) {
        expect(claim.issuer).toBe(base.logicalOrigin);
        expect(new URL(claim.assertionId).origin).toBe(base.logicalOrigin);
        expect(claim.observedAt).toBe(FIXED_NOW);
        expect(claim.rights.mode).not.toBeNull();
        expect(claim.rights.summary).not.toBeNull();
        expect(Object.hasOwn(claim.evidence, 'targetRevision')).toBe(true);
        expect(Object.hasOwn(claim.evidence, 'targetDigest')).toBe(true);
        const sourceRoot = rootForUrl(claim.evidence.sourceUrl);
        const sourceBytes = fs.readFileSync(artifactPath(sourceRoot, claim.evidence.sourceUrl));
        expect(verifySha256Digest(sourceBytes, claim.sourceDigest)).toBe(true);
        if (claim.evidence.targetDigest !== null) {
          const targetRoot = rootForUrl(claim.target);
          const targetBytes = fs.readFileSync(artifactPath(targetRoot, claim.target));
          expect(verifySha256Digest(targetBytes, claim.evidence.targetDigest)).toBe(true);
          expect(claim.evidence.targetRevision).not.toBeNull();
        }
      }
    }
  });
});

describe('federation disagreement, cycles, rights, and direct links', () => {
  test('Atlas exact and Cautious close mappings preserve the same endpoints as distinct claims', () => {
    const atlasClaims = claimsOf(publications.atlas.linkset);
    const cautiousClaims = claimsOf(publications.cautious.linkset);
    const exact = atlasClaims.find((claim) => claim.relation === RELATIONS.exactMatch);
    const close = cautiousClaims.find((claim) => claim.relation === RELATIONS.closeMatch);
    expect(exact).toBeDefined();
    expect(close).toBeDefined();
    expect(exact.subject).toBe(fixtureUrls('fungi').pages.primary);
    expect(exact.target).toBe(fixtureUrls('forage').pages.primary);
    expect(close.subject).toBe(exact.subject);
    expect(close.target).toBe(exact.target);
    expect(exact.issuer).toBe(FIXTURE_BASE_BY_ID.atlas.logicalOrigin);
    expect(close.issuer).toBe(FIXTURE_BASE_BY_ID.cautious.logicalOrigin);
    expect(exact.assertionId).not.toBe(close.assertionId);
    expect(exact.rationale).toContain('exactly equivalent');
    expect(close.rationale).toContain('declines Atlas');
    expect(exact.evidence.targetDigest).not.toBeNull();
    expect(close.evidence.targetDigest).not.toBeNull();
  });

  test('Atlas and Cautious form a bounded source-qualified recursion cycle', () => {
    const atlasCycle = claimsOf(publications.atlas.linkset).find((claim) => claim.target === fixtureUrls('cautious').pages.primary);
    const cautiousCycle = claimsOf(publications.cautious.linkset).find((claim) => claim.target === fixtureUrls('atlas').pages.primary);
    expect(atlasCycle.relation).toBe(RELATIONS.related);
    expect(cautiousCycle.relation).toBe(RELATIONS.related);
    expect(atlasCycle.issuer).toBe('https://atlas.test');
    expect(cautiousCycle.issuer).toBe('https://cautious.test');
  });

  test('Atlas mirrors the licensed Fungi asset byte-for-byte without gaining owner authority', () => {
    const fungiUrl = fixtureUrls('fungi').pages.mirrorSource;
    const atlasUrl = fixtureUrls('atlas').pages.mirror;
    const fungiBytes = fs.readFileSync(artifactPath(publicRoots['https://fungi.test'], fungiUrl));
    const atlasBytes = fs.readFileSync(artifactPath(publicRoots['https://atlas.test'], atlasUrl));
    expect(atlasBytes.equals(fungiBytes)).toBe(true);

    const mirrorItem = publications.atlas.inventory.items.find((item) => item.url === atlasUrl);
    expect(mirrorItem.rights.mode).toBe('licensed-reuse');
    expect(mirrorItem.rights.source).toBe(fungiUrl);
    expect(mirrorItem.rights.license).toBe('https://creativecommons.org/licenses/by/4.0/');
    const mirrorClaim = claimsOf(publications.atlas.linkset).find((claim) => claim.relation === RELATIONS.mirror);
    expect(mirrorClaim.target).toBe(fungiUrl);
    expect(mirrorClaim.issuer).toBe('https://atlas.test');
    expect(mirrorClaim.rights).toMatchObject({
      mode: 'licensed-reuse',
      license: 'https://creativecommons.org/licenses/by/4.0/',
      source: fungiUrl,
    });
    expect(mirrorClaim.rationale).toContain('FungiWiki remains the owner authority');
  });

  test('Toxins is explicit link-only content and is not mirrored elsewhere', () => {
    const toxins = publications.toxins;
    expect(toxins.descriptor.policies.rights.mode).toBe('link-only');
    expect(toxins.inventory.items.every((item) => item.rights.mode === 'link-only')).toBe(true);
    const marker = 'This body is link-only fixture content.';
    const hits = FIXTURE_BASES.filter((base) => allTextUnder(publicRoots[base.logicalOrigin]).includes(marker));
    expect(hits.map((base) => base.id)).toEqual(['toxins']);
    expect(claimsOf(toxins.linkset).every((claim) => claim.rationale.includes('Link-only'))).toBe(true);
    expect(claimsOf(toxins.linkset).every((claim) => claim.rights.mode === 'link-only')).toBe(true);
  });

  test('meta-wiki pages retain direct owner URLs independently of federation JSON', () => {
    const fungi = fixtureUrls('fungi').pages.primary;
    const forage = fixtureUrls('forage').pages.primary;
    const atlasHtml = fs.readFileSync(artifactPath(publicRoots['https://atlas.test'], fixtureUrls('atlas').pages.primary), 'utf8');
    const cautiousHtml = fs.readFileSync(artifactPath(publicRoots['https://cautious.test'], fixtureUrls('cautious').pages.primary), 'utf8');
    for (const html of [atlasHtml, cautiousHtml]) {
      expect(html).toContain(`href="${fungi}"`);
      expect(html).toContain(`href="${forage}"`);
    }
    expect(atlasHtml).toContain(`href="${fixtureUrls('cautious').pages.primary}"`);
    expect(cautiousHtml).toContain(`href="${fixtureUrls('atlas').pages.primary}"`);
  });
});

describe('private canaries', () => {
  test('title, path, body, asset, backlink, tag, collection, encoded, Base64, slug, and digest canaries never enter generated trees', () => {
    const manifests = [
      ...PROJECTED_BASE_IDS.map((id) => JSON.parse(fs.readFileSync(path.join(PROJECTED_FIXTURE_ROOT, id, 'private/canaries.json'), 'utf8'))),
      ...AUTHORED_BASE_IDS.map((id) => JSON.parse(fs.readFileSync(path.join(AUTHORED_FIXTURE_ROOT, id, 'private/canaries.json'), 'utf8'))),
    ];
    for (const manifest of manifests) {
      expect(Object.keys(manifest).sort()).toEqual([
        'asset', 'backlink', 'base64', 'body', 'collection', 'digest', 'encoded', 'path', 'slugged', 'tag', 'title',
      ]);
    }

    const generatedRoots = [projected.root, authored.root];
    const generatedText = generatedRoots.map(allTextUnder).join('\n');
    const generatedPaths = generatedRoots.flatMap(walkRelativeFiles).join('\n');
    for (const canary of manifests.flatMap(flattenStrings)) {
      expect(generatedText.includes(canary)).toBe(false);
      expect(generatedPaths.includes(canary)).toBe(false);
    }
  });
});

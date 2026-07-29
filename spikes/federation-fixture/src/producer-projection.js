import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSite } from '@cyberbaser/linkcheck';
import { project, verifyProjection } from '@cyberbaser/projection';
import { extractRefs, select, selectFiles } from '@cyberbaser/publish';
import {
  FIXED_CLOCK,
  FIXTURE_PROFILE_URN,
  LINKSET_EVIDENCE,
  RELATIONS,
  assertValid,
  sha256Digest,
  stableJsonBytes,
  validateDescriptor,
  validateInventory,
  validateLinkset,
  verifySha256Digest,
} from './contracts.js';
import {
  FIXTURE_BASE_BY_ID,
  FIXTURE_ORIGINS,
  fixtureUrls,
  logicalUrl,
} from './topology.js';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PROJECTED_FIXTURE_ROOT = path.resolve(MODULE_DIR, '../fixtures/projected');
export const PROJECTED_BASE_IDS = Object.freeze(['fungi', 'forage', 'atlas']);

const PROJECTED_SPECS = Object.freeze({
  fungi: Object.freeze({
    allow: Object.freeze(['index.md', 'species']),
    revisions: Object.freeze({
      primary: 'fungi-chanterelle-r1',
      secondary: 'fungi-false-chanterelle-r1',
      mirrorSource: 'fungi-comparison-r1',
    }),
  }),
  forage: Object.freeze({
    allow: Object.freeze(['index.md', 'guides', 'regions']),
    revisions: Object.freeze({
      primary: 'forage-chanterelle-r3',
      secondary: 'forage-coastal-r2',
    }),
  }),
  atlas: Object.freeze({
    allow: Object.freeze(['index.md', 'collections']),
    revisions: Object.freeze({
      primary: 'atlas-field-set-r4',
      mirror: 'atlas-mirror-r1',
    }),
  }),
});

function ensureDir(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

function writeBytes(root, fixturePath, bytes) {
  const destination = path.join(root, fixturePath.replace(/^\/+/, ''));
  ensureDir(path.dirname(destination));
  fs.writeFileSync(destination, bytes);
  return destination;
}

function walkRelativeFiles(root) {
  const files = [];
  const stack = [''];
  while (stack.length) {
    const relative = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(path.join(root, relative), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) stack.push(child);
      else if (entry.isFile()) files.push(child);
    }
  }
  return files.sort();
}

function fixtureFileMap(sourceRoot) {
  const files = {};
  for (const relative of walkRelativeFiles(sourceRoot)) {
    if (relative === 'publish.yml') continue;
    files[relative] = /\.md$/i.test(relative)
      ? fs.readFileSync(path.join(sourceRoot, relative), 'utf8')
      : null;
  }
  return files;
}

function assertSelectionParity(id, sourceRoot, selected) {
  const memorySelection = selectFiles(
    fixtureFileMap(sourceRoot),
    { allow: [...PROJECTED_SPECS[id].allow] },
    { audience: 'public' },
  );
  if (memorySelection.errors.length || selected.errors.length) {
    throw new Error(`${id} publish selection failed closed: ${JSON.stringify({ disk: selected.errors, memory: memorySelection.errors })}`);
  }
  if (JSON.stringify(memorySelection.published) !== JSON.stringify(selected.published)) {
    throw new Error(`${id} select() and selectFiles() disagree`);
  }
  return memorySelection;
}

const FRONTMATTER = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function markdownTitle(markdown, fallback) {
  const match = markdown.match(FRONTMATTER);
  if (!match) return fallback;
  const title = match[1].match(/^title\s*:\s*(.+?)\s*$/m)?.[1];
  return title ? title.replace(/^['"]|['"]$/g, '') : fallback;
}

function renderFixtureMarkdown(markdown, base, relativePath) {
  const title = markdownTitle(markdown, relativePath.replace(/\.md$/i, ''));
  const body = markdown.replace(FRONTMATTER, '').trim();
  const renderedBody = body.replace(/!\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, (_match, rawTarget) => {
    const target = rawTarget.startsWith('/') ? rawTarget : `/${rawTarget.replace(/^\/+/, '')}`;
    return `<img src="${escapeHtml(target)}" alt="Fixture publication asset">`;
  });
  const linkset = base.linksetPaths[0];
  return Buffer.from([
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="utf-8">',
    `  <title>${escapeHtml(title)}</title>`,
    `  <link rel="describedby" href="${escapeHtml(base.descriptorPath)}">`,
    `  <link rel="alternate" type="application/linkset+json" href="${escapeHtml(linkset)}">`,
    '</head>',
    '<body>',
    renderedBody,
    '</body>',
    '</html>',
    '',
  ].join('\n'), 'utf8');
}

function renderProjection(projectionRoot, publicRoot, base) {
  fs.rmSync(publicRoot, { recursive: true, force: true });
  ensureDir(publicRoot);
  for (const relative of walkRelativeFiles(projectionRoot)) {
    const source = path.join(projectionRoot, relative);
    if (/\.md$/i.test(relative)) {
      const destination = relative === 'index.md'
        ? 'index.html'
        : relative.replace(/\.md$/i, '.html');
      writeBytes(publicRoot, destination, renderFixtureMarkdown(fs.readFileSync(source, 'utf8'), base, relative));
    } else {
      const destination = path.join(publicRoot, relative);
      ensureDir(path.dirname(destination));
      fs.copyFileSync(source, destination);
    }
  }
}

function artifactUrl(base, relative) {
  return relative === 'index.html' ? fixtureUrls(base).homepage : logicalUrl(base, `/${relative}`);
}

function mediaTypeFor(relative, base) {
  const fixturePath = `/${relative}`;
  if (base.linksetPaths.includes(fixturePath)) return 'application/linkset+json';
  if (relative.endsWith('.json')) return 'application/json';
  if (relative.endsWith('.html')) return 'text/html; charset=utf-8';
  if (relative.endsWith('.svg')) return 'image/svg+xml';
  if (relative.endsWith('.txt')) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

function ownerRights(base) {
  return {
    mode: 'owner-published',
    summary: `${base.label} publishes this fixture artifact under its own authority.`,
  };
}

function licensedComparisonRights(sourceUrl) {
  return {
    mode: 'licensed-reuse',
    summary: 'Fixture comparison image reused under CC BY 4.0 with source-qualified provenance.',
    license: 'https://creativecommons.org/licenses/by/4.0/',
    source: sourceUrl,
    attribution: 'FungiWiki fixture illustration',
  };
}

function rightsForArtifact(base, relative) {
  if (base.id === 'fungi' && relative === base.pages.mirrorSource.replace(/^\//, '')) {
    return licensedComparisonRights(logicalUrl('fungi', base.pages.mirrorSource));
  }
  if (base.id === 'atlas' && relative === base.pages.mirror.replace(/^\//, '')) {
    return licensedComparisonRights(logicalUrl('fungi', FIXTURE_BASE_BY_ID.fungi.pages.mirrorSource));
  }
  return ownerRights(base);
}

function evidenceForBytes(url, bytes, revision = null, mediaType = null) {
  return Object.freeze({
    url,
    revision,
    digest: sha256Digest(bytes),
    byteLength: bytes.byteLength,
    mediaType,
  });
}

function evidenceAt(publicRoot, url, revision = null, base = null) {
  const parsed = new URL(url);
  const relative = parsed.pathname === '/' ? 'index.html' : parsed.pathname.slice(1);
  const bytes = fs.readFileSync(path.join(publicRoot, relative));
  return evidenceForBytes(url, bytes, revision, base ? mediaTypeFor(relative, base) : null);
}

function evidenceTarget({
  issuer,
  assertionId,
  href,
  source,
  target,
  rationale = null,
  rights = null,
}) {
  const assertionRights = rights ?? {
    mode: 'owner-published',
    summary: `${issuer} publishes this fixture assertion under its own authority.`,
  };
  const result = {
    href,
    [LINKSET_EVIDENCE.issuer]: [issuer],
    [LINKSET_EVIDENCE.assertionId]: [assertionId],
    [LINKSET_EVIDENCE.observedAt]: [source.observedAt],
    [LINKSET_EVIDENCE.sourceDigest]: [source.digest],
    [LINKSET_EVIDENCE.evidence]: [JSON.stringify({
      sourceUrl: source.url,
      targetDigest: target?.digest ?? null,
      targetRevision: target?.revision ?? null,
    })],
    'cb-rights-mode': [assertionRights.mode],
    'cb-rights-summary': [assertionRights.summary],
  };
  if (assertionRights.license) result['cb-rights-license'] = [assertionRights.license];
  if (assertionRights.source) result['cb-rights-source'] = [assertionRights.source];
  if (rationale) result[LINKSET_EVIDENCE.rationale] = [rationale];
  return result;
}

function sortTargets(targets) {
  return targets.sort((left, right) => {
    const href = left.href.localeCompare(right.href);
    if (href) return href;
    return left[LINKSET_EVIDENCE.assertionId][0].localeCompare(right[LINKSET_EVIDENCE.assertionId][0]);
  });
}

function makeContext(anchor, relations) {
  const context = { anchor };
  for (const relation of Object.keys(relations).sort()) context[relation] = sortTargets(relations[relation]);
  return context;
}

function observed(externalEvidence, url) {
  return externalEvidence[url] ?? null;
}

function sourceEvidence(publicRoot, base, url, revision, observedAt) {
  return {
    ...evidenceAt(publicRoot, url, revision, base),
    observedAt,
  };
}

function buildLinksetValue(id, publicRoot, externalEvidence, now) {
  const base = FIXTURE_BASE_BY_ID[id];
  const urls = fixtureUrls(base);
  const linksetUrl = urls.linksets[0];
  const assertionId = (name) => `${linksetUrl}#${name}`;

  if (id === 'fungi') {
    const source = sourceEvidence(publicRoot, base, urls.pages.primary, PROJECTED_SPECS.fungi.revisions.primary, now);
    return {
      linkset: [makeContext(urls.pages.primary, {
        [RELATIONS.related]: [
          evidenceTarget({ issuer: base.logicalOrigin, assertionId: assertionId('forage-guide'), href: fixtureUrls('forage').pages.primary, source, target: observed(externalEvidence, fixtureUrls('forage').pages.primary) }),
          evidenceTarget({ issuer: base.logicalOrigin, assertionId: assertionId('toxins-safety'), href: fixtureUrls('toxins').pages.primary, source, target: observed(externalEvidence, fixtureUrls('toxins').pages.primary) }),
        ],
      })],
    };
  }

  if (id === 'forage') {
    const source = sourceEvidence(publicRoot, base, urls.pages.primary, PROJECTED_SPECS.forage.revisions.primary, now);
    return {
      linkset: [makeContext(urls.pages.primary, {
        [RELATIONS.related]: [
          evidenceTarget({ issuer: base.logicalOrigin, assertionId: assertionId('cautious-annotation'), href: fixtureUrls('cautious').pages.annotation, source, target: observed(externalEvidence, fixtureUrls('cautious').pages.annotation) }),
          evidenceTarget({ issuer: base.logicalOrigin, assertionId: assertionId('fungi-species'), href: fixtureUrls('fungi').pages.primary, source, target: observed(externalEvidence, fixtureUrls('fungi').pages.primary) }),
        ],
      })],
    };
  }

  const primarySource = sourceEvidence(publicRoot, base, urls.pages.primary, PROJECTED_SPECS.atlas.revisions.primary, now);
  const mirrorSource = sourceEvidence(publicRoot, base, urls.pages.mirror, PROJECTED_SPECS.atlas.revisions.mirror, now);
  const fungiPrimary = fixtureUrls('fungi').pages.primary;
  const foragePrimary = fixtureUrls('forage').pages.primary;
  const fungiAsset = fixtureUrls('fungi').pages.mirrorSource;
  const cautiousPrimary = fixtureUrls('cautious').pages.primary;

  return {
    linkset: [
      makeContext(urls.pages.primary, {
        [RELATIONS.collection]: [evidenceTarget({ issuer: base.logicalOrigin, assertionId: assertionId('collection-fungi'), href: fungiPrimary, source: primarySource, target: observed(externalEvidence, fungiPrimary) })],
        [RELATIONS.related]: [evidenceTarget({ issuer: base.logicalOrigin, assertionId: assertionId('cycle-cautious'), href: cautiousPrimary, source: primarySource, target: observed(externalEvidence, cautiousPrimary), rationale: 'Atlas links to the competing Cautious collection without treating it as authority.' })],
      }),
      makeContext(urls.pages.mirror, {
        [RELATIONS.mirror]: [evidenceTarget({
          issuer: base.logicalOrigin,
          assertionId: assertionId('licensed-fungi-mirror'),
          href: fungiAsset,
          source: mirrorSource,
          target: observed(externalEvidence, fungiAsset),
          rationale: 'Licensed byte-identical mirror; FungiWiki remains the owner authority.',
          rights: licensedComparisonRights(fungiAsset),
        })],
      }),
      makeContext(fungiPrimary, {
        [RELATIONS.exactMatch]: [evidenceTarget({ issuer: base.logicalOrigin, assertionId: assertionId('exact-chanterelle'), href: foragePrimary, source: primarySource, target: observed(externalEvidence, foragePrimary), rationale: 'Atlas treats these two fixture concepts as exactly equivalent for its beginner collection.' })],
      }),
    ].sort((left, right) => left.anchor.localeCompare(right.anchor)),
  };
}

function descriptorValue(base) {
  const urls = fixtureUrls(base);
  return {
    profile: FIXTURE_PROFILE_URN,
    publisher: base.logicalOrigin,
    homepage: urls.homepage,
    inventory: urls.inventory,
    linksets: [...urls.linksets].sort(),
    policies: {
      rights: ownerRights(base),
      history: {
        mode: 'snapshot-only',
        summary: 'This fixture publishes one complete deterministic snapshot and no durable change feed.',
      },
    },
    capabilities: [...base.capabilities],
  };
}

function inventoryValue(base, publicRoot, now) {
  const urls = fixtureUrls(base);
  const inventoryRelative = base.inventoryPath.replace(/^\//, '');
  const items = walkRelativeFiles(publicRoot)
    .filter((relative) => relative !== inventoryRelative)
    .map((relative) => {
      const bytes = fs.readFileSync(path.join(publicRoot, relative));
      return {
        url: artifactUrl(base, relative),
        byteLength: bytes.byteLength,
        digest: sha256Digest(bytes),
        mediaType: mediaTypeFor(relative, base),
        rights: rightsForArtifact(base, relative),
      };
    })
    .sort((left, right) => left.url.localeCompare(right.url));
  return {
    profile: FIXTURE_PROFILE_URN,
    publisher: base.logicalOrigin,
    inventory: urls.inventory,
    generatedAt: now,
    complete: true,
    items,
  };
}

function validatePublication(base, publicRoot, descriptor, inventory, linkset, now) {
  const urls = fixtureUrls(base);
  const servedUrls = walkRelativeFiles(publicRoot).map((relative) => artifactUrl(base, relative));
  assertValid(`${base.id} descriptor`, validateDescriptor(descriptor, { publisher: base.logicalOrigin }));
  assertValid(`${base.id} inventory`, validateInventory(inventory, {
    inventoryUrl: urls.inventory,
    servedUrls,
    expectedTime: now,
  }));
  assertValid(`${base.id} Linkset`, validateLinkset(linkset, {
    publisher: base.logicalOrigin,
    allowedOrigins: FIXTURE_ORIGINS,
    expectedTime: now,
  }));

  for (const item of inventory.items) {
    const parsed = new URL(item.url);
    const relative = parsed.pathname === '/' ? 'index.html' : parsed.pathname.slice(1);
    const bytes = fs.readFileSync(path.join(publicRoot, relative));
    if (bytes.byteLength !== item.byteLength || !verifySha256Digest(bytes, item.digest)) {
      throw new Error(`${base.id} inventory evidence does not match ${item.url}`);
    }
  }

  const links = checkSite(publicRoot);
  if (links.broken.length) throw new Error(`${base.id} same-origin static link check failed: ${JSON.stringify(links.broken)}`);
  return { servedUrls: servedUrls.sort(), links };
}

function collectObservedTargets(base, publicRoot, revisions) {
  const result = {};
  for (const relative of walkRelativeFiles(publicRoot)) {
    const url = artifactUrl(base, relative);
    const pageEntry = Object.entries(base.pages).find(([, fixturePath]) => fixturePath.replace(/^\//, '') === relative);
    const revision = pageEntry ? revisions[pageEntry[0]] ?? null : null;
    result[url] = evidenceAt(publicRoot, url, revision, base);
  }
  return result;
}

function buildProjectedAt(id, buildRoot, { clock, externalEvidence }) {
  if (!PROJECTED_BASE_IDS.includes(id)) throw new TypeError(`unknown projected fixture base ${id}`);
  const base = FIXTURE_BASE_BY_ID[id];
  const sourceRoot = path.join(PROJECTED_FIXTURE_ROOT, id);
  const projectionRoot = path.join(buildRoot, 'projection');
  const publicRoot = path.join(buildRoot, 'public');
  fs.rmSync(buildRoot, { recursive: true, force: true });
  ensureDir(buildRoot);

  const selected = select(sourceRoot, { audience: 'public' });
  const memorySelection = assertSelectionParity(id, sourceRoot, selected);
  const references = Object.fromEntries(selected.report.published.pages.map((relative) => [
    relative,
    extractRefs(fs.readFileSync(path.join(sourceRoot, relative), 'utf8')),
  ]));

  const projection = project(sourceRoot, projectionRoot, {
    selectResult: selected,
    lowercase: false,
    verify: true,
    sampleSize: 0,
    writeReport: false,
  });
  if (!projection.ok) throw new Error(`${id} projection failed: ${JSON.stringify(projection.failures)}`);
  const boundary = verifyProjection(sourceRoot, projectionRoot, selected, { lowercase: false, sampleSize: 0 });
  if (!boundary.ok) throw new Error(`${id} projection boundary failed: ${JSON.stringify(boundary)}`);

  renderProjection(projectionRoot, publicRoot, base);
  const now = clock.now();
  const linkset = buildLinksetValue(id, publicRoot, externalEvidence, now);
  writeBytes(publicRoot, base.linksetPaths[0], stableJsonBytes(linkset));
  const descriptor = descriptorValue(base);
  writeBytes(publicRoot, base.descriptorPath, stableJsonBytes(descriptor));
  const inventory = inventoryValue(base, publicRoot, now);
  writeBytes(publicRoot, base.inventoryPath, stableJsonBytes(inventory));
  const validation = validatePublication(base, publicRoot, descriptor, inventory, linkset, now);
  const observedTargets = collectObservedTargets(base, publicRoot, PROJECTED_SPECS[id].revisions);

  return Object.freeze({
    id,
    base,
    sourceRoot,
    buildRoot,
    projectionRoot,
    publicRoot,
    descriptor,
    inventory,
    linkset,
    selected,
    memorySelection,
    projection,
    boundary,
    references,
    validation,
    observedTargets: Object.freeze(observedTargets),
  });
}

function temporaryRoot(prefix, outputRoot) {
  if (outputRoot) {
    const resolved = path.resolve(outputRoot);
    ensureDir(resolved);
    return { root: resolved, owned: false };
  }
  return { root: fs.mkdtempSync(path.join(os.tmpdir(), prefix)), owned: true };
}

export function buildProjectedBase(id, options = {}) {
  const temporary = temporaryRoot(`cb-federation-${id}-`, options.outputRoot);
  const publication = buildProjectedAt(id, path.join(temporary.root, id), {
    clock: options.clock ?? FIXED_CLOCK,
    externalEvidence: options.externalEvidence ?? {},
  });
  return Object.freeze({
    ...publication,
    root: temporary.root,
    cleanup: () => {
      if (temporary.owned) fs.rmSync(temporary.root, { recursive: true, force: true });
    },
  });
}

export function buildProjectedPublications(options = {}) {
  const temporary = temporaryRoot('cb-federation-projected-', options.outputRoot);
  const clock = options.clock ?? FIXED_CLOCK;
  const publications = {};
  const observedTargets = { ...(options.externalEvidence ?? {}) };
  try {
    for (const id of PROJECTED_BASE_IDS) {
      const publication = buildProjectedAt(id, path.join(temporary.root, id), {
        clock,
        externalEvidence: observedTargets,
      });
      publications[id] = publication;
      Object.assign(observedTargets, publication.observedTargets);
    }
  } catch (error) {
    if (temporary.owned) fs.rmSync(temporary.root, { recursive: true, force: true });
    throw error;
  }

  return Object.freeze({
    root: temporary.root,
    roots: Object.freeze(Object.fromEntries(PROJECTED_BASE_IDS.map((id) => [id, publications[id].publicRoot]))),
    publications: Object.freeze(publications),
    observedTargets: Object.freeze(observedTargets),
    cleanup: () => {
      if (temporary.owned) fs.rmSync(temporary.root, { recursive: true, force: true });
    },
  });
}

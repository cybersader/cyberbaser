import { createHash, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSite } from '@cyberbaser/linkcheck';
import {
  FIXED_CLOCK,
  FIXTURE_PROFILE_URN,
  LINKSET_EVIDENCE,
  RELATIONS,
  assertValid,
  validateDescriptor,
  validateInventory,
  validateLinkset,
} from './contracts.js';
import {
  FIXTURE_BASE_BY_ID,
  FIXTURE_ORIGINS,
  fixtureUrls,
  logicalUrl,
} from './topology.js';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const AUTHORED_FIXTURE_ROOT = path.resolve(MODULE_DIR, '../fixtures/authored');
export const AUTHORED_BASE_IDS = Object.freeze(['toxins', 'cautious']);

const AUTHORED_REVISIONS = Object.freeze({
  toxins: Object.freeze({
    primary: 'toxins-false-chanterelle-r2',
    secondary: 'toxins-response-r1',
  }),
  cautious: Object.freeze({
    primary: 'cautious-field-set-r5',
    annotation: 'cautious-annotation-r2',
  }),
});

function authoredCanonical(value, at = '$', seen = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${at} contains a non-finite number`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object') throw new TypeError(`${at} contains unsupported ${typeof value}`);
  if (seen.has(value)) throw new TypeError(`${at} contains a cycle`);
  seen.add(value);
  if (Array.isArray(value)) {
    const entries = value.map((entry, index) => authoredCanonical(entry, `${at}[${index}]`, seen));
    seen.delete(value);
    return entries;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${at} must contain plain objects`);
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) throw new TypeError(`${at}.${key} is undefined`);
    result[key] = authoredCanonical(value[key], `${at}.${key}`, seen);
  }
  seen.delete(value);
  return result;
}

/** Deliberately separate from Producer A's serializer. */
export function authoredJsonBytes(value) {
  return Buffer.from(`${JSON.stringify(authoredCanonical(value), null, 2)}\n`, 'utf8');
}

function authoredDigest(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return `sha-256=:${createHash('sha256').update(bytes).digest('base64')}:`;
}

function verifyAuthoredDigest(value, expected) {
  const match = typeof expected === 'string' ? expected.match(/^sha-256=:([A-Za-z0-9+/]{43}=):$/) : null;
  if (!match) return false;
  const wanted = Buffer.from(match[1], 'base64');
  const actual = createHash('sha256').update(value).digest();
  return wanted.length === actual.length && timingSafeEqual(wanted, actual);
}

function ensureDir(directory) {
  fs.mkdirSync(directory, { recursive: true });
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

function copyPublicTree(sourceRoot, publicRoot) {
  fs.rmSync(publicRoot, { recursive: true, force: true });
  ensureDir(publicRoot);
  for (const relative of walkRelativeFiles(sourceRoot)) {
    const source = path.join(sourceRoot, relative);
    const destination = path.join(publicRoot, relative);
    ensureDir(path.dirname(destination));
    fs.copyFileSync(source, destination);
  }
}

function writeAuthored(root, fixturePath, value) {
  const destination = path.join(root, fixturePath.replace(/^\/+/, ''));
  ensureDir(path.dirname(destination));
  fs.writeFileSync(destination, authoredJsonBytes(value));
}

function artifactUrl(base, relative) {
  return relative === 'index.html' ? fixtureUrls(base).homepage : logicalUrl(base, `/${relative}`);
}

function mediaTypeFor(relative, base) {
  const fixturePath = `/${relative}`;
  if (base.linksetPaths.includes(fixturePath)) return 'application/linkset+json';
  if (relative.endsWith('.json')) return 'application/json';
  if (relative.endsWith('.html')) return 'text/html; charset=utf-8';
  return 'application/octet-stream';
}

function rightsForBase(base) {
  if (base.id === 'toxins') {
    return {
      mode: 'link-only',
      summary: 'Link-only fixture content: retain metadata and the direct owner URL, never copy the body for republication.',
    };
  }
  return {
    mode: 'owner-published',
    summary: `${base.label} publishes this fixture artifact under its own authority.`,
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
      rights: rightsForBase(base),
      history: {
        mode: 'snapshot-only',
        summary: 'This independently authored fixture exposes one deterministic snapshot and no durable change feed.',
      },
    },
    capabilities: [...base.capabilities],
  };
}

function evidenceAt(publicRoot, base, url, revision = null) {
  const parsed = new URL(url);
  const relative = parsed.pathname === '/' ? 'index.html' : parsed.pathname.slice(1);
  const bytes = fs.readFileSync(path.join(publicRoot, relative));
  return {
    url,
    revision,
    digest: authoredDigest(bytes),
    byteLength: bytes.byteLength,
    mediaType: mediaTypeFor(relative, base),
  };
}

function targetEvidence({
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
  const value = {
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
  if (assertionRights.license) value['cb-rights-license'] = [assertionRights.license];
  if (assertionRights.source) value['cb-rights-source'] = [assertionRights.source];
  if (rationale) value[LINKSET_EVIDENCE.rationale] = [rationale];
  return value;
}

function makeContext(anchor, relations) {
  const context = { anchor };
  for (const relation of Object.keys(relations).sort()) {
    context[relation] = relations[relation].sort((left, right) => {
      const href = left.href.localeCompare(right.href);
      if (href) return href;
      return left[LINKSET_EVIDENCE.assertionId][0].localeCompare(right[LINKSET_EVIDENCE.assertionId][0]);
    });
  }
  return context;
}

function observed(externalEvidence, url) {
  return externalEvidence[url] ?? null;
}

function sourceEvidence(publicRoot, base, url, revision, observedAt) {
  return { ...evidenceAt(publicRoot, base, url, revision), observedAt };
}

function authoredLinkset(id, publicRoot, externalEvidence, now) {
  const base = FIXTURE_BASE_BY_ID[id];
  const urls = fixtureUrls(base);
  const linksetUrl = urls.linksets[0];
  const assertionId = (name) => `${linksetUrl}#${name}`;

  if (id === 'toxins') {
    const source = sourceEvidence(publicRoot, base, urls.pages.primary, AUTHORED_REVISIONS.toxins.primary, now);
    const fungiFalse = fixtureUrls('fungi').pages.secondary;
    const foragePrimary = fixtureUrls('forage').pages.primary;
    return {
      linkset: [makeContext(urls.pages.primary, {
        [RELATIONS.related]: [
          targetEvidence({ issuer: base.logicalOrigin, assertionId: assertionId('forage-field-guide'), href: foragePrimary, source, target: observed(externalEvidence, foragePrimary), rationale: 'Link-only comparison target; ToxinNotes grants no republication right.', rights: rightsForBase(base) }),
          targetEvidence({ issuer: base.logicalOrigin, assertionId: assertionId('fungi-owner-comparison'), href: fungiFalse, source, target: observed(externalEvidence, fungiFalse), rationale: 'Link-only comparison target; the owner page remains authoritative.', rights: rightsForBase(base) }),
        ],
      })],
    };
  }

  const primarySource = sourceEvidence(publicRoot, base, urls.pages.primary, AUTHORED_REVISIONS.cautious.primary, now);
  const annotationSource = sourceEvidence(publicRoot, base, urls.pages.annotation, AUTHORED_REVISIONS.cautious.annotation, now);
  const fungiPrimary = fixtureUrls('fungi').pages.primary;
  const foragePrimary = fixtureUrls('forage').pages.primary;
  const atlasPrimary = fixtureUrls('atlas').pages.primary;

  return {
    linkset: [
      makeContext(urls.pages.primary, {
        [RELATIONS.annotation]: [targetEvidence({ issuer: base.logicalOrigin, assertionId: assertionId('regional-annotation'), href: urls.pages.annotation, source: primarySource, target: { ...annotationSource }, rationale: 'The annotation explains why Cautious publishes a close match instead of Atlas\'s exact match.' })],
        [RELATIONS.related]: [targetEvidence({ issuer: base.logicalOrigin, assertionId: assertionId('cycle-atlas'), href: atlasPrimary, source: primarySource, target: observed(externalEvidence, atlasPrimary), rationale: 'Cautious links to the competing Atlas collection without adopting its exact mapping.' })],
      }),
      makeContext(urls.pages.annotation, {
        [RELATIONS.related]: [targetEvidence({ issuer: base.logicalOrigin, assertionId: assertionId('annotation-fungi-owner'), href: fungiPrimary, source: annotationSource, target: observed(externalEvidence, fungiPrimary), rationale: 'The annotation points back to the subject owner rather than replacing it.' })],
      }),
      makeContext(fungiPrimary, {
        [RELATIONS.closeMatch]: [targetEvidence({ issuer: base.logicalOrigin, assertionId: assertionId('close-chanterelle'), href: foragePrimary, source: primarySource, target: observed(externalEvidence, foragePrimary), rationale: 'Regional taxonomy, naming, and evidence thresholds can diverge, so Cautious declines Atlas\'s exact-equivalence claim.' })],
      }),
    ].sort((left, right) => left.anchor.localeCompare(right.anchor)),
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
        digest: authoredDigest(bytes),
        mediaType: mediaTypeFor(relative, base),
        rights: rightsForBase(base),
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

function validateAuthoredPublication(base, publicRoot, descriptor, inventory, linkset, now) {
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
    if (bytes.byteLength !== item.byteLength || !verifyAuthoredDigest(bytes, item.digest)) {
      throw new Error(`${base.id} inventory evidence does not match ${item.url}`);
    }
  }
  const links = checkSite(publicRoot);
  if (links.broken.length) throw new Error(`${base.id} same-origin static link check failed: ${JSON.stringify(links.broken)}`);
  return { servedUrls: servedUrls.sort(), links };
}

function collectObservedTargets(base, publicRoot) {
  const revisions = AUTHORED_REVISIONS[base.id];
  const result = {};
  for (const relative of walkRelativeFiles(publicRoot)) {
    const url = artifactUrl(base, relative);
    const pageEntry = Object.entries(base.pages).find(([, fixturePath]) => fixturePath.replace(/^\//, '') === relative);
    const revision = pageEntry ? revisions[pageEntry[0]] ?? null : null;
    result[url] = evidenceAt(publicRoot, base, url, revision);
  }
  return result;
}

function buildAuthoredAt(id, buildRoot, { clock, externalEvidence }) {
  if (!AUTHORED_BASE_IDS.includes(id)) throw new TypeError(`unknown authored fixture base ${id}`);
  const base = FIXTURE_BASE_BY_ID[id];
  const fixtureRoot = path.join(AUTHORED_FIXTURE_ROOT, id);
  const sourceRoot = path.join(fixtureRoot, 'public');
  const privateRoot = path.join(fixtureRoot, 'private');
  const publicRoot = path.join(buildRoot, 'public');
  fs.rmSync(buildRoot, { recursive: true, force: true });
  ensureDir(buildRoot);
  copyPublicTree(sourceRoot, publicRoot);

  const now = clock.now();
  const linkset = authoredLinkset(id, publicRoot, externalEvidence, now);
  writeAuthored(publicRoot, base.linksetPaths[0], linkset);
  const descriptor = descriptorValue(base);
  writeAuthored(publicRoot, base.descriptorPath, descriptor);
  const inventory = inventoryValue(base, publicRoot, now);
  writeAuthored(publicRoot, base.inventoryPath, inventory);
  const validation = validateAuthoredPublication(base, publicRoot, descriptor, inventory, linkset, now);
  const observedTargets = collectObservedTargets(base, publicRoot);

  return Object.freeze({
    id,
    base,
    fixtureRoot,
    sourceRoot,
    privateRoot,
    buildRoot,
    publicRoot,
    descriptor,
    inventory,
    linkset,
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

export function buildAuthoredBase(id, options = {}) {
  const temporary = temporaryRoot(`cb-federation-${id}-`, options.outputRoot);
  const publication = buildAuthoredAt(id, path.join(temporary.root, id), {
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

export function buildAuthoredPublications(options = {}) {
  const temporary = temporaryRoot('cb-federation-authored-', options.outputRoot);
  const clock = options.clock ?? FIXED_CLOCK;
  const publications = {};
  const observedTargets = { ...(options.externalEvidence ?? {}) };
  try {
    for (const id of AUTHORED_BASE_IDS) {
      const publication = buildAuthoredAt(id, path.join(temporary.root, id), {
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
    roots: Object.freeze(Object.fromEntries(AUTHORED_BASE_IDS.map((id) => [id, publications[id].publicRoot]))),
    publications: Object.freeze(publications),
    observedTargets: Object.freeze(observedTargets),
    cleanup: () => {
      if (temporary.owned) fs.rmSync(temporary.root, { recursive: true, force: true });
    },
  });
}

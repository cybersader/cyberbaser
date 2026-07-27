import { deepFreeze, FIXTURE_PROFILE_URN } from './contracts.js';

/**
 * Every URL below is test scaffolding. It does not answer Q06, define a live URL
 * contract, or create names that any external publisher should adopt.
 */
export const FIXTURE_BASES = deepFreeze([
  {
    id: 'fungi',
    label: 'FungiWiki',
    kind: 'subject',
    producer: 'projection',
    logicalOrigin: 'https://fungi.test',
    homepagePath: '/',
    descriptorPath: '/about/federation.json',
    inventoryPath: '/exports/current-resources.json',
    linksetPaths: ['/links/outbound.linkset.json'],
    pages: {
      primary: '/species/chanterelle.html',
      secondary: '/species/false-chanterelle.html',
      mirrorSource: '/assets/chanterelle-comparison.svg',
    },
    capabilities: ['complete-inventory', 'describedby', 'linkset', 'subject-pages'],
    defaultRights: 'owner-published',
  },
  {
    id: 'forage',
    label: 'ForageBase',
    kind: 'subject',
    producer: 'projection',
    logicalOrigin: 'https://forage.test',
    homepagePath: '/',
    descriptorPath: '/publishing/base-description.json',
    inventoryPath: '/inventory/public-snapshot.json',
    linksetPaths: ['/relations/field-guides.linkset.json'],
    pages: {
      primary: '/guides/chanterelle.html',
      secondary: '/regions/coastal-foraging.html',
    },
    capabilities: ['complete-inventory', 'describedby', 'linkset', 'subject-pages'],
    defaultRights: 'owner-published',
  },
  {
    id: 'toxins',
    label: 'ToxinNotes',
    kind: 'subject',
    producer: 'authored',
    logicalOrigin: 'https://toxins.test',
    homepagePath: '/',
    descriptorPath: '/policies/peer-publication.json',
    inventoryPath: '/published/artifacts.json',
    linksetPaths: ['/evidence/outbound-links.json'],
    pages: {
      primary: '/notes/false-chanterelle.html',
      secondary: '/notes/poisoning-response.html',
    },
    capabilities: ['complete-inventory', 'describedby', 'link-only-rights', 'linkset', 'subject-pages'],
    defaultRights: 'link-only',
  },
  {
    id: 'atlas',
    label: 'Atlas of Edible Fungi',
    kind: 'meta',
    producer: 'projection',
    logicalOrigin: 'https://atlas.test',
    homepagePath: '/',
    descriptorPath: '/collections/about-atlas.json',
    inventoryPath: '/catalog/current.json',
    linksetPaths: ['/catalog/mappings.linkset.json'],
    pages: {
      primary: '/collections/beginner-field-set.html',
      mirror: '/mirrors/fungi/chanterelle-comparison.svg',
    },
    capabilities: ['collection', 'complete-inventory', 'describedby', 'licensed-mirror', 'linkset', 'mapping'],
    defaultRights: 'owner-published',
  },
  {
    id: 'cautious',
    label: 'Cautious Forager Index',
    kind: 'meta',
    producer: 'authored',
    logicalOrigin: 'https://cautious.test',
    homepagePath: '/',
    descriptorPath: '/index/this-base.json',
    inventoryPath: '/crawl/snapshot.json',
    linksetPaths: ['/assertions/curation.linkset.json'],
    pages: {
      primary: '/collections/conservative-field-set.html',
      annotation: '/annotations/chanterelle-regional-difference.html',
    },
    capabilities: ['annotation', 'collection', 'complete-inventory', 'describedby', 'linkset', 'mapping'],
    defaultRights: 'owner-published',
  },
]);

export const FIXTURE_ORIGINS = Object.freeze(FIXTURE_BASES.map((base) => base.logicalOrigin));
export const FIXTURE_DESCRIPTOR_PATHS = Object.freeze(FIXTURE_BASES.map((base) => base.descriptorPath));

export const FIXTURE_BASE_BY_ID = deepFreeze(Object.fromEntries(
  FIXTURE_BASES.map((base) => [base.id, base]),
));

export const FIXTURE_BASE_BY_ORIGIN = deepFreeze(Object.fromEntries(
  FIXTURE_BASES.map((base) => [base.logicalOrigin, base]),
));

function assertFrozenDefinitions() {
  if (FIXTURE_BASES.length !== 5) throw new Error('fixture topology must contain exactly five bases');
  if (new Set(FIXTURE_ORIGINS).size !== 5) throw new Error('fixture logical origins must be distinct');
  if (new Set(FIXTURE_DESCRIPTOR_PATHS).size !== 5) throw new Error('fixture descriptor paths must be distinct');
  for (const base of FIXTURE_BASES) {
    const origin = new URL(base.logicalOrigin);
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/') {
      throw new Error(`${base.id} logicalOrigin must be a bare HTTPS origin`);
    }
    if (!origin.hostname.endsWith('.test')) throw new Error(`${base.id} logicalOrigin must use the reserved .test suffix`);
    if (!base.descriptorPath.startsWith('/') || base.descriptorPath.startsWith('/.well-known/')) {
      throw new Error(`${base.id} descriptorPath must be an arbitrary non-well-known absolute path`);
    }
    for (const path of [base.homepagePath, base.descriptorPath, base.inventoryPath, ...base.linksetPaths, ...Object.values(base.pages)]) {
      assertFixturePath(path);
    }
    const sortedCapabilities = [...base.capabilities].sort();
    if (base.capabilities.some((capability, index) => capability !== sortedCapabilities[index])) {
      throw new Error(`${base.id} capabilities must be sorted`);
    }
  }
}

export function assertFixturePath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) {
    throw new TypeError('fixture path must be root-absolute without a network-path prefix');
  }
  if (value.includes('?') || value.includes('#') || value.includes('\\')) throw new TypeError(`fixture path must not contain query, fragment, or backslash: ${value}`);
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new TypeError(`fixture path must have valid percent encoding: ${value}`);
  }
  const segments = decoded.split('/');
  if (segments.includes('.') || segments.includes('..')) throw new TypeError(`fixture path must not traverse: ${value}`);
  if (decoded.includes('\\') || decoded.includes('\0')) throw new TypeError(`fixture path must not contain encoded backslash or NUL: ${value}`);
  return value;
}

export function logicalUrl(baseOrId, path = '/') {
  const base = typeof baseOrId === 'string'
    ? FIXTURE_BASE_BY_ID[baseOrId] ?? FIXTURE_BASE_BY_ORIGIN[baseOrId]
    : baseOrId;
  if (!base || !FIXTURE_BASE_BY_ID[base.id]) throw new TypeError(`unknown fixture base ${String(baseOrId)}`);
  assertFixturePath(path);
  return new URL(path, base.logicalOrigin).href;
}

export function fixtureUrls(baseOrId) {
  const base = typeof baseOrId === 'string'
    ? FIXTURE_BASE_BY_ID[baseOrId] ?? FIXTURE_BASE_BY_ORIGIN[baseOrId]
    : baseOrId;
  if (!base) throw new TypeError(`unknown fixture base ${String(baseOrId)}`);
  return deepFreeze({
    homepage: logicalUrl(base, base.homepagePath),
    descriptor: logicalUrl(base, base.descriptorPath),
    inventory: logicalUrl(base, base.inventoryPath),
    linksets: base.linksetPaths.map((path) => logicalUrl(base, path)),
    pages: Object.fromEntries(Object.entries(base.pages).map(([name, path]) => [name, logicalUrl(base, path)])),
  });
}

export function isFixtureLogicalUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && !url.username
      && !url.password
      && FIXTURE_ORIGINS.includes(url.origin);
  } catch {
    return false;
  }
}

function normalizePhysicalOrigin(value, id) {
  if (value === undefined || value === null) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${id} physical origin must be an absolute loopback URL`);
  }
  const port = Number(url.port);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError(`${id} physical origin must be http://127.0.0.1:<ephemeral-port>`);
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new TypeError(`${id} physical origin must not contain credentials, path, query, or fragment`);
  }
  return url.origin;
}

/**
 * Build the injected fixture topology without touching the network or filesystem.
 * Each root and physical origin is keyed by base ID. The resulting
 * logicalToPhysical table is consumed only by FixtureTransport; public transport
 * policy must never receive this loopback mapping.
 */
export function createFixtureTopology({ roots = {}, physicalOrigins = {} } = {}) {
  for (const key of Object.keys(roots)) {
    if (!FIXTURE_BASE_BY_ID[key]) throw new TypeError(`unknown fixture root key ${key}`);
    if (roots[key] !== null && typeof roots[key] !== 'string') throw new TypeError(`${key} root must be a string or null`);
  }
  for (const key of Object.keys(physicalOrigins)) {
    if (!FIXTURE_BASE_BY_ID[key]) throw new TypeError(`unknown physical-origin key ${key}`);
  }

  const bases = FIXTURE_BASES.map((definition) => {
    const urls = fixtureUrls(definition);
    return deepFreeze({
      ...definition,
      profile: FIXTURE_PROFILE_URN,
      urls,
      root: roots[definition.id] ?? null,
      physicalOrigin: normalizePhysicalOrigin(physicalOrigins[definition.id], definition.id),
    });
  });

  const byId = Object.fromEntries(bases.map((base) => [base.id, base]));
  const byOrigin = Object.fromEntries(bases.map((base) => [base.logicalOrigin, base]));
  const logicalToPhysical = Object.fromEntries(
    bases
      .filter((base) => base.physicalOrigin !== null)
      .map((base) => [base.logicalOrigin, base.physicalOrigin]),
  );

  return deepFreeze({
    profile: FIXTURE_PROFILE_URN,
    bases,
    byId,
    byOrigin,
    logicalToPhysical,
  });
}

export function assertCompleteFixtureTopology(topology) {
  if (!topology || topology.profile !== FIXTURE_PROFILE_URN || !Array.isArray(topology.bases)) {
    throw new TypeError('invalid fixture topology object');
  }
  if (topology.bases.length !== FIXTURE_BASES.length) throw new Error('fixture topology is missing bases');
  for (const base of topology.bases) {
    if (typeof base.root !== 'string' || base.root.length === 0) throw new Error(`${base.id} has no independent static root`);
    if (typeof base.physicalOrigin !== 'string') throw new Error(`${base.id} has no loopback server binding`);
    if (topology.logicalToPhysical[base.logicalOrigin] !== base.physicalOrigin) {
      throw new Error(`${base.id} logical-to-physical binding is inconsistent`);
    }
  }
  return topology;
}

assertFrozenDefinitions();

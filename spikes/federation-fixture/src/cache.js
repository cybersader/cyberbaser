import { createHash } from 'node:crypto';
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  FIXED_CLOCK,
  FIXTURE_PROFILE_URN,
  assertValid,
  cacheRecordKey,
  sha256Digest,
  stableJsonBytes,
  stableStringify,
  validateCacheRecord,
} from './contracts.js';
import { FIXTURE_ORIGINS } from './topology.js';

export const CACHE_FORMAT = 'cyberbaser-federation-fixture-cache-v1';
const RECORD_DIRECTORY = 'records';

function filenameForKey(key) {
  return `${createHash('sha256').update(key, 'utf8').digest('hex')}.json`;
}

function compareRecords(a, b) {
  const aKey = cacheRecordKey(a);
  const bKey = cacheRecordKey(b);
  const keyOrder = aKey.localeCompare(bKey);
  if (keyOrder !== 0) return keyOrder;
  return stableStringify(a).localeCompare(stableStringify(b));
}

function chooseCanonicalRecord(a, b) {
  if (!a) return b;
  const aDepth = Array.isArray(a.discoveryChain) ? a.discoveryChain.length : Number.MAX_SAFE_INTEGER;
  const bDepth = Array.isArray(b.discoveryChain) ? b.discoveryChain.length : Number.MAX_SAFE_INTEGER;
  if (aDepth !== bDepth) return aDepth < bDepth ? a : b;
  return stableStringify(a).localeCompare(stableStringify(b)) <= 0 ? a : b;
}

/**
 * Validate, source-deduplicate, and sort cache records. Equal subject/target
 * endpoints never merge unless their publisher, issuer, assertion, and fetched
 * artifact provenance also produce the same frozen cache key.
 */
export function normalizeCacheRecords(records, { allowedOrigins = FIXTURE_ORIGINS, expectedTime } = {}) {
  if (!Array.isArray(records)) throw new TypeError('cache records must be an array');
  const byKey = new Map();
  for (const record of records) {
    assertValid('cache record', validateCacheRecord(record, { allowedOrigins, expectedTime }));
    const key = cacheRecordKey(record);
    byKey.set(key, chooseCanonicalRecord(byKey.get(key), record));
  }
  return [...byKey.values()].sort(compareRecords);
}

export function cacheExport(records, { clock = FIXED_CLOCK, allowedOrigins = FIXTURE_ORIGINS } = {}) {
  if (!clock || typeof clock.now !== 'function') throw new TypeError('cache clock must expose now()');
  const generatedAt = clock.now();
  return {
    format: CACHE_FORMAT,
    generatedAt,
    profile: FIXTURE_PROFILE_URN,
    records: normalizeCacheRecords(records, { allowedOrigins, expectedTime: generatedAt }),
  };
}

export function cacheExportBytes(records, options = {}) {
  return stableJsonBytes(cacheExport(records, options));
}

export async function deleteCacheRoot(root) {
  if (typeof root !== 'string' || root.length === 0) throw new TypeError('cache root must be a non-empty path');
  await rm(resolve(root), { recursive: true, force: true });
}

/**
 * Recheck cached source artifacts without treating cache absence as authority.
 * Only a 410 response from the exact owner URL marks a record deleted. A 2xx
 * representation with different bytes is stale; every other response or
 * transport failure is unavailable.
 */
export async function refreshCacheObservations(records, {
  transport,
  clock = FIXED_CLOCK,
  allowedOrigins = FIXTURE_ORIGINS,
  limits = {},
} = {}) {
  if (!transport || typeof transport.get !== 'function') {
    throw new TypeError('observation refresh requires a transport with get()');
  }
  if (!clock || typeof clock.now !== 'function') throw new TypeError('observation refresh clock must expose now()');
  if (limits === null || typeof limits !== 'object' || Array.isArray(limits)) {
    throw new TypeError('observation refresh limits must be an object');
  }

  const verifiedAt = clock.now();
  const normalized = normalizeCacheRecords(records, {
    allowedOrigins,
    expectedTime: verifiedAt,
  });
  const observations = new Map();
  const urls = [...new Set(normalized.map((record) => record.fetchedUrl))].sort();

  await Promise.all(urls.map(async (url) => {
    try {
      observations.set(url, { response: await transport.get(url, limits), error: null });
    } catch (error) {
      observations.set(url, { response: null, error });
    }
  }));

  const refreshed = normalized.map((record) => {
    const { response, error } = observations.get(record.fetchedUrl);
    let state;
    let httpStatus = null;
    if (error || !response) {
      state = 'unavailable';
    } else {
      httpStatus = Number.isInteger(response.status) ? response.status : null;
      const exactOwnerResponse = response.url === record.fetchedUrl;
      if (exactOwnerResponse && response.status === 410) {
        state = 'deleted';
      } else if (exactOwnerResponse && response.ok) {
        state = sha256Digest(response.body) === record.sourceDigest ? 'current' : 'stale';
      } else {
        state = 'unavailable';
      }
    }

    return {
      ...record,
      observation: {
        ...record.observation,
        state,
        verifiedAt,
        httpStatus,
      },
    };
  });

  return normalizeCacheRecords(refreshed, {
    allowedOrigins,
    expectedTime: verifiedAt,
  });
}

/** A deliberately simple, disposable, deterministic JSON cache. */
export class JsonCache {
  constructor(root, { clock = FIXED_CLOCK, allowedOrigins = FIXTURE_ORIGINS } = {}) {
    if (typeof root !== 'string' || root.length === 0) throw new TypeError('cache root must be a non-empty path');
    if (!clock || typeof clock.now !== 'function') throw new TypeError('cache clock must expose now()');
    this.root = resolve(root);
    this.recordsRoot = join(this.root, RECORD_DIRECTORY);
    this.clock = clock;
    this.allowedOrigins = [...allowedOrigins];
    this.writeSequence = 0;
  }

  async initialize() {
    await mkdir(this.recordsRoot, { recursive: true });
    return this;
  }

  validate(record) {
    assertValid('cache record', validateCacheRecord(record, {
      allowedOrigins: this.allowedOrigins,
      expectedTime: this.clock.now(),
    }));
    return record;
  }

  pathFor(recordOrKey) {
    const key = typeof recordOrKey === 'string' ? recordOrKey : cacheRecordKey(recordOrKey);
    return join(this.recordsRoot, filenameForKey(key));
  }

  async readRecordFile(path) {
    const bytes = await readFile(path);
    let record;
    try {
      record = JSON.parse(bytes.toString('utf8'));
    } catch (error) {
      throw new Error(`cache record ${path} is not valid JSON: ${error.message}`);
    }
    return this.validate(record);
  }

  async get(recordOrKey) {
    const path = this.pathFor(recordOrKey);
    try {
      return await this.readRecordFile(path);
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  async put(record) {
    this.validate(record);
    await this.initialize();
    const key = cacheRecordKey(record);
    const path = this.pathFor(key);
    const existing = await this.get(key);
    const selected = chooseCanonicalRecord(existing, record);
    if (existing && stableStringify(existing) === stableStringify(selected)) {
      return { key, path, written: false, record: existing };
    }

    const temporary = `${path}.${process.pid}.${this.writeSequence += 1}.tmp`;
    try {
      await writeFile(temporary, stableJsonBytes(selected), { flag: 'wx' });
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
    return { key, path, written: true, record: selected };
  }

  async putMany(records) {
    const normalized = normalizeCacheRecords(records, {
      allowedOrigins: this.allowedOrigins,
      expectedTime: this.clock.now(),
    });
    const results = [];
    for (const record of normalized) results.push(await this.put(record));
    return results;
  }

  async remove(recordOrKey) {
    const path = this.pathFor(recordOrKey);
    try {
      await rm(path);
      return true;
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
  }

  async clear() {
    await deleteCacheRoot(this.root);
  }

  async records() {
    let names;
    try {
      names = await readdir(this.recordsRoot);
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
    const unexpected = names.filter((name) => !/^[a-f0-9]{64}\.json$/.test(name));
    if (unexpected.length) {
      throw new Error(`cache contains unexpected files: ${unexpected.sort().join(', ')}`);
    }
    const records = [];
    for (const name of names.sort()) records.push(await this.readRecordFile(join(this.recordsRoot, name)));
    return normalizeCacheRecords(records, {
      allowedOrigins: this.allowedOrigins,
      expectedTime: this.clock.now(),
    });
  }

  async export() {
    return cacheExport(await this.records(), {
      clock: this.clock,
      allowedOrigins: this.allowedOrigins,
    });
  }

  async exportBytes() {
    return stableJsonBytes(await this.export());
  }
}

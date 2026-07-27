import { isIP } from 'node:net';
import {
  DEFAULT_CRAWL_BUDGETS,
  FIXTURE_PROFILE_URN,
} from './contracts.js';
import {
  FIXTURE_ORIGINS,
  assertFixturePath,
} from './topology.js';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const SENSITIVE_HEADERS = new Set([
  'authorization',
  'connection',
  'content-length',
  'cookie',
  'forwarded',
  'host',
  'proxy-authorization',
  'proxy-connection',
  'transfer-encoding',
  'x-api-key',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
]);

export class TransportError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'TransportError';
    this.code = code;
    this.details = details;
  }
}

export class TransportPolicyError extends TransportError {
  constructor(code, message, details = {}) {
    super(code, message, details);
    this.name = 'TransportPolicyError';
  }
}

export class TransportLimitError extends TransportError {
  constructor(code, message, details = {}) {
    super(code, message, details);
    this.name = 'TransportLimitError';
  }
}

function normalizeMethod(value = 'GET') {
  const method = String(value).toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    throw new TransportPolicyError('method', 'federation transports allow only GET and HEAD');
  }
  return method;
}

function normalizeHeaders(input) {
  const headers = new Headers(input ?? {});
  for (const name of SENSITIVE_HEADERS) {
    if (headers.has(name)) {
      throw new TransportPolicyError('ambient-credentials', `ambient credential or connection-control header ${name} is not allowed`);
    }
  }
  headers.set('accept-encoding', 'identity');
  headers.delete('referer');
  headers.delete('origin');
  return headers;
}

function normalizeLimits(input = {}, { redirectsMayBeZero = false } = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('transport limits must be an object');
  }
  const defaults = {
    maxRedirects: DEFAULT_CRAWL_BUDGETS.maxRedirects,
    maxResponseBytes: DEFAULT_CRAWL_BUDGETS.maxResponseBytes,
    maxDecompressedBytes: DEFAULT_CRAWL_BUDGETS.maxDecompressedBytes,
    maxTotalBytes: DEFAULT_CRAWL_BUDGETS.maxTotalBytes,
    maxWallTimeMs: DEFAULT_CRAWL_BUDGETS.maxWallTimeMs,
  };
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(defaults, key)) throw new TypeError(`unknown transport limit ${key}`);
    const minimum = key === 'maxRedirects' && redirectsMayBeZero ? 0 : 1;
    if (!Number.isSafeInteger(input[key]) || input[key] < minimum) {
      throw new TypeError(`transport limit ${key} must be a safe integer >= ${minimum}`);
    }
  }
  return Object.freeze({ ...defaults, ...input });
}

function mergeLimits(base, overrides = {}) {
  const merged = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(base, key)) continue;
    const minimum = key === 'maxRedirects' ? 0 : 1;
    if (!Number.isSafeInteger(value) || value < minimum) {
      throw new TypeError(`transport limit ${key} must be a safe integer >= ${minimum}`);
    }
    merged[key] = Math.min(base[key], value);
  }
  return Object.freeze(merged);
}

function rawPathFromAbsoluteUrl(value) {
  const scheme = value.indexOf('://');
  if (scheme < 0) return '/';
  const authorityStart = scheme + 3;
  const pathStart = value.indexOf('/', authorityStart);
  if (pathStart < 0) return '/';
  const query = value.indexOf('?', pathStart);
  const hash = value.indexOf('#', pathStart);
  const endCandidates = [query, hash].filter((index) => index >= 0);
  const end = endCandidates.length ? Math.min(...endCandidates) : value.length;
  return value.slice(pathStart, end);
}

function assertUnnormalizedPathIsSafe(value) {
  const stringValue = String(value);
  const rawPath = stringValue.includes('://')
    ? rawPathFromAbsoluteUrl(stringValue)
    : stringValue.split(/[?#]/, 1)[0];
  let decoded;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    throw new TransportPolicyError('url-path', 'URL path has invalid percent encoding');
  }
  if (decoded.includes('\\') || decoded.includes('\0')) {
    throw new TransportPolicyError('url-path', 'URL path contains an encoded backslash or NUL');
  }
  const segments = decoded.split('/');
  if (segments.includes('.') || segments.includes('..')) {
    throw new TransportPolicyError('url-path', 'URL path contains traversal segments');
  }
}

function asFixtureUrl(value) {
  assertUnnormalizedPathIsSafe(value);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TransportPolicyError('url', 'fixture request must use an absolute logical URL');
  }
  if (url.protocol !== 'https:') throw new TransportPolicyError('url-scheme', 'fixture logical URLs must use HTTPS');
  if (url.username || url.password) throw new TransportPolicyError('url-credentials', 'URL credentials are not allowed');
  if (url.hash) throw new TransportPolicyError('url-fragment', 'fixture requests must not contain fragments');
  if (!FIXTURE_ORIGINS.includes(url.origin)) {
    throw new TransportPolicyError('fixture-origin', `origin ${url.origin} is not one of the five exact fixture origins`);
  }
  assertFixturePath(url.pathname);
  return url;
}

function normalizePhysicalMapping(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('logicalToPhysical must be an object keyed by logical fixture origin');
  }
  const result = {};
  for (const [logicalOrigin, physicalOrigin] of Object.entries(input)) {
    if (!FIXTURE_ORIGINS.includes(logicalOrigin)) {
      throw new TypeError(`fixture transport mapping contains unknown logical origin ${logicalOrigin}`);
    }
    let physical;
    try {
      physical = new URL(physicalOrigin);
    } catch {
      throw new TypeError(`${logicalOrigin} physical mapping must be an absolute loopback URL`);
    }
    const port = Number(physical.port);
    if (
      physical.protocol !== 'http:'
      || physical.hostname !== '127.0.0.1'
      || !Number.isInteger(port)
      || port < 1
      || port > 65_535
      || physical.username
      || physical.password
      || physical.pathname !== '/'
      || physical.search
      || physical.hash
    ) {
      throw new TypeError(`${logicalOrigin} physical mapping must be http://127.0.0.1:<port>`);
    }
    result[logicalOrigin] = physical.origin;
  }
  return Object.freeze(result);
}

async function cancelBody(response) {
  try {
    await response.body?.cancel();
  } catch {
    // A consumed or synthetic response may not support cancellation. Redirect
    // bodies are never exposed to a caller regardless.
  }
}

function parseContentLength(headers) {
  const value = headers.get('content-length');
  if (value === null || !/^\d+$/.test(value)) return null;
  const length = Number(value);
  return Number.isSafeInteger(length) ? length : null;
}

async function readStreamChunk(reader, signal) {
  if (!signal) return reader.read();
  if (signal.aborted) throw signal.reason ?? new Error('transport request aborted');
  let onAbort;
  try {
    return await Promise.race([
      reader.read(),
      new Promise((_, reject) => {
        onAbort = () => reject(signal.reason ?? new Error('transport request aborted'));
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

async function readLimitedBody(response, method, limits, signal) {
  if (method === 'HEAD' || !response.body) {
    return { body: Buffer.alloc(0), wireByteLength: 0, decompressedByteLength: 0 };
  }

  const declared = parseContentLength(response.headers);
  if (declared !== null && declared > limits.maxResponseBytes) {
    await cancelBody(response);
    throw new TransportLimitError(
      'maxResponseBytes',
      `declared response length ${declared} exceeds ${limits.maxResponseBytes} bytes`,
      { declared, limit: limits.maxResponseBytes },
    );
  }

  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await readStreamChunk(reader, signal);
      if (done) break;
      const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      length += chunk.byteLength;
      if (length > limits.maxResponseBytes) {
        throw new TransportLimitError(
          'maxResponseBytes',
          `response exceeds ${limits.maxResponseBytes} bytes`,
          { observed: length, limit: limits.maxResponseBytes },
        );
      }
      if (length > limits.maxDecompressedBytes) {
        throw new TransportLimitError(
          'maxDecompressedBytes',
          `decoded response exceeds ${limits.maxDecompressedBytes} bytes`,
          { observed: length, limit: limits.maxDecompressedBytes },
        );
      }
      if (length > limits.maxTotalBytes) {
        throw new TransportLimitError(
          'maxTotalBytes',
          `transport response exceeds total byte limit ${limits.maxTotalBytes}`,
          { observed: length, limit: limits.maxTotalBytes },
        );
      }
      chunks.push(chunk);
    }
  } catch (error) {
    try {
      await reader.cancel(error);
    } catch {
      // Preserve the original limit or stream error.
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
  const body = Buffer.concat(chunks, length);
  return {
    body,
    wireByteLength: declared ?? length,
    decompressedByteLength: length,
  };
}

function combineSignals(externalSignal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('transport wall-time limit exceeded'));
  }, timeoutMs);
  const signals = externalSignal ? [externalSignal, controller.signal] : [controller.signal];
  const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);
  return {
    signal,
    didTimeout: () => timedOut,
    clear: () => clearTimeout(timer),
  };
}

async function withinWallTime(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new TransportLimitError('maxWallTimeMs', message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function normalizeResponse(response) {
  if (!response || typeof response.status !== 'number' || !response.headers) {
    throw new TransportError('response-shape', 'injected request function returned no HTTP Response');
  }
  return response;
}

function terminalResponse({ requestedUrl, finalUrl, response, bodyResult, redirects, addresses = [] }) {
  return Object.freeze({
    profile: FIXTURE_PROFILE_URN,
    requestedUrl,
    url: finalUrl,
    status: response.status,
    ok: response.status >= 200 && response.status < 300,
    headers: new Headers(response.headers),
    body: bodyResult.body,
    byteLength: bodyResult.wireByteLength,
    decompressedByteLength: bodyResult.decompressedByteLength,
    redirects: Object.freeze(redirects.map((redirect) => Object.freeze({ ...redirect }))),
    resolvedAddresses: Object.freeze(addresses.map((address) => Object.freeze({ ...address }))),
  });
}

/**
 * Fixture-only logical HTTPS transport. It never accepts a sixth origin and its
 * loopback map is injected explicitly by the local server harness.
 */
export class FixtureTransport {
  constructor({ topology, logicalToPhysical, request = globalThis.fetch, limits = {} } = {}) {
    const mapping = logicalToPhysical ?? topology?.logicalToPhysical;
    this.logicalToPhysical = normalizePhysicalMapping(mapping ?? {});
    if (typeof request !== 'function') throw new TypeError('fixture transport request must be a function');
    this.request = request;
    this.limits = normalizeLimits(limits, { redirectsMayBeZero: true });
  }

  async fetch(value, options = {}) {
    const requested = asFixtureUrl(value);
    const method = normalizeMethod(options.method);
    const headers = normalizeHeaders(options.headers);
    const limits = mergeLimits(this.limits, options);
    const redirects = [];
    const startedAt = performance.now();
    let current = requested;

    while (true) {
      if (performance.now() - startedAt > limits.maxWallTimeMs) {
        throw new TransportLimitError('maxWallTimeMs', `fixture request exceeded ${limits.maxWallTimeMs} ms`);
      }
      const physicalOrigin = this.logicalToPhysical[current.origin];
      if (!physicalOrigin) {
        throw new TransportError('unavailable-origin', `fixture origin ${current.origin} has no running loopback binding`);
      }
      const physical = new URL(`${current.pathname}${current.search}`, physicalOrigin);
      const timeout = combineSignals(options.signal, Math.max(1, limits.maxWallTimeMs - Math.floor(performance.now() - startedAt)));
      let response;
      try {
        response = normalizeResponse(await this.request(physical.href, {
          method,
          headers: new Headers(headers),
          redirect: 'manual',
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          signal: timeout.signal,
        }, Object.freeze({
          kind: 'fixture',
          logicalUrl: current.href,
          physicalUrl: physical.href,
        })));
      } catch (error) {
        timeout.clear();
        if (timeout.didTimeout()) {
          throw new TransportLimitError('maxWallTimeMs', `fixture request exceeded ${limits.maxWallTimeMs} ms`);
        }
        if (error instanceof TransportError) throw error;
        throw new TransportError('network', `fixture request for ${current.href} failed: ${error.message}`, { cause: error });
      }

      const location = response.headers.get('location');
      if (REDIRECT_STATUSES.has(response.status) && location !== null) {
        if (redirects.length >= limits.maxRedirects) {
          await cancelBody(response);
          timeout.clear();
          throw new TransportLimitError('maxRedirects', `fixture request exceeded ${limits.maxRedirects} redirects`);
        }
        let next;
        try {
          assertUnnormalizedPathIsSafe(location);
          next = asFixtureUrl(new URL(location, current).href);
          if (options.onRedirect !== undefined) {
            if (typeof options.onRedirect !== 'function') throw new TypeError('onRedirect must be a function');
            await options.onRedirect(Object.freeze({ from: current.href, to: next.href, status: response.status }));
          }
        } catch (error) {
          await cancelBody(response);
          timeout.clear();
          throw error;
        }
        redirects.push({ from: current.href, to: next.href, status: response.status });
        await cancelBody(response);
        timeout.clear();
        current = next;
        continue;
      }

      try {
        const bodyResult = await readLimitedBody(response, method, limits, timeout.signal);
        return terminalResponse({
          requestedUrl: requested.href,
          finalUrl: current.href,
          response,
          bodyResult,
          redirects,
        });
      } catch (error) {
        if (timeout.didTimeout()) {
          throw new TransportLimitError('maxWallTimeMs', `fixture request exceeded ${limits.maxWallTimeMs} ms`);
        }
        throw error;
      } finally {
        timeout.clear();
      }
    }
  }

  get(value, options = {}) {
    return this.fetch(value, { ...options, method: 'GET' });
  }

  head(value, options = {}) {
    return this.fetch(value, { ...options, method: 'HEAD' });
  }
}

function parseIpv4(value) {
  const parts = value.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return null;
  const numbers = parts.map(Number);
  if (numbers.some((part) => part < 0 || part > 255)) return null;
  return numbers.reduce((result, part) => (result << 8n) | BigInt(part), 0n);
}

function parseIpv6(value) {
  let address = value.toLowerCase();
  const zone = address.indexOf('%');
  if (zone >= 0) return null;
  if (address.startsWith('[') && address.endsWith(']')) address = address.slice(1, -1);

  let ipv4Tail = null;
  const lastColon = address.lastIndexOf(':');
  if (address.includes('.') && lastColon >= 0) {
    ipv4Tail = parseIpv4(address.slice(lastColon + 1));
    if (ipv4Tail === null) return null;
    address = `${address.slice(0, lastColon)}:${Number((ipv4Tail >> 16n) & 0xffffn).toString(16)}:${Number(ipv4Tail & 0xffffn).toString(16)}`;
  }

  const halves = address.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if ([...left, ...right].some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const groups = [...left, ...Array(Math.max(0, missing)).fill('0'), ...right].map((part) => parseInt(part, 16));
  if (groups.length !== 8) return null;
  return groups.reduce((result, part) => (result << 16n) | BigInt(part), 0n);
}

function cidrContains(address, network, prefix, bits) {
  const shift = BigInt(bits - prefix);
  return (address >> shift) === (network >> shift);
}

const IPV4_BLOCKS = Object.freeze([
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
].map(([network, prefix]) => [parseIpv4(network), prefix]));

const IPV6_BLOCKS = Object.freeze([
  ['::', 8],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
].map(([network, prefix]) => [parseIpv6(network), prefix]));

/** Return true for public globally routable IPv4/IPv6 literals only. */
export function isPublicIpAddress(value) {
  const normalized = String(value).replace(/^\[|\]$/g, '');
  const family = isIP(normalized);
  if (family === 4) {
    const address = parseIpv4(normalized);
    return !IPV4_BLOCKS.some(([network, prefix]) => cidrContains(address, network, prefix, 32));
  }
  if (family === 6) {
    const address = parseIpv6(normalized);
    if (address === null) return false;
    const globalUnicast = cidrContains(address, parseIpv6('2000::'), 3, 128);
    return globalUnicast && !IPV6_BLOCKS.some(([network, prefix]) => cidrContains(address, network, prefix, 128));
  }
  return false;
}

function isReservedHostname(value) {
  const hostname = value.toLowerCase().replace(/\.$/, '');
  if (!hostname.includes('.')) return true;
  const reservedSuffixes = ['.localhost', '.local', '.internal', '.test', '.invalid', '.example'];
  if (hostname === 'localhost' || reservedSuffixes.some((suffix) => hostname.endsWith(suffix))) return true;
  return ['example.com', 'example.net', 'example.org'].some(
    (reserved) => hostname === reserved || hostname.endsWith(`.${reserved}`),
  );
}

function asPublicHttpsUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TransportPolicyError('url', 'public request must use an absolute URL');
  }
  if (url.protocol !== 'https:') throw new TransportPolicyError('url-scheme', 'public transport is HTTPS-only');
  if (url.username || url.password) throw new TransportPolicyError('url-credentials', 'URL credentials are not allowed');
  if (url.hash) throw new TransportPolicyError('url-fragment', 'public transport requests must not contain fragments');
  return url;
}

function normalizeResolvedAddresses(value) {
  const entries = Array.isArray(value) ? value : [value];
  const addresses = entries.map((entry) => {
    const address = typeof entry === 'string' ? entry : entry?.address;
    const family = typeof entry === 'object' && entry !== null && entry.family !== undefined
      ? Number(entry.family)
      : isIP(String(address));
    if (!address || (family !== 4 && family !== 6) || isIP(String(address)) !== family) {
      throw new TransportPolicyError('dns-result', 'resolver returned an invalid IPv4/IPv6 address');
    }
    return { address: String(address), family };
  });
  if (addresses.length === 0) throw new TransportPolicyError('dns-empty', 'resolver returned no addresses');
  addresses.sort((a, b) => a.family - b.family || a.address.localeCompare(b.address));
  return addresses;
}

/** Resolve and reject a destination before any request function is called. */
export async function resolvePublicDestination(url, resolver) {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const literalFamily = isIP(hostname);
  if (!literalFamily && isReservedHostname(hostname)) {
    throw new TransportPolicyError('reserved-hostname', `hostname ${hostname} is local or reserved`);
  }
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : normalizeResolvedAddresses(await resolver(hostname, { all: true, verbatim: true }));
  const blocked = addresses.filter(({ address }) => !isPublicIpAddress(address));
  if (blocked.length) {
    throw new TransportPolicyError(
      'blocked-address',
      `destination ${hostname} resolved to private or reserved address ${blocked.map(({ address }) => address).join(', ')}`,
      { hostname, addresses },
    );
  }
  return Object.freeze(addresses.map((address) => Object.freeze({ ...address })));
}

/**
 * Hardened public transport. The injected requester must connect to one of the
 * validated addresses supplied in its third argument; no loopback bypass exists.
 */
export class PublicHttpTransport {
  constructor({ resolve, dns, request, limits = {} } = {}) {
    this.resolve = resolve ?? dns;
    this.request = request;
    if (typeof this.resolve !== 'function') throw new TypeError('public transport requires an injected DNS resolver');
    if (typeof this.request !== 'function') throw new TypeError('public transport requires an injected address-pinning request function');
    this.limits = normalizeLimits(limits, { redirectsMayBeZero: true });
  }

  async fetch(value, options = {}) {
    const requested = asPublicHttpsUrl(value);
    const method = normalizeMethod(options.method);
    const headers = normalizeHeaders(options.headers);
    const limits = mergeLimits(this.limits, options);
    const redirects = [];
    const startedAt = performance.now();
    let current = requested;
    let lastAddresses = [];

    while (true) {
      const elapsed = performance.now() - startedAt;
      if (elapsed > limits.maxWallTimeMs) {
        throw new TransportLimitError('maxWallTimeMs', `public request exceeded ${limits.maxWallTimeMs} ms`);
      }
      const remainingForDns = Math.max(1, limits.maxWallTimeMs - Math.floor(elapsed));
      lastAddresses = await withinWallTime(
        resolvePublicDestination(current, this.resolve),
        remainingForDns,
        `public DNS validation exceeded ${limits.maxWallTimeMs} ms`,
      );
      const timeout = combineSignals(options.signal, Math.max(1, limits.maxWallTimeMs - Math.floor(performance.now() - startedAt)));
      let response;
      try {
        response = normalizeResponse(await this.request(current.href, {
          method,
          headers: new Headers(headers),
          redirect: 'manual',
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          signal: timeout.signal,
        }, Object.freeze({
          kind: 'public',
          hostname: current.hostname,
          addresses: lastAddresses,
          requireAddressPinning: true,
        })));
      } catch (error) {
        timeout.clear();
        if (timeout.didTimeout()) {
          throw new TransportLimitError('maxWallTimeMs', `public request exceeded ${limits.maxWallTimeMs} ms`);
        }
        if (error instanceof TransportError) throw error;
        throw new TransportError('network', `public request for ${current.href} failed: ${error.message}`, { cause: error });
      }

      const location = response.headers.get('location');
      if (REDIRECT_STATUSES.has(response.status) && location !== null) {
        if (redirects.length >= limits.maxRedirects) {
          await cancelBody(response);
          timeout.clear();
          throw new TransportLimitError('maxRedirects', `public request exceeded ${limits.maxRedirects} redirects`);
        }
        let next;
        try {
          next = asPublicHttpsUrl(new URL(location, current).href);
          await withinWallTime(
            resolvePublicDestination(next, this.resolve),
            Math.max(1, limits.maxWallTimeMs - Math.floor(performance.now() - startedAt)),
            `public redirect validation exceeded ${limits.maxWallTimeMs} ms`,
          );
          if (options.onRedirect !== undefined) {
            if (typeof options.onRedirect !== 'function') throw new TypeError('onRedirect must be a function');
            await options.onRedirect(Object.freeze({ from: current.href, to: next.href, status: response.status }));
          }
        } catch (error) {
          await cancelBody(response);
          timeout.clear();
          throw error;
        }
        redirects.push({ from: current.href, to: next.href, status: response.status });
        await cancelBody(response);
        timeout.clear();
        current = next;
        continue;
      }

      try {
        const bodyResult = await readLimitedBody(response, method, limits, timeout.signal);
        return terminalResponse({
          requestedUrl: requested.href,
          finalUrl: current.href,
          response,
          bodyResult,
          redirects,
          addresses: lastAddresses,
        });
      } catch (error) {
        if (timeout.didTimeout()) {
          throw new TransportLimitError('maxWallTimeMs', `public request exceeded ${limits.maxWallTimeMs} ms`);
        }
        throw error;
      } finally {
        timeout.clear();
      }
    }
  }

  get(value, options = {}) {
    return this.fetch(value, { ...options, method: 'GET' });
  }

  head(value, options = {}) {
    return this.fetch(value, { ...options, method: 'HEAD' });
  }
}

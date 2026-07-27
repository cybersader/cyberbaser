import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { stableJsonBytes } from './contracts.js';
import {
  FIXTURE_BASES,
  assertCompleteFixtureTopology,
  assertFixturePath,
  createFixtureTopology,
} from './topology.js';

export const LOOPBACK_HOST = '127.0.0.1';
export const ROUTE_FALLTHROUGH = Symbol('fixture-route-fallthrough');

const MEDIA_TYPES = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.linkset': 'application/linkset+json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
  '.xml': 'application/xml; charset=utf-8',
});

function responseHeaders(input, body, mediaType) {
  const headers = new Headers(input ?? {});
  if (!headers.has('content-type') && mediaType) headers.set('content-type', mediaType);
  if (!headers.has('content-length')) headers.set('content-length', String(body.byteLength));
  if (!headers.has('cache-control')) headers.set('cache-control', 'no-store');
  if (!headers.has('x-content-type-options')) headers.set('x-content-type-options', 'nosniff');
  return headers;
}

function bodyAllowed(status) {
  return status !== 204 && status !== 205 && status !== 304;
}

function makeResponse(body, { status = 200, headers, mediaType, method = 'GET' } = {}) {
  const bytes = bodyAllowed(status)
    ? Buffer.isBuffer(body)
      ? body
      : body instanceof Uint8Array
        ? Buffer.from(body.buffer, body.byteOffset, body.byteLength)
        : Buffer.from(body ?? '', 'utf8')
    : Buffer.alloc(0);
  const normalizedHeaders = responseHeaders(headers, bytes, mediaType);
  return new Response(method === 'HEAD' || !bodyAllowed(status) ? null : bytes, {
    status,
    headers: normalizedHeaders,
  });
}

function errorResponse(status, message, method = 'GET', headers = {}) {
  return makeResponse(`${message}\n`, {
    status,
    method,
    mediaType: 'text/plain; charset=utf-8',
    headers,
  });
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

/**
 * Validate the request target before it is joined to a filesystem root. The
 * decoded path is returned for exact overlay lookup and static-file resolution.
 */
export function safeRequestPath(requestUrl) {
  const rawPath = rawPathFromAbsoluteUrl(String(requestUrl));
  if (!rawPath.startsWith('/') || rawPath.startsWith('//')) {
    throw new TypeError('request path must be root-absolute');
  }
  let decoded;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    throw new TypeError('request path has invalid percent encoding');
  }
  if (decoded.includes('\\') || decoded.includes('\0')) {
    throw new TypeError('request path contains a backslash or NUL');
  }
  if (decoded.startsWith('//')) throw new TypeError('request path has a network-path prefix');
  const segments = decoded.split('/');
  if (segments.includes('.') || segments.includes('..')) {
    throw new TypeError('request path traverses outside the static root');
  }
  assertFixturePath(decoded);
  return decoded;
}

function normalizeRoutes(routes = {}) {
  if (routes instanceof Map) {
    for (const path of routes.keys()) assertFixturePath(path);
    return routes;
  }
  if (routes === null || typeof routes !== 'object' || Array.isArray(routes)) {
    throw new TypeError('route overlays must be a Map or object keyed by fixture path');
  }
  const map = new Map();
  for (const [path, value] of Object.entries(routes)) {
    assertFixturePath(path);
    map.set(path, value);
  }
  return map;
}

async function overlayResponse(value, context) {
  const resolved = typeof value === 'function' ? await value(context.request, context) : value;
  if (resolved === undefined || resolved === ROUTE_FALLTHROUGH) return ROUTE_FALLTHROUGH;
  if (resolved instanceof Response) {
    const body = bodyAllowed(resolved.status)
      ? Buffer.from(await resolved.clone().arrayBuffer())
      : Buffer.alloc(0);
    return makeResponse(body, {
      status: resolved.status,
      headers: resolved.headers,
      method: context.method,
    });
  }
  if (Number.isInteger(resolved)) {
    return errorResponse(resolved, `fixture overlay returned ${resolved}`, context.method);
  }
  if (resolved === null || typeof resolved !== 'object' || Array.isArray(resolved)) {
    throw new TypeError('route overlay must return a Response, status integer, response spec, or fallthrough');
  }
  if (resolved.delayMs !== undefined) {
    if (!Number.isSafeInteger(resolved.delayMs) || resolved.delayMs < 0) {
      throw new TypeError('route overlay delayMs must be a non-negative safe integer');
    }
    await Bun.sleep(resolved.delayMs);
  }
  if (resolved.error) throw resolved.error;
  const body = resolved.json === undefined
    ? resolved.body ?? ''
    : stableJsonBytes(resolved.json);
  const headers = new Headers(resolved.headers ?? {});
  if (resolved.location !== undefined) headers.set('location', String(resolved.location));
  const mediaType = resolved.json === undefined
    ? resolved.mediaType
    : 'application/json; charset=utf-8';
  return makeResponse(body, {
    status: resolved.status ?? 200,
    headers,
    mediaType,
    method: context.method,
  });
}

function isInsideRoot(root, target) {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

async function staticResponse(root, decodedPath, method) {
  const relativePath = decodedPath.slice(1);
  let candidate = resolve(root, relativePath || '.');
  if (!isInsideRoot(root, candidate)) return errorResponse(403, 'path escapes fixture root', method);

  let candidateStat;
  try {
    candidateStat = await stat(candidate);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      return errorResponse(404, 'not found', method);
    }
    throw error;
  }

  if (candidateStat.isDirectory()) {
    candidate = join(candidate, 'index.html');
    try {
      candidateStat = await stat(candidate);
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
        return errorResponse(404, 'not found', method);
      }
      throw error;
    }
  }
  if (!candidateStat.isFile()) return errorResponse(404, 'not found', method);

  const resolvedTarget = await realpath(candidate);
  if (!isInsideRoot(root, resolvedTarget)) return errorResponse(403, 'symlink escapes fixture root', method);
  const fileType = await lstat(resolvedTarget);
  if (!fileType.isFile()) return errorResponse(404, 'not found', method);

  const bytes = await readFile(resolvedTarget);
  const mediaType = MEDIA_TYPES[extname(resolvedTarget).toLowerCase()] ?? 'application/octet-stream';
  return makeResponse(bytes, { method, mediaType });
}

/** Start one independently stoppable static publisher on an ephemeral loopback port. */
export async function startFixtureServer({ base, root, routes = {}, onRequest } = {}) {
  if (!base || typeof base.id !== 'string') throw new TypeError('fixture server requires a frozen base definition');
  if (typeof root !== 'string' || root.length === 0) throw new TypeError(`${base.id} fixture server requires a static root`);
  if (onRequest !== undefined && typeof onRequest !== 'function') throw new TypeError('onRequest must be a function');

  const rootPath = await realpath(root);
  const rootStat = await stat(rootPath);
  if (!rootStat.isDirectory()) throw new TypeError(`${base.id} static root must be a directory`);
  const routeMap = normalizeRoutes(routes);
  let stopped = false;

  const server = Bun.serve({
    hostname: LOOPBACK_HOST,
    port: 0,
    async fetch(request) {
      const method = request.method.toUpperCase();
      if (method !== 'GET' && method !== 'HEAD') {
        return errorResponse(405, 'method not allowed', method, { allow: 'GET, HEAD' });
      }

      let decodedPath;
      try {
        decodedPath = safeRequestPath(request.url);
      } catch (error) {
        return errorResponse(400, error.message, method);
      }

      const context = Object.freeze({
        base,
        root: rootPath,
        path: decodedPath,
        method,
        request,
      });
      if (onRequest) await onRequest(context);

      if (routeMap.has(decodedPath)) {
        try {
          const response = await overlayResponse(routeMap.get(decodedPath), context);
          if (response !== ROUTE_FALLTHROUGH) return response;
        } catch (error) {
          return errorResponse(500, `fixture overlay failed: ${error.message}`, method);
        }
      }
      return staticResponse(rootPath, decodedPath, method);
    },
    error(error) {
      return errorResponse(500, `fixture server failed: ${error.message}`);
    },
  });

  const physicalOrigin = `http://${LOOPBACK_HOST}:${server.port}`;
  return {
    id: base.id,
    base,
    root: rootPath,
    routes: routeMap,
    server,
    physicalOrigin,
    get stopped() {
      return stopped;
    },
    setRoute(path, value) {
      assertFixturePath(path);
      routeMap.set(path, value);
      return this;
    },
    deleteRoute(path) {
      assertFixturePath(path);
      return routeMap.delete(path);
    },
    clearRoutes() {
      routeMap.clear();
    },
    async stop(force = true) {
      if (stopped) return;
      stopped = true;
      await Promise.resolve(server.stop(force));
    },
  };
}

/**
 * Start all five publishers. Failure while starting one publisher stops only the
 * instances already created; callers still retain an independent handle per base.
 */
export async function startFixtureServers({ roots, routeOverlays = {}, onRequest } = {}) {
  if (roots === null || typeof roots !== 'object' || Array.isArray(roots)) {
    throw new TypeError('roots must be an object keyed by the five fixture base IDs');
  }
  for (const key of Object.keys(roots)) {
    if (!FIXTURE_BASES.some((base) => base.id === key)) throw new TypeError(`unknown fixture root key ${key}`);
  }
  for (const key of Object.keys(routeOverlays)) {
    if (!FIXTURE_BASES.some((base) => base.id === key)) throw new TypeError(`unknown fixture route overlay key ${key}`);
  }

  const servers = [];
  try {
    for (const base of FIXTURE_BASES) {
      const handle = await startFixtureServer({
        base,
        root: roots[base.id],
        routes: routeOverlays[base.id] ?? {},
        onRequest: onRequest
          ? (context) => onRequest({ ...context, id: base.id })
          : undefined,
      });
      servers.push(handle);
    }

    const distinctRoots = new Set(servers.map((handle) => handle.root));
    if (distinctRoots.size !== FIXTURE_BASES.length) {
      throw new Error('each fixture publisher must have an independent static root');
    }

    const byId = Object.fromEntries(servers.map((handle) => [handle.id, handle]));
    const topology = assertCompleteFixtureTopology(createFixtureTopology({
      roots: Object.fromEntries(servers.map((handle) => [handle.id, handle.root])),
      physicalOrigins: Object.fromEntries(servers.map((handle) => [handle.id, handle.physicalOrigin])),
    }));

    return {
      servers,
      byId,
      topology,
      async stop(id, force = true) {
        const handle = byId[id];
        if (!handle) throw new TypeError(`unknown fixture server ${id}`);
        await handle.stop(force);
      },
      async stopAll(force = true) {
        await Promise.allSettled(servers.map((handle) => handle.stop(force)));
      },
    };
  } catch (error) {
    await Promise.allSettled(servers.map((handle) => handle.stop(true)));
    throw error;
  }
}

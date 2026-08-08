import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOwnerAlphaConfig, validateOwnerAlphaConfig } from './config.js';
import { fail, OwnerAlphaError } from './errors.js';
import { listDurableJobs, loadDurableJob, validateJobId } from './job-state.js';
import { ensureOwnerSite } from './site.js';
import { createEditSession as createSourceEditSession } from './source.js';
import { prepareStore, storeContextFromConfig } from './store.js';

const COOKIE_NAME = 'owner_alpha_session';
export const MAX_OWNER_SESSIONS = 64;
const DEFAULT_EDIT_SESSION_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_EDIT_SESSIONS = 64;
const MAX_STATIC_BYTES = 64 * 1024 * 1024;
const PUBLIC_ROOT = fileURLToPath(new URL('../public/', import.meta.url));
const PROJECT_ROOT = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const OWNER_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "connect-src 'self'",
  "font-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "img-src 'self' data:",
  "manifest-src 'self'",
  "media-src 'self'",
  "object-src 'none'",
  "script-src 'self'",
  "script-src-attr 'none'",
  "style-src 'self'",
].join('; ');

const READER_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "connect-src 'self'",
  "font-src 'self' https://fonts.gstatic.com https://cdn.jsdelivr.net",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "img-src 'self' data: blob:",
  "manifest-src 'self'",
  "media-src 'self'",
  "object-src 'none'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net",
  "script-src-attr 'none'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net",
  "worker-src 'self' blob:",
].join('; ');

const CONTENT_TYPES = Object.freeze({
  '.avif': 'image/avif',
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.ogg': 'audio/ogg',
  '.otf': 'font/otf',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml; charset=utf-8',
});

function token() {
  return randomBytes(32).toString('base64url');
}

function exactToken(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(value);
}

function sameSecret(left, right) {
  if (!exactToken(left) || !exactToken(right)) return false;
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function securityHeaders({ owner = false, cache = 'no-store', csp = OWNER_CSP } = {}) {
  const headers = new Headers({
    'Cache-Control': cache,
    'Content-Security-Policy': csp,
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  });
  if (owner) headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
  return headers;
}

function response(body, status, headers = {}) {
  const secured = securityHeaders({ owner: true });
  for (const [name, value] of Object.entries(headers)) secured.set(name, value);
  return new Response(body, { status, headers: secured });
}

function html(body, status = 200, headers = {}) {
  return response(body, status, { 'Content-Type': 'text/html; charset=utf-8', ...headers });
}

function json(value, status = 200, headers = {}) {
  return response(`${JSON.stringify(value)}\n`, status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...headers,
  });
}

function errorResponse(status, code) {
  return json({ error: { code } }, status);
}

function cookieHeader(processSession) {
  return `${COOKIE_NAME}=${processSession}; Path=/; HttpOnly; SameSite=Strict`;
}

function requestCookie(request) {
  const raw = request.headers.get('cookie');
  if (raw === null || raw.length > 4096) return null;
  const matches = [];
  for (const field of raw.split(';')) {
    const part = field.trim();
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    if (part.slice(0, separator) === COOKIE_NAME) matches.push(part.slice(separator + 1));
  }
  return matches.length === 1 ? matches[0] : null;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function textareaText(value) {
  const escaped = String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;');
  return value.startsWith('\n') ? `\n${escaped}` : escaped;
}

function pageShell({ title, body, script = null }) {
  const scriptTag = script ? `<script src="${script}" defer></script>` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="/owner/assets/owner.css">
${scriptTag}
</head>
<body>
${body}
</body>
</html>
`;
}

function editPage({ editSessionId, csrfToken, session }) {
  return pageShell({
    title: 'Owner edit',
    script: '/owner/assets/editor.js',
    body: `<main class="owner-shell" id="owner-editor" data-edit-session-id="${escapeHtml(editSessionId)}" data-csrf="${escapeHtml(csrfToken)}">
<header class="owner-header">
<p class="eyebrow">Owner alpha</p>
<h1>Edit Markdown</h1>
<p class="lede">One bounded Save publishes through the configured owner-controlled pipeline.</p>
</header>
<form id="edit-form">
<label for="edited-text">Markdown</label>
<textarea id="edited-text" name="editedText" spellcheck="false" autocomplete="off">${textareaText(session.source.text)}</textarea>
<div class="actions"><button type="submit" id="save-button">Save and publish</button></div>
<p id="form-status" class="status" role="status" aria-live="polite"></p>
</form>
</main>`,
  });
}

function publicJob(job) {
  const result = {
    jobId: job.jobId,
    state: job.state,
    revision: job.revision,
  };
  if (typeof job.createdAt === 'string') result.createdAt = job.createdAt;
  if (typeof job.updatedAt === 'string') result.updatedAt = job.updatedAt;
  if (job.recovery && typeof job.recovery === 'object') {
    result.recovery = {
      classification: job.recovery.classification,
      automatic: job.recovery.automatic,
      instruction: job.recovery.instruction,
    };
  }
  if (job.failure && typeof job.failure === 'object') {
    result.failure = {
      code: job.failure.code,
      retryable: job.failure.retryable,
    };
  } else {
    result.failure = null;
  }
  return result;
}

function jobPage(job, readerOrigin) {
  const safe = publicJob(job);
  return pageShell({
    title: `Owner job ${safe.jobId}`,
    script: '/owner/assets/job.js',
    body: `<main class="owner-shell" id="owner-job" data-job-id="${escapeHtml(safe.jobId)}">
<header class="owner-header">
<p class="eyebrow">Owner alpha</p>
<h1>Save job</h1>
<p class="lede">This page reports the durable pipeline state. It has no mutation controls.</p>
</header>
<section class="job-card" aria-live="polite">
<dl>
<div><dt>Job</dt><dd id="job-id">${escapeHtml(safe.jobId)}</dd></div>
<div><dt>State</dt><dd id="job-state">${escapeHtml(safe.state)}</dd></div>
<div><dt>Updated</dt><dd id="job-updated">${escapeHtml(safe.updatedAt ?? '')}</dd></div>
</dl>
<p id="job-recovery" class="status">${escapeHtml(safe.recovery?.instruction ?? '')}</p>
<p id="job-error" class="error" role="alert"></p>
</section>
<p><a href="${escapeHtml(readerOrigin)}/cyberbase/">Return to Cyberbase</a></p>
</main>`,
  });
}

function queryObject(url, required) {
  const found = new Map();
  for (const [key, value] of url.searchParams) {
    if (!required.includes(key) || found.has(key)) return null;
    found.set(key, value);
  }
  if (found.size !== required.length || required.some((key) => !found.has(key))) return null;
  return Object.fromEntries(found);
}

async function readBoundedJson(request, maximum) {
  const contentType = request.headers.get('content-type');
  if (contentType !== 'application/json') throw Object.assign(new Error('content-type'), { status: 415 });
  const declared = request.headers.get('content-length');
  if (declared !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(declared)) throw Object.assign(new Error('length'), { status: 400 });
    if (Number(declared) > maximum) throw Object.assign(new Error('large'), { status: 413 });
  }
  if (request.body === null) throw Object.assign(new Error('body'), { status: 400 });

  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) {
        await reader.cancel();
        throw Object.assign(new Error('large'), { status: 413 });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return JSON.parse(text);
  } catch (error) {
    if (error?.status) throw error;
    throw Object.assign(new Error('json'), { status: 400 });
  }
}

function validateSaveBody(value, maximumEditedBytes) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 3 || !['editSessionId', 'editedText', 'csrf'].every((key) => keys.includes(key))) return null;
  if (!exactToken(value.editSessionId) || !exactToken(value.csrf) || typeof value.editedText !== 'string') return null;
  if (Buffer.byteLength(value.editedText, 'utf8') > maximumEditedBytes) return null;
  return value;
}

function safePathSegments(encodedPath, { directoryIndex = true } = {}) {
  let candidate = encodedPath;
  let wantsIndex = false;
  if (directoryIndex && (candidate === '' || candidate.endsWith('/'))) {
    wantsIndex = true;
    candidate = candidate.replace(/\/+$/u, '');
  }
  if (candidate === '') return ['index.html'];

  const segments = candidate.split('/').map((segment) => {
    let decoded;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw Object.assign(new Error('path'), { status: 400 });
    }
    if (decoded === ''
      || decoded === '.'
      || decoded === '..'
      || decoded.includes('/')
      || decoded.includes('\\')
      || /\p{Cc}/u.test(decoded)) {
      throw Object.assign(new Error('path'), { status: 400 });
    }
    return decoded;
  });
  if (wantsIndex) segments.push('index.html');
  return segments;
}

function contained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function readSafeStatic(rootInput, encodedPath, { directoryIndex = true } = {}) {
  const root = path.resolve(rootInput);
  const segments = safePathSegments(encodedPath, { directoryIndex });
  let rootReal;
  try {
    const rootMetadata = await lstat(root);
    if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) return { status: 404 };
    rootReal = await realpath(root);
  } catch {
    return { status: 404 };
  }
  if (rootReal !== root) return { status: 404 };

  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    let metadata;
    try {
      metadata = await lstat(current);
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { status: 404 };
      return { status: 500 };
    }
    if (metadata.isSymbolicLink()) return { status: 404 };
  }

  let candidateReal;
  try {
    candidateReal = await realpath(current);
  } catch {
    return { status: 404 };
  }
  if (candidateReal !== current || !contained(rootReal, candidateReal)) return { status: 404 };

  let handle;
  try {
    handle = await open(current, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.nlink !== 1) return { status: 404 };
    if (metadata.size > MAX_STATIC_BYTES) return { status: 413 };
    const realMetadata = await stat(candidateReal);
    if (metadata.dev !== realMetadata.dev || metadata.ino !== realMetadata.ino) return { status: 404 };
    return {
      status: 200,
      bytes: await handle.readFile(),
      contentType: CONTENT_TYPES[path.extname(current).toLowerCase()] ?? 'application/octet-stream',
    };
  } catch (error) {
    if (error?.code === 'ELOOP' || error?.code === 'ENOENT') return { status: 404 };
    return { status: 500 };
  } finally {
    await handle?.close();
  }
}

async function staticResponse(root, encodedPath, request, options = {}) {
  let result;
  try {
    result = await readSafeStatic(root, encodedPath, options);
    if (result.status === 404
      && options.cleanHtml === true
      && encodedPath !== ''
      && !encodedPath.endsWith('/')) {
      const segments = safePathSegments(encodedPath, { directoryIndex: false });
      const last = segments.at(-1);
      if (last && path.extname(last) === '') {
        result = await readSafeStatic(root, `${encodedPath}.html`, {
          ...options,
          directoryIndex: false,
        });
      }
    }
  } catch (error) {
    return errorResponse(error?.status ?? 400, 'invalid-static-path');
  }
  if (result.status !== 200) return errorResponse(result.status, result.status === 404 ? 'not-found' : 'static-unavailable');
  const bytes = result.bytes;
  const csp = options.reader === true ? READER_CSP : OWNER_CSP;
  const headers = securityHeaders({ cache: 'private, max-age=0, must-revalidate', csp });
  headers.set('Content-Type', result.contentType);
  headers.set('Content-Length', String(bytes.length));
  return new Response(request.method === 'HEAD' ? null : bytes, { status: 200, headers });
}

export function createReaderHandler({
  config: configInput,
  projectRoot = PROJECT_ROOT,
  siteRoot,
} = {}) {
  const config = validateOwnerAlphaConfig(configInput);
  const expectedHost = `${config.listen.host}:${config.listen.readerPort}`;
  const expectedOrigin = `http://${expectedHost}`;
  const resolvedSiteRoot = siteRoot ?? path.resolve(projectRoot, config.workspace.site);

  return async function ownerAlphaReaderFetch(request) {
    if (!(request instanceof Request)) return errorResponse(400, 'invalid-request');
    if (request.headers.get('host') !== expectedHost) return errorResponse(421, 'invalid-host');
    if (!['GET', 'HEAD'].includes(request.method)) {
      return response(null, 405, { Allow: 'GET, HEAD' });
    }
    let url;
    try {
      url = new URL(request.url);
    } catch {
      return errorResponse(400, 'invalid-url');
    }
    if (url.origin !== expectedOrigin) return errorResponse(421, 'invalid-host');
    if (url.pathname === '/') return response(null, 302, { Location: '/cyberbase/' });
    if (!url.pathname.startsWith('/cyberbase/')) return errorResponse(404, 'not-found');
    if (url.search !== '') return errorResponse(400, 'unexpected-query');
    return staticResponse(resolvedSiteRoot, url.pathname.slice('/cyberbase/'.length), request, {
      cleanHtml: true,
      reader: true,
    });
  };
}

export function createMemoryEditSessionStore({
  ttlMs = DEFAULT_EDIT_SESSION_TTL_MS,
  maxEntries = DEFAULT_MAX_EDIT_SESSIONS,
  now = () => Date.now(),
  createToken = token,
} = {}) {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || !Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    throw new TypeError('edit session store limits must be positive integers');
  }
  const entries = new Map();

  function prune() {
    const current = now();
    for (const [id, entry] of entries) if (entry.expiresAt <= current) entries.delete(id);
  }

  return Object.freeze({
    create(value) {
      prune();
      if (entries.size >= maxEntries) throw new OwnerAlphaError('edit-session-capacity', 'too many active edit sessions');
      let id;
      do id = createToken(); while (entries.has(id));
      if (!exactToken(id)) throw new TypeError('edit session token factory returned an invalid token');
      const expiresAt = now() + ttlMs;
      entries.set(id, { value, expiresAt });
      return Object.freeze({ id, expiresAt });
    },
    get(id) {
      prune();
      return entries.get(id)?.value ?? null;
    },
    delete(id) {
      return entries.delete(id);
    },
  });
}

export function createOwnerAlphaHandler({
  config: configInput,
  projectRoot = PROJECT_ROOT,
  siteRoot,
  publicRoot = PUBLIC_ROOT,
  createEditSession = createSourceEditSession,
  editSessions = createMemoryEditSessionStore(),
  saveEdit,
  lookupJob,
  createToken = token,
  createJobId = () => `OA-${randomUUID()}`,
} = {}) {
  const config = validateOwnerAlphaConfig(configInput);
  if (typeof createEditSession !== 'function'
    || typeof saveEdit !== 'function'
    || typeof lookupJob !== 'function'
    || typeof createJobId !== 'function') {
    throw new TypeError('createEditSession, saveEdit, lookupJob, and createJobId dependencies are required');
  }
  if (!editSessions || typeof editSessions.create !== 'function' || typeof editSessions.get !== 'function' || typeof editSessions.delete !== 'function') {
    throw new TypeError('editSessions must provide create, get, and delete');
  }
  // Each consumed bootstrap capability becomes one device session with its own
  // cookie and CSRF token, so one captured device secret is not every device's
  // secret. Only local console authority can mint a new capability.
  const sessions = new Map();
  const issuedTokens = new Set();
  let outstanding = null;

  function createBootstrapCapability() {
    if (sessions.size >= MAX_OWNER_SESSIONS) {
      fail('owner-session-capacity', 'active owner sessions are at capacity; restart the server to reset sessions');
    }
    // Generation order (session, CSRF, bootstrap) is part of the deterministic
    // token-factory contract used by fixtures.
    const sessionToken = createToken();
    const csrfToken = createToken();
    const capability = {
      sessionToken,
      csrfToken,
      bootstrapToken: createToken(),
    };
    const tokens = Object.values(capability);
    if (tokens.some((value) => !exactToken(value) || issuedTokens.has(value))
      || new Set(tokens).size !== 3) {
      throw new TypeError('process token factory must return distinct unseen 32-byte base64url tokens');
    }
    for (const value of tokens) issuedTokens.add(value);
    return capability;
  }

  function issueBootstrap() {
    outstanding = createBootstrapCapability();
    return outstanding.bootstrapToken;
  }

  function resolveSession(cookieValue) {
    if (!exactToken(cookieValue)) return null;
    // Constant-time scan; the map is bounded by MAX_OWNER_SESSIONS.
    let found = null;
    for (const [sessionToken, record] of sessions) {
      if (sameSecret(cookieValue, sessionToken)) found = record;
    }
    return found;
  }

  issueBootstrap();
  const initialBootstrapToken = outstanding.bootstrapToken;
  const expectedHost = `${config.listen.host}:${config.listen.port}`;
  const expectedOrigin = `http://${expectedHost}`;
  const readerOrigin = `http://${config.listen.host}:${config.listen.readerPort}`;
  const inFlight = new Set();
  const maximumBodyBytes = Math.min(
    config.limits.maxArtifactBytes,
    config.limits.maxSourceBytes + 16 * 1024,
  );

  const handler = async function ownerAlphaFetch(request) {
    if (!(request instanceof Request)) return errorResponse(400, 'invalid-request');
    if (request.headers.get('host') !== expectedHost) return errorResponse(421, 'invalid-host');
    if (!['GET', 'HEAD', 'POST'].includes(request.method)) {
      return response(null, 405, { Allow: 'GET, HEAD, POST' });
    }

    let url;
    try {
      url = new URL(request.url);
    } catch {
      return errorResponse(400, 'invalid-url');
    }
    if (url.origin !== expectedOrigin) return errorResponse(421, 'invalid-host');

    if (url.pathname === '/owner/bootstrap') {
      if (request.method !== 'GET') return response(null, 405, { Allow: 'GET' });
      const query = queryObject(url, ['token']);
      if (!query || outstanding === null || !sameSecret(query.token, outstanding.bootstrapToken)) {
        return errorResponse(403, 'invalid-bootstrap');
      }
      const consumed = outstanding;
      outstanding = null;
      sessions.set(consumed.sessionToken, { csrfToken: consumed.csrfToken });
      return response(null, 303, {
        Location: `${readerOrigin}/cyberbase/`,
        'Set-Cookie': cookieHeader(consumed.sessionToken),
      });
    }

    const deviceSession = resolveSession(requestCookie(request));
    if (deviceSession === null) {
      return errorResponse(403, 'invalid-session');
    }
    const csrfToken = deviceSession.csrfToken;
    if (request.method === 'POST' && request.headers.get('origin') !== expectedOrigin) {
      return errorResponse(403, 'invalid-origin');
    }

    if (url.pathname === '/') {
      if (request.method !== 'GET' && request.method !== 'HEAD') return response(null, 405, { Allow: 'GET, HEAD' });
      return response(null, 302, { Location: `${readerOrigin}/cyberbase/` });
    }

    const asset = {
      '/owner/assets/editor.js': 'editor.js',
      '/owner/assets/job.js': 'job.js',
      '/owner/assets/owner.css': 'owner.css',
    }[url.pathname];
    if (asset) {
      if (request.method !== 'GET' && request.method !== 'HEAD') return response(null, 405, { Allow: 'GET, HEAD' });
      if (url.search !== '') return errorResponse(400, 'unexpected-query');
      return staticResponse(publicRoot, asset, request, { directoryIndex: false });
    }

    if (url.pathname === '/owner/edit') {
      if (request.method !== 'GET' && request.method !== 'HEAD') return response(null, 405, { Allow: 'GET, HEAD' });
      const query = queryObject(url, ['relativePath', 'slug']);
      if (!query) return errorResponse(400, 'invalid-edit-query');
      try {
        const session = await createEditSession({
          config,
          renderer: { relativePath: query.relativePath, slug: query.slug },
        });
        if (typeof session?.source?.text !== 'string') return errorResponse(500, 'invalid-edit-session');
        const stored = editSessions.create(session);
        const body = editPage({ editSessionId: stored.id, csrfToken, session });
        if (request.method === 'HEAD') return html(null, 200);
        return html(body);
      } catch (error) {
        const code = error instanceof OwnerAlphaError ? error.code : 'edit-session-failed';
        return errorResponse(code === 'edit-session-capacity' ? 503 : 400, code);
      }
    }

    if (url.pathname === '/api/edits') {
      if (request.method !== 'POST') return response(null, 405, { Allow: 'POST' });
      let body;
      try {
        body = await readBoundedJson(request, maximumBodyBytes);
      } catch (error) {
        return errorResponse(error?.status ?? 400, 'invalid-request-body');
      }
      const save = validateSaveBody(body, config.limits.maxSourceBytes);
      if (!save) return errorResponse(400, 'invalid-save-request');
      if (!sameSecret(save.csrf, csrfToken)) return errorResponse(403, 'invalid-csrf');
      const session = editSessions.get(save.editSessionId);
      if (session === null) return errorResponse(410, 'edit-session-expired');
      if (inFlight.has(save.editSessionId)) return errorResponse(409, 'save-in-progress');

      inFlight.add(save.editSessionId);
      let jobId;
      let started;
      try {
        jobId = validateJobId(createJobId());
        started = await saveEdit({ jobId, session, editedText: save.editedText });
        if (!started || started.jobId !== jobId || started.state !== 'accepted') {
          throw new OwnerAlphaError('invalid-save-acceptance', 'Save did not return exact durable acceptance');
        }
      } catch (error) {
        inFlight.delete(save.editSessionId);
        if (error instanceof OwnerAlphaError) {
          return errorResponse(error.code === 'lock-busy' ? 409 : 400, error.code);
        }
        return errorResponse(500, 'save-failed');
      }
      editSessions.delete(save.editSessionId);
      inFlight.delete(save.editSessionId);
      return json({
        jobId,
        state: started.state ?? 'accepted',
        statusUrl: `/owner/jobs/${encodeURIComponent(jobId)}`,
        jsonUrl: `/api/jobs/${encodeURIComponent(jobId)}`,
      }, 202);
    }

    const jobMatch = url.pathname.match(/^\/(owner\/jobs|api\/jobs)\/([^/]+)$/u);
    if (jobMatch) {
      if (request.method !== 'GET' && request.method !== 'HEAD') return response(null, 405, { Allow: 'GET, HEAD' });
      if (url.search !== '') return errorResponse(400, 'unexpected-query');
      let jobId;
      try {
        jobId = validateJobId(decodeURIComponent(jobMatch[2]));
      } catch {
        return errorResponse(400, 'invalid-job-id');
      }
      let job;
      try {
        job = await lookupJob(jobId);
      } catch (error) {
        if (error instanceof OwnerAlphaError && ['artifact-not-found', 'job-not-found'].includes(error.code)) {
          return errorResponse(404, 'job-not-found');
        }
        return errorResponse(500, 'job-lookup-failed');
      }
      if (!job || job.jobId !== jobId) return errorResponse(404, 'job-not-found');
      if (jobMatch[1] === 'api/jobs') {
        if (request.method === 'HEAD') return json(null, 200);
        return json(publicJob(job));
      }
      if (request.method === 'HEAD') return html(null);
      return html(jobPage(job, readerOrigin));
    }

    return errorResponse(404, 'not-found');
  };
  Object.defineProperties(handler, {
    bootstrapToken: { value: initialBootstrapToken, enumerable: false },
    issueBootstrap: { value: issueBootstrap, enumerable: false },
    ownerOrigin: { value: expectedOrigin, enumerable: false },
    readerOrigin: { value: readerOrigin, enumerable: false },
  });
  return handler;
}

export function startOwnerAlphaServer({ config: configInput, fetch, serve = Bun.serve } = {}) {
  const config = validateOwnerAlphaConfig(configInput);
  if (typeof fetch !== 'function' || typeof serve !== 'function') throw new TypeError('fetch and serve are required');
  // Bind exactly the validated private address; if the host does not own it,
  // startup must fail rather than fall back to a wildcard bind.
  return serve({
    hostname: config.listen.host,
    port: config.listen.port,
    fetch,
  });
}

export function startReaderServer({ config: configInput, fetch, serve = Bun.serve } = {}) {
  const config = validateOwnerAlphaConfig(configInput);
  if (typeof fetch !== 'function' || typeof serve !== 'function') throw new TypeError('fetch and serve are required');
  return serve({
    hostname: config.listen.host,
    port: config.listen.readerPort,
    fetch,
  });
}

export function startOwnerAlphaServers({
  config: configInput,
  ownerFetch,
  readerFetch,
  serve = Bun.serve,
} = {}) {
  const config = validateOwnerAlphaConfig(configInput);
  const owner = startOwnerAlphaServer({ config, fetch: ownerFetch, serve });
  let reader;
  try {
    reader = startReaderServer({ config, fetch: readerFetch, serve });
  } catch (error) {
    owner.stop?.();
    throw error;
  }
  return Object.freeze({
    owner,
    reader,
    ownerOrigin: `http://${config.listen.host}:${config.listen.port}`,
    readerOrigin: `http://${config.listen.host}:${config.listen.readerPort}`,
    bootstrapToken: ownerFetch.bootstrapToken,
    issueBootstrap: ownerFetch.issueBootstrap,
    stop(closeActiveConnections) {
      reader.stop?.(closeActiveConnections);
      owner.stop?.(closeActiveConnections);
    },
  });
}

async function loadPipelineAdapter(options) {
  const pipeline = await import('./pipeline.js');
  if (typeof pipeline.createSaveHandler !== 'function') {
    throw new TypeError('pipeline.js must export createSaveHandler(options)');
  }
  const created = await pipeline.createSaveHandler(options);
  if (typeof created === 'function') {
    return {
      saveEdit: created,
      resumeJob: typeof created.resumeJob === 'function' ? created.resumeJob : null,
      getJob: typeof created.getJob === 'function' ? created.getJob : null,
    };
  }
  if (!created || typeof created.saveEdit !== 'function') {
    throw new TypeError('createSaveHandler(options) must return saveEdit({ session, editedText })');
  }
  return {
    saveEdit: created.saveEdit,
    resumeJob: typeof created.resumeJob === 'function' ? created.resumeJob : null,
    getJob: typeof created.getJob === 'function' ? created.getJob : null,
  };
}

export async function recoverOwnerAlphaJobs({
  config: configInput,
  context,
  pipeline,
  listJobs = listDurableJobs,
} = {}) {
  const config = validateOwnerAlphaConfig(configInput);
  if (!context || typeof listJobs !== 'function') {
    throw new TypeError('recovery requires a store context and job enumerator');
  }
  const jobs = await listJobs(context, { maxBytes: config.limits.maxArtifactBytes });
  const resumable = jobs.filter((job) => job.recovery?.automatic === true);
  if (resumable.length > 0 && typeof pipeline?.resumeJob !== 'function') {
    throw new OwnerAlphaError('automatic-recovery-unavailable', 'durable jobs require automatic recovery but the pipeline has no resume adapter');
  }
  const results = [];
  for (const job of resumable) {
    results.push(await pipeline.resumeJob({ jobId: job.jobId }));
  }
  return Object.freeze(results);
}

export async function runOwnerAlphaServer({
  configFile = new URL('../owner-alpha.local.json', import.meta.url),
  projectRoot = PROJECT_ROOT,
  serve = Bun.serve,
  rebuildSite = ensureOwnerSite,
  loadPipeline = loadPipelineAdapter,
  createHandler = createOwnerAlphaHandler,
  createReader = createReaderHandler,
  startServers = startOwnerAlphaServers,
  listJobs = listDurableJobs,
  recoverJobs = recoverOwnerAlphaJobs,
} = {}) {
  if (typeof rebuildSite !== 'function'
    || typeof loadPipeline !== 'function'
    || typeof createHandler !== 'function'
    || typeof createReader !== 'function'
    || typeof startServers !== 'function'
    || typeof listJobs !== 'function'
    || typeof recoverJobs !== 'function') {
    throw new TypeError('rebuildSite, pipeline, handlers, servers, and recovery dependencies are required');
  }
  const config = await loadOwnerAlphaConfig(configFile);
  const storeContext = storeContextFromConfig(config, projectRoot);
  await prepareStore(storeContext);
  await rebuildSite({ config, projectRoot });
  const pipeline = await loadPipeline({ config, projectRoot, context: storeContext });
  const lookupJob = pipeline.getJob ?? ((jobId) => loadDurableJob(storeContext, jobId, {
    maxBytes: config.limits.maxArtifactBytes,
  }));
  const ownerFetch = createHandler({
    config,
    projectRoot,
    saveEdit: pipeline.saveEdit,
    lookupJob,
  });
  const readerFetch = createReader({ config, projectRoot });
  const runtime = startServers({ config, ownerFetch, readerFetch, serve });
  const recovery = Promise.resolve().then(() => recoverJobs({
    config,
    context: storeContext,
    pipeline,
    listJobs,
  }));
  return Object.freeze({ ...runtime, recovery });
}

export const OWNER_ALPHA_READY_CONTENT = 'owner-alpha-ready-v1\n';

export async function writeOwnerAlphaReadyMarker(file) {
  if (typeof file !== 'string'
    || !path.isAbsolute(file)
    || path.normalize(file) !== file
    || file === path.parse(file).root) {
    throw new TypeError('ready marker must be one normalized absolute file path');
  }
  const parent = path.dirname(file);
  const parentMetadata = await lstat(parent);
  if (parentMetadata.isSymbolicLink()
    || !parentMetadata.isDirectory()
    || await realpath(parent) !== parent
    || (typeof process.getuid === 'function' && parentMetadata.uid !== process.getuid())
    || (typeof process.getgid === 'function' && parentMetadata.gid !== process.getgid())
    || (parentMetadata.mode & 0o777) !== 0o700) {
    throw new OwnerAlphaError('ready-directory-invalid', 'ready marker parent must be a private runtime-owned real directory');
  }
  const temporary = path.join(parent, `.${path.basename(file)}.tmp-${process.pid}-${randomUUID()}`);
  let handle;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(OWNER_ALPHA_READY_CONTENT, 'utf8');
    await handle.sync();
    await handle.chmod(0o600);
    await handle.close();
    handle = null;
    await rename(temporary, file);
    const metadata = await stat(file);
    if (!metadata.isFile()
      || metadata.nlink !== 1
      || (metadata.mode & 0o777) !== 0o600
      || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())
      || (typeof process.getgid === 'function' && metadata.gid !== process.getgid())) {
      throw new OwnerAlphaError('ready-marker-invalid', 'ready marker did not retain private runtime ownership');
    }
  } finally {
    await handle?.close();
    await rm(temporary, { force: true });
  }
}

export async function removeOwnerAlphaReadyMarker(file) {
  if (typeof file === 'string' && file.length > 0) await rm(file, { force: true });
}

if (import.meta.main) {
  const { startBootstrapConsole, formatBootstrapUrl } = await import('./bootstrap-console.js');
  const configFile = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
  const readyFile = process.env.OWNER_ALPHA_READY_FILE;
  let runtime;
  let disposeConsole;
  let stopping = false;

  const stop = async (exitCode) => {
    if (stopping) return;
    stopping = true;
    disposeConsole?.();
    runtime?.stop(true);
    try {
      await removeOwnerAlphaReadyMarker(readyFile);
    } finally {
      process.exitCode = exitCode;
    }
  };

  const stopForSignal = async () => {
    await stop(0);
    process.exit(0);
  };
  process.once('SIGTERM', () => { void stopForSignal(); });
  process.once('SIGINT', () => { void stopForSignal(); });

  try {
    runtime = await runOwnerAlphaServer({ configFile });
    await runtime.recovery;
    if (readyFile) await writeOwnerAlphaReadyMarker(readyFile);
    console.log(`Owner alpha reader: ${runtime.readerOrigin}/cyberbase/`);
    console.log(`Owner alpha bootstrap: ${formatBootstrapUrl(runtime.ownerOrigin, runtime.bootstrapToken)}`);
    if (typeof runtime.issueBootstrap === 'function' && process.stdin.readable) {
      console.log("Enter 'b' for a one-time sign-in link for another device.");
      disposeConsole = startBootstrapConsole({
        input: process.stdin,
        output: process.stdout,
        ownerOrigin: runtime.ownerOrigin,
        issueBootstrap: runtime.issueBootstrap,
      });
    }
  } catch (error) {
    await stop(1);
    console.error(`Owner alpha startup failed: ${error instanceof OwnerAlphaError ? error.code : 'unexpected-error'}`);
  }
}

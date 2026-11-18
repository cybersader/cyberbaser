import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildViewModel } from './view-model.js';
import { renderShell } from './render-shell.js';

export const MOCKUP_HOST = '127.0.0.2';

const CSS_PATH = fileURLToPath(new URL('../public/mockup.css', import.meta.url));
const JS_PATH = fileURLToPath(new URL('../public/mockup.js', import.meta.url));
const CSP = [
  "default-src 'none'", "base-uri 'none'", "connect-src 'none'", "font-src 'self'",
  "form-action 'none'", "frame-ancestors 'none'", "img-src 'self' data:",
  "object-src 'none'", "script-src 'self'", "script-src-attr 'none'", "style-src 'self'",
  "worker-src 'none'",
].join('; ');
const CONTENT = Object.freeze({
  '/mockup.css': ['text/css; charset=utf-8', CSS_PATH],
  '/mockup.js': ['text/javascript; charset=utf-8', JS_PATH],
});

function securityHeaders(contentType) {
  return new Headers({
    'Cache-Control': 'no-store',
    'Content-Security-Policy': CSP,
    'Content-Type': contentType,
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
  });
}
function response(body, status, contentType, method, extra = {}) {
  const headers = securityHeaders(contentType);
  for (const [key, value] of Object.entries(extra)) headers.set(key, value);
  return new Response(method === 'HEAD' ? null : body, { status, headers });
}
function validatePort(port) {
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new TypeError('mockup port must be an integer from 1024 through 65535');
  return port;
}

export async function createMockupHandler({ port = 4328 } = {}) {
  validatePort(port);
  const expectedHost = `${MOCKUP_HOST}:${port}`;
  const [html, css, script] = await Promise.all([
    renderShell(buildViewModel()),
    readFile(CSS_PATH),
    readFile(JS_PATH),
  ]);
  const assets = new Map([['/mockup.css', css], ['/mockup.js', script]]);
  return async function handle(request) {
    const method = request.method.toUpperCase();
    if (!['GET', 'HEAD'].includes(method)) return response('method not allowed\n', 405, 'text/plain; charset=utf-8', method, { Allow: 'GET, HEAD' });
    if (request.headers.get('host') !== expectedHost) return response('invalid host\n', 421, 'text/plain; charset=utf-8', method);
    if (request.headers.has('cookie')) return response('cookies not accepted\n', 400, 'text/plain; charset=utf-8', method);
    const url = new URL(request.url);
    if (url.username || url.password || url.search) return response('not found\n', 404, 'text/plain; charset=utf-8', method);
    if (url.pathname === '/' || url.pathname === '/index.html') return response(html, 200, 'text/html; charset=utf-8', method);
    if (assets.has(url.pathname)) return response(assets.get(url.pathname), 200, CONTENT[url.pathname][0], method);
    return response('not found\n', 404, 'text/plain; charset=utf-8', method);
  };
}

export async function startMockupServer({ port = 4328 } = {}) {
  validatePort(port);
  const fetch = await createMockupHandler({ port });
  const server = Bun.serve({ hostname: MOCKUP_HOST, port, fetch });
  return Object.freeze({
    hostname: MOCKUP_HOST, port: server.port, url: `http://${MOCKUP_HOST}:${server.port}/`,
    stop(closeActiveConnections = true) { server.stop(closeActiveConnections); },
  });
}

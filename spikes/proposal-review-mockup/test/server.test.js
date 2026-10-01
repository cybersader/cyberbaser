import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createMockupHandler, MOCKUP_HOST } from '../src/server.js';

const ROOT = path.resolve(import.meta.dir, '..');
function request(pathname = '/', { method = 'GET', host = `${MOCKUP_HOST}:4328`, cookie = null } = {}) {
  const headers = { Host: host };
  if (cookie !== null) headers.Cookie = cookie;
  return new Request(`http://${MOCKUP_HOST}:4328${pathname}`, { method, headers });
}

test('server enforces exact numeric Host, GET/HEAD only, containment, and no cookies', async () => {
  const handler = await createMockupHandler({ port: 4328 });
  const home = await handler(request('/'));
  expect(home.status).toBe(200);
  expect(home.headers.get('set-cookie')).toBeNull();
  expect(await home.text()).toContain('Static concept — controls do nothing. No decision is recorded.');
  const head = await handler(request('/mockup.css', { method: 'HEAD' }));
  expect(head.status).toBe(200);
  expect(await head.text()).toBe('');
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'CONNECT', 'OPTIONS', 'TRACE']) {
    const response = await handler(request('/', { method }));
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, HEAD');
  }
  expect((await handler(request('/', { host: 'localhost:4328' }))).status).toBe(421);
  expect((await handler(request('/', { host: `${MOCKUP_HOST}:9999` }))).status).toBe(421);
  const cookieResponse = await handler(request('/', { cookie: 'owner_alpha_session=privileged-owner-cookie' }));
  expect(cookieResponse.status).toBe(400);
  expect(await cookieResponse.text()).toBe('cookies not accepted\n');
  expect((await handler(request('/unknown'))).status).toBe(404);
  expect((await handler(request('/../package.json'))).status).toBe(404);
  expect((await handler(request('/?state=1'))).status).toBe(404);
});

test('security headers prohibit connections, forms, objects, framing, caching, and sniffing', async () => {
  const response = await (await createMockupHandler({ port: 4328 }))(request('/'));
  const csp = response.headers.get('content-security-policy');
  for (const directive of ["connect-src 'none'", "form-action 'none'", "object-src 'none'", "frame-ancestors 'none'", "default-src 'none'"]) expect(csp).toContain(directive);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(response.headers.get('x-frame-options')).toBe('DENY');
});

test('fixture JSON is HTML-escaped and active-looking fixture content never enters markup', async () => {
  const response = await (await createMockupHandler({ port: 4328 }))(request('/'));
  const html = await response.text();
  expect(html).not.toContain('<script>alert("never")</script>');
  expect(html).toContain('\\u003cscript\\u003ealert');
  expect(html).toContain('type="application/json"');
});

test('executable mockup code has no privileged boundary imports or persistent/network client APIs', async () => {
  const files = ['src/server.js', 'src/view-model.js', 'src/render-shell.js', 'public/mockup.js'];
  const combined = (await Promise.all(files.map((file) => readFile(path.join(ROOT, file), 'utf8')))).join('\n');
  for (const forbidden of ['owner_alpha_session', '/api/review/', 'bootstrap?token=', 'review.sock', 'child_process', 'execFile(', 'git commit', 'git push']) expect(combined).not.toContain(forbidden);
  const client = await readFile(path.join(ROOT, 'public/mockup.js'), 'utf8');
  for (const forbidden of ['fetch(', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'sendBeacon', 'localStorage', 'sessionStorage', 'indexedDB', 'serviceWorker', 'document.cookie', 'clipboard.write', 'caches.']) expect(client).not.toContain(forbidden);
});

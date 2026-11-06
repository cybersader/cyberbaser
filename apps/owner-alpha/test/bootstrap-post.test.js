import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { createOwnerAlphaHandler } from '../src/server.js';

const config = JSON.parse(await readFile(new URL('../owner-alpha.example.json', import.meta.url), 'utf8'));
const ORIGIN = 'http://127.0.0.1:4317';
const HOST = '127.0.0.1:4317';
const code = (byte) => Buffer.alloc(32, byte).toString('base64url');
const INITIAL = code(3);
function fixture() {
  let issued = 0;
  const forbidden = () => { throw new Error('unexpected-effect'); };
  return createOwnerAlphaHandler({ config, createToken: () => code(++issued),
    createEditSession: forbidden, saveEdit: forbidden, lookupJob: forbidden });
}
function request(path, { method = 'GET', headers = {}, body, origin = ORIGIN } = {}) {
  return new Request(`${origin}${path}`, { method, headers: { Host: HOST, ...headers }, body });
}
function post({ token = INITIAL, body = JSON.stringify({ token }), headers = {}, path = '/owner/bootstrap', origin } = {}) {
  return request(path, { method: 'POST', origin, body,
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json', ...headers } });
}
const cookie = (response) => response.headers.get('set-cookie')?.split(';')[0];
function protections(response) {
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  expect(response.headers.get('x-frame-options')).toBe('DENY');
  expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  expect(response.headers.get('content-security-policy')).toContain("script-src 'self'");
}

describe('body-only bootstrap', () => {
  test('POST creates a usable session with a fixed body and no redirect; both replay routes fail', async () => {
    const handler = fixture();
    const result = await handler(post());
    expect(result.status).toBe(200);
    expect(await result.text()).toBe('{"ok":true}\n');
    expect(result.headers.get('location')).toBeNull();
    expect(result.headers.get('set-cookie')).toBe(`owner_alpha_session=${code(1)}; Path=/; HttpOnly; SameSite=Strict`);
    protections(result);
    expect((await handler(request('/', { headers: { Cookie: cookie(result) } }))).status).toBe(302);
    expect((await handler(post())).status).toBe(403);
    expect((await handler(request(`/owner/bootstrap?token=${INITIAL}`))).status).toBe(403);
  });

  test('legacy GET retains its redirect, cookie, strict query and one-use behavior', async () => {
    const handler = fixture();
    expect((await handler(request(`/owner/bootstrap?token=${INITIAL}&extra=1`))).status).toBe(403);
    const result = await handler(request(`/owner/bootstrap?token=${INITIAL}`));
    expect(result.status).toBe(303);
    expect(result.headers.get('location')).toBe('http://127.0.0.1:4318/cyberbase/');
    expect(cookie(result)).toBe(`owner_alpha_session=${code(1)}`);
    expect(await result.text()).toBe('');
    expect((await handler(post())).status).toBe(403);
  });

  test('simultaneous GET and POST cannot consume twice', async () => {
    const handler = fixture();
    const results = await Promise.all([handler(post()), handler(request(`/owner/bootstrap?token=${INITIAL}`))]);
    expect(results.filter((result) => result.headers.has('set-cookie'))).toHaveLength(1);
    expect(results.map((result) => result.status).sort()).toEqual([303, 403]);
  });

  test('a POST held in body reading cannot consume a replaced capability or the new session', async () => {
    const handler = fixture(); let controller;
    const body = new ReadableStream({ start(value) { controller = value; } });
    const pending = handler(post({ body }));
    const replacement = handler.issueBootstrap();
    controller.enqueue(new TextEncoder().encode(JSON.stringify({ token: INITIAL })));
    controller.close();
    expect((await pending).status).toBe(403);
    expect((await handler(post({ token: replacement }))).status).toBe(200);
  });

  test('simultaneous POST requests consume once; re-arm preserves every established session', async () => {
    const handler = fixture();
    const results = await Promise.all([handler(post()), handler(post())]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 403]);
    const first = cookie(results.find((result) => result.status === 200));
    const superseded = handler.issueBootstrap();
    const current = handler.issueBootstrap();
    expect((await handler(post({ token: superseded }))).status).toBe(403);
    const second = await handler(post({ token: current }));
    expect(second.status).toBe(200);
    expect(cookie(second)).not.toBe(first);
    for (const session of [first, cookie(second)]) {
      expect((await handler(request('/', { headers: { Cookie: session } }))).status).toBe(302);
    }
  });

  const invalid = [
    ['wrong Host', { headers: { Host: '127.0.0.1:9999' } }, 421],
    ['wrong request origin', { origin: 'http://127.0.0.2:4317' }, 421],
    ['wrong Origin', { headers: { Origin: 'http://127.0.0.2:4317' } }, 403],
    ['opaque Origin', { headers: { Origin: 'null' } }, 403],
    ['query', { path: '/owner/bootstrap?token=synthetic' }, 400],
    ['wrong type', { headers: { 'Content-Type': 'text/plain' } }, 415],
    ['type parameter', { headers: { 'Content-Type': 'application/json; charset=utf-8' } }, 415],
    ['missing member', { body: '{}' }, 400],
    ['duplicate member', { body: `{"token":"${INITIAL}","token":"${INITIAL}"}` }, 400],
    ['escaped duplicate', { body: `{"token":"${INITIAL}","to\\u006ben":"${INITIAL}"}` }, 400],
    ['extra member', { body: `{"token":"${INITIAL}","extra":true}` }, 400],
    ['wrong member', { body: `{"other":"${INITIAL}"}` }, 400],
    ['array', { body: `["${INITIAL}"]` }, 400],
    ['null', { body: 'null' }, 400],
    ['number', { body: '{"token":1}' }, 400],
    ['malformed', { body: '{"token":' }, 400],
    ['empty', { body: '' }, 400],
    ['missing body', { body: null }, 400],
    ['short token', { token: 'short' }, 400],
    ['noncanonical token', { token: 'b'.repeat(43) }, 400],
    ['incorrect token', { token: code(9) }, 403],
    ['actual oversize', { body: JSON.stringify({ token: INITIAL }) + ' '.repeat(257) }, 413],
    ['declared oversize', { headers: { 'Content-Length': '257' } }, 413],
    ['invalid length', { headers: { 'Content-Length': '-1' } }, 400],
    ['invalid UTF8', { body: new Uint8Array([0xff, 0xfe]) }, 400],
  ];
  for (const [name, options, status] of invalid) {
    test(`${name} is refused without consuming, rearming or echoing the capability`, async () => {
      const handler = fixture();
      const result = await handler(post(options));
      expect(result.status).toBe(status);
      expect(result.headers.has('set-cookie')).toBe(false);
      expect(result.headers.has('location')).toBe(false);
      const text = await result.text();
      expect(text).not.toContain(INITIAL);
      expect(text).not.toContain(code(1));
      expect(text).not.toContain(code(2));
      expect(Object.keys(JSON.parse(text))).toEqual(['error']);
      protections(result);
      expect((await handler(post())).status).toBe(200);
      expect((await handler(post({ token: code(6) }))).status).toBe(403);
    });
  }

  for (const header of ['Origin', 'Content-Type']) {
    test(`missing ${header} refuses before consumption`, async () => {
      const handler = fixture(); const input = post(); input.headers.delete(header);
      expect((await handler(input)).status).toBe(header === 'Origin' ? 403 : 415);
      expect((await handler(post())).status).toBe(200);
    });
  }

  test('Host, request origin, Origin and query rejection precede accessing request.body', async () => {
    for (const options of [invalid[0][1], invalid[1][1], invalid[2][1], invalid[4][1]]) {
      const handler = fixture(); const input = post(options); let bodyAccess = 0;
      Object.defineProperty(input, 'body', { get() { bodyAccess += 1; throw new Error('body-access'); } });
      const result = await handler(input);
      expect([400, 403, 421]).toContain(result.status);
      expect(bodyAccess).toBe(0);
      expect((await handler(post())).status).toBe(200);
    }
  });

  test('exact body cap and a single escaped JSON key are accepted', async () => {
    const body = `{"to\\u006ben":"${INITIAL}"}`;
    const handler = fixture();
    expect((await handler(post({ body: body + ' '.repeat(256 - Buffer.byteLength(body)) }))).status).toBe(200);
  });

  test('sign-in page is secret-free with exact unique accessible labels and no submitting form', async () => {
    const handler = fixture(); const result = await handler(request('/owner/sign-in'));
    expect(result.status).toBe(200); protections(result);
    const text = await result.text();
    expect(text).toContain('<label for="owner-bootstrap-token">One-time sign-in code</label>');
    expect(text).toContain('<input id="owner-bootstrap-token" type="password" autocomplete="off"');
    expect(text).toContain('<button id="owner-bootstrap-submit" type="button">Sign in</button>');
    expect(text.match(/<input\b/g)).toHaveLength(1);
    expect(text.match(/<button\b/g)).toHaveLength(1);
    expect(text).not.toMatch(/<form\b|\bvalue=|\bname="token|data-.*token=/u);
    for (const secret of [INITIAL, code(1), code(2)]) expect(text).not.toContain(secret);
    expect(text).toContain('src="/owner/assets/bootstrap.js"');
    expect(text).toContain('id="owner-bootstrap-status"');
    const head = await handler(request('/owner/sign-in', { method: 'HEAD' }));
    expect(head.status).toBe(200); expect(await head.text()).toBe('');
    expect((await handler(request('/owner/sign-in?x=1'))).status).toBe(400);
    expect((await handler(request('/owner/sign-in', { method: 'POST' }))).status).toBe(405);
    expect((await handler(post())).status).toBe(200);
  });

  test('only fixed sign-in assets are public, queryless, read-only and protected', async () => {
    const handler = fixture();
    for (const asset of ['bootstrap.js', 'owner.css']) {
      const path = `/owner/assets/${asset}`;
      for (const method of ['GET', 'HEAD']) {
        const result = await handler(request(path, { method }));
        expect(result.status).toBe(200); protections(result);
        if (method === 'HEAD') expect(await result.text()).toBe('');
      }
      expect((await handler(request(`${path}?x=1`))).status).toBe(400);
      expect((await handler(request(path, { method: 'POST' }))).status).toBe(405);
    }
    for (const asset of ['editor.js', 'publication.js', 'job.js', 'review.js', 'apply.js', 'missing.js']) {
      expect((await handler(request(`/owner/assets/${asset}`))).status).toBe(403);
    }
    const result = await handler(request('/owner/bootstrap', { method: 'HEAD' }));
    expect(result.status).toBe(405); expect(result.headers.get('allow')).toBe('GET, POST');
    expect((await handler(post())).status).toBe(200);
  });
});

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createPublicKey } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../../docs/package.json', import.meta.url));
const { chromium } = require(process.env.DOCS_NODE_MODULES
  ? join(process.env.DOCS_NODE_MODULES, 'playwright') : 'playwright');
const assets = new Map([
  ['/', ['text/html; charset=utf-8', '<!doctype html><meta charset="utf-8"><title>Local Iroh fixture</title><script type="module" src="/client.js"></script>']],
  ['/client.js', ['text/javascript', readFileSync(new URL('./web/client.js', import.meta.url))]],
  ['/generated/carrier.js', ['text/javascript', readFileSync(new URL('./target/browser/carrier.js', import.meta.url))]],
  ['/generated/carrier_bg.wasm', ['application/wasm', readFileSync(new URL('./target/browser/carrier_bg.wasm', import.meta.url))]],
]);

async function staticOrigin() {
  const server = createServer((req, res) => {
    const asset = assets.get(req.url);
    if (req.method !== 'GET' || !asset) return res.writeHead(404).end();
    res.writeHead(200, {
      'Content-Type': asset[0],
      'Content-Security-Policy': "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' ws://127.0.0.1:*; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      'X-Content-Type-Options': 'nosniff',
    }).end(asset[1]);
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, url: `http://localhost:${server.address().port}` };
}

async function bounded(promise, label, ms = 8_000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timeout: ${label}`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

const editor = await staticOrigin();
const wrongOrigin = await staticOrigin(); // Same RP ID, distinct port; browser signs for that wrong origin.
let browser, owner;
const checks = [];
const ok = name => { checks.push(name); console.log(`ok ${name}`); };
try {
  browser = await chromium.launch();
  const context = await browser.newContext();
  await context.route('**/*', route => {
    const origin = new URL(route.request().url()).origin;
    return [editor.url, wrongOrigin.url].includes(origin) ? route.continue() : route.abort();
  });
  const page = await context.newPage();
  const sockets = [];
  page.on('websocket', socket => sockets.push(socket.url()));
  page.on('pageerror', error => console.error(error));
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
    protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
    hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true,
  } });
  const load = async url => { await page.goto(url); await page.waitForFunction(() => window.fixture, { timeout: 8_000 }); };
  await load(editor.url);
  assert.equal(await page.evaluate(() => isSecureContext), true);
  const { origin, credentialId, publicKeySpki } = await bounded(page.evaluate(() => fixture.makeEnrollment()), 'virtual enrollment');
  const { x, y } = createPublicKey({ key: Buffer.from(publicKeySpki, 'base64url'), format: 'der', type: 'spki' }).export({ format: 'jwk' });
  const publicKey = Buffer.concat([Buffer.of(4), Buffer.from(x, 'base64url'), Buffer.from(y, 'base64url')]).toString('base64url');

  owner = spawn(fileURLToPath(new URL('./target/debug/cyberbaser-iroh-editor-carrier', import.meta.url)), {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const events = [];
  const lines = createInterface({ input: owner.stdout });
  lines.on('line', line => { events.push(JSON.parse(line)); });
  const waitFor = async predicate => {
    for (;;) {
      const match = events.find(predicate);
      if (match) return match;
      await once(lines, 'line');
    }
  };
  owner.stdin.write(`${JSON.stringify({ origin, credentialId, publicKey })}\n`);
  const ready = await bounded(waitFor(event => event.ready), 'owner and relay ready');
  assert.equal(ready.ownerIpAddresses, 0);
  const relaySocket = new URL('/relay', ready.relay).href.replace('http:', 'ws:');
  const connect = (slot, ms) => bounded(page.evaluate(([slot, owner, relay]) => fixture.connect(slot, owner, relay),
    [slot, ready.owner, ready.relay]), `connect ${slot}`, ms);
  const close = slot => bounded(page.evaluate(slot => fixture.close(slot), slot), `close ${slot}`);
  const send = (slot, frame) => bounded(page.evaluate(([slot, frame]) => fixture.send(slot, frame), [slot, frame]), 'exchange');
  let id = 0;
  const request = async (slot, body, requestId = ++id) => {
    const reply = await send(slot, { v: 1, id: requestId, body });
    assert.equal(reply.response.id, requestId);
    assert.equal(reply.response.v, 1);
    return reply;
  };
  const code = ({ response }, value) => {
    assert.equal(response.ok, false);
    assert.equal(response.error, value);
  };
  const challenge = async slot => {
    const { response } = await request(slot, { op: 'challenge' });
    assert.equal(response.ok, true);
    return response.result;
  };
  const signFor = (slot, material) => bounded(page.evaluate(([slot, material, id]) => fixture.sign(slot, material, id),
    [slot, material, credentialId]), 'passkey assertion');
  const sign = async slot => signFor(slot, await challenge(slot));
  const submit = { op: 'fake-submit', text: 'synthetic only' };
  const echo = { op: 'echo-read', text: 'hello from wasm' };

  const a = await connect('a');
  assert.deepEqual(await bounded(waitFor(e => e.peer === a.peer), 'native path evidence'), { path: 'relay', peer: a.peer });
  assert.ok(sockets.includes(relaySocket));
  assert.ok(sockets.every(url => url === relaySocket));
  ok('Chromium WASM used only the loopback relay; owner selected relay and advertises no IP');
  code(await request('a', submit), 'principal_required');
  code(await request('a', echo), 'principal_required');
  ok('peer key alone cannot submit or read');

  const b = await connect('b');
  assert.notEqual(a.peer, b.peer);
  const materialA = await challenge('a');
  await assert.rejects(signFor('b', materialA), /challenge does not match this connection/);
  const signedForA = await signFor('a', materialA);
  const signedForB = await sign('b');
  code(await request('b', signedForA), 'invalid_assertion');
  code(await request('b', signedForB), 'no_pending_challenge');
  ok('cross-connection proof rejected; failed verification consumed the pending challenge');

  const invalidSignature = await sign('b');
  const signature = Buffer.from(invalidSignature.signature, 'base64url');
  signature[signature.length - 1] ^= 1;
  code(await request('b', { ...invalidSignature, signature: signature.toString('base64url') }), 'invalid_assertion');
  ok('invalid signature rejected with an otherwise current challenge');
  await close('b');

  const auth = await request('a', signedForA);
  const principal = auth.response.result?.principal;
  assert.deepEqual(Object.keys(principal).sort(), ['authenticatedAt', 'id', 'method', 'sessionId']);
  assert.equal(principal.id, 'fixture-owner');
  assert.equal(principal.method, 'webauthn');
  assert.match(principal.sessionId, /^[\w-]{43}$/);
  assert.ok(Math.abs(principal.authenticatedAt - Math.floor(Date.now() / 1000)) <= 5);
  const accepted = await request('a', submit);
  assert.deepEqual(accepted.response.result, { accepted: true, principal });
  assert.deepEqual((await request('a', echo)).response.result, { text: echo.text });
  ok('real virtual WebAuthn assertion maps to principal; both fake commands succeed');

  code(await request('a', signedForA), 'no_pending_challenge');
  code(await request('a', submit, accepted.response.id), 'duplicate_request');
  ok('same-channel assertion replay and duplicate command id rejected');
  const valid = JSON.stringify({ v: 1, id: ++id, body: echo });
  const limit = 4096;
  assert.equal((await send('a', valid.padEnd(limit))).response.ok, true);
  const oversized = await send('a', valid.padEnd(limit + 1));
  assert.equal(oversized.response.id, null);
  code(oversized, 'frame_too_large');
  code(await send('a', '{'), 'bad_frame');
  assert.equal((await request('a', echo)).response.ok, true);
  ok('4,096-byte frame accepted; 4,097 bytes and malformed JSON rejected without losing session');

  const times = [];
  for (let i = 0; i < 50; i++) {
    const echoResult = await request('a', echo);
    assert.equal(echoResult.response.ok, true);
    times.push(echoResult.ms);
  }
  times.sort((x, y) => x - y);
  const rounded = n => Number(n.toFixed(2));
  await close('a');

  await load(wrongOrigin.url);
  await connect('wrong');
  const wrong = await sign('wrong');
  assert.equal(JSON.parse(Buffer.from(wrong.clientDataJson, 'base64url')).origin, wrongOrigin.url);
  code(await request('wrong', wrong), 'invalid_assertion');
  code(await request('wrong', submit), 'principal_required');
  await close('wrong');
  ok('real assertion from same RP ID but wrong exact origin rejected');

  owner.stdin.write('stop-relay\n');
  await bounded(waitFor(event => event.relayStopped), 'relay shutdown');
  assert.equal(owner.exitCode, null);
  await assert.rejects(connect('offline', 3_000));
  assert.ok(sockets.every(url => url === relaySocket));
  ok('new browser dial fails with only the local relay stopped');
  console.log(JSON.stringify({ checks: checks.length, chromium: browser.version(), unit: 'ms',
    coldDial: rounded(a.ms), warmEcho: { n: times.length, min: rounded(times[0]),
      p50: rounded((times[24] + times[25]) / 2), p95: rounded(times[47]), max: rounded(times.at(-1)) } }));
} finally {
  await browser?.close();
  if (owner && owner.exitCode === null && owner.signalCode === null) {
    const exited = once(owner, 'exit');
    owner.stdin.end('exit\n');
    await bounded(exited, 'owner shutdown', 5_000).catch(() => owner.kill());
  }
  await Promise.all([editor, wrongOrigin].map(({ server }) => new Promise(resolve => server.close(resolve))));
}

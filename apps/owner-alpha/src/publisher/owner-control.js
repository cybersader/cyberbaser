// The owner control socket, beside the publication socket: how the node
// relays what a device needs to approve a publish or change the device list.
// The node can call every operation, and none of them gives it power: a
// challenge is only a one-use number, and every change needs a signature the
// publisher checks against its own list (owner-keys.js).
//
// Requests: one JSON line, {"v":1,"op":...}, at most 16 KiB.
//   status | challenge | keys
//   enroll         {record: {intent, approval}}  first device, by the one-time code
//   change         {record}                      key-add, key-revoke, recovery-reset
//   publish-starter {commit, record}             setup's starter publish.yml, signed
//   publish-bundle  {commit, record}             new notes and images, signed
// Answers: {"ok":true,"result":...} or {"ok":false,"code":...}.
import http from 'node:http';
import { lstat, readFile, unlink } from 'node:fs/promises';
import net from 'node:net';
import { OwnerAlphaError, fail } from '../errors.js';
import { qrSvg } from '../qr.js';
import { READ_TIMEOUT_MS, readFrame, restrictSocket, validSocketPath } from './protocol.js';
import { APPROVAL_PROBLEMS } from './owner-keys.js';
import { BUNDLE_PUBLISH_CODES } from './bundle-publish.js';

export const OWNER_OPERATIONS = Object.freeze(['status', 'challenge', 'keys', 'enroll', 'change', 'publish-starter', 'publish-bundle']);
export const MAX_OWNER_REQUEST_BYTES = 16 * 1024;
export const MAX_OWNER_RESPONSE_BYTES = 64 * 1024;
const COMMIT = /^[0-9a-f]{40}$/u;
export const OWNER_CODES = Object.freeze([...Object.keys(APPROVAL_PROBLEMS), 'owner-invalid-request', 'owner-unsupported', 'owner-failed',
  'starter-refused', 'github-unreachable', ...BUNDLE_PUBLISH_CODES]);

export function ownerSocketPath(socketPath) {
  const candidate = `${socketPath}.owners`;
  if (!validSocketPath(candidate)) fail('publisher-unsafe-socket', 'publisher socket path is too long for its owner control socket');
  return candidate;
}

function validRecord(record) {
  return record !== null && typeof record === 'object' && !Array.isArray(record)
    && Object.keys(record).sort().join(',') === 'approval,intent';
}

function parseOwnerRequest(text) {
  let value;
  try { value = JSON.parse(text); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.v !== 1 || !OWNER_OPERATIONS.includes(value.op)) return null;
  const keys = Object.keys(value).sort().join(',');
  if (['status', 'challenge', 'keys'].includes(value.op)) return keys === 'op,v' ? value : null;
  if (['enroll', 'change'].includes(value.op)) return keys === 'op,record,v' && validRecord(value.record) ? value : null;
  return keys === 'commit,op,record,v' && COMMIT.test(value.commit ?? '') && validRecord(value.record) ? value : null;
}

function failureCode(error) {
  return error instanceof OwnerAlphaError && OWNER_CODES.includes(error.code) ? error.code : 'owner-failed';
}

/**
 * ownerKeys: createOwnerKeys(...). publishStarter: async ({commit, record})
 * or null when this publisher pushes no starter file.
 */
export async function startOwnerControl({ socketPath, ownerKeys, uid = process.getuid(), socketGroup = null, publishStarter = null,
  publishBundle = null }) {
  const address = ownerSocketPath(socketPath);
  try {
    const present = await lstat(address);
    if (!present.isSocket() || present.uid !== uid) fail('publisher-socket-in-use', 'owner control path is occupied');
    await unlink(address);
  } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  let open = 0;
  const server = net.createServer((socket) => {
    socket.on('error', () => socket.destroy());
    const reply = (value) => socket.end(`${JSON.stringify(value)}\n`, () => socket.destroy());
    if (open >= 4) return reply({ ok: false, code: 'owner-busy' });
    open += 1;
    socket.once('close', () => { open -= 1; });
    const timer = setTimeout(() => { stop(); reply({ ok: false, code: 'owner-invalid-request' }); }, READ_TIMEOUT_MS);
    const stop = readFrame(socket, async (text) => {
      clearTimeout(timer);
      const request = parseOwnerRequest(text);
      if (request === null) return reply({ ok: false, code: 'owner-invalid-request' });
      let result;
      try {
        switch (request.op) {
          case 'status': result = await ownerKeys.status(); break;
          case 'challenge': result = await ownerKeys.challenge(); break;
          case 'keys': result = await ownerKeys.list(); break;
          case 'enroll': result = await ownerKeys.enroll(request.record); break;
          case 'change': result = await ownerKeys.change(request.record); break;
          case 'publish-bundle':
            if (publishBundle === null) throw new OwnerAlphaError('owner-unsupported', 'this publisher pushes no page bundles');
            result = await publishBundle({ commit: request.commit, record: request.record });
            break;
          default:
            if (publishStarter === null) throw new OwnerAlphaError('owner-unsupported', 'this publisher pushes no starter file');
            result = await publishStarter({ commit: request.commit, record: request.record });
        }
      } catch (error) {
        return reply({ ok: false, code: failureCode(error) });
      }
      if (!socket.destroyed) reply({ ok: true, result });
    }, () => { clearTimeout(timer); reply({ ok: false, code: 'owner-invalid-request' }); }, { maxBytes: MAX_OWNER_REQUEST_BYTES });
  });
  server.on('error', () => {});
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ path: address, backlog: 8 }, () => { server.off('error', reject); resolve(); });
  });
  await restrictSocket(address, uid, socketGroup);
  return Object.freeze({
    address,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      try { await unlink(address); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    },
  });
}

/** The node's side: one owner-control request. Never carries a credential. */
export function ownerRequest({ socketPath, op, record, commit, timeoutMs = op.startsWith('publish-') ? 120_000 : 20_000 }) {
  const frame = op === 'enroll' || op === 'change' ? { v: 1, op, record }
    : op === 'publish-starter' || op === 'publish-bundle' ? { v: 1, op, commit, record } : { v: 1, op };
  const text = JSON.stringify(frame);
  if (!OWNER_OPERATIONS.includes(op) || parseOwnerRequest(text) === null || Buffer.byteLength(text) >= MAX_OWNER_REQUEST_BYTES) {
    return Promise.reject(new OwnerAlphaError('owner-invalid-request', 'invalid owner request'));
  }
  const address = ownerSocketPath(socketPath);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: address });
    let settled = false;
    const settle = (action, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stopReading();
      socket.destroy();
      action(value);
    };
    const unavailable = () => settle(reject, new OwnerAlphaError('publisher-unavailable', 'the publisher is not running'));
    const invalid = () => settle(reject, new OwnerAlphaError('owner-failed', 'publisher owner response was invalid'));
    const timer = setTimeout(unavailable, timeoutMs);
    const stopReading = readFrame(socket, (line) => {
      let value;
      try { value = JSON.parse(line); } catch { return invalid(); }
      if (value?.ok === true && value.result && typeof value.result === 'object') return settle(resolve, value.result);
      if (value?.ok === false && OWNER_CODES.includes(value.code)) {
        return settle(reject, new OwnerAlphaError(value.code, APPROVAL_PROBLEMS[value.code] ?? 'owner request refused'));
      }
      return invalid();
    }, invalid, { maxBytes: MAX_OWNER_RESPONSE_BYTES });
    socket.once('connect', () => socket.write(`${text}\n`));
    socket.once('error', unavailable);
    socket.once('end', unavailable);
    socket.once('close', unavailable);
  });
}

// --- The first-device code on a page only the owner's browser can read -----
//
// The publisher serves the code (QR and text) on 127.0.0.1:<port>. The node
// must not learn it, or it could enroll its own key, so:
//   - only explicitly authorized local UIDs may see the code, using the
//     established client socket's full tuple in the kernel tables;
//   - the Host header must be the loopback address itself (no DNS rebinding);
//   - no CORS headers, and fetch/XHR requests are refused, so a page the node
//     serves can show the code in an <img> or <iframe> but cannot read it.
// The node can at worst show a different code. That only fails: enrollment
// needs the real code, and the device trusts the publisher key only after the
// publisher proves it holds the same code (README, "Enrollment").

// procfs prints each 32-bit address word in the kernel's native endianness.
const littleEndian = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
const mapped = '00000000000000000000FFFF';
export function validEnrollUid(uid) {
  return Number.isInteger(uid) && uid >= 0 && uid < 0xffffffff && uid !== 65534;
}

function addressHex(address) {
  const family = net.isIP(address);
  const v4 = (value) => Buffer.from(value.split('.').map(Number)).toString('hex').toUpperCase();
  if (family === 4) return v4(address);
  if (family !== 6 || address.includes('%')) return null;
  let hex;
  try {
    // WHATWG URL canonicalizes dotted IPv4-mapped tails to hex groups.
    const host = new URL(`http://[${address}]/`).hostname.slice(1, -1);
    const [left, right] = host.split('::');
    const before = left ? left.split(':') : [];
    const after = right ? right.split(':') : [];
    const groups = right === undefined ? before : [...before, ...Array(8 - before.length - after.length).fill('0'), ...after];
    hex = groups.map((part) => part.padStart(4, '0')).join('').toUpperCase();
  } catch { return null; }
  return hex.startsWith(mapped) ? hex.slice(mapped.length) : hex;
}

/** The unique established client socket's UID in this netns, or null. */
export async function loopbackPeerUid({ clientAddress, clientPort, serverAddress, serverPort, read = (file) => readFile(file, 'utf8') }) {
  const client = addressHex(clientAddress);
  const server = addressHex(serverAddress);
  const loopback = (address) => address !== null && (address.length === 8 ? address.startsWith('7F') : address === '00000000000000000000000000000001');
  if (!loopback(client) || !loopback(server) || client.length !== server.length
      || ![clientPort, serverPort].every((p) => Number.isInteger(p) && p > 0 && p <= 65535)) return null;
  const endpoint = (address, port, length) => {
    const hex = length === 32 && address.length === 8 ? mapped + address : address;
    if (hex.length !== length) return null;
    const words = hex.match(/.{8}/gu).map((word) => littleEndian ? word.match(/../gu).reverse().join('') : word);
    return `${words.join('')}:${port.toString(16).toUpperCase().padStart(4, '0')}`;
  };
  try {
    const [v4, v6, overflowText] = await Promise.all([
      read('/proc/net/tcp'), read('/proc/net/tcp6'), read('/proc/sys/kernel/overflowuid'),
    ]);
    const overflow = overflowText.trim();
    if (!/^\d+$/u.test(overflow) || Number(overflow) >= 0xffffffff) return null;
    const matches = [];
    for (const [text, length] of [[v4, 8], [v6, 32]]) {
      const local = endpoint(client, clientPort, length);
      const remote = endpoint(server, serverPort, length);
      if (local === null || remote === null) continue;
      for (const line of text.split('\n').slice(1)) {
        const fields = line.trim().split(/\s+/u);
        if (fields[1] === local && fields[2] === remote && fields[3] === '01') matches.push(fields[7]);
      }
    }
    if (matches.length !== 1 || !/^\d+$/u.test(matches[0] ?? '')) return null;
    const uid = Number(matches[0]);
    return validEnrollUid(uid) && uid !== Number(overflow) ? uid : null;
  } catch { return null; }
}

function page(display) {
  if (display === null) {
    return '<!doctype html><meta charset="utf-8"><title>Cyberbaser</title><body style="font:16px system-ui;margin:2rem">'
      + '<p>A device can already publish, or the setup code expired. An administrator can make a new code with '
      + '<code>cyberbaser publisher enroll-code</code>.</p></body>';
  }
  const until = new Date(display.expiresAt).toISOString().slice(11, 16);
  return `<!doctype html><meta charset="utf-8"><title>Set up your publishing device</title><body style="font:16px system-ui;margin:2rem;max-width:28rem">`
    + `<h1 style="font-size:1.2rem">Scan with the device that will approve publishing</h1>`
    + `<div style="width:16rem">${qrSvg(display.uri, { title: 'Publishing setup code' })}</div>`
    + `<p>Or type this code: <strong style="font-family:monospace">${display.code}</strong></p>`
    + `<p style="color:#555">Shown by the publisher itself, not by the web app. Valid until ${until} UTC, for one device.</p></body>`;
}

export async function startEnrollPage({ ownerKeys, port, host = '127.0.0.1', authorizedUids = [], peerUid = loopbackPeerUid }) {
  if (!Array.isArray(authorizedUids) || !authorizedUids.every(validEnrollUid)) {
    throw new TypeError('enrollment requires an explicit list of valid local UIDs');
  }
  const allowed = new Set(authorizedUids);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || !['127.0.0.1', 'localhost'].includes(host)) {
    fail('publisher-unsafe-socket', 'the enrollment page binds one loopback port');
  }
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const server = http.createServer(async (request, response) => {
    const deny = (status) => { response.writeHead(status, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); response.end(); };
    try {
      if (request.method !== 'GET' || !hosts.has(request.headers.host ?? '')) return deny(421);
      const mode = request.headers['sec-fetch-mode'];
      if (request.headers.origin !== undefined || mode === 'cors' || mode === 'same-origin') return deny(403);
      if (allowed.size === 0) return deny(403);
      const socket = request.socket;
      const uid = await peerUid({ clientAddress: socket.remoteAddress, clientPort: socket.remotePort,
        serverAddress: socket.localAddress, serverPort: socket.localPort });
      if (!validEnrollUid(uid) || !allowed.has(uid)) return deny(403);
      const url = new URL(request.url, `http://127.0.0.1:${port}`);
      if (!['/enroll', '/enroll.svg'].includes(url.pathname) || url.search !== '') return deny(404);
      const display = await ownerKeys.enrollmentDisplay();
      const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        'Cross-Origin-Resource-Policy': 'cross-origin', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:" };
      if (url.pathname === '/enroll.svg') {
        if (display === null) return deny(410);
        response.writeHead(200, { ...headers, 'Content-Type': 'image/svg+xml' });
        return response.end(qrSvg(display.uri, { title: 'Publishing setup code' }));
      }
      response.writeHead(display === null ? 410 : 200, { ...headers, 'Content-Type': 'text/html; charset=utf-8' });
      return response.end(page(display));
    } catch {
      return deny(500);
    }
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port, host: '127.0.0.1' }, () => { server.off('error', reject); resolve(); });
  });
  return Object.freeze({
    port,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  });
}

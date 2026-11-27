// The forge control socket: how the web-facing node asks the publisher to sign
// in to the forge, list repositories, bind one, report status or disconnect.
// It sits beside the publication socket, in the same owner-only directory, and
// never carries a credential in either direction: requests name an operation,
// responses carry only ForgeAccess's plain status and repository rows.
import { lstat, unlink } from 'node:fs/promises';
import net from 'node:net';
import { OwnerAlphaError, fail } from '../errors.js';
import { FORGE_PROBLEMS, validFullName } from './forge-access.js';
import { validCallbackOrigin, validCode, validState } from './github-app-manifest.js';
import { MAX_FRAME_BYTES, READ_TIMEOUT_MS, readFrame, restrictSocket, validSocketPath } from './protocol.js';

// fetch: the publisher refreshes its mirror of the bound repository and says
// which branch and commit it holds. publish-starter: the one change a
// first-run publisher may push (see mirror.js), named by its commit.
// The GitHub App manifest flow (github-app-manifest.js): new-app, install-app,
// app-installed and web-sign-in carry the setup page's loopback origin and
// answer with a GitHub URL (and the manifest); app-created and app-authorized
// carry GitHub's code and our state back. None carries a secret either way.
export const FORGE_OPERATIONS = Object.freeze(['status', 'check', 'start', 'cancel', 'repositories', 'select', 'disconnect',
  'fetch', 'publish-starter', 'new-app', 'app-created', 'install-app', 'app-installed', 'web-sign-in', 'app-authorized']);
const ORIGIN_OPS = Object.freeze(['new-app', 'install-app', 'app-installed', 'web-sign-in']);
const CODE_OPS = Object.freeze(['app-created', 'app-authorized']);
const COMMIT = /^[0-9a-f]{40}$/u;
export const MAX_FORGE_RESPONSE_BYTES = 512 * 1024;
const FORGE_CODES = Object.freeze([...Object.keys(FORGE_PROBLEMS), 'forge-invalid-request', 'forge-unsupported', 'forge-failed', 'forge-busy']);

export function forgeSocketPath(socketPath) {
  const candidate = `${socketPath}.forge`;
  if (!validSocketPath(candidate)) fail('publisher-unsafe-socket', 'publisher socket path is too long for its forge control socket');
  return candidate;
}

function requestFrame(op, fields = {}) {
  if (op === 'select') return JSON.stringify({ v: 1, op, repository: fields.repository });
  if (op === 'publish-starter') return JSON.stringify({ v: 1, op, commit: fields.commit });
  if (ORIGIN_OPS.includes(op)) return JSON.stringify({ v: 1, op, origin: fields.origin });
  if (CODE_OPS.includes(op)) return JSON.stringify({ v: 1, op, code: fields.code, state: fields.state });
  return JSON.stringify({ v: 1, op });
}

function validFields(op, fields) {
  if (op === 'select') return validFullName(fields.repository);
  if (op === 'publish-starter') return COMMIT.test(fields.commit ?? '');
  if (ORIGIN_OPS.includes(op)) return validCallbackOrigin(fields.origin);
  if (CODE_OPS.includes(op)) return validCode(fields.code) && validState(fields.state);
  return true;
}

// Exact canonical text only: no duplicate members, no extra whitespace or keys.
function parseForgeRequest(text) {
  let value;
  try { value = JSON.parse(text); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value) || !FORGE_OPERATIONS.includes(value.op)) return null;
  if (!validFields(value.op, value)) return null;
  return requestFrame(value.op, value) === text ? value : null;
}

function failureCode(error) {
  if (error instanceof OwnerAlphaError && FORGE_CODES.includes(error.code)) return error.code;
  return 'forge-failed';
}

// mirror: createMirror(...) for fetch; checkout: the node's notes copy, the
// only place a starter commit is read from. Either may be null (no such ops).
// starterSigned: the starter file needs the owner's signature (owner-control.js
// publish-starter), so this unsigned operation is refused.
export async function startForgeControl({ socketPath, forgeAccess, uid = process.getuid(), socketGroup = null, mirror = null,
  starterCheckout = null, starterSigned = false }) {
  const address = forgeSocketPath(socketPath);
  // The caller holds the publisher's socket lifetime lock in this owner-only
  // directory, so a leftover socket of ours here is stale.
  try {
    const present = await lstat(address);
    if (!present.isSocket() || present.uid !== uid) fail('publisher-socket-in-use', 'forge control path is occupied');
    await unlink(address);
  } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  let open = 0;
  const server = net.createServer((socket) => {
    socket.on('error', () => socket.destroy());
    const reply = (value) => socket.end(`${JSON.stringify(value)}\n`, () => socket.destroy());
    if (open >= 4) return reply({ ok: false, code: 'forge-busy' });
    open += 1;
    socket.once('close', () => { open -= 1; });
    const timer = setTimeout(() => { stop(); reply({ ok: false, code: 'forge-invalid-request' }); }, READ_TIMEOUT_MS);
    const stop = readFrame(socket, async (text) => {
      clearTimeout(timer);
      const request = parseForgeRequest(text);
      if (request === null) return reply({ ok: false, code: 'forge-invalid-request' });
      let result;
      try {
        if (forgeAccess === null) throw new OwnerAlphaError('forge-unsupported', 'no forge access configured');
        switch (request.op) {
          case 'status': result = await forgeAccess.status(); break;
          case 'check': result = await forgeAccess.status({ check: true }); break;
          case 'start': result = await forgeAccess.startSignIn(); break;
          case 'cancel': await forgeAccess.cancelSignIn(); result = {}; break;
          case 'repositories': result = await forgeAccess.listRepositories(); break;
          case 'fetch': {
            if (mirror === null) throw new OwnerAlphaError('forge-unsupported', 'this publisher keeps no mirror');
            const held = await mirror.refresh();
            result = { repository: held.repository, branch: held.branch, head: held.head };
            break;
          }
          case 'publish-starter': {
            if (mirror === null || starterCheckout === null || starterSigned) {
              throw new OwnerAlphaError('forge-unsupported', 'the starter file needs the owner\'s signed approval');
            }
            result = await mirror.publishStarter({ checkout: starterCheckout, commit: request.commit });
            break;
          }
          case 'select': result = await forgeAccess.selectRepository(request.repository); break;
          case 'new-app': case 'app-created': case 'install-app': case 'app-installed': case 'web-sign-in': case 'app-authorized': {
            if (typeof forgeAccess.newApp !== 'function') throw new OwnerAlphaError('forge-unsupported', 'this provider has no GitHub App flow');
            if (request.op === 'new-app') result = await forgeAccess.newApp(request.origin);
            else if (request.op === 'app-created') result = await forgeAccess.appCreated(request.code, request.state);
            else if (request.op === 'install-app') result = await forgeAccess.installApp(request.origin);
            else if (request.op === 'app-installed') result = await forgeAccess.appInstalled(request.origin);
            else if (request.op === 'web-sign-in') result = await forgeAccess.webSignIn(request.origin);
            else result = await forgeAccess.appAuthorized(request.code, request.state);
            break;
          }
          default: await forgeAccess.disconnect(); result = {};
        }
      } catch (error) {
        return reply({ ok: false, code: failureCode(error) });
      }
      if (!socket.destroyed) reply({ ok: true, result });
    }, () => { clearTimeout(timer); reply({ ok: false, code: 'forge-invalid-request' }); }, { maxBytes: MAX_FRAME_BYTES });
  });
  server.on('error', () => {});
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ path: address, backlog: 8 }, () => { server.off('error', reject); resolve(); });
  });
  // Same access as the publication socket beside it.
  await restrictSocket(address, uid, socketGroup);
  return Object.freeze({
    address,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      try { await unlink(address); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    },
  });
}

/** Ask the publisher one forge question. Never sends or expects a credential. */
export function forgeRequest({ socketPath, op, repository, commit, origin, code, state,
  timeoutMs = ['fetch', 'publish-starter'].includes(op) ? 120_000 : 20_000 }) {
  const fields = { repository, commit, origin, code, state };
  if (!FORGE_OPERATIONS.includes(op) || !validFields(op, fields)) {
    return Promise.reject(new OwnerAlphaError('forge-invalid-request', 'invalid forge request'));
  }
  const address = forgeSocketPath(socketPath);
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
    const invalid = () => settle(reject, new OwnerAlphaError('forge-failed', 'publisher forge response was invalid'));
    const timer = setTimeout(unavailable, timeoutMs);
    const stopReading = readFrame(socket, (text) => {
      let value;
      try { value = JSON.parse(text); } catch { return invalid(); }
      if (value?.ok === true && value.result && typeof value.result === 'object') return settle(resolve, value.result);
      if (value?.ok === false && FORGE_CODES.includes(value.code)) {
        return settle(reject, new OwnerAlphaError(value.code, FORGE_PROBLEMS[value.code] ?? 'forge request refused'));
      }
      return invalid();
    }, invalid, { maxBytes: MAX_FORGE_RESPONSE_BYTES });
    socket.once('connect', () => socket.write(`${requestFrame(op, fields)}\n`));
    socket.once('error', unavailable);
    socket.once('end', unavailable);
    socket.once('close', unavailable);
  });
}

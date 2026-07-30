import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isIP } from 'node:net';
import {
  assertIgnoredPath,
  attemptPaths,
  loadOwnerDogfoodSeries,
  renderExpectedReaderForm,
  verifyAttemptWorkspace,
} from './pilot-workspace.js';
import { validateAttemptId, validateOperator } from './pilot-input.js';

const DEFAULT_EXPIRES_MINUTES = 15;
const MAX_EXPIRES_MINUTES = 60;
const OPERATOR_MAX_BYTES = 128 * 1024;
const FORM_MAX_BYTES = 256 * 1024;
const STATUS_MAX_BYTES = 1024 * 1024;
const STATUS_TIMEOUT_MS = 5_000;
const FORM_CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; font-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'";

export class DogfoodReaderServerError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'DogfoodReaderServerError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new DogfoodReaderServerError(code, message, details);
}

function sameOpenedFile(before, after) {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mtimeNs === after.mtimeNs
    && before.ctimeNs === after.ctimeNs;
}

async function readNoFollowRegularFile(file, { label, maxBytes }) {
  let handle;
  try {
    handle = await open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) fail(`invalid-${label}`, `${label} must be a regular file`);
    if (before.nlink !== 1n) fail(`invalid-${label}`, `${label} must not be hard-linked`);
    if (before.size > BigInt(maxBytes)) fail(`${label}-too-large`, `${label} exceeds its byte limit`);
    const bytes = Buffer.from(await handle.readFile());
    const after = await handle.stat({ bigint: true });
    if (!sameOpenedFile(before, after) || BigInt(bytes.byteLength) !== before.size) {
      fail(`${label}-changed`, `${label} changed while it was being read`);
    }
    return bytes;
  } catch (error) {
    if (error instanceof DogfoodReaderServerError) throw error;
    if (error?.code === 'ELOOP') {
      fail('workspace-symlink-rejected', 'pilot workspace components must not be symbolic links');
    }
    fail(`invalid-${label}`, `${label} must be a readable regular file`);
  } finally {
    await handle?.close();
  }
}

export function parseExpiresMinutes(value = String(DEFAULT_EXPIRES_MINUTES)) {
  if (!/^(?:[1-9]|[1-5][0-9]|60)$/u.test(value)) {
    fail(
      'invalid-expires-minutes',
      `expires-minutes must be a whole number from 1 through ${MAX_EXPIRES_MINUTES}`,
    );
  }
  return Number(value);
}

export async function loadDogfoodReaderSnapshot(attemptIdInput, {
  projectRoot,
  workspaceRoot,
} = {}) {
  const attemptId = validateAttemptId(attemptIdInput);
  if (!attemptId.startsWith('OD-')) {
    fail('dogfood-attempt-id-required', 'dogfood:serve requires an OD-01 through OD-99 attempt ID');
  }
  const workspaceOptions = {
    ...(projectRoot === undefined ? {} : { projectRoot }),
    ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
  };
  const series = await loadOwnerDogfoodSeries(workspaceOptions);
  if (!series.attemptIds.includes(attemptId)) {
    fail('dogfood-attempt-not-declared', `${attemptId} is not declared in the owner self-dogfood series`);
  }
  const paths = attemptPaths(attemptId, workspaceOptions);
  await verifyAttemptWorkspace(paths);
  await assertIgnoredPath(paths.operator, paths.projectRoot);
  await assertIgnoredPath(paths.readerForm, paths.projectRoot);

  const operatorBytes = await readNoFollowRegularFile(paths.operator, {
    label: 'dogfood-operator',
    maxBytes: OPERATOR_MAX_BYTES,
  });
  let operatorInput;
  try {
    operatorInput = JSON.parse(operatorBytes.toString('utf8'));
  } catch {
    fail('invalid-dogfood-operator', 'dogfood operator must contain readable JSON');
  }
  const operator = validateOperator(operatorInput);
  if (operator.attemptId !== attemptId || operator.profile !== 'owner-self-dogfood') {
    fail('dogfood-operator-mismatch', 'dogfood operator must match the requested owner-self-dogfood attempt');
  }

  const bytes = await readNoFollowRegularFile(paths.readerForm, {
    label: 'reader-form',
    maxBytes: FORM_MAX_BYTES,
  });
  const expectedBytes = Buffer.from(
    await renderExpectedReaderForm(attemptId, operator.profile),
    'utf8',
  );
  if (!bytes.equals(expectedBytes)) {
    fail(
      'reader-form-integrity-mismatch',
      'reader form bytes no longer match the canonical generated instrument',
    );
  }
  return Object.freeze({
    attemptId,
    bytes,
    byteLength: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
}

async function readBoundedStream(stream, maxBytes) {
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) fail('tailscale-status-too-large', 'tailscale status output exceeded its byte limit');
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total).toString('utf8');
}

export async function runTailscaleStatusCommand({
  spawn = Bun.spawn,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  timeoutMs = STATUS_TIMEOUT_MS,
  maxBytes = STATUS_MAX_BYTES,
} = {}) {
  let child;
  let timedOut = false;
  try {
    child = spawn(['tailscale', 'status', '--json'], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const timer = setTimer(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        readBoundedStream(child.stdout, maxBytes),
        readBoundedStream(child.stderr, maxBytes),
        child.exited,
      ]);
      if (timedOut) fail('tailscale-status-timeout', 'tailscale status did not complete in time');
      if (exitCode !== 0) {
        fail('tailscale-status-failed', 'tailscale status failed', {
          stderr: stderr.trim().slice(0, 1_000),
        });
      }
      return stdout;
    } finally {
      clearTimer(timer);
    }
  } catch (error) {
    child?.kill();
    if (error instanceof DogfoodReaderServerError) throw error;
    fail('tailscale-status-unavailable', 'tailscale status could not be executed');
  }
}

function isTailscaleIpv4(value) {
  if (isIP(value) !== 4) return false;
  const [first, second] = value.split('.').map(Number);
  return first === 100 && second >= 64 && second <= 127;
}

function normalizedMagicDns(value) {
  if (typeof value !== 'string') return null;
  const dnsName = value.replace(/\.$/u, '').toLowerCase();
  if (dnsName.length === 0 || dnsName.length > 253) return null;
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u.test(dnsName)) {
    return null;
  }
  if (!dnsName.endsWith('.ts.net') && !dnsName.endsWith('.tailscale.net')) return null;
  return dnsName;
}

export async function discoverTailscaleSelf({ runStatus = runTailscaleStatusCommand } = {}) {
  let status;
  try {
    status = JSON.parse(await runStatus());
  } catch (error) {
    if (error instanceof DogfoodReaderServerError) throw error;
    fail('tailscale-status-invalid', 'tailscale status must return readable JSON');
  }
  if (status?.BackendState !== 'Running' || status?.Self?.Online !== true) {
    fail('tailscale-not-online', 'the local Tailscale node must be running and online');
  }
  const addresses = Array.isArray(status.Self.TailscaleIPs) ? status.Self.TailscaleIPs : [];
  const ipv4Addresses = addresses.filter((address) => isIP(address) === 4);
  if (ipv4Addresses.length !== 1 || !isTailscaleIpv4(ipv4Addresses[0])) {
    fail('tailscale-ip-invalid', 'the local node must report exactly one Tailscale IPv4 address');
  }
  return Object.freeze({
    ipv4: ipv4Addresses[0],
    dnsName: normalizedMagicDns(status.Self.DNSName),
  });
}

function responseHeaders(byteLength) {
  return {
    'Cache-Control': 'private, no-store, max-age=0',
    'Content-Length': String(byteLength),
    'Content-Security-Policy': FORM_CSP,
    'Content-Type': 'text/html; charset=utf-8',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Pragma': 'no-cache',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  };
}

export function createDogfoodReaderHandler({
  bytes,
  routePath,
  allowedHostnames,
  port,
  onServed = () => {},
}) {
  const snapshot = Buffer.from(bytes);
  const hosts = new Set(allowedHostnames.map((value) => value.toLowerCase()));
  const headers = responseHeaders(snapshot.byteLength);
  let consumed = false;
  return function handleDogfoodReaderRequest(request) {
    const url = new URL(request.url);
    if (!hosts.has(url.hostname.toLowerCase()) || url.port !== String(port)) {
      return new Response('Not found\n', { status: 404 });
    }
    if (url.pathname !== routePath || url.search !== '' || url.hash !== '') {
      return new Response('Not found\n', { status: 404 });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed\n', {
        status: 405,
        headers: { Allow: 'GET, HEAD' },
      });
    }
    const contentLength = request.headers.get('content-length');
    if (request.body !== null
      || request.headers.has('transfer-encoding')
      || (contentLength !== null && contentLength !== '0')) {
      return new Response('Request body not allowed\n', { status: 400 });
    }
    if (request.method === 'HEAD') return new Response(null, { status: 200, headers });
    if (consumed) return new Response('Not found\n', { status: 404 });
    consumed = true;
    queueMicrotask(onServed);
    return new Response(snapshot, { status: 200, headers });
  };
}

export function createRouteToken() {
  return randomBytes(32).toString('base64url');
}

export function startDogfoodReaderServer({
  snapshot,
  tailscale,
  expiresMinutes = DEFAULT_EXPIRES_MINUTES,
  routeTokenFactory = createRouteToken,
  serverFactory = (options) => Bun.serve(options),
  signalSource = process,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  now = Date.now,
  queueTask = queueMicrotask,
} = {}) {
  const normalizedExpires = parseExpiresMinutes(String(expiresMinutes));
  const routeToken = routeTokenFactory();
  if (!/^[A-Za-z0-9_-]{43}$/u.test(routeToken)) {
    fail('invalid-route-token', 'the generated route token is invalid');
  }
  const routePath = `/${routeToken}`;
  let handler;
  const server = serverFactory({
    hostname: tailscale.ipv4,
    port: 0,
    maxRequestBodySize: 1,
    fetch(request) {
      if (!handler) return new Response('Unavailable\n', { status: 503 });
      return handler(request);
    },
  });
  const allowedHostnames = [tailscale.ipv4, ...(tailscale.dnsName ? [tailscale.dnsName] : [])];
  let timer;
  let stopPromise;
  let resolveCompletion;
  let rejectCompletion;
  const completion = new Promise((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  const signals = ['SIGINT', 'SIGTERM'];
  const installedSignals = [];
  const removeLifecycle = () => {
    if (timer !== undefined) clearTimer(timer);
    for (const signal of installedSignals) signalSource.off(signal, signalHandlers[signal]);
  };
  const stop = (reason, force = false) => {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      removeLifecycle();
      try {
        await Promise.resolve(server.stop(force));
        const outcome = Object.freeze({ reason });
        resolveCompletion(outcome);
        return outcome;
      } catch (error) {
        rejectCompletion(error);
        throw error;
      }
    })();
    return stopPromise;
  };
  const signalHandlers = Object.fromEntries(signals.map((signal) => [
    signal,
    () => { void stop(signal.toLowerCase(), true); },
  ]));
  handler = createDogfoodReaderHandler({
    bytes: snapshot.bytes,
    routePath,
    allowedHostnames,
    port: server.port,
    onServed: () => queueTask(() => { void stop('served', false); }),
  });
  const expiresAt = now() + normalizedExpires * 60_000;
  try {
    for (const signal of signals) {
      signalSource.on(signal, signalHandlers[signal]);
      installedSignals.push(signal);
    }
    timer = setTimer(() => { void stop('expired', true); }, normalizedExpires * 60_000);
  } catch (error) {
    removeLifecycle();
    try { void Promise.resolve(server.stop(true)); } catch {}
    throw error;
  }

  const ipUrl = `http://${tailscale.ipv4}:${server.port}${routePath}`;
  const dnsUrl = tailscale.dnsName
    ? `http://${tailscale.dnsName}:${server.port}${routePath}`
    : null;
  return Object.freeze({
    port: server.port,
    ipUrl,
    dnsUrl,
    expiresAt,
    completion,
    stop,
  });
}

export async function prepareDogfoodReaderServer({
  attemptId,
  expiresMinutes = DEFAULT_EXPIRES_MINUTES,
  snapshotOptions,
  discoveryOptions,
  serverOptions,
} = {}) {
  const normalizedExpires = parseExpiresMinutes(String(expiresMinutes));
  const snapshot = await loadDogfoodReaderSnapshot(attemptId, snapshotOptions);
  const tailscale = await discoverTailscaleSelf(discoveryOptions);
  const running = startDogfoodReaderServer({
    snapshot,
    tailscale,
    expiresMinutes: normalizedExpires,
    ...serverOptions,
  });
  return Object.freeze({ snapshot, tailscale, ...running });
}

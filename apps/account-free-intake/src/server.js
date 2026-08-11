import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  AccountFreeIntakeError,
  correctionIntentDigest,
  createBareGitObjectResolver,
  createRetainedSourceBindingResolver,
  deriveAccountFreeProposal,
  validateCorrectionIntent,
} from '@cyberbaser/account-free-intake';
import { openProposalQueue, ProposalQueueError } from '@cyberbaser/proposal-queue';
import { createGlobalAbuseLimiter } from './abuse.js';
import { validateRuntimePaths } from './config.js';

const SECURITY_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'Permissions-Policy': 'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
});

const SOURCE_RESOLUTION_CODES = new Set([
  'repository-binding-mismatch',
  'source-binding-mismatch',
  'trust-policy-binding-mismatch',
  'git-object-not-commit',
  'git-object-not-blob',
  'git-revision-mismatch',
  'unsupported-source-object',
  'invalid-git-tree-entry',
]);
const QUEUE_CAPACITY_CODES = new Set([
  'queue-pending-capacity',
  'queue-source-capacity',
  'queue-retained-capacity',
]);
const CONTRACT_422_CODES = new Set([
  'quote-not-found',
  'quote-ambiguous',
  'correction-quote-not-found',
  'correction-quote-ambiguous',
  'unresolvable-binding',
]);

class RequestError extends Error {
  constructor(code, status) {
    super(code);
    this.name = 'RequestError';
    this.code = code;
    this.status = status;
  }
}

function requestFail(code, status) {
  throw new RequestError(code, status);
}

function utcSecond(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  const milliseconds = date.getTime();
  if (!Number.isFinite(milliseconds)) throw new Error('clock returned an invalid time');
  return new Date(milliseconds).toISOString().replace(/\.\d{3}Z$/u, 'Z');
}

function createDeadline(timeoutMs, now = () => performance.now()) {
  const expiresAt = now() + timeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  return Object.freeze({
    signal: controller.signal,
    remaining() {
      return Math.max(0, expiresAt - now());
    },
    assert() {
      if (controller.signal.aborted || now() >= expiresAt) requestFail('request-deadline', 503);
    },
    async race(promise, onTimeout) {
      this.assert();
      let timeout;
      try {
        return await Promise.race([
          promise,
          new Promise((_, reject) => {
            timeout = setTimeout(() => {
              reject(new RequestError('request-deadline', 503));
              onTimeout?.();
            }, this.remaining());
            timeout.unref?.();
          }),
        ]);
      } finally {
        clearTimeout(timeout);
      }
    },
    close() {
      clearTimeout(timer);
    },
  });
}

function executeGitWithDeadline(deadline) {
  return ({ command, args, maxBytes, env }) => deadline.race(new Promise((resolve, reject) => {
    execFile(command, args, {
      encoding: 'buffer',
      env,
      maxBuffer: maxBytes,
      signal: deadline.signal,
      windowsHide: true,
    }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout, exitCode: 0 });
    });
  }));
}

function responseHeaders({ origin = null, cors = false, extra = {} } = {}) {
  const headers = new Headers(SECURITY_HEADERS);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  if (cors) {
    headers.set('Vary', 'Origin');
    if (origin !== null) headers.set('Access-Control-Allow-Origin', origin);
  }
  for (const [name, value] of Object.entries(extra)) headers.set(name, value);
  return headers;
}

function jsonResponse(value, status, options = {}) {
  return new Response(`${JSON.stringify(value)}\n`, {
    status,
    headers: responseHeaders(options),
  });
}

function emptyResponse(status, options = {}) {
  const headers = responseHeaders(options);
  headers.delete('Content-Type');
  return new Response(null, { status, headers });
}

function publicError(error) {
  if (error instanceof RequestError) return { status: error.status, code: error.code };
  const code = error?.code;
  if (code === 'stale-publication' || code === 'idempotency-conflict') return { status: 409, code };
  if (CONTRACT_422_CODES.has(code)) return { status: 422, code };
  if (SOURCE_RESOLUTION_CODES.has(code)) return { status: 422, code: 'unresolvable-binding' };
  if (QUEUE_CAPACITY_CODES.has(code)) return { status: 503, code: 'queue-capacity' };
  if (error instanceof AccountFreeIntakeError) return { status: 400, code };
  if (error instanceof ProposalQueueError) return { status: 500, code: 'internal-error' };
  if (code === 'quote-not-found' || code === 'quote-ambiguous') return { status: 422, code };
  return { status: 500, code: 'internal-error' };
}

function hasForbiddenBody(request) {
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null && contentLength !== '0') return true;
  if (request.headers.has('transfer-encoding')) return true;
  return request.body !== null;
}

function requireExactHost(request, expectedHost) {
  if (request.headers.get('host') !== expectedHost) requestFail('forbidden-host', 403);
}

function requireCredentialFreeRequest(request) {
  if (
    request.headers.has('authorization')
    || request.headers.has('proxy-authorization')
    || request.headers.has('cookie')
  ) {
    requestFail('credentials-forbidden', 400);
  }
}

function requireLoopbackPeer(peer) {
  const address = peer?.address;
  if (
    typeof address !== 'string'
    || !(
      /^127(?:\.[0-9]{1,3}){3}$/u.test(address)
      || address === '::1'
      || /^::ffff:127(?:\.[0-9]{1,3}){3}$/iu.test(address)
    )
  ) {
    requestFail('forbidden-health-peer', 403);
  }
}

function allowedOrigin(request, config) {
  const origin = request.headers.get('origin');
  if (origin === null || !config.allowedFormOrigins.includes(origin)) requestFail('forbidden-origin', 403);
  return origin;
}

function validatePreflight(request, config) {
  const origin = allowedOrigin(request, config);
  if (request.headers.get('access-control-request-method') !== 'POST') {
    requestFail('invalid-preflight', 403);
  }
  const requestedHeaders = request.headers.get('access-control-request-headers');
  if (requestedHeaders === null) requestFail('invalid-preflight', 403);
  const normalized = requestedHeaders.split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
  if (normalized.length !== 1 || normalized[0] !== 'content-type') requestFail('invalid-preflight', 403);
  return origin;
}

function parseDeclaredLength(request, maximum) {
  const value = request.headers.get('content-length');
  if (value === null) return null;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) requestFail('invalid-content-length', 400);
  const length = Number(value);
  if (!Number.isSafeInteger(length)) requestFail('body-too-large', 413);
  if (length > maximum) requestFail('body-too-large', 413);
  return length;
}

async function readBoundedBody(request, maximum, deadline) {
  const declared = parseDeclaredLength(request, maximum);
  if (request.body === null) requestFail('malformed-json', 400);
  const reader = request.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const result = await deadline.race(reader.read(), () => reader.cancel().catch(() => {}));
      if (result.done) break;
      const chunk = Buffer.from(result.value);
      length += chunk.length;
      if (length > maximum) {
        await reader.cancel().catch(() => {});
        requestFail('body-too-large', 413);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  if (declared !== null && declared !== length) requestFail('content-length-mismatch', 400);
  const bytes = Buffer.concat(chunks, length);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    requestFail('invalid-utf8', 400);
  }
  if (text.startsWith('﻿')) requestFail('utf8-bom', 400);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    requestFail('malformed-json', 400);
  }
  try {
    return validateCorrectionIntent(parsed);
  } catch (error) {
    throw error;
  }
}

function receiptBody(receipt) {
  return {
    receipt: {
      queueId: receipt.queueId,
      state: 'pending-review',
      proposalDigest: receipt.proposalDigest,
      receivedAt: receipt.receivedAt,
      expiresAt: receipt.expiresAt,
    },
  };
}

function assertCapturedEvidence({ config, intent, binding, evidence, result }) {
  if (
    binding.bindingDigest !== intent.bindingDigest
    || binding.page.pageId !== intent.pageId
    || binding.manifest.source.repository !== config.repository
    || result.binding.source.repository !== config.repository
    || result.binding.source.revision !== binding.manifest.source.revision
    || result.binding.source.path !== binding.page.path
    || result.proposal.source.repository !== config.repository
    || result.proposal.source.revision !== binding.manifest.source.revision
    || result.proposal.source.path !== binding.page.path
    || result.basePolicy.status !== evidence.policy.status
    || result.basePolicy.digest !== evidence.policy.digest
  ) {
    throw new Error('captured intake evidence disagrees before durable enqueue');
  }
}

export function createIntakeEvidenceContext({
  config,
  bindings: injectedBindings = null,
  gitFactory = null,
} = {}) {
  const bindings = injectedBindings ?? createRetainedSourceBindingResolver({
    manifestRoot: config.bindingsRoot,
  });
  const createGit = gitFactory ?? ((deadline = null) => createBareGitObjectResolver({
    repository: config.repository,
    gitDirectory: config.gitDir,
    ...(deadline === null ? {} : { execute: executeGitWithDeadline(deadline) }),
  }));
  const resolveDurableEvidence = async (entry) => {
    if (entry.carrier.lane !== 'lane-b') {
      throw new ProposalQueueError('unsupported-queue-lane', 'the account-free runtime queue may contain only Lane B entries');
    }
    const metadata = entry.carrier.metadata;
    const binding = await bindings.resolve(metadata.bindingDigest, metadata.pageId);
    if (
      binding.manifest.source.repository !== config.repository
      || entry.proposal.source.repository !== binding.manifest.source.repository
      || entry.proposal.source.revision !== binding.manifest.source.revision
      || entry.proposal.source.path !== binding.page.path
    ) {
      throw new AccountFreeIntakeError('repository-binding-mismatch', 'durable proposal source contradicts its configured Lane B binding');
    }
    return createGit(null).resolve(binding);
  };
  return Object.freeze({ bindings, createGit, resolveDurableEvidence });
}

export async function openIntakeService({
  config,
  clock = () => new Date(),
  proposalIdFactory = randomUUID,
  queueIdFactory = randomUUID,
  bindings: injectedBindings = null,
  queue: injectedQueue = null,
  gitFactory = null,
  validatePaths = true,
} = {}) {
  if (validatePaths) await validateRuntimePaths(config);
  const evidenceContext = createIntakeEvidenceContext({
    config,
    bindings: injectedBindings,
    gitFactory,
  });
  const { bindings, createGit, resolveDurableEvidence } = evidenceContext;

  const queue = injectedQueue ?? await openProposalQueue({
    config: config.queue,
    clock: () => utcSecond(clock),
    idFactory: queueIdFactory,
    resolveEvidence: resolveDurableEvidence,
  });
  let ready = true;
  const limiter = createGlobalAbuseLimiter({
    capacity: config.limits.tokenBucketCapacity,
    refillPerSecond: config.limits.tokenBucketRefillPerSecond,
    maxConcurrent: config.limits.maxConcurrentRequests,
  });

  async function submit(request, origin) {
    if (request.headers.get('content-type') !== 'application/json') {
      requestFail('invalid-content-type', 400);
    }
    const release = limiter.tryEnter();
    if (release === null) requestFail('too-many-active-requests', 429);
    const deadline = createDeadline(config.limits.requestTimeoutMs);
    try {
      const intent = await readBoundedBody(request, config.limits.maxBodyBytes, deadline);
      deadline.assert();
      const requestDigest = correctionIntentDigest(intent);
      const carrier = {
        lane: 'lane-b',
        metadata: { bindingDigest: intent.bindingDigest, pageId: intent.pageId },
      };
      const idempotency = {
        scope: 'lane-b',
        key: intent.idempotencyKey,
        requestDigest,
      };
      const replay = await deadline.race(queue.enqueue({
        proposalText: null,
        baseBytes: null,
        policy: null,
        verifiedSubject: null,
        carrier,
        idempotency,
      }));
      if (replay.receipt !== null) {
        return jsonResponse(receiptBody(replay.receipt), 200, { origin, cors: true });
      }

      deadline.assert();
      const binding = await deadline.race(bindings.resolve(intent.bindingDigest, intent.pageId));
      if (binding.manifest.source.repository !== config.repository) {
        throw new AccountFreeIntakeError('repository-binding-mismatch', 'binding repository is not configured');
      }
      const git = createGit(deadline);
      let evidence;
      try {
        evidence = await deadline.race(git.resolve(binding));
      } catch (error) {
        deadline.assert();
        throw error;
      }
      deadline.assert();
      const result = await deriveAccountFreeProposal({
        intent,
        bindings: Object.freeze({ resolve: async () => binding }),
        git: Object.freeze({ resolve: async () => evidence }),
        proposalId: `account-free:${proposalIdFactory()}`,
        submittedAt: utcSecond(clock),
      });
      assertCapturedEvidence({ config, intent, binding, evidence, result });
      deadline.assert();
      const queued = await queue.enqueue({
        proposalText: result.proposalText,
        baseBytes: evidence.baseBytes,
        policy: evidence.policy,
        verifiedSubject: null,
        carrier,
        idempotency,
      });
      const status = queued.replayed ? 200 : 202;
      return jsonResponse(receiptBody(queued.receipt), status, { origin, cors: true });
    } finally {
      deadline.close();
      release();
    }
  }

  async function fetch(request, peer = null) {
    const url = new URL(request.url);
    let corsOrigin = null;
    const corsPath = url.pathname === '/v1/corrections';
    const healthHost = `127.0.0.1:${config.listen.port}`;
    try {
      if (url.search !== '') requestFail('not-found', 404);
      requireCredentialFreeRequest(request);

      if (url.pathname === '/healthz') {
        requireExactHost(request, healthHost);
        requireLoopbackPeer(peer);
        if (request.headers.has('origin')) requestFail('forbidden-origin', 403);
        if (request.method !== 'GET') {
          return jsonResponse({ error: { code: 'method-not-allowed' } }, 405, {
            extra: { Allow: 'GET' },
          });
        }
        if (hasForbiddenBody(request)) requestFail('request-body-forbidden', 400);
        if (!ready) requestFail('unready', 503);
        return jsonResponse({ status: 'ok' }, 200);
      }

      requireExactHost(request, config.publicHost);
      if (url.pathname !== '/v1/corrections') requestFail('not-found', 404);
      if (!['OPTIONS', 'POST'].includes(request.method)) {
        return jsonResponse({ error: { code: 'method-not-allowed' } }, 405, {
          cors: true,
          extra: { Allow: 'OPTIONS, POST' },
        });
      }
      if (!limiter.tryTake()) requestFail('rate-limited', 429);

      if (request.method === 'OPTIONS') {
        if (hasForbiddenBody(request)) requestFail('request-body-forbidden', 400);
        corsOrigin = validatePreflight(request, config);
        return emptyResponse(204, {
          origin: corsOrigin,
          cors: true,
          extra: {
            'Access-Control-Allow-Headers': 'content-type',
            'Access-Control-Allow-Methods': 'POST',
          },
        });
      }

      corsOrigin = allowedOrigin(request, config);
      return await submit(request, corsOrigin);
    } catch (error) {
      const mapped = publicError(error);
      const origin = corsOrigin ?? (
        corsPath && config.allowedFormOrigins.includes(request.headers.get('origin'))
          ? request.headers.get('origin')
          : null
      );
      return jsonResponse({ error: { code: mapped.code } }, mapped.status, {
        origin,
        cors: corsPath,
        extra: mapped.status === 429 ? { 'Retry-After': '1' } : {},
      });
    }
  }

  return Object.freeze({
    fetch,
    queue,
    stats: () => queue.stats(),
    setReadyForTest(value) { ready = value === true; },
    async close() {
      ready = false;
      await queue.close();
    },
  });
}

export function startBunServer({ config, service }) {
  return Bun.serve({
    hostname: config.listen.host,
    port: config.listen.port,
    fetch(request, server) {
      return service.fetch(request, server.requestIP(request));
    },
  });
}

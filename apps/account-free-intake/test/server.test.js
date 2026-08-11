import { afterEach, describe, expect, test } from 'bun:test';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { openIntakeService } from '../src/server.js';
import {
  renderListHtml,
  renderListText,
  renderShowHtml,
  renderShowText,
  runReviewCommand,
} from '../src/review.js';
import { FORM_ORIGIN, createFixture, request } from './helpers.js';

const cleanups = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()();
});

async function setup() {
  const fixture = await createFixture();
  const service = await openIntakeService({ config: fixture.config });
  cleanups.push(async () => {
    await service.close();
    await fixture.cleanup();
  });
  return { fixture, service };
}

function postRequest(intent, overrides = {}) {
  return request('/v1/corrections', {
    method: 'POST',
    origin: FORM_ORIGIN,
    headers: { 'Content-Type': 'application/json', ...(overrides.headers ?? {}) },
    body: overrides.body ?? JSON.stringify(intent),
    host: overrides.host ?? 'intake.example',
  });
}

async function responseJson(response) {
  return JSON.parse(await response.text());
}

describe('account-free HTTP boundary', () => {
  test('serves only the exact health route and public correction methods', async () => {
    const { service } = await setup();

    const loopbackPeer = { address: '127.0.0.1', family: 'IPv4', port: 12345 };
    const health = await service.fetch(
      request('/healthz', { host: '127.0.0.1:8080' }),
      loopbackPeer,
    );
    expect(health.status).toBe(200);
    expect(await responseJson(health)).toEqual({ status: 'ok' });
    expect(health.headers.get('cache-control')).toBe('no-store');
    expect(health.headers.get('x-frame-options')).toBe('DENY');

    const remoteHealth = await service.fetch(
      request('/healthz', { host: '127.0.0.1:8080' }),
      { address: '192.0.2.10', family: 'IPv4', port: 12345 },
    );
    expect(remoteHealth.status).toBe(403);
    expect(await responseJson(remoteHealth)).toEqual({ error: { code: 'forbidden-health-peer' } });

    const query = await service.fetch(request('/healthz?probe=1', { host: '127.0.0.1:8080' }));
    expect(query.status).toBe(404);
    expect(await responseJson(query)).toEqual({ error: { code: 'not-found' } });

    const publicHealth = await service.fetch(request('/healthz'));
    expect(publicHealth.status).toBe(403);
    expect(await responseJson(publicHealth)).toEqual({ error: { code: 'forbidden-host' } });

    const unknown = await service.fetch(request('/v1/other'));
    expect(unknown.status).toBe(404);

    const method = await service.fetch(request('/v1/corrections', { method: 'GET' }));
    expect(method.status).toBe(405);
    expect(method.headers.get('allow')).toBe('OPTIONS, POST');
    expect(await responseJson(method)).toEqual({ error: { code: 'method-not-allowed' } });
  });

  test('requires exact Host and exact CORS preflight fields', async () => {
    const { service } = await setup();

    const badHost = await service.fetch(request('/healthz', { host: 'intake.example:443' }));
    expect(badHost.status).toBe(403);
    expect(await responseJson(badHost)).toEqual({ error: { code: 'forbidden-host' } });

    const preflight = await service.fetch(request('/v1/corrections', {
      method: 'OPTIONS',
      origin: FORM_ORIGIN,
      headers: {
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'Content-Type',
      },
    }));
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe(FORM_ORIGIN);
    expect(preflight.headers.get('access-control-allow-methods')).toBe('POST');
    expect(preflight.headers.get('access-control-allow-headers')).toBe('content-type');
    expect(preflight.headers.get('access-control-allow-credentials')).toBeNull();
    expect(preflight.headers.get('vary')).toBe('Origin');

    const wildcard = await service.fetch(request('/v1/corrections', {
      method: 'OPTIONS',
      origin: 'https://evil.example',
      headers: {
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    }));
    expect(wildcard.status).toBe(403);
    expect(wildcard.headers.get('access-control-allow-origin')).toBeNull();

    const extraHeader = await service.fetch(request('/v1/corrections', {
      method: 'OPTIONS',
      origin: FORM_ORIGIN,
      headers: {
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type, authorization',
      },
    }));
    expect(extraHeader.status).toBe(403);
  });

  test('rejects credentials and requires an exact allowed Origin', async () => {
    const { fixture, service } = await setup();
    const intent = fixture.intent();

    const credentialed = await service.fetch(postRequest(intent, {
      headers: { Authorization: 'Bearer must-not-be-accepted' },
    }));
    expect(credentialed.status).toBe(400);
    expect(await responseJson(credentialed)).toEqual({ error: { code: 'credentials-forbidden' } });

    const cookie = await service.fetch(postRequest(intent, {
      headers: { Cookie: 'session=must-not-be-accepted' },
    }));
    expect(cookie.status).toBe(400);

    const absentOrigin = await service.fetch(request('/v1/corrections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(intent),
    }));
    expect(absentOrigin.status).toBe(403);
    expect(absentOrigin.headers.get('access-control-allow-origin')).toBeNull();
  });

  test('durably queues a new anonymous proposal and returns only the bounded receipt', async () => {
    const { fixture, service } = await setup();
    const intent = fixture.intent({ idempotencyKey: 'A'.repeat(32) });

    const accepted = await service.fetch(postRequest(intent));
    expect(accepted.status).toBe(202);
    expect(accepted.headers.get('access-control-allow-origin')).toBe(FORM_ORIGIN);
    const body = await responseJson(accepted);
    expect(Object.keys(body)).toEqual(['receipt']);
    expect(Object.keys(body.receipt)).toEqual([
      'queueId', 'state', 'proposalDigest', 'receivedAt', 'expiresAt',
    ]);
    expect(body.receipt.state).toBe('pending-review');
    expect(JSON.stringify(body)).not.toContain('Correct the misspelling');
    expect(JSON.stringify(body)).not.toContain('example.invalid/reference');
    expect(service.stats().pendingEntries).toBe(1);

    const replay = await service.fetch(postRequest(intent));
    expect(replay.status).toBe(200);
    expect(await responseJson(replay)).toEqual(body);
    expect(service.stats().pendingEntries).toBe(1);

    const entry = await service.queue.load(body.receipt.queueId);
    expect(entry.proposal.submission.identityClaim).toBeNull();
    expect(entry.classification.classification.route).toBe('full-review');
    expect(entry.carrier.metadata).toEqual({
      bindingDigest: fixture.bindingDigest,
      pageId: fixture.pageId,
    });

    expect(renderListText([entry])).toContain(body.receipt.queueId);
    expect(renderListHtml([entry])).toContain('<!doctype html>');
    expect(renderShowText(entry)).toContain('Exact replacement text:');
    expect(renderShowHtml(entry)).toContain('Correct the misspelling.');
    expect(renderShowHtml(entry)).not.toContain('<script');

    await expect(runReviewCommand({
      config: fixture.config,
      command: 'list',
      format: 'text',
    })).rejects.toMatchObject({ code: 'lock-busy' });

    await service.close();
    const reopened = await openIntakeService({ config: fixture.config });
    try {
      const retained = await reopened.queue.load(body.receipt.queueId);
      expect(retained.proposalText).toBe(entry.proposalText);
      expect(reopened.stats().pendingEntries).toBe(1);
    } finally {
      await reopened.close();
    }

    const entryDirectory = path.join(
      fixture.config.queue.root,
      'pending',
      body.receipt.queueId,
    );
    const artifactNames = await readdir(entryDirectory);
    const beforeReview = Object.fromEntries(await Promise.all(
      artifactNames.map(async (name) => [name, await readFile(path.join(entryDirectory, name))]),
    ));

    const listed = await runReviewCommand({
      config: fixture.config,
      command: 'list',
      format: 'text',
      state: 'pending-review',
    });
    expect(listed).toContain(body.receipt.queueId);
    const shown = await runReviewCommand({
      config: fixture.config,
      command: 'show',
      queueId: body.receipt.queueId,
      format: 'html',
    });
    expect(shown).toContain('<!doctype html>');
    expect(shown).toContain('Correct the misspelling.');
    expect(await readdir(path.join(fixture.config.queue.root, 'expired'))).toEqual([]);
    expect(await readdir(path.join(fixture.config.queue.root, 'pending'))).toEqual([
      body.receipt.queueId,
    ]);
    for (const [name, bytes] of Object.entries(beforeReview)) {
      expect(await readFile(path.join(entryDirectory, name))).toEqual(bytes);
    }
  });

  test('escapes untrusted review content in terminal text and static HTML', async () => {
    const { fixture, service } = await setup();
    const accepted = await service.fetch(postRequest(fixture.intent({ idempotencyKey: 'C'.repeat(32) })));
    const body = await responseJson(accepted);
    const entry = structuredClone(await service.queue.load(body.receipt.queueId));
    entry.proposal.submission.rationale = '[31m</pre><script>alert(1)</script>';

    const text = renderShowText(entry);
    expect(text).not.toContain('');
    expect(text).toContain('\\u001b');
    const html = renderShowHtml(entry);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  test('maps body, contract, source, and idempotency failures without reflecting data', async () => {
    const { fixture, service } = await setup();

    const wrongType = await service.fetch(request('/v1/corrections', {
      method: 'POST',
      origin: FORM_ORIGIN,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: '{}',
    }));
    expect(wrongType.status).toBe(400);
    expect(await responseJson(wrongType)).toEqual({ error: { code: 'invalid-content-type' } });

    const malformed = await service.fetch(request('/v1/corrections', {
      method: 'POST',
      origin: FORM_ORIGIN,
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    }));
    expect(malformed.status).toBe(400);
    expect(await responseJson(malformed)).toEqual({ error: { code: 'malformed-json' } });

    const oversized = await service.fetch(request('/v1/corrections', {
      method: 'POST',
      origin: FORM_ORIGIN,
      headers: { 'Content-Type': 'application/json', 'Content-Length': '98305' },
      body: '{}',
    }));
    expect(oversized.status).toBe(413);
    expect(await responseJson(oversized)).toEqual({ error: { code: 'body-too-large' } });

    const missingQuote = await service.fetch(postRequest(fixture.intent({
      selection: { quote: 'not in source', prefix: null, suffix: null },
    })));
    expect(missingQuote.status).toBe(422);
    expect(await responseJson(missingQuote)).toEqual({ error: { code: 'correction-quote-not-found' } });

    const staleIntent = fixture.intent({
      bindingDigest: 'sha-256=:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=:',
    });
    const stale = await service.fetch(postRequest(staleIntent));
    expect(stale.status).toBe(409);
    expect(await responseJson(stale)).toEqual({ error: { code: 'stale-publication' } });

    const first = fixture.intent({ idempotencyKey: 'B'.repeat(32) });
    expect((await service.fetch(postRequest(first))).status).toBe(202);
    const conflict = fixture.intent({
      idempotencyKey: 'B'.repeat(32),
      rationale: 'A different request using the same replay identity.',
    });
    const conflicting = await service.fetch(postRequest(conflict));
    expect(conflicting.status).toBe(409);
    const conflictBody = await responseJson(conflicting);
    expect(conflictBody).toEqual({ error: { code: 'idempotency-conflict' } });
    expect(JSON.stringify(conflictBody)).not.toContain('different request');
  });

  test('applies one end-to-end request deadline before durable enqueue', async () => {
    const fixture = await createFixture();
    cleanups.push(fixture.cleanup);
    const config = {
      ...fixture.config,
      limits: { ...fixture.config.limits, requestTimeoutMs: 20 },
    };
    let enqueueCalls = 0;
    const queue = {
      async enqueue() {
        enqueueCalls += 1;
        return { replayed: false, receipt: null };
      },
      stats() { return { pendingEntries: 0, expiredEntries: 0, retainedBytes: 0, sourcePartitions: 0 }; },
      async close() {},
    };
    const service = await openIntakeService({
      config,
      validatePaths: false,
      queue,
      bindings: { resolve: () => new Promise(() => {}) },
    });
    cleanups.push(() => service.close());

    const response = await service.fetch(postRequest(fixture.intent()));
    expect(response.status).toBe(503);
    expect(await responseJson(response)).toEqual({ error: { code: 'request-deadline' } });
    expect(enqueueCalls).toBe(1);
  });

  test('ignores forwarded authority headers and trusts only exact Host and Origin', async () => {
    const { fixture, service } = await setup();
    const response = await service.fetch(postRequest(fixture.intent(), {
      headers: {
        Forwarded: 'host=evil.example;proto=http',
        'X-Forwarded-Host': 'evil.example',
        'X-Forwarded-For': '203.0.113.10',
      },
    }));
    expect(response.status).toBe(202);
  });
});

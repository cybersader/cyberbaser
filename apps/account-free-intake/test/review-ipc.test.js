import { afterEach, describe, expect, test } from 'bun:test';
import net from 'node:net';
import { chmod, lstat, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  REVIEW_IPC_REQUEST_MAX_BYTES,
  createReviewIpcHandler,
  parseReviewIpcRequest,
  startReviewIpcServer,
} from '../src/review-ipc.js';
import { validateConfig } from '../src/config.js';
import { openIntakeService, startIntakeRuntime } from '../src/server.js';
import {
  FORM_ORIGIN,
  configInput,
  createFixture,
  request,
} from './helpers.js';

const fixtures = [];
const services = [];
const ipcServers = [];

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function requestBytes(value) {
  return Buffer.from(`${canonicalJson(value)}\n`, 'utf8');
}

function parseResponse(bytes) {
  const buffer = Buffer.from(bytes);
  expect(buffer.at(-1)).toBe(0x0a);
  expect(buffer.indexOf(0x0a)).toBe(buffer.length - 1);
  const parsed = JSON.parse(buffer.toString('utf8'));
  expect(buffer.toString('utf8')).toBe(`${canonicalJson(parsed)}\n`);
  return parsed;
}

async function exchange(socketPath, bytes, { end = false } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    const chunks = [];
    socket.once('connect', () => {
      socket.write(bytes);
      if (end) socket.end();
    });
    socket.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    socket.once('end', () => resolve(Buffer.concat(chunks)));
    socket.once('error', reject);
  });
}

async function liveFixture({ enabled = true, requestTimeoutMs = 5000, queueIds = null, clock = null } = {}) {
  const fixture = await createFixture();
  fixtures.push(fixture);
  const runtime = path.join(fixture.root, 'review-runtime');
  await mkdir(runtime, { mode: 0o700 });
  await chmod(runtime, 0o700);
  const socketPath = path.join(runtime, 'review.sock');
  const config = validateConfig(configInput(fixture.root, {
    reviewIpc: {
      enabled,
      socketPath: enabled ? socketPath : null,
      requestTimeoutMs: 5000,
      maxConcurrentRequests: 4,
      maxListEntries: 100,
    },
  }));
  let nextId = 1;
  const service = await openIntakeService({
    config,
    ...(clock === null ? {} : { clock }),
    queueIdFactory: () => {
      const suffix = queueIds === null ? nextId++ : queueIds.shift();
      return `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;
    },
  });
  services.push(service);
  return { fixture, runtime, socketPath, config, service, requestTimeoutMs };
}

async function submit(item, rationale) {
  const response = await item.service.fetch(request('/v1/corrections', {
    method: 'POST',
    origin: FORM_ORIGIN,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(item.fixture.intent({ rationale })),
  }));
  expect(response.status).toBe(202);
  return response.json();
}

afterEach(async () => {
  await Promise.all(ipcServers.splice(0).map((server) => server.close()));
  await Promise.all(services.splice(0).map((service) => service.close()));
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

describe('review IPC protocol', () => {
  test('serves bounded paginated summaries and exact one-ID loads from the open writer', async () => {
    const item = await liveFixture();
    await submit(item, 'First correction.');
    await submit(item, 'Second correction.');
    const handle = createReviewIpcHandler({ review: item.service.review, maxListEntries: 100 });

    const first = parseResponse(await handle(requestBytes({
      schemaVersion: 1,
      operation: 'list',
      state: 'pending-review',
      cursor: null,
      limit: 1,
    })));
    expect(first.operation).toBe('list');
    expect(first.entries).toHaveLength(1);
    expect(first.nextCursor).toBeString();
    expect(first.entries[0]).toMatchObject({
      queueId: 'Q-00000000-0000-4000-8000-000000000001',
      state: 'pending-review',
      lane: 'lane-b',
      tier: 'anonymous',
      route: 'full-review',
    });

    const second = parseResponse(await handle(requestBytes({
      schemaVersion: 1,
      operation: 'list',
      state: 'pending-review',
      cursor: first.nextCursor,
      limit: 1,
    })));
    expect(second.entries.map((entry) => entry.queueId)).toEqual([
      'Q-00000000-0000-4000-8000-000000000002',
    ]);
    expect(second.nextCursor).toBeNull();

    const loaded = parseResponse(await handle(requestBytes({
      schemaVersion: 1,
      operation: 'load',
      queueId: first.entries[0].queueId,
    })));
    expect(loaded.operation).toBe('load');
    expect(Object.keys(loaded.entry).sort()).toEqual([
      'carrier',
      'classification',
      'proposalText',
      'queueId',
      'receipt',
      'state',
    ]);
    expect(loaded.entry.proposalText.endsWith('\n')).toBe(true);
    expect(loaded.entry).not.toHaveProperty('location');
    expect(loaded.entry).not.toHaveProperty('retainedBytes');
    expect(loaded.entry).not.toHaveProperty('semantics');
  });

  test('invalidates a continuation cursor when the live queue snapshot changes', async () => {
    const at = new Date('2026-08-20T12:00:00Z');
    const item = await liveFixture({
      queueIds: [500, 900, 100],
      clock: () => at,
    });
    await submit(item, 'First correction.');
    await submit(item, 'Second correction.');
    const handle = createReviewIpcHandler({ review: item.service.review, maxListEntries: 100 });
    const first = parseResponse(await handle(requestBytes({
      schemaVersion: 1,
      operation: 'list',
      state: 'pending-review',
      cursor: null,
      limit: 1,
    })));
    expect(first.nextCursor).toBeString();

    await submit(item, 'Later correction with a lower random queue ID.');
    const continued = parseResponse(await handle(requestBytes({
      schemaVersion: 1,
      operation: 'list',
      state: 'pending-review',
      cursor: first.nextCursor,
      limit: 1,
    })));
    expect(continued).toEqual({ schemaVersion: 1, error: { code: 'invalid-cursor' } });
  });

  test('returns bounded stable errors for malformed requests and cursor misuse', async () => {
    const item = await liveFixture();
    await submit(item, 'Correction.');
    await submit(item, 'Second correction.');
    const handle = createReviewIpcHandler({ review: item.service.review, maxListEntries: 100 });

    expect(parseResponse(await handle(Buffer.from('{"operation":"list"}\n')))).toEqual({
      schemaVersion: 1,
      error: { code: 'invalid-request' },
    });
    expect(parseResponse(await handle(Buffer.from('{ "operation": "list" }\n'))).error.code).toBe('invalid-request');
    expect(parseResponse(await handle(requestBytes({
      schemaVersion: 1,
      operation: 'delete',
    }))).error.code).toBe('unsupported-operation');
    expect(parseResponse(await handle(requestBytes({
      schemaVersion: 1,
      operation: 'load',
      queueId: 'Q-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    }))).error.code).toBe('not-found');

    const first = parseResponse(await handle(requestBytes({
      schemaVersion: 1,
      operation: 'list',
      state: 'pending-review',
      cursor: null,
      limit: 1,
    })));
    const badCursor = parseResponse(await handle(requestBytes({
      schemaVersion: 1,
      operation: 'list',
      state: 'expired',
      cursor: first.nextCursor ?? Buffer.from(canonicalJson({
        queueId: first.entries[0].queueId,
        receivedAt: first.entries[0].receivedAt,
        schemaVersion: 1,
        state: 'pending-review',
      })).toString('base64url'),
      limit: 1,
    })));
    expect(badCursor.error.code).toBe('invalid-cursor');

    const oversized = Buffer.alloc(REVIEW_IPC_REQUEST_MAX_BYTES + 1, 0x61);
    expect(parseResponse(await handle(oversized)).error.code).toBe('invalid-request-bytes');
  });

  test('requires canonical one-request bytes', () => {
    const canonical = requestBytes({
      schemaVersion: 1,
      operation: 'list',
      state: null,
      cursor: null,
      limit: 10,
    });
    expect(parseReviewIpcRequest(canonical)).toEqual({
      schemaVersion: 1,
      operation: 'list',
      state: null,
      cursor: null,
      limit: 10,
    });
    expect(() => parseReviewIpcRequest(Buffer.from(`﻿${canonical}`))).toThrow(/BOM/);
    expect(() => parseReviewIpcRequest(Buffer.from(canonical.toString().trim()))).toThrow(/final LF/);
    expect(() => parseReviewIpcRequest(Buffer.from(`${canonical}\n`))).toThrow(/one final LF/);
  });
});

describe('combined intake runtime lifecycle', () => {
  test('starts queue, private review, then public listener and closes in reverse authority order', async () => {
    const events = [];
    const review = Object.freeze({ list: async () => [], load: async () => null });
    const service = {
      queue: Object.freeze({}),
      review,
      close: async () => events.push('service-close'),
    };
    const runtime = await startIntakeRuntime({
      config: { reviewIpc: { enabled: true } },
      openService: async () => {
        events.push('service-open');
        return service;
      },
      startReview: async ({ review: source }) => {
        expect(source).toBe(review);
        events.push('review-start');
        return { close: async () => events.push('review-close') };
      },
      startPublic: async () => {
        events.push('public-start');
        return { stop: async () => events.push('public-stop') };
      },
    });
    expect(events).toEqual(['service-open', 'review-start', 'public-start']);
    await runtime.close();
    await runtime.close();
    expect(events).toEqual([
      'service-open',
      'review-start',
      'public-start',
      'public-stop',
      'review-close',
      'service-close',
    ]);
  });

  test('rolls back private review and queue ownership when public startup fails', async () => {
    const events = [];
    await expect(startIntakeRuntime({
      config: { reviewIpc: { enabled: true } },
      openService: async () => {
        events.push('service-open');
        return {
          review: Object.freeze({ list: async () => [], load: async () => null }),
          close: async () => events.push('service-close'),
        };
      },
      startReview: async () => {
        events.push('review-start');
        return { close: async () => events.push('review-close') };
      },
      startPublic: async () => {
        events.push('public-start');
        throw new Error('public bind failed');
      },
    })).rejects.toThrow('public bind failed');
    expect(events).toEqual([
      'service-open',
      'review-start',
      'public-start',
      'review-close',
      'service-close',
    ]);
  });

  test('attempts lower-authority cleanup after a review close failure', async () => {
    const events = [];
    const primary = new Error('public bind failed');
    await expect(startIntakeRuntime({
      config: { reviewIpc: { enabled: true } },
      openService: async () => ({
        review: Object.freeze({ list: async () => [], load: async () => null }),
        close: async () => events.push('service-close'),
      }),
      startReview: async () => ({
        close: async () => {
          events.push('review-close');
          throw new Error('review cleanup failed');
        },
      }),
      startPublic: async () => { throw primary; },
    })).rejects.toBe(primary);
    expect(events).toEqual(['review-close', 'service-close']);
  });

  test('retries only failed runtime cleanup steps while still releasing the queue', async () => {
    const events = [];
    let reviewAttempts = 0;
    const runtime = await startIntakeRuntime({
      config: { reviewIpc: { enabled: true } },
      openService: async () => ({
        review: Object.freeze({ list: async () => [], load: async () => null }),
        close: async () => events.push('service-close'),
      }),
      startReview: async () => ({
        close: async () => {
          reviewAttempts += 1;
          events.push(`review-close-${reviewAttempts}`);
          if (reviewAttempts === 1) throw new Error('review cleanup failed');
        },
      }),
      startPublic: async () => ({ stop: async () => events.push('public-stop') }),
    });

    await expect(runtime.close()).rejects.toBeInstanceOf(AggregateError);
    expect(events).toEqual(['public-stop', 'review-close-1', 'service-close']);
    await runtime.close();
    expect(events).toEqual(['public-stop', 'review-close-1', 'service-close', 'review-close-2']);
  });
});

describe('private Unix socket lifecycle', () => {
  test('creates mode 0600, exchanges one request, and removes its socket on close', async () => {
    const item = await liveFixture();
    await submit(item, 'Correction.');
    const server = await startReviewIpcServer({ config: item.config, review: item.service.review });
    ipcServers.push(server);

    const metadata = await lstat(item.socketPath);
    expect(metadata.isSocket()).toBe(true);
    expect(metadata.mode & 0o777).toBe(0o600);
    expect(metadata.uid).toBe(process.getuid());

    const response = parseResponse(await exchange(item.socketPath, requestBytes({
      schemaVersion: 1,
      operation: 'list',
      state: 'pending-review',
      cursor: null,
      limit: 10,
    })));
    expect(response.entries).toHaveLength(1);

    await server.close();
    ipcServers.splice(ipcServers.indexOf(server), 1);
    await expect(lstat(item.socketPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('rejects unsafe parents, occupied leaves, and a second active listener', async () => {
    const broad = await liveFixture();
    await chmod(broad.runtime, 0o755);
    await expect(startReviewIpcServer({ config: broad.config, review: broad.service.review }))
      .rejects.toThrow(/mode 0700/);

    const occupied = await liveFixture();
    await writeFile(occupied.socketPath, 'not a socket');
    await expect(startReviewIpcServer({ config: occupied.config, review: occupied.service.review }))
      .rejects.toThrow(/unsafe entry/);

    const active = await liveFixture();
    const first = await startReviewIpcServer({ config: active.config, review: active.service.review });
    ipcServers.push(first);
    await expect(startReviewIpcServer({ config: active.config, review: active.service.review }))
      .rejects.toThrow(/active listener/);
  });

  test('removes only a stale current-owner socket before binding', async () => {
    const item = await liveFixture();
    const child = Bun.spawn({
      cmd: [process.execPath, '-e', [
        "import net from 'node:net';",
        `const server = net.createServer(() => {}).listen(${JSON.stringify(item.socketPath)}, () => console.log('ready'));`,
        'setInterval(() => {}, 1000);',
      ].join(' ')],
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const reader = child.stdout.getReader();
    const ready = await reader.read();
    expect(Buffer.from(ready.value).toString()).toContain('ready');
    child.kill(9);
    await child.exited;
    expect((await lstat(item.socketPath)).isSocket()).toBe(true);

    const server = await startReviewIpcServer({ config: item.config, review: item.service.review });
    ipcServers.push(server);
    expect((await lstat(item.socketPath)).mode & 0o777).toBe(0o600);
  });

  test('rejects a symlinked socket parent before binding', async () => {
    const item = await liveFixture();
    const real = path.join(item.fixture.root, 'real-review-runtime');
    const alias = path.join(item.fixture.root, 'review-alias');
    await mkdir(real, { mode: 0o700 });
    await symlink(real, alias);
    const config = validateConfig(configInput(item.fixture.root, {
      reviewIpc: {
        enabled: true,
        socketPath: path.join(alias, 'review.sock'),
        requestTimeoutMs: 5000,
        maxConcurrentRequests: 4,
        maxListEntries: 100,
      },
    }));
    await expect(startReviewIpcServer({ config, review: item.service.review }))
      .rejects.toThrow(/real directory/);
    await rm(alias, { force: true });
  });

  test('bounds active connections and times out incomplete exchanges', async () => {
    const item = await liveFixture();
    const config = {
      ...item.config,
      reviewIpc: {
        ...item.config.reviewIpc,
        requestTimeoutMs: 50,
        maxConcurrentRequests: 1,
      },
    };
    const server = await startReviewIpcServer({ config, review: item.service.review });
    ipcServers.push(server);

    const held = net.createConnection({ path: item.socketPath });
    await new Promise((resolve, reject) => {
      held.once('connect', resolve);
      held.once('error', reject);
    });
    const busy = parseResponse(await exchange(item.socketPath, Buffer.alloc(0), { end: false }));
    expect(busy.error.code).toBe('busy');

    const timeoutChunks = [];
    held.on('data', (chunk) => timeoutChunks.push(Buffer.from(chunk)));
    await new Promise((resolve) => held.once('end', resolve));
    expect(parseResponse(Buffer.concat(timeoutChunks)).error.code).toBe('timeout');
  });

  test('keeps timed-out backend work inside the concurrency cap and drains it on close', async () => {
    const item = await liveFixture();
    const config = {
      ...item.config,
      reviewIpc: {
        ...item.config.reviewIpc,
        requestTimeoutMs: 50,
        maxConcurrentRequests: 1,
      },
    };
    let releaseBackend;
    let backendActive = 0;
    let maximumBackend = 0;
    const gate = new Promise((resolve) => { releaseBackend = resolve; });
    const review = Object.freeze({
      async list() {
        backendActive += 1;
        maximumBackend = Math.max(maximumBackend, backendActive);
        await gate;
        backendActive -= 1;
        return [];
      },
      async load() { throw new Error('load not expected'); },
    });
    const server = await startReviewIpcServer({ config, review });
    ipcServers.push(server);
    const listRequest = requestBytes({
      schemaVersion: 1,
      operation: 'list',
      state: 'pending-review',
      cursor: null,
      limit: 10,
    });

    const timedOut = parseResponse(await exchange(item.socketPath, listRequest));
    expect(timedOut.error.code).toBe('timeout');
    const busy = parseResponse(await exchange(item.socketPath, listRequest));
    expect(busy.error.code).toBe('busy');
    expect(maximumBackend).toBe(1);

    let closeSettled = false;
    const closing = server.close().then(() => { closeSettled = true; });
    await Bun.sleep(10);
    expect(closeSettled).toBe(false);
    releaseBackend();
    await closing;
    ipcServers.splice(ipcServers.indexOf(server), 1);
    expect(closeSettled).toBe(true);
    expect(backendActive).toBe(0);
  });
});

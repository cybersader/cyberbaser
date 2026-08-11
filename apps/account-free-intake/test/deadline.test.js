import { expect, test } from 'bun:test';
import { validateConfig } from '../src/config.js';
import { openIntakeService } from '../src/server.js';
import { configInput, FORM_ORIGIN } from './helpers.js';

function fakeQueue() {
  return Object.freeze({
    enqueue: async () => ({ replayed: false, receipt: null }),
    stats: () => Object.freeze({ pendingEntries: 0, expiredEntries: 0, retainedBytes: 0, sourcePartitions: 0 }),
    close: async () => {},
  });
}

test('enforces the five-second total request deadline while streaming the body', async () => {
  const config = validateConfig(configInput('/srv/cyberbaser/account-free-deadline'));
  const service = await openIntakeService({
    config,
    validatePaths: false,
    bindings: Object.freeze({ resolve: async () => null }),
    queue: fakeQueue(),
  });
  try {
    const body = new ReadableStream({
      pull() {
        return new Promise(() => {});
      },
    });
    const request = new Request('http://127.0.0.1/v1/corrections', {
      method: 'POST',
      headers: {
        Host: 'intake.example',
        Origin: FORM_ORIGIN,
        'Content-Type': 'application/json',
      },
      body,
    });
    const response = await service.fetch(request);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: 'request-deadline' } });
  } finally {
    await service.close();
  }
}, 7_000);

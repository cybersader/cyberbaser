import { expect, test } from 'bun:test';
import { capturePublicationResponse } from './publication-response-capture.js';

function deferred() { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { promise, resolve }; }

test('response body succeeds and stays exact without persistence or a second request', async () => {
  const body = { candidateDigest: 'synthetic-exact-digest', capturedVersion: 1, jobId: 'synthetic-job' }; let reads = 0;
  const captured = await capturePublicationResponse(Promise.resolve({ status: () => 201,
    json: async () => { reads += 1; return body; } }));
  expect(captured).toEqual({ status: 201, body, bodyReadSucceeded: true, classification: null });
  expect(captured.body).toBe(body); expect(reads).toBe(1);
});

test('old swallowed body-read failure produces undefined dereference; corrected capture reports fixed failure without raw detail', async () => {
  const secret = 'synthetic-private-capability-must-not-leak';
  const response = { status: () => 201, json: async () => { throw new Error(secret); } };
  // Exact relevant old ordering: disk await, swallowed parse failure, return
  // undefined, successful201 assertion, then dereference before fifth assertion.
  const oldRecord = async () => { await Promise.resolve(); let body; try { body = await response.json(); } catch {} return body; };
  const old = await oldRecord(); expect(response.status()).toBe(201);
  expect(() => old.candidateDigest).toThrow(TypeError);
  const captured = await capturePublicationResponse(Promise.resolve(response));
  expect(captured).toEqual({ status: 201, body: undefined, bodyReadSucceeded: false, classification: 'response-body-read-failed' });
  expect(JSON.stringify(captured)).not.toContain(secret);
});

test('capture attached before click reads body before navigation completion or disk I/O', async () => {
  const response = deferred(); const bodyRead = deferred(); const events = []; let navigationFinished = false;
  const capture = capturePublicationResponse(response.promise);
  const click = (async () => {
    events.push('click'); response.resolve({ status: () => 201, json: async () => {
      events.push('body-read'); if (navigationFinished) throw new Error('body no longer available'); bodyRead.resolve(); return { exact: true };
    } });
    await bodyRead.promise;
    navigationFinished = true; events.push('navigation-finished');
  })();
  await click;
  const captured = await capture; events.push('disk-persist');
  expect(captured.bodyReadSucceeded).toBe(true); expect(captured.body).toEqual({ exact: true });
  expect(events).toEqual(['click', 'body-read', 'navigation-finished', 'disk-persist']);
});

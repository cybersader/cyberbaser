import { expect, test } from 'bun:test';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { createChangeSetProposal, serializeChangeSetProposal } from '@cyberbaser/proposal';
import { createQueueFilesystem, openProposalQueue } from '@cyberbaser/proposal-queue';
import { createReviewIpcHandler } from '../src/review-ipc.js';
import { openIntakeService } from '../src/server.js';
import { BASE_TEXT, createFixture, FORM_ORIGIN, REPOSITORY, request, SOURCE_PATH } from './helpers.js';

const at = '2026-11-21T10:00:00Z';
const clock = () => new Date(at);
const submitter = { id: 'synthetic-agent', keyId: 'agent-fixture-key', kind: 'agent', label: 'Synthetic agent' };
const verifiedSubject = { author: submitter.id, authorType: 'agent' };
const start = Buffer.from(BASE_TEXT).indexOf('teh');
const operations = [{ operationId: 'spelling', start, end: start + 3, expected: 'teh', replacement: 'the' }];
const refused = { schemaVersion: 1, error: { code: 'proposal-submission-refused' } };

function handoff(fixture) {
  const proposal = createChangeSetProposal(Buffer.from(BASE_TEXT), {
    proposalId: 'signed-fixture', source: { repository: REPOSITORY, revision: fixture.revision, path: SOURCE_PATH }, operations,
    submission: { submittedAt: at, rationale: 'Correct the misspelling.', evidence: [], identityClaim: null },
  });
  return { bindingDigest: fixture.bindingDigest, operation: 'submit-signed', proposalText: serializeChangeSetProposal(proposal), schemaVersion: 1, submitter };
}

async function submit(service, input) {
  const handle = createReviewIpcHandler({ review: service.review, submitSigned: service.submitSigned });
  // Fixed request and actor keys above are already in canonical order.
  return JSON.parse((await handle(Buffer.from(`${JSON.stringify(input)}\n`))).toString('utf8'));
}

function post(service, endpoint, body) {
  return service.fetch(request(endpoint, { method: 'POST', origin: FORM_ORIGIN,
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), { address: '192.0.2.1' });
}

test('public intake routes accept neither signed carriers nor claimed verification', async () => {
  const fixture = await createFixture();
  let service;
  try {
    service = await openIntakeService({ config: fixture.config, clock });
    const signed = handoff(fixture);
    const visitor = fixture.intent();
    const suggestions = { schemaVersion: 2, artifactType: visitor.artifactType, bindingDigest: visitor.bindingDigest,
      pageId: visitor.pageId, operations, idempotencyKey: 'A'.repeat(32) };
    for (const [route, draft] of [['/v1/corrections', visitor], ['/v2/suggestions', suggestions]]) {
      for (const body of [signed, { ...draft, lane: 'lane-signed', submitter }, { ...draft, verifiedSubject }]) {
        expect((await post(service, route, body)).status).toBe(400);
        expect(service.stats().pendingEntries).toBe(0);
      }
    }
    expect((await post(service, '/submit-signed', signed)).status).toBe(404);
    expect(service.stats().pendingEntries).toBe(0);
    expect((await post(service, '/v1/corrections', visitor)).status).toBe(202);
    expect((await post(service, '/v2/suggestions', suggestions)).status).toBe(202);
    const rows = await service.review.list({ state: 'pending-review' });
    expect(rows).toHaveLength(2);
    for (const { carrier, classification } of rows) {
      expect(carrier.lane).toBe('lane-b');
      expect(classification.verifiedSubject).toBeNull();
    }
  } finally {
    await service?.close();
    await fixture.cleanup();
  }
});

for (const afterRename of [false, true]) {
  test(`signed handoff interrupted ${afterRename ? 'after' : 'before'} commit recovers create-once`, async () => {
    const fixture = await createFixture();
    const config = fixture.config;
    let queue;
    let service;
    let reopened;
    let triggered = false;
    let armed = false;
    function interrupt() {
      if (!armed || triggered) return;
      triggered = true;
      throw new Error('synthetic interruption before acknowledgement');
    }
    try {
      queue = await openProposalQueue({ config: config.queue, clock: () => at,
        filesystem: createQueueFilesystem({
          beforeRename(source) {
            if (!afterRename && path.basename(source).startsWith('.stage-')) interrupt();
          },
          beforeDirectorySync(directory) {
            if (afterRename && path.basename(directory) === 'pending') interrupt();
          },
        }),
      });
      service = await openIntakeService({ config, clock, queue });
      const input = handoff(fixture);
      const missingActor = { ...input };
      delete missingActor.submitter;
      expect(await submit(service, missingActor)).toEqual({ schemaVersion: 1, error: { code: 'invalid-request' } });
      armed = true;
      expect(await submit(service, input)).toEqual(refused);
      expect(triggered).toBe(true);
      await service.close();
      service = null;
      queue = null;

      // Restart with the real retained manifest and Git evidence resolver, not
      // an injected queue and without a current binding on the replay.
      reopened = await openIntakeService({ config, clock });
      expect(reopened.stats().pendingEntries).toBe(afterRename ? 1 : 0);
      expect(await readdir(path.join(config.queue.root, 'staging'))).toEqual([]);
      const noBinding = { ...input, bindingDigest: null };
      if (!afterRename) expect(await submit(reopened, noBinding)).toEqual(refused);
      const response = await submit(reopened, afterRename ? noBinding : input);
      expect(response).toEqual({ schemaVersion: 1, operation: 'submit-signed',
        receipt: { queueId: expect.stringMatching(/^Q-/u), acceptedAt: at, baseBound: true } });
      expect(await submit(reopened, noBinding)).toEqual(response);
      expect(reopened.stats().pendingEntries).toBe(1);
      const row = await reopened.review.load(response.receipt.queueId);
      expect(row.carrier).toMatchObject({ lane: 'lane-signed', metadata: { bindingDigest: fixture.bindingDigest, submitter } });
      expect(row.classification).toMatchObject({ verifiedSubject, classification: { tier: 'unregistered-agent', route: 'full-review' } });
    } finally {
      await service?.close();
      await queue?.close();
      await reopened?.close();
      await fixture.cleanup();
    }
  });
}

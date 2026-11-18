import { afterEach, expect, test } from 'bun:test';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { applyProposal, parseProposal } from '../../../packages/proposal/src/index.js';
import {
  CONFIG as LANE_A,
  jsonResponse,
  pullRequestPayload,
  repositoryPayload,
  userPayload,
} from '../../../packages/forgejo-intake/test/fixtures.js';
import { createGitFixture } from '../../../packages/forgejo-intake/test/git-fixture.js';
import { validateConfig } from '../src/config.js';
import { openIntakeService, startIntakeRuntime } from '../src/server.js';
import { laneARequestDigest } from '../src/forgejo-watcher.js';
import { configInput, createFixture } from './helpers.js';

const cleanup = [];

afterEach(async () => {
  for (const item of cleanup.splice(0).reverse()) await item();
});

function forgejoBlock(root, overrides = {}) {
  return {
    enabled: true,
    apiBaseUrl: LANE_A.forgejo.apiBaseUrl,
    repository: { ...LANE_A.repository },
    cloneDir: path.join(root, 'forge-clone'),
    pollIntervalMs: 60_000,
    tokenFile: null,
    ...overrides,
  };
}

// A fetch that consumes responses from a live array, so a test can add the
// next poll's responses after the service is open.
function liveFetch(responses, calls) {
  return async (url, options) => {
    calls.push({ url: url.toString(), options });
    const next = responses.shift();
    if (next === undefined) throw new Error('unexpected fetch');
    return next;
  };
}

function listing(pullRequests) {
  return jsonResponse(pullRequests.map((item) => pullRequestPayload(item)));
}

function pullRequestReads(git, { number = 42, headSha = git.headSha, baseSha = git.baseSha } = {}) {
  return [
    jsonResponse({ version: '16.0.5' }),
    jsonResponse(repositoryPayload()),
    jsonResponse(pullRequestPayload({ number, html_url: `https://forge.example:8443/owner/wiki/pulls/${number}`, base: { ...pullRequestPayload().base, sha: baseSha }, head: { ...pullRequestPayload().head, sha: headSha } })),
    jsonResponse(userPayload({ is_admin: false })),
  ];
}

async function watcherFixture({ responses, pollIntervalMs = 60_000 }) {
  const intake = await createFixture();
  cleanup.push(() => intake.cleanup());
  const forge = await createGitFixture({
    baseText: '# Handbook\n\nHandover happens at 09:00 local time.\n',
    headText: '# Handbook\n\nHandover happens at 09:00 UTC.\n',
  });
  cleanup.push(() => forge.cleanup());
  const config = validateConfig(configInput(intake.root, {
    listen: null,
    publicOrigin: null,
    allowedFormOrigins: [],
    forgejo: forgejoBlock(intake.root, { pollIntervalMs }),
  }));
  const calls = [];
  const events = [];
  let nextId = 1;
  const open = () => openIntakeService({
    config,
    queueIdFactory: () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`,
    forgejo: {
      fetch: liveFetch(responses, calls),
      execute: forge.execute,
      getToken: () => 'watcher-secret',
      clock: () => new Date('2026-09-30T12:00:00Z'),
      log: (event) => events.push(event),
    },
  });
  return { intake, forge, config, calls, events, open };
}

test('the watcher lists open pull requests, enqueues each new head exactly once, skips refusals, and never writes to the forge', async () => {
  const responsesHolder = [];
  const fixture = await watcherFixture({ responses: responsesHolder });
  const { forge, calls, events } = fixture;
  // Poll 1: one open request plus one draft. Poll 2: same listing, nothing new.
  responsesHolder.push(
    jsonResponse({ version: '16.0.5' }),
    listing([
      { number: 42, base: { ...pullRequestPayload().base, sha: forge.baseSha }, head: { ...pullRequestPayload().head, sha: forge.headSha } },
      { number: 43, draft: true, base: { ...pullRequestPayload().base, sha: forge.baseSha }, head: { ...pullRequestPayload().head, sha: 'c'.repeat(40) } },
    ]),
    ...pullRequestReads(forge),
    jsonResponse({ version: '16.0.5' }),
    listing([
      { number: 42, base: { ...pullRequestPayload().base, sha: forge.baseSha }, head: { ...pullRequestPayload().head, sha: forge.headSha } },
    ]),
  );
  const service = await fixture.open();
  cleanup.push(() => service.close());
  expect(service.fetch).toBeFunction();
  const noForm = await service.fetch(new Request('https://intake.example/v1/corrections', { method: 'POST' }));
  expect(noForm.status).toBe(404);

  const first = await service.forgejo.pollOnce();
  expect(first.listed).toBe(2);
  expect(first.enqueued).toEqual([{ pullRequestNumber: 42, headSha: forge.headSha, queueId: 'Q-00000000-0000-4000-8000-000000000001', replayed: false }]);
  expect(first.skipped).toEqual([]);
  expect(calls.every(({ options }) => options.method === 'GET')).toBe(true);
  expect(calls.map(({ url }) => new URL(url).pathname + new URL(url).search)).toEqual([
    '/api/v1/version',
    '/api/v1/repos/owner/wiki/pulls?state=open&sort=oldest&page=1&limit=50',
    '/api/v1/version',
    '/api/v1/repos/owner/wiki',
    '/api/v1/repos/owner/wiki/pulls/42',
    '/api/v1/users/alice',
  ]);

  const entries = await service.review.list({ state: 'pending-review' });
  expect(entries).toHaveLength(1);
  const entry = entries[0];
  expect(entry.carrier).toMatchObject({ lane: 'lane-a', metadata: { repositoryId: '731', pullRequestNumber: 42, headSha: forge.headSha } });
  expect(entry.receipt.lane).toBe('lane-a');
  expect(entry.receipt.requestDigest).toBe(laneARequestDigest({ repositoryId: '731', pullRequestNumber: 42, headSha: forge.headSha }));
  expect(entry.classification.verifiedSubject).toEqual({ author: 'forgejo:https://forge.example:8443#user=123', authorType: 'human' });
  expect(entry.classification.classification.route).toBe('auto-merge');
  expect(entry.proposal.proposalId).toBe(`forgejo-pr:731:42:${forge.headSha}`);
  expect(entry.proposal.source).toEqual({ repository: LANE_A.repository.url, revision: forge.baseSha, path: 'docs/notes.md' });
  const candidate = applyProposal(Buffer.from('# Handbook\n\nHandover happens at 09:00 local time.\n'), parseProposal(entry.proposalText));
  expect(candidate.toString('utf8')).toBe('# Handbook\n\nHandover happens at 09:00 UTC.\n');
  expect(JSON.stringify(entries)).not.toContain('watcher-secret');
  expect(JSON.stringify(events)).not.toContain('watcher-secret');

  // The clone retained the base commit and left no temporary refs.
  const cloneRefs = (await forge.execute({ command: 'git', args: ['-C', fixture.config.forgejo.cloneDir, 'for-each-ref', '--format=%(refname)'], maxBytes: 65536 })).stdout.toString('utf8').trim().split('\n');
  expect(cloneRefs).toEqual([`refs/cyberbaser/lane-a/retained/${forge.baseSha}`]);
  expect((await lstat(fixture.config.forgejo.cloneDir)).mode & 0o077).toBe(0);

  // Poll 2: the same head is not read or enqueued again.
  const second = await service.forgejo.pollOnce();
  expect(second).toEqual({ listed: 1, enqueued: [], skipped: [], failed: [] });
  expect(calls).toHaveLength(8);
  expect(await service.review.list({ state: 'pending-review' })).toHaveLength(1);
  expect(service.forgejo.state()).toMatchObject({ polls: 2, enqueued: 1, replayed: 0, skipped: 0, failures: 0, running: false });

  // The forge's own refs are exactly as the fixture left them: nothing was pushed.
  expect(await forge.bareGit(['for-each-ref', '--format=%(refname)'])).toBe('refs/heads/main\nrefs/pull/42/head');
});

test('a new head of the same request enqueues a second entry, a two-file request is skipped with the adapter code, and recovery proves Lane A entries from the clone', async () => {
  const responsesHolder = [];
  const fixture = await watcherFixture({ responses: responsesHolder });
  const { forge } = fixture;
  responsesHolder.push(
    jsonResponse({ version: '16.0.5' }),
    listing([{ number: 42, base: { ...pullRequestPayload().base, sha: forge.baseSha }, head: { ...pullRequestPayload().head, sha: forge.headSha } }]),
    ...pullRequestReads(forge),
  );
  const service = await fixture.open();
  cleanup.push(() => service.close());
  await service.forgejo.pollOnce();

  // The author pushes again: a new head on the same request, changing a second file too.
  await forge.git(['checkout', '-q', forge.headSha]);
  const { writeFile: write, mkdir: makeDir } = await import('node:fs/promises');
  await makeDir(path.join(forge.checkout, 'docs'), { recursive: true });
  await write(path.join(forge.checkout, 'docs', 'notes.md'), '# Handbook\n\nHandover happens at 09:00 UTC sharp.\n');
  await forge.git(['add', '--all']);
  await forge.git(['commit', '-q', '-m', 'Second head']);
  const secondHead = await forge.git(['rev-parse', 'HEAD']);
  await forge.git(['remote', 'set-url', 'origin', `file://${forge.bare}`]);
  await forge.git(['push', '-q', 'origin', `HEAD:refs/pull/42/head`]);
  await write(path.join(forge.checkout, 'docs', 'other.md'), '# Other\n\nA second file.\n');
  await forge.git(['add', '--all']);
  await forge.git(['commit', '-q', '-m', 'Two files']);
  const twoFileHead = await forge.git(['rev-parse', 'HEAD']);
  await forge.git(['push', '-q', 'origin', `HEAD:refs/pull/44/head`]);
  await forge.git(['remote', 'set-url', 'origin', LANE_A.repository.url]);

  responsesHolder.push(
    jsonResponse({ version: '16.0.5' }),
    listing([
      { number: 42, base: { ...pullRequestPayload().base, sha: forge.baseSha }, head: { ...pullRequestPayload().head, sha: secondHead } },
      { number: 44, base: { ...pullRequestPayload().base, sha: forge.baseSha }, head: { ...pullRequestPayload().head, sha: twoFileHead } },
    ]),
    ...pullRequestReads(forge, { number: 42, headSha: secondHead }),
    ...pullRequestReads(forge, { number: 44, headSha: twoFileHead }),
  );
  const poll = await service.forgejo.pollOnce();
  expect(poll.enqueued).toEqual([{ pullRequestNumber: 42, headSha: secondHead, queueId: 'Q-00000000-0000-4000-8000-000000000002', replayed: false }]);
  expect(poll.skipped).toEqual([{ pullRequestNumber: 44, headSha: twoFileHead, code: 'invalid-change-shape' }]);
  const pending = await service.review.list({ state: 'pending-review' });
  expect(pending.map((entry) => entry.carrier.metadata.headSha)).toEqual([forge.headSha, secondHead]);

  // The skipped head is not asked about again while it stays the same.
  responsesHolder.push(
    jsonResponse({ version: '16.0.5' }),
    listing([{ number: 44, base: { ...pullRequestPayload().base, sha: forge.baseSha }, head: { ...pullRequestPayload().head, sha: twoFileHead } }]),
  );
  expect(await service.forgejo.pollOnce()).toEqual({ listed: 1, enqueued: [], skipped: [], failed: [] });

  // Restart: the queue recovers both Lane A entries by re-proving them from the clone's retained objects.
  await service.close();
  cleanup.pop();
  const reopened = await fixture.open();
  cleanup.push(() => reopened.close());
  const recovered = await reopened.review.list({ state: 'pending-review' });
  expect(recovered.map((entry) => entry.queueId)).toEqual(['Q-00000000-0000-4000-8000-000000000001', 'Q-00000000-0000-4000-8000-000000000002']);
  expect(reopened.forgejo.state().seen).toBe(0);
  await reopened.forgejo.prepare();
  expect(reopened.forgejo.state().seen).toBe(2);
});

test('the runtime starts without a public listener when the form is off and stops the watcher on close', async () => {
  const responsesHolder = [jsonResponse({ version: '16.0.5' }), listing([])];
  const fixture = await watcherFixture({ responses: responsesHolder, pollIntervalMs: 10_000 });
  let started = 0;
  const runtime = await startIntakeRuntime({
    config: fixture.config,
    serviceOptions: {
      forgejo: { fetch: liveFetch(responsesHolder, fixture.calls), execute: fixture.forge.execute, clock: () => new Date('2026-09-30T12:00:00Z') },
    },
    startPublic: () => { started += 1; throw new Error('the public listener must not start when listen is null'); },
  });
  cleanup.push(() => runtime.close());
  expect(runtime.server).toBeNull();
  expect(started).toBe(0);
  expect(runtime.service.forgejo.state().running).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(runtime.service.forgejo.state().polls).toBe(1);
  await runtime.close();
  cleanup.pop();
  expect(runtime.service.forgejo.state().running).toBe(false);
});

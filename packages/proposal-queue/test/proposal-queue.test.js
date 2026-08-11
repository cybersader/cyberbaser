import { afterEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import {
  link,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseConfig } from '@cyberbaser/trust';
import { prepareProposal, serializeProposal } from '@cyberbaser/proposal';
import {
  DEFAULT_QUEUE_CONFIG,
  ProposalQueueError,
  createQueueFilesystem,
  inspectProposalQueue,
  openProposalQueue,
  proposalSemantics,
  validateProposalQueueConfig,
} from '../src/index.js';

const cleanup = [];
const openQueues = [];
const BASE = Buffer.from('---\ntitle: Example\n---\n\nA line about teh process.\n');
const TRUST_CONFIG = parseConfig(`
trusted:
  - forgejo:https://forge.example#user=7
agents: []
caps:
  lines: 60
  files: 5
  proseWords: 25
allowedNewFolders:
  - "docs/**"
frontmatterAllowlist:
  - title
`);
const POLICY_DIGEST = `sha-256=:${Buffer.alloc(32, 1).toString('base64')}:`;
const POLICY = Object.freeze({ status: 'valid', digest: POLICY_DIGEST, config: TRUST_CONFIG });
const HEAD_SHA = 'a'.repeat(40);

function stamp(day = 0, second = 0) {
  return new Date(Date.UTC(2026, 7, 10 + day, 12, 0, second))
    .toISOString()
    .replace('.000Z', 'Z');
}

function digest(byte) {
  return `sha-256=:${Buffer.alloc(32, byte).toString('base64')}:`;
}

function proposalText({
  proposalId = 'queue:test-1',
  revision = 'revision-1',
  pathName = 'docs/example.md',
  replacement = 'the',
} = {}) {
  return serializeProposal(prepareProposal(BASE, {
    proposalId,
    source: {
      repository: 'https://forge.example/owner/wiki.git',
      revision,
      path: pathName,
    },
    operation: {
      type: 'quote',
      selector: { quote: 'teh', prefix: 'A line about ', suffix: ' process.' },
      replacement,
    },
    submission: {
      submittedAt: stamp(),
      rationale: 'Correct the misspelling.',
      evidence: [],
      identityClaim: null,
    },
  }));
}

function laneBInput(overrides = {}) {
  return {
    proposalText: proposalText(),
    baseBytes: BASE,
    policy: POLICY,
    verifiedSubject: null,
    carrier: {
      lane: 'lane-b',
      metadata: { bindingDigest: digest(2), pageId: 'docs/example' },
    },
    idempotency: {
      scope: 'lane-b',
      key: randomBytes(32).toString('base64url'),
      requestDigest: digest(3),
    },
    ...overrides,
  };
}

function laneAInput(overrides = {}) {
  return {
    proposalText: proposalText({ proposalId: 'forgejo-pr:1:2:a' }),
    baseBytes: BASE,
    policy: POLICY,
    verifiedSubject: {
      author: 'forgejo:https://forge.example#user=7',
      authorType: 'human',
    },
    carrier: {
      lane: 'lane-a',
      metadata: { repositoryId: '1', pullRequestNumber: 2, headSha: HEAD_SHA },
    },
    idempotency: {
      scope: `forgejo:1:2:${HEAD_SHA}`,
      key: null,
      requestDigest: digest(4),
    },
    ...overrides,
  };
}

const resolveEvidence = async () => ({ baseBytes: BASE, policy: POLICY });

async function openTracked(options) {
  const queue = await openProposalQueue(options);
  openQueues.push(queue);
  return queue;
}

async function closeTracked(queue) {
  await queue.close();
  const index = openQueues.indexOf(queue);
  if (index !== -1) openQueues.splice(index, 1);
}

async function fixture(config = {}, options = {}) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'proposal-queue-'));
  cleanup.push(parent);
  const root = path.join(parent, 'queue');
  let current = options.at ?? stamp();
  const queue = await openTracked({
    config: { root, ...config },
    clock: () => current,
    resolveEvidence,
    ...(options.filesystem === undefined ? {} : { filesystem: options.filesystem }),
    ...(options.idFactory === undefined ? {} : { idFactory: options.idFactory }),
  });
  return {
    parent,
    root,
    queue,
    setClock(value) { current = value; },
  };
}

function expectCode(action, code) {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ProposalQueueError);
    expect(error.code).toBe(code);
    return error;
  }
  throw new Error(`expected ProposalQueueError(${code})`);
}

async function expectCodeAsync(action, code) {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(ProposalQueueError);
    expect(error.code).toBe(code);
    return error;
  }
  throw new Error(`expected ProposalQueueError(${code})`);
}

afterEach(async () => {
  await Promise.all(openQueues.splice(0).map((queue) => queue.close()));
  await Promise.all(cleanup.splice(0).map((target) => rm(target, { recursive: true, force: true })));
});

describe('configuration and canonical durable artifacts', () => {
  test('publishes the approved bounded defaults', () => {
    expect(DEFAULT_QUEUE_CONFIG).toEqual({
      maxPendingEntries: 1000,
      maxRetainedBytes: 256 * 1024 * 1024,
      maxPendingPerSource: 25,
      pendingRetentionDays: 30,
      expiredGraceDays: 7,
    });
    const config = validateProposalQueueConfig({ root: '/tmp/cyberbaser-proposal-queue' });
    expect(config.maxPendingEntries).toBe(1000);
    expect(config.maxRetainedBytes).toBe(256 * 1024 * 1024);
    expectCode(
      () => validateProposalQueueConfig({ root: '/tmp/q', maxPendingEntries: 10_001 }),
      'invalid-queue-config',
    );
  });

  test('stores exact canonical proposal bytes in one Q-<uuid> entry with strict metadata', async () => {
    const { queue, root } = await fixture();
    const input = laneBInput();
    const accepted = await queue.enqueue(input);
    expect(accepted.replayed).toBe(false);
    expect(accepted.receipt.queueId).toMatch(/^Q-[0-9a-f-]{36}$/);
    expect(accepted.receipt.expiresAt).toBe(stamp(30));
    const entry = await queue.load(accepted.receipt.queueId);
    expect(entry.state.state).toBe('pending-review');
    expect(entry.receipt.proposalByteLength).toBe(Buffer.byteLength(input.proposalText));
    expect(entry.classification.verifiedSubject).toBeNull();
    expect(entry.classification.classification).toMatchObject({
      tier: 'anonymous',
      route: 'full-review',
    });

    const directory = path.join(root, 'pending', entry.queueId);
    expect((await readdir(directory)).sort()).toEqual([
      'carrier.json',
      'classification.json',
      'proposal.json',
      'receipt.json',
      'state.json',
    ]);
    expect(await readFile(path.join(directory, 'proposal.json'))).toEqual(Buffer.from(input.proposalText));
    for (const name of await readdir(directory)) {
      expect((await lstat(path.join(directory, name))).mode & 0o777).toBe(0o600);
    }
    expect((await lstat(directory)).mode & 0o777).toBe(0o700);
    expect(Object.isFrozen(entry.receipt)).toBe(true);
  });

  test('persists only the Lane B idempotency key digest', async () => {
    const { queue, root } = await fixture();
    const input = laneBInput();
    const accepted = await queue.enqueue(input);
    const directory = path.join(root, 'pending', accepted.receipt.queueId);
    const durable = Buffer.concat(await Promise.all(
      (await readdir(directory)).map((name) => readFile(path.join(directory, name))),
    )).toString('utf8');
    expect(durable).not.toContain(input.idempotency.key);
    expect(durable).not.toContain('"key"');
    expect(accepted.receipt.idempotencyKeyDigest).toMatch(/^sha-256=:/);
    expect((await queue.load(accepted.receipt.queueId)).carrier.replayScope).toMatch(/^sha-256=:/);
  });

  test('rejects noncanonical or tampered durable metadata on recovery', async () => {
    const { queue, root } = await fixture();
    const accepted = await queue.enqueue(laneBInput());
    await closeTracked(queue);
    const receiptPath = path.join(root, 'pending', accepted.receipt.queueId, 'receipt.json');
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
    await writeFile(receiptPath, `${JSON.stringify({ ...receipt, extra: true })}\n`, { mode: 0o600 });
    await expectCodeAsync(() => openProposalQueue({
      config: { root },
      clock: () => stamp(),
      resolveEvidence,
    }), 'unknown-field');
  });
});

describe('filesystem safety, locking, and crash recovery', () => {
  test('rejects symlinked queue roots and no-follows artifact symlinks', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'proposal-queue-link-'));
    cleanup.push(parent);
    const target = path.join(parent, 'target');
    await mkdir(target, { mode: 0o700 });
    const rootLink = path.join(parent, 'queue');
    await symlink(target, rootLink);
    await expectCodeAsync(() => openProposalQueue({ config: { root: rootLink } }), 'queue-symlink-rejected');

    const fixtureValue = await fixture();
    const accepted = await fixtureValue.queue.enqueue(laneBInput());
    await closeTracked(fixtureValue.queue);
    const proposalPath = path.join(
      fixtureValue.root,
      'pending',
      accepted.receipt.queueId,
      'proposal.json',
    );
    const outside = path.join(fixtureValue.parent, 'outside.json');
    await writeFile(outside, proposalText(), { mode: 0o600 });
    await unlink(proposalPath);
    await symlink(outside, proposalPath);
    await expectCodeAsync(() => openProposalQueue({
      config: { root: fixtureValue.root },
      clock: () => stamp(),
      resolveEvidence,
    }), 'queue-symlink-rejected');
  });

  test('holds one nonblocking kernel lock and ignores persistent lock-file existence', async () => {
    const { queue, root } = await fixture();
    const filesystem = createQueueFilesystem();
    await expectCodeAsync(() => filesystem.acquireLock(root), 'lock-busy');
    await closeTracked(queue);
    await writeFile(path.join(root, '.queue.lock'), 'stale note\n', { mode: 0o600 });
    const reopened = await openTracked({
      config: { root },
      clock: () => stamp(),
      resolveEvidence,
    });
    expect(reopened.stats().pendingEntries).toBe(0);
  });

  test('inspects retained entries without recovery, retention, or filesystem mutation', async () => {
    const fixtureValue = await fixture({ pendingRetentionDays: 1, expiredGraceDays: 1 });
    const accepted = await fixtureValue.queue.enqueue(laneBInput());
    await expectCodeAsync(() => inspectProposalQueue({
      config: {
        root: fixtureValue.root,
        pendingRetentionDays: 1,
        expiredGraceDays: 1,
      },
      resolveEvidence,
    }), 'lock-busy');
    await closeTracked(fixtureValue.queue);

    const entryDirectory = path.join(fixtureValue.root, 'pending', accepted.receipt.queueId);
    const before = Object.fromEntries(await Promise.all(
      (await readdir(entryDirectory)).map(async (name) => [name, await readFile(path.join(entryDirectory, name))]),
    ));
    const inspector = await inspectProposalQueue({
      config: {
        root: fixtureValue.root,
        pendingRetentionDays: 1,
        expiredGraceDays: 1,
      },
      resolveEvidence,
    });
    openQueues.push(inspector);
    expect((await inspector.list({ state: 'pending-review' }))[0].queueId).toBe(accepted.receipt.queueId);
    expect((await inspector.load(accepted.receipt.queueId)).state.state).toBe('pending-review');
    expect(inspector.stats()).toMatchObject({ pendingEntries: 1, expiredEntries: 0 });
    await closeTracked(inspector);

    expect(await readdir(path.join(fixtureValue.root, 'expired'))).toEqual([]);
    expect(await readdir(path.join(fixtureValue.root, 'pending'))).toEqual([accepted.receipt.queueId]);
    for (const [name, bytes] of Object.entries(before)) {
      expect(await readFile(path.join(entryDirectory, name))).toEqual(bytes);
    }
  });

  test('read-only inspection refuses a queue that requires recovery without cleaning it', async () => {
    const fixtureValue = await fixture();
    await closeTracked(fixtureValue.queue);
    const staging = path.join(fixtureValue.root, 'staging', '.stage-Q-00000000-0000-4000-8000-000000000000-test');
    await mkdir(staging, { mode: 0o700 });
    await expectCodeAsync(() => inspectProposalQueue({
      config: { root: fixtureValue.root },
      resolveEvidence,
    }), 'queue-recovery-required');
    expect(await readdir(path.join(fixtureValue.root, 'staging'))).toEqual([path.basename(staging)]);
  });

  test('removes an interrupted durable stage on the next open', async () => {
    let failRename = true;
    const filesystem = createQueueFilesystem({
      beforeRename(source) {
        if (failRename && path.basename(source).startsWith('.stage-')) {
          failRename = false;
          throw new Error('injected pre-rename crash');
        }
      },
    });
    const fixtureValue = await fixture({}, { filesystem });
    const input = laneBInput();
    await expect(fixtureValue.queue.enqueue(input)).rejects.toThrow('injected pre-rename crash');
    expect(await readdir(path.join(fixtureValue.root, 'staging'))).toEqual([]);
    await closeTracked(fixtureValue.queue);
    const reopened = await openTracked({
      config: { root: fixtureValue.root },
      clock: () => stamp(),
      resolveEvidence,
    });
    expect(await readdir(path.join(fixtureValue.root, 'staging'))).toEqual([]);
    expect((await reopened.enqueue(input)).replayed).toBe(false);
  });

  test('recovers a committed rename whose directory fsync reported failure', async () => {
    let failSync = true;
    const filesystem = createQueueFilesystem({
      beforeDirectorySync(directory) {
        if (failSync && path.basename(directory) === 'pending') {
          failSync = false;
          throw new Error('injected post-rename sync failure');
        }
      },
    });
    const fixtureValue = await fixture({}, { filesystem });
    const input = laneBInput();
    await expect(fixtureValue.queue.enqueue(input)).rejects.toThrow('injected post-rename sync failure');
    await closeTracked(fixtureValue.queue);
    const reopened = await openTracked({
      config: { root: fixtureValue.root },
      clock: () => stamp(),
      resolveEvidence,
    });
    const replay = await reopened.enqueue(input);
    expect(replay.replayed).toBe(true);
    expect(reopened.stats().pendingEntries).toBe(1);
  });

  test('finishes expiration after state rename but before directory move', async () => {
    let failStateSync = false;
    const filesystem = createQueueFilesystem({
      beforeDirectorySync(directory) {
        if (failStateSync && path.basename(directory).startsWith('Q-')) {
          failStateSync = false;
          throw new Error('injected state sync failure');
        }
      },
    });
    const fixtureValue = await fixture({ pendingRetentionDays: 1 }, { filesystem });
    const accepted = await fixtureValue.queue.enqueue(laneBInput());
    fixtureValue.setClock(stamp(1));
    failStateSync = true;
    await expect(fixtureValue.queue.expireDue()).rejects.toThrow('injected state sync failure');
    await closeTracked(fixtureValue.queue);
    const reopened = await openTracked({
      config: { root: fixtureValue.root, pendingRetentionDays: 1 },
      clock: () => stamp(1),
      resolveEvidence,
    });
    expect((await reopened.load(accepted.receipt.queueId)).state.state).toBe('expired');
    expect(await readdir(path.join(fixtureValue.root, 'pending'))).toEqual([]);
  });

  test('recovers a purge moved durably into staging before removal', async () => {
    let failPurgeSync = false;
    const filesystem = createQueueFilesystem({
      beforeDirectorySync(directory) {
        if (failPurgeSync && path.basename(directory) === 'expired') {
          failPurgeSync = false;
          throw new Error('injected purge sync failure');
        }
      },
    });
    const fixtureValue = await fixture(
      { pendingRetentionDays: 1, expiredGraceDays: 1 },
      { filesystem },
    );
    await fixtureValue.queue.enqueue(laneBInput());
    fixtureValue.setClock(stamp(1));
    await fixtureValue.queue.expireDue();
    fixtureValue.setClock(stamp(2));
    failPurgeSync = true;
    await expect(fixtureValue.queue.expireDue()).rejects.toThrow('injected purge sync failure');
    expect((await readdir(path.join(fixtureValue.root, 'staging')))[0]).toStartWith('.purge-Q-');
    await closeTracked(fixtureValue.queue);
    const reopened = await openTracked({
      config: {
        root: fixtureValue.root,
        pendingRetentionDays: 1,
        expiredGraceDays: 1,
      },
      clock: () => stamp(2),
      resolveEvidence,
    });
    expect(reopened.stats()).toMatchObject({ pendingEntries: 0, expiredEntries: 0 });
    expect(await readdir(path.join(fixtureValue.root, 'staging'))).toEqual([]);
  });
});

describe('retention, capacity, idempotency, and semantic projection', () => {
  test('moves only pending-review to expired and purges after the grace period', async () => {
    const fixtureValue = await fixture({ pendingRetentionDays: 1, expiredGraceDays: 1 });
    const accepted = await fixtureValue.queue.enqueue(laneBInput());
    expect((await fixtureValue.queue.expireDue()).expired).toEqual([]);
    fixtureValue.setClock(stamp(1));
    const first = await fixtureValue.queue.expireDue();
    expect(first.expired).toEqual([accepted.receipt.queueId]);
    const expired = await fixtureValue.queue.load(accepted.receipt.queueId);
    expect(expired.state).toMatchObject({ state: 'expired', revision: 1 });
    expect(expired.state.history.map((event) => event.to)).toEqual(['pending-review', 'expired']);
    fixtureValue.setClock(stamp(2));
    const second = await fixtureValue.queue.expireDue();
    expect(second.purged).toEqual([accepted.receipt.queueId]);
    await expectCodeAsync(
      () => fixtureValue.queue.load(accepted.receipt.queueId),
      'queue-entry-not-found',
    );
  });

  test('enforces pending, retained-byte, and per-source capacity', async () => {
    const onePending = await fixture({ maxPendingEntries: 1, maxPendingPerSource: 1 });
    await onePending.queue.enqueue(laneBInput());
    await expectCodeAsync(() => onePending.queue.enqueue(laneBInput({
      proposalText: proposalText({ proposalId: 'queue:other', pathName: 'docs/other.md' }),
      carrier: { lane: 'lane-b', metadata: { bindingDigest: digest(5), pageId: 'docs/other' } },
      idempotency: { scope: 'lane-b', key: randomBytes(32).toString('base64url'), requestDigest: digest(6) },
    })), 'queue-pending-capacity');

    const oneSource = await fixture({ maxPendingEntries: 2, maxPendingPerSource: 1 });
    await oneSource.queue.enqueue(laneBInput());
    await expectCodeAsync(() => oneSource.queue.enqueue(laneBInput({
      proposalText: proposalText({ proposalId: 'queue:same-source', revision: 'revision-2' }),
      idempotency: { scope: 'lane-b', key: randomBytes(32).toString('base64url'), requestDigest: digest(7) },
    })), 'queue-source-capacity');

    const bytes = await fixture({ maxRetainedBytes: 1024 });
    await expectCodeAsync(() => bytes.queue.enqueue(laneBInput()), 'queue-retained-capacity');
  });

  test('provides lane-scoped idempotency, safe probes, and conflicts on changed requests', async () => {
    const { queue } = await fixture();
    const input = laneBInput();
    const first = await queue.enqueue(input);
    const replay = await queue.enqueue(input);
    expect(replay.replayed).toBe(true);
    expect(replay.receipt.queueId).toBe(first.receipt.queueId);

    const probe = await queue.enqueue({
      ...input,
      proposalText: null,
      baseBytes: null,
      policy: null,
    });
    expect(probe.replayed).toBe(true);
    expect(probe.receipt.queueId).toBe(first.receipt.queueId);

    await expectCodeAsync(() => queue.enqueue({
      ...input,
      idempotency: { ...input.idempotency, requestDigest: digest(9) },
    }), 'idempotency-conflict');

    const laneA = await queue.enqueue(laneAInput());
    expect(laneA.receipt.queueId).not.toBe(first.receipt.queueId);
  });

  test('does not deduplicate Lane B requests without an idempotency key', async () => {
    const { queue } = await fixture();
    const input = laneBInput();
    input.idempotency.key = null;
    const first = await queue.enqueue(input);
    const second = await queue.enqueue(input);
    expect(second.replayed).toBe(false);
    expect(second.receipt.queueId).not.toBe(first.receipt.queueId);
    expect(first.receipt.idempotencyKeyDigest).toBeNull();
  });

  test('projects canonical proposals into one carrier-neutral semantic shape', async () => {
    const { queue } = await fixture();
    const laneBReceipt = await queue.enqueue(laneBInput());
    const laneAReceipt = await queue.enqueue(laneAInput());
    const laneB = proposalSemantics((await queue.load(laneBReceipt.receipt.queueId)).proposal);
    const laneA = proposalSemantics((await queue.load(laneAReceipt.receipt.queueId)).proposalText);
    expect(Object.keys(laneA)).toEqual(Object.keys(laneB));
    expect(laneA).toEqual(laneB);
    expect(laneA).toMatchObject({
      source: { path: 'docs/example.md' },
      baseByteLength: BASE.length,
    });
    expect(Object.isFrozen(laneA)).toBe(true);
  });

  test('rejects identity promotion, Lane A raw keys, and unsafe Lane B metadata', async () => {
    const { queue } = await fixture();
    await expectCodeAsync(() => queue.enqueue(laneBInput({
      verifiedSubject: { author: 'claimed-reader', authorType: 'human' },
    })), 'lane-b-subject-forbidden');
    await expectCodeAsync(() => queue.enqueue(laneAInput({
      idempotency: {
        scope: `forgejo:1:2:${HEAD_SHA}`,
        key: randomBytes(32).toString('base64url'),
        requestDigest: digest(4),
      },
    })), 'invalid-idempotency-key');
    await expectCodeAsync(() => queue.enqueue(laneBInput({
      carrier: {
        lane: 'lane-b',
        metadata: { bindingDigest: digest(2), pageId: '/tmp/private/page' },
      },
    })), 'unsafe-metadata');
  });

  test('requires exact evidence to reopen retained entries', async () => {
    const fixtureValue = await fixture();
    await fixtureValue.queue.enqueue(laneBInput());
    await closeTracked(fixtureValue.queue);
    await expectCodeAsync(() => openProposalQueue({
      config: { root: fixtureValue.root },
      clock: () => stamp(),
    }), 'recovery-evidence-required');
    await expect(openProposalQueue({
      config: { root: fixtureValue.root },
      clock: () => stamp(),
      resolveEvidence: async () => ({
        baseBytes: Buffer.from('changed base\n'),
        policy: POLICY,
      }),
    })).rejects.toMatchObject({ code: 'correction-base-length-mismatch' });
  });

  test('rejects extra hard links and corrupted acknowledged classification evidence', async () => {
    const hardlinkFixture = await fixture();
    const hardlinkReceipt = await hardlinkFixture.queue.enqueue(laneBInput());
    await closeTracked(hardlinkFixture.queue);
    const proposalPath = path.join(
      hardlinkFixture.root,
      'pending',
      hardlinkReceipt.receipt.queueId,
      'proposal.json',
    );
    const linked = path.join(hardlinkFixture.parent, 'linked-proposal.json');
    await link(proposalPath, linked);
    await expectCodeAsync(() => openProposalQueue({
      config: { root: hardlinkFixture.root },
      clock: () => stamp(),
      resolveEvidence,
    }), 'unsafe-queue-artifact');

    const corruptFixture = await fixture();
    const corruptReceipt = await corruptFixture.queue.enqueue(laneBInput());
    await closeTracked(corruptFixture.queue);
    const classificationPath = path.join(
      corruptFixture.root,
      'pending',
      corruptReceipt.receipt.queueId,
      'classification.json',
    );
    const classification = JSON.parse(await readFile(classificationPath, 'utf8'));
    classification.classification.reasons = ['forged-reason'];
    await writeFile(classificationPath, `${JSON.stringify(classification)}\n`, { mode: 0o600 });
    await expectCodeAsync(() => openProposalQueue({
      config: { root: corruptFixture.root },
      clock: () => stamp(),
      resolveEvidence,
    }), 'classification-mismatch');
  });

  test('cleans injected write and file-sync failures without acknowledging an entry', async () => {
    for (const hook of ['beforeWrite', 'beforeFileSync']) {
      let failOnce = true;
      const filesystem = createQueueFilesystem({
        [hook]() {
          if (failOnce) {
            failOnce = false;
            throw new Error(`injected-${hook}`);
          }
        },
      });
      const fixtureValue = await fixture({}, { filesystem });
      await expect(fixtureValue.queue.enqueue(laneBInput())).rejects.toThrow(`injected-${hook}`);
      expect(await readdir(path.join(fixtureValue.root, 'pending'))).toEqual([]);
      expect(await readdir(path.join(fixtureValue.root, 'staging'))).toEqual([]);
    }
  });

  test('derives Lane A replay from repository, PR, and head rather than caller scope spelling', async () => {
    const { queue } = await fixture();
    const firstInput = laneAInput();
    const first = await queue.enqueue(firstInput);
    const replay = await queue.enqueue({
      ...firstInput,
      idempotency: { ...firstInput.idempotency, scope: 'different-safe-scope' },
    });
    expect(replay.replayed).toBe(true);
    expect(replay.receipt.queueId).toBe(first.receipt.queueId);

    const nextHead = 'b'.repeat(40);
    const next = await queue.enqueue(laneAInput({
      carrier: {
        lane: 'lane-a',
        metadata: { repositoryId: '1', pullRequestNumber: 2, headSha: nextHead },
      },
      idempotency: {
        scope: 'same-caller-scope',
        key: null,
        requestDigest: digest(10),
      },
      proposalText: proposalText({ proposalId: 'forgejo-pr:1:2:b' }),
    }));
    expect(next.replayed).toBe(false);
    expect(next.receipt.queueId).not.toBe(first.receipt.queueId);
  });
});

import { afterEach, describe, expect, test } from 'bun:test';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import {
  prepareProposal,
  proposalDigest,
  serializeProposal,
} from '@cyberbaser/proposal';
import {
  createReviewEvidence,
  createReviewSummary,
} from '@cyberbaser/proposal-review';
import {
  digestBytes,
  openProposalQueue,
} from '@cyberbaser/proposal-queue';
import { parseConfig } from '@cyberbaser/trust';
import {
  OwnerAlphaError,
  createOwnerProposalReviewSource,
  createProposalReviewClient,
  validateOwnerReviewEvidence,
} from '../src/index.js';
import { canonicalJson } from '../src/json.js';

const execFileAsync = promisify(execFile);
const cleanup = [];
const queues = [];
const servers = [];
const REPOSITORY = 'https://github.com/cybersader/cyberbase.git';
const SOURCE_PATH = 'docs/example.md';
const BASE = Buffer.from('---\ntitle: Example\n---\n\nA line about teh process.\n');
const POLICY_TEXT = 'trusted: []\nagents: []\n';
const RECEIVED_AT = '2026-08-20T12:00:00Z';

function artifactBytes(value) {
  return Buffer.from(`${canonicalJson(value)}\n`, 'utf8');
}

function digest(byte) {
  return `sha-256=:${Buffer.alloc(32, byte).toString('base64')}:`;
}

function rebindProposalReceipt(evidence) {
  evidence.receipt.proposalDigest = proposalDigest(evidence.proposal);
  evidence.receipt.proposalByteLength = Buffer.byteLength(serializeProposal(evidence.proposal), 'utf8');
  return evidence;
}

async function run(cwd, args) {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return stdout.trim();
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'owner-proposal-review-'));
  cleanup.push(root);
  const checkout = path.join(root, 'checkout');
  await mkdir(path.join(checkout, 'docs'), { recursive: true });
  await mkdir(path.join(checkout, '.cyberbaser'), { recursive: true });
  await execFileAsync('git', ['init', '--initial-branch=main', checkout]);
  await run(checkout, ['config', 'user.name', 'Owner Review Test']);
  await run(checkout, ['config', 'user.email', 'owner-review@example.invalid']);
  await run(checkout, ['remote', 'add', 'origin', REPOSITORY]);
  await writeFile(path.join(checkout, SOURCE_PATH), BASE);
  await writeFile(path.join(checkout, '.cyberbaser', 'trust.yml'), POLICY_TEXT);
  await run(checkout, ['add', '.']);
  await run(checkout, ['commit', '-m', 'fixture']);
  const revision = await run(checkout, ['rev-parse', 'HEAD']);

  const rawConfig = JSON.parse(await readFile(
    path.resolve(import.meta.dir, '..', 'owner-alpha.example.json'),
    'utf8',
  ));
  rawConfig.repository.checkout = checkout;

  const proposalText = serializeProposal(prepareProposal(BASE, {
    proposalId: 'owner-review:test',
    source: { repository: REPOSITORY, revision, path: SOURCE_PATH },
    operation: {
      type: 'quote',
      selector: { quote: 'teh', prefix: 'A line about ', suffix: ' process.' },
      replacement: 'the',
    },
    submission: {
      submittedAt: RECEIVED_AT,
      rationale: 'Correct the misspelling.',
      evidence: [],
      identityClaim: null,
    },
  }));
  const policy = {
    status: 'valid',
    digest: digestBytes(Buffer.from(POLICY_TEXT)),
    config: parseConfig(POLICY_TEXT),
  };
  const queue = await openProposalQueue({
    config: { root: path.join(root, 'queue') },
    clock: () => RECEIVED_AT,
    idFactory: () => '00000000-0000-4000-8000-000000000001',
    resolveEvidence: async () => ({ baseBytes: BASE, policy }),
  });
  queues.push(queue);
  const accepted = await queue.enqueue({
    proposalText,
    baseBytes: BASE,
    policy,
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
  });
  const entry = await queue.review.load(accepted.receipt.queueId);
  const evidence = createReviewEvidence({
    queueId: entry.queueId,
    proposalText: entry.proposalText,
    receipt: entry.receipt,
    carrier: entry.carrier,
    classification: entry.classification,
    state: entry.state,
  });
  return { root, checkout, revision, config: rawConfig, evidence };
}

async function expectCode(action, code) {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(OwnerAlphaError);
    expect(error.code).toBe(code);
    return error;
  }
  throw new Error(`expected OwnerAlphaError(${code})`);
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  await Promise.all(queues.splice(0).map((queue) => queue.close()));
  await Promise.all(cleanup.splice(0).map((target) => rm(target, { recursive: true, force: true })));
});

describe('owner proposal review client', () => {
  test('uses canonical bounded list/load exchanges and validates loaded queue evidence', async () => {
    const item = await fixture();
    const summary = createReviewSummary(item.evidence);
    const requests = [];
    const client = createProposalReviewClient({
      socketPath: '/injected/review.sock',
      transport: async (_socketPath, bytes) => {
        requests.push(Buffer.from(bytes));
        const request = JSON.parse(bytes.toString('utf8'));
        return request.operation === 'list'
          ? artifactBytes({ schemaVersion: 1, operation: 'list', entries: [summary], nextCursor: null })
          : artifactBytes({
            schemaVersion: 1,
            operation: 'load',
            entry: {
              queueId: item.evidence.queueId,
              proposalText: serializeProposal(item.evidence.proposal),
              receipt: item.evidence.receipt,
              carrier: item.evidence.carrier,
              classification: item.evidence.classification,
              state: item.evidence.state,
            },
          });
      },
    });

    expect(await client.list()).toEqual({ entries: [summary], nextCursor: null });
    expect(await client.load(item.evidence.queueId)).toEqual(item.evidence);
    for (const request of requests) {
      expect(request.at(-1)).toBe(0x0a);
      expect(request.toString('utf8')).toBe(`${canonicalJson(JSON.parse(request))}\n`);
    }
  });

  test('rejects noncanonical responses, oversized responses, and bounded remote errors', async () => {
    const noncanonical = createProposalReviewClient({
      socketPath: '/injected/review.sock',
      transport: async () => Buffer.from('{ "schemaVersion": 1 }\n'),
    });
    await expectCode(() => noncanonical.list(), 'invalid-review-response');

    const oversized = createProposalReviewClient({
      socketPath: '/injected/review.sock',
      maxResponseBytes: 64,
      transport: async () => Buffer.alloc(65, 0x61),
    });
    await expectCode(() => oversized.list(), 'invalid-review-response');

    const remoteError = createProposalReviewClient({
      socketPath: '/injected/review.sock',
      transport: async () => artifactBytes({ schemaVersion: 1, error: { code: 'busy' } }),
    });
    await expectCode(() => remoteError.list(), 'review-ipc-busy');

    const nesting = 10_000;
    const deepResponse = Buffer.from(
      `{"entries":${'['.repeat(nesting)}null${']'.repeat(nesting)},"nextCursor":null,"operation":"list","schemaVersion":1}\n`,
      'utf8',
    );
    const deeplyNested = createProposalReviewClient({
      socketPath: '/injected/review.sock',
      transport: async () => deepResponse,
    });
    await expectCode(() => deeplyNested.list(), 'invalid-review-response');
  });

  test('connects only to a private runtime-owned Unix socket', async () => {
    const item = await fixture();
    const runtime = path.join(item.root, 'review-runtime');
    const socketPath = path.join(runtime, 'review.sock');
    await mkdir(runtime, { mode: 0o700 });
    await chmod(runtime, 0o700);
    const server = net.createServer((socket) => {
      socket.once('data', () => socket.end(artifactBytes({
        schemaVersion: 1,
        operation: 'list',
        entries: [],
        nextCursor: null,
      })));
    });
    servers.push(server);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    await chmod(socketPath, 0o600);

    const client = createProposalReviewClient({ socketPath });
    expect(await client.list()).toEqual({ entries: [], nextCursor: null });

    await chmod(runtime, 0o755);
    await expectCode(() => client.list(), 'unsafe-review-socket');
  });
});

describe('independent owner proposal validation', () => {
  test('revalidates exact Git source, candidate, trust policy, classification, and expiry', async () => {
    const item = await fixture();
    const validated = await validateOwnerReviewEvidence({
      config: item.config,
      evidence: item.evidence,
      clock: () => new Date('2026-08-20T12:00:01Z'),
    });
    expect(validated.summary).toEqual(createReviewSummary(item.evidence));
    expect(validated.summary).toMatchObject({
      state: 'pending-review',
      lane: 'lane-b',
      tier: 'anonymous',
      route: 'full-review',
    });
    expect(validated.sourceVerification).toMatchObject({
      revision: item.revision,
      path: SOURCE_PATH,
      baseByteLength: BASE.length,
      policyStatus: 'valid',
    });
    expect(await run(item.checkout, ['status', '--porcelain=v1', '--untracked-files=all'])).toBe('');
  });

  test('rejects a valid local commit object that is unreachable from the configured branch', async () => {
    const item = await fixture();
    const tree = await run(item.checkout, ['rev-parse', 'HEAD^{tree}']);
    const detached = await run(item.checkout, ['commit-tree', tree, '-m', 'unreachable fixture']);
    const evidence = structuredClone(item.evidence);
    evidence.proposal.source.revision = detached;
    rebindProposalReceipt(evidence);

    await expectCode(() => validateOwnerReviewEvidence({
      config: item.config,
      evidence,
      clock: () => new Date('2026-08-20T12:00:01Z'),
    }), 'review-revision-unreachable');
  });

  test('rechecks expiry after source and policy validation complete', async () => {
    const item = await fixture();
    const beforeExpiry = new Date(Date.parse(item.evidence.receipt.expiresAt) - 1000);
    const atExpiry = new Date(item.evidence.receipt.expiresAt);
    const times = [beforeExpiry, atExpiry];
    await expectCode(() => validateOwnerReviewEvidence({
      config: item.config,
      evidence: item.evidence,
      clock: () => times.shift() ?? atExpiry,
    }), 'review-expired');
    expect(times).toEqual([]);
  });

  test('fails closed on wall-clock expiry, source partition mismatch, and classification mismatch', async () => {
    const item = await fixture();
    await expectCode(() => validateOwnerReviewEvidence({
      config: item.config,
      evidence: item.evidence,
      clock: () => new Date(item.evidence.receipt.expiresAt),
    }), 'review-expired');

    const partitionMismatch = structuredClone(item.evidence);
    partitionMismatch.receipt.sourcePartitionDigest = digest(9);
    await expectCode(() => validateOwnerReviewEvidence({
      config: item.config,
      evidence: partitionMismatch,
      clock: () => new Date('2026-08-20T12:00:01Z'),
    }), 'review-source-partition-mismatch');

    const classificationMismatch = structuredClone(item.evidence);
    classificationMismatch.classification.classification = {
      ...classificationMismatch.classification.classification,
      route: 'reject',
      reasons: ['tampered-route'],
    };
    await expectCode(() => validateOwnerReviewEvidence({
      config: item.config,
      evidence: classificationMismatch,
      clock: () => new Date('2026-08-20T12:00:01Z'),
    }), 'review-classification-mismatch');

    const policyMismatch = structuredClone(item.evidence);
    policyMismatch.classification.policyDigest = digest(8);
    await expectCode(() => validateOwnerReviewEvidence({
      config: item.config,
      evidence: policyMismatch,
      clock: () => new Date('2026-08-20T12:00:01Z'),
    }), 'review-policy-mismatch');

    const baseMismatch = rebindProposalReceipt(structuredClone(item.evidence));
    baseMismatch.proposal.operation.baseDigest = digest(7);
    rebindProposalReceipt(baseMismatch);
    await expectCode(() => validateOwnerReviewEvidence({
      config: item.config,
      evidence: baseMismatch,
      clock: () => new Date('2026-08-20T12:00:01Z'),
    }), 'invalid-review-evidence');

    const candidateMismatch = structuredClone(item.evidence);
    candidateMismatch.proposal.operation.candidateDigest = digest(8);
    rebindProposalReceipt(candidateMismatch);
    await expectCode(() => validateOwnerReviewEvidence({
      config: item.config,
      evidence: candidateMismatch,
      clock: () => new Date('2026-08-20T12:00:01Z'),
    }), 'invalid-review-evidence');
  });

  test('binds every advertised summary to freshly loaded and revalidated evidence', async () => {
    const item = await fixture();
    const summary = createReviewSummary(item.evidence);
    const client = Object.freeze({
      list: async () => ({ entries: [summary], nextCursor: null }),
      load: async () => item.evidence,
    });
    const source = createOwnerProposalReviewSource({
      config: item.config,
      client,
      clock: () => new Date('2026-08-20T12:00:01Z'),
    });
    const page = await source.list();
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0].evidence).toEqual(item.evidence);

    const tampered = structuredClone(summary);
    tampered.route = 'reject';
    const badSource = createOwnerProposalReviewSource({
      config: item.config,
      client: Object.freeze({
        list: async () => ({ entries: [tampered], nextCursor: null }),
        load: async () => item.evidence,
      }),
      clock: () => new Date('2026-08-20T12:00:01Z'),
    });
    await expectCode(() => badSource.list(), 'invalid-review-evidence');
  });
});

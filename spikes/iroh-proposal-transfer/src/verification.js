import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  applyProposal,
  classifyProposal,
  parseProposal,
  prepareProposal,
  proposalDigest,
  serializeProposal,
} from '@cyberbaser/proposal';
import {
  openProposalQueue,
  proposalSemantics,
} from '@cyberbaser/proposal-queue';
import {
  BASE_BYTES,
  FIXED_NOW,
  fixedIdFactory,
  proposalContentKey,
  runtimeLeakPaths,
  sha256Digest,
  stableStringify,
} from './contracts.js';

const MODULE_DIR = import.meta.dir;
const SPIKE_ROOT = path.dirname(MODULE_DIR);
const RUST_BINARY = path.join(SPIKE_ROOT, 'target', 'debug', 'cyberbaser-iroh-proposal-transfer');
const POLICY = Object.freeze({ status: 'missing', digest: null, config: null });
const BINDING_DIGEST = sha256Digest(Buffer.from('iroh-fixture-binding-v1', 'utf8'));
const RATIONALE = `Controlled local Iroh carrier fixture. ${'Exact proposal bytes remain transport-neutral. '.repeat(260)}`;

function proposalBytes() {
  const proposal = prepareProposal(BASE_BYTES, {
    proposalId: 'iroh-fixture:proposal-1',
    source: {
      repository: 'https://forge.example/owner/wiki.git',
      revision: 'fixture-revision-1',
      path: 'docs/iroh-fixture.md',
    },
    operation: {
      type: 'quote',
      selector: {
        quote: 'teh',
        prefix: 'should correct ',
        suffix: ' exact typo',
      },
      replacement: 'the',
    },
    submission: {
      submittedAt: FIXED_NOW,
      rationale: RATIONALE,
      evidence: [],
      identityClaim: null,
    },
  });
  return Buffer.from(serializeProposal(proposal), 'utf8');
}

async function runCommand(command, args, { cwd, input, timeoutMs = 120_000 } = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1' },
    });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${command} timed out`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const output = Buffer.concat(stdout);
      const errors = Buffer.concat(stderr).toString('utf8');
      if (code !== 0) {
        reject(new Error(`${command} exited ${code ?? signal}: ${errors.trim()}`));
        return;
      }
      resolve({ stdout: output, stderr: errors });
    });
    child.stdin.end(input);
  });
}

async function buildRust() {
  await runCommand('cargo', ['build', '--locked', '--quiet'], { cwd: SPIKE_ROOT, timeoutMs: 600_000 });
}

async function runRust(bytes, workDir) {
  const input = stableStringify({
    proposalBase64: bytes.toString('base64'),
    workDir,
  });
  const result = await runCommand(RUST_BINARY, [], { cwd: SPIKE_ROOT, input });
  if (result.stderr !== '') throw new Error(`Rust harness wrote unexpected stderr: ${result.stderr}`);
  return JSON.parse(result.stdout.toString('utf8'));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function comparableQueueEntry(entry) {
  return {
    proposalText: entry.proposalText,
    semantics: entry.semantics,
    classification: entry.classification,
    carrier: entry.carrier,
    state: { state: entry.state.state },
    proposalDigest: entry.receipt.proposalDigest,
    proposalByteLength: entry.receipt.proposalByteLength,
    requestDigest: entry.receipt.requestDigest,
    idempotencyKeyDigest: entry.receipt.idempotencyKeyDigest,
    sourcePartitionDigest: entry.receipt.sourcePartitionDigest,
  };
}

async function queueScenario(root, bytes, queueId) {
  const parsed = parseProposal(bytes);
  const requestDigest = proposalDigest(parsed);
  const key = proposalContentKey(bytes);
  const queue = await openProposalQueue({
    config: { root },
    clock: () => FIXED_NOW,
    idFactory: fixedIdFactory([queueId]),
    resolveEvidence: async () => ({ baseBytes: BASE_BYTES, policy: POLICY }),
  });
  try {
    const accepted = await queue.enqueue({
      proposalText: bytes,
      baseBytes: BASE_BYTES,
      policy: POLICY,
      verifiedSubject: null,
      carrier: {
        lane: 'lane-b',
        metadata: { bindingDigest: BINDING_DIGEST, pageId: 'docs/iroh-fixture' },
      },
      idempotency: { scope: 'lane-b', key, requestDigest },
    });
    const entry = await queue.load(accepted.receipt.queueId);
    return { accepted, entry, key, stats: await queue.stats() };
  } finally {
    await queue.close();
  }
}

async function combinedQueue(root, directBytes, relayBytes) {
  const key = proposalContentKey(directBytes);
  const requestDigest = proposalDigest(parseProposal(directBytes));
  const queue = await openProposalQueue({
    config: { root },
    clock: () => FIXED_NOW,
    idFactory: fixedIdFactory(['00000000-0000-4000-8000-000000000003']),
    resolveEvidence: async () => ({ baseBytes: BASE_BYTES, policy: POLICY }),
  });
  const input = (bytes) => ({
    proposalText: bytes,
    baseBytes: BASE_BYTES,
    policy: POLICY,
    verifiedSubject: null,
    carrier: {
      lane: 'lane-b',
      metadata: { bindingDigest: BINDING_DIGEST, pageId: 'docs/iroh-fixture' },
    },
    idempotency: { scope: 'lane-b', key, requestDigest },
  });
  try {
    const first = await queue.enqueue(input(directBytes));
    const second = await queue.enqueue(input(relayBytes));
    const entries = await queue.list({ state: 'pending-review' });
    const durable = await readFile(path.join(root, 'pending', first.receipt.queueId, 'carrier.json'), 'utf8');
    return {
      first,
      second,
      pendingEntries: entries.length,
      sameQueueId: first.receipt.queueId === second.receipt.queueId,
      sameReceipt: stableStringify(first.receipt) === stableStringify(second.receipt),
      rawKeyPersisted: durable.includes(key),
    };
  } finally {
    await queue.close();
  }
}

function pathEvidence(receipt) {
  return {
    direct: receipt.direct.selectedPath,
    relayInterrupted: receipt.relay.interrupted.selectedPath,
    relayContinued: receipt.relay.continued.selectedPath,
    relayDuplicate: receipt.relay.duplicate.selectedPath,
  };
}

export async function runIrohVerificationOnce({ skipBuild = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cb-iroh-transfer-'));
  const sourceBefore = Buffer.from(BASE_BYTES);
  const report = {
    schemaVersion: 1,
    artifactType: 'cyberbaser-iroh-proposal-transfer-verification',
    complete: false,
    fixedClock: FIXED_NOW,
    evidenceBoundary: 'controlled-local-replaceable-carrier-fixture',
    protocolSelection: false,
    productionClaim: false,
    proposal: null,
    transport: null,
    equivalence: null,
    queue: null,
    authorityBoundary: null,
    cleanup: null,
    errors: [],
  };
  try {
    const canonical = proposalBytes();
    const canonicalProposal = parseProposal(canonical);
    const canonicalDigest = proposalDigest(canonicalProposal);
    assert(canonical.length > 4096 && canonical.length <= 256 * 1024, 'canonical fixture proposal is outside the transfer size target');
    if (!skipBuild) await buildRust();
    const rustRoot = path.join(root, 'rust');
    const receipt = await runRust(canonical, rustRoot);
    const direct = await readFile(path.join(rustRoot, receipt.files.direct));
    const relay = await readFile(path.join(rustRoot, receipt.files.relay));
    const partial = await readFile(path.join(rustRoot, receipt.files.interruptedPrefix));

    assert(direct.equals(canonical), 'direct Iroh bytes differ from canonical proposal bytes');
    assert(relay.equals(canonical), 'relay Iroh bytes differ from canonical proposal bytes');
    assert(receipt.direct.selectedPath === 'ip', 'direct transfer did not select IP');
    for (const phase of [receipt.relay.interrupted, receipt.relay.continued, receipt.relay.duplicate]) {
      assert(phase.selectedPath === 'relay', 'relay transfer phase did not select relay');
    }
    assert(receipt.relay.interrupted.status === 'interrupted', 'relay transfer did not interrupt');
    assert(receipt.relay.continued.startedAtOffset === receipt.relay.interrupted.completedAtOffset, 'relay continuation did not use the acknowledged offset');
    assert(receipt.relay.duplicate.status === 'already-present' && receipt.relay.duplicate.contentBytesTransferred === 0, 'duplicate transport request transferred content bytes');
    let partialRejected = false;
    try {
      parseProposal(partial);
    } catch {
      partialRejected = true;
    }
    assert(partialRejected, 'interrupted prefix parsed as a canonical proposal');

    const directProposal = parseProposal(direct);
    const relayProposal = parseProposal(relay);
    const directCandidate = applyProposal(BASE_BYTES, directProposal);
    const relayCandidate = applyProposal(BASE_BYTES, relayProposal);
    const directClassification = classifyProposal(BASE_BYTES, directProposal, null, null);
    const relayClassification = classifyProposal(BASE_BYTES, relayProposal, null, null);
    const semantics = proposalSemantics(directProposal);

    assert(proposalDigest(directProposal) === canonicalDigest, 'direct proposal digest changed');
    assert(proposalDigest(relayProposal) === canonicalDigest, 'relay proposal digest changed');
    assert(stableStringify(proposalSemantics(relayProposal)) === stableStringify(semantics), 'proposal semantics changed across paths');
    assert(directCandidate.equals(relayCandidate), 'candidate bytes changed across paths');
    assert(stableStringify(directClassification) === stableStringify(relayClassification), 'trust classification changed across paths');
    assert(directClassification.tier === 'unknown' && directClassification.route === 'full-review' && directClassification.reasons.includes('no-trust-config'), 'anonymous proposal with missing policy did not fail closed to full-review');

    const directQueue = await queueScenario(path.join(root, 'queue-direct'), direct, '00000000-0000-4000-8000-000000000001');
    const relayQueue = await queueScenario(path.join(root, 'queue-relay'), relay, '00000000-0000-4000-8000-000000000002');
    const combined = await combinedQueue(path.join(root, 'queue-combined'), direct, relay);
    assert(stableStringify(comparableQueueEntry(directQueue.entry)) === stableStringify(comparableQueueEntry(relayQueue.entry)), 'isolated queue evidence changed across paths');
    assert(combined.second.replayed && combined.sameQueueId && combined.sameReceipt && combined.pendingEntries === 1, 'completed duplicate did not collapse to one queue receipt');
    assert(!combined.rawKeyPersisted, 'raw content idempotency key was persisted');
    assert(Buffer.from(BASE_BYTES).equals(sourceBefore), 'source fixture bytes changed');

    report.proposal = {
      byteLength: canonical.length,
      contentKey: proposalContentKey(canonical),
      digest: canonicalDigest,
      semantics,
    };
    report.transport = {
      implementation: 'iroh-1.0.3-custom-fixture-alpn',
      transportHash: receipt.transportHash,
      chunkBytes: receipt.chunkBytes,
      paths: pathEvidence(receipt),
      interruption: {
        acknowledgedOffset: receipt.relay.interrupted.completedAtOffset,
        continuedFromSameOffset: receipt.relay.resumedFromAcknowledgedOffset,
        prefixRejectedBeforeQueue: partialRejected,
      },
      duplicate: {
        status: receipt.relay.duplicate.status,
        contentBytesTransferred: receipt.relay.duplicate.contentBytesTransferred,
      },
    };
    report.equivalence = {
      canonicalBytes: direct.equals(relay) && direct.equals(canonical),
      proposalDigest: proposalDigest(directProposal) === proposalDigest(relayProposal),
      proposalSemantics: stableStringify(proposalSemantics(directProposal)) === stableStringify(proposalSemantics(relayProposal)),
      candidateBytes: directCandidate.equals(relayCandidate),
      candidateDigest: sha256Digest(directCandidate),
      anonymousClassification: stableStringify(directClassification) === stableStringify(relayClassification),
      classification: directClassification,
    };
    report.queue = {
      isolatedEquivalent: true,
      exactProposalBytesRetained: Buffer.from(directQueue.entry.proposalText).equals(direct),
      firstReplayed: combined.first.replayed,
      secondReplayed: combined.second.replayed,
      sameQueueId: combined.sameQueueId,
      sameReceipt: combined.sameReceipt,
      pendingEntries: combined.pendingEntries,
      rawContentKeyPersisted: combined.rawKeyPersisted,
    };
    report.authorityBoundary = {
      rustInputKeys: ['proposalBase64', 'workDir'],
      credentialInput: false,
      ownerSourceInput: false,
      gitInput: false,
      sourceApplication: false,
      sourceBytesUnchanged: Buffer.from(BASE_BYTES).equals(sourceBefore),
      partialQueueAdmissions: 0,
    };
    report.cleanup = { temporaryStateRemoved: true };
    const leaks = runtimeLeakPaths(report);
    assert(leaks.length === 0, `deterministic report contains runtime fields: ${leaks.join(', ')}`);
    report.complete = true;
    return report;
  } catch (error) {
    report.errors.push({ code: error?.code ?? error?.name ?? 'error', message: error?.message ?? String(error) });
    return report;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function runIrohVerification() {
  await buildRust();
  const first = await runIrohVerificationOnce({ skipBuild: true });
  const second = await runIrohVerificationOnce({ skipBuild: true });
  const firstBytes = stableStringify(first);
  const secondBytes = stableStringify(second);
  if (firstBytes !== secondBytes) throw new Error('fresh Iroh verification runs were not byte-identical');
  return first;
}

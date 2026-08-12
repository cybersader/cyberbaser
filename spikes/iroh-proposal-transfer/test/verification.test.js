import { describe, expect, test } from 'bun:test';
import { stableStringify } from '../src/contracts.js';
import {
  runIrohVerification,
  runIrohVerificationOnce,
} from '../src/verification.js';

let sharedReport;

async function report() {
  sharedReport ??= runIrohVerificationOnce();
  return await sharedReport;
}

describe('Iroh proposal-transfer fixture', () => {
  test('forces direct IP and local-relay paths on the data connections', async () => {
    const value = await report();
    expect(value.complete).toBe(true);
    expect(value.transport.paths).toEqual({
      direct: 'ip',
      relayInterrupted: 'relay',
      relayContinued: 'relay',
      relayDuplicate: 'relay',
    });
  }, 120_000);

  test('continues from the acknowledged offset and transfers no duplicate content', async () => {
    const value = await report();
    expect(value.transport.interruption.acknowledgedOffset).toBe(4096);
    expect(value.transport.interruption.continuedFromSameOffset).toBe(true);
    expect(value.transport.interruption.prefixRejectedBeforeQueue).toBe(true);
    expect(value.transport.duplicate).toEqual({ status: 'already-present', contentBytesTransferred: 0 });
  }, 120_000);

  test('preserves canonical bytes, semantics, candidate, and anonymous routing', async () => {
    const value = await report();
    expect(value.equivalence.canonicalBytes).toBe(true);
    expect(value.equivalence.proposalDigest).toBe(true);
    expect(value.equivalence.proposalSemantics).toBe(true);
    expect(value.equivalence.candidateBytes).toBe(true);
    expect(value.equivalence.anonymousClassification).toBe(true);
    expect(value.equivalence.classification.tier).toBe('unknown');
    expect(value.equivalence.classification.route).toBe('full-review');
    expect(value.equivalence.classification.reasons).toContain('no-trust-config');
  }, 120_000);

  test('hands off only completed bytes and collapses content-identical replay', async () => {
    const value = await report();
    expect(value.queue.isolatedEquivalent).toBe(true);
    expect(value.queue.exactProposalBytesRetained).toBe(true);
    expect(value.queue.firstReplayed).toBe(false);
    expect(value.queue.secondReplayed).toBe(true);
    expect(value.queue.sameQueueId).toBe(true);
    expect(value.queue.sameReceipt).toBe(true);
    expect(value.queue.pendingEntries).toBe(1);
    expect(value.queue.rawContentKeyPersisted).toBe(false);
    expect(value.authorityBoundary.partialQueueAdmissions).toBe(0);
  }, 120_000);

  test('keeps Rust transport input free of source and authority evidence', async () => {
    const value = await report();
    expect(value.authorityBoundary).toMatchObject({
      rustInputKeys: ['proposalBase64', 'workDir'],
      credentialInput: false,
      ownerSourceInput: false,
      gitInput: false,
      sourceApplication: false,
      sourceBytesUnchanged: true,
    });
    expect(value.protocolSelection).toBe(false);
    expect(value.productionClaim).toBe(false);
  }, 120_000);

  test('fresh complete verifier runs are byte-identical', async () => {
    const first = await runIrohVerification();
    const second = await runIrohVerification();
    expect(stableStringify(first)).toBe(stableStringify(second));
    expect(first.complete).toBe(true);
  }, 240_000);
});

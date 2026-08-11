import { expect, test } from 'bun:test';
import { applyProposal, parseProposal } from '@cyberbaser/proposal';
import {
  AccountFreeIntakeError,
  createBareGitObjectResolver,
  deriveAccountFreeProposal,
  sourceBindingDigest,
} from '../src/index.js';
import { createBareFixture, makeIntent } from './fixtures.js';

function bindingsFor(fixture) {
  const bindingDigest = sourceBindingDigest(fixture.manifest);
  return {
    bindingDigest,
    bindings: Object.freeze({
      async resolve(requestedDigest, requestedPageId) {
        if (requestedDigest !== bindingDigest || requestedPageId !== fixture.page.pageId) {
          throw new AccountFreeIntakeError('unresolvable-binding', 'publication binding could not be resolved');
        }
        return Object.freeze({
          bindingDigest,
          manifest: fixture.manifest,
          page: fixture.page,
        });
      },
    }),
  };
}

test('derivation creates one canonical anonymous full-review proposal against exact rendered bytes', async () => {
  const fixture = await createBareFixture();
  try {
    const { bindingDigest, bindings } = bindingsFor(fixture);
    const git = createBareGitObjectResolver({
      gitDirectory: fixture.bare,
      repository: fixture.manifest.source.repository,
    });
    const result = await deriveAccountFreeProposal({
      intent: makeIntent({ bindingDigest, pageId: fixture.page.pageId }),
      bindings,
      git,
      proposalId: 'account-free:fixture-1',
      submittedAt: '2026-08-10T12:34:56Z',
    });

    const proposal = parseProposal(result.proposalText);
    expect(proposal).toEqual(result.proposal);
    expect(proposal.source).toEqual({
      repository: fixture.manifest.source.repository,
      revision: fixture.baseRevision,
      path: fixture.page.path,
    });
    expect(proposal.operation.type).toBe('quote');
    expect(proposal.submission.identityClaim).toBeNull();
    expect(result.verifiedSubject).toBeNull();
    expect(result.classification.tier).toBe('anonymous');
    expect(result.classification.route).toBe('full-review');
    expect(result.classification.reasons).toContain('anonymous-author');
    expect(result.basePolicy).toEqual({
      status: 'valid',
      digest: fixture.manifest.trustPolicy.digest,
    });
    expect(applyProposal(fixture.baseBytes, proposal)).toEqual(fixture.nextBytes);
    expect(result.binding.bindingDigest).toBe(bindingDigest);
    expect(result.binding.source.path).toBe(fixture.page.path);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.classification)).toBe(true);
    expect(Object.isFrozen(result.binding.source)).toBe(true);
  } finally {
    await fixture.cleanup();
  }
});

test('derivation fails closed on missing or ambiguous quote anchors', async () => {
  const fixture = await createBareFixture({
    baseText: 'teh first and teh second\n',
    nextText: 'the first and teh second\n',
  });
  try {
    const { bindingDigest, bindings } = bindingsFor(fixture);
    const git = createBareGitObjectResolver({
      gitDirectory: fixture.bare,
      repository: fixture.manifest.source.repository,
    });
    await expect(deriveAccountFreeProposal({
      intent: makeIntent({
        bindingDigest,
        pageId: fixture.page.pageId,
        quote: 'teh',
        prefix: null,
        suffix: null,
      }),
      bindings,
      git,
      proposalId: 'account-free:ambiguous',
      submittedAt: '2026-08-10T12:34:56Z',
    })).rejects.toMatchObject({ code: 'correction-quote-ambiguous' });

    await expect(deriveAccountFreeProposal({
      intent: makeIntent({
        bindingDigest,
        pageId: fixture.page.pageId,
        quote: 'absent',
        prefix: null,
        suffix: null,
      }),
      bindings,
      git,
      proposalId: 'account-free:missing',
      submittedAt: '2026-08-10T12:34:56Z',
    })).rejects.toMatchObject({ code: 'correction-quote-not-found' });
  } finally {
    await fixture.cleanup();
  }
});

test('missing base policy remains fail-closed at full review without inventing trust', async () => {
  const fixture = await createBareFixture({ policyText: null });
  try {
    const { bindingDigest, bindings } = bindingsFor(fixture);
    const git = createBareGitObjectResolver({
      gitDirectory: fixture.bare,
      repository: fixture.manifest.source.repository,
    });
    const result = await deriveAccountFreeProposal({
      intent: makeIntent({ bindingDigest, pageId: fixture.page.pageId }),
      bindings,
      git,
      proposalId: 'account-free:no-policy',
      submittedAt: '2026-08-10T12:34:56Z',
    });
    expect(result.verifiedSubject).toBeNull();
    expect(result.basePolicy).toEqual({ status: 'missing', digest: null });
    expect(result.classification).toMatchObject({
      tier: 'unknown',
      route: 'full-review',
      reasons: ['no-trust-config'],
    });
  } finally {
    await fixture.cleanup();
  }
});

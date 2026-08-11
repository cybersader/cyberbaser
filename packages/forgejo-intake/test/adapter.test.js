import { describe, expect, test } from 'bun:test';
import { applyProposal, parseProposal } from '@cyberbaser/proposal';
import { parseConfig } from '@cyberbaser/trust';
import {
  deriveForgejoPullRequestProposal,
  readForgejoPullRequestProposal,
} from '../src/index.js';
import { BASE_SHA, CONFIG, expectCode, HEAD_SHA } from './fixtures.js';

const BASE = Buffer.from('# Notes\n\nA paragraph about teh process.\n', 'utf8');
const HEAD = Buffer.from('# Notes\n\nA paragraph about the process.\n', 'utf8');

function snapshot(overrides = {}) {
  return {
    instanceVersion: '16.0.2',
    repository: {
      id: '731',
      fullName: 'owner/wiki',
      cloneUrl: CONFIG.repository.url,
      defaultBranch: 'main',
    },
    pullRequest: {
      number: 42,
      url: 'https://forge.example:8443/owner/wiki/pulls/42',
      title: 'Correct one typo',
      body: 'Preserve every untouched byte.',
      createdAt: '2026-08-10T12:34:56.789Z',
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      author: { id: '123', login: 'alice' },
      ...overrides,
    },
  };
}

function policy(author = 'forgejo:https://forge.example:8443#user=123') {
  return parseConfig(`trusted:\n  - "${author}"\n`);
}

function evidence(overrides = {}) {
  return {
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    path: 'docs/notes.md',
    baseBytes: BASE,
    headBytes: HEAD,
    policy: {
      status: 'valid',
      digest: 'sha-256=:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=:',
      config: policy(),
    },
    ...overrides,
  };
}

describe('deriveForgejoPullRequestProposal', () => {
  test('maps one verified Forgejo PR to one exact canonical proposal', () => {
    const result = deriveForgejoPullRequestProposal({
      config: CONFIG,
      pullRequestNumber: 42,
      snapshot: snapshot(),
      gitEvidence: evidence(),
    });

    expect(result.proposal.proposalId).toBe(`forgejo-pr:731:42:${HEAD_SHA}`);
    expect(result.proposal.source).toEqual({
      repository: CONFIG.repository.url,
      revision: BASE_SHA,
      path: 'docs/notes.md',
      digest: result.proposal.source.digest,
    });
    expect(result.proposal.submission).toEqual({
      submittedAt: '2026-08-10T12:34:56Z',
      rationale: 'Correct one typo\n\nPreserve every untouched byte.',
      evidence: [],
      identityClaim: {
        type: 'human',
        issuer: 'https://forge.example:8443/',
        subject: 'user:123',
      },
    });
    expect(result.verifiedSubject).toEqual({
      author: 'forgejo:https://forge.example:8443#user=123',
      authorType: 'human',
    });
    expect(result.trust.policyStatus).toBe('valid');
    expect(result.trust.classification.tier).toBe('trusted-human');
    expect(result.trust.classification.route).toBe('auto-merge');
    expect(result.carrier.author).toEqual({ id: '123', login: 'alice' });

    const reparsed = parseProposal(result.proposalText);
    expect(reparsed).toEqual(result.proposal);
    expect(applyProposal(BASE, reparsed)).toEqual(HEAD);
    expect(result.proposalText.endsWith('\n')).toBe(true);
  });

  test('is deterministic for one PR head and changes identity when the head changes', () => {
    const first = deriveForgejoPullRequestProposal({
      config: CONFIG,
      pullRequestNumber: 42,
      snapshot: snapshot(),
      gitEvidence: evidence(),
    });
    const second = deriveForgejoPullRequestProposal({
      config: CONFIG,
      pullRequestNumber: 42,
      snapshot: snapshot(),
      gitEvidence: evidence(),
    });
    expect(second.proposalText).toBe(first.proposalText);
    expect(second.proposalDigest).toBe(first.proposalDigest);

    const nextHeadSha = '3333333333333333333333333333333333333333';
    const changed = deriveForgejoPullRequestProposal({
      config: CONFIG,
      pullRequestNumber: 42,
      snapshot: snapshot({ headSha: nextHeadSha }),
      gitEvidence: evidence({ headSha: nextHeadSha }),
    });
    expect(changed.proposal.proposalId).not.toBe(first.proposal.proposalId);
  });

  test('normalizes rationale line endings and uses title alone for a blank body', () => {
    const titleOnly = deriveForgejoPullRequestProposal({
      config: CONFIG,
      pullRequestNumber: 42,
      snapshot: snapshot({ title: 'Fix\r\ntypo', body: '  ' }),
      gitEvidence: evidence(),
    });
    expect(titleOnly.proposal.submission.rationale).toBe('Fix\ntypo');
    expectCode(() => deriveForgejoPullRequestProposal({
      config: CONFIG,
      pullRequestNumber: 42,
      snapshot: snapshot({ title: 'Fix\rtypo' }),
      gitEvidence: evidence(),
    }), 'invalid-rationale');
  });

  test('preserves exact UTF-8 and untouched bytes across representative edits', () => {
    const cases = [
      ['tabs', Buffer.from('a\tb\n'), Buffer.from('a\tc\n')],
      ['trailing spaces', Buffer.from('alpha  \nbeta\n'), Buffer.from('alpha \nbeta\n')],
      ['emoji', Buffer.from('status: ❌\n'), Buffer.from('status: ✅\n')],
      ['combining form', Buffer.from('name: cafe\n'), Buffer.from('name: café\n')],
      ['leading BOM', Buffer.from('﻿# Ttle\n'), Buffer.from('﻿# Title\n')],
    ];
    for (const [label, baseBytes, headBytes] of cases) {
      const result = deriveForgejoPullRequestProposal({
        config: CONFIG,
        pullRequestNumber: 42,
        snapshot: snapshot(),
        gitEvidence: evidence({ baseBytes, headBytes }),
      });
      expect(applyProposal(baseBytes, result.proposal), label).toEqual(headBytes);
    }
  });

  test('fails closed on missing or malformed policy and never trusts the inert claim', () => {
    for (const status of ['missing', 'malformed']) {
      const result = deriveForgejoPullRequestProposal({
        config: CONFIG,
        pullRequestNumber: 42,
        snapshot: snapshot(),
        gitEvidence: evidence({ policy: { status, digest: null, config: null } }),
      });
      expect(result.trust.policyStatus).toBe(status);
      expect(result.trust.classification.route).toBe('full-review');
    }

    const claimOnlyPolicy = policy('user:123');
    const result = deriveForgejoPullRequestProposal({
      config: CONFIG,
      pullRequestNumber: 42,
      snapshot: snapshot(),
      gitEvidence: evidence({
        policy: {
          status: 'valid',
          digest: 'sha-256=:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=:',
          config: claimOnlyPolicy,
        },
      }),
    });
    expect(result.proposal.submission.identityClaim.subject).toBe('user:123');
    expect(result.trust.classification.route).toBe('full-review');
  });

  test('namespaces equal user IDs by Forgejo origin', () => {
    const otherConfig = {
      ...CONFIG,
      forgejo: { apiBaseUrl: 'https://other.example/api/v1' },
      repository: {
        ...CONFIG.repository,
        url: 'https://other.example/owner/wiki.git',
      },
    };
    const result = deriveForgejoPullRequestProposal({
      config: otherConfig,
      pullRequestNumber: 42,
      snapshot: {
        ...snapshot(),
        repository: { ...snapshot().repository, fullName: 'owner/wiki' },
        pullRequest: {
          ...snapshot().pullRequest,
          url: 'https://other.example/owner/wiki/pulls/42',
        },
      },
      gitEvidence: evidence(),
    });
    expect(result.verifiedSubject.author).toBe('forgejo:https://other.example#user=123');
    expect(result.trust.classification.route).toBe('full-review');
  });

  test('rejects mismatched Git evidence and impossible proposal reconstruction', () => {
    expectCode(() => deriveForgejoPullRequestProposal({
      config: CONFIG,
      pullRequestNumber: 42,
      snapshot: snapshot(),
      gitEvidence: evidence({ headSha: '4444444444444444444444444444444444444444' }),
    }), 'git-evidence-sha-mismatch');
    expectCode(() => deriveForgejoPullRequestProposal({
      config: CONFIG,
      pullRequestNumber: 42,
      snapshot: snapshot(),
      gitEvidence: evidence({ headBytes: Buffer.from([0xff]) }),
    }), 'invalid-utf8');
  });

  test('deeply freezes presentation values without retaining caller byte buffers', () => {
    const mutableBase = Buffer.from(BASE);
    const mutableHead = Buffer.from(HEAD);
    const result = deriveForgejoPullRequestProposal({
      config: CONFIG,
      pullRequestNumber: 42,
      snapshot: snapshot(),
      gitEvidence: evidence({ baseBytes: mutableBase, headBytes: mutableHead }),
    });
    mutableBase.fill(0);
    mutableHead.fill(0);
    expect(applyProposal(BASE, result.proposal)).toEqual(HEAD);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.proposal)).toBe(true);
    expect(Object.isFrozen(result.trust.classification)).toBe(true);
    expect(Object.isFrozen(result.carrier.author)).toBe(true);
  });
});

describe('readForgejoPullRequestProposal', () => {
  test('orchestrates API before Git and passes only exact authoritative identifiers', async () => {
    const calls = [];
    const api = {
      async readPullRequest(input) {
        calls.push(['api', input]);
        return snapshot();
      },
    };
    const git = {
      async readPullRequest(input) {
        calls.push(['git', input]);
        return evidence();
      },
    };
    const result = await readForgejoPullRequestProposal({
      config: CONFIG,
      pullRequestNumber: 42,
      api,
      git,
      remote: 'read-only',
    });
    expect(calls.map(([kind]) => kind)).toEqual(['api', 'git']);
    expect(calls[1][1]).toMatchObject({
      pullRequestNumber: 42,
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      remote: 'read-only',
    });
    expect(result.proposal.proposalId).toContain(HEAD_SHA);
  });
});

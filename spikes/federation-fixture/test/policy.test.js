import { describe, expect, test } from 'bun:test';
import {
  FIXED_NOW,
  RELATIONS,
  assertValid,
  sha256Digest,
  stableStringify,
  validateCacheRecord,
} from '../src/contracts.js';
import { FIXTURE_ORIGINS, fixtureUrls } from '../src/topology.js';
import {
  MIRROR_AUTHORITY_SCOPE,
  planRepublication,
  verifyLicensedMirrorProvenance,
} from '../src/rights.js';
import {
  searchCautiousEvidence,
  searchRecentOwnerRevisions,
} from '../src/search.js';
import {
  ProposalValidationError,
  applyByteSplices,
  createProposalReceiver,
  receiveProposal,
  validateByteSplices,
} from '../src/proposal.js';

const fungi = fixtureUrls('fungi');
const forage = fixtureUrls('forage');
const toxins = fixtureUrls('toxins');
const atlas = fixtureUrls('atlas');
const cautious = fixtureUrls('cautious');

function cacheRecord({
  id,
  publisher,
  directOwnerUrl,
  relation = RELATIONS.related,
  title,
  summary,
  observedAt,
  ownerRevision = null,
}) {
  const fetchedUrl = `${publisher}/artifacts/${id}.json`;
  const assertionId = `${publisher}/assertions/${id}#claim`;
  const artifactBytes = Buffer.from(`public fixture assertion ${id}\n`, 'utf8');
  const digest = sha256Digest(artifactBytes);
  const record = {
    publisher,
    issuer: publisher,
    assertionId,
    fetchedUrl,
    discoveryChain: [fetchedUrl],
    sourceDigest: digest,
    observation: {
      state: 'current',
      observedAt: FIXED_NOW,
      verifiedAt: FIXED_NOW,
      httpStatus: 200,
    },
    rights: {
      mode: 'owner-published',
      summary: 'Public fixture assertion metadata.',
    },
    rawArtifact: {
      url: fetchedUrl,
      mediaType: 'application/json',
      byteLength: artifactBytes.byteLength,
      digest,
      fetchedAt: FIXED_NOW,
    },
    assertion: {
      assertionId,
      issuer: publisher,
      subject: directOwnerUrl,
      relation,
      target: directOwnerUrl,
      rationale: summary,
      evidence: {
        sourceUrl: fetchedUrl,
        sourceDigest: digest,
        targetRevision: `revision-${id}`,
        targetDigest: sha256Digest(Buffer.from(`target ${id}\n`, 'utf8')),
        observedAt: FIXED_NOW,
      },
    },
    search: {
      directOwnerUrl,
      title,
      summary,
      keywords: ['chanterelle', 'field guide'],
      ...(ownerRevision ? { ownerRevision: { ...ownerRevision, observedAt } } : {}),
    },
  };
  assertValid('cache record', validateCacheRecord(record, {
    allowedOrigins: FIXTURE_ORIGINS,
    expectedTime: FIXED_NOW,
  }));
  return record;
}

const TRUST_CONFIG = {
  trusted: [],
  agents: ['fixture-agent'],
  caps: {
    lines: 60,
    files: 5,
    proseWords: 25,
    typoLines: 6,
    typoWords: 10,
  },
  allowedNewFolders: [],
  frontmatterAllowlist: ['tags', 'title'],
};

const ORIGINAL_MARKDOWN = Buffer.from(`---
title: Chanterelle safety
tags: [fungi]
---

# Chanterelle safety

See [[False chanterelle]] before collecting.

> [!note] Field check
> Correct teh short typo without rewriting this file.
`, 'utf8');

function typoProposal(baseBytes = ORIGINAL_MARKDOWN) {
  const start = baseBytes.indexOf(Buffer.from('teh'));
  if (start < 0) throw new Error('test fixture typo is missing');
  return {
    proposalId: 'https://atlas.test/proposals/fungi-typo-1',
    author: {
      id: 'sender-claimed-agent',
      type: 'agent',
    },
    target: {
      url: fungi.pages.primary,
      byteLength: baseBytes.byteLength,
      digest: sha256Digest(baseBytes),
    },
    splices: [{
      start,
      end: start + Buffer.byteLength('teh'),
      insert: Buffer.from('the', 'utf8'),
    }],
    claimedOfmVerdict: 'damage',
    claimedTrustRoute: 'reject',
  };
}

function receiver(currentBytes = ORIGINAL_MARKDOWN) {
  return {
    publisher: 'https://fungi.test',
    targetUrl: fungi.pages.primary,
    path: 'species/chanterelle.md',
    currentBytes,
    contributor: {
      id: 'fixture-agent',
      type: 'agent',
    },
    trustConfig: TRUST_CONFIG,
  };
}

describe('rights policy', () => {
  test('Atlas verifies a licensed mirror while Fungi keeps source authority', () => {
    const sourceBytes = Buffer.from('<svg><title>Chanterelle comparison</title></svg>\n', 'utf8');
    const decision = planRepublication({
      source: {
        publisher: 'https://fungi.test',
        url: fungi.pages.mirrorSource,
        revision: 'fungi-chart-r7',
        digest: sha256Digest(sourceBytes),
        byteLength: sourceBytes.byteLength,
        rights: {
          mode: 'licensed-reuse',
          summary: 'Redistribution permitted with attribution under CC BY-SA 4.0.',
          license: 'https://creativecommons.org/licenses/by-sa/4.0/',
          attribution: 'FungiWiki contributors',
          source: fungi.pages.mirrorSource,
        },
      },
      destination: {
        publisher: 'https://atlas.test',
        url: atlas.pages.mirror,
        revision: 'atlas-mirror-r1',
      },
      sourceBytes,
      retrievedAt: FIXED_NOW,
      modifications: [],
    });

    expect(decision.decision).toBe('licensed-mirror');
    expect(decision.publicationBytes.equals(sourceBytes)).toBe(true);
    expect(decision.mirror.publisher).toBe('https://atlas.test');
    expect(decision.mirror.provenance.sourcePublisher).toBe('https://fungi.test');
    expect(decision.mirror.provenance.sourceDigest).toBe(sha256Digest(sourceBytes));
    expect(decision.mirror.authority.mirror.scope).toBe(MIRROR_AUTHORITY_SCOPE);
    expect(decision.mirror.authority.sourceAuthorityTransferred).toBe(false);
    expect(decision.mirror.authority.source.url).toBe(fungi.pages.mirrorSource);

    const verified = verifyLicensedMirrorProvenance(decision.mirror, {
      sourceBytes,
      mirrorBytes: decision.publicationBytes,
    });
    expect(verified).toEqual({ ok: true, errors: [] });
  });

  test('a provenance record cannot promote Atlas to Fungi authority', () => {
    const sourceBytes = Buffer.from('licensed fixture bytes\n', 'utf8');
    const decision = planRepublication({
      source: {
        publisher: 'https://fungi.test',
        url: fungi.pages.mirrorSource,
        revision: 'fungi-chart-r8',
        digest: sha256Digest(sourceBytes),
        byteLength: sourceBytes.byteLength,
        rights: {
          mode: 'licensed-reuse',
          summary: 'Licensed fixture.',
          license: 'https://creativecommons.org/licenses/by-sa/4.0/',
          attribution: 'FungiWiki contributors',
        },
      },
      destination: {
        publisher: 'https://atlas.test',
        url: atlas.pages.mirror,
        revision: 'atlas-mirror-r2',
      },
      sourceBytes,
      retrievedAt: FIXED_NOW,
    });
    const forged = JSON.parse(JSON.stringify(decision.mirror));
    forged.authority.sourceAuthorityTransferred = true;
    forged.authority.source.publisher = 'https://atlas.test';

    const verification = verifyLicensedMirrorProvenance(forged, {
      sourceBytes,
      mirrorBytes: decision.publicationBytes,
    });
    expect(verification.ok).toBe(false);
    expect(verification.errors.map((error) => error.code)).toContain('authority-transfer');
    expect(verification.errors.map((error) => error.code)).toContain('source-authority');
  });

  test('Toxins stays link-only and its body never enters republication output', () => {
    const toxinsBody = Buffer.from('TOXINS-LINK-ONLY-BODY-CANARY\n', 'utf8');
    const decision = planRepublication({
      source: {
        publisher: 'https://toxins.test',
        url: toxins.pages.primary,
        revision: 'toxins-r4',
        digest: sha256Digest(toxinsBody),
        byteLength: toxinsBody.byteLength,
        rights: {
          mode: 'link-only',
          summary: 'Linking is permitted; copying is not licensed.',
          source: toxins.pages.primary,
        },
      },
      destination: {
        publisher: 'https://atlas.test',
        url: `${atlas.homepage}mirrors/toxins/false-chanterelle.html`,
        revision: 'must-not-exist',
      },
      sourceBytes: toxinsBody,
      mirrorBytes: toxinsBody,
      retrievedAt: FIXED_NOW,
    });

    expect(decision.decision).toBe('link-only');
    expect(decision.permitted).toBe(false);
    expect(decision.bodyCopied).toBe(false);
    expect(decision.directOwnerUrl).toBe(toxins.pages.primary);
    expect(decision).not.toHaveProperty('publicationBytes');
    expect(decision).not.toHaveProperty('mirror');
    expect(stableStringify(decision)).not.toContain('TOXINS-LINK-ONLY-BODY-CANARY');
    expect(decision.authority.sourceAuthorityTransferred).toBe(false);
  });
});

describe('visible plural search', () => {
  test('providers change ranking without changing result identity or owner URLs', () => {
    const fungiOwner = cacheRecord({
      id: 'fungi-owner',
      publisher: 'https://fungi.test',
      directOwnerUrl: fungi.pages.primary,
      title: 'Golden chanterelle',
      summary: 'A current chanterelle species entry.',
      observedAt: '2026-07-27T11:45:00.000Z',
      ownerRevision: {
        publisher: 'https://fungi.test',
        revision: 'fungi-r11',
        digest: sha256Digest(Buffer.from('fungi-r11')),
      },
    });
    const forageOwner = cacheRecord({
      id: 'forage-owner',
      publisher: 'https://forage.test',
      directOwnerUrl: forage.pages.primary,
      title: 'Chanterelle field guide',
      summary: 'Regional chanterelle guidance for coastal collectors.',
      observedAt: '2026-07-27T08:00:00.000Z',
      ownerRevision: {
        publisher: 'https://forage.test',
        revision: 'forage-r4',
        digest: sha256Digest(Buffer.from('forage-r4')),
      },
    });
    const cautiousAnnotation = cacheRecord({
      id: 'cautious-forage-annotation',
      publisher: 'https://cautious.test',
      directOwnerUrl: forage.pages.primary,
      relation: RELATIONS.annotation,
      title: 'Chanterelle field guide',
      summary: 'Cautious Forager annotates a regional difference in this chanterelle guide.',
      observedAt: FIXED_NOW,
    });
    const records = [cautiousAnnotation, forageOwner, fungiOwner];
    const before = stableStringify(records);

    const recent = searchRecentOwnerRevisions(records, 'chanterelle', { crawlTime: FIXED_NOW });
    const cautiousFirst = searchCautiousEvidence(records, 'chanterelle', { crawlTime: FIXED_NOW });

    expect(recent.map((result) => result.directOwnerUrl)).toEqual([
      fungi.pages.primary,
      forage.pages.primary,
    ]);
    expect(cautiousFirst.map((result) => result.directOwnerUrl)).toEqual([
      forage.pages.primary,
      fungi.pages.primary,
    ]);
    expect(new Set(recent.map((result) => result.identity))).toEqual(new Set(cautiousFirst.map((result) => result.identity)));
    expect(recent[0].provider.id).toBe('recent-owner-revisions');
    expect(cautiousFirst[0].provider.id).toBe('cautious-evidence-first');
    expect(recent[0].corpusPolicy).toContain('direct owner URL');
    expect(recent[0].rankingPolicy).toContain('newest revision evidence');
    expect(cautiousFirst[0].signals.cautiousAnnotationEvidence).toBe(1);
    expect(cautiousFirst[0].crawlTime).toBe(FIXED_NOW);
    expect(cautiousFirst[0].provenance.map((entry) => entry.issuer)).toContain('https://cautious.test');
    expect(stableStringify(records)).toBe(before);
  });

  test('third-party timestamps do not masquerade as owner revision freshness', () => {
    const record = cacheRecord({
      id: 'atlas-claims-fungi-fresh',
      publisher: 'https://atlas.test',
      directOwnerUrl: fungi.pages.primary,
      title: 'Golden chanterelle',
      summary: 'Atlas republishes an observation, not an owner revision.',
      observedAt: '2099-01-01T00:00:00.000Z',
      ownerRevision: {
        publisher: 'https://atlas.test',
        revision: 'atlas-claim',
        digest: sha256Digest(Buffer.from('atlas-claim')),
      },
    });

    const [result] = searchRecentOwnerRevisions([record], 'chanterelle', { crawlTime: FIXED_NOW });
    expect(result.directOwnerUrl).toBe(fungi.pages.primary);
    expect(result.signals.newestOwnerRevision).toBeNull();
    expect(result.provenance[0].publisher).toBe('https://atlas.test');
  });
});

describe('exact-byte receiver-owned proposals', () => {
  test('Buffer splices are checked by receiver-owned OFM and trust policy', () => {
    const proposal = typoProposal();
    const originalSnapshot = Buffer.from(ORIGINAL_MARKDOWN);
    const result = receiveProposal({ proposal, receiver: receiver() });

    expect(result.status).toBe('receiver-evaluated');
    expect(result.candidateText).toContain('Correct the short typo');
    expect(result.candidateText).toContain('[[False chanterelle]]');
    expect(result.candidateText).toContain('> [!note] Field check');
    expect(result.receiverChecks.ofm.verdict).toBe('clean');
    expect(result.receiverChecks.trust.tier).toBe('agent');
    expect(result.receiverChecks.trust.route).toBe('auto-merge');
    expect(result.moderation.receiverOwned).toBe(true);
    expect(result.moderation.route).toBe('auto-merge');
    expect(result.sourceWritePerformed).toBe(false);
    expect(result.rebased).toBe(false);
    expect(ORIGINAL_MARKDOWN.equals(originalSnapshot)).toBe(true);
    expect(proposal.claimedOfmVerdict).toBe('damage');
    expect(proposal.claimedTrustRoute).toBe('reject');
  });

  test('sender claims cannot override receiver detection of OFM damage', () => {
    const originalLink = Buffer.from('[[False chanterelle]]', 'utf8');
    const replacement = Buffer.from('[False chanterelle](False%20chanterelle)', 'utf8');
    const start = ORIGINAL_MARKDOWN.indexOf(originalLink);
    const proposal = {
      proposalId: 'https://atlas.test/proposals/degrade-wikilink',
      author: { id: 'sender-claimed-agent', type: 'agent' },
      target: {
        url: fungi.pages.primary,
        byteLength: ORIGINAL_MARKDOWN.byteLength,
        digest: sha256Digest(ORIGINAL_MARKDOWN),
      },
      splices: [{ start, end: start + originalLink.byteLength, insert: replacement }],
      claimedOfmVerdict: 'clean',
      claimedTrustRoute: 'auto-merge',
    };

    const result = receiveProposal({ proposal, receiver: receiver() });
    expect(result.receiverChecks.ofm.verdict).toBe('damage');
    expect(result.receiverChecks.trust.route).toBe('reject');
    expect(result.receiverChecks.trust.reasons).toContain('ofm-damage');
    expect(result.moderation.route).toBe('reject');
  });

  test('same-length stale bytes fail on digest before apply or classification', () => {
    const proposal = typoProposal();
    const staleBytes = Buffer.from(ORIGINAL_MARKDOWN.toString('utf8').replace('teh', 'xxx'), 'utf8');
    expect(staleBytes.byteLength).toBe(proposal.target.byteLength);
    expect(sha256Digest(staleBytes)).not.toBe(proposal.target.digest);
    const staleSnapshot = Buffer.from(staleBytes);
    const calls = { apply: 0, ofm: 0, trust: 0 };
    const receive = createProposalReceiver({
      applySplicesFn(...args) {
        calls.apply += 1;
        return applyByteSplices(...args);
      },
      ofmCheckFn() {
        calls.ofm += 1;
        return { verdict: 'clean', findings: [], stats: {} };
      },
      trustClassifyFn() {
        calls.trust += 1;
        return { tier: 'agent', route: 'auto-merge', reasons: [], checks: {} };
      },
    });

    let failure;
    try {
      receive({ proposal, receiver: receiver(staleBytes) });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ProposalValidationError);
    expect(failure.code).toBe('target-digest-mismatch');
    expect(failure.phase).toBe('precondition');
    expect(calls).toEqual({ apply: 0, ofm: 0, trust: 0 });
    expect(staleBytes.equals(staleSnapshot)).toBe(true);
  });

  test('splices must be ordered, non-overlapping, and encoded as Buffer bytes', () => {
    expect(() => validateByteSplices([
      { start: 2, end: 4, insert: Buffer.from('x') },
      { start: 3, end: 5, insert: Buffer.from('y') },
    ], 8)).toThrow(ProposalValidationError);

    expect(() => validateByteSplices([
      { start: 0, end: 1, insert: 'not exact bytes' },
    ], 8)).toThrow(ProposalValidationError);
  });

  test('invalid UTF-8 candidates fail before OFM or trust classification', () => {
    const base = Buffer.from('ok', 'utf8');
    const proposal = {
      proposalId: 'https://atlas.test/proposals/invalid-utf8',
      author: { id: 'fixture-agent', type: 'agent' },
      target: {
        url: fungi.pages.primary,
        byteLength: base.byteLength,
        digest: sha256Digest(base),
      },
      splices: [{ start: 0, end: 1, insert: Buffer.from([0xc3]) }],
    };
    const calls = { ofm: 0, trust: 0 };
    const receive = createProposalReceiver({
      ofmCheckFn() {
        calls.ofm += 1;
        return { verdict: 'clean', findings: [], stats: {} };
      },
      trustClassifyFn() {
        calls.trust += 1;
        return { tier: 'agent', route: 'auto-merge', reasons: [], checks: {} };
      },
    });

    let failure;
    try {
      receive({ proposal, receiver: receiver(base) });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ProposalValidationError);
    expect(failure.code).toBe('invalid-utf8');
    expect(failure.phase).toBe('candidate');
    expect(calls).toEqual({ ofm: 0, trust: 0 });
  });
});

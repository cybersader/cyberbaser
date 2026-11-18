# `@cyberbaser/proposal-review`

Pure canonical contracts for reviewing one retained Cyberbaser proposal and recording one owner decision.

The package defines three schema-version-1 artifacts:

- **review evidence**: one queue ID plus the canonical proposal, receipt, carrier, classification, and queue state;
- **review summary**: bounded list fields derived from exact review evidence; validation and parsing require that evidence so a digest cannot be paired with attacker-selected display fields;
- **owner decision**: immutable `approve` or `reject` intent bound to the exact review-evidence digest.

Owner decisions have `authorityScope: "decision-only"`. Every source, Git, rebuild, deployment, and publication effect flag is required to be `false`. Approval here does not apply a proposal or authorize another component to do so.

## Proposal versions

Review evidence accepts either the original single-splice proposal (v1) or the atomic single-file change set (v2). `createReviewEvidence` dispatches the exact canonical `proposalText` through `parseVersionedProposal`. An optional IPC `proposalVersion` must agree with those bytes; it is not added to stored review artifacts. Existing v1 evidence, summaries, decisions and their canonical bytes remain unchanged.

For v2, the receipt binds the digest of the **complete proposal**, including every operation and submission metadata. One owner decision approves or rejects that whole proposal. There is no subset approval or per-operation authority. `reviewProposalBinding` supplies one normalized source/base/candidate view without rewriting the embedded proposal. `applyReviewProposal` and `classifyReviewProposal` dispatch by version; classification evaluates the combined before/after file and never trusts sender identity claims.

Owner-alpha separately records the application act and retains the canonical v2 proposal in a version-2 prepared input/source operation. Its existing pipeline checks, exact atomic file replacement, one-path commit verification and durable recovery consume that same change set. No presentation diff is an application instruction, and an interrupted application without durable effect evidence is never replayed automatically.

## Boundaries

- Pure and no-I/O: no filesystem, queue, Git, network, clock, identity verification, source write, or publication work.
- The proposal queue remains proposal evidence only and retains only `pending-review` and `expired` states.
- `decisionAuthority` is separate from contributor `verifiedSubject`; anonymous evidence remains anonymous.
- Canonical bytes are recursively key-sorted compact JSON with exactly one final LF.
- Parsing rejects malformed UTF-8, BOMs, unknown fields, unsupported schemas, unsafe numbers, noncanonical bytes, oversize artifacts, and credential-like material.
- A decision is eligible only when embedded evidence is `pending-review` and `receivedAt <= decidedAt < expiresAt`.

## Public API

```js
import {
  createReviewEvidence,
  createReviewSummary,
  serializeReviewSummary,
  parseReviewSummary,
  reviewEvidenceDigest,
  createOwnerDecision,
  serializeOwnerDecision,
  parseOwnerDecision,
} from '@cyberbaser/proposal-review';

const summary = createReviewSummary(evidence);
const summaryText = serializeReviewSummary(summary, evidence);
parseReviewSummary(summaryText, evidence);
```

Runtime validation is authoritative for canonical bytes and cross-artifact relationships. The JSON Schema is available at `@cyberbaser/proposal-review/schema/v1` for structural validation.

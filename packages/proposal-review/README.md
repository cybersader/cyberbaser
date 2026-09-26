# `@cyberbaser/proposal-review`

Pure canonical contracts for reviewing one retained Cyberbaser proposal and recording one owner decision.

The package defines three schema-version-1 artifacts:

- **review evidence**: one queue ID plus the canonical proposal, receipt, carrier, classification, and queue state;
- **review summary**: bounded list fields derived from exact review evidence; validation and parsing require that evidence so a digest cannot be paired with attacker-selected display fields;
- **owner decision**: immutable `approve` or `reject` intent bound to the exact review-evidence digest.

Owner decisions have `authorityScope: "decision-only"`. Every source, Git, rebuild, deployment, and publication effect flag is required to be `false`. Approval here does not apply a proposal or authorize another component to do so.

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

# `@cyberbaser/proposal-queue`

Carrier-neutral durable storage for canonical `@cyberbaser/proposal` artifacts from WP4 intake lanes.

The package stores the exact canonical proposal bytes plus strict receipt, carrier, classification, and lifecycle artifacts. It holds one nonblocking Linux kernel lock while a queue is open, stages every new entry durably, and preserves only two lifecycle states: `pending-review` and `expired`.

It does not accept HTTP, rate-limit public traffic, verify accounts, render a review UI, apply a proposal to source, commit, push, merge, deploy, or authorize publication. Lane B remains anonymous at the trust floor. Owner-alpha remains a separate direct-authority writer.

## Storage contract

The queue root is one private `0700` directory:

```text
queue/
├── .queue.lock
├── staging/
├── pending/
│   └── Q-<uuid>/
│       ├── proposal.json
│       ├── receipt.json
│       ├── carrier.json
│       ├── classification.json
│       └── state.json
└── expired/
    └── Q-<uuid>/
        └── ...the same five files
```

Every artifact file is `0600`, singly linked, opened with `O_NOFOLLOW`, bounded before reading, and validated against its exact key set. Metadata uses compact canonical JSON followed by one LF. `proposal.json` is stored byte-for-byte and must pass `parseProposal()` canonical validation.

A new entry is written to a private staging directory, each file is `fsync`ed, the staging directory is `fsync`ed, and the complete directory is renamed into `pending/` before that parent is `fsync`ed. State replacement and expiration moves use the same rename and directory-sync discipline.

## Queue bounds

Defaults are deliberately finite:

- 1,000 pending entries;
- 256 MiB across all retained entry artifacts;
- 25 pending entries per repository-and-path source partition;
- 30 days in `pending-review`;
- 7 days of expired grace before durable removal.

Configuration may only tighten or increase these values within the exported hard caps. Expiration is the only state transition. No accepted, rejected, merged, or applied state exists in this package.

## Idempotency and carrier metadata

Idempotency is lane-scoped. Lane A replay identity is derived by the queue from repository ID, pull-request number, and head object ID; its caller scope is correlation-only and its raw key must be null. Lane B supplies a high-entropy 32-128 character unpadded base64url key and a request digest.

The raw Lane B key is never written to disk or returned in queue metadata. Only its SHA-256 digest and a separately derived lane-scoped replay digest are retained. Reusing the same replay identity with another request digest or proposal fails closed with `idempotency-conflict`. A Lane B request with a null key is intentionally not deduplicated.

Carrier artifacts retain only bounded, credential-free routing evidence:

- Lane A: repository ID, pull-request number, and head object ID.
- Lane B: the validated page binding digest and public page ID.

## Recovery and integrity

Opening a nonempty queue requires `resolveEvidence(entry)`. The callback must resolve the exact base bytes and current parsed policy evidence for that durable entry. Opening fails closed if proposal application, policy binding, or the recomputed trust classification differs from the retained artifacts.

Recovery also:

- removes interrupted entry staging directories;
- completes an expiration whose atomic state replacement succeeded before the directory move;
- removes interrupted purge staging directories;
- removes state-replacement temporaries;
- rejects duplicate queue IDs, duplicate replay scopes, unsafe paths, unknown files, malformed metadata, and ambiguous locations;
- applies pending expiration and expired-grace retention before returning the open queue.

The queue holds its exclusive kernel lock until `close()` completes. Lock-file existence does not imply ownership, and process exit cannot strand the kernel lock.

`inspectProposalQueue()` provides a separate nonmutating inspection path. It opens only an initialized queue under a shared lock, reads the exact five-artifact entries, and revalidates source and policy evidence without creating directories, removing temporaries, recovering staging, changing state, expiring entries, or purging retention. The shared lock fails while the normal writer is open. Nonempty staging or a contradictory acknowledged location returns `queue-recovery-required`/`ambiguous-queue-location`; normal writer startup must recover the queue before inspection.

## API

```js
import {
  inspectProposalQueue,
  openProposalQueue,
  proposalSemantics,
} from '@cyberbaser/proposal-queue';

const queue = await openProposalQueue({
  config: {
    root: '/absolute/private/proposal-queue',
  },
  resolveEvidence: async (entry) => ({
    baseBytes: await resolvePinnedSource(entry.proposal.source),
    policy: await resolvePinnedTrustPolicy(entry),
  }),
});

try {
  const result = await queue.enqueue({
    proposalText,
    baseBytes,
    policy: {
      status: 'valid',
      digest: policyDigest,
      config: parsedTrustConfig,
    },
    verifiedSubject: null,
    carrier: {
      lane: 'lane-b',
      metadata: {
        bindingDigest,
        pageId: 'docs/example',
      },
    },
    idempotency: {
      scope: 'lane-b',
      key: browserGeneratedKey,
      requestDigest,
    },
  });

  if (result.receipt !== null) {
    const entry = await queue.load(result.receipt.queueId);
    const semantics = proposalSemantics(entry.proposal);
    console.log(result.replayed, semantics);
  }

  await queue.expireDue();
  console.log(queue.stats());
} finally {
  await queue.close();
}
```

For local inspection, stop the writer and open the nonmutating reader with the same queue config and evidence resolver:

```js
const inspection = await inspectProposalQueue({
  config: { root: '/absolute/private/proposal-queue' },
  resolveEvidence,
});
try {
  console.log(await inspection.list({ state: 'pending-review' }));
} finally {
  await inspection.close();
}
```

`enqueue()` also supports a replay probe: after validating the lane and idempotency fields, a caller may pass `null` for `proposalText`, `baseBytes`, and `policy`. A known replay identity returns its existing receipt. An unknown identity returns `{ replayed: false, receipt: null }` without allocating an entry.

`proposalSemantics()` projects canonical proposal bytes or an already validated proposal into the carrier-neutral exact source and splice bindings used by review surfaces. It does not include transport metadata or grant source authority.

## Evidence boundary

Package tests cover exact proposal retention, strict canonical metadata, private modes, no-follow handling, kernel-lock contention, staging and rename crash windows, recovery evidence, lifecycle recovery, retention, all capacity limits, Lane A and Lane B idempotency, raw-key non-retention, anonymous Lane B classification, and semantic projection.

This is hermetic package evidence. It does not establish a public account-free endpoint, edge abuse controls, independent-human usability, a live Forgejo lane, an owner decision product, or production authority.

`.github/workflows/proposal-queue.yml` runs this suite with `contents: read`, credential-free checkout, immutable action pins, no secrets, and no repository mutation or publication step. `test/ci-structure.test.js` also verifies the package/app/renderer Lane B workflow and the separate local-image acceptance workflow remain read-only.

## Development

```bash
bun install --frozen-lockfile
bun test
```

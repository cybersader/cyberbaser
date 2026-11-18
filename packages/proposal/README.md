# `@cyberbaser/proposal`

Canonical, source-bound proposal objects for Cyberbaser intake adapters.

The package defines the value that future Forgejo-native, account-free, rich-editor, and agent lanes must converge on. It prepares and validates one exact UTF-8 splice against one pinned existing Markdown source, preserves every byte outside that splice, and converts verified bytes into the existing `@cyberbaser/trust` classifier input.

It is a pure no-I/O package. It does not fetch source, resolve revisions, verify identity claims, hold a queue, accept HTTP, write files, run Git, apply an accepted change to canonical source, or publish anything. Owner-alpha remains a separate direct-authority writer.

## Contract

Schema version 1 contains:

- a caller-supplied proposal ID;
- a credential-free canonical HTTPS repository URL, opaque pinned revision, and repository-relative Markdown path;
- a fully prepared quote- or offset-bound `@cyberbaser/correction` operation;
- a caller-supplied UTC-second timestamp, rationale, evidence URLs, and optional inert identity claim.

The serialized artifact is compact canonical JSON followed by exactly one LF. It is limited to 256 KiB. Each old and replacement span is limited to 64 KiB. No-ops and complete nonempty-file replacement or deletion are rejected; an existing empty Markdown file may receive one bounded insertion.

An identity claim is not a verified trust subject. `proposalToTrustChange()` and `classifyProposal()` accept a separate receiver-verified `{ author, authorType }` value. Without one, the proposal enters the existing anonymous full-review path. Trust conversion strips a stable leading UTF-8 BOM prefix from both decoded views so frontmatter controls still apply, and fails closed if the operation changes that prefix.

## API

```js
import {
  prepareProposal,
  serializeProposal,
  parseProposal,
  proposalDigest,
  applyProposal,
  proposalToTrustChange,
  classifyProposal,
} from '@cyberbaser/proposal';
```

`prepareProposal(baseBytes, input)` accepts a raw quote or offset request and returns a deeply frozen, fully bound proposal. `applyProposal(baseBytes, proposal)` rechecks every binding and returns candidate bytes in memory. It performs no file I/O.

The structural JSON Schema is exported as `@cyberbaser/proposal/schema/v1`. Runtime validation remains authoritative for canonical encoding and cross-field byte relationships.

## V2: one-file atomic change sets

V2 is an additive, opt-in contract. **The original root API remains v1-only**, including `parseProposal`, its direct proposal return value, validators, trust conversion, canonical bytes and digests. A v2 proposal carries no approval, verified identity, source-write authority or deployment authority. Existing intake, queue, review and owner application formats do not automatically support it.

### Shape and canonical bytes

The fixed key order is shown below. Digest placeholders are illustrative, not valid wire values.

```text
{
  schemaVersion: 2,
  artifactType: "cyberbaser-proposal",
  proposalId,
  changeSet: {
    atomic: true,
    repository,
    baseRevision,
    files: [{
      path,
      kind: "modify",
      base: { byteLength, digest },
      operations: [{ operationId, start, end, expected, replacement }],
      candidate: { byteLength, digest }
    }],
    changeSetDigest
  },
  submission: { submittedAt, rationale, evidence, identityClaim }
}
```

Exactly one repository, one revision and one existing Markdown file are supported. `atomic` must be `true`, `files.length` must be `1`, and `kind` must be `modify`. There are no create, rename, multi-file, selector, intent-summary or partial-decision fields. All records reject missing and unknown fields. Repository/path/revision and submission validation reuse the v1 rules. In particular, claims remain inert, rationale uses LF (no CR), URLs are credential-free and canonical, and evidence is limited to eight URLs. The caller must resolve a truly immutable revision and verify file existence; the pure core validates the opaque revision identifier and exact supplied bytes, not a repository or filesystem.

Canonical artifacts use compact `JSON.stringify` output in the order above plus exactly one final LF, as in v1. All digests use `sha-256=:<canonical padded base64 SHA-256>:`. Base/candidate digests hash the corresponding raw bytes. `changeSetDigest` hashes the UTF-8 canonical **change-set body**, with keys `atomic`, `repository`, `baseRevision`, `files`, followed by one LF, **omitting `changeSetDigest` itself**. `changeSetProposalDigest()` hashes the complete canonical proposal including its final LF; it additionally binds proposal ID and submission. The inner digest is not an approval identity or substitute for the complete proposal digest. Changing submission changes the outer digest even when the change set stays identical.

The structural schema is exported as `@cyberbaser/proposal/schema/v2`. As with v1, JSON Schema alone cannot establish byte caps, canonical URL spelling, digest agreement, offset boundaries, unique IDs/starts, source equality or cross-field relationships. Runtime validation is authoritative.

### Exact operation rules and limits

- `operationId` is a caller-assigned stable identifier: 1–128 ASCII characters matching `[A-Za-z0-9][A-Za-z0-9._:-]*`, unique within the proposal. Stability across revisions is an adapter responsibility, not inherited approval.
- `start` and `end` are non-negative safe-integer, half-open **UTF-8 byte offsets into the same pinned base**. They are not UTF-16 indices or offsets into intermediate candidates. Both must be code point boundaries; `start <= end <= base.byteLength`.
- `expected` and `replacement` are exact UTF-8 strings with no unpaired surrogates. The base slice must equal `expected`, including whitespace and combining marks. No Unicode or Markdown normalization occurs.
- Operations must arrive in strictly ascending `start` order. The core rejects rather than sorts. All duplicate starts are rejected, including two insertions and an insertion paired with a replacement at the same start. Adjacent ranges (`previous.end === next.start`) are allowed, including an insertion at a preceding replacement's end. Dependent/overlapping edits must be composed upstream into one exact bounded operation.
- Every operation must change bytes. The complete candidate must also differ from the base, so cancelling operations fail. The union of removed ranges may not cover the complete nonempty file, even via adjacent operations. One bounded insertion into an existing empty file is valid.
- Candidate construction copies `base[0:start1]`, replacement 1, every untouched base gap, subsequent replacements and the final base suffix in one pass. It never serializes a whole Markdown document. Application verifies base length/digest, every expected slice, UTF-8/CRLF boundaries and final candidate length/digest before returning bytes.

| Executable ceiling | V2 limit |
| --- | --- |
| Operations | 1–50 |
| Each expected span | 16 KiB UTF-8 |
| Each replacement span | 16 KiB UTF-8 |
| Sum of all expected **plus** replacement bytes | 64 KiB |
| Base and candidate, independently | 4 MiB |
| Complete canonical artifact, including LF | 256 KiB |
| Operation ID | 128 ASCII characters |

These are bounded implementation ceilings, not measured public-service budgets or a grant to increase intake limits. JSON escaping can reach the artifact ceiling before the changed-byte ceiling. Receiving lanes may impose stricter policy and must meter aggregate operations/bytes rather than treating a batch as one old one-splice request.

**Newlines and BOM:** the envelope uses LF only, but source and replacement text may contain LF or CRLF. Existing CRLF pairs must be selected whole: neither endpoint may lie between their CR and LF, even for an insertion or a net-safe reconstruction. Replacements may not introduce a lone CR; existing lone CR bytes outside changes survive unchanged. Replacing a complete CRLF pair with LF is an explicit declared edit, never silent normalization. BOM, tabs and all untouched bytes are preserved. This pure-core support does not relax the owner's current LF-only application policy, frontmatter policy or trust checks. V1 rules are unchanged.

### V2 API

```js
import {
  createChangeSetProposal,
  validateChangeSetProposal,
  applyChangeSetProposal,
  serializeChangeSetProposal,
  changeSetProposalDigest,
  parseVersionedProposal,
  projectV1ToChangeSet,
  describeChangeSet,
  renderChangeSet,
  criticMarkupAdapter,
} from '@cyberbaser/proposal';
```

- `createChangeSetProposal(baseBytes, { proposalId, source: { repository, revision, path }, operations, submission })` verifies the source and operations and returns a deeply frozen v2 proposal. Base input must be `Buffer` or `Uint8Array`. It does not sort operations, generate IDs, read a clock or mutate input.
- `validateChangeSetProposal(proposal, baseBytes?)` returns a normalized, deeply frozen proposal. Without base bytes it validates the envelope, bounds, relationships and inner digest only, **not** source truth. Supplying the base additionally verifies every source/candidate binding. A matching self-declared digest is not authentication.
- `applyChangeSetProposal(baseBytes, proposal)` always performs full verification and returns a fresh candidate `Buffer` in memory. It never writes source.
- `serializeChangeSetProposal(proposal)` and `changeSetProposalDigest(proposal)` produce canonical text and the complete artifact digest, respectively. They validate structurally; they do not fetch or verify source.
- `parseVersionedProposal(bytesOrText)` returns a frozen `{ version: 1 | 2, proposal }`. It rejects noncanonical bytes, BOM, malformed UTF-8, unknown versions and over-limit artifacts. It is also exported as **`parseProposal` from `@cyberbaser/proposal/v2`**, whose other exports include the v2 APIs. The root `parseProposal` stays unchanged for existing consumers. Parsing alone never proves source applicability.
- `projectV1ToChangeSet(v1Proposal)` returns an ephemeral frozen `{ version: 1, proposalDigest, proposalId, changeSet, submission }` display view, with operation ID `v1:operation`. `proposalDigest` remains the original v1 digest. The view is deliberately **not** a serializable/executable v2 proposal. It imposes no v2 caps or newline rules on historical v1 records and does not change their bytes, selectors or approval identity. Apply the original v1 artifact, never the projection.
- `describeChangeSet(baseBytes, originalV1OrV2Proposal, { contextCodePoints = 40 } = {})` verifies the original proposal and adds `startPosition`, `endPosition` and `context: { before, after }` to each operation. Positions are 1-based lines and Unicode-code-point columns (LF advances the line, tabs count as one code point), not grapheme, screen or UTF-16 columns. Context is limited to 0–200 code points per side. V1 descriptions recheck the original quote selector, including uniqueness, before projecting.

Constants `CHANGE_SET_SCHEMA_VERSION`, `CHANGE_SET_MAX_OPERATIONS`, `CHANGE_SET_MAX_SPAN_BYTES`, `CHANGE_SET_MAX_CHANGED_BYTES` and `CHANGE_SET_MAX_FILE_BYTES` expose these ceilings. `PROPOSAL_MAX_BYTES` and `ProposalError` are shared with v1.

### Replaceable display adapters

`renderChangeSet(baseBytes, originalProposal, adapter = criticMarkupAdapter, options = {})` verifies the source before invoking a provider and returns frozen `{ adapter, proposalDigest, operations: [{ operationId, text }] }` display data. The tiny provider interface is exactly:

```js
{ id: 'provider-name', renderOperation(frozenOperationDescription) { return 'text'; } }
```

IDs match `[a-z][a-z0-9-]{0,63}`. Output must be a valid UTF-8 string no larger than 512 KiB per operation. The core rejects invalid providers, failures and invalid output; provider output cannot alter proposal bytes. Add another module, a registry entry in `changeSetDisplayAdapters`, and run the shared conformance cases in `test/change-set.test.js` for a new built-in provider. Callers can also explicitly supply an adapter without modifying the core.

The built-in `critic-markup` adapter shows insertions, deletions and substitutions, escaping backslashes, braces and tildes in literal text. It is **plain-text display**, not an integrity envelope, HTML sanitizer, executable patch or lossless CriticMarkup import/export codec. Render provider text as text, never as raw HTML. The tests exercise both the built-in adapter and an independent plain-text provider, plus fail-closed provider failures.

### Adoption boundary

Intake must derive one v2 artifact from one pinned source and meter request attempts plus operation/byte work. Queue/recovery must explicitly dispatch versions, retain original canonical bytes and digest, and account for aggregate work. Review needs per-operation display with one atomic decision bound to the complete original proposal digest. Trust/integrity must be recalculated on the **combined candidate**, using receiver-verified identity and the existing BOM/frontmatter protections, rather than classifying each operation separately. The existing `classifyProposal`/`proposalToTrustChange` APIs intentionally remain v1-only; v2 trust integration is not silently enabled here.

Owner application still needs a versioned multi-operation job, every-gap proof, existing source/policy checks, fresh digest-bound approval and one atomic Save. No sequential v1 jobs, broad encompassing replacement, execution-time subset, silent rebase or automatic approval inheritance is permitted. A selected subset must become a new candidate with fresh classification and approval. A mixed-version restart/recovery test and throwaway end-to-end rehearsal remain adoption gates; package tests alone are not an offered product or real-vault acceptance.

## Development

```bash
bun install --frozen-lockfile
bun test
```

From the repository root, use `build-contained -- bun test packages/proposal/test` for the contract suite. To test dependent packages against the **current worktree** rather than stale installed `file:` copies, add `--preload ./packages/proposal/test/live-package-preload.js` to the contained Bun test invocation. The preload only resolves this package's four public entry points to their live local files; it does not install dependencies, modify consumer directories or enable v2 in their APIs.

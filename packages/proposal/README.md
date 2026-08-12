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

## Development

```bash
bun install --frozen-lockfile
bun test
```

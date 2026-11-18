# `@cyberbaser/account-free-intake`

Read-only WP4 Lane B derivation primitives for turning one untrusted, account-free correction intent into the canonical `@cyberbaser/proposal` shape.

**Status:** implemented and hermetically tested at the package layer. This package is not an HTTP endpoint, queue, rendered form, owner review surface, identity verifier, source writer, public deployment, or offered account-free contribution path. It does not close Q09.

## Boundary

The package performs this in-memory/read-only flow:

```text
strict correction intent
  → exact retained publication binding digest + opaque page ID
  → exact historical Markdown blob from a configured bare Git object store
  → trust policy from that same source revision
  → one quote-bound canonical @cyberbaser/proposal
  → anonymous full-review classification when the bound policy is valid
```

It performs no HTTP, network fetch, evidence fetch, queue operation, source write, checkout, worktree, index update, ref creation, commit, push, credential handling, CAPTCHA, identity elevation, owner decision, or publication action.

## Public correction intent

Version 1 accepts exactly these keys:

```js
{
  schemaVersion: 1,
  artifactType: 'cyberbaser-account-free-correction-intent',
  bindingDigest: 'sha-256=:...:',
  pageId: 'page-v1:...',
  selection: {
    quote: 'exact selected source text',
    prefix: null,
    suffix: null,
  },
  replacement: 'replacement text',
  rationale: 'why this should change',
  evidence: ['https://example.invalid/reference'],
  idempotencyKey: null,
}
```

`prefix`, `suffix`, and `idempotencyKey` are explicit string-or-null fields. Unknown and missing fields fail closed, including caller-supplied repository, revision, path, offset, base bytes/digest, operation type, submission time, proposal ID, identity/contact data, trust route, policy, owner decision, command, refspec, or publication target.

Limits are narrower than the shared proposal contract:

- complete canonical intent: 96 KiB;
- quote and replacement: 16 KiB each;
- prefix and suffix: 4 KiB each;
- rationale: 16 KiB;
- up to eight canonical credential-free HTTPS evidence URLs, 2 KiB each;
- optional idempotency key: 32–128 base64url characters.

Evidence URLs remain inert. This package never fetches them. `parseCorrectionIntent()` accepts only compact fixed-order JSON followed by one LF; an HTTP caller that has already bounded and parsed strict JSON may call `validateCorrectionIntent()`.

## Private publication source binding

A private, canonical manifest binds rendered pages to one exact publication:

```js
{
  schemaVersion: 1,
  artifactType: 'cyberbaser-publication-source-binding',
  source: {
    repository: 'https://forge.example:8443/owner/wiki.git',
    revision: 'opaque-immutable-revision',
  },
  publication: {
    publishPolicyDigest: 'sha-256=:...:',
    selectedTreeDigest: 'sha-256=:...:',
  },
  renderer: {
    name: 'quartz-cyberbase',
    revision: 'opaque-immutable-renderer-revision',
  },
  trustPolicy: {
    status: 'valid',
    digest: 'sha-256=:...:',
  },
  pages: [{
    pageId: 'page-v1:...',
    path: 'Knowledge/Example.md',
    byteLength: 412,
    digest: 'sha-256=:...:',
  }],
}
```

The repository URL is canonical, credential-free HTTPS. Revisions are bounded opaque immutable identifiers in the manifest contract; the bare-Git resolver narrows the source revision to one complete lowercase 40- or 64-character object ID before invoking Git.

`prepareSourceBindingManifest()` computes deterministic opaque page IDs from a length-prefixed domain separator, repository, exact revision, and source path. It sorts pages by UTF-8 path bytes and rejects duplicate paths or page IDs. Serialization is fixed-order compact JSON with exactly one final LF. `sourceBindingDigest()` hashes those exact bytes.

The manifest remains private. A rendered page needs only `bindingDigest`, `pageId`, and the configured public intake origin. It never needs to expose source repository, revision, or path.

## Retained exact-revision resolution

`createRetainedSourceBindingResolver({ manifestRoot })` reads immutable manifest files named by `retainedManifestFilename(bindingDigest)` from one owner-controlled read-only directory. It rejects symlink roots/files, non-regular or multiply linked artifacts, noncanonical bytes, digest contradictions, and missing page IDs.

Resolution is exact:

```js
const binding = await bindings.resolve(bindingDigest, pageId);
```

A missing manifest returns `stale-publication`. Missing or contradictory page evidence returns the generic `unresolvable-binding` failure. The resolver never substitutes a newer manifest, current branch, `HEAD`, fuzzy match, or silent rebase. Operators must retain manifests and their Git objects for at least as long as pending proposals can remain reviewable.

## Inert bare-Git resolver

Configure one credential-free repository identity and one local bare object directory:

```js
const git = createBareGitObjectResolver({
  repository: 'https://forge.example:8443/owner/wiki.git',
  gitDirectory: '/srv/cyberbaser/source-objects.git',
});
```

For the exact retained binding, the resolver:

- requires the configured repository identity to match the manifest;
- requires a real bare repository;
- requires the opaque manifest revision to be a complete Git object ID resolving exactly to a commit;
- resolves one literal repository-relative Markdown path;
- requires a regular `100644` or `100755` blob;
- reads bounded fatal-UTF-8 bytes and verifies exact manifest length and digest;
- reads `.cyberbaser/trust.yml` only from the same revision;
- verifies trust-policy status/digest against the manifest.

Git runs through `execFile`, never a shell. The resolver sets `GIT_OPTIONAL_LOCKS=0`, `GIT_TERMINAL_PROMPT=0`, `GIT_NO_LAZY_FETCH=1`, disables ambient Git configuration/object-directory inputs and replacement objects, and allows no protocol. It invokes only object-inspection commands. There is no fetch, remote access, checkout, worktree, index, ref mutation, hook, submodule, commit, or push.

## Anonymous proposal derivation

The receiver, not the anonymous caller, supplies `proposalId` and a canonical UTC-second `submittedAt`:

```js
const result = await deriveAccountFreeProposal({
  intent,
  bindings,
  git,
  proposalId: 'account-free:Q-123',
  submittedAt: '2026-08-10T12:34:56Z',
});
```

For a v1 intent, derivation uses a quote operation through `prepareProposal()`, serializes and reparses the canonical proposal, and reapplies it against the exact base bytes. It sets `submission.identityClaim` to `null` and supplies no receiver-verified subject. With a valid bound trust policy, the result must classify as tier `anonymous`, route `full-review`; a contradictory tier or route fails internally. A missing or malformed bound policy remains fail-closed at the classifier's `unknown`/`full-review` result and never gains identity or a stronger route.

The deeply frozen result contains the canonical proposal/text/digest, `verifiedSubject: null`, base-policy evidence, classification, sanitized binding metadata, and the caller's inert idempotency key for the later queue boundary. It has no durable or write effect.

## API

```js
import {
  validateCorrectionIntent,
  serializeCorrectionIntent,
  parseCorrectionIntent,
  correctionIntentDigest,
  computePageId,
  prepareSourceBindingManifest,
  validateSourceBindingManifest,
  serializeSourceBindingManifest,
  parseSourceBindingManifest,
  sourceBindingDigest,
  retainedManifestFilename,
  createRetainedSourceBindingResolver,
  createBareGitObjectResolver,
  deriveAccountFreeProposal,
} from '@cyberbaser/account-free-intake';
```

## Tests

```bash
bun install --cwd packages/account-free-intake --frozen-lockfile
bun test packages/account-free-intake/test
```

The suite covers strict intent keys and limits, authority/identity injection rejection, canonical manifest and page-ID vectors, deterministic ordering, retained exact binding lookup, stale and contradictory bindings, real local historical Git objects, base-policy binding, absent policy, no Git/network mutation, exact CRLF/tabs/trailing-space/emoji/combining-form preservation, missing and ambiguous quotes, canonical proposal replay, anonymous trust routing, and deep immutability.

## Multi-operation suggestion intent (v2)

The existing v1 APIs and canonical bytes are unchanged. Additive APIs are `validateSuggestionIntent`, `serializeSuggestionIntent`, `parseSuggestionIntent`, `suggestionIntentDigest`, `validateVersionedIntent`, and `versionedIntentDigest`. `deriveAccountFreeProposal` dispatches by the validated intent schema version.

A strict v2 intent contains `schemaVersion: 2`, the same `artifactType: 'cyberbaser-account-free-correction-intent'`, `bindingDigest`, opaque `pageId`, `operations`, and required nullable `idempotencyKey`. Optional `rationale` defaults to null; optional `evidence` defaults to an empty array. No other keys are accepted. The operations are exactly `{operationId,start,end,expected,replacement}` with ascending, distinct UTF-8 byte offsets into the retained base. IDs are unique. There are 1–50 operations, at most 16 KiB per expected/replacement span and 64 KiB aggregate expected plus replacement bytes. The intent itself is bounded to 256 KiB. Canonical serializers fix key order and append one LF; the parser rejects all other byte spellings. Omitted optional values normalize before the intent digest, so equivalent default metadata has the same replay binding.

The binding and Git resolver are exactly the v1 resolvers. Derivation calls `createChangeSetProposal`, validates each exact base slice and the combined candidate, and produces the canonical v2 artifact/digest. It does not write files. When rationale is absent/null, artifact rationale is the receiver-supplied neutral `Suggested edits.` because the unchanged proposal submission contract requires nonblank text. This is not a claim that the reader supplied a rationale.

The shared proposal v2 trust bridge classifies the combined exact before/after file using `@cyberbaser/trust`, including OFM checks, original leading-BOM handling and existing policy semantics. It never treats a v2 artifact as a loose collection of independently trusted splices. Identity remains null and the same anonymous full-review invariant applies. The HTTP carrier is documented in `apps/account-free-intake/README.md`; it uses the separate `POST /v2/suggestions` endpoint and shared attempt/work budgets.

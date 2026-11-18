# `@cyberbaser/suggestion-ledger`

A pure, dependency-free ESM suggestion ledger shared by replaceable rendered-page and source editors. It runs in browsers and Bun without Node APIs, file I/O, network access, editor dependencies, or source-write authority.

The immutable UTF-8 base is the authority. An origin-aware piece table retains original slices, original-byte deletion tombstones and inserted text. Editing inserted text edits that insertion; deleting it never invents deleted source bytes. Adjacent/dependent edits merge into one suggestion. Candidate bytes come only from pinned base slices and declared replacements, never a Markdown serializer or DOM conversion.

## Start here

```js
import { SuggestionLedger, digestBytes } from '@cyberbaser/suggestion-ledger';

const base = new TextEncoder().encode('Hello 😀\r\n');
const identity = {
  path: 'Example.md',
  byteLength: base.length,
  digest: digestBytes(base), // RFC 9530: sha-256=:BASE64:
};
const ledger = new SuggestionLedger(base, identity, {
  clock: () => '2026-11-16T12:00:00.000Z', // Optional injectable timestamp clock.
});

// Current-view UTF-16 selection -> current-view UTF-8 byte coordinates.
const map = ledger.coordinates('view');
ledger.replace({ start: map.utf16ToByte(0), end: map.utf16ToByte(5) }, 'Hi', {
  comment: 'Shorter greeting',
});
ledger.insert(ledger.coordinates().utf16ToByte(2), '!');
ledger.verify();
const operations = ledger.toOperations();
const candidate = ledger.toCandidateBytes();
```

Construction copies the base (including `Buffer` inputs), validates strict UTF-8, exact length and actual SHA-256 digest, and freezes the copied identity. A digest is a content binding, not proof of publication, permission, authorship or trust. The path is an inert binding label, not a filesystem destination or path-authority validator.

## Public API

### Edits and local history

- `new SuggestionLedger(baseBytes, {path, byteLength, digest}, {clock?, limits?}?)`
- `insert(at, text, {space = 'view', comment = ''}?)`
- `delete({start, end}, {space = 'view', comment = ''}?)`
- `replace({start, end}, text, {space = 'view', comment = ''}?)`
- `setComment(suggestionId, comment)`
- `discard(suggestionId)` restores that suggestion's original span without discarding other suggestions.
- `undo()`, `redo()`, `canUndo`, `canRedo`
- `baseIdentity`, `baseBytes` (fresh copy), `currentText`, `metadata` (frozen copy)

Ranges are half-open **UTF-8 byte offsets**, never UTF-16 indices. All edit methods return `true` on a ledger step; byte-identical edits return `false` and consume no history or ID. Unknown suggestion IDs and invalid coordinates throw. Each successful edit/comment/discard is one history step. Failures are atomic, including a throwing/invalid clock or exceeded limit. Editing after undo clears redo. Undo does not recycle creation IDs.

`space: 'base'` addresses pinned original coordinates despite previous length changes. Existing dependent replacement text is absorbed when a base-range boundary lies strictly inside a deleted/replaced original span. A base-range start maps before an insertion at that start; the end excludes a suggestion starting at that end. Zero-length base insertion maps **after** existing replacement/insertion text at that original boundary. These explicit rules avoid pretending replacement text has a one-to-one mapping to deleted original bytes. Use view coordinates for precise edits within inserted text.

Suggestion IDs are deterministic `suggestion-N` creation sequences. Editing an existing suggestion retains its ID and creation timestamp. Adjacent/overlapping suggestions keep the oldest creation ID, even when it is not the leftmost suggestion. Local comments merge in creation order, with the new edit comment appended; identical whole comments are deduplicated. A canceled suggestion loses its metadata; undo restores it. A globally unchanged candidate cancels all remaining operations. Metadata is `{[operationId]: {comment, createdAt}}` and is never embedded in the operation wire shape. It is local unverified presentation data, not an author identity.

### Coordinate adapters

- `coordinates('view' | 'base' = 'view')` returns an immutable snapshot adapter.
- `createCoordinateAdapter(bytes)` makes a standalone adapter.
- `adapter.utf16ToByte(index)`, `adapter.byteToUtf16(offset)`
- `adapter.positionAt(byteOffset)` -> `{line, column}`
- `adapter.byteAt({line, column})` -> byte offset
- `adapter.byteLength`, `adapter.utf16Length`, `adapter.lineCount`
- `ledger.baseToView(baseByteOffset, 'left' | 'right' = 'right')`

Offsets inside a UTF-8 code point, between a UTF-16 surrogate pair, or outside the document are refused. Unpaired replacement/comment surrogates and invalid base UTF-8 are refused rather than replaced. Combining marks and ZWJ sequences are addressable at scalar boundaries; grapheme-level keyboard behavior belongs to the editor adapter.

Lines and columns are one-based; columns count UTF-16 code units. CRLF is one logical line break with **both original bytes retained**. Lone CR and LF are also line breaks. A boundary between CR and LF remains addressable on the preceding line (the CR occupies a column). BOM, tabs, combining marks, mixed EOLs and terminal newlines are retained exactly. No normalization occurs. Recreate a view adapter after edits; a previously returned adapter intentionally describes the previous view.

### Exact output and verification

`toOperations()` returns a frozen array of frozen objects with **exactly these five keys**:

```ts
{
  operationId: string;
  start: number;
  end: number;
  expected: string;
  replacement: string;
}[]
```

Offsets always refer to the immutable base's UTF-8 bytes. Operations are sorted by `start`, non-overlapping, unique-ID, merged when adjacent, and individually no-op-free. `expected` decodes exactly `base[start:end]`. Insertions use `start === end` and `expected === ''`; deletions use `replacement === ''`. Separate operations have at least one untouched base byte between them. A base-identical complete candidate has no operations.

`toCandidateBytes()` builds `base[0:start1] + replacement1 + base[end1:start2] + ... + base[endN:]` in memory. `verify()` throws on a provenance/replay/untouched-byte invariant violation and otherwise returns `true`. Its independent piece-table projection must match operation replay exactly; every untouched gap and suffix is checked byte-for-byte.

This is an editor-side draft algebra, **not** a canonical proposal validator. It can represent a whole-file draft replacement; intake/owner policy must separately reject ineligible whole-file replacements, enforce the selected proposal version and smaller admission limits, verify publication/source bindings, and classify the combined candidate. A ledger operation or a local discard/preview is never source-write, approval or publication authority.

### Pluggable display adapters

`ledger.render(adapterId, registry = defaultDisplayAdapters)` selects a provider. The small vendor-neutral interface is:

```ts
interface DisplayAdapter<T> {
  id: string;
  render(input: {
    baseText: string;
    operations: readonly Operation[];
    metadata: Readonly<Record<string, { comment: string; createdAt: string }>>;
  }): T;
}
```

The core passes frozen snapshots. `createDisplayAdapterRegistry(providers)` validates providers and refuses duplicate/unknown IDs. Add a provider module, register its object, and run the same registry conformance tests. Providers get no ledger mutation or writer capability.

Built-ins:

- `criticMarkupAdapter`, ID `critic-markup`: `{~~old~>new~~}`, `{++inserted++}`, `{--deleted--}`, and nonempty `{>>comment<<}`. Literal CriticMarkup delimiters in source, replacements or comments **refuse** because there is no universal escaping convention. Use view segments in that case. This is display/export only, not a parsing, identity or integrity envelope.
- `viewSegmentsAdapter`, ID `view-segments`: frozen runs of exactly `{kind: 'equal'|'insert'|'delete', text, baseStart, baseEnd}`. Equal/delete runs have real original ranges; inserted runs have the zero-width anchor `baseStart === baseEnd === operation.start`. Excluding inserts reconstructs the original; excluding deletes reconstructs the current view. Correlate operations by original range when drawing suggestion cards.

Output is plain source text, not safe HTML. UI adapters must use text nodes or appropriate escaping/sanitization.

### Persistence

- `serialize()` -> JSON string containing schema version, complete base identity, current operations/metadata, undo/redo snapshots, and the next creation sequence.
- `SuggestionLedger.deserialize(baseBytes, identity, serialized, {clock?, limits?}?)` -> ledger.

Reload rehashes the supplied source, requires the saved path/length/digest to match, and validates **every** current/history operation, exact expected bytes, scalar boundaries, canonical ordering, IDs, metadata and bounds before restoring state. Stale source is refused, never silently rebased. The injected clock is executable behavior and is not serialized; pass it again when needed. Storage and retention are the host's responsibility. Saved state contains base-derived text/comments and should stay in a private draft store, not public build artifacts or identity/session credentials.

## Bounds and scope

Defaults are configurable positive integer core budgets, not intake policy:

| Limit | Default |
| --- | ---: |
| `maxBaseBytes` | 4 MiB |
| `maxViewBytes` | 8 MiB |
| `maxOperations` | 1,000 |
| `maxHistory` | 100 total undo/redo snapshots |
| `maxSerializedBytes` | 16 MiB |

Use `{limits: {...}}` at construction/reload. Unknown limit names refuse. Edits operate on in-memory pieces and rebuild bounded coordinate maps/projections; this is not a balanced-tree editor buffer or a large-file performance claim. Serialization fails if the retained history exceeds its byte budget; hosts may choose a lower history cap for draft storage. No accepted edits are silently dropped to fit persistence.

## Integration contracts

**Rendered-page editor:** retained renderer provenance must first prove that a visible range corresponds exactly to one literal source range. First edits can use base coordinates. Subsequent selections, especially inserted text, must use current-view byte coordinates from the shared ledger; never turn a DOM text index into an original byte offset by assumption. Draw deletion runs noneditable and insertion runs editable. Generated/transformed/transcluded text without an exact mapping must refuse or open the source surface. Both surfaces consume the same ledger, metadata and IDs.

**CodeMirror 6:** intercept every text-changing transaction, translate its UTF-16 positions through a snapshot of the current view, and submit exact range edits. Multi-range changes are applied from right to left so earlier coordinates do not move; this API records one ledger step per range. If a single CM6 transaction must undo atomically, add an explicit grouping adapter rather than implying that multiple calls already form one step. Ledger undo/redo is authoritative for suggestions, not an independent untracked editor document history. IME, paste/drop, cut, spellcheck and programmatic transactions must use the same route. Refresh both surfaces from the candidate/decorations only after ledger success; do not adopt `doc.toString()` as the source authority.

CM6 line-break positions/default normalization are not this library's byte coordinates. Configure a proven EOL-preserving adapter or translate CM6 line/column positions with retained original separators; refuse unsupported cases. A raw `coordinates().utf16ToByte(cmPosition)` is valid only when the editor string has been proven byte-equivalent to the current view, including all EOLs and BOM. No CM6 package is a dependency here.

**Submission:** send `toOperations()` through the separately versioned proposal adapter; metadata stays separate. The receiver revalidates pinned base, exact operation bytes, aggregate policy and trust. The owner decides/applies through the existing owner-controlled route. No display provider or editor can bypass it.

## Verification

From the repository root:

```sh
build-contained -- bun test packages/suggestion-ledger/test
```

Tests include deterministic unit cases plus 100 seeded, 100-step Unicode edit histories against an independent string-splice model. Bases/replacements contain emoji, CJK, combining marks, BOM, tabs, LF, CRLF, lone CR and ZWJ sequences. The mixed histories cover base/view edits, inserted-text edits, spanning deletions, undo/redo, discard, deterministic IDs, repeated persistence, scalar conversions and untouched-byte reconstruction. These are library tests, not rendered-page or CM6 browser acceptance.

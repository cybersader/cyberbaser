# @cyberbaser/ofm

The OFM (Obsidian-flavored markdown) **validator**. A corruption detector for tools that re-serialize markdown — deliberately **not a writer**.

## Why a validator and not a serializer

The R09 gate measurement (2026-07-25, see `/cyberbaser/research/v1-build-plan/` on the docs site) ran the proven masking pipeline over all 1430 real vault files: **4.6% byte-identical**, and only 36.9% even with stringify options tuned to the vault's style. Zero mask leaks, zero parse errors — the failures are formatting normalization, which means whole-file AST re-serialization is *architecturally* incapable of byte fidelity on real files.

Locked consequence (R12): the write path is raw text, splice-only — bytes in, edited bytes out, nothing re-serializes. What still needs tooling is **detecting** the tools that *do* re-serialize (CMS candidates, the Notion sync leg, structured editors) and the edits that destroy constructs. That is this package.

## CLI

```bash
bun install            # once, in packages/ofm

# Round-trip diagnostic over a whole vault (the R09 gate, reusable):
node bin/ofm-check.js corpus ~/bench/cyberbase [--json report.json]

# Classify a change between two versions of a file — the core validator:
node bin/ofm-check.js diff before.md after.md
#   verdict: clean   — plausible honest region edit (may include informational retargets)
#   verdict: suspect — re-serialization fingerprints (mass churn, style rewrites, injected escapes)
#   verdict: damage  — OFM constructs removed or degraded (exit code 1)
# Roundtrip/corpus also exit 1 for checker errors, mask leaks or refused input.

# Per-file diagnostic with first divergence shown:
node bin/ofm-check.js roundtrip file.md
```

Real-vault smoke test (2026-07-25): an honest appended line → `clean`; the same file re-serialized through remark → `suspect: list-marker-normalized`, churn 0.45.

## Library

```js
import { mask, unmask, roundtrip, checkChange, runCorpus, inventory } from '@cyberbaser/ofm';
```

- `mask(src)` / `unmask(text, store)` — the collision-safe masking core (PUA sentinels; throws `MaskCollisionError` rather than corrupting). Lossless by construction; proven over 21 fixtures and 1430 real files with zero leaks.
- `checkChange(before, after)` — the validator verdict: construct-inventory delta (wikilinks, embeds, callouts, math, footnotes, block IDs…), degradation detection (`[[X]]` → `[X](…)`), escape injection, mass-churn and list-marker fingerprints.
  - Wiki/embed replacements at corresponding link slots on aligned changed lines produce `wikilink-retargeted` / `embed-retargeted` findings with `severity: 'info'`. These alone leave the verdict `clean`. Remaining removals still mean damage. Equal document-wide removed/added counts are not enough: unchanged lines bound edit hunks, unequal-length ambiguous hunks are not paired, and alignment fails closed above 256 line edits.
  - Bracket escapes that disambiguate an existing Markdown link label are not counted as injected escapes. The parser must identify real links in both versions, with matching label/destination bytes except for label bracket escapes. New links, code, changed destinations, URL escapes and ordinary prose escapes get no exemption. Raw escape totals remain visible in `stats`.
- `runCorpus(dir)` — the gate measurement as a function; `checkerErrors` counts content-loss failures separately from parse errors.
- `roundtrip(src, pipeline?)` — the diagnostic; expected to diverge on most real files. Its default serializer uses the source's first unordered-list marker (ignoring code fences); an explicit pipeline retains its configured options. Mixed marker styles and other formatting can still normalize. Never put it in a write path.
  - A blank line inserted before a list is formatting, not a missing sentence. The CLI explains that case when displaying the first divergence.
  - Missing mask tokens or lost non-whitespace parsed content throw `RoundtripContentLossError` (exported from the package), never a successful diagnostic. The guard reparses output and checks text, code, math, frontmatter, destinations and other content payloads in source order, while allowing whitespace and Markdown-delimiter normalization. It is not a proof of raw-byte or full semantic fidelity.

## Tests

From the repository root, run `build-contained -- bun test packages/ofm/test`. Tests cover masking losslessness over the 21 spike fixtures, the spike's 20/21 parity (the nested-callout reflow is the one known holdout), classifier damage/injection negatives, source-marker preservation, content-loss errors and CLI/corpus behavior.

`test/fixtures/pr11/` contains six minimal public excerpts with the exact vault paths from `cybersader/cyberbase` PR #11: base `0cc579a4b0484b1939db1bd76ed9b8b3c1b6a717`, head `2a2fa72d16b498e662becb52d79e403981daa09c`, observed in run `43928114617`. The apparent empty output at line 23 of **Software Factory for AI-Written Code** was an inserted blank line; the sentence was intact at output line 24. The real default-serializer mismatch was dash-to-star list normalization. Neither issue required a dependency change.

Run the reusable fixture diagnostic from the repository root with `build-contained -- node packages/ofm/bin/ofm-check.js corpus packages/ofm/test/fixtures/pr11`. Formatting divergence is expected and is not an author verdict. Consumers with copied `file:` installations must refresh their installed package before testing a change; those installations are not necessarily live workspace links.

## Lineage

Hardened from `spikes/ofm-roundtrip/` (kept untouched as the historical R05 artifact). The corpus runner started as `spikes/ofm-roundtrip/corpus.mjs`, the R09 gate script.

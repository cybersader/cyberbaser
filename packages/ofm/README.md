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
#   verdict: clean   — plausible honest region edit
#   verdict: suspect — re-serialization fingerprints (mass churn, style rewrites, injected escapes)
#   verdict: damage  — OFM constructs removed or degraded (exit code 1)

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
- `runCorpus(dir)` — the gate measurement as a function.
- `roundtrip(src)` — the diagnostic; expected to diverge on most real files. Never put it in a write path.

## Tests

`bun test` — 10 tests: masking losslessness over the 21 spike fixtures, the spike's 20/21 parity (the nested-callout reflow is the one known holdout), and the verdict contract (honest edit clean, section deletion damage, wikilink degradation damage, remark normalization suspect).

## Lineage

Hardened from `spikes/ofm-roundtrip/` (kept untouched as the historical R05 artifact). The corpus runner started as `spikes/ofm-roundtrip/corpus.mjs`, the R09 gate script.

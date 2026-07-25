---
title: "The v1 build plan: three shapes and one gate"
description: "Six agents produced three competing shapes for v1. They disagree about what the product is. A half-day measurement of the real vault decides between them, so that runs first and nothing is locked until the number exists."
sidebar:
  label: "v1 build plan"
  order: 10
status: research
tags: [research, planning, roadmap, architecture]
---

On 2026-07-25 a six-agent design pass rebuilt the technical plan from [the recovered plan critique](/cyberbaser/research/plan-critique/). Four agents designed subsystems; two were adversarial by assignment, one steelmanning the case against the critics' consensus and one hunting for options outside the frame. The adversarial pair earned their seats: they did not agree with the four critics, or with each other, about what v1 is.

This page is the reconciliation. It states what every pass agreed on, where the three surviving shapes diverge, and the single measurement that decides between them. **Per the maintainer's call, nothing below is locked until that measurement exists.** (The measurement has since run — see [the gate result](#gate-result-run-2026-07-25) — and each shape contributed a piece of the locked answer.)

<div class="cb-grid">
  <a class="cb-card" href="/cyberbaser/research/proposal-hub-bom/">
    <span class="cb-card-label">Shape A · ~24 days</span>
    <span class="cb-card-title">Hub bill of materials</span>
    <span class="cb-card-desc">Ten named deployables around a serializer library and a CM6 edit widget. <strong>R12 kept:</strong> the component decomposition, per-PR preview design, the publish boundary (H6).</span>
  </a>
  <a class="cb-card" href="/cyberbaser/research/dissent/">
    <span class="cb-card-label">Shape B · ~11 days</span>
    <span class="cb-card-title">Contract-first governance</span>
    <span class="cb-card-desc">The OFM census argued the round-trip is a floor, not a moat. <strong>R12 kept:</strong> the corpus measurement itself, the hub contract, the two-corpus generality rule.</span>
  </a>
  <a class="cb-card" href="/cyberbaser/research/option-space/">
    <span class="cb-card-label">Shape C · ~19 days</span>
    <span class="cb-card-title">Conformance suite + suggestions</span>
    <span class="cb-card-desc">The suite as the first artifact; annotations instead of PRs. <strong>R12 kept:</strong> the validator-first sequencing — <code>@cyberbaser/ofm</code> is this idea, re-scoped by the gate evidence.</span>
  </a>
</div>

## The three shapes

| | Shape A: the hub bill of materials | Shape B: contract-first governance | Shape C: conformance suite + suggestions |
| --- | --- | --- | --- |
| Source | [Hub bill of materials](/cyberbaser/research/proposal-hub-bom/) | [The dissent](/cyberbaser/research/dissent/) | [The options the frame excludes](/cyberbaser/research/option-space/) |
| What v1 is | Ten named deployables: serializer library, CM6 edit widget, intake service, triage CI, per-PR previews, publish boundary, plus four forge-provided rows | A one-page hub contract, the write-back endpoint un-deferred (it is the runtime, not a feature), trust state moved out of the forge namespace, a two-corpus generality rule | The round-trip spike packaged as an executable conformance suite, then CriticMarkup suggestions as the contribution unit instead of file-and-PR |
| What the moat is | The lossless serializer; everything imports it | Possibly not the serializer: an OFM census of the real vault found ~80-85% of files carry no OFM at all, so the round-trip may be a correctness floor and governance the real product | Interoperability itself: the suite is the contract, and renderers, editors, CMSs, sync tools, and agents are conformant or not |
| First artifact | Environment-overridable base path, then the serializer package | The hub contract (1 day of writing) | The packaged suite, because it mechanically resolves the renderer fork, the CMS question, and the Notion audit |
| Contribution unit | File edit → PR | File edit → PR, endpoint shipped unlisted | A CriticMarkup annotation with a **reject-all invariance** rule: rejecting every suggestion must restore the original bytes, so destruction is impossible by construction |
| Days | ~24 | ~10.75 | ~19 |

Two further passes feed all three shapes rather than competing with them: [selective publishing](/cyberbaser/research/proposal-selective-publishing/) (urgent regardless of shape) and [the renderer, URL, and filename decisions](/cyberbaser/research/proposal-renderer-urls/) (needed by all three).

## What every pass agreed on

These hold under any shape, so they are safe to act on now:

1. **Measure the real vault before designing anything else.** Four independent passes converged on this from different directions. The vault has never been built, timed, or censused by any pipeline.
2. **No third-party serializer touches vault bytes.** The [architecture boundaries](/cyberbaser/design/architecture/) already forbid it; the CMS bake-off as planned tests a feature matrix when the kill criterion is a byte-diff. Run the [cheap kill test](/cyberbaser/research/proposal-write-path/) on all candidates rather than a deep evaluation of one.
3. **Selective publishing is a live exposure, not planning debt.** Personal content sits in a public repo with only a license carve-out between it and the roadmap's "publish the real vault" step. Roadmap Phase 3 is blocked until this has a mechanism. The passes disagree on the mechanism (two-repo split vs. a build-time publish boundary vs. an opt-in frontmatter flag), and the [selective publishing proposal](/cyberbaser/research/proposal-selective-publishing/) argues the strongest version.
4. **The Notion sync leg is an unexamined third writer into the source of truth.** Audit it empirically (the [write path proposal](/cyberbaser/research/proposal-write-path/) specifies the seven questions), then fence or cut on evidence. The real hazard is last-writer-wins on a file with two owners, which no serializer fixes.
5. **Q06 (stable URLs) is a one-day convention decision, not research.** The passes split on mechanism (path-slug plus `aliases` vs. `permalink` frontmatter); the [renderer and URLs proposal](/cyberbaser/research/proposal-renderer-urls/) makes the strongest case and the choice rides on the same gate measurement (the path census is part of it).
6. **Move the build checkout to ext4 before measuring anything.** The working tree is on a WSL2 9p mount where file-heavy operations run 5-20x slower; any number taken there has to be taken again.
7. **The orientation layer had drifted** and has now been corrected in the same session, per the knowledge-ops rule: the stale post-R08 justification in `FOCUS.md`, the CMS-finalist mismatch between the task layer and the research layer, and a misidentified sibling project.

## The gate: one measurement, stated before it runs

Shape B and Shape C independently converged on the same falsification test, and Shape A's plan is the one most exposed to its outcome. It doubles as the measurement run that every pass demanded.

**Procedure (~1 day total):**

1. Clone the vault to native ext4 (`~/bench/cyberbase`), shallow. Record clone time on ext4 vs. the 9p mount once, permanently settling the "is this slow or is this WSL" question.
2. Run the census: file counts, OFM construct counts, binary/LFS weight against GitHub Pages' 1 GB cap, path safety (Windows-illegal chars, NFC, case collisions, slug collisions).
3. Point `spikes/ofm-roundtrip/` pipeline D at **every** markdown file in the vault (~1445), not the 21 hand-written fixtures. Report: byte-identical percentage, a histogram of failure classes, wall-clock time.

**Decision rule, fixed in advance:**

- **≥ 99% byte-identical:** the round-trip is a solved floor, not a moat. The serializer ships as a small library plus CI gate, and the engineering weight shifts to what the forge cannot provide: the publish boundary, governance, and the contribution unit. Shapes B and C lead; Shape A's editor-centric sequencing is demoted to its triggered-later items.
- **< 95%:** the masking layer is a property of 21 fixtures rather than of OFM, the keystone is over-claimed, and nothing else ships until the serializer is actually built. Shape A's serializer-first sequencing leads.
- **Between:** read the histogram. If failures concentrate in one construct class, it is a bug to fix and then re-run; if they spread, treat as < 95%.

Either outcome is decisive, which is what makes the half-day worth spending first. The same run retires Q05 (build scale), the unrun binary/LFS check, and the renderer kill criterion as side effects.

## Gate result (run 2026-07-25)

The measurement ran the same day, on an ext4 clone. Raw output: pipeline D over **1430 files, 7.3 seconds, zero parse errors, zero mask-token collisions**.

| Metric | Result |
| --- | --- |
| Byte-identical | **66/1430 (4.6%)** |
| + trailing-whitespace equivalence | 225/1430 (15.7%) |
| + stringify options tuned to vault style (`bullet: '-'` etc.) | 73/1430 byte (5.1%), 528/1430 normalized (36.9%) |
| Files with no OFM-specific constructs | 1188 (83.1%) — confirms the dissent's census |
| Failure histogram (top) | list-marker 565 · other 426 · blockquote 144 · escape-added 58 · heading 20 · math 11 |
| Vault working tree | 725 MB sans `.git` (1.4 GB with), 4183 files, 1438 md, 1153 png, 131 files > 1 MB, **0 files > 100 MB** |
| Filesystem penalty | find+read of all md files: 0.04 s ext4 vs 31.2 s on `/mnt/c` — **~780x** for this pattern, far beyond the assumed 5-20x |

**Reading it honestly: both branches of the decision rule had a false premise.** The number lands in the "< 95%, serializer is unbuilt" branch — the 20/21 spike result was a property of fixtures written in remark's own output style, exactly as the dissent predicted. But the histogram shows the failures are almost entirely **formatting normalization** (list markers, blockquote spacing, added escapes), not OFM construct damage: the masking layer held perfectly (zero leaks). And the tuning experiment proves this is not a configuration problem: matching stringify style to the vault recovers to only 36.9%. Whole-file AST re-serialization is *architecturally* incapable of byte fidelity against real-world formatting diversity. "Build the serializer until files pass" is not a task, it is a treadmill.

### The locked shape (R12): byte-preservation by construction, validation as the product

1. **No whole-file re-serialization ever sits in the write path.** The write path is raw text: bytes in, edited bytes out, splice-only. This is what the [write path proposal](/cyberbaser/research/proposal-write-path/) already chose (CM6 raw surface; GitHub web editor as the interim path), now backed by measurement instead of preference. Byte fidelity is achieved by never round-tripping, not by serializer heroics.
2. **The serializer package is redefined as a validator, not a writer.** `@cyberbaser/ofm` ships as a *corruption detector*: the corpus runner (the exact tool that produced this table), a two-version diff checker that classifies changes as intended-edit vs. collateral damage (normalization noise, added escapes, OFM construct breakage), and the masking layer as its parsing core. Its customers are exactly the third-party writers that DO re-serialize: CMS candidates, the Notion sync, any structured editor. This is Shape C's conformance suite, re-scoped by evidence, and it becomes the Q04 enforcement mechanism: the CI gate checks that a change *damaged no constructs*, not that a file survives a re-serialization it will never undergo.
3. **The moat restated:** not "lossless re-serialization" (unachievable and unnecessary) but **byte-preservation plus mechanical validation plus governance** — the things the measurement showed are real and buildable.
4. Everything else (publish boundary, trust curve, renderer decisions) proceeds per its proposal, unblocked, with the suite as the shared kill-criterion tool.

Side-effect retirements: **Q05 closed** (a full remark pass over the vault is 7 seconds on ext4; build scale is a non-problem, the filesystem was the problem), the **binary/LFS check closed** (no file over 100 MB; 725 MB working tree means the publish boundary must exclude unreferenced assets to clear Pages' 1 GB cap, which it does by design), and all **bench work must run on ext4** (~780x).

## Sequenced next actions

| # | Action | Days | Status |
| --- | --- | --- | --- |
| 1 | Knowledge-ops landing: critiques, proposals, orientation-layer corrections | 0.5 | **done 2026-07-25** |
| 2 | ~~Selective-publishing triage~~ waived by R11 (content is intentional); publish boundary survives as a feature | — | **waived 2026-07-25** |
| 3 | **The gate measurement** | 1 | **done 2026-07-25** (results above) |
| 4 | Lock the shape (R12: byte-preservation + validation) | 0.5 | **done 2026-07-25** |
| 5 | Build `@cyberbaser/ofm` as the validator package: corpus runner, diff classifier, masking core, fixtures as tests, CLI | 2 | **in progress** — the first testable artifact |
| 6 | Wire the CI gate on cyberbase PRs (report-only first), then the remaining locked-shape work per the proposals | 8-15 | next |

## Where the shapes genuinely conflict

Recorded so the disagreement survives even after a winner is picked:

- **What gets built first:** preview infrastructure (A) vs. a written contract (B) vs. an executable test suite (C). C's argument is the strongest stated: the suite resolves other open decisions mechanically instead of by argument.
- **The contribution unit:** A and B keep file-and-PR; C argues the file-and-PR unit is what *generates* the merge-conflict UX problem, the per-PR preview problem, and the moderation reading load, and that an annotation unit with reject-all invariance dissolves all three. This is the largest unresolved design question after the gate.
- **The dogfood target:** the sequencing critic and Shape A point at the real vault now; Shape C points at a small, clean, public, contribution-shaped repo first, with the real vault as target #2. This choice interacts with selective publishing: the small target defers the exposure problem, it does not solve it.
- **The zero-account endpoint:** the critics deferred it; B un-defers it as "the hub runtime wearing a feature's name," shipped unlisted; C defers it again behind the agent-contributor path. The gate does not decide this one; the shape decision does.

## Related

- [Plan critique](/cyberbaser/research/plan-critique/) — the recovered four-lens audit this pass rebuilt from
- [The dissent](/cyberbaser/research/dissent/) — where the critics' consensus was attacked, and partially overturned
- [The options the frame excludes](/cyberbaser/research/option-space/) — the option-space pass, including the suggestion unit
- [Hub bill of materials](/cyberbaser/research/proposal-hub-bom/) · [Selective publishing](/cyberbaser/research/proposal-selective-publishing/) · [Renderer + URLs](/cyberbaser/research/proposal-renderer-urls/) · [The write path](/cyberbaser/research/proposal-write-path/)
- [Assumptions & risks](/cyberbaser/research/assumptions-and-risks/) — the risk register the critique validated
- [Roadmap](/cyberbaser/getting-started/roadmap/) — Phase 3 is blocked on selective publishing under every shape

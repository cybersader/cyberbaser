---
title: "The options the frame excludes"
description: "An option-space pass over the v1 design: browser-hosted Obsidian, agents as first-class contributors, a CRDT hybrid, suggestions instead of PRs, and the interop identity taken literally. Each priced and ruled on."
sidebar:
  label: "Outside the box"
  order: 16
status: research
tags: [research, architecture, contribution]
---

:::caution[Proposal, not a decision]
One of several competing v1 designs from the adversarial design pass of 2026-07-25. Nothing on this page is locked. The deciding gate is the corpus round-trip measurement described in [the v1 build plan](/cyberbaser/research/v1-build-plan/). Sections of the original analysis that depend on the maintainer's private repositories have been reduced here to their public conclusions; the full version lives in the maintainer's private workspace.
:::

Every argument in the plan critique is made inside one frame: a git repo, a static renderer, a CMS or editor widget, a PR queue. The four critics disagreed about sequencing and scope inside that frame; none of them stepped out of it. This pass looks for what the frame excludes, and rules on each option rather than listing it.

## Section 0: the orientation layer misidentified a sibling project

The orientation layer (`CLAUDE.md`, `PROJECT_CONTEXT.md`, `FOCUS.md`) described one of the maintainer's sibling projects as "Obsidian in the browser, a potential authoring spoke for the web-edit path." Verified against the actual repositories: that attribution was wrong. The named project is unrelated to markdown or vaults, while a *different*, private sibling actually holds that role, and has running capabilities that overlap three things cyberbaser's own research marks unsolved: sub-repo access control (one of git's two [structural zeros](/cyberbaser/research/source-of-truth/)), the maintainer's access-flexibility requirement, and the still-open "where does the hub runtime live?" question in [architecture](/cyberbaser/design/architecture/).

The corrective conclusions, which survive without the private detail:

- **The boundary between the two projects is a free scope reduction for cyberbaser.** The private sibling serves known, authenticated, trusted contributors inside tenants with folder-level access control and real-time collaboration. Cyberbaser serves the opposite population: unknown, anonymous, low-trust, drive-by, over a public rendered site plus a small edit affordance. Drawing that line moves mixed-privacy, role-based access, real-time collaboration, and most of the hub-runtime question out of cyberbaser's roadmap by assigning them an owner.
- The orientation files and the agent memory carrying the wrong attribution have been corrected (2026-07-25).

**Verdict: PURSUE NOW** (done in the same session). Cost: 0.5 maintainer-days.

## Option 1: Obsidian itself as the edit surface

**The idea.** If the authoring surface is literally Obsidian running in the browser against the vault, the CMS question and much of the translation-layer risk collapse, because the editor's semantics *are* the vault's semantics and no third-party serializer is in the write path. Prior art (Ignis, obsidian-web) proves the shim pattern is technically real, and a private sibling project has spiked it successfully.

**Why it still fails as cyberbaser's v1 edit surface:**

1. **Obsidian's ToS.** Its reverse-engineering carve-out covers non-commercial plugin development; a hosted "bring-your-vault" service is commercial. This is not a risk cyberbaser can engineer around.
2. **It cannot serve an anonymous contributor.** Booting an Obsidian instance per drive-by reader is absurd on cost; a streamed-desktop variant needs a container and a session. The minimum-viable-contribution bar in [contribution workflows](/cyberbaser/design/contribution-workflows/) is "3 clicks: Edit → type → Propose change." Streaming a desktop app misses that bar by an order of magnitude.
3. **It inverts a locked constraint.** Making the one blessed write path *be Obsidian* contradicts "don't over-anchor on Obsidian" and the editor-agnostic hub.

**Verdict: REJECT as the v1 edit surface. PARK WITH A TRIGGER** as a future trusted-contributor path (an edit-capable guest-session link to a real Obsidian instance would beat any CMS for named experts, at zero cyberbaser engineering, if the sibling ships it and the ToS position clarifies).

**The part worth keeping now:** the insight that "no third-party serializer in the write path" is the actual goal, not "Obsidian specifically." Cyberbaser already has that property in hand: the `spikes/ofm-roundtrip/` masking layer reaches it by never handing OFM bytes to a parser that would reinterpret them. A CodeMirror 6 widget over masked markdown has the same no-reserializer property as Obsidian-in-a-tab at roughly 1% of the cost and no ToS exposure.

## Option 2: agents as a first-class contributor class

**The evidence is already in.** [Assumptions & risks](/cyberbaser/research/assumptions-and-risks/) records that an agent found a real defect, produced a surgical OFM-safe fix, and opened [cyberbase#2](https://github.com/cybersader/cyberbase/pull/2), which merged. `PROJECT_CONTEXT.md` lists "AI agents maintaining content through the same reviewed pipeline as humans" as a target user, and the maintainer collaborates with agents daily.

Put that next to R08 (the demand gate waived because the maintainer is user #1). The honest consequence nobody drew: **after the maintainer, the next contributor is the maintainer's agents, not a human stranger.** That traffic exists and is proven. Human-stranger traffic does not.

**What changes if agents are the designed-for class:**

1. **The account question evaporates.** An agent has a bot identity by construction; the "never force an account" principle stays true and stays unbuilt, because the contributor class v1 actually serves does not need it.
2. **The trust curve becomes machine-checkable.** The human curve is "roughly three merged, unproblematic edits." An agent curve is different in kind: does the diff pass the conformance suite, does the document survive reject-all unchanged (Option 4), is the diff under N lines, is a source cited. CI evaluates those in seconds; the maintainer reads only what fails.
3. **The moderation queue's job inverts.** For human strangers the queue judges intent (unautomatable, the solo-maintainer bottleneck). For agents it verifies invariants (fully automatable) plus a thin human pass on truth.
4. **The v1 write interface is an API, not a form.** Agents need a documented write endpoint, a validator, and machine-readable rejection reasons, not a WYSIWYG. This kills the CMS bake-off for v1 more decisively than "narrow it to one candidate."
5. **The interoperability identity gets its machine half back.** "An interoperability layer for contributable, version-controlled knowledge bases" becomes an interop layer between *writers*, some of which are programs. One design note worth stealing: Obsidian plugins are unsandboxed, so any "approve this edit" dialog *inside* an editor is courtesy UI; a gate outside the editor, like the PR queue, is real enforcement.

**Cost:** 2 maintainer-days (policy column in the review model + the automated gates as a required check). **Verdict: PURSUE NOW.** The cheapest correct re-minimization of v1 after R08, and more honest than "build one web path," because it builds the path traffic actually uses.

## Option 3: CRDT for editing sessions, git as durable SSOT

The narrow question the SSOT research did not ask: is there a hybrid where CRDT handles only concurrent *editing sessions* while git stays the durable source of truth, sidestepping the serializer problem?

**Yes, and it is field-proven at small scale** (including in a private sibling project of the maintainer's, whose CRDT sync treats files as the sole source of truth and every index as a regenerable derived artifact). It sidesteps the serializer problem exactly as hoped: the CRDT merges bytes and writes bytes; there is no markdown-to-model-and-back step to lose anything in.

**The residual risk is real and is exactly Relay.md's.** [Source of truth](/cyberbaser/research/source-of-truth/) states it: Yjs treats markdown as a character sequence with no awareness of Obsidian syntax, so a concurrent edit splitting `[[a link]]` at the bracket produces a silently corrupted wikilink the CRDT considers a valid merge. Byte merging does not create *loss*, but it can create *invalid OFM*.

**What cyberbaser should do about it: almost nothing, and one small thing.** Cyberbaser v1 has no concurrent editing sessions; contribution is async and low-rate, and the docs already say realtime collaboration is out of scope. Adding a CRDT buys nothing and costs a server, a session model, and a new failure mode.

The one small thing is a test, not a feature: the conformance suite (Option 5) gains a **concurrent-merge fixture class**. Take each OFM fixture, produce two divergent edits touching the same construct, three-way merge them the way git or a CRDT would, and assert the result is still *valid OFM*, not merely a clean merge. Nobody in the surveyed field has that test; Relay.md's data-loss notes are evidence nobody checked. ~1 day.

**Verdict: REJECT the hybrid as v1 architecture. PURSUE NOW the merge-validity fixture class.**

## Option 4: change the unit of contribution from file-and-PR to a suggestion

This is the strongest single idea in this pass.

**The frame everything else argues inside:** a contribution is a new version of a file, delivered on a branch, reviewed as a diff, merged. Every hard problem in the critique is a consequence of that choice: merge-conflict UX for non-git contributors, per-PR previews that GitHub Pages structurally cannot provide, the fork-and-PR dance the CMS exists to hide, and the moderation load of reading whole-file diffs.

**A different unit: the suggestion.** Not a new file state, but an *additive annotation inside the existing file* that proposes a change, accepted or rejected in place. There is a plain-text standard for this: [CriticMarkup](https://github.com/CriticMarkup/CriticMarkup-toolkit) (`{++inserted++}`, `{--deleted--}`, `{~~old~>new~~}`, `{>>comment<<}`). The maintainer already maintains a public fork of the Obsidian implementation, [`cybersader/obsidian-criticmarkup`](https://github.com/cybersader/obsidian-criticmarkup), whose feature list already includes a vault-wide suggestions index and accept/reject from the gutter. A grep of cyberbaser for `criticmarkup` returned zero hits before this pass.

**Why this dissolves the hard problems rather than solving them:**

1. **No branch, so no merge conflicts.** Two people suggesting changes to the same paragraph produce two adjacent annotations, not two competing file states.
2. **No per-PR preview needed.** There is nothing to preview but one page with annotations on it, rendered by the same build.
3. **The maintainer reviews in Obsidian, in their own vault, in a UI that already exists.** Zero cyberbaser engineering for the entire review side.
4. **The safety property becomes mechanically checkable.** Define **reject-all invariance**: for any submitted document `D'`, applying reject-all must produce a document byte-identical to the pre-edit `D`. If that holds, the contributor provably destroyed nothing: vandalism, blanking, and silent rewrites are impossible *by construction*, not by moderation. Review collapses from "read the whole diff and hope you spot what was removed" to "read only what was added." For a solo maintainer that is the difference between a queue that works and the queue-is-the-bottleneck failure the risk register warns about.
5. **It composes with Option 2** (an agent suggestion is the same object; the invariant is a CI gate) **and Option 5** (CriticMarkup becomes one more construct that must survive the round-trip, plus one genuinely new conformance rule: a suggestion may not straddle an OFM construct boundary).
6. **It fits the locked identity better than a CMS does.** A shared plain-text suggestion format with a conformance rule is an interoperability artifact; a CMS is a publishing tool, which the identity work already ruled a dead frame.

**Honest caveats:** the upstream CriticMarkup plugin's own README warns of a non-zero risk of text removal in suggestion mode (that is the *accept* path; the reject-all invariant fully protects the *ingest* path, and a bad accept is one `git revert` away). Hands-on testing against the 21 fixtures is the go/no-go gate before anything else in this direction.

**Cost, priced:** masking + fixtures 1d · invariant validator 1d · render-side strip/style 1d · CM6 suggest widget 3d · write-back to a long-lived `suggestions` branch 2d · maintainer review side 0d (existing plugin) = **8 days**.

**What it kills:** the CMS bake-off, the per-PR preview requirement, the merge-conflict UX problem, and the review-queue app. **Verdict: PURSUE NOW, contingent on the go/no-go test — and this pass's author believes it is better than the convergent edit-widget-plus-PR path.**

## Option 5: the interop identity taken literally — a conformance suite, not a spec document

**The steelman.** If cyberbaser is genuinely an interoperability layer, the primary artifact is a **contract**: a statement of what must survive a round-trip, plus an executable suite that decides whether an implementation honors it. That is the most faithful reading of the locked identity, it needs no runtime, no auth, no hosting, and no users, and a solo maintainer can produce it.

**The ruthless half:** a spec *document* with no conforming implementations is a blog post. Do not write `OFM-INTEROP-1.0`.

**But the executable half survives, for an unusual reason: it has seven real consumers on day one, all inside the maintainer's own portfolio.**

| Consumer | What the suite decides for it |
| --- | --- |
| The Quartz-vs-Starlight fork | Run both renderers against the fixtures; the fork resolves mechanically instead of by argument |
| Any CMS candidate | The byte-diff kill criterion, made permanent and CI-enforced |
| [`notion-to-obsidian-github-sync`](https://github.com/cybersader/notion-to-obsidian-github-sync) | The uncontrolled third writer becomes a checked writer |
| CRDT/merge tooling | The merge-validity fixtures (Option 3) say whether byte-merging is safe over OFM |
| Agent contributions (Option 2) | The suite is the automated trust gate |
| The suggestion unit (Option 4) | The reject-all invariant and no-straddling rule live in it |
| The CM6 edit widget | Its regression suite |

`spikes/ofm-roundtrip/` is already ~80% of it: 21 tier-annotated fixtures and four escalating pipelines with byte-diff. Missing: packaging (named export, CLI, machine-readable result), the equivalence rules that let "semantically equivalent" pass where "byte-identical" fails, and the new fixture classes from Options 3 and 4.

**Cost:** ~4 days. **What it retires:** Q02 and Q04 both resolve to "run the suite," the CMS feature matrix, and the renderer fork. **Verdict: PURSUE NOW for the suite; REJECT the spec document until at least two implementations conform.** Do the 4-day version first, before anything else in the plan.

## Options the critique did not list

### Option 6: change the dogfood corpus

`cybersader/cyberbase` is 592 MB, ~1445 files, never built by any pipeline, mixed with personal content, written into by a third-party sync, on a slow 9p mount. It is the hardest possible first target on every axis simultaneously, and choosing it as the v1 dogfood corpus is part of why nothing has shipped.

The maintainer already owns a better first target: [`awesome-obsidian-and-cyber`](https://github.com/cybersader/awesome-obsidian-and-cyber) — public, 6.6 MB, pure markdown, no personal content, no third-party writer, and already contribution-shaped as an awesome-list (the exact repo genre [contribution workflows](/cyberbaser/design/contribution-workflows/) names as the benchmark for the contribution floor).

**Verdict: PURSUE NOW.** Cost: ~0, it is a config value. It retires the 592 MB build risk, the LFS question, the personal-content carve-out, and the third writer, all at once — and defers none permanently: cyberbase becomes target #2 once the pipeline works. **The caveat the reconciliation should carry:** this defers the exposure problem; it does not solve it. The [selective publishing work](/cyberbaser/research/proposal-selective-publishing/) stays urgent regardless.

### Option 7: selective publishing v1 is an opt-in flag, not an access-control architecture

At v1 it is one rule: **publishing is opt-in per file, never opt-out** — how Obsidian Publish itself works. Roughly half a day of build-filter work, and it makes the failure mode "a page nobody meant to publish stays unpublished" instead of "a journal entry ships." The maintainer already runs the heavier version of the pattern in production: [`knowledge-work-foundations`](https://github.com/cybersader/knowledge-work-foundations) is a "public mirror of tier 1 content only," which is the separate-repo-tiers answer the [SSOT research](/cyberbaser/research/source-of-truth/) sketched. Both weights are proven in-house.

Two honest caveats: this controls *publishing*, not *exposure* (the vault repo is already public; an allowlist does not un-expose it), and the [full selective-publishing proposal](/cyberbaser/research/proposal-selective-publishing/) argues the repo boundary itself must move. Treat this option as the floor, not the answer.

### Option 8: the write path is an API before it is a UI

Follows from Option 2. If the v1 contributor is an agent, the v1 artifact is a documented write endpoint with a validator and machine-readable rejection reasons, not a form. Resist building it as an MCP server for now; the plain HTTP function that takes a suggestion payload and makes a bot commit (Option 4, 2 days) is the v1 shape. **PARK WITH A TRIGGER:** 20+ merged agent contributions over plain HTTP.

## What this pass flags as better than the convergent plan

1. **The unit is wrong.** File-and-PR is what generates the merge-conflict, preview, and moderation-load problems. The suggestion unit dissolves them and adds a mechanically checkable safety invariant, the only kind of safety a solo part-time maintainer can rely on.
2. **The first artifact is wrong.** It should be the conformance suite, because the suite resolves the renderer fork, the CMS question, and the third-writer audit mechanically, in about 4 days. Building a widget first means building it against an undecided renderer.
3. **The contributor is wrong.** The plan builds a web path for human strangers who, post-R08, are explicitly not the validation target. The contributor that exists and is proven is the maintainer's own agents.

## Related

- [The v1 build plan](/cyberbaser/research/v1-build-plan/) — how this shape competes with the other two
- [The dissent](/cyberbaser/research/dissent/) — arrives at the conformance-suite-first conclusion from the opposite direction
- [The write path](/cyberbaser/research/proposal-write-path/) — the file-and-PR shape this challenges
- [Selective publishing](/cyberbaser/research/proposal-selective-publishing/) — why Option 7 is a floor, not the answer
- [SSOT findings](/cyberbaser/research/source-of-truth/) — the structural zeros the sibling boundary reassigns
- External: [CriticMarkup toolkit](https://github.com/CriticMarkup/CriticMarkup-toolkit) · [criticmarkup-parser](https://github.com/Fevol/criticmarkup-parser) · [Relay.md](https://relay.md/) (the CRDT cautionary case) · [Quartz](https://quartz.jzhao.xyz/)

## Task list

The reconciled sequencing lives in [the v1 build plan](/cyberbaser/research/v1-build-plan/). This shape's own ordering, if adopted after the gate:

| Wave | Work | Days |
| --- | --- | --- |
| 0 | Orientation-layer correction + sibling boundary | 1 (done 2026-07-25) |
| 1 | Package the conformance suite: CLI, JSON output, equivalence rules, merge-validity fixtures | 4 |
| 2 | Use the suite to resolve the renderer fork, check the Notion writer, decide Q06 | 2 |
| 3 | The suggestion unit: go/no-go plugin test, masking, reject-all validator, render strip, CM6 widget, write-back | 8 |
| 4 | Agents as the designed-for contributor: policy column + CI gates with auto-merge on all-pass | 2 |
| 5 | Dogfood target: small public repo first, opt-in publish flag | 1 |

---
title: "Renderer, URLs, filenames: what we publish and at what addresses"
description: "Four decisions that unblock first publish: adopt Quartz as the vault's spoke renderer, fix the URL contract to path-slug plus aliases, replace the kebab-case lint with a safety lint, and run the one build measurement nobody has run."
sidebar:
  label: "Renderer + URL decisions"
  order: 13
status: research
tags: [architecture, tradeoffs, scaling]
---

:::caution[Proposal, not a decision]
One of several competing v1 designs from the adversarial design pass of 2026-07-25. Nothing on this page is locked. The deciding gate is the corpus round-trip measurement described in [the v1 build plan](/cyberbaser/research/v1-build-plan/), which also maps how the competing shapes differ.
:::

Four questions have been sitting open with no owner, and they are the same question asked four ways: **what do we publish, and at what addresses.** Nothing can ship until they are answered, and none of them needs more research. They need one measurement and one afternoon of convention-setting.

This page decides all four. It supersedes the renderer and SEO rows in [the v1 architecture table](/cyberbaser/research/v1-architecture/) and closes Q02 and Q06 in [Open Questions](/cyberbaser/reference/open-questions/).

## The four decisions

| # | Question | Decision | Cost |
|---|---|---|---|
| **D1** | Quartz or the bespoke Starlight chain? | **Two spokes: Quartz renders the content vault, Starlight keeps rendering the project docs site.** Neither is rewritten into the other. | 1 day to prove, 0 days to migrate |
| **D2** | Q06 stable URLs | **Path-derived slug + `aliases` frontmatter as the redirect table + a CI slug-diff gate that fires only after a declared URL-freeze date.** | 1 day |
| **D3** | Filename policy | **Safety lint, not style lint. No mass rename.** Ban what breaks checkouts and what collides after slugification; keep spaces, keep case, keep natural titles. | 1.5 days |
| **D4** | The unrun measurement | **One instrumented build of the real vault on ext4, with a Windows/9p control run**, producing a census, a failure list, and an output size measured against the GitHub Pages 1 GB cap. | 1.5 days |

D4 is the empirical input to D1 and D3, and it also answers Q05 as a side effect. One measurement retires three open questions.

---

## D1. The renderer fork: adopt Quartz for the vault, keep Starlight for the docs

### The decision

Run **two renderers, permanently**, over two different content sets:

- **`cybersader/cyberbase` (the 1439-file OFM vault) renders through Quartz.** Quartz is Obsidian-native by design: transclusion, block refs, heading anchors, foldable callouts, LaTeX, backlinks, popovers, comment stripping, tags. The [prior-art audit](/cyberbaser/research/assumptions-and-risks/#tested-quartz-prior-art-audit-2026-06-19) (`research/assumptions-and-risks.mdx` line 53) already recorded that it beats this project's own Starlight prototype on OFM fidelity, for free. There is no version of "build the forward transform ourselves" that ends better than that.
- **`cyberbaser/docs` (this site, ~81 pages of MDX with custom components) stays on Astro + Starlight.** It is not an Obsidian vault, it uses none of the OFM features Quartz exists to solve, and it depends on hand-built MDX components (`brand.css`, the mockup/tree/diff/dial library) and 77 green Playwright tests. Porting it to Quartz would be several days of pure loss.

The framing that made this look like a hard fork was treating "the renderer" as singular. It is not. There are two content sets with two shapes, and the correct answer is the boring one.

### The cheap empirical test (not more research)

The fidelity question is already answered by the June audit. The only thing still unknown is whether Quartz **survives the real vault**, which is exactly the measurement in D4. So the test is not a separate spike, it is one arm of the D4 run:

1. Clone `cybersader/cyberbase` to ext4, symlink it into `quartz/content`, run `npx quartz build`.
2. Record: exit code, wall time, peak RSS, the full warning list, count of unresolved wikilinks, output file count, output byte size.
3. Score a fixed 20-item OFM checklist against the built HTML by grep, not by eye: `[[wikilink|alias]]`, `[[note#heading]]`, `[[note#^blockid]]`, `![[embed.md]]`, `![[image.png]]`, `![[note#heading]]`, each of the 13 callout types collapsed to 3 representatives, `$inline$` and `$$block$$` math, ```` ```mermaid ````, tables, footnotes, tags, `%%comments%%` (must be absent from output), frontmatter aliases.

**Kill criterion, stated in advance:** Quartz is adopted unless the build fails outright on the real vault, or scores below the current Starlight chain on the 20-item checklist. Anything else (slow build, ugly slugs, missing feature we do not use) is a configuration problem, not a fork.

**Time box: 1 day.** If it takes more than a day, that itself is the finding.

### What this decision deletes

Be explicit, because a lot of planned work evaporates:

| Deleted / retargeted | Where it lives now | Why |
|---|---|---|
| **Q02, "is `astro-loader-obsidian` sufficient for Tier 1?"** | `reference/open-questions.mdx` lines 24-30 | Closed as **not applicable**. We are not using it. It was already flagged as a corruption risk (`v1-architecture.mdx` line 119: it "silently parses `#hex` colors and shell `#` in code blocks as tags"). Deciding not to build the forward transform retires the question rather than answering it. |
| **Phase 1, "Translation Layer Hands-On"** as written | `.claude/20-ROADMAP.md` lines 43-44 | Currently scoped as "prove Tier 1 against real vault content (`astro-loader-obsidian` sufficiency vs custom remark/rehype)". That is the **forward** direction, which is now bought. Phase 1 is retargeted to the **reverse** direction only: the web-edit-to-vault serializer built on the 20/21 spike. This is a scope reduction of roughly half a phase. |
| **The `starlight-obsidian` v0.13 + `rehype-callouts` v2.2 stack row** | `v1-architecture.mdx` line 41 and line 119 | Demoted from "the v1 translation layer" to "not used". The docs site does not need it (no OFM content); the vault does not need it (Quartz covers it). |
| **The KaTeX CSS fix, the Mermaid/Playwright CI dance, `starlight-tags`, Pagefind sizing** | `v1-architecture.mdx` lines 121-122, 129 | All become project-docs-only concerns. Quartz ships its own search, math, and Mermaid. None of it is vault infrastructure any more. |
| **Any renderer-adapter abstraction** | proposed, never built | Stays killed. See the boundary section below. |
| **"Alternative-SSG evaluation" as an out-of-scope item** | `.claude/20-ROADMAP.md` line 23 | Was listed as explicitly out of scope during Phase R on the grounds that the renderer is a commodity. That reasoning is right and is exactly why this decision is cheap: we are picking a commodity, not evaluating a platform. Remove the line rather than leaving it to block the 1-day test. |

What it does **not** delete: the round-trip serializer, the trust curve, the moderation queue, the write-back endpoint. Those are the hub, and the hub is unaffected by which spoke renders. That is the point.

### How the boundary is enforced, in practice

The critics argued that renderer agnosticism is **a boundary, not an adapter layer**. **Agree, and refute the adapter framing specifically.** An adapter layer would be the worst possible response here: it would be code written against exactly one renderer, tested against exactly one renderer, and therefore coupled to it more tightly than a bare dependency would be, while costing days to build and maintain. An abstraction with one implementation is not an abstraction, it is a rename.

The boundary is enforced by four mechanisms, none of which is an interface:

1. **Two live spokes.** Starlight renders the docs, Quartz renders the vault, both in CI, both on every push. An agnosticism you never exercise is already broken and you do not know it yet. Two running renderers make coupling fail loudly and immediately. This is the single strongest enforcement available and it costs nothing extra, because both sites exist anyway.
2. **Dependency direction, checked mechanically.** The hub package (serializer, edit widget, write-back endpoint) must have **zero** dependencies on `quartz`, `astro`, `@astrojs/*`, or any renderer plugin. This is a five-line CI check over the lockfile, and it is the whole "no coupling" rule made executable. The hub touches markdown files and git commits, never a renderer AST.
3. **A clean vault contract.** The vault carries **no renderer-specific files and no renderer-required frontmatter**. No `quartz.config.ts` in the vault, no Quartz-only keys that the vault needs in order to render correctly. Quartz's own convention (vault mounted or symlinked into `content/`) fits this exactly: the vault is an input, not a project. This is the `architecture.mdx` boundary table (lines 249-253) applied literally: "Vault must not depend on cyberbaser plugins to work in Obsidian", extended to "must not depend on the renderer either".
4. **The URL contract is the API of the spoke** (D2 below). A renderer is admissible if and only if it produces the contracted slug for a given vault path and honors the contracted alias table. That is a conformance test of roughly 50 lines over a fixture list of vault paths and expected URLs. It is the *only* code the boundary needs, and it is a test, not an abstraction.

Stated as a single sentence for the architecture page: **the renderer is swappable because the vault contains nothing renderer-specific, the hub imports nothing renderer-specific, and the only thing the renderer owes us is the URL contract, which is asserted by a test.**

The exit cost, priced honestly: if Quartz turns out wrong in a year, the cost of leaving is (a) reconfiguring a different SSG and (b) preserving the URL scheme. (b) is the expensive half, which is why D2 exists and why it must be renderer-independent.

### Runners-up

- **Keep the bespoke Starlight chain for the vault.** Rejected: it costs several days to reach parity with something free, and the audit says it currently trails. The only argument for it is sunk cost in `brand.css` components, which serve the docs site and are retained there.
- **Migrate everything, including the docs, to Quartz.** Rejected: destroys 77 green tests and a custom component library, for a site whose content has none of the OFM features Quartz solves. Also, ironically, it would leave the project with one renderer, which is the coupling risk we are trying to avoid.
- **Fork Quartz.** Rejected explicitly, and this is the trap to name out loud: "adopt Quartz" becoming "maintain a Quartz fork" is exactly how the commodity turns into a dependency. If a Quartz behavior is wrong for us, the fix goes in the **projection step** (D3), which runs *before* Quartz sees the files and knows nothing about Quartz, or upstream as a PR. Never in a patched `quartz/util/path.ts`. Write this down as a rule; it is the one that will actually get violated.

---

## D2. Q06 stable URLs: path-derived slug plus an alias redirect table

Q06 (`reference/open-questions.mdx` lines 64-70) self-describes as blocking any production deploy and has sat ownerless since 2026-04-11. It is a one-day convention decision. Here is the convention.

### The decision

**Three rules, and they are the contract every spoke must satisfy:**

1. **Canonical URL = the slugified vault path, relative to vault root, minus the `.md` extension.** No frontmatter required, no per-file annotation, no authoring ceremony. Slugification is defined by the contract below, not by the renderer.
2. **`aliases: []` in frontmatter is the redirect table.** Every string in it must resolve to the page, permanently. This is the *same* field Obsidian already uses for wikilink resolution, so one entry fixes the vault-internal link and the public URL simultaneously. That is the property that makes this option strictly better than the alternatives.
3. **A CI slug-diff gate**, active from a declared URL-freeze date onward: compute the slug set of the build, diff it against the slug set of the last published deploy, and **fail the build if a slug disappeared and is not covered by an alias**. Renames are still allowed; unrecorded renames are not.

### Why this and not the other two candidates

**Frontmatter `slug` / `permalink` (the current recommendation in `v1-architecture.mdx` lines 50 and 131) is overturned.** Three reasons:

- It requires an authoring action on every file. There are 1439 of them. It will be applied to the twelve pages someone remembers and to nothing else, which means the URL policy is really "auto-slug" with extra steps and a false sense of coverage.
- It creates a second naming authority. The filename says one thing, `permalink` says another, and Obsidian's wikilinks resolve on the *filename*. The vault's internal link graph and the published link graph then diverge, silently, forever. `aliases` has the opposite property: it is the field Obsidian *already* consults, so the two graphs stay identical by construction.
- It is not renderer-portable. Quartz has no `permalink` concept; Starlight has `slug` but spells it differently. A `permalink` contract would require custom code in every renderer, which is precisely the coupling D1 forbids. `aliases` is natively implemented on both sides: Quartz's `AliasRedirects` emitter reads `file.data.aliases` and emits stub pages carrying `<link rel="canonical">`, `noindex`, and a meta-refresh; Astro's static `redirects` config "will output HTML files with the meta refresh tag by default". Same mechanism, two renderers, zero custom code.

That last point also **closes the open flag on `v1-architecture.mdx` line 131** ("the `public/_redirects` plan is Cloudflare-specific and does not work on GitHub Pages"). It does not need a Cloudflare host or a real 301. It needs meta-refresh stubs, which both candidate renderers already generate, and which Google treats as a redirect signal for permanent moves. This was never a host problem; it was a "we specified the wrong mechanism" problem.

**Content-hash URLs are rejected outright.** They break the one property a wiki URL exists to have: a human can read it, type it, and guess it. They also change on every content edit unless the hash is over an identity rather than the content, at which point it is a UUID with extra steps and no readable meaning. And no candidate renderer produces them without custom code, so they violate the boundary contract in D1. This option should be struck from the register, not carried forward.

### The slug contract, written out

So it can be asserted by a test rather than argued about later. Per path segment, in order:

```
whitespace     -> "-"
"&"            -> "-and-"
"%"            -> "-percent"
"?" and "#"    -> removed
".md" ext      -> removed
trailing "/"   -> removed
result         -> lowercased          (see D3: applied in the projection step)
```

The first six lines are Quartz's `sluggify()` verbatim (`quartz/util/path.ts`), chosen deliberately: adopting the incumbent's rule means zero custom code on the Quartz side and a small, well-specified job on any other side. The lowercase step is ours and is handled in D3.

Two consequences of this rule that must be tested, not assumed:

- **It is lossy, so collisions are possible.** `Threat Modeling.md` and `Threat-Modeling.md` both slugify to `threat-modeling`. So do `A & B.md` and `A and B.md`. A collision means one page silently overwrites the other in the output. This is real data loss with no error message, and it is why slug uniqueness is a hard CI gate in D3.
- **Case matters on the server.** GitHub Pages serves from Linux, so `/Threat-Modeling` and `/threat-modeling` are different URLs, and Quartz's slugifier does not lowercase. Handled in D3 by lowercasing in the projection step and emitting the natural-case form as an alias, so both resolve and one is canonical.

### What URL churn during a maintainer-only dogfood period actually costs

Honestly: **externally, nothing. Internally, a habit debt that compounds silently.**

- No inbound links exist. The vault has never been published by any pipeline. There is no search index to invalidate, no third-party blog post pointing at a page, no bookmark to break. Renaming and reorganizing freely right now costs literally zero.
- The real cost is different, and it is the reason to decide now rather than later: **every day without the convention is a day of vault reorganization that nobody records**, so that when the freeze date arrives, the alias table starts empty and the entire pre-freeze history of moves is unrecoverable. That is not expensive yet. It becomes permanently expensive the moment a URL is public, because from then on every unrecorded rename is a 404 you cannot detect after the fact.

So the policy is deliberately two-phase, and the phases are separated by a **declared date, not a vibe**:

- **Before the URL-freeze date:** reorganize the vault as aggressively as you like. Add no aliases. The slug-diff gate is off. This is the window in which D3's renames happen, and it is why D3 must land before first publish.
- **At the freeze date** (defined as: the day the site is served from a real domain, or the day it is submitted to any search engine, whichever comes first): turn on the slug-diff gate, snapshot the slug set, and from then on every rename either keeps its slug or adds an alias. CI enforces it.

This converts URL stability from a discipline problem, which a solo part-time maintainer will lose, into a mechanical one, which CI wins for free. It is half a day of work and it is the highest-leverage automation in this entire document.

---

## D3. Filename policy: a safety lint, not a style lint

`v1-architecture.mdx` line 130 currently prescribes "enforce ASCII kebab-case filenames via CI lint". The real vault demonstrably contains emoji, spaces, and `&` in paths, and the only evidence anything works is a single successful WSL traversal. **Overturn the kebab-case rule. Adopt a safety lint and a projection step. Do not mass-rename.**

### The decisive argument against mass rename

Kebab-casing filenames **does not change the published URL**. `Exposure Triangle.md` and `exposure-triangle.md` both slugify to the same address (modulo case, which is handled separately below). So the mass rename buys nothing at the URL layer, which was its stated purpose, while costing:

- **Wikilink breakage across the whole vault.** Obsidian wikilinks resolve on the note *name*. A rename performed outside Obsidian breaks every `[[Exposure Triangle]]` in the vault at once. Performing it inside Obsidian with "automatically update internal links" enabled rewrites them, but that is a per-file interactive operation across 1439 files, or a bulk-rename plugin doing an unreviewed find-and-replace over the entire corpus.
- **Block-ref breakage.** `[[Note#^block-id]]` embeds the note name, so it breaks on exactly the same trigger as a plain wikilink. Within-file `^ids` are unaffected.
- **Canvas breakage.** JSON Canvas nodes store file paths in a `file` field. Any rename that Obsidian's link updater does not cover leaves dangling canvas nodes, and a canvas node failing is much quieter than a broken wikilink.
- **GitHub permalink breakage.** Anything linking to a file at `github.com/cybersader/cyberbase/blob/main/...` breaks. The repo is public and has been since before this project started.
- **A 1439-file diff** that makes `git blame` across the rename plus any content edits materially harder to read.

Priced: **3 to 5 maintainer-days plus an irreducible tail of silent breakage, in exchange for cosmetics.** Refuse.

### The decision

**Enforce a safety charset and slug uniqueness. Enforce nothing about style.**

**CI-failing (must be renamed):**

1. Windows-illegal characters in any path segment: `< > : " | ? *`, plus control characters (0x00-0x1F).
2. Reserved Windows device names as basenames: `CON`, `PRN`, `AUX`, `NUL`, `COM1`-`COM9`, `LPT1`-`LPT9`.
3. Leading or trailing whitespace, or a trailing `.`, in any segment.
4. Total path length over 200 characters (Windows `MAX_PATH` headroom; keep `core.longpaths=true` from line 130, which is good advice and stays).
5. Paths not in Unicode NFC form (a macOS NFD path and a Linux NFC path that look identical are different bytes to git, and the wikilink resolves on exactly one of them). Set `core.precomposeunicode=true` and `core.quotepath=false` alongside the existing `core.trustctime=false`.
6. **Slug collisions.** No two vault paths may slugify to the same slug. This is the only rule on the list that catches silent data loss, and it is the reason the lint exists at all.

**Explicitly allowed, forever:**

- Spaces in file basenames. The slugifier handles them, the URL is identical, and titles read like titles in Obsidian's file explorer.
- `&` and `%` in basenames. Handled by the slugifier, subject to rule 6.
- Mixed case in basenames. Handled by the projection step below.
- Non-Latin scripts in basenames, subject to NFC and rule 6.

**Banned in *directory* names only:** emoji and pictographic symbols. This is the one place a rename is worth doing, and it is nearly free, because **Obsidian wikilinks are name-based, not path-based, so renaming a folder does not break a wikilink.** The exception is path-qualified links (`[[folder/note]]`) and embeds, which the census in D4 counts before anything is touched. Emoji folder names are worth removing because they percent-encode into unreadable URL segments (`%F0%9F%93%A5`), they are the most likely NFC/normalization tripwire, and unlike file basenames they are pure organizational decoration.

**Emoji in file basenames:** banned as well, renamed inside Obsidian so links are rewritten by the app. Expect a small number. The census in D4 gives the exact count before committing to the work; if it exceeds roughly 40 files, split it across two sessions rather than escalating the decision.

### The projection step (where lowercasing and everything else lives)

The vault is the source of truth and stays untouched. Between the vault and any renderer sits a **build-time projection**: a script that copies (or hard-links) the vault into `content/` and, on the way through:

1. Lowercases path segments, and injects the natural-case slug into the projected copy's `aliases` frontmatter so both URLs resolve with the lowercase one canonical. Frontmatter-only, no body rewriting, so no risk to content.
2. Drops excluded paths. This is also the natural home for the selective-publishing problem (journals, finance notes, resumes) that currently has no task anywhere, though the exclusion policy itself belongs to whoever owns that decision.
3. Fails the build on any safety-lint violation or slug collision.

This is not a renderer adapter and must not become one. It knows nothing about Quartz or Astro; it takes files and produces files. It is a **vault projection**, which makes it a hub function under the architecture boundary table, and it is the designated place for every "the renderer does the wrong thing" fix so that forking a renderer never becomes tempting.

Priced at **1 day**, and it is the piece that makes D1, D2, and D3 all mechanical.

### Runner-up

**Unicode everywhere, no lint at all.** Rejected only because of rules 1, 5, and 6. Windows-illegal characters make the repo un-checkoutable on the maintainer's own primary OS, NFD/NFC drift breaks links in a way that is nearly impossible to debug, and slug collisions destroy pages with no error. Everything *else* in "unicode everywhere" is accepted: this decision is much closer to that pole than to the kebab-case pole, and the framing should be "we kept the vault's natural names and banned only what actually breaks".

---

## D4. The measurement protocol

Nobody has ever built this vault. Every performance, cost, and feasibility claim downstream of it is a guess, including Q05 (`open-questions.mdx` lines 54-60) and the LFS check still open in `FOCUS.md` line 29.

### Control for the WSL2 filesystem penalty first

The working tree lives on `/mnt/c` under WSL2, which is the 9p protocol, where file-heavy operations commonly run 5 to 20 times slower than native ext4. A build over 1439 files and 592 MB is precisely the worst case for it. Measure on both, but be deliberate about which tree moves:

- **Move the *build* checkout to ext4** (`~/bench/cyberbase`, inside the WSL filesystem). This is the number that predicts CI, because GitHub Actions `ubuntu-latest` is ext4. Roughly a 2-hour job, and it must happen **before** the big-vault work, because otherwise every measurement taken is contaminated and every iteration is slow for no reason.
- **Do not move the authoring vault off the Windows side.** Obsidian is a Windows app; a vault served to it over `\\wsl.localhost` inverts the penalty and makes daily authoring slow. The ext4 copy is a build/bench clone, not the working vault.
- **Run the build on both once**, and record the ratio as a single number. It is worth knowing permanently, and it settles the "is this slow, or is this WSL" question for every future benchmark.

### What to record

**Clone and size**

```bash
/usr/bin/time -v git clone --depth 1 https://github.com/cybersader/cyberbase ~/bench/cyberbase
du -sh ~/bench/cyberbase ~/bench/cyberbase/.git
git -C ~/bench/cyberbase count-objects -vH
```

**File census** (total files, `.md` count, extension breakdown, size histogram):

```bash
find ~/bench/cyberbase -type f -not -path '*/.git/*' -printf '%s\t%p\n' | sort -rn > census.tsv
```

**Binary / LFS count** (the "1-hour check" from `FOCUS.md`, finally specified). Working tree and history are different questions and both matter:

```bash
# working tree, largest files
awk -F'\t' '$1 > 1048576' census.tsv | wc -l          # >1 MB
awk -F'\t' '$1 > 52428800' census.tsv                  # >50 MiB: git warns
awk -F'\t' '$1 > 104857600' census.tsv                 # >100 MiB: GitHub blocks the push

# full history, largest blobs ever committed
git -C ~/bench/cyberbase rev-list --objects --all \
  | git -C ~/bench/cyberbase cat-file --batch-check='%(objecttype) %(objectname) %(objectsize) %(rest)' \
  | awk '$1=="blob"' | sort -k3 -rn | head -50

git -C ~/bench/cyberbase check-attr -a --all 2>/dev/null | grep -i lfs   # existing LFS config?
```

**Decision rules, fixed in advance:**

- Any blob over **100 MiB** in history: LFS (or history surgery) is mandatory, because GitHub hard-blocks the push. Any file over **50 MiB** produces a git warning.
- Total working-tree binary weight over **300 MB**: media moves to R2 (already the decided media store) **before** first publish, because of the output-size cap below.
- Prefer R2 over LFS for published media. Two reasons that are easy to get wrong: LFS objects are **not** fetched by `actions/checkout` unless `lfs: true` is set, so an unconfigured Pages build publishes LFS *pointer text files* instead of images; and LFS bandwidth is metered and trivially exhausted by a public site.

**Path census** (feeds D3 directly):

```bash
# unsafe characters, emoji, case-only duplicates, NFC violations, slug collisions
```
Report: max path length; count of paths containing `< > : " | ? *`; count with emoji/pictographic codepoints, split by directory-segment vs basename; count of paths not in NFC; count of path pairs differing only by case; **count of slug collisions after applying the D2 slug rule**; count of path-qualified wikilinks (`[[folder/note]]`) that a folder rename would break.

**Build** (both renderers, both filesystems):

```bash
/usr/bin/time -v npx quartz build 2>&1 | tee build.log
```
Record: exit code, wall time, **peak RSS** (`Maximum resident set size` from `time -v`), full warning list bucketed by cause, count of unresolved wikilinks, output file count, output byte size. Run once with default Node heap and once with `NODE_OPTIONS=--max-old-space-size=8192` to find out whether the default OOMs.

**Failure list:** every file that errored or warned, with the cause, as a table. This is the deliverable that tells you whether the vault is publishable, and it is the one that gets skipped if the protocol is not written down.

### Measure against the real limits

| Limit | Value | What blows it |
|---|---|---|
| Published Pages site size | **1 GB, hard** | 592 MB of repo, most of it assets, copied into output alongside generated HTML. This is the most likely failure and the reason the binary census is not optional. |
| Source repo size | **1 GB, recommended** | Already at ~592 MB and growing. |
| Pages deployment timeout | **10 minutes** | The upload/deploy step, not the build step. Large asset counts hurt here more than page counts. |
| Pages bandwidth | **100 GB/month, soft** | Only a problem after traffic exists; note it and move on. |
| Single file size | **50 MiB warn / 100 MiB block** | Any single large asset in history. |
| Builds per hour | 10, soft, **not applicable** with a custom Actions workflow | Which is what `deploy.yml` already uses. |

**The prediction worth falsifying:** output exceeds 1 GB because the asset copy dominates. If it does, the fix is the projection step (exclude unpublished media) plus R2, both already decided, and it must be known before first publish rather than after.

### What this run retires

- **The D1 kill criterion**, empirically.
- **Q05 (incremental builds)**: with a real full-build number, either it is fine and Q05 closes, or it is not and Q05 gets a task with a budget. Either way it stops being an open question backed by nothing.
- **The vault binary/LFS check** left open in `FOCUS.md` line 29.
- **The n=1 WSL traversal** as the sole evidence for anything.

---

## Adjacent: per-PR previews (flagged, not owned here)

The moderation policy commits the maintainer to reviewing the rendered preview rather than the diff, but GitHub Pages deploys exactly one environment. The cheap fix that fits this decision set: have the PR workflow run the same projection plus Quartz build and **upload the output as a workflow artifact**. The maintainer downloads and serves it locally. Zero additional hosting, no second host, no policy exception, and it works identically for both spokes. Roughly a quarter day. A real preview host can wait for the Forgejo substrate decision.

## Related

- [The v1 architecture](/cyberbaser/research/v1-architecture/) - rows superseded here: translation layer (line 41), SEO/permalink (lines 50, 131), filename lint (line 130)
- [Assumptions and risks](/cyberbaser/research/assumptions-and-risks/#tested-quartz-prior-art-audit-2026-06-19) - the Quartz audit this decision acts on
- [Architecture](/cyberbaser/design/architecture/) - the boundary table (lines 249-253) that D1 makes executable
- [Open Questions](/cyberbaser/reference/open-questions/) - Q02 closed as not-applicable, Q06 answered, Q05 pending one measurement
- [Primitives, Stable URLs](/cyberbaser/concepts/primitives/#stable-urls) - line 349 still says "open question for now"; D2 replaces it
- External: [Quartz `sluggify`](https://github.com/jackyzha0/quartz/blob/v4/quartz/util/path.ts) · [Quartz `AliasRedirects`](https://github.com/jackyzha0/quartz/blob/v4/quartz/plugins/emitters/aliases.ts) · [Astro static redirects](https://docs.astro.build/en/guides/routing/) · [GitHub Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits) · [GitHub large file limits](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github)

---

## Task list

Sequenced. Everything before T7 must land **before first publish**, because after first publish the filename and URL decisions become permanent.

| # | Task | Days | Depends on | Output |
|---|---|---|---|---|
| **T1** | Move the build checkout to ext4. Shallow-clone `cybersader/cyberbase` to `~/bench/cyberbase`; leave the authoring vault on the Windows side. Time `git clone` and a full `find` traversal on both filesystems; record the 9p penalty ratio. | 0.5 | - | One number, permanently reusable |
| **T2** | Run the census scripts: file census, binary/LFS census (working tree + full history), path census (unsafe chars, emoji by segment type, NFC, case-only dupes, **slug collisions**, path-qualified wikilinks). | 0.5 | T1 | `census.md`: the counts every later decision needs |
| **T3** | Instrumented Quartz build of the real vault. Exit code, wall time, peak RSS, warning list, unresolved wikilinks, output size and file count, on ext4 and on `/mnt/c`. Default heap and 8 GB heap. | 0.5 | T1 | `build-report.md` + the D1 verdict |
| **T4** | Score the 20-item OFM checklist by grep over the built HTML. Apply the D1 kill criterion and write the verdict down. | 0.25 | T3 | Renderer decision, closed |
| **T5** | Record the decisions. Log D1/D2/D3 in `.claude/41-QUESTIONS-RESOLVED.md` as R09/R10/R11 (renumber as the orchestrator sees fit). Close Q02 as not-applicable and Q06 as answered in `reference/open-questions.mdx`. Update `primitives.mdx` line 349. Correct `v1-architecture.mdx` lines 41, 50, 119, 130, 131. Retarget Phase 1 in `.claude/20-ROADMAP.md` lines 43-44 to the reverse direction only. | 0.5 | T4 | Orientation layer no longer points the wrong way |
| **T6** | Write the URL contract and its conformance test: a fixture list of vault paths to expected slugs, asserted against whatever built the site. ~50 lines. | 0.5 | T4 | The boundary, made executable |
| **T7** | Build the projection step: vault to `content/`, lowercase path segments, inject natural-case aliases, run the safety lint, fail on slug collisions, hook for path exclusion. | 1.0 | T2, T6 | The one place renderer workarounds are allowed to live |
| **T8** | Rename the D3 offenders: emoji and unsafe characters out of directory names first (free), then the small set of file basenames, inside Obsidian with link updating on. Re-run T2 to confirm zero violations. | 0.5-1.0 | T2, T7 | Vault passes the safety lint |
| **T9** | Add the hub dependency-direction CI check (hub packages must not depend on any renderer package). Five lines. | 0.25 | T6 | Coupling fails loudly |
| **T10** | Declare the URL-freeze date, snapshot the slug set, and turn on the CI slug-diff gate (fail if a slug vanishes without an alias covering it). | 0.5 | T7, T8 | URL stability becomes mechanical, not disciplinary |
| **T11** | PR-preview artifact workflow: run projection plus build on PRs, upload output as a workflow artifact. | 0.25 | T7 | The moderation policy becomes satisfiable |
| **T12** | Act on the size finding: if output exceeds 1 GB or binary weight exceeds 300 MB, move media to R2 via the projection step's exclusion hook. Re-measure. | 0.5-1.5 | T3, T7 | Under the Pages cap, verified |

**Total: 5.75 to 7.25 maintainer-days**, of which T1 through T4 (1.75 days) retire three open questions and can be done in a single weekend.

**Do first, do not skip:** T1. Every measurement taken before the tree moves to ext4 has to be taken again.

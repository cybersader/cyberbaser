---
title: "The write path and how it is enforced"
description: "Kill the CMS bake-off, ship the hub's own editor on the proven serializer, and turn the round-trip from a demo into a required CI check. Plus the Notion third-writer problem and the stale-PR UX."
sidebar:
  order: 14
status: research
tags: [design, translation-layer, contribution, cms, testing]
---

:::caution[Proposal, not a decision]
One of several competing v1 designs from the adversarial design pass of 2026-07-25. Nothing on this page is locked. The deciding gate is the corpus round-trip measurement described in [the v1 build plan](/cyberbaser/research/v1-build-plan/), which also maps how the competing shapes differ.
:::

The read path is a commodity. Quartz already wins it ([Quartz audit](/cyberbaser/research/assumptions-and-risks/#tested-quartz-prior-art-audit-2026-06-19)), and the [architecture](/cyberbaser/design/architecture/) already demotes the renderer to a swappable spoke. Everything cyberbaser is actually for lives on the **write path**: the bytes that go back into the vault after somebody edits on the web.

This page decides five things about that path, in the order they block each other:

1. Whether a third-party CMS is allowed to touch vault bytes at all (**no**), and what ships instead.
2. Which of two docs pages is right about the Decap editing surface (**`research/v1-architecture.mdx` is right; `design/contribution-workflows.mdx` is wrong and must change**).
3. The byte-fidelity kill test that runs *before* any deeper evaluation of anything.
4. The round-trip CI gate that turns [Principle 2](/cyberbaser/getting-started/principles/#2-obsidian-semantics-must-round-trip) from an aspiration into an enforced property. This resolves [Q04](/cyberbaser/reference/open-questions/#q04--how-do-we-guarantee-no-lossy-round-trip-in-practice) and is the project's **first shippable artifact**.
5. The Notion leg: an uncontrolled third writer into the SSOT that the 20/21 proof never modeled, plus the stale-base UX for contributors who do not know git.

---

## 1. The CMS question, resolved: adopt none

### The rule that decides it

The [architecture boundaries table](/cyberbaser/design/architecture/#boundaries-what-each-part-must-not-do) says the hub must not "apply lossy transforms" and must not "hold content state outside the commit it produces." Those two rows are not style guidance. They are the product. Read literally, they say: **no component in the write path may parse the file into a model it owns and re-emit it**, because the re-emission is where the file stops being the user's file.

Every git-backed CMS in the finalist list does exactly that. The evidence is already in the repo, in `research/v1-architecture.mdx` lines 64-66:

- **Decap** — "*both* its markdown and new richtext widgets round-trip through `remark@10` and write a raw markdown string; **neither is inherently safe passthrough**." The markdown widget was deprecated in April 2026, so `widget: richtext, modes: ["raw"]` is the only remaining surface, and that surface still runs the file through remark on save.
- **Sveltia** — Lexical-based, "a known serializer bug escapes asterisks globally on any save." A global escape rewrite is the worst possible failure mode here: it corrupts the whole file, not one construct, which also destroys the diff that moderation depends on.
- **TinaCMS** — Plate/Slate AST, hard-disqualified; a 2026 bug means even standard bold and italic fail to write to disk.
- **EmDash** — stores content as portable text, "structured JSON, not HTML" ([challenge 02](/cyberbaser/agent-context/zz-challenges/02-cms-evaluation/), line 23). That is the same disqualification as Tina, one level more explicit: the content model is not the file. A JSON-native CMS over a markdown SSOT means the markdown is an export format, which inverts [Principle 5](/cyberbaser/getting-started/principles/) (the vault is primary).
- **Pages CMS** — the least-bad of the group and the one the v1 stack table currently picks, but it is GitHub-backend-only, single-maintainer, and last released June 2025. It also does not escape the structural problem, only softens it.

So the planned 3-way bake-off (Decap vs Sveltia vs EmDash, `FOCUS.md` line 31) is measuring feature matrices for candidates that are already eliminated by a boundary rule the project wrote down first. The critics are right about that.

### What "raw mode" actually buys, and what it costs

The counter-argument is: force raw mode and the serializer never runs. That is half true. In raw mode the CMS is an authenticated textarea over a git commit. What you are actually buying, then, is not an editor. It is four pieces of plumbing:

1. OAuth against the forge, and the token never reaching the browser.
2. Fork-and-PR mechanics for a contributor without repo write access.
3. A file browser and a collection schema so a contributor can find a page.
4. A commit-message and submit flow.

Those four are real work and are the honest case for adopting something. But they come attached to a fifth thing you cannot decline: **a dependency you do not control sitting at the exact center of the moat**, whose upgrade cadence you must re-qualify with a byte test on every bump, and which is maintenance-stagnant with an unpatched Sept-2025 XSS (`v1-architecture.mdx` line 99).

### The two options, priced

Solo part-time maintainer, days of focused work.

| | Adopt Decap in forced raw mode | Ship the hub's CM6 editor |
|---|---|---|
| CMS config, collections, raw widget | 1.0 | — |
| OAuth proxy: build + host + secret handling ([Q07](/cyberbaser/reference/open-questions/#q07--how-does-the-oauth-proxy-for-decap-get-hosted), still unowned) | 1.5 | 1.5 (same cost, same code, either way) |
| Open-authoring fork/PR wiring | 0.5 | 1.0 |
| Editor surface | 0 (inherited) | 2.0 (CM6 + OFM highlighting + read-only preview pane) |
| Serializer library | 0 (inherited, and it is the wrong one) | 2.0 (`@cyberbaser/ofm`, needed anyway for the CI gate) |
| Byte-fidelity qualification | 0.5, **repeated on every upgrade** | 0.5, once, then it is your own test suite |
| **First ship** | **3.5** | **7.0** |
| Recurring cost | re-qualify per release; inherit CVEs; widget deprecations (the markdown widget already died once) | your own regression suite |
| Failure mode | a silent escape rewrite corrupts the vault and you find out from a reader | a test goes red in CI |

The gap is **3.5 days**. What those 3.5 days buy is ownership of the one component that is the entire differentiation. And the accounting is generous to Decap, because 2.0 of the CM6 column (the serializer library) is **not optional under either choice**: the CI gate in section 4 needs that library regardless. Netting it out, the real gap is **1.5 days**.

### Decision

**Adopt no CMS. Ship the hub's own CodeMirror 6 editor on the packaged spike serializer.** Sequenced in three steps so that nothing is built before it is needed:

- **Now, 0 days: Path C is the web edit path.** "Edit this page on GitHub" already exists, already gives any GitHub user a raw editor with automatic fork and PR, and is byte-safe by construction because no AST is involved anywhere. It passes the kill test in section 3 trivially. Under [R08](/cyberbaser/getting-started/roadmap/) the maintainer is user #1, and for user #1 this is a complete web edit path today.
- **Next, 2 days: package the serializer** (section 4). It is the CI gate, and it is also the editor's engine. It ships value on its own.
- **When triggered, +5 days: the CM6 widget.** Triggers, either one: (a) a real non-git contributor is blocked by the GitHub UI, or (b) the maintainer's own dogfood friction on mobile becomes a recurring complaint. Not before. Building an editor for contributors who do not exist yet is exactly the mistake the critics identified elsewhere in the plan.

**Runner-up: Decap in forced raw mode**, as the explicit fallback if the CM6 widget overruns 10 days. It is the fallback and not the pick because its serializer is not passthrough, its maintenance is stagnant, and its editing surface in raw mode is a textarea, so the thing you are paying a dependency for is plumbing you can write in 2 days.

**Rejected: Sveltia** (global asterisk escaping is a whole-file rewrite, and whole-file rewrites break moderation review, not just fidelity), **TinaCMS** and **EmDash** (both own a content model that is not the file, which is a Principle 5 violation, not a bug to be fixed).

### What this does to the roadmap

- `FOCUS.md` line 31, "CMS finalists hands-on (Decap vs Sveltia vs EmDash)": replace with the kill test in section 3, scoped to 0.5 days total, not a bake-off.
- The v1 stack table in `research/v1-architecture.mdx` line 42, "Pages CMS (invited editors) + Decap open-authoring", becomes "hub-owned CM6 widget; GitHub web editor is the interim path; no third-party CMS in the write path."
- Roadmap Phase 2 "implement ≥2 of 3 paths" narrows to one built web path, because Path C already works and Path B is a git clone.

### The spike stops being an island

`spikes/ofm-roundtrip/` currently has no consumer and no integration task. It proved a thesis and then sat there. Sections 3 and 4 give it two: it becomes the **library that the CI gate runs** and the **engine the editor writes through**. That is the fix. The concrete first move is turning `roundtrip.mjs` into a published module with a CLI, priced at 2 days in the task list.

---

## 2. The contradiction, resolved

Two pages currently disagree about the same component.

**`design/contribution-workflows.mdx` line 20:**

> "**Editor**: Decap renders the page's markdown in a rich editor (not raw). Tier 1 features (wikilinks, callouts) render as interactive widgets; Tier 2/3 render read-only"

**`research/v1-architecture.mdx` line 65:**

> "Decap — *both* its markdown and new richtext widgets round-trip through `remark@10` and write a raw markdown string; **neither is inherently safe passthrough** ... Wikilinks can be read as link text, callouts flattened to blockquotes."

One page promises interactive wikilink and callout widgets. The other proves that the code path which would render them is the code path that flattens callouts to blockquotes. `contribution-workflows.mdx` is dated April 2026 and predates the June research run and the June spike; `v1-architecture.mdx` carries the evidence and the corrections from six skeptical verifiers.

**`v1-architecture.mdx` is right. `contribution-workflows.mdx` line 20 is wrong and is the more dangerous of the two, because it is on the design page a fresh agent reads when implementing Path A.**

### The reconciliation that keeps the good part of the UX

The contradiction is not purely a mistake. It is the collision of a real UX requirement with a real safety constraint, and there is a resolution that satisfies both: **separate the editing surface from the preview surface.**

- **The editing surface is raw text, always.** Bytes in, bytes out, no AST. Syntax highlighting is allowed (it colors, it does not rewrite). This is what CM6 is for, and it is why CM6 rather than a block editor: the file is always the markdown, which mirrors Obsidian's own architecture (`v1-architecture.mdx` line 85).
- **The preview surface is rendered, read-only, and one-way.** `markdown → HTML` through the *same* pipeline the site uses. It never writes back, so it cannot corrupt anything. Wikilinks, callouts, embeds, math and Mermaid can all render richly in the preview pane, which is where the contributor actually wanted to see them.

That gives the contributor the confidence of seeing a real callout render, without ever handing the bytes to something that will re-emit them. It also resolves [Q03](/cyberbaser/reference/open-questions/#q03--should-the-web-cms-show-rendered-obsidian-preview-or-raw-markdown) ("rendered preview or raw markdown?") as **both, on different sides of a one-way boundary** rather than as a choice.

### Exact text changes

**`design/contribution-workflows.mdx`, replace lines 12-14** (heading and target-user paragraph):

> ## Path A: Web edit (the hub's own editor)
>
> **Target user:** domain expert, zero git knowledge. Until the hub's editor ships, this path is served by the GitHub web editor (Path C), which requires a GitHub account. That account is a trust signal, not a wall: contribution overall is gated by the maintainer's trust curve and a moderation queue, and a no-account path (a serverless contribution bot) is tracked separately.

**Replace line 20** (the flow step):

> 3. **Editor**: the page's markdown opens in a raw-text editor with Obsidian-syntax highlighting. The editing surface is always the literal file; nothing re-serializes it. Alongside it, a read-only preview pane renders the page through the same pipeline the site uses, so wikilinks, callouts, embeds and math appear as they will publish. The preview never writes back, which is what makes rich rendering safe here.

**Replace line 22 and line 23** (submit and behind-the-scenes), since the fork mechanics are no longer Decap's:

> 5. **Submit**: contributor writes a one-line summary and clicks Submit.
> 6. **Behind the scenes**: the change is committed to a branch and opened as a PR against the vault, carrying the base commit the editor read the file at (see [stale bases](#the-stale-base-problem)). On the GitHub path this is a fork-and-PR; on the [self-hosted Forgejo path](/cyberbaser/design/reference-architectures/self-hosted-forgejo-auth/) it is the same shape without an OAuth proxy.

**Replace the third open question, line 37:**

> - How does the editor surface Tier 2/3 features it can't render? Answer: it does not need to. The editing surface is raw text, so every tier is editable; the preview pane degrades to a plain code block for anything it cannot render, and never rewrites it.

**Add one row to the `design/architecture.mdx` boundaries table** (line 250-255), because the boundary that decided all of this is currently only implied:

> | **Editing surface** | parse the file into a model it owns and re-emit it · introduce escaping the author did not write · normalize the whole file when one line changed |

**Update `research/v1-architecture.mdx` line 42 and line 44** so the stack table names the hub's editor rather than a CMS, and mark the CMS row resolved rather than "🔴 round-trip untested."

---

## 3. The byte-fidelity kill test

This runs **before** any deeper evaluation of any candidate, including cyberbaser's own editor. It is a gate, not a benchmark. Total budget: **2 hours, hard cap.** Thirty minutes per candidate.

### The fixture

One file, `KILLTEST.md`, committed to a scratch branch of a throwaway repo (not `cyberbase`). It is the existing 21 fixtures assembled into one realistic page, plus the nested-frontmatter case the spike does not currently cover:

````markdown
---
title: Kill test
aliases: [kt, "kill test"]
meta:
  source: manual
  reviewed: 2026-07-25
tags: [security/testing, ops]
---

A paragraph with an ordinary word to change.

See [[Some Page]], [[Some Page|the alias]], [[Some Page#A Heading]], and [[Some Page#^block-id]].

![[diagram.png]]
![[diagram.png|200]]
![[Other Note#Section]]
![[Other Note#^abc123]]

> [!note] Outer
> > [!info] Inner
> > inner body

> [!tip]- Collapsed
> Hidden body.

Energy is $E = mc^2$ and it costs $5 and $10 in cash.

$$
\int_0^\infty x\,dx
$$

```bash
grep "#FF0000" file.txt # a hex color
```

| A | B |
| - | - |
| 1 | 2 |

An inline #security/tag and a trailing line.
````

The nested frontmatter (`meta:` with children) and the quoted-alias list are added deliberately: YAML re-emission is a common silent rewriter, and a CMS that flattens `meta` or unquotes `"kill test"` has failed a case the current 21 fixtures do not cover.

### The procedure

1. Point the candidate at the scratch repo.
2. Open `KILLTEST.md` in whatever the candidate's default editing mode is. **Test the default first**, then raw mode if the default fails. A candidate that only passes in a mode nobody would choose has told you something.
3. Change one word, in the first paragraph, in a place with no markup near it.
4. Save through the candidate's normal save path.
5. `git diff --numstat` and `git diff --word-diff=porcelain`.

### Pass, soft-fail, hard-fail

**Pass:** `git diff --numstat` reports `1  1  KILLTEST.md`, and the word-diff shows exactly the one word. Nothing else in the file moved.

**Soft-fail:** the only differences fall in the pre-declared equivalence classes:
- YAML key reordering within a mapping (not semantic)
- a blank `>` line inserted between a blockquote's content and a nested blockquote (the known nested-callout reflow; Obsidian still renders it, see `spikes/ofm-roundtrip/README.md` finding 4)
- trailing-newline-at-EOF normalization

A soft-fail does not pass by default. It passes only if the maintainer explicitly ratifies each class into the written equivalence-rules file (section 4). Unratified soft-fail is a fail.

**Hard-fail, any one of these ends the evaluation:**
- Any byte changed inside `[[...]]`, `![[...]]`, `[!type]`, `$…$`, `$$…$$`, a fenced code block, or a table row.
- Any escape character introduced that the author did not write. `[[x]]` → `\[\[x]]` is the canonical case, and it is what config A through C of the spike do to 9 to 15 of the 21 fixtures.
- Any whole-file normalization: list-marker changes, emphasis-marker changes, hard-wrap or unwrap, indentation rewrites, blank-line collapsing. This is a double kill. It corrupts fidelity **and** it destroys the diff, which is the surface the moderation queue reviews. A 400-line diff for a one-word edit is unreviewable, so the trust curve stops working.
- Frontmatter structure changed: nesting flattened, quoting style rewritten, arrays reflowed to block sequences.

### Expected results, and what to do with them

Predicted from the evidence already in the repo:

| Candidate | Predicted | Basis |
|---|---|---|
| GitHub web editor (Path C) | **pass** | no AST anywhere; it is a textarea over a commit |
| Decap, richtext default | hard-fail | remark@10 escapes bracket constructs, flattens callouts (`v1-architecture.mdx` line 65) |
| Decap, forced raw | soft-fail or pass | still goes through remark on save; the empirical question is whether the raw path short-circuits it |
| Sveltia | hard-fail | global asterisk escaping is a whole-file rewrite |
| EmDash | hard-fail | portable-text JSON model; markdown is an export |
| CM6 + `@cyberbaser/ofm` | pass, except nested callouts (soft-fail, ratified) | reproduced locally: 20/21, the holdout is reflow not loss |

**If every candidate fails, that is the finding, not a crisis.** It converts an open question ("which CMS?") into a closed one ("the CMS category is disqualified from touching vault bytes"), and it is precisely the argument for building the editor. The fallback is explicitly **not** "pick the least-bad and write a mitigation doc." A textarea over git is provably byte-safe and costs less than fighting somebody else's serializer forever. Path C covers the gap at zero cost while the widget gets built.

The kill test also has a second life: it is the qualification gate for every future write-path component, including cyberbaser's own. Any change to the serializer re-runs it.

---

## 4. The round-trip CI gate (resolves Q04)

[Q04](/cyberbaser/reference/open-questions/#q04--how-do-we-guarantee-no-lossy-round-trip-in-practice) has been open since 2026-04-11, self-describes as blocking "the claim of round-trip editability in vision and principles," and is currently scheduled in **no phase of the roadmap**. The [enforcement challenge brief](/cyberbaser/agent-context/zz-challenges/translation-layer-round-trip-enforcement/) even says "probably 2-3 sessions of work once Phase R exits," which is how a load-bearing gate gets deferred indefinitely.

It should be built now, and first, because it is the cheapest thing in the plan that turns the moat from a claim into a mechanism. The spike already contains its engine.

### Step 1: package the spike as a library (2 days)

`spikes/ofm-roundtrip/roundtrip.mjs` is a 147-line script with the working logic in about 50 of them (the `mask` / `unmask` / `roundtripProtected` block, lines 40-69). Promote it to `packages/ofm/` as `@cyberbaser/ofm`, MIT (per the open-core split in `v1-architecture.mdx` line 132: MIT on the translation layer as the distribution channel).

Surface:

```
mask(src)            -> { text, store }        // OFM constructs -> inert placeholders
unmask(text, store)  -> string
parse(src)           -> mdast                  // masked parse, gfm + frontmatter + math
stringify(tree)      -> string
roundtrip(src)       -> string                 // parse . stringify, masked
check(src)           -> { ok, class, diffs }   // ok | equivalent | corrupt, with byte ranges
```

Plus a CLI: `ofm-check <paths...>`, exit 1 on `corrupt`, exit 0 on `ok` or ratified `equivalent`, machine-readable output with `--json`.

Two things the production version must fix that the spike deliberately did not:

1. **The mask token is not collision-safe.** `OFMMASK0OFMMASK` is a plain string; a document containing that literal, or a document where masking interacts with code fences, breaks. Use a private-use-area sentinel plus a counter, and assert the sentinel is absent from the input before masking.
2. **The spike normalizes trailing whitespace before comparing** (`roundtrip.mjs` line 80, `const norm = s => s.replace(/\s+$/g, '')`). The library must compare true bytes and classify the whitespace difference as an equivalence class rather than hiding it. Otherwise the gate is quietly weaker than the moat it claims to enforce.

Ship the **written equivalence rules** in the same package, one file, one rule per Tier-1 construct, in the form the enforcement brief already sketched: `[[Foo]]` vs `[[Foo|Foo]]`, `> [!note]` vs `> [!note]-` (**not** equivalent, the `-` means collapsed), YAML key order (equivalent), `![[image.png|200]]` size hints (must survive exactly), block IDs (must survive exactly, a re-key breaks inbound references). The rules file is the spec; `check()` implements it; the kill test's soft-fail list points at it.

### Step 2: the required check on every cyberbase PR (1 day + 0.25 to enforce)

A workflow in `cybersader/cyberbase`, `.github/workflows/roundtrip.yml`:

```yaml
on:
  pull_request:
    paths: ['**/*.md']
```

Steps: checkout with `fetch-depth: 0`, get the changed markdown via `git diff --name-only --diff-filter=ACM origin/${{ github.base_ref }}...HEAD -- '*.md'`, run `bunx @cyberbaser/ofm check` on that list, annotate failures inline on the diff.

**Changed files only, never the whole vault.** The vault is ~1439 files and 592 MB; a full scan per PR is minutes of CI and most of it re-checks bytes nobody touched. Add a separate weekly `schedule:` job that scans everything and opens or updates one tracking issue. The weekly job is where the legacy corpus gets characterized without ever blocking a contributor.

**Roll it out in report-only mode for two weeks.** The first full scan will find failures in files nobody has edited in a year, and blocking on those on day one teaches everyone to bypass the check. Report-only produces the initial corpus; then flip `continue-on-error` off and mark it required in branch protection.

What the check actually asserts is worth stating precisely, because it is easy to over-claim: it asserts **this file survives a round-trip through cyberbaser's serializer**, which is equivalent to **this file is safe to edit through cyberbaser's web path**. It does not prove the editor's UI is correct, and it does not prove the renderer is faithful. Those are separate tests. It does prove that no PR can introduce a construct the write path would corrupt, which is the property [Principle 2](/cyberbaser/getting-started/principles/#2-obsidian-semantics-must-round-trip) claims.

### Step 3: property-based tests, seeded from the corpus (2 days)

The spike proved achievability at 20/21 against 21 hand-written fixtures. Twenty-one fixtures is a demo, not a guarantee. The enforcement brief's "Approach B then A" ordering is right, and step 2 above is Approach B.

For Approach A, `fast-check` over an OFM grammar, with one correction to the brief's plan: **grammar-only generators produce unrealistic markdown and burn time on cases that never occur.** Seed the generators from the real corpus instead. Take real vault files, mutate them structurally (nest a callout one level deeper, move a wikilink inside a table cell, put an embed inside a list item inside a blockquote), and assert `check(mutated).class !== 'corrupt'`. Structural nesting is where the known holdout lives, so that is where the generator should spend its budget.

Do this **after** the CI gate is live, not before. The corpus is the input.

### Step 4: the fidelity-break log (0.5 days)

This is the mechanism that turns daily dogfood use into the test corpus, which is the only way the corpus grows without becoming a corpus-writing project nobody does.

**File:** `packages/ofm/breaks.jsonl` in the cyberbaser repo, append-only, one JSON object per line.

**Record:**

```json
{
  "date": "2026-07-25",
  "source": "ci | manual | killtest",
  "construct": "callout-nested-in-list",
  "snippet": "- item\n  > [!note] x\n  > body\n",
  "expected": "<bytes>",
  "actual": "<bytes>",
  "class": "corrupt | equivalent",
  "status": "open | fixtured | fixed | wontfix",
  "fixture": "callout-in-list"
}
```

**Four rules that make it work:**

1. **Snippet, never the file.** Store the minimal reproducing bytes, not the path and not the content. The vault mixes cyber reference material with journals, finance notes and resumes ([Legal & Governance](/cyberbaser/design/legal-and-governance/) line 49). A break log that quotes file content is a leak channel, and the repo it lives in is public.
2. **A break is closed only by adding a fixture.** `status: fixed` requires a `fixture` field pointing at a new entry in the fixtures file. This is the entire growth mechanism: 21 fixtures today, and every real break the maintainer hits in normal use becomes number 22, 23, 24.
3. **Logging must take under a minute.** A `bun run break` prompt in the ofm package, plus a two-field GitHub issue template. If it takes five minutes, the maintainer will fix the file in Obsidian and move on, and the corpus never grows.
4. **CI logs automatically.** The weekly full-scan job appends a deduplicated record for each distinct construct it finds failing, so the legacy vault characterizes itself.

The log is also the honest public record of where the moat leaks, which is worth more to the project's credibility than a 20/21 headline.

---

## 5. The Notion leg, and the stale-base problem

### The gap

The `cyberbase` repo description says it "utilizes Notion, Obsidian, and Github to sync content," via `cybersader/notion-to-obsidian-github-sync` ([Existing Work](/cyberbaser/reference/existing-work/) line 52). In the docs, Notion appears **only** as a competitor and an anti-pattern ([Prior Art](/cyberbaser/research/prior-art/#notion-as-a-public-wiki): "Exporting to markdown is lossy," "Obsidian incompatibility ... round-tripping is not feasible"). It appears nowhere as a **writer into the source of truth**.

So the project's own prior-art page documents that Notion export mangles the exact constructs the moat protects, and the project's own dogfood vault has that exporter wired up as a live writer. The 20/21 proof modeled two parties, web and vault. This vault has three, and the third one is a tool the docs already classify as lossy.

### The audit, 1 day

Empirical, not documentary. Do not read the sync tool's README and believe it. Read what it has actually committed.

**Setup:** clone `cybersader/cyberbase` (592 MB; on the current WSL2 `/mnt/c` working tree this is slow, so clone to native ext4 under `~/` and note the wall-clock time, since no build of this vault has ever been timed and Q05 needs the number anyway).

**Identify the writer:**

```bash
git log --format='%an <%ae>' | sort | uniq -c | sort -rn
```

The sync commits under some distinct identity, or under the maintainer's, which is itself finding #1: an unattributable third writer cannot be fenced.

**Then answer seven questions, each with a command:**

| # | Question | How |
|---|---|---|
| 1 | Does it write frontmatter, and which keys? | `git show <sync-commit> -- '*.md' \| grep -A20 '^+---'`; look for Notion page IDs, `created`/`last_edited_time` |
| 2 | Does it write timestamps that dirty every file? | count sync commits where content is unchanged but a date key moved. This is the failure `v1-architecture.mdx` line 130 explicitly warns about |
| 3 | Does it rename or coin filenames? | `git log --diff-filter=R --name-status --author=<sync>`; check for 32-hex Notion IDs, spaces, non-ASCII, case collisions |
| 4 | Does it rewrite links? | grep sync-touched files for `](` relative links vs `[[wikilinks]]`. Notion exports produce the former; if it rewrites the latter, that is direct moat damage |
| 5 | Does it touch files it did not semantically change? | `git log --author=<sync> --shortstat`; look for commits with high file counts and low line deltas. This is churn, and it is unfenceable |
| 6 | Does it delete? | `git log --diff-filter=D --name-only --author=<sync>` |
| 7 | Does it stay in its own subtree? | `git log --author=<sync> --name-only \| sort -u \| cut -d/ -f1 \| sort \| uniq -c` |

**Then run the checker over its output**, which is the whole point of building it first:

```bash
git log --author=<sync> --name-only --pretty= -- '*.md' | sort -u > /tmp/notion-touched.txt
bunx @cyberbaser/ofm check --json $(cat /tmp/notion-touched.txt)
```

That single command converts "Notion's exporter is known to mangle wikilinks and callouts" from a claim inherited from the prior-art page into a measured corruption rate on this vault's real files. If it is near zero, the fence can be loose. If it is high, the fence must be tight.

### The decision: fence it, with a cut trigger

**Fence.** Cutting is cheap to say and expensive to mean: it removes an input path the maintainer actually writes through, and under [R08](/cyberbaser/getting-started/roadmap/) the maintainer is user #1, so breaking their workflow to protect a property fails the dogfood test that justifies the whole phase.

**The fence, four parts:**

1. **Scope.** Notion writes into exactly one subtree, `sources/notion/`, declared in a writers manifest at `.cyberbaser/writers.yml`. Nothing outside that subtree is Notion's.
2. **One-way.** No cyberbaser path writes into that subtree. The web editor does not render an Edit button for files under it, and the CM6 widget refuses those paths server-side, not just in the UI.
3. **Attributable and reviewable.** The sync commits under its own bot identity, on a branch, as a PR. It gets the **same round-trip check as any human PR**. If the exporter corrupts OFM, that now shows up as a red check on a reviewable PR instead of landing silently on `main`.
4. **A promotion door.** A file leaves the fence by an explicit `git mv` out of `sources/notion/` after passing `ofm-check`. It is a one-way door: once promoted, Notion no longer owns that file, and if Notion re-exports it, the sync must skip it (a `.notionignore`-style list, or the manifest itself).

**Cut instead if the audit shows any of these**, because they cannot be fenced:

- The sync writes outside its subtree (question 7 fails).
- The sync rewrites files it did not semantically change (question 5, churn). Churn makes every PR diff untrustworthy, which breaks moderation.
- The sync deletes files (question 6). A destructive third writer into an SSOT is not a sync, it is a mirror, and mirrors overwrite.

Cutting means: freeze the last export in place, stop the job, and the exported files become ordinary vault files under the maintainer's hand. No migration needed.

### The thing the fence is actually protecting against, which is not a round-trip problem

Worth stating plainly because it is easy to miss. A Notion-exported file that someone later edits on the web is not at risk: the exporter's output is plain CommonMark, so there is no OFM in it to lose.

The real hazard runs the other direction. The maintainer enriches an exported note in Obsidian, adding `[[wikilinks]]` and callouts, and then **Notion re-exports and overwrites it**. Every enrichment is gone. That is not a serialization failure and no serializer fixes it. It is last-writer-wins on a file with two owners.

Which is why the fence, and specifically the promotion door, is the only real mitigation: a file is owned by exactly one writer at a time, and enrichment is what moves ownership. The round-trip CI check is a good detector here (it will flag the moment a file's OFM content vanishes) but detection after overwrite is a worse outcome than never allowing two owners.

This is also the shape of the general problem for any vault with more than one automated writer, so it belongs in the architecture as a **writers manifest** concept rather than as a Notion special case.

### The stale-base problem

`design/contribution-workflows.mdx` line 93 currently reads: "If both land simultaneously as open PRs, the second gets a merge conflict and must rebase." For a contributor who by definition does not know git, "must rebase" is not a workflow, it is the end of the contribution.

**Design rule: a non-git contributor never sees the word rebase and is never asked to resolve a conflict.** Conflicts belong to the maintainer, who has the context and the tools.

Four cases, in order of frequency:

1. **Base moved, this file untouched.** Roughly all of them. GitHub merges cleanly, nothing happens. **Critical repo setting:** branch protection must **not** enable "Require branches to be up to date before merging." That single checkbox forces a rebase on every PR whenever anything else lands, converting a non-problem into the problem. Cost: one setting, 5 minutes.
2. **Same file, different regions.** Git merges it. Nothing happens.
3. **Same file, overlapping lines.** A genuine conflict, and rare, because contribution volume is low and moderation turnaround is days. The maintainer sees "conflicting" in the queue and has three one-click options: apply the contributor's intent onto the current base and merge with a `Co-authored-by` trailer preserving credit; ask for a re-submit; or reject. All three are maintainer actions.
4. **Contributor re-submit, made cheap.** The editor captures the **base commit SHA** it read the file at and sends it with the submission. When the queue shows a submission whose base is stale and whose region conflicts, the contributor gets: "This page changed while you were editing. Here is what changed, and here is your edit. Re-apply?" Re-applying reopens the editor on current content with their change highlighted. This is exactly MediaWiki's edit-conflict UX, which has decades of evidence with non-technical users, and it needs no git vocabulary.

**Build now:** the branch-protection setting (5 minutes) and the base-SHA capture in the submission payload (0.25 days, folded into the widget). **Do not build now:** the re-apply UI. Spec it, and wait until the break log or the moderation queue shows a real conflict. Building conflict tooling before the first conflict is the same error as the CMS bake-off.

**Replacement text for `design/contribution-workflows.mdx` lines 90-94:**

> > [!info] Concurrent edits
> > Two contributors edit the same page at once. Almost always this is a non-event: git merges changes to different files, and different regions of the same file, without help. The repo deliberately does **not** require branches to be up to date before merging, so an unrelated commit landing first does not stall a pending contribution.
> >
> > When two edits genuinely overlap the same lines, the conflict belongs to the maintainer, not the contributor. The maintainer either applies the contributor's intent onto the current content (crediting them with a `Co-authored-by` trailer) or asks for a re-submit. Because every submission carries the commit it was based on, the queue can tell the contributor exactly what changed underneath them and let them re-apply their edit on the current page. Nobody is asked to rebase.
> >
> > There is no realtime collaborative editing, and that is fine: contribution is low-rate and async.

---

## Task list

Sequenced. Each task's exit condition is stated. Days are focused maintainer-days, solo part-time.

### Gate: the kill test (do this before anything else)

| # | Task | Days | Exit condition |
|---|---|---|---|
| T1 | Write `KILLTEST.md` (section 3) into a throwaway repo | 0.1 | file committed, all 22 constructs present |
| T2 | Run the kill test against GitHub web editor, Decap default, Decap raw, Sveltia | 0.4 | one results table with pass/soft/hard per candidate and the actual diffs pasted |
| T3 | Record the verdict and close the bake-off | 0.1 | `FOCUS.md` line 31 replaced; `41-QUESTIONS-RESOLVED.md` gets R09 "no third-party CMS in the write path" |

**Subtotal 0.6 days.** This replaces the 3-way bake-off currently on `FOCUS.md`.

### Reconcile the docs (do immediately after, same session as T3)

| # | Task | Days | Exit condition |
|---|---|---|---|
| T4 | Apply the exact edits in section 2 to `design/contribution-workflows.mdx` (lines 12-14, 20, 22-23, 37, 90-94) | 0.3 | no page claims Decap renders Tier-1 widgets |
| T5 | Add the "Editing surface" row to the `design/architecture.mdx` boundaries table | 0.1 | the rule that decided this is written down |
| T6 | Update `research/v1-architecture.mdx` stack table rows 42 and 44; resolve [Q03](/cyberbaser/reference/open-questions/#q03--should-the-web-cms-show-rendered-obsidian-preview-or-raw-markdown) as "raw editing surface, read-only rendered preview" | 0.2 | Q03 moves to the resolved log; open questions drop from 7 to 6 |

**Subtotal 0.6 days.**

### The first shippable artifact: `@cyberbaser/ofm` and the CI gate

| # | Task | Days | Exit condition |
|---|---|---|---|
| T7 | Promote `spikes/ofm-roundtrip/roundtrip.mjs` to `packages/ofm/`: library API, collision-safe sentinel, true byte comparison, `ofm-check` CLI, MIT | 2.0 | `bunx ofm-check` runs on a path list and exits non-zero on corruption; 20/21 reproduced as a unit test |
| T8 | Write the equivalence rules file (one rule per Tier-1 construct) and wire `check()` to it | 0.5 | nested-callout reflow is a ratified equivalence class, not a hidden `norm()` |
| T9 | Add `.github/workflows/roundtrip.yml` to `cybersader/cyberbase`, changed-files-only, **report-only** | 1.0 | green PRs show the check with annotations; nothing blocks yet |
| T10 | Add the weekly full-corpus scan job + tracking issue | 0.3 | one issue lists every failing construct in the legacy vault |
| T11 | Stand up the fidelity-break log: `breaks.jsonl`, `bun run break` prompt, issue template, the fixture-closes-a-break rule | 0.5 | logging a break takes under a minute; CI appends automatically |
| T12 | After two weeks of report-only: flip to required, set branch protection, **leave "require up to date" off** | 0.25 | a PR that corrupts a wikilink cannot merge |

**Subtotal 4.55 days.** At T12 the project has shipped something that enforces the moat rather than demonstrating it, and Q04 is closed.

### The Notion leg

| # | Task | Days | Exit condition |
|---|---|---|---|
| T13 | Clone `cyberbase` to native ext4, time it, answer the seven audit questions (section 5) | 0.6 | a written answer per question with the command output; clone+scan wall-clock recorded (feeds [Q05](/cyberbaser/reference/open-questions/#q05--whats-the-incremental-build-story-for-a-vault-of-thousands-of-pages)) |
| T14 | Run `ofm-check` over every file the sync has ever touched | 0.2 | a corruption rate, not an adjective. Depends on T7 |
| T15 | Decide fence vs cut against the three cut triggers, and log it as a resolved question | 0.2 | R-entry in `41-QUESTIONS-RESOLVED.md` |
| T16 | If fence: `.cyberbaser/writers.yml` manifest, move Notion output under `sources/notion/`, sync commits as a bot on a PR, promotion door documented | 1.0 | the sync's next run opens a PR that runs the round-trip check |

**Subtotal 2.0 days.** T13-T15 are the audit and the decision; T16 only runs on the fence branch.

### Stale bases

| # | Task | Days | Exit condition |
|---|---|---|---|
| T17 | Turn off "require branches to be up to date" on `cyberbase`; verify a pending PR survives an unrelated merge | 0.1 | verified, not assumed |

**Subtotal 0.1 days.**

### Deferred until triggered

These are specced, not scheduled. Trigger stated for each.

| # | Task | Days | Trigger |
|---|---|---|---|
| T18 | Property-based tests seeded by mutating real corpus files | 2.0 | after T12; the corpus must exist first |
| T19 | CM6 editor component: raw editing surface, OFM highlighting, read-only preview pane through the site pipeline | 2.0 | a real non-git contributor is blocked, **or** the maintainer's mobile dogfood friction recurs |
| T20 | "Suggest edit" wiring: fetch raw file, open editor, capture base SHA, submit | 1.0 | with T19 |
| T21 | Write-back endpoint (fork+PR on GitHub; direct PKCE on the [Forgejo path](/cyberbaser/design/reference-architectures/self-hosted-forgejo-auth/), no proxy) | 2.0 | with T19; resolves [Q07](/cyberbaser/reference/open-questions/#q07--how-does-the-oauth-proxy-for-decap-get-hosted) |
| T22 | Stale-base re-apply UI | 0.5 | the first real conflict appears in the queue |
| T23 | Embed serializer and spacing-preserving blockquote stringify (the 21st fixture) | 1.5 | the break log shows nested callouts costing real edits |

**Deferred subtotal 9.0 days.**

### Totals

- **Committed now: 7.85 days**, which ends with the round-trip gate required on every cyberbase PR, the docs contradiction gone, the CMS question closed, and the Notion writer fenced or cut on evidence.
- **Deferred behind stated triggers: 9.0 days**, mostly the editor, which does not need to exist until somebody is blocked without it.

## Related

- [Translation layer](/cyberbaser/design/translation-layer/) — the tier list this enforces
- [Contribution workflows](/cyberbaser/design/contribution-workflows/) — the page section 2 corrects
- [The v1 architecture](/cyberbaser/research/v1-architecture/) — the evidence for the CMS verdict
- [Round-trip enforcement challenge](/cyberbaser/agent-context/zz-challenges/translation-layer-round-trip-enforcement/) — the Q04 brief this closes
- [Legal & Governance](/cyberbaser/design/legal-and-governance/) — why the break log stores snippets, not files
- [Principle 2](/cyberbaser/getting-started/principles/#2-obsidian-semantics-must-round-trip) — the principle the CI gate makes real

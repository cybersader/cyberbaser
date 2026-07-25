---
title: "The case against the convergent verdict"
description: "A dissent against the four-critic consensus on cyberbaser v1: where forge-as-hub, dogfood-first, Quartz adoption, and the three cuts are wrong, how strongly, and what changes."
sidebar:
  label: "Dissent: case against"
  order: 15
status: research
tags: [research, planning, architecture]
---

:::caution[Proposal, not a decision]
One of several competing v1 designs from the adversarial design pass of 2026-07-25. Nothing on this page is locked. The deciding gate is the corpus round-trip measurement described in [the v1 build plan](/cyberbaser/research/v1-build-plan/), which also maps how the competing shapes differ.
:::

Four critics read the same dossier and agreed. That is worth less than it looks. Unanimity across agents reading one corpus measures the corpus, not the world, and the corpus here is a docs site the project wrote about itself. This page argues the other side as hard as it can honestly be argued, then says where the argument actually lands.

Two ground rules for reading it. First, every steelman below is labelled with a verdict (WINS, PARTIALLY WINS, LOSES) and I say plainly where I am arguing a position I do not hold. Second, the critics are quoted as they wrote it, not as it is convenient to have them write it.

## New evidence the critics did not have

Before the four arguments, one measurement, because three of them lean on it.

The convergent verdict treats the lossless Obsidian-Flavored-Markdown round-trip as settled and central. `research/v1-architecture.mdx` line 31 calls it "**the value moat**." `41-QUESTIONS-RESOLVED.md` R05 (lines 31-35) marks it empirically resolved at 20/21. Nobody asked how much OFM the dogfood vault actually contains.

Against a local checkout of the vault (`$VAULT` below), counting:

```bash
cd "$VAULT"
find . -name "*.md" -not -path "./.git/*" | wc -l          # 1445
grep -rl "\[\["      --include="*.md" . | wc -l            # 158
grep -rl "> \[!"     --include="*.md" . | wc -l            #  86
grep -rl "^|"        --include="*.md" . | wc -l            #  63
grep -rl '^```dataview' --include="*.md" . | wc -l         #  13
grep -rlE "^<(div|img|br|details|iframe|span)" --include="*.md" . | wc -l  # 9
grep -rl "!\[\["     --include="*.md" . | wc -l            #   4
grep -rl '\$\$'      --include="*.md" . | wc -l            #   2
```

| Construct | Files | Share of 1445 |
|---|---:|---:|
| `[[wikilinks]]` (any) | 158 | 10.9% |
| `> [!callouts]` | 86 | 6.0% |
| Tables | 63 | 4.4% |
| Dataview blocks | 13 | 0.9% |
| Raw HTML at line start | 9 | 0.6% |
| `![[embeds]]` | 4 | 0.28% |
| `$$math$$` | 2 | 0.14% |

Caveats, stated up front so the number is usable rather than rhetorical. These are file-presence counts, not density; one wikilink is enough to corrupt a file, so 158 is the population at risk, not a measure of importance. `grep "\[\["` also matches inside code fences, so it is an upper bound on genuine wikilinks. The table and HTML greps are line-anchored and therefore undercount. And this is one vault.

Even with all of that, the shape is not close. **Roughly 80 to 85% of the maintainer's own vault is plain markdown that no Obsidian-flavored parser would treat differently from CommonMark.** The constructs the keystone spike was built around, embeds and math, appear in six files combined out of 1445. `spikes/ofm-roundtrip/` has 21 fixtures, four of which target `![[embeds]]`; the real corpus has four *files* that use them.

This does not mean the round-trip is unnecessary. It means the round-trip is a **correctness floor**, not a moat, and the plan currently spends its identity, its keystone, its editor choice, and its CMS kill criterion on treating it as a moat. Hold that thought; it changes the answer to three of the four questions below.

## 1. The forge is already the hub

### What the critics said

> "The forge is already ~80% of the hub. PRs = moderation queue; branch protection + CODEOWNERS + auto-merge = trust curve; merge = write-back; git history = attribution. `contribution-workflows.mdx` already specs it that way (trust via `.github/trusted-contributors.yml`). v1 is glue + one library, not a platform. The only things the forge does NOT provide: the lossless serializer, a static edit widget, and one anonymous write-back endpoint."

That is a fair reading of `design/contribution-workflows.mdx`, which really does spec trust as a YAML file at line 106 and really does hand review to PR mechanics in the table at lines 98-104. As a *scope* claim about v1 it is largely right, and I will concede that at the end.

### The steelman

**The arithmetic is measuring the wrong thing.** The three items the critics list as missing (serializer, edit widget, write-back endpoint) are not a remainder. They are the entire user-visible product plus the only component that needs a runtime. The forge supplies storage, diff, merge, and history: infrastructure, and commodity infrastructure at that. "The forge is 80% of the hub" counts mechanisms, not work or differentiation. On the same measure, Postgres is 80% of Wikipedia.

**It answers the plan's biggest open question by accident.** `design/architecture.mdx` line 262 still lists "**Where does the hub runtime live?**" as open, on the page that declares the hub the product. "The forge is the hub" resolves that question silently, with the answer "GitHub." That is the highest-consequence decision in the plan and it is being made as a side effect of a scoping argument rather than on its own merits.

**It hard-couples to one forge's semantics, against a locked constraint.** `FOCUS.md` line 14 makes **self-hosted Forgejo preferred**, and RA-01 exists because PKCE against Forgejo's OIDC deletes the OAuth proxy entirely. If governance is expressed as GitHub Actions plus GitHub API calls plus `.github/`-namespaced config, then the Forgejo move is a rewrite of the governance layer, not a remote change. The fork API, the auto-merge semantics, the CODEOWNERS behavior, and the bot-permission model all differ. The critics' own advice to "DEFER: stand up the Forgejo mirror now" makes this worse: defer the mirror *and* encode governance in GitHub primitives, and the preferred substrate quietly becomes unreachable.

**A PR queue is a git artifact carrying a git mental model, so Principle 3 becomes a claim the architecture cannot keep.** `getting-started/principles.mdx` line 89 states the rule ("Contributors shouldn't need to learn git") and explicitly rules out "Merge conflict resolution that requires a terminal." `design/contribution-workflows.mdx` line 31 goes further: the contributor "should never see the word 'fork'." Then lines 92-94 concede the failure directly:

> "If both land simultaneously as open PRs, the second gets a merge conflict and must rebase."

Combine that with the written moderation SLA at line 112 ("aims to act within a few days") and the failure is not exotic, it is the median case. A contributor edits a page, the maintainer reviews four days later, `main` has moved, and the forge's answer to "what now" is a git UI saying rebase. A hub's answer would be to re-apply the edit against current head and show the maintainer a three-way text merge inside the review card. That capability does not exist in any forge, and it is the difference between a promise and a slogan.

**The forge cannot express a trust curve. It can express permissions plus bot glue, which is a different object.** The dial in `concepts/problem.mdx` lines 121-137 is a continuum: "anonymous edits queued; email / verified get faster review; long-trusted edit directly." A curve is a function from (contributor history, change class, blast radius) to (review depth, auto-merge, rate limit). The forge offers repo roles (coarse, per-person, and requiring an account **on that forge**), branch protection (per-branch, not per-path-per-person), CODEOWNERS (which per `research/source-of-truth.mdx` line 44 "routes review, not read access"), and auto-merge (which needs an approving review or a bot with write access).

To get the dial you write a bot that holds state: how many merged edits this person has, what class of change this is, whether it touches the personal folders. **That state is the hub.** Once written, "the forge is the hub" has silently become "the hub is a bot that uses the forge as a queue," which is a perfectly good architecture and a completely different claim. The cost of the confusion is that the interesting design question, *what is the trust state model*, never got asked, because the critics recorded it as already solved.

There is a sharper version. R03 (`41-QUESTIONS-RESOLVED.md` lines 19-23) says accounts are never forced and "an account is a trust signal, not a wall." A forge has no representation for "anonymous contributor #7, three merged edits, no account." So forge-native trust is definitionally scoped to the exact population the contribution model says not to require. The curve and the substrate are pointed in opposite directions.

**It forecloses the two v2+ pillars, which the project's own research already established as unfixable inside git.** `research/source-of-truth.mdx` scores sub-repo access control 0/2 (line 44) and federation/discovery 0/2 (line 48), then line 56: "Git's two weakest scores are the exact two capabilities the v2+ vision needs most." Line 188 records that the git-native mixed-privacy workaround, one repo per access tier, "**shatters the single-vault invariant**." The recommendation at line 221 is explicit: mixed-privacy and federation are "deferred capabilities to be solved by a layer **in front of** git."

If the forge is the hub, there is no layer in front of git. There is nowhere to put the maintainer's new requirement:

> "if you want a role-based access system, that should be possible with the wiki system; and if you want something as simple as 'here's a private page for me, here's the public side' ... that should be possible as well in our architectures."

The forge-native answer to that is "second repo," which the research already ruled out. This is not a v2 problem the maintainer can postpone, because it is live *today*: `design/legal-and-governance.mdx` line 49 records that the vault "mixes cyber reference material with journals, finance notes, and resumes," and the only written mitigation is a license carve-out, which is prose, not access control.

**So: what is the product?** If the forge is the hub, cyberbaser v1 is a masking function (about ten lines, per pipeline D in `spikes/ofm-roundtrip/README.md`), an edit widget, a write-back endpoint, and some YAML. `research/assumptions-and-risks.mdx` line 57 names the moat as "turning a browser edit back into a clean, Obsidian-valid vault file **under maintainer control**." Outsource "under maintainer control" to GitHub and the moat is the masking function. Add the census above, where 80 to 85% of files carry no OFM at all, and the masking function is protecting a minority of a single vault.

### Where the steelman is weakest

For a solo part-time maintainer with zero external contributors today, building a governance runtime is exactly the platform-before-users mistake. The forge genuinely gives a working queue, working attribution, working auth, and zero ops cost on day one. No server to secure, no state to back up, no 3am page. The critics are right that v1 should *use* the forge hard. They are wrong that v1 should *be* the forge, and the gap between those is one page of writing, not one quarter of engineering.

### Verdict: PARTIALLY WINS

The scoping claim survives. The architectural claim does not. The fix is a boundary, not a build, and it is close to free.

**Concrete changes:**

1. Write a one-page **hub contract** naming the five operations the hub owns: `accept-edit`, `classify-trust`, `route-decision`, `write-back`, `publish-manifest`. The forge is adapter #1 for four of them. Nothing about v1's code changes; what changes is that a later Forgejo or federation move is an adapter swap rather than a rewrite. **1 day.**
2. Move trust state out of the forge namespace: `.github/trusted-contributors.yml` becomes `.cyberbaser/trust.yml`, living with the content, versioned with the content, readable by any adapter. **0.25 day.**
3. Strike the phrase "the forge is 80% of the hub" from the plan and replace it with "the forge is v1's substrate for four of the hub's five operations, and provides zero of the fifth." The fifth is `publish-manifest`, which is where mixed-privacy will land.
4. Record the conflict-reapply gap explicitly as a known Principle 3 violation in v1 with a named owner, rather than leaving it buried at `contribution-workflows.mdx` line 93. Do not build it in v1. Do not pretend it is not there.

## 2. Dogfood-first (R08) is a trap

### What the locked decision says

R08, `41-QUESTIONS-RESOLVED.md` lines 49-53: external demand validation is not required, "the maintainer is user #1 and will use it regardless. Dogfooding is the v1 validation." The critics extend it to kill work that "serve[s] contributors who do not exist."

### The steelman

**The dogfood corpus is atypical in exactly the dimensions that will shape the code.** 592 MB across roughly 1445 markdown files means the mass is binary, so the first real engineering wall is LFS and asset handling. That is a hosting problem, not an interoperability problem, and the weeks it eats generalize to nobody. The repo's own description says the vault "Utilizes Notion, Obsidian, and Github to sync content," so the second wall is a Notion normalizer: zero generality, and per the briefing an uncontrolled third writer into the SSOT that the 20/21 proof never modeled. The third wall is the personal content, and the natural dogfood fix for that is an ignore-list, which solves the maintainer's problem completely and the maintainer's *stated requirement* (role-based, per-page public and private) not at all.

**Dogfooding exercises the publish direction, which the project already ruled a commodity, and starves the contribution direction, which it declared the moat.** The maintainer as user #1 is a vault owner, not a contributor. Daily: build the site, look at it, fix rendering. Never: the zero-account web edit, a stranger in the moderation queue, the trust curve advancing someone from anonymous to trusted, two contributors colliding on one page. `research/assumptions-and-risks.mdx` line 36 is unambiguous that publishing is "commoditized" and that "only the **reverse** (web-edit → clean vault) is novel." So R08, as operationalized, points the maintainer's entire feedback loop at the commodity half. That is the precise defect: R08 removed a gate without replacing it with a *usage* that touches the thing being validated.

The census above sharpens this into something worse. The maintainer's vault is 80 to 85% plain markdown. Dogfooding it will not stress the round-trip either. The maintainer will not *feel* the moat, because their own files barely exercise it, and unfelt features do not get built well.

**"General, not cyber" is a stated intention with no mechanism, and the drift is already documented.** `PROJECT_CONTEXT.md` line 14 locks it. `research/assumptions-and-risks.mdx` lines 17-19 already records the symptom: "The red-team agents kept framing the audience as 'cybersecurity practitioners' (the `cyberbase` vault name biases them)." That is identity erosion from agents merely *reading* the repo. A year of *building against one vault* has a much steeper gradient, and there is currently no artifact anywhere in the repo that would fail if the tool only worked on cyberbase.

**What v1 looks like with generality taken seriously from day one.** Not "find external users." Two corpora, from the first commit. Every hub capability must run against `cybersader/cyberbase` **and** a structurally different second corpus that is text-heavy rather than binary-heavy, not authored in Obsidian, and not maintainer-owned. The cheapest candidate is already in this repo: `docs/src/content/docs/`, 45 files of MDX with components, frontmatter contracts, and a tag registry, which is about as unlike cyberbase as a markdown corpus gets. A public digital garden or a handbook repo works too. Wiring a second corpus path into an existing harness is hours, and any hardcoded assumption dies on contact.

The second lever is already built: `spikes/ofm-roundtrip/fixtures.mjs` is vault-independent by construction. Generality is enforced by keeping the fixtures as the specification and the vault as the smoke test, never the reverse.

### Where the steelman is weakest

R08 does not say "build only for me," it says "do not wait for strangers before building." Those are different, and the alternative has an unbounded failure mode: waiting for external demand means never shipping, and the maintainer is a real user with a real 1445-file problem. Sequencing-wise R08 is correct. The trap is in the *shaping*, and shaping is cheap to constrain.

### Verdict: PARTIALLY WINS

Keep R08. Add a generality guard that costs under a day, and refuse two specific vault-shaped rabbit holes.

**Concrete changes:**

1. **Two-corpus rule**, written into the plan as a hard gate: no hub capability is done until it runs against corpus A (cyberbase) and corpus B (non-Obsidian, not maintainer-owned). **0.5 day to wire; then free forever.**
2. **De-scope the 592 MB.** v1 publishes text; assets over a size threshold are excluded by the publish manifest rather than solved. LFS is not a v1 problem, it is a hosting problem wearing a v1 costume. **0 days, it is a decision.**
3. **Notion is a lint, not a feature.** One CI check that flags files whose syntax was mangled by an export, run against the vault. No importer, no normalizer, no round-trip guarantee for a third writer nobody has modeled. **0.5 day.**
4. **Make the first governance primitive an allow-list, not an ignore-list.** A publish manifest ("these paths are public") costs the same to build as `.publishignore` and is the same object that later carries per-page and per-role visibility. An ignore-list is a dead end that will feel finished. This is the single highest-leverage day in the whole plan, because it is where the maintainer's 2026-07-02 requirement and the personal-content risk meet. **1 day.**

## 3. Adopting Quartz is wrong

### What the critics said

> "The Quartz-adoption fork is unresolved and everything downstream assumes an answer. `research/assumptions-and-risks.mdx` says Quartz v5 beats the Starlight prototype on OFM fidelity for free, and calls it 'worth a spike' -- a spike that was never scheduled."

To be fair to them: they demanded the fork be *resolved*, they did not say "adopt." The steelman here is against the answer everyone is assuming.

### The steelman

**It buys a commodity and pays with a coupling, at the one layer where the coupling matters.** `design/architecture.mdx` line 253 states the boundary: the hub must not "be coupled to a specific renderer." Quartz is not a library you call, it is an opinionated pipeline with its own transformer chain and content model. Adopt it and the *parse* of OFM lives in Quartz's transformers. But parse is not renderer-side work in this architecture: the round-trip requires that the same understanding of `![[note#^id]]` exists on the write path. If read-path semantics are Quartz's and write-path semantics are `mdast-util-to-markdown` plus the masking layer, you maintain two OFM dialects and the round-trip's correctness is defined by their agreement, which nothing tests. `research/v1-architecture.mdx` line 86 already warns about exactly this failure for editors ("Tiptap's markdown extension (MarkedJS-based, *not* `mdast`) diverges from the serialization foundation"). The same warning applies to the renderer, where nobody is currently looking.

**"Renderer-agnostic" is untestable with exactly one renderer, and the plan is contemplating swapping one single renderer for another single renderer.** N stays 1 either way and the constraint stays decorative. The critics are right that "any v1 renderer-adapter abstraction" should be killed, since agnosticism is a boundary rather than code. But a boundary that is never crossed is indistinguishable from no boundary. The discipline that makes it real is cheap: the hub emits a defined artifact (clean `.md` plus a manifest) and **two** renderers consume it, even if the second is a fifty-line static dump.

**The migration cost is real and nobody priced it.** `FOCUS.md` line 21: the Starlight prototype is ~81 pages with 77 Playwright tests green. It carries a visual component library in `brand.css` used heavily throughout (`design/architecture.mdx` and `getting-started/principles.mdx` are mostly inline SVG components), `starlight-tags` against a validated `docs/tags.yml`, and MDX components like `<Aside>`. Quartz does not render MDX. Moving the docs site to Quartz means rewriting every visual in the canonical knowledge base (R07, `41-QUESTIONS-RESOLVED.md` lines 43-47). That is plausibly 5 to 15 maintainer-days of pure translation with zero product value.

The fair counter is that nobody proposed moving the docs site, only the vault rendering. Correct. But notice what that implies: you end up running **two renderers anyway**, Starlight for cyberbaser's docs and Quartz for cyberbase's vault. Which is, conveniently, the only honest test of renderer-agnosticism this project will ever get for free.

**A weaker argument, flagged as one I only half believe.** `research/assumptions-and-risks.mdx` line 72 lists "Quartz / Obsidian Publish shipping a contribution UI" as a direction-changer. Building *on* Quartz means that if Quartz ships a CMS you have built a feature for your competitor's platform. I flag this as a steelman I do not fully hold, because the same open-source dynamic could just as easily make cyberbaser the default contribution layer for a 12.5k-star project, and that is distribution, not doom.

### Verdict: PARTIALLY WINS, and it reframes the fork rather than answering it "no"

The critics are right the fork must be resolved cheaply. The dissent's contribution is that "adopt vs keep" is the wrong axis. The right resolution is: **the hub's output artifact is the contract, and both renderers consume it.**

**Concrete changes:**

1. **Run the Quartz spike, scoped to the vault site only, explicitly excluding the docs site.** `npx quartz` against a 50-file subset of cyberbase, count Tier-1 features rendered, done. **0.5 day.**
2. **Two-renderer smoke test as the actual test of the agnosticism constraint.** Same hub output, two consumers, one assertion that both produce the expected page set. **0.5 day.**
3. **Pin the parse boundary in the hub contract.** One OFM parse/serialize module belongs to the hub. Renderers render; they do not get to *define* what `![[x#^y]]` means. If a renderer's transformers disagree with the hub's masking layer on a fixture, that is a pipeline bug and there is a test that says so. **0 extra days if done at contract-writing time, several days if discovered later.**

## 4. Which cut will be regretted

The three under review: DEFER the zero-account contribution bot, KILL Obsidian plugin-execution testing, NARROW the three-way CMS bake-off to one candidate.

### Plugin-execution testing: the kill is right, and I can now prove it

`research/v1-architecture.mdx` line 128 already settled the mechanism ("don't run community plugins in CI... the official `obsidian-headless` is Sync-only; the CLI needs the desktop app; `obsidianless` (xvfb+Docker) is fragile"). The only *reason* to want the test is to know what fraction of the real vault is unrenderable without plugins. That is a grep, not a headless browser, and it took seconds: **13 of 1445 files** contain Dataview blocks, 0.9%. Kill confirmed, replacement cost zero, because it is already run. Regret risk: negligible.

### Narrowing the CMS bake-off: the cut is right but mis-shaped

The critics' reasoning is strong: "the kill criterion is a 5-minute byte-diff, not a feature matrix." The mis-shaping is that once the criterion is a five-minute byte-diff, running *all three* costs about a day and running one costs about a third of a day. Narrowing saves nothing meaningful and risks learning late that the chosen one fails. And the plan needs to know whether **all three** fail, because if they do, the answer is the one the critics themselves floated: "ship the hub's own CM6 widget." Run the cheap test on all three, run the expensive test on none. Regret risk: medium, fix cost: two thirds of a day.

While there: `design/contribution-workflows.mdx` line 20 says Decap "renders the page's markdown in a rich editor (not raw). Tier 1 features (wikilinks, callouts) render as interactive widgets." `research/v1-architecture.mdx` line 99 says the only safe configuration is `widget: richtext, modes: ["raw"]`, and line 65 says neither Decap widget is "inherently safe passthrough." These contradict. One of them is wrong and the byte-diff decides which.

### Deferring the zero-account bot: this is the one that will be regretted

**It is misclassified.** It looks like a contributor feature. It is the hub runtime.

The critics list "one anonymous write-back endpoint" as one of exactly three things the forge does not provide, and it is the only one of the three that requires a server. Therefore it is the component that answers `design/architecture.mdx` line 262, "Where does the hub runtime live?" Defer it and v1 ships with no runtime, which means: the trust curve has nowhere to keep state, the publish manifest has nowhere to be enforced, the maintainer's role-based and per-page-private requirement has no home, and the RA-01 migration to the *preferred* Forgejo substrate has nothing to migrate. Deferring it does not defer a feature. It defers the architecture, and it makes "the forge is the hub" true by default rather than by decision.

**The stated justification is inconsistent with R08.** The critics defer it because it "serves nobody yet" (briefing line 98). That is precisely the reasoning R08 waived. R08 says build without external demand. Applying "serves nobody yet" selectively to the one capability that separates cyberbaser from `git` plus a text editor, while accepting R08 everywhere else, is not a consistent rule.

**The project's own risk register ranks it critical.** `research/assumptions-and-risks.mdx` line 34 lists "The GitHub-account wall on the 'zero-git' path" as **critical**, and states flatly that the persona Principle 3 exists to serve "has **no path**." R03 (`41-QUESTIONS-RESOLVED.md` lines 19-23) makes "accounts never forced" a locked decision. Deferring the only mechanism that implements a locked decision is a quiet relitigation of it.

**It is cheap.** The pattern is established prior art, listed at `research/v1-architecture.mdx` line 102: Contribunator, Staticman, PRB0t, gitmask. The minimum viable version is a single function: receive `{path, newContent, note}`, validate the result through the existing round-trip harness, commit to a branch as the bot, open a PR. Two to three days, not a platform.

**The honest counter, and why it does not save the deferral.** A public anonymous write endpoint on day one is an abuse magnet for a solo maintainer, and every mitigation currently written at `design/contribution-workflows.mdx` lines 130-135 assumes a GitHub account ("Rate limiting per GitHub account (Decap / the OAuth proxy enforces this)"). So the anonymous *surface* genuinely needs something the plan lacks. But that argues for shipping the endpoint **unlisted and allow-listed**, not for deferring it. The maintainer can be the only person who knows the URL for three months and the architecture is still validated, the trust state still has a home, and the manifest still has an enforcement point.

### Verdict: WINS

**Concrete changes:**

1. **Un-defer and rename.** "Zero-account contribution bot" becomes "**the hub write-back endpoint**": one function, one job, no UI, no public form. **2-3 days.**
2. Ship it unlisted or allow-listed. The anonymous form is a later toggle on top of it, not a prerequisite. **0 days.**
3. Keep the other two cuts, with the adjustments above: plugin testing stays dead (the grep already ran), and the CMS test runs cheap on all three rather than expensive on one.

## Where I actually land

| Steelman | Verdict | The change that follows |
|---|---|---|
| 1. Forge-as-hub is a trap | **Partially wins** | Keep the forge as substrate. Write the hub contract (1 day) and move trust state out of `.github/`. The scoping claim was right, the architectural claim was not. |
| 2. Dogfood-first is a trap | **Partially wins** | Keep R08. Add the two-corpus rule, de-scope binaries and Notion, and make the first governance primitive an allow-list. |
| 3. Adopting Quartz is wrong | **Partially wins** | Wrong axis. Run the spike scoped to the vault site, keep Starlight for the docs, and let two renderers consuming one hub artifact be the agnosticism test. |
| 4. The cuts are false economy | **Wins, for one of the three** | Un-defer the write-back endpoint (it is the runtime, not a feature). Plugin testing stays killed. CMS test goes cheap-on-three rather than expensive-on-one. |

The pattern across all four: **the critics were right about scope and wrong about shape.** Almost none of the corrections above add engineering days. They add about three days of writing and decision-making that determine whether v1's seven or eight days of engineering produce something extensible or something disposable.

Where I agree with the critics without reservation: v1 is small, `FOCUS.md` line 37 is stale post-R08 and should stop citing "demand unvalidated" as the reason not to build, Q06 stable URLs is a one-day convention decision with no owner, and the per-PR preview commitment at `design/contribution-workflows.mdx` line 118 is unimplementable against a deploy workflow whose `concurrency: group: 'pages'` and single `environment: name: github-pages` (`.github/workflows/deploy.yml`) allow exactly one environment. That last one needs the written policy at line 112 amended, not the pipeline heroically extended.

## The assumption that costs the most, and the cheapest test

**The assumption: that OFM fidelity is what makes a knowledge base contributable. In one phrase, that the round-trip is the moat.**

It is stated as fact at `research/v1-architecture.mdx` line 31 ("The value moat is the lossless Obsidian-Flavored-Markdown round-trip") and it is load-bearing for the identity, the keystone, the editor choice, the CMS kill criterion, and the entire defensibility argument against Quartz at `research/assumptions-and-risks.mdx` line 54.

If it is wrong, two things fail at once. The round-trip becomes a correctness floor that any competent implementation clears, worth a week rather than a phase. And the remaining differentiator is governance: trust curve, moderation, selective publishing, federation. Which is exactly the half the convergent verdict just handed to the forge. Both halves hollow simultaneously, and the answer to "what is the product" becomes genuinely unclear. Nothing else in the plan has that blast radius, because everything else fails locally.

The census above is the first real evidence, and it points the wrong way for the assumption: 80 to 85% of the dogfood vault carries no OFM at all, and the exotic constructs the keystone spike was designed around appear in six files out of 1445.

**The cheapest test that would falsify it, in half a day.** Swap the corpus, not the code. `spikes/ofm-roundtrip/roundtrip.mjs` already does parse, stringify, byte-diff, and reports per-fixture results. Point pipeline D at every `.md` file in the local vault checkout instead of the 21 hand-written fixtures, and report two numbers: the byte-identical percentage, and a histogram of failure classes.

Reading the result:

- **Pipeline D round-trips over 99% of real files, and the OFM census holds under 20%.** The round-trip is solved and small. It is a floor, not a moat. Reallocate engineering from editor fidelity to governance: the write-back endpoint, the trust state model, the publish manifest. Rewrite the moat sentence at `research/v1-architecture.mdx` line 31 to say so, and demote the keystone from identity to invariant.
- **Pipeline D falls below about 95%.** The masking layer is a property of the 21 fixtures rather than of OFM, R05 in `41-QUESTIONS-RESOLVED.md` is over-resolved, and no CMS ships until it is fixed. The moat is real and unbuilt.

Either result is decisive, which is what makes it worth doing first. The test also returns three answers the plan needs and nobody owns: how long a full pass over 1445 files takes on WSL2 `/mnt/c` (the briefing notes no build has ever been timed on a 9p filesystem that runs 5 to 20x slower than ext4), the real binary footprint for the unrun LFS check, and a concrete list of the file classes a web edit would corrupt today. The corpus is already on disk, so there is no 592 MB clone in the price.

## Related

- [The v1 architecture (Phase R findings)](/cyberbaser/research/v1-architecture/) — the plan this dissents from
- [Assumptions & risks under test](/cyberbaser/research/assumptions-and-risks/) — where the moat claim and the critical GitHub-wall risk are recorded
- [SSOT findings](/cyberbaser/research/source-of-truth/) — git's two structural zeros, and "solve it in a layer in front of git"
- [Architecture](/cyberbaser/design/architecture/) — the hub boundaries, and the still-open "where does the hub runtime live"
- [Contribution workflows](/cyberbaser/design/contribution-workflows/) — the trust YAML, the rebase concession, and the preview commitment
- [Principles](/cyberbaser/getting-started/principles/) — Principle 3, and what it rules out
- External: [Contribunator](https://github.com/Contribunator/Contribunator), [Staticman](https://staticman.net/), [gitmask](https://github.com/AnalogJ/gitmask) (the write-back prior art) · [Quartz #1864](https://github.com/jackyzha0/quartz/issues/1864) (the incumbent disclaiming the CMS niche) · [mdast-util-to-markdown](https://github.com/syntax-tree/mdast-util-to-markdown)

## Task list

Sequenced, day-priced for a solo part-time maintainer. Days are maintainer-days, not calendar days. Total: **10.75 days**, of which 3.25 are writing and decisions and 7.5 are engineering.

### Gate 0 — run before committing to any of it (0.5 day)

| # | Task | Days | Why now |
|---|---|---:|---|
| 0.1 | **Corpus-swap round-trip run.** Point `spikes/ofm-roundtrip/roundtrip.mjs` pipeline D at all 1445 `.md` files in the local vault. Report byte-identical %, failure histogram, wall-clock time, binary footprint. | 0.5 | Falsifies or confirms the assumption everything else rests on. Also settles the unrun LFS check and the never-timed build, free. |

**Branch here.** Below 95% byte-identical: stop, fix the serializer, nothing else ships. At or above 99%: the round-trip is a floor, and tasks 1.x through 4.x are the real v1.

### Phase A — decisions and boundaries (3.25 days, no code)

| # | Task | Days | Depends on |
|---|---|---:|---|
| 1.1 | **Write the hub contract**, one page: the five hub operations (`accept-edit`, `classify-trust`, `route-decision`, `write-back`, `publish-manifest`), the forge as adapter #1 for four of them, and the rule that the hub owns one OFM parse/serialize module that renderers may use but not redefine. | 1.0 | 0.1 |
| 1.2 | **Decide the publish manifest as an allow-list**, not an ignore-list, and write the schema. This is where the maintainer's role-based and per-page-private requirement lands, and where the journals/finance/resumes exposure gets a real mechanism instead of a license carve-out. | 1.0 | 1.1 |
| 1.3 | **Resolve Q06 (stable URLs).** The critics are right that this is a convention decision, not research. Pick `permalink` frontmatter per `research/v1-architecture.mdx` line 131, write it down, close the question. | 0.5 | — |
| 1.4 | **Reconcile the four documented contradictions.** Decap rich-widget vs raw-only (`contribution-workflows.mdx` line 20 vs `v1-architecture.mdx` line 99); per-PR preview commitment (`contribution-workflows.mdx` line 118 and the review-the-rendered-preview clause at line 112) vs single-environment GitHub Pages deploy; `FOCUS.md` line 37 still citing "demand unvalidated" post-R08; `.github/trusted-contributors.yml` renamed to `.cyberbaser/trust.yml`. | 0.5 | 1.1 |
| 1.5 | **Adopt the two-corpus rule** and name corpus B (recommend `docs/src/content/docs/`: text-heavy, non-Obsidian, structurally unlike cyberbase). Write it into the plan as a done-criterion. | 0.25 | — |

### Phase B — the cheap empirical questions (2 days)

| # | Task | Days | Depends on |
|---|---|---:|---|
| 2.1 | **CMS byte-diff on all three finalists** (Decap raw mode, Sveltia, Pages CMS): open a file containing wikilinks and callouts, save without editing, diff the bytes. Five minutes each plus setup. Kill criterion is the diff, not a feature matrix. | 1.0 | 0.1 |
| 2.2 | **Quartz spike, vault-site scope only.** `npx quartz` against a 50-file cyberbase subset, count Tier-1 features rendered, compare to the Starlight prototype. Explicitly out of scope: migrating the docs site. | 0.5 | — |
| 2.3 | **Two-renderer smoke test.** Same hub output artifact consumed by two renderers, one assertion that both produce the expected page set. This is the only thing that makes "renderer-agnostic" testable. | 0.5 | 2.2, 1.1 |

### Phase C — the one thing to build (5 days)

| # | Task | Days | Depends on |
|---|---|---:|---|
| 3.1 | **The hub write-back endpoint.** One function: receive `{path, newContent, note}`, run the result through the round-trip harness, reject on corruption, commit to a branch as the bot, open a PR. Unlisted and allow-listed. No public form, no UI. | 2.5 | 1.1, 2.1 |
| 3.2 | **Trust state, minimum viable.** `.cyberbaser/trust.yml` plus the classifier that reads it and decides route (auto-merge / quick review / full review), per the dial at `concepts/problem.mdx` lines 121-137. Runs in CI, forge-agnostic in shape. | 1.0 | 3.1 |
| 3.3 | **Publish manifest enforcement.** Build reads the allow-list from 1.2 and refuses to emit anything outside it. Verify against the vault that journals, finance, and resumes do not appear in the output. | 1.0 | 1.2 |
| 3.4 | **Notion lint.** One CI check flagging export-mangled syntax. Not an importer, not a normalizer. | 0.5 | 0.1 |

### Explicitly not in this list

Plugin-execution testing (killed; the grep already answered it at 0.9% of files). Q01 local-vault audit (killed). Any v1 renderer-adapter abstraction (killed; 2.3 replaces it). The public anonymous contribution form (3.1 ships the endpoint, the form is a later toggle). Forgejo mirror (deferred, and 1.1 is what makes deferring it safe). Incremental builds (0.1 produces the measurement that decides it). Real-time collaboration, federation, block-ID transclusion, per-PR previews.

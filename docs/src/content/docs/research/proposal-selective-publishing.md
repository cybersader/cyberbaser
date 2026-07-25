---
title: Selective Publishing and Access
description: What is public, what is not, and who decides. The v1 mechanism is a default-deny selector over a private source repo that generates a public published artifact. Role-based access is a v2 layer in front of git, not a v1 feature.
sidebar:
  order: 12
status: research
tags: [design, architecture, governance, federation]
---

:::caution[Proposal, not a decision]
One of several competing v1 designs from the adversarial design pass of 2026-07-25. Nothing on this page is locked. The deciding gate is the corpus round-trip measurement described in [the v1 build plan](/cyberbaser/research/v1-build-plan/), which also maps how the competing shapes differ.
:::

:::note[Maintainer position (R11, 2026-07-25)]
The exposure framing below is the analysis as delivered, but the maintainer has since stated the vault's public content is **intentional**: the triage/remediation track (tasks 1-5) is waived. What survives is the *mechanism* half of this page — the publish boundary, default-deny selector, cross-boundary link handling, and leak tests — as the feature implementing the access-flexibility requirement, prerequisite to publishing the vault (roadmap Phase 3).
:::

Every other page in this project describes something that has not been built yet. This one describes something that is already happening. `cybersader/cyberbase` is a public repository containing content that was never written for publication, and the only mitigation anyone has written down is a license carve-out. A license governs what people may *do* with content they can already read. It does nothing about who can read it. Those are two different boundaries and the project has so far only addressed the second-most-urgent one.

This page states the exposure honestly, picks the v1 mechanism, and answers the maintainer's access-flexibility requirement without pretending git can do something it structurally cannot.

## Where things actually stand

Verified 2026-07-25:

- `cybersader/cyberbase` is **public**, 592 MB, ~1439 files. Its own GitHub description says the content is *"mixed with some personal."* Last push 2026-07-01.
- [`design/legal-and-governance.mdx`](/cyberbaser/design/legal-and-governance/) line 49 states it plainly: *"Our vault mixes cyber reference material with journals, finance notes, and resumes."*
- The mitigation on record is line 51's carve-out pattern: license the public content, list explicit exceptions. That is correct and insufficient. It is a reuse control, not a read control.
- Two external PRs are merged into that history: [cyberbase#2](https://github.com/cybersader/cyberbase/pull/2) (the agent PR probe) and [cyberbase#3](https://github.com/cybersader/cyberbase/pull/3) (the LICENSE), both recorded in [`research/assumptions-and-risks.mdx`](/cyberbaser/research/assumptions-and-risks/) lines 63 and 65.
- A grep of `.claude/` for selective-publish, include-exclude, or role-based returns zero hits. There is no task for any of this. Meanwhile [`.claude/20-ROADMAP.md`](/cyberbaser/getting-started/roadmap/) Phase 3 reads, in full: *"Point at `cybersader/cyberbase`, deploy to a real domain."* Phase 3 as written is an instruction to publish the journals.

The saving grace is that the vault **has never been built or rendered by any pipeline**. The exposure today is "readable by anyone who clones or browses the repo." It is not yet "indexed as a website with a search index and a sitemap." Phase 3 converts the first into the second. That conversion is the thing to stop.

### What is already irreversible

Be blunt about this, because the temptation is to reach for `git filter-repo` and feel like the problem is solved.

Anything that has been in a public GitHub repo should be treated the way security teams treat a leaked credential: **assume it is disclosed, and spend your effort on stopping future harm rather than on undoing the past.** Concretely, the following pin the current history in place:

1. **Git-is-SSOT is a project invariant.** [`principles.mdx`](/cyberbaser/getting-started/principles/) Principle 1 makes the versioned history authoritative, and [`legal-and-governance.mdx`](/cyberbaser/design/legal-and-governance/) line 73 makes commit history the *attribution record* the license points at. A history rewrite deletes the thing the license relies on for two merged contributions.
2. **Obsidian Git backups hold full clones on every machine the maintainer syncs.** After a force-pushed rewrite, the next auto-commit-auto-push cycle from an un-reset machine either fails noisily or re-pushes the old objects. This is a realistic way to rewrite the history, feel finished, and have it restored by a background sync three hours later.
3. **Merged PR refs survive rewrites.** GitHub keeps `refs/pull/N/head` and cached diff views after a force-push; [GitHub's own removing-sensitive-data guidance](https://docs.github.com/en/authentication/keeping-your-account-secure/removing-sensitive-data-from-a-repository) says you must contact Support to purge cached views and PR references, and that commits remain reachable through forks and clones. PR #2 and #3 are exactly this case.
4. **Forks and archives are outside your control.** Per [GitHub's repository-visibility docs](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility), making a public repo private **splits its public forks into a new network** rather than deleting them. Public forks stay public. Separately, public GitHub repos are routinely archived by [Software Heritage](https://www.softwareheritage.org/) and their events logged by [GH Archive](https://www.gharchive.org/), neither of which you can retract.

**Price the rewrite now vs later.** The mechanical cost is roughly the same either way and it is small: `git filter-repo` over 592 MB is on the order of an hour of wall time, plus a WSL2 penalty because the working tree is on `/mnt/c` (9p, commonly 5-20x slower than native ext4 on file-heavy operations). Budget **1 maintainer-day today, 1 maintainer-day in a year.** The cost that changes with time is the *coordination* cost: one more merged external PR, one more fork, one more machine syncing via Obsidian Git, and each of those multiplies the "who do I have to tell" step. It roughly doubles per new participant.

The honest conclusion is that a rewrite is **not the main lever**, because it does not retract forks, archives, or the two years the repo has already been public. Do a rewrite only for a specific class of content, defined below. For everything else, the lever that actually works is: stop adding to the public surface, and never render it.

### The rewrite trigger

Rewrite history if, and only if, the triage in Task 1 finds any of:

- Live credentials, tokens, or keys (rewrite **and** rotate; rotation is the part that matters).
- Third-party personal data the maintainer does not own: someone else's address, medical detail, or private correspondence.
- Financial account identifiers, tax IDs, or scans of identity documents.

Do **not** rewrite for the maintainer's own journals, notes, or resumes. Those are the maintainer's to disclose, the disclosure already happened, and the rewrite costs the SSOT invariant, every existing clone, and both merged PRs while buying almost nothing back.

## The v1 mechanism

### The options, compared

Four candidates. The comparison turns on one question that is easy to miss: **does the mechanism control what the site shows, or what the repository exposes?**

| Mechanism | Controls | Handles non-markdown | Failure floor | Verdict |
|---|---|---|---|---|
| Frontmatter flag, default-allow (`private: true` to hide) | Render only | No | A new file with no frontmatter is public | Reject |
| Frontmatter flag, default-deny (`publish: true` to show) | Render only | No | A new file with no frontmatter is hidden | Good rule, wrong layer alone |
| Folder allowlist | Render only | Yes, by path | A file moved into an allowlisted folder is public | Good coarse tier, too blunt alone |
| **Two-repo split: private source, generated public subset** | **Repository read access** | Yes | Nothing reaches the public repo unless the selector emitted it | **Recommended** |

The first three all share a disqualifying property for the situation actually at hand: they are filters applied at **render** time, and the repository stays public underneath. Setting `publish: false` on a journal entry in a public repo hides it from the website and changes nothing about the exposure. [Quartz's `ExplicitPublish` filter](https://quartz.jzhao.xyz/plugins/ExplicitPublish) and the [Obsidian Digital Garden plugin's `dg-publish`](https://dg-docs.ole.dev/) both behave this way, and both are documented as controlling site output, not repo visibility. That is correct behavior for their use case (a repo that was public on purpose). It is not the case here.

The second disqualifier is **binaries**. 592 MB across ~1439 files averages roughly 420 KB per file, which means the repo is dominated by attachments, not prose. Attachments have no frontmatter. A frontmatter-only scheme cannot express visibility for a PNG of a bank statement, and in a typical vault layout that PNG sits in a shared attachments folder next to screenshots that belong on the public site, so a path allowlist cannot classify it either.

### Recommendation

**Adopt the two-repo split, with a default-deny selector between the two.**

- **`cybersader/cyberbase-vault` (new, private)** is the SSOT. Full existing history, full content, Obsidian Git points here. This is where all authoring happens and where the round-trip writes back.
- **`cybersader/cyberbase` (public)** becomes a **generated artifact**. It contains only what the selector emitted, byte-identical to the source. Nobody authors into it directly.
- The selector is `publish.yml` at the vault root, evaluated **default-deny**, with a folder allowlist as the bulk-grant tier and per-file frontmatter as the override tier.

The exact precedence, deny-wins:

1. `publish: false` in frontmatter → never published. Beats everything, including an allowlisted folder.
2. `publish: true` in frontmatter → published. If the file's folder is not in the allowlist, an explicit `slug:` is required or the build fails (see the URL-leak note below).
3. Path matches an allowlist entry in `publish.yml` → published.
4. Otherwise → not published.
5. **Non-markdown assets publish by reachability, never by path**: an asset is emitted only if a published page references it. This is the rule that makes the shared-attachments-folder problem tractable, and it is why an allowlist alone is insufficient.

The URL-leak note: a file published out of a non-allowlisted folder would otherwise get a URL like `/journal-2024/one-shareable-entry/`, which broadcasts the private folder's existence and name. Requiring an explicit `slug:` in that case forces the maintainer to choose a public path. This is also the first concrete constraint on [Q06 (stable URLs)](/cyberbaser/reference/open-questions/#q06--content-addressability-slugs-hashes-or-title-based-with-redirects), which self-describes as blocking any production deploy: the URL scheme cannot be a pure function of vault path, because vault paths are sometimes secrets.

### Why this does not violate the single-vault invariant

[`research/source-of-truth.mdx`](/cyberbaser/research/source-of-truth/) line 188 raises exactly the right objection: *"The git-native workaround for mixed-privacy (one repo per access tier) shatters the single-vault invariant, which is itself a hard constraint."*

That objection lands on a different design. It applies to *one authoring surface per tier*, where the maintainer decides which repo to write into and content lives in two places with two histories. The split proposed here has **exactly one authoring surface**. The public repo is a build output, in the same category as `dist/`: derived, regenerable, never edited by a human. If it is deleted, `publish` regenerates it. The invariant that matters, one authoritative copy you own and author into, survives intact.

The cost that is real: web contributions arrive at the public repo, because that is where the fork-and-PR surface lives, and they have to be replayed into the private source. That is addressed below and it is bounded, because the publish transform is path-preserving, which makes the mapping the identity function.

### Why default-deny

This is the load-bearing choice and it deserves an argument rather than an assertion.

**The failure modes are asymmetric and only one of them is recoverable.** Under default-deny, the error is a page that should be public and isn't. The maintainer notices, sets a flag, and the next build fixes it. Cost: minutes, fully recoverable. Under default-allow, the error is a journal entry that goes public and gets crawled, forked, and archived. Cost: unbounded, and per the irreversibility section above, unrecoverable. When one error class is cheap and the other is permanent, the default belongs on the cheap side. This is the same reasoning behind deny-by-default firewall policy and it is not a close call.

**The corpus predates the policy.** Those 1439 files were written by someone who had no publication in mind. Default-allow retroactively labels every one of them "public unless I remember otherwise," which is a precise description of how the current situation was produced. Default-deny makes the maintainer's silence mean "not published," which is the honest reading of what that silence actually meant when the files were written.

**There is more than one writer, and not all of them are under control.** Obsidian writes to the vault. The Notion sync leg writes to the vault, and its exporter is a third-party tool that mangles wikilinks and callouts and can create files with arbitrary or absent frontmatter. Agents and the future CMS will write to the vault. Under default-allow, a third-party exporter's frontmatter handling decides what the world sees. Under default-deny, anything a new writer creates is invisible until a human classifies it. That property is worth more than the labeling convenience.

**The precedent splits exactly along this line.** [Obsidian Publish](https://help.obsidian.md/publish) is default-deny: files are explicitly selected for publication. The Digital Garden plugin is default-deny (`dg-publish: true`). Quartz defaults to publish-everything with an opt-in `ExplicitPublish` filter available. The tools built for mixed personal vaults chose default-deny; the tool built for repos that were already public chose default-allow. cyberbase is the first case.

**The cost of default-deny is the bulk-onboarding of 1439 files, and the folder allowlist is what pays it.** Labeling is O(top-level folders), not O(files). Allowlist `/cyber`, `/tools`, `/notes-public`, and the entire published surface exists after one afternoon of directory review. That is the entire reason the recommendation is allowlist-plus-override rather than per-file flags alone: per-file default-deny without a bulk tier would be genuinely unusable at this scale, and an unusable safety mechanism gets disabled.

## Interaction with the round-trip guarantee

The keystone result (OFM round-trip, 20/21, `spikes/ofm-roundtrip/`) is a **byte-level** guarantee: a web edit writes back bytes that Obsidian reads identically. Selective publishing can destroy that guarantee in one specific way, so the rule is stated as a hard boundary.

**The selector filters the file set. It never transforms file contents.**

If publishing rewrote a cross-boundary wikilink into a stub, the public copy's bytes would diverge from the private source. A web edit against the public copy would then round-trip the *rewritten* bytes back into the vault, and the vault's own links would be silently rewritten by the publishing pipeline. That is content corruption originating in the safety mechanism. It also directly violates [`architecture.mdx`](/cyberbaser/design/architecture/) line 253, which says the hub and round-trip must not apply lossy transforms.

Consequences worth making explicit:

- Published files in the public repo are **byte-identical** to their private sources. A CI byte-diff assertion enforces this, and it is a two-line check.
- All link resolution against the public/private boundary happens in the **renderer**, on HTML output. Never in markdown.
- **Frontmatter is not redacted.** A published file carries its full frontmatter, private fields included. There is no field-level redactor in v1 because a redactor is a byte transform and would break the guarantee above. The consequence: if a file's frontmatter is sensitive, that file is not publishable. Accept this cost rather than engineering around it.

### Cross-boundary wikilinks

A published page contains `[[Private Note]]`. Three candidate behaviors:

| Behavior | Leaks | Problem |
|---|---|---|
| Broken link (unresolved, 404) | Title, existence, and a crawlable 404 surface | Link checkers fire on every one, training the maintainer to ignore link failures |
| Silent strip (render as plain text) | Only the display text the author already wrote in a public sentence | Invisible to the maintainer unless reported |
| Stub page ("this page is private") | Title, existence, confirmation that private content sits at that path | Produces an enumerable directory of everything you hid |

**Decision: silent strip for readers, loud report for the maintainer.**

Render `[[Private Note]]` as its display text, in plain body prose. No `href`, no tooltip, no CSS class that says "private", nothing a scraper can pattern-match to enumerate the private set. The stub option is the worst of the three: it converts your private page list into a public index, with no compensating benefit. The broken-link option is nearly as bad and additionally poisons your link-checking signal, which is the thing that catches real regressions.

Silence toward readers must not mean silence toward the maintainer. Every build emits `publish-report.json` listing each stripped cross-boundary link with source page, target, and line number. The maintainer reads that file, the reader never sees it. Stripped links are a signal that a public page depends on private context and may not make sense standalone, which is editorial information the maintainer wants.

Authors already have the escape hatch: `[[Private Note|the internal write-up]]` strips to "the internal write-up", so the alias mechanism gives per-link control over exactly what text survives. No new syntax needed.

**Embeds are different and get the opposite treatment.** `![[Private Note]]` in a published page is a **build failure**, not a silent strip. Two reasons. A transclusion that silently resolves to nothing changes the meaning of the page rather than degrading it, and an embed that accidentally resolves *across* the boundary inlines the entire private body into public HTML. That is the single highest-consequence failure in this design, so it fails loudly and requires the maintainer to either publish the target or delete the embed.

### The derived-index rule

This is where static sites actually leak, and it deserves its own rule because it is easy to get the page filter right and the index wrong.

**Every derived artifact is computed from the published set, never from the full set.** Search index, sitemap, RSS, graph JSON, backlinks, tag pages, "recent changes". The classic failure is a search index built before the filter, shipped as a single JSON blob containing the full text of unpublished pages. The page filter looks like it works because the private pages 404, while their entire contents are sitting in `search-index.json`.

The test that enforces this is worth more than any other test in the design: after a build, grep every emitted file for every unpublished path, title, and a sample of unpublished body text. Zero hits, or the build fails. Make it a CI gate before Phase 3 ships anything.

## The access-flexibility requirement

The maintainer's requirement, recorded here because it was never in the repo:

> "Flexibility of access: if you want a role-based access system, that should be possible with the wiki system; and if you want something as simple as 'here's a private page for me, here's the public side', despite the hierarchical nature of the knowledge base, that should be possible as well in our architectures."

Two halves. The second half is a v1 requirement. The first half is a v2 architecture, and the useful move is to make v1 a special case of it rather than a thing that has to be thrown away.

### v1 answer: visibility, not identity

v1 has exactly two states, published and not-published, and no concept of a user. No login, no per-reader rules, no gated pages.

That is a deliberate limit, not an omission. [`source-of-truth.mdx`](/cyberbaser/research/source-of-truth/) scores git **0/2 on sub-repo access control** (line 44: *"CODEOWNERS routes review, not read access. Repos are all-or-nothing on read"*), and line 56 names it the single most important finding on the page: the CMS layer cannot fix it, because CMSs inherit whatever the forge exposes. Any read-ACL finer than "this repo" must be enforced by a runtime sitting in front of git. Introducing that runtime in v1 means the thing line 204 warns about, git demoted from arbiter-of-visibility to a file store behind a permission API. It also breaks static hosting outright: GitHub Pages serves one anonymous bucket, so a role-gated page cannot be a static artifact, and building one forces an answer to [`architecture.mdx`](/cyberbaser/design/architecture/) line 262's still-open *"where does the hub runtime live?"* before anything ships.

The two-repo split is the honest v1 read-ACL: it uses the only granularity git actually has (the repository) and gets a real boundary out of it, instead of simulating access control with frontmatter and hoping.

### Both requested shapes, expressed

**"One private page, the rest public, despite the hierarchy."** Allowlist the parent folder in `publish.yml`, then put `publish: false` on the one file. Rule 1 beats rule 3, so the deny wins against its own folder's grant. The hierarchy does not fight you because deny is not inherited *through*, it is asserted *at* the file.

```yaml
# publish.yml
allow:
  - cyber/**
  - tools/**
```
```yaml
# cyber/incident-notes/client-acme.md
---
publish: false
---
```

**"Mostly private, a few public pages."** Grant nothing in the allowlist, mark the handful with `publish: true` plus an explicit `slug:`. Rule 2.

**The shape that is deliberately not supported in v1:** promoting a page out of a folder without a slug. That build failure is the design working, because the URL would otherwise name the private folder.

### v2 role-based path, sketched only

The generalization is small enough to make v1 forward-compatible for roughly one line of code, and that is the only v2 work worth doing now.

**Parameterize the selector by audience, and have v1 only ever pass `public`.** `select(vault, audience) -> fileset`. Frontmatter becomes `visibility: [public]` or `visibility: [team-research, maintainers]`, with bare `publish: true` desugaring to `visibility: [public]`. In v1 there is one audience and one output. In v2 the same selector runs N times and emits N artifacts, one per audience, and the build code does not change.

What v2 adds on top, and what it costs:

- **A read proxy.** The static public artifact stays the anonymous tier. Everything else is served by a runtime that checks an OIDC session before choosing which artifact to serve. [RA-01, the self-hosted Forgejo + PKCE stack](/cyberbaser/design/reference-architectures/self-hosted-forgejo-auth/), is the identity half and already exists as a design.
- **Roles come from the forge, not from a new system.** Forgejo teams map to audiences. No separate user database.
- **The honest cost, already documented.** [`source-of-truth.mdx`](/cyberbaser/research/source-of-truth/) line 204 states it: once a permission-aware proxy is the read boundary, git has stopped being the arbiter of visibility. That is a genuine architectural concession and it belongs in the v2 decision, not smuggled in early. v1 does not pay it, because in v1 the repository boundary *is* the access boundary and git is still the arbiter.

Do not build any of this now. Ship the audience parameter, pass `public`, stop.

## Does personal content belong in the public repo at all?

**No. Recommendation: the authoritative vault goes private, and the public repo becomes a generated artifact containing only published content.**

Not a hedge, and not "add a folder to `.gitignore`." The reasoning:

1. **The mixing has no upside.** Nothing about the project requires journals and resumes to be co-located with the cyber reference material *in a public repo*. They are co-located in the *vault* for good reasons (one graph, one search, one set of links) and the two-repo split preserves all of that, because the private vault keeps everything.
2. **Confidentiality by convention is not confidentiality.** The current arrangement depends on nobody looking, on every future file being correctly flagged, and on three different writers (Obsidian, Notion sync, agents) all respecting a rule none of them enforce. That is not a control.
3. **Publishing the vault is on the roadmap.** Phase 3 says point the renderer at `cybersader/cyberbase`. There is no version of that step that is safe with the current mixture, and no task anywhere that makes it safe. This design *is* the missing Phase 3 prerequisite.
4. **It improves the license story rather than duplicating it.** Once the public repo only contains published content, the carve-out list in [`legal-and-governance.mdx`](/cyberbaser/design/legal-and-governance/) shrinks from "journals, finance, resumes, third-party material, code" to "third-party material, code". The license stops carrying weight it was never designed to carry, and starts doing only the job it is good at.

### The mechanics, and why not `filter-repo`

Recommended sequence, which reaches a clean public surface without a history rewrite:

1. **Rename** `cybersader/cyberbase` → `cybersader/cyberbase-vault` and **set it private**. Full history preserved, so the SSOT invariant and the attribution record survive untouched. Obsidian Git needs one `git remote set-url` per machine.
2. **Create a new public `cybersader/cyberbase`** as the generated published artifact. Taking the freed name means old inbound links resolve to the new public artifact rather than to a renamed private repo. Its history is a fresh sequence of `publish <source-sha>` commits.
3. **Re-add `LICENSE.md`** to the new public repo, with the shortened carve-out list.
4. **Archive the evidence.** PR #2 and #3 move into a private repo and stop being publicly linkable. Copy their diffs and discussion into [`assumptions-and-risks.mdx`](/cyberbaser/research/assumptions-and-risks/) so the falsification-test record survives as text, since the record is what mattered, not the URL.

Runner-up, and why it loses: keep `cyberbase` public and `git filter-repo` the personal content out of its history. It costs a rewrite of a 592 MB repo on a 9p mount, it invalidates every clone, it breaks the two merged PRs, it strains the SSOT invariant, and per the irreversibility section it still does not retract forks or archives. It buys a cleaner past for a real price and does nothing the rename does not do for the future.

Accept openly: the exposure through 2026-07-01 is not retracted by any of this. Public forks split off and stay public. Archives keep what they took. The recommendation stops the bleeding and makes the roadmap executable. It does not undo anything, and any plan that claims to is lying.

## Task list

Sequenced. Priced in maintainer-days for a solo part-time maintainer. Total v1: **~5 days**, and Task 1 through 3 are the urgent part.

| # | Task | Days | Notes |
|---|---|---|---|
| 1 | **Exposure triage.** Run [gitleaks](https://github.com/gitleaks/gitleaks) or [trufflehog](https://github.com/trufflesecurity/trufflehog) over the full history. Separately, walk the top-level folders and sort them into must-purge (credentials, third-party PII, financial identifiers) vs accept-as-disclosed. Also run `gh api repos/cybersader/cyberbase/forks` to find out whether forks exist. Output: one private triage note. | 0.5 | Do this first. Everything else waits on knowing which class the content is in. |
| 2 | **Rotate anything the scan finds.** Non-negotiable and independent of the rest. | 0.25 | Rotation is what mitigates a leaked credential. The rewrite is cosmetic by comparison. |
| 3 | **Repo split.** Rename `cyberbase` → `cyberbase-vault`, set private, create the new public `cyberbase`, update Obsidian Git remotes on every machine, verify sync from both. | 0.5 | This alone stops the exposure growing. Ship it before any pipeline work. |
| 4 | **Decide the history-purge question** with the Task 1 output in hand, against the rewrite-trigger criteria above. If triggered, `git filter-repo` plus a GitHub Support request to purge cached PR views, plus a re-clone on every machine. | 0.25 decide, +1 if triggered | Expect not triggered. Budget the day anyway. |
| 5 | **Archive the PR evidence** into `assumptions-and-risks.mdx` before #2 and #3 stop being publicly linkable. | 0.25 | |
| 6 | **Build the selector.** `publish.yml` parser, the four-rule precedence, asset reachability, the `audience` parameter (v1 passes `public` only), `publish-report.json`. Plain Node, no framework, target ~200 lines. | 1.0 | The audience parameter is the entire v2 forward-compatibility investment. |
| 7 | **Classify the vault.** Walk the top-level folders, write the allowlist, spot-check with a dry run that prints the emitted file list. | 0.5 | O(folders). This is the step default-deny makes affordable. |
| 8 | **Cross-boundary link handling in the renderer.** Strip links to display text, fail the build on cross-boundary embeds, populate the report. | 0.5 | Renderer-side only. Never touches markdown bytes. |
| 9 | **Leak tests as a CI gate.** Assert no unpublished path, title, or body sample appears in any emitted file, including search index, sitemap, RSS, and graph JSON. Assert every published file is byte-identical to its source. | 0.5 | The highest-value test in the design. Phase 3 does not ship without it green. |
| 10 | **Publish job.** Generate the public repo from the private one on push. Path-preserving, so the public→private contribution mapping stays the identity function. | 0.5 | |
| 11 | **Propagate the decision.** Add a "Selective Publishing" gate to `.claude/20-ROADMAP.md` blocking Phase 3, log the decision in `41-QUESTIONS-RESOLVED.md`, note the `slug:` constraint against Q06 in `open-questions.mdx`, shorten the carve-out list in `legal-and-governance.mdx`. | 0.25 | Same-session knowledge-ops rule. |
| — | v2 role tiers, read proxy, audience artifacts | deferred | Not now. The selector's `audience` parameter is the only part of it that exists in v1. |

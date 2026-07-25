---
title: "Hub bill of materials (v1)"
description: "The hub decomposed into named deployables: what each one is, where it runs, what state it holds, who can call it, and what breaks if it dies. Closes the 'where does the hub runtime live?' question."
sidebar:
  label: "Hub bill of materials"
  order: 11
status: research
tags: [design, architecture, contribution]
---

:::caution[Proposal, not a decision]
One of several competing v1 designs from the adversarial design pass of 2026-07-25. Nothing on this page is locked. The deciding gate is the corpus round-trip measurement described in [the v1 build plan](/cyberbaser/research/v1-build-plan/), which also maps how the competing shapes differ.
:::

[Architecture](/cyberbaser/design/architecture/) calls the hub the product and then, at the bottom of the same page, still lists **"Where does the hub runtime live?"** as an open question (`design/architecture.mdx`, line 262). That gap is why the plan keeps drifting: "the hub" is treated as one thing, so every discussion about it collapses into either "it's just GitHub" or "it's a platform." It is neither. This page breaks it into named deployables and prices each one.

## The answer in one paragraph

**The v1 hub runs in three places, and only one of them is a server.** Most of it is a library and a static JavaScript bundle that run in the contributor's browser. Most of the rest is CI jobs that run inside the forge on push and pull-request events. Exactly one component is an always-on, internet-facing process: the anonymous write endpoint, and it runs on the maintainer's own box behind a [Cloudflare Tunnel](https://www.cloudflare.com/products/tunnel/), per [RA-01](/cyberbaser/design/reference-architectures/self-hosted-forgejo-auth/). There is no hub database, no hub session store, and no hub-owned copy of content. The forge holds the state; the hub holds the translation.

## The bill of materials

`H` rows are things cyberbaser has to build. `F` rows are things the forge already provides, listed anyway so nothing hides in the gaps between them.

| ID | Component | Kind | Runs where | Build cost |
|---|---|---|---|---|
| **H1** | `cb-serializer` | npm library | Browser and Node, no network surface | 4 d |
| **H2** | `cb-edit` | Static JS + CSS bundle | The reader's browser, served from the rendered site | 6 d |
| **H3** | `cb-intake` | One HTTP service | Maintainer's box, behind a Cloudflare Tunnel | 4 d |
| **H4** | `cb-triage` | CI job | Forge runner, on pull-request events | 2 d |
| **H5** | `cb-preview` | Two CI jobs + a second Pages site | Forge runner, publishing to a separate origin | 3 d |
| **H6** | `publish.yml` | Config file + two enforcement points | Read by the site build and by `cb-intake` | 2 d |
| **F1** | Moderation queue | The forge's pull-request list | The forge | 0 d |
| **F2** | Trust-curve state | `.github/trusted-contributors.yml` + branch protection | The repo and the forge's settings | 1 d |
| **F3** | Write-back path | Merge to `main`, then `deploy.yml` | The forge | 0 d (exists) |
| **F4** | Attribution | Git commit author and trailers | The repo | 0.5 d |

Total: about **22.5 maintainer-days**, or five to six weeks at a part-time pace. That number is the real answer to "how big is the hub," and it is small because ten components produce exactly one server.

---

## H1 · `cb-serializer`

**What it is.** The lossless Obsidian-flavored-markdown round-trip: mask `![[embed]]`, `[[wikilink|alias]]` and `[!callout]` before parse, run `mdast-util-to-markdown`, restore after stringify. This is the [20/21 spike](/cyberbaser/research/v1-architecture/#blockmarkdown-fidelity--the-keystone-rd) in `spikes/ofm-roundtrip/`, hardened into a package with the 21 fixtures as its test suite.

**Where it runs.** Wherever markdown is written: inside `cb-edit` in the browser, inside `cb-intake` on the server, and inside CI as a fixture check. It is a library, not a service. It never opens a socket.

**State it holds.** None. Pure function, markdown in, markdown out.

**Who can call it.** Any code that imports it. No trust boundary.

**If it dies.** A library does not go down; it ships a bug, and the failure mode is silent content corruption, which is the worst failure in the system. Two defenses, both cheap: the 21 fixtures gate every commit, and `cb-edit` runs a self-check before it will let anyone save. It parses and re-serializes the *unedited* document first, and if that is not byte-identical it disables the save button and falls back to the "edit on GitHub" path. The widget refuses to write to any file it cannot prove it can write back cleanly. That property is worth more than any amount of fixture coverage, because it holds for vault content nobody wrote a fixture for.

**The forge provides:** nothing. This is the moat, and no forge, CMS or SSG has it.

## H2 · `cb-edit` (the edit widget)

**What it is.** A CodeMirror 6 editor plus a submit flow, bundled as a static asset the renderer includes on every page. Click "Suggest edit," the widget fetches the raw source of the current file, opens it in CM6 with `cb-serializer` masking active, and offers one action: submit.

**Where it runs.** Entirely in the reader's browser, served as static files from the same site. No build-time coupling to the renderer beyond a `<script>` tag and a `data-source-path` attribute, which is what keeps [renderer-agnosticism](/cyberbaser/design/architecture/#boundaries-what-each-part-must-not-do) a boundary rather than an abstraction layer.

**State it holds.** A draft in `localStorage`, keyed by source path, and nothing else. It holds no session, no token, and no copy of the vault. This satisfies the boundary rule that edit surfaces must "keep content outside the vault" never (`design/architecture.mdx`, line 255).

**Who can call it.** Any reader. No account, no auth. That is the point.

**If it dies.** The JavaScript fails to load and the page is still a complete, readable static page. The footer "Edit this page on GitHub" link still works, so Path C is untouched, and Paths B and C are unaffected in any case. The widget is progressive enhancement over a static site, which is the only design that satisfies [Principle 4](/cyberbaser/getting-started/principles/#4-every-contribution-path-must-work-independently) without effort.

**The forge provides:** nothing. GitHub's web editor is a different product for a different user, and the [minimum viable contribution set](/cyberbaser/design/contribution-workflows/#minimum-viable-contribution-set) explicitly benchmarks against it rather than adopting it.

## H3 · `cb-intake` (the anonymous write endpoint)

Covered in full below under [The anonymous write endpoint](#the-anonymous-write-endpoint). In summary: one small HTTP service, self-hosted, holding one bot credential and one 24-hour rate-limit ledger, reachable only through a Cloudflare Tunnel.

## H4 · `cb-triage` (trust-curve enforcement)

**What it is.** A CI job that reads `.github/trusted-contributors.yml`, classifies the incoming diff, applies a label, and enables auto-merge only for the one cell in the [review model table](/cyberbaser/design/contribution-workflows/#review-model) that allows it: a typo-level fix from a trusted contributor. Everything else gets labelled and left for the maintainer. The classifier is small and deliberately conservative: single file, under some line threshold, no frontmatter change, no heading change, no link target change, no new file. Anything ambiguous is not a typo fix.

**Where it runs.** The forge's CI runner, on pull-request events.

**State it holds.** None of its own. The trust list is a file in the repo, so the trust curve is version-controlled, reviewable, and reverted by a git revert. There is no trust database.

**Who can call it.** The forge, on events. Never callable directly.

**If it dies.** Auto-merge stops happening and every PR waits for the maintainer. The system degrades to "all edits are moderated," which is the safe direction. A failure of `cb-triage` can never cause an unreviewed merge, because auto-merge is opt-in per PR rather than a default with an exception.

**The forge provides:** most of it. Branch protection, CODEOWNERS, required checks and auto-merge are all forge features. What the forge does not provide is the *classifier*, the ~80 lines that decide whether this particular diff is trivial. That is the only new code in the trust curve.

## H5 · `cb-preview` (per-PR rendered previews)

Covered in full below under [Per-PR rendered previews](#per-pr-rendered-previews). In summary: two CI jobs, split across a trust boundary, publishing each PR's build into a subpath of a second GitHub Pages site on its own origin.

## H6 · `publish.yml` (what is publishable and what is writable)

**What it is.** One file at `.cyberbaser/publish.yml`, holding include and exclude globs. Nothing else. It exists because the dogfood vault "mixes cyber reference material with journals, finance notes, and resumes" ([Legal & Governance](/cyberbaser/design/legal-and-governance/#mixed-vaults-carve-out-what-isnt-for-reuse)), and the only mitigation currently written is a license carve-out. A license carve-out is a legal statement about content that is already published. It is not access control.

**Where it runs.** It does not run. It is read at two enforcement points: the site build, which will not render an excluded path, and `cb-intake`, which returns 403 for a write to an excluded path.

**State it holds.** It *is* the state, and it lives in git, so the publish boundary has a history and a blame view.

**Who can call it.** The build and the intake service, both of which read it from the repo.

**If it dies.** Fail closed in both readers. A missing or unparseable `publish.yml` means the build publishes nothing new and the intake service accepts nothing. Never fail open on a file whose whole job is to keep the journal off the internet.

**The forge provides:** nothing, and it structurally cannot. Sub-repo access control is one of git's two [structural zeros](/cyberbaser/research/source-of-truth/) identified by the SSOT research. This is the v1 floor of the maintainer's "flexibility of access" requirement: a public/private split by path. Roles, per-user rules and encryption are v2. Two globs lists, two enforcement points, no ACL system.

## F1 · Moderation queue

**What it is.** The forge's pull-request list, filtered by label. There is no cyberbaser moderation UI in v1.

**Where it runs / state / callers.** The forge, entirely.

**If it dies.** Contributions queue up in `cb-intake`'s retry buffer for as long as it holds them, then fail visibly to the contributor with a "try again later" message. Nothing is lost, because nothing was ever accepted.

**The forge provides:** all of it, with one exception, which is the rendered preview the written policy commits to. See below.

## F2 · Trust-curve state

`.github/trusted-contributors.yml` as specified in [contribution-workflows.mdx](/cyberbaser/design/contribution-workflows/#review-model), line 106, plus branch protection settings in the forge. Moving someone onto the list is a commit, which is exactly the "conscious act" the policy already describes. **The forge provides:** the enforcement. Cyberbaser provides the file format and the classifier (H4).

## F3 · Write-back path

Merge to `main` fires the existing `.github/workflows/deploy.yml`, which builds and deploys via `actions/deploy-pages@v4`. This already works and needs no new code. **The forge provides:** all of it.

## F4 · Attribution

For identified contributors, the commit author is the contributor and the forge does this for free, exactly as [contribution-workflows.mdx](/cyberbaser/design/contribution-workflows/#attribution) line 122 says. The half-day of work is for the anonymous case, where `cb-intake` has to synthesize an author: a fixed bot identity in `Author`, a stable pseudonymous submission ID in a `Co-authored-by`-free trailer, and no IP address anywhere in the repo. Git history is permanent, so anything written into it is written forever, which makes "never put a network identifier in a commit" a hard rule rather than a preference.

---

## Testing the 80% claim

The critics' claim is that the forge already provides about 80% of the hub, so v1 is glue plus one library. Checked against the BOM, the claim is **directionally right and quantitatively wrong, and the wrong number matters.**

By component count, the forge fully provides four of ten rows and most of a fifth. That is closer to 45%. By build cost, the forge covers 1.5 of 22.5 days, or about 7%. Neither number is 80%.

The reason the claim still *feels* true is that it is measuring the right thing under the wrong name. Here is the accurate version:

> **The forge provides essentially 100% of the durable state and 0% of the translation.**

Every piece of state that matters in v1 lives in the forge: the content, the history, the queue, the trust list, the attribution, the review record, the publish boundary. The only state anywhere else in the system is `cb-intake`'s 24-hour rate-limit ledger, and that ledger can be deleted at any moment with no consequence beyond a brief window of relaxed limits. That is the sharp, useful claim, and it is stronger than the 80% version: **the v1 hub is stateless except for one disposable cache.** No backups, no migrations, no data-loss scenario, no GDPR surface in the product.

Three things the forge specifically does not provide, and one qualifier:

1. **The serializer (H1).** No forge, CMS or SSG round-trips Obsidian-flavored markdown losslessly. Verified across the [v1 architecture research](/cyberbaser/research/v1-architecture/#the-keystone-lossless-round-trip): TinaCMS, Decap and Sveltia each corrupt some subset on save.
2. **The edit widget (H2).** The forge's web editor requires an account and shows raw text. It cannot be the anonymous path and it cannot be the in-place path.
3. **Per-PR rendered previews (H5).** The forge provides CI and one Pages environment. The written moderation policy needs many. Detailed below.
4. **The publish boundary (H6).** Not on the critics' list and it should be. Git has no sub-repo access control, and a public repo with journals in it is a live present-tense risk, not a v2 feature request.

And the qualifier that undercuts the 80% framing most: **the forge provides 80% of the hub only for contributors who have forge accounts.** The [locked contribution model](/cyberbaser/getting-started/vision/) says accounts are never forced. For the anonymous path, which is the one that distinguishes this project from "a repo with CONTRIBUTING.md," the forge provides the merge target and nothing else. H1, H2 and H3 exist precisely because that path has no forge support at all.

---

## Per-PR rendered previews

### The problem, stated exactly

The moderation policy in [contribution-workflows.mdx](/cyberbaser/design/contribution-workflows/#the-policy-concretely-cyberbases-own) line 112 commits the maintainer to reviewing "the rendered preview (not just the diff)," and line 118 asserts that "every PR gets a preview deployment from the same pipeline that builds the site." The pipeline in `.github/workflows/deploy.yml` deploys through `actions/deploy-pages@v4` into a single environment named `github-pages`, under a `concurrency` group of `pages` (lines 16 to 18 and the `deploy` job). GitHub Pages serves [one site per repository](https://docs.github.com/en/pages/getting-started-with-github-pages/about-github-pages). There is no per-PR environment, and adding one is not a configuration flag.

The [vision page](/cyberbaser/getting-started/vision/) sharpens the requirement further: at 09:14 the maintainer "approves it on their phone during coffee." Any preview mechanism that requires a local checkout fails the phone test, and the phone test is the whole ergonomic claim of the moderation model. So "check it out locally" is not an acceptable v1 answer, only an acceptable fallback.

### The mechanism

**One preview site, many subpaths, on its own origin, built by a split-trust workflow pair.**

A second repository, `cyberbase-previews`, with GitHub Pages enabled and a custom domain such as `previews.example.org`. Each PR's build lands at `previews.example.org/pr-123/`. The one Pages environment per repo constraint is real, but it constrains *environments*, not *directories*, and a single static site can hold hundreds of independent builds side by side.

Two jobs, because of a security boundary that cannot be skipped:

1. **Build job**, triggered on `pull_request`. Runs the contributor's content with a read-only token and no secrets, builds the site with the base path overridden to `/pr-<n>/`, and uploads the result as a workflow artifact. This job is where untrusted content executes, so it can do nothing but produce a zip.
2. **Publish job**, triggered on `workflow_run` completion of the build job. Runs from the base branch's trusted code with a deploy credential, downloads the artifact, and commits it into the previews repo under `pr-<n>/`. It never checks out the contributor's branch.

This is the [pwn-request-safe pattern](https://securitylab.github.com/resources/github-actions-preventing-pwn-requests/) GitHub's own security team documents. The naive version, running `pull_request_target` over a fork's code, hands repository write access to anyone who opens a PR, which in this system means handing them the vault.

Three details that are easy to get wrong and expensive to discover late:

- **Base path.** `astro.config.mjs` hardcodes `base: '/cyberbaser'` (line 23) and `site: 'https://cybersader.github.io'` (line 22). Both have to become environment-overridable before previews work at all, or every asset URL in the preview 404s.
- **Origin isolation is not optional.** A preview of a fork PR is attacker-authored markdown rendered to HTML. If it is served from `cybersader.github.io`, it shares an origin with the real site and with every other project on that account. A custom domain on the previews repo puts it on a separate origin, which is why the custom domain is part of the mechanism rather than a nicety.
- **Garbage collection.** A weekly scheduled job deletes `pr-<n>/` directories for closed PRs. Without it the previews repo grows without bound and eventually becomes the largest thing in the account.

### The gate, split correctly

Line 118 says "if the preview fails to build, the PR can't merge." Keep that, but split the two checks. **The build is a required status check** and blocks merge, because a PR that breaks the site must never merge. **Publishing the preview is best-effort** and does not block, because a transient failure in the previews repo should not hold up a typo fix. Conflating them makes the previews repo a hard dependency of merging, which is a worse failure mode than reviewing a diff without a preview once in a while.

### Runners-up

- **Cloudflare Pages preview deployments.** Half a day instead of three, and genuinely excellent. Rejected because it makes Cloudflare a *host*, which [R04](/cyberbaser/design/reference-architectures/self-hosted-forgejo-auth/) explicitly forecloses ("Cloudflare is edge-only, never the host"), and because a preview host is a renderer host: the moment previews live at Cloudflare, the deploy pipeline has two targets and the swappable-spoke boundary starts leaking. Reconsider only if a maintainer explicitly relaxes R04.
- **Artifact download plus local serve.** Zero days, works today, and fails the phone test.
- **`gh pr checkout` and a local build.** Zero days, best fidelity, fails the phone test and costs the maintainer minutes per PR on a 9p WSL filesystem where no build has ever been timed.

Keep the local checkout documented as the fallback for the case where the preview job fails, since the maintainer will need it anyway.

---

## The anonymous write endpoint

### The constraint ambiguity, resolved

Is a Cloudflare Worker "edge" or "compute"? [RA-01](/cyberbaser/design/reference-architectures/self-hosted-forgejo-auth/) answers it implicitly and then the answer gets lost: its trade-off table describes the target state as "Cloudflare is a **dumb edge only** (tunnel/WAF), no compute, no secrets," and it treats the Worker OAuth proxy as a thing PKCE deleted, celebrating the deletion of "the only piece of *compute* and the only *secret* that previously had to live at Cloudflare."

So the project has already made this call once. Stating it as a rule so it stops being re-litigated:

> **A Cloudflare component is "edge" if it holds no cyberbaser secret and can see no submission content in the clear. Otherwise it is compute, and compute belongs on the maintainer's box.**

Under that rule, WAF, rate-limiting, DDoS protection, TLS termination and Turnstile verification are edge. A Worker that holds a git write token and reads a contributor's submitted markdown is compute, and it is disqualified. Not because Workers are bad, but because that Worker would hold the single most dangerous credential in the system on infrastructure the project has declared it does not want to depend on.

### Where it runs

`cb-intake` is a small HTTP service (a single container) on the maintainer's box, in the same Docker Compose stack as Forgejo in RA-01, reachable from the internet only through a [Cloudflare Tunnel](https://www.cloudflare.com/products/tunnel/). No inbound ports open. Same stack, same operational burden, one more container. This is the piece that answers "where does the hub runtime live," and the answer is: next to the forge, on your own hardware, and it is the only one.

### What it does

Accepts a submission of `{path, base_commit, new_content, note, turnstile_token}`. Verifies the Turnstile token, checks the rate-limit ledger, validates the path against `publish.yml`, verifies the content round-trips through `cb-serializer`, then commits to a **bot-owned fork** and opens a cross-repo pull request.

The fork is the load-bearing security decision. The bot's credential has write access to a fork and no access to the canonical repo. A total compromise of `cb-intake` therefore yields the ability to open pull requests, which is a capability anonymous strangers already have by design. It does not yield write access to the vault. It also means unreviewed content never enters the canonical repository's object store, which matters more than it sounds: git history is permanent, and a rejected submission containing illegal content, personal data or malware would otherwise be in the canonical repo's objects forever even after the branch is deleted.

### Rate limiting, in four layers

1. **Edge, per IP.** A [Cloudflare rate-limiting rule](https://developers.cloudflare.com/waf/rate-limiting-rules/) on the intake hostname. Free-tier gives one rule, which is enough for one endpoint. This is the layer that absorbs volumetric abuse before it reaches the box, and it is the layer the [problem page already assigns to the edge](/cyberbaser/concepts/problem/#contribution-on-your-terms).
2. **Proof of humanity.** A [Turnstile](https://www.cloudflare.com/products/turnstile/) token required on every submission. Turnstile is the right choice specifically because it does not require an account and usually does not require an interaction, so it costs the anonymous path nothing it was designed to protect.
3. **Application, per bucket.** A token bucket in the ledger, keyed on hashed IP, on the /24, and on the target path. Roughly three submissions per hour per IP, ten per day per /24, two per day per page. Numbers to tune, layers not to skip.
4. **Circuit breaker.** A global cap on open bot PRs. Above the cap, the endpoint returns 503 and stops opening pull requests entirely until the maintainer drains the queue. This is what makes the worst case bounded: the maximum damage a determined attacker can do is fill the queue to the cap once.

Plus the static limits: 256 KB body, one file per submission, no new files in v1, and rejection of any submission whose content does not survive `cb-serializer` unchanged.

### The abuse surface, enumerated

| Vector | Bounded by |
|---|---|
| Volumetric flood | Edge rate-limit, before it reaches the box |
| Distributed low-rate spam | Turnstile plus the per-page bucket plus the circuit breaker |
| Maintainer-attention exhaustion | The circuit breaker; the cap is the real defense, not the filters |
| Malicious content in a rendered preview | Preview served from a separate origin (H5) |
| Illegal content entering permanent history | Bot fork, so nothing unreviewed touches the canonical object store |
| Credential theft from `cb-intake` | The token only writes to the fork |
| Writes to personal folders | `publish.yml` checked server-side; the widget's absence of an edit button is not a control |
| CI-minute exhaustion | Preview builds only run for PRs the maintainer has labelled, not automatically on bot PRs |
| Deanonymization of contributors | No IP in git; hashed IP in the ledger only, with a 24-hour TTL |

The last CI row deserves a note: running a preview build on every anonymous submission converts a spam flood into a bill. Gate preview builds on a label the maintainer applies, or on the contributor being on the trusted list.

### Runners-up

- **Cloudflare Worker plus a KV ledger.** Half the build cost, no box to run, and genuinely the pragmatic choice for someone without always-on hardware. Rejected on the rule above: it puts the vault write credential and the plaintext of every submission on third-party compute. Document it as the explicit exception path for maintainers who do not self-host, and be honest that taking it means Cloudflare is compute.
- **A hosted contribution bot ([Staticman](https://staticman.net/), [Contribunator](https://github.com/Contribunator/Contribunator), PRB0t).** Same shape, someone else's uptime, and the same credential problem plus a dependency on a project with unclear maintenance. Useful as prior art for the design; not as the deployment.
- **`repository_dispatch` from a static form service.** Still requires a credentialed endpoint somewhere. Moves the problem, does not solve it.

---

## What is explicitly NOT a service in v1

Write this list down so the scope cannot re-inflate. Each of these has been argued for somewhere in the research, and each is a "no" for v1 with a reason.

- **No moderation UI.** The queue is the forge's PR list. Building a review interface duplicates a mature product to gain a label filter.
- **No user database, no accounts, no sessions.** [R03](/cyberbaser/getting-started/vision/) locks accounts as never forced. The trust curve is a YAML file. If cyberbaser ever needs a session store, something has gone wrong upstream.
- **No trust-score engine.** Discourse-style trust levels are the *inspiration* for the model, not a component to implement. Trust is a list, and moving someone onto it is a commit.
- **No renderer adapter layer.** Renderer-agnosticism is a boundary rule in the [boundaries table](/cyberbaser/design/architecture/#boundaries-what-each-part-must-not-do), enforced by `cb-edit` needing only a script tag and a source path. An abstraction layer over SSGs is code written to satisfy an adjective.
- **No content API, no sync daemon, no webhook fan-out.** The forge's events and CI cover every trigger v1 has.
- **No search service.** Pagefind is sufficient under 5,000 pages, and it is a build step, not a deployment.
- **No media service.** Assets live in the repo in v1. R2 becomes a question at a size the vault has not been measured at yet.
- **No federation anything.** Registry, discovery, cross-KB identity: all v2+, all named in the vision, none of them a v1 deployable.
- **No RBAC engine.** The v1 answer to "flexibility of access" is `publish.yml` with include and exclude globs. Roles, per-user grants and encrypted subtrees are v2, and they are the same [structural gap in git](/cyberbaser/research/source-of-truth/) that federation is.
- **No real-time collaboration, no CRDT, no presence.** Deferred in the v1 architecture and still deferred.
- **No hub-side copy of content, ever.** The boundary rule says the hub must not "hold content state outside the commit it produces" (`design/architecture.mdx`, line 253). Every component above obeys it, which is the single reason the system is this small.

The test to apply when something new wants to become a service: **does it hold state that is not in git?** If yes, it needs an explicit argument, and in v1 exactly one component passes that test, holding one disposable ledger.

---

## Task list

Sequenced. Later items depend on earlier ones. Days are solo part-time maintainer-days.

| # | Task | Days | Depends on | Why now |
|---|---|---|---|---|
| 1 | Make `astro.config.mjs` `site` and `base` environment-overridable; verify a build at a non-root base path | 0.5 | none | Blocks previews entirely; cheapest possible unblock |
| 2 | Write `.cyberbaser/publish.yml` for the dogfood vault and enforce it in the build (fail closed on missing or unparseable) | 2 | none | Personal content in a public repo is a present risk, not a v2 feature |
| 3 | Harden `spikes/ofm-roundtrip/` into `cb-serializer`: package it, wire the 21 fixtures as CI, add the self-check API | 4 | none | Everything downstream imports it |
| 4 | Build `cb-preview`: the `pull_request` build job, the `workflow_run` publish job, the previews repo, the custom domain, the GC job | 3 | 1 | The written moderation policy is currently uncheckable |
| 5 | Write `.github/trusted-contributors.yml`, turn on branch protection, require the preview build check | 1 | 4 | Makes the review-model table real |
| 6 | Build `cb-triage`: the trivial-diff classifier and the auto-merge enablement | 2 | 3, 5 | The only new code in the trust curve |
| 7 | Build `cb-edit`: CM6, masking, source fetch, draft persistence, submit, and the round-trip self-check gate | 6 | 3 | The in-place edit path, the thing no forge provides |
| 8 | Build `cb-intake`: Turnstile, four-layer rate limiting, `publish.yml` check, bot-fork commit, cross-repo PR, anonymous attribution | 4 | 2, 3, 7 | The one server; last because it is only useful once the widget can call it |
| 9 | Deploy `cb-intake` into the RA-01 compose stack behind a Cloudflare Tunnel; configure the edge rate-limit rule | 1 | 8 | Where the hub runtime actually lives |
| 10 | Update `design/architecture.mdx` to replace the "where does the hub runtime live?" open question with a link to this page | 0.5 | 9 | Same-session knowledge-ops rule; a stale question sends fresh agents in an old direction |

**Total: 24 days.** Items 1 through 3 are independent and can start in any order. Item 4 is the highest-value early item, because it is the one that makes the already-written moderation policy true rather than aspirational.

## Related

- [Architecture](/cyberbaser/design/architecture/) · [Contribution workflows](/cyberbaser/design/contribution-workflows/) · [Legal & Governance](/cyberbaser/design/legal-and-governance/)
- [RA-01 · Self-hosted Forgejo + PKCE auth](/cyberbaser/design/reference-architectures/self-hosted-forgejo-auth/) — the stack `cb-intake` deploys into
- [The v1 architecture (Phase R findings)](/cyberbaser/research/v1-architecture/) — the research this decomposes
- [SSOT findings](/cyberbaser/research/source-of-truth/) — why `publish.yml` exists rather than an ACL system

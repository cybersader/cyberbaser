# 41 — Resolved Questions

> **Status**: 🌳 Live decision log. Move entries here from `40-QUESTIONS-OPEN.md` when answered. Preserve the *why*, not just the what.

## Log

### [R01] Is git the right single source of truth?
- **Asked**: 2026-04-11 · **Resolved**: 2026-06-17
- **Answer**: Yes, **scoped**. Git stays the SSOT as the *current manifestation*, not the essence, with an explicit off-ramp if a loss-free markdown↔block serializer ever ships.
- **Rationale**: 14-agent challenge run (`research/source-of-truth.mdx`): git scored 21/26; its two structural zeros (sub-repo access control, federation) are exactly the v2+ pillars, but no alternative fixes them without breaking the plain-`.md` constraint.
- **Consequence**: Principle 1 renamed to "A single source of truth you own"; the layer never forces git on contributors.

### [R02] What *is* cyberbaser, in one phrase?
- **Asked**: 2026-04-11 (roadmap "identity" task) · **Resolved**: 2026-06-20
- **Answer**: **An interoperability layer for contributable, version-controlled knowledge bases.** Category word: "layer."
- **Rationale**: 12-agent essence panel + maintainer's own choices. "Publishing tool" is a dead frame (Quartz wins it); "CMS/contributability layer" drops the interoperability half. The category-defining move is the inversion: the content owns itself; every tool is a replaceable adapter.
- **Consequence**: every page leads with the essence; "Obsidian Publish successor" framing stays private; general-not-cyber locked (cyberbase = dogfood).

### [R03] What's the contribution/identity model?
- **Asked**: Phase-R (auth model task) · **Resolved**: 2026-06-19/20
- **Answer**: Maintainer-set **trust curve + moderation queue**. Accounts never forced; an account is a trust signal, not a wall. "Contributable, not controllable."
- **Rationale**: identity gates are mostly theater (email aliasing is trivial; a GitHub-account wall filters out the domain expert you want). The real question is "can this hurt anything before a human approves it?" — moderation is the load-bearing mechanism. DoS is a separate, edge-layer problem.
- **Consequence**: GitHub OAuth scoped to the Decap path only; the serverless contribution-bot pattern is the zero-account path to evaluate; compose existing tools (Discourse-style trust, moderation tooling), don't build from scratch.

### [R04] Where does this get hosted, and on whose infrastructure?
- **Asked**: Phase-R · **Resolved**: 2026-06-19/20
- **Answer**: **GitHub Pages** is the current deploy target (`actions/deploy-pages@v4`). **Self-hosting is preferred** for anything needing identity (Forgejo). **Cloudflare is edge-only** (CDN/WAF/rate-limit), never the host. **No AWS/GCP, ever** (maintainer constraint).
- **Rationale**: GitHub-trust concern + self-host preference; RA-01 showed Decap/Sveltia authenticate directly via PKCE against Forgejo's built-in OIDC — the OAuth proxy and its secret disappear entirely on the self-hosted path.
- **Consequence**: the old "Cloudflare Pages (current choice)" framing was purged site-wide in the vision sweep; RA-01 is the reference architecture.

### [R05] Is the lossless round-trip actually achievable?
- **Asked**: 2026-04-11 (the keystone doubt) · **Resolved**: 2026-06-17 (empirically)
- **Answer**: Yes — the `spikes/ofm-roundtrip/` spike round-tripped **20/21 fixtures**, via a markdown-first path (block model = the OFM AST; markdown as serialization, not lossy export).
- **Rationale**: right-sized to an afternoon go/no-go per the red-team, instead of a multi-week keystone build.
- **Consequence**: unblocks block-grade editing UX and the SSOT off-ramp; leading candidate stack = `mdast-util-to-markdown` + CodeMirror 6 (swappable spokes).

### [R06] Is the hub or the renderer the product?
- **Asked**: implicit since Phase 0 · **Resolved**: 2026-06-19/20
- **Answer**: **The hub** (round-trip translation + trust/moderation + federation later), and it must stay **renderer-agnostic**. SSG renderers are swappable commodity spokes.
- **Rationale**: tested Quartz audit — Quartz v5 beats our own prototype on OFM fidelity for free, and its maintainer publicly closed CMS/web-editor requests as out of scope. Forward publishing is commoditized; the reverse direction is structurally impossible in any SSG and genuinely unclaimed.
- **Consequence**: never couple the hub to one SSG; Astro/Starlight demoted to "current prototype" everywhere.

### [R07] Where does the canonical knowledge base live (knowledge-ops)?
- **Asked**: 2026-06-21 (meta-layer drift discovered) · **Resolved**: 2026-06-21
- **Answer**: The **docs site** (`docs/src/content/docs/`) is the canonical KB. The `.claude/` numbered files are pointer stubs with greppable summaries; `PROJECT_CONTEXT.md` + `FOCUS.md` are the orientation layer.
- **Rationale**: the numbered files froze in April while the docs matured through research + the vision sweep — two disagreeing brains, and agents read the stale one first. One canonical home per fact; the orientation layer must be updated in the same session as any locked decision.
- **Consequence**: 12 numbered files converted to stubs; roadmap exit criteria re-anchored to docs pages; CLAUDE.md updated.

### [R08] Does v1 need external demand validation before building?
- **Asked**: 2026-06-19 (red-team #1 meta-risk) · **Resolved**: 2026-06-21
- **Answer**: **No.** The maintainer is user #1 and will use it regardless — dogfooding is the v1 validation. External demand becomes a growth/adoption question, not a build gate.
- **Rationale**: maintainer decision; the red-team's "unverified demand" risk applied to a product framing, not a dogfood-first tool.
- **Consequence**: the Phase-R open gate shifts to the cheap falsification tests (PR probe, moderation policy, LICENSE) and the zero-account path; CMS/plugin hands-on unblocks after those.

### [R09] Which of the three competing v1 shapes do we build?
- **Asked**: 2026-07-25 (six-agent design pass produced three shapes that disagree on what the product is) · **Resolved**: 2026-07-25 (as a *process* decision — the shape itself is still open)
- **Answer**: **Decided by measurement, not argument.** Run the gate first: `spikes/ofm-roundtrip/` pipeline D against all ~1445 real vault files + the full census, decision rule fixed in advance (≥99% byte-identical → round-trip is a floor, governance-led shapes lead; <95% → serializer-first shape leads). Nothing locks into FOCUS/roadmap until the number exists.
- **Rationale**: maintainer decision 2026-07-25. The dissent and option-space passes independently converged on the same falsification test, and the four-critic consensus had already been partially overturned by the dissent — locking a shape on argument alone repeats the mistake the critique documented.
- **Consequence**: old What's-Next items (zero-account bot evaluation, 3-way CMS bake-off, plugin execution testing) retired; three shapes published as proposals under `/cyberbaser/research/` (v1-build-plan is the reconciliation); FOCUS.md re-sequenced around triage → gate → lock.

### [R10] Who owns mixed-privacy, RBAC, and real-time collaboration?
- **Asked**: 2026-07-02 (maintainer's access-flexibility requirement, uncaptured until now) · **Resolved**: 2026-07-25
- **Answer**: **Not cyberbaser.** A private sibling project (browser-hosted Obsidian; see `.workspace/sibling-boundary-analysis.md`, gitignored) owns the authenticated/tenanted/role-gated half: folder-level access control, real-time collaboration, per-user runtimes. Cyberbaser owns the anonymous/public half: rendered static site, publish boundary (visibility, not identity), async moderated contribution. v1 access-flexibility answer = the publish boundary; v2 role-based sketch lives in `/cyberbaser/research/proposal-selective-publishing/`.
- **Rationale**: the orientation layer had misattributed the browser-Obsidian role to Retake Forge (wrong project); once corrected, the sibling's shipped capabilities cover exactly git's two structural zeros from the SSOT research. Duplicating them in cyberbaser would rebuild a running system.
- **Consequence**: sibling entries corrected in CLAUDE.md / PROJECT_CONTEXT.md / FOCUS.md (generic in public files, full analysis private); "Deliberately NOT Doing" now lists mixed-privacy/RBAC/real-time as assigned elsewhere; the access-flexibility requirement is captured in the selective-publishing proposal.

### [R11] Is the personal content in the public vault an exposure requiring remediation?
- **Asked**: 2026-07-25 (raised by the plan critique and the selective-publishing proposal) · **Resolved**: 2026-07-25
- **Answer**: **No — waived.** The maintainer has been intentional about what is in the public `cyberbase` repo; there is no secrets-scan / history-purge / repo-split remediation track.
- **Rationale**: maintainer decision, same day. The critique's framing assumed unintentional exposure; the maintainer states the current public content is deliberate.
- **Consequence**: FOCUS's triage step removed; the roadmap Phase 3 gate reworded from safety-blocker to feature-prerequisite. **Selective publishing survives as a feature** (the publish boundary implementing the access-flexibility requirement: "one private page, rest public" and eventual role-based tiers) — it is a Phase 3 prerequisite, not an emergency. The proposal page's exposure framing stands as analysis but does not drive sequencing.

### [R12] The v1 shape (resolves the R09 gate)
- **Asked**: 2026-07-25 (R09) · **Resolved**: 2026-07-25, same day, by measurement
- **Answer**: **Byte-preservation by construction, validation as the product.** Pipeline D over all 1430 real vault files: **4.6% byte-identical** (36.9% even with vault-tuned stringify options), zero mask leaks, zero parse errors, failures dominated by formatting normalization not OFM damage. Both decision-rule branches had a false premise: the serializer isn't "unbuilt," it's *unbuildable as a whole-file re-serializer* — AST round-trips are architecturally incapable of byte fidelity on real formatting diversity. Locked: (1) **no whole-file re-serialization in the write path, ever** — raw-text splice-only editing (GitHub web editor interim, CM6 raw widget later); (2) **`@cyberbaser/ofm` is a validator, not a writer** — corpus runner + diff classifier + masking core, aimed at third-party writers that DO re-serialize (CMS candidates, Notion sync); (3) the moat restated as byte-preservation + mechanical validation + governance.
- **Rationale**: the gate measurement (R09 procedure, results in `/cyberbaser/research/v1-build-plan/`). The dissent's prediction confirmed: 20/21 was a property of fixtures written in remark's output style. **R05's consequence was over-claimed** — the spike proved masking protects OFM constructs through a parse (true, still stands), not that real files round-trip (false).
- **Consequence**: Q04 enforcement re-scoped to "no construct damage in a change" (not whole-file re-serialization survival); **Q05 closed** (full pass = 7.3 s on ext4; scale was never the problem); binary/LFS check closed (0 files >100 MB; 725 MB tree → publish boundary must exclude unreferenced assets for the Pages 1 GB cap); all bench/build work on ext4 (measured ~780x penalty on /mnt/c for many-small-file reads, not 5-20x); first artifact = the `@cyberbaser/ofm` validator package.

### [R13] The Notion third writer: fence or cut?
- **Asked**: 2026-07-25 (flagged by the plan critique; audit spec in the write-path proposal) · **Resolved**: 2026-07-25, empirically
- **Answer**: **Neither — it's dormant. Frozen and absorbed.** The sync (35 commits, distinct `<null>`-email signature) last ran **2024-08-20**. It was perfectly confined to `CybersaderNotion/`, wrote plain CommonMark (1681 md-links, zero wikilinks — nothing OFM to corrupt), but mirrored by delete-and-recreate (1570 deletions, paired 1574/1560-file commits). Decision: the last export is absorbed as an ordinary maintainer-owned subtree; the sync may not restart in its historical form (meets two cut triggers); any future Notion import returns as a fenced PR-bot through the ofm-check-gated queue.
- **Rationale**: full audit on the history clone, results + commands in `/cyberbaser/research/notion-writer-audit/`. The "live third writer" premise in the risk register was false — the repo description advertising the sync misled every analysis including our own.
- **Consequence**: the two-owner overwrite hazard is currently zero; the writers-manifest concept survives as the shape for any future automated writer; recommend updating the cyberbase repo description to stop advertising the live sync.

### [R14] The vault renderer: Quartz, adopted on measurement
- **Asked**: 2026-06-19 ("worth a spike", never scheduled) · **Resolved**: 2026-07-25, by the pre-stated D1 kill criterion
- **Answer**: **Adopt Quartz for the vault site** (Starlight keeps the project docs; two spokes, permanently). Real vault, ext4: 1420 pages in 1:55, 2.42 GiB RSS, exit 0, **20/20 OFM checklist by grep**. Q02 (`astro-loader-obsidian` sufficiency) closed as not-applicable. **Filename policy settled with it**: census found 0 slug collisions and 2 total lint violations across 4,183 paths — the safety lint replaces the mass rename, which is dead.
- **Rationale**: `/cyberbaser/research/quartz-spike-results/` (condensed; raw in `.workspace/`). Kill criterion was stated before the run.
- **Consequence**: pre-publish list = publish.yml authoring (maintainer) · projection wiring (selector → lowercase/alias → frontmatter pre-flight → Quartz) · 2 renames + 4 frontmatter kill-switch files + Templates/ ignore · derived-path lint + output link-check (Quartz reports zero broken links; truth is 5.7%) · **open sub-decision: Quartz v4.5.2 (measured) vs v5 (current upstream)**. `@cyberbaser/publish` v0.1 ships the selector + slug contract + lint, 91 tests green.

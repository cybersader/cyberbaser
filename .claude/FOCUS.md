# Cyberbaser — Current Focus

> Update when direction changes, milestones complete, or priorities shift.

**Current:** Phase R exit, **shape locked (R12, 2026-07-25) — building.** The gate measurement ran: pipeline D over all 1430 real vault files = **4.6% byte-identical** (tuned: 36.9%), zero mask leaks, zero parse errors, failures = formatting normalization. Verdict: whole-file AST re-serialization can never reach byte fidelity, so the locked shape is **byte-preservation by construction (raw-text splice-only write path) + `@cyberbaser/ofm` as a validator (corpus runner, diff classifier, masking core) + governance**. Full results + reasoning: `/cyberbaser/research/v1-build-plan/` ("Gate result" section). First artifact in progress: the `@cyberbaser/ofm` package.

Last updated: 2026-07-25 (evening — R09 gate run, R12 locked)

## Locked This Cycle (do not relitigate without new evidence)

- **Identity / essence:** *an interoperability layer for contributable, version-controlled knowledge bases.* General, not cyber (cyberbase = dogfood). Category word: "layer." Never pitch as "publishing tool / CMS / Obsidian-to-web."
- **Hub-and-spoke:** the hub (round-trip + trust/moderation + federation later) is the product and is renderer-agnostic; SSGs are swappable spokes. Quartz already wins forward publishing.
- **Contribution model:** maintainer-set **trust curve + moderation queue**; accounts never forced ("contributable, not controllable"); DoS handled at the edge, separate from content moderation.
- **Hosting/identity:** GitHub Pages current deploy target; Cloudflare edge-only; **self-hosted Forgejo preferred** (RA-01: PKCE against Forgejo OIDC, no OAuth proxy). No hyperscalers.
- **SSOT:** git, *scoped* — current manifestation, not essence, with an off-ramp (Principle 1 = "a single source of truth you own").
- **Keystone:** OFM round-trip proven 20/21 (`spikes/ofm-roundtrip/`); markdown-first block schema is the path (mdast-util-to-markdown + CodeMirror 6 leading candidates).
- **Visual language for the docs:** real-UI mockups (browser windows, file trees, diffs, review cards) with tool logos; no abstract box diagrams; equal grids; topics varied and general.

## Project State

- Phase-0 Astro + Starlight prototype: parked; publishes the research (~81 pages, 77 Playwright tests green).
- Docs site = **the canonical KB** (vision-swept 2026-06-21). `.claude/` numbered files are now pointer stubs; see `PROJECT_CONTEXT.md` → knowledge-ops map.
- Problem, ecosystem, primitives, prior art, vision, principles, architecture, translation-layer, contribution-workflows: all substantive with visuals. Roadmap exit criteria re-anchored (see `20-ROADMAP.md`).

## What's Next

**The old items 2-3 (zero-account bot evaluation, 3-way CMS bake-off, plugin execution testing) are retired** — the plan critique showed all three were pre-R08 artifacts serving contributors who don't exist yet (`/cyberbaser/research/plan-critique/`). The sequence now:

1. ~~The gate measurement~~ **RUN 2026-07-25** (results in `/cyberbaser/research/v1-build-plan/`): 4.6% byte-identical, 0 mask leaks, 0 parse errors, 83.1% of files OFM-free, 7.3 s full pass on ext4, ~780x 9p penalty measured, 0 files >100 MB. Q05 + the LFS check closed as side effects.
2. ~~Lock the shape~~ **LOCKED 2026-07-25 (R12)**: byte-preservation by construction + validator + governance. No whole-file re-serialization in the write path, ever.
3. **Build `@cyberbaser/ofm`** (~2 d, in progress): the validator package — corpus runner, two-version diff classifier, masking core, 21 fixtures + corpus-derived cases as tests, `ofm-check` CLI. The first artifact the maintainer can actually run.
4. ~~Wire the CI gate~~ **LIVE 2026-07-25** (cyberbase#4 merged, report-only): every markdown PR on the vault now gets `ofm-check` classification (clean/suspect/damage). Flip to required after the observation window by removing `continue-on-error` + branch protection. ~~Notion-leg audit~~ **DONE 2026-07-25 (R13)**: sync dormant since 2024-08, frozen and absorbed — `/cyberbaser/research/notion-writer-audit/`.
5. ~~Publish boundary + Quartz spike~~ **DONE 2026-07-25 (R14, 3-agent wave)**: Quartz **adopted** — real vault, 1:55 build, 20/20 OFM checklist; census found **0 slug collisions, 2 lint violations** (mass rename dead). `@cyberbaser/publish` v0.1 built: selector (fail-closed, byte-identical, audience-ready) + slug contract + safety lint, 91 tests green. Results: `/cyberbaser/research/quartz-spike-results/`.
6. ~~Pre-publish list + first deploy~~ **LIVE 2026-07-25 (R16): https://cybersader.github.io/cyberbase/** — 933 pages + 373 assets through projection → pinned Quartz v4.5.2 → Pages. publish.yml agent-authored/maintainer-approved (R15); v0 ships **verbatim paths** (D2 lowercase deferred to projection v2 pending an asset-alias story); CI build 160 s, deploy 16 s, 25% of cap.
7. **Next up:** (a) **pipeline link-check** (top follow-up: Quartz silently ships ~5.7% unresolved links; the 28-page `_attachments` relative-link class is the fidelity-break corpus's first entry); (b) flip `ofm-check` on the vault to required after the observation window; (c) the first real web edit landing as a splice-only commit (v1 Build exit criterion); (d) URL freeze + slug-diff gate when ready to stabilize; (e) Quartz v5 evaluation (pin stays v4.5.2 until re-measured).

**Exposure triage waived (2026-07-25, maintainer decision — R11):** the vault's public content is intentional; no secrets-scan/purge remediation track. Selective publishing stays on the roadmap as the **publish-boundary feature** (the access-flexibility requirement below), a Phase 3 prerequisite rather than a safety emergency.

**New requirement captured (2026-07-02, was never in the repo):** *flexibility of access* — role-based access must be possible, and so must a simple "one private page, rest public" split despite the hierarchical KB. v1 answer is visibility (publish boundary), not identity; v2 sketch in `/cyberbaser/research/proposal-selective-publishing/`.

**Done recently:** 2026-07-02 critique recovered + landed as `/cyberbaser/research/plan-critique/` · six-agent design pass → three shapes reconciled in `/cyberbaser/research/v1-build-plan/` (proposals: hub-bom, selective-publishing, renderer-urls, write-path; adversarial: dissent, option-space) · orientation layer corrected (stale post-R08 justification, CMS-finalist mismatch, misidentified sibling project — see `.workspace/sibling-boundary-analysis.md`, private).

## Deliberately NOT Doing Right Now

- Locking any of the three v1 shapes before the gate measurement (R09)
- Building the CMS, editor, auth, or collaboration features before the shape is locked
- Publishing the real vault before selective publishing has a mechanism (Phase 3 gate)
- Mixed-privacy, RBAC, real-time collaboration inside cyberbaser — assigned to the private sibling project (see `.workspace/sibling-boundary-analysis.md`)
- Extending the Phase-0 prototype beyond what publishing the research requires
- Relitigating locked decisions above without new evidence

## Running the Docs Site

```bash
cd docs
bun run dev          # http://localhost:4321/cyberbaser/ (dev, HMR — may be flaky on mobile)
bun run dev:host     # bind to 0.0.0.0 (Tailscale / LAN)
bun run build        # production build
bun run preview --host 0.0.0.0  # serve built output (use this for mobile testing via Tailscale)
bun run test:local   # headless Playwright suites (layout + smoke; test:e2e is --headed)
```

## Pointers to External Context

- **Live content vault**: https://github.com/cybersader/cyberbase
- **Local research vault**: Obsidian vault (local path varies by machine)
- **Identity/essence + risks**: `/cyberbaser/research/assumptions-and-risks/` · SSOT findings: `/cyberbaser/research/source-of-truth/` · v1 stack: `/cyberbaser/research/v1-architecture/`
- **Self-hosted auth**: `/cyberbaser/design/reference-architectures/self-hosted-forgejo-auth/` (RA-01)
- **Challenge briefs**: `/cyberbaser/agent-context/zz-challenges/` · **Roadmap**: `/cyberbaser/getting-started/roadmap/`
- **Sibling repos**: `cybersader/crosswalker`, `cybersader/cyberchaste`, a private browser-Obsidian sibling (boundary analysis: `.workspace/sibling-boundary-analysis.md`, not for the public repo), Sinario (cyber scenarios)

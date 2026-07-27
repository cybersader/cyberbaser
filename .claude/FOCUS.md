# Cyberbaser — Current Focus

> Update when direction changes, milestones complete, or priorities shift.

**Current:** Phase R exit, **shape locked (R12, 2026-07-25) and the local federation fixture measured (2026-07-27, no R-number).** The write path remains byte-preservation by construction plus `@cyberbaser/ofm` validation and governance. The standalone five-origin fixture passed its bounded falsification run: five logical HTTPS origins mapped through an injected transport to five stoppable loopback servers, 31 visited URLs, 14 source-qualified records, two conflicting mappings, two visible search rankings, deterministic cache rebuild, 55 private canaries with zero hits, exact-owner `410` deletion, and stale proposal rejection before apply/OFM/trust. This is controlled local compatibility, **not independent interoperability**. Next research item: publish the smallest provisional profile, fixtures, and conformance tests, then recruit one independently operated producer or consumer. Full federation result: `/cyberbaser/research/federation/`.

Last updated: 2026-07-27 (five-origin federation fixture measured; no decision lock added)

## Locked This Cycle (do not relitigate without new evidence)

- **Identity / essence:** *an interoperability layer for contributable, version-controlled knowledge bases.* General, not cyber (cyberbase = dogfood). Category word: "layer." Never pitch as "publishing tool / CMS / Obsidian-to-web."
- **Hub-and-spoke:** the hub (round-trip + trust/moderation + federation contract) is the product and is renderer-agnostic; SSGs are swappable spokes. Federation is owner-controlled publication between independent bases and ordinary meta-wikis, **never a central cyberbaser database or registry**; crawlers, graph stores, caches, and search providers are disposable spokes. The local fixture supports that boundary under controlled failure tests, but the network runtime is unbuilt, the exact profile is not R-locked, and no independent interoperability claim exists. Quartz already wins forward publishing.
- **Contribution model:** maintainer-set **trust curve + moderation queue**; accounts never forced ("contributable, not controllable"); DoS handled at the edge, separate from content moderation.
- **Hosting/identity:** GitHub Pages current deploy target; Cloudflare edge-only; **self-hosted Forgejo preferred** (RA-01: PKCE against Forgejo OIDC, no OAuth proxy). No hyperscalers.
- **SSOT:** git, *scoped* — current manifestation, not essence, with an off-ramp (Principle 1 = "a single source of truth you own").
- **Write-path rule:** the 20/21 fixture spike proved masking through a parse, but the 1,430-file gate measured only 4.6% byte identity and disproved whole-file round-tripping. All writes are raw-text splice-only; `@cyberbaser/ofm` validates and classifies damage.
- **Visual language for the docs:** real-UI mockups (browser windows, file trees, diffs, review cards) with tool logos; no abstract box diagrams; equal grids; topics varied and general.

## Project State

- Phase-0 Astro + Starlight prototype: parked; publishes the research (**98 pages** in the 2026-07-27 production build). The Playwright suite was not part of this result-document lane.
- Docs site = **the canonical KB** (vision-swept 2026-06-21). `.claude/` numbered files are now pointer stubs; see `PROJECT_CONTEXT.md` → knowledge-ops map.
- Problem, ecosystem, primitives, prior art, vision, principles, architecture, translation-layer, contribution-workflows: all substantive with visuals. Roadmap exit criteria re-anchored (see `20-ROADMAP.md`).

## What's Next

**The old items 2-3 (zero-account bot evaluation, 3-way CMS bake-off, plugin execution testing) are retired** — the plan critique showed all three were pre-R08 artifacts serving contributors who don't exist yet (`/cyberbaser/research/plan-critique/`). The sequence now:

1. ~~The gate measurement~~ **RUN 2026-07-25** (results in `/cyberbaser/research/v1-build-plan/`): 4.6% byte-identical, 0 mask leaks, 0 parse errors, 83.1% of files OFM-free, 7.3 s full pass on ext4, ~780x 9p penalty measured, 0 files >100 MB. Q05 + the LFS check closed as side effects.
2. ~~Lock the shape~~ **LOCKED 2026-07-25 (R12)**: byte-preservation by construction + validator + governance. No whole-file re-serialization in the write path, ever.
3. ~~Build `@cyberbaser/ofm`~~ **BUILT 2026-07-25**: validator package with corpus runner, two-version diff classifier, masking core, corpus-derived tests, and the `ofm-check` CLI. It is a validator, never a whole-file writer.
4. ~~Wire the CI gate~~ **LIVE 2026-07-25** (cyberbase#4 merged, report-only): every markdown PR on the vault now gets `ofm-check` classification (clean/suspect/damage). Flip to required after the observation window by removing `continue-on-error` + branch protection. ~~Notion-leg audit~~ **DONE 2026-07-25 (R13)**: sync dormant since 2024-08, frozen and absorbed — `/cyberbaser/research/notion-writer-audit/`.
5. ~~Publish boundary + Quartz spike~~ **DONE 2026-07-25 (R14, 3-agent wave)**: Quartz **adopted** — real vault, 1:55 build, 20/20 OFM checklist; census found **0 slug collisions, 2 lint violations** (mass rename dead). `@cyberbaser/publish` v0.1 built: selector (fail-closed, byte-identical, audience-ready) + slug contract + safety lint, 91 tests green. Results: `/cyberbaser/research/quartz-spike-results/`.
6. ~~Pre-publish list + first deploy~~ **LIVE 2026-07-25 (R16): https://cybersader.github.io/cyberbase/** — 933 pages + 373 assets through projection → pinned Quartz v4.5.2 → Pages. publish.yml agent-authored/maintainer-approved (R15); v0 ships **verbatim paths** (D2 lowercase deferred to projection v2 pending an asset-alias story); CI build 160 s, deploy 16 s, 25% of cap.
7. ~~The contribution loop~~ **CLOSED + PROVEN 2026-07-25/26 (R17)**: two rehearsal PRs ran the full circuit (edit → queue → `ofm-check` → merge → auto-redeploy → verified live); the gate's quotepath crash was caught by rehearsal #1 and fixed; **every page now carries "Edit this page"** (931/931 links verified). Formal criterion 3 closes when the maintainer personally clicks Edit and lands one.
8. ~~Tracks 2 + 3~~ **SHIPPED 2026-07-26 (R18)**: `@cyberbaser/linkcheck` (first real number: 1145 broken → **779** after the `RelativeFolderLinks` fix; attachment class 248 → 7), theme + the reported explorer-scroll bug (root-caused to upstream `overscroll-behavior`, verified with headless wheel events), and `@cyberbaser/trust` landed in the vault as **decision-only** labeling. After the R21 wiring audit: five packages, **165 tests green**.
9. ~~Bounded five-origin federation fixture~~ **PASSED 2026-07-27 (research result; no R-number)**: standalone `spikes/federation-fixture/`, not a production package or live URL contract. `bun test --cwd spikes/federation-fixture` passed **52 tests / 887 assertions**; 16 destructive/security tests repeated three times passed **48 executions / 648 assertions**; two `bun run --cwd spikes/federation-fixture verify` runs returned byte-identical `complete: true` JSON. Default crawl limits: depth 4, origins 5, URLs 64, redirects 8, 512 KiB/response, 4 MiB total, 1 MiB decompressed, 512 KiB parser input, 250 ms parser, 5 s wall time, concurrency 3. No actual TLS, hosts-file edit, external service, registry, global identity/trust, remote write, or interoperability claim.
10. **Next research item:** publish the smallest provisional federation profile, fixtures, and conformance tests, then recruit one independently operated producer or consumer. Until that succeeds, say **local fixture compatibility**, not interoperability. Product work still queued: (a) the identity gap (`agents:` is empty, so agent auto-merge is inert); (b) flip `ofm-check` to required after reading the R17 logs; (c) wire linkcheck into publish at the frozen R19 baseline; (d) Q06 URL freeze + slug-diff gate; (e) Quartz v5 evaluation while v4.5.2 stays pinned.

**Closed by R19 — do NOT reopen without new evidence:** the 669 remaining broken links are the maintainer's inherited content debt (old Notion exports), explicitly out of scope; the 43 emoji folder renames are declined (73 path-qualified wikilinks, and they are daily navigation). A future agent finding a pile of broken links or ugly encoded URLs should read R19 before "fixing" anything.

**Exposure triage waived (2026-07-25, maintainer decision — R11):** the vault's public content is intentional; no secrets-scan/purge remediation track. Selective publishing stays on the roadmap as the **publish-boundary feature** (the access-flexibility requirement below), a Phase 3 prerequisite rather than a safety emergency.

**New requirement captured (2026-07-02, was never in the repo):** *flexibility of access* — role-based access must be possible, and so must a simple "one private page, rest public" split despite the hierarchical KB. v1 answer is visibility (publish boundary), not identity; v2 sketch in `/cyberbaser/research/proposal-selective-publishing/`.

**Done recently:** 2026-07-02 critique recovered + landed as `/cyberbaser/research/plan-critique/` · six-agent design pass → three shapes reconciled in `/cyberbaser/research/v1-build-plan/` (proposals: hub-bom, selective-publishing, renderer-urls, write-path; adversarial: dissent, option-space) · orientation layer corrected (stale post-R08 justification, CMS-finalist mismatch, misidentified sibling project — see `.workspace/sibling-boundary-analysis.md`, private).

## Deliberately NOT Doing Right Now

- Whole-file re-serialization or a CMS writer in any write path; R12 ruled it out by measurement
- Promoting the federation fixture into a production package, live Q06 URL contract, registry, shared runtime, global identity/trust system, or remote write endpoint
- Calling controlled local fixture compatibility “interoperability” before an independently operated implementation passes the published conformance material
- Mixed-privacy, RBAC, real-time collaboration inside cyberbaser; assigned to the private sibling project (see `.workspace/sibling-boundary-analysis.md`)
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

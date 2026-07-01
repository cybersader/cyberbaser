# Cyberbaser — Current Focus

> Update when direction changes, milestones complete, or priorities shift.

**Current:** Phase R, pivoted from *writing the foundations* (now done and vision-swept) to **externally validating them**. The identity is locked, the keystone round-trip is empirically proven, and the whole docs site + `.claude/` layer now speak the same locked vision. The untested thing is no longer the tech — it's the demand and the contribution model in the wild.

Last updated: 2026-06-21

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

## What's Next (highest-severity, cheapest tests first — per the 2026-06-19 red-team)

1. **Validate the pain externally.** Get real people (2-3 KB maintainers, not just cyber) to confirm they want contributable wikis. Demand survey. *No building until this happens.* (#1 meta-risk: everything else is polished supply with unverified demand.)
2. **Cheap falsification tests** (~1 day each): LLM→vault PR probe (agent-contribution claim) · a 2-paragraph moderation policy (test the trust-curve story concretely) · commit a vault `LICENSE` (unblocks public contribution legally).
3. **Zero-account contribution path:** evaluate the serverless contribution-bot pattern (Contribunator/Staticman-style) against the trust-curve model — the honest gap left after the account-wall reframe.
4. **CMS finalists hands-on** (Decap vs Sveltia vs EmDash) and **plugin execution testing** (Obsidian CLI/headless) — only after demand is validated.

**Done recently:** vision sweep across 26 pages (identity/renderer/host/account-wall/jargon) · principles + primitives + problem + ecosystem pages rebuilt with logo-anchored visuals · Quartz prior-art audit · SSOT challenge answered · RA-01 self-hosted auth · OFM round-trip spike · `.claude/` layer de-duplicated to pointer stubs (this file).

## Deliberately NOT Doing Right Now

- Building the CMS, editor, auth, or collaboration features (research first; demand unvalidated)
- Extending the Phase-0 prototype beyond what publishing the research requires
- Filling later roadmap phases with concrete steps
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
- **Sibling repos**: `cybersader/crosswalker`, `cybersader/cyberchaste`, Retake Forge (Obsidian in the browser), Sinario (cyber scenarios)

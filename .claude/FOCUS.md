# Cyberbaser — Current Focus

> Update when direction changes, milestones complete, or priorities shift.

**Current:** Phase R deep research — mining the Cyberbase Obsidian vault for prior research + structuring a concrete research roadmap with 10 tasks following crosswalker's pattern.

Last updated: 2026-04-13

## Project State

- **Reinitialized** from dormant Phase-0 prototype to match crosswalker/cyberchaste convention (2026-04-11).
- **Docs site built out** with 54+ pages: silver+emerald theme, rotating hero ("The contributable wiki, reinvented."), layered architecture diagram, custom inline SVG components, 32 Playwright smoke tests.
- **Positioning pivoted** from "cyber-specific wiki tooling" to "the contributable wiki, reinvented" — a general platform for Obsidian-to-web wiki publishing with multiple contribution paths.
- **Vault mining in progress** (2026-04-13): extracted 300+ curated links from the Cyberbase Obsidian vault, wrote 3 decision-log entries documenting vision, tech stack, and collaboration findings. Roadmap now has 10 concrete research tasks (R01–R10).

## What's Next (in priority order)

1. **Start resolving research tasks** — beginning with R01 (identity), R02 (CMS survey), R05 (collaboration model) since these have the most vault evidence to work from
2. **Research Emdash CMS** — user-requested, needs fresh web research (not in vault)
3. **Hands-on R06 (translation layer)** — test `astro-loader-obsidian` with real cyberbase vault content against the Tier 1 feature list
4. **Fill in remaining research pages** — R03 (auth), R04 (plugin abstraction), R07–R10 each need their own `research/*.mdx` page
5. **Refine identity** — R01 drives everything. Once answered, rewrite `concepts/problem.mdx` and `getting-started/vision.mdx`

## Deliberately NOT Doing Right Now

- Building new features (Phase 0 is parked)
- Implementation of CMS, auth, or collaboration (research first)
- Translation layer code (R06 research first)
- Filling out later roadmap phases (research drives roadmap, not the other way around)

## Running the Docs Site

```bash
cd docs
bun run dev          # http://localhost:4321/cyberbaser/ (dev, HMR — may be flaky on mobile)
bun run dev:host     # bind to 0.0.0.0 (Tailscale / LAN)
bun run build        # production build
bun run preview --host 0.0.0.0  # serve built output (use this for mobile testing via Tailscale)
```

## Pointers to External Context

- **Live content vault**: https://github.com/cybersader/cyberbase
- **Local research vault**: Obsidian vault, 📁 51 - Cyberbase folder (local path varies by machine)
- **Vault mining logs**: [Vision mining](/cyberbaser/agent-context/zz-log/2026-04-13-vault-vision-mining/) · [Tech stack mining](/cyberbaser/agent-context/zz-log/2026-04-13-vault-tech-stack-mining/) · [Collab mining](/cyberbaser/agent-context/zz-log/2026-04-13-vault-collab-mining/)
- **Research roadmap**: [Roadmap · Phase R](/cyberbaser/getting-started/roadmap/)
- **Sibling repos**: `cybersader/crosswalker`, `cybersader/cyberchaste`

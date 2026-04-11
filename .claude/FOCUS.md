# Cyberbaser — Current Focus

> Update when direction changes, milestones complete, or priorities shift.

**Current:** Research & Foundations phase. Ground-up first-principles capture. No new shipping-oriented work until `.claude/` numbered files (01 through 12 at minimum) have real content in them.

Last updated: 2026-04-11

## Project State

- **Reinitialized** from dormant Phase-0 prototype to match the `.claude/` convention used in crosswalker / cyberchaste.
- Phase-0 prototype (Astro + Starlight + Playwright + Cloudflare Pages) is parked in `docs/`. It builds, tests pass, deploy workflow exists — but it's not the focus. Leave it alone unless research reveals a needed change.
- Old PARA-structured dev docs have been archived to `.workspace/_archive-phase-0-docs/` — not deleted, but off the critical path. They describe implementation details, not first principles.
- First-principles scaffolding (`.claude/01-PROBLEM.md` through `.claude/41-QUESTIONS-RESOLVED.md`) is created as skeletons with TODO prompts. These are the work surface.

## What's Next (in priority order)

1. **Fill `.claude/01-PROBLEM.md`** — articulate the actual problem cyberbaser solves in its own words. Not "publish an Obsidian vault" but *why that's hard and why existing solutions don't cover it*.
2. **Inventory the ecosystem** (`02-ECOSYSTEM.md`) — Obsidian Publish, Quartz, Digital Garden, Astro Starlight, Docusaurus, MkDocs Material, Decap, Netlify CMS, etc. What exists, what each does well, what each fails at.
3. **Name the concepts** (`03-CONCEPTS.md`) — wikilinks, backlinks, Open Authoring, translation layer, structural vs. presentational content. These are the primitives the rest of the project reasons about.
4. **Prior-art deep-dive** (`04-PRIOR-ART.md`) — tools that have *tried* to solve the Obsidian→web contribution problem. What did they learn? What did they concede?
5. **Extract principles** (`12-PRINCIPLES.md`) — once the problem, ecosystem, and prior art are on the page, the design principles should fall out. Don't write principles before the evidence that justifies them.
6. **Only then**: update `20-ROADMAP.md` with a phased plan. Roadmap is downstream of principles, not the other way around.

## Deliberately NOT Doing Right Now

- Building new publishing features
- Refactoring the Astro site
- Evaluating alternative SSGs (the existing prototype is fine as a throwaway — don't replace it until research says to)
- Filling out `20-ROADMAP.md` with concrete implementation steps before the first-principles files have content

## Running the Docs Site

```bash
cd docs
bun install
bun run dev          # http://localhost:4321/
bun run build        # Production build
bun run test:e2e     # Playwright tests
```

## Pointers to External Context

- **Live content vault**: https://github.com/cybersader/cyberbase
- **Local research vault**: `C:\Users\Cybersader\Documents\4 VAULTS\cyberbase\📁 51 - Cyberbase\`
- **MCP / agent workflow patterns**: `C:\Users\Cybersader\Documents\1 Projects, Workspaces\mcp-workflow-and-tech-stack\docs\`
- **Sibling repos for convention reference**: `cybersader/crosswalker`, `cybersader/cyberchaste`

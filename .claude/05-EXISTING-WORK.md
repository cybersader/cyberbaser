# 05 — Existing Work

> **Status**: 🌱 Skeleton, but partially grounded in real artifacts as of 2026-04-11.

Inventory of what has *already* been built toward cyberbaser. Prevents re-research and makes clear what's actually salvageable vs. what should be left alone.

## In This Repo (cybersader/cyberbaser)

### Phase-0 publishing prototype — `docs/`
- Astro v5 + Starlight v0.37
- `astro-loader-obsidian` as a content loader dependency
- Playwright E2E tests (see `docs/tests/`)
- Cloudflare Pages deploy workflow (`.github/workflows/deploy.yml`)
- Migrated from npm to Bun
- **Status**: parked. Builds and deploys, but not actively developed during the current research phase. Don't edit unless research says to.

### Archived Phase-0 dev docs — `.workspace/_archive-phase-0-docs/`
- Old PARA-structured markdown notes about architecture, build scaling, translation layer, deployment, testing workflow, Cloudflare vendor setup
- **Status**: archived, not deleted. Useful as a reference mine for when `22-TRANSLATION-LAYER.md` and `21-ARCHITECTURE.md` get filled in. Delete when exhausted.

### `.claude/` meta layer (this folder) — 2026-04-11
- Reinitialized to match crosswalker / cyberchaste convention
- PROJECT_CONTEXT, FOCUS, KNOWLEDGE_BASE_PHILOSOPHY, DOCUMENTATION_STYLE, RESEARCH_SOURCES populated
- Numbered first-principles files (01-41) scaffolded as skeletons
- **Status**: this is the active work surface

## In Sibling Repos (cybersader's other work)

### `cybersader/cyberbase` — the live content vault
- The Obsidian vault that cyberbaser publishes
- Already has Notion + Obsidian + GitHub sync
- **Status**: production content, untouched by cyberbaser work

### `cybersader/notion-to-obsidian-github-sync`
- Previous attempt: back up Notion → clean up → commit to repo for Obsidian consumption
- **Status**: functional; the upstream of the current vault
- **Relevant lesson**: see `04-PRIOR-ART.md` entry

### `cybersader/cybersader-notion-workspace-public`
- Even earlier attempt: public-read Notion workspace
- **Status**: superseded

### `cybersader/cybersader-obsidian-wiki-template` + `obsidian-vault-template-template` + `obsidian-secops-vault-template`
- Earlier vault scaffolding experiments
- **Status**: unclear if still relevant; audit during research phase

### `cybersader/awesome-*` repos (awesome-bhis, awesome-siem, awesome-cyber-deception, awesome-log-management, awesome-obsidian-and-cyber, awesome-sigma)
- Prior-art data points — the "minimum viable contribution" baseline

## In the Local Obsidian Research Vault

- Local Obsidian vault (local research vault)
- **Status**: unknown contents as of 2026-04-11. Audit early in the research phase — likely contains prior thinking that should be ported into these numbered files.

## In the MCP / Agent Workflow Project

- Local MCP workflow project (sibling workspace)
- **Status**: not cyberbaser-specific but contains KB patterns and agent conventions worth pulling in.

---

## Implication for Roadmap

> Because the Phase-0 publishing pipeline exists and works, cyberbaser is **not** blocked on "can we build the site at all." The blocker is upstream: we don't yet have the first-principles clarity to know what the site should *be*. That's why the roadmap (see `20-ROADMAP.md`) places Research & Foundations as the only active phase.

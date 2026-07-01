# Cyberbaser Project Context

> Last aligned: 2026-06-21 (post vision-sweep). If this file disagrees with the docs site, the docs site wins — and this file should be fixed in the same session.

## What This Project Is

**Cyberbaser is an interoperability layer for contributable, version-controlled knowledge bases.** It sits *between* the tools people author in (Obsidian first-class, but any markdown surface), the renderers that publish the result (Quartz, Starlight, anything), and — eventually — other knowledge bases, keeping one plain-text corpus faithful as changes round-trip through all of them.

Three pillars, held in one phrase:
- **Interoperability** — author from any tool, render with any generator, federate with any other base (v2+). The hub is the *between*.
- **Contributable** — anyone can help maintain it, governed by a maintainer-set **trust curve + moderation queue**, never an account wall. "Contributable, not controllable."
- **Version-controlled / resilient** — plain text with full history: durable, portable, owned. Git is how version control happens today; it is the current manifestation, **not the essence**, and the layer never forces git on contributors.

**It is general, not a cyber tool.** The `cybersader/cyberbase` vault (cybersecurity content) is the first dogfooding corpus, not the scope. Any wiki — research, handbook, course, standard — is the target.

There are two repos to keep straight:

| Repo | Role |
|---|---|
| `cybersader/cyberbase` | The dogfood content vault (cyber topics) — the first content, not the point |
| `cybersader/cyberbaser` (this repo) | The layer: research, translation-layer R&D, contribution/trust design, the docs site that publishes the research |

## The Architecture in One Line

Write anywhere → the **hub** keeps every surface the same faithful markdown and reviews each change (trust curve + moderation) → that markdown, with history, is the single source of truth you own → the published wiki is a generated view of it. **The hub is the product; renderers are swappable commodity spokes** — never couple the hub to one SSG.

## Hard Constraints (violating these = going the wrong direction)

1. **Renderer-agnostic.** Astro/Starlight is the current prototype only. Quartz already wins forward publishing; the reverse (web-edit → clean vault file) is the differentiator no SSG can do.
2. **No hyperscalers.** Self-hosting preferred (Forgejo for identity/hosting; see RA-01 — PKCE against Forgejo's OIDC eliminates the OAuth proxy). GitHub Pages is the *current* deploy target; Cloudflare is edge-only (CDN/WAF/rate-limit), never the host. No AWS/GCP.
3. **Accounts are never forced.** Contribution safety = moderation queue + maintainer's trust curve. Identity gates are mostly theater; an account is a trust signal, not a wall.
4. **The keystone is the lossless round-trip** (proven in `spikes/ofm-roundtrip/`, 20/21). Every design decision gets checked against translation-layer implications.
5. **Research before implementation.** The Phase-0 prototype is parked; no feature without a written justification.

## Who It's For

- **Knowledge owners** with a markdown KB who want it publicly contributable without a separate publishing stack or a walled garden.
- **Readers** who spot a wrong fact and will fix it in three clicks, but never via a CLI or signup.
- **Developers** who fix things by editing a `.md` and opening a PR.
- **AI agents** maintaining content through the same reviewed pipeline as humans — the tool is deliberately agent-friendly.
- **User (Cybersader)**: cybersecurity professional, Obsidian power user, WSL on Windows, collaborates heavily with Claude Code across sibling projects.

## Where Knowledge Lives (knowledge-ops map)

The **canonical knowledge base is the docs site** (`docs/src/content/docs/`) — problem, ecosystem, primitives, prior art, vision, principles, architecture, translation layer, contribution workflows, research findings, open questions. It is mature, vision-swept, and covered by Playwright tests.

The `.claude/` layer is the **orientation + pointer layer**: this file and `FOCUS.md` orient a fresh agent; the numbered files are greppable stubs pointing at their canonical docs pages; `40/41-QUESTIONS-*.md` track decision state; `RESEARCH_SOURCES.md` holds curated sources. **When a decision gets locked in a session, propagate it here in the same session** — this layer going stale is how agents end up pointed in an old direction.

## How to Approach Work in This Repo

1. **Read this file, then `FOCUS.md`.** That's the direction and the current state. Follow stub pointers into the docs site for depth.
2. **Research goes INTO files, not chat.** New findings go to the canonical docs page (or a new page in `docs/src/content/docs/research/`); locked decisions also land in `41-QUESTIONS-RESOLVED.md` and, if they change direction, here and in `FOCUS.md`.
3. **The docs/ folder is both the dev environment AND the published research.** `cd docs && bun run dev` to preview.
4. **Scratch goes in `.workspace/`** (tracked folder, gitignored contents). Old Phase-0 docs live in `.workspace/_archive-phase-0-docs/` — an archive, not a live source.

## Relationship to Sibling Projects

Shared `.claude/` workspace convention across Cybersader projects:

- **crosswalker** — ontology lifecycle management system for knowledge bases (GRC crosswalking). Most mature `.claude/` layout; the numbered-file convention came from it. Its identity phrasing rhymes with cyberbaser's on purpose.
- **cyberchaste** — device-level content filtering research. Source of `KNOWLEDGE_BASE_PHILOSOPHY.md` and `DOCUMENTATION_STYLE.md`.
- **agentic-workflow-and-tech-stack** — meta scaffold for filesystem-based agent workflows.
- **Retake Forge** — Obsidian in the browser. Strategically adjacent: a browser-native Obsidian surface is a potential authoring spoke for cyberbaser's web-edit path.
- **Sinario** — cyber scenarios tooling. Content-adjacent (scenario content could live on a cyberbase-style wiki).

When in doubt about convention, check crosswalker first.

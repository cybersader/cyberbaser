# Cyberbaser Project Context

## What This Project Is

**Cyberbaser** is the tooling project for **Cyberbase** — a distributed, contributable knowledge wiki for cybersecurity and cyber-resilience topics, mixed with some personal knowledge. The content itself lives in a separate repo (`cybersader/cyberbase`) and originates in an Obsidian vault. Cyberbaser is the pipeline, the publishing surface, and the research project that answers "how do we turn an Obsidian vault into a clean, contributable, web-accessible wiki — without losing Obsidian's affordances?"

There are two repos to keep straight:

| Repo | Role |
|---|---|
| `cybersader/cyberbase` | The live Obsidian vault / content source of truth |
| `cybersader/cyberbaser` (this repo) | The tooling: Astro+Starlight site generator, translation layer R&D, CMS integration, deployment |

## Who It's For

- **Primary reader**: cybersecurity practitioners, students, and curious generalists who want a searchable, cross-linked wiki of cyber topics.
- **Primary contributor profile**: people with mixed git fluency. Some know git + Obsidian well; others will only ever use a web CMS. The whole point of the project is that **all three contribution paths must work**:
  1. Web CMS (Decap, Open Authoring) — zero-git contribution
  2. Obsidian + Git — for vault-native power users
  3. Direct GitHub (edit-in-place, PRs) — for developers
- **User (Cybersader)**: cybersecurity professional, Obsidian power user, runs Home Assistant, lives in WSL on Windows, collaborates heavily with Claude Code across multiple sibling projects.

## Core Philosophy

1. **GitHub is the single source of truth.** Every contribution path ultimately produces commits to `cybersader/cyberbase`. No sidecar databases, no vendor content stores.
2. **Obsidian semantics must round-trip.** If a link renders in Obsidian and also renders on the web, a contributor can edit either surface without corrupting the other.
3. **No vendor lock-in.** The Obsidian vault is the durable artifact. Astro, Decap, Cloudflare can all be swapped.
4. **The hard problem is the translation layer**, not the site generator. See `22-TRANSLATION-LAYER.md`.
5. **Ground-up reasoning over inherited scaffolding.** The project was reinitialized to build up first principles (01-PROBLEM through 12-PRINCIPLES) rather than jumping straight to implementation.

## Relationship to Sibling Projects

Cyberbaser is one of several Cybersader projects that share a common `.claude/` workspace convention:

- **crosswalker** — GRC framework crosswalking Obsidian plugin. Most mature `.claude/` layout; the numbered-file convention here was copied from it.
- **cyberchaste** — device-level content filtering research project. Source of `KNOWLEDGE_BASE_PHILOSOPHY.md` and `DOCUMENTATION_STYLE.md` (identical across both siblings).
- **agentic-workflow-and-tech-stack** — meta scaffold for filesystem-based agent workflows. Relevant patterns for how `.claude/` should be organized.

When in doubt about convention, check crosswalker first.

## Current Phase

**Research phase.** The Phase-0 publishing prototype (Astro + Starlight + Playwright + Cloudflare Pages) has been built and parked in `docs/`. The work now is mostly reading, thinking, and writing into the numbered KB files — not code. See `FOCUS.md` for the current dated snapshot.

## How to Approach Work in This Repo

1. **Read `.claude/` first.** `KNOWLEDGE_BASE_PHILOSOPHY.md` explains the living-KB pattern. `FOCUS.md` tells you what's actually active right now. The numbered files (01–41) are where thinking accumulates.
2. **Research goes INTO files, not chat.** When researching a topic, update the relevant numbered file (or create a topic-specific one in `docs/src/content/docs/research/`). Don't dump findings into a chat reply that disappears.
3. **The docs/ folder is both the dev environment AND the published wiki.** `cd docs && bun run dev` to preview. Astro Starlight autogenerates navigation from `src/content/docs/kb/`.
4. **Scratch and half-baked thoughts go in `.workspace/`.** That folder is tracked but its contents are gitignored — it's your local notebook.
5. **Old Phase-0 docs are in `.workspace/_archive-phase-0-docs/`.** They were not ported forward because the reinit explicitly starts from first principles. Mine them if useful, delete when done.

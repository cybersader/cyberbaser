# 23 — Contribution Workflows

> **Status**: ✅ Superseded. The canonical, maintained version of this content is the docs page below. This stub keeps the key facts greppable and points there. **Do not extend this file; edit the docs page instead.**
>
> **Canonical**: `docs/src/content/docs/design/contribution-workflows.mdx` · published at `/cyberbaser/design/contribution-workflows/`

## Current truth (summary, 2026-06-21)

- Three independent paths: **Web CMS** (Decap Open Authoring; fork+PR invisible to the contributor), **Obsidian + Git** (power users), **direct GitHub** (developers).
- Every path feeds the same maintainer-configured pipeline: contribution → trust-curve step → **moderation queue** → merge → live. Accounts are never forced; an account is a trust signal, not a wall. A serverless contribution bot is the zero-account path being evaluated.
- Review model: trust-tiered (auto-merge only for trusted typo fixes). DoS/volumetric abuse is an edge concern (rate-limit/WAF), separate from content moderation.

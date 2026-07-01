# 02 — Ecosystem

> **Status**: ✅ Superseded. The canonical, maintained version of this content is the docs page below. This stub keeps the key facts greppable and points there. **Do not extend this file; edit the docs page instead.**
>
> **Canonical**: `docs/src/content/docs/concepts/ecosystem.mdx` · published at `/cyberbaser/concepts/ecosystem/`

## Current truth (summary, 2026-06-21)

- Four layers: **publishing/SSG** (commodity, swappable: Astro/Starlight today, Quartz, Docusaurus, MkDocs), **translation** (unified/remark/rehype, astro-loader-obsidian unproven for Tier 1), **contribution/CMS** (Decap Open Authoring, Sveltia, Tina, GitHub web editor), **hosting + auth** (GitHub Pages current, Forgejo self-host preferred, Cloudflare edge-only, GitHub OAuth = one option).
- The docs page has a logo+link card per tool (21 tools).
- Hypothesis: an SSG + a competent translation layer + Open Authoring + static host + self-hostable identity *composition* satisfies all three corners of the problem triangle; no single tool does.

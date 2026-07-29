# 02 — Ecosystem

> **Status**: ✅ Superseded. The canonical, maintained version of this content is the docs page below. This stub keeps the key facts greppable and points there. **Do not extend this file; edit the docs page instead.**
>
> **Canonical**: `docs/src/content/docs/concepts/ecosystem.mdx` · published at `/cyberbaser/concepts/ecosystem/`

## Current truth (summary, 2026-07-29)

- Four replaceable areas: **authoring surfaces** (reader, rich browser/WYSIWYG/CMS-like, forge, local Markdown, agent), **proposal and exact-change adapters**, **rendering/publishing spokes** (Quartz for the vault, Starlight for this KB), and **hosting/identity** (GitHub Pages current, Forgejo self-host preferred, Cloudflare edge-only).
- The evaluated Decap, Sveltia, TinaCMS, EmDash, and Pages CMS native save configurations are historical UX evidence, not current writer candidates: each regenerated complete files. A future rich integration needs a deliberate pinned-base exact-proposal adapter.
- Current hypothesis: replaceable external authoring spokes → bounded proposals → owner-controlled exact-change/integrity/trust/review boundary → one authoritative source → replaceable renderer and host. The owner's local editor is a separate direct-authoring lane.

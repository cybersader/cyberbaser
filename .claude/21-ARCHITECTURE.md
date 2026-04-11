# 21 — Architecture

> **Status**: 🌱 Skeleton. Port content from `.workspace/_archive-phase-0-docs/areas/cyberbase-architecture.md` as research proceeds, but only after principles are written.

The technical architecture: how the pieces fit together. This file answers "if someone asked you to draw cyberbaser on a whiteboard, what would you draw?"

## High-Level Diagram (TODO — ASCII)

```
[ Obsidian Vault ]  <─── edit locally ──  [ Cybersader ]
        │
        │ (git push)
        ▼
[ GitHub: cybersader/cyberbase ] ◄──────────── [ PR from web CMS ]
        │                         ◄──────────── [ PR from direct GitHub ]
        │ (webhook / action)
        ▼
[ Astro Build in cyberbaser ]
        │  (translation layer: remark/rehype plugins)
        ▼
[ Static HTML + assets ]
        │
        ▼
[ Cloudflare Pages ] ──────────► [ cyberbase.wiki ]
```

> TODO: redraw after 01-PROBLEM and 12-PRINCIPLES are real. The diagram above is inherited from the Phase-0 prototype thinking and should be validated, not assumed.

## Components

### The Vault Repo (`cybersader/cyberbase`)
> TODO: what's in it, what's its invariant shape, how cyberbaser consumes it.

### The Build Pipeline (this repo's `docs/`)
> TODO: Astro + Starlight + astro-loader-obsidian + (future) remark plugins for wikilinks/callouts/embeds. Where each transformation happens.

### The Translation Layer
> See `22-TRANSLATION-LAYER.md` for depth; this file only references it.

### The CMS (Decap / Open Authoring)
> TODO: how Open Authoring turns a web form submission into a forked PR. What the OAuth proxy does. What Cloudflare Pages Functions host.

### The Hosting (Cloudflare Pages)
> TODO: why Cloudflare. What Pages Functions are used for. Custom domain setup.

### Auth (GitHub OAuth)
> TODO: the OAuth app, the proxy, the permission scopes, what happens when a contributor signs in.

## Boundaries (what each component must NOT do)

> TODO: a principled boundary list. e.g., "The Astro build must not write to the vault," "The CMS must not assume git knowledge," etc.

## Sequence Diagrams (key flows)

### Flow 1: Vault owner edits in Obsidian
> TODO

### Flow 2: Anonymous reader submits a correction via Web CMS
> TODO

### Flow 3: Developer edits markdown directly on GitHub
> TODO

## Open Architectural Questions

> TODO: migrate to `40-QUESTIONS-OPEN.md` as they surface. Candidates:
> - Where does the translation layer run — build time only, or also client-side for preview?
> - How is backlinks data computed and cached?
> - What's the incremental build story for a large vault?
> - Where do assets (images) live and how are they addressed?

# 21 — Architecture

> **Status**: ✅ Superseded. The canonical, maintained version of this content is the docs page below. This stub keeps the key facts greppable and points there. **Do not extend this file; edit the docs page instead.**
>
> **Canonical**: `docs/src/content/docs/design/architecture.mdx` · published at `/cyberbaser/design/architecture/`

## Current truth (summary, 2026-07-29)

- **Mental model:** replaceable authoring spokes → pinned, bounded external proposals → owner-controlled publication/exact-change/integrity/trust/review boundary → one authoritative Markdown source → replaceable rendering and publication spokes.
- **Owner lane:** the owner keeps authoring the source directly in their preferred local Markdown tool. Cyberbaser must not force that work through an external editor or moderation form.
- **External lanes:** reader controls, rich browser/WYSIWYG/CMS-like tools, forge editors, and agents may use arbitrary presentation or transient models, but their adapters cannot directly write canonical files, become a second authority, authorize themselves, or hide stale/ambiguous source mapping.
- **As built:** six no-authority packages (`correction`, `ofm`, `publish`, `projection`, `linkcheck`, `trust`) plus dogfood CI jobs. `correction` prepares/applies one candidate splice in memory and performs no file I/O.
- Renderers and hosts are swappable commodity spokes; never couple the hub to one SSG or forge. GitHub Pages is current, Cloudflare stays edge-only, and self-hosted Forgejo remains preferred for identity/hosting.

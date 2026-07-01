# 21 — Architecture

> **Status**: ✅ Superseded. The canonical, maintained version of this content is the docs page below. This stub keeps the key facts greppable and points there. **Do not extend this file; edit the docs page instead.**
>
> **Canonical**: `docs/src/content/docs/design/architecture.mdx` · published at `/cyberbaser/design/architecture/`

## Current truth (summary, 2026-06-21)

- **Mental model:** write anywhere → the hub keeps every surface the same faithful markdown and reviews each change → that markdown (with history) is the source of truth → the wiki is a generated view.
- The hub **translates** (round-trip) and **governs** (trust curve + moderation). Renderers are swappable commodity spokes; never couple the hub to one SSG.
- Hosting: **GitHub Pages current**; Cloudflare edge-only (CDN/WAF); **self-hosted Forgejo preferred** for identity/hosting (RA-01: Decap/Sveltia authenticate via PKCE against Forgejo's built-in OIDC — no OAuth proxy, no secret).

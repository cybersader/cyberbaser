# Cyberbase Development Documentation

## Navigation

### Projects (Active Work)
- [Phase 0: Foundation](projects/cyberbase-phase-0-foundation.md) - Current phase

### Areas (Ongoing Concerns)
- [Architecture](areas/cyberbase-architecture.md) - System design
- [Translation Layer](areas/cyberbase-translation-layer.md) - The critical problem
- [Deployment Architecture](areas/cyberbase-deployment-architecture.md) - Build & deploy options

### Resources (Reference)
- [Research: Astro + Obsidian Integration](resources/research-astro-obsidian-integration.md)
- [Vendor: Cloudflare Pages Setup](resources/vendor-cloudflare-pages-setup.md)

### Archive (Superseded)
- (Empty - nothing archived yet)

## Quick Reference

**Current Phase**: Phase 0 - Foundation

**Tech Stack**:
| Component | Choice |
|-----------|--------|
| SSG | Astro + Starlight |
| CMS | Decap CMS |
| Hosting | Cloudflare Pages |
| Auth | GitHub OAuth |

**Critical Problem**: Translation Layer (Obsidian → Web)

## How to Use These Docs

1. Start with `CLAUDE.md` in the project root for context
2. Check the relevant Area doc for ongoing concerns
3. Check the Project doc for current implementation details
4. Add to Resources when synthesizing external research

## File Naming

- Lowercase kebab-case
- Prefix with category: `research-`, `vendor-`, `adr-`
- Be descriptive over brief

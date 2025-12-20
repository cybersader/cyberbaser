# Cyberbase Development Workspace

## Project Overview

Cyberbase is a **distributed contributable knowledge wiki** built on Obsidian, with GitHub as the single source of truth and multiple contribution entry points (Web CMS, Obsidian+Git, GitHub direct).

## Quick Links

- **Plan**: `/home/cybersader/.claude/plans/distributed-wandering-giraffe.md`
- **Research**: `/mnt/c/Users/Cybersader/Documents/4 VAULTS/cyberbase/📁 51 - Cyberbase/`
- **MCP Patterns**: `/mnt/c/Users/Cybersader/Documents/1 Projects, Workspaces/mcp-workflow-and-tech-stack/docs/`
- **Live Vault**: https://github.com/cybersader/cyberbase

## Documentation Structure (PARA)

```
docs/
├── projects/     # Current implementation phases, active tasks
├── areas/        # Ongoing concerns (architecture, security, translation layer)
├── resources/    # Research, references, vendor docs
└── archive/      # Completed/superseded documentation
```

## File Naming Conventions

- Use lowercase kebab-case: `cyberbase-phase-0-foundation.md`
- Prefix with category when helpful: `research-decap-cms.md`, `vendor-cloudflare.md`
- Be descriptive: prefer `cyberbase-translation-layer-wikilinks.md` over `wikilinks.md`

## Current Phase

**Phase 0: Foundation** - Publish existing vault to web + set up dev environment

## Tech Stack

| Component | Technology |
|-----------|------------|
| SSG | Astro + Starlight |
| CMS | Decap CMS (Open Authoring) |
| Hosting | Cloudflare Pages |
| Auth | GitHub OAuth (primary) |
| Translation | unified/remark |

## Key Decisions

1. Astro + Starlight for flexibility and ecosystem
2. Mirror Obsidian folder structure in URLs
3. Wikilinks everywhere, transform at build time
4. PARA-structured development documentation

## The Critical Problem: Translation Layer

The hardest part is converting Obsidian content to web:
- **Tier 1 (Full)**: Wikilinks, callouts, embeds, code, math, Mermaid
- **Tier 2 (Partial)**: Simple Dataview, block refs, aliases
- **Tier 3 (None)**: Complex Dataview, Canvas, plugin-specific

Think about translation layer implications early in all decisions.

# Cyberbase Architecture

**Status**: Living Document

---

## System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                     CONTRIBUTORS                                 │
├───────────────┬───────────────┬───────────────┬─────────────────┤
│   Web CMS     │  Obsidian     │   GitHub      │   Anonymous     │
│  (GitHub OAuth)│   + Git      │    Direct     │    Reader       │
└───────┬───────┴───────┬───────┴───────┬───────┴────────┬────────┘
        │               │               │                │
        ▼               ▼               ▼                │
┌───────────────────────────────────────────────────┐    │
│            GITHUB REPOSITORY                       │    │
│         (Single Source of Truth)                   │    │
│                                                    │    │
│   Fork → Edit → PR → Review → Merge               │    │
└───────────────────────┬───────────────────────────┘    │
                        │                                │
                        ▼                                │
┌───────────────────────────────────────────────────┐    │
│          TRANSLATION LAYER                         │    │
│   (The Critical Problem)                           │    │
│                                                    │    │
│   Obsidian MD → Parse → Transform → Validate → Web│    │
└───────────────────────┬───────────────────────────┘    │
                        │                                │
                        ▼                                │
┌───────────────────────────────────────────────────┐    │
│   ASTRO + STARLIGHT → CLOUDFLARE PAGES             │◄───┘
│                                                    │
│   Graph View | Search | Backlinks | Edit Button   │
└───────────────────────────────────────────────────┘
```

## Core Principles

1. **GitHub is the single source of truth** - All content lives in Git
2. **Multiple contribution entry points** - Lower friction for different users
3. **Translation layer handles complexity** - Contributors don't need to understand web constraints
4. **Progressive enhancement** - Start simple, add features incrementally

## Component Architecture

### 1. Content Layer (GitHub)

- Repository: `cybersader/cyberbase`
- Format: Obsidian-flavored Markdown
- Structure: Mirrors folder hierarchy

### 2. Translation Layer

See: `cyberbase-translation-layer.md`

Responsible for:
- Wikilink resolution
- Embed expansion
- Callout transformation
- Dataview static rendering
- Schema validation

### 3. Build Layer (Astro)

- Static site generation
- Content collections with Zod schemas
- Starlight theme for documentation UI
- Graph view component
- Search indexing

### 4. Hosting Layer (Cloudflare)

- Cloudflare Pages for static hosting
- Global CDN
- Automatic SSL
- Deploy hooks from GitHub

### 5. CMS Layer (Decap)

- Open Authoring (fork-based PRs)
- GitHub OAuth
- Constrained editor (Tier 1 features only)

## Data Flow

### Read Path
```
User Request → Cloudflare CDN → Static HTML/JS
```

### Write Path (GitHub User)
```
Edit Button → Decap CMS → GitHub OAuth → Fork Repo →
Edit in CMS → Create PR → Maintainer Review → Merge →
GitHub Actions → Astro Build → Cloudflare Deploy
```

### Write Path (Obsidian User)
```
Edit in Obsidian → Git Commit → Push →
GitHub Actions → Astro Build → Cloudflare Deploy
```

## Future Architecture (Phases 5-6)

### Real-time Collaboration
- Yjs CRDT for concurrent editing
- WebSocket sync server
- Presence indicators

### Distributed Layer
- IPFS content addressing
- IPNS for mutable references
- Federation with other knowledge bases

## Architecture Decisions

| Decision | Choice | Rationale | Date |
|----------|--------|-----------|------|
| SSG | Astro + Starlight | Flexibility, ecosystem | 2024-12-19 |
| CMS | Decap (Open Authoring) | Fork-based PRs, GitHub native | 2024-12-19 |
| Hosting | Cloudflare Pages | Free, fast, good DX | 2024-12-19 |
| Auth | GitHub OAuth primary | Git attribution, no backend | 2024-12-19 |

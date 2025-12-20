# Phase 0: Foundation

**Goal**: Publish existing vault to web + set up dev environment

**Status**: In Progress

---

## Objectives

1. Initialize Astro project with Starlight theme
2. Install and configure astro-loader-obsidian for vault ingestion
3. Set up Obsidian → Astro content pipeline
4. Deploy to Cloudflare Pages
5. Implement graph view, search, backlinks

## Deliverables

- [ ] Live site at custom domain
- [ ] CI/CD pipeline (GitHub Actions → Cloudflare)
- [ ] Basic documentation

## Technical Decisions

### Astro + Starlight

**Why Astro over Quartz:**
- More flexible, larger ecosystem
- Better for mixed content sites (wiki + landing pages)
- Content Collections with schema validation (Zod)
- Islands architecture for performance
- Growing community

**Trade-off**: Requires more setup for Obsidian features (wikilinks, graph view)

### astro-loader-obsidian

Repository: https://github.com/aitorllj93/astro-loader-obsidian

Capabilities:
- Loads Obsidian vault into Astro content collections
- Handles wikilinks, embeds, frontmatter
- Configurable file filtering

### Content Pipeline

```
Obsidian Vault (GitHub)
        │
        ▼
astro-loader-obsidian
        │
        ▼
Astro Content Collections
        │
        ▼
Starlight Theme
        │
        ▼
Cloudflare Pages
```

## Open Questions

1. Does astro-loader-obsidian handle all Tier 1 features?
2. What's the best approach for graph view in Starlight?
3. How to handle backlinks without Quartz?

## Success Criteria

- [ ] Existing cyberbase content renders correctly
- [ ] Wikilinks resolve to correct URLs
- [ ] Callouts render with styling
- [ ] Search works across content
- [ ] Build time < 2 minutes

## Cost Impact

Replaces Obsidian Publish: $8/mo → $0/mo = $96/year savings

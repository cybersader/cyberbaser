# Deployment Architecture

**Status**: Living Document - Needs Architecture Decision

---

## Overview

Deployment for Cyberbase is not straightforward because:
1. **Multiple contribution paths** exist (Obsidian, Web CMS, GitHub)
2. **Future distributed network** changes the model entirely
3. **Build triggers** can come from many sources
4. **Not everyone will use the same stack**

This document maps out the options and trade-offs.

---

## Current Architecture: Centralized Model

```
                    ┌─────────────────────────────────────┐
                    │           BUILD TRIGGERS            │
                    ├───────────┬───────────┬─────────────┤
                    │  GitHub   │ Obsidian  │   Web CMS   │
                    │   Push    │  Plugin   │   (Decap)   │
                    └─────┬─────┴─────┬─────┴──────┬──────┘
                          │           │            │
                          ▼           ▼            ▼
                    ┌─────────────────────────────────────┐
                    │         GITHUB REPOSITORY           │
                    │       (Single Source of Truth)      │
                    └───────────────────┬─────────────────┘
                                        │
              ┌─────────────────────────┼─────────────────────────┐
              │                         │                         │
              ▼                         ▼                         ▼
    ┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
    │  GitHub Actions │     │ Cloudflare Pages│     │   Self-Hosted   │
    │   (CI/CD)       │     │   (Auto-deploy) │     │   (Manual/CI)   │
    └────────┬────────┘     └────────┬────────┘     └────────┬────────┘
             │                       │                       │
             ▼                       ▼                       ▼
    ┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
    │ GitHub Pages /  │     │ Cloudflare CDN  │     │  Your Server    │
    │ Netlify / Vercel│     │                 │     │  (VPS/HomeLab)  │
    └─────────────────┘     └─────────────────┘     └─────────────────┘
```

---

## Deployment Options (Centralized)

### Option 1: Cloudflare Pages (Direct)

**How it works**:
- Connect GitHub repo to Cloudflare Pages
- Cloudflare auto-builds on every push
- No GitHub Actions needed

**Pros**:
- Simplest setup
- Free tier is generous
- Global CDN
- Automatic SSL

**Cons**:
- Build happens on Cloudflare's infrastructure
- Less control over build process
- May hit build time limits for large vaults

**Best for**: Simple, fast deployment

---

### Option 2: GitHub Actions → Deploy

**How it works**:
```yaml
# .github/workflows/deploy.yml
on:
  push:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm run build
      - uses: cloudflare/pages-action@v1
        # or: peaceiris/actions-gh-pages
        # or: netlify/actions
```

**Pros**:
- Full control over build
- Can run custom transformation scripts
- Better for complex translation layer
- Multiple deploy targets possible

**Cons**:
- More setup
- GitHub Actions minutes (free tier: 2000/month)

**Best for**: Custom build pipeline, multiple deploy targets

---

### Option 3: Obsidian Plugin (Future)

**How it works**:
- User installs Cyberbase Publisher plugin
- Plugin handles:
  - Git commit/push
  - Direct API calls to trigger builds
  - Optional: Direct publish to IPFS

**Pros**:
- Best UX for Obsidian users
- Can handle transformation locally
- Could bypass GitHub entirely (IPFS route)

**Cons**:
- Requires plugin development
- Plugin maintenance burden
- Users need to install/configure

**Best for**: Obsidian-native experience

---

### Option 4: Self-Hosted Build Server

**How it works**:
- Run build on your own infrastructure (HomeLab, VPS)
- Webhook triggers from GitHub
- Deploy to CDN or serve directly

**Pros**:
- Full control
- No external dependencies
- Can run complex transformations
- Good for privacy-sensitive content

**Cons**:
- Infrastructure management
- Need reliable hosting
- More complex setup

**Best for**: Maximum control, self-sovereignty

---

## Custom Domains

### Automatic URL

Every Cloudflare Pages project gets a free `*.pages.dev` subdomain:
- Project "cyberbase" → `cyberbase.pages.dev`
- Project "cyberbase-test" → `cyberbase-test.pages.dev`

Each deployment also gets a unique URL (e.g., `3adb062d.cyberbase.pages.dev`) for previewing specific commits.

### Adding a Custom Domain

1. **Cloudflare Dashboard**: Pages → [Project] → Custom domains → Set up a custom domain
2. **Enter domain**: e.g., `test.cyberbaser.com` or `wiki.yourdomain.com`
3. **DNS Configuration**:
   - **If domain is in Cloudflare**: Auto-configured (CNAME added automatically)
   - **If domain is external**: Add CNAME record pointing to `<project>.pages.dev`

### DNS Records (External Domain)

```
Type    Name    Target                  TTL
CNAME   test    cyberbase.pages.dev     Auto
CNAME   wiki    cyberbase.pages.dev     Auto
```

For apex/root domains (`cyberbaser.com` without subdomain), use Cloudflare's DNS or a provider that supports CNAME flattening.

### Project Naming Strategy

Consider using separate Cloudflare Pages projects for different environments:

| Environment | Project Name | Domain | Purpose |
|------------|--------------|--------|---------|
| Production | `cyberbase` | `cyberbase.wiki` | Live site |
| Testing | `cyberbase-test` | `test.cyberbaser.com` | Testing deployments |
| Staging | `cyberbase-staging` | `staging.cyberbase.wiki` | Pre-production review |

To use different projects, update `--project-name` in `.github/workflows/deploy.yml`:
```yaml
command: pages deploy site/dist --project-name=cyberbase-test
```

### Multiple Domains

A single project can have multiple custom domains pointing to it. All will serve the same content:
- `cyberbase.wiki`
- `www.cyberbase.wiki`
- `cyberbase.com` (if owned)

---

## Future Architecture: Distributed Model

When moving to a distributed knowledge network, the model changes significantly:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    DISTRIBUTED KNOWLEDGE NETWORK                         │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐                 │
│  │   Node A     │   │   Node B     │   │   Node C     │                 │
│  │ (Your Site)  │   │ (Contributor)│   │ (Mirror)     │                 │
│  │              │   │              │   │              │                 │
│  │ ┌──────────┐ │   │ ┌──────────┐ │   │ ┌──────────┐ │                 │
│  │ │ Obsidian │ │   │ │ Web CMS  │ │   │ │  Quartz  │ │                 │
│  │ │ + Astro  │ │   │ │ + Hugo   │ │   │ │  + IPFS  │ │   ...more      │
│  │ └──────────┘ │   │ └──────────┘ │   │ └──────────┘ │   nodes         │
│  │      │       │   │      │       │   │      │       │                 │
│  │      ▼       │   │      ▼       │   │      ▼       │                 │
│  │ ┌──────────┐ │   │ ┌──────────┐ │   │ ┌──────────┐ │                 │
│  │ │   Git    │◄┼───┼─│   Git    │◄┼───┼─│   IPFS   │ │                 │
│  │ │ (GitHub) │ │   │ │ (GitLab) │ │   │ │ (Pinned) │ │                 │
│  │ └──────────┘ │   │ └──────────┘ │   │ └──────────┘ │                 │
│  └──────────────┘   └──────────────┘   └──────────────┘                 │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │                     CONTENT ADDRESSING LAYER                      │   │
│  │                                                                   │   │
│  │   Git SHAs ←──────→ IPFS CIDs ←──────→ IPNS Names                │   │
│  │                                                                   │   │
│  │   Content-addressed links work across all nodes                  │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │                        DISCOVERY LAYER                            │   │
│  │                                                                   │   │
│  │   - DNS: cyberbase.wiki, contributor.xyz, etc.                   │   │
│  │   - IPNS: /ipns/k51... (mutable references)                      │   │
│  │   - ENS: cyberbase.eth (optional, web3 discovery)                │   │
│  │   - Registry: List of known nodes/mirrors                        │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Key Differences in Distributed Model

1. **No single deployment target** - Each node deploys independently
2. **Content-addressed links** - Links work across nodes via CID/SHA
3. **Heterogeneous stacks** - Nodes can use different SSGs, CMSs
4. **Partial replication** - Nodes may only host subset of content
5. **No central build** - Each node builds their own view

### What This Means for Now

**Keep architecture flexible**:
- Content in standard markdown (portable)
- Links that can be transformed (relative, wikilinks)
- Metadata in frontmatter (not build-system-specific)
- Translation layer as standalone tool (not coupled to Astro)

**Don't optimize for**:
- Single deployment provider
- One SSG
- Centralized auth

---

## Decision Matrix

| Factor | Cloudflare Pages | GitHub Actions | Self-Hosted | Distributed |
|--------|-----------------|----------------|-------------|-------------|
| Setup complexity | Low | Medium | High | Very High |
| Cost | Free | Free (limits) | $ | Varies |
| Control | Low | Medium | High | Full |
| Vendor lock-in | Medium | Low | None | None |
| Future-proof | Okay | Good | Good | Best |
| Build customization | Limited | Full | Full | Full |

---

## Recommendation

### For MVP (Now)
**GitHub Actions → Cloudflare Pages**

Why:
1. Full control over build (translation layer)
2. Can add custom scripts easily
3. Cloudflare for hosting (free, fast)
4. Not locked to Cloudflare's build system
5. Easy to switch deploy target later

### For Phase 1-3
Same as MVP, but add:
- Obsidian plugin for direct publish
- Multiple deploy targets (mirror to IPFS)

### For Phase 6 (Distributed)
- Each node manages own deployment
- Publish to IPFS as primary
- DNS/IPNS for discovery
- Sync via Git or CRDT

---

## Open Questions

1. **How do nodes discover each other in distributed model?**
   - Central registry? DHT? DNS-based?

2. **How to handle content-addressed links across nodes?**
   - Transform wikilinks to CIDs?
   - Resolve at runtime?

3. **What's the minimum viable distributed setup?**
   - Just IPFS pinning?
   - Full node software?

4. **How does auth work in distributed model?**
   - Per-node auth?
   - Federated identity?

---

## Related Documents

- `cyberbase-architecture.md` - Overall system design
- `cyberbase-translation-layer.md` - Content transformation
- Research: IPFS, libp2p, OrbitDB for distributed state

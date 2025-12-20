# Build Scaling Strategy

**Status**: Future Consideration
**Relevant when**: Build times exceed 5 minutes or content exceeds ~5000 pages

---

## The Problem

Traditional SSG rebuilds everything on every change:
- 100 pages → ~10 seconds
- 1,000 pages → ~1-2 minutes
- 10,000 pages → ~10-20 minutes
- 100,000 pages → impractical

With many contributors making frequent changes, this compounds.

---

## Current Approach: Full Rebuilds

```
Push → Build All Pages → Deploy All
```

**Acceptable when:**
- < 5000 pages
- Build time < 5 minutes
- Infrequent updates (< 10/day)

**Cyberbase now:** Full rebuild is fine. Astro + Bun is fast.

---

## Scaling Options

### 1. Build Caching

Cache expensive operations between builds:

```
┌─────────────────────────────────────────┐
│              BUILD PROCESS               │
├─────────────────────────────────────────┤
│  Content Hash → Check Cache             │
│       │                                  │
│       ├─ Cache hit → Use cached result  │
│       └─ Cache miss → Process + cache   │
└─────────────────────────────────────────┘
```

**What to cache:**
- Parsed markdown AST
- Resolved wikilinks
- Graph calculations
- Image transformations

**Tools:**
- Astro content layer (built-in caching)
- Custom cache with Redis/file system
- Cloudflare KV for edge caching

### 2. Incremental Builds

Only rebuild what changed + its dependents:

```
File A changed
    │
    ▼
Build A + pages that link TO A + pages that link FROM A
```

**Challenges:**
- Dependency tracking is complex
- Wikilinks create hidden dependencies
- Graph view depends on everything

**Astro support:** Partial. Content collections cache, but pages still rebuild.

### 3. ISR (Incremental Static Regeneration)

Generate pages on-demand, cache at edge:

```
Request for /page/foo
        │
        ▼
┌─────────────────┐
│ Check CDN cache │
└────────┬────────┘
         │
    ┌────┴────┐
    │ Cached? │
    └────┬────┘
         │
    Yes ─┴─ No
     │      │
     ▼      ▼
  Serve   Generate
  cached  on-demand
          → cache
```

**Pros:**
- No rebuild needed for most changes
- Pay for what you use
- Scales infinitely

**Cons:**
- First request is slow (cold start)
- More complex architecture
- Need server/edge runtime

**Implementation:**
- Astro `output: 'server'` or `'hybrid'`
- Cloudflare Workers for edge rendering
- Stale-while-revalidate for freshness

### 4. Hybrid Static + Dynamic

Pre-build important pages, generate others on-demand:

```yaml
# astro.config.mjs
export default defineConfig({
  output: 'hybrid',  // Default static, opt-in to SSR
});

# For specific pages:
export const prerender = false;  // Generate on request
```

**Use cases:**
- Homepage, popular pages → static
- Long-tail content → on-demand
- User-specific views → dynamic

### 5. Distributed Build Model (Future Vision)

Each node builds independently:

```
┌─────────────┐  ┌─────────────┐  ┌─────────────┐
│   Node A    │  │   Node B    │  │   Node C    │
│  (1000 pg)  │  │  (500 pg)   │  │  (2000 pg)  │
│             │  │             │  │             │
│ Builds own  │  │ Builds own  │  │ Builds own  │
│   content   │  │   content   │  │   content   │
└─────────────┘  └─────────────┘  └─────────────┘
```

**No central build bottleneck.** Scale is horizontal.

Cross-node linking via content addressing (IPFS CID or Git SHA).

---

## Recommended Path for Cyberbase

### Phase 0-2 (Now - 6 months)
**Strategy:** Full rebuilds

- Content is small (< 1000 pages)
- Builds are fast (< 2 minutes)
- Focus on features, not optimization

### Phase 3-4 (6-12 months)
**Strategy:** Build caching + monitoring

- Add caching for translation layer
- Cache graph calculations
- Monitor build times
- Set alert at 5 minutes

### Phase 5+ (12+ months)
**Strategy:** Evaluate based on scale

If centralized:
- Implement ISR or hybrid mode
- Edge rendering for dynamic content

If distributed:
- Each node handles own builds
- No central scaling needed

---

## Build Time Optimization Checklist

Quick wins (do now):
- [x] Use Bun instead of npm (faster installs)
- [ ] Enable Astro content caching
- [ ] Minimize image processing in build

Medium effort (when needed):
- [ ] Cache wikilink resolution
- [ ] Pre-compute graph at intervals (not every build)
- [ ] Parallelize independent transformations

Major changes (if builds exceed 10 min):
- [ ] Switch to hybrid SSG/SSR
- [ ] Implement ISR with Cloudflare Workers
- [ ] Consider distributed model

---

## Monitoring

Track these metrics:
- Total build time
- Content parsing time
- Page generation time
- Deploy time

Add to CI:
```yaml
- name: Build site
  run: |
    start=$(date +%s)
    bun run build
    end=$(date +%s)
    echo "Build time: $((end-start)) seconds"
```

---

## Quick Reference: Enabling Hybrid Mode

When ready to switch from full static to hybrid (static + on-demand):

### 1. Install Cloudflare Adapter

```bash
cd site
bun add @astrojs/cloudflare
```

### 2. Update Astro Config

```js
// astro.config.mjs
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import cloudflare from '@astrojs/cloudflare';

export default defineConfig({
  output: 'hybrid',  // Static by default, opt-in to SSR per page
  adapter: cloudflare(),
  // ... rest of config
});
```

### 3. Mark Pages for On-Demand Rendering (Optional)

For pages that should render on request instead of at build time:

```astro
---
// In any .astro file
export const prerender = false;  // This page renders on request
---
```

### 4. Deploy

No changes needed to workflow - Cloudflare Pages automatically:
- Serves static pages from CDN
- Routes dynamic pages to Workers

### Cost

- Cloudflare Workers: 100,000 requests/day free
- Beyond that: $5/month for 10 million requests

### When to Use

| Page Type | Prerender | Why |
|-----------|-----------|-----|
| Homepage | Yes (default) | High traffic, rarely changes |
| Popular KB pages | Yes | Frequently accessed |
| Long-tail content | No | Rarely accessed, not worth build time |
| User-specific views | No | Must be dynamic |
| Search results | No | Query-dependent |

---

## Related

- `cyberbase-deployment-architecture.md` - Deployment options
- `cyberbase-translation-layer.md` - Content transformation (caching opportunity)
- Phase 6 plan - Distributed architecture

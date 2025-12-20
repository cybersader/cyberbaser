# Research: Astro + Obsidian Integration

**Date**: 2024-12-20
**Status**: In Progress

---

## The Challenge

Starlight (Astro's documentation theme) has its own content handling:
- Uses `docsLoader()` from `@astrojs/starlight/loaders`
- Expects content in `src/content/docs/`
- Has specific frontmatter schema (docsSchema)

The `astro-loader-obsidian` package:
- Is a general Astro content loader
- Handles Obsidian-specific syntax (wikilinks, embeds)
- Not specifically designed for Starlight

## Integration Options

### Option 1: Replace docsLoader with ObsidianMdLoader

**Approach**: Use Obsidian loader directly in Starlight

```typescript
import { defineCollection } from 'astro:content';
import { ObsidianMdLoader, ObsidianDocumentSchema } from 'astro-loader-obsidian';
import { docsSchema } from '@astrojs/starlight/schema';
import { z } from 'astro:schema';

export const collections = {
  docs: defineCollection({
    loader: ObsidianMdLoader({
      base: '../cyberbase',  // or wherever vault is
      pattern: '**/*.md',
    }),
    schema: docsSchema().extend(ObsidianDocumentSchema),
  }),
};
```

**Pros**: Direct Obsidian support
**Cons**: May break Starlight features that depend on docsLoader

### Option 2: Symlink Vault to Starlight Structure

**Approach**: Keep docsLoader, symlink Obsidian content

```bash
# Create symlink from vault to Starlight content
ln -s /path/to/cyberbase src/content/vault
```

**Pros**: Simple, uses native Starlight
**Cons**: Wikilinks won't work without additional transformation

### Option 3: Build-time Copy with Transformation

**Approach**: Transform Obsidian content at build time

```bash
# Pre-build script that:
# 1. Copies vault to src/content/docs
# 2. Transforms wikilinks to standard links
# 3. Converts callouts to MDX components
```

**Pros**: Full control over transformation
**Cons**: More complex build process

### Option 4: Custom Astro Integration

**Approach**: Build a custom Astro integration that:
1. Watches vault for changes
2. Transforms and copies to content/docs
3. Preserves Starlight compatibility

**Pros**: Best of both worlds
**Cons**: Most development effort

## Recommendation

**Start with Option 3** (Build-time transformation):

1. Simplest to implement initially
2. Can iterate on transformation logic
3. Clear separation of concerns
4. Can evolve into Option 4 later

## Key Transformations Needed

| Obsidian | Starlight/MDX |
|----------|---------------|
| `[[wikilink]]` | `[wikilink](/docs/wikilink)` |
| `[[link\|alias]]` | `[alias](/docs/link)` |
| `> [!note]` | `<Aside type="note">` |
| `![[embed]]` | Custom component or inline |
| Frontmatter `publish: true` | Filter during copy |

## Existing Tools

- **obsidian-export**: CLI to export Obsidian vault to standard MD
  - https://github.com/zoni/obsidian-export
  - Handles wikilinks, embeds
  - Written in Rust, very fast

- **remark plugins**:
  - `remark-wiki-link`
  - `remark-obsidian`
  - Can run in Astro's markdown pipeline

## Next Steps

1. Test Starlight with basic Obsidian markdown (no wikilinks)
2. Evaluate obsidian-export for transformation
3. Build minimal transformation script
4. Iterate on wikilink handling

## Related Documents

- `cyberbase-translation-layer.md` - The bigger picture on translation

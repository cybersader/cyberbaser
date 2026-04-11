# 02 — Ecosystem

> **Status**: 🌱 Skeleton. Each tool gets a real section after actual research.

The landscape of tools that touch the problem space cyberbaser operates in. This is not prior-art analysis (that's `04-PRIOR-ART.md`) — this is an inventory of *what exists*, grouped by the role each thing plays. Prior-art is about "what did they try and learn"; this file is about "what shelf do I grab a component from if I want X."

## Static Site Generators (the "publisher" layer)

### Astro (current choice)
> TODO: why we started here. Strengths: flexible, ecosystem, MDX support. Weaknesses: TODO.

### Starlight
> TODO: what it is, why we layered it on Astro. Navigation autogeneration, docs-specific defaults. Weaknesses: opinionated layout.

### Quartz v4
> TODO: the current baseline for "Obsidian→web" in the community. What it does well, what it gives up.

### Docusaurus
> TODO: the docs-site incumbent. What it teaches us about large wiki navigation.

### MkDocs Material
> TODO: Python-based, very polished. Why we didn't pick it.

### Logseq Publish
> TODO: parallel ecosystem, worth understanding because some concepts transfer.

## Obsidian-Native Publishing

### Obsidian Publish (official)
> TODO: the paid offering. What it includes, what it costs, why it's not a fit for cyberbaser.

### Digital Garden (plugin)
> TODO: community plugin. How it works. Lessons.

### Obsidian Export (plugin family)
> TODO: assorted plugins that turn a vault into markdown for another system.

## Headless CMS / Git-Backed CMS (the "contribution" layer)

### Decap CMS
> TODO: formerly Netlify CMS. Open Authoring is the killer feature.

### Sveltia CMS
> TODO: modern fork of Decap, worth tracking.

### TinaCMS
> TODO: another git-backed CMS. Different model (inline editing).

### GitHub Web Editor + PR workflow
> TODO: the baseline. No CMS at all — just the "Edit this page" link.

## Translation / Markdown Processing (the "round-trip" layer)

### unified / remark / rehype
> TODO: the AST ecosystem. Everything else is built on this.

### remark-wiki-link
> TODO: handles `[[wikilinks]]` → HTML.

### astro-loader-obsidian
> TODO: currently a dependency. What it does, where it falls short.

### Pandoc
> TODO: heavyweight alternative. Worth knowing about even if not used.

## Hosting

### Cloudflare Pages (current choice)
> TODO: why. Strengths: global CDN, free tier, Pages Functions. Weaknesses: TODO.

### GitHub Pages
> TODO: the baseline free option. Why not.

### Vercel / Netlify
> TODO: commercial alternatives with generous free tiers.

## Auth (for contribution workflows)

### GitHub OAuth
> TODO: the primary auth mechanism for Open Authoring. Requires OAuth proxy.

### Other identity providers
> TODO: not in scope for now but worth noting as an extension point.

---

## Gap Analysis

> TODO: after filling in the above, write one paragraph here: what's missing from the ecosystem? What combination of these tools does cyberbaser need that doesn't exist as a ready-made product? That gap is the reason cyberbaser exists.

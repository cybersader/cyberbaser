---
title: "Quartz spike + path census: the empirical results"
description: "The real 1420-page vault builds through Quartz in under two minutes and scores 20/20 on the OFM checklist — Quartz is adopted for the vault site (R14). The path census kills the mass-rename question: zero slug collisions, two lint violations."
sidebar:
  label: "Quartz spike results"
  order: 18
status: research
tags: [research, architecture, scaling, translation-layer]
---

The [renderer decisions proposal](/cyberbaser/research/proposal-renderer-urls/) specified a kill criterion in advance (D1) and a measurement protocol (D4). Both ran on 2026-07-25 against the real vault on ext4, alongside the path census that decides the filename policy (D3). This page is the condensed record; full raw reports are archived in the maintainer's workspace.

## Verdict: adopt Quartz for the vault site (R14)

The kill criterion was not met. Quartz v4.5.2 built all **1420 markdown pages in 1:55 wall, 2.42 GiB peak RSS, exit 0**, and scored **20/20** on the OFM checklist, graded by grep over the built HTML (items the vault doesn't exercise — block-id links, image/heading embeds, nested callouts — were graded on controlled fixtures through the same build). Notable passes: note and heading embeds inline server-side, collapsed callouts emit real fold markup, `aliases:` frontmatter produces meta-refresh redirect stubs exactly as the D2 URL contract assumed, and `%%comments%%` strip cleanly (131 source files contain them; the only 5 HTML hits are inside code fences).

This closes **Q02** (`astro-loader-obsidian` sufficiency) as not-applicable, permanently.

## The fine print that matters

**Quartz has no per-file error isolation.** One unparseable YAML frontmatter block aborts the entire build with no partial output. Exactly **4 files out of 1430 (0.28%)** hold that kill switch: three Templater templates with JS inside the frontmatter fence, and one content page whose first line is a `---` horizontal rule. Related: Quartz's default `ignorePatterns` lists lowercase `templates/`, and the vault's folder is `Templates/` — the glob is case-sensitive and silently doesn't match. Pre-publish fix: add the vault's `Templates/` to `ignorePatterns` and repair the one content page. The projection step should also run the frontmatter parse as a pre-flight so a future bad file fails with a filename instead of a stack trace.

**Quartz reports zero unresolved wikilinks; the truth is 1085 of 18,992 internal anchors (5.7%).** Measured independently over the emitted HTML, since Quartz emits no warning and no broken-link class. One systematic sub-cause: folder-relative markdown links resolve by basename only, so every Notion-exported relative link 404s. This is the [fidelity-break log's](/cyberbaser/research/proposal-write-path/) first real corpus, and a link-check belongs in the publish pipeline because the renderer will not do it.

**The sluggify divergence is real.** Quartz preserves path case verbatim; lowercasing is cyberbaser's extension in the [D2 contract](/cyberbaser/research/proposal-renderer-urls/), so the projection step must apply it (with natural-case aliases) before Quartz ever sees the files — and the URL conformance test must account for the divergence. Heading anchors use a different, lowercased slugger, so anchors and paths currently disagree on case.

**The output, not the input, is the Windows hazard.** The vault's own paths are clean, but 6 *emitted* paths contain colons (URLs that ended up in `tags:` arrays become `public/tags/https:/…` files), making the built artifact un-checkout-able on Windows. The safety lint must run over **derived** paths — tag values, aliases, permalinks — not just vault file paths.

**Size: 537.6 MB output, 53.8% of the GitHub Pages 1 GB cap.** The "asset copy blows the cap" prediction is falsified for this corpus. Breakdown: 363.8 MB copied assets, 147.4 MB HTML (~31 KB/page), 26.5 MB generated og-images. No file over 50 MiB, so nothing forces LFS. Untested: the 10-minute Pages deploy timeout against 7,466 files, and CI wall time (the 1:55 was on 24 cores; Actions runners have 2).

**Version caveat:** v4.5.2 was measured. Upstream's default is now v5 (YAML config, npm plugin loader). v4-vs-v5 is an open adoption sub-decision; the checklist result de-risks the family, not the major version.

## The path census: the mass-rename question is dead

The [filename policy debate](/cyberbaser/research/proposal-renderer-urls/) (ASCII kebab-case lint vs. unicode-everywhere) turned on unmeasured fear. Measured (4,183 paths, 52 ms):

| Safety rule | Violations |
| --- | --- |
| Slug collisions (the data-loss rule) | **0** — 4,183 paths → 4,183 distinct slugs |
| Windows-illegal characters | 0 |
| Reserved device names | 0 |
| Not NFC-normalized | 0 |
| Case-only duplicates | 0 |
| Leading/trailing whitespace | 1 (a leading space in one Clippings folder) |
| Path length > 200 | 1 (a 203-char path) |

**The entire safety lint costs this vault two renames.** Emoji (report-only, allowed): 2,521 paths carry a pictographic codepoint, but 2,519 of those come from just **75 directory segments** (`📁 98 - ARCHIVE` alone accounts for 485); only 83 file *basenames* have emoji. So even the optional emoji cleanup is 75 folder renames (free for wikilinks, which resolve by note name) plus an 83-file basename pass if ever wanted.

## What shipped alongside the measurements

`packages/publish` (`@cyberbaser/publish`, 91 tests green) now implements the boundary these results feed:

- **The selector** — default-deny precedence exactly as [specified](/cyberbaser/research/proposal-selective-publishing/), fail-closed on missing/invalid `publish.yml`, assets by reachability only, cross-boundary embeds as errors, a deterministic `publish-report.json`, and an `audiences:` map already parsed so v2 role tiers need no call-site change. Byte-identity is tested down to CRLF and binary content.
- **The slug contract + lint** — `sluggify` (Quartz-compatible + lowercase), the six safety rules, and the census as a reusable function.

## What this unblocks (the remaining pre-publish list)

1. Author the real `publish.yml` (the maintainer's folder walk — the one step only they can do)
2. The projection step wiring: vault → selector → lowercase/alias → frontmatter pre-flight → Quartz
3. The two lint renames + the 4 kill-switch files + `Templates/` ignore
4. Derived-path lint + output link-check in the pipeline
5. The v4-vs-v5 pick, then first real deploy to Pages

## Related

- [Renderer, URLs, filenames](/cyberbaser/research/proposal-renderer-urls/) — the proposal this validates (D1 verdict in, D3 settled, D2 divergence noted)
- [Selective publishing](/cyberbaser/research/proposal-selective-publishing/) — the selector spec now implemented
- [The v1 build plan](/cyberbaser/research/v1-build-plan/) — the R12 shape this executes
- External: [Quartz](https://quartz.jzhao.xyz/) · [GitHub Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)

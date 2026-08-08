# quartz-cyberbase

The Quartz renderer spoke for the `cybersader/cyberbase` site. It is a pinned,
reproducible wrapper around an upstream Quartz checkout, with zero forked Quartz
source.

## What this is (and is not)

Cyberbaser's architecture is hub-and-spoke: the hub is the round-trip,
trust/moderation and projection layer, and it is **renderer-agnostic**. A
renderer is a swappable spoke. This directory is one spoke, for one site.

Consequences that are load-bearing, not stylistic:

- **The vault carries no renderer files.** `cybersader/cyberbase` holds content
  and `publish.yml`. Everything Quartz-specific lives here, in cyberbaser.
- **The input is a projection, not the vault.** By the time `build.sh` runs, the
  content tree has already been filtered against `publish.yml`, pre-flighted for
  bad frontmatter, checked for case collisions, and leak-tested. **Paths are
  verbatim**: the projection copies each published file to its vault path
  byte-for-byte, with no lowercasing and no renames (`project.js` defaults
  `lowercase = false`; R16 deferred lowercasing to projection v2, because
  lowercased pages beside natural-case assets break relative references). Alias
  injection only fires on a case change, so under verbatim projection nothing is
  injected either. The projection is a disposable build input; the vault is never
  modified.
- **Nothing here may become load-bearing for the content.** If a second renderer
  (Starlight, Hugo, something else) is added tomorrow, the projection must not
  need to change. Anything Quartz needs that the projection cannot supply
  generically is a smell.

## Files

| File | Purpose |
| --- | --- |
| `setup.sh` | Clone Quartz at the pinned tag into a target dir, `npm ci`, copy configs and `components/` over the defaults. Idempotent. |
| `build.sh` | Point a projected content tree at that checkout and run `npx quartz build`. |
| `quartz.config.ts` | Site config: `baseUrl`, plugin/emitter chain, theme. |
| `quartz.layout.ts` | Component layout. Quartz imports this from the repo root, so it must be shipped even if it barely differs from upstream. Also holds `VAULT_REPO_URL`, the single declaration of the source repo. |
| `components/*.{ts,tsx}` | Cyberbaser-local Quartz components and pure helpers, copied into `<quartz>/quartz/components/` by `setup.sh`. `EditThisPage.tsx` keeps the public GitHub editor link and can instead emit an absolute cross-origin link to the privileged owner origin (the reader and owner run on different ports of one private numeric IPv4 address). `editLink.ts` owns URL construction, source-page eligibility, exact private-origin validation, and fail-closed build-mode resolution. `validate-owner-origin.ts` is the CLI wrapper `build.sh` uses for the same validation. |
| `tests/` | Focused Bun + shell assertions for public URL compatibility, exact owner query encoding, synthetic/tag-page exclusion, and build-mode guards. No added test framework. |
| `styles/custom.scss` | The theme stylesheet, copied to `<quartz>/quartz/styles/custom.scss` by `setup.sh`. See "Theme" below. |

## The pin

**Quartz `v4.5.2`** at immutable commit `4923affa7722dfc751f1074348e6dad214fe0c08`, with the repository, tag, and commit set in `setup.sh` as `QUARTZ_REPO`, `QUARTZ_REF`, and `QUARTZ_COMMIT`.

Rationale: v4.5.2 is the version actually measured against the vault during the
R14 spike on 2026-07-25. It scored **20/20** on the Obsidian-flavored-markdown
conformance suite and built the full vault in about 2 minutes. Pinning to the
measured version is the point: a floating `main` would silently change the
markdown semantics of a knowledge base whose whole premise is that authoring
semantics round-trip.

Known behavior of this version, all confirmed by measurement:

- **No per-file error isolation.** One file with invalid YAML frontmatter aborts
  the entire build. The projection must pre-flight and fail those files closed.
- **Path case is preserved.** Quartz does not lowercase. If lowercasing is ever
  wanted it is the projection's job, and today the projection does not do it
  either (R16: verbatim paths).
- **`ignorePatterns` globs are case-sensitive**, and are passed straight to
  globby, which skips dot-directories by default.
- **Derived output paths can contain colons** (e.g. URLs inside a `tags:` array).
  Those are un-checkout-able on Windows and must be linted out upstream.
- **Broken-link reporting is not trustworthy.** Quartz reported zero while ground
  truth was 5.7%. Link checking belongs in the pipeline, not here.
- **`%%` comment stripping is line-anchored.** Inline `%% … %%` mid-sentence, and
  some multi-line forms, leave a literal `%%` in the HTML. Rare (3 pages in a
  930-page build) and cosmetic, but it is a real fidelity gap.

**Open sub-decision: Quartz v5.** Not evaluated. Bumping the pin means re-running
the OFM conformance suite and the vault build, and re-checking every item above.
Do not bump it as a routine dependency update.

## Theme

"Slate + emerald": a calm, technical dark-first palette with a family
resemblance to the cyberbaser docs site (silver + emerald) and no shared code
with it. Two files own it.

**`quartz.config.ts` → `theme`** — the nine Quartz colour tokens per mode, plus
the three font families.

- Fonts: header **IBM Plex Sans**, body **Source Sans 3**, code **JetBrains
  Mono**. All three are core Google Fonts families, fetched by name at build
  time (`fontOrigin: "googleFonts"`). Source Sans 3 is the maintained successor
  to Source Sans Pro and is built for long-form screen reading, which is what
  this vault mostly is; JetBrains Mono keeps `0`/`O` and `1`/`l`/`I` apart in a
  vault full of commands and hashes.
- Contrast, measured (WCAG 2.1, against each token's own background — not
  eyeballed; recompute if you change a value):

  | token | light on `#f7f8f7` | dark on `#121614` |
  | --- | --- | --- |
  | `darkgray` (body text) | 9.46:1 AAA | 11.13:1 AAA |
  | `dark` (headings) | 16.22:1 AAA | 16.16:1 AAA |
  | `gray` (meta, "Edit this page") | 4.87:1 AA | 5.99:1 AA |
  | `secondary` (links) | 5.85:1 AA | 9.51:1 AAA |
  | `tertiary` (hover, active) | 7.69:1 AAA | 12.10:1 AAA |

  `lightgray` is a border/surface token and is never used for text. Inline code
  (`dark` on `lightgray`) is 13.47:1 / 11.78:1; internal links on their
  `highlight` background are 5.22:1 / 7.90:1; `==highlight==` text is 7.97:1 /
  5.84:1.

**`styles/custom.scss`** — the readability pass, in seven commented sections:
the explorer scroll fix, reading measure (`min(80ch, 100%)` on the centre
column), nested-list spacing and indent guides, tables, callouts,
"Edit this page", and small global items. It is appended after every upstream
component stylesheet, so an equal-specificity rule in it wins.

Callout hues are the one palette that is not read from `theme.colors`: Quartz
hardcodes them in `callouts.scss`. They are redefined here as `--cb-<name>`
custom properties with a separate value per mode, because the title text sits
on an 8% tint of its own hue and no single mid-tone clears 4.5:1 against both
`#f7f8f7` and `#121614`. Every pair was computed; all are ≥ 4.5:1.

### Changing it

- **A colour** — edit `quartz.config.ts`, recompute the contrast ratio against
  that token's background before committing, and update the table above.
- **A font** — edit `theme.typography`. The family must exist on Google Fonts
  under that exact name; the build fetches
  `https://fonts.googleapis.com/css2?family=<header>&family=<body>&family=<code>`
  and a build with a typo'd family silently falls back to `system-ui`. Check
  the emitted `public/index.css` for the family name after changing it.
- **Spacing, tables, callouts, the explorer** — `styles/custom.scss`. Re-run
  `setup.sh` (it re-copies the file) then `build.sh`.

### Known upstream defect fixed here

Quartz v4.5.2's `explorer.scss` applies `overscroll-behavior: contain` to every
`<ul>` under `.explorer-content`, and each folder's `<ul>` is `overflow: hidden`
for the collapse animation. `overflow: hidden` makes an element a scroll
container, so a wheel event over an expanded folder lands on a *non-scrollable*
scroll container whose `contain` refuses to pass the scroll up the chain —
hovering the file explorer and scrolling did nothing at all. Section 1 of
`custom.scss` keeps `contain` on the actual scroller (`.explorer-content >
ul.overflow`) and releases the nested lists. Verified on desktop, tablet and the
mobile menu; the sidebar's `position: sticky` is untouched.

## Local use

```bash
./setup.sh ~/bench/quartz-site                   # once (re-runnable)
./build.sh /path/to/projected/content ~/bench/quartz-site
# owner mode accepts one exact private numeric IPv4 origin (loopback, RFC 1918, or RFC 6598)
CYBERBASER_EDIT_LINK_MODE=owner CYBERBASER_OWNER_ORIGIN=http://127.0.0.1:4317 ./build.sh /path/to/projected/content ~/bench/quartz-site
./tests/run.sh
```

`build.sh` prints the output directory as its last line and propagates the
Quartz exit code. Useful env vars:

- `COPY_CONTENT=1` — copy the content tree instead of symlinking it.
- `OUTPUT_DIR=…` — override the output path (default `$QUARTZ_DIR/public`).
- `CYBERBASER_EDIT_LINK_MODE=public|owner` — selects edit-link behavior at build
  time. `public` is the default and preserves the GitHub edit URL. `owner` emits
  `/owner/edit?relativePath=…&slug=…` with both exact values percent-encoded.
  Owner mode is same-origin, local-only, and rejected when `CI` is true.
- `QUARTZ_REF=…` — override the pin in `setup.sh` (for evaluating a bump only).

## How CI uses it

The deploy runs from the vault repo, which owns the Pages environment, but the
renderer and the pipeline are cloned from cyberbaser (public):

1. Check out `cybersader/cyberbase` (the content).
2. Check out `cybersader/cyberbaser` (this directory + `packages/publish`).
3. Run the projection: `publish.yml` boundary, frontmatter pre-flight,
   case-collision guard, verbatim path copy, post-hoc leak test. Output: a
   projected content tree.
4. `renderers/quartz-cyberbase/setup.sh "$RUNNER_TEMP/quartz"`
5. `renderers/quartz-cyberbase/build.sh "$PROJECTED" "$RUNNER_TEMP/quartz"`
6. `actions/upload-pages-artifact` on `$RUNNER_TEMP/quartz/public`, then
   `actions/deploy-pages@v4` (`build_type: workflow`).

CI always builds public edit links. Public mode is the default, invalid modes
fail before Quartz runs, and owner mode is rejected whenever `CI` is true. The
owner route is fixed to same-origin `/owner/edit`; there is no configurable
localhost or owner host value that can leak into generated output.

`baseUrl` is `cybersader.github.io/cyberbase`, matching the project-Pages base
path `/cyberbase`. If the site ever moves to a custom domain, that string and the
Pages config change together, and nothing else here does.

## Swapping renderers

Add a sibling directory, e.g. `renderers/starlight-cyberbase/`, exposing the same
two-script contract:

- `setup.sh [TARGET_DIR]` — materialize a pinned renderer, idempotently.
- `build.sh CONTENT_DIR [TARGET_DIR]` — render the projected tree, print the
  output directory, propagate the exit code.

Then point CI's steps 4 and 5 at it. The projection, `publish.yml`, and the vault
stay untouched. That is the test for whether the boundary is still intact: if
swapping a renderer requires editing anything outside `renderers/`, the hub has
leaked into a spoke.

## Related

- `.claude/PROJECT_CONTEXT.md` — the renderer-agnostic boundary and hub/spoke split
- `docs/src/content/docs/design/translation-layer.mdx` — OFM tier system this
  renderer is measured against
- `packages/publish` — the `publish.yml` boundary and `sluggify()` used by the projection
- `packages/projection` — produces the projected content tree this renderer consumes
- Upstream: <https://github.com/jackyzha0/quartz> · <https://quartz.jzhao.xyz/configuration>

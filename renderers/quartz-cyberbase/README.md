# quartz-cyberbase

The Quartz renderer spoke for the `cybersader/cyberbase` site. It is a pinned,
reproducible wrapper around an upstream Quartz checkout: five files here, zero
forked Quartz source.

## What this is (and is not)

Cyberbaser's architecture is hub-and-spoke: the hub is the round-trip,
trust/moderation and projection layer, and it is **renderer-agnostic**. A
renderer is a swappable spoke. This directory is one spoke, for one site.

Consequences that are load-bearing, not stylistic:

- **The vault carries no renderer files.** `cybersader/cyberbase` holds content
  and `publish.yml`. Everything Quartz-specific lives here, in cyberbaser.
- **The input is a projection, not the vault.** By the time `build.sh` runs, the
  content tree has already been filtered against `publish.yml`, lowercased per
  segment, pre-flighted for bad frontmatter, and had natural-case `aliases:`
  injected. The projection is a disposable build input; the vault is never
  modified.
- **Nothing here may become load-bearing for the content.** If a second renderer
  (Starlight, Hugo, something else) is added tomorrow, the projection must not
  need to change. Anything Quartz needs that the projection cannot supply
  generically is a smell.

## Files

| File | Purpose |
| --- | --- |
| `setup.sh` | Clone Quartz at the pinned tag into a target dir, `npm ci`, copy configs over the defaults. Idempotent. |
| `build.sh` | Point a projected content tree at that checkout and run `npx quartz build`. |
| `quartz.config.ts` | Site config: `baseUrl`, plugin/emitter chain, theme. |
| `quartz.layout.ts` | Component layout. Quartz imports this from the repo root, so it must be shipped even if it barely differs from upstream. |

## The pin

**Quartz `v4.5.2`** (commit `4923aff`), set in `setup.sh` as `QUARTZ_REF`.

Rationale: v4.5.2 is the version actually measured against the vault during the
R14 spike on 2026-07-25. It scored **20/20** on the Obsidian-flavored-markdown
conformance suite and built the full vault in about 2 minutes. Pinning to the
measured version is the point: a floating `main` would silently change the
markdown semantics of a knowledge base whose whole premise is that authoring
semantics round-trip.

Known behavior of this version, all confirmed by measurement:

- **No per-file error isolation.** One file with invalid YAML frontmatter aborts
  the entire build. The projection must pre-flight and fail those files closed.
- **Path case is preserved.** Lowercasing is the projection's job, not Quartz's.
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

## Local use

```bash
./setup.sh ~/bench/quartz-site                   # once (re-runnable)
./build.sh /path/to/projected/content ~/bench/quartz-site
```

`build.sh` prints the output directory as its last line and propagates the
Quartz exit code. Useful env vars:

- `COPY_CONTENT=1` — copy the content tree instead of symlinking it.
- `OUTPUT_DIR=…` — override the output path (default `$QUARTZ_DIR/public`).
- `QUARTZ_REF=…` — override the pin in `setup.sh` (for evaluating a bump only).

## How CI uses it

The deploy runs from the vault repo, which owns the Pages environment, but the
renderer and the pipeline are cloned from cyberbaser (public):

1. Check out `cybersader/cyberbase` (the content).
2. Check out `cybersader/cyberbaser` (this directory + `packages/publish`).
3. Run the projection: `publish.yml` boundary, per-segment lowercasing,
   frontmatter pre-flight, alias injection. Output: a projected content tree.
4. `renderers/quartz-cyberbase/setup.sh "$RUNNER_TEMP/quartz"`
5. `renderers/quartz-cyberbase/build.sh "$PROJECTED" "$RUNNER_TEMP/quartz"`
6. `actions/upload-pages-artifact` on `$RUNNER_TEMP/quartz/public`, then
   `actions/deploy-pages@v4` (`build_type: workflow`).

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

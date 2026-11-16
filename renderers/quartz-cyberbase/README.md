# quartz-cyberbase

The Quartz renderer spoke for the `cybersader/cyberbase` site. It is a pinned,
reproducible wrapper around an upstream Quartz checkout. Default builds leave
upstream source unchanged. Optional source provenance uses a small hash-attested
adapter patch in the disposable checkout, not a separately maintained Quartz fork.

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
| `components/*.{ts,tsx}` | Cyberbaser-local Quartz components and pure helpers, copied into `<quartz>/quartz/components/` by `setup.sh`. `EditThisPage.tsx` keeps the public GitHub editor link and can instead emit an absolute cross-origin link to the privileged owner origin. `SuggestCorrection.tsx` is a separate disabled-by-default account-free form: when explicitly enabled, it exposes only the public intake action, retained binding digest, and opaque page ID. The helpers own exact URL/source validation, page-ID derivation, strict browser payload construction, response bounds, and retry idempotency. `validate-owner-origin.ts` is the CLI wrapper `build.sh` uses for owner validation. |
| `tests/` | Focused Bun + shell assertions for public URL compatibility, exact owner query encoding, synthetic/tag-page exclusion, build-mode guards, disabled account-free configuration, opaque page IDs, strict browser payloads, bounded responses, and retry behavior. No added test framework. |
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

## Optional source provenance

Set `CYBERBASER_SOURCE_PROVENANCE=enabled` for both `setup.sh` and `build.sh` to
emit `<page-slug>.provenance.json` beside each source-backed HTML page. Unset or
`disabled` keeps the existing output; other values fail closed. This is build
metadata for a browser suggestion ledger, not a source writer or an enabled
editing interface.

The adapter captures the exact input bytes before Quartz trims them, carries
per-file maps through text transforms and the Markdown/HTML pipeline, and emits
after transclusion expansion. SHA-256 and byte length describe the **build input**,
including original CRLF and leading/trailing whitespace, not normalized Markdown
or HTML. The normal verbatim publication projection preserves that identity. A
caller that rewrites projected content must not equate this digest with the
canonical source digest: it needs its own proven projection mapping or must fall
back to source editing.

### Contract v1

`plugins/provenanceContract.ts` is renderer-neutral. `ProvenanceSink.write(page,
manifest)` is the small pluggable emission interface. Quartz supplies a filesystem
sink; another renderer can produce the same manifest without depending on Quartz
or its patch.

Example HTML for the seven-byte source `Hi 😀`:

```html
<p data-cb-node="cb0">Hi 😀</p>
```

Corresponding sidecar shape (`sha256` below stands for the 64-character lowercase
hex digest of those exact seven bytes):

```json
{
  "schema": "cyberbaser.source-provenance",
  "version": 1,
  "source": { "path": "note.md", "byteLength": 7, "sha256": "<sha256>" },
  "leaves": [{
    "id": "cb0.0", "parent": "cb0", "child": 0, "text": "Hi 😀",
    "runs": [{ "rendered": [0, 5], "source": [0, 7], "kind": "exact" }],
    "exact": [0, 7]
  }]
}
```

- `source.path` is the POSIX path relative to the published input directory, never
  an absolute local path. Original source content is not included in the sidecar.
- Each leaf identifies one DOM `Text` child using its existing parent's
  `data-cb-node` and its **`childNodes` index**, not `children` index. `$body` means
  the source body root, normally `article.popover-hint` in this adapter. `id` is
  the deterministic parent/index pair. IDs are stable for an identical input and
  pinned pipeline, not persistent IDs across source changes.
- `text` is exact DOM `Text.data`, including whitespace before CSS layout collapse.
  Browser CRLF normalization is accounted for. `rendered` ranges are half-open
  **UTF-16** coordinates for DOM selection; `source` ranges are half-open **UTF-8
  byte** coordinates, always at complete Unicode boundaries.
- `kind: "exact"` means the indicated source bytes decode to the indicated text.
  Adjacent exact ranges are coalesced only when source intervals touch. `exact`
  on a leaf additionally certifies its entire text as one contiguous source slice.
- `kind: "atom"` retains the full source atom for a rendered transformation:
  entities, Markdown escapes, smart punctuation, normalized line endings and
  arrows. It does **not** claim that source bytes equal the displayed character.
  A consumer must replace a complete atom, never an interior portion.
- Unmapped runs have a `reason` instead of `source`/`kind`. Current codes are
  `target-derived-wikilink`, `target-derived-tag`, `callout-title`, `math`,
  `transclusion`, `raw-text-element`, `generated-whitespace`, and
  `generated-or-unmapped`. They are explicitly not editable in place.

Only parent attributes are added. No text wrappers, new layout boxes, innerHTML
replacement, or source serialization are introduced. Adjacent HAST text nodes are
merged with their maps because HTML parsing merges them too. This minimizes DOM
changes, including inside tables, syntax highlighting and MathML. Authored
`data-cb-*` attributes are removed before assigning adapter locators.

The browser must scope lookup to the source body, require exactly one matching
parent and text child, compare `Text.data` with `text`, and verify the full pinned
source identity before using any interval. Revalidate after DOM mutation. Reject
missing/duplicate locators, stale text, surrogate-interior positions, partial
atoms, gaps, overlaps, and cross-source or discontinuous selections. Unannotated
chrome/generated component text is not editable. Malformed author HTML or later
client rewriting can invalidate locators; do not guess a replacement match.
Provenance alone is not authentication, approval, Markdown safety, a freshness
check, or permission to apply a change. The proposal and integrity gates remain
mandatory.

### Pinned adapter patch

`patches/quartz-4.5.2-provenance.patch` changes exactly four upstream files:

| Upstream file | Adapter seam |
| --- | --- |
| `quartz/plugins/types.ts` | Optional pre-parse, per-file text-transform, HTML-handler and final-render hooks. |
| `quartz/processors/parse.ts` | Invoke pre-trim capture; pass the same file through preprocessing; install supported `mdast-util-to-hast` handlers. Used by both single-thread and worker builds. |
| `quartz/plugins/transformers/ofm.ts` | Route find-and-replace through our local position-preserving adapter. |
| `quartz/components/renderPage.tsx` | Invoke final annotation after transclusions are expanded. Transcluded text is noneditable rather than incorrectly bound to the hosting page. |

`patches/quartz-4.5.2-provenance.sha256.json` records pristine and enabled SHA-256
for every target. Both setup and build verify all targets before applying anything;
unknown hashes, substituted paths, and mixed patch states fail closed. Exact
already-enabled hashes allow idempotent enabled builds. Disabled builds refuse an
already-patched checkout: re-run setup from the pristine seed instead of silently
leaving enabled code or stale sidecars in an off build. The seed is read-only.
No `node_modules` files are patched. The local find-and-replace adapter retains the
upstream MIT license. No global hooks or `String.prototype` mutations are used.

### Verification

Run the lightweight contract/guard and existing renderer checks:

`build-contained -- bash renderers/quartz-cyberbase/tests/run.sh`

Run real-CLI synthetic acceptance (requires the installed pinned offline seed):

`build-contained -- node renderers/quartz-cyberbase/tests/provenance-build.mjs`

Run the 57-page corpus gate, extracting only the permitted curation folder through
`git archive origin/main` into a fresh temporary directory:

`CYBERBASER_CORPUS_VAULT=/path/to/vault build-contained -- node renderers/quartz-cyberbase/tests/provenance-build.mjs --corpus`

The vault path is supplied by the operator and never stored in the repository.

`QUARTZ_SEED_DIR` can select another pristine, pin-verified offline seed. The test
materializes its own checkout and never uses a running rehearsal. Test-only config
uses local fonts and omits social-image generation to avoid font downloads;
**the complete configured source-transformer chain, actual Quartz CLI, emitters,
page rendering, and final HTML parse remain in use**. This is mechanical static
build acceptance, not a browser editing/usability claim.

Measured on 2026-11-16: **125,462 / 126,944 substantive body Unicode characters
mapped (98.8326%) across 57 pages**, comprising 125,336 exact characters and 126
transformed atoms. All final HTML text locators were checked, and all **3,092
exact whole-leaf ranges** matched the original source bytes. The denominator
excludes whitespace-only leaves and collapses HTML ASCII whitespace outside
`pre`, matching the prior research measure; raw text maps are also checked.

Synthetic acceptance covers emoji, CRLF, entities, escapes, alias versus
target-derived wikilinks, callouts, tables, inline HTML, inline/fenced code,
math, and transclusions. It proves two-worker/single-thread equivalence and an
exact source splice whose rebuilt body changes only the declared prose. The
uninstrumented versus disabled golden matched **all 16 emitted fixture files
byte-for-byte**. Hash-drift rejection is exercised too.

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
- `CYBERBASER_ACCOUNT_FREE_INTAKE=enabled` — explicit opt-in for the account-free
  form. Unset is the fail-closed default. Enabling also requires one exact
  intake origin (canonical HTTPS, or a private-network IPv4 HTTP origin with an
  explicit port for the owner's local site), retained binding digest,
  credential-free source repository, and immutable source revision through the
  corresponding `CYBERBASER_ACCOUNT_FREE_*` variables. The browser receives
  the intake action, binding digest, and opaque page ID, plus published source
  identity when provenance is separately enabled. Current public
  builds leave this unset; the form is not offered publicly. The owner app sets
  these itself for the private local site when its `suggestions.form` is on.
- `CYBERBASER_SUGGESTION_CHALLENGE_SITE_KEY=…` — optional public challenge site
  key, meaningful only when the correction form is enabled. The default provider
  is Turnstile, whose keys use 1–256 ASCII letters, digits, underscores or hyphens.
  Empty or provider-rejected values fail the enabled build. Without a key, no
  widget or provider script loads and the JSON request stays unchanged. With a
  key, opening an inline editor loads the selected provider's script and renders
  a `suggest-correction` widget before the Send button. The single-use token goes only in `Cyberbaser-Challenge-Token`, never
  the JSON intent or URL, and the widget resets after every attempt. Server-side
  verification and a matching CORS header allowlist are required separately;
  this renderer neither verifies tokens nor holds a secret.
- `CYBERBASER_SUGGESTION_CHALLENGE_PROVIDER=…` — optional registry id; defaults to
  `turnstile`. An unknown id (including an empty string) fails an enabled build,
  even without a site key. A valid provider id alone never enables a widget.
  Disabled correction forms ignore both challenge inputs.
- `QUARTZ_REF=…` — override the pin in `setup.sh` (for evaluating a bump only).

This renderer emits no Content-Security-Policy meta tag or hosting header.
A host that supplies its own CSP must allow `https://challenges.cloudflare.com`
in both `script-src` and `frame-src` only when the challenge is configured.
Owner-alpha's separate reader CSP and explicit build-environment allowlist do
not yet pass or allow this optional key; exporting it in the parent shell alone
will not enable the widget through that app. These offline tests do not validate
live Turnstile or authorize enabling a public form. Other providers require their
own reviewed script/frame CSP permissions; no provider adds host policy itself.

## Suggesting an edit on the page

With the account-free form enabled and `CYBERBASER_SOURCE_PROVENANCE=enabled`
passed to **both setup and build**, readers can suggest changes directly on the
rendered page. The existing **Suggest an edit** entry turns on **Suggesting**;
the toggle switches between reading and suggesting without losing the draft.

1. Click into mapped text and type to insert. Select words and type to replace.
   Backspace/Delete suggests a deletion. The original text stays visible in red
   strikethrough; additions appear in green underline. Link labels and bold text
   retain their links/formatting. Edits inside green text update that same change.
2. Each change has a desktop margin card or mobile bottom-tray card with an
   optional comment and **Discard**. **Your changes** reviews the complete batch.
   Draft operations and local comments survive reload in sessionStorage, keyed
   by opaque page ID and the pinned base digest. Discard restores original text.
3. Add an optional **Why?**, HTTPS **Source link**, and configured bot check, then
   choose **Send N suggestions**. Comments join the submission rationale, not the
   five-field operation records. Successful submission shows the queue receipt,
   clears the draft and marks, and returns the unchanged original page. Only an
   owner can apply a proposal to the source.

Generated text, transformed atoms and discontinuous selections are not edited
by guesswork. Dashed hints explain that these regions need a future source
editor. Plain-text paste uses the same exact-range route; HTML paste, drops,
formatting commands and native document undo cannot mutate the source model.
Use **Discard** to restore a suggestion. Selections must stay within one verified
exact run, not cross Markdown syntax boundaries. IME input is captured separately
from the browser's transient composition DOM.

### Sparse source model and v2 submission

The sidecar identity must match the page's separately embedded provenance
`{path, byteLength, sha256}`. Every leaf must identify one unique parent and the
exact `childNodes` text child. Stale text, invalid offsets, surrogate interiors,
missing/duplicate parents and overlapping source ranges refuse suggesting mode.
Only verified exact runs become editable. Owned wrappers retain their pinned
origins; DOM text and locator ownership are rechecked before editing or sending.
The page's original Text nodes are retained and restored during SPA cleanup.

`@cyberbaser/suggestion-ledger` requires the **complete base bytes** and verifies
their digest. This browser deliberately has neither. `suggestModeModel.ts` is a
thin sparse origin-token adapter instead: original Unicode tokens retain exact
base-byte coordinates, inserted tokens have no original coordinates, and
operations come only from verified run slices. It never pads unknown regions,
invents offsets, fetches raw Markdown, serializes HTML to Markdown, or claims to
validate a full-file digest. The intake resolves and verifies the complete
historical source. Adjacent/dependent edits within one run coalesce; independent
operations sort by pinned offsets and cannot overlap.

The browser posts the strict v2 account-free correction intent to
`/v2/suggestions` on the configured intake origin. Each operation is exactly
`{operationId,start,end,expected,replacement}` with UTF-8 offsets into the original
base. The batch has at most 50 operations, 16 KiB per expected/replacement span,
and 64 KiB aggregate text. Optional rationale/evidence and stable retry keys use
the existing intent/challenge policy. Challenge tokens remain header-only. No
source path, author, repository, revision or candidate file enters the intent.
The only new browser fetch is the same-origin provenance JSON; no other service
is added beyond the configured intake and optional challenge provider.

### Missing or stale provenance falls back to the block editor

Without a valid sidecar and matching embedded identity, the existing pencil and
selection editor remains available. Select words and choose **Suggest edit**, or
click a block pencil. The block opens as a full-width plain-text editor. **Cancel**
or **Escape** restores the original nodes; sending shows a receipt beside the
unchanged original block. Nested containers are not flattened. This fallback
continues using `/v1/corrections` with derived quote/context/replacement, not v2.
Its Unicode/word-boundary diff supplies up to 40 code points of adjacent context;
blank **Why?** uses `Suggested an edit to this page.` Formatting can prevent exact
quote matching, which explains that the reader should choose a smaller phrase.

Disabled forms still emit no markup, CSS or browser scripts. Provenance remains
separately opt-in; leaving both features off preserves the existing build output.

### Verification

Run `build-contained -- bash renderers/quartz-cyberbase/tests/run.sh` for the
existing fallback/challenge checks plus fake-DOM provenance, sparse operations,
strict v2 intent/receipt and 2,400 deterministic Unicode reconstruction checks.
Run `build-contained -- node renderers/quartz-cyberbase/tests/suggest-build.mjs`
for an offline three-page pinned Quartz build and real headless Playwright
selection/typing, link/bold/insert byte-splice reconstruction, inserted-text edits,
draft reload, mobile tray, noneditable refusal, v2 receipt and stale/missing
sidecar fallback. It uses the existing offline seed (override
`QUARTZ_SEED_DIR` with an absolute path), throwaway fixture files and a random
loopback port; it does not touch any running rehearsal or real vault.
Strict browser checking is
`build-contained -- docs/node_modules/.bin/tsc -p renderers/quartz-cyberbase/tests/tsconfig.browser.json`.
These are mechanical checks, not a human usability or live challenge acceptance.

## Adding a challenge provider

The browser contract is `ChallengeProvider` in `components/challenge/registry.ts`:

```ts
{
  id: string,
  scriptUrl: string, // constant credential-free HTTPS URL
  validateSiteKey(key: string): boolean,
  mount(container, { siteKey, action, onToken, onExpire, onError }): {
    reset(): void,
    remove(): void,
  },
}
```

The core form owns script loading once per URL, bounded in-memory tokens, the
`Cyberbaser-Challenge-Token` header, keeping tokens out of the body and URL,
disabling submit without a token, resetting after each attempt, SPA cleanup, and
plain error messages. Providers only render and report tokens or lifecycle
callbacks. They must disable SDK-generated response form fields, avoid script
loading, requests and token storage, and access browser globals only inside
`mount`. `validateSiteKey` is pure and rejects unsafe configuration. Build-time
imports must work without a browser. Script URLs must never depend on site keys,
form fields, environment values, or other runtime input.

To contribute one provider:

1. Add `components/challenge/providers/<id>.ts`, exporting an object that satisfies
   `ChallengeProvider`. Use a stable lowercase id, one constant HTTPS script URL,
   provider-specific safe public-key validation, and an adapter from the SDK's
   callbacks and widget handle to the contract. Start from `providers/turnstile.ts`.
2. Statically import that object in `components/challenge/registry.ts` and add
   `[provider.id, provider]` to its `providers` map. No core form branch, dynamic
   import, or custom script loader is needed. `setup.sh` copies the entire
   challenge directory, and the inline browser entry bundles the static registry.
3. Add `tests/<id>-provider.test.ts`. Import the provider and call
   `runChallengeProviderConformance` from `tests/conformance/challenge-provider.ts`
   with a safe fake site key and an `install(fakeWindow)` SDK fixture. That fixture
   returns token/expiry/error triggers, mount assertions, and reset/remove
   counters; see `tests/turnstile-provider.test.ts`. The shared suite supplies the
   fake DOM/global and prohibits script loading and requests. It checks constant
   HTTPS script configuration, unsafe-key rejection, token delivery, expiry,
   errors, reset, and removal. The runner discovers `*-provider.test.ts` files.
4. From the repository root run
   `build-contained -- bash renderers/quartz-cyberbase/tests/run.sh`. The lifecycle
   suite also bundles the real inline entry and tests header-only transport,
   submission gating, per-attempt resets, loader failures, and SPA cleanup offline.
5. Add the matching server-side verifier provider with **the same id** in
   `apps/account-free-intake`, using that side's registry and conformance suite.
   Configure `botCheck.provider: '<id>'` there and
   `CYBERBASER_SUGGESTION_CHALLENGE_PROVIDER=<id>` here. Document the provider's
   host CSP requirements and verification configuration in the PR. Browser
   conformance alone is not server verification or permission to offer the lane.

## How CI uses it

The deploy runs from the vault repo, which owns the Pages environment, but the
renderer and the pipeline are cloned from cyberbaser (public):

1. Check out `cybersader/cyberbase` (the content plus its cumulative URL baseline).
2. Check out immutable Cyberbaser commit `eac9f1f` (renderer, projection, and checker).
3. Run the projection: `publish.yml` boundary, frontmatter pre-flight,
   case-collision guard, verbatim path copy, post-hoc leak test. Output: a
   projected content tree.
4. `renderers/quartz-cyberbase/setup.sh "$RUNNER_TEMP/quartz"`
5. `renderers/quartz-cyberbase/build.sh "$PROJECTED" "$RUNNER_TEMP/quartz"`
6. Run `cb-urlcheck` against `.cyberbaser/url-baseline.xml`; upload its
   deterministic report and stop before Pages upload on any uncovered URL.
7. `actions/upload-pages-artifact` on `$RUNNER_TEMP/quartz/public`, then
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

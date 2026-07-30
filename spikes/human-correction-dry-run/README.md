# Human correction dry-run harness

This is a private, standalone Bun project for repeatable correction dry runs. It produces **internal agentic evidence only**. It is not a human pilot attempt, participant study, product runtime, hosted review console, intake endpoint, editor, writer, or account-free contribution path.

The base harness reads one owner-mapped Markdown file from a caller-supplied local checkout, prepares one exact quote replacement, applies one candidate splice in memory, composes OFM and trust checks, and emits a redacted local review artifact. It never writes the source file.

An explicit `live-run` lane adds local publication and rendering evidence. It verifies a clean checkout at a caller-pinned commit, creates separate temporary baseline and candidate vault copies, applies the prepared splice only to the candidate copy, composes the current Cyberbaser selector/projection/boundary verifier when `publish.yml` is present, and renders both projections in separate pinned-Quartz workspaces. Both static outputs pass through `checkSite`; the review evidence records a deterministic candidate-only broken-link delta over `(page, href, decoded, class)` and exact rendered-target text counts. Temporary vaults, projections, Quartz workspaces, and sites are removed in a `finally` path. The supplied checkout is checked again after the run.

## Safety boundary

- One existing UTF-8 Markdown file.
- One owner-supplied source path. It may be repository-relative or an exact absolute path inside the supplied checkout.
- One exact quote, with optional immediately adjacent `prefix` and `suffix`.
- One contiguous replacement splice.
- No fuzzy matching, slug-to-source inference, rebasing, normalization, or whole-file serialization.
- No source writes, commits, pushes, account operations, or public deployment.
- `dry-run` and all normal tests are offline. `live-run` invokes the renderer's setup contract, which may use the network for its Git clone or dependency installation. `--quartz-repo` can make the Git source local, but dependency installation remains renderer-owned. The lane never contacts or modifies the public vault checkout.
- `live-run` rejects symbolic links anywhere in the supplied checkout before copying, projection, or rendering, so a public checkout cannot redirect the harness to host files.
- Review JSON and HTML redact the source path and raw evidence. They contain source text only from the selected quote and optional selector context.
- The static HTML has no scripts, forms, links, images, remote resources, or credential-bearing fields.

The write boundary comes from [`@cyberbaser/correction`](../../packages/correction/). [`@cyberbaser/ofm`](../../packages/ofm/) validates the before/after change, and [`@cyberbaser/trust`](../../packages/trust/) routes it under a caller-injected owner policy. The base `dry-run` does not invent projection, render, or link results. The explicit `live-run` composes [`@cyberbaser/publish`](../../packages/publish/), [`@cyberbaser/projection`](../../packages/projection/), [`@cyberbaser/linkcheck`](../../packages/linkcheck/), and the unmodified pinned [`quartz-cyberbase`](../../renderers/quartz-cyberbase/) spoke against temporary copies only.

See the canonical [concierge human-correction pilot](../../docs/src/content/docs/research/concierge-human-correction-pilot.mdx) for the larger study procedure. The selector shape is related to the [Web Annotation Text Quote Selector](https://www.w3.org/TR/annotation-model/#text-quote-selector), while the digest representation follows [RFC 9530](https://www.rfc-editor.org/rfc/rfc9530.html).

## Recorded internal run

One selected Cyberbase spelling correction completed the full internal no-write and isolated rendering sequence on 2026-07-28. The quote resolved once at byte range `[302, 394)`; 302 prefix bytes and 2,284 suffix bytes remained identical; OFM returned `clean`; baseline and candidate projections each contained 933 pages and 373 assets; separate Quartz `v4.5.2` builds showed the exact old-to-new rendered text change; and both sites retained the same 779 inherited broken-link tuples with zero candidate-only findings. The supplied checkout remained clean and byte-identical, no source write or deployment occurred, and temporary workspaces were removed.

This is **internal agentic and mechanical evidence only**. It contributes zero attempts to the 3-of-5 reader threshold, zero corrections to the independent-owner accepted-and-live threshold, and no human timing or owner-preference evidence. The injected `agent` / `auto-merge` trust result is a classification under a test policy, not owner approval.

Detailed outcomes, observed command-scope failures, machine timings, limitations, and remaining human work are recorded in [`RESULTS.md`](./RESULTS.md). The retained artifacts are intentionally sanitized:

- [`results/ir-drop-responsibilities.case.json`](./results/ir-drop-responsibilities.case.json): selected public text and redacted source mapping only.
- [`results/ir-drop-responsibilities.result.json`](./results/ir-drop-responsibilities.result.json): deterministic mechanical, projection, rendering, link-delta, and isolation evidence.
- [`results/ir-drop-responsibilities.review.html`](./results/ir-drop-responsibilities.review.html): static local review card with restrictive CSP and no active controls or remote resources.

They are review evidence, not runnable private inputs. Raw source mapping, local paths, and underlying evidence remain outside tracked artifacts.

## Install and verify

```bash
bun install --frozen-lockfile
bun test
bun run verify
```

`bun run verify` is the authoritative offline synthetic verifier. It reads only the synthetic public Markdown fixtures and prints deterministic JSON. A nonzero exit means at least one named criterion failed. Bun may print its fixed `$ bun run bin/verify.js` package-script launcher banner to standard error; that banner is not a verifier diagnostic.

## Run owner self-dogfood on Cyberbase

Owner self-dogfood is the immediate use of this harness. It reuses the same case, evaluation, review, checkout, projection, rendering, link-delta, and decision-binding modules, but uses distinct `OD-01` through `OD-99` attempt IDs and the `owner-self-dogfood` profile. One maintainer may switch between reader and owner contexts. Status, preparation, rendering, review-card, and validated-decision outputs report `evidenceClass: owner-self-dogfood`, `countsTowardHumanPilot: false`, and `independentOwnerEvidence: false`; raw input/scaffold files are not evidence-classification outputs.

Before any `OD-*` attempt, privately precommit the series. The non-overwriting charter declares three to five unique attempt IDs, assigns each of the five required obligations exactly once, uses every declared ID, names the planned signed-out phone/OS/browser, and fixes the maintainer-only evidence boundary. Its schema provides no dedicated fields for candidates, paths, URLs, quotes, replacements, notes, decisions, or observations, and rejects unknown field names. Use the mobile labels only to name the actual environment, not to embed other private data.

Example shape only; replace the sample device, operating system, and browser with the actual planned environment before initialization:

```json
{
  "schemaVersion": 1,
  "artifactType": "private-owner-self-dogfood-series-charter",
  "profile": "owner-self-dogfood",
  "attemptIds": ["OD-01", "OD-02", "OD-03"],
  "obligationAssignments": {
    "normal-correction": "OD-01",
    "signed-out-mobile-handoff": "OD-01",
    "stale-source": "OD-02",
    "ambiguous-quote": "OD-02",
    "owner-rejection": "OD-03"
  },
  "plannedSignedOutMobile": {
    "attemptId": "OD-01",
    "device": "Pixel 8",
    "operatingSystem": "Android 16",
    "browser": "Chrome 138",
    "signedIn": false
  },
  "evidenceClassification": {
    "evidenceClass": "owner-self-dogfood",
    "countsTowardHumanPilot": false,
    "independentOwnerEvidence": false,
    "claimBoundary": "maintainer operational and mechanical evidence only"
  }
}
```

Create the canonical ignored charter once:

```bash
bun run dogfood:series-init -- \
  --input '/absolute/private/owner-dogfood-series.json'
```

The canonical file is `.workspace/human-correction-pilot/owner-self-dogfood-series.json`. While it exists, a second initialization cannot replace it. This is an exclusive non-overwriting harness write, not cryptographic or filesystem immutability. Manual editing or deletion is outside the guarantee and invalidates the series. `dogfood:init` fails before checkout inspection or attempt-artifact creation when the charter is missing or the requested OD ID was not declared; the command may still record a private global failure log.

After the owner chooses a genuine candidate and confirms its page-to-source mapping, initialize the declared attempt:

```bash
bun run dogfood:init -- \
  --attempt OD-01 \
  --profile owner-self-dogfood \
  --checkout '/absolute/path/to/clean/cyberbase-checkout' \
  --source 'owner/supplied/repository-relative-page.md' \
  --url 'https://cybersader.github.io/cyberbase/exact-public-page/' \
  --authorize-source yes
```

Initialization creates the local reader form and operator/decision files plus `dogfood-observation.json`, a private scaffold that carries the attempt's exact precommitted obligations, separate reader and owner device/browser/account contexts, manual interventions, and whether a source write, deployment, or live verification actually happened. The planned phone context is prefilled for the mobile obligation. Decision validation compares both the obligations and that mobile context with the canonical charter. Blank observation fields are not evidence, and automated browser emulation must not be labeled as a physical-phone result.

The recommended phone handoff is the bounded Tailscale command:

```bash
bun run dogfood:serve -- --attempt OD-01 --expires-minutes 15
```

It safely opens only the declared attempt's canonical `reader-form.html`, verifies that its bytes still match the generated instrument, snapshots those bytes in memory, discovers the current node's active Tailscale IPv4, and binds an ephemeral listener to that address only. It prints a random one-shot URL, atomically allows only the first bodyless GET, stops the listener immediately afterward or at the bounded expiry, and accepts no submission. HEAD is metadata-only; body-bearing GET/HEAD and every mutating method are rejected without consuming the route. Treat the URL as an expiring capability secret. The link uses HTTP inside Tailscale's encrypted tunnel; it does not claim browser TLS. The command never falls back to `0.0.0.0`, a LAN address, loopback proxying, Tailscale Serve, or Funnel, and it does not read or change any existing Tailscale Serve configuration.

An owner-controlled exact-file transfer remains valid. In either mode, deliver **only** the form. Never serve or copy the containing attempt directory: it also contains private operator, observation, decision, log, and run artifacts. After the HTML loads, the form makes no subsequent request, uploads nothing, and downloads `submission.json` locally. Transfer only that downloaded JSON back to the laptop and place it at the returned attempt path. This is disposable study transport, not a hosted form, intake endpoint, account-free contribution path, or independent-reader/owner evidence.

Then run:

```bash
bun run dogfood:prepare -- --attempt OD-01
bun run dogfood:render -- --attempt OD-01
# after the owner fills the bound owner-decision.json
bun run dogfood:decision -- --attempt OD-01
```

The recommended series covers a normal correction, signed-out mobile handoff, stale source, ambiguous quote, and owner rejection across three to five attempts. The charter binds those labels but does not by itself prove their outcomes. Decision validation requires the attempt assigned `owner-rejection` to end with `reject`; stale and ambiguous obligations are supported by their recorded fail-closed error and evidence that no Cyberbaser candidate application or deployment occurred because they stop before decision eligibility. Any changed validated case input, including mapping, base, selector, quote, replacement, rationale, evidence, or correction kind, creates a different mechanical case ID. A changed owner decision does not create a new mechanical case; keep it bound to the existing eligible attempt and never overwrite a completed attempt. A validated rejection is a successful owner-authority outcome and still performs no source write or deployment.

The harness cannot complete the owner's editorial step on the owner's behalf. Before validating an owner-self-dogfood decision, it strictly loads `dogfood-observation.json`, verifies its attempt obligations and planned mobile context against the canonical charter, requires that source-write, deployment, and live-verification flags are still false, and snapshots the private observation into the validated decision artifact. That validated artifact is create-once: a later contradictory decision cannot replace it. An accepted candidate is applied separately through the owner's normal local Markdown workflow, followed by digest comparison, normal publication, and live verification. Nothing in this package writes canonical source, commits, pushes, deploys, or authorizes itself.

## Prepare a deferred independent human-pilot attempt

The pilot operator layer is a thin concierge wrapper around the same modules. It adds no deployed or Cyberbaser-operated product server, database, account integration, hosted form, source writer, generalized renderer executor, or public-results publisher. The optional expiring Tailscale command above is an owner-local exact-file transport and accepts no intake. This larger protocol is preserved for later if Cyberbaser needs unfamiliar-reader or independent-owner usability evidence; it is not required before owner self-dogfooding.

All live material is created below the repository's ignored `.workspace/human-correction-pilot/` directory. Every command verifies its destinations with `git check-ignore`, rejects symlinked workspace components, and keeps raw submissions, credit requests, owner mappings, local paths, and private cards out of tracked files.

There are three explicit profiles:

- `cyberbase-rehearsal` supplies safe defaults for the public Cyberbase repository, the Cyberbaser publication boundary, the pinned Quartz `v4.5.2` wrapper, and an anonymous/full-review policy. It is permanently marked as **zero counted independent-owner evidence**.
- `owner-self-dogfood` uses the same Cyberbase safety defaults with `OD-*` attempt IDs, a private observation scaffold, and explicit maintainer-only evidence classification. It can never claim independent owner evidence or count toward the human pilot.
- `independent-counted` guesses no repository, checkout, source path, commit, URL, base path, or build command. It requires explicit source-processing authorization and independent-owner attestation. The Cyberbase repository is rejected under this profile, including equivalent trailing-slash and `.git` URLs. The preparation kit itself always reports `countsTowardPilot: false`; only the later private human record may count an attempt or result after a bound decision, owner-controlled application, and live verification.

`countsTowardPilot` is the legacy preparation-kit compatibility field and remains false on every kit artifact. `countsTowardHumanPilot` is the explicit profile evidence-classification field and is also false for rehearsal and owner self-dogfood outputs. Neither field turns an automated or prepared artifact into a counted human result.

Initialize one attempt only after the human study is ready to begin. The existing two-argument form creates blank mapping templates for any profile:

```bash
bun run pilot:init -- --attempt HC-01 --profile cyberbase-rehearsal
# or, after independent recruitment begins:
bun run pilot:init -- --attempt HC-01 --profile independent-counted
```

For a Cyberbase rehearsal or owner self-dogfood attempt, the owner-confirmed mapping can instead be verified and prefilled in one command. Use `HC-*` with `cyberbase-rehearsal` or `OD-*` with `owner-self-dogfood`:

```bash
bun run pilot:init -- \
  --attempt HC-01 \
  --profile cyberbase-rehearsal \
  --checkout '/absolute/path/to/clean/cyberbase-checkout' \
  --source 'owner/supplied/repository-relative-page.md' \
  --url 'https://cybersader.github.io/cyberbase/exact-public-page/' \
  --authorize-source yes
```

The four prefill flags are all-or-none and are accepted only for `cyberbase-rehearsal` or `owner-self-dogfood`; authorization must be exactly `yes`. The command derives the checkout's exact local `HEAD`, then reuses the live lane's repository-root, no-symlink, clean-worktree, Cyberbase-origin, tracked-source, and source-at-HEAD verification before creating anything. It writes that verified checkout, commit, owner-supplied source path, exact public URL, and authorization into `operator.json`. It never infers a source from the URL, title, slug, search, or renderer output, and it never overwrites an existing attempt.

Successful JSON output identifies `readerForm`, `submission`, and `operator` paths explicitly. Blank initialization creates an incomplete `operator.json`; Cyberbase prefill creates a verified mapped operator. Both modes create a blank `owner-decision.json` scaffold. The form is one self-contained local file. It has exactly the seven precommitted participant fields, makes no network request, loads no remote resource, collects no account/contact/credential field, and downloads `submission.json` locally. An empty replacement requires an explicit deletion confirmation. Browsers normalize textarea line endings before script can serialize them, so this bounded instrument rejects multiline exact quotes and replacements. Supported single-line values are not trimmed, case-folded, or whitespace-repaired; rationale may still contain multiple lines.

The human concierge must then:

1. share the blank form and observe whether the attempt was unaided;
2. save the downloaded `submission.json` in the attempt folder;
3. obtain the owner's explicit page-to-source mapping, pinned revision, local-processing authorization, trust policy, publication-boundary status, renderer details, and exact build command;
4. complete `operator.json` without guessing from a URL, slug, title, repository search, or rendered output; and
5. add exact immediately adjacent prefix/suffix only when the submitted quote is ambiguous in the owner-confirmed current source.

Prepare the exact no-write candidate and private owner card:

```bash
bun run pilot:prepare -- --attempt HC-01
```

Preparation verifies the checkout before and after evaluation, requires the owner-mapped Markdown file to be tracked with bytes exactly matching the pinned commit, forces the trust subject to `anonymous` with an empty author regardless of public credit, and writes one deterministic run directory named with the existing mechanical case ID. Any changed validated case input creates a different run instead of overwriting previous evidence; owner decisions remain separately bound to an eligible existing case. The private run includes exact `baseline-source.md` and `candidate-source.md` snapshots, a bound `render-attestation.json` scaffold, and a bound owner-decision template. These remain under ignored workspace storage and are not source writes. The initial card is explicitly incomplete: rendering is required before `ownerDecisionEligible` can become true. OFM `damage` produces no owner card; `suspect` produces a blocked card; trust remains informational.

For a Cyberbase rehearsal, reuse the existing isolated pinned-Quartz lane:

```bash
bun run pilot:render -- --attempt HC-01
```

For an independent base, the owner or concierge creates two isolated copies of the pinned checkout outside the supplied source checkout. Replace only the owner-mapped file in the baseline copy with the generated `baseline-source.md`, and replace only that file in the candidate copy with `candidate-source.md`. Run the recorded build command separately against those two copies. The kit does not execute the owner command or write either supplied checkout.

After both builds, complete the generated run-local `render-attestation.json`. Keep its prefilled attempt ID, case ID, source digests, renderer profile, and command unchanged; add the two absolute output paths, attest that the exact prepared snapshots were built in isolated workspaces, and record the confirmation time. Then verify the outputs:

```bash
bun run pilot:render -- \
  --attempt HC-01 \
  --baseline-site '/absolute/path/to/baseline-output' \
  --candidate-site '/absolute/path/to/candidate-output'
```

Rendering reruns the complete evaluation against current source bytes, compares it byte-for-byte with the stored case, evaluation, status, and source snapshots, and requires the source to remain tracked and identical to the pinned commit. It also binds both static-output paths to the owner attestation. Only then does it run `checkSite()`, exact rendered-target capture, and the candidate-only link delta. Exact source-anchor uniqueness remains the authority for the splice. Because a renderer may duplicate prose into metadata or structured output, rendered HTML may contain multiple literal occurrences: the baseline must contain the old text one or more times and no replacement text, while the candidate must contain no old text and, for a non-empty replacement, the replacement one or more times. The evidence retains and displays all measured occurrence counts. The attestation supplies explicit owner provenance for the external build; it is not a cryptographic proof that an arbitrary directory was produced by a particular renderer, so a false owner attestation remains outside what this local kit can detect.

Inherited baseline link debt is recorded but does not block by itself. Any candidate-only broken-link tuple, rendered-target mismatch, source mutation, checkout mismatch, altered prepared artifact, incomplete build attestation, OFM block, incomplete review-card evidence, or missing publication-boundary evidence keeps the attempt ineligible. Static-output mode marks a Cyberbaser publication boundary unverified rather than pretending that rendered directories prove projection safety.

The kit never fills in or infers an editorial decision. Preparation binds the mechanical case ID and candidate digest into `owner-decision.json`; the owner fills only the decision, reason, review time, and decision timestamp after reviewing the complete local card outside GitHub. Validate the binding before any owner-controlled application:

```bash
bun run pilot:decision -- --attempt HC-01
```

The command rejects an ineligible run or a decision whose attempt ID, mechanical case ID, or candidate digest differs from the freshly revalidated eligible run. For a Cyberbase rehearsal, decision validation reruns the complete isolated pinned-Quartz live lane and compares a deterministic safety projection of the stored and fresh evidence: prepared case/evaluation binding, projection verification, renderer identity and isolation, complete candidate-only and baseline-only link deltas, rendered-page absence/presence gates, source-checkout/no-write assertions, and cleanup. It deliberately excludes build-variant aggregate successful-link totals/occurrences, rendered HTML byte lengths and hashes, and literal multiplicity above the required presence threshold. Eligibility and expected status come only from the fresh evidence, so changing blocked evidence and stored status to eligible still fails closed. The rerun may take as long as a full `pilot:render` run. Independent static-output decisions keep the existing fresh output verification. The command writes only a private validation record and still reports `countsTowardPilot: false`. Application, source write, commit, push, deployment, live verification, human timing records, owner preference, threshold counting, and anonymized aggregate publication remain human work under the [canonical pilot protocol](../../docs/src/content/docs/research/concierge-human-correction-pilot.mdx).

## Run against a caller-supplied checkout

Prepare two private local JSON files outside this tracked fixture directory:

```json
{
  "repository": "https://example.org/owner/public-kb",
  "baseCommit": "0123456789abcdef0123456789abcdef01234567",
  "sourcePath": "owner/supplied/path.md",
  "publicUrl": "https://example.org/public-page",
  "quote": "Exact text copied from the owner-mapped source",
  "replacement": "Exact replacement text",
  "rationale": "Why the bounded change improves the page.",
  "evidence": ["Private local evidence retained by the operator."],
  "kind": "typo"
}
```

The optional `prefix` and `suffix` fields must be exact, immediately adjacent source context. They disambiguate the submitted quote without changing it.

The owner policy is a JSON object accepted by `@cyberbaser/trust`. Then run:

```bash
bun run dry-run -- \
  --checkout /absolute/path/to/owner-checkout \
  --case /absolute/path/to/private-case.json \
  --policy /absolute/path/to/private-owner-policy.json \
  --policy-revision owner-policy-revision \
  --format json
```

Use `--format html` for escaped static local HTML. Both formats go to standard output. The command creates no review file and performs no source write. Redirecting output to private storage is an operator action outside the harness.

The checkout and source path are independent inputs on purpose. The harness verifies containment, but it never guesses a source file from the public URL, title, slug, repository search, or renderer output.

## Run the isolated local rendering lane

`live-run` requires the pinned commit as a second explicit input, even though the case also carries `baseCommit`. The two values must match. The checkout must be the repository root, its `origin` must match `case.repository`, `HEAD` must equal the pin, and `git status --porcelain --untracked-files=all` must be empty before and after the run.

```bash
bun run live-run -- \
  --checkout /absolute/path/to/clean-public-vault \
  --commit 0123456789abcdef0123456789abcdef01234567 \
  --case /absolute/path/to/private-case.json \
  --policy /absolute/path/to/private-owner-policy.json \
  --policy-revision owner-policy-revision \
  --base-path project-pages-prefix \
  --format json
```

The renderer wrapper owns the Quartz pin (`v4.5.2`). By default its `setup.sh` clones upstream and installs dependencies separately for the baseline and candidate workspaces. To use a local Git source for the Quartz clone, pass its repository URL without changing the renderer (the renderer still owns dependency installation):

```bash
  --quartz-repo file:///absolute/path/to/local/pinned-quartz-repository
```

Use `--format html` for the escaped static rendered review card. Both formats go to standard output after the temporary workspaces have been deleted and the supplied checkout has passed its final clean/byte-identical check. The card records summarized projection checks, both `checkSite` results, the exact candidate-only link delta, and comparable target-page text counts. It contains no accept/apply control and performs no public deployment.

Normal tests inject fake build and render functions. They make no network requests, do not invoke Quartz, and still exercise source isolation, candidate-only application, link-delta ordering, rendered evidence, failure cleanup, and the real `select` → `project` → `verifyProjection` composition.

## Project layout

- `src/case.js`: strict input validation, deterministic JSON, and public-safe case projection.
- `src/evaluate.js`: exact byte read, prepare/apply, outside-splice proof, OFM, trust, immutability, and no-write confirmation.
- `src/review-card.js`: redacted deterministic JSON and escaped static HTML.
- `src/live-run.js`: clean/pinned checkout verification, isolated copies and projections, pinned-Quartz adapters, site checks, target evidence, deterministic link delta, and `finally` cleanup.
- `src/live-review-card.js`: redacted rendered-run JSON and escaped static HTML.
- `src/public-safety.js`: shared private-path and credential scanner for public-safe review modules.
- `src/pilot-input.js`: strict submission, operator, render-attestation, and owner-decision schemas plus deterministic form-to-case conversion.
- `src/pilot-workspace.js`: ignored-path, symlink, attempt initialization, atomic artifact, and private-log handling.
- `src/pilot-run.js`: no-write pilot preparation, exact source snapshots, fresh evidence rebinding, Cyberbase-live or owner-static render verification, and owner-decision binding validation.
- `src/pilot-review-card.js`: deterministic private owner cards, complete contract checks, participant context, and explicit pending status.
- `src/cli.js`: one strict `--name value` parser shared by the four pilot commands.
- `src/verification.js`: authoritative synthetic checks shared by the verifier and tests.
- `bin/verify.js`: deterministic synthetic verifier entry point.
- `bin/dry-run.js`: read-only local-checkout entry point.
- `bin/live-run.js`: isolated local projection/rendering entry point; no public deployment or source application.
- `bin/pilot-init.js`, `bin/pilot-prepare.js`, `bin/pilot-render.js`, `bin/pilot-decision.js`: private concierge operator entry points.
- `templates/`: public-safe local form and JSON scaffolds; no participant data.
- `fixtures/`: synthetic public Markdown only.
- `test/`: focused unit and integration coverage.
- [`TESTING.md`](./TESTING.md): predeclared criteria and commands.
- [`RESULTS.md`](./RESULTS.md): observed local results for the latest run.

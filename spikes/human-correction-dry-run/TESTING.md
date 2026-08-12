# Testing criteria

These criteria test the private dry-run harness and owner self-dogfood preparation path, not the deferred five-reader human pilot. Synthetic success cannot be reported as participant usability, owner preference, useful-correction demand, independent-owner evidence, or a shipped contribution path.

## Deterministic criteria

| ID | Criterion | Observable pass condition |
|---|---|---|
| D01 | Frozen local install | `bun install --frozen-lockfile` exits zero without changing `bun.lock`. |
| D02 | Focused automated suite | `bun test` exits zero with no skipped or failed tests. |
| D03 | Authoritative verifier | `bun run verify` exits zero and every named JSON check has `status: "PASS"`. |
| D04 | Stable verifier output | Two fresh verifier processes exit zero, emit no verifier diagnostic on standard error, and produce byte-identical JSON. The `bun run verify` package-script wrapper may print Bun's fixed `$ bun run bin/verify.js` launcher banner to standard error. |
| D05 | Exact correction boundary | One quote resolves once, one in-memory splice is prepared/applied, and prefix/suffix bytes are identical. |
| D06 | Fail-closed ambiguity | A repeated exact quote returns `quote-ambiguous`; no evaluation/candidate is returned and source bytes remain identical. |
| D07 | No source mutation | Fixture bytes are identical before and after evaluation, and the record says `sourceWritePerformed: false`. |
| D08 | Static review safety | Script-shaped quote/rationale text is escaped; attribute-bearing injection fails as `active-content`; an injected `credit` field fails as `unknown-case-field`; artifacts contain no executable script or active/resource attribute. |
| D09 | Offline normal tests | `bun test` injects fake build/render functions, makes no network requests, and does not invoke Quartz. |
| D10 | Missing quote | A case whose exact quote is absent returns `quote-not-found`; no trimming, case folding, fuzzy repair, or candidate occurs. |
| D11 | Stale same-length base | Applying a prepared correction to different bytes of identical length returns `base-digest-mismatch`. |
| D12 | Owner mapping mismatch | If the owner-supplied mapped file lacks the quote while another file contains it, evaluation returns `quote-not-found` and performs no URL/title/slug/search fallback. |
| D13 | Exact UTF-8 and line endings | A CRLF fixture containing emoji, non-ASCII text, and a combining sequence resolves at UTF-8 byte offsets; base/candidate digests match independent SHA-256 calculations and all outside bytes remain identical. |
| D14 | Source excerpt minimization | Review JSON/HTML include only the exact quote plus explicit adjacent `prefix`/`suffix`; before/after canaries and headings are absent. |
| D15 | Candidate digest binding | Tampering only the prepared `candidateDigest` returns `candidate-digest-mismatch` before candidate bytes are returned. |
| D16 | Separate adversarial verifier | `bun run verify:adversarial` emits byte-stable JSON with exactly three sorted PASS scenarios for stale source, ambiguous quote, and synthetic rejection binding. It contains no OD IDs, runtime paths, timestamps, PIDs, credentials, human-owner claim, source application, or deployment. |
| L01 | Clean pinned checkout | Local-Git coverage accepts only a repository-root checkout whose origin, exact `HEAD`, and empty porcelain status match the explicit case and commit. |
| L02 | Isolated live copies | Baseline and candidate begin byte-identical; the exact splice is written only to the candidate temporary copy. |
| L03 | Current projection composition | A no-Quartz test composes current `select` → `project` → `verifyProjection` and confirms an unselected file is absent. |
| L04 | Candidate-only link regression | Set difference over `(page, href, decoded, class)` reports the exact new candidate tuple and does not classify unchanged inherited baseline debt as candidate-only. |
| L05 | Comparable rendered target | Fake rendered outputs prove the same target page contains old-only text in baseline and replacement-only text in candidate. |
| L06 | Finally cleanup | Success and injected render/build/target-mismatch failures remove the temporary root and leave supplied source bytes unchanged. |
| L07 | Unpublished/private denial | Projection of an owner-mapped source outside the public allowlist returns `candidate-not-published` and emits no private target file. |
| L08 | Build failure | An injected candidate projection build failure is returned with its named code; renderer setup does not start and cleanup completes. |
| L09 | Rendered-target mismatch | If the candidate render still shows the old quote, the run returns `rendered-target-mismatch` and cleanup completes. |
| L10 | Checkout symlink rejection | A clean checkout containing any symbolic link returns `checkout-symlink-rejected` before copying, projection, or rendering. |

## Adoption-simulation criteria

| ID | Criterion | Observable pass condition |
|---|---|---|
| A01 | First useful command | A new operator can follow README install and `bun run verify` commands without repository-specific setup beyond Bun. |
| A02 | Local dry-run entry point | The documented CLI accepts a caller-supplied checkout, case JSON, and owner-policy JSON and returns review JSON on standard output. |
| A03 | Actionable failures | Invalid case fields, unresolved mappings, ambiguity, and unsafe review content return named error codes rather than silently repairing input. |
| A04 | Explicit live-run inputs | The rendering CLI requires checkout, commit, case, and owner policy; commit must exactly match the frozen case. |
| A05 | Local renderer source | `--quartz-repo file:///...` can point setup at a caller-supplied local pinned Quartz Git repository without editing the renderer wrapper. |
| A06 | Differently phrased form simulations | Four explicitly labeled `SIMULATED` form-shaped submissions (concise typo, explanatory factual wording, direct deletion, and informal emoji wording) preserve exact quote/replacement/rationale through deterministic no-write review evidence. Every artifact still says it is not a human pilot result. |

This is a documentation and command-shape simulation only. No ordinary reader or independent owner is represented. A06 measures only test-fixture conversion mechanics; it makes no claim about human usability, unaided completion, timing, correction usefulness, credit handling, or owner preference.

## Modularity criteria

| ID | Criterion | Observable pass condition |
|---|---|---|
| M01 | Case module | `src/case.js` validates and public-safes case data without reading source files. |
| M02 | Evaluation module | `src/evaluate.js` consumes an injected case, checkout, owner policy, and policy revision without rendering HTML or writing files. |
| M03 | Review module | `src/review-card.js` consumes only an immutable evaluation record and produces JSON/HTML without source-file access. |
| M04 | Local package composition | All six declared `file:` dependencies resolve from the frozen lock; correction, OFM, trust, publish, projection, and linkcheck are exercised on their appropriate lanes. |
| M05 | Injectable expensive boundaries | Projection-build, renderer-setup, and render functions are replaceable in tests; the production defaults integrate the existing package and renderer contracts. |
| M06 | Separate rendered review module | `src/live-review-card.js` consumes only a completed live-run record and emits redacted JSON/static HTML without reading source or renderer files. |

## Intuitiveness criteria

| ID | Criterion | Observable pass condition |
|---|---|---|
| I01 | Honest status | Every review artifact says it is internal agentic evidence, pending owner, and no source write has occurred. |
| I02 | Visible exact change | The card shows old and replacement text with only optional selected adjacent context. |
| I03 | Visible mechanical evidence | The card shows byte range/digests, outside-splice identity, OFM verdict, trust route, and policy revision. |
| I04 | No misleading action | The static cards contain no accept button, form, automatic-apply control, or claim that owner approval happened. |
| I05 | Render comparison is visible | The live card shows renderer pin, baseline/candidate target counts, both broken-link totals, and the exact candidate-only delta. |
| I06 | Isolation is visible | The live card says checkout bytes remained unchanged, candidate application occurred only in a temporary copy, workspaces were isolated and cleaned, and no public deployment occurred. |

## Documentation criteria

| ID | Criterion | Observable pass condition |
|---|---|---|
| DOC01 | Scope is explicit | README states that this is not a human pilot or product runtime. |
| DOC02 | Source mapping rule is explicit | README says source mapping is owner-supplied and never inferred by slug or public URL. |
| DOC03 | No-write behavior is explicit | README explains that output is standard output and any redirection is an operator action. |
| DOC04 | Commands execute | The README install, test, verify, and local dry-run command shapes match `package.json` and the CLI parser. |
| DOC05 | Related contracts are linked | README links correction, OFM, trust, publish, projection, linkcheck, the pinned Quartz renderer, the canonical pilot protocol, Web Annotation, and RFC 9530. |
| DOC06 | Live lane is bounded | README documents explicit pin/origin/clean checks, separate temporary lanes, local Quartz override, no public deployment, no source application, and cleanup-before-output. |

## Operator and owner-self-dogfood criteria

These checks validate only the private preparation kit. Synthetic fixtures and agent execution remain zero reader attempts and zero independent-owner results. Owner self-dogfood may add maintainer operational evidence only when the maintainer actually performs the recorded steps; automated coverage cannot claim a physical-device pass or owner decision.

| ID | Criterion | Observable pass condition |
|---|---|---|
| P01 | Seven-field local form | The template contains exactly Page URL, Exact quote, Replacement, Rationale, Factual source, Public credit name, and Credit consent in that order, with the precommitted instructions. |
| P02 | No active intake endpoint | The form has no action/method target, remote resource, network API, storage API, contact/account/credential field, or tracking mechanism. |
| P03 | Exact supported serialization | Single-line quote/replacement values preserve spaces, Unicode, emoji, and empty deletion exactly; multiline change fields fail closed because browsers normalize textarea line endings. Timing metadata remains separate. |
| P04 | Strict private schemas | Series-charter, submission, operator, dogfood-observation, render-attestation, and owner-decision validators reject unknown fields, invalid context/credit values, unpinned mappings, missing source authorization, incomplete independent-owner/render facts, malformed decision identifiers, forged evidence classification, and unknown privacy-expanding charter fields. |
| P05 | Profile and counting isolation | Cyberbase is limited to the non-counting `cyberbase-rehearsal` and `owner-self-dogfood` profiles, URL variants cannot enter `independent-counted`, owner dogfood cannot claim independent-owner attestation, the legacy kit field `countsTowardPilot` remains false, and profile classification reports `countsTowardHumanPilot: false` for rehearsal and dogfood outputs. |
| P06 | Anonymous trust subject | Public credit name and consent never change the forced `anonymous` / empty-author trust input. |
| P07 | Ignored workspace | Every attempt and artifact remains below ignored `.workspace/`; invalid IDs, existing attempts, unignored destinations, and symlinked workspace components fail closed. |
| P08 | Deterministic run identity | Existing `caseId()` names the run; changing any validated case input, including mapping, base, selector, quote, replacement, rationale, evidence, or correction kind, creates a different run and an existing run is never overwritten. Owner-decision changes remain separately bound to the existing eligible case. |
| P09 | Fast path incomplete | Successful no-write preparation remains `ownerDecisionEligible: false` until render evidence exists. |
| P10 | OFM gate | `damage` produces no owner card; `suspect` produces a visibly blocked card; only `clean` can become eligible. |
| P11 | Public/private separation | Mechanical review JSON excludes checkout paths, source paths, raw factual evidence, and unconsented credit names; the private owner card includes mapping and participant context. |
| P12 | Bound static-output boundary | Independent render mode requires tracked source bytes at the pin, exact prepared baseline/candidate snapshots, a bound owner render attestation, fresh evaluation equality, complete rendered views, and two `checkSite()` results. Source-anchor uniqueness remains authoritative; rendered HTML may repeat derivative prose, but the baseline must have old text present and replacement absent, while the candidate must have old text absent and the non-empty replacement present. Measured counts remain visible. It invokes no owner command and blocks candidate-only links while tolerating inherited baseline debt. |
| P13 | Cyberbase reuse | Cyberbase render mode calls the existing isolated live lane and inherits its checkout, projection, render, link-delta, source-isolation, and cleanup guarantees. It requires tracked `publish.yml` at the exact source pin before temporary work begins, removes the policy-free whole-vault fallback, and requires both lanes to prove `cyberbaser-select-project-verify`, mapped-source selection, successful projection, and successful verification before renderer setup. Decision validation reruns that same lane, compares the stored and fresh safety-relevant evidence while excluding known build-variant aggregate successes and target bytes/hashes, and derives eligibility and expected status solely from the fresh evidence. Changed link tuples, target safety gates, projection, source isolation, no-write, or cleanup evidence still fail closed. |
| P14 | Human decision remains human and bound | No command infers accept/reject/clarify. `pilot:decision` validates the hand-entered outcome against the eligible attempt, case ID, and candidate digest, then writes only a private no-source-write validation record. A Cyberbase decision can take as long as a full render because it reruns both live lanes. |
| P15 | Complete owner card gate | Eligibility requires rendered baseline/candidate passages, byte lengths/digests, anchor/context status, OFM findings/churn/escapes, trust reasons/checks, link totals/delta, and applicable projection evidence. |
| P16 | Existing harness compatibility | The existing dry-run and live-run suites still pass, `bun run verify` retains byte-identical synthetic-v1 output with 11 PASS checks, and stored schema-v1 preparation/render status is normalized to schema v2 without weakening profile classification checks. |
| P17 | Verified Cyberbase initialization | Optional Cyberbase prefill requires the complete checkout/source/URL/authorization flag set under `cyberbase-rehearsal` or `owner-self-dogfood`, derives local HEAD, reuses live checkout verification, requires tracked `publish.yml` at that same HEAD, writes only the explicit owner mapping, reports form/submission/operator paths, and fails before creation on partial, unauthorized, dirty, wrong-root, wrong-origin, non-Markdown, untracked-source, or policy-free input. |
| P18 | Distinct owner-dogfood attempt namespace | `owner-self-dogfood` requires `OD-01` through `OD-99`; rehearsal and independent profiles require `HC-01` through `HC-99`. Cross-namespace attempt IDs fail closed. |
| P19 | Explicit evidence classification | Owner-dogfood status, preparation, rendering, review, and validated-decision artifacts report `evidenceClass: owner-self-dogfood`, `countsTowardHumanPilot: false`, `independentOwnerEvidence: false`, and a maintainer-only claim boundary. |
| P20 | Private observation and immutable rejection path | Initialization creates an ignored `dogfood-observation.json` with separate reader/owner context fields and false write/deploy/live defaults. Decision validation binds and snapshots that observation, refuses any pre-decision write/deploy/live flag, and creates the validated decision exactly once. A correctly bound owner rejection cannot later be replaced by a contradictory decision; the harness cannot invent either decision. |
| P21 | Historical charter compatibility | `dogfood:series-init` creates one deterministic ignored charter containing three to five unique `OD-*` IDs, exactly the five canonical obligation assignments, a matching signed-out mobile context, and the fixed maintainer-only evidence classification. A second initialization while the charter exists preserves the original bytes. Missing charters and undeclared OD IDs fail before checkout inspection or attempt-artifact creation, while HC initialization remains unchanged. Initialization copies the assigned obligations and applicable mobile context into the observation; decision validation rejects later mismatch with the canonical charter and requires the designated owner-rejection attempt to end with `reject`. Stale and ambiguous outcomes remain separately proven by their fail-closed error and evidence that no Cyberbaser candidate application or deployment occurred. |
| P22 | One-shot private Tailscale handoff | `dogfood:serve` derives only a declared OD attempt's canonical form, validates its owner-dogfood operator, safe-opens one regular non-linked byte snapshot, verifies it against the generated instrument, binds only to the active `100.64.0.0/10` Tailscale IPv4, advertises the numeric `http://100.*` URL instead of a browser-upgradable MagicDNS hostname, and serves one random exact GET/HEAD route. A synchronous consumed latch allows only the first bodyless GET, then the listener stops; a 1–60 minute expiry is the backstop. HEAD is metadata-only, body-bearing GET/HEAD and all mutating methods fail without consuming the route, request bodies are capped at the server boundary, all sibling/traversal/query routes fail, and no upload, Tailscale Serve, Funnel, configuration mutation, broad-interface fallback, filesystem write, or product-endpoint claim exists. |
| P23 | Guided owner-dogfood wizard | TTY-only `bun run dogfood` lists only charter-declared attempts, reports `OD-02` and `OD-03` as terminal Not run — superseded with no initialization or decision action, derives conservative artifact-bound stages for `OD-01`, marks the next valid action as recommended, and invokes the existing initialization, one-shot transport, preparation, rendering, repin recovery, and decision APIs only after explicit numbered confirmation. Exit, Ctrl-C, EOF, and pre-confirmation cancellation write no artifact or failure log; confirmed long actions cannot be silently cancelled mid-write. Initialization failures log globally without creating phantom attempts. Owner decisions use one immutable run-local artifact, so concurrent sessions cannot overwrite each other. Piped or flag-bearing use fails with strict-CLI guidance. Superseded attempts expose no operational action, no source mapping or editorial choice is inferred, and no apply, commit, push, deploy, or live-verification action exists. |
| P24 | Immutable owner-dogfood repin | A policy-free historical OD attempt is blocked before preparation or rendering and offers no render/decision action. One explicit owner-authorized repin may change only checkout path and base commit while preserving repository, source path, public URL, profile, correction, renderer, and owner policy. The replacement checkout must be clean, carry tracked `publish.yml`, preserve the exact quote, and produce a different base-bound case. Create-once `operator-repin.json` leaves the original operator, submission, runs, logs, and source bytes unchanged; cancellation, overwrite, unchanged base, stale quote, dirty checkout, wrong repository, missing policy, or completed decision fail closed. |
| P25 | Serialized binding transitions and historical terminal state | Repin and guided-decision writes share one nonblocking Linux `flock` kernel lock, so concurrent transitions cannot both bind the attempt. The lock file may persist without stranding later processes because only the kernel lock carries ownership; contention tests require at most one active callback. Each transition reloads the effective operator and case under the lock. Once a validated decision exists, inspection validates and returns that immutable terminal evidence without requiring the historical checkout or pinned commit to remain locally available; pre-decision checkout or policy drift still blocks ongoing work. |
| P26 | Versioned reader-form integrity | New attempts generate `reader-form-v2`, whose browser and submission validators reject exact quote equal to replacement with `no-op-replacement`. Historical `reader-form-v1` remains byte-verifiable and valid under its original contract. The reader server accepts only a full byte match against one supported canonical generated instrument, and later preparation/verification binds the submission's declared version to those issued bytes. |
| P27 | Read-only post-application evidence | `dogfood:verify-live` requires explicit attempt, repository root, application commit, deployment run ID, and positive wait bound. It binds the immutable accept to the reviewed evaluation; disables Git lazy fetching; verifies single-parent Git objects and exact parent/path/mode/digests/splice; binds the run to the active publication workflow, push event, main branch, exact successful jobs, and successful `github-pages` deployment; and checks bounded HTML page text at the exact public location. Every network operation and body read shares the deadline and fixed byte limits. It creates one private artifact once and performs no Git, source, remote, deployment, or observation mutation. |
| P28 | Manual-series supersession is honest | The immutable charter and `OD-01` remain preserved; `OD-02` and `OD-03` do not exist and are recorded as Not run — superseded. Synthetic rejection binding creates no human-decision artifact and is never counted as a human owner rejection. |

## Run sequence

Run these commands from `spikes/human-correction-dry-run/`. Running an unscoped `bun test` from the repository root also discovers unrelated repository test suites and is not a valid harness result.

```bash
bun install --frozen-lockfile
bun test
bun test test/pilot-input.test.js test/pilot-workspace.test.js test/pilot-run.test.js test/pilot-review-card.test.js
bun test test/adversarial-verification.test.js test/post-application-verification.test.js
bun run verify > /tmp/human-correction-dry-run.verify.1.json
bun run verify > /tmp/human-correction-dry-run.verify.2.json
cmp /tmp/human-correction-dry-run.verify.1.json /tmp/human-correction-dry-run.verify.2.json
bun run verify:adversarial > /tmp/human-correction-adversarial.1.json
bun run verify:adversarial > /tmp/human-correction-adversarial.2.json
cmp /tmp/human-correction-adversarial.1.json /tmp/human-correction-adversarial.2.json
```

The normal sequence above is offline and does not invoke Quartz. A real `live-run` is an explicit, separately recorded integration action because it creates two local renderer workspaces and may install renderer dependencies. It must use a clean caller-supplied checkout and never deploy the output. `dogfood:verify-live` is also explicit: run it only after owner-authorized application and deployment already exist. It performs network reads and creates one private create-once verification artifact, but does not mutate source, Git, remote state, deployment, or the observation.

The latest observed results belong in [`RESULTS.md`](./RESULTS.md). Result comments are added only after the corresponding command or inspection has actually run.

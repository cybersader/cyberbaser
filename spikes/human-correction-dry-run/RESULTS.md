# Observed results

- Latest completed internal candidate run: 2026-07-28
- Runtime: Bun 1.3.11
- Branch: `research/human-correction-pilot`

## Evidence boundary

This file records **internal agentic and mechanical evidence only**. The run is not a reader attempt, independent-owner result, human-usability result, accepted correction, live source correction, public deployment, owner-preference result, interoperability result, or shipped account-free contribution path.

The selected case was one owner-mapped, public Cyberbase spelling correction at pinned commit `b320c5c2c92d646b9df7019c9e29034341ebff6b`:

```text
responsibilites → responsibilities
```

The tracked record uses case ID `DRY-4447FE60DEA5`. The local source path and raw supporting evidence are redacted from tracked artifacts.

This run contributes:

- **0 of 5** reader attempts;
- **0 of 3** required unaided reader completions;
- **0 of 2** substantive corrections accepted by an independent owner and verified live;
- no independent-owner result;
- no participant, concierge, or owner-review timing result; and
- no owner-preference result.

Q09 remains open. The independent human pilot remains next.

## Commands and execution sequence

The completed execution used fresh temporary workspaces and the existing harness implementation:

1. Fresh-cloned `https://github.com/cybersader/cyberbase.git` under `/tmp` and checked out detached commit `b320c5c2c92d646b9df7019c9e29034341ebff6b`.
2. Reconfirmed the owner-supplied source mapping, exact quote count, replacement count, source line, UTF-8 byte range, publication flag, file length, and SHA-256 with an independent script.
3. Ran `bun install --frozen-lockfile` in the standalone harness.
4. Ran the package-scoped Bun test suite.
5. Ran two fresh authoritative verifier processes and compared their output bytes.
6. Ran the no-write `dry-run` CLI with the exact case, an injected internal owner policy, an explicit policy revision, and a registered internal agent subject.
7. Fresh-cloned Quartz under `/tmp`, pinned it to `v4.5.2`, and ran the production live-run components through an instrumented temporary driver. The driver retained the normal projection, renderer, link-check, rendered-evidence, cleanup, and review-card implementations.
8. Validated the three tracked artifacts for JSON integrity, matching case IDs, expected evidence values, local-path leakage, credentials, contact information, raw private evidence, and active HTML content.
9. Rechecked the pinned Cyberbase checkout, source digest, empty Git status, temporary-workspace cleanup, and absence of writes outside the scoped tracked artifacts and `/tmp`.
10. After audit hardening added whole-checkout symbolic-link rejection, reran the full `live-run` CLI against the same clean pinned checkout and a local Git source for Quartz `v4.5.2`.

The selected correction needed no repair. The later audit hardened checkout isolation and review terminology without changing the correction. No source write, commit, push, pull request, remote mutation, or public deployment occurred.

## Automated validation

| Check | Measured result |
|---|---|
| Frozen install | Completed successfully in 11.22 s. |
| Scoped harness suite | Initial candidate run: 46 passed, 0 failed, 213 assertions across eight files, about 2.82 s. Post-audit checkout and review-state hardening: 47 passed, 0 failed, 218 assertions across eight files. Latest initialization, rendered-evidence, and decision-hardening rerun: 77 passed, 0 failed, 410 assertions across 12 files in 21.19 s. The focused pilot subset passed 26 tests with 157 assertions in 16.19 s; the render/adversarial/decision subset passed 24 tests with 146 assertions in 18.38 s; the latest initialization/input subset passed 15 tests with 95 assertions in 2.31 s. |
| Authoritative verifier | 11 PASS, 0 FAIL, `complete: true`. |
| Dependent package suites | Correction, linkcheck, OFM, projection, publish, and trust: 187 passed, 0 failed, 558 assertions across eight files. |
| Canonical docs build and linkcheck | PASS, 99 pages built. Linkcheck found the existing single `other` finding in `agent-context/zz-challenges/mdx-auto-wrapping/`, within the explicit budget of 1. Existing Starlight override, Vite externalization, and large-chunk warnings remained non-fatal. |
| Repeated verifier determinism | Two fresh verifier processes exited zero, emitted no verifier diagnostic stderr, and produced byte-identical JSON; 0.922 s and 0.911 s. The `bun run verify` wrapper may print Bun's fixed launcher banner to stderr. |
| Artifact validation | PASS for one sanitized case JSON, one result JSON, and one static review-card HTML. |

The scoped tests covered fail-closed quote handling, ambiguous and missing anchors, stale-base detection, UTF-8 and CRLF preservation in the correction core, mapping containment, publication denial, candidate-only link deltas, rendered-target mismatch, injected build failure, cleanup, and review-card active-content rejection. Pilot-kit audit coverage also rejects ignored source mappings, stale current source bytes, altered stored evaluation evidence, missing build attestation, Cyberbase under the independent profile, incomplete review-card evidence, malformed or mismatched owner decisions, and multiline browser change fields. Rendered-target regression coverage permits multiple raw-HTML occurrences caused by derivative metadata only when the baseline has no replacement text and every old-text occurrence disappears from the candidate; even one candidate old-text residue still fails. The recorded Cyberbase run below remains the measured 1/0 baseline and 0/1 candidate result. Decision-time coverage proves that a valid Cyberbase decision performs a fresh injected live verification and tolerates only excluded build nondeterminism: aggregate successful-link totals/occurrences, target HTML byte length/hash, and harmless literal multiplicity above the presence threshold. The deterministic comparison still binds case/evaluation, projection, renderer/isolation, complete candidate-only and baseline-only tuples/counts, rendered-page safety, source isolation/no-write, and cleanup. The demonstrated tamper that changes a blocked stored candidate-only count from 1 to 0 and rewrites status as eligible is rejected, as are changed link tuples and target safety booleans. Cyberbase initialization coverage verifies the one-command explicit prefill and rejects partial flags, non-`yes` authorization, independent-profile use, non-Markdown sources, nested checkout paths, wrong origins, ignored untracked sources, and dirty worktrees before attempt creation. In real Cyberbase operation, `pilot:decision` reruns the full isolated live lane and may take as long as a full render. Synthetic and simulated form-shaped fixtures remain simulations, not human attempts.

## Complete Cyberbase-profile operator rehearsal

After the pilot-kit audits and repairs, the complete private CLI sequence passed against a synthetic clean Git checkout carrying the public Cyberbase repository identity and the pinned Quartz wrapper:

```text
pilot:init → pilot:prepare → pilot:render → pilot:decision
```

| Stage | Observed result |
|---|---|
| `pilot:init` | Created ignored attempt `HC-95`; `countsTowardPilot: false`. |
| `pilot:prepare` | Created deterministic case `DRY-2F46EC0B900A`; owner decision remained ineligible pending rendering. |
| `pilot:render` | Completed isolated baseline/candidate projection and Quartz rendering; owner decision became mechanically eligible; `countsTowardPilot: false`. |
| `pilot:decision` | Reran the full isolated Cyberbase live lane, matched the deterministic safety projection, validated the synthetic bound decision, and reported `sourceWritePerformed: false`. |
| Source checkout | SHA-256 `deff0dae352d59d3334234f00fecf73d3aa1a492f9fa04635decc304494bde6c` before and after; Git status remained empty. |
| Cleanup | The ignored attempt and temporary checkout were removed. |

The later one-command `pilot:init` prefill was also exercised against the clean pinned public Cyberbase checkout and the real owner-supplied IR DROP source mapping. It derived commit `b320c5c2c92d646b9df7019c9e29034341ebff6b`, verified the origin, clean state, tracked source bytes, and explicit public URL, then created the reader form and a prefilled private operator record. The rehearsal attempt was removed afterward.

Two earlier full rehearsals failed closed and were retained as adverse observations. The first exposed raw-HTML derivative multiplicity: a visually unique source passage appeared more than once in Quartz output. The rule now retains exact source-byte uniqueness while accepting one-or-more derivative appearances only when every old-text appearance disappears from the candidate and the replacement is absent from the baseline. The second exposed expected Quartz build variance in successful-link aggregates and generated HTML hashes. Decision validation now reruns the live lane and compares a deterministic safety projection that retains publication verification, candidate-only and baseline-only broken tuples, rendered old/new safety, source isolation, no-write assertions, and cleanup.

This rehearsal is not a reader attempt, owner result, accepted correction, application, live publication, or human-usability measurement. It contributes zero to every pilot threshold.

## Exact correction outcome

| Observation | Result |
|---|---|
| Quote resolution | Exactly once at half-open UTF-8 byte range `[302, 394)` |
| Source line during independent confirmation | Line 11 |
| Base byte length | 2,678 |
| Candidate byte length | 2,679 |
| Size delta | One UTF-8 byte inserted |
| Base representation digest | `sha-256=:XGF2wGp1IfVlGZocJUE7vHXLLqRW62yNIwqLssfvt5Q=:` |
| Candidate representation digest | `sha-256=:L4Asio4+Oix6P0yCtZqirOIXrm7E0xvDohJDne7vTVU=:` |
| Outside-splice identity | 302 prefix bytes and 2,284 suffix bytes preserved exactly |
| Expected old bytes | Verified |
| OFM | `clean`, zero findings, churn `0.036`, zero escapes before and after |
| No-write evaluation time | 0.76 s |

The source file's SHA-256 remained `5c6176c06a7521f565199a1c25413bbc75cb2ea456eb6c8d230a8bb2c7efb794` before and after. The candidate bytes existed only in memory and in a temporary candidate copy.

## Trust classification

The injected internal policy produced:

| Field | Result |
|---|---|
| Author type | `agent` |
| Tier | `agent` |
| Route | `auto-merge` |
| Policy revision | `internal-dry-run-policy-v1` |
| Reason | `all-agent-gates-passed` |

This is only the deterministic output of the explicitly injected internal policy. It is not an owner decision, owner preference, application authority, or recommendation to bypass review. The human pilot's default participant representation remains anonymous unless the independent owner's real policy says otherwise.

## Projection outcome

Baseline and candidate used separate temporary vault and projection copies.

| Observation | Baseline | Candidate |
|---|---:|---:|
| Published pages | 933 | 933 |
| Published assets | 373 | 373 |
| Expected files | 1,306 | 1,306 |
| Actual files | 1,306 | 1,306 |
| Unexpected files | 0 | 0 |
| Missing files | 0 | 0 |
| Denied-present files | 0 | 0 |
| Projection failures | 0 | 0 |
| Selection errors | 4 | 4 |
| Projection warnings | 6 | 6 |
| Path violations | 2 | 2 |

The equal selection-error, warning, and path-violation counts are inherited diagnostics in this pinned corpus. They were not suppressed. Explicit projection verification passed in both lanes, and the correction introduced no file-set difference or denied-file exposure.

Measured projection times were 0.440 s for baseline and 0.374 s for candidate.

## Pinned Quartz rendering outcome

Quartz source clone completed in 0.88 s. Baseline and candidate used separate Quartz `v4.5.2` workspaces.

| Observation | Baseline | Candidate |
|---|---:|---:|
| Setup time | 7.538 s | 7.241 s |
| Build time | 83.964 s | 84.428 s |
| HTML pages checked | 3,786 | 3,786 |
| Broken-link tuples | 779 | 779 |
| Missing-page findings | 669 | 669 |
| Missing-asset findings | 101 | 101 |
| Relative-attachment findings | 7 | 7 |
| Other findings | 2 | 2 |
| Old-text occurrences on target page | 1 | 0 |
| Replacement occurrences on target page | 0 | 1 |
| Target page | same output path | same output path |

Both builds completed successfully. Rendered-target evidence took 0.006 s and proved that the old text appeared only in the baseline while the replacement appeared only in the candidate on the same output page.

## Link delta

The comparison key was `(page, href, decoded, class)`.

| Delta | Count |
|---|---:|
| Candidate-only | **0** |
| Baseline-only | **0** |
| Unchanged inherited | 779 |

The baseline link check took 0.736 s and the candidate check took 0.677 s. The 779 tuples are inherited baseline content debt. The supported claim is only that this candidate introduced no candidate-only broken-link tuple.

### Repeated-build aggregate-count variance

The post-hardening full rerun preserved the same 779 broken tuples, zero candidate-only tuples, zero baseline-only tuples, and the same exact rendered-target old-to-new evidence. Aggregate all-link counts were not byte-stable across Quartz builds:

| Measurement | Recorded baseline | Recorded candidate | Rerun baseline | Rerun candidate |
|---|---:|---:|---:|---:|
| Unique internal `(page, href)` pairs | 84,341 | 84,341 | 84,338 | 84,341 |
| Raw internal-link occurrences | 145,219 | 145,176 | 145,208 | 145,180 |

The unchanged baseline itself varied between runs, so these aggregate counts are renderer/build-output nondeterminism or timestamp-sensitive output, not a stable candidate-regression signal. The evidence does not support a stronger full-render-equality claim, and it does not attribute every aggregate-count difference to the correction. The bounded claim remains tuple-level broken-link parity plus exact target-page replacement evidence.

## Isolation, cleanup, and artifact safety

| Check | Result |
|---|---|
| Supplied checkout clean before run | PASS |
| Supplied checkout symbolic-link scan | PASS on the post-hardening full rerun |
| Supplied checkout clean after run | PASS |
| Exact pinned `HEAD` retained | PASS |
| Source bytes unchanged | PASS |
| Candidate applied only to temporary candidate copy | PASS |
| Baseline and candidate renderer workspaces isolated | PASS |
| Temporary live workspaces retained | 0 |
| Cleanup completed | PASS |
| Source write performed | No |
| Public deployment performed | No |

The static HTML review artifact has a restrictive Content Security Policy and contains no scripts, forms, frames, images, links, remote resources, accept/apply controls, or resource/action attributes. The case and result JSON omit the local source path, credentials, contact information, and raw private evidence.

## Machine execution timings

These timings describe one machine execution under `/tmp`. They are nondeterministic engineering observations, not product performance promises or human-study measurements.

| Operation | Time |
|---|---:|
| Cyberbase clone | 23.41 s |
| Quartz source clone | 0.88 s |
| Frozen install | 11.22 s |
| Scoped tests | about 2.82 s |
| Verifier process 1 | 0.922 s |
| Verifier process 2 | 0.911 s |
| No-write evaluation | 0.76 s |
| Instrumented live run | 190.169 s |
| Checkout verification before | 0.027 s |
| Checkout verification after | 0.026 s |
| Baseline projection | 0.440 s |
| Candidate projection | 0.374 s |
| Baseline Quartz setup | 7.538 s |
| Candidate Quartz setup | 7.241 s |
| Baseline Quartz build | 83.964 s |
| Candidate Quartz build | 84.428 s |
| Baseline link check | 0.736 s |
| Candidate link check | 0.677 s |
| Rendered-target evidence | 0.006 s |
| Combined copy, evaluation, card, and cleanup overhead not separately instrumented | 4.712 s |

No human concierge intake, mapping-confirmation, review-card interpretation, editorial decision, local application, publication, or owner-preference time was measured or inferred.

## Failures and adverse observations

### Selected candidate execution

The completed selected-candidate run had no harness repair, test failure, verifier failure, anchor failure, base-digest failure, projection failure, Quartz build failure, rendered-target mismatch, candidate-only link finding, source mutation, cleanup failure, or artifact-validation failure.

The following nonzero inherited diagnostics remained visible and equal in both lanes:

- four selector errors;
- six projection warnings;
- two path violations; and
- 779 broken-link tuples.

They are not candidate-run failures, but they are limitations of the pinned corpus and must not be rewritten as an entirely clean baseline.

### Earlier command-scope mistakes retained for honesty

During the preceding adversarial validation pass:

- An unscoped `bun test` from the repository root discovered unrelated `docs/tests/*.spec.ts` Playwright files. It reported 285 passing tests and three loader errors. The correctly scoped harness command then passed 46 of 46 tests. No docs or production code was changed to hide the invocation mistake.
- One verifier command placed Bun's `--cwd` flag in the wrong position and printed Bun usage text instead of JSON. The corrected package-script command passed twice and produced byte-identical output.

These were operator invocation errors, not harness defects and not evidence that the human workflow is usable.

## Retained sanitized artifacts

- [`results/ir-drop-responsibilities.case.json`](./results/ir-drop-responsibilities.case.json): sanitized case record with the public correction text, public repository/commit, evidence-item count, and redacted source mapping.
- [`results/ir-drop-responsibilities.result.json`](./results/ir-drop-responsibilities.result.json): deterministic mechanical, projection, rendering, link-delta, trust-classification, isolation, and cleanup evidence.
- [`results/ir-drop-responsibilities.review.html`](./results/ir-drop-responsibilities.review.html): static redacted review card, labeled `pending owner` and explicitly stating that no source write or public deployment occurred.

These are review artifacts, not the private runnable case input and not a product review surface.

## Limitations and remaining human work

- The candidate is spelling-only. It does not count toward the requirement for two substantive accepted-and-live corrections.
- No ordinary reader opened or completed the blank study form. Unaided completion remains `Not run`.
- No independently operated Markdown-KB owner confirmed a mapping, reviewed a card, accepted or rejected a correction, applied bytes, or published a result. Independent-owner and accepted-live thresholds remain `Not run`.
- No human concierge-conversion or owner-review duration was measured. The machine timings above cannot substitute for either threshold.
- No owner made the forced preference choice between the pilot workflow and email plus manual editing.
- One public Cyberbase candidate and one pinned Quartz configuration do not establish demand, general renderer support, a generalized source map, abuse resistance, accessibility, or interoperability.
- The harness performs no source I/O and ships no endpoint, editor, hosted console, automatic writer, account system, or account-free contribution path.

The next work is the precommitted independent pilot: five ordinary readers, one independently operated owner, owner-confirmed source mappings, local review cards, owner-controlled application, live verification of accepted corrections, human timing, and the forced owner-preference question. The fixed thresholds remain unchanged.

## Overall result

The internal dry run **completed successfully for its narrow mechanical scope**. It demonstrated that one exact public typo candidate could be bound to pinned source bytes, prepared as one splice, classified, projected, rendered, checked for candidate-only link damage, represented in sanitized static evidence, and cleaned up without modifying the supplied checkout.

It did not demonstrate human usability, useful correction demand, independent-owner acceptance, owner preference, a live correction, a shipped contribution workflow, or interoperability. It does not close Q09 and does not earn an R-number.

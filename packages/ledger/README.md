# @cyberbaser/ledger

`@cyberbaser/ledger` records one immutable, canonical JSONL observation for each pull request's first maintainer closure. It is the evidence source for deciding whether a maintainer's trust routes agree with real merge outcomes, including the requirement for at least 20 classified PRs and zero `auto-merge` disagreements before automatic merging can be activated.

**Status: installed and live in Cyberbase, with one unclassified maintainer observation.** The two-stage workflows were installed through Cyberbase PR #8. The first live runs exposed two GitHub integration mismatches and failed closed before publication: custom `run-name` appears in `workflow_run.name`, and the artifact ZIP endpoint rejects `application/octet-stream` while redirecting a normal API request to bounded HTTPS object storage. Cyberbaser PRs #4 and #5 repaired those assumptions; Cyberbase PRs #9 and #10 advanced the immutable tooling pin. Capture run `31648052403` and Record run `31648065388` then published the first valid row through ledger-only commit `4994bb6ce40a8f2dfb06f979ec8b49bb6ed63560`. The ledger validates with one entry, but its route is `null`, so the classified-observation count remains zero. A real fork run, closed-unmerged run, and duplicate rerun remain pending.

## What the package enforces

- Version 1 entries have a strict schema, canonical key order, compact JSON, and one trailing `LF`.
- Unknown fields, unsupported schemas, malformed history, duplicate PR numbers, invalid SHA or timestamp relationships, and noncanonical lines fail closed.
- Existing entries are validated before every append or statistics calculation.
- The first successfully published closure observation wins. A rerun is `already-recorded`; a later closure after reopening is `already-recorded-reclosed`.
- Check runs are reduced to the newest run for each `(appSlug, name)` pair and sorted by app slug, then name.
- Statistics report route counts, route-versus-decision agreement, and progress toward the configured observation target.
- The ledger domain in [`src/ledger.js`](./src/ledger.js) remains pure. The local ledger CLI owns file I/O; the GitHub adapter under [`src/github/`](./src/github/) owns bounded API reads, inert Git-object inspection, authority reconstruction, and exact publication.

The local CLI prepares a complete same-directory temporary file containing the original bytes plus one canonical line, verifies that the source file did not change during preparation, and atomically renames the temporary file. It never repairs, normalizes, sorts, or otherwise changes an existing ledger line.

## Two-stage GitHub architecture

The adapter deliberately separates an unprivileged event capture from a privileged trusted recorder.

### Stage A: Decision Ledger Capture

[`templates/decision-ledger-capture.yml`](./templates/decision-ledger-capture.yml) runs on `pull_request: closed` with `permissions: {}`. It checks out no repository, imports no Cyberbaser package, executes no contributor file, and uploads one one-day artifact containing exactly:

- schema version;
- repository ID and exact `owner/repository` name;
- source workflow run ID and attempt;
- pull-request number.

The deterministic run name and artifact name also bind the run ID and PR number. The JSON file is a **routing hint, not an authority record**. It contains no labels, route, actor, decision, SHAs, timestamps, checks, OFM result, URL, path, command, ref, or refspec.

### Stage B: Decision Ledger Record

[`templates/decision-ledger-record.yml`](./templates/decision-ledger-record.yml) runs only after `Decision Ledger Capture` completes successfully. It receives `actions: read`, `checks: read`, `contents: write`, `issues: read`, and `pull-requests: read`; uses one repository-wide, non-cancelling concurrency group; checks out the current base-repository default branch; and never makes the contributor head the active worktree.

Before using the hint, Stage B:

1. re-fetches the exact source run by `github.event.workflow_run.id`;
2. requires the trusted workflow name, path, event, repository, run ID, run attempt, success state, and deterministic display title;
3. lists artifacts for that exact run and requires exactly one correctly named, unexpired, bounded artifact;
4. downloads only that artifact, requires one fixed filename, and parses strict canonical JSON within compressed and unpacked size limits;
5. requires the archive contents, artifact metadata, refetched run, and Stage B event to agree; and
6. permits an empty `workflow_run.pull_requests` array, but fails on a conflicting or ambiguous non-empty array.

Only after those checks does Stage B reconstruct the ledger entry from authoritative sources. GitHub documents both the privileged `workflow_run` model and the need to treat artifacts from untrusted workflows carefully in [Events that trigger workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run). The exact-run and artifact reads use the [workflow-runs](https://docs.github.com/en/rest/actions/workflow-runs) and [artifacts](https://docs.github.com/en/rest/actions/artifacts) REST APIs.

## Authority sources

No ledger authority field is accepted from the capture artifact.

| Ledger evidence | Authoritative Stage B source |
|---|---|
| Repository and source run | Stage B event context plus the exact refetched Actions run |
| PR number | Trusted run title and artifact metadata, then verification against the pull-request API |
| Author, opened/closed time, merged state, merge SHA, base SHA, head SHA | [Pull-request API](https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request) |
| Trust route | Paginated [issue-label API](https://docs.github.com/en/rest/issues/labels#list-labels-for-an-issue) |
| Merged actor | Pull-request API `merged_by` |
| Closed-unmerged actor | The unique paginated [issue timeline](https://docs.github.com/en/rest/issues/timeline#list-timeline-events-for-an-issue) `closed` event matching `closed_at` |
| Actor authority | Current [collaborator-permission API](https://docs.github.com/en/rest/collaborators/collaborators#get-repository-permissions-for-a-user); must resolve to `maintain` or `admin` |
| Checks | Paginated [check-runs API](https://docs.github.com/en/rest/checks/runs#list-check-runs-for-a-git-reference) for the exact head SHA |
| Agent policy | `.cyberbaser/trust.yml` read from the exact base commit |
| OFM verdict | Recomputed from the exact inert base/head Git objects |
| `recordedAt` | Stage B clock immediately before publication input is built |

The adapter fetches the exact base, PR-head, and merge objects into private refs, verifies each as a commit, and requires the fetched PR-head ref to equal the API head SHA. Contributor content is read only as inert Git bytes for OFM recomputation. Missing objects, malformed base policy, incomplete pagination, contradictory labels, ambiguous close events, insufficient actor permission, or mismatched identities fail closed.

## Timing semantics

A row is the first **successfully published Stage B observation**, not a cryptographic snapshot of every value at the instant the PR closed. PR state, author, object IDs, and closure timestamps come from the authoritative pull-request record. Mutable labels, check-run state, and the actor's current repository permission are observed when Stage B reconstructs the entry. `recordedAt` is the Stage B clock.

If delivery repeats, or the PR is reopened and closed again, first-closure deduplication preserves the first published row. Later mutable observations cannot replace it.

## Safe publication

Stage B publishes through tested package code rather than a large workflow shell block. For at most three attempts it:

1. verifies that the configured fetch and push destinations both equal the trusted base-repository destination;
2. resolves and fetches exactly one default-branch ref;
3. creates a fresh detached worktree at that accepted tip;
4. validates the existing ledger and reruns first-closure deduplication;
5. appends through the existing canonical CLI path;
6. verifies that only `.cyberbaser/decision-ledger.jsonl` changed;
7. creates one factual, single-parent bot commit with exactly that path;
8. requires the remote ref to remain at the accepted base before push;
9. pushes the exact commit to `refs/heads/<default>` without force; and
10. verifies that the exact commit became the remote branch tip.

Only a classified fast-forward branch-advance race is retried. Authentication, branch protection, malformed history, destination mismatch, rewind/divergence, authority failure, or unverifiable post-push state stops immediately. The publisher never force-pushes, merges, rebases, rolls back, writes a fork/PR head, or accepts a destination, path, command, URL, ref, or refspec from the artifact.

## CLI

Validate or summarize a local ledger:

```bash
bun packages/ledger/bin/cb-decision-ledger.js validate \
  --file .cyberbaser/decision-ledger.jsonl

bun packages/ledger/bin/cb-decision-ledger.js stats \
  --file .cyberbaser/decision-ledger.jsonl \
  --target 20
```

Append one already-derived version 1 entry from standard input:

```bash
printf '%s\n' "$ENTRY_JSON" | \
  bun packages/ledger/bin/cb-decision-ledger.js append \
    --file .cyberbaser/decision-ledger.jsonl
```

The narrow GitHub CLI has two commands used by the templates:

- `capture` creates the canonical inert routing hint.
- `record` validates the `workflow_run` event, reconstructs authority through the GitHub API and exact Git objects, then performs bounded exact publication.

Every successful command writes one compact JSON object to stdout. Diagnostics go to stderr. The domain CLI's exit codes remain `0` for success or an idempotent no-op, `2` for invalid arguments/input/history, `3` for unsupported schemas or contradictory duplicate history, and `4` for filesystem or publication failures.

## Live installation and current evidence

The supplied record template remains intentionally **non-runnable**: its Cyberbaser checkout uses the all-zero immutable tooling placeholder. Each installation or repair must replace that placeholder with one reviewed 40-character Cyberbaser commit. The template never falls back to `main`, `latest`, a tag, or another mutable tooling ref. GitHub actions and Bun are also pinned to reviewed versions.

Cyberbase PR #8 installed both workflows. PRs #9 and #10 advanced the installed recorder after the first two live attempts exposed measured GitHub behavior. Both attempts failed closed before any ledger or content write. The third sequence succeeded:

- Capture run `31648052403` emitted the inert hint for Cyberbase PR #10;
- Record run `31648065388` reconstructed authority and published one row;
- commit `4994bb6ce40a8f2dfb06f979ec8b49bb6ed63560` is single-parent and changes only `.cyberbaser/decision-ledger.jsonl`;
- the complete ledger validates with one entry;
- the row is an unclassified maintainer merge (`trustRoute: null`, `ofmVerdict: not-applicable`), so progress remains `0 / 20`; and
- the ledger-only push triggered no site-publication workflow.

This is real GitHub and default-branch publication evidence for one maintainer-authored workflow-only PR. It is not yet live fork-token, closed-unmerged, duplicate-delivery, classifier-agreement, or independent-human evidence.

## Development and acceptance evidence

```bash
bun install --cwd packages/ledger --frozen-lockfile
bun test packages/ledger/test
```

The hermetic acceptance suite uses fake GitHub API responses and local bare remotes to prove:

- a maintainer-authored merged PR publishes one row;
- a fork PR publishes while contributor package code remains unexecuted;
- a closed-unmerged PR derives its actor from the unique matching timeline event;
- duplicate delivery changes neither the ledger nor Git; and
- a tampered artifact fails before any reconstruction Git command or publication mutation.

Workflow-structure tests also reject `pull_request_target`, writable one-stage `pull_request` recorders, contributor checkout, mutable action references, and force pushes. Repository CI in [`.github/workflows/ledger.yml`](../../.github/workflows/ledger.yml) is read-only package verification, not the live vault recorder.

Related packages: [`@cyberbaser/trust`](../trust/) supplies the base-bound agent policy and route vocabulary, and [`@cyberbaser/ofm`](../ofm/) supplies the authoring-semantics verdict recomputed from exact base/head objects. The canonical design and operational status live in [Decision Ledger](../../docs/src/content/docs/design/decision-ledger.mdx).

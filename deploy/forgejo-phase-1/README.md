# Forgejo Actions phase-one fixture

This package is the disposable acceptance boundary for owner-alpha's Forgejo Actions deployment-observation adapter. It proves a private Forgejo-hosted repository, two controlled PR checks, one exact owner-alpha Save, exact run/job binding, and an HTTPS live witness without moving production authority.

**WP3 phase one is complete.** The adapter and fixture are hermetically tested, and the real Forgejo 16.0.2 gate passed on 2026-08-10 under a rootless Docker daemon. Workflow jobs ran in unprivileged run-scoped containers, the isolation probe passed, the controlled PR gates passed, the exact owner-alpha Save reached the live witness, temporary storage remained below 4 GiB, the authoritative seed repository stayed unchanged, and manifest-bound cleanup removed every labelled resource.

See the canonical [Forgejo phase-one guide](../../docs/src/content/docs/development/forgejo-phase-1.mdx), the [next-arc architecture plan](../../docs/src/content/docs/design/v2-architecture-plan.mdx), and Forgejo's [Actions documentation](https://forgejo.org/docs/latest/user/actions/).

## What the fixture does

1. Creates one mode-`0700` UUID run root below `/home/cybersader/.cache/cyberbaser/wp3/` on native ext4 or btrfs storage.
2. Reserves `127.0.0.1:8443` for Forgejo and `127.0.0.3:8443` for the published witness.
3. Creates a run-local CA and ECDSA P-256 TLS certificates.
4. Starts one immutable-image Forgejo container and requires the explicitly reviewed 16.0.2 release at runtime, with `pull_policy: never`, read-only root, dropped capabilities, bounded logs, SQLite, no SSH, and double-labelled resources.
5. Creates a tiny authoritative bare repository, records its refs and objects, then seeds one private Forgejo repository once without enabling Forgejo mirroring.
6. Builds one run-scoped job image and runs one checksum-bound Forgejo Runner daemon at capacity one. The daemon may reach the rootless engine; every workflow job runs in an unprivileged container with only the exact read-only tool and writable publication mounts, one run-scoped network, and no engine socket.
7. Runs `isolation-probe` before downstream work. The probe fails if job code can reach a Docker or Podman socket, the host run root, host Git identity, host engine data, host SSH state, the host loopback forge origin, or a writable tool mount.
8. Runs the tracked shell-only `ofm-check` and `trust-gate` workflows on one controlled same-repository PR, then merges only after both exact workflow runs succeed.
9. Clones the Forgejo repository into an isolated owner-alpha checkout and runs one exact Save through normal push, Forgejo run/job observation, and the existing live-witness boundary.
10. Rechecks the original authoritative repository, storage ceiling, retained evidence, and manifest-bound cleanup.

The tracked workflows prove only the fixture workflows and copied Cyberbaser tools in this repository. They do not claim that unpublished workflows in an external vault were ported.

## Normal tests

These tests do not start Forgejo or pull images:

```bash
bun run --cwd apps/owner-alpha test:deployment
```

The focused cross-provider entry point covers the unchanged GitHub branch, strict Forgejo configuration, both providers through the generic dispatcher, persisted-binding recovery, adapter contracts, initializing-job polling, redirect rejection, private-checkout authentication under a clean Git boundary, fixture structure, cleanup fault cases, runner-byte binding, container isolation, Forgejo-native run statuses and fields, null empty-dependency normalization, and the runtime skip contract.

## Real gate inputs

Provisioning the immutable Forgejo image and runner is a separate action. The gate never pulls either input:

```text
OWNER_ALPHA_REAL_FORGEJO=1
WP3_FORGEJO_IMAGE=<immutable image ID or repository@sha256 digest>
WP3_FORGEJO_RUNNER=<absolute native-Linux runner binary path>
WP3_FORGEJO_RUNNER_SHA256=<expected lowercase SHA-256>
```

Run:

```bash
OWNER_ALPHA_REAL_FORGEJO=1 \
WP3_FORGEJO_IMAGE='repository@sha256:...' \
WP3_FORGEJO_RUNNER='/absolute/native/linux/path/forgejo-runner' \
WP3_FORGEJO_RUNNER_SHA256='...' \
bun run --cwd apps/owner-alpha test:forgejo:real
```

The harness refuses mutable image tags, mounted Windows/WSL runner paths, symlink aliases, checksum mismatches, unsupported run-root filesystems, occupied fixture bindings, non-rootless engines, and concurrent runs. It copies the verified runner bytes into the mode-`0700` run root and rehashes that copy, so later replacement of the operator path cannot change the executable.

## Credential boundary

The run creates distinct setup, repository-push, Actions-observer, and runner-registration credentials. Each harness-created value lives in its own mode-`0600` file below the run root and does not enter owner-alpha configuration, environment variables, command arguments, endpoint URLs, retained JSON, or durable job evidence.

Private workflow checkout is a separate Forgejo platform boundary. Each job receives Forgejo's automatic repository-scoped `FORGEJO_TOKEN` in its step environment. The tracked workflows require that token and call a read-only allowlisted checkout helper that disables system, global, indexed, and interactive Git credential sources, installs a temporary helper for the fetch, and removes it afterward. The observer token remains file-backed and is read on every request through the adapter's test-only `getForgejoObserverToken()` seam. The normal owner-alpha server and WP2 image remain anonymous-only for deployment observation.

## Measured acceptance

The final retained evidence run on 2026-08-10 recorded:

- Forgejo `16.0.2+gitea-1.22.0`;
- successful `isolation-probe`, `ofm-check`, and `trust-gate` jobs;
- one merged controlled PR;
- one exact `content/page.md` owner-alpha splice and one-path commit;
- exact pushed SHA, Forgejo run `6`, and bound `build` → `deploy` jobs at attempt `1`;
- successful HTTPS live transition;
- unchanged authoritative seed repository;
- peak combined temporary storage: `172,289,041` bytes;
- after-teardown measurement before run-root removal: `33,979,833` bytes;
- cleanup: two exact processes stopped, four labelled Docker resources removed, zero skipped processes or resources;
- zero labelled resources and zero run roots after completion.

This is controlled local fixture evidence. It is not a physical-device result, independent-owner result, service installation, image publication, external-vault workflow-port claim, persistent mirror, or production authority cutover.

## Cleanup and storage

The combined Docker-growth plus run-root ceiling is 4,294,967,296 bytes. At or above 3.5 GiB, the harness starts no new phase. It measures every required phase boundary.

Cleanup reads only the atomic mode-`0600` manifest. Docker creation is authorized in that manifest before Compose starts. If Compose or the runner creates a labelled resource before its ID is persisted, cleanup requires the exact run and provenance labels, records the recovered immutable ID atomically, and only then removes it. A process is stopped only when PID, `/proc` start time, executable, and run-root working directory all match. The harness and child handle `SIGINT`, `SIGTERM`, and `SIGHUP`; the child also watches for parent death. A stale global lock may be recovered only after its recorded owner identity is dead and manifest-bound cleanup succeeds. Cleanup errors remain gate failures. The final storage measurement runs after process and Docker teardown, before the validated run root is removed. No prune command, unrelated image or cache removal, unrelated process stop, or broad project cleanup is permitted.

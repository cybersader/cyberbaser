# Forgejo Actions phase-one fixture

This package is the disposable acceptance boundary for owner-alpha's Forgejo Actions deployment-observation adapter. It proves a private Forgejo-hosted repository, two controlled PR checks, one exact owner-alpha Save, exact run/job binding, and an HTTPS live witness without moving production authority.

The adapter and fixture package are implemented, and the hermetic configuration, adapter, recovery, workflow-authentication, cleanup, and provider-regression tests pass. Adversarial review confirmed that the planned same-UID host-mode runner could read run-root credentials and reach an ambient same-user container socket. The harness now blocks the opt-in real gate before it acquires the fixture lock, creates a run root, or starts Docker. WP3 phase one is **implemented but quarantined pending a separately reviewed runner-isolation boundary and then real-engine acceptance**, not complete.

See the canonical [Forgejo phase-one guide](../../docs/src/content/docs/development/forgejo-phase-1.mdx), the [next-arc architecture plan](../../docs/src/content/docs/design/v2-architecture-plan.mdx), and Forgejo's [Actions documentation](https://forgejo.org/docs/latest/user/actions/).

## What the fixture does

1. Creates one mode-`0700` UUID run root below `/home/cybersader/.cache/cyberbaser/wp3/` on native ext4.
2. Reserves `127.0.0.2:443` for Forgejo and `127.0.0.3:443` for the published witness.
3. Creates a run-local CA and TLS certificates.
4. Starts one immutable-image Forgejo container and requires the explicitly reviewed 16.0.2 release at runtime, with `pull_policy: never`, read-only root, dropped capabilities, bounded logs, SQLite, no SSH, and double-labelled resources.
5. Creates a tiny authoritative bare repository, records its refs and objects, then seeds one private Forgejo repository once without enabling Forgejo mirroring.
6. Intended to run one checksum-bound native host-mode Forgejo Runner at capacity one. This step is currently fail-closed because a same-UID runner is not isolated from run-root credentials or ambient same-user container sockets.
7. Once a reviewed isolation boundary exists, runs the tracked shell-only `ofm-check` and `trust-gate` workflows on one controlled same-repository PR, then merges only after both checks succeed.
8. Clones the Forgejo repository into an isolated owner-alpha checkout and runs one exact Save through normal push, Forgejo run/job observation, and the existing live-witness boundary.
9. Rechecks the original authoritative repository, storage ceiling, retained evidence, and manifest-bound cleanup.

The tracked workflows prove only the fixture workflows and copied Cyberbaser tools in this repository. They do not claim that unpublished workflows in an external vault were ported.

## Normal tests

These tests do not start Forgejo or pull images:

```bash
bun run --cwd apps/owner-alpha test:deployment
```

This focused cross-provider entry point covers the unchanged GitHub branch, strict Forgejo configuration, both providers through the generic dispatcher, persisted-binding recovery, adapter contracts, initializing-job polling, redirect rejection, private-checkout authentication under a clean Git boundary, fixture structure, cleanup fault cases, runner-byte binding, and the runtime skip contract. The runtime file's real acceptance case remains skipped unless every exact opt-in input is present, and the harness still refuses to start it while the host-runner isolation blocker remains.

## Real gate inputs

Provisioning the image and runner is a separate authorized action. The gate never pulls either input:

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

The harness refuses mutable image tags, mounted Windows/WSL runner paths, symlink aliases, checksum mismatches, non-ext4 run roots, occupied standard HTTPS bindings, and concurrent fixture runs. It copies the verified runner bytes into the mode-`0700` run root and rehashes that copy, so later replacement of the operator-supplied pathname cannot change the executable. At present it then fails before resource creation because the same-UID host-runner authority is not an acceptable isolation boundary.

## Credential boundary

The run is designed to create distinct setup, repository-push, Actions-observer, and runner-registration credentials. Each harness-created value lives in its own mode-`0600` file below the run root and does not enter owner-alpha configuration, environment variables, command arguments, endpoint URLs, retained JSON, or durable job evidence.

Private workflow checkout is a separate Forgejo platform boundary. Each job receives Forgejo's automatic repository-scoped `FORGEJO_TOKEN` in its step environment. The tracked workflows require that token and call a read-only allowlisted checkout helper that disables system, global, indexed, and interactive Git credential sources, installs a temporary helper for the fetch, and removes the helper afterward. This prevents fallback to unrelated host credentials. The observer token remains file-backed and is read on every request through the adapter's test-only `getForgejoObserverToken()` seam. The normal owner-alpha server and WP2 image remain anonymous-only for deployment observation.

## Cleanup and storage

The combined Docker-growth plus run-root ceiling is 4,294,967,296 bytes. At or above 3.5 GiB, the harness starts no new phase. It measures every required phase boundary.

Cleanup reads only the atomic mode-`0600` manifest. Docker creation is authorized in that manifest before Compose starts. If Compose creates a double-labelled resource and fails before its ID is recorded, cleanup also requires the exact Compose project label, writes the recovered ID into the manifest atomically, and only then removes it. A process is stopped only when PID, `/proc` start time, executable, and run-root working directory all match. The harness and child handle `SIGINT`, `SIGTERM`, and `SIGHUP`; the child also watches for parent death and terminates directly spawned processes. A stale global lock may be recovered only after its recorded owner identity is dead and manifest-bound cleanup succeeds. Cleanup errors are retained as gate failures rather than suppressed. The final storage measurement runs after process and Docker teardown, before the validated run root is removed. No prune command, image removal, cache removal, unrelated process stop, or broad project cleanup is permitted.

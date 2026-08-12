# Account-free intake OCI deployment

This directory packages `apps/account-free-intake` as a dedicated local-only Linux/amd64 OCI image and an off-by-default Docker Compose profile. It is a packaging and local acceptance boundary for WP4 Lane B. It does not expose a real public endpoint, install a service, publish an image, configure TLS or edge abuse controls, or authorize source application or publication.

The runtime accepts anonymous correction intents only after the application resolves retained publication bindings and exact historical Git objects. Its only durable write is the proposal queue. The owner-controlled review and source-application boundary remains separate.

## Fixed isolation contract

The `account-free-intake` service is deliberately narrower than a general application container:

- image default and Compose runtime user are `65532:65532`;
- the image root is read-only;
- all Linux capabilities are dropped and `no-new-privileges` is set;
- the Compose profile is named `account-free-intake`, so a plain `docker compose up` starts nothing;
- the service uses a dedicated `internal: true` bridge network;
- there is no host networking, `ports:` mapping, `EXPOSE`, or direct host listener;
- the source config, retained bindings, and bare Git object store are read-only binds;
- one dedicated named volume contains only `/var/lib/cyberbaser/proposal-queue`;
- `/run/account-free-intake` and `/tmp` are small `nosuid,nodev,noexec` tmpfs mounts;
- the image contains no owner-alpha application, vault worktree, renderer, publication output, credential helper, or service manager.

The entrypoint also rejects credential and engine-socket environment inputs, requires the Git input to be a real bare repository without credential helpers, and refuses `/vault`, owner-alpha runtime paths, Docker or Podman sockets, SSH material, a source worktree mount, or publication output.

The internal network is attachable only so a separately designed reverse proxy can eventually join it. This repository does not provide or start that proxy. A future proxy must preserve the configured public `Host`, expose only `/v1/corrections`, keep `/healthz` internal, terminate TLS, and supply independent edge DDoS controls. Joining a proxy or exposing an endpoint is a separate authorization step.

The review CLI is unavailable concurrently with the running service because its shared inspection lock conflicts with the service's lifetime exclusive queue lock. Stop the service before invoking it. The inspector opens only an initialized queue, revalidates exact proposal/source/policy evidence, and performs no recovery, expiration, purge, state replacement, temporary cleanup, or other filesystem mutation. If the queue requires recovery, inspection fails closed and the normal service startup must recover it first.

## Image contents

The build context is allowlisted. The final image contains only:

- `apps/account-free-intake`;
- `packages/account-free-intake`;
- `packages/proposal-queue`;
- the proposal, correction, trust, and OFM runtime dependencies;
- Bun, Node, Git, `flock`, and the small deployment scripts in this directory.

Both OCI bases, the Debian snapshot, and explicitly requested Debian packages are pinned. The image has no registry publication workflow and Compose uses `pull_policy: never` with no `build:` stanza.

## Prepare local fixture inputs

All examples use reserved `.invalid` domains and do not name a live service.

### 1. Build a local image

From the repository root:

```bash
docker buildx build \
  --platform linux/amd64 \
  --file deploy/account-free-intake/Containerfile \
  --tag cyberbaser-account-free-intake:local \
  --load \
  .

docker image inspect --format '{{.Id}}' cyberbaser-account-free-intake:local
```

Record the returned `sha256:...` image ID. Use that immutable local ID in the operator environment. Do not push the tag or substitute `latest`.

### 2. Prepare the credential-free config

```bash
install -d -m 700 /absolute/operator/config-directory
install -m 444 \
  deploy/account-free-intake/account-free-intake.container.example.json \
  /absolute/operator/config-directory/account-free-intake.json
```

Edit the copy before making it read-only. Replace every `.invalid` origin and repository identity, but keep these container paths exact:

```json
{
  "bindingsRoot": "/srv/cyberbaser/source-bindings",
  "gitDir": "/srv/cyberbaser/source-objects.git",
  "queue": {
    "root": "/var/lib/cyberbaser/proposal-queue"
  }
}
```

`enabled` must remain literal `true`, `listen.host` must remain `0.0.0.0`, and the application schema keeps the HTTP body, deadline, concurrency, and token-bucket limits fixed. The file must be one regular, singly linked, non-symlink file with no write permission bits. Startup copies it without following symlinks into a mode-`0600` private tmpfs file, validates the complete application schema and runtime paths, then starts the listener from that staged copy.

The config is credential-free. Never put a token, password, private key, authorization header, credential-helper setting, SSH path, or engine endpoint in it.

### 3. Prepare retained read-only inputs

Provide two exact host directories:

1. A retained source-binding directory containing canonical immutable binding manifests named by `retainedManifestFilename(bindingDigest)`.
2. A real bare Git repository retaining every commit, page blob, and bound trust-policy blob needed for the full queue retention period.

The configured repository is an identity binding only. Runtime Git inspection uses `protocol.allow=never`, so the container cannot fetch a missing object. Populate and verify these inputs outside the service, then mount them read-only. Do not mount a checkout, worktree, forge credential, home directory, `.ssh` directory, SSH agent, Git credential store, vault, renderer output, or publication directory.

### 4. Prepare the operator environment

```bash
install -m 600 \
  deploy/account-free-intake/operator.env.example \
  /absolute/operator/config-directory/account-free-intake.env
```

Set the immutable image ID, the three exact absolute input paths, a dedicated queue-volume name, and a dedicated internal-network name. Do not reuse an owner-alpha state volume or a volume used by another queue process.

## Validate and start locally without exposure

Compose requires the explicit profile on every operation:

```bash
docker compose \
  --file deploy/account-free-intake/compose.yaml \
  --env-file /absolute/operator/config-directory/account-free-intake.env \
  --profile account-free-intake \
  config

docker compose \
  --file deploy/account-free-intake/compose.yaml \
  --env-file /absolute/operator/config-directory/account-free-intake.env \
  --profile account-free-intake \
  up --detach
```

The one-shot queue initializer has no network, mounts no config or source input, and receives only `CAP_CHOWN`. On a new dedicated volume it creates one `0700`, `65532:65532` queue root. On later starts it refuses unexpected volume entries, ownership changes, or mode changes. It never recursively changes an existing queue.

The service becomes healthy only when:

1. every fixed mount and exclusion check passes;
2. the config is safely staged and fully validated;
3. the queue lock, recovery, evidence verification, expiration, and retention pass;
4. an exact `127.0.0.1:<port>` Host request from the container loopback reaches `/healthz` and returns the fixed ready response.

There is intentionally no documented host URL because the service has no published port. Inspect only through Docker while running local acceptance:

```bash
docker compose \
  --file deploy/account-free-intake/compose.yaml \
  --env-file /absolute/operator/config-directory/account-free-intake.env \
  --profile account-free-intake \
  ps
```

## Stop and remove local resources

```bash
docker compose \
  --file deploy/account-free-intake/compose.yaml \
  --env-file /absolute/operator/config-directory/account-free-intake.env \
  --profile account-free-intake \
  down
```

`down` preserves the named queue volume. Deleting that volume destroys retained proposal review evidence, so do it only after deliberate owner review. Removing the container or local image never alters source because no source worktree or publication output is mounted.

## Tests

Run the package-local deterministic suite:

```bash
bun test deploy/account-free-intake/test
```

The structural and script tests require only Bun, Git, and `flock`. They validate the image allowlist, pinned runtime, fixed staging contract, off-by-default Compose profile, internal-only/no-port topology, read-only mounts, dedicated queue storage, non-root and capability policy, health request, and explicit exclusion list.

The container runtime acceptance is opt-in because it builds and runs a local image:

```bash
image_id="$(docker image inspect --format '{{.Id}}' cyberbaser-account-free-intake:local)"
ACCOUNT_FREE_INTAKE_CONTAINER_IMAGE="$image_id" \
  bun test deploy/account-free-intake/test/runtime-acceptance.test.js
```

That acceptance creates only temporary local Git objects, retained bindings, an internal Docker network, a named queue volume, and one container. It verifies image metadata, mount access, network isolation, internal health, one real anonymous enqueue, durable queue artifacts, unchanged read-only inputs, and cleanup. It does not contact a forge, fetch evidence, expose a host port, start a reverse proxy, install a service, publish an image, write source, make an owner decision, or publish content.

If Docker is unavailable or `ACCOUNT_FREE_INTAKE_CONTAINER_IMAGE` is unset, the image acceptance test is reported as skipped rather than silently claiming runtime evidence.

The read-only `.github/workflows/account-free-intake-container.yml` builds a local image, resolves its immutable image ID, and supplies that ID to the runtime acceptance test. It has no registry login/push, artifact publication, deployment, secret, or repository-write step.

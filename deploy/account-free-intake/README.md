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

The local-only internal network is attachable so a separately authorized reverse proxy can join it. The optional public overlay below supplies a Cloudflare Tunnel connector, not an activated tunnel. A proxy must preserve the configured public `Host`, expose only `/v1/corrections`, keep `/healthz` internal, terminate TLS, and supply independent edge DDoS controls. Joining a proxy or exposing an endpoint is a separate authorization step. The base Compose file remains unchanged and internal-only.

The review CLI is unavailable concurrently with the running service because its shared inspection lock conflicts with the service's lifetime exclusive queue lock. Stop the service before invoking it. The inspector opens only an initialized queue, revalidates exact proposal/source/policy evidence, and performs no recovery, expiration, purge, state replacement, temporary cleanup, or other filesystem mutation. If the queue requires recovery, inspection fails closed and the normal service startup must recover it first.

## Image contents

The build context is allowlisted. The final image contains only:

- `apps/account-free-intake`;
- `packages/account-free-intake`;
- `packages/proposal-queue`;
- `packages/proposal-review` for strict live snapshot and summary contracts;
- the proposal, correction, trust, and OFM runtime dependencies;
- Bun, Node, Git, `flock`, and the small deployment scripts in this directory.

Both OCI bases, the Debian snapshot, and explicitly requested Debian packages are pinned. The image has no registry publication workflow and Compose uses `pull_policy: never` with no `build:` stanza.

## Prepare local fixture inputs

Local examples use reserved `.invalid` domains. The optional public examples use reserved `example.com` hostnames. None names a live service.

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

`enabled` must remain literal `true`, `listen.host` must remain `0.0.0.0` for this container bundle (only the owner app's private-site mode binds a private address directly), and the application schema keeps the HTTP body, deadline, concurrency, and token-bucket limits fixed. The file must be one regular, singly linked, non-symlink file with no write permission bits. Startup copies it without following symlinks into a mode-`0600` private tmpfs file, validates the complete application schema and runtime paths, then starts the listener from that staged copy.

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

## Opening the form to the public (off by default)

**This is a prepared deployment profile, not public deployment evidence or permission to expose the owner's server.** Both Compose files have profiles on every service. A plain `docker compose up` starts nothing, even when the optional overlay is included. Do not set `COMPOSE_PROFILES` globally. Do not start the connector until the owner authorizes the hostname, edge rules, and privacy trade-off.

The intended path is browser → Cloudflare HTTPS edge → outbound Tunnel connector → intake → local proposal queue. There are no inbound home-router rules or host port mappings, including on a Docker-capable TrueNAS host. Cloudflare terminates public TLS and can process correction content; this is not end-to-end encryption from the browser to the home server. The Turnstile secret is mounted only into intake and sent to Turnstile's Siteverify service for validation; the tunnel token is mounted only into the connector. Neither is a forge credential or source-write authority.

### Prerequisites and network boundary

- An owner-controlled Cloudflare account, a domain/zone eligible for the selected Tunnel and rate-limiting features, a public HTTPS form site, and explicit authorization to expose only this endpoint. Verify the account's current feature availability; this runbook does not promise any pricing tier or entitlement.
- A supported Docker Engine and Compose with profiles, file-backed secrets, and JSON `config` output. TrueNAS installations need a supported Docker/Compose deployment surface and suitable persistent datasets; this is not a TrueNAS app catalog installation or a Podman compatibility claim.
- The local immutable intake image and retained read-only inputs described above. Rebuild the image with the bot-check implementation before public use. Do not run a second writer against the queue volume.
- An independently reviewed cloudflared release with `tunnel run --token-file` support. Verify the current [Tunnel run parameters](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-run-parameters/) and [connectivity prerequisites](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/troubleshoot-tunnels/connectivity-prechecks/) before selecting it. Load the exact verified image locally; the wrapper never pulls it. No current Cloudflare account, CLI, or network behavior was verified by these offline tests.
- No overlap with the fixed internal subnet `172.30.93.0/29`. The public overlay assigns intake `172.30.93.2` and connector `172.30.93.3`; `trustedPeers` is exactly that dedicated subnet, never all Docker or private addresses. If it overlaps a home/container network, change the overlay's subnet and both fixed addresses, the public config CIDR, tunnel origin, and corresponding tests together before use.

`compose.public.yaml` adds two separate outbound bridges. Only cloudflared joins the tunnel-egress bridge; only intake joins the verification-egress bridge for Turnstile's server-side HTTPS check. They share only the internal bridge. This explicitly relaxes the **optional public intake's outbound isolation**, not its no-host-port boundary. Compose bridges are not destination allowlists. Enforce any outbound allowlist with the host firewall using the current Cloudflare connectivity documentation; DNS, tunnel transport, and Siteverify connectivity must work. The base local-only profile retains no egress. A host/Docker administrator can attach peers to bridges; this is not a boundary against a malicious host administrator. Never attach unrelated containers to the trusted subnet.

### Prepare the widget, config, and secret files

1. Copy `account-free-intake.public.container.example.json` to an operator-owned file outside the repository. Replace `suggest.example.com` with the intake hostname, `www.example.com` with the form hostname, and the repository identity with the retained source identity. Keep the fixed container paths and read-only config-file requirements from the local setup. The public example explicitly enables Turnstile and header-based client addressing; do not reuse the bot-check-off local example.
2. Create a [Turnstile widget](https://developers.cloudflare.com/turnstile/get-started/) for the exact **form** hostname. Put its **public site key** in the renderer's Turnstile configuration and use action `suggest-correction`. Keep `botCheck.expectedHostnames` equal to the form hostname, not the intake hostname. The browser sends the result in `Cyberbaser-Challenge-Token`, not in proposal JSON, a URL, or retained evidence. Check the renderer's current configuration instructions before building the public site.
3. Save the widget's **secret key** as the sole value in an operator-owned regular file outside the repository, for example `/absolute/operator/secrets/turnstile-secret`. Do not put it into an environment value, config JSON, shell argument, image, site build, or log. Use the platform's secure secret-entry/file mechanism, not a command containing the key. The file is mounted read-only at `/run/secrets/turnstile-secret`; validation fails closed if verification fails or times out. The example uses a 3000 ms verification timeout.
4. Copy `operator.public.env.example` to a mode-`0600` operator file. Fill the input paths and **secret file paths only**. A placeholder digest is intentionally unusable: replace `CLOUDFLARED_IMAGE` with `cloudflare/cloudflared@sha256:<verified 64-digit digest>` for the reviewed image. Never substitute a mutable tag. `public-profile.js` rejects placeholders and malformed pins before startup; Docker also uses `pull_policy: never`.

The public example keeps default application buckets: sender capacity/refill **3 / 3 per hour**, network **10 / 10 per day**, page **2 / 2 per day**. These are bounded origin defenses alongside the global token/concurrency limits and finite queue capacity, not a substitute for edge protection. Header trust applies only when the socket peer belongs to the dedicated subnet. Ensure the connector supplies the authoritative `CF-Connecting-IP` and preserves/replaces the origin Host as configured, rather than forwarding arbitrary client address headers from another proxy.

Compose local file-backed secrets are read-only mounts but are **not encrypted secret storage**, and Compose may not remap their host ownership/mode. Both containers run as `65532:65532`: set file ownership/mode or an equivalent dataset ACL so this identity can read the files but other host users cannot. A typical rootful Linux setup uses owner `65532:65532` and mode `0400` inside an operator-only parent directory. Verify actual permissions on the selected host; do not make secrets world-readable to fix an ACL problem. Keep the two secrets separate, singly linked and non-symlinked, and rotate them independently after suspected exposure.

### Prepare the tunnel and edge controls before starting it

1. Create an owner-managed, remotely managed [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/). Save its connector token as the sole value in `/absolute/operator/secrets/cloudflared-token`, with the same restricted ownership/readability rules. Point `ACCOUNT_FREE_INTAKE_TUNNEL_TOKEN_PATH` to that file. Never use a literal token environment variable or pass it in the connector command line.
2. Configure only the public hostname `suggest.example.com` to reach `http://172.30.93.2:8080` inside the connector's internal bridge. Pin the origin HTTP Host to `suggest.example.com` to match `publicOrigin`. Restrict the published application route to the exact `/v1/corrections` path, permitting both POST and CORS OPTIONS. Do not forward a catch-all route, `/healthz`, an owner application, forge, dashboard, or a private management hostname. Use the current Tunnel documentation for the selected release/dashboard's path matching and unmatched-route rejection behavior, and verify it before public use.
3. Add **one [Cloudflare rate-limiting rule](https://developers.cloudflare.com/waf/rate-limiting-rules/)** matching the intake hostname and `/v1/corrections`. For example, limit each client IP to **10 requests per 60 seconds**, temporarily blocking excess requests. This is a tunable starting target, not an assertion that every plan supports that exact window, characteristic, or action. Choose supported equivalents, account for CORS OPTIONS, and test retries/shared-network users. The rule must be enabled before opening the route.
4. Optional additional controls: reviewed WAF managed rules and supported bot protections, scoped to this hostname/path. Do not put an interactive HTML challenge or account-login Access gate in front of the JSON POST or CORS preflight: that can break the account-free form. Turnstile's widget is the intended browser challenge. Never enable broad zone-wide settings merely to run this profile.
5. Keep the form hidden until the connector and server pass the owner's bounded acceptance check. Test a valid challenge, expired/missing challenge rejection, wrong-origin rejection, sender limit, and edge throttling. Verify `/healthz` and every unrelated path remain unavailable publicly. Inspect logs without recording tokens or submitted text. Do not infer public readiness from the local structure tests.

### Validate, start, and turn it off again

From the repository root, validate the merged profile without starting or pulling anything:

`bun deploy/account-free-intake/public-profile.js config /absolute/operator/account-free-intake.public.env`

After separate owner authorization, start the explicit public profile:

`bun deploy/account-free-intake/public-profile.js up /absolute/operator/account-free-intake.public.env`

The wrapper includes both Compose files and `--profile public`, checks the resolved digest, and refuses builds/pulls. All intake hardening, read-only evidence, queue-only writes, and internal health checks remain in force. No connector is started by the local-only instructions above. Do not bypass the wrapper with an unverified image pin.

To close the internet path while leaving intake running locally:

`bun deploy/account-free-intake/public-profile.js stop /absolute/operator/account-free-intake.public.env`

To stop and remove this Compose deployment without deleting the retained queue:

`bun deploy/account-free-intake/public-profile.js down /absolute/operator/account-free-intake.public.env`

Also hide/rebuild the public form and disable/delete the published Tunnel route (and revoke its token if exposure is no longer intended) in the owner's Cloudflare account. Neither wrapper command modifies Cloudflare. A later explicit `up` can reopen a configured route unless it has been disabled. Return to the base file and bot-check-off local config only after stopping the public stack; never run public and local stacks against one queue concurrently. Do not use `down --volumes`.

**Not provided:** receipt status lookup, contributor accounts or verified identity, hosted review/owner authority, source writes, merge/publication, automatic domain/DNS/account provisioning, automated edge-policy enforcement, image supply-chain attestation, tunnel HA, or proof that an unfamiliar reader can complete the form. Receipts acknowledge bounded intake only. Decisions, source application, and publication remain owner-controlled and separate.

## Tests

Run the package-local deterministic suite:

```bash
build-contained -- bun test deploy/account-free-intake/test
```

The structural and script tests require only Bun, Git, and `flock`. They validate the image allowlist, pinned runtime, fixed staging contract, off-by-default Compose profiles, base internal-only/no-port topology, explicit public egress, exact proxy CIDR, file-only secrets, digest startup refusal, read-only mounts, dedicated queue storage, non-root and capability policy, health request, and explicit exclusion list. When the Docker Compose CLI is available, an additional `compose config` check verifies the actual merged profile without contacting the Docker daemon, starting a container, or pulling an image. The public example goes through the app config loader using synthetic temporary paths; that check is explicitly skipped only when the server's public config keys are not yet present.

The container runtime acceptance is opt-in because it builds and runs a local image:

```bash
image_id="$(docker image inspect --format '{{.Id}}' cyberbaser-account-free-intake:local)"
ACCOUNT_FREE_INTAKE_CONTAINER_IMAGE="$image_id" \
  bun test deploy/account-free-intake/test/runtime-acceptance.test.js
```

That acceptance creates only temporary local Git objects, retained bindings, an internal Docker network, a named queue volume, and one container. It verifies image metadata, mount access, network isolation, internal health, one real anonymous enqueue, durable queue artifacts, unchanged read-only inputs, and cleanup. It does not contact a forge, fetch evidence, expose a host port, start a reverse proxy, install a service, publish an image, write source, make an owner decision, or publish content.

If Docker is unavailable or `ACCOUNT_FREE_INTAKE_CONTAINER_IMAGE` is unset, the image acceptance test is reported as skipped rather than silently claiming runtime evidence.

The read-only `.github/workflows/account-free-intake-container.yml` builds a local image, resolves its immutable image ID, and supplies that ID to the runtime acceptance test. It has no registry login/push, artifact publication, deployment, secret, or repository-write step.

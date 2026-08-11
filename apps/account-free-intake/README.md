# Account-free intake app

A small Bun runtime for WP4 Lane B. It accepts one anonymous correction intent, resolves the exact retained publication binding and historical Markdown blob, derives a canonical `@cyberbaser/proposal`, and durably enqueues it for full owner review.

This app is optional and refuses to start unless `enabled` is literal `true`. It is not deployed by this repository. It performs no source write, checkout, ref update, commit, push, evidence fetch, identity verification, owner decision, merge, or publication action. It does not import owner-alpha and it does not close Q09.

## Boundary

- `POST /v1/corrections` accepts only `application/json` from an exact configured HTTPS `Origin` and exact public `Host`.
- `OPTIONS /v1/corrections` permits only `POST` and `Content-Type`. It never enables credentialed CORS.
- `GET /healthz` requires the exact `127.0.0.1:<port>` Host, an actual loopback socket peer, no Origin, no credentials, no body, and no query.
- `Authorization`, `Proxy-Authorization`, and `Cookie` are rejected. `Forwarded` and `X-Forwarded-*` are never authority inputs.
- The body ceiling is exactly 98,304 bytes. The complete body, binding resolution, local Git object inspection, derivation, and replay probe share one five-second deadline. Git is cancelled through the core resolver's injected executor seam.
- Abuse control is global rather than IP-derived: a 20-token process-wide bucket refills at one token per second, with at most four active submissions. This remains an origin control, not a substitute for edge DDoS protection.
- Success returns only a bounded queue receipt. Untrusted rationale, evidence, source bytes, repository paths, and raw idempotency keys are never reflected.

The process binds `0.0.0.0` for a later isolated-container deployment. Do not publish that listener directly. A separately configured reverse proxy must preserve the exact public Host and expose only `/v1/corrections`; it must not expose `/healthz`. TLS and edge abuse controls are outside this app.

## Configuration

Copy `account-free-intake.example.json` and replace every example origin, repository, and absolute path. The schema is exact: unknown fields fail closed, credentialed/non-HTTPS URLs fail, paths must be normalized and symlink-free, and the fixed HTTP abuse limits cannot be weakened through configuration.

The configured bare Git directory and retained binding directory are read-only inputs. The proposal queue is the only durable write location. The queue root must be private and must not be shared by a simultaneously running second process.

## Run

```bash
bun install --cwd apps/account-free-intake --frozen-lockfile
bun apps/account-free-intake/bin/server.js --config /absolute/account-free-intake.json
```

Startup validates the input paths, performs proposal-queue recovery and retention, acquires the queue's kernel lock, and only then starts the Bun listener. `SIGINT` and `SIGTERM` stop the listener and release the queue lock.

## Read-only review commands

The CLI exposes no accept, reject, apply, write, or publication operation:

```bash
bun apps/account-free-intake/bin/review.js --config /absolute/account-free-intake.json list
bun apps/account-free-intake/bin/review.js --config /absolute/account-free-intake.json list --state expired --format html
bun apps/account-free-intake/bin/review.js --config /absolute/account-free-intake.json show Q-00000000-0000-4000-8000-000000000000
bun apps/account-free-intake/bin/review.js --config /absolute/account-free-intake.json show Q-00000000-0000-4000-8000-000000000000 --format html
```

Text output escapes terminal control characters. HTML is a complete static document with escaped untrusted content, inline CSS, no scripts, no external assets, and a deny-by-default CSP.

The review CLI must run while the server is stopped because its shared inspection lock conflicts with the server's lifetime exclusive queue lock. It opens only an already initialized queue, verifies every retained proposal against exact source/policy evidence, and performs no recovery, expiration, purge, state replacement, temporary cleanup, or other filesystem mutation. If staging or an acknowledged location requires recovery, inspection fails closed and the normal service startup must recover it before review. The commands expose no lifecycle mutation or owner decision.

## Test

```bash
bun test apps/account-free-intake/test
```

The app-local suite covers strict credential-free configuration, exact Host/Origin/CORS behavior, loopback-only health, forbidden credentials, fixed body bounds, total request deadlines, global token/concurrency limits, forwarded-header non-authority, durable enqueue/recovery/idempotency, anonymous full-review routing, bounded public receipts, Bun HTTP serving, and safe text/static-HTML review rendering.

`.github/workflows/account-free-intake.yml` runs the proposal queue, derivation, app, and disabled renderer checks. `.github/workflows/account-free-intake-container.yml` runs deployment structure, a local image build, and isolated container acceptance. Both have only `contents: read`, credential-free checkout, immutable action pins, no secrets, and no repository or publication action.

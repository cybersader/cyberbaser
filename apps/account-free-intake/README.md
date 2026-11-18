# Account-free intake app

A small Bun runtime for WP4 Lane B. It accepts one anonymous correction or single-file multi-operation suggestion intent, resolves the exact retained publication binding and historical Markdown blob, derives a canonical `@cyberbaser/proposal`, and durably enqueues it for full owner review.

This app is optional and refuses to start unless `enabled` is literal `true`. It is not deployed by this repository. It performs no source write, checkout, ref update, commit, push, evidence fetch, identity verification, owner decision, merge, or publication action. It does not import owner-alpha and it does not close Q09.

## Boundary

- `POST /v1/corrections` and `POST /v2/suggestions` accept only `application/json` from an exact configured HTTPS `Origin` and exact public `Host`.
- `OPTIONS` on either endpoint permits only `POST` and `Content-Type`, plus `Cyberbaser-Challenge-Token` only when bot checking is enabled. It never enables credentialed CORS.
- `GET /healthz` requires the exact `127.0.0.1:<port>` Host, an actual loopback socket peer, no Origin, no credentials, no body, and no query.
- `Authorization`, `Proxy-Authorization`, and `Cookie` are rejected. Forwarded headers never control Host, Origin, health authorization, or CORS. One explicitly configured address header (for example `cf-connecting-ip` or `x-real-ip`) can supply only the abuse-control address, and only behind an explicitly trusted TCP peer.
- The v1 body ceiling is exactly 98,304 bytes; the separate v2 endpoint has a fixed 262,144-byte ceiling. The complete body, optional bot verification, binding resolution, local Git object inspection, derivation, and replay probe share one five-second deadline. Git is cancelled through the core resolver's injected executor seam.
- Abuse control combines a 20-token global bucket (one token per second), at most four active submissions, and bounded sender, network, and page buckets. Optional Turnstile verification gates the queue and source resolver. These are application controls, not substitutes for edge DDoS protection.
- Success returns only a bounded queue receipt. Untrusted rationale, evidence, source bytes, repository paths, and raw idempotency keys are never reflected.

For a public HTTPS origin the process binds `0.0.0.0` for a later isolated-container deployment. Do not publish that listener directly. For the owner's own private site, `publicOrigin` may be one exact private numeric IPv4 HTTP origin with an explicit port, and `listen` then binds exactly that address; the owner app derives and writes that config and runs this process beside itself. A separately configured reverse proxy must preserve the exact public Host and expose only the explicitly enabled public submission paths (`/v1/corrections` and, for suggesting mode, `/v2/suggestions`); it must not expose `/healthz`. TLS and edge abuse controls are outside this app.

## Suggesting-mode submission (v2)

`POST /v2/suggestions` is deliberately separate from `/v1/corrections`. Each endpoint rejects the other intent version. Send ordinary JSON with this strict shape (property order is not significant at the HTTP boundary):

```json
{
  "schemaVersion": 2,
  "artifactType": "cyberbaser-account-free-correction-intent",
  "bindingDigest": "sha-256=:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=:",
  "pageId": "page-v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "operations": [
    { "operationId": "edit-1", "start": 12, "end": 15, "expected": "teh", "replacement": "the" },
    { "operationId": "edit-2", "start": 28, "end": 28, "expected": "", "replacement": "also " }
  ],
  "rationale": "Two corrections on this page.",
  "evidence": [],
  "idempotencyKey": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
}
```

`rationale` and `evidence` may be omitted. Rationale also accepts null; the receiver uses the neutral artifact rationale `Suggested edits.` when it is absent/null because the existing proposal submission contract requires nonblank text. Evidence defaults to `[]` and accepts at most eight distinct canonical HTTPS URLs. `idempotencyKey` is required and is either null or 32–128 base64url characters. Every other field is required; unknown fields at either level fail closed. No client source path, repository, revision, candidate file, author, trust route or whole-file HTML is accepted.

Operations are the ledger's exact `{operationId,start,end,expected,replacement}` records, with UTF-8 byte offsets into the retained base, not JavaScript string indices or progressively edited offsets. The array must contain 1–50 uniquely identified operations sorted by distinct start offsets, without overlap. Insertions have equal start/end and empty expected text. Each span is at most 16 KiB and aggregate expected plus replacement bytes are at most 64 KiB. The proposal core also refuses stale/mismatched expected slices, split UTF-8 code points, split CRLF pairs, no-ops, whole-file removal coverage, and oversized base/candidate files. It retains untouched bytes by construction.

The service resolves the same retained publication binding, exact historical blob and base trust policy as v1. It creates one atomic v2 proposal and classifies the **combined before/after file**, not each operation separately, using the shared proposal trust bridge and existing OFM/trust rules. Identity remains null; the route must remain anonymous full-review (or unknown/full-review for an unusable policy). The challenge header, trusted client-address source, CORS, five-second deadline, receipt fields, queue capacity, expiry and replay semantics are unchanged. Expected-byte mismatches return 422; structural intent/proposal failures return 400; work-limit failures return 429. Replays are charged before lookup and return the original receipt without deriving a new proposal.

### Private review IPC compatibility

The private IPC request/envelope schema remains `schemaVersion: 1`. Both list summaries and load entries now include `proposalVersion: 1 | 2`; the loaded `proposalText` remains the exact canonical stored artifact, including its final LF, never a v1 projection or regenerated candidate. The shared proposal-review contract validates that the version matches the parsed artifact. All other v1 projection fields retain their meanings. Consumers must accept the added version field and dispatch from it; strict consumers need the matching proposal-review update. The CLI also lists both versions and shows every v2 operation separately.

## Configuration

Copy `account-free-intake.example.json` and replace every example origin, repository, and absolute path. The schema is exact: unknown fields fail closed, credentialed/non-HTTPS URLs fail, paths must be normalized and symlink-free, and the fixed body/deadline/global/concurrency bounds cannot be weakened through configuration. The additional sender/network/page limits accept integers from 1 through 1,000,000. Existing configs without the new settings still load.

The configured bare Git directory and retained binding directory are read-only inputs. The proposal queue is the only durable write location. The queue root must be private and must not be shared by a simultaneously running second process.

## Public abuse protections

The example keeps bot verification off (`"botCheck": null`) and derives the client address from the socket (`"clientAddress": { "source": "socket" }`). To enable Turnstile, add this exact block to the operator's config:

```json
{
  "botCheck": {
    "provider": "turnstile",
    "secretFile": "/run/secrets/turnstile",
    "expectedHostnames": ["wiki.example"],
    "expectedAction": "suggest-correction",
    "timeoutMs": 3000
  }
}
```

The secret file must be a bounded (at most 4,096 bytes), regular, singly linked file at a normalized absolute, symlink-free path. Keep it owner-readable only (for example mode 0600), mount it read-only, and never place it in source control. It is read once at service startup, held only in the verifier closure, and requires a restart to rotate. Startup fails if the configured secret cannot be read safely. Hostnames are the exact frontend hostnames returned by Turnstile, without schemes or ports; do not include local/test hostnames in a production allowlist.

The browser sends a fresh token in `Cyberbaser-Challenge-Token`, outside the intent JSON. After method/Host/Origin/content-type/body checks and sender/network limits, the service posts the secret, token, and available client IP to Cloudflare's fixed HTTPS siteverify endpoint. It requires literal `success: true`, an exact allowed hostname, and action `suggest-correction`. Missing or rejected tokens return 403 `challenge-failed`; upstream network, HTTP, JSON, or timeout failures return 503 `challenge-unavailable`. The three-second verification budget is bounded by the remaining shared five-second deadline. There is no retry or bypass. Tokens, secrets, and raw IPs are never placed in proposals, queue entries, public responses, or application logs. The configured client IP is disclosed to Cloudflare as `remoteip` during verification.

If a trusted reverse proxy supplies `cf-connecting-ip`, opt in explicitly:

```json
{
  "clientAddress": {
    "source": "header",
    "header": "cf-connecting-ip",
    "trustedPeers": ["10.20.0.2/32", "2001:db8:1234::2/128"]
  }
}
```

The `header` value accepts any single lowercase HTTP header token, for example `x-real-ip`; `source: "header"` remains the backward-compatible alias for `source: "trusted-header"`. A configured `x-forwarded-for` still accepts only one numeric IP, never a forwarded chain.

Use only the actual proxy's socket CIDRs, not arbitrary client ranges. Prevent direct bypass of the proxy; the proxy must replace, not preserve, visitor-supplied address headers. Only a peer inside `trustedPeers` can supply that header. Missing, comma-separated, zoned, port-bearing, or otherwise malformed values fall back to the socket address. No forwarded header changes Host, Origin, health authorization, or CORS authority. IPv4-mapped socket addresses normalize to IPv4 for quotas; both their IPv4 and mapped IPv6 trusted CIDRs are supported. Missing/invalid socket addresses share one fail-closed `unknown` quota and omit Turnstile's optional `remoteip`.

### Layered quotas and retention

| Limit | Default capacity | Refill |
| --- | --- | --- |
| Sender (`perSenderCapacity`, `perSenderRefillPerHour`) | 3 | 3/hour |
| Network (`perNetworkCapacity`, `perNetworkRefillPerDay`) | 10 | 10/day |
| Opaque page ID (`perPageCapacity`, `perPageRefillPerDay`) | 2 | 2/day |
| Sender operation units (`perSenderOperationBudget`) | 50 | 50/hour |
| Sender expected + replacement UTF-8 bytes (`perSenderByteBudget`) | 65,536 | 65,536/hour |

Network identities use IPv4 /24 or IPv6 /64. Alternate IPv6 spellings and mapped IPv4 addresses share the same canonical sender identity. Senders and networks are keyed by HMAC-SHA256 with a random per-process salt; no raw address is retained in the maps. Page IDs are HMAC-keyed too. Each of the five in-memory maps (three attempt scopes plus two lazily created work scopes) retains at most **10,000 keys**, evicting the oldest inserted key before adding another. Eviction forgets that key's quota; restart resets all quotas and the salt. These limits are local to one service process, not a persistent or distributed abuse ledger.

Order is global admission, bounded body/intent validation, sender then network admission, optional bot verification, then page and weighted sender-work admission before any queue/source lookup. OPTIONS uses only the existing global bucket. Sender/network buckets count eligible parsed attempts even if bot verification later fails; a sender rejection does not charge the network bucket. Page and work buckets count every parsed, challenge-approved attempt that reaches them, including idempotent replays, rejected source/quote operations, queue-capacity failures, and other downstream failures. A v2 submission spends one sender/network/page attempt token, N operation units, and the sum of every expected/replacement UTF-8 byte length. A v1 submission spends one operation unit and its quote plus replacement byte lengths, sharing the same sender work budget. Work does not multiply queue occupancy: one proposal still occupies one entry. Work stores charge operations before bytes; a byte-budget refusal does not refund already charged operation units. Rejected requests do not refund consumed tokens. A quota rejection returns 429 `rate-limited` with the existing `Retry-After: 1` hint; that hint is not the time until a sender/network/page token refills.

The durable queue's existing pending-entry, per-source, and retained-byte capacity limits remain the inbox circuit breaker. A full queue returns 503 `queue-capacity`; bot verification and rate limits do not replace or weaken that cap.

## Adding a provider

Backend controls use small app-local contracts. Provider modules are reviewed code, not runtime plugins: configuration selects only a frozen registry entry, never a script path or arbitrary verification URL. Turnstile is the first challenge provider, not the challenge interface. Each contribution should include its module, registry entry where selection exists, synthetic harness, and a test file invoking the shared suite. No live account, network, or real secret is needed to prove conformance.

### Challenge provider

1. Add `src/challenge/providers/<id>.js`, exporting a frozen object with this contract:

   ```js
   {
     id,
     validateOptions(input), // frozen cloned options, or throw with code 'invalid-config'
     async create(options, deps) {
       return {
         async verify({ token, clientAddress, signal }) {
           return { outcome: 'pass' }; // exactly 'pass', 'fail', or 'unavailable'
         },
       };
     },
   }
   ```

2. Register the module under its exact `id` in `src/challenge/registry.js`. Config stays `botCheck: { provider: '<id>', ...providerOptions }`; the core removes `provider` and passes every remaining key to `validateOptions`. Reject unknown/missing fields, copy and deeply freeze option arrays/objects, and throw `IntakeConfigError('invalid-config', safeMessage)` (or use helpers from `src/control-config.js`). Do not include secret values or filesystem diagnostics in errors.
3. Put vendor endpoints, request/response formats, hostname/action binding rules, and option validation only in that module. `deps` supplies injectable `fetch` and shared `readSecretFile(path)`. Load secrets at startup into the private verifier closure, never into returned options, results, queues, responses, or logs. `clientAddress` is a canonical parsed IP record with `.address`, or `null`; do not derive it from request headers yourself. Honor the supplied `AbortSignal` and do not retry.
4. Add `test/harnesses/<id>.js` with `options`, nonempty `invalidOptions`, `malformedOutcome` (`'fail'` or `'unavailable'`), and `transport(scenario)` for `pass`, `fail`, `malformed`, `slow`, and `throw`. Each transport returns `{ deps: { fetch, readSecretFile }, calls, signal() }`. Its slow transport deliberately never settles even after abort. See the Turnstile harness for the complete runnable shape.
5. Add one `test/<id>-provider.test.js` importing the module and harness and calling `challengeProviderConformance(provider, harness)` from `test/conformance/challenge-provider.js`. Add vendor-specific response/binding tests where needed. Submit the module, registry entry, harness, and test together.

Core `src/bot-check.js` owns `Cyberbaser-Challenge-Token` extraction (1–2,048 characters, no whitespace or comma), the maximum three-second verification budget and enclosing request deadline, cancellation, and public error mapping. CORS advertisement remains in core `src/server.js`. A provider may omit `timeoutMs`; if present, core caps it at three seconds and the remaining deadline. The legacy Turnstile config still requires exactly `timeoutMs: 3000` and `expectedAction: 'suggest-correction'`.

Only an exact single-own-data-field `{ outcome: 'pass' }` result passes. Explicit `outcome: 'fail'` means 403 `challenge-failed`. Throws (even a forged `ChallengeError`), aborts, timeouts, unknown outcomes, inherited/accessor outcomes, and malformed or extra-field pass results mean 503 `challenge-unavailable`. Invalid/missing tokens remain 403 before invoking the provider. Turnstile's well-formed JSON with failed/missing binding fields remains an explicit provider failure (403); HTTP, JSON parsing, and network failures remain unavailable (503). Shared conformance covers both provider transport behavior and core fail-closed enforcement.

### Client-address source

1. Add `src/client-address/sources/<id>.js` exporting a frozen `{ id, validateOptions(input), create(options) }`. Validation returns deeply frozen cloned options or throws `invalid-config`. `create` returns a synchronous `(request, socketPeer) => numericIpStringOrNull` resolver. It must not mutate inputs. Use the shared numeric parsing/CIDR helpers in `src/client-address/ip.js` rather than implementing an alternate IP identity format.
2. Register it under its `id` in `src/client-address/registry.js`; config is `{ source: '<id>', ...sourceOptions }`. The existing `header` alias continues to select `trusted-header` without changing existing config output. All header-derived identities must remain gated by the actual trusted socket peer, with malformed/missing values falling back to that socket. Source selection never grants authority over Host, Origin, health authorization, or CORS.
3. Add a synthetic harness with `options`, `invalidOptions`, and `cases: [{ headers, peer, address }]`, then call `clientAddressSourceConformance(source, harness)` from `test/conformance/client-address-source.js` in a test file. Include untrusted-peer, missing-peer, malformed-address, and canonicalization cases. Core re-parses every source result before challenge verification and HMAC keying.

### Limit store

The synchronous store contract is `{ take(key, { capacity, refillPerMs, cost = 1 }, nowMs) -> boolean }`. `key` is an opaque scope-separated HMAC, never an IP or page ID. Core owns normalization, the private process salt, HMAC keying, policies, clock injection, admission order, and independent attempt/work stores. `cost` is an optional positive integer in the same units as capacity/refill; omitting it preserves the original one-token call. An insufficient balance refuses the whole charge without partially deducting that charge. Only literal `true` grants admission.

1. Add a module exporting `createStore({ maxKeys })`. Implement bounded retained memory, fractional refill capped at capacity, independent keys, and no refill credit from clock regression. The existing default `src/limit-store/in-memory.js` uses FIFO eviction and at most 10,000 keys per store; eviction forgets quota. Its diagnostic `size` getter exposes only a count, not keys.
2. Add a test file calling `limitStoreConformance('<id>', { createStore, size: store => retainedCount })` from `test/conformance/limit-store.js`. `size` is harness instrumentation, not a required runtime method. The suite checks capacity, weighted atomic charges, refill in work units, clock regression, key/store independence, bounded memory, and FIFO eviction.
3. Use the programmatic `createLayeredAbuseLimiter({ limits, createStore })` seam for evaluation. There is deliberately no operator config key or registry for stores while only one implementation exists. A future selectable store needs an explicit registry/config decision; an asynchronous or distributed store needs a separate interface decision, not a Promise returned from `take`. The global token bucket/concurrency gate and durable queue circuit breakers remain separate controls.

Run `build-contained -- bun test apps/account-free-intake/test` and `build-contained -- bun test deploy/account-free-intake/test` before submitting a provider PR. The latter protects deployment-config compatibility without deploying anything.

## Run

```bash
bun install --cwd apps/account-free-intake --frozen-lockfile
bun apps/account-free-intake/bin/server.js --config /absolute/account-free-intake.json
```

Startup validates the input paths, performs proposal-queue recovery and retention, acquires the queue's kernel lock, and only then starts the Bun listener. `SIGINT` and `SIGTERM` stop the listener and release the queue lock.

## Forge watcher

An optional `forgejo` block makes the same process watch one Forgejo repository for open pull requests and enqueue each new head as a Lane A entry through the queue's one writer. It is read-only towards the forge. When the block is enabled, the public form may be off: set `listen` and `publicOrigin` to `null` and `allowedFormOrigins` to `[]`. The watcher keeps a private clone at `forgejo.cloneDir`, retains the base commit of every entry it enqueued, and proves Lane A entries from that clone on recovery. `forgejo.tokenFile` names a mode-0600 file for a private repository; the token is read per request and never logged. A disabled block is `{ "enabled": false }`.

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

The app-local suite covers strict credential-free configuration, exact Host/Origin/CORS behavior, loopback-only health, forbidden credentials, fixed body bounds, total request deadlines, global token/concurrency limits, HMAC sender/network/page limits with clock-driven refill and bounded eviction, trusted proxy CIDRs and malformed-header fallback, optional fail-closed Turnstile verification with injected fetch, conditional CORS headers, secret non-disclosure, forwarded-header non-authority, durable enqueue/recovery/idempotency, anonymous full-review routing, bounded public receipts, Bun HTTP serving, and safe text/static-HTML review rendering.

`.github/workflows/account-free-intake.yml` runs the proposal queue, derivation, app, and disabled renderer checks. `.github/workflows/account-free-intake-container.yml` runs deployment structure, a local image build, and isolated container acceptance. Both have only `contents: read`, credential-free checkout, immutable action pins, no secrets, and no repository or publication action.

For compatibility checks against live worktree sources rather than cached `file:` installs, preload `apps/account-free-intake/test/live-package-preload.js` (through `BUN_OPTIONS` or `bun test --preload`) when running the intake and queue suites. This loader changes test resolution only, not runtime package routing.

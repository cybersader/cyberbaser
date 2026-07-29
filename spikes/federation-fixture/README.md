# Five-origin federation fixture

A bounded falsification spike for Cyberbaser's publication-based federation architecture. It asks whether independently built static publications can be discovered from chosen seeds, preserve source-qualified disagreement, rebuild disposable views, and keep direct owner navigation when optional federation services disappear.

This directory is a **standalone private Bun project**. It is not a production package, protocol release, URL standard, registry, global identity or trust system, remote write endpoint, or interoperability claim. The fixture uses controlled producers and consumers in one repository. Independent interoperability would require a separately operated implementation after this spike.

See the canonical research boundary in [the federation architecture page](../../docs/src/content/docs/research/federation.mdx) and the local integrity packages reused by the spike: [`@cyberbaser/publish`](../../packages/publish/), [`@cyberbaser/projection`](../../packages/projection/), [`@cyberbaser/linkcheck`](../../packages/linkcheck/), [`@cyberbaser/ofm`](../../packages/ofm/), and [`@cyberbaser/trust`](../../packages/trust/).

## Frozen fixture topology

The logical names and paths below are test data only. They do not settle Q06 or prescribe live publisher URLs.

| ID | Logical HTTPS origin | Role | Producer | Arbitrary descriptor path |
|---|---|---|---|---|
| `fungi` | `https://fungi.test` | subject base | publish/projection path | `/about/federation.json` |
| `forage` | `https://forage.test` | subject base | publish/projection path | `/publishing/base-description.json` |
| `toxins` | `https://toxins.test` | subject base | independently authored | `/policies/peer-publication.json` |
| `atlas` | `https://atlas.test` | meta-wiki | publish/projection path | `/collections/about-atlas.json` |
| `cautious` | `https://cautious.test` | competing meta-wiki | independently authored | `/index/this-base.json` |

There is no hosts-file edit and no actual TLS. Each logical origin is physically served by its own independently stoppable `Bun.serve()` instance on `http://127.0.0.1:<ephemeral-port>`, from its own temporary static root. A fixture-only injected transport maps the five exact logical origins to those loopback servers. The public HTTP transport remains structurally separate and has no private-network bypass.

## Shared contract

`src/contracts.js` freezes the minimum fixture profile:

- profile: `urn:cyberbaser:fixture:federation:2026-07-27`;
- clock: `2026-07-27T12:00:00.000Z` through an injected `FIXED_CLOCK`;
- deterministic JSON: recursively sorted object keys, preserved array order, two-space indentation, one trailing LF, and rejection of cycles or non-JSON values;
- digest: exact representation bytes encoded in [RFC 9530](https://www.rfc-editor.org/rfc/rfc9530.html)-style `sha-256=:<base64>:`;
- descriptor: `profile`, `publisher`, `homepage`, complete `inventory`, sorted `linksets`, inline rights/history `policies`, and sorted exercised `capabilities`;
- inventory: a complete sorted snapshot with `url`, exact `byteLength`, digest, `mediaType`, and rights summary for every served artifact **except the inventory document itself**. No other exclusion is permitted;
- Linkset: [RFC 9264](https://www.rfc-editor.org/rfc/rfc9264.html) `application/linkset+json` shape with `linkset` as the sole top-level member, absolute HTTPS anchors and targets, and source-qualification attributes for issuer, assertion ID, observation time, and source digest;
- assertion: issuer-owned assertion ID, subject, relation, target, rationale, and revision/digest evidence;
- cache record: publisher, issuer, assertion ID, fetched logical URL, discovery chain, source digest, observation state, rights, raw artifact provenance, and the source-qualified assertion;
- cache keys include publisher/issuer/assertion/provenance. Equal endpoints alone never deduplicate Atlas and Cautious claims;
- observation states: `current`, `stale`, `unavailable`, and owner-qualified `deleted` (`410` required);
- crawl budgets: depth 4, origins 5, URLs 64, redirects 8, response 512 KiB, total 4 MiB, decompressed response 1 MiB, parser input 512 KiB, parser time 250 ms, wall time 5 s, concurrency 3.

Unknown relations and metadata are data, not executable extensions. The crawler follows only `DEFAULT_RELATION_ALLOWLIST`. No JSON-LD context, schema, script, key, image, or other attacker-selected resource is fetched because metadata names it.

## Contract exports

`src/contracts.js` exports:

- constants: `FIXTURE_PROFILE_URN`, `FIXED_NOW`, `FIXED_CLOCK`, `DIGEST_ALGORITHM`, `INVENTORY_RULE`, `RIGHTS_MODES`, `HISTORY_MODES`, `OBSERVATION_STATES`, `LINKSET_EVIDENCE`, `RELATIONS`, `DEFAULT_RELATION_ALLOWLIST`, `DEFAULT_CRAWL_BUDGETS`, `CRAWL_BUDGET_KEYS`, `ASSERTION_SHAPE`, `CACHE_RECORD_SHAPE`;
- deterministic data helpers: `deepFreeze`, `stableStringify`, `stableJsonBytes`;
- digest helpers: `sha256Digest`, `parseSha256Digest`, `verifySha256Digest`;
- validators: `validateDescriptor`, `validateInventory`, `validateLinkset`, `validateAssertion`, `validateCacheRecord`, `assertValid`, `ContractValidationError`;
- source-qualified identity helpers: `assertionKey`, `cacheRecordKey`;
- budget helper: `normalizeCrawlBudgets`.

`src/topology.js` exports:

- frozen topology: `FIXTURE_BASES`, `FIXTURE_ORIGINS`, `FIXTURE_DESCRIPTOR_PATHS`, `FIXTURE_BASE_BY_ID`, `FIXTURE_BASE_BY_ORIGIN`;
- URL/path helpers: `assertFixturePath`, `logicalUrl`, `fixtureUrls`, `isFixtureLogicalUrl`;
- construction helpers: `createFixtureTopology`, `assertCompleteFixtureTopology`.

`createFixtureTopology()` only constructs data. It does not start servers or read roots. Physical bindings must be `http://127.0.0.1:<port>` and are exposed only in the returned `logicalToPhysical` table for the injected fixture transport.

## Implemented fixture lanes

### Two producer paths

- `src/producer-projection.js` builds Fungi, Forage, and Atlas through `@cyberbaser/publish` selection, byte-identical `@cyberbaser/projection`, reference extraction, minimal fixture rendering, and same-origin `@cyberbaser/linkcheck` checks.
- `src/producer-authored.js` independently builds Toxins and Cautious from public-only authored trees. It does not import the projection producer, publish/projection packages, or Producer A's serializer.
- Both paths write only to temporary build roots and are consumed by the shared descriptor, inventory, and Linkset validators.

### Independent serving and bounded discovery

- `src/server.js` starts five separately stoppable loopback servers, one static root per publisher. It permits only GET/HEAD and rejects decoded, encoded, double-encoded, backslash, NUL, and escaping-symlink paths.
- `FixtureTransport` accepts only the five exact logical HTTPS origins and uses only the injected loopback map.
- `PublicHttpTransport` is a separate HTTPS-only policy with injected DNS and address-pinning request functions. It blocks private/reserved IPv4, IPv6, and hostnames, strips ambient credentials, and revalidates redirects before dispatch.
- `src/crawler.js` starts from caller-selected seeds, follows only the explicit relation allowlist plus frozen descriptor structure, verifies source bytes, terminates cycles through visited URLs and declared budgets, and reports every budget.
- `src/cache.js` provides a deletable deterministic JSON cache. Observation refresh treats only an HTTP 410 from the exact owner URL as deletion; changed bytes are stale and outages are unavailable.

### Policy behavior

- `src/rights.js` permits only verified licensed reuse. Atlas owns its mirror, while Fungi retains authority over the source. Toxins remains metadata-only and link-only.
- `src/search.js` exposes two pure providers over the same direct-owner identity corpus. Provider switching changes ranking and visibly reports policy, but does not change identities or direct URLs.
- `src/proposal.js` checks receiver-owned URL, exact byte length, and digest before applying ordered Buffer splices or invoking receiver-owned OFM and trust policy. There is no rebase path.

### Destructive and security tests

`test/destructive.test.js` and `test/security.test.js` use fresh temporary topologies to cover direct-link survival, deterministic cache rebuild, source-qualified disagreement, inventory recovery, 410 deletion versus stale/unavailable observations, rights behavior, recursive budget termination, search-provider switching, stale exact-byte rejection, all 55 private canaries, fixture-origin isolation, SSRF policy through injected fakes, and traversal-safe serving.

## Run

```bash
cd spikes/federation-fixture
bun install --frozen-lockfile
bun test
bun run verify
```

`bun run verify` is the authoritative bounded verifier. It builds all five publications in temporary directories, starts and stops all five origins, crawls all origins, deletes and rebuilds the cache, exercises deletion and stale-proposal behavior, scans private canaries, and prints deterministic JSON. It exits zero only when `complete` is `true`; cleanup runs in `finally` paths.

The current controlled fixture result is five origins, 31 visited logical URLs, 14 source-qualified cache records, two conflicting mappings, two visibly different search-provider rankings, a byte-identical cache rebuild, 55 private canaries with zero hits, an owner-qualified 410 deletion, and stale proposal rejection before apply/OFM/trust. These are fixture measurements, not an external interoperability result.

CI is defined in [`.github/workflows/federation-fixture.yml`](../../.github/workflows/federation-fixture.yml). It has read-only repository permissions, is path-filtered to this spike, its five local package dependencies, and its workflow, and uses no service container or external federation fixture.

## Deliberate omissions

No production federation package, root workspace migration, live-corpus enrollment, global registry or resolver, global identity or trust, actual TLS, hosts-file change, external service, Webmention/WebSub/ActivityPub/relay/DHT substrate, durable Change List, remote write endpoint, JSON-LD context fetching, SQLite/RDF/graph database, Playwright, or rich Markdown renderer belongs in this spike.

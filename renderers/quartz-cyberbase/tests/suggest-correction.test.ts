import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  ACCOUNT_FREE_INTAKE_PATH,
  computePageId,
  resolveIntakeOrigin,
  resolveSuggestCorrectionOptions,
  suggestionBindingForPage,
} from "../components/suggestCorrectionConfig"
import {
  buildCorrectionIntent,
  idempotencyKeyFromBytes,
  intentFingerprint,
  errorCodeFromResponse,
  parseEvidenceUrls,
  parseRetryState,
  readBoundedJsonResponse,
  retryIdempotencyKey,
  serializeCorrectionIntent,
  submitCorrectionIntent,
} from "../components/suggestCorrectionClient"

const repository = "https://forge.example:8443/owner/wiki.git"
const revision = "1111111111111111111111111111111111111111"
const bindingDigest = "sha-256=:dnsUaEW9sPCjZ7UCItxthnrYHexoGDDHGauNk5ois8w=:"
const expectedPageId = "page-v1:G2diQT1Iqo71iP-aXy2oZu2xRMGkUMgIS_OJ_QVe9KY"
const intakeOrigin = "https://intake.example:8443"

// Golden vector copied from @cyberbaser/account-free-intake/source-binding.test.js.
assert.equal(computePageId({ repository, revision, path: "docs/first.md" }), expectedPageId)
assert.notEqual(computePageId({ repository, revision, path: "docs/other.md" }), expectedPageId)
assert.throws(() => computePageId({ repository, revision: "bad\ud800revision", path: "docs/first.md" }), /SOURCE_REVISION/)
assert.throws(() => computePageId({ repository, revision, path: "docs/bad\ud800.md" }), /source path/)
assert.throws(() => computePageId({ repository: `https://forge.example/${"a".repeat(2048)}.git`, revision, path: "docs/first.md" }), /bounded/)

const disabled = resolveSuggestCorrectionOptions({
  enabled: undefined,
  intakeOrigin: undefined,
  bindingDigest: undefined,
  sourceRepository: undefined,
  sourceRevision: undefined,
})
assert.deepEqual(disabled, { enabled: false })
assert.equal(suggestionBindingForPage("docs/first.md", "docs/first", disabled), null)

const enabled = resolveSuggestCorrectionOptions({
  enabled: "enabled",
  intakeOrigin,
  bindingDigest,
  sourceRepository: repository,
  sourceRevision: revision,
})
assert.deepEqual(suggestionBindingForPage("docs/first.md", "docs/first", enabled), {
  action: `${intakeOrigin}${ACCOUNT_FREE_INTAKE_PATH}`,
  bindingDigest,
  pageId: expectedPageId,
})
for (const [path, slug] of [
  [undefined, "folder"],
  ["tags.md", "tags"],
  ["topic.md", "tags/topic"],
] as const) {
  assert.equal(suggestionBindingForPage(path, slug, enabled), null)
}
assert.throws(() => resolveSuggestCorrectionOptions({
  enabled: "true",
  intakeOrigin,
  bindingDigest,
  sourceRepository: repository,
  sourceRevision: revision,
}), /CYBERBASER_ACCOUNT_FREE_INTAKE/)
for (const origin of [
  undefined,
  "",
  "http://intake.example",
  "https://user@intake.example",
  "https://intake.example/path",
  "https://intake.example/",
  "https://INTAKE.example",
  "https://intake.example:443",
  "http://8.8.8.8:4319",
  "http://127.0.0.1",
  "http://wiki.internal:4319",
  "http://127.0.0.1:4319/",
]) {
  assert.throws(() => resolveIntakeOrigin(origin), /INTAKE_ORIGIN/)
}
assert.equal(resolveIntakeOrigin(intakeOrigin), intakeOrigin)
// The owner's private local site posts to the intake the owner app runs beside it.
assert.equal(resolveIntakeOrigin("http://127.0.0.1:4319"), "http://127.0.0.1:4319")
assert.equal(resolveIntakeOrigin("http://100.100.100.100:4319"), "http://100.100.100.100:4319")
assert.deepEqual(suggestionBindingForPage("docs/first.md", "docs/first", {
  enabled: true,
  intakeOrigin: "http://127.0.0.1:4319",
  bindingDigest,
  sourceRepository: repository,
  sourceRevision: revision,
}), {
  action: `http://127.0.0.1:4319${ACCOUNT_FREE_INTAKE_PATH}`,
  bindingDigest,
  pageId: expectedPageId,
})

const entropy = Uint8Array.from({ length: 32 }, (_, index) => index)
const idempotencyKey = idempotencyKeyFromBytes(entropy)
assert.equal(idempotencyKey, "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8")
const baseInput = {
  bindingDigest,
  pageId: expectedPageId,
  quote: "teh",
  prefix: "Correct ",
  suffix: " typo.",
  replacement: "the",
  rationale: "Correct the misspelling without changing meaning.",
  evidenceText: "https://example.invalid/reference",
}
const fingerprint = intentFingerprint(baseInput)
const stored = { fingerprint, idempotencyKey }
assert.equal(retryIdempotencyKey(fingerprint, stored, Uint8Array.from({ length: 32 }, () => 255)), idempotencyKey)
assert.notEqual(
  retryIdempotencyKey(intentFingerprint({ ...baseInput, replacement: "other" }), stored, Uint8Array.from({ length: 32 }, () => 255)),
  idempotencyKey,
)
assert.deepEqual(parseRetryState(JSON.stringify(stored)), stored)
assert.equal(parseRetryState('{"fingerprint":"x","idempotencyKey":"short"}'), null)

const intent = buildCorrectionIntent({ ...baseInput, idempotencyKey })
assert.deepEqual(Object.keys(intent), [
  "schemaVersion",
  "artifactType",
  "bindingDigest",
  "pageId",
  "selection",
  "replacement",
  "rationale",
  "evidence",
  "idempotencyKey",
])
assert.deepEqual(Object.keys(intent.selection), ["quote", "prefix", "suffix"])
assert.equal(intent.schemaVersion, 1)
assert.equal(intent.artifactType, "cyberbaser-account-free-correction-intent")
assert.equal(intent.idempotencyKey, idempotencyKey)
const text = serializeCorrectionIntent(intent)
assert.equal(text, `${JSON.stringify(intent)}\n`)
assert.ok(text.endsWith("\n"))
assert.ok(!text.endsWith("\n\n"))

// The browser request is the strict public intent only. Authority, source,
// owner-local routing, identity, contact, and account fields cannot enter it.
const forbiddenKeys = [
  "repository",
  "revision",
  "path",
  "sourcePath",
  "sourceRevision",
  "ownerOrigin",
  "identity",
  "identityClaim",
  "contact",
  "email",
  "account",
]
function collectKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      keys.add(key)
      collectKeys(nested, keys)
    }
  }
  return keys
}
const requestKeys = collectKeys(intent)
for (const key of forbiddenKeys) assert.equal(requestKeys.has(key), false, key)
assert.equal(text.includes("127.0.0.1"), false)
assert.equal(text.includes("docs/first.md"), false)
assert.equal(text.includes(revision), false)

assert.deepEqual(parseEvidenceUrls("https://example.invalid/a\n\nhttps://example.invalid/b"), [
  "https://example.invalid/a",
  "https://example.invalid/b",
])
for (const evidenceText of [
  "http://example.invalid/",
  "https://user:secret@example.invalid/",
  "https://example.invalid/a\nhttps://example.invalid/a",
]) {
  assert.throws(() => buildCorrectionIntent({ ...baseInput, evidenceText, idempotencyKey }))
}
assert.throws(() => buildCorrectionIntent({ ...baseInput, quote: "", idempotencyKey }), /selected text/)
assert.throws(() => buildCorrectionIntent({ ...baseInput, rationale: "   ", idempotencyKey }), /rationale/)
assert.throws(() => buildCorrectionIntent({ ...baseInput, quote: "🙂".repeat(4097), idempotencyKey }), /16384 UTF-8 bytes/)

// Explicit opt-in fails closed when any retained-publication input is absent.
for (const missing of ["intakeOrigin", "bindingDigest", "sourceRepository", "sourceRevision"] as const) {
  const environment = {
    enabled: "enabled",
    intakeOrigin,
    bindingDigest,
    sourceRepository: repository,
    sourceRevision: revision,
  }
  environment[missing] = undefined as never
  assert.throws(() => resolveSuggestCorrectionOptions(environment), /required/)
}

// Published provenance identity is permitted only from the opt-in provenance state.
// Repository/revision/owner/private account values must still never reach the form.
const componentSource = readFileSync(join(import.meta.dir, "../components/SuggestCorrection.tsx"), "utf8")
assert.doesNotMatch(componentSource, /data-(?:repository|revision|path|owner|identity|contact|account)/iu)
assert.match(componentSource, /sourceProvenance\?\.source \? \{/u)
assert.match(componentSource, /"data-source-identity": JSON.stringify\(\(fileData as any\).sourceProvenance.source\)/u)
const formNames = [...componentSource.matchAll(/name="([^"]+)"/gu)].map((match) => match[1])
assert.deepEqual(formNames, ["edited", "rationale", "evidence"])
assert.doesNotMatch(componentSource, /Text to replace|Context immediately (?:before|after)/u)

const acceptedCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
const acceptedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  acceptedCalls.push({ input, init })
  return new Response(JSON.stringify({ receipt: { state: "pending-review", queueId: "Q-test" } }), {
    status: 202,
    headers: { "content-type": "application/json" },
  })
}) as typeof fetch
const accepted = await submitCorrectionIntent(`${intakeOrigin}${ACCOUNT_FREE_INTAKE_PATH}`, intent, acceptedFetch)
assert.deepEqual(accepted, {
  accepted: true,
  replayed: false,
  message: "Thanks — sent for review. Receipt Q-test. The page stays unchanged until the owner applies the edit.",
})
assert.equal(acceptedCalls.length, 1)
assert.equal(String(acceptedCalls[0].input), `${intakeOrigin}/v1/corrections`)
assert.equal(acceptedCalls[0].init?.method, "POST")
assert.equal(acceptedCalls[0].init?.credentials, "omit")
assert.equal(acceptedCalls[0].init?.redirect, "error")
assert.equal(acceptedCalls[0].init?.referrerPolicy, "no-referrer")
assert.equal(acceptedCalls[0].init?.body, text)
assert.deepEqual(acceptedCalls[0].init?.headers, {
  Accept: "application/json",
  "Content-Type": "application/json",
})

const replayed = await submitCorrectionIntent(`${intakeOrigin}${ACCOUNT_FREE_INTAKE_PATH}`, intent, (async () =>
  new Response(JSON.stringify({ status: "pending-review", queueId: "Q-test" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as typeof fetch)
assert.equal(replayed.accepted, true)
assert.equal(replayed.replayed, true)
assert.match(replayed.message, /^Thanks — already sent for review\./u)

const rejected = await submitCorrectionIntent(`${intakeOrigin}${ACCOUNT_FREE_INTAKE_PATH}`, intent, (async () =>
  new Response(JSON.stringify({ error: { code: "queue-full", message: "must not be displayed" } }), {
    status: 429,
    headers: { "content-type": "application/json" },
  })) as typeof fetch)
assert.deepEqual(rejected, {
  accepted: false,
  replayed: false,
  message: "Submission failed (queue-full). Try again.",
})
assert.equal(rejected.message.includes("must not be displayed"), false)
assert.equal(errorCodeFromResponse({ error: { code: "invalid_request" } }), "invalid_request")
assert.equal(errorCodeFromResponse({ error: { code: "<b>unsafe</b>" } }), null)

const notAccepted = await submitCorrectionIntent(`${intakeOrigin}${ACCOUNT_FREE_INTAKE_PATH}`, intent, (async () =>
  new Response("{}", { status: 201, headers: { "content-type": "application/json" } })) as typeof fetch)
assert.equal(notAccepted.accepted, false)

await assert.rejects(
  () => readBoundedJsonResponse(new Response("{}", {
    status: 200,
    headers: { "content-type": "application/json", "content-length": "20000" },
  })),
  /too large/,
)
assert.equal(await readBoundedJsonResponse(new Response("server text", {
  status: 500,
  headers: { "content-type": "text/plain" },
})), null)

// Challenge inputs are public and opt-in. An unused key cannot enable the form.
const challengeEnvironment = {
  enabled: "enabled", intakeOrigin, bindingDigest,
  sourceRepository: repository, sourceRevision: revision,
}
const challengeSiteKey = "0x4AAAAAAA-test_site-key"
assert.equal(resolveSuggestCorrectionOptions({ ...challengeEnvironment, challengeSiteKey }).enabled, true)
const challenged = resolveSuggestCorrectionOptions({ ...challengeEnvironment, challengeSiteKey })
assert.ok(challenged.enabled)
assert.equal(challenged.challengeSiteKey, challengeSiteKey)
// Omitting the provider keeps the previous options/output shape byte-compatible.
assert.deepEqual(challenged, { ...enabled, challengeSiteKey })
assert.deepEqual(resolveSuggestCorrectionOptions({
  ...challengeEnvironment, challengeSiteKey, challengeProvider: "turnstile",
}), challenged)
assert.deepEqual(resolveSuggestCorrectionOptions({
  ...challengeEnvironment, challengeProvider: "turnstile",
}), enabled)
for (const challengeProvider of ["", "missing", "Turnstile", "__proto__", "toString", "https://untrusted.example/sdk.js"]) {
  for (const key of [undefined, challengeSiteKey]) {
    assert.throws(() => resolveSuggestCorrectionOptions({
      ...challengeEnvironment, challengeSiteKey: key, challengeProvider,
    }), /CYBERBASER_SUGGESTION_CHALLENGE_PROVIDER/)
  }
}
assert.deepEqual(resolveSuggestCorrectionOptions({
  ...challengeEnvironment, enabled: undefined, challengeProvider: "unused-provider",
}), { enabled: false })
assert.ok(enabled.enabled)
assert.equal(Object.hasOwn(enabled, "challengeSiteKey"), false)
for (const badKey of ["", " ", "bad key", "x".repeat(257), "x\n", "key<script>", "é", "key/", "\u0000"]) {
  assert.throws(() => resolveSuggestCorrectionOptions({
    ...challengeEnvironment, challengeSiteKey: badKey,
  }), /CYBERBASER_SUGGESTION_CHALLENGE_SITE_KEY/)
}
assert.deepEqual(resolveSuggestCorrectionOptions({
  ...challengeEnvironment, enabled: undefined, challengeSiteKey: "unused malformed key",
}), { enabled: false })

const challengeCalls: RequestInit[] = []
await submitCorrectionIntent(`${intakeOrigin}${ACCOUNT_FREE_INTAKE_PATH}`, intent, (async (_input, init) => {
  challengeCalls.push(init!)
  return new Response("{}", { status: 202, headers: { "content-type": "application/json" } })
}) as typeof fetch, "test-challenge-token")
assert.equal(new Headers(challengeCalls[0].headers).get("Cyberbaser-Challenge-Token"), "test-challenge-token")
assert.equal(challengeCalls[0].body, text)
assert.equal(String(challengeCalls[0].body).includes("test-challenge-token"), false)

for (const [status, code, message] of [
  [403, "challenge-failed", "Couldn't confirm you're human. Please try again."],
  [503, "challenge-unavailable", "Verification is temporarily unavailable. Please try again later."],
  [429, "rate-limited", "Too many suggestions from here right now. Please try again later."],
  [503, "queue-capacity", "Suggestions are paused while the owner reviews the backlog."],
] as const) {
  const result = await submitCorrectionIntent(`${intakeOrigin}${ACCOUNT_FREE_INTAKE_PATH}`, intent, (async () =>
    new Response(JSON.stringify({ error: { code, message: "never display server text" } }), {
      status, headers: { "content-type": "application/json" },
    })) as typeof fetch)
  assert.deepEqual(result, { accepted: false, replayed: false, message })
}

console.log("suggest-correction unit checks passed")

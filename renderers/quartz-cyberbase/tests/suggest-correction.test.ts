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
]) {
  assert.throws(() => resolveIntakeOrigin(origin), /INTAKE_ORIGIN/)
}
assert.equal(resolveIntakeOrigin(intakeOrigin), intakeOrigin)

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

// The rendered component may expose only the canonical action and opaque binding values.
const componentSource = readFileSync(join(import.meta.dir, "../components/SuggestCorrection.tsx"), "utf8")
assert.doesNotMatch(componentSource, /data-(?:source|repository|revision|path|owner|identity|contact|account)/iu)
const formNames = [...componentSource.matchAll(/name="([^"]+)"/gu)].map((match) => match[1])
assert.deepEqual(formNames, ["quote", "prefix", "suffix", "replacement", "rationale", "evidence"])

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
  message: "Correction received. Status: pending-review. Queue ID: Q-test.",
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
assert.match(replayed.message, /^Correction already received\./u)

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

console.log("suggest-correction unit checks passed")

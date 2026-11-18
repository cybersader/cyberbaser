import assert from "node:assert/strict"
import { deriveSuggestedEdit } from "../components/suggestCorrectionDiff"
import { buildCorrectionIntent } from "../components/suggestCorrectionClient"
import { validateCorrectionIntent } from "../../../packages/account-free-intake/src/intent.js"

const cases = [
  ["The quick brown fox.", "The quick red fox.", { quote: "brown", replacement: "red", prefix: "The quick ", suffix: " fox." }],
  ["The quick fox.", "The very quick fox.", { quote: "The ", replacement: "The very ", prefix: "", suffix: "quick fox." }],
  ["cat", "a cat", { quote: "cat", replacement: "a cat", prefix: "", suffix: "" }],
  ["cat", "cats", { quote: "cat", replacement: "cats", prefix: "", suffix: "" }],
  ["The quick brown fox.", "The quick fox.", { quote: "brown ", replacement: "", prefix: "The quick ", suffix: "fox." }],
  ["A red fox and red dog.", "A blue fox and blue dog.", { quote: "red fox and red", replacement: "blue fox and blue", prefix: "A ", suffix: " dog." }],
  ["Hello 🙂 friend.", "Hello 🌍 friend.", { quote: "🙂", replacement: "🌍", prefix: "Hello ", suffix: " friend." }],
  ["A café noir.", "A café noir.", { quote: "café", replacement: "café", prefix: "A ", suffix: " noir." }],
  ["🙂", "🙂!", { quote: "🙂", replacement: "🙂!", prefix: "", suffix: "" }],
  ["🙂", "!🙂", { quote: "🙂", replacement: "!🙂", prefix: "", suffix: "" }],
  ["A cat.", "A dog.", { quote: "cat", replacement: "dog", prefix: "A ", suffix: "." }],
  ["Removed", "", { quote: "Removed", replacement: "", prefix: "", suffix: "" }],
] as const
for (const [original, edited, expected] of cases) {
  assert.deepEqual(deriveSuggestedEdit(original, edited), expected, `${JSON.stringify(original)} → ${JSON.stringify(edited)}`)
}
assert.equal(deriveSuggestedEdit("unchanged 🙂", "unchanged 🙂"), null)
assert.equal(deriveSuggestedEdit("", ""), null)
assert.throws(() => deriveSuggestedEdit("", "new"), /containing text/u)
assert.throws(() => deriveSuggestedEdit("before", "🙂".repeat(4097)), /too long/u)
assert.throws(() => deriveSuggestedEdit("🙂".repeat(4097), "after"), /too long/u)

// Context is adjacent source text, never trimmed whitespace or normalized prose.
const original = `${"context words ".repeat(12)}The old phrase.${" more context".repeat(12)}`
const edit = deriveSuggestedEdit(original, original.replace("old", "new"))!
assert.ok(Array.from(edit.prefix).length <= 40)
assert.ok(Array.from(edit.suffix).length <= 40)
assert.match(edit.prefix, /The $/u)
assert.match(edit.suffix, /^ phrase\./u)
assert.match(edit.prefix, /^(?:\s|context|words)/u)

// Every result must rebuild the edited block exactly. This deterministic corpus
// includes insertions/deletions, disjoint edits, tabs/newlines, combining forms,
// non-Latin words and ZWJ/skin-tone emoji without splitting a surrogate pair.
let seed = 7143
const random = (maximum: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % maximum }
const alphabet = ["a", "b", "é", "中", "λ", "́", "🙂", "👩", "🏽", "‍", "💻", " ", "\t", "\n", "."]
const corpus: Array<readonly [string, string]> = cases.map(([before, after]) => [before, after])
for (let index = 0; index < 1000; index++) {
  const before = Array.from({ length: 1 + random(40) }, () => alphabet[random(alphabet.length)])
  const start = random(before.length + 1)
  const end = start + random(before.length - start + 1)
  const inserted = Array.from({ length: random(10) }, () => alphabet[random(alphabet.length)])
  const after = [...before.slice(0, start), ...inserted, ...before.slice(end)]
  if (index % 2 === 0) after.push("z")
  corpus.push([before.join(""), after.join("")])
}
for (const [before, after] of corpus) {
  const change = deriveSuggestedEdit(before, after)
  if (!change) { assert.equal(before, after); continue }
  assert.ok(change.quote.length > 0)
  const selector = change.prefix + change.quote + change.suffix
  const index = before.indexOf(selector)
  assert.ok(index >= 0)
  const offset = index + change.prefix.length
  assert.equal(before.slice(0, offset) + change.replacement + before.slice(offset + change.quote.length), after)
  for (const text of Object.values(change)) assert.equal(new TextDecoder().decode(new TextEncoder().encode(text)), text)
  // The actual server validator accepts the generated machine contract.
  const intent = buildCorrectionIntent({
    bindingDigest: `sha-256=:${"A".repeat(43)}=:`, pageId: `page-v1:${"A".repeat(43)}`,
    ...change, rationale: "Suggested an edit to this page.", evidenceText: "", idempotencyKey: "A".repeat(43),
  })
  assert.deepEqual(validateCorrectionIntent(intent), intent)
}
console.log("suggest-diff replacement, insertion, deletion, multi-change, Unicode and 1,000 exact-reconstruction checks passed")

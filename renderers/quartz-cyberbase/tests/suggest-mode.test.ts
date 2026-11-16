import assert from "node:assert/strict"
import { SparseRun, sortedOperations, verifiedLeafNode, verifyManifest, utf8 } from "../components/suggestModeModel"
import { buildSuggestionIntent, submitSuggestionIntent } from "../components/suggestModeClient"
import { renderedRunSnapshot } from "../components/suggestMode"
import { validateSuggestionIntent } from "../../../packages/account-free-intake/src/suggestion-intent.js"

// Screenshot caret cleanup can leave an empty style attribute on a deletion.
// The snapshot removes only that no-op, never meaningful attributes or text.
class SnapshotElement {
  attrs = new Map<string, string>([["contenteditable", "false"]])
  text = 'several style="" alternatives'
  getAttribute(name: string) { return this.attrs.get(name) ?? null }
  removeAttribute(name: string) { this.attrs.delete(name) }
}
class SnapshotHost {
  child = new SnapshotElement()
  get innerHTML() { return `<del${[...this.child.attrs].map(([name, value]) => ` ${name}="${value}"`).join("")}>${this.child.text}</del>` }
  querySelectorAll() { return this.child.attrs.has("style") ? [this.child] : [] }
  cloneNode() { const copy = new SnapshotHost(); copy.child.attrs = new Map(this.child.attrs); copy.child.text = this.child.text; return copy }
}
const snapshotHost = new SnapshotHost()
const snapshot = renderedRunSnapshot(snapshotHost as unknown as HTMLElement)
snapshotHost.child.attrs.set("style", "")
assert.equal(renderedRunSnapshot(snapshotHost as unknown as HTMLElement), snapshot)
assert.equal(snapshotHost.child.attrs.has("style"), true, "snapshot must not mutate the live DOM")
snapshotHost.child.attrs.set("style", "display:none")
assert.notEqual(renderedRunSnapshot(snapshotHost as unknown as HTMLElement), snapshot)
snapshotHost.child.attrs.set("style", "")
snapshotHost.child.text = "changed source text"
assert.notEqual(renderedRunSnapshot(snapshotHost as unknown as HTMLElement), snapshot)
snapshotHost.child.text = 'several style="" alternatives'
snapshotHost.child.attrs.set("contenteditable", "true")
assert.notEqual(renderedRunSnapshot(snapshotHost as unknown as HTMLElement), snapshot)

// Fake DOM has real childNodes (including element/text siblings), never children indices.
const text = (value: string) => ({ nodeType: 3, textContent: value })
const leaf = { id: "cb0.1", parent: "cb0", child: 1, text: "Hi 😀", runs: [{ rendered: [0, 5] as [number, number], source: [7, 14] as [number, number], kind: "exact" }] }
const node = text(leaf.text)
const parent = { dataset: { cbNode: "cb0" }, childNodes: [{ nodeType: 1, textContent: "prefix" }, node] }
const root = { querySelectorAll: () => [parent] } as unknown as HTMLElement
assert.equal(verifiedLeafNode(root, leaf), node as unknown as Text)
assert.throws(() => verifiedLeafNode({ querySelectorAll: () => [parent, parent] } as unknown as HTMLElement, leaf), /ambiguous/)
assert.throws(() => verifiedLeafNode(root, { ...leaf, child: 0 }), /changed/)
node.textContent = "stale"; assert.throws(() => verifiedLeafNode(root, leaf), /changed/); node.textContent = leaf.text
const identity = { path: "note.md", byteLength: 30, sha256: "a".repeat(64) }
const manifest = { schema: "cyberbaser.source-provenance", version: 1, source: identity, leaves: [leaf] }
assert.equal(verifyManifest(manifest, identity), manifest)
// A fake DOM UTF-16 selection of the emoji maps to its four exact pinned bytes.
const mapped = new SparseRun("dom", leaf.runs[0].source[0], verifiedLeafNode(root, leaf).textContent!)
mapped.replace(3, 5, "🌎")
assert.deepEqual(mapped.operations(), [{ operationId: "edit-dom-10", start: 10, end: 14, expected: "😀", replacement: "🌎" }])
assert.throws(() => verifyManifest(manifest, { ...identity, sha256: "b".repeat(64) }), /identity/)
assert.throws(() => verifyManifest({ ...manifest, leaves: [{ ...leaf, runs: [{ rendered: [0, 4], source: [7, 13], kind: "exact" }] }] }, identity), /characters/)
assert.throws(() => verifyManifest({ ...manifest, leaves: [{ ...leaf, runs: [{ rendered: [0, 5], source: [7, 13], kind: "exact" }] }] }, identity), /range/)
const refused = verifyManifest({ ...manifest, leaves: [{ ...leaf, runs: [{ rendered: [0, 5], reason: "generated-or-unmapped" }] }] }, identity)
assert.equal(refused.leaves[0].runs[0].source, undefined)

const base = "Hello **brown** [friendly](https://example.org).\r\n"
const plain = new SparseRun("0", 0, "Hello ")
const bold = new SparseRun("1", 8, "brown")
const link = new SparseRun("2", 17, "friendly")
plain.replace(5, 5, ", reader")
bold.replace(0, 5, "red")
link.replace(0, 6, "")
const ops = sortedOperations([link, plain, bold])
assert.equal(ops.length, 3)
const candidate = [...ops].reverse().reduce((bytes, op) => {
  assert.equal(bytes.subarray(op.start, op.end).toString(), op.expected)
  return Buffer.concat([bytes.subarray(0, op.start), Buffer.from(op.replacement), bytes.subarray(op.end)])
}, Buffer.from(base))
assert.equal(candidate.toString(), "Hello, reader **red** [ly](https://example.org).\r\n")
// Inserted text has no invented base coordinates, even after repeated typing/backspace.
bold.replace(1, 2, "o"); assert.equal(bold.operations()[0].replacement, "rod")
bold.replace(1, 2, "e"); assert.equal(bold.operations()[0].replacement, "red")
const saved = JSON.parse(JSON.stringify(bold.operations()))
const restored = new SparseRun("1", 8, "brown"); restored.restore(saved)
assert.deepEqual(restored.operations(), bold.operations())
restored.discard(restored.operations()[0]); assert.equal(restored.currentText, "brown")
const insertion = new SparseRun("3", 40, "😀 cat")
assert.throws(() => insertion.replace(1, 1, "x"), /characters/)
insertion.replace(2, 2, "hi"); insertion.replace(2, 4, "")
assert.deepEqual(insertion.operations(), [])
assert.throws(() => sortedOperations([new SparseRun("4", 0, "a"), Object.assign(new SparseRun("5", 0, "b"), { tokens: [{ text: "x", start: null, end: null }] }), Object.assign(new SparseRun("6", 0, "b"), { tokens: [{ text: "y", start: null, end: null }] })]), /overlap/)

const intent = buildSuggestionIntent({ bindingDigest: `sha-256=:${"A".repeat(43)}=:`, pageId: `page-v1:${"A".repeat(43)}`, operations: ops, rationale: "", evidenceText: "https://example.org/", idempotencyKey: "A".repeat(32) })
assert.deepEqual(Object.keys(intent), ["schemaVersion", "artifactType", "bindingDigest", "pageId", "operations", "evidence", "idempotencyKey"])
assert.deepEqual(Object.keys(intent.operations[0]), ["operationId", "start", "end", "expected", "replacement"])
assert.doesNotThrow(() => validateSuggestionIntent(intent))
let call: RequestInit | undefined
const receipt = await submitSuggestionIntent("https://intake.example/v2/suggestions", intent, (async (_url, init) => {
  call = init
  return new Response(JSON.stringify({ receipt: { queueId: "Q-v2" } }), { status: 202, headers: { "content-type": "application/json" } })
}) as typeof fetch, "challenge-token")
assert.equal(receipt.accepted, true); assert.match(receipt.message, /Receipt Q-v2/)
assert.deepEqual(JSON.parse(call!.body as string), intent)
assert.equal((call!.headers as Record<string, string>)["Cyberbaser-Challenge-Token"], "challenge-token")
assert.equal(call!.credentials, "omit")
// Deterministic Unicode/adjacent/dependent editing reconstruction against a separate splice path.
let seed = 19
const random = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n }
const alphabet = ["a", "é", "😀", "中", " "]
for (let n = 0; n < 300; n++) {
  const original = Array.from({ length: 15 }, () => alphabet[random(alphabet.length)]).join("")
  const run = new SparseRun("fuzz", 11, original)
  let current = original
  for (let k = 0; k < 8; k++) {
    const chars = [...current], a = random(chars.length + 1), b = a + random(chars.length - a + 1)
    const replacement = alphabet[random(alphabet.length)]
    run.replace(chars.slice(0, a).join("").length, chars.slice(0, b).join("").length, replacement)
    current = chars.slice(0, a).join("") + replacement + chars.slice(b).join("")
    const bytes = [...run.operations()].reverse().reduce((bytes, op) => Buffer.concat([bytes.subarray(0, op.start - 11), Buffer.from(op.replacement), bytes.subarray(op.end - 11)]), Buffer.from(original))
    assert.equal(bytes.toString(), current); assert.equal(run.currentText, current)
  }
}
console.log("suggest-mode fake-DOM provenance, empty-style snapshot regression, sparse insert/replace/delete, inserted edits, refusal, persistence, v2 payload, receipt and 2,400 Unicode reconstruction checks passed")

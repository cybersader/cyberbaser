import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { BlockDraft } from "../source-editor/src/draft"
import { verifyManifest, verifiedBlockNode, validateOperations, utf8 } from "../components/suggestModeModel"
import type { Operation, ProvenanceBlock } from "../components/suggestModeModel"
import { localOperations, sourceOperations, touchesBlock } from "../components/sourceEditor"
import { sourceEditorAsset } from "../components/sourceEditorAsset"

const fixtures = [
  ["[[target]]", "target", "third"],
  ["> [!tip] Custom title\r\n> Body text.", "Custom title", "New title"],
  ["$$\nx + y\n$$", "x", "z"],
  ["First line\r\nSecond line\r\n", "Second", "Next"],
  ["Hello 😀 world", "😀", "🌍"],
  ["Mixed\r\nline\nlast\r\n", "line", "middle"],
]
for (const [text, old, replacement] of fixtures) {
  const prefix = "Untouched 😀\r\n\r\n", suffix = "\r\n\r\nUntouched tail."
  const base = prefix + text + suffix, start = utf8(prefix).length
  const block: ProvenanceBlock = { id: "block0", parent: "cb0", source: [start, start + utf8(text).length], text, editable: true }
  const identity = { path: "test.md", byteLength: utf8(base).length, sha256: "a".repeat(64) }
  const sidecar = { schema: "cyberbaser.source-provenance", version: 2, source: identity, leaves: [], blocks: [block] }
  assert.equal(verifyManifest(sidecar, identity).blocks?.[0], block)
  const node = { dataset: { cbNode: "cb0" } }
  assert.equal(verifiedBlockNode({ querySelectorAll: () => [node] } as unknown as HTMLElement, block), node as unknown as HTMLElement)
  const draft = new BlockDraft(text)
  const at = text.indexOf(old)
  draft.change([{ from: at, to: at + old.length, insert: replacement }])
  assert.equal(draft.text, text.replace(old, replacement))
  const ops = sourceOperations(block, draft.operations())
  validateOperations(ops)
  const expectedStart = start + utf8(text.slice(0, at)).length
  assert.deepEqual(ops.map(({ start, end, expected, replacement }) => ({ start, end, expected, replacement })), [{ start: expectedStart, end: expectedStart + utf8(old).length, expected: old, replacement }])
  const candidate = [...ops].reverse().reduce((bytes, op) => {
    assert.equal(bytes.subarray(op.start, op.end).toString(), op.expected)
    return Buffer.concat([bytes.subarray(0, op.start), Buffer.from(op.replacement), bytes.subarray(op.end)])
  }, Buffer.from(base))
  assert.equal(candidate.toString(), prefix + text.replace(old, replacement) + suffix)
  const reopened = new BlockDraft(text, localOperations(block, ops))
  assert.equal(reopened.text, draft.text)
  // Cancel is isolation: a second draft cannot mutate the accepted pending operations.
  const cancelled = new BlockDraft(text, localOperations(block, ops))
  cancelled.change([{ from: 0, to: 0, insert: "discard me" }])
  assert.equal(new BlockDraft(text, localOperations(block, ops)).text, draft.text)
  assert.equal(touchesBlock({ start: expectedStart, end: expectedStart + 1 } as Operation, block), true)
  assert.equal(touchesBlock({ start: 0, end: start - 1 } as Operation, block), false)
  assert.throws(() => validateOperations([...ops, { ...ops[0], operationId: "rendered-overlap" }]), /overlap/)
}
const multi = new BlockDraft("😀 one\r\ntwo\nthree")
multi.change([{ from: 3, to: 6, insert: "ONE" }, { from: 8, to: 11, insert: "TWO" }])
assert.equal(multi.text, "😀 ONE\r\nTWO\nthree")
assert.throws(() => multi.change([{ from: 1, to: 1, insert: "bad" }]), /UTF-16/)
assert.equal(multi.text, "😀 ONE\r\nTWO\nthree")
const crlf = new BlockDraft("one\r\ntwo")
assert.throws(() => crlf.change([{ from: 4, to: 5, insert: "" }]), /complete CRLF/)
assert.equal(crlf.text, "one\r\ntwo")
crlf.change([{ from: 3, to: 5, insert: "" }])
assert.equal(crlf.text, "onetwo")
const insert = new BlockDraft("A 😀 B")
insert.change([{ from: 2, to: 2, insert: "new " }]); insert.change([{ from: 2, to: 5, insert: "NEW" }])
assert.equal(insert.operations().length, 1)
assert.equal(insert.operations()[0].replacement, "NEW ")
const refused: ProvenanceBlock = { id: "block0", parent: "cb0", source: [0, 5], editable: false, reason: "obsidian-comment" }
assert.throws(() => sourceOperations(refused, []), /obsidian-comment/)
const identity = { path: "test.md", byteLength: 5, sha256: "a".repeat(64) }
const old = { schema: "cyberbaser.source-provenance", version: 1, source: identity, leaves: [] }
assert.equal(verifyManifest(old, identity).blocks, undefined)
assert.equal(verifyManifest({ ...old, version: 2, blocks: [refused] }, identity).blocks?.[0].text, undefined)
assert.throws(() => verifyManifest({ ...old, version: 2, blocks: [{ ...refused, text: "secret" }] }, identity), /must not publish/)
assert.throws(() => verifyManifest({ ...old, version: 2, blocks: [{ ...refused, editable: true, text: "x" }] }, identity), /bytes/)
assert.throws(() => verifiedBlockNode({ querySelectorAll: () => [] } as unknown as HTMLElement, refused), /locator/)
const renderer = path.resolve(import.meta.dir, "..")
const asset = path.join(renderer, "vendor", sourceEditorAsset)
const digest = createHash("sha256").update(fs.readFileSync(asset)).digest("hex")
assert.equal(sourceEditorAsset, `source-editor.${digest.slice(0, 16)}.js`)
assert.equal(fs.readFileSync(`${asset}.sha256`, "utf8"), `${digest}  ${sourceEditorAsset}\n`)
if (fs.existsSync(path.join(renderer, "source-editor/node_modules/@codemirror/state/package.json"))) {
  process.stdout.write(execFileSync("bun", [path.join(renderer, "source-editor/build.mjs")], { cwd: renderer, encoding: "utf8" }))
} else console.log("source-editor rebuild skipped: optional build dependencies absent; vendored hash verified offline")
console.log("suggest-source-editor: v2 fake-sidecar blocks, wiki/callout/math/CRLF/mixed-EOL/emoji exact splices, local/global offsets, multi-range transactions, inserted edits, cancel isolation, overlap/refusal, v1 fallback and vendored SHA-256 passed")

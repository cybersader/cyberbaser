import { SuggestionLedger, digestBytes } from "../../../../packages/suggestion-ledger/src/index.js"
import type { Operation } from "../../components/suggestModeModel"
import { validateOperations, utf8 } from "../../components/suggestModeModel"

/** Complete block-local base, not the complete page. No source I/O or Markdown serialization. */
export class BlockDraft {
  ledger: SuggestionLedger
  constructor(readonly base: string, operations: Operation[] = []) {
    const bytes = utf8(base)
    this.ledger = new SuggestionLedger(bytes, { path: "published-block.md", byteLength: bytes.length, digest: digestBytes(bytes) }, {
      clock: () => "2026-11-16T00:00:00.000Z", limits: { maxBaseBytes: 8192, maxViewBytes: 32768, maxOperations: 50, maxHistory: 1 },
    })
    validateOperations(operations)
    for (const op of [...operations].reverse()) {
      const map = this.ledger.coordinates("base")
      const a = map.byteToUtf16(op.start), b = map.byteToUtf16(op.end)
      if (base.slice(a, b) !== op.expected) throw Error("Stored source edit does not match this block.")
      this.ledger.replace({ start: op.start, end: op.end }, op.replacement, { space: "base" })
    }
    this.ledger.verify()
  }
  get text(): string { return this.ledger.currentText }
  operations(): Operation[] { return [...this.ledger.toOperations()] }
  /** CM changes refer to one pre-transaction UTF-16 document. Convert all first, apply right-to-left. */
  change(changes: { from: number; to: number; insert: string }[]) {
    const map = this.ledger.coordinates()
    const splitsBreak = (at: number) => at > 0 && this.text[at - 1] === "\r" && this.text[at] === "\n"
    if (changes.some(change => splitsBreak(change.from) || splitsBreak(change.to))) throw Error("Choose a complete CRLF line break.")
    const converted = changes.map(change => ({ start: map.utf16ToByte(change.from), end: map.utf16ToByte(change.to), insert: change.insert }))
    const snapshot = this.ledger.serialize()
    try {
      for (const change of converted.reverse()) this.ledger.replace({ start: change.start, end: change.end }, change.insert)
      validateOperations(this.operations()); this.ledger.verify()
    } catch (error) {
      this.ledger = SuggestionLedger.deserialize(this.ledger.baseBytes, this.ledger.baseIdentity, snapshot)
      throw error
    }
  }
}

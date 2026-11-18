/** Sparse original-byte ledger. Only independently verified exact runs enter this model.
 * Unlike SuggestionLedger this never claims to possess or verify the complete base file.
 * Original tokens retain their pinned byte origin; inserted tokens have no source origin.
 */
export interface SourceIdentity { path: string; byteLength: number; sha256: string }
export interface Operation { operationId: string; start: number; end: number; expected: string; replacement: string }
export interface ProvenanceLeaf {
  id: string; parent: string; child: number; text: string
  runs: { rendered: [number, number]; source?: [number, number]; kind?: string; reason?: string }[]
}
export interface ProvenanceBlock {
  id: string; parent: string; source: [number, number]; text?: string; editable: boolean; reason?: string
}
export interface Manifest { schema: string; version: number; source: SourceIdentity; leaves: ProvenanceLeaf[]; blocks?: ProvenanceBlock[] }
export const utf8 = (text: string) => new TextEncoder().encode(text)
export function boundary(text: string, at: number) {
  if (!Number.isInteger(at) || at < 0 || at > text.length ||
      (at > 0 && at < text.length && /[\uD800-\uDBFF]/u.test(text[at - 1]) && /[\uDC00-\uDFFF]/u.test(text[at]))) throw Error("Choose complete characters.")
}
export function verifyManifest(value: unknown, expected: SourceIdentity): Manifest {
  const m = value as Manifest
  if (!m || m.schema !== "cyberbaser.source-provenance" || ![1, 2].includes(m.version) || !Array.isArray(m.leaves) ||
      !m.source || m.source.path !== expected.path || m.source.sha256 !== expected.sha256 || m.source.byteLength !== expected.byteLength ||
      !/^[a-f0-9]{64}$/u.test(expected.sha256) || !Number.isSafeInteger(expected.byteLength) || expected.byteLength < 0) throw Error("Page source identity changed.")
  const ids = new Set<string>()
  for (const leaf of m.leaves) {
    if (!leaf || typeof leaf.id !== "string" || ids.has(leaf.id) || typeof leaf.parent !== "string" ||
        !Number.isSafeInteger(leaf.child) || leaf.child < 0 || typeof leaf.text !== "string" || !Array.isArray(leaf.runs)) throw Error("Invalid provenance leaf.")
    ids.add(leaf.id)
    let previous = 0
    for (const run of leaf.runs) {
      if (!Array.isArray(run.rendered) || run.rendered.length !== 2) throw Error("Invalid rendered range.")
      const [a, b] = run.rendered
      boundary(leaf.text, a); boundary(leaf.text, b)
      if (a !== previous || b <= a) throw Error("Discontinuous rendered range.")
      previous = b
      if (run.source) {
        const [start, end] = run.source
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > expected.byteLength ||
            (run.kind !== "exact" && run.kind !== "atom") || (run.kind === "exact" && utf8(leaf.text.slice(a, b)).length !== end - start)) throw Error("Invalid source range.")
      } else if (typeof run.reason !== "string") throw Error("Missing provenance refusal.")
    }
    if (previous !== leaf.text.length) throw Error("Incomplete rendered coverage.")
  }
  if (m.blocks !== undefined) {
    if (!Array.isArray(m.blocks)) throw Error("Invalid source blocks.")
    const blockIds = new Set<string>(), parents = new Set<string>()
    for (const block of m.blocks) {
      if (!block || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,80}$/u.test(block.id) || blockIds.has(block.id) ||
          typeof block.parent !== "string" || parents.has(block.parent) || !Array.isArray(block.source) || block.source.length !== 2 ||
          !Number.isSafeInteger(block.source[0]) || !Number.isSafeInteger(block.source[1]) || block.source[0] < 0 ||
          block.source[1] < block.source[0] || block.source[1] > expected.byteLength || typeof block.editable !== "boolean") throw Error("Invalid source block.")
      if (block.editable) {
        if (typeof block.text !== "string" || utf8(block.text).length !== block.source[1] - block.source[0] || utf8(block.text).length > 8192 ||
            /[\uD800-\uDFFF]/u.test(block.text.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/gu, ""))) throw Error("Invalid source block bytes.")
      } else if (block.text !== undefined || typeof block.reason !== "string") throw Error("Refused source block must not publish text.")
      blockIds.add(block.id); parents.add(block.parent)
    }
    const editable = m.blocks.filter(block => block.editable).sort((a, b) => a.source[0] - b.source[0])
    if (editable.some((block, i) => i > 0 && block.source[0] < editable[i - 1].source[1])) throw Error("Overlapping source blocks.")
  }
  return m
}
export function verifiedBlockNode(root: HTMLElement, block: ProvenanceBlock): HTMLElement {
  const matches = block.parent === "$body" ? [root] : [...root.querySelectorAll<HTMLElement>("[data-cb-node]")].filter(el => el.dataset.cbNode === block.parent)
  if (matches.length !== 1 || matches[0] === root) throw Error("Missing or ambiguous source block locator.")
  return matches[0]
}
export function verifiedLeafNode(root: HTMLElement, leaf: ProvenanceLeaf): Text {
  // No selector interpolation: locator strings are untrusted build metadata.
  const parents = leaf.parent === "$body" ? [root] : [...root.querySelectorAll<HTMLElement>("[data-cb-node]")].filter(el => el.dataset.cbNode === leaf.parent)
  if (parents.length !== 1) throw Error("Missing or ambiguous source locator.")
  const node = parents[0].childNodes[leaf.child]
  if (!node || node.nodeType !== 3 || node.textContent !== leaf.text) throw Error("Rendered text changed.")
  return node as Text
}
interface Token { text: string; start: number | null; end: number | null }
export class SparseRun {
  readonly original: Token[] = []
  tokens: Token[] = []
  constructor(readonly id: string, readonly start: number, readonly text: string) {
    let at = start
    for (const text of this.text) { const end = at + utf8(text).length; this.original.push({ text, start: at, end }); at = end }
    this.reset()
  }
  get end() { return this.start + utf8(this.text).length }
  get currentText() { return this.tokens.map(t => t.text).join("") }
  reset() { this.tokens = this.original.map(t => ({ ...t })) }
  replace(start: number, end: number, replacement: string) {
    const text = this.currentText
    boundary(text, start); boundary(text, end)
    if (end < start || /[\uD800-\uDFFF]/u.test(replacement.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/gu, ""))) throw Error("Invalid text range.")
    let cursor = 0, a = 0, b = 0
    for (const token of this.tokens) { cursor += token.text.length; if (cursor <= start) a++; if (cursor <= end) b++ }
    const before = this.tokens
    this.tokens = [...before.slice(0, a), ...[...replacement].map(text => ({ text, start: null, end: null })), ...before.slice(b)]
    try { validateOperations(this.operations()) } catch (error) { this.tokens = before; throw error }
  }
  operations(): Operation[] {
    let cursor = this.start, replacement = ""
    const ops: Operation[] = []
    const bytes = utf8(this.text)
    const emit = (end: number) => {
      if (cursor === end && replacement === "") return
      const expected = new TextDecoder("utf-8", { fatal: true }).decode(bytes.slice(cursor - this.start, end - this.start))
      if (expected !== replacement) ops.push({ operationId: `edit-${this.id}-${cursor}`, start: cursor, end, expected, replacement })
      cursor = end; replacement = ""
    }
    for (const token of this.tokens) {
      if (token.start === null) replacement += token.text
      else { emit(token.start); cursor = token.end! }
    }
    emit(this.end)
    return ops
  }
  restore(operations: Operation[]) {
    this.reset()
    for (const op of [...operations].reverse()) {
      if (op.start < this.start || op.end > this.end || new TextDecoder("utf-8", { fatal: true }).decode(utf8(this.text).slice(op.start - this.start, op.end - this.start)) !== op.expected) throw Error("Stored suggestion no longer matches.")
      const before = new TextDecoder("utf-8", { fatal: true }).decode(utf8(this.text).slice(0, op.start - this.start)).length
      this.replace(before, before + op.expected.length, op.replacement)
    }
  }
  discard(op: Operation) { this.restore(this.operations().filter(item => item.operationId !== op.operationId)) }
}
export function validateOperations(ops: Operation[]) {
  if (ops.length > 50) throw Error("Send at most 50 suggestions at a time.")
  let bytes = 0, previous: Operation | undefined
  const ids = new Set<string>()
  for (const op of ops) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(op.operationId) || ids.has(op.operationId) ||
        !Number.isSafeInteger(op.start) || !Number.isSafeInteger(op.end) || op.start < 0 || op.end < op.start || op.end > 4 * 1024 * 1024 ||
        /\r(?!\n)/u.test(op.replacement) || op.end - op.start !== utf8(op.expected).length || op.expected === op.replacement ||
        (previous && (op.start <= previous.start || op.start < previous.end))) throw Error("Suggestions overlap or are not exact source ranges.")
    const a = utf8(op.expected).length, b = utf8(op.replacement).length
    if (a > 16384 || b > 16384) throw Error("Choose a smaller edit (16 KiB maximum).")
    bytes += a + b; ids.add(op.operationId); previous = op
  }
  if (bytes > 65536) throw Error("Suggestions exceed the 64 KiB limit.")
}
export function sortedOperations(runs: Iterable<SparseRun>) {
  const ops = [...runs].flatMap(run => run.operations()).sort((a, b) => a.start - b.start)
  validateOperations(ops)
  return ops
}

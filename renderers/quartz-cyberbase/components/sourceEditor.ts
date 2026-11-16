import type { Operation, ProvenanceBlock } from "./suggestModeModel"
import { utf8, validateOperations } from "./suggestModeModel"

/** Carrier/editor-neutral boundary. Implementations receive only a pinned block, never file authority. */
export interface SourceEditorSession {
  operations(): Operation[] // block-local original UTF-8 byte ranges
  focus(): void
  destroy(): void
}
export interface SourceEditor {
  mount(parent: HTMLElement, options: {
    text: string
    operations: Operation[]
    label: string
    onError(message: string): void
  }): SourceEditorSession
}
declare global { interface Window { cyberbaserSourceEditor?: SourceEditor } }
let loading: Promise<SourceEditor> | undefined
/** No import, preload or fetch occurs until a reader opens a source block. */
export function loadSourceEditor(asset: string): Promise<SourceEditor> {
  if (window.cyberbaserSourceEditor) return Promise.resolve(window.cyberbaserSourceEditor)
  if (loading) return loading
  loading = new Promise<SourceEditor>((resolve, reject) => {
    const url = new URL(asset, location.href)
    if (url.origin !== location.origin || !/\/static\/source-editor\.[a-f0-9]{16}\.js$/u.test(url.pathname)) {
      reject(Error("The source editor asset must be a same-origin static file.")); return
    }
    const script = document.createElement("script")
    script.src = url.href; script.async = true
    const timer = setTimeout(() => finish(Error("Source editor loading timed out. Try again.")), 15000)
    const finish = (error?: Error) => {
      clearTimeout(timer); script.onload = script.onerror = null
      if (error || !window.cyberbaserSourceEditor) { script.remove(); reject(error ?? Error("Source editor did not initialize.")) }
      else resolve(window.cyberbaserSourceEditor)
    }
    script.onload = () => finish()
    script.onerror = () => finish(Error("Could not load the source editor. Try again."))
    document.head.append(script)
  }).catch(error => { loading = undefined; throw error })
  return loading
}
export function touchesBlock(op: Operation, block: ProvenanceBlock) {
  // Include insertions at either boundary: one block may not silently claim an adjacent edit.
  return op.start <= block.source[1] && op.end >= block.source[0]
}
export function sourceOperations(block: ProvenanceBlock, local: Operation[]): Operation[] {
  if (!block.editable || typeof block.text !== "string") throw Error(`Source editing unavailable: ${block.reason ?? "unpublished source"}.`)
  validateOperations(local)
  const bytes = utf8(block.text), decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
  return local.map(op => {
    if (op.end > bytes.length || decoder.decode(bytes.slice(op.start, op.end)) !== op.expected) throw Error("Source edit no longer matches the pinned block.")
    // Validate both boundaries even for an empty expected slice.
    decoder.decode(bytes.slice(0, op.start)); decoder.decode(bytes.slice(op.end))
    return { ...op, operationId: `source-${block.id}-${op.start}`, start: block.source[0] + op.start, end: block.source[0] + op.end }
  })
}
export function localOperations(block: ProvenanceBlock, ops: Operation[]): Operation[] {
  const local = ops.map(op => ({ ...op, start: op.start - block.source[0], end: op.end - block.source[0] }))
  sourceOperations(block, local)
  return local
}

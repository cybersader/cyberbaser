/** Bounded snapshots of the existing exact-operation ledger, not a second text model. */
export class SuggestHistory<T> {
  private past: { before: T; after: T; group?: string; end?: string; time: number }[] = []
  private future: typeof this.past = []
  get canUndo() { return this.past.length > 0 }
  get canRedo() { return this.future.length > 0 }
  clear() { this.past = []; this.future = [] }
  breakGroup() { const last = this.past.at(-1); if (last) last.group = undefined }
  record(before: T, after: T, typing?: { group: string; start: string; end: string }, now = Date.now()) {
    const last = this.past.at(-1)
    if (typing && last?.group === typing.group && last.end === typing.start && now - last.time <= 1000) {
      last.after = after; last.end = typing.end; last.time = now
    } else {
      this.past.push({ before, after, group: typing?.group, end: typing?.end, time: now })
      if (this.past.length > 100) this.past.shift()
    }
    this.future = []
  }
  undo() { const item = this.past.pop(); if (!item) return; this.future.push(item); this.breakGroup(); return item.before }
  redo() { const item = this.future.pop(); if (!item) return; item.group = undefined; this.past.push(item); return item.after }
}
/** Word-boundary context. Preserve the change itself, including exact whitespace. */
export function changeContext(text: string, start: number, end: number) {
  let a = Math.max(0, start - 60), b = Math.min(text.length, end + 60)
  if (a > 0) { const space = text.indexOf(" ", a); if (space >= 0 && space < start) a = space + 1 }
  if (b < text.length) { const space = text.lastIndexOf(" ", b); if (space > end) b = space }
  return { before: (a > 0 ? "…" : "") + text.slice(a, start), after: text.slice(end, b) + (b < text.length ? "…" : "") }
}

import { EditorState } from "@codemirror/state"
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap } from "@codemirror/view"
import { markdownLanguage } from "@codemirror/lang-markdown"
import { syntaxHighlighting, defaultHighlightStyle, syntaxTree } from "@codemirror/language"
import { BlockDraft } from "./draft"
import type { SourceEditor } from "../../components/sourceEditor"

class Deleted extends WidgetType {
  constructor(readonly text: string) { super() }
  eq(other: Deleted) { return other.text === this.text }
  toDOM() {
    const el = document.createElement("del")
    el.className = "cb-source-delete"; el.textContent = this.text
    el.contentEditable = "false"; el.setAttribute("aria-label", `Deleted: ${this.text}`)
    return el
  }
  ignoreEvent() { return true }
}
const implementation: SourceEditor = {
  mount(parent, options) {
    const draft = new BlockDraft(options.text, options.operations)
    const marks = (view: EditorView) => {
      const ranges = [], map = draft.ledger.coordinates()
      let delta = 0
      for (const op of draft.operations()) {
        const fromByte = op.start + delta
        const from = map.byteToUtf16(fromByte), to = map.byteToUtf16(fromByte + new TextEncoder().encode(op.replacement).length)
        if (op.expected) ranges.push(Decoration.widget({ widget: new Deleted(op.expected), side: -1 }).range(from))
        if (to > from) ranges.push(Decoration.mark({ class: "cb-source-insert" }).range(from, to))
        delta += new TextEncoder().encode(op.replacement).length - (op.end - op.start)
      }
      // Fade syntax, never remove it or move source positions. Reveal the cursor's line.
      const cursorLine = view.state.doc.lineAt(view.state.selection.main.head).number
      syntaxTree(view.state).iterate({ enter(node) {
        if (/^(EmphasisMark|LinkMark|CodeMark|HeaderMark|QuoteMark)$/u.test(node.name) &&
            node.to > node.from && view.state.doc.lineAt(node.from).number !== cursorLine) {
          ranges.push(Decoration.mark({ class: "cb-source-syntax" }).range(node.from, node.to))
        }
      } })
      return Decoration.set(ranges, true)
    }
    const tracked = ViewPlugin.fromClass(class {
      decorations
      constructor(view: EditorView) { this.decorations = marks(view) }
      update(update: { view: EditorView }) { this.decorations = marks(update.view) }
    }, { decorations: plugin => plugin.decorations })
    const newline = options.text.includes("\r\n") ? "\r\n" : "\n"
    const view = new EditorView({ parent, state: EditorState.create({
      doc: draft.text,
      extensions: [
        // Explicit LF splitter retains CR as a literal document character. Existing
        // CRLF and mixed EOL bytes survive; CM positions match raw UTF-16 exactly.
        EditorState.lineSeparator.of("\n"), markdownLanguage,
        syntaxHighlighting(defaultHighlightStyle), EditorView.lineWrapping,
        EditorView.contentAttributes.of({ "aria-label": options.label, "aria-multiline": "true", spellcheck: "true" }),
        EditorState.transactionFilter.of(transaction => {
          if (!transaction.docChanged) return transaction
          try {
            const changes: { from: number; to: number; insert: string }[] = []
            transaction.changes.iterChanges((from, to, _fromB, _toB, inserted) => changes.push({ from, to, insert: inserted.toString() }))
            draft.change(changes)
            return transaction
          } catch (error) {
            options.onError(error instanceof Error ? error.message : "Choose complete characters.")
            return []
          }
        }),
        keymap.of([
          { key: "Enter", run: editor => {
            const selection = editor.state.selection.main, at = selection.head
            if (selection.empty && draft.text[at - 1] === "\r" && draft.text[at] === "\n") {
              editor.dispatch({ changes: { from: at - 1, insert: newline }, selection: { anchor: at - 1 + newline.length } })
            } else editor.dispatch(editor.state.replaceSelection(newline))
            return true
          } },
          { key: "Backspace", run: editor => {
            const selection = editor.state.selection.main, at = selection.head
            if (!selection.empty || draft.text.slice(at - 2, at) !== "\r\n") return false
            editor.dispatch({ changes: { from: at - 2, to: at }, selection: { anchor: at - 2 } }); return true
          } },
          { key: "Delete", run: editor => {
            const selection = editor.state.selection.main, at = selection.head
            if (!selection.empty) return false
            const from = draft.text[at - 1] === "\r" && draft.text[at] === "\n" ? at - 1 : at
            if (draft.text.slice(from, from + 2) !== "\r\n") return false
            editor.dispatch({ changes: { from, to: from + 2 }, selection: { anchor: from } }); return true
          } },
          { key: "Mod-z", run: () => { options.onError("Use Cancel to discard this source-edit session."); return true } },
          { key: "Mod-y", run: () => true },
        ]), tracked,
      ],
    }) })
    return { operations: () => draft.operations(), focus: () => view.focus(), destroy: () => view.destroy() }
  },
}
window.cyberbaserSourceEditor = implementation

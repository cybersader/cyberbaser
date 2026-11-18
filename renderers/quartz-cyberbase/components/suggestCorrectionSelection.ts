import { deriveSuggestedEdit } from "./suggestCorrectionDiff"
import type { SuggestedEdit } from "./suggestCorrectionDiff"

const BLOCKS = "p, li, h1, h2, h3, h4, h5, h6"
const EXCLUDED = "form, nav, aside, .sidebar, .suggest-correction, .suggest-edit-pencil, .suggest-edit-receipt"

export interface InlineSuggestionEditor {
  readonly active: boolean
  change(): SuggestedEdit | null
  busy(value: boolean): void
  finish(receipt: string): void
  destroy(): void
}

/** The original nodes are hidden, never replaced or reserialized. */
export function setupSuggestionSelection(
  form: HTMLFormElement,
  callbacks: { opened(): void; changed(): void; closed(): void },
): InlineSuggestionEditor {
  const root = form.closest<HTMLElement>(".suggest-correction")!
  const article = document.querySelector<HTMLElement>("article")
  const edited = form.elements.namedItem("edited") as HTMLTextAreaElement
  const hint = root.querySelector<HTMLElement>(".suggest-correction-hint")!
  const entry = root.querySelector<HTMLButtonElement>(".suggest-correction-entry")!
  const cancel = form.querySelector<HTMLButtonElement>(".suggest-correction-cancel")!
  const float = document.createElement("button")
  float.type = "button"
  float.className = "suggest-edit-floating"
  float.textContent = "Suggest edit"
  float.hidden = true
  root.appendChild(float)
  let target: HTMLElement | null = null
  let original = ""
  let originalHidden: string | null = null
  let listHost: HTMLElement | null = null
  let working = false
  let selected: { block: HTMLElement; start: number; end: number } | null = null
  const receipts: HTMLElement[] = []
  const controls: Array<{ block: HTMLElement; pencil: HTMLButtonElement; text: string; className: string | null; click: () => void }> = []

  const focusBlock = (block: HTMLElement) => {
    const previous = block.getAttribute("tabindex")
    block.setAttribute("tabindex", "-1")
    block.focus({ preventScroll: true })
    if (previous === null) block.removeAttribute("tabindex")
    else block.setAttribute("tabindex", previous)
  }
  const close = (receipt?: string, focus = true) => {
    if (!target) return
    const block = target
    if (originalHidden === null) block.removeAttribute("hidden")
    else block.setAttribute("hidden", originalHidden)
    target = null
    selected = null
    form.hidden = true
    root.appendChild(form)
    listHost?.remove()
    listHost = null
    callbacks.closed()
    form.reset()
    if (receipt) {
      const message = document.createElement(block.tagName === "LI" ? "li" : "p")
      message.className = "suggest-edit-receipt"
      message.setAttribute("role", "status")
      message.setAttribute("aria-live", "polite")
      message.textContent = receipt
      block.after(message)
      receipts.push(message)
    }
    if (focus) focusBlock(block)
  }
  const open = (block: HTMLElement, start?: number, end?: number) => {
    if (working || target) return
    const control = controls.find((item) => item.block === block)
    if (!control) return
    target = block
    original = control.text
    originalHidden = block.getAttribute("hidden")
    selected = null
    float.hidden = true
    hint.hidden = true
    form.reset()
    edited.value = original
    edited.rows = Math.max(3, Math.min(16, original.split("\n").length + Math.ceil(original.length / 85)))
    block.hidden = true
    if (block.tagName === "LI") {
      // Keep list children valid while the original item is hidden.
      listHost = document.createElement("li")
      listHost.className = "suggest-edit-host"
      listHost.appendChild(form)
      block.after(listHost)
    } else block.after(form)
    form.hidden = false
    callbacks.opened()
    callbacks.changed()
    edited.focus()
    edited.setSelectionRange(start ?? original.length, end ?? original.length)
  }
  for (const block of article?.querySelectorAll<HTMLElement>(BLOCKS) ?? []) {
    // A list item with nested paragraphs/lists is not one plain-text block.
    // Its leaf paragraphs/items remain independently editable.
    if (block.closest(EXCLUDED) || block.querySelector(`${BLOCKS}, ul, ol, form, button, input, textarea`)
      || block.hidden || !block.textContent?.trim()) continue
    const text = block.textContent
    const pencil = document.createElement("button")
    pencil.type = "button"
    pencil.className = "suggest-edit-pencil suggest-edit-mobile-visible"
    pencil.setAttribute("aria-label", "Suggest edit")
    pencil.setAttribute("title", "Suggest edit")
    pencil.textContent = "✎"
    const click = () => open(block)
    pencil.addEventListener("click", click)
    const className = block.getAttribute("class")
    block.classList.add("suggest-edit-block")
    block.appendChild(pencil)
    controls.push({ block, pencil, text, className, click })
  }
  const capture = () => {
    if (target) return
    selected = null
    float.hidden = true
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return
    const range = selection.getRangeAt(0)
    const startNode = range.startContainer.nodeType === 1 ? range.startContainer as Element : range.startContainer.parentElement
    const endNode = range.endContainer.nodeType === 1 ? range.endContainer as Element : range.endContainer.parentElement
    if (!startNode || !endNode || startNode.closest(EXCLUDED) || endNode.closest(EXCLUDED)) return
    const block = startNode.closest<HTMLElement>(BLOCKS)
    if (!block || endNode.closest(BLOCKS) !== block || !article?.contains(block)
      || !controls.some((control) => control.block === block)) return
    const prefix = range.cloneRange()
    prefix.selectNodeContents(block)
    prefix.setEnd(range.startContainer, range.startOffset)
    const start = prefix.toString().length
    const end = start + range.toString().length
    const text = controls.find((control) => control.block === block)!.text
    if (start >= end || end > text.length) return
    selected = { block, start, end }
    const rect = range.getBoundingClientRect()
    float.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 160))}px`
    float.style.top = `${Math.max(8, rect.bottom + 48 < window.innerHeight ? rect.bottom + 8 : rect.top - 48)}px`
    float.hidden = false
  }
  const useSelection = () => { if (selected) open(selected.block, selected.start, selected.end) }
  const preserveSelection = (event: Event) => event.preventDefault()
  const dismissFloat = () => { float.hidden = true; selected = null }
  const explain = () => { hint.hidden = false }
  const onInput = () => callbacks.changed()
  const onCancel = () => { if (!working) close() }
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape" && !working) { event.preventDefault(); close() }
  }
  const captureEvents = ["selectionchange", "pointerup", "keyup"] as const
  for (const event of captureEvents) document.addEventListener(event, capture)
  window.addEventListener("scroll", dismissFloat, true)
  window.addEventListener("resize", dismissFloat)
  float.addEventListener("pointerdown", preserveSelection)
  float.addEventListener("click", useSelection)
  entry.addEventListener("click", explain)
  cancel.addEventListener("click", onCancel)
  form.addEventListener("input", onInput)
  form.addEventListener("keydown", onKey)
  return {
    get active() { return target !== null },
    change() { return target ? deriveSuggestedEdit(original, edited.value) : null },
    busy(value) {
      working = value
      for (const control of [edited, cancel, form.elements.namedItem("rationale"), form.elements.namedItem("evidence")]) {
        if (control) (control as HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement).disabled = value
      }
    },
    finish(receipt) { close(receipt) },
    destroy() {
      close(undefined, false)
      for (const event of captureEvents) document.removeEventListener(event, capture)
      window.removeEventListener("scroll", dismissFloat, true)
      window.removeEventListener("resize", dismissFloat)
      float.removeEventListener("pointerdown", preserveSelection)
      float.removeEventListener("click", useSelection)
      float.remove()
      entry.removeEventListener("click", explain)
      cancel.removeEventListener("click", onCancel)
      form.removeEventListener("input", onInput)
      form.removeEventListener("keydown", onKey)
      for (const { block, pencil, className, click } of controls) {
        pencil.removeEventListener("click", click)
        pencil.remove()
        if (className === null) block.removeAttribute("class")
        else block.setAttribute("class", className)
      }
      for (const receipt of receipts) receipt.remove()
    },
  }
}

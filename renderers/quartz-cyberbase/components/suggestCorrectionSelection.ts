// Quartz renders the source-backed page body in an article. Do not capture
// navigation, sidebars or form controls, even if a layout nests them in it.
const EXCLUDED = "form, nav, aside, .sidebar, .suggest-correction"

/** Selection is only a quote convenience, never a rendered-to-source mapper. */
export function setupSuggestionSelection(form: HTMLFormElement): () => void {
  const quote = form.elements.namedItem("quote")
  const details = form.closest("details")
  const summary = details?.querySelector("summary")
  const useSelection = form.querySelector<HTMLButtonElement>(".suggest-correction-use-selection")
  const hint = form.querySelector<HTMLElement>(".suggest-correction-selection-hint")
  if (!(quote instanceof HTMLTextAreaElement) || !details || !summary || !useSelection || !hint) return () => {}

  let lastSelection = ""
  const capture = () => {
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return
    const text = selection.toString().trim().replace(/\s+/gu, " ")
    if (!text) return
    const article = document.querySelector("article")
    for (let index = 0; index < selection.rangeCount; index++) {
      const range = selection.getRangeAt(index)
      const ancestor = range.commonAncestorContainer
      const element = ancestor instanceof Element ? ancestor : ancestor.parentElement
      if (!article || !article.contains(ancestor) || element?.closest(EXCLUDED)
        || Array.from(article.querySelectorAll(EXCLUDED)).some((node) => range.intersectsNode(node))) {
        lastSelection = ""
        return
      }
    }
    // Keep only bounded state. An over-length sentinel still lets the form
    // explain why it did not fill, without retaining an arbitrarily large quote.
    lastSelection = text.length > quote.maxLength ? text.slice(0, quote.maxLength + 1) : text
  }
  const fill = (explicit = false) => {
    capture()
    if (!explicit && quote.value !== "") return
    if (lastSelection.length > quote.maxLength) {
      hint.textContent = "Selected text is too long. Select a shorter passage."
    } else if (lastSelection !== "") {
      quote.value = lastSelection
      hint.textContent = "Selected text added. Check the quote before sending."
    } else if (explicit) {
      hint.textContent = "Select text in the page article first."
    }
  }
  const onOpen = () => { if (details.open) fill() }
  const onSummaryClick = () => { if (!details.open) fill() }
  const onUseSelection = () => fill(true)
  // Preserve the last article selection when focusing/opening the form clears
  // the browser's current selection. Capture phase runs before control handlers.
  const captureEvents = ["selectionchange", "pointerup", "keyup", "pointerdown"] as const
  for (const event of captureEvents) document.addEventListener(event, capture, true)
  details.addEventListener("toggle", onOpen)
  summary.addEventListener("click", onSummaryClick)
  useSelection.addEventListener("click", onUseSelection)

  return () => {
    lastSelection = ""
    for (const event of captureEvents) document.removeEventListener(event, capture, true)
    details.removeEventListener("toggle", onOpen)
    summary.removeEventListener("click", onSummaryClick)
    useSelection.removeEventListener("click", onUseSelection)
  }
}

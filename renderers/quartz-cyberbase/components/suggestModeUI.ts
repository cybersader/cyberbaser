/** Presentation only. No source mapping, draft data or submission authority. */
export const suggestingHintKey = "cyberbaser:suggesting:hint-dismissed:v1"
function el<K extends keyof HTMLElementTagNameMap>(tag: K, text: string, className: string) {
  const node = document.createElement(tag); node.textContent = text; node.className = className
  return node
}
export function createSuggestModeUI(entry: HTMLButtonElement, onToggle: () => void, onReview: () => void, finishLabel = "Send") {
  const toolbar = el("div", "", "cb-suggest-toolbar")
  toolbar.setAttribute("role", "toolbar"); toolbar.setAttribute("aria-label", finishLabel === "Save" ? "Editing controls" : "Suggestion controls")
  const mode = el("span", finishLabel === "Save" ? "Editing" : "Suggesting", "cb-suggest-mode")
  const toggle = el("button", "Cancel", "cb-suggest-toggle")
  toggle.type = "button"; toggle.setAttribute("aria-pressed", "false"); toggle.setAttribute("aria-label", finishLabel === "Save" ? "Cancel editing" : "Cancel suggesting")
  const count = el("button", "0 changes", "cb-suggest-review")
  count.type = "button"; count.setAttribute("aria-expanded", "false")
  const review = el("button", `${finishLabel} · 0`, "cb-suggest-send-review")
  review.type = "button"
  const markdown = el("button", "Markdown", "cb-suggest-markdown")
  const undo = el("button", "↶", "cb-suggest-undo"), redo = el("button", "↷", "cb-suggest-redo")
  for (const [button, name] of [[undo, "Undo"], [redo, "Redo"]] as const) {
    button.type = "button"; button.setAttribute("aria-label", name); button.title = name; button.disabled = true
  }
  markdown.type = "button"; markdown.disabled = true; markdown.title = "Place the caret in a block to edit its Markdown"
  toolbar.append(mode, undo, redo, markdown, count)
  const finish = el("div", "", "cb-suggest-finish")
  finish.setAttribute("role", "group"); finish.setAttribute("aria-label", "Finish editing")
  finish.append(toggle, review)
  const hint = el("aside", "", "cb-suggest-help")
  hint.append(el("p", "Tap text to edit.", ""))
  const dismiss = el("button", "Got it", "cb-suggest-hint-dismiss")
  dismiss.type = "button"; hint.append(dismiss)
  let dismissed = false
  try { dismissed = localStorage.getItem(suggestingHintKey) === "1" } catch { /* optional storage */ }
  let enabled = false, expanded = false
  const tray = el("aside", "", "cb-suggest-tray")
  tray.setAttribute("aria-label", "Your suggestion cards")
  const trayHeading = el("div", "", "cb-suggest-tray-heading")
  const title = el("strong", "Your changes", "")
  const collapse = el("button", "Close changes", "cb-suggest-tray-close")
  collapse.type = "button"; trayHeading.append(title, collapse)
  const cards = el("div", "", "cb-suggest-cards")
  tray.append(trayHeading, cards)
  const syncTray = () => {
    count.setAttribute("aria-expanded", String(expanded))
    tray.classList.toggle("cb-suggest-tray-expanded", expanded)
    tray.classList.toggle("cb-suggest-bottom-tray", window.innerWidth <= 800)
    tray.hidden = !enabled
  }
  const showCards = () => { expanded = !expanded; syncTray() }
  const closeCards = () => { expanded = false; syncTray(); count.focus({ preventScroll: true }) }
  const dismissHint = () => {
    dismissed = true; hint.hidden = true
    try { localStorage.setItem(suggestingHintKey, "1") } catch { /* optional storage */ }
  }
  const enter = () => onToggle()
  entry.addEventListener("click", enter); toggle.addEventListener("click", onToggle)
  count.addEventListener("click", showCards); review.addEventListener("click", onReview)
  collapse.addEventListener("click", closeCards); dismiss.addEventListener("click", dismissHint)
  window.addEventListener("resize", syncTray)
  document.body.append(toolbar, finish, hint, tray)
  return {
    toolbar, finish, toggle, count, review, tray, cards, hint, markdown, undo, redo,
    setMode(on: boolean) {
      if (on && !enabled) expanded = window.innerWidth >= 1400
      enabled = on; entry.hidden = on; toolbar.hidden = !on; finish.hidden = !on; hint.hidden = true
      toggle.setAttribute("aria-pressed", String(on))
      if (!on) expanded = false
      syncTray()
    },
    setCount(n: number) { review.textContent = `${finishLabel} · ${n}`; count.textContent = `${n} change${n === 1 ? "" : "s"}`; review.disabled = !n; title.textContent = `Your changes (${n})`; tray.classList.toggle("cb-suggest-tray-empty", n === 0) },
    destroy() {
      entry.hidden = false
      entry.removeEventListener("click", enter); toggle.removeEventListener("click", onToggle)
      count.removeEventListener("click", showCards); review.removeEventListener("click", onReview)
      collapse.removeEventListener("click", closeCards); dismiss.removeEventListener("click", dismissHint)
      window.removeEventListener("resize", syncTray)
      toolbar.remove(); finish.remove(); hint.remove(); tray.remove()
    },
  }
}
/** Reveal a single chip, without adding flow-layout controls below every block. */
export function activeSourceBlock(blocks: { host: HTMLElement; button: HTMLButtonElement }[], onActive?: (button: HTMLButtonElement) => void) {
  let active: (typeof blocks)[number] | undefined
  return (target?: Node | null) => {
    const next = target ? blocks.find(({ host, button }) => host === target || button === target || host.contains(target)) : undefined
    // Browser selectionchange may report the article itself after focus or layout.
    // It must not erase the block just activated by a deliberate tap.
    if (target && !next) return
    if (next === active) return
    if (active) { active.button.hidden = true; active.host.classList.remove("cb-source-active") }
    active = next
    if (active) { active.button.hidden = active.button.disabled; active.host.classList.add("cb-source-active"); onActive?.(active.button) }
  }
}

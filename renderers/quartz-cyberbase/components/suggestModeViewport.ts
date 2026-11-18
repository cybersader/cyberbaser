/** Touch editing top-anchors finish controls on focus, without trusting Safari's keyboard
 * measurements. Viewport geometry only improves sheet sizing and caret scrolling.
 * Presentation and scrolling only: this controller never changes the draft. */
export function setupSuggestViewport(root: HTMLElement, form: HTMLFormElement, tray: HTMLElement) {
  const viewport = window.visualViewport
  const coarse = () => window.matchMedia?.("(pointer: coarse)").matches ?? false
  const touch = () => coarse() || (window.matchMedia?.("(hover: none)").matches ?? false)
  const editing = (element: HTMLElement | null) => !!element
    && (element === root || element.matches("input, textarea, [contenteditable='true']"))
    && (root.contains(element) || form.contains(element) || tray.contains(element))
  let frame = 0, blurTimer = 0, settleTimer = 0, destroyed = false
  const properties = ["--cb-suggest-visible-top", "--cb-suggest-visible-height", "--cb-suggest-keyboard-bottom"]
  const debug = new URLSearchParams(window.location.search).get("cbdebug") === "viewport" ? document.createElement("pre") : null
  if (debug) {
    debug.className = "cb-suggest-viewport-debug"
    debug.style.cssText = "position:fixed;top:8px;left:8px;z-index:2147483647;max-width:calc(100vw - 16px);margin:0;padding:8px;background:rgba(0,0,0,.88);color:#fff;font:12px/1.4 monospace;white-space:pre-wrap;overflow-wrap:anywhere;pointer-events:none;border-radius:4px;"
    debug.setAttribute("aria-hidden", "true")
    document.body.append(debug)
  }
  const showDebug = () => {
    if (!debug) return
    const active = document.activeElement as HTMLElement | null
    debug.textContent = `innerHeight: ${window.innerHeight}\nvisualViewport.height: ${viewport?.height ?? "n/a"}\nvisualViewport.offsetTop: ${viewport?.offsetTop ?? "n/a"}\nvisualViewport.scale: ${viewport?.scale ?? "n/a"}\nactiveElement: ${active?.tagName ?? "none"}.${active?.className ?? ""}\npointer coarse: ${coarse()}\nhover none: ${window.matchMedia?.("(hover: none)").matches ?? false}\nfinish top-anchored: ${document.body.classList.contains("cb-suggest-keyboard-open")}`
  }
  const clear = () => {
    document.body.classList.remove("cb-suggest-keyboard-open")
    for (const property of properties) document.body.style.removeProperty(property)
  }
  const update = () => {
    frame = 0
    if (destroyed) return
    const focused = document.activeElement as HTMLElement | null
    const isEditing = editing(focused)
    const mode = root.classList.contains("cb-suggesting")
    // Focus is the primary rule, even if WebKit never reports a smaller viewport.
    // Retain the top-anchored state briefly while focus moves between our controls.
    const hidden = mode && touch() && (isEditing || (!!blurTimer && document.body.classList.contains("cb-suggest-keyboard-open")))
    if (hidden) {
      document.body.classList.add("cb-suggest-keyboard-open")
      const layoutHeight = Math.max(document.documentElement.clientHeight, window.innerHeight)
      const top = viewport?.offsetTop ?? 0, height = viewport?.height ?? window.innerHeight
      document.body.style.setProperty(properties[0], `${top}px`)
      document.body.style.setProperty(properties[1], `${height}px`)
      document.body.style.setProperty(properties[2], `${Math.max(0, layoutHeight - top - height)}px`)
    } else clear()
    showDebug()
    if (!mode || !isEditing || !viewport || viewport.scale > 1.05) return
    const layoutHeight = Math.max(document.documentElement.clientHeight, window.innerHeight)
    // On fine-pointer desktops, ignore ordinary browser chrome/zoom changes.
    if (!touch() && layoutHeight - viewport.height <= Math.max(140, layoutHeight * 0.2)) return
    const container = form.contains(focused) ? form : tray.contains(focused) ? tray : null
    const activeBlock = focused === root ? root.querySelector<HTMLElement>(".cb-source-active") : null
    let rect = (activeBlock ?? focused!).getBoundingClientRect()
    if (!container) {
      const selection = window.getSelection()
      if (selection?.rangeCount && root.contains(selection.focusNode)) {
        const caret = selection.getRangeAt(0).cloneRange(); caret.collapse(false)
        const caretRect = caret.getBoundingClientRect()
        if (caretRect.height) rect = caretRect
      }
    }
    const top = viewport.offsetTop + (hidden && !container ? 112 : 16), bottom = viewport.offsetTop + viewport.height - 24
    const delta = rect.height > bottom - top ? rect.top - top
      : rect.bottom > bottom ? rect.bottom - bottom : rect.top < top ? rect.top - top : 0
    if (Math.abs(delta) > 1) {
      if (container) container.scrollTop += delta
      else window.scrollBy({ top: delta, behavior: "instant" })
    }
  }
  const refresh = () => { if (!frame && !destroyed) frame = requestAnimationFrame(update) }
  const settle = () => {
    window.clearTimeout(settleTimer)
    settleTimer = window.setTimeout(() => {
      settleTimer = 0
      const focused = document.activeElement as HTMLElement | null
      if (destroyed || !touch() || !root.classList.contains("cb-suggesting") || !editing(focused)) return
      const target = focused === root ? root.querySelector<HTMLElement>(".cb-source-active") : focused
      target?.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" })
      refresh()
    }, 350)
  }
  const onFocusIn = () => {
    if (editing(document.activeElement as HTMLElement | null)) {
      window.clearTimeout(blurTimer); blurTimer = 0
      if (touch()) settle()
    }
    refresh()
  }
  const onFocusOut = () => {
    window.clearTimeout(blurTimer); window.clearTimeout(settleTimer); settleTimer = 0
    blurTimer = window.setTimeout(() => { blurTimer = 0; refresh() }, 180)
    refresh()
  }
  const onSelection = () => { refresh(); if (touch() && editing(document.activeElement as HTMLElement | null)) settle() }
  viewport?.addEventListener("resize", refresh); viewport?.addEventListener("scroll", refresh)
  window.addEventListener("resize", refresh); window.addEventListener("scroll", refresh)
  document.addEventListener("focusin", onFocusIn); document.addEventListener("focusout", onFocusOut)
  document.addEventListener("selectionchange", onSelection)
  refresh()
  return {
    refresh,
    destroy() {
      destroyed = true; cancelAnimationFrame(frame)
      window.clearTimeout(blurTimer); window.clearTimeout(settleTimer)
      viewport?.removeEventListener("resize", refresh); viewport?.removeEventListener("scroll", refresh)
      window.removeEventListener("resize", refresh); window.removeEventListener("scroll", refresh)
      document.removeEventListener("focusin", onFocusIn); document.removeEventListener("focusout", onFocusOut)
      document.removeEventListener("selectionchange", onSelection)
      clear(); debug?.remove()
    },
  }
}

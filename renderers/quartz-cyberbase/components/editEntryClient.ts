/** Reading-only motion feedback. No navigation, draft or authority changes. */
export function setupEditEntryScroll() {
  const entries = [...document.querySelectorAll<HTMLElement>(".cb-edit-entry")]
  if (!entries.length) return () => {}
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)")
  let lastY = window.scrollY, timer = 0
  const restore = () => {
    window.clearTimeout(timer)
    for (const entry of entries) entry.classList.remove("cb-edit-scrolling-down")
  }
  const onScroll = () => {
    const y = window.scrollY, down = y > lastY
    lastY = y
    if (reduced.matches || !down) { restore(); return }
    for (const entry of entries) entry.classList.add("cb-edit-scrolling-down")
    window.clearTimeout(timer)
    timer = window.setTimeout(restore, 240)
  }
  window.addEventListener("scroll", onScroll, { passive: true })
  reduced.addEventListener("change", restore)
  return () => {
    restore()
    window.removeEventListener("scroll", onScroll)
    reduced.removeEventListener("change", restore)
  }
}

// Copy Markdown: puts the note's raw source on the clipboard. The URL is the
// build-pinned raw link, so the copy matches the page that is showing.
// Safari only allows clipboard writes inside the tap, so the fetch is handed to
// ClipboardItem as a promise instead of awaited first.
async function copyMarkdown(button: HTMLButtonElement) {
  const url = button.dataset.cbCopyMarkdown
  if (!url) return
  const label = button.querySelector<HTMLElement>(".cb-note-action-label") ?? button
  const original = button.dataset.cbLabel ?? label.textContent ?? "Copy Markdown"
  button.dataset.cbLabel = original
  const done = (text: string) => {
    label.textContent = text
    setTimeout(() => { label.textContent = original }, 2000)
  }
  const text = () => fetch(url, { credentials: "omit" }).then(response => {
    if (!response.ok) throw new Error(String(response.status))
    return response.text()
  })
  try {
    if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
      await navigator.clipboard.write([new ClipboardItem({ "text/plain": text().then(value => new Blob([value], { type: "text/plain" })) })])
    } else if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(await text())
    } else {
      // Plain-HTTP private sites have no Clipboard API. The legacy copy command
      // still works while the tap's user activation lasts.
      const value = await text()
      const area = document.createElement("textarea")
      area.value = value
      area.setAttribute("readonly", "")
      area.style.cssText = "position:fixed;top:0;left:0;opacity:0"
      document.body.append(area)
      area.select()
      const copied = document.execCommand("copy")
      area.remove()
      if (!copied) throw new Error("copy refused")
    }
    done("Copied")
  } catch {
    // Clipboard blocked or offline: open the raw file so the reader can still copy it.
    done("Opening raw…")
    window.open(url, "_blank", "noopener")
  }
}

document.addEventListener("nav", () => {
  for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-cb-copy-markdown]")) {
    const onClick = () => void copyMarkdown(button)
    button.addEventListener("click", onClick)
    window.addCleanup(() => button.removeEventListener("click", onClick))
  }
})

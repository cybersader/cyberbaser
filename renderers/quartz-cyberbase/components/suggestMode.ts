import { createFinishAction } from "./suggestModeFinish"
import { SuggestHistory, changeContext } from "./suggestModeHistory"
import { setupSuggestViewport } from "./suggestModeViewport"
import { createSuggestModeUI, activeSourceBlock } from "./suggestModeUI"
import { SparseRun, sortedOperations, verifiedLeafNode, verifiedBlockNode, verifyManifest, utf8, validateOperations } from "./suggestModeModel"
import type { Operation, SourceIdentity, ProvenanceBlock } from "./suggestModeModel"
import { buildSuggestionIntent } from "./suggestModeClient"
import { readBoundedJsonResponse, retryIdempotencyKey, parseRetryState } from "./suggestCorrectionClient"
import { setupSuggestionChallenge } from "./suggestCorrectionChallenge"
import type { SuggestionChallenge } from "./suggestCorrectionChallenge"

import { loadSourceEditor, localOperations, sourceOperations, touchesBlock } from "./sourceEditor"
import type { SourceEditorSession } from "./sourceEditor"

interface RunView { model: SparseRun; host: HTMLElement; html: string }
interface Point { view: RunView; offset: number }
const cannotEdit = "This text cannot be safely edited here. Choose a smaller plain-text range."
function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string) {
  const el = document.createElement(tag)
  if (text !== undefined) el.textContent = text
  if (className) el.className = className
  return el
}
/** Empty style attributes carry no source/rendered-text identity. Screenshot caret
 * cleanup (and browser tools) can leave style="" on noneditable deletion marks.
 * Canonicalize that one no-op only; retain every tag, text, locator and nonempty
 * attribute so real source-view mutations still fail closed.
 */
export function renderedRunSnapshot(host: HTMLElement): string {
  if (![...host.querySelectorAll("[style]")].some(node => node.getAttribute("style") === "")) return host.innerHTML
  const copy = host.cloneNode(true) as HTMLElement
  for (const node of copy.querySelectorAll("[style]")) if (node.getAttribute("style") === "") node.removeAttribute("style")
  return copy.innerHTML
}
function stored(key: string) { try { return sessionStorage.getItem(key) } catch { return null } }
function store(key: string, value: string | null) { try { if (value === null) sessionStorage.removeItem(key); else sessionStorage.setItem(key, value) } catch { /* storage is optional */ } }

/** Probe before installing the legacy editor. Missing/stale sidecars leave the original DOM untouched. */
export async function setupSuggestMode(form: HTMLFormElement): Promise<boolean> {
  if (!form.dataset.sourceIdentity || !form.dataset.provenanceUrl) return false
  const root = document.querySelector<HTMLElement>("article.popover-hint")
  const entry = form.closest(".suggest-correction")?.querySelector<HTMLButtonElement>(".suggest-correction-entry")
  if (!root || !entry) return false
  let destroyed = false
  const abort = new AbortController()
  window.addCleanup(() => { destroyed = true; abort.abort() })
  let manifest
  const probeTimer = setTimeout(() => abort.abort(), 5000)
  try {
    const url = new URL(form.dataset.provenanceUrl, location.href)
    if (url.origin !== location.origin) return false
    const response = await fetch(url, { credentials: "omit", cache: "no-store", redirect: "error", signal: abort.signal })
    if (!response.ok) return false
    manifest = verifyManifest(await readBoundedJsonResponse(response, 8 * 1024 * 1024), JSON.parse(form.dataset.sourceIdentity) as SourceIdentity)
    // Validate every locator before touching any node, including refused leaves.
    for (const leaf of manifest.leaves) verifiedLeafNode(root, leaf)
    for (const block of manifest.blocks ?? []) verifiedBlockNode(root, block)
    const ranges = manifest.leaves.flatMap(leaf => leaf.runs.filter(run => run.kind === "exact").map(run => run.source!)).sort((a, b) => a[0] - b[0])
    if (ranges.some((range, i) => i > 0 && range[0] < ranges[i - 1][1])) return false
  } catch { return destroyed }
  finally { clearTimeout(probeTimer) }
  if (destroyed) return true

  const originals: { marker: Comment; node: Text; hosts: HTMLElement[]; parent: Node; locator: string }[] = []
  const untouched: { node: Text; text: string; parent: Node; locator: string }[] = []
  const refusedParents = new Map<Element, Map<string, string | null>>()
  const views: RunView[] = []
  const blocks = (manifest.blocks ?? []).map(block => ({ block, host: verifiedBlockNode(root, block), button: element("button", "</>", "cb-source-open") }))
  const sourceEdits = new Map<string, Operation[]>()
  const blockContext = new Map(blocks.map(({ block, host }) => {
    const headings = [...root.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6")]
    const heading = headings.filter(h => h === host || !!(h.compareDocumentPosition(host) & Node.DOCUMENT_POSITION_FOLLOWING)).at(-1)?.textContent ?? document.querySelector("h1.article-title")?.textContent ?? "Page introduction"
    return [block.id, { text: host.textContent ?? "", heading }]
  }))
  const viewContext = new Map<string, { blockId: string; offset: number }>()
  let activeBlock: (typeof blocks)[number] | undefined
  let activeSource: { shell: HTMLElement; host: HTMLElement; hidden: HTMLElement["hidden"]; returnTo: HTMLElement; session?: SourceEditorSession; commit?: () => boolean } | undefined
  // Capture all nodes first: replacing an earlier sibling changes childNodes indices.
  const nodes = manifest.leaves.map(leaf => verifiedLeafNode(root, leaf))
  for (let i = 0; i < manifest.leaves.length; i++) {
    const leaf = manifest.leaves[i], node = nodes[i], marker = document.createComment("suggesting source leaf"), hosts: HTMLElement[] = []
    // Never insert HTML wrappers into raw-text elements or MathML. Generated
    // whitespace has no editable surface and must not acquire layout boxes.
    if (leaf.runs.every(run => ["raw-text-element", "math", "generated-whitespace"].includes(run.reason ?? ""))) {
      const parent = node.parentElement!
      untouched.push({ node, text: leaf.text, parent, locator: leaf.parent })
      if (parent !== root && leaf.text.trim() && !refusedParents.has(parent)) {
        refusedParents.set(parent, new Map(["class", "contenteditable", "title", "tabindex", "role", "aria-label"].map(name => [name, parent.getAttribute(name)])))
        parent.classList.add("cb-suggest-unmapped"); parent.setAttribute("contenteditable", "false")
        parent.setAttribute("title", cannotEdit); parent.setAttribute("tabindex", "0"); parent.setAttribute("role", "button"); parent.setAttribute("aria-label", cannotEdit)
      }
      continue
    }
    node.before(marker)
    for (let j = 0; j < leaf.runs.length; j++) {
      const run = leaf.runs[j], text = leaf.text.slice(...run.rendered)
      const host = element("span", text)
      hosts.push(host); node.before(host)
      if (run.kind === "exact" && run.source) {
        const model = new SparseRun(`${i}-${j}`, run.source[0], text)
        host.dataset.cbRun = model.id
        views.push({ model, host, html: "" })
      } else {
        host.className = "cb-suggest-unmapped"; host.contentEditable = "false"
        host.title = `${cannotEdit} (${run.reason ?? "transformed source atom"})`
        host.tabIndex = 0; host.setAttribute("role", "button"); host.setAttribute("aria-label", host.title)
      }
    }
    const parent = node.parentNode!
    node.remove(); originals.push({ marker, node, hosts, parent, locator: leaf.parent })
  }
  for (const view of views) {
    const found = blocks.find(({ host }) => host.contains(view.host))
    if (found) {
      const range = document.createRange(); range.selectNodeContents(found.host); range.setEndBefore(view.host)
      viewContext.set(view.model.id, { blockId: found.block.id, offset: range.toString().length })
    }
  }
  const status = element("p", "", "cb-suggest-status"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite")
  const formStatus = form.querySelector<HTMLElement>(".suggest-correction-status")!
  const finish = createFinishAction(form, manifest.source)
  const ui = createSuggestModeUI(entry, () => onToggle(), () => onReview(), finish.label)
  const markBlock = activeSourceBlock(blocks)
  const positionSourceButton = () => {
    if (!activeBlock) return
    const rect = activeBlock.host.getBoundingClientRect(), coarse = matchMedia("(pointer: coarse)").matches
    const size = coarse ? 44 : 24
    activeBlock.button.style.top = `${rect.top + scrollY - (innerWidth <= 600 ? 8 : coarse ? 10 : 0)}px`
    activeBlock.button.style.left = `${Math.max(4, rect.left + scrollX + (innerWidth <= 600 ? rect.width - size : coarse ? -48 : -38))}px`
  }
  const activateBlock = (target?: Node | null) => {
    const next = target ? blocks.find(({ host }) => host === target || host.contains(target)) : undefined
    if (target && !next) return
    activeBlock = next; markBlock(target); positionSourceButton(); updateSubmit()
  }
  const prompt = element("aside", undefined, "cb-markdown-prompt"); prompt.hidden = true; prompt.contentEditable = "false"
  prompt.setAttribute("role", "dialog"); prompt.setAttribute("aria-label", "Markdown editing")
  const promptText = element("p"), promptEdit = element("button", "Edit Markdown")
  promptEdit.type = "button"; prompt.append(promptText, promptEdit); document.body.append(prompt)
  let promptTarget: HTMLElement | undefined
  const hidePrompt = () => { prompt.hidden = true; promptTarget = undefined }
  const showPrompt = (target: HTMLElement) => {
    const found = blocks.find(({ host }) => host === target || host.contains(target))
    activateBlock(target); promptTarget = target
    const available = !!found?.block.editable
    promptText.textContent = available ? "This part comes from Markdown." : "This block can't be edited here"
    promptEdit.hidden = !available; prompt.hidden = false
    const rect = target.getBoundingClientRect()
    prompt.style.left = `${Math.max(12, Math.min(rect.left, innerWidth - prompt.offsetWidth - 12))}px`
    prompt.style.top = `${Math.max(12, Math.min(rect.bottom + 6, innerHeight - prompt.offsetHeight - 12))}px`
  }
  promptEdit.addEventListener("click", () => { const target = promptTarget; hidePrompt(); if (target) void openSource(target) })
  const viewportUI = setupSuggestViewport(root, form, ui.tray)
  const backdrop = element("div", undefined, "cb-suggest-backdrop"); backdrop.hidden = true
  const formMarker = document.createComment("suggestion review")
  form.before(formMarker); form.classList.add("cb-suggest-review-sheet")
  form.setAttribute("role", "dialog"); form.setAttribute("aria-modal", "true"); form.setAttribute("aria-label", "Review changes")
  document.body.append(backdrop, form, status)
  const heading = element("h2", "Your changes")
  const summary = element("div", undefined, "cb-suggest-summary")
  const editedLabel = form.querySelector("textarea[name='edited']")?.closest("label") as HTMLElement | null
  if (editedLabel) editedLabel.hidden = true
  form.prepend(heading, summary)
  const submit = form.querySelector<HTMLButtonElement>("button[type='submit']")!
  const cancel = form.querySelector<HTMLButtonElement>(".suggest-correction-cancel")!
  cancel.textContent = "Back to editing"
  let enabled = false, busy = false, composing = false, composition: { a: Point; b: Point } | null = null
  let challenge: SuggestionChallenge | undefined
  const comments: Record<string, string> = {}
  const key = `cyberbaser:suggesting:v2:${form.dataset.pageId}:${manifest.source.sha256}`
  const retryKey = `${key}:retry`
  let navigating = false
  if (!finish.needsChallenge) {
    for (const name of ["rationale", "evidence"]) (form.elements.namedItem(name) as HTMLElement)?.closest("label")?.setAttribute("hidden", "")
    form.querySelector<HTMLElement>(".suggest-correction-challenge")?.setAttribute("hidden", "")
    const raw = element("a", "Edit whole file as Markdown", "cb-suggest-raw"); raw.href = finish.rawHref!
    ui.toolbar.append(raw)
  }
  const say = (message: string) => { status.textContent = message; formStatus.textContent = message }
  const operations = () => {
    const ops = [...sortedOperations(views.map(v => v.model)), ...[...sourceEdits.values()].flat()].sort((a, b) => a.start - b.start)
    validateOperations(ops); return ops
  }
  interface Snapshot { operations: Operation[]; comments: Record<string, string>; caret?: { id: string; offset: number } }
  const history = new SuggestHistory<Snapshot>()
  let historyCaret: string | undefined
  const snapshot = (caret = selection()?.a): Snapshot => ({
    operations: operations().map(op => ({ ...op })), comments: { ...comments },
    caret: caret ? { id: caret.view.model.id, offset: caret.offset } : undefined,
  })
  const restoreDraft = (saved: { operations: Operation[]; comments?: Record<string, unknown> }) => {
    const pending = saved.operations.map(op => ({ ...op }))
    sourceEdits.clear()
    for (const view of views) {
      const matching = pending.filter(op => op.operationId.startsWith(`edit-${view.model.id}-`) && op.start >= view.model.start && op.end <= view.model.end)
      view.model.restore(matching)
      for (const op of matching) pending.splice(pending.indexOf(op), 1)
    }
    for (const { block } of blocks) {
      const matching = pending.filter(op => op.operationId.startsWith(`source-${block.id}-`))
      if (matching.length) {
        sourceOperations(block, localOperations(block, matching))
        if (sortedOperations(views.map(v => v.model)).some(op => touchesBlock(op, block))) throw Error("Stored edits mix Markdown and rendered changes")
        sourceEdits.set(block.id, matching)
        for (const op of matching) pending.splice(pending.indexOf(op), 1)
      }
    }
    if (pending.length) throw Error("Stored range is no longer available")
    for (const id of Object.keys(comments)) delete comments[id]
    for (const [id, value] of Object.entries(saved.comments ?? {})) if (typeof value === "string" && value.length <= 2048) comments[id] = value
    operations()
  }
  const travel = (direction: "undo" | "redo", fromToolbar = false) => {
    if (!enabled || busy || activeSource) return
    const saved = history[direction](); if (!saved) return
    restoreDraft(saved)
    const view = views.find(v => v.model.id === saved.caret?.id)
    // A toolbar tap on a touch device must not refocus the page, or iOS reopens the keyboard.
    const keepKeyboardClosed = fromToolbar && document.activeElement !== root && (matchMedia("(pointer: coarse)").matches || matchMedia("(hover: none)").matches)
    render(view && !keepKeyboardClosed ? { view, offset: Math.min(saved.caret!.offset, view.model.currentText.length) } : undefined)
    persist(); say(direction === "undo" ? "Undone." : "Redone.")
    if (!operations().length && !form.hidden) showReview(false)
  }
  const persist = () => store(key, JSON.stringify({ operations: operations(), comments }))
  const updateSubmit = () => {
    const ops = operations(), count = ops.length
    if (activeBlock) activeBlock.button.hidden = !!activeSource || !activeBlock.block.editable
    submit.textContent = finish.reviewLabel
    submit.disabled = busy || !!activeSource || !count || (!!challenge && !challenge.response())
    ui.setCount(count)
    for (const { block, button } of blocks) button.dataset.cbChangeCount = String(ops.filter(op => touchesBlock(op, block)).length)
    ui.markdown.disabled = busy || !!activeSource || !activeBlock?.block.editable
    ui.markdown.title = !activeBlock ? "Place the caret in a block to edit its Markdown" : !activeBlock.block.editable ? "This block can't be edited here" : "Edit Markdown for this block (Ctrl/Cmd+Shift+M)"
    ui.undo.disabled = busy || !!activeSource || !history.canUndo
    ui.redo.disabled = busy || !!activeSource || !history.canRedo
    ui.review.disabled = busy || (activeSource ? !activeSource.session : !count)
  }
  const setMode = (on: boolean) => {
    enabled = on; root.contentEditable = String(on && !busy && !activeSource && form.hidden)
    root.classList.toggle("cb-suggesting", on); root.setAttribute("aria-label", "Page text, suggesting editor")
    if (on) { root.setAttribute("role", "textbox"); root.setAttribute("aria-multiline", "true") }
    else { root.removeAttribute("role"); root.removeAttribute("aria-multiline") }
    ui.setMode(on)
    if (!on) {
      activateBlock(); hidePrompt()
      for (const view of views) { view.host.textContent = view.model.text; view.html = renderedRunSnapshot(view.host) }
      for (const { host } of blocks) host.classList.remove("cb-source-pending")
    }
    viewportUI.refresh()
  }
  const showReview = (show: boolean) => {
    form.hidden = !show; backdrop.hidden = !show
    document.body.classList.toggle("cb-suggest-review-open", show)
    ui.review.setAttribute("aria-expanded", String(show))
    root.contentEditable = String(enabled && !busy && !activeSource && !show)
    if (show && finish.needsChallenge && !challenge) challenge = setupSuggestionChallenge(form, submit, say, () => !busy && operations().length > 0)
    updateSubmit(); viewportUI.refresh()
    if (show) cancel.focus({ preventScroll: true })
    else if (enabled) ui.review.focus({ preventScroll: true })
  }
  const reviewKeys = (event: KeyboardEvent) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); showReview(false) }
    if (event.key === "Tab") {
      const items = [...form.querySelectorAll<HTMLElement>("button:not([disabled]), input, textarea:not([name='edited']), iframe, [tabindex='0']")].filter(item => !item.closest("[hidden]"))
      const first = items[0], last = items.at(-1)
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
  }
  const renderCards = () => {
    ui.cards.replaceChildren(); summary.replaceChildren()
    const ops = operations()
    if (!ops.length) summary.append(element("p", "No pending suggestions. Return to the page to make a change."))
    for (const op of ops) {
      const view = views.find(v => v.model.operations().some(item => item.operationId === op.operationId))
      const mapped = view && viewContext.get(view.model.id)
      const source = [...sourceEdits.entries()].find(([, items]) => items.some(item => item.operationId === op.operationId))
      const blockId = mapped?.blockId ?? source?.[0]
      const context = blockId ? blockContext.get(blockId) : undefined
      let text = context?.text ?? view?.model.text ?? "", start = 0
      if (view) start = (mapped?.offset ?? 0) + new TextDecoder().decode(utf8(view.model.text).slice(0, op.start - view.model.start)).length
      else {
        start = op.expected ? text.indexOf(op.expected) : -1
        // A syntax-only operation has no rendered quote. Use only the already
        // safety-approved published Markdown, never fetch omitted source.
        if (start < 0 || (!op.expected && source)) {
          const block = blocks.find(item => item.block.id === blockId)?.block
          text = block?.text ?? ""; start = block ? new TextDecoder().decode(utf8(text).slice(0, op.start - block.source[0])).length : 0
        }
      }
      const around = changeContext(text, start, start + op.expected.length)
      const makeCard = (withComment: boolean, review = false) => {
        const card = element("section", undefined, review ? "cb-suggest-review-card" : "cb-suggest-card"); card.dataset.operationId = op.operationId
        card.append(element("small", context?.heading ?? "Page introduction", "cb-suggest-section"))
        if (source) card.append(element("small", "Markdown edit", review ? "cb-suggest-review-badge" : "cb-source-badge"))
        const line = element("div", undefined, "cb-suggest-context"); line.append(document.createTextNode(around.before))
        if (op.expected) line.append(element("del", op.expected))
        if (op.replacement) line.append(element("ins", op.replacement))
        line.append(document.createTextNode(around.after)); card.append(line)
        const remove = element("button", "Remove"); remove.type = "button"
        remove.addEventListener("click", () => {
          if (busy || activeSource) return
          const before = snapshot()
          if (source) sourceEdits.set(source[0], source[1].filter(item => item.operationId !== op.operationId))
          else view!.model.discard(op)
          delete comments[op.operationId]
          history.record(before, snapshot()); render(); persist()
          if (!operations().length && !form.hidden) showReview(false)
        })
        if (withComment) {
          const comment = element("textarea"); comment.value = comments[op.operationId] ?? ""; comment.placeholder = "Add a comment (optional)"
          comment.maxLength = 2048; comment.setAttribute("aria-label", `Comment on ${op.operationId}`)
          comment.addEventListener("input", () => { comments[op.operationId] = comment.value; persist() })
          card.append(comment)
        }
        card.append(remove); return card
      }
      ui.cards.append(makeCard(finish.needsChallenge)); summary.append(makeCard(false, true))
    }
    updateSubmit()
  }
  const restore = (point?: Point) => {
    if (!point || !enabled) return
    const parts = [...point.view.host.querySelectorAll<HTMLElement>("[data-cb-view]")]
    const part = parts.find(el => +el.dataset.cbView! <= point.offset && +el.dataset.cbView! + el.textContent!.length >= point.offset)
    if (!part?.firstChild) return
    const range = document.createRange(); range.setStart(part.firstChild, point.offset - +part.dataset.cbView!); range.collapse(true)
    root.focus({ preventScroll: true }); const selection = getSelection(); selection?.removeAllRanges(); selection?.addRange(range)
  }
  const render = (caret?: Point) => {
    for (const view of views) {
      const { model, host } = view
      host.replaceChildren(); let byte = model.start, position = 0
      const append = (text: string, tag: "span" | "ins" | "del") => {
        const part = element(tag, text)
        if (tag === "del") part.contentEditable = "false"
        else { part.dataset.cbView = String(position); position += text.length; if (!text) part.append(document.createTextNode("")) }
        host.append(part)
      }
      const slice = (a: number, b: number) => new TextDecoder("utf-8", { fatal: true }).decode(utf8(model.text).slice(a - model.start, b - model.start))
      for (const op of model.operations()) {
        append(slice(byte, op.start), "span")
        if (op.expected) append(op.expected, "del")
        if (op.replacement) append(op.replacement, "ins")
        byte = op.end
      }
      append(slice(byte, model.end), "span"); view.html = renderedRunSnapshot(host)
    }
    for (const { block, host, button } of blocks) {
      const pending = !!sourceEdits.get(block.id)?.length
      host.classList.toggle("cb-source-pending", pending)
      button.textContent = "</>"
    }
    renderCards(); restore(caret)
  }
  const validDom = () => {
    const locators = new Map<string, HTMLElement[]>()
    locators.set("$body", [root])
    for (const parent of root.querySelectorAll<HTMLElement>("[data-cb-node]")) {
      const id = parent.dataset.cbNode!
      locators.set(id, [...(locators.get(id) ?? []), parent])
    }
    for (let i = 0; i < originals.length; i++) {
      const { marker, hosts, parent, locator } = originals[i]
      if (marker.parentNode !== parent || !root.contains(marker)) return false
      let previous: Node = marker
      for (const host of hosts) { if (previous.nextSibling !== host) return false; previous = host }
      const matches = locators.get(locator) ?? []
      if (matches.length !== 1 || matches[0] !== parent) return false
    }
    for (const { node, text, parent, locator } of untouched) {
      const matches = locators.get(locator) ?? []
      if (node.parentNode !== parent || node.data !== text || matches.length !== 1 || matches[0] !== parent) return false
    }
    return views.every(view => renderedRunSnapshot(view.host) === view.html) && blocks.every(({ block, host }) => {
      try { return verifiedBlockNode(root, block) === host } catch { return false }
    })
  }
  const closeSource = (focus = true) => {
    if (!activeSource) return
    const current = activeSource; activeSource = undefined
    current.session?.destroy(); current.shell.remove(); current.host.hidden = current.hidden
    if (!destroyed) {
      setMode(enabled); updateSubmit()
      if (focus) current.returnTo.focus({ preventScroll: true })
    }
  }
  const openSource = async (target: HTMLElement) => {
    if (!enabled || busy || activeSource) return
    hidePrompt(); history.breakGroup()
    const found = blocks.find(({ host, button }) => button === target || host === target || host.contains(target))
    if (!found) { say(cannotEdit); return }
    const { block, host, button } = found
    if (!block.editable) { say(`Source editing unavailable: ${block.reason ?? "unpublished source"}. This block stays unchanged.`); return }
    if (!validDom()) { say("The page structure changed. Reload this page before editing."); return }
    if (sortedOperations(views.map(v => v.model)).some(op => touchesBlock(op, block))) {
      say("Discard the rendered-text edits in this block to edit its source."); return
    }
    if (!form.dataset.sourceEditorAsset) { say("Source editing is unavailable in this build."); return }
    const shell = element("section", undefined, "cb-source-editor")
    shell.contentEditable = "false"; shell.setAttribute("aria-label", "Editing Markdown")
    const title = element("strong", "Editing Markdown")
    const mount = element("div", undefined, "cb-source-mount")
    const error = element("p", "Loading Markdown editor…", "cb-source-status"); error.setAttribute("role", "status"); error.setAttribute("aria-live", "polite")
    const done = element("button", "Done", "cb-source-done"), cancelSource = element("button", "Cancel", "cb-source-cancel")
    done.type = cancelSource.type = "button"; done.disabled = true
    shell.append(title, mount, error, done, cancelSource)
    const current = { shell, host, hidden: host.hidden, returnTo: target.closest<HTMLElement>("[tabindex],button") ?? button, session: undefined as SourceEditorSession | undefined, commit: undefined as (() => boolean) | undefined }
    activeSource = current; host.hidden = true; host.after(shell); root.contentEditable = "false"; updateSubmit()
    cancelSource.addEventListener("click", () => { closeSource(); say("Markdown edits cancelled. The pending suggestion is unchanged.") })
    shell.addEventListener("keydown", event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeSource() } })
    current.commit = () => {
      if (!current.session || activeSource !== current) return false
      try {
        if (!validDom()) throw Error("The page structure changed. Cancel and reload before editing.")
        const next = sourceOperations(block, current.session.operations())
        const merged = [...operations().filter(op => !sourceEdits.get(block.id)?.includes(op)), ...next].sort((a, b) => a.start - b.start)
        validateOperations(merged)
        const before = snapshot()
        sourceEdits.set(block.id, next)
        if (JSON.stringify(before.operations) !== JSON.stringify(operations())) history.record(before, snapshot())
        closeSource(); render(); persist(); say(next.length ? "Markdown edit added." : "No Markdown changes.")
        return true
      } catch (failure) { error.textContent = failure instanceof Error ? failure.message : "Could not record source changes."; return false }
    }
    done.addEventListener("click", () => current.commit?.())
    cancelSource.focus({ preventScroll: true })
    try {
      const editor = await loadSourceEditor(form.dataset.sourceEditorAsset)
      if (destroyed || activeSource !== current) return
      current.session = editor.mount(mount, { text: block.text!, operations: localOperations(block, sourceEdits.get(block.id) ?? []), label: "Markdown source for this block", onError: message => { error.textContent = message } })
      error.textContent = ""; done.disabled = false; updateSubmit(); current.session.focus()
    } catch (failure) { if (activeSource === current) error.textContent = failure instanceof Error ? failure.message : "Could not open the source editor." }
  }
  for (const { block, host, button } of blocks) {
    button.disabled = !block.editable
    button.title = "Edit Markdown for this block"; button.setAttribute("aria-label", button.title)
    button.type = "button"; button.contentEditable = "false"; button.hidden = true
    button.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); void openSource(button) })
    document.body.append(button)
  }
  const point = (node: Node, offset: number): Point | null => {
    if (!root.contains(node)) return null
    if (node.nodeType === 1) {
      const child = node.childNodes[offset] ?? node.childNodes[offset - 1]
      if (!child) return null
      const walker = document.createTreeWalker(child, NodeFilter.SHOW_TEXT)
      const text = child.nodeType === 3 ? child : walker.nextNode()
      return text ? point(text, offset >= node.childNodes.length ? text.textContent!.length : 0) : null
    }
    const part = node.parentElement?.closest<HTMLElement>("[data-cb-view]")
    const view = views.find(v => v.host === part?.parentElement)
    if (!part || !view || renderedRunSnapshot(view.host) !== view.html || node !== part.firstChild) return null
    return { view, offset: +part.dataset.cbView! + offset }
  }
  const selection = () => {
    const s = getSelection()
    if (!s || s.rangeCount !== 1) return null
    const range = s.getRangeAt(0), a = point(range.startContainer, range.startOffset), b = point(range.endContainer, range.endOffset)
    return a && b && a.view === b.view ? { a, b } : null
  }
  const edit = (value: string, type: string, selected = selection()) => {
    if (!enabled || busy || activeSource) return
    if (!selected || !validDom()) { say(cannotEdit); return }
    const { a, b } = selected, model = a.view.model
    if (blocks.some(({ block }) => sourceEdits.get(block.id)?.length && touchesBlock({ start: model.start, end: model.end } as Operation, block))) {
      say("This block has source edits. Use Edit Markdown to continue, or discard its source edits before editing rendered text."); return
    }
    let start = a.offset, end = b.offset
    const units = (text: string) => [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map(p => p.segment)
    if (start === end && type.includes("Backward")) start -= units(model.currentText.slice(0, start)).at(-1)?.length ?? 0
    if (start === end && type.includes("Forward")) end += units(model.currentText.slice(end))[0]?.length ?? 0
    const previous = model.tokens
    try {
      const before = snapshot(a), old = JSON.stringify(before.operations)
      model.replace(start, end, value); operations()
      const caret = { view: a.view, offset: start + value.length }
      if (old !== JSON.stringify(operations())) history.record(before, snapshot(caret), value && start === end && type === "insertText" ? {
        group: viewContext.get(model.id)?.blockId ?? model.id, start: `${model.id}:${start}`, end: `${model.id}:${caret.offset}`,
      } : undefined)
      historyCaret = `${model.id}:${caret.offset}`
      hidePrompt(); render(caret); persist(); say("")
    } catch (error) { model.tokens = previous; say(error instanceof Error ? error.message : cannotEdit) }
  }
  const beforeInput = (event: InputEvent) => {
    if (!enabled || activeSource || (event.target as Element).closest(".cb-source-open")) return
    event.preventDefault()
    if (event.inputType === "historyUndo" || event.inputType === "historyRedo") { travel(event.inputType === "historyUndo" ? "undo" : "redo"); return }
    if (composing) return
    if (["insertText", "insertReplacementText", "insertFromComposition"].includes(event.inputType)) edit(event.data ?? "", event.inputType)
    else if (["insertParagraph", "insertLineBreak"].includes(event.inputType)) edit("\n", event.inputType)
    else if (event.inputType.startsWith("delete")) edit("", event.inputType)
    else say("Only text suggestions are supported here. Use Edit Markdown, when available, to change Markdown syntax.")
  }
  const keydown = (event: KeyboardEvent) => {
    if (!enabled || composing || activeSource || (event.target as Element).closest(".cb-source-open")) return
    if (event.key === "Backspace" || event.key === "Delete") { event.preventDefault(); edit("", event.key === "Backspace" ? "deleteContentBackward" : "deleteContentForward") }
    if ((event.ctrlKey || event.metaKey) && ["b", "i", "u"].includes(event.key.toLowerCase())) { event.preventDefault(); say("Use Edit Markdown to change formatting.") }
    if ((event.key === "Enter" || event.key === " ") && (event.target as HTMLElement).classList.contains("cb-suggest-unmapped")) { event.preventDefault(); showPrompt(event.target as HTMLElement) }
  }
  const click = (event: MouseEvent) => {
    if (!enabled || activeSource) return
    const target = event.target as HTMLElement
    activateBlock(target)
    // Quartz's window SPA handler does not honor defaultPrevented.
    if (target.closest("a")) { event.preventDefault(); event.stopPropagation() }
    const refused = target.closest<HTMLElement>(".cb-suggest-unmapped")
    if (refused || (activeBlock && !activeBlock.block.editable)) { event.preventDefault(); showPrompt(refused ?? target) }
    else hidePrompt()
  }
  const paste = (event: ClipboardEvent) => { if (enabled && !activeSource) { event.preventDefault(); edit(event.clipboardData?.getData("text/plain") ?? "", "insertFromPaste") } }
  const cut = (event: ClipboardEvent) => {
    if (!enabled || activeSource) return
    event.preventDefault()
    const selected = selection()
    if (selected) event.clipboardData?.setData("text/plain", selected.a.view.model.currentText.slice(selected.a.offset, selected.b.offset))
    edit("", "deleteByCut", selected)
  }
  const input = () => {
    if (enabled && !activeSource && !composing && !validDom()) {
      render()
      say(validDom() ? "The browser made an unsupported change. The tracked draft was restored." : "The page structure changed. Reload this page before editing.")
    }
  }
  const drop = (event: DragEvent) => { if (enabled && !activeSource) { event.preventDefault(); say("Paste plain text at the cursor instead of dropping content.") } }
  const compositionStart = () => { if (enabled && !busy && !activeSource) { composing = true; composition = selection() } }
  const compositionEnd = (event: CompositionEvent) => { if (!composing) return; composing = false; render(); edit(event.data, "insertFromComposition", composition); composition = null }
  const cancelSheet = element("dialog", undefined, "cb-cancel-sheet")
  const cancelTitle = element("h2"), discard = element("button", "Discard"), draft = element("button", "Save draft"), keep = element("button", "Keep editing")
  for (const button of [discard, draft, keep]) button.type = "button"
  cancelSheet.setAttribute("aria-label", "Discard changes?")
  cancelSheet.append(cancelTitle, discard, draft, keep); document.body.append(cancelSheet)
  const exit = () => {
    cancelSheet.close(); setMode(false); say("")
    // Keep the immutable ledger locally, but return the reading surface to base.
    for (const view of views) { view.host.textContent = view.model.text; view.html = renderedRunSnapshot(view.host) }
    entry.focus({ preventScroll: true })
  }
  discard.addEventListener("click", () => {
    for (const view of views) view.model.reset()
    sourceEdits.clear(); history.clear()
    for (const id of Object.keys(comments)) delete comments[id]
    store(key, null); store(retryKey, null); store(`${key}:paused`, null); render(); exit()
  })
  draft.addEventListener("click", () => {
    persist()
    if (stored(key) !== JSON.stringify({ operations: operations(), comments })) { say("Draft storage unavailable. Keep editing or discard."); return }
    store(`${key}:paused`, "1"); exit()
  })
  keep.addEventListener("click", () => { cancelSheet.close(); ui.toggle.focus({ preventScroll: true }) })
  const onToggle = () => {
    if (busy) return
    if (activeSource && !activeSource.commit?.()) return
    if (!form.hidden) showReview(false)
    if (enabled && operations().length) {
      (document.activeElement as HTMLElement)?.blur()
      cancelTitle.textContent = `Discard ${operations().length} changes?`
      cancelSheet.showModal(); return
    }
    if (!enabled) { store(`${key}:paused`, null); render() }
    setMode(!enabled); say("")
  }
  const selectionStamp = () => {
    const s = getSelection()
    return [s?.anchorNode, s?.anchorOffset, s?.focusNode, s?.focusOffset] as const
  }
  const onActiveBlock = (event: Event) => {
    if (enabled && !activeSource) {
      activateBlock(event.target as Node)
      const target = event.target as HTMLElement
      if (target.closest(".cb-suggest-unmapped")) showPrompt(target)
    }
  }
  const onSelection = () => {
    const stamp = selectionStamp()
    const node = stamp[0]
    if (enabled && !activeSource) {
      const selected = selection(), next = selected ? `${selected.a.view.model.id}:${selected.a.offset}` : undefined
      if (next !== historyCaret || (selected && selected.a.offset !== selected.b.offset)) history.breakGroup()
      historyCaret = next
    }
    if (enabled && !activeSource && node && root.contains(node)) {
      activateBlock(node)
      const target = node.nodeType === 1 ? node as HTMLElement : node.parentElement
      const refused = target?.closest<HTMLElement>(".cb-suggest-unmapped")
      if (refused) showPrompt(refused)
      else if (promptTarget && !prompt.contains(document.activeElement)) hidePrompt()
    }
  }
  const onReview = () => {
    if (activeSource && !activeSource.commit?.()) return
    if (operations().length) showReview(form.hidden === true)
  }
  const onCancel = () => showReview(false)
  const onSubmit = async (event: SubmitEvent) => {
    event.preventDefault(); if (busy || destroyed || activeSource) return
    try {
      if (!validDom()) throw Error("Rendered text changed. Reload this page before sending.")
      const token = challenge?.response()
      if (challenge && !token) { say("Please complete the human verification before sending."); return }
      const rationale = (form.elements.namedItem("rationale") as HTMLInputElement).value
      const evidence = (form.elements.namedItem("evidence") as HTMLInputElement).value.trim()
      const commentText = operations().map(op => comments[op.operationId] ? `${op.operationId}: ${comments[op.operationId]}` : "").filter(Boolean).join("\n")
      const input = {
        bindingDigest: form.dataset.bindingDigest!, pageId: form.dataset.pageId!, operations: operations(),
        rationale: [rationale.trim(), commentText].filter(Boolean).join("\n"), evidenceText: evidence ? new URL(evidence).href : "",
      }
      const fingerprint = JSON.stringify(input)
      const idempotencyKey = retryIdempotencyKey(fingerprint, parseRetryState(stored(retryKey)), crypto.getRandomValues(new Uint8Array(32)))
      const intent = buildSuggestionIntent({ ...input, idempotencyKey })
      store(retryKey, JSON.stringify({ fingerprint, idempotencyKey }))
      busy = true; root.contentEditable = "false"; challenge?.submitting(); updateSubmit(); say("Sending for owner review…")
      navigating = !finish.needsChallenge
      const result = await finish.submit(intent, token)
      if (!result.navigating) navigating = false
      if (destroyed) return
      if (result.accepted) {
        for (const view of views) view.model.reset()
        sourceEdits.clear(); history.clear()
        for (const id of Object.keys(comments)) delete comments[id]
        store(key, null); store(retryKey, null); form.reset(); render(); showReview(false); setMode(false)
        entry.focus({ preventScroll: true })
      }
      say(result.message)
    } catch (error) { if (!destroyed) { navigating = false; say(error instanceof Error ? error.message : "Could not send. Retry safely.") } }
    finally { busy = false; if (!destroyed) { root.contentEditable = String(enabled && form.hidden); challenge?.reset(); updateSubmit() } }
  }
  try {
    const saved = JSON.parse(stored(key) ?? "null")
    if (saved) {
      if (!Array.isArray(saved.operations) || saved.operations.length > 50) throw Error("Invalid stored suggestions")
      restoreDraft(saved)
      operations()
    }
  } catch { for (const view of views) view.model.reset(); sourceEdits.clear(); store(key, null); say("Stored suggestions could not be restored safely.") }
  const markdown = () => { if (activeBlock) void openSource(activeBlock.host) }
  const undo = () => travel("undo", true), redo = () => travel("redo", true)
  const shortcuts = (event: KeyboardEvent) => {
    if (event.key === "Escape" && !prompt.hidden) { event.preventDefault(); event.stopPropagation(); hidePrompt(); return }
    const target = event.target as HTMLElement
    if (!enabled || busy || activeSource || composing || target.closest("input,textarea,[role='textbox']:not(article),.cm-editor")) return
    if (!(event.ctrlKey || event.metaKey)) return
    const key = event.key.toLowerCase()
    if (key === "m" && event.shiftKey) { event.preventDefault(); markdown() }
    else if (key === "z" || (key === "y" && event.ctrlKey)) { event.preventDefault(); travel(key === "y" || event.shiftKey ? "redo" : "undo") }
  }
  const positionChrome = () => { positionSourceButton(); if (promptTarget && !prompt.hidden) showPrompt(promptTarget) }
  const outsidePrompt = (event: PointerEvent) => { if (!prompt.contains(event.target as Node)) hidePrompt() }
  const unload = (event: BeforeUnloadEvent) => { if (!navigating && enabled && operations().length) { event.preventDefault(); event.returnValue = "" } }
  const leave = element("div", undefined, "cb-leave-guard"); leave.hidden = true
  const leavePanel = element("section"), leaveText = element("p"), stay = element("button", "Stay"), discardLeave = element("button", "Discard and leave")
  stay.type = discardLeave.type = "button"; leavePanel.append(leaveText, stay, discardLeave); leave.append(leavePanel)
  leavePanel.setAttribute("role", "alertdialog"); leavePanel.setAttribute("aria-modal", "true"); leavePanel.setAttribute("aria-label", "Unsent suggestions")
  document.body.append(leave)
  let destination: HTMLAnchorElement | undefined, leaveReturn: HTMLElement | undefined
  const stayHere = () => { leave.hidden = true; destination = undefined; leaveReturn?.focus({ preventScroll: true }) }
  stay.addEventListener("click", stayHere)
  discardLeave.addEventListener("click", () => {
    const target = destination; if (!target) return
    for (const view of views) view.model.reset()
    sourceEdits.clear(); history.clear(); store(key, null); store(retryKey, null)
    leave.hidden = true; destination = undefined; render(); setMode(false)
    // Replay this one approved click. Quartz's existing router retains navigation authority.
    target.click()
  })
  leave.addEventListener("keydown", event => {
    if (event.key === "Escape") { event.preventDefault(); stayHere() }
    if (event.key === "Tab") { event.preventDefault(); (document.activeElement === stay ? discardLeave : stay).focus() }
  })
  const guardNavigation = (event: MouseEvent) => {
    if (!enabled || !operations().length || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    const anchor = (event.target as Element).closest<HTMLAnchorElement>("a[href]")
    if (!anchor || (enabled && root.contains(anchor)) || anchor.target === "_blank" || anchor.hasAttribute("download")) return
    const url = new URL(anchor.href, location.href)
    if (url.origin !== location.origin || (url.pathname === location.pathname && url.search === location.search && url.hash)) return
    // Capture before Quartz's window listener, which does not honor defaultPrevented.
    event.preventDefault(); event.stopPropagation(); hidePrompt()
    destination = anchor; leaveReturn = document.activeElement as HTMLElement
    const n = operations().length; leaveText.textContent = `You have ${n} unsent suggestions. Leave and discard them?`
    leave.hidden = false; stay.focus({ preventScroll: true })
  }
  ui.markdown.addEventListener("click", markdown); ui.undo.addEventListener("click", undo); ui.redo.addEventListener("click", redo)
  document.addEventListener("keydown", shortcuts, true)
  document.addEventListener("pointerdown", outsidePrompt, true)
  document.addEventListener("click", guardNavigation, true)
  window.addEventListener("beforeunload", unload)
  window.addEventListener("resize", positionChrome); window.addEventListener("scroll", positionChrome, true)
  root.addEventListener("beforeinput", beforeInput)
  root.addEventListener("keydown", keydown)
  root.addEventListener("click", click)
  root.addEventListener("paste", paste)
  root.addEventListener("cut", cut)
  root.addEventListener("input", input)
  root.addEventListener("drop", drop)
  root.addEventListener("compositionstart", compositionStart)
  root.addEventListener("compositionend", compositionEnd)
  root.addEventListener("focusin", onActiveBlock)
  document.addEventListener("selectionchange", onSelection)
  cancel.addEventListener("click", onCancel); backdrop.addEventListener("click", onCancel)
  form.addEventListener("keydown", reviewKeys)
  form.addEventListener("submit", onSubmit)
  render(); setMode((operations().length > 0 && stored(`${key}:paused`) !== "1") || ((finish.label === "Save" || location.hash === "#edit") && stored(`${key}:paused`) !== "1"))
  window.addCleanup(() => {
    document.removeEventListener("keydown", shortcuts, true); document.removeEventListener("pointerdown", outsidePrompt, true)
    document.removeEventListener("click", guardNavigation, true); window.removeEventListener("beforeunload", unload)
    window.removeEventListener("resize", positionChrome); window.removeEventListener("scroll", positionChrome, true)
    ui.markdown.removeEventListener("click", markdown); ui.undo.removeEventListener("click", undo); ui.redo.removeEventListener("click", redo)
    prompt.remove(); leave.remove(); cancelSheet.remove()
    destroyed = true; viewportUI.destroy(); challenge?.destroy(); closeSource(false)
    for (const { host, button } of blocks) { button.remove(); host.classList.remove("cb-source-pending", "cb-source-active") }
    root.removeEventListener("beforeinput", beforeInput); root.removeEventListener("keydown", keydown)
    root.removeEventListener("click", click); root.removeEventListener("paste", paste); root.removeEventListener("drop", drop)
    root.removeEventListener("cut", cut); root.removeEventListener("input", input)
    root.removeEventListener("compositionstart", compositionStart); root.removeEventListener("compositionend", compositionEnd)
    root.removeEventListener("focusin", onActiveBlock)
    document.removeEventListener("selectionchange", onSelection)
    cancel.removeEventListener("click", onCancel); backdrop.removeEventListener("click", onCancel)
    form.removeEventListener("keydown", reviewKeys); form.removeEventListener("submit", onSubmit)
    root.removeAttribute("contenteditable"); root.removeAttribute("role"); root.removeAttribute("aria-label"); root.removeAttribute("aria-multiline"); root.classList.remove("cb-suggesting")
    for (const { marker, node, hosts } of originals) { marker.replaceWith(node); hosts.forEach(host => host.remove()) }
    for (const [parent, attrs] of refusedParents) for (const [name, value] of attrs) { if (value === null) parent.removeAttribute(name); else parent.setAttribute(name, value) }
    ui.destroy(); backdrop.remove(); status.remove(); heading.remove(); summary.remove()
    document.body.classList.remove("cb-suggest-review-open")
    formMarker.replaceWith(form); form.hidden = true; form.classList.remove("cb-suggest-review-sheet")
    form.removeAttribute("role"); form.removeAttribute("aria-modal"); form.removeAttribute("aria-label")
    if (editedLabel) editedLabel.hidden = false
  })
  return true
}

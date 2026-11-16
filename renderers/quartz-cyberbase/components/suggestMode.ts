import { SparseRun, sortedOperations, verifiedLeafNode, verifiedBlockNode, verifyManifest, utf8, validateOperations } from "./suggestModeModel"
import type { Operation, SourceIdentity, ProvenanceBlock } from "./suggestModeModel"
import { buildSuggestionIntent, submitSuggestionIntent } from "./suggestModeClient"
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
  const blocks = (manifest.blocks ?? []).map(block => ({ block, host: verifiedBlockNode(root, block), button: element("button", block.editable ? "Edit source" : "Source unavailable", "cb-source-open") }))
  const sourceEdits = new Map<string, Operation[]>()
  let activeSource: { shell: HTMLElement; host: HTMLElement; hidden: HTMLElement["hidden"]; returnTo: HTMLElement; session?: SourceEditorSession } | undefined
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
  const section = form.closest<HTMLElement>(".suggest-correction")!
  const toggle = element("button", "Suggesting", "cb-suggest-toggle")
  toggle.type = "button"; toggle.setAttribute("aria-pressed", "false")
  const review = element("button", "Your changes", "cb-suggest-review")
  review.type = "button"; review.setAttribute("aria-expanded", "false")
  const hint = element("p", "Click to insert. Select and type to replace. Backspace or Delete suggests a deletion. The page stays unchanged until the owner applies it.", "cb-suggest-help")
  hint.hidden = true
  const status = element("p", "", "cb-suggest-status"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite")
  const tray = element("aside", undefined, "cb-suggest-tray"); tray.setAttribute("aria-label", "Your suggestion cards")
  const heading = element("h2", "Your changes")
  const summary = element("div", undefined, "cb-suggest-summary")
  const editedLabel = form.querySelector("textarea[name='edited']")?.closest("label") as HTMLElement | null
  if (editedLabel) editedLabel.hidden = true
  form.prepend(heading, summary)
  const submit = form.querySelector<HTMLButtonElement>("button[type='submit']")!
  const cancel = form.querySelector<HTMLButtonElement>(".suggest-correction-cancel")!
  cancel.textContent = "Close review"
  section.prepend(toggle, review, hint, status)
  document.body.append(tray)
  let enabled = false, busy = false, composing = false, composition: { a: Point; b: Point } | null = null
  let challenge: SuggestionChallenge | undefined
  const comments: Record<string, string> = {}
  const key = `cyberbaser:suggesting:v2:${form.dataset.pageId}:${manifest.source.sha256}`
  const retryKey = `${key}:retry`
  const say = (message: string) => { status.textContent = message }
  const operations = () => {
    const ops = [...sortedOperations(views.map(v => v.model)), ...[...sourceEdits.values()].flat()].sort((a, b) => a.start - b.start)
    validateOperations(ops); return ops
  }
  const persist = () => store(key, JSON.stringify({ operations: operations(), comments }))
  const updateSubmit = () => {
    const count = operations().length
    submit.textContent = `Send ${count} suggestion${count === 1 ? "" : "s"}`
    submit.disabled = busy || !!activeSource || !count || (!!challenge && !challenge.response())
    review.textContent = `Your changes (${count})`
  }
  const setMode = (on: boolean) => {
    enabled = on; root.contentEditable = String(on && !busy && !activeSource)
    root.classList.toggle("cb-suggesting", on); root.setAttribute("aria-label", "Page text, suggesting editor")
    if (on) { root.setAttribute("role", "textbox"); root.setAttribute("aria-multiline", "true") }
    else { root.removeAttribute("role"); root.removeAttribute("aria-multiline") }
    toggle.setAttribute("aria-pressed", String(on)); toggle.textContent = on ? "Suggesting" : "Suggesting: off"
    hint.hidden = !on; tray.hidden = !on
    for (const { button } of blocks) button.hidden = !on
  }
  const showReview = (show: boolean) => {
    form.hidden = !show; review.setAttribute("aria-expanded", String(show))
    if (show && !challenge) challenge = setupSuggestionChallenge(form, submit, say, () => !busy && operations().length > 0)
    updateSubmit()
  }
  const renderCards = () => {
    tray.replaceChildren(); summary.replaceChildren()
    for (const op of operations()) {
      const card = element("section", undefined, "cb-suggest-card")
      card.dataset.operationId = op.operationId
      card.append(element("strong", "You · suggestion"))
      if (op.operationId.startsWith("source-")) card.append(element("small", "Source edit", "cb-source-badge"))
      if (op.expected) card.append(element("del", op.expected))
      if (op.replacement) card.append(element("ins", op.replacement))
      const discard = element("button", "Discard"); discard.type = "button"
      discard.addEventListener("click", () => {
        if (busy || activeSource) return
        const source = [...sourceEdits.entries()].find(([, items]) => items.some(item => item.operationId === op.operationId))
        if (source) sourceEdits.set(source[0], source[1].filter(item => item.operationId !== op.operationId))
        else views.find(v => v.model.operations().some(item => item.operationId === op.operationId))!.model.discard(op)
        delete comments[op.operationId]; render(); persist()
      })
      const comment = element("textarea"); comment.value = comments[op.operationId] ?? ""; comment.placeholder = "Add a comment (optional)"
      comment.maxLength = 2048; comment.setAttribute("aria-label", `Comment on ${op.operationId}`)
      comment.addEventListener("input", () => { comments[op.operationId] = comment.value; persist() })
      card.append(comment, discard); tray.append(card)
      const line = element("p")
      if (op.expected) line.append(element("del", op.expected))
      if (op.replacement) line.append(element("ins", op.replacement))
      summary.append(line)
    }
    updateSubmit(); layout()
  }
  const layout = () => {
    tray.classList.toggle("cb-suggest-bottom-tray", window.innerWidth <= 800)
    if (window.innerWidth > 800) {
      const rect = root.getBoundingClientRect()
      tray.style.left = `${Math.min(rect.right + 16, window.innerWidth - 270)}px`
      tray.style.top = `${Math.max(16, rect.top)}px`
    } else { tray.style.left = ""; tray.style.top = "" }
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
      button.textContent = pending ? "Edit source · pending changes" : block.editable ? "Edit source" : "Source unavailable"
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
    shell.contentEditable = "false"; shell.setAttribute("aria-label", "Editing Markdown source")
    const title = element("strong", "Editing Markdown source")
    const help = element("p", "Edit this block’s exact Markdown. Green additions and red deletions join the same suggestion for owner review.")
    const mount = element("div", undefined, "cb-source-mount")
    const error = element("p", "Loading source editor…", "cb-source-status"); error.setAttribute("role", "status"); error.setAttribute("aria-live", "polite")
    const done = element("button", "Done", "cb-source-done"), cancelSource = element("button", "Cancel", "cb-source-cancel")
    done.type = cancelSource.type = "button"; done.disabled = true
    shell.append(title, help, mount, error, done, cancelSource)
    const current = { shell, host, hidden: host.hidden, returnTo: target.closest<HTMLElement>("[tabindex],button") ?? button, session: undefined as SourceEditorSession | undefined }
    activeSource = current; host.hidden = true; host.after(shell); root.contentEditable = "false"; updateSubmit()
    cancelSource.addEventListener("click", () => { closeSource(); say("Source edits cancelled. The pending suggestion is unchanged.") })
    shell.addEventListener("keydown", event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeSource() } })
    done.addEventListener("click", () => {
      if (!current.session || activeSource !== current) return
      try {
        if (!validDom()) throw Error("The page structure changed. Cancel and reload before editing.")
        const next = sourceOperations(block, current.session.operations())
        const merged = [...operations().filter(op => !sourceEdits.get(block.id)?.includes(op)), ...next].sort((a, b) => a.start - b.start)
        validateOperations(merged)
        sourceEdits.set(block.id, next)
        closeSource(); render(); persist(); say(next.length ? "Source edit added to your pending suggestion." : "This block has no source changes.")
      } catch (failure) { error.textContent = failure instanceof Error ? failure.message : "Could not record source changes." }
    })
    cancelSource.focus({ preventScroll: true })
    try {
      const editor = await loadSourceEditor(form.dataset.sourceEditorAsset)
      if (destroyed || activeSource !== current) return
      current.session = editor.mount(mount, { text: block.text!, operations: localOperations(block, sourceEdits.get(block.id) ?? []), label: "Markdown source for this block", onError: message => { error.textContent = message } })
      error.textContent = ""; done.disabled = false; current.session.focus()
    } catch (failure) { if (activeSource === current) error.textContent = failure instanceof Error ? failure.message : "Could not open the source editor." }
  }
  for (const { host, button } of blocks) {
    button.type = "button"; button.contentEditable = "false"
    button.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); void openSource(button) })
    host.append(button)
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
      say("This block has source edits. Use Edit source to continue, or discard its source edits before editing rendered text."); return
    }
    let start = a.offset, end = b.offset
    const units = (text: string) => [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map(p => p.segment)
    if (start === end && type.includes("Backward")) start -= units(model.currentText.slice(0, start)).at(-1)?.length ?? 0
    if (start === end && type.includes("Forward")) end += units(model.currentText.slice(end))[0]?.length ?? 0
    const previous = model.tokens
    try {
      model.replace(start, end, value); operations()
      render({ view: a.view, offset: start + value.length }); persist(); say("")
    } catch (error) { model.tokens = previous; say(error instanceof Error ? error.message : cannotEdit) }
  }
  const beforeInput = (event: InputEvent) => {
    if (!enabled || activeSource || (event.target as Element).closest(".cb-source-open")) return
    event.preventDefault()
    if (composing) return
    if (["insertText", "insertReplacementText", "insertFromComposition"].includes(event.inputType)) edit(event.data ?? "", event.inputType)
    else if (["insertParagraph", "insertLineBreak"].includes(event.inputType)) edit("\n", event.inputType)
    else if (event.inputType.startsWith("delete")) edit("", event.inputType)
    else say("Only text suggestions are supported here. Use Edit source, when available, to change Markdown syntax.")
  }
  const keydown = (event: KeyboardEvent) => {
    if (!enabled || composing || activeSource || (event.target as Element).closest(".cb-source-open")) return
    if (event.key === "Backspace" || event.key === "Delete") { event.preventDefault(); edit("", event.key === "Backspace" ? "deleteContentBackward" : "deleteContentForward") }
    if ((event.ctrlKey || event.metaKey) && ["z", "y", "b", "i", "u"].includes(event.key.toLowerCase())) { event.preventDefault(); say("Use Discard on a suggestion to restore its original text.") }
    if ((event.key === "Enter" || event.key === " ") && (event.target as HTMLElement).classList.contains("cb-suggest-unmapped")) { event.preventDefault(); void openSource(event.target as HTMLElement) }
  }
  const click = (event: MouseEvent) => {
    if (!enabled || activeSource) return
    const target = event.target as HTMLElement
    // Quartz's window SPA handler does not honor defaultPrevented.
    if (target.closest("a")) { event.preventDefault(); event.stopPropagation() }
    if (target.closest(".cb-suggest-unmapped")) { event.preventDefault(); void openSource(target) }
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
  const onEntry = () => { setMode(true); say("Suggesting mode is on."); root.focus({ preventScroll: true }) }
  const onToggle = () => { if (activeSource) say("Choose Done or Cancel in the source editor first."); else setMode(!enabled) }
  const onReview = () => showReview(form.hidden === true)
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
      const action = new URL(form.dataset.action!); action.pathname = "/v2/suggestions"
      const result = await submitSuggestionIntent(action.href, intent, fetch, token)
      if (destroyed) return
      if (result.accepted) {
        for (const view of views) view.model.reset()
        sourceEdits.clear()
        for (const id of Object.keys(comments)) delete comments[id]
        store(key, null); store(retryKey, null); form.reset(); render(); showReview(false); setMode(false)
        entry.focus({ preventScroll: true })
      }
      say(result.message)
    } catch (error) { if (!destroyed) say(error instanceof Error ? error.message : "Could not send. Retry safely.") }
    finally { busy = false; if (!destroyed) { root.contentEditable = String(enabled); challenge?.reset(); updateSubmit() } }
  }
  try {
    const saved = JSON.parse(stored(key) ?? "null")
    if (saved) {
      if (!Array.isArray(saved.operations) || saved.operations.length > 50) throw Error("Invalid stored suggestions")
      const pending = [...saved.operations] as Operation[]
      for (const view of views) {
        const matching = pending.filter(op => op.start >= view.model.start && op.end <= view.model.end && op.operationId.startsWith(`edit-${view.model.id}-`))
        view.model.restore(matching)
        for (const op of matching) pending.splice(pending.indexOf(op), 1)
      }
      for (const { block } of blocks) {
        const matching = pending.filter(op => op.operationId.startsWith(`source-${block.id}-`))
        if (matching.length) {
          sourceOperations(block, localOperations(block, matching))
          if (sortedOperations(views.map(v => v.model)).some(op => touchesBlock(op, block))) throw Error("Stored edits mix source and rendered changes")
          sourceEdits.set(block.id, matching)
          for (const op of matching) pending.splice(pending.indexOf(op), 1)
        }
      }
      if (pending.length) throw Error("Stored range is no longer available")
      if (saved.comments && typeof saved.comments === "object") for (const [id, value] of Object.entries(saved.comments)) if (typeof value === "string" && value.length <= 2048) comments[id] = value
      operations()
    }
  } catch { for (const view of views) view.model.reset(); sourceEdits.clear(); store(key, null); say("Stored suggestions could not be restored safely.") }
  root.addEventListener("beforeinput", beforeInput)
  root.addEventListener("keydown", keydown)
  root.addEventListener("click", click)
  root.addEventListener("paste", paste)
  root.addEventListener("cut", cut)
  root.addEventListener("input", input)
  root.addEventListener("drop", drop)
  root.addEventListener("compositionstart", compositionStart)
  root.addEventListener("compositionend", compositionEnd)
  entry.addEventListener("click", onEntry); toggle.addEventListener("click", onToggle)
  review.addEventListener("click", onReview); cancel.addEventListener("click", onCancel)
  form.addEventListener("submit", onSubmit)
  window.addEventListener("resize", layout); window.addEventListener("scroll", layout, { passive: true })
  render(); setMode(operations().length > 0)
  window.addCleanup(() => {
    destroyed = true; challenge?.destroy(); closeSource(false)
    for (const { host, button } of blocks) { button.remove(); host.classList.remove("cb-source-pending") }
    root.removeEventListener("beforeinput", beforeInput); root.removeEventListener("keydown", keydown)
    root.removeEventListener("click", click); root.removeEventListener("paste", paste); root.removeEventListener("drop", drop)
    root.removeEventListener("cut", cut); root.removeEventListener("input", input)
    root.removeEventListener("compositionstart", compositionStart); root.removeEventListener("compositionend", compositionEnd)
    entry.removeEventListener("click", onEntry); toggle.removeEventListener("click", onToggle)
    review.removeEventListener("click", onReview); cancel.removeEventListener("click", onCancel); form.removeEventListener("submit", onSubmit)
    window.removeEventListener("resize", layout); window.removeEventListener("scroll", layout)
    root.removeAttribute("contenteditable"); root.removeAttribute("role"); root.removeAttribute("aria-label"); root.removeAttribute("aria-multiline"); root.classList.remove("cb-suggesting")
    for (const { marker, node, hosts } of originals) { marker.replaceWith(node); hosts.forEach(host => host.remove()) }
    for (const [parent, attrs] of refusedParents) for (const [name, value] of attrs) { if (value === null) parent.removeAttribute(name); else parent.setAttribute(name, value) }
    tray.remove(); toggle.remove(); review.remove(); hint.remove(); status.remove(); heading.remove(); summary.remove()
    if (editedLabel) editedLabel.hidden = false
  })
  return true
}

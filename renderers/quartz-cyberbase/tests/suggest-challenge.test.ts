import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { runInNewContext } from "node:vm"
import { suggestionBindingForPage } from "../components/suggestCorrectionConfig"

const source = (name: string) => readFileSync(join(import.meta.dir, "../components", name), "utf8")
const browserBundle = await Bun.build({
  entrypoints: [join(import.meta.dir, "../components/scripts/suggest-correction.inline.ts")],
  target: "browser", format: "iife", write: false,
})
assert.equal(browserBundle.success, true, browserBundle.logs.map(String).join("\n"))
const browserCode = await browserBundle.outputs[0].text()
// Exercise the actual JSX without a Quartz checkout or network.
const componentCode = new Bun.Transpiler({
  loader: "tsx", tsconfig: { compilerOptions: { jsx: "react", jsxFactory: "h" } },
}).transformSync(source("SuggestCorrection.tsx").replace(/^import [^\n]+\n/gmu, "").replace("export default", "globalThis.createComponent ="))
interface VNode { tag: string; props: Record<string, unknown>; children: unknown[] }
const h = (tag: string, props: Record<string, unknown>, ...children: unknown[]): VNode => ({ tag, props, children })
const componentContext = { h, classNames: (...classes: string[]) => classes.filter(Boolean).join(" "), suggestionBindingForPage, script: "" } as Record<string, any>
runInNewContext(componentCode, componentContext)
const options = {
  enabled: true as const, intakeOrigin: "https://intake.example",
  bindingDigest: "sha-256=:dnsUaEW9sPCjZ7UCItxthnrYHexoGDDHGauNk5ois8w=:",
  sourceRepository: "https://forge.example/owner/wiki.git", sourceRevision: "1".repeat(40),
}
function nodes(value: unknown): VNode[] {
  if (!value || typeof value !== "object" || !("tag" in value)) return []
  const node = value as VNode
  return [node, ...node.children.flatMap(nodes)]
}
const render = (opts: object) => componentContext.createComponent(opts)({ fileData: { relativePath: "page.md", slug: "page" } })
assert.equal(render({ enabled: false }), null)
assert.equal(render({ enabled: false, challengeSiteKey: "unused", challengeProvider: "missing" }), null)
// Byte-identical disabled page output: no markup, CSS or script resources enter layout.
const layout = readFileSync(join(import.meta.dir, "../quartz.layout.ts"), "utf8")
assert.match(layout, /SUGGEST_CORRECTION_OPTIONS.enabled\s*\?\s*\[SuggestCorrection\(SUGGEST_CORRECTION_OPTIONS\)\]\s*:\s*\[\]/u)
function disabledLayoutBytes(layoutSource: string): Buffer {
  const code = new Bun.Transpiler({ loader: "ts" }).transformSync(layoutSource
    .replace(/^import [^\n]+\n/gmu, ""))
    .replace(/export (?:const|let|var) (\w+)/gu, "globalThis.$1")
  const context: Record<string, any> = {
    process: { env: {} },
    Component: new Proxy({}, { get: (_target, name) => (...args: unknown[]) => ({ component: String(name), args }) }),
    EditThisPage: (opts: unknown) => ({ component: "EditThisPage", opts }),
    resolveEditLinkMode: () => "public", resolveOwnerOrigin: () => { throw new Error("unexpected owner origin") },
    resolveSuggestCorrectionOptions: () => ({ enabled: false }),
    SuggestCorrection: () => { throw new Error("a disabled layout must not collect suggestion CSS/scripts") },
  }
  runInNewContext(code, context)
  return Buffer.from(JSON.stringify([context.sharedPageComponents, context.defaultContentPageLayout, context.defaultListPageLayout]))
}
assert.deepEqual(disabledLayoutBytes(layout), disabledLayoutBytes(layout.replace(/^\s*\.\.\.SUGGEST_CORRECTION_COMPONENTS,\n/gmu, "")),
  "disabled page layouts are byte-identical to omitting the suggestion component entirely")
assert.deepEqual(render({ ...options, challengeProvider: "turnstile" }), render(options))
const plainNodes = nodes(render(options))
assert.equal(plainNodes.some((node) => node.props?.class === "suggest-correction-challenge"), false)
assert.deepEqual(plainNodes.filter((node) => node.props?.name).map((node) => node.props.name), ["edited", "rationale", "evidence"])
assert.equal(plainNodes.find((node) => node.tag === "form")!.props.hidden, true)
assert.equal(plainNodes.find((node) => node.props?.name === "edited")!.props.required, undefined, "empty edited text is a valid deletion")
assert.ok(plainNodes.some((node) => node.props?.class === "suggest-correction-entry" && node.tag === "button"))
const challengedNodes = nodes(render({ ...options, challengeSiteKey: "site-key" }))
const widgetIndex = challengedNodes.findIndex((node) => node.props?.class === "suggest-correction-challenge")
assert.equal(challengedNodes[widgetIndex].props["data-sitekey"], "site-key")
assert.equal(Object.hasOwn(challengedNodes[widgetIndex].props, "data-provider"), false)
assert.ok(widgetIndex < challengedNodes.findIndex((node) => node.tag === "button" && node.props.type === "submit"))
assert.equal(nodes(render({ ...options, challengeSiteKey: "site-key", challengeProvider: "fixture-provider" }))
  .find((node) => node.props?.class === "suggest-correction-challenge")!.props["data-provider"], "fixture-provider")
const css = componentContext.createComponent(options).css
assert.match(css, /@media \(max-width: 800px\), \(hover: none\)/u)
assert.match(css, /\.suggest-edit-mobile-visible\s*\{\s*opacity: 1/u)
assert.match(css, /min-width: 40px/u)
assert.match(css, /min-height: 40px/u)
assert.match(css, /\.suggest-correction-form\[hidden\]/u)

class Events {
  listeners = new Map<string, Set<(event: any) => any>>()
  addEventListener(name: string, handler: (event: any) => any) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set())
    this.listeners.get(name)!.add(handler)
  }
  removeEventListener(name: string, handler: (event: any) => any) { this.listeners.get(name)?.delete(handler) }
  emit(name: string, event: any = {}) {
    let result: any
    for (const handler of this.listeners.get(name) ?? []) result = handler(event)
    return result
  }
}
class TextNode {
  nodeType = 3
  parentElement: FakeElement | null = null
  constructor(public textContent: string) {}
}
let focused: FakeElement | null = null
class FakeElement extends Events {
  nodeType = 1
  parentElement: FakeElement | null = null
  children: Array<FakeElement | TextNode> = []
  attributes = new Map<string, string>()
  dataset: Record<string, string> = {}
  style: Record<string, string> = {}
  disabled = false
  type = ""
  name = ""
  value = ""
  rows = 0
  selectionStart = 0
  selectionEnd = 0
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  removed = false
  constructor(public tag: string, className = "") { super(); if (className) this.className = className }
  get tagName() { return this.tag.toUpperCase() }
  get className() { return this.attributes.get("class") ?? "" }
  set className(value: string) { this.attributes.set("class", value) }
  get hidden() { return this.attributes.has("hidden") }
  set hidden(value: boolean) { if (value) this.attributes.set("hidden", ""); else this.attributes.delete("hidden") }
  get textContent(): string { return this.children.map((child) => child.textContent).join("") }
  set textContent(value: string) { this.children = []; if (value) this.appendChild(new TextNode(value)) }
  get classList() {
    return {
      add: (value: string) => { this.className = [...new Set([...this.className.split(" ").filter(Boolean), value])].join(" ") },
      remove: (value: string) => { this.className = this.className.split(" ").filter((item) => item !== value).join(" ") },
      length: this.className.split(" ").filter(Boolean).length,
    }
  }
  setAttribute(name: string, value: string) { this.attributes.set(name, value) }
  getAttribute(name: string) { return this.attributes.get(name) ?? null }
  removeAttribute(name: string) { this.attributes.delete(name) }
  appendChild<T extends FakeElement | TextNode>(child: T): T {
    if (child instanceof FakeElement) child.remove()
    child.parentElement = this
    this.children.push(child)
    return child
  }
  remove() {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((child) => child !== this)
    this.parentElement = null
    this.removed = true
  }
  after(node: FakeElement) {
    const parent = this.parentElement!
    node.remove()
    node.parentElement = parent
    parent.children.splice(parent.children.indexOf(this) + 1, 0, node)
  }
  matches(selector: string): boolean {
    return selector.split(",").some((part) => {
      const item = part.trim()
      if (item.startsWith(".")) return this.className.split(" ").includes(item.slice(1))
      const tagClass = item.match(/^(\w+)\.([\w-]+)$/u)
      if (tagClass) return this.tag === tagClass[1] && this.className.split(" ").includes(tagClass[2])
      const match = item.match(/^(\w+)(?:\[([^=]+)=['"]([^'"]+)['"]\])?$/u)
      return !!match && this.tag === match[1] && (!match[2] || (this as any)[match[2]] === match[3])
    })
  }
  closest(selector: string): FakeElement | null { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null }
  contains(node: FakeElement | TextNode | null): boolean { return node === this || (!!node?.parentElement && this.contains(node.parentElement)) }
  querySelectorAll(selector: string): FakeElement[] {
    return this.children.flatMap((child) => child instanceof FakeElement
      ? [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)] : [])
  }
  querySelector(selector: string): any { return this.querySelectorAll(selector)[0] ?? null }
  focus() { focused = this }
  setSelectionRange(start: number, end: number) { this.selectionStart = start; this.selectionEnd = end }
}
class Input extends FakeElement { constructor(name: string) { super("input"); this.name = name } }
class TextArea extends FakeElement { constructor(name: string) { super("textarea"); this.name = name } }
class Form extends FakeElement {
  elements = { namedItem: (name: string) => this.children.find((child) => child instanceof FakeElement && child.name === name) }
  reset() { for (const child of this.children) if (child instanceof Input || child instanceof TextArea) child.value = "" }
  submit() { return this.emit("submit", { preventDefault() {} }) }
}
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
function harness(challenged = false, withForm = true, provider?: string, blockTag = "p", rich = false) {
  focused = null
  const documentEvents = new Events()
  const windowEvents = new Events()
  const body = new FakeElement("body")
  const article = body.appendChild(new FakeElement("article"))
  const block = article.appendChild(new FakeElement(blockTag, "existing-class"))
  const originalText = "The quick brown fox jumps over the lazy dog."
  const text = block.appendChild(new TextNode(rich ? "The quick " : originalText))
  if (rich) {
    const link = block.appendChild(new FakeElement("a"))
    link.setAttribute("href", "https://original.example/")
    const strong = link.appendChild(new FakeElement("strong"))
    strong.textContent = "brown"
    block.appendChild(new TextNode(" fox jumps over the lazy dog."))
  }
  block.setAttribute("data-original", "preserve me")
  const root = body.appendChild(new FakeElement("section", "suggest-correction"))
  const entry = root.appendChild(new FakeElement("button", "suggest-correction-entry"))
  const hint = root.appendChild(new FakeElement("p", "suggest-correction-hint")); hint.hidden = true
  const form = root.appendChild(new Form("form", "suggest-correction-form")); form.hidden = true
  form.dataset = { bindingDigest: options.bindingDigest, pageId: `page-v1:${"A".repeat(43)}`, action: "https://intake.example/v1/corrections" }
  const edited = form.appendChild(new TextArea("edited"))
  const rationale = form.appendChild(new Input("rationale"))
  const evidence = form.appendChild(new Input("evidence"))
  const submit = form.appendChild(new FakeElement("button")); submit.type = "submit"; submit.disabled = true
  const cancel = form.appendChild(new FakeElement("button", "suggest-correction-cancel"))
  const status = form.appendChild(new FakeElement("p", "suggest-correction-status"))
  const container = challenged ? form.appendChild(new FakeElement("div", "suggest-correction-challenge")) : null
  if (container) container.dataset = { sitekey: "test-site-key", ...(provider === undefined ? {} : { provider }) }
  const scripts: any[] = []
  const cleanups: Array<() => void> = []
  const timers = new Map<number, () => void>()
  const storage = new Map<string, string>()
  let timerId = 0
  let selection: any = null
  let callbacks: Record<string, any> = {}
  let resets = 0
  let removals = 0
  let renders = 0
  let response: () => Promise<Response> = async () => new Response(JSON.stringify({ receipt: { state: "pending-review", queueId: "Q-inline" } }), {
    status: 202, headers: { "content-type": "application/json" },
  })
  const calls: RequestInit[] = []
  const win: Record<string, any> = {
    addCleanup: (fn: () => void) => cleanups.push(fn), getSelection: () => selection, innerWidth: 375, innerHeight: 800,
    addEventListener: windowEvents.addEventListener.bind(windowEvents), removeEventListener: windowEvents.removeEventListener.bind(windowEvents),
  }
  const api = {
    render(mounted: unknown, opts: Record<string, unknown>) {
      assert.equal(mounted, container)
      assert.equal(opts.sitekey, "test-site-key")
      assert.equal(opts.action, "suggest-correction")
      assert.equal(opts["response-field"], false)
      callbacks = opts; renders++; return "widget-1"
    },
    getResponse() { return "test-single-use-token" },
    reset() { resets++ }, remove() { removals++ },
  }
  runInNewContext(browserCode, {
    window: win,
    document: {
      addEventListener: documentEvents.addEventListener.bind(documentEvents), removeEventListener: documentEvents.removeEventListener.bind(documentEvents),
      querySelector: (selector: string) => body.querySelector(selector),
      querySelectorAll: (selector: string) => withForm ? body.querySelectorAll(selector) : [],
      createElement: (tag: string) => new FakeElement(tag), head: { appendChild: (script: any) => scripts.push(script) },
    },
    Element: FakeElement, HTMLFormElement: Form, HTMLTextAreaElement: TextArea, HTMLInputElement: Input,
    sessionStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    crypto, Uint8Array, btoa, TextEncoder, TextDecoder, URL, Headers, Response,
    setTimeout(fn: () => void) { timers.set(++timerId, fn); return timerId }, clearTimeout: (id: number) => timers.delete(id),
    fetch: async (_url: unknown, init: RequestInit) => { calls.push(init); return response() },
  })
  const nav = () => documentEvents.emit("nav")
  nav()
  return {
    body, article, block, text, originalText, root, form, edited, rationale, evidence, submit, cancel, entry, hint, status,
    scripts, calls, timers, storage, documentEvents, windowEvents, nav,
    get pencil() { return block.querySelector(".suggest-edit-pencil") as FakeElement },
    get floating() { return root.querySelector(".suggest-edit-floating") as FakeElement },
    get focused() { return focused }, get resets() { return resets }, get removals() { return removals }, get renders() { return renders },
    get callbacks() { return callbacks },
    select(start: number, end: number, region: "article" | "nav" | "form" | "cross-block" | "pencil" = "article") {
      const other = new FakeElement(region === "nav" ? "nav" : "p")
      const startContainer = region === "nav" ? other : region === "form" ? edited : region === "pencil" ? this.pencil : text
      selection = {
        isCollapsed: start === end, rangeCount: 1,
        getRangeAt: () => ({
          startContainer, endContainer: region === "cross-block" ? other : startContainer, startOffset: start,
          toString: () => originalText.slice(start, end),
          cloneRange: () => ({ selectNodeContents() {}, setEnd() {}, toString: () => originalText.slice(0, start) }),
          getBoundingClientRect: () => ({ left: 40, top: 100, bottom: 120 }),
        }),
      }
      documentEvents.emit("selectionchange")
    },
    edit(value = originalText.replace("brown", "red")) { edited.value = value; form.emit("input") },
    respond(fn: () => Promise<Response>) { response = fn },
    async load() { win.turnstile = api; scripts[0].onload(); await flush() },
    verify(value = "test-single-use-token") { callbacks.callback(value) },
    cleanup() { cleanups.splice(0).forEach((fn) => fn()) },
  }
}

// Selection opens a prefilled editor at the block, selecting only the chosen words.
const selected = harness()
selected.entry.emit("click")
assert.equal(selected.hint.hidden, false)
selected.select(10, 19)
assert.equal(selected.floating.hidden, false)
assert.equal(selected.floating.style.left, "40px")
assert.equal(selected.floating.style.top, "128px")
let prevented = false
selected.floating.emit("pointerdown", { preventDefault() { prevented = true } })
assert.equal(prevented, true)
selected.floating.emit("click")
assert.equal(selected.form.parentElement, selected.article)
assert.equal(selected.article.children[selected.article.children.indexOf(selected.block) + 1], selected.form)
assert.equal(selected.block.hidden, true)
assert.equal(selected.form.hidden, false)
assert.equal(selected.edited.value, selected.originalText)
assert.equal(selected.edited.selectionStart, 10)
assert.equal(selected.edited.selectionEnd, 19)
assert.equal(selected.focused, selected.edited)
assert.equal(selected.submit.disabled, true)
selected.edit()
assert.equal(selected.submit.disabled, false)
selected.edit(selected.originalText)
assert.equal(selected.submit.disabled, true)
const originalNodes = selected.block.children.slice()
const attributes = [...selected.block.attributes].filter(([key]) => key !== "hidden")
selected.form.emit("keydown", { key: "Escape", preventDefault() {} })
assert.equal(selected.block.hidden, false)
assert.deepEqual(selected.block.children, originalNodes, "Esc restores the same original nodes, not HTML copies")
assert.deepEqual([...selected.block.attributes], attributes)
assert.equal(selected.focused, selected.block)
assert.equal(selected.form.hidden, true)
assert.equal(selected.form.parentElement, selected.root)
assert.equal(selected.block.getAttribute("tabindex"), null)
selected.cleanup()
assert.equal(selected.block.className, "existing-class")
assert.deepEqual(selected.block.children, [selected.text])

// Pencil controls support paragraphs, headings and leaf list items, including keyboard click.
for (const tag of ["p", "li", "h2"]) {
  const pencil = harness(false, true, undefined, tag)
  assert.match(pencil.pencil.className, /suggest-edit-mobile-visible/u)
  assert.equal(pencil.pencil.getAttribute("aria-label"), "Suggest edit")
  pencil.pencil.emit("click")
  assert.equal(pencil.edited.value, pencil.originalText)
  assert.equal(pencil.edited.selectionStart, pencil.originalText.length)
  if (tag === "li") assert.equal(pencil.form.parentElement?.tag, "li", "the editor remains within a list item")
  pencil.cancel.emit("click")
  assert.equal(pencil.block.hidden, false)
  assert.equal(pencil.focused, pencil.block)
  pencil.cleanup()
}
const rich = harness(false, true, undefined, "p", true)
const richNodes = rich.block.children.slice()
const originalLink = rich.block.querySelector("a")!
let linkClicks = 0
originalLink.addEventListener("click", () => linkClicks++)
rich.pencil.emit("click")
assert.equal(rich.edited.value, rich.originalText)
rich.edit()
rich.form.emit("keydown", { key: "Escape", preventDefault() {} })
assert.deepEqual(rich.block.children, richNodes)
assert.equal(rich.block.querySelector("a"), originalLink)
assert.equal(originalLink.getAttribute("href"), "https://original.example/")
originalLink.emit("click")
assert.equal(linkClicks, 1, "original event listeners survive cancellation")
rich.cleanup()

const deletion = harness()
deletion.pencil.emit("click")
deletion.edit("")
assert.equal(deletion.submit.disabled, false)
await deletion.form.submit()
assert.equal(JSON.parse(String(deletion.calls[0].body)).replacement, "")
assert.equal(JSON.parse(String(deletion.calls[0].body)).selection.quote, deletion.originalText)
assert.equal(deletion.text.textContent, deletion.originalText)
deletion.cleanup()

for (const region of ["nav", "form", "cross-block", "pencil"] as const) {
  const excluded = harness()
  excluded.select(0, 3, region)
  assert.equal(excluded.floating.hidden, true, region)
  excluded.cleanup()
}
const collapsed = harness()
collapsed.select(1, 8)
collapsed.select(1, 1)
assert.equal(collapsed.floating.hidden, true)
collapsed.select(1, 8)
collapsed.windowEvents.emit("scroll")
assert.equal(collapsed.floating.hidden, true)
collapsed.cleanup()

const plain = harness()
assert.equal(plain.scripts.length, 0)
plain.pencil.emit("click")
plain.edit()
await plain.form.submit()
assert.equal(plain.calls.length, 1)
const payload = JSON.parse(String(plain.calls[0].body))
assert.deepEqual(payload.selection, { quote: "brown", prefix: "The quick ", suffix: " fox jumps over the lazy dog." })
assert.equal(payload.replacement, "red")
assert.equal(payload.rationale, "Suggested an edit to this page.")
assert.deepEqual(payload.evidence, [])
assert.equal(new Headers(plain.calls[0].headers).has("Cyberbaser-Challenge-Token"), false)
assert.equal(plain.form.hidden, true)
assert.equal(plain.block.hidden, false)
assert.equal(plain.text.textContent, plain.originalText)
assert.equal(plain.focused, plain.block)
assert.match(plain.article.querySelector(".suggest-edit-receipt").textContent, /^Thanks — sent for review\. Receipt Q-inline\./u)
assert.equal(plain.storage.size, 0)
plain.cleanup()

// A source mismatch retains the edited text for a smaller retry, using only friendly local copy.
for (const code of ["correction-quote-not-found", "correction-quote-ambiguous", "quote-not-found", "quote-ambiguous"]) {
  const mismatch = harness()
  mismatch.respond(async () => new Response(JSON.stringify({ error: { code, message: "untrusted server text" } }), { status: 422, headers: { "content-type": "application/json" } }))
  mismatch.pencil.emit("click")
  mismatch.edit()
  await mismatch.form.submit()
  assert.equal(mismatch.status.textContent, "This part of the page is formatted in a way we couldn't match. Try selecting a smaller plain-text phrase.")
  assert.equal(mismatch.form.hidden, false)
  assert.equal(mismatch.block.hidden, true)
  assert.equal(mismatch.edited.value, mismatch.originalText.replace("brown", "red"))
  assert.equal(mismatch.submit.disabled, false)
  mismatch.cleanup()
}
const tooLong = harness()
tooLong.pencil.emit("click")
tooLong.edit("🙂".repeat(4097))
assert.equal(tooLong.submit.disabled, true)
assert.equal(tooLong.status.textContent, "This edit is too long. Try changing a smaller part of the page.")
tooLong.edit()
assert.equal(tooLong.submit.disabled, false)
assert.equal(tooLong.status.textContent, "")
tooLong.cleanup()

const absent = harness(true, false)
assert.equal(absent.scripts.length, 0)
assert.deepEqual([...absent.documentEvents.listeners.keys()], ["nav"])
for (const provider of ["missing", "__proto__", "toString"]) {
  const unknown = harness(true, true, provider)
  unknown.pencil.emit("click")
  unknown.edit()
  assert.equal(unknown.scripts.length, 0)
  assert.equal(unknown.submit.disabled, true)
  assert.match(unknown.status.textContent, /temporarily unavailable/u)
  await unknown.form.submit()
  assert.equal(unknown.calls.length, 0)
  unknown.cleanup()
}
const protectedForm = harness(true)
assert.equal(protectedForm.scripts.length, 0, "no challenge request until an edit is opened")
protectedForm.pencil.emit("click")
assert.equal(protectedForm.scripts.length, 1)
assert.equal(protectedForm.scripts[0].src, "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit")
assert.equal(protectedForm.scripts[0].async, true)
assert.equal(protectedForm.scripts[0].defer, true)
await protectedForm.load()
assert.equal(protectedForm.renders, 1)
assert.equal(protectedForm.timers.size, 0)
protectedForm.verify()
assert.equal(protectedForm.submit.disabled, true, "a token cannot enable an unchanged edit")
protectedForm.edit()
assert.equal(protectedForm.submit.disabled, false)
for (const unsafe of ["", "has whitespace", "has\nnewline", "has\u0000control", "has\u007fcontrol", "x".repeat(2049)]) {
  protectedForm.verify(unsafe)
  assert.equal(protectedForm.submit.disabled, true)
}
protectedForm.submit.disabled = false
await protectedForm.form.submit()
assert.equal(protectedForm.calls.length, 0)
assert.match(protectedForm.status.textContent, /complete the human verification/u)
protectedForm.verify()
protectedForm.callbacks["expired-callback"]()
assert.equal(protectedForm.submit.disabled, true)
assert.match(protectedForm.status.textContent, /expired/u)
protectedForm.callbacks["error-callback"]()
assert.equal(protectedForm.submit.disabled, true)
assert.match(protectedForm.status.textContent, /temporarily unavailable/u)

// Server/network/local failures retain the session, reset tokens and preserve safe retry keys.
protectedForm.respond(async () => new Response(JSON.stringify({ error: { code: "challenge-failed" } }), { status: 403, headers: { "content-type": "application/json" } }))
protectedForm.verify()
await protectedForm.form.submit()
assert.equal(protectedForm.status.textContent, "Couldn't confirm you're human. Please try again.")
assert.equal(protectedForm.submit.disabled, true)
const failedKey = JSON.parse(String(protectedForm.calls[0].body)).idempotencyKey
protectedForm.verify()
assert.equal(protectedForm.status.textContent, "Couldn't confirm you're human. Please try again.")
protectedForm.respond(async () => { throw new Error("offline") })
await protectedForm.form.submit()
assert.equal(JSON.parse(String(protectedForm.calls[1].body)).idempotencyKey, failedKey)
assert.equal(protectedForm.status.dataset.state, "error")
protectedForm.evidence.value = "http://not-https.example/"
protectedForm.verify()
await protectedForm.form.submit()
assert.equal(protectedForm.calls.length, 2)
assert.match(protectedForm.status.textContent, /HTTPS/u)
protectedForm.evidence.value = "  https://reference.example  "
protectedForm.rationale.value = "Fix the colour."
let resolveResponse!: (value: Response) => void
protectedForm.respond(() => new Promise((resolve) => { resolveResponse = resolve }))
protectedForm.verify()
const pending = protectedForm.form.submit()
protectedForm.verify("fresh-during-request")
assert.equal(protectedForm.submit.disabled, true)
protectedForm.form.emit("keydown", { key: "Escape", preventDefault() {} })
assert.equal(protectedForm.form.hidden, false, "cannot lose an in-flight edit")
await protectedForm.form.submit()
assert.equal(protectedForm.calls.length, 3)
assert.equal(new Headers(protectedForm.calls[2].headers).get("Cyberbaser-Challenge-Token"), "test-single-use-token")
assert.equal(String(protectedForm.calls[2].body).includes("test-single-use-token"), false)
assert.equal(JSON.parse(String(protectedForm.calls[2].body)).rationale, "Fix the colour.")
assert.deepEqual(JSON.parse(String(protectedForm.calls[2].body)).evidence, ["https://reference.example/"])
resolveResponse(new Response(JSON.stringify({ receipt: { queueId: "Q-safe" } }), { status: 202, headers: { "content-type": "application/json" } }))
await pending
assert.equal(protectedForm.removals, 1)
assert.equal(protectedForm.resets, 5)
assert.equal(protectedForm.form.hidden, true)
assert.equal(protectedForm.submit.disabled, true)
assert.match(protectedForm.article.querySelector(".suggest-edit-receipt").textContent, /Receipt Q-safe/u)
protectedForm.verify()
assert.equal(protectedForm.submit.disabled, true)
// One cached script across fresh removable widgets and SPA initialization.
protectedForm.pencil.emit("click")
await flush()
assert.equal(protectedForm.renders, 2)
assert.equal(protectedForm.scripts.length, 1)
protectedForm.cleanup()
assert.equal(protectedForm.removals, 2)
assert.equal(protectedForm.documentEvents.listeners.get("selectionchange")?.size, 0)
assert.equal(protectedForm.windowEvents.listeners.get("scroll")?.size, 0)
assert.equal(protectedForm.form.listeners.get("submit")?.size, 0)
assert.equal(protectedForm.block.querySelector(".suggest-edit-pencil"), null)
assert.equal(protectedForm.article.querySelector(".suggest-edit-receipt"), null)
protectedForm.nav()
protectedForm.pencil.emit("click")
await flush()
assert.equal(protectedForm.renders, 3)
protectedForm.cleanup()

const interrupted = harness()
interrupted.pencil.emit("click")
interrupted.edit()
let finishInterrupted!: (value: Response) => void
interrupted.respond(() => new Promise((resolve) => { finishInterrupted = resolve }))
const interruptedRequest = interrupted.form.submit()
interrupted.cleanup()
assert.equal(interrupted.block.hidden, false)
assert.deepEqual(interrupted.block.children, [interrupted.text])
finishInterrupted(new Response("{}", { status: 202 }))
await interruptedRequest
assert.equal(interrupted.article.querySelector(".suggest-edit-receipt"), null, "late responses cannot update a departed SPA page")

const abandoned = harness(true)
abandoned.pencil.emit("click")
abandoned.cleanup()
await abandoned.load()
assert.equal(abandoned.renders, 0)
for (const fail of ["error", "timeout"] as const) {
  const failed = harness(true)
  failed.pencil.emit("click")
  if (fail === "error") failed.scripts[0].onerror()
  else for (const timeout of failed.timers.values()) timeout()
  await flush()
  assert.equal(failed.submit.disabled, true)
  assert.match(failed.status.textContent, /temporarily unavailable/u)
  assert.equal(failed.scripts[0].removed, true)
  failed.cleanup()
}
console.log("suggest-challenge render, header-only token, gating, retry and SPA cleanup checks passed")
console.log("suggest-inline selection, pencil, exact restoration, receipt, mismatch and mobile-class checks passed")

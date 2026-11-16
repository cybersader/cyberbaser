import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { runInNewContext } from "node:vm"
import * as client from "../components/suggestCorrectionClient"
import { suggestionBindingForPage } from "../components/suggestCorrectionConfig"

const source = (name: string) => readFileSync(join(import.meta.dir, "../components", name), "utf8")
// Bundle the actual browser entry and its static registry/provider imports.
// This also catches accidentally importing build-only/node modules into the form.
const browserBundle = await Bun.build({
  entrypoints: [join(import.meta.dir, "../components/scripts/suggest-correction.inline.ts")],
  target: "browser",
  format: "iife",
  write: false,
})
assert.equal(browserBundle.success, true, browserBundle.logs.map(String).join("\n"))
assert.equal(browserBundle.outputs.length, 1)
const browserCode = await browserBundle.outputs[0].text()

// Render actual component JSX with tiny Quartz/JSX stubs, not a network checkout.
const componentCode = new Bun.Transpiler({
  loader: "tsx",
  tsconfig: { compilerOptions: { jsx: "react", jsxFactory: "h" } },
}).transformSync(source("SuggestCorrection.tsx")
  .replace(/^import [^\n]+\n/gmu, "")
  .replace("export default", "globalThis.createComponent ="))
interface VNode { tag: string; props: Record<string, unknown>; children: unknown[] }
const h = (tag: string, props: Record<string, unknown>, ...children: unknown[]): VNode => ({ tag, props, children })
const componentContext = { h, classNames: (...classes: string[]) => classes.filter(Boolean).join(" "), suggestionBindingForPage, script: "" } as Record<string, any>
runInNewContext(componentCode, componentContext)
const options = {
  enabled: true as const,
  intakeOrigin: "https://intake.example",
  bindingDigest: "sha-256=:dnsUaEW9sPCjZ7UCItxthnrYHexoGDDHGauNk5ois8w=:",
  sourceRepository: "https://forge.example/owner/wiki.git",
  sourceRevision: "1111111111111111111111111111111111111111",
}
function nodes(value: unknown): VNode[] {
  if (!value || typeof value !== "object" || !("tag" in value)) return []
  const node = value as VNode
  return [node, ...node.children.flatMap(nodes)]
}
function render(opts: object, relativePath: string | undefined = "page.md", slug = "page") {
  return componentContext.createComponent(opts)({ fileData: { relativePath, slug } })
}
assert.equal(render({ enabled: false }), null)
assert.equal(render({ ...options, challengeSiteKey: "site-key" }, undefined, "tags/topic"), null)
assert.equal(nodes(render(options)).some((node) => node.props?.class === "suggest-correction-challenge"), false)
assert.deepEqual(render({ ...options, challengeProvider: "turnstile" }), render(options))
const challengedNodes = nodes(render({ ...options, challengeSiteKey: "site-key" }))
const widgetIndex = challengedNodes.findIndex((node) => node.props?.class === "suggest-correction-challenge")
assert.ok(widgetIndex > 0)
assert.equal(challengedNodes[widgetIndex].props["data-sitekey"], "site-key")
assert.equal(challengedNodes[widgetIndex].props["data-action"], "suggest-correction")
assert.equal(Object.hasOwn(challengedNodes[widgetIndex].props, "data-provider"), false)
const selectedProviderNode = nodes(render({ ...options, challengeSiteKey: "site-key", challengeProvider: "fixture-provider" }))
  .find((node) => node.props?.class === "suggest-correction-challenge")!
assert.equal(selectedProviderNode.props["data-provider"], "fixture-provider")
assert.ok(widgetIndex < challengedNodes.findIndex((node) => node.tag === "button" && node.props.type === "submit"))
const selectionControl = challengedNodes.find((node) => node.props?.class === "suggest-correction-use-selection")!
assert.equal(selectionControl.tag, "button")
assert.equal(selectionControl.props.type, "button")
assert.equal(selectionControl.children.join(""), "Use selected text")
assert.ok(challengedNodes.some((node) => node.props?.class === "suggest-correction-selection-hint"
  && node.props.role === "status" && node.props["aria-live"] === "polite"))
assert.ok(challengedNodes.some((node) => node.props?.role === "status" && node.props["aria-live"] === "polite"))

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
class FakeElement extends Events {
  parentElement: FakeElement | null = null
  children: FakeElement[] = []
  textContent = ""
  open = false
  constructor(public tag: string, public className = "") { super() }
  append(child: FakeElement) { child.parentElement = this; this.children.push(child); return child }
  matches(selector: string): boolean {
    return selector.split(",").some((part) => part.trim().startsWith(".")
      ? this.className.split(" ").includes(part.trim().slice(1)) : part.trim() === this.tag)
  }
  contains(node: { parentElement: FakeElement | null } | null): boolean {
    return node === this || (!!node?.parentElement && this.contains(node.parentElement))
  }
  closest(selector: string): FakeElement | null { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null }
  querySelectorAll(selector: string): FakeElement[] {
    return this.children.flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)])
  }
  querySelector(selector: string): any { return this.querySelectorAll(selector)[0] ?? null }
}
class TextArea { maxLength = 16 * 1024; constructor(public value: string) {} }
class Form extends FakeElement {
  dataset = { bindingDigest: options.bindingDigest, pageId: `page-v1:${"A".repeat(43)}`, action: "https://intake.example/v1/corrections" }
  button = { disabled: true }
  status = { textContent: "", dataset: {} as Record<string, string> }
  selectionHint = new FakeElement("span")
  useSelection = new FakeElement("button")
  details = new FakeElement("details")
  summary = this.details.append(new FakeElement("summary"))
  container: { dataset: { sitekey: string; provider?: string } } | null
  resetCount = 0
  fields: Record<string, TextArea> = {
    quote: new TextArea("teh"), prefix: new TextArea(""), suffix: new TextArea(""),
    replacement: new TextArea("the"), rationale: new TextArea("Fix a typo."), evidence: new TextArea(""),
  }
  elements = { namedItem: (name: string) => this.fields[name] }
  constructor(challenged: boolean, provider?: string) {
    super("form")
    this.details.append(this)
    this.container = challenged ? { dataset: { sitekey: "test-site-key", ...(provider === undefined ? {} : { provider }) } } : null
  }
  querySelector(selector: string) {
    if (selector === ".suggest-correction-challenge") return this.container
    if (selector === ".suggest-correction-status") return this.status
    if (selector === "button[type='submit']") return this.button
    if (selector === ".suggest-correction-use-selection") return this.useSelection
    if (selector === ".suggest-correction-selection-hint") return this.selectionHint
    return null
  }
  reset() { this.resetCount++ }
  submit() { return this.emit("submit", { currentTarget: this, preventDefault() {} }) }
  openForm() { this.summary.emit("click"); this.details.open = true; this.details.emit("toggle") }
}
async function flush() { for (let i = 0; i < 5; i++) await Promise.resolve() }
function harness(challenged: boolean, withForm = true, provider?: string) {
  const form = new Form(challenged, provider)
  const scripts: Array<Record<string, any>> = []
  const cleanups: Array<() => void> = []
  const timers = new Map<number, () => void>()
  let timerId = 0
  const documentEvents = new Events()
  let article = new FakeElement("article")
  let selection: any = null
  const nav = () => documentEvents.emit("nav")
  let callbacks: Record<string, any> = {}
  let token = ""
  let resets = 0
  let removals = 0
  let renders = 0
  let response: () => Promise<Response> = async () => new Response("{}", { status: 202 })
  const calls: RequestInit[] = []
  const api = {
    render(container: unknown, opts: Record<string, unknown>) {
      assert.equal(container, form.container)
      assert.equal(opts.sitekey, "test-site-key")
      assert.equal(opts.action, "suggest-correction")
      assert.equal(opts["response-field"], false)
      callbacks = opts
      renders++
      return "widget-1"
    },
    getResponse(id: string) { assert.equal(id, "widget-1"); return token },
    reset(id: string) { assert.equal(id, "widget-1"); resets++; token = "" },
    remove(id: string) { assert.equal(id, "widget-1"); removals++ },
  }
  const win: Record<string, any> = {
    addCleanup: (fn: () => void) => cleanups.push(fn),
    getSelection: () => selection,
  }
  const context = {
    ...client, window: win,
    document: {
      addEventListener: documentEvents.addEventListener.bind(documentEvents),
      removeEventListener: documentEvents.removeEventListener.bind(documentEvents),
      querySelector(selector: string) { assert.equal(selector, "article"); return article },
      querySelectorAll() { return withForm ? [form] : [] },
      createElement(tag: string) { assert.equal(tag, "script"); return { remove() { this.removed = true } } },
      head: { appendChild(script: Record<string, any>) { scripts.push(script) } },
    },
    Element: FakeElement, HTMLFormElement: Form, HTMLTextAreaElement: TextArea,
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    crypto, Uint8Array, btoa, TextEncoder, TextDecoder, URL, Headers, Response,
    setTimeout(fn: () => void) { timers.set(++timerId, fn); return timerId },
    clearTimeout(id: number) { timers.delete(id) },
    fetch: async (_url: unknown, init: RequestInit) => { calls.push(init); return response() },
  }
  runInNewContext(browserCode, context)
  nav()
  return {
    form, scripts, calls, timers, documentEvents,
    select(text: string, region: "article" | "code" | "nav" | "sidebar" | "form" | "cross-form" | "cross-article" = "article") {
      let ancestor: FakeElement | { parentElement: FakeElement | null } = article
      let crossed: FakeElement | undefined
      if (region === "code") ancestor = { parentElement: article.append(new FakeElement("code")) }
      if (region === "nav") ancestor = new FakeElement("nav")
      if (region === "sidebar") ancestor = new FakeElement("div", "sidebar")
      if (region === "form") ancestor = article.append(new FakeElement("form"))
      if (region === "cross-form") crossed = article.append(new FakeElement("form"))
      if (region === "cross-article") ancestor = new FakeElement("main")
      selection = {
        isCollapsed: text === "", rangeCount: 1, toString: () => text,
        getRangeAt: () => ({ commonAncestorContainer: ancestor, intersectsNode: (node: FakeElement) => node === crossed }),
      }
    },
    get resets() { return resets }, get removals() { return removals }, get renders() { return renders },
    get callbacks() { return callbacks },
    respond(fn: () => Promise<Response>) { response = fn },
    async load() { win.turnstile = api; scripts[0].onload(); await flush() },
    verify(value = "test-single-use-token") { token = value; callbacks.callback() },
    cleanup() { cleanups.splice(0).forEach((fn) => fn()) },
    nav() { article = new FakeElement("article"); nav() },
  }
}

// No key or no form: no API script, widget or header, original enabled submit.
const plain = harness(false)
assert.equal(plain.scripts.length, 0)
assert.equal(plain.form.button.disabled, false)
await plain.form.submit()
assert.equal(plain.calls.length, 1)
assert.equal(new Headers(plain.calls[0].headers).has("Cyberbaser-Challenge-Token"), false)
assert.equal(plain.form.button.disabled, false)
const absentForm = harness(true, false)
assert.equal(absentForm.scripts.length, 0)
assert.equal(absentForm.calls.length, 0)
assert.deepEqual([...absentForm.documentEvents.listeners.keys()], ["nav"])
for (const provider of ["missing", "__proto__", "toString"]) {
  const unknown = harness(true, true, provider)
  assert.equal(unknown.scripts.length, 0)
  assert.equal(unknown.form.button.disabled, true)
  assert.match(unknown.form.status.textContent, /temporarily unavailable/u)
  await unknown.form.submit()
  assert.equal(unknown.calls.length, 0)
}
const explicitProvider = harness(true, true, "turnstile")
await explicitProvider.load()
explicitProvider.verify()
assert.equal(explicitProvider.form.button.disabled, false)
explicitProvider.cleanup()

const protectedForm = harness(true)
assert.equal(protectedForm.form.button.disabled, true)
await protectedForm.form.submit()
assert.equal(protectedForm.calls.length, 0)
assert.equal(protectedForm.scripts.length, 1)
assert.equal(protectedForm.scripts[0].src, "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit")
assert.equal(protectedForm.scripts[0].async, true)
assert.equal(protectedForm.scripts[0].defer, true)
await protectedForm.load()
assert.equal(protectedForm.renders, 1)
assert.equal(protectedForm.form.button.disabled, true)
assert.equal(protectedForm.timers.size, 0)
protectedForm.verify()
assert.equal(protectedForm.form.button.disabled, false)
await protectedForm.form.submit()
assert.equal(protectedForm.calls.length, 1)
assert.equal(new Headers(protectedForm.calls[0].headers).get("Cyberbaser-Challenge-Token"), "test-single-use-token")
assert.equal(String(protectedForm.calls[0].body).includes("test-single-use-token"), false)
assert.equal(protectedForm.resets, 1)
assert.equal(protectedForm.form.button.disabled, true)
assert.equal(protectedForm.form.status.dataset.state, "success")
assert.equal(protectedForm.form.resetCount, 1)
protectedForm.verify("refreshed-after-success")
assert.equal(protectedForm.form.status.dataset.state, "success")
assert.match(protectedForm.form.status.textContent, /^Correction received/u)

// Every attempt consumes/reset its widget, including server, network and local errors.
protectedForm.respond(async () => new Response(JSON.stringify({ error: { code: "challenge-failed" } }), {
  status: 403, headers: { "content-type": "application/json" },
}))
protectedForm.verify("another-token")
await protectedForm.form.submit()
assert.equal(protectedForm.resets, 2)
assert.equal(protectedForm.form.status.textContent, "Couldn't confirm you're human. Please try again.")
protectedForm.verify("refreshed-after-error")
assert.equal(protectedForm.form.status.textContent, "Couldn't confirm you're human. Please try again.")
protectedForm.respond(async () => { throw new Error("offline") })
protectedForm.verify()
await protectedForm.form.submit()
assert.equal(protectedForm.resets, 3)
assert.equal(protectedForm.form.status.dataset.state, "error")
protectedForm.form.fields.quote.value = ""
protectedForm.verify()
await protectedForm.form.submit()
assert.equal(protectedForm.resets, 4)
assert.equal(protectedForm.calls.length, 3)
protectedForm.form.fields.quote.value = "teh"
for (const unsafeToken of ["", "has whitespace", "has\nnewline", "has\u0000control", "has\u007fcontrol", "x".repeat(2049)]) {
  protectedForm.verify(unsafeToken)
  assert.equal(protectedForm.form.button.disabled, true)
}
protectedForm.verify("")
assert.equal(protectedForm.form.button.disabled, true)
// Even forced activation without a token cannot bypass the submission guard.
protectedForm.form.button.disabled = false
await protectedForm.form.submit()
assert.equal(protectedForm.resets, 5)
assert.equal(protectedForm.calls.length, 3)
assert.match(protectedForm.form.status.textContent, /complete the human verification/u)
protectedForm.verify()
protectedForm.callbacks["expired-callback"]()
assert.equal(protectedForm.form.button.disabled, true)
assert.match(protectedForm.form.status.textContent, /expired/u)
protectedForm.callbacks["error-callback"]()
assert.equal(protectedForm.form.button.disabled, true)
assert.match(protectedForm.form.status.textContent, /temporarily unavailable/u)

// A fresh callback while a request is in flight must not allow duplicate sends.
let resolveResponse!: (value: Response) => void
protectedForm.respond(() => new Promise((resolve) => { resolveResponse = resolve }))
protectedForm.verify()
const pending = protectedForm.form.submit()
protectedForm.verify("fresh-during-request")
assert.equal(protectedForm.form.button.disabled, true)
resolveResponse(new Response("{}", { status: 202 }))
await pending
assert.equal(protectedForm.resets, 6)
protectedForm.cleanup()
assert.equal(protectedForm.removals, 1)
protectedForm.callbacks.callback()
assert.equal(protectedForm.form.button.disabled, true)

// SPA navigation reuses the loaded API, but owns a fresh removable widget.
protectedForm.nav()
await flush()
assert.equal(protectedForm.renders, 2)
assert.equal(protectedForm.scripts.length, 1)
protectedForm.cleanup()
assert.equal(protectedForm.removals, 2)
const abandoned = harness(true)
abandoned.cleanup()
await abandoned.load()
assert.equal(abandoned.renders, 0)
const failed = harness(true)
failed.scripts[0].onerror()
await flush()
assert.equal(failed.form.button.disabled, true)
assert.match(failed.form.status.textContent, /temporarily unavailable/u)
assert.equal(failed.scripts[0].removed, true)
const timedOut = harness(true)
for (const timeout of timedOut.timers.values()) timeout()
await flush()
assert.equal(timedOut.form.button.disabled, true)
assert.match(timedOut.form.status.textContent, /temporarily unavailable/u)

// Selection convenience is independent of challenge setup and makes no request.
for (const challenged of [false, true]) {
  const selected = harness(challenged)
  selected.form.fields.quote.value = ""
  selected.select("  First\n\t passage   with *Markdown*, ‘quotes’ & λ. \n", "code")
  selected.documentEvents.emit("selectionchange")
  // Moving focus can collapse the selection before the details opens.
  selected.select("")
  selected.documentEvents.emit("selectionchange")
  selected.form.openForm()
  assert.equal(selected.form.fields.quote.value, "First passage with *Markdown*, ‘quotes’ & λ.")
  assert.match(selected.form.selectionHint.textContent, /Selected text added/u)
  assert.equal(selected.calls.length, 0)
  assert.equal(selected.scripts.length, challenged ? 1 : 0)
  selected.cleanup()
}
for (const region of ["nav", "sidebar", "form", "cross-form", "cross-article"] as const) {
  const outside = harness(false)
  outside.form.fields.quote.value = ""
  outside.select("Ignore this selection", region)
  outside.documentEvents.emit("pointerup")
  outside.form.openForm()
  assert.equal(outside.form.fields.quote.value, "", region)
  outside.form.useSelection.emit("click")
  assert.match(outside.form.selectionHint.textContent, /Select text in the page article/u)
}
for (const event of ["pointerup", "keyup", "selectionchange", "pointerdown"]) {
  const captured = harness(false)
  captured.form.fields.quote.value = ""
  captured.select(`Saved by ${event}`)
  captured.documentEvents.emit(event)
  captured.select("")
  captured.form.openForm()
  assert.equal(captured.form.fields.quote.value, `Saved by ${event}`)
}
const tooLong = harness(false)
tooLong.form.fields.quote.value = ""
tooLong.select("x".repeat(tooLong.form.fields.quote.maxLength + 1))
tooLong.form.openForm()
assert.equal(tooLong.form.fields.quote.value, "")
assert.match(tooLong.form.selectionHint.textContent, /too long.*shorter/u)
tooLong.select("x".repeat(tooLong.form.fields.quote.maxLength))
tooLong.form.useSelection.emit("click")
assert.equal(tooLong.form.fields.quote.value.length, tooLong.form.fields.quote.maxLength)
tooLong.form.fields.quote.value = "Keep this manual quote"
tooLong.select("x".repeat(tooLong.form.fields.quote.maxLength + 1))
tooLong.form.useSelection.emit("click")
assert.equal(tooLong.form.fields.quote.value, "Keep this manual quote")
assert.match(tooLong.form.selectionHint.textContent, /too long.*shorter/u)
const typed = harness(false)
typed.form.fields.quote.value = "Reader's own exact quote"
typed.select("New selection")
typed.form.openForm()
assert.equal(typed.form.fields.quote.value, "Reader's own exact quote")
typed.form.details.open = false
typed.form.openForm()
assert.equal(typed.form.fields.quote.value, "Reader's own exact quote")
// The native button click is also generated by keyboard Enter/Space activation.
typed.form.useSelection.emit("click")
assert.equal(typed.form.fields.quote.value, "New selection")
typed.select("  Recaptured\n\t selection  ")
typed.form.useSelection.emit("click")
assert.equal(typed.form.fields.quote.value, "Recaptured selection")
typed.select("")
typed.form.fields.quote.value = "Manual text again"
typed.form.useSelection.emit("click")
assert.equal(typed.form.fields.quote.value, "Recaptured selection")
// A new non-content selection must not reapply an older article selection.
typed.select("Navigation text", "nav")
typed.documentEvents.emit("selectionchange")
typed.form.useSelection.emit("click")
assert.equal(typed.form.fields.quote.value, "Recaptured selection")
assert.match(typed.form.selectionHint.textContent, /Select text in the page article/u)
// Quartz calls cleanup before replacing the article and emitting nav.
const navigation = harness(false)
navigation.form.fields.quote.value = ""
navigation.select("Previous page selection")
navigation.documentEvents.emit("keyup")
navigation.cleanup()
for (const event of ["pointerup", "keyup", "selectionchange", "pointerdown"]) {
  assert.equal(navigation.documentEvents.listeners.get(event)?.size, 0)
}
assert.equal(navigation.form.summary.listeners.get("click")?.size, 0)
assert.equal(navigation.form.useSelection.listeners.get("click")?.size, 0)
assert.equal(navigation.form.details.listeners.get("toggle")?.size, 0)
navigation.nav()
// Even a browser range left pointing at the detached old article is ignored.
navigation.form.openForm()
assert.equal(navigation.form.fields.quote.value, "")
navigation.select("")
navigation.form.useSelection.emit("click")
assert.equal(navigation.form.fields.quote.value, "")
navigation.select("Next page selection")
navigation.form.useSelection.emit("click")
assert.equal(navigation.form.fields.quote.value, "Next page selection")
// Opening details by keyboard/programmatic toggle also fills without a click.
const toggled = harness(false)
toggled.form.fields.quote.value = ""
toggled.select("Toggle-only selection")
toggled.form.details.open = true
toggled.form.details.emit("toggle")
assert.equal(toggled.form.fields.quote.value, "Toggle-only selection")
console.log("suggest-challenge render and browser lifecycle checks passed")
console.log("suggest-selection capture, bounds, explicit replacement and SPA cleanup checks passed")

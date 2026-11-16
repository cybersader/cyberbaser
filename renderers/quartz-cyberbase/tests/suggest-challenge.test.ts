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
assert.ok(widgetIndex < challengedNodes.findIndex((node) => node.tag === "button"))
assert.ok(challengedNodes.some((node) => node.props?.role === "status" && node.props["aria-live"] === "polite"))

class TextArea { constructor(public value: string) {} }
class Form {
  dataset = { bindingDigest: options.bindingDigest, pageId: `page-v1:${"A".repeat(43)}`, action: "https://intake.example/v1/corrections" }
  button = { disabled: true }
  status = { textContent: "", dataset: {} as Record<string, string> }
  container: { dataset: { sitekey: string; provider?: string } } | null
  handler: ((event: unknown) => Promise<void>) | undefined
  resetCount = 0
  fields: Record<string, TextArea> = {
    quote: new TextArea("teh"), prefix: new TextArea(""), suffix: new TextArea(""),
    replacement: new TextArea("the"), rationale: new TextArea("Fix a typo."), evidence: new TextArea(""),
  }
  elements = { namedItem: (name: string) => this.fields[name] }
  constructor(challenged: boolean, provider?: string) {
    this.container = challenged ? { dataset: { sitekey: "test-site-key", ...(provider === undefined ? {} : { provider }) } } : null
  }
  querySelector(selector: string) {
    if (selector === ".suggest-correction-challenge") return this.container
    if (selector === ".suggest-correction-status") return this.status
    if (selector === "button[type='submit']") return this.button
    return null
  }
  addEventListener(_name: string, handler: (event: unknown) => Promise<void>) { this.handler = handler }
  removeEventListener() { this.handler = undefined }
  reset() { this.resetCount++ }
  submit() { return this.handler!({ currentTarget: this, preventDefault() {} }) }
}
async function flush() { for (let i = 0; i < 5; i++) await Promise.resolve() }
function harness(challenged: boolean, withForm = true, provider?: string) {
  const form = new Form(challenged, provider)
  const scripts: Array<Record<string, any>> = []
  const cleanups: Array<() => void> = []
  const timers = new Map<number, () => void>()
  let timerId = 0
  let nav: () => void = () => {}
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
  const win: Record<string, any> = { addCleanup: (fn: () => void) => cleanups.push(fn) }
  const context = {
    ...client, window: win,
    document: {
      addEventListener(name: string, fn: () => void) { assert.equal(name, "nav"); nav = fn },
      querySelectorAll() { return withForm ? [form] : [] },
      createElement(tag: string) { assert.equal(tag, "script"); return { remove() { this.removed = true } } },
      head: { appendChild(script: Record<string, any>) { scripts.push(script) } },
    },
    HTMLFormElement: Form, HTMLTextAreaElement: TextArea,
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    crypto, Uint8Array, btoa, TextEncoder, TextDecoder, URL, Headers, Response,
    setTimeout(fn: () => void) { timers.set(++timerId, fn); return timerId },
    clearTimeout(id: number) { timers.delete(id) },
    fetch: async (_url: unknown, init: RequestInit) => { calls.push(init); return response() },
  }
  runInNewContext(browserCode, context)
  nav()
  return {
    form, scripts, calls, timers,
    get resets() { return resets }, get removals() { return removals }, get renders() { return renders },
    get callbacks() { return callbacks },
    respond(fn: () => Promise<Response>) { response = fn },
    async load() { win.turnstile = api; scripts[0].onload(); await flush() },
    verify(value = "test-single-use-token") { token = value; callbacks.callback() },
    cleanup() { cleanups.splice(0).forEach((fn) => fn()) },
    nav() { nav() },
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
assert.equal(harness(true, false).scripts.length, 0)
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

console.log("suggest-challenge render and browser lifecycle checks passed")

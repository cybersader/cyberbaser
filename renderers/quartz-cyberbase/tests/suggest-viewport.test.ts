import assert from "node:assert/strict"
import { setupSuggestViewport } from "../components/suggestModeViewport"

class Events {
  listeners = new Map<string, Set<() => void>>()
  addEventListener(name: string, handler: () => void) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name)!.add(handler) }
  removeEventListener(name: string, handler: () => void) { this.listeners.get(name)?.delete(handler) }
  emit(name: string) { for (const handler of this.listeners.get(name) ?? []) handler() }
  get size() { return [...this.listeners.values()].reduce((sum, handlers) => sum + handlers.size, 0) }
}
class Box {
  classes = new Set<string>()
  children: Box[] = []
  scrollTop = 0
  editable = true
  rect = { top: 650, bottom: 676, height: 26 }
  tagName = "DIV"
  className = "editor"
  textContent = ""
  removed = false
  centered: ScrollIntoViewOptions[] = []
  style = {
    cssText: "", values: new Map<string, string>(),
    setProperty(name: string, value: string) { this.values.set(name, value) },
    removeProperty(name: string) { this.values.delete(name) },
  }
  classList = { add: (name: string) => this.classes.add(name), remove: (name: string) => this.classes.delete(name), contains: (name: string) => this.classes.has(name) }
  append(node: Box) { this.children.push(node) }
  remove() { this.removed = true }
  setAttribute() {}
  contains(node: unknown): boolean { return node === this || this.children.some(child => child.contains(node)) }
  matches() { return this.editable }
  querySelector() { return this.children.find(child => child.classes.has("cb-source-active")) ?? null }
  getBoundingClientRect() { return this.rect }
  scrollIntoView(options: ScrollIntoViewOptions) { this.centered.push(options) }
}
const viewport = Object.assign(new Events(), { height: 844, offsetTop: 0, scale: 1 })
const body = new Box()
const root = new Box(), form = new Box(), tray = new Box(), reason = new Box(), comment = new Box(), source = new Box(), button = new Box()
button.editable = false
root.classes.add("cb-suggesting"); root.children.push(source); form.children.push(reason, button); tray.children.push(comment)
const doc = Object.assign(new Events(), { body, documentElement: { clientHeight: 844 }, activeElement: null as Box | null, createElement: () => new Box() })
let caret = { top: 650, bottom: 676, height: 26 }, scrollCalls = 0, pointerCoarse = true, hoverNone = false
let id = 0
const frames = new Map<number, () => void>(), timers = new Map<number, { fn: () => void; delay: number }>()
const win = Object.assign(new Events(), {
  visualViewport: viewport as typeof viewport | null, innerHeight: 844, location: { search: "" },
  matchMedia: (query: string) => ({ matches: query === "(pointer: coarse)" ? pointerCoarse : hoverNone }),
  setTimeout: (fn: () => void, delay: number) => { timers.set(++id, { fn, delay }); return id },
  clearTimeout: (n: number) => timers.delete(n),
  getSelection: () => ({ rangeCount: 1, focusNode: source, getRangeAt: () => ({ cloneRange: () => ({ collapse() {}, getBoundingClientRect: () => caret }) }) }),
  scrollBy: ({ top }: { top: number }) => { scrollCalls++; caret = { ...caret, top: caret.top - top, bottom: caret.bottom - top } },
})
const old = { window: globalThis.window, document: globalThis.document, requestAnimationFrame: globalThis.requestAnimationFrame, cancelAnimationFrame: globalThis.cancelAnimationFrame }
Object.assign(globalThis, { window: win, document: doc,
  requestAnimationFrame: (fn: () => void) => { frames.set(++id, fn); return id }, cancelAnimationFrame: (n: number) => frames.delete(n) })
const flush = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn()) }
const tick = (delay: number) => { for (const [key, timer] of [...timers]) if (timer.delay <= delay) { timers.delete(key); timer.fn() }; flush() }
const open = () => body.classes.has("cb-suggest-keyboard-open")
try {
  const controller = setupSuggestViewport(root as any, form as any, tray as any)
  flush(); assert.equal(open(), false); assert.equal(body.children.length, 0, "no debug DOM without the exact query")
  doc.activeElement = root; doc.emit("focusin"); flush()
  assert.equal(open(), true, "coarse-pointer editor focus hides chrome without any viewport shrink")
  assert.equal(body.style.values.get("--cb-suggest-visible-height"), "844px")
  assert.equal(scrollCalls, 0)
  source.classes.add("cb-source-active")
  tick(350)
  assert.equal(source.centered.length, 1, "active block centers after keyboard animation")
  assert.equal(source.centered[0].block, "center")
  viewport.height = 420; viewport.offsetTop = 60; viewport.emit("resize"); flush()
  assert.equal(open(), true)
  assert.equal(body.style.values.get("--cb-suggest-visible-top"), "60px")
  assert.equal(body.style.values.get("--cb-suggest-visible-height"), "420px")
  assert.equal(body.style.values.get("--cb-suggest-keyboard-bottom"), "364px")
  assert.equal(caret.bottom, 456, "caret is scrolled above keyboard with breathing room")
  assert.equal(scrollCalls, 1)
  viewport.offsetTop = 80; viewport.emit("scroll"); flush()
  assert.equal(body.style.values.get("--cb-suggest-visible-top"), "80px")
  assert.equal(scrollCalls, 1, "visible caret does not trigger a scroll loop")
  viewport.height = 844; viewport.offsetTop = 0; viewport.emit("resize"); flush()
  assert.equal(open(), true, "focus rule does not depend on WebKit reporting a keyboard")
  viewport.scale = 2; viewport.height = 420
  const beforeZoom = scrollCalls; viewport.emit("resize"); flush()
  assert.equal(open(), true); assert.equal(scrollCalls, beforeZoom, "zoom excludes corrective scrolling, not focus hiding")
  viewport.scale = 1; viewport.offsetTop = 60
  doc.activeElement = reason; doc.emit("focusin"); flush()
  assert.equal(form.scrollTop, 220, "review input scrolls inside the visible sheet")
  assert.equal(scrollCalls, 1, "review sheet never scrolls the article underneath")
  doc.activeElement = null; doc.emit("focusout"); flush()
  assert.equal(open(), true, "blur grace period prevents focus-transition flicker")
  doc.activeElement = comment; doc.emit("focusin"); flush(); tick(180)
  assert.equal(open(), true, "moving between our editable controls cancels restoration")
  assert.ok(tray.scrollTop > 0, "comment textarea remains inside the visible change sheet")
  doc.activeElement = source; doc.emit("focusin"); flush(); assert.equal(open(), true, "source editor uses the focus rule")
  doc.activeElement = button; doc.emit("focusout"); doc.emit("focusin"); flush()
  assert.equal(open(), true); tick(180); assert.equal(open(), false, "non-editing control restores chrome after the grace period")
  assert.equal(body.style.values.size, 0)
  pointerCoarse = false; hoverNone = true; viewport.height = 844; viewport.offsetTop = 0
  doc.activeElement = reason; doc.emit("focusin"); flush(); assert.equal(open(), true, "hover:none also enables focus hiding")
  doc.activeElement = null; doc.emit("focusout"); flush(); tick(180); assert.equal(open(), false)
  hoverNone = false; doc.activeElement = root; doc.emit("focusin"); flush()
  assert.equal(open(), false, "fine-pointer desktop focus keeps toolbar available")
  viewport.height = 760; controller.refresh(); flush(); assert.equal(open(), false)
  pointerCoarse = true; root.classes.delete("cb-suggesting"); controller.refresh(); flush(); assert.equal(open(), false)
  root.classes.add("cb-suggesting"); viewport.height = 420; viewport.offsetTop = 60
  root.rect = { top: 0, bottom: 2000, height: 2000 }; source.rect = { top: 600, bottom: 630, height: 30 }
  caret = { top: 0, bottom: 0, height: 0 }; controller.refresh(); flush()
  assert.equal(caret.top, -174, "zero-height caret falls back to the active block, not the article")
  doc.emit("focusout"); doc.emit("focusin"); viewport.emit("resize"); controller.destroy(); flush(); tick(1000)
  assert.equal(open(), false); assert.equal(body.style.values.size, 0)
  assert.equal(viewport.size + win.size + doc.size + timers.size, 0, "SPA cleanup removes listeners and pending timers")
  win.visualViewport = null
  const absent = setupSuggestViewport(root as any, form as any, tray as any)
  flush(); assert.equal(open(), true, "touch focus still hides chrome when visualViewport is missing")
  doc.emit("focusin"); tick(350); assert.equal(source.centered.length, 2, "delayed block centering works without visualViewport")
  absent.destroy(); flush()
  win.location.search = "?cbdebug=other"
  const other = setupSuggestViewport(root as any, form as any, tray as any); flush(); other.destroy()
  assert.equal(body.children.length, 0, "other query values do not enable the overlay")
  win.visualViewport = viewport; win.location.search = "?cbdebug=viewport"
  const diagnostic = setupSuggestViewport(root as any, form as any, tray as any); flush()
  const debug = body.children[0]
  for (const text of ["innerHeight: 844", "visualViewport.height: 420", "visualViewport.offsetTop: 60", "visualViewport.scale: 1", "activeElement: DIV.editor", "pointer coarse: true", "chrome hidden: true"]) assert.ok(debug.textContent.includes(text), text)
  doc.activeElement = null; doc.emit("focusout"); tick(180)
  assert.ok(debug.textContent.includes("chrome hidden: false"), "diagnostics follow focus restoration")
  viewport.height = 500; viewport.emit("resize"); flush()
  assert.ok(debug.textContent.includes("visualViewport.height: 500"), "diagnostics follow live viewport changes")
  diagnostic.destroy(); assert.equal(debug.removed, true)
  assert.equal(viewport.size + win.size + doc.size + timers.size, 0)
} finally { Object.assign(globalThis, old) }
console.log("suggest-viewport: coarse/hover-none focus hiding without viewport shrink, delayed blur/centering, review/comment/source inputs, caret/block fallback, desktop/zoom guards, missing viewport, query-only live diagnostics and SPA cleanup passed")

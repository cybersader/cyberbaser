import assert from "node:assert/strict"
import { setupEditEntryScroll } from "../components/editEntryClient"

const saved = { document: globalThis.document, window: globalThis.window }
const classes = new Set<string>(), timers = new Map<number, () => void>()
let scroll: (() => void) | undefined, change: (() => void) | undefined, id = 0
const reduced = { matches: false, addEventListener(_event: string, fn: () => void) { change = fn }, removeEventListener() { change = undefined } }
const windowMock = {
  scrollY: 0, matchMedia: () => reduced,
  addEventListener(_event: string, fn: () => void) { scroll = fn }, removeEventListener() { scroll = undefined },
  setTimeout(fn: () => void) { timers.set(++id, fn); return id }, clearTimeout(timer: number) { timers.delete(timer) },
}
Object.assign(globalThis, {
  window: windowMock,
  document: { querySelectorAll: () => [{ classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c) } }] },
})
try {
  const cleanup = setupEditEntryScroll()
  const down = () => classes.has("cb-edit-scrolling-down")
  windowMock.scrollY = 200; scroll!(); assert.equal(down(), true)
  windowMock.scrollY = 300; scroll!(); assert.equal(timers.size, 1, "one restore timer while scrolling")
  windowMock.scrollY = 250; scroll!(); assert.equal(down(), false); assert.equal(timers.size, 0)
  windowMock.scrollY = 400; scroll!(); [...timers.values()][0](); assert.equal(down(), false, "stop restores entry")
  windowMock.scrollY = 500; scroll!(); assert.equal(down(), true)
  reduced.matches = true; change!(); assert.equal(down(), false, "live reduced-motion change restores entry")
  windowMock.scrollY = 600; scroll!(); assert.equal(down(), false, "reduced motion stays still")
  reduced.matches = false; windowMock.scrollY = 700; scroll!(); assert.equal(down(), true)
  cleanup(); assert.equal(down(), false); assert.equal(timers.size, 0); assert.equal(scroll, undefined); assert.equal(change, undefined)
} finally { Object.assign(globalThis, saved) }
console.log("edit-entry: scroll down/up/stop, reduced motion and SPA cleanup passed")

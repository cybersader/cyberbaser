import { colorSchemeScript, stylesheetSlug } from "../plugins/appearanceCore"
import { parseSiteConfig } from "../plugins/siteConfig"
const assert = (ok: unknown, message: string) => { if (!ok) throw new Error(message) }
const throws = (fn: () => unknown, message: string) => { let threw = false; try { fn() } catch { threw = true }; assert(threw, message) }

// Settings: stylesheet stays inside the settings folder, scheme is one of three.
const config = parseSiteConfig({ appearance: { stylesheet: "site.css", colorScheme: "dark" } }, "/vault/.cyberbaser")
assert(config.appearance?.stylesheet === "/vault/.cyberbaser/site.css", `stylesheet ${config.appearance?.stylesheet}`)
assert(config.appearance?.colorScheme === "dark", "scheme")
assert(parseSiteConfig({ appearance: { stylesheet: "a.css" } }, "/s").appearance?.colorScheme === "system", "system default")
assert(parseSiteConfig({}, "/s").appearance === undefined, "no appearance without settings")
throws(() => parseSiteConfig({ appearance: { stylesheet: "../publish.css" } }, "/s"), "stylesheet outside settings folder")
throws(() => parseSiteConfig({ appearance: { stylesheet: "/etc/x.css" } }, "/s"), "absolute stylesheet")
throws(() => parseSiteConfig({ appearance: { stylesheet: "site.js" } }, "/s"), "non-css stylesheet")
throws(() => parseSiteConfig({ appearance: { colorScheme: "blue" } }, "/s"), "unknown scheme")
throws(() => parseSiteConfig({ appearance: { font: "x" } }, "/s"), "unknown appearance key")

// Stylesheet name follows content.
assert(stylesheetSlug("a{}") === stylesheetSlug("a{}") && stylesheetSlug("a{}") !== stylesheetSlug("b{}"), "content addressed")
assert(/^static\/site-[0-9a-f]{12}$/.test(stylesheetSlug("a{}")), stylesheetSlug("a{}"))

// Default scheme applies only when the reader has no saved choice.
assert(colorSchemeScript("system") === undefined, "system adds nothing")
function runScheme(saved: string | null) {
  const attrs: Record<string, string> = { "saved-theme": "light" }
  const documentStub = { documentElement: { setAttribute: (k: string, v: string) => { attrs[k] = v } } }
  const storage = { getItem: () => saved }
  new Function("document", "localStorage", colorSchemeScript("dark")!)(documentStub, storage)
  return attrs["saved-theme"]
}
assert(runScheme(null) === "dark", "default applied")
assert(runScheme("light") === "light", "reader choice kept")
console.log("appearance: settings validation, content-addressed stylesheet and default color scheme passed")

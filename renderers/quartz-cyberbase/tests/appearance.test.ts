import { colorSchemeScript, faviconSlug, isPng, stylesheetSlug } from "../plugins/appearanceCore"
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
// Site icon: PNG only, inside the settings folder, content-addressed.
assert(parseSiteConfig({ appearance: { favicon: "icon.png" } }, "/v/.cyberbaser").appearance?.favicon === "/v/.cyberbaser/icon.png", "favicon path")
throws(() => parseSiteConfig({ appearance: { favicon: "icon.svg" } }, "/s"), "non-png favicon")
throws(() => parseSiteConfig({ appearance: { favicon: "../icon.png" } }, "/s"), "favicon outside settings folder")
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])
assert(isPng(png) && !isPng(new Uint8Array([0x3c, 0x73, 0x76, 0x67, 0, 0, 0, 0, 0])), "png signature")
assert(/^static\/site-icon-[0-9a-f]{12}$/.test(faviconSlug(png)), faviconSlug(png))
console.log("appearance: settings validation, content-addressed stylesheet and default color scheme, site icon passed")

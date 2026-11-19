import { readFileSync } from "fs"
import { FullSlug, joinSegments } from "../util/path"
import { QuartzEmitterPlugin } from "../plugins/types"
import { write } from "../plugins/emitters/helpers"
import { h } from "preact"
import { ColorScheme, colorSchemeScript, faviconSlug, isPng, stylesheetSlug } from "./appearanceCore"

/**
 * The vault's own look, the way Obsidian Publish reads publish.css: a
 * stylesheet from the vault's settings folder, linked after the renderer's own
 * styles so it wins ties, the site icon, and the default color scheme.
 *
 * The icon is published under a content-addressed name, declared after
 * Quartz's own icon link (browsers use the last), and as /favicon.ico; the
 * config drops Quartz's Favicon emitter when a vault icon is set.
 *
 * Settings: `appearance.stylesheet`, `appearance.favicon` and `appearance.colorScheme` in
 * `.cyberbaser/site.yml`. Copied into `<quartz>/quartz/cyberbase/` by setup.sh.
 */
export interface VaultAppearanceOptions {
  /** Absolute path of the stylesheet, or unset for none. */
  stylesheet?: string
  /** Absolute path of a PNG site icon, or unset for the renderer default. */
  favicon?: string
  colorScheme: ColorScheme
  /** Path prefix of the site ("" at a domain root). */
  basePath: string
}

export const VaultAppearance: QuartzEmitterPlugin<VaultAppearanceOptions> = (opts) => {
  const cssText = opts?.stylesheet ? readFileSync(opts.stylesheet, "utf8") : undefined
  const slug = cssText === undefined ? undefined : stylesheetSlug(cssText)
  const script = opts ? colorSchemeScript(opts.colorScheme) : undefined
  const icon = opts?.favicon ? new Uint8Array(readFileSync(opts.favicon)) : undefined
  if (icon && !isPng(icon)) throw new Error(`appearance.favicon is not a PNG file: ${opts!.favicon}`)
  const iconSlug = icon ? faviconSlug(icon) : undefined
  const base = opts?.basePath || "/"
  return {
    name: "VaultAppearance",
    externalResources() {
      return {
        css: slug ? [{ content: joinSegments(base, `${slug}.css`) }] : [],
        js: script ? [{ loadTime: "beforeDOMReady", contentType: "inline", script }] : [],
        additionalHead: iconSlug
          ? [
              h("link", { rel: "icon", type: "image/png", href: joinSegments(base, `${iconSlug}.png`) }),
              h("link", { rel: "apple-touch-icon", href: joinSegments(base, `${iconSlug}.png`) }),
            ]
          : [],
      }
    },
    async *emit(ctx) {
      if (cssText !== undefined && slug) yield write({ ctx, content: cssText, slug: slug as FullSlug, ext: ".css" })
      if (icon && iconSlug) {
        yield write({ ctx, content: Buffer.from(icon), slug: iconSlug as FullSlug, ext: ".png" })
        yield write({ ctx, content: Buffer.from(icon), slug: "favicon" as FullSlug, ext: ".ico" })
      }
    },
  }
}

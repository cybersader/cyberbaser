import { readFileSync } from "fs"
import { FullSlug, joinSegments } from "../util/path"
import { QuartzEmitterPlugin } from "../plugins/types"
import { write } from "../plugins/emitters/helpers"
import { ColorScheme, colorSchemeScript, stylesheetSlug } from "./appearanceCore"

/**
 * The vault's own look, the way Obsidian Publish reads publish.css: a
 * stylesheet from the vault's settings folder, linked after the renderer's own
 * styles so it wins ties, plus the site's default color scheme.
 *
 * Settings: `appearance.stylesheet` and `appearance.colorScheme` in
 * `.cyberbaser/site.yml`. Copied into `<quartz>/quartz/cyberbase/` by setup.sh.
 */
export interface VaultAppearanceOptions {
  /** Absolute path of the stylesheet, or unset for none. */
  stylesheet?: string
  colorScheme: ColorScheme
  /** Path prefix of the site ("" at a domain root). */
  basePath: string
}

export const VaultAppearance: QuartzEmitterPlugin<VaultAppearanceOptions> = (opts) => {
  const cssText = opts?.stylesheet ? readFileSync(opts.stylesheet, "utf8") : undefined
  const slug = cssText === undefined ? undefined : stylesheetSlug(cssText)
  const script = opts ? colorSchemeScript(opts.colorScheme) : undefined
  return {
    name: "VaultAppearance",
    externalResources() {
      return {
        css: slug ? [{ content: joinSegments(opts!.basePath || "/", `${slug}.css`) }] : [],
        js: script ? [{ loadTime: "beforeDOMReady", contentType: "inline", script }] : [],
      }
    },
    async *emit(ctx) {
      if (cssText !== undefined && slug) yield write({ ctx, content: cssText, slug: slug as FullSlug, ext: ".css" })
    },
  }
}

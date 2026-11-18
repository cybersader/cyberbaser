import { QuartzComponentConstructor } from "./types"
import { fallbackScript } from "../cyberbase/legacyUrlsCore"

/**
 * Renders nothing. On the site's 404 page, forwards old-host URLs (any case,
 * `+`/`%20`, trailing slash) using `static/legacy-urls.json`, or says the note
 * is no longer public. Included only when a legacy URL snapshot is configured.
 */
export default ((opts: { basePath: string }) => {
  function LegacyUrlFallback() {
    return null
  }
  LegacyUrlFallback.afterDOMLoaded = fallbackScript(opts.basePath, `${opts.basePath}/static/legacy-urls.json`)
  return LegacyUrlFallback
}) satisfies QuartzComponentConstructor<{ basePath: string }>

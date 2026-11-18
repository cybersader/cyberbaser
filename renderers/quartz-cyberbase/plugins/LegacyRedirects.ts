import { createHash } from "crypto"
import { readFileSync } from "fs"
import { FullSlug, resolveRelative, simplifySlug } from "../util/path"
import { QuartzEmitterPlugin } from "../plugins/types"
import { write } from "../plugins/emitters/helpers"
import { normalizeLegacyPath, parseSnapshot, stubHtml } from "./legacyUrlsCore"

/**
 * Redirects for URLs from a previous publishing host, resolved at build time
 * from a snapshot the vault keeps (old URL -> source path).
 *
 * For each old URL whose source note is still published: a static redirect
 * page at the old path in `+` form and in space form. For every snapshot URL:
 * an entry in `static/legacy-urls.json`, keyed by a hash of the normalized
 * path, pointing at the new path or `0` for a note that is no longer public.
 * The 404 page's fallback script (see legacyUrlsCore) uses that map for case,
 * encoding and trailing-slash variants a static host cannot match.
 *
 * Copied into `<quartz>/quartz/cyberbase/` by setup.sh.
 */
export interface LegacyRedirectsOptions {
  /** Absolute path to the snapshot JSON. Unset disables the plugin. */
  snapshotPath?: string
}

export const hashLegacyKey = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 32)

export const LegacyRedirects: QuartzEmitterPlugin<LegacyRedirectsOptions> = (opts) => ({
  name: "LegacyRedirects",
  async *emit(ctx, content) {
    if (!opts?.snapshotPath) return
    const snapshot = parseSnapshot(readFileSync(opts.snapshotPath, "utf8"))
    const published = new Map<string, FullSlug>()
    for (const [, file] of content) {
      const relativePath = file.data.relativePath
      if (relativePath && file.data.slug) published.set(relativePath.normalize("NFC"), file.data.slug as FullSlug)
    }
    const taken = new Set<string>(ctx.allSlugs.map((slug) => slug.normalize("NFC")))
    const map: Record<string, string | 0> = {}
    let redirected = 0, retired = 0, stubs = 0, collisions = 0
    for (const entry of snapshot.urls) {
      const target = published.get(entry.source.normalize("NFC"))
      const keys = [entry.old, ...(entry.permalink ? [entry.permalink] : [])]
      for (const key of keys) {
        const hashed = hashLegacyKey(normalizeLegacyPath(key))
        // A permalink of a published note is already an AliasRedirects page.
        map[hashed] = target ? simplifySlug(target) : 0
      }
      if (!target) { retired++; continue }
      redirected++
      for (const form of new Set([entry.old, entry.old.replace(/\+/g, " ")])) {
        const slug = form.normalize("NFC") as FullSlug
        if (taken.has(slug)) { collisions++; continue }
        taken.add(slug)
        yield write({ ctx, content: stubHtml(resolveRelative(slug, target)), slug, ext: ".html" })
        stubs++
      }
    }
    // The previous host's home page (Publish indexFile README) is the new home.
    map[hashLegacyKey("readme")] = ""
    yield write({ ctx, content: JSON.stringify(map), slug: "static/legacy-urls" as FullSlug, ext: ".json" })
    console.log(`Legacy URLs: ${redirected} redirected (${stubs} pages, ${collisions} skipped for existing paths), ${retired} retired, from ${snapshot.urls.length} snapshot entries`)
  },
})

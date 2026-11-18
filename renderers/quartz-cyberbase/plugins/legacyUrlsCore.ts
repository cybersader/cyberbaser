/**
 * Pure helpers shared by the legacy-URL emitter, its browser fallback and tests.
 * No Quartz imports, no I/O.
 *
 * A legacy URL is an address from a previous publishing host (for example
 * Obsidian Publish: note path without `.md`, spaces as `+`). Matching ignores
 * case, `+`/`%20`, a trailing slash and a `.md`/`.html` suffix, because the old
 * host resolved all of those.
 */
export interface LegacyUrlEntry {
  /** Old path relative to the old site root, as the old host linked it. */
  old: string
  /** Vault-relative source path of the note it showed. */
  source: string
  permalink?: string
}

export interface LegacyUrlSnapshot {
  source?: string
  urls: LegacyUrlEntry[]
}

export function normalizeLegacyPath(path: string): string {
  let value = path.replace(/\+/g, " ")
  try {
    value = decodeURIComponent(value)
  } catch {
    // Keep undecodable input as typed; it simply will not match.
  }
  return value
    .normalize("NFC")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.(md|html)$/i, "")
    .toLowerCase()
}

/** Quartz (github-slugger) heading id for an old `#Heading Text` fragment. */
export function headingFragment(fragment: string): string {
  let value = fragment.replace(/\+/g, " ")
  try {
    value = decodeURIComponent(value)
  } catch {}
  if (value.startsWith("^")) return value
  return value
    .replace(/<[^>]*>/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replace(/ /g, "-")
}

export function parseSnapshot(text: string): LegacyUrlSnapshot {
  const data = JSON.parse(text)
  if (!data || !Array.isArray(data.urls)) throw new Error("legacy URL snapshot needs a urls array")
  for (const entry of data.urls) {
    if (!entry || typeof entry.old !== "string" || typeof entry.source !== "string" || entry.old === "" || !entry.source.endsWith(".md")) {
      throw new Error(`invalid legacy URL entry: ${JSON.stringify(entry)}`)
    }
    if (entry.old.split("/").some((part: string) => part === "." || part === "..")) throw new Error(`legacy URL escapes the site: ${entry.old}`)
    if (entry.permalink !== undefined && typeof entry.permalink !== "string") throw new Error(`invalid permalink for ${entry.old}`)
  }
  return data
}

/**
 * Browser fallback for the site's 404 page. Looks the requested path up by
 * SHA-256 of its normalized form, so the published map never lists the paths
 * of notes that left the site. `0` marks a known retired note; `""` is the site home.
 */
export function fallbackScript(basePath: string, mapUrl: string): string {
  return `(() => {
  if (document.body?.dataset.slug !== "404") return
  const base = ${JSON.stringify(basePath)}
  let path = location.pathname
  if (base && (path === base || path.startsWith(base + "/"))) path = path.slice(base.length)
  const norm = ${normalizeLegacyPath.toString()}
  const frag = ${headingFragment.toString()}
  const key = norm(path)
  if (!key || !crypto.subtle) return
  crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)).then(digest => {
    const hash = [...new Uint8Array(digest)].slice(0, 16).map(b => b.toString(16).padStart(2, "0")).join("")
    return fetch(${JSON.stringify(mapUrl)}).then(r => r.ok ? r.json() : {}).then(map => {
      if (!(hash in map)) return
      const target = map[hash]
      if (target !== 0) {
        location.replace(base + "/" + target + (location.hash ? "#" + encodeURIComponent(frag(location.hash.slice(1))) : ""))
        return
      }
      const note = document.createElement("p")
      note.className = "cb-legacy-retired"
      note.textContent = "This note was published on the old site but is no longer public."
      ;(document.querySelector("article") ?? document.body).prepend(note)
    })
  }).catch(() => {})
})()`
}

export function stubHtml(target: string): string {
  const escaped = target.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Moved</title>
<link rel="canonical" href="${escaped}"><meta name="robots" content="noindex">
<meta http-equiv="refresh" content="0; url=${escaped}">
<script>(function(t){var h=location.hash;if(h){t+="#"+encodeURIComponent((${headingFragment.toString()})(h.slice(1)))}location.replace(t)})(${JSON.stringify(target)})</script>
</head><body><p>This page moved to <a href="${escaped}">${escaped}</a>.</p></body></html>
`
}

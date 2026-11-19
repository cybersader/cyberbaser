type Part = { type: string; value?: string }
export type TocEntry = { depth: number; text: string; slug: string }

const raw = (parts: Part[]) => parts.map((p) => p.value ?? "").join("")
const visibleRaw = (parts: Part[]) => parts.filter((p) => p.type === "text").map((p) => p.value ?? "").join("")

/**
 * Rebuild TOC entries from headings' visible text (inline HTML dropped).
 * The anchor is slugged from that text as written, as the heading id is, so a
 * leading space left by an icon gives "-cyberbase"; the label is trimmed.
 * `slug` is a fresh stateful slugger (github-slugger's `slug`), applied to
 * every heading in order as the heading ids are, so duplicates get the same
 * -1, -2 suffixes. Entries are matched to headings in order by original text.
 */
export function tocPlainText(toc: TocEntry[], headings: { depth: number; parts: Part[] }[], slug: (text: string) => string): TocEntry[] {
  const rebuilt = headings.map((h) => {
    const written = visibleRaw(h.parts)
    return { raw: raw(h.parts), text: written.replace(/\s+/g, " ").trim(), slug: slug(written) }
  })
  let at = 0
  return toc.map((entry) => {
    for (let i = at; i < rebuilt.length; i++) {
      if (rebuilt[i].raw === entry.text) {
        at = i + 1
        return rebuilt[i].text ? { ...entry, text: rebuilt[i].text, slug: rebuilt[i].slug } : entry
      }
    }
    return entry
  })
}

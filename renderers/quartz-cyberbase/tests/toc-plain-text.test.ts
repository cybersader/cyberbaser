import { tocPlainText } from "../plugins/tocPlainTextCore"
const assert = (ok: unknown, message: string) => { if (!ok) throw new Error(message) }

// Minimal stand-in for github-slugger: lowercase, dashes, -1/-2 for repeats.
function slugger() {
  const seen = new Map<string, number>()
  return (text: string) => {
    const base = text.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, "").trim().replace(/\s/g, "-")
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    return n ? `${base}-${n}` : base
  }
}

const icon = '<img width="20" alt="" src="https://cdn.example/github.svg">'
const headings = [
  { depth: 1, parts: [{ type: "text", value: "🔗 Links" }] },
  { depth: 1, parts: [{ type: "html", value: icon }, { type: "text", value: " Cyberbase" }] },
  { depth: 2, parts: [{ type: "html", value: icon }, { type: "text", value: " Base Source" }] },
  { depth: 4, parts: [{ type: "text", value: "Deep" }] },
  { depth: 2, parts: [{ type: "html", value: icon }, { type: "text", value: " Cyberbase" }] },
]
const toc = [
  { depth: 0, text: "🔗 Links", slug: "-links" },
  { depth: 0, text: `${icon} Cyberbase`, slug: "img-width20-broken" },
  { depth: 1, text: `${icon} Base Source`, slug: "img-broken" },
  { depth: 1, text: `${icon} Cyberbase`, slug: "img-broken-1" },
]
const out = tocPlainText(toc, headings, slugger())
assert(out[0].text === "🔗 Links", "plain heading kept")
assert(out[1].text === "Cyberbase" && out[1].slug === "cyberbase", JSON.stringify(out[1]))
assert(out[2].text === "Base Source" && out[2].slug === "base-source", JSON.stringify(out[2]))
assert(out[3].text === "Cyberbase" && out[3].slug === "cyberbase-1", `duplicate suffix ${JSON.stringify(out[3])}`)
assert(out.every((e, i) => e.depth === toc[i].depth), "depths kept")
// An entry that matches no heading is left alone.
assert(tocPlainText([{ depth: 0, text: "x", slug: "x" }], headings, slugger())[0].slug === "x", "unmatched kept")
console.log("toc-plain-text: icon headings get visible text and real anchors")

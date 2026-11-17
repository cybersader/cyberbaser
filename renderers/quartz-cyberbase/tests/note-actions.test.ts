import { githubSourceHost, parseNoteDate } from "../components/sourceLinks"
const assert = (ok: unknown, message: string) => { if (!ok) throw new Error(message) }
const sha = "0123456789abcdef0123456789abcdef01234567"
const host = githubSourceHost({ repoUrl: "https://github.com/cybersader/cyberbase", branch: "main", revision: sha })
const links = host.linksFor("📁 03 - Curations, Stacks/Awesome AI/Awesome AI.md")
const path = "%F0%9F%93%81%2003%20-%20Curations%2C%20Stacks/Awesome%20AI/Awesome%20AI.md"
assert(links.view === `https://github.com/cybersader/cyberbase/blob/${sha}/${path}`, `view ${links.view}`)
assert(links.edit === `https://github.com/cybersader/cyberbase/edit/main/${path}`, `edit ${links.edit}`)
assert(links.raw === `https://raw.githubusercontent.com/cybersader/cyberbase/${sha}/${path}`, `raw ${links.raw}`)
assert(links.webEditor === `https://github.dev/cybersader/cyberbase/blob/main/${path}`, `webEditor ${links.webEditor}`)
assert(links.archive === "https://github.com/cybersader/cyberbase/archive/refs/heads/main.zip", `archive ${links.archive}`)
// Never the old repo; never a slug.
assert(!JSON.stringify(links).includes("awesome-cybersader"), "old repo leaked")
// Unpinned builds fall back to the branch; bad revisions are ignored.
assert(githubSourceHost({ repoUrl: "https://github.com/cybersader/cyberbase", revision: "not-a-sha" }).linksFor("a.md").raw.endsWith("/main/a.md"), "bad revision not ignored")
for (const bad of ["https://github.com/x", "http://github.com/a/b", "https://evil.example/a/b"]) {
  let threw = false; try { githubSourceHost({ repoUrl: bad }) } catch { threw = true }
  assert(threw, `accepted repo ${bad}`)
}
let threw = false; try { githubSourceHost({ repoUrl: "https://github.com/a/b", branch: "../x" }) } catch { threw = true }
assert(threw, "accepted traversal branch")
// Dates as the vault writes them.
const d = parseNoteDate("Wednesday, May 15th 2024, 9:13 pm")!
assert(d.toISOString() === "2024-05-15T21:13:00.000Z", `obsidian date ${d?.toISOString()}`)
assert(parseNoteDate("Wednesday, February 12th 2025, 12:05 am")!.toISOString() === "2025-02-12T00:05:00.000Z", "12 am")
assert(parseNoteDate("2024-05-15")!.toISOString().startsWith("2024-05-15"), "iso")
assert(parseNoteDate("February 31st 2025") === undefined, "impossible day accepted")
assert(parseNoteDate("someday") === undefined && parseNoteDate(42) === undefined, "garbage accepted")
console.log("note-actions: source links from vault path, revision pinning, repo/branch guards and vault date parsing passed")

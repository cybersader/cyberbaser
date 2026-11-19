import { hasFrontmatterDates, parseGitLog, RECORD } from "../plugins/gitDatesCore"
const assert = (ok: unknown, message: string) => { if (!ok) throw new Error(message) }

// Newest commit first, as git log prints it.
const log = [
  "2025-03-02T10:00:00-05:00\n\nnotes/a.md\nnotes/b c.md\n",
  "2024-06-01T09:00:00Z\n\nnotes/a.md\n",
  "2023-01-15T08:00:00+01:00\n\nnotes/a.md\n📁 emoji/n.md\n",
  "not a date\n\nnotes/ignored.md\n",
].map((r) => RECORD + r).join("")
const dates = parseGitLog(log)
assert(dates.get("notes/a.md")?.created.toISOString() === "2023-01-15T07:00:00.000Z", "created is the oldest commit")
assert(dates.get("notes/a.md")?.modified.toISOString() === "2025-03-02T15:00:00.000Z", "modified is the newest commit")
assert(dates.get("notes/b c.md")?.created.getTime() === dates.get("notes/b c.md")?.modified.getTime(), "one commit: same day")
assert(dates.has("📁 emoji/n.md"), "unquoted unicode path")
assert(!dates.has("notes/ignored.md"), "records without a date are skipped")

assert(!hasFrontmatterDates(undefined) && !hasFrontmatterDates({ title: "x" }), "no dates")
assert(hasFrontmatterDates({ "date created": "Saturday, March 9th 2024" }) && hasFrontmatterDates({ modified: "2024-01-01" }), "vault and Quartz keys")
assert(!hasFrontmatterDates({ date: "" }), "empty value does not count")
console.log("git-dates: first/last commit per path, unicode paths, frontmatter dates win")

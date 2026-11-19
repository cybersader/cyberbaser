/**
 * Pure parts of GitDates: parse one `git log` pass into first and last commit
 * dates per path, and decide whether a note's frontmatter already dates it.
 */
export type GitDates = { created: Date; modified: Date }

/** Separator written before each commit by `--format=%x1e%aI`. */
export const RECORD = "\x1e"

/**
 * `git log --no-renames --format=%x1e%aI --name-only` lists commits newest
 * first: the first date seen for a path is its last change, the last date seen
 * is when it was added.
 */
export function parseGitLog(output: string): Map<string, GitDates> {
  const dates = new Map<string, GitDates>()
  for (const record of output.split(RECORD)) {
    const lines = record.split("\n")
    const stamp = new Date(lines[0].trim())
    if (Number.isNaN(stamp.getTime())) continue
    for (const line of lines.slice(1)) {
      const file = line.trim()
      if (!file) continue
      const seen = dates.get(file)
      if (seen) seen.created = stamp
      else dates.set(file, { created: stamp, modified: stamp })
    }
  }
  return dates
}

/** Frontmatter keys that date a note (the vault's own, and Quartz's). */
const DATE_KEYS = ["date created", "date modified", "created", "modified", "date", "updated", "lastmod", "last-modified", "published", "publishDate"]

export function hasFrontmatterDates(frontmatter: Record<string, unknown> | undefined): boolean {
  return !!frontmatter && DATE_KEYS.some((key) => frontmatter[key] !== undefined && frontmatter[key] !== null && frontmatter[key] !== "")
}

import { execFileSync } from "child_process"
import { QuartzTransformerPlugin } from "../plugins/types"
import { GitDates as Dates, hasFrontmatterDates, parseGitLog, RECORD } from "./gitDatesCore"

/**
 * Created/updated dates from the vault's git history, for notes whose
 * frontmatter has none. The renderer builds a copy of the vault with no
 * history, so without this those notes show the build time.
 *
 * Reads `CYBERBASER_SOURCE_CHECKOUT` (the vault checkout; it needs full
 * history, e.g. actions/checkout with fetch-depth: 0). One `git log` pass per
 * build. A shallow clone, a missing checkout or a git failure leaves dates as
 * they were and says so in the build log. Copied into `<quartz>/quartz/cyberbase/`.
 */
export const GitDates: QuartzTransformerPlugin<{ checkout?: string }> = (opts) => {
  let dates: Map<string, Dates> | undefined
  const load = () => {
    if (dates || !opts?.checkout) return dates
    try {
      const git = (...args: string[]) => execFileSync("git", ["-C", opts.checkout!, "-c", "core.quotepath=false", ...args], { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 })
      if (git("rev-parse", "--is-shallow-repository").trim() === "true") {
        console.warn("GitDates: the vault checkout is shallow; fetch full history (fetch-depth: 0) for created dates. Skipping.")
        dates = new Map()
        return dates
      }
      dates = parseGitLog(git("log", "--no-renames", `--format=${RECORD}%aI`, "--name-only"))
      console.log(`GitDates: ${dates.size} paths dated from git history`)
    } catch (error) {
      console.warn(`GitDates: could not read git history (${(error as Error).message.split("\n")[0]}). Skipping.`)
      dates = new Map()
    }
    return dates
  }
  return {
    name: "GitDates",
    markdownPlugins() {
      return [
        () => (_tree: unknown, file: any) => {
          if (hasFrontmatterDates(file.data.frontmatter)) return
          const found = load()?.get(file.data.relativePath)
          if (!found) return
          file.data.dates = { ...(file.data.dates ?? {}), created: found.created, modified: found.modified, published: found.created }
        },
      ]
    },
  }
}

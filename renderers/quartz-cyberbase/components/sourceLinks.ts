/**
 * Source-host links for a note: view, edit, raw, web editor and vault archive.
 *
 * Hosts are pluggable behind `SourceHost`. GitHub is the current dogfood
 * provider; a Forgejo or other forge provider implements the same interface.
 * Links are always built from the note's real vault path (Quartz
 * `fileData.relativePath`), never from its URL slug, because permalinks,
 * slugified emoji folders and renamed slugs differ from the source path.
 *
 * Copied into `<quartz>/quartz/components/` by setup.sh. Pure, no DOM.
 */
import { encodeRepoPath } from "./editLink"

export interface NoteSourceLinks {
  /** Rendered source view of the exact file. */
  view: string
  /** Hosted web editor for the file on the working branch. */
  edit: string
  /** Raw Markdown bytes, pinned to the published revision when known. */
  raw: string
  /** Full in-browser editor (for example github.dev), if the host offers one. */
  webEditor?: string
  /** Download of the whole vault. */
  archive: string
}

export interface SourceHost {
  readonly id: string
  linksFor(relativePath: string): NoteSourceLinks
}

export interface GitHubSourceOptions {
  /** `https://github.com/<owner>/<repo>`, no trailing slash. */
  repoUrl: string
  /** Working branch for edit and archive links. */
  branch?: string
  /** Commit the site was built from. Pins view/raw so Copy matches the page. */
  revision?: string
}

const GITHUB_REPO = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/
const REF = /^[A-Za-z0-9._/-]{1,255}$/

export function githubSourceHost(opts: GitHubSourceOptions): SourceHost {
  const match = GITHUB_REPO.exec(opts.repoUrl)
  if (!match) throw new Error(`GitHub source repo must be https://github.com/<owner>/<repo>, got ${opts.repoUrl}`)
  const [, owner, repo] = match
  const branch = opts.branch ?? "main"
  if (!REF.test(branch) || branch.includes("..")) throw new Error(`invalid source branch: ${branch}`)
  const revision = opts.revision && /^[0-9a-f]{40}$/.test(opts.revision) ? opts.revision : branch
  return {
    id: "github",
    linksFor(relativePath: string): NoteSourceLinks {
      const path = encodeRepoPath(relativePath)
      return {
        view: `${opts.repoUrl}/blob/${revision}/${path}`,
        edit: `${opts.repoUrl}/edit/${branch}/${path}`,
        raw: `https://raw.githubusercontent.com/${owner}/${repo}/${revision}/${path}`,
        webEditor: `https://github.dev/${owner}/${repo}/blob/${branch}/${path}`,
        archive: `${opts.repoUrl}/archive/refs/heads/${branch}.zip`,
      }
    },
  }
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"]

/**
 * Parse vault frontmatter dates. Accepts ISO values and the Obsidian
 * "Wednesday, May 15th 2024, 9:13 pm" style the vault writes. Returns
 * undefined rather than guessing.
 */
export function parseNoteDate(value: unknown): Date | undefined {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value
  if (typeof value !== "string") return undefined
  const text = value.trim()
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) {
    const date = new Date(text)
    return Number.isNaN(date.getTime()) ? undefined : date
  }
  const match = /^(?:[A-Za-z]+,\s*)?([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})(?:,?\s+(\d{1,2}):(\d{2})\s*([ap]m)?)?$/i.exec(text)
  if (!match) return undefined
  const month = MONTHS.indexOf(match[1].toLowerCase())
  if (month < 0) return undefined
  const day = Number(match[2]), year = Number(match[3])
  let hour = match[4] ? Number(match[4]) : 0
  const minute = match[5] ? Number(match[5]) : 0
  const meridiem = match[6]?.toLowerCase()
  if (meridiem === "pm" && hour < 12) hour += 12
  if (meridiem === "am" && hour === 12) hour = 0
  const date = new Date(Date.UTC(year, month, day, hour, minute))
  return date.getUTCDate() === day && date.getUTCMonth() === month ? date : undefined
}

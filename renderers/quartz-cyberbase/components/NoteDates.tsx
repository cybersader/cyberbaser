import { QuartzComponentConstructor, QuartzComponentProps } from "./types"
import readingTime from "reading-time"
import { classNames } from "../util/lang"
import { i18n } from "../i18n"
import { parseNoteDate } from "./sourceLinks"
import style from "./styles/contentMeta.scss"

/**
 * Page metadata line: "📅 created … · 📅 updated … · N min read".
 *
 * Reads the vault's own "date created" / "date modified" frontmatter (the keys
 * the old publish.js showed), falling back to Quartz's created/modified dates.
 * No other frontmatter is displayed. Dates are shown as written (UTC wall
 * clock), so a reader's time zone never shifts the day.
 * Copied into `<quartz>/quartz/components/` by setup.sh.
 */
const pick = (frontmatter: Record<string, unknown> | undefined, keys: string[]) => {
  for (const key of keys) {
    const date = parseNoteDate(frontmatter?.[key])
    if (date) return date
  }
  return undefined
}

export default (() => {
  function NoteDates({ cfg, fileData, displayClass }: QuartzComponentProps) {
    if (!fileData.text) return null
    const frontmatter = fileData.frontmatter as Record<string, unknown> | undefined
    const created = pick(frontmatter, ["date created", "created", "date"]) ?? fileData.dates?.created
    const modified = pick(frontmatter, ["date modified", "modified", "updated", "lastmod"]) ?? fileData.dates?.modified
    const format = (date: Date) => date.toLocaleDateString(cfg.locale, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" })
    const minutes = Math.ceil(readingTime(fileData.text).minutes)
    return (
      <p show-comma={true} class={classNames(displayClass, "content-meta", "cb-note-dates")}>
        {created && <span><span aria-hidden="true">📅 </span>created <time datetime={created.toISOString()}>{format(created)}</time></span>}
        {modified && <span><span aria-hidden="true">📅 </span>updated <time datetime={modified.toISOString()}>{format(modified)}</time></span>}
        <span>{i18n(cfg.locale).components.contentMeta.readingTime({ minutes })}</span>
      </p>
    )
  }
  NoteDates.css = style
  return NoteDates
}) satisfies QuartzComponentConstructor

import { QuartzComponentConstructor, QuartzComponentProps } from "./types"
import { classNames } from "../util/lang"
import { isTagSlug } from "./editLink"
import type { SourceHost } from "./sourceLinks"
// @ts-ignore Quartz bundles *.inline.ts as a string
import script from "./scripts/note-actions.inline"

/**
 * Source controls carried over from the old publish.js site: a quiet icon row
 * under the title (edit, view source, copy Markdown, show raw; names on hover
 * and for screen readers) and an "Interact with this note" block after the body.
 *
 * Links come from the note's vault path via a pluggable `SourceHost`, never
 * from the URL slug. Pages without a source file (generated folder and tag
 * pages) render nothing. Copied into `<quartz>/quartz/components/` by setup.sh.
 */
export interface NoteActionsOptions {
  host: SourceHost
  placement: "header" | "footer"
  /** Header only: include the public Edit link as the first icon. */
  withEdit?: boolean
}

const svg = (paths: string) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" dangerouslySetInnerHTML={{ __html: paths }} />
)
const ICONS = {
  edit: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>'),
  source: svg('<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>'),
  copy: svg('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
  raw: svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/>'),
}

const external = { target: "_blank", rel: "noopener noreferrer" }

export default ((opts: NoteActionsOptions) => {
  function NoteActions({ fileData, displayClass }: QuartzComponentProps) {
    const relativePath = fileData.relativePath
    if (!relativePath || isTagSlug(fileData.slug)) return null
    const links = opts.host.linksFor(relativePath)

    if (opts.placement === "header") {
      return (
        <nav class={classNames(displayClass, "cb-note-actions")} aria-label="Note source">
          {opts.withEdit && <a href={links.edit} {...external} title="Edit this note" aria-label="Edit this note">{ICONS.edit}</a>}
          <a href={links.view} {...external} title="View source" aria-label="View source">{ICONS.source}</a>
          <button type="button" data-cb-copy-markdown={links.raw} title="Copy Markdown" aria-label="Copy Markdown">
            {ICONS.copy}<span class="cb-note-action-label">Copy Markdown</span>
          </button>
          <a href={links.raw} {...external} title="Show raw" aria-label="Show raw">{ICONS.raw}</a>
        </nav>
      )
    }

    return (
      <section class={classNames(displayClass, "cb-note-interact")} aria-labelledby="cb-note-interact-title">
        <h2 id="cb-note-interact-title">Interact with this note</h2>
        <div class="cb-note-interact-buttons">
          <a href={links.edit} {...external}>Edit note</a>
          <a href={links.raw} {...external}>Raw note</a>
          <a href={links.archive}>Download vault</a>
          {links.webEditor && <a href={links.webEditor} {...external}>Open in web editor</a>}
        </div>
      </section>
    )
  }

  NoteActions.css = opts.placement === "header" ? `
.cb-note-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 0.25rem; margin: 0.35rem 0 0 -0.4rem; font-size: 0.8rem; }
.cb-note-actions a, .cb-note-actions button { display: inline-flex; align-items: center; justify-content: center; gap: 0.35rem; min-width: 32px; height: 32px; padding: 0 0.4rem; border: 1px solid transparent; border-radius: 6px; background: none; color: var(--gray); font: inherit; text-decoration: none; cursor: pointer; }
.cb-note-actions :is(a, button):hover { color: var(--secondary); border-color: var(--lightgray); }
.cb-note-actions :is(a, button):focus-visible { outline: 2px solid var(--secondary); outline-offset: 2px; }
.cb-note-actions .cb-note-action-label { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.cb-note-actions button[data-cb-state] { color: var(--secondary); }
.cb-note-actions button[data-cb-state] .cb-note-action-label { position: static; width: auto; height: auto; clip: auto; }
@media (max-width: 750px) {
  .cb-note-actions a, .cb-note-actions button { min-width: 44px; height: 44px; }
}
` : `
.cb-note-interact { margin: 3rem 0 1rem; padding: 1rem 1.25rem; border: 1px solid var(--lightgray); border-radius: 8px; }
.cb-note-interact h2 { margin: 0 0 0.75rem; font-size: 1rem; }
.cb-note-interact-buttons { display: flex; flex-wrap: wrap; gap: 0.5rem; }
.cb-note-interact-buttons a { display: inline-flex; align-items: center; min-height: 40px; padding: 0 0.9rem; border: 1px solid var(--lightgray); border-radius: 6px; color: var(--secondary); background: var(--light); font-size: 0.9rem; font-weight: 600; text-decoration: none; }
.cb-note-interact-buttons a:hover { border-color: var(--secondary); }
.cb-note-interact-buttons a:focus-visible { outline: 2px solid var(--secondary); outline-offset: 2px; }
`
  if (opts.placement === "header") NoteActions.afterDOMLoaded = script

  return NoteActions
}) satisfies QuartzComponentConstructor<NoteActionsOptions>

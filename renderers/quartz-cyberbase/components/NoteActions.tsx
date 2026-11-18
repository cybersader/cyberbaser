import { QuartzComponentConstructor, QuartzComponentProps } from "./types"
import { classNames } from "../util/lang"
import { isTagSlug } from "./editLink"
import type { SourceHost } from "./sourceLinks"
// @ts-ignore Quartz bundles *.inline.ts as a string
import script from "./scripts/note-actions.inline"

/**
 * Source controls carried over from the old publish.js site: a link row under
 * the title and an "Interact with this note" block after the body.
 *
 * Links come from the note's vault path via a pluggable `SourceHost`, never
 * from the URL slug. Pages without a source file (generated folder and tag
 * pages) render nothing. Copied into `<quartz>/quartz/components/` by setup.sh.
 */
export interface NoteActionsOptions {
  host: SourceHost
  placement: "header" | "footer"
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
          <a href={links.view} {...external}>View source</a>
          <button type="button" data-cb-copy-markdown={links.raw} title="Copy this note's Markdown">
            <span class="cb-note-action-label">Copy Markdown</span>
          </button>
          <a href={links.raw} {...external} class="cb-note-action-wide">Show raw</a>
          <a href={links.archive} class="cb-note-action-wide">Download vault</a>
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
.cb-note-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 0.25rem 1rem; margin: 0.35rem 0 0; font-size: 0.8rem; }
.cb-note-actions a, .cb-note-actions button { padding: 0; border: 0; background: none; color: var(--gray); font: inherit; line-height: 1.4; text-decoration: none; cursor: pointer; min-height: 24px; display: inline-flex; align-items: center; }
.cb-note-actions :is(a, button):hover { color: var(--secondary); }
.cb-note-actions :is(a, button):focus-visible { outline: 2px solid var(--secondary); outline-offset: 2px; border-radius: 2px; }
@media (max-width: 750px) {
  .cb-note-actions .cb-note-action-wide { display: none; }
  .cb-note-actions :is(a, button) { min-height: 44px; }
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

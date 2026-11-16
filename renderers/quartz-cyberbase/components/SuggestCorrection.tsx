import { QuartzComponentConstructor, QuartzComponentProps } from "./types"
import { classNames } from "../util/lang"
import { pathToRoot } from "../util/path"
import { suggestionBindingForPage } from "./suggestCorrectionConfig"
import { sourceEditorAsset } from "./sourceEditorAsset"
import type { SuggestCorrectionOptions } from "./suggestCorrectionConfig"
// @ts-ignore Quartz's inline-script loader compiles this browser entry separately.
import script from "./scripts/suggest-correction.inline"

/** Intake identity plus optional published provenance, never private repository/account data. */
export default ((opts: SuggestCorrectionOptions) => {
  const label = opts.enabled ? (opts.text ?? "Suggest an edit") : "Suggest an edit"

  function SuggestCorrection({ fileData, displayClass }: QuartzComponentProps) {
    const binding = suggestionBindingForPage(fileData.relativePath, fileData.slug, opts)
    if (!binding) return null

    return (
      <section class={classNames(displayClass, "suggest-correction")} aria-label="Suggest an edit">
        <button type="button" class="suggest-correction-entry">{label}</button>
        <p class="suggest-correction-hint" role="status" aria-live="polite" hidden>
          Select words in the page and choose Suggest edit, or click a pencil beside a paragraph.
          Your edit goes to the owner for review; the page stays unchanged. No account needed.
        </p>
        <form
          class="suggest-correction-form"
          action={binding.action}
          method="post"
          autocomplete="off"
          data-action={binding.action}
          data-binding-digest={binding.bindingDigest}
          data-page-id={binding.pageId}
          {...((fileData as any).sourceProvenance?.source ? {
            "data-source-editor-asset": `${pathToRoot(fileData.slug!)}/static/${sourceEditorAsset}`,
            "data-source-identity": JSON.stringify((fileData as any).sourceProvenance.source),
            "data-provenance-url": `${pathToRoot(fileData.slug!)}/${fileData.slug}.provenance.json`,
          } : {})}
          hidden
        >
          <label>
            Suggest an edit
            <textarea name="edited" rows={4} spellcheck={true}></textarea>
          </label>
          <label>
            Why? (optional)
            <input name="rationale" type="text" maxlength={16 * 1024} />
          </label>
          <label>
            Source link (optional)
            <input name="evidence" type="url" inputmode="url" placeholder="https://…" maxlength={2 * 1024} />
          </label>
          {opts.enabled && opts.challengeSiteKey !== undefined && (
            <div
              class="suggest-correction-challenge"
              data-sitekey={opts.challengeSiteKey}
              data-action="suggest-correction"
              {...(opts.challengeProvider === undefined ? {} : { "data-provider": opts.challengeProvider })}
            ></div>
          )}
          <div class="suggest-correction-actions">
            <button type="submit" disabled>Send</button>
            <button type="button" class="suggest-correction-cancel">Cancel</button>
          </div>
          <p class="suggest-correction-status" role="status" aria-live="polite"></p>
        </form>
      </section>
    )
  }

  SuggestCorrection.afterDOMLoaded = script
  SuggestCorrection.css = `
.suggest-correction { margin: 0.6rem 0 1rem; font-size: 0.9rem; }
.suggest-correction-hint { color: var(--gray); }
.suggest-correction-form {
  display: grid;
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  gap: 0.6rem;
  padding: 0.8rem;
  border: 1px solid var(--secondary);
  border-radius: 6px;
  background: var(--light);
}
.suggest-correction-form[hidden], .suggest-edit-floating[hidden], .suggest-edit-block[hidden], .cb-suggest-tray[hidden], .suggest-correction-form label[hidden] { display: none; }
.cb-suggesting { outline: 1px solid var(--lightgray); outline-offset: 8px; caret-color: #13834b; }
.cb-suggesting:focus { outline-color: var(--secondary); }
[data-cb-run] ins, .cb-suggest-card ins, .cb-suggest-summary ins { color: #087940; background: #d8f4df; text-decoration: underline; text-decoration-thickness: 2px; white-space: pre-wrap; }
[data-cb-run] del, .cb-suggest-card del, .cb-suggest-summary del { color: #a32c32; background: #ffe4e5; text-decoration: line-through; }
.cb-suggest-unmapped { border-bottom: 1px dashed var(--gray); cursor: pointer; }
.cb-source-open { display: block; font: 0.75rem var(--bodyFont); color: var(--secondary); background: var(--light); border: 1px solid var(--lightgray); border-radius: 4px; padding: 4px 8px; margin-top: 6px; cursor: pointer; min-height: 32px; }
.cb-source-open[hidden], .cb-source-pending[hidden] { display: none; }
.cb-source-pending { outline: 1px dashed var(--secondary); outline-offset: 4px; }
.cb-source-editor { padding: 12px; margin-block: 12px; border: 1px solid var(--secondary); border-radius: 6px; background: var(--light); color: var(--dark); min-width: 0; }
.cb-source-editor > p { font-size: 0.85rem; margin-block: 6px; }
.cb-source-editor > button { min-height: 36px; padding: 4px 12px; margin-inline-end: 8px; cursor: pointer; }
.cb-source-editor .cm-editor { border: 1px solid var(--lightgray); font-family: var(--codeFont); background: var(--light); color: var(--dark); }
.cb-source-editor .cm-scroller { max-height: 340px; overflow: auto; }
.cb-source-editor .cm-content { padding: 8px; min-height: 70px; caret-color: var(--dark); }
.cb-source-editor .cm-line { white-space: pre-wrap; overflow-wrap: anywhere; }
.cb-source-editor .cb-source-syntax { opacity: 0.4; }
.cb-source-editor .cb-source-insert { color: #087940; background: #d8f4df; text-decoration: underline; }
.cb-source-editor .cb-source-delete { color: #a32c32; background: #ffe4e5; text-decoration: line-through; white-space: pre-wrap; }
.cb-source-badge { color: var(--secondary); font-size: 0.75rem; }
:root[saved-theme='dark'] .cb-source-editor .cb-source-insert { color: #a1e8b6; background: #123b28; }
:root[saved-theme='dark'] .cb-source-editor .cb-source-delete { color: #ffb1b1; background: #4d2329; }
.cb-suggest-toggle, .cb-suggest-review { margin-inline-end: 0.5rem; }
.cb-suggest-toggle[aria-pressed='true'] { background: #d8f4df; color: #087940; }
.cb-suggest-help, .cb-suggest-status { font-size: 0.9rem; }
.cb-suggest-tray { position: fixed; z-index: 40; width: 250px; max-height: 65vh; overflow: auto; display: grid; gap: 10px; padding: 8px; box-sizing: border-box; }
.cb-suggest-card { padding: 12px; border: 1px solid var(--lightgray); border-inline-start: 3px solid #13834b; border-radius: 6px; background: var(--light); box-shadow: 0 2px 8px #0001; min-width: 0; overflow-wrap: anywhere; }
.cb-suggest-card > * { display: block; margin: 0 0 6px; }
.cb-suggest-card textarea { width: 100%; box-sizing: border-box; min-height: 55px; background: var(--light); color: var(--dark); border: 1px solid var(--lightgray); border-radius: 4px; padding: 5px; }
.cb-suggest-card button { min-height: 36px; cursor: pointer; }
.cb-suggest-bottom-tray { bottom: 0; left: 0; right: 0; width: 100%; max-height: 28vh; display: flex; background: var(--light); border-top: 1px solid var(--lightgray); }
.cb-suggest-bottom-tray .cb-suggest-card { flex: 0 0 240px; }
@media (max-width: 800px) { body:has(.cb-suggesting) { padding-bottom: 30vh; } }
@media (min-width: 801px) and (max-width: 1350px) { .cb-suggest-tray:not([hidden]) { position: static; width: 100%; max-height: 35vh; display: flex; } .cb-suggest-card { flex: 0 0 230px; } }
:root[saved-theme='dark'] :is([data-cb-run], .cb-suggest-card, .cb-suggest-summary) ins { color: #a1e8b6; background: #123b28; }
:root[saved-theme='dark'] :is([data-cb-run], .cb-suggest-card, .cb-suggest-summary) del { color: #ffb1b1; background: #4d2329; }
.suggest-correction-form > * { margin: 0; min-width: 0; }
.suggest-correction-form label { display: grid; gap: 0.25rem; font: 600 0.9rem var(--headerFont); }
.suggest-correction-form :is(textarea, input) {
  box-sizing: border-box;
  width: 100%;
  max-width: 100%;
  min-height: 40px;
  padding: 0.5rem;
  border: 1px solid var(--lightgray);
  border-radius: 5px;
  background: var(--light);
  color: var(--darkgray);
  font: 400 1rem/1.5 var(--bodyFont);
}
.suggest-correction-form textarea { resize: vertical; }
.suggest-correction-actions { display: flex; flex-wrap: wrap; gap: 0.6rem; }
.suggest-correction :is(button), .suggest-correction-form button, .suggest-edit-floating {
  min-height: 40px;
  padding: 0.4rem 0.75rem;
  border: 1px solid var(--secondary);
  border-radius: 5px;
  background: var(--light);
  color: var(--secondary);
  font: 600 0.9rem var(--headerFont);
  cursor: pointer;
}
.suggest-correction-form button[type="submit"], .suggest-edit-floating { background: var(--secondary); color: var(--light); }
.suggest-correction-form button:disabled { opacity: 0.5; cursor: not-allowed; }
/* Keep the pencil inside the content column: Quartz's left sidebar sits over
   the outer margin and would swallow clicks there. */
.suggest-edit-block { position: relative; padding-inline-end: 40px; }
.suggest-edit-pencil {
  position: absolute;
  inset-inline-end: 0;
  top: 0;
  z-index: 1;
  min-width: 32px;
  min-height: 32px;
  border: 1px solid var(--lightgray);
  border-radius: 5px;
  padding: 0;
  background: var(--light);
  color: var(--secondary);
  font: 1.2rem var(--bodyFont);
  cursor: pointer;
  opacity: 0;
}
.suggest-edit-block:hover > .suggest-edit-pencil,
.suggest-edit-block:focus-within > .suggest-edit-pencil { opacity: 1; }
.suggest-edit-floating { position: fixed; z-index: 1000; }
.suggest-edit-host, li.suggest-edit-receipt { list-style: none; }
.suggest-edit-receipt { font-size: 0.9rem; color: var(--secondary); }
.suggest-correction-status[data-state="error"] { color: #a83a32; }
:root[saved-theme="dark"] .suggest-correction-status[data-state="error"] { color: #ef9089; }
:is(.suggest-correction-form, .suggest-correction) :is(button, input, textarea):focus-visible,
.suggest-edit-pencil:focus-visible, .suggest-edit-floating:focus-visible {
  outline: 2px solid var(--secondary); outline-offset: 2px;
}
@media (max-width: 800px), (hover: none) {
  .suggest-edit-block { padding-inline-end: 0; }
  .suggest-edit-mobile-visible { opacity: 1; position: static; float: right; margin-inline-start: 0.4rem; min-width: 40px; min-height: 40px; }
  .suggest-correction-form { width: 100%; }
}
`

  return SuggestCorrection
}) satisfies QuartzComponentConstructor<SuggestCorrectionOptions>

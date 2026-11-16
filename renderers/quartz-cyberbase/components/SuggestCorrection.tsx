import { QuartzComponentConstructor, QuartzComponentProps } from "./types"
import { classNames } from "../util/lang"
import { suggestionBindingForPage } from "./suggestCorrectionConfig"
import type { SuggestCorrectionOptions } from "./suggestCorrectionConfig"
// @ts-ignore Quartz's inline-script loader compiles this browser entry separately.
import script from "./scripts/suggest-correction.inline"

/** Only the public intake action and opaque publication identity reach readers. */
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
.suggest-correction-form[hidden], .suggest-edit-floating[hidden], .suggest-edit-block[hidden] { display: none; }
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

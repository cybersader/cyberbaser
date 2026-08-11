import { QuartzComponentConstructor, QuartzComponentProps } from "./types"
import { classNames } from "../util/lang"
import { suggestionBindingForPage } from "./suggestCorrectionConfig"
import type { SuggestCorrectionOptions } from "./suggestCorrectionConfig"
// @ts-ignore Quartz's inline-script loader compiles this browser entry separately.
import script from "./scripts/suggest-correction.inline"

/**
 * Disabled-by-default account-free correction form for real source-backed pages.
 *
 * Only the retained publication binding digest, opaque page ID, and public intake
 * action reach the browser. Repository, revision, source path, owner origin, and
 * private-network details remain build-time inputs and are never form fields or
 * request members.
 */
export default ((opts: SuggestCorrectionOptions) => {
  const label = opts.enabled ? (opts.text ?? "Suggest a correction") : "Suggest a correction"

  function SuggestCorrection({ fileData, displayClass }: QuartzComponentProps) {
    const binding = suggestionBindingForPage(fileData.relativePath, fileData.slug, opts)
    if (!binding) return null

    return (
      <details class={classNames(displayClass, "suggest-correction")}>
        <summary>{label}</summary>
        <form
          class="suggest-correction-form"
          action={binding.action}
          method="post"
          autocomplete="off"
          data-action={binding.action}
          data-binding-digest={binding.bindingDigest}
          data-page-id={binding.pageId}
        >
          <p class="suggest-correction-intro">
            Send one exact text correction for owner review. No account or contact information is requested.
          </p>
          <label>
            Text to replace
            <textarea name="quote" required rows={3} maxlength={16 * 1024}></textarea>
          </label>
          <div class="suggest-correction-context">
            <label>
              Context immediately before (optional)
              <textarea name="prefix" rows={2} maxlength={4 * 1024}></textarea>
            </label>
            <label>
              Context immediately after (optional)
              <textarea name="suffix" rows={2} maxlength={4 * 1024}></textarea>
            </label>
          </div>
          <label>
            Replacement text
            <textarea name="replacement" rows={3} maxlength={16 * 1024}></textarea>
          </label>
          <label>
            Why should this change?
            <textarea name="rationale" required rows={3} maxlength={16 * 1024}></textarea>
          </label>
          <label>
            Evidence links (optional, one HTTPS URL per line)
            <textarea name="evidence" rows={2} maxlength={16 * 1024}></textarea>
          </label>
          <div class="suggest-correction-actions">
            <button type="submit" disabled>Send for review</button>
            <span class="suggest-correction-status" role="status" aria-live="polite"></span>
          </div>
        </form>
      </details>
    )
  }

  SuggestCorrection.afterDOMLoaded = script
  SuggestCorrection.css = `
.suggest-correction {
  margin: 0.6rem 0 1rem;
  border: 1px solid var(--lightgray);
  border-radius: 6px;
  font-size: 0.9rem;
}
.suggest-correction > summary {
  cursor: pointer;
  padding: 0.45rem 0.65rem;
  color: var(--secondary);
  font-family: var(--headerFont);
  font-weight: 600;
}
.suggest-correction-form {
  display: grid;
  gap: 0.75rem;
  padding: 0 0.75rem 0.85rem;
}
.suggest-correction-intro {
  margin: 0;
  color: var(--gray);
}
.suggest-correction-form label {
  display: grid;
  gap: 0.25rem;
  min-width: 0;
  color: var(--darkgray);
  font-family: var(--headerFont);
  font-weight: 600;
}
.suggest-correction-form textarea {
  box-sizing: border-box;
  width: 100%;
  max-width: 100%;
  resize: vertical;
  padding: 0.5rem;
  border: 1px solid var(--lightgray);
  border-radius: 5px;
  background: var(--light);
  color: var(--darkgray);
  font: 400 0.9rem/1.4 var(--bodyFont);
}
.suggest-correction-form textarea:focus {
  outline: 2px solid var(--secondary);
  outline-offset: 1px;
}
.suggest-correction-context {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.75rem;
}
.suggest-correction-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.65rem;
}
.suggest-correction-actions button {
  padding: 0.45rem 0.75rem;
  border: 1px solid var(--secondary);
  border-radius: 5px;
  background: var(--secondary);
  color: var(--light);
  font-family: var(--headerFont);
  font-weight: 600;
  cursor: pointer;
}
.suggest-correction-actions button:disabled {
  cursor: wait;
  opacity: 0.55;
}
.suggest-correction-status[data-state="success"] { color: var(--secondary); }
.suggest-correction-status[data-state="error"] { color: #a83a32; }
:root[saved-theme="dark"] .suggest-correction-status[data-state="error"] { color: #ef9089; }
@media (max-width: 640px) {
  .suggest-correction-context { grid-template-columns: minmax(0, 1fr); }
}
`

  return SuggestCorrection
}) satisfies QuartzComponentConstructor<SuggestCorrectionOptions>

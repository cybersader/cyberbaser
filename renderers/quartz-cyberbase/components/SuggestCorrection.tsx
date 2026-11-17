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
.suggest-correction-form[hidden], .suggest-edit-floating[hidden], .suggest-edit-block[hidden],
.cb-suggest-tray[hidden], .suggest-correction-form label[hidden], .suggest-correction-entry[hidden],
.cb-suggest-toolbar[hidden], .cb-suggest-help[hidden], .cb-suggest-backdrop[hidden] { display: none; }
/* Enabled pages keep the forge route a quiet alternate link, never a second button. */
body:has(.suggest-correction) .edit-this-page a { border: 0; padding: 0; background: transparent; font-weight: 400; text-decoration: underline; text-underline-offset: 3px; }
body:has(.cb-suggesting) .popover, body:has(.cb-suggesting) .edit-this-page, .suggest-correction:has(.suggest-correction-entry[hidden]) { display: none; }
article.cb-suggesting, article.cb-suggesting:focus { outline: none; caret-color: var(--secondary); }
.cb-suggesting .cb-source-active { box-shadow: inset 2px 0 0 color-mix(in srgb, var(--secondary) 28%, transparent); }
:is([data-cb-run], .cb-suggest-card, .cb-suggest-review-card, .cb-suggest-summary) ins { color: #087940; background: #d8f4df; text-decoration: underline; text-decoration-thickness: 2px; white-space: pre-wrap; }
:is([data-cb-run], .cb-suggest-card, .cb-suggest-review-card, .cb-suggest-summary) del { color: #a32c32; background: #ffe4e5; text-decoration: line-through; }
.cb-suggest-unmapped { border-bottom: 1px dashed var(--gray); cursor: pointer; }
.cb-source-open { position: absolute; z-index: 30; display: grid; place-items: center; box-sizing: border-box; top: 0; left: -38px; width: 24px; height: 24px; padding: 0; margin: 0; font: 600 13px var(--codeFont); color: var(--secondary); background: var(--light); border: 1px solid var(--lightgray); border-radius: 5px; cursor: pointer; }
.cb-source-open:focus-visible { outline: 2px solid var(--secondary); outline-offset: 2px; }
.cb-source-open::after { position: absolute; top: -7px; right: -8px; font: 600 10px var(--bodyFont); border-radius: 8px; background: var(--secondary); color: var(--light); padding: 0 3px; }
.cb-source-open:not([data-cb-change-count='0'])::after { content: attr(data-cb-change-count); }
@media (pointer: coarse) { .cb-source-open { width: 44px; height: 44px; top: -10px; left: -48px; border: 10px solid transparent; background-clip: padding-box; } }
/* Phones have no gutter; an overlay would cover the text being typed. The toolbar Markdown button and the contextual prompt cover this case. */
@media (max-width: 600px) { .cb-source-open { display: none !important; } }

.cb-markdown-prompt { position: fixed; z-index: 85; width: max-content; max-width: calc(100vw - 24px); box-sizing: border-box; padding: 10px 12px; border: 1px solid var(--lightgray); border-radius: 8px; box-shadow: 0 4px 18px #0002; background: var(--light); color: var(--darkgray); font: 400 0.85rem/1.5 var(--bodyFont); }
.cb-markdown-prompt[hidden], .cb-leave-guard[hidden] { display: none; }
.cb-markdown-prompt p { margin: 0 0 6px; }
:is(.cb-markdown-prompt, .cb-leave-guard) button { min-height: 44px; padding: 8px 12px; background: var(--light); color: var(--secondary); border: 1px solid var(--lightgray); border-radius: 6px; font: 600 0.85rem var(--bodyFont); cursor: pointer; }
.cb-leave-guard { position: fixed; inset: 0; z-index: 110; display: grid; place-items: center; padding: 16px; background: #0006; }
.cb-leave-guard > section { box-sizing: border-box; width: min(400px, 100%); padding: 20px; border: 1px solid var(--lightgray); border-radius: 10px; background: var(--light); color: var(--darkgray); }
.cb-leave-guard p { margin: 0 0 16px; }
.cb-leave-guard button { margin: 0 8px 0 0; }

.cb-source-open[hidden], .cb-source-pending[hidden] { display: none; }
.cb-source-pending { text-decoration: underline dashed var(--secondary); text-underline-offset: 5px; }
.cb-source-editor { position: relative; z-index: 35; padding: 16px; margin-block: 16px; border: 1px solid var(--lightgray); border-radius: 8px; background: var(--light); color: var(--dark); min-width: 0; max-width: 100%; box-sizing: border-box; }
.cb-source-editor > p { font-size: 0.9rem; line-height: 1.5; margin-block: 8px 16px; }
.cb-source-editor > button { min-height: 44px; padding: 6px 16px; margin: 12px 8px 0 0; cursor: pointer; }
.cb-source-editor .cm-editor { border: 1px solid var(--lightgray); font: 16px/1.6 var(--codeFont); background: var(--light); color: var(--dark); }
.cb-source-editor .cm-scroller { max-height: 40dvh; overflow: auto; }
.cb-source-editor .cm-content { padding: 8px; min-height: 90px; caret-color: var(--secondary); }
.cb-source-editor .cm-line { white-space: pre-wrap; overflow-wrap: anywhere; }
.cb-source-editor .cb-source-syntax { opacity: 0.6; }
.cb-source-editor .cb-source-insert { color: #087940; background: #d8f4df; text-decoration: underline; }
.cb-source-editor .cb-source-delete { color: #a32c32; background: #ffe4e5; text-decoration: line-through; white-space: pre-wrap; }
.cb-source-badge { color: var(--secondary); font-size: 0.8rem; }
:root[saved-theme='dark'] .cb-source-editor .cb-source-insert { color: #a1e8b6; background: #123b28; }
:root[saved-theme='dark'] .cb-source-editor .cb-source-delete { color: #ffb1b1; background: #4d2329; }
:is(.cb-suggest-toolbar, .cb-suggest-help, .cb-suggest-tray, .cb-source-editor) button {
  min-height: 44px; min-width: 44px; border: 1px solid var(--lightgray); border-radius: 6px;
  padding: 8px 12px; background: var(--light); color: var(--secondary); font: 600 0.85rem var(--bodyFont); cursor: pointer;
}
:is(.cb-suggest-toolbar, .cb-suggest-help, .cb-suggest-tray, .cb-source-editor) button:focus-visible { outline: 2px solid var(--secondary); outline-offset: 2px; }
.cb-suggest-toolbar { position: fixed; z-index: 70; bottom: 16px; right: 16px; display: flex; align-items: center; gap: 6px; padding: 8px; border: 1px solid var(--lightgray); border-radius: 10px; background: var(--light); color: var(--dark); box-shadow: 0 5px 24px #0002; }
.cb-suggest-toolbar .cb-suggest-toggle { display: inline-flex; align-items: center; gap: 7px; border-color: transparent; }
.cb-suggest-toggle::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--secondary); }
.cb-suggest-toolbar .cb-suggest-review { border-color: transparent; font-variant-numeric: tabular-nums; }
.cb-suggest-toolbar .cb-suggest-review[aria-expanded='true'] { background: var(--highlight); }
.cb-suggest-toolbar .cb-suggest-send-review, .cb-source-editor .cb-source-done { color: var(--light); background: var(--secondary); border-color: var(--secondary); }
.cb-suggest-toolbar button:disabled { opacity: 0.5; cursor: not-allowed; }
.cb-suggest-help { position: fixed; z-index: 71; right: 16px; top: 16px; display: flex; align-items: center; gap: 12px; width: min(380px, calc(100vw - 32px)); box-sizing: border-box; padding: 12px 16px; border: 1px solid var(--lightgray); border-radius: 8px; background: var(--light); color: var(--darkgray); box-shadow: 0 5px 24px #0002; }
.cb-suggest-help p { font: 400 0.85rem/1.5 var(--bodyFont); margin: 0; }
.cb-suggest-help button { flex-shrink: 0; }
.cb-suggest-status { position: fixed; bottom: 96px; left: 16px; z-index: 72; max-width: min(420px, calc(100vw - 32px)); box-sizing: border-box; margin: 0; padding: 12px 16px; border: 1px solid var(--lightgray); border-radius: 8px; background: var(--light); color: var(--darkgray); font: 400 0.9rem/1.5 var(--bodyFont); box-shadow: 0 4px 16px #0002; }
.cb-suggest-status:empty { display: none; }
.cb-suggest-tray { position: fixed; z-index: 50; width: 260px; max-height: calc(100dvh - 160px); overflow: auto; right: 16px; bottom: 94px; box-sizing: border-box; color: var(--darkgray); background: var(--light); border: 1px solid var(--lightgray); border-radius: 10px; box-shadow: 0 5px 24px #0002; }
.cb-suggest-tray-empty { display: none; }
.cb-suggest-tray-heading { position: sticky; top: 0; z-index: 1; display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 8px 12px; background: var(--light); border-bottom: 1px solid var(--lightgray); font-size: 0.9rem; }
.cb-suggest-tray-heading > button { font-size: 0.8rem; font-weight: 400; border: 0; }
.cb-suggest-cards { display: grid; gap: 0; padding: 0 16px; }
.cb-suggest-card { padding: 16px 0; border-bottom: 1px solid var(--lightgray); min-width: 0; overflow-wrap: anywhere; }
.cb-suggest-card:last-child { border-bottom: 0; }
.cb-suggest-card > * { display: block; margin: 0 0 8px; }
.cb-suggest-card > strong { font: 600 0.85rem var(--bodyFont); }
.cb-suggest-card :is(ins, del) { font-size: 0.95rem; }
.cb-suggest-card textarea { width: 100%; box-sizing: border-box; min-height: 72px; background: var(--light); color: var(--darkgray); border: 1px solid var(--lightgray); border-radius: 6px; padding: 8px; font: 400 16px/1.5 var(--bodyFont); resize: vertical; }
.cb-suggest-card button { font-weight: 400; }
.cb-suggest-backdrop { position: fixed; inset: 0; z-index: 89; background: #0005; }
body.cb-suggest-review-open { overflow: hidden; }
body.cb-suggest-review-open :is(.cb-suggest-help, .cb-suggest-status) { visibility: hidden; }
.suggest-correction-form.cb-suggest-review-sheet { position: fixed; z-index: 90; inset: 0 0 0 auto; width: min(460px, 100%); height: 100dvh; overflow: auto; overscroll-behavior: contain; align-content: start; gap: 20px; padding: 28px 24px; border: 0; border-left: 1px solid var(--lightgray); border-radius: 0; box-shadow: -4px 0 32px #0002; }
.cb-suggest-review-sheet > h2 { font-size: 1.5rem; margin: 0; }
.cb-suggest-summary { overflow-wrap: anywhere; }
.cb-suggest-summary p { margin: 0; padding: 12px 0; border-bottom: 1px solid var(--lightgray); }
.cb-suggest-summary :is(ins, del) { display: inline; white-space: pre-wrap; }
.cb-suggest-section { color: var(--gray); font-size: 0.8rem; }
.cb-suggest-context { line-height: 1.6; white-space: pre-wrap; }
.cb-suggest-card .cb-suggest-context { display: block; }
.cb-suggest-review-card { padding-block: 12px; border-bottom: 1px solid var(--lightgray); }
.cb-suggest-review-card > * { margin-block: 0 8px; }
.cb-suggest-review-card small { display: block; }
.cb-suggest-summary button { min-height: 44px; padding: 8px 12px; color: var(--secondary); background: var(--light); border: 1px solid var(--lightgray); border-radius: 6px; cursor: pointer; }
:root[saved-theme='dark'] :is([data-cb-run], .cb-suggest-card, .cb-suggest-review-card, .cb-suggest-summary) ins { color: #a1e8b6; background: #123b28; }
:root[saved-theme='dark'] :is([data-cb-run], .cb-suggest-card, .cb-suggest-review-card, .cb-suggest-summary) del { color: #ffb1b1; background: #4d2329; }
/* Below a roomy desktop margin, cards are explicitly opened in a sheet, never laid over text. */
.cb-suggest-tray:not(.cb-suggest-tray-expanded) { display: none; }
@media (min-width: 801px) and (max-width: 1399px) {
  .cb-suggest-tray { width: 320px; }
  body:has(.cb-suggest-tray-expanded:not([hidden])) .page { box-sizing: border-box; width: calc(100% - 352px); margin-inline: 0 352px; }
  body:has(.cb-suggest-tray-expanded:not([hidden])) .page > #quartz-body { grid-template-columns: minmax(0, 1fr); grid-template-areas: "grid-header" "grid-center" "grid-footer"; padding-inline: 24px; }
  body:has(.cb-suggest-tray-expanded:not([hidden])) .page > #quartz-body > .sidebar { display: none; }
}
@media (min-width: 1200px) and (max-width: 1399px) {
  body:has(.cb-suggest-tray-expanded:not([hidden])) .page > #quartz-body { grid-template-columns: 220px minmax(0, 1fr); grid-template-areas: "grid-sidebar-left grid-header" "grid-sidebar-left grid-center" "grid-sidebar-left grid-footer"; }
  body:has(.cb-suggest-tray-expanded:not([hidden])) .page > #quartz-body > .sidebar.left { display: flex; padding-inline: 8px 24px; }
}
@media (min-width: 1400px) { .cb-suggest-tray { right: max(16px, calc((100vw - 1600px) / 2)); } }
@media (max-width: 800px) {
  /* Quartz positions this panel inside a 16px-inset sidebar. A full viewport
     width leaks horizontally when resizing an expanded desktop explorer. */
  body:has(.suggest-correction) .explorer .explorer-content { width: calc(100dvw - 32px); max-width: 100%; }
  body:has(.cb-suggesting) { padding-bottom: calc(100px + env(safe-area-inset-bottom, 0px)); }
  .cb-suggest-toolbar { inset: auto 0 0; gap: 2px; justify-content: space-between; padding: 8px 10px calc(8px + env(safe-area-inset-bottom, 0px)); border-radius: 0; border-width: 1px 0 0; box-shadow: 0 -3px 20px #0001; }
  .cb-suggest-toolbar { display: grid; grid-template-columns: 28px 44px 44px minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1.35fr); gap: 2px; padding-inline: 6px; }
  .cb-suggest-toolbar button { min-width: 0; padding-inline: 3px; font-size: 0.7rem; white-space: nowrap; }
  .cb-suggest-toolbar .cb-suggest-toggle { font-size: 0; gap: 0; min-width: 28px; padding-inline: 6px; }
  .cb-suggest-toolbar :is(.cb-suggest-undo, .cb-suggest-redo) { font-size: 20px; padding-inline: 0; }
  .cb-suggest-toolbar .cb-suggest-review { padding-inline: 3px; }
  .cb-suggest-help { inset: auto 12px calc(76px + env(safe-area-inset-bottom, 0px)); width: auto; }
  .cb-suggest-status { bottom: calc(76px + env(safe-area-inset-bottom, 0px)); left: 12px; max-width: calc(100vw - 24px); }
  .cb-suggest-tray { inset: auto 0 calc(62px + env(safe-area-inset-bottom, 0px)); width: 100%; max-height: 52dvh; overscroll-behavior: contain; border-radius: 14px 14px 0 0; box-shadow: 0 -5px 24px #0002; }
  .cb-suggest-tray-heading { padding: 10px 16px; }
  .cb-suggest-help:has(~ .cb-suggest-tray-expanded) { display: none; }
  .suggest-correction-form.cb-suggest-review-sheet { padding: max(24px, env(safe-area-inset-top, 0px)) 20px max(24px, env(safe-area-inset-bottom, 0px)); border: 0; }
  .cb-suggest-review-sheet .suggest-correction-actions { flex-direction: column; }
  .cb-source-editor { padding: 12px; }
}
/* A software keyboard pans Safari's visual viewport independently of fixed
   layout chrome. Hide the toolbar; keep sheets within the visible viewport. */
body.cb-suggest-keyboard-open :is(.cb-suggest-toolbar, .cb-suggest-help, .cb-suggest-status) { display: none; }

body.cb-suggest-keyboard-open .suggest-correction-form.cb-suggest-review-sheet { top: var(--cb-suggest-visible-top); bottom: auto; height: var(--cb-suggest-visible-height); padding-block: 16px; scroll-padding-block: 24px; }
body.cb-suggest-keyboard-open .cb-suggest-tray { bottom: calc(var(--cb-suggest-keyboard-bottom) + 8px); max-height: calc(var(--cb-suggest-visible-height) - 16px); scroll-padding-block: 24px; }
.suggest-correction-form > * { margin: 0; min-width: 0; }
.suggest-correction-status:empty { display: none; }
.suggest-correction-form label { display: grid; gap: 0.25rem; font: 600 0.9rem var(--headerFont); }
.suggest-correction-form :is(textarea, input) {
  box-sizing: border-box;
  width: 100%;
  max-width: 100%;
  min-height: 44px;
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
  min-height: 44px;
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

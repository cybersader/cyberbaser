/** One presentation for owner navigation and visitor entry; no edit authority. */
export function EditPencil() {
  return <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m15 5 4 4M17 3a2.828 2.828 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" /></svg>
}
export const editEntryCss = `
.edit-this-page:has(.cb-edit-entry), .suggest-correction { margin: .25rem 0 .75rem; }
body :is(a,button).cb-edit-entry {
  display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box;
  width: auto; height: 36px; min-height: 36px; gap: 6px; padding: 6px 8px; margin: 0;
  border: 0; border-radius: 6px; background: transparent; color: var(--darkgray);
  text-decoration: none; cursor: pointer; font: 500 .85rem var(--bodyFont); line-height: 1; vertical-align: middle;
}
body :is(a,button).cb-edit-entry:hover { color: var(--secondary); background: var(--lightgray); }
body :is(a,button).cb-edit-entry:focus-visible { outline: 2px solid var(--secondary); outline-offset: 3px; }
body :is(a,button).cb-edit-entry svg { flex: none; }
body :is(a,button).cb-edit-entry { transition: transform 180ms ease, opacity 180ms ease; transform-origin: bottom right; }
body :is(a,button).cb-edit-entry[data-placement='floating'] .cb-edit-label { display: none; }
@media (min-width: 601px) and (pointer: fine) {
  .page-header > .popover-hint:has(.cb-edit-entry:is([data-placement='auto'], [data-placement='inline'])) { display: grid; grid-template-columns: minmax(0, 1fr) auto; column-gap: 16px; align-items: center; }
  .page-header > .popover-hint:has(.cb-edit-entry) > * { grid-column: 1 / -1; min-width: 0; }
  .page-header > .popover-hint:has(.cb-edit-entry:is([data-placement='auto'], [data-placement='inline'])) > .content-meta { grid-column: 1; margin: 0; }
  .page-header > .popover-hint > :is(.edit-this-page, .suggest-correction):has(.cb-edit-entry:is([data-placement='auto'], [data-placement='inline'])) { grid-column: 2; justify-self: end; margin: 0; }
}
@media (prefers-reduced-motion: no-preference) {
  body :is(a,button).cb-edit-entry[data-placement='floating'].cb-edit-scrolling-down:not(:focus-visible) { transform: scale(.85); opacity: .7; }
}
@media (prefers-reduced-motion: reduce) { body :is(a,button).cb-edit-entry { transition: none; } }
body :is(a,button).cb-edit-entry[data-placement='floating'] {
  position: fixed; z-index: 90; width: 56px; height: 56px; padding: 16px;
  right: max(20px, env(safe-area-inset-right)); bottom: calc(20px + env(safe-area-inset-bottom));
  border-radius: 50%; background: var(--light); color: var(--secondary); box-shadow: 0 3px 14px #0003;
  border: 1px solid var(--lightgray);
}
@media (max-width: 600px), (pointer: coarse) {
  body :is(a,button).cb-edit-entry[data-placement='auto'] .cb-edit-label { display: none; }
  @media (prefers-reduced-motion: no-preference) {
    body :is(a,button).cb-edit-entry[data-placement='auto'].cb-edit-scrolling-down:not(:focus-visible) { transform: scale(.85); opacity: .7; }
  }
  body :is(a,button).cb-edit-entry[data-placement='auto'] {
    position: fixed; z-index: 90; width: 56px; height: 56px; padding: 16px;
    right: max(20px, env(safe-area-inset-right)); bottom: calc(20px + env(safe-area-inset-bottom));
    border-radius: 50%; background: var(--light); color: var(--secondary); box-shadow: 0 3px 14px #0003;
    border: 1px solid var(--lightgray);
  }
}
body:has(.cb-suggesting) .cb-edit-entry, body :is(a,button).cb-edit-entry[hidden] { display: none; }
`

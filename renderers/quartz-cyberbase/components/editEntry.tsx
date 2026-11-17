/** One presentation for owner navigation and visitor entry; no edit authority. */
export function EditPencil() {
  return <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m15 5 4 4M17 3a2.828 2.828 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" /></svg>
}
export const editEntryCss = `
.edit-this-page:has(.cb-edit-entry), .suggest-correction { margin: .25rem 0 .75rem; }
body :is(a,button).cb-edit-entry {
  display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box;
  width: 36px; height: 36px; min-height: 32px; padding: 6px; margin: 0;
  border: 0; border-radius: 50%; background: transparent; color: var(--darkgray);
  text-decoration: none; cursor: pointer; line-height: 1; vertical-align: middle;
}
body :is(a,button).cb-edit-entry:hover { color: var(--secondary); background: var(--lightgray); }
body :is(a,button).cb-edit-entry:focus-visible { outline: 2px solid var(--secondary); outline-offset: 3px; }
body :is(a,button).cb-edit-entry svg { flex: none; }
body :is(a,button).cb-edit-entry[data-placement='floating'] {
  position: fixed; z-index: 90; width: 56px; height: 56px; padding: 16px;
  right: max(20px, env(safe-area-inset-right)); bottom: calc(20px + env(safe-area-inset-bottom));
  background: var(--light); color: var(--secondary); box-shadow: 0 3px 14px #0003;
  border: 1px solid var(--lightgray);
}
@media (max-width: 600px), (pointer: coarse) {
  body :is(a,button).cb-edit-entry[data-placement='auto'] {
    position: fixed; z-index: 90; width: 56px; height: 56px; padding: 16px;
    right: max(20px, env(safe-area-inset-right)); bottom: calc(20px + env(safe-area-inset-bottom));
    background: var(--light); color: var(--secondary); box-shadow: 0 3px 14px #0003;
    border: 1px solid var(--lightgray);
  }
}
body:has(.cb-suggesting) .cb-edit-entry, body :is(a,button).cb-edit-entry[hidden] { display: none; }
.cb-edit-markdown { margin-left: .5rem; font-size: .75rem; color: var(--gray); }
body:has(.cb-suggesting) .cb-edit-markdown { display: none; }
`

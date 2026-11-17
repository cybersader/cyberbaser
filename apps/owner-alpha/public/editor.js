const root = document.querySelector('#owner-editor');
const form = document.querySelector('#edit-form');
const textarea = document.querySelector('#edited-text');
const button = document.querySelector('#save-button');
const status = document.querySelector('#form-status');

if (root && form && textarea && button && status) {
  const original = textarea.value;
  const draftKey = `owner-raw-draft:${location.search}:${root.dataset.sourceDigest}`;
  const back = root.querySelector('a[href^="/owner/in-place"]')?.href;
  try { textarea.value = sessionStorage.getItem(draftKey) ?? original; } catch { /* optional storage */ }
  const leave = () => { if (back) location.assign(back); };
  document.querySelector('#cancel-edit')?.addEventListener('click', () => {
    if (textarea.value === original) { leave(); return; }
    const sheet = document.createElement('dialog'); sheet.className = 'owner-cancel-sheet';
    const title = document.createElement('h2'); title.textContent = 'Discard changes?'; sheet.append(title);
    for (const [label, action] of [
      ['Discard', () => { try { sessionStorage.removeItem(draftKey); } catch {} leave(); }],
      ['Save draft', () => { try { sessionStorage.setItem(draftKey, textarea.value); leave(); } catch { status.textContent = 'Draft storage unavailable.'; } }],
      ['Keep editing', () => {}],
    ]) {
      const control = document.createElement('button'); control.type = 'button'; control.textContent = label;
      control.addEventListener('click', () => { sheet.close(); sheet.remove(); action(); }); sheet.append(control);
    }
    sheet.addEventListener('cancel', () => sheet.remove()); document.body.append(sheet); sheet.showModal();
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    button.disabled = true;
    status.className = 'status';
    status.textContent = 'Starting the owner-controlled publish job…';

    try {
      const response = await fetch('/api/edits', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          editSessionId: root.dataset.editSessionId,
          editedText: textarea.value,
          csrf: root.dataset.csrf,
        }),
      });
      const result = await response.json();
      if (!response.ok || typeof result.statusUrl !== 'string') {
        throw new Error(result?.error?.code ?? 'save-failed');
      }
      try { sessionStorage.removeItem(draftKey); } catch {}
      window.location.assign(result.statusUrl);
    } catch (error) {
      status.className = 'status error';
      status.textContent = `Save was not accepted (${error.message}). Reload the edit link and try again.`;
      button.disabled = false;
    }
  });
}

const root = document.querySelector('#owner-direct');
const form = document.querySelector('#direct-form');
const status = document.querySelector('#form-status');
if (root && form && status) {
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const button = form.querySelector('button');
    button.disabled = true;
    status.textContent = 'Saving…';
    try {
      const response = await fetch('/api/owner-direct', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ editId: root.dataset.editId, csrf: root.dataset.csrf }),
      });
      const result = await response.json();
      if (result?.error?.code === 'recovery-in-progress') { status.textContent = 'Finishing an earlier publish. Try again in a moment.'; button.disabled = false; return; }
      if (!response.ok || !/^\/owner\/jobs\/OA-[A-Za-z0-9-]+$/.test(result.statusUrl)) throw Error(result?.error?.code ?? 'save-failed');
      location.assign(result.statusUrl);
    } catch (error) {
      status.textContent = `Not saved (${error.message}).`;
      button.disabled = false;
    }
  });
}

const root = document.querySelector('#owner-editor');
const form = document.querySelector('#edit-form');
const textarea = document.querySelector('#edited-text');
const button = document.querySelector('#save-button');
const status = document.querySelector('#form-status');

if (root && form && textarea && button && status) {
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
      window.location.assign(result.statusUrl);
    } catch (error) {
      status.className = 'status error';
      status.textContent = `Save was not accepted (${error.message}). Reload the edit link and try again.`;
      button.disabled = false;
    }
  });
}

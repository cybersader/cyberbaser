const form = document.querySelector('#apply-form');
const status = document.querySelector('#apply-status');
const dialog = document.querySelector('#decision-dialog');
const confirmButton = document.querySelector('#apply-confirm');
const cancelButton = document.querySelector('[data-dialog-cancel]');
const applyButton = document.querySelector('[data-apply]');

if (form && status && dialog && confirmButton && cancelButton && applyButton) {
  let inFlight = false;

  function showStatus(message, { error = false, focus = false } = {}) {
    status.className = error ? 'status error' : 'status';
    status.textContent = message;
    if (focus) status.focus();
  }

  function setPending(pending) {
    inFlight = pending;
    for (const button of [applyButton, confirmButton, cancelButton]) button.disabled = pending;
  }

  function recoveryMessage(code) {
    if (code === 'lock-busy') return 'Another owner action is finishing. Wait a moment, then try again.';
    if (code === 'application-stale') return 'The page changed since you reviewed this. Nothing was changed. Reload to see why.';
    if (code === 'application-unapplicable') return 'The page pipeline cannot apply this change. Nothing was changed. Reload to see why.';
    if (code === 'checkout-not-clean' || code === 'checkout-not-at-origin-branch') {
      return 'Your page checkout has unsaved or unpushed work. Nothing was changed. Tidy it up, then try again.';
    }
    return 'The change was not started. Reload this screen and try again.';
  }

  async function apply() {
    if (inFlight) return;
    setPending(true);
    showStatus('Checking the page once more, then starting…');
    try {
      const response = await fetch(`/api/review/${encodeURIComponent(form.dataset.queueId)}/apply`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ queueId: form.dataset.queueId, csrf: form.dataset.csrf }),
      });
      const result = await response.json().catch(() => null);
      const code = result?.error?.code;
      if (!response.ok) {
        if (code === 'application-applied') {
          window.location.reload();
          return;
        }
        throw Object.assign(new Error('application-not-started'), { code });
      }
      if (typeof result?.statusUrl !== 'string') throw new Error('invalid-application-result');
      const statusUrl = new URL(result.statusUrl, window.location.origin);
      if (statusUrl.origin !== window.location.origin || !/^\/owner\/jobs\/[^/]+$/u.test(statusUrl.pathname) || statusUrl.search || statusUrl.hash) {
        throw new Error('invalid-application-result');
      }
      window.location.assign(statusUrl.href);
    } catch (error) {
      setPending(false);
      showStatus(recoveryMessage(error?.code), { error: true, focus: true });
    }
  }

  form.addEventListener('submit', (event) => event.preventDefault());
  applyButton.addEventListener('click', () => {
    showStatus('');
    dialog.showModal();
    confirmButton.focus();
  });
  cancelButton.addEventListener('click', () => dialog.close());
  confirmButton.addEventListener('click', () => { void apply(); });
  dialog.addEventListener('cancel', (event) => {
    if (inFlight) event.preventDefault();
  });
  dialog.addEventListener('close', () => {
    if (!inFlight) applyButton.focus();
  });
}

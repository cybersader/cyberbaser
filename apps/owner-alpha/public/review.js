const form = document.querySelector('#review-decision-form');
const reason = document.querySelector('#decision-reason');
const status = document.querySelector('#decision-status');
const byteCount = document.querySelector('#decision-byte-count');
const dialog = document.querySelector('#decision-dialog');
const dialogTitle = document.querySelector('#decision-dialog-title');
const dialogKicker = document.querySelector('#decision-dialog-kicker');
const dialogSuggestion = document.querySelector('#decision-dialog-suggestion');
const dialogCopy = document.querySelector('#decision-dialog-copy');
const confirmButton = document.querySelector('#decision-confirm');
const cancelButton = document.querySelector('[data-dialog-cancel]');
const modeLinks = [...document.querySelectorAll('.review-modes .mode-tab')];
const dock = document.querySelector('#decision-dock-details');

for (const link of modeLinks) {
  link.addEventListener('keydown', (event) => {
    const current = modeLinks.indexOf(link);
    let next = null;
    if (event.key === 'ArrowRight') next = (current + 1) % modeLinks.length;
    if (event.key === 'ArrowLeft') next = (current - 1 + modeLinks.length) % modeLinks.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = modeLinks.length - 1;
    if (next === null) return;
    event.preventDefault();
    modeLinks[next].focus();
  });
}

if (form && reason && status && byteCount && dialog && dialogTitle && dialogKicker
  && dialogSuggestion && dialogCopy && confirmButton && cancelButton) {
  const maximumReasonBytes = Number(form.dataset.maxReasonBytes);
  const actionButtons = [...form.querySelectorAll('[data-action]')];
  let selectedAction = null;
  let actionTrigger = null;
  let inFlight = false;

  function reasonBytes() {
    return new TextEncoder().encode(reason.value).length;
  }

  function updateByteCount() {
    const bytes = reasonBytes();
    byteCount.textContent = `${bytes} of ${maximumReasonBytes} UTF-8 bytes`;
    byteCount.className = bytes > maximumReasonBytes ? 'byte-count error' : 'byte-count';
  }

  function showStatus(message, { error = false, focus = false } = {}) {
    status.className = error ? 'status error' : 'status';
    status.textContent = message;
    if (focus) status.focus();
  }

  function validateNote() {
    const bytes = reasonBytes();
    if (!Number.isSafeInteger(maximumReasonBytes)) return 'The decision-note limit is unavailable. Reload the proposal.';
    if (reason.value.length === 0 || reason.value.trim().length === 0) return 'Write a decision note before choosing Approve or Reject.';
    if (reason.value.trim() !== reason.value) return 'Remove whitespace from the beginning or end of the decision note.';
    if (/\p{Cc}/u.test(reason.value)) return 'The decision note cannot contain line breaks or control characters.';
    if (bytes > maximumReasonBytes) return `Shorten the decision note to ${maximumReasonBytes} UTF-8 bytes or fewer.`;
    return null;
  }

  function setPending(pending) {
    inFlight = pending;
    for (const button of [...actionButtons, confirmButton, cancelButton]) button.disabled = pending;
  }

  function openConfirmation(action, trigger) {
    const validationMessage = validateNote();
    if (validationMessage !== null) {
      showStatus(validationMessage, { error: true });
      reason.focus();
      return;
    }
    selectedAction = action;
    actionTrigger = trigger;
    const approving = action === 'approve';
    dialogKicker.textContent = approving ? 'Approve suggestion' : 'Reject suggestion';
    dialogTitle.textContent = approving ? 'Confirm approval' : 'Confirm rejection';
    dialogSuggestion.textContent = form.dataset.suggestionLabel;
    dialogCopy.textContent = 'This decision is immutable. Source remains unchanged, and no application or publication begins.';
    confirmButton.dataset.action = action;
    confirmButton.textContent = approving ? 'Confirm approval' : 'Confirm rejection';
    showStatus('');
    dialog.showModal();
    confirmButton.focus();
  }

  function recoveryMessage(code) {
    if (code === 'lock-busy') return 'Another owner action is finishing. Wait a moment, then try again.';
    if (code === 'decision-evidence-mismatch' || code === 'decision-evidence-conflict') {
      return 'The proposal evidence changed. No decision was recorded. Reload the proposal before deciding.';
    }
    if (code === 'review-expired' || code === 'decision-expired') {
      return 'This proposal expired before the decision could be recorded. No decision was recorded.';
    }
    if (code === 'review-source-timeout' || code === 'review-ipc-timeout') {
      return 'Source verification took too long. No decision was recorded. Try again when the review service is responsive.';
    }
    if (code === 'review-source-unavailable' || code === 'review-ipc-busy' || code === 'review-ipc-internal-error') {
      return 'The review service is temporarily unavailable. No decision was recorded. Try again shortly.';
    }
    return 'The decision was not recorded. Keep this note, reload the proposal, and try again.';
  }

  async function recordDecision() {
    if (inFlight || !['approve', 'reject'].includes(selectedAction)) return;
    const validationMessage = validateNote();
    if (validationMessage !== null) {
      dialog.close();
      showStatus(validationMessage, { error: true });
      reason.focus();
      return;
    }

    setPending(true);
    dialogCopy.textContent = selectedAction === 'approve'
      ? 'Recording approval after fresh source and policy checks…'
      : 'Recording rejection after fresh source and policy checks…';

    try {
      const response = await fetch(
        `/api/review/${encodeURIComponent(form.dataset.queueId)}/decision`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            queueId: form.dataset.queueId,
            reviewEvidenceDigest: form.dataset.reviewEvidenceDigest,
            action: selectedAction,
            reason: reason.value,
            csrf: form.dataset.csrf,
          }),
        },
      );
      const result = await response.json().catch(() => null);
      const code = result?.error?.code;
      if (!response.ok) {
        if (code === 'decision-already-recorded') {
          window.location.assign(`/owner/decisions/${encodeURIComponent(form.dataset.queueId)}`);
          return;
        }
        throw Object.assign(new Error('decision-not-recorded'), { code });
      }
      if (typeof result?.statusUrl !== 'string') throw new Error('invalid-decision-receipt');
      const statusUrl = new URL(result.statusUrl, window.location.origin);
      const expectedPath = `/owner/decisions/${encodeURIComponent(form.dataset.queueId)}`;
      if (statusUrl.origin !== window.location.origin || statusUrl.pathname !== expectedPath || statusUrl.search || statusUrl.hash) {
        throw new Error('invalid-decision-receipt');
      }
      window.location.assign(statusUrl.href);
    } catch (error) {
      const message = recoveryMessage(error?.code);
      const reloadRequired = ['decision-evidence-mismatch', 'decision-evidence-conflict', 'review-expired', 'decision-expired']
        .includes(error?.code);
      setPending(false);
      if (reloadRequired) {
        dialog.close();
        showStatus(message, { error: true, focus: true });
      } else {
        dialogCopy.textContent = message;
        confirmButton.focus();
      }
    }
  }

  form.addEventListener('submit', (event) => event.preventDefault());
  reason.addEventListener('input', updateByteCount);
  for (const button of actionButtons) {
    button.addEventListener('click', () => {
      if (!['approve', 'reject'].includes(button.dataset.action)) return;
      openConfirmation(button.dataset.action, button);
    });
  }
  cancelButton.addEventListener('click', () => dialog.close());
  confirmButton.addEventListener('click', () => { void recordDecision(); });
  dialog.addEventListener('cancel', (event) => {
    if (inFlight) event.preventDefault();
  });
  dialog.addEventListener('close', () => {
    if (!inFlight) actionTrigger?.focus();
  });
  updateByteCount();
}

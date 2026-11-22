{
// The page sits in a sandboxed frame with no scripts. Moving between changes
// navigates that frame to an anchor Cyberbaser placed on each change; the
// frame's own CSS highlights the targeted change.
const app = document.querySelector('#owner-review-detail');
const frame = document.querySelector('#rv-frame');
const sheet = document.querySelector('#rv-sheet');
const fold = document.querySelector('#rv-fold');
if (sheet && fold) {
  fold.addEventListener('click', () => {
    const folded = sheet.classList.toggle('is-min');
    fold.setAttribute('aria-expanded', String(!folded));
    fold.setAttribute('aria-label', folded ? 'Show the panel' : 'Hide the panel');
  });
}
const anchors = (app?.dataset.anchors ?? '').split(',').filter(Boolean).map(Number);
const position = document.querySelector('#rv-pos');
const listLinks = [...document.querySelectorAll('#rv-list a[data-change]')];
let current = 0;
function showChange(index) {
  if (!frame || anchors.length === 0) return;
  current = (index + anchors.length) % anchors.length;
  const number = anchors[current];
  frame.src = `${app.dataset.frame}#c${number}`;
  if (position) position.textContent = `${current + 1} of ${anchors.length}`;
  for (const link of listLinks) link.setAttribute('aria-current', String(Number(link.dataset.change) === number));
}
document.querySelector('#rv-prev')?.addEventListener('click', () => showChange(current - 1));
document.querySelector('#rv-next')?.addEventListener('click', () => showChange(current + 1));
for (const link of listLinks) {
  link.addEventListener('click', (event) => {
    event.preventDefault();
    showChange(anchors.indexOf(Number(link.dataset.change)));
  });
}
if (listLinks.length && anchors.length) listLinks.find((link) => Number(link.dataset.change) === anchors[0])?.setAttribute('aria-current', 'true');
const listToggle = document.querySelector('#rv-list-toggle');
const list = document.querySelector('#rv-list');
if (listToggle && list) {
  const total = list.children.length;
  listToggle.addEventListener('click', () => {
    const open = list.hidden;
    list.hidden = !open;
    listToggle.setAttribute('aria-expanded', String(open));
    listToggle.textContent = open ? 'Hide the list' : `See all ${total} changes`;
  });
}
// "I've seen this": changes the page cannot show are looked at before Approve.
const seen = document.querySelector('#rv-seen');
let acknowledged = false;
if (seen) {
  seen.addEventListener('click', () => {
    acknowledged = true;
    const approveButton = document.querySelector('.rv-act [data-action="approve"]');
    seen.hidden = true;
    if (approveButton) { approveButton.hidden = false; approveButton.focus(); }
  });
}
const rehearsalDismiss = document.querySelector('[data-dismiss-rehearsal]');
if (rehearsalDismiss) {
  rehearsalDismiss.addEventListener('click', () => {
    rehearsalDismiss.closest('.proposal-rehearsal-notice').hidden = true;
    document.querySelector('#owner-review-list h1')?.focus();
  });
}

const form = document.querySelector('#review-decision-form');
const reason = document.querySelector('#decision-reason');
const status = document.querySelector('#decision-status');
const byteCount = document.querySelector('#decision-byte-count');
const dialog = document.querySelector('#decision-dialog');
const dialogTitle = document.querySelector('#decision-dialog-title');
const confirmButton = document.querySelector('#decision-confirm');
const cancelButton = document.querySelector('[data-dialog-cancel]');
const modeLinks = [...document.querySelectorAll('.review-modes .mode-tab')];

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

if (form && reason && status && byteCount && dialog && dialogTitle && confirmButton && cancelButton) {
  const maximumReasonBytes = Number(form.dataset.maxReasonBytes);
  const actionButtons = [...document.querySelectorAll('.rv-act [data-action]')];
  let selectedAction = null;
  let actionTrigger = null;
  let inFlight = false;

  function reasonBytes() {
    return new TextEncoder().encode(reason.value).length;
  }

  // The counter stays quiet until the note is close to the limit.
  function updateByteCount() {
    const bytes = reasonBytes();
    byteCount.textContent = `${bytes} of ${maximumReasonBytes} UTF-8 bytes`;
    const near = bytes > maximumReasonBytes - 512;
    byteCount.className = `byte-count${near ? ' visible' : ''}${bytes > maximumReasonBytes ? ' error' : ''}`;
  }

  function showStatus(message, { error = false, focus = false } = {}) {
    status.className = error ? 'status error' : 'status';
    status.textContent = message;
    if (focus) status.focus();
  }

  function validateNote() {
    const bytes = reasonBytes();
    if (!Number.isSafeInteger(maximumReasonBytes)) return 'The note limit is unavailable. Reload the proposal.';
    if (reason.value.length === 0 || reason.value.trim().length === 0) return 'Write a short note before you approve or reject.';
    if (reason.value.trim() !== reason.value) return 'Trim the spaces at the start or end of your note.';
    if (/\p{Cc}/u.test(reason.value)) return 'Keep the note to one paragraph, without line breaks.';
    if (bytes > maximumReasonBytes) return `Shorten the note to ${maximumReasonBytes} UTF-8 bytes or fewer.`;
    return null;
  }

  function setPending(pending) {
    inFlight = pending;
    for (const button of [...actionButtons, confirmButton, cancelButton]) button.disabled = pending;
  }

  function openSheet(action, trigger) {
    selectedAction = action;
    actionTrigger = trigger;
    const approving = action === 'approve';
    const count = Number(form.dataset.changeCount);
    const what = count > 1 ? `all ${count} changes` : 'this proposal';
    dialogTitle.textContent = approving ? `Approve ${what}?` : `Reject ${what}?`;
    confirmButton.dataset.action = action;
    confirmButton.textContent = approving ? 'Approve' : 'Reject';
    showStatus('');
    dialog.showModal();
    reason.focus();
  }

  function recoveryMessage(code) {
    if (code === 'lock-busy') return 'Another owner action is finishing. Wait a moment, then try again.';
    if (code === 'unseen-changes-not-acknowledged') return 'Look at the changes the page can’t show, then choose I’ve seen this. Nothing was recorded.';
    if (code === 'decision-evidence-mismatch' || code === 'decision-evidence-conflict') {
      return 'This proposal changed while you were reading it. Nothing was recorded. Reload it before deciding.';
    }
    if (code === 'review-expired' || code === 'decision-expired') {
      return 'This proposal expired before your decision could be recorded. Nothing was recorded.';
    }
    if (code === 'review-source-timeout' || code === 'review-ipc-timeout') {
      return 'Checking the source took too long. Nothing was recorded. Try again in a moment.';
    }
    if (code === 'review-source-unavailable' || code === 'review-ipc-busy' || code === 'review-ipc-internal-error') {
      return 'The review service is not answering right now. Nothing was recorded. Try again shortly.';
    }
    return 'Your decision was not recorded. Keep your note, reload the proposal, and try again.';
  }

  async function recordDecision() {
    if (inFlight || !['approve', 'reject'].includes(selectedAction)) return;
    const validationMessage = validateNote();
    if (validationMessage !== null) {
      showStatus(validationMessage, { error: true });
      reason.focus();
      return;
    }

    setPending(true);
    showStatus(selectedAction === 'approve' ? 'Checking the source once more, then recording your approval…' : 'Checking the source once more, then recording your rejection…');

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
            ...(selectedAction === 'approve' && form.dataset.mustSee === 'true' && acknowledged ? { acknowledgedInvisible: true } : {}),
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
      setPending(false);
      showStatus(recoveryMessage(error?.code), { error: true, focus: true });
    }
  }

  form.addEventListener('submit', (event) => event.preventDefault());
  reason.addEventListener('input', updateByteCount);
  for (const button of actionButtons) {
    button.addEventListener('click', () => {
      if (!['approve', 'reject'].includes(button.dataset.action)) return;
      openSheet(button.dataset.action, button);
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
}

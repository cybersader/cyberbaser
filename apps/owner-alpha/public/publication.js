const form = document.querySelector('#publication-form');
const status = document.querySelector('#publication-status');
if (form && status) {
  let pending = false;
  const trigger = form.querySelector('button[type="submit"]');
  const dialog = document.querySelector('#publication-dialog');
  const confirm = document.querySelector('#publication-confirm');
  const cancel = document.querySelector('#publication-cancel');
  const action = form.dataset.action;
  const send = async () => {
    if (pending) return;
    pending = true;
    trigger.disabled = true;
    if (confirm) confirm.disabled = true;
    dialog?.close();
    form.setAttribute('aria-busy', 'true');
    status.textContent = action === 'prepare' ? 'Capturing your page and preparing the review…' : 'Rechecking this version and starting publication…';
    try {
      const body = action === 'prepare' ? { mappingId: form.dataset.mappingId, csrf: form.dataset.csrf }
        : { draftId: form.dataset.draftId, csrf: form.dataset.csrf };
      const response = await fetch(`/api/publication/${action}`, { method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const result = await response.json();
      if (!response.ok) throw new Error('publication-refused');
      const unchanged = action === 'prepare' && result.outcome === 'unchanged';
      if (unchanged && (Object.keys(result).sort().join(',') !== 'outcome,reviewUrl'
        || typeof result.reviewUrl !== 'string' || !/^\/owner\/publication\/current\/[0-9a-f]{64}$/u.test(result.reviewUrl))) {
        throw new Error('invalid-publication-response');
      }
      const target = new URL(action === 'prepare' ? result.reviewUrl : result.statusUrl, window.location.origin);
      const allowed = action === 'prepare' ? (unchanged ? /^\/owner\/publication\/current\/[0-9a-f]{64}$/u : /^\/owner\/publication\/[0-9a-f]{64}$/u) : /^\/owner\/jobs\/OA-PUB-[0-9a-f]{64}$/u;
      if (target.origin !== window.location.origin || !allowed.test(target.pathname) || target.search || target.hash) throw new Error('invalid-publication-response');
      window.location.assign(target.href);
    } catch {
      // A lost response can hide acceptance. Do not claim that no job started.
      status.textContent = action === 'prepare' ? 'The review could not be prepared. Check the configured source and publication checkout.'
        : 'Publication could not be confirmed. Reload this review to check its one existing job before trying again. Do not assume nothing changed.';
      pending = false;
      trigger.disabled = false;
      if (confirm) confirm.disabled = false;
      form.removeAttribute('aria-busy');
      trigger.focus();
    }
  };
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (pending) return;
    if (action === 'prepare') { void send(); return; }
    // Fail closed if native confirmation is unavailable. Opening the sheet never
    // grants publication; only its deliberate confirm action sends the request.
    if (!dialog || typeof dialog.showModal !== 'function') {
      status.textContent = 'Publication needs a browser with dialog support. No request was sent.';
      return;
    }
    if (!dialog.open) { dialog.showModal(); cancel.focus(); }
  });
  cancel?.addEventListener('click', () => dialog.close());
  dialog?.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    // Keep both keyboard directions within the two deliberate dialog actions,
    // including browsers that otherwise briefly focus the document boundary.
    if (event.shiftKey && document.activeElement === cancel) { event.preventDefault(); confirm.focus(); }
    else if (!event.shiftKey && document.activeElement === confirm) { event.preventDefault(); cancel.focus(); }
  });
  dialog?.addEventListener('close', () => { if (!pending) trigger.focus(); });
  confirm?.addEventListener('click', () => { if (dialog.open) void send(); });
}

// Display controls never submit, fetch, persist hunks or change the reviewed version.
const review = document.querySelector('.publication-review-app');
if (review) {
  const anchors = [...review.querySelectorAll('[data-change]')];
  const count = document.querySelector('#publication-change-count');
  const marks = document.querySelector('#publication-toggle-marks');
  const announcement = document.querySelector('#publication-review-announcement');
  const marksTip = document.querySelector('#publication-toggle-marks-tip');
  const startAtFirst = review.dataset.startFirstChange !== undefined;
  if (startAtFirst) anchors.sort((left, right) => Number(left.dataset.change) - Number(right.dataset.change));
  let current = startAtFirst ? 0 : -1;
  const announce = (text) => { if (announcement) announcement.textContent = text; };
  const showMarks = (visible) => {
    review.dataset.marksVisible = String(visible);
    marks?.setAttribute('aria-pressed', String(visible));
    if (marksTip) marksTip.textContent = visible ? 'Changes shown' : 'Changes hidden';
  };
  const move = (direction) => {
    if (!anchors.length) return;
    const restored = review.dataset.marksVisible !== 'true';
    showMarks(true); // Restore deleted blocks BEFORE choosing/focusing a target.
    current = current < 0 ? (direction > 0 ? 0 : anchors.length - 1)
      : (current + direction + anchors.length) % anchors.length;
    anchors[current].focus({ preventScroll: true });
    anchors[current].scrollIntoView({ block: 'start', behavior: 'instant' });
    if (count) count.textContent = `${current + 1} / ${anchors.length}`;
    announce(`${restored ? 'Changes shown. ' : ''}Change ${current + 1} of ${anchors.length}.`);
  };
  document.querySelector('#publication-previous-change')?.addEventListener('click', () => move(-1));
  document.querySelector('#publication-next-change')?.addEventListener('click', () => move(1));
  marks?.addEventListener('click', () => {
    const visible = review.dataset.marksVisible !== 'true';
    showMarks(visible);
    announce(visible ? 'Changes shown.' : 'Changes hidden.');
  });
  // Real hoverable tooltips. Escape suppresses a tip until both focus and
  // pointer leave its control; changing display state never replaces its SVG.
  for (const tool of review.querySelectorAll('.publication-tool')) {
    let hovered = false; let focused = false; let dismissed = false;
    const paint = () => {
      if (!hovered && !focused) dismissed = false;
      tool.dataset.tooltipVisible = String((hovered || focused) && !dismissed);
    };
    tool.addEventListener('pointerenter', () => { hovered = true; paint(); });
    tool.addEventListener('pointerleave', () => { hovered = false; paint(); });
    tool.addEventListener('focusin', () => { focused = true; paint(); });
    tool.addEventListener('focusout', (event) => { focused = tool.contains(event.relatedTarget); paint(); });
    tool.addEventListener('keydown', (event) => { if (event.key === 'Escape') { dismissed = true; paint(); } });
  }
  // Details has its own native modal and focus model, never Publish's form or
  // two-action trap. Move the already-escaped DOM; do not fetch/parse HTML.
  const tools = document.querySelector('#publication-toggle-details');
  const details = document.querySelector('#publication-review-details');
  const fallback = document.querySelector('#publication-review-fallback');
  const sheet = document.querySelector('#publication-details-dialog');
  const body = document.querySelector('#publication-details-body');
  const close = document.querySelector('#publication-close-details');
  const scroller = document.querySelector('#publication-document-scroll');
  if (startAtFirst && scroller && anchors[0]) {
    const viewport = scroller.getBoundingClientRect();
    const first = anchors[0].getBoundingClientRect();
    if (first.top > viewport.bottom - 24) anchors[0].scrollIntoView({ block: 'center', behavior: 'instant' });
  }
  if (tools && details && fallback && sheet && body && close && scroller && typeof sheet.showModal === 'function') {
    let scrollTop = 0; let scrollLeft = 0;
    const restoreScroll = () => { scroller.scrollTop = scrollTop; scroller.scrollLeft = scrollLeft; };
    const restoreFallback = () => {
      fallback.append(details); fallback.hidden = false; fallback.open = true;
      tools.hidden = true; tools.setAttribute('aria-expanded', 'false');
    };
    const open = () => {
      if (sheet.open) return;
      scrollTop = scroller.scrollTop; scrollLeft = scroller.scrollLeft;
      try {
        sheet.showModal(); close.focus({ preventScroll: true });
        tools.setAttribute('aria-expanded', 'true'); restoreScroll();
      } catch { restoreFallback(); restoreScroll(); }
    };
    try {
      body.append(details);
      close.addEventListener('click', () => sheet.close());
      sheet.addEventListener('close', () => {
        tools.setAttribute('aria-expanded', 'false');
        tools.focus({ preventScroll: true }); restoreScroll();
      });
      sheet.addEventListener('keydown', (event) => {
        if (event.key !== 'Tab') return;
        const stops = [...sheet.querySelectorAll('button, [href], summary, [tabindex]:not([tabindex="-1"])')]
          .filter((node) => !node.disabled && node.getClientRects().length > 0);
        const first = stops[0]; const last = stops.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      });
      tools.addEventListener('click', open);
      // Only hide the native disclosure after the enhancement is initialized.
      fallback.hidden = true; tools.hidden = false;
      if (fallback.open) open();
    } catch { restoreFallback(); }
  }
}

// Publication-only job presentation. Other owner jobs retain their existing
// client and markup. Raw states remain in the record, not in the page headline.
const root = document.querySelector('.publication-page #owner-job');
if (root) {
  const stage = document.querySelector('#job-stage');
  const state = document.querySelector('#job-state');
  const updated = document.querySelector('#job-updated');
  const recovery = document.querySelector('#job-recovery');
  const error = document.querySelector('#job-error');
  const steps = [...document.querySelectorAll('#job-steps .job-step')];
  const terminal = new Set(['completed', 'blocked-pre-apply', 'deployment-failed', 'manual-intervention', 'cancelled', 'failed']);
  let stages;
  try { stages = JSON.parse(root.dataset.stages); } catch { /* Keep the server-rendered record. */ }
  const paint = (job) => {
    const found = stages.steps.findIndex((step) => step.states.includes(job.state));
    const current = found !== -1 ? found : stages.stops[job.state]?.step ?? 0;
    const done = job.state === 'completed';
    const stopped = Object.hasOwn(stages.stops, job.state) && !done;
    const uncertain = ['failed', 'manual-intervention', 'cancelled'].includes(job.state);
    stage.textContent = job.liveCopy ?? stages.stops[job.state]?.copy ?? (found !== -1 ? stages.activeCopy : null) ?? 'Publication status is unavailable. Check the record before taking another action.';
    steps.forEach((element, index) => {
      const status = uncertain ? 'unknown' : done || index < current ? 'done' : index === current ? (stopped ? 'stopped' : 'current') : 'pending';
      element.className = `job-step job-step-${status}`;
      element.dataset.status = status;
      element.querySelector('.publication-step-status').textContent = { done: 'Done', current: 'In progress', stopped: 'Stopped', pending: 'Waiting', unknown: 'See record' }[status];
    });
    const note = document.querySelector('#publication-job-note');
    if (done && note) note.textContent = note.dataset.completeCopy;
    state.textContent = job.state;
    updated.textContent = job.updatedAt ?? '—';
    recovery.textContent = job.recovery?.instruction ?? '';
    error.textContent = job.failure ? `Stopped (${job.failure.code}).` : '';
  };
  async function refresh() {
    if (!stages) return;
    try {
      const response = await fetch(`/api/jobs/${encodeURIComponent(root.dataset.jobId)}`, {
        credentials: 'same-origin', headers: { Accept: 'application/json' },
      });
      const job = await response.json();
      if (!response.ok) throw new Error('job-lookup-failed');
      paint(job);
      if (!terminal.has(job.state)) window.setTimeout(refresh, 2000);
    } catch {
      error.textContent = 'Progress could not be refreshed. Reload this page to check the existing job; do not start another publication.';
      window.setTimeout(refresh, 5000);
    }
  }
  refresh();
}

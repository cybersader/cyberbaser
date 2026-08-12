const root = document.querySelector('#owner-job');
const state = document.querySelector('#job-state');
const updated = document.querySelector('#job-updated');
const recovery = document.querySelector('#job-recovery');
const error = document.querySelector('#job-error');
const terminal = new Set([
  'completed',
  'blocked-pre-apply',
  'deployment-failed',
  'manual-intervention',
  'cancelled',
  'failed',
]);

async function refresh() {
  if (!root || !state || !updated || !recovery || !error) return;
  try {
    const response = await fetch(`/api/jobs/${encodeURIComponent(root.dataset.jobId)}`, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
    const job = await response.json();
    if (!response.ok) throw new Error(job?.error?.code ?? 'job-lookup-failed');
    state.textContent = job.state;
    updated.textContent = job.updatedAt ?? '';
    recovery.textContent = job.recovery?.instruction ?? '';
    error.textContent = job.failure ? `Pipeline stopped (${job.failure.code}).` : '';
    if (!terminal.has(job.state)) window.setTimeout(refresh, 2000);
  } catch (caught) {
    error.textContent = `Status refresh failed (${caught.message}).`;
    window.setTimeout(refresh, 5000);
  }
}

refresh();

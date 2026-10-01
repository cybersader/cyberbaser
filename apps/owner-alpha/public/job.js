const root = document.querySelector('#owner-job');
const stage = document.querySelector('#job-stage');
const state = document.querySelector('#job-state');
const updated = document.querySelector('#job-updated');
const recovery = document.querySelector('#job-recovery');
const error = document.querySelector('#job-error');
const steps = [...document.querySelectorAll('#job-steps .job-step')];
const terminal = new Set([
  'completed',
  'blocked-pre-apply',
  'deployment-failed',
  'manual-intervention',
  'cancelled',
  'failed',
]);

let stages = { steps: [], stops: {} };
try {
  stages = JSON.parse(root?.dataset.stages ?? '{}');
} catch {
  // The server-rendered page stays correct without live updates.
}

function stepIndex(jobState) {
  const index = stages.steps.findIndex((step) => step.states.includes(jobState));
  if (index !== -1) return index;
  return stages.stops[jobState]?.step ?? 0;
}

function stageCopy(jobState) {
  if (stages.stops[jobState]) return stages.stops[jobState].copy;
  const step = stages.steps.find((item) => item.states.includes(jobState));
  return step ? step.label : jobState;
}

function paint(jobState) {
  const current = stepIndex(jobState);
  const done = jobState === 'completed';
  const stopped = Object.hasOwn(stages.stops, jobState) && !done;
  steps.forEach((element, index) => {
    const status = done || index < current ? 'done' : index === current ? (stopped ? 'stopped' : 'current') : 'pending';
    element.className = `job-step job-step-${status}`;
    element.dataset.status = status;
  });
  if (stage) stage.textContent = stageCopy(jobState);
}

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
    error.textContent = job.failure ? `Stopped (${job.failure.code}).` : '';
    paint(job.state);
    if (!terminal.has(job.state)) window.setTimeout(refresh, 2000);
  } catch (caught) {
    error.textContent = `Status refresh failed (${caught.message}).`;
    window.setTimeout(refresh, 5000);
  }
}

refresh();

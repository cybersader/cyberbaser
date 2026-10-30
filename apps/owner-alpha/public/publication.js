const form = document.querySelector('#publication-form');
const status = document.querySelector('#publication-status');
if (form && status) {
  let pending = false;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (pending) return;
    const action = form.dataset.action;
    if (action === 'publish' && !window.confirm('Publish this captured version? This applies the exact change, commits, pushes, and confirms the deployment.')) return;
    pending = true;
    form.querySelector('button').disabled = true;
    status.textContent = action === 'prepare' ? 'Preparing the exact review…' : 'Rechecking the captured version and starting its publication job…';
    try {
      const body = action === 'prepare' ? { mappingId: form.dataset.mappingId, csrf: form.dataset.csrf }
        : { draftId: form.dataset.draftId, csrf: form.dataset.csrf };
      const response = await fetch(`/api/publication/${action}`, { method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const result = await response.json();
      if (!response.ok) throw new Error('publication-refused');
      const target = new URL(action === 'prepare' ? result.reviewUrl : result.statusUrl, window.location.origin);
      const allowed = action === 'prepare' ? /^\/owner\/publication\/[0-9a-f]{64}$/u : /^\/owner\/jobs\/OA-PUB-[0-9a-f]{64}$/u;
      if (target.origin !== window.location.origin || !allowed.test(target.pathname) || target.search || target.hash) throw new Error('invalid-publication-response');
      window.location.assign(target.href);
    } catch {
      // A lost response can hide acceptance. Do not claim that no job started.
      status.textContent = action === 'prepare' ? 'The review could not be prepared. Check the configured source and publication checkout.'
        : 'Publication could not be confirmed. Reload this review to check its one existing job before trying again. Do not assume nothing changed.';
      pending = false;
      form.querySelector('button').disabled = false;
    }
  });
}

// First-run setup: each button names one action for the step on screen. The
// server decides what happens and which step comes next; this page only posts
// the action with the session's CSRF token and shows the result.
(() => {
  const root = document.getElementById('setup');
  if (!root) return;
  const csrf = root.dataset.csrf;
  const step = root.dataset.step;
  const status = document.getElementById('setup-status');
  const MESSAGES = {
    'not-ready': 'That step is not finished yet.',
    'invalid-url': 'Enter the full address, starting with https://.',
    'step-changed': 'This page was out of date. It has been refreshed.',
  };

  async function send(action, value = null, trigger = null) {
    if (trigger) trigger.disabled = true;
    status.textContent = '';
    let outcome = null;
    try {
      const response = await fetch('/setup/step', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csrf, step, action, value }),
      });
      outcome = await response.json().catch(() => null);
    } catch {
      status.textContent = 'This page lost contact with Cyberbaser. Check that it is still running, then try again.';
      if (trigger) trigger.disabled = false;
      return null;
    }
    if (outcome?.ok || outcome?.code === 'step-changed') { location.assign('/setup'); return outcome; }
    if (trigger) trigger.disabled = false;
    return outcome ?? { ok: false };
  }

  // ---- Your website: a detected address, or one field
  const form = document.getElementById('website-form');
  const found = document.getElementById('website-found');
  const urlInput = document.getElementById('website-url');
  const urlError = document.getElementById('website-error');
  form?.addEventListener('submit', (event) => { event.preventDefault(); root.querySelector('[data-action="save-url"]')?.click(); });

  // ---- Your notes: the starter publish.yml, built from the folders picked
  const starter = document.getElementById('setup-starter');
  const file = document.getElementById('setup-file');
  const picked = () => [...root.querySelectorAll('.setup-folder[aria-pressed="true"]')].map((node) => node.dataset.folder);
  function renderFile() {
    const folders = picked().sort((a, b) => a.localeCompare(b));
    const head = '# What Cyberbaser may publish. Only notes in these folders go on your website.\n# Everything else stays private. Add or remove folders any time.\n';
    file.textContent = folders.length === 0 ? `${head}allow: []\n`
      : `${head}allow:\n${folders.map((folder) => `  - ${JSON.stringify(`${folder}/**`)}`).join('\n')}\n`;
  }
  root.querySelectorAll('.setup-folder').forEach((node) => node.addEventListener('click', () => {
    node.setAttribute('aria-pressed', node.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
    renderFile();
  }));

  root.addEventListener('click', async (event) => {
    const trigger = event.target.closest('[data-action]');
    if (!trigger || trigger.closest('#forge') || trigger.closest('#devices')) return;
    const action = trigger.dataset.action;
    if (action === 'open-starter') {
      starter.hidden = false;
      trigger.closest('.setup-actions').hidden = true;
      (root.querySelector('.setup-folder') ?? root.querySelector('[data-action="starter"]'))?.focus();
      return;
    }
    if (action === 'edit-url') {
      found.hidden = true;
      form.hidden = false;
      urlInput.focus();
      return;
    }
    if (action === 'save-url') {
      urlError.textContent = '';
      if (!urlInput.value.trim()) { urlError.textContent = 'Enter the address, or choose Skip for now.'; urlInput.focus(); return; }
      const outcome = await send('save-url', urlInput.value.trim(), trigger);
      if (outcome && !outcome.ok) { urlError.textContent = MESSAGES[outcome.code] ?? 'That address was not accepted.'; urlInput.focus(); }
      return;
    }
    const outcome = await send(action, action === 'starter' ? picked() : null, trigger);
    if (outcome && !outcome.ok) status.textContent = MESSAGES[outcome.code] ?? 'That did not work. Try again.';
  });

  // ---- Connect GitHub: Continue follows the connection state.
  const forge = document.getElementById('forge');
  const next = root.querySelector('.setup-continue [data-action="continue"]');
  forge?.addEventListener('forge-state', (event) => {
    if (next) { next.disabled = event.detail.state !== 'connected'; next.closest('.setup-continue').hidden = next.disabled; }
    if (event.detail.state === 'connected') next?.focus();
  });

  // ---- Your notes: a calm progress line while the copy and build run.
  const phase = root.dataset.notesPhase;
  if (step === 'notes' && ['idle', 'cloning', 'building'].includes(phase)) {
    let seen = phase;
    const poll = async () => {
      try {
        const now = await (await fetch('/setup/state', { credentials: 'same-origin' })).json();
        if (now.step !== step || now.notes.phase !== seen) { location.assign('/setup'); return; }
        seen = now.notes.phase;
      } catch { /* keep waiting */ }
      setTimeout(poll, 1200);
    };
    setTimeout(poll, 1200);
  }

  // ---- Done: setup hands over to Cyberbaser itself; links work once it answers.
  const starting = document.getElementById('setup-starting');
  if (step === 'done' && starting) {
    const linksRow = starting.nextElementSibling;
    linksRow?.setAttribute('aria-hidden', 'true');
    linksRow?.classList.add('is-waiting');
    let tries = 0;
    const check = async () => {
      tries += 1;
      let up = false;
      try { up = (await fetch('/owner/devices/state', { credentials: 'same-origin' })).ok; } catch { up = false; }
      if (up) {
        starting.textContent = '';
        starting.hidden = true;
        linksRow?.removeAttribute('aria-hidden');
        linksRow?.classList.remove('is-waiting');
        return;
      }
      if (tries === 20) starting.textContent = 'Still starting. This can take a minute the first time.';
      setTimeout(check, 1500);
    };
    check();
  }

  if (step !== 'github' && step !== 'phone' && step !== 'agent') root.querySelector('.setup-step h1')?.setAttribute('tabindex', '-1');
})();

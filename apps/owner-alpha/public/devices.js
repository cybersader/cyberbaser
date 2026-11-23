// Devices and agents: start pairing, show the code and the four words, Confirm,
// Revoke. Every POST carries the session's CSRF token; the server decides grants.
(() => {
  const root = document.getElementById('devices');
  if (!root) return;
  const csrf = root.dataset.csrf;
  const form = document.getElementById('pair-form');
  const live = document.getElementById('pair-live');
  const status = document.getElementById('pair-status');
  let current = null; // { enrollmentId, code, expiresAt }
  let timer = null;

  const post = async (route, body) => {
    const response = await fetch(route, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin', body: JSON.stringify({ ...body, csrf }) });
    if (!response.ok) throw new Error('refused');
    return response.json();
  };

  const el = (tag, attrs = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attrs)) {
      if (name === 'class') node.className = value; else node.setAttribute(name, value);
    }
    for (const child of children) node.append(child);
    return node;
  };

  function minutesLeft(at) {
    const seconds = Math.max(0, Math.round((at - Date.now()) / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  }

  // Kind decides which access choices exist: an agent may only suggest.
  function syncAccess() {
    if (!form) return;
    const kind = form.elements.kind.value;
    const note = document.getElementById('access-note');
    for (const input of form.querySelectorAll('input[name="access"]')) {
      const allowed = kind !== 'agent' || input.value === 'propose';
      input.disabled = !allowed;
      input.closest('.segment').hidden = !allowed;
      if (!allowed && input.checked) form.querySelector('input[name="access"][value="propose"]').checked = true;
    }
    note.hidden = kind !== 'agent';
    const label = form.elements.label;
    if (['My agent', 'My phone'].includes(label.value)) label.value = kind === 'agent' ? 'My agent' : 'My phone';
  }

  function showCode() {
    const command = `bun apps/owner-alpha/bin/cyberbaser-pair.js ${current.code}`;
    const copy = el('button', { type: 'button', class: 'quiet' }, 'Copy');
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(command); copy.textContent = 'Copied'; } catch { copy.textContent = 'Select and copy'; }
    });
    const cancel = el('button', { type: 'button', class: 'quiet' }, 'Cancel');
    cancel.addEventListener('click', () => finish('cancel'));
    live.replaceChildren(
      el('h3', {}, current.kind === 'agent' ? 'Run this where the agent works' : 'Enter this on the device'),
      el('p', { class: 'pair-hint' }, 'The code works once, for five minutes. Then come back here to compare words.'),
      el('pre', { class: 'pair-code', tabindex: '0' }, command),
      el('div', { class: 'pair-row' }, el('span', { class: 'pair-timer', id: 'pair-timer' }, `Expires in ${minutesLeft(current.expiresAt)}`), copy, cancel),
    );
  }

  function showWords(pairing) {
    const confirm = el('button', { type: 'button' }, 'Confirm');
    const cancel = el('button', { type: 'button', class: 'quiet' }, 'They differ, cancel');
    confirm.addEventListener('click', async () => {
      confirm.disabled = true;
      try {
        await post('/owner/devices/confirm', { enrollmentId: pairing.enrollmentId, words: pairing.words });
        location.reload();
      } catch { live.replaceChildren(el('p', { class: 'error' }, 'Pairing did not complete. Start again.')); stop(); }
    });
    cancel.addEventListener('click', () => finish('cancel'));
    live.replaceChildren(
      el('h3', {}, `Does ${pairing.label} show these words?`),
      el('ol', { class: 'pair-words' }, ...pairing.words.map((word) => el('li', {}, word))),
      el('p', { class: 'pair-hint' }, 'Confirm only if the agent prints the same four words in the same order.'),
      el('div', { class: 'pair-row' }, confirm, cancel),
    );
    confirm.focus();
  }

  function stop() {
    clearInterval(timer);
    timer = null;
    current = null;
    if (form) form.hidden = false;
  }

  async function finish(kind) {
    const id = current?.enrollmentId;
    stop();
    live.hidden = true;
    if (kind === 'cancel' && id) await post('/owner/devices/cancel', { enrollmentId: id }).catch(() => {});
    status.textContent = kind === 'cancel' ? 'Pairing cancelled. Nothing was added.' : 'The code expired. Nothing was added.';
  }

  async function poll() {
    if (!current) return;
    const tick = document.getElementById('pair-timer');
    if (tick) tick.textContent = `Expires in ${minutesLeft(current.expiresAt)}`;
    let state;
    try { state = await (await fetch('/owner/devices/state', { credentials: 'same-origin' })).json(); } catch { return; }
    const pairing = state.pairings?.find((item) => item.enrollmentId === current?.enrollmentId);
    if (!pairing) { await finish('expired'); return; }
    if (pairing.state === 'awaiting' && pairing.words && !live.querySelector('.pair-words')) showWords(pairing);
  }

  form?.addEventListener('change', (event) => { if (event.target.name === 'kind') syncAccess(); });
  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    status.textContent = '';
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      const started = await post('/owner/devices/pair', { kind: form.elements.kind.value,
        access: form.elements.access.value, label: form.elements.label.value.trim() });
      current = { ...started, kind: form.elements.kind.value };
      form.hidden = true;
      live.hidden = false;
      showCode();
      timer = setInterval(poll, 1500);
    } catch {
      status.textContent = 'Could not start pairing. Check the name, then try again.';
    } finally { button.disabled = false; }
  });

  // Revoke asks once inline, then acts.
  root.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-revoke]');
    if (!button) return;
    if (button.dataset.armed !== 'yes') {
      button.dataset.armed = 'yes';
      button.textContent = 'Revoke for good';
      setTimeout(() => { if (button.isConnected) { button.dataset.armed = ''; button.textContent = 'Revoke'; } }, 5000);
      return;
    }
    button.disabled = true;
    try { await post('/owner/devices/revoke', { keyId: button.dataset.revoke }); location.reload(); }
    catch { button.disabled = false; button.textContent = 'Revoke failed, retry'; }
  });

  syncAccess();
})();

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

  // The node draws the QR modules; this only builds the SVG. The path is
  // checked against the shape the node emits before it is used.
  function qrImage(qr) {
    if (!qr || !Number.isInteger(qr.size) || qr.size > 200 || typeof qr.path !== 'string'
      || !/^(M\d+ \d+h\d+v1h-\d+z)+$/u.test(qr.path)) return null;
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', `0 0 ${qr.size} ${qr.size}`);
    svg.setAttribute('class', 'pair-qr');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'QR code that opens Obsidian with this pairing code');
    svg.setAttribute('shape-rendering', 'crispEdges');
    const back = document.createElementNS(ns, 'rect');
    back.setAttribute('width', String(qr.size));
    back.setAttribute('height', String(qr.size));
    back.setAttribute('fill', '#fff');
    const modules = document.createElementNS(ns, 'path');
    modules.setAttribute('d', qr.path);
    modules.setAttribute('fill', '#000');
    svg.append(back, modules);
    return svg;
  }

  function showCode() {
    const agent = current.kind === 'agent';
    const text = agent ? `bun apps/owner-alpha/bin/cyberbaser-pair.js ${current.code}` : current.code;
    const copy = el('button', { type: 'button', class: 'quiet' }, agent ? 'Copy' : 'Copy code');
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(text); copy.textContent = 'Copied'; } catch { copy.textContent = 'Select and copy'; }
    });
    const cancel = el('button', { type: 'button', class: 'quiet' }, 'Cancel');
    cancel.addEventListener('click', () => finish('cancel'));
    const code = el('pre', { class: 'pair-code', tabindex: '0' }, text);
    const image = agent ? null : qrImage(current.qr);
    const body = image
      ? el('div', { class: 'pair-scan' }, el('figure', { class: 'pair-qr-frame' }, image),
        el('div', { class: 'pair-scan-text' },
          el('p', {}, 'Point the phone camera at this code. Obsidian opens with the code filled in; tap Pair there.'),
          el('p', { class: 'pair-hint-inline' }, 'No camera? Paste the code in Obsidian: Pair with your Cyberbaser node.'),
          code))
      : code;
    live.replaceChildren(
      el('h3', {}, agent ? 'Run this where the agent works' : 'Scan this with the phone'),
      el('p', { class: 'pair-hint' }, 'The code works once, for five minutes. Then come back here to compare words.'),
      body,
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

  // Notes to link: a device sent a note this node could not place. The owner
  // picks the vault file from the published paths; the node links it only
  // when both texts match.
  const linkSection = document.getElementById('link-notes');
  const linkList = document.getElementById('link-list');
  let vaultPaths = [];
  const LINK_REASONS = {
    'link-request-expired': 'This request expired. Send the note again from the device.',
    'link-path-not-published': 'That file is not published in your vault. Pick one from the list.',
    'link-path-refused': 'That path cannot be linked to this note.',
    'link-note-unavailable': 'The node cannot read this note right now. Send it again from the device.',
    'link-text-unreadable': 'The note text cannot be compared exactly.',
  };

  function picker(initial, fixed) {
    const wrap = el('div', { class: 'path-picker' });
    const input = el('input', { type: 'text', class: 'path-input', value: initial, autocomplete: 'off', spellcheck: 'false',
      role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': 'false', 'aria-label': 'Vault file' });
    if (fixed) input.readOnly = true;
    const list = el('ul', { class: 'path-options', role: 'listbox', hidden: '' });
    const render = () => {
      const query = input.value.trim().toLowerCase();
      const matches = vaultPaths.filter((p) => p.toLowerCase().includes(query)).slice(0, 8);
      list.replaceChildren(...matches.map((p) => {
        const option = el('li', { role: 'option', tabindex: '-1' }, p);
        option.addEventListener('mousedown', (event) => { event.preventDefault(); input.value = p; close(); });
        option.addEventListener('keydown', (event) => { if (event.key === 'Enter') { input.value = p; close(); input.focus(); } });
        return option;
      }));
      const open = !fixed && document.activeElement === input && matches.length > 0 && !(matches.length === 1 && matches[0] === input.value);
      list.hidden = !open;
      input.setAttribute('aria-expanded', String(open));
    };
    const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); };
    input.addEventListener('input', render);
    input.addEventListener('focus', render);
    input.addEventListener('blur', close);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' && !list.hidden) { event.preventDefault(); list.querySelector('li')?.focus(); }
      if (event.key === 'Escape') close();
    });
    list.addEventListener('keydown', (event) => {
      const items = [...list.querySelectorAll('li')];
      const index = items.indexOf(document.activeElement);
      if (event.key === 'ArrowDown') { event.preventDefault(); items[Math.min(index + 1, items.length - 1)]?.focus(); }
      if (event.key === 'ArrowUp') { event.preventDefault(); (index <= 0 ? input : items[index - 1]).focus(); }
      if (event.key === 'Escape') { close(); input.focus(); }
    });
    wrap.append(input, list);
    return { wrap, input };
  }

  function linkRow(request) {
    const { wrap, input } = picker(request.suggestedVaultPath, request.fixedVaultPath);
    const confirm = el('button', { type: 'button' }, 'Link');
    const dismiss = el('button', { type: 'button', class: 'quiet' }, 'Not now');
    const result = el('p', { class: 'link-result', role: 'status' });
    confirm.addEventListener('click', async () => {
      confirm.disabled = true;
      result.textContent = 'Comparing…';
      try {
        const response = await fetch('/owner/devices/link', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin', body: JSON.stringify({ requestId: request.requestId, vaultPath: input.value.trim(), csrf }) });
        const outcome = await response.json();
        if (outcome.ok && outcome.linked) {
          result.textContent = outcome.unchanged ? 'Already linked. Nothing changed.' : 'Linked. Send the note again from the device.';
          row.classList.add('is-done');
          setTimeout(loadLinks, 2500);
        } else if (outcome.ok) {
          const lines = outcome.many ? 'Many lines' : `${outcome.differences ?? outcome.count} ${(outcome.differences ?? outcome.count) === 1 ? 'line differs' : 'lines differ'}`;
          result.textContent = `Not linked: ${lines} between the note and the vault file. Sync the device, or pick another file, then send again.`;
          row.classList.add('is-refused');
          setTimeout(loadLinks, 6000);
        } else {
          result.textContent = LINK_REASONS[outcome.reason] ?? 'The node refused this link.';
          confirm.disabled = false;
        }
      } catch { result.textContent = 'Could not reach the node.'; confirm.disabled = false; }
    });
    dismiss.addEventListener('click', async () => { await post('/owner/devices/link-dismiss', { requestId: request.requestId }).catch(() => {}); loadLinks(); });
    const row = el('li', { class: 'link-row' },
      el('div', { class: 'link-pair' },
        el('div', { class: 'link-side' }, el('span', { class: 'link-label' }, 'The device sent'), el('code', { class: 'link-path' }, request.notePath)),
        el('div', { class: 'link-side' }, el('span', { class: 'link-label' }, request.fixedVaultPath ? 'Your publication page' : 'Vault file'), wrap)),
      el('div', { class: 'pair-row' }, confirm, dismiss), result);
    return row;
  }

  async function loadLinks() {
    if (!linkSection) return;
    let state;
    try { state = await (await fetch('/owner/devices/links', { credentials: 'same-origin' })).json(); } catch { return; }
    vaultPaths = Array.isArray(state.paths) ? state.paths : [];
    const requests = Array.isArray(state.requests) ? state.requests : [];
    linkSection.hidden = requests.length === 0;
    if (linkList.contains(document.activeElement)) return; // never yank a row the owner is using
    linkList.replaceChildren(el('ul', { class: 'link-list' }, ...requests.map(linkRow)));
  }
  if (linkSection) { loadLinks(); setInterval(loadLinks, 5000); }

  syncAccess();
})();

// Publishing to GitHub: connect (device code, or in setup GitHub's own create,
// install and authorize pages), pick the one repository from a searchable
// list, see status, disconnect. Every POST carries the CSRF token. The page
// only ever sees the user code, the app's public client ID and plain status;
// never a token or secret.
(() => {
  const root = document.getElementById('forge');
  if (!root) return;
  const csrf = root.dataset.csrf;
  const panel = document.getElementById('forge-panel');
  let pollTimer = null;
  let tickTimer = null;
  let lastApp = null;

  const el = (tag, attrs = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attrs)) {
      if (value === false || value === null || value === undefined) continue;
      if (name === 'class') node.className = value; else node.setAttribute(name, value === true ? '' : value);
    }
    for (const child of children) if (child !== null && child !== undefined) node.append(child);
    return node;
  };
  const button = (label, onClick, kind = '') => {
    const node = el('button', { type: 'button', class: kind || null }, label);
    node.addEventListener('click', onClick);
    return node;
  };

  async function call(route, body) {
    const init = body === undefined ? { credentials: 'same-origin' }
      : { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, csrf }) };
    let response;
    try { response = await fetch(route, init); } catch { throw new Error('This page lost contact with Cyberbaser. Reload to try again.'); }
    const value = await response.json().catch(() => null);
    if (!response.ok || value?.ok !== true) throw new Error(value?.message ?? 'That did not work. Try again.');
    return value;
  }

  function stopTimers() {
    clearTimeout(pollTimer);
    clearInterval(tickTimer);
    pollTimer = null;
    tickTimer = null;
  }

  function show(...nodes) {
    panel.replaceChildren(...nodes);
  }

  // First-run setup listens for this to know when it may continue.
  const setupMode = root.dataset.mode === 'setup';
  function announce(state) {
    root.dispatchEvent(new CustomEvent('forge-state', { detail: { state: state.state, repository: state.repository ?? null } }));
  }

  function relative(iso) {
    if (!iso) return null;
    const days = Math.round((Date.now() - Date.parse(iso)) / 86_400_000);
    if (!Number.isFinite(days)) return null;
    if (days <= 0) return 'updated today';
    if (days === 1) return 'updated yesterday';
    if (days < 45) return `updated ${days} days ago`;
    const months = Math.round(days / 30);
    if (months < 18) return `updated ${months} months ago`;
    return `updated ${Math.round(days / 365)} years ago`;
  }

  // ---- states ----------------------------------------------------------

  const linkButton = (label, href, kind = '') => el('a', { class: `forge-link-button${kind ? ` ${kind}` : ''}`, href }, label);

  // No GitHub App yet: setup creates one from a manifest, on GitHub's own page.
  function noApp() {
    stopTimers();
    if (!setupMode) {
      show(el('div', { class: 'forge-sheet' }, el('h3', {}, 'GitHub is not set up'),
        el('p', { class: 'pair-hint' }, 'Cyberbaser has no GitHub App yet. It is created during setup.')));
      return;
    }
    const create = linkButton('Create Cyberbaser\'s GitHub App', '/setup/github/create');
    show(el('div', { class: 'forge-sheet' },
      el('p', { class: 'pair-hint' }, 'GitHub opens with everything filled in. Click Create there, then Install. The app can update files in the one repository you choose and nothing else.'),
      el('div', { class: 'pair-row forge-actions' }, create)));
    create.focus();
  }

  // The app setup created signs in through GitHub's pages, not a code.
  function webConnect(problemMessage = null) {
    stopTimers();
    if (!setupMode) {
      show(el('div', { class: 'forge-sheet' }, el('h3', {}, problemMessage ? 'GitHub needs attention' : 'Connect GitHub'),
        problemMessage ? el('p', { class: 'forge-problem', role: 'alert' }, problemMessage) : null,
        el('p', { class: 'pair-hint' }, 'This GitHub App signs in through GitHub\'s own page, which opens from setup.')));
      return;
    }
    const install = linkButton('Install on your repository', '/setup/github/install');
    show(el('div', { class: 'forge-sheet' },
      problemMessage ? el('p', { class: 'forge-problem', role: 'alert' }, problemMessage) : null,
      el('p', { class: 'pair-hint' }, 'On GitHub choose "Only select repositories", pick the one with your notes, and click Install. GitHub then asks you to authorize Cyberbaser, and you come back here.'),
      el('div', { class: 'pair-row forge-actions' }, install, linkButton('Already installed? Sign in', '/setup/github/sign-in', 'quiet'))));
    install.focus();
  }

  function notConnected(problemMessage = null) {
    stopTimers();
    if (lastApp?.signIn === 'web') return webConnect(problemMessage);
    const connect = button('Connect GitHub', startSignIn);
    show(el('div', { class: 'forge-sheet' },
      setupMode && !problemMessage ? null : el('h3', {}, problemMessage ? 'GitHub needs attention' : 'Connect GitHub'),
      problemMessage ? el('p', { class: 'forge-problem', role: 'alert' }, problemMessage) : null,
      el('p', { class: 'pair-hint' }, 'You sign in on github.com and install the Cyberbaser app on the one repository that holds your notes. It can update files there and nothing else.'),
      el('div', { class: 'pair-row forge-actions' }, connect),
    ));
    connect.focus();
  }

  async function startSignIn(event) {
    const trigger = event?.currentTarget;
    if (trigger) trigger.disabled = true;
    try {
      const started = await call('/owner/github/start', {});
      announce({ state: 'waiting-for-code' });
      waiting(started);
    } catch (error) {
      notConnected(error.message);
    }
  }

  function waiting({ userCode, verificationUri, expiresAt }) {
    stopTimers();
    const expires = Date.parse(expiresAt);
    const copy = button('Copy code', async () => {
      try { await navigator.clipboard.writeText(userCode); copy.textContent = 'Copied'; }
      catch { copy.textContent = 'Select the code to copy'; }
    }, 'quiet');
    const timer = el('span', { class: 'pair-timer' });
    const tick = () => {
      const seconds = Math.max(0, Math.round((expires - Date.now()) / 1000));
      timer.textContent = `Code works for ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    };
    tick();
    tickTimer = setInterval(tick, 1000);
    show(el('div', { class: 'forge-sheet' },
      el('h3', {}, 'Enter this code on GitHub'),
      el('p', { class: 'pair-hint' }, 'Open the GitHub page, type the code, then choose the one repository with your notes when GitHub asks where to install Cyberbaser.'),
      el('div', { class: 'forge-code-row' },
        el('output', { class: 'forge-code', 'aria-label': `Code ${userCode.split('').join(' ')}` }, userCode),
        copy),
      el('div', { class: 'pair-row forge-actions' },
        el('a', { class: 'forge-link-button', href: verificationUri, target: '_blank', rel: 'noopener noreferrer' }, 'Open GitHub'),
        button('Cancel', async () => { stopTimers(); await call('/owner/github/cancel', {}).catch(() => {}); notConnected(); }, 'quiet')),
      el('p', { class: 'forge-waiting', role: 'status' }, el('span', { class: 'forge-pulse', 'aria-hidden': 'true' }), 'Waiting for GitHub…', ' ', timer),
    ));
    const poll = async () => {
      let state;
      try { state = await call('/owner/github/state'); } catch { pollTimer = setTimeout(poll, 3000); return; }
      if (state.state === 'waiting-for-code') { pollTimer = setTimeout(poll, 2000); return; }
      render(state);
    };
    pollTimer = setTimeout(poll, 2000);
  }

  async function picker(previous = null) {
    stopTimers();
    show(el('div', { class: 'forge-sheet' }, el('h3', {}, 'Pick the repository'), el('p', { class: 'pair-hint' }, 'Looking up the repositories Cyberbaser was installed on…')));
    let listing;
    try { listing = await call('/owner/github/repositories'); }
    catch (error) { problem({ message: error.message }); return; }
    // Usable repositories first; the rest stay findable with the reason shown.
    const rows = [...listing.repositories].sort((left, right) => Number(left.problem !== null) - Number(right.problem !== null));
    const search = el('input', {
      type: 'search', id: 'forge-search', class: 'forge-search', placeholder: 'Search by name', autocomplete: 'off', spellcheck: 'false',
      role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'forge-options', 'aria-autocomplete': 'list',
    });
    const list = el('ul', { id: 'forge-options', class: 'forge-options', role: 'listbox', 'aria-label': 'Repositories' });
    const count = el('p', { class: 'forge-count', role: 'status' });
    const confirmSlot = el('div', { class: 'forge-confirm-slot' });
    let visible = [];
    let active = -1;

    function option(row, index) {
      const [owner, name] = row.fullName.split('/');
      const meta = [row.private === true ? 'Private' : row.private === false ? 'Public' : null, relative(row.updatedAt)].filter(Boolean).join(' · ');
      const unusable = row.problem !== null;
      const node = el('li', {
        id: `forge-option-${index}`, class: `forge-option${unusable ? ' is-unusable' : ''}`, role: 'option',
        'aria-selected': 'false', 'aria-disabled': unusable ? 'true' : null,
      },
      el('span', { class: 'forge-option-name' }, el('span', { class: 'forge-owner' }, `${owner}/`), el('strong', {}, name)),
      el('span', { class: 'forge-option-meta' }, unusable ? row.problemMessage ?? 'Cannot publish here' : meta || ' '));
      node.addEventListener('mousedown', (event) => event.preventDefault());
      node.addEventListener('click', () => { setActive(index); choose(); });
      return node;
    }

    function setActive(index) {
      active = index;
      for (const [position, node] of [...list.children].entries()) {
        const on = position === index;
        node.classList.toggle('is-active', on);
        node.setAttribute('aria-selected', on ? 'true' : 'false');
        if (on) node.scrollIntoView({ block: 'nearest' });
      }
      if (index >= 0 && list.children[index]) search.setAttribute('aria-activedescendant', list.children[index].id);
      else search.removeAttribute('aria-activedescendant');
    }

    function filter() {
      const needle = search.value.trim().toLowerCase();
      visible = rows.filter((row) => row.fullName.toLowerCase().includes(needle));
      list.replaceChildren(...visible.map(option));
      if (visible.length === 0) {
        list.append(el('li', { class: 'forge-empty', role: 'presentation' }, rows.length === 0
          ? 'Cyberbaser is not installed on any repository yet. Install it on GitHub, then look again.'
          : `Nothing matches “${search.value.trim()}”.`));
      }
      count.textContent = rows.length === 0 ? '' : visible.length === rows.length
        ? `${rows.length} ${rows.length === 1 ? 'repository' : 'repositories'}` : `${visible.length} of ${rows.length}`;
      setActive(visible.findIndex((row) => row.problem === null));
      confirmSlot.replaceChildren();
    }

    function move(step) {
      if (visible.length === 0) return;
      let next = active;
      for (let i = 0; i < visible.length; i++) {
        next = (next + step + visible.length) % visible.length;
        if (visible[next].problem === null) break;
      }
      setActive(next);
    }

    function choose() {
      const row = visible[active];
      if (!row || row.problem !== null) return;
      const use = button(`Publish to ${row.fullName}`, async () => {
        use.disabled = true;
        try {
          const picked = await call('/owner/github/select', { repository: row.fullName });
          render(await call('/owner/github/state').catch(() => ({ state: picked.restartNeeded ? 'restart-needed' : 'connected', repository: picked.repository })));
        } catch (error) {
          use.disabled = false;
          confirmSlot.replaceChildren(el('p', { class: 'forge-problem', role: 'alert' }, error.message));
        }
      });
      const changes = row.fullName !== root.dataset.configured;
      if (setupMode) use.textContent = 'Use this repository';
      confirmSlot.replaceChildren(el('div', { class: 'forge-confirm' },
        el('p', {}, setupMode ? `Cyberbaser will keep a private copy of ${row.fullName} on this machine. Nothing is published.` : changes
          ? `Your site will publish to ${row.fullName}. This changes your publishing settings; Cyberbaser restarts to use it.`
          : `Your site publishes to ${row.fullName}.`),
        el('div', { class: 'pair-row forge-actions' }, use, button('Back', () => { confirmSlot.replaceChildren(); search.focus(); }, 'quiet'))));
      use.focus();
    }

    search.addEventListener('input', filter);
    search.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown') { event.preventDefault(); move(1); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); move(-1); }
      else if (event.key === 'Enter') { event.preventDefault(); choose(); }
      else if (event.key === 'Escape' && search.value) { event.preventDefault(); search.value = ''; filter(); }
    });

    show(el('div', { class: 'forge-sheet forge-picker' },
      el('h3', {}, 'Pick the repository with your notes'),
      el('p', { class: 'pair-hint' }, 'Only repositories the Cyberbaser app was installed on are listed.'),
      el('label', { class: 'visually-hidden', for: 'forge-search' }, 'Search repositories'),
      el('div', { class: 'forge-search-wrap' }, search, count),
      list,
      listing.truncated ? el('p', { class: 'pair-hint' }, 'Showing the first 1,000. Search narrows the list.') : null,
      confirmSlot,
      previous ? el('div', { class: 'pair-row' }, button('Keep the current one', () => render(previous), 'quiet')) : null,
    ));
    filter();
    search.focus();
  }

  function connected(state) {
    stopTimers();
    const disconnect = button('Disconnect', async () => {
      if (disconnect.dataset.armed !== 'yes') {
        disconnect.dataset.armed = 'yes';
        disconnect.textContent = 'Disconnect for good';
        setTimeout(() => { if (disconnect.isConnected) { disconnect.dataset.armed = ''; disconnect.textContent = 'Disconnect'; } }, 5000);
        return;
      }
      disconnect.disabled = true;
      try { await call('/owner/github/disconnect', {}); notConnected(); }
      catch (error) { disconnect.disabled = false; disconnect.textContent = 'Disconnect failed, retry'; }
    }, 'quiet-danger');
    const restart = state.state === 'restart-needed';
    const renew = state.renewsAutomatically
      ? `Access renews by itself. You sign in again by ${new Date(state.signInRenewBy).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })}.`
      : 'Uses a token you pasted into the publisher. Replace it before it expires.';
    show(el('div', { class: `forge-status${restart ? ' is-pending' : ''}` },
      el('div', { class: 'forge-status-main' },
        el('span', { class: 'forge-state-dot', 'aria-hidden': 'true' }),
        el('div', { class: 'device-name' },
          el('strong', {}, setupMode ? state.repository : restart ? `Picked ${state.repository}` : `Publishing to ${state.repository}`),
          el('span', {}, restart ? state.message : renew))),
      el('div', { class: 'pair-row forge-status-actions' },
        root.dataset.provider === 'github-app' ? button('Change repository', () => picker(state), 'quiet') : null,
        setupMode ? null : disconnect),
    ));
  }

  function problem(state) {
    stopTimers();
    // Access that is gone can only be restored by signing in again; anything
    // else may clear up, so checking again comes first.
    const gone = ['revoked', 'sign-in-expired'].includes(state.problem) && root.dataset.provider === 'github-app';
    const retry = button('Check again', async () => { retry.disabled = true; render(await call('/owner/github/check').catch((error) => ({ state: 'problem', message: error.message }))); }, gone ? 'quiet' : '');
    const reconnect = lastApp?.signIn === 'web' && setupMode ? linkButton('Connect again', '/setup/github/sign-in', gone ? '' : 'quiet')
      : button('Connect again', startSignIn, gone ? '' : 'quiet');
    const title = gone ? 'GitHub access was removed' : state.repository ? `Cannot publish to ${state.repository}` : 'GitHub needs attention';
    show(el('div', { class: 'forge-sheet is-problem' },
      el('h3', {}, title),
      el('p', { class: 'forge-problem', role: 'alert' }, state.message ?? 'Something is wrong with GitHub access.'),
      el('p', { class: 'pair-hint' }, 'Nothing can be published until this is fixed.'),
      el('div', { class: 'pair-row forge-actions' }, ...(gone ? [reconnect, retry]
        : [retry, root.dataset.provider === 'github-app' ? reconnect : null])),
    ));
  }

  function render(state) {
    if (state.app) lastApp = state.app;
    announce(state);
    if (state.state === 'no-app') return noApp();
    if (state.state === 'waiting-for-code') return waiting(state);
    if (state.state === 'pick-repository') return picker();
    if (state.state === 'connected' || state.state === 'restart-needed') return connected(state);
    if (state.state === 'problem') {
      if (['denied', 'code-expired'].includes(state.problem)) return notConnected(state.message);
      return problem(state);
    }
    return notConnected();
  }

  // Opening the page checks with GitHub, so a removed app or token shows at once.
  call('/owner/github/check').then(render, (error) => problem({ message: error.message }));
})();

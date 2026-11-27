// The setup listener goes away before the owner listener starts. Keep the
// ready page's own CSS and poller in the document, with exact CSP hashes.
import { createHash } from 'node:crypto';

export const READY_STYLE = `
:root { color-scheme: light dark; --ink: #18202a; --paper: #fbfcfd; --muted: #566170; --line: #d5dbe2; --accent: #1f5bd7; --on-accent: #fff; }
@media (prefers-color-scheme: dark) {
  :root { --ink: #e2e7ef; --paper: #151b22; --muted: #aeb9c8; --line: #4a5563; --accent: #8fb0ff; --on-accent: #10161d; }
}
body { margin: 0; font: 1rem/1.55 system-ui, sans-serif; color: var(--ink); background: var(--paper); }
.setup-shell { width: min(34rem, calc(100% - 2rem)); margin: 0 auto; padding: 1.25rem 0 4rem; }
.setup-top { display: flex; justify-content: space-between; align-items: center; min-height: 2.75rem; margin-bottom: 2rem; }
.setup-mark, .setup-aside, .setup-summary dt { color: var(--muted); }
.setup-mark, .setup-summary { font-weight: 600; }
.setup-progress { display: flex; gap: 0.3rem; margin: 0; padding: 0; list-style: none; }
.setup-progress li { width: 1.1rem; height: 0.25rem; border-radius: 1rem; background: var(--muted); }
.setup-progress li.is-current { width: 1.8rem; background: var(--accent); }
.visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.setup-step { display: grid; gap: 1.25rem; }
.setup-step > * { margin: 0; min-width: 0; }
.setup-step h1 { font-size: clamp(1.75rem, 5.5vw, 2.25rem); line-height: 1.12; }
.setup-summary { border-top: 1px solid var(--line); }
.setup-summary > div { display: grid; grid-template-columns: minmax(6rem, 0.35fr) minmax(0, 1fr); gap: 1rem; padding: 0.75rem 0; border-bottom: 1px solid var(--line); }
.setup-summary dd { margin: 0; overflow-wrap: anywhere; }
.setup-actions { display: flex; flex-wrap: wrap; gap: 0.6rem; }
[hidden] { display: none !important; }
.setup-link-button { padding: 0.7rem 1.25rem; border: 1px solid var(--accent); border-radius: 0.45rem; background: var(--accent); color: var(--on-accent); font-weight: 650; text-decoration: none; }
.setup-link-button.quiet { border-color: var(--line); background: transparent; color: var(--accent); }
.setup-link-button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
`;

function pollReady() {
  const status = document.getElementById('setup-starting');
  const actions = document.getElementById('setup-ready-actions');
  const started = Date.now();
  const probe = (url) => fetch(url, { method: 'HEAD', mode: 'same-origin', credentials: 'same-origin',
    cache: 'no-store', redirect: 'manual', signal: AbortSignal.timeout(5000) });
  async function check() {
    try {
      // Setup never redirects `/`; only the signed-in owner server does. Do
      // not follow the redirect, which can point to the separate reader port.
      const home = await probe('/');
      if (home.type === 'opaqueredirect' || home.status === 302) {
        status.textContent = 'Cyberbaser is ready to open.';
        actions.hidden = false;
        return;
      }
      // The normal server also answers if it had to restart without the
      // setup session. In that case the owner needs its new sign-in link.
      if (home.status === 403 && (await probe('/owner/sign-in')).ok) {
        status.textContent = 'Cyberbaser is running. Ask for a fresh sign-in link to open it.';
        return;
      }
    } catch { /* No listener during handover. */ }
    if (Date.now() - started >= 30_000) status.textContent = 'Still starting. This can take a minute the first time.';
    setTimeout(check, 1500);
  }
  void check();
}

export const READY_SCRIPT = `(${pollReady.toString()})();`;
const hash = (value) => `'sha256-${createHash('sha256').update(value).digest('base64')}'`;
export const readyCsp = (csp) => csp.replace("style-src 'self'", `style-src ${hash(READY_STYLE)}`)
  .replace("script-src 'self'", `script-src ${hash(READY_SCRIPT)}`);

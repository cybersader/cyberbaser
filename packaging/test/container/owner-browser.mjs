// The owner's browser in the container setup test, as plain HTTP: the same
// requests the setup, devices and review pages make. Run with the program's runtime:
//   BUN_BE_BUN=1 /test/cyberbaser owner-browser.mjs <command> [arguments...] <cookie-file>
//   setup-to-phone <setup-link>     GitHub, the repository, notes, the starter publish.yml, website skipped
//   setup-private <setup-link> <owner/name>   GitHub, that repository (publish.yml kept), Keep it private
//   step <action>                   one setup action on the step on screen
//   phone-page                      what the phone step shows
//   pair-start <page> <kind> <access> <label>   start pairing from /setup or /owner/devices
//   pair-confirm <page> <enrollmentId>          compare the words and confirm
//   devices                         paired devices and open pairings
//   landed | sign-in <link> | approve <queue-id> | job <job-id> | post <path> | page <path>
// Prints one JSON line. Synthetic data only.
import { readFileSync, writeFileSync } from 'node:fs';

const PORT = Number(process.env.ONE_APP_TEST_PORT ?? 4317);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const READER = `http://127.0.0.1:${PORT + 1}`;
const ENROLL = `http://127.0.0.1:${PORT + 2}`;
const args = process.argv.slice(2);
const command = args[0];
const rest = args.slice(1, -1);
const cookieFile = args.at(-1);
let cookie = null;
try { cookie = readFileSync(cookieFile, 'utf8').trim() || null; } catch { cookie = null; }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function call(route, body, { redirect = 'manual', withCookie = true } = {}) {
  const form = body instanceof URLSearchParams;
  const response = await fetch(`${ORIGIN}${route}`, {
    method: body === undefined ? 'GET' : 'POST', redirect, signal: AbortSignal.timeout(180_000),
    headers: { ...(cookie && withCookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { Origin: ORIGIN }),
      ...(body === undefined || form ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: form ? body : JSON.stringify(body) }),
  });
  const set = response.headers.get('set-cookie');
  if (set) { cookie = set.split(';', 1)[0]; writeFileSync(cookieFile, cookie, { mode: 0o600 }); }
  const text = await response.text();
  let value = null;
  try { value = JSON.parse(text); } catch { value = null; }
  return { status: response.status, text, value, location: response.headers.get('location'), headers: response.headers };
}

function done(value) { process.stdout.write(`${JSON.stringify(value)}\n`); process.exit(0); }
function failed(stage, detail) { process.stdout.write(`${JSON.stringify({ ok: false, stage, detail: String(detail).slice(0, 400) })}\n`); process.exit(1); }

async function csrfFrom(route) {
  const page = await call(route);
  const csrf = /data-csrf="([^"]+)"/u.exec(page.text)?.[1];
  if (!csrf) failed('csrf', `${route} ${page.status}`);
  return csrf;
}

async function stepper() {
  const csrf = await csrfFrom('/setup');
  const step = async (action, value = null) => {
    const current = /data-step="([^"]+)"/u.exec((await call('/setup')).text)?.[1];
    return call('/setup/step', { csrf, step: current, action, value });
  };
  return { step, csrf };
}

async function openSetup(link) {
  try {
    const url = new URL(link);
    if (url.origin !== ORIGIN || url.pathname !== '/setup/start') failed('setup-link', 'unexpected target');
    const page = await call(url.pathname + url.search, undefined, { withCookie: false });
    const action = /<form id="setup-start" method="post" action="([^"]+)"/u.exec(page.text)?.[1];
    const token = /name="token" value="([A-Za-z0-9_-]{43})"/u.exec(page.text)?.[1];
    if (page.status !== 200 || action !== '/setup/start' || !token || !page.text.includes('>Start setup</button>')) {
      failed('setup-link', page.status);
    }
    const opened = await call(action, new URLSearchParams({ token }), { withCookie: false });
    if (opened.status !== 303 || opened.location !== '/setup') failed('start-setup', opened.status);
  } catch { failed('setup-link', 'could not open setup'); }
}

// Setup up to the phone step: GitHub, the private repository, the notes copy,
// and the starter publish.yml chosen on screen. The starter is prepared as one
// commit and waits for the owner's phone; nothing reaches GitHub here.
async function setupToPhone(link) {
  await openSetup(link);
  const { step, csrf } = await stepper();
  if ((await step('start')).value?.step !== 'github') failed('start', 'not on github');
  const started = await call('/owner/github/start', { csrf });
  if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/u.test(started.value?.userCode ?? '')) failed('sign-in', started.text);
  let state;
  for (let i = 0; i < 90; i++) {
    state = (await call('/owner/github/state')).value;
    if (state?.state !== 'waiting-for-code') break;
    await sleep(1000);
  }
  if (state?.state !== 'pick-repository') failed('sign-in', JSON.stringify(state));
  const listing = (await call('/owner/github/repositories')).value;
  const row = listing?.repositories?.find((entry) => entry.fullName === 'cybersader/cyberbase');
  if (!row || row.problem !== null || row.private !== true) failed('picker', JSON.stringify(listing));
  const picked = await call('/owner/github/select', { csrf, repository: 'cybersader/cyberbase' });
  if (picked.value?.ok !== true) failed('pick', picked.text);
  if ((await step('continue')).value?.step !== 'notes') failed('continue-notes', 'refused');
  let notes;
  for (let i = 0; i < 120; i++) {
    notes = (await call('/setup/state')).value?.notes;
    if (['ready', 'failed'].includes(notes?.phase)) break;
    await sleep(1000);
  }
  if (notes?.phase !== 'ready') failed('notes', JSON.stringify(notes));
  let page = await call('/setup');
  const multiSelect = page.text.includes('<input type="checkbox" name="folder" value="Garden">') && !page.text.includes(' checked')
    && page.text.includes('<summary>Show the file</summary>');
  const starter = await step('starter', ['Garden']);
  if (starter.value?.ok !== true) failed('starter', starter.text);
  page = await call('/setup');
  const starterWaiting = page.text.includes('It goes to GitHub when you approve it on your phone');
  if ((await step('continue')).value?.step !== 'website') failed('continue-website', 'refused');
  if ((await step('skip')).value?.step !== 'phone') failed('website', 'refused');
  done({ ok: true, count: notes.count, multiSelect, starterWaiting });
}

// GitHub's own pages (the stand-in GitHub): post the page's one form, as the
// owner clicking its button, and return where GitHub sends the browser.
async function clickOnGithub(response) {
  const text = await response.text();
  const action = /<form method="post" action="([^"]+)"/u.exec(text)?.[1];
  const page = /name="page" value="([^"]+)"/u.exec(text)?.[1];
  if (!action || !page) failed('github-page', `${response.status} ${text.slice(0, 200)}`);
  const clicked = await fetch(new URL(action, response.url), { method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ page }).toString() });
  if (clicked.status !== 302) failed('github-click', clicked.status);
  return new URL(clicked.headers.get('location'));
}
const unescape = (text) => text.replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');

// No GitHub App yet: Create on GitHub, Install on GitHub, Authorize on GitHub.
// GitHub's returns arrive without the owner's cookie (SameSite=Strict), as a
// real browser sends them.
async function manifestFlow() {
  const page = await call('/setup/github/create');
  if (page.status !== 200) failed('create-page', page.status);
  const action = unescape(/<form id="github-create" method="post" action="([^"]+)"/u.exec(page.text)?.[1] ?? '');
  const manifest = unescape(/name="manifest" value="([^"]+)"/u.exec(page.text)?.[1] ?? '');
  const formAllowed = (page.headers.get('content-security-policy') ?? '').includes(`form-action 'self' ${new URL(action).origin}`);
  const githubNew = await fetch(action, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ manifest }).toString() });
  const created = await clickOnGithub(githubNew);
  if (created.origin !== ORIGIN) failed('created-return', created.origin);
  const back = await call(created.pathname + created.search, undefined, { withCookie: false });
  if (back.status !== 200 || back.headers.get('refresh') !== '0; url=/setup') failed('created', `${back.status} ${back.text.slice(0, 200)}`);
  const replay = await call(created.pathname + created.search, undefined, { withCookie: false });
  const install = await call('/setup/github/install');
  if (install.status !== 303) failed('install', install.status);
  const installed = await clickOnGithub(await fetch(install.location, { redirect: 'manual' }));
  const toAuthorize = await call(installed.pathname + installed.search, undefined, { withCookie: false });
  if (toAuthorize.status !== 303) failed('installed', `${toAuthorize.status} ${toAuthorize.text.slice(0, 200)}`);
  const authorized = await clickOnGithub(await fetch(toAuthorize.location, { redirect: 'manual' }));
  const connected = await call(authorized.pathname + authorized.search, undefined, { withCookie: false });
  if (connected.status !== 200) failed('authorized', `${connected.status} ${connected.text.slice(0, 200)}`);
  return { formAllowed, replayRefused: replay.status === 409, githubClicks: 3 };
}

// Setup for a private-only site (install --site private) on a repository that
// already has its publish.yml: GitHub, the repository, the notes copy, then
// "Keep it private" on the website step.
async function setupPrivate(link, repository) {
  await openSetup(link);
  const { step, csrf } = await stepper();
  if ((await step('start')).value?.step !== 'github') failed('start', 'not on github');
  let state = (await call('/owner/github/state')).value;
  let manifest = null;
  if (state?.state === 'no-app') {
    manifest = await manifestFlow();
    state = (await call('/owner/github/state')).value;
    // The app is on exactly one repository, so setup picked it.
    if (state?.state !== 'connected' || state.repository !== repository) failed('manifest-connected', JSON.stringify(state));
  } else {
    const started = await call('/owner/github/start', { csrf });
    if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/u.test(started.value?.userCode ?? '')) failed('sign-in', started.text);
    for (let i = 0; i < 90; i++) {
      state = (await call('/owner/github/state')).value;
      if (state?.state !== 'waiting-for-code') break;
      await sleep(1000);
    }
    if (state?.state !== 'pick-repository') failed('sign-in', JSON.stringify(state));
    const listing = (await call('/owner/github/repositories')).value;
    const row = listing?.repositories?.find((entry) => entry.fullName === repository);
    if (!row || row.problem !== null || row.private !== true) failed('picker', JSON.stringify(listing));
    const picked = await call('/owner/github/select', { csrf, repository });
    if (picked.value?.ok !== true) failed('pick', picked.text);
  }
  if ((await step('continue')).value?.step !== 'notes') failed('continue-notes', 'refused');
  let notes;
  for (let i = 0; i < 300; i++) {
    notes = (await call('/setup/state')).value?.notes;
    if (['ready', 'failed'].includes(notes?.phase)) break;
    await sleep(1000);
  }
  if (notes?.phase !== 'ready') failed('notes', JSON.stringify(notes));
  const notesPage = (await call('/setup')).text;
  const publishYmlKept = notesPage.includes('decides what goes on your website');
  if ((await step('continue')).value?.step !== 'website') failed('continue-website', 'refused');
  const website = (await call('/setup')).text;
  const privateOffered = website.includes('Keep it private') && website.includes(`${READER}/`);
  if ((await step('private')).value?.step !== 'phone') failed('website', 'refused');
  done({ ok: true, count: notes.count, publishYmlKept, privateOffered, manifest });
}

async function setupStep(action) {
  const { step } = await stepper();
  const result = await step(action);
  done({ ok: result.value?.ok === true, step: result.value?.step ?? null, code: result.value?.code ?? null });
}

async function setupPhonePage() {
  const page = await call('/setup');
  done({ ok: page.status === 200, access: /name="access" value="([a-z]+)" checked/u.exec(page.text)?.[1] ?? null, enrolFrame: page.text.includes(`src="${ENROLL}/enroll"`),
    frameAllowed: (page.headers.get('content-security-policy') ?? '').includes(`frame-src ${ENROLL}`),
    paired: page.text.includes('is paired'), starterNote: page.text.includes('Approvals waiting') });
}

// Pairing as the Devices section does it: start, then compare words and confirm.
async function pairStart(route, kind, access, label) {
  const csrf = await csrfFrom(route);
  const started = await call('/owner/devices/pair', { csrf, kind, access, label });
  if (started.value?.ok !== true) failed('pair-start', started.text);
  done({ ok: true, code: started.value.code, enrollmentId: started.value.enrollmentId });
}

async function pairConfirm(route, enrollmentId) {
  const csrf = await csrfFrom(route);
  let pairing = null;
  for (let i = 0; i < 120; i++) {
    pairing = (await call('/owner/devices/state')).value?.pairings?.find((item) => item.enrollmentId === enrollmentId);
    if (pairing?.state === 'awaiting' && pairing.words) break;
    await sleep(500);
  }
  if (!pairing?.words) failed('pair-words', JSON.stringify(pairing));
  const confirmed = await call('/owner/devices/confirm', { csrf, enrollmentId, words: pairing.words });
  if (confirmed.value?.ok !== true) failed('pair-confirm', confirmed.text);
  done({ ok: true, words: pairing.words });
}

async function devicesState() {
  const state = (await call('/owner/devices/state')).value;
  done({ ok: state !== null, devices: (state?.devices ?? []).filter((device) => !device.revoked).map((device) => device.kind),
    pairings: (state?.pairings ?? []).length });
}

async function landed() {
  // The node takes over the same address in the same process; the cookie from setup is the owner's session.
  let review = null;
  for (let i = 0; i < 180; i++) {
    try { review = await call('/owner/review'); } catch (error) { review = { status: 0, text: String(error?.message) }; }
    if (review?.status === 200 && review.text.includes('Proposals')) return done({ ok: true, waited: i });
    await sleep(1000);
  }
  failed('landed', `the node never answered the owner: ${review?.status} ${review?.text?.slice(0, 120)}`);
}

async function approve(queueId) {
  const page = await call(`/owner/review/${queueId}`);
  const csrf = /data-csrf="([^"]+)"/u.exec(page.text)?.[1];
  const evidence = /data-review-evidence-digest="([^"]+)"/u.exec(page.text)?.[1];
  if (!csrf || !evidence) failed('review-page', page.status);
  const decision = await call(`/api/review/${queueId}/decision`, { queueId, reviewEvidenceDigest: evidence, action: 'approve',
    reason: 'Synthetic container test approval.', csrf });
  if (decision.status !== 201) failed('approve', decision.text);
  const applied = await call(`/api/review/${queueId}/apply`, { queueId, csrf });
  if (applied.status !== 202) failed('apply', applied.text);
  const jobId = applied.value.jobId;
  let job;
  for (let i = 0; i < 240; i++) {
    job = (await call(`/api/jobs/${jobId}`)).value;
    // Until the job is past its push (later states wait on the forge's deployment, which this test has none of).
    if (job && !['accepted', 'preflighting', 'checking', 'rendering', 'ready-to-apply', 'applying', 'source-applied', 'committing',
      'committed', 'pushing'].includes(job.state)) break;
    await sleep(1000);
  }
  done({ ok: true, jobId, state: job?.state ?? null, failure: job?.failure?.code ?? null });
}

async function job(jobId) {
  const value = (await call(`/api/jobs/${jobId}`)).value;
  done({ ok: value !== null, state: value?.state ?? null, failure: value?.failure?.code ?? null });
}

// A signed-in owner act (any POST), to see whether it is held back.
async function post(route) {
  const csrf = await csrfFrom('/owner/devices');
  const result = await call(route, { csrf });
  done({ ok: result.status < 400, status: result.status, code: result.value?.error?.code ?? null, message: result.value?.error?.message ?? null });
}

try {
  if (command === 'setup-to-phone') await setupToPhone(rest[0]);
  else if (command === 'setup-private') await setupPrivate(rest[0], rest[1]);
  else if (command === 'step') await setupStep(rest[0]);
  else if (command === 'phone-page') await setupPhonePage();
  else if (command === 'pair-start') await pairStart(...rest);
  else if (command === 'pair-confirm') await pairConfirm(...rest);
  else if (command === 'devices') await devicesState();
  else if (command === 'landed') await landed();
  else if (command === 'sign-in') {
    const signed = await call(rest[0].slice(ORIGIN.length));
    done({ ok: signed.status === 303, status: signed.status });
  } else if (command === 'approve') await approve(rest[0]);
  else if (command === 'job') await job(rest[0]);
  else if (command === 'post') await post(rest[0]);
  else if (command === 'page') {
    const page = await call(rest[0]);
    done({ ok: page.status === 200, status: page.status, unreachable: page.text.includes("Can't reach GitHub") });
  } else failed('usage', command);
} catch (error) {
  failed(command, error?.message ?? error);
}

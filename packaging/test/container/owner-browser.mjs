// The owner's browser in the container setup test, as plain HTTP: the same
// requests the setup and review pages make. Run with the program's runtime:
//   BUN_BE_BUN=1 /test/cyberbaser owner-browser.mjs setup <setup-link> <cookie-file>
//   BUN_BE_BUN=1 /test/cyberbaser owner-browser.mjs landed <cookie-file>
//   BUN_BE_BUN=1 /test/cyberbaser owner-browser.mjs sign-in <bootstrap-link> <cookie-file>
//   BUN_BE_BUN=1 /test/cyberbaser owner-browser.mjs approve <queue-id> <cookie-file>
//   BUN_BE_BUN=1 /test/cyberbaser owner-browser.mjs page <path> <cookie-file>
// Prints one JSON line. Synthetic data only.
import { readFileSync, writeFileSync } from 'node:fs';

const ORIGIN = 'http://127.0.0.1:4317';
const args = process.argv.slice(2);
const command = args[0];
const argument = args.length === 3 ? args[1] : null;
const cookieFile = args.at(-1);
let cookie = null;
try { cookie = readFileSync(cookieFile, 'utf8').trim() || null; } catch { cookie = null; }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function call(route, body, { redirect = 'manual' } = {}) {
  const response = await fetch(`${ORIGIN}${route}`, {
    method: body === undefined ? 'GET' : 'POST', redirect, signal: AbortSignal.timeout(180_000),
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { Origin: ORIGIN, 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const set = response.headers.get('set-cookie');
  if (set) { cookie = set.split(';', 1)[0]; writeFileSync(cookieFile, cookie, { mode: 0o600 }); }
  const text = await response.text();
  let value = null;
  try { value = JSON.parse(text); } catch { value = null; }
  return { status: response.status, text, value, location: response.headers.get('location') };
}

function done(value) { process.stdout.write(`${JSON.stringify(value)}\n`); process.exit(0); }
function failed(stage, detail) { process.stdout.write(`${JSON.stringify({ ok: false, stage, detail: String(detail).slice(0, 400) })}\n`); process.exit(1); }

async function setup(link) {
  const opened = await call(link.slice(ORIGIN.length));
  if (opened.status !== 303) failed('open-link', opened.status);
  let page = await call('/setup');
  const csrf = /data-csrf="([^"]+)"/u.exec(page.text)?.[1];
  const step = async (action, value = null) => {
    const current = /data-step="([^"]+)"/u.exec((await call('/setup')).text)?.[1];
    return call('/setup/step', { csrf, step: current, action, value });
  };
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
  page = await call('/setup');
  const multiSelect = page.text.includes('<input type="checkbox" name="folder" value="Garden">') && !page.text.includes(' checked')
    && page.text.includes('<summary>Show the file</summary>');
  const starter = await step('starter', ['Garden']);
  if (starter.value?.ok !== true) failed('starter', starter.text);
  const afterStarter = (await call('/setup')).text.includes('You added it just now.');
  if ((await step('continue')).value?.step !== 'website') failed('continue-website', 'refused');
  if ((await step('skip')).value?.step !== 'phone') failed('website', 'refused');
  if ((await step('skip')).value?.step !== 'agent') failed('phone', 'refused');
  const finished = await step('skip');
  if (finished.value?.step !== 'done') failed('done', finished.text);
  done({ ok: true, count: notes.count, multiSelect, afterStarter });
}

async function landed() {
  // The node takes over the same address in the same process; the cookie from setup is the owner's session.
  let review = null;
  for (let i = 0; i < 180; i++) {
    try { review = await call('/owner/review'); } catch (error) { review = { status: 0, text: String(error?.message) }; }
    if (review?.status === 200 && review.text.includes('Proposals')) return done({ ok: true, waited: i });
    await sleep(1000);
  }
  const { createHash } = await import('node:crypto');
  const mark = createHash('sha256').update(String(cookie).split('=')[1] ?? '').digest('hex').slice(0, 8);
  failed('landed', `the node never answered the owner: ${review?.status} ${review?.text?.slice(0, 120)} cookie ${mark}`);
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

try {
  if (command === 'setup') await setup(argument);
  else if (command === 'landed') await landed();
  else if (command === 'sign-in') {
    const signed = await call(argument.slice(ORIGIN.length));
    done({ ok: signed.status === 303, status: signed.status });
  } else if (command === 'approve') await approve(argument);
  else if (command === 'page') {
    const page = await call(argument);
    done({ ok: page.status === 200, status: page.status, unreachable: page.text.includes("Can't reach GitHub") });
  } else failed('usage', command);
} catch (error) {
  failed(command, error?.message ?? error);
}

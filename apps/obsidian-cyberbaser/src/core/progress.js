// What happens after "Publish to your site", in plain words. Pure, no Obsidian:
// main.js draws the checklist, the status bar item, the note mark and the
// notices from what this returns.
//
// One item per post on its way: { id, path, title, bundleId, step, reason,
// lastStep, pages, at, liveSince, sentText, originalText }.
// step: queued (no connection, sent when back), checking (being sent),
// waiting (for the owner's approval), review (a propose-only device: the owner
// looks at it on the node), publishing (approved, the site is updating), live,
// failed, withdrawn, declined.
//
// The tracker reads progress from the node and sends queued posts again. It is
// never given anything that signs: approving stays a tap in the approval sheet.

export const IN_FLIGHT = Object.freeze(['queued', 'checking', 'waiting', 'review', 'publishing']);
export const LIVE_SHOWN_MS = 5000;
const ORDER = ['checking', 'waiting', 'publishing', 'live'];

/** The checklist for one item: [{ key, label, detail, state: done | current | todo | failed | queued }]. */
export function viewSteps(item, { canSign = false, site = null } = {}) {
  const waitingDetail = item.step === 'review' ? 'Your site owner looks at it first'
    : canSign ? 'Approve it on this device' : 'Open Cyberbaser on your phone to approve';
  const steps = [
    { key: 'checking', label: 'Checking your post', detail: item.step === 'queued' ? "Will send when you're back online" : null },
    { key: 'waiting', label: 'Waiting for your approval', detail: waitingDetail },
    { key: 'publishing', label: 'Publishing', detail: 'Usually under a minute' },
    { key: 'live', label: `Live on ${site ?? 'your site'}`, detail: null },
  ];
  const current = item.step === 'review' ? 'waiting' : item.step;
  if (current === 'queued') return steps.map((step, i) => ({ ...step, state: i === 0 ? 'queued' : 'todo' }));
  if (current === 'failed' || current === 'declined') {
    const at = ORDER.indexOf(item.lastStep === 'review' ? 'waiting' : item.lastStep ?? 'checking');
    const failedAt = at < 0 ? 0 : Math.min(at, 2);
    return steps.map((step, i) => ({ ...step, detail: null,
      state: i < failedAt ? 'done' : i === failedAt ? 'failed' : 'todo' }));
  }
  if (current === 'withdrawn') return steps.map((step) => ({ ...step, detail: null, state: 'todo' }));
  const index = ORDER.indexOf(current);
  return steps.map((step, i) => ({ ...step, detail: i === index && current !== 'live' ? step.detail : null,
    state: current === 'live' ? 'done' : i < index ? 'done' : i === index ? 'current' : 'todo' }));
}

const ERRORS = Object.freeze({
  unreachable: ["Couldn't reach your site. Your post is safe.", 'retry'],
  'address-mismatch': ['Your site would put this page at a different address than shown. Your post is safe.', 'retry'],
  'capture-base-moved': ['Your site changed while this was on its way. Your post is safe.', 'retry'],
  'owner-approval-mismatch': ['What reached your site was not what you approved, so nothing was published. Your post is safe.', 'retry'],
  'deployment-failed': ["Your site didn't finish updating. Your post is safe.", 'check'],
  'live-verification-failed': ["Your site updated, but the page isn't showing yet. Your post is safe.", 'check'],
  declined: ['Not approved this time. Your post is safe.', 'retry'],
  unchanged: ['Your site already has this post.', 'check'],
});

/** { text, action: retry | check, detail } for a failed item: one plain sentence, one next step. */
export function failureWords(reason) {
  const key = typeof reason === 'string' ? reason : 'unknown';
  const found = ERRORS[key] ?? (key.startsWith('live-') ? ERRORS['live-verification-failed'] : null);
  const [text, action] = found ?? ['Something stopped this publish. Your post is safe.', 'retry'];
  return { text, action, detail: key };
}

/**
 * The desktop status bar item, or null when there is nothing to say (idle).
 * { key, text, icon, spin }.
 */
export function statusBarState(items, now = Date.now()) {
  const list = [...items].filter((item) => !item.dismissed);
  if (list.some((item) => item.step === 'failed' || item.step === 'declined')) return { key: 'attention', text: 'Needs attention', icon: 'alert-circle', spin: false };
  const flying = list.filter((item) => IN_FLIGHT.includes(item.step));
  if (flying.length > 1) return { key: 'several', text: `${flying.length} publishing`, icon: null, spin: true };
  if (flying.length === 1) {
    const [item] = flying;
    if (item.step === 'waiting' || item.step === 'review') return { key: 'waiting', text: 'Waiting for approval', icon: 'clock', spin: false };
    if (item.step === 'queued') return { key: 'queued', text: 'Waiting to send', icon: 'wifi-off', spin: false };
    return { key: 'publishing', text: 'Publishing…', icon: null, spin: true };
  }
  if (list.some((item) => item.step === 'live' && typeof item.liveSince === 'number' && now - item.liveSince < LIVE_SHOWN_MS)) {
    return { key: 'live', text: 'Live ✓', icon: null, spin: false };
  }
  return null;
}

/** The quiet mark for one note, or null: queued, waiting, publishing, attention. Nothing once it is live. */
export function markFor(items, path) {
  const item = [...items].reverse().find((candidate) => candidate.path === path && !candidate.dismissed);
  if (!item) return null;
  if (item.step === 'failed' || item.step === 'declined') return 'attention';
  if (item.step === 'review') return 'waiting';
  if (item.step === 'checking') return 'publishing';
  return ['queued', 'waiting', 'publishing'].includes(item.step) ? item.step : null;
}

/**
 * The items on their way, kept in step with the node.
 *   readProgress(bundleId) -> { step, reason, at, pages }   (controller.bundleProgress)
 *   withdraw(bundleId)                                       (controller.withdraw)
 *   send(item) -> { bundleId, step?, pages?, sentText?, originalText? } | throws
 *       re-runs the whole publish for the item's note (same checks, same
 *       approval); main.js supplies it.
 *   isUnreachable(error) -> boolean
 *   save(queue) / load() -> [{ path, title, queuedAt }]      device-only storage
 *   onEvent({ type: needs-approval | live | failed | queued | changed, item })
 */
export function createPublishTracker({ readProgress, withdraw, send, isUnreachable = () => false, describeError = () => null,
  save = () => {}, load = () => [], onEvent = () => {}, now = Date.now }) {
  const items = new Map();
  let counter = 0;
  // A display problem never stops a post on its way.
  const tell = (event) => { try { onEvent(event); } catch { /* shown on the next change */ } };
  const emit = (type, item) => { tell({ type, item }); if (type !== 'changed') tell({ type: 'changed', item }); };
  const persist = () => save([...items.values()].filter((item) => item.step === 'queued')
    .map(({ path, title, queuedAt }) => ({ path, title, queuedAt })));
  const set = (item, patch) => {
    const before = item.step;
    Object.assign(item, patch);
    if (IN_FLIGHT.includes(item.step) && item.step !== 'queued') item.lastStep = item.step;
    if (before !== item.step) {
      if (item.step === 'waiting' || item.step === 'review') emit('needs-approval', item);
      else if (item.step === 'live') { item.liveSince = now(); emit('live', item); }
      else if (item.step === 'failed' || item.step === 'declined') emit('failed', item);
      else if (item.step === 'queued') emit('queued', item);
      else emit('changed', item);
    }
    persist();
  };
  for (const saved of load() ?? []) {
    if (typeof saved?.path !== 'string') continue;
    counter += 1;
    items.set(`q${counter}`, { id: `q${counter}`, path: saved.path, title: saved.title ?? saved.path, bundleId: null,
      step: 'queued', reason: null, lastStep: null, pages: [], queuedAt: saved.queuedAt ?? now() });
  }

  async function sendItem(item) {
    set(item, { step: 'checking', reason: null, message: null });
    try {
      const sent = await send(item);
      if (!sent || typeof sent.bundleId !== 'string') { set(item, { step: 'failed', reason: sent?.reason ?? 'unknown', lastStep: 'checking' }); return item; }
      set(item, { bundleId: sent.bundleId, step: sent.step ?? 'waiting', pages: sent.pages ?? item.pages,
        sentText: sent.sentText ?? item.sentText, originalText: sent.originalText ?? item.originalText });
    } catch (error) {
      if (isUnreachable(error)) set(item, { step: 'queued', queuedAt: item.queuedAt ?? now() });
      else set(item, { step: 'failed', reason: error?.reason ?? error?.kind ?? 'unknown', message: describeError(error), lastStep: 'checking' });
    }
    return item;
  }

  return Object.freeze({
    items: () => [...items.values()],
    get: (id) => items.get(id) ?? null,
    inFlight: () => [...items.values()].some((item) => IN_FLIGHT.includes(item.step)),

    /**
     * A post the author just published: sent now (or queued when there is no
     * connection). Returns { item, done } at once, so the view can follow it.
     */
    publish({ path, title }) {
      for (const [id, item] of items) if (item.path === path && !IN_FLIGHT.includes(item.step)) items.delete(id);
      counter += 1;
      const item = { id: `p${counter}`, path, title, bundleId: null, step: 'checking', reason: null, lastStep: 'checking', pages: [] };
      items.set(item.id, item);
      return { item, done: sendItem(item) };
    },

    /** Try again after a failure: the whole publish again, same checks, same approval. */
    async retry(id) {
      const item = items.get(id);
      if (!item) return null;
      return sendItem(item);
    },

    /** One polite round: queued posts are sent again, the rest read from the node. */
    async poll() {
      for (const item of [...items.values()]) {
        if (item.step === 'queued') { await sendItem(item); continue; }
        if (!['waiting', 'review', 'publishing'].includes(item.step) || item.bundleId === null) continue;
        let progress;
        try { progress = await readProgress(item.bundleId); } catch { continue; }
        if (!progress || typeof progress.step !== 'string') continue;
        set(item, { step: progress.step, reason: progress.reason ?? null, at: progress.at ?? null,
          pages: Array.isArray(progress.pages) ? progress.pages : item.pages });
      }
    },

    /** Take a post back before it is approved. Queued posts are simply dropped. */
    async withdraw(id) {
      const item = items.get(id);
      if (!item || !['queued', 'waiting', 'review'].includes(item.step)) return null;
      if (item.bundleId !== null && item.step !== 'queued') await withdraw(item.bundleId);
      set(item, { step: 'withdrawn' });
      return item;
    },

    dismiss(id) {
      const item = items.get(id);
      if (item) { items.delete(id); emit('changed', item); persist(); }
    },
  });
}

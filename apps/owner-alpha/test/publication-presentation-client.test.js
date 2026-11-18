import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../public/publication.js', import.meta.url), 'utf8');
function harness({ action = 'publish', destination, rejection = false, supportDialog = true, deferred = false, responseBody } = {}) {
  const listeners = new Map(); const requests = []; const navigations = []; let active;
  const element = (name) => ({ name, disabled: false, textContent: '', dataset: {},
    addEventListener(type, callback) { listeners.set(`${name}:${type}`, callback); },
    fire(type, event = {}) { return listeners.get(`${name}:${type}`)?.({ preventDefault() {}, ...event }); },
    focus() { active = this; }, setAttribute() {}, removeAttribute() {} });
  const trigger = element('trigger'); const status = element('status'); const confirm = element('confirm'); const cancel = element('cancel');
  const dialog = Object.assign(element('dialog'), { open: false,
    showModal: supportDialog ? function () { this.open = true; } : undefined,
    close() { this.open = false; this.fire('close'); } });
  const form = Object.assign(element('form'), { dataset: { action, mappingId: 'one-page', draftId: 'a'.repeat(64), csrf: 'synthetic-csrf' }, querySelector: () => trigger });
  const nodes = { '#publication-form': form, '#publication-status': status, '#publication-dialog': dialog, '#publication-confirm': confirm, '#publication-cancel': cancel };
  let resolve;
  const gate = new Promise((yes) => { resolve = yes; });
  vm.runInNewContext(source, { URL, document: { querySelector: (selector) => nodes[selector] ?? null, get activeElement() { return active; } },
    window: { location: { origin: 'http://127.0.0.1:4317', assign: (url) => navigations.push(url) } },
    fetch: async (url, options) => {
      requests.push({ url, options }); if (deferred) await gate;
      if (rejection) throw new Error('synthetic-lost-response');
      return { ok: true, json: async () => responseBody ?? ({ reviewUrl: destination ?? `/owner/publication/${'a'.repeat(64)}`,
        statusUrl: destination ?? `/owner/jobs/OA-PUB-${'a'.repeat(64)}` }) };
    } });
  return { form, trigger, status, dialog, confirm, cancel, requests, navigations, resolve, active: () => active?.name };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('native dialog opens without sending; Cancel and Escape return focus without publishing', () => {
  const ui = harness(); ui.form.fire('submit');
  expect(ui.dialog.open).toBe(true); expect(ui.active()).toBe('cancel'); expect(ui.requests).toHaveLength(0);
  ui.cancel.fire('click'); expect(ui.dialog.open).toBe(false); expect(ui.active()).toBe('trigger');
  ui.form.fire('submit'); ui.dialog.close(); // Browser's native Escape close event.
  expect(ui.active()).toBe('trigger'); expect(ui.requests).toHaveLength(0);
});

test('dialog Tab and Shift+Tab wrap between Cancel and Publish without escaping to the page', () => {
  const ui = harness(); ui.form.fire('submit'); let prevented = 0;
  ui.dialog.fire('keydown', { key: 'Tab', shiftKey: true, preventDefault() { prevented += 1; } });
  expect(ui.active()).toBe('confirm');
  ui.dialog.fire('keydown', { key: 'Tab', shiftKey: false, preventDefault() { prevented += 1; } });
  expect(ui.active()).toBe('cancel'); expect(prevented).toBe(2); expect(ui.requests).toHaveLength(0);
});

test('deliberate confirmation sends the unchanged CSRF payload once even with repeated activation', async () => {
  const ui = harness({ deferred: true }); ui.form.fire('submit');
  ui.confirm.fire('click'); ui.confirm.fire('click'); ui.form.fire('submit');
  expect(ui.requests).toHaveLength(1); expect(ui.trigger.disabled).toBe(true); expect(ui.confirm.disabled).toBe(true);
  expect(ui.requests[0].url).toBe('/api/publication/publish');
  expect(ui.requests[0].options.credentials).toBe('same-origin');
  expect(ui.requests[0].options.headers).toEqual({ 'Content-Type': 'application/json' });
  expect(JSON.parse(ui.requests[0].options.body)).toEqual({ draftId: 'a'.repeat(64), csrf: 'synthetic-csrf' });
  ui.resolve(); await settle(); expect(ui.navigations).toEqual([`http://127.0.0.1:4317/owner/jobs/OA-PUB-${'a'.repeat(64)}`]);
});

test('prepare remains a single request without confirmation and retains its closed payload', async () => {
  const ui = harness({ action: 'prepare', deferred: true }); ui.form.fire('submit'); ui.form.fire('submit');
  expect(ui.dialog.open).toBe(false); expect(ui.requests).toHaveLength(1);
  expect(JSON.parse(ui.requests[0].options.body)).toEqual({ mappingId: 'one-page', csrf: 'synthetic-csrf' });
  ui.resolve(); await settle(); expect(ui.navigations).toHaveLength(1);
});

test('unchanged prepare follows only the closed current-view response without confirmation', async () => {
  const reviewUrl = `/owner/publication/current/${'a'.repeat(64)}`;
  const ui = harness({ action: 'prepare', responseBody: { outcome: 'unchanged', reviewUrl } });
  ui.form.fire('submit'); await settle();
  expect(ui.dialog.open).toBe(false); expect(ui.requests).toHaveLength(1);
  expect(ui.navigations).toEqual([`http://127.0.0.1:4317${reviewUrl}`]);
});

test('unchanged navigation rejects wrong outcomes, extra fields and every nonexact current URL shape', async () => {
  const reviewUrl = `/owner/publication/current/${'a'.repeat(64)}`;
  const bodies = [
    { reviewUrl }, { outcome: 'other', reviewUrl }, { outcome: 'unchanged', reviewUrl, draftId: 'a'.repeat(64) },
    ...[reviewUrl.toUpperCase(), `${reviewUrl}?x=1`, `${reviewUrl}#x`, `${reviewUrl}/`,
      `/owner/publication/current/${'a'.repeat(63)}`, `/owner/publication/${'a'.repeat(64)}`,
      `http://127.0.0.1:4317${reviewUrl}`, `//127.0.0.1:4317${reviewUrl}`, `https://elsewhere.invalid${reviewUrl}`,
      `/owner/publication/current/%61${'a'.repeat(63)}`, `/x/../owner/publication/current/${'a'.repeat(64)}`,
    ].map((value) => ({ outcome: 'unchanged', reviewUrl: value })),
  ];
  for (const responseBody of bodies) {
    const ui = harness({ action: 'prepare', responseBody }); ui.form.fire('submit'); await settle();
    expect(ui.navigations).toHaveLength(0); expect(ui.trigger.disabled).toBe(false);
  }
});

for (const action of ['prepare', 'publish']) {
  for (const destination of ['https://elsewhere.invalid/owner/publication/' + 'a'.repeat(64), '/owner/review',
    '/owner/jobs/OA-PUB-' + 'a'.repeat(64) + '?x=1', '/owner/publication/' + 'a'.repeat(64) + '#x', '//elsewhere.invalid/path']) {
    test(`${action} refuses unsafe response navigation ${destination.includes('?') ? 'query' : destination.includes('#') ? 'fragment' : destination.startsWith('//') ? 'authority' : destination.startsWith('https:') ? 'external' : 'path'}`, async () => {
      const ui = harness({ action, destination }); ui.form.fire('submit'); if (action === 'publish') ui.confirm.fire('click');
      await settle(); expect(ui.navigations).toHaveLength(0); expect(ui.trigger.disabled).toBe(false);
      if (action === 'publish') expect(ui.status.textContent).toContain('Do not assume nothing changed.');
    });
  }
}

test('lost acceptance response keeps uncertainty explicit and restores the action focus', async () => {
  const ui = harness({ rejection: true }); ui.form.fire('submit'); ui.confirm.fire('click'); await settle();
  expect(ui.status.textContent).toContain('Reload this review to check its one existing job');
  expect(ui.status.textContent).toContain('Do not assume nothing changed.'); expect(ui.active()).toBe('trigger');
});

test('missing native dialog support fails closed without sending a publication request', () => {
  const ui = harness({ supportDialog: false }); ui.form.fire('submit'); ui.confirm.fire('click');
  expect(ui.requests).toHaveLength(0); expect(ui.status.textContent).toContain('No request was sent.');
});

async function jobHarness(state, { reject = false } = {}) {
  const labels = ['Check', 'Apply', 'Push', 'Build', 'Verify', 'Refresh'];
  const stages = { activeCopy: 'Publishing this version', steps: labels.map((label, index) => ({ label, states: index === 0 ? ['accepted'] : index === 2 ? ['pushing'] : [] })),
    stops: Object.fromEntries(['failed', 'manual-intervention', 'cancelled', 'completed'].map((key) => [key, { step: key === 'completed' ? 6 : 0, copy: key === 'completed' ? 'Rehearsal complete' : 'Check the record. Changes may already exist.' }])) };
  const root = { dataset: { jobId: `OA-PUB-${'a'.repeat(64)}`, stages: JSON.stringify(stages) } };
  const nodes = Object.fromEntries(['job-stage', 'job-state', 'job-updated', 'job-recovery', 'job-error'].map((id) => [`#${id}`, { textContent: '' }]));
  nodes['#publication-job-note'] = { textContent: 'In progress', dataset: { completeCopy: 'Local only. No public site changed.' } };
  const steps = labels.map(() => ({ dataset: {}, label: { textContent: '' }, querySelector() { return this.label; } }));
  const requests = []; const scheduled = [];
  vm.runInNewContext(source, { document: { querySelector: (selector) => selector === '.publication-page #owner-job' ? root : nodes[selector] ?? null,
    querySelectorAll: () => steps }, window: { setTimeout: (_, milliseconds) => scheduled.push(milliseconds) },
    fetch: async (url, options) => { requests.push({ url, options }); if (reject) throw new Error('not-public');
      return { ok: true, json: async () => ({ state, updatedAt: 'synthetic-time', recovery: { instruction: 'Safe instruction.' }, failure: null }) }; } });
  await settle(); return { nodes, steps, requests, scheduled };
}

test('active job polling preserves the overall task headline instead of repeating the current step', async () => {
  for (const state of ['accepted', 'pushing']) {
    const ui = await jobHarness(state);
    expect(ui.nodes['#job-stage'].textContent).toBe('Publishing this version');
    expect(ui.nodes['#job-state'].textContent).toBe(state);
    expect(ui.steps.filter((step) => step.dataset.status === 'current')).toHaveLength(1);
    expect(ui.scheduled).toEqual([2000]);
  }
});

test('publication-only layout keeps the reading edge aligned, tablet comparison stacked and unknown marker distinct', async () => {
  const css = await readFile(new URL('../public/owner.css', import.meta.url), 'utf8');
  const scoped = css.slice(css.indexOf('/* Publication workspace.'));
  expect(scoped).toContain('.publication-page .reading-body { width: 100%; max-width: 75ch; margin: 0;');
  expect(scoped).toContain('@media (max-width: 900px) {\n  .publication-page .proof-grid { grid-template-columns: minmax(0, 1fr); }');
  expect(scoped).toContain(".publication-page .job-step-unknown::before { content: '?';");
  expect(scoped).not.toContain('.proposal-review-page');
});

for (const state of ['failed', 'manual-intervention', 'cancelled']) {
  test(`uncertain ${state} progress does not invent completed or unstarted effects`, async () => {
    const ui = await jobHarness(state);
    expect(ui.steps.every((step) => step.dataset.status === 'unknown' && step.label.textContent === 'See record')).toBe(true);
    expect(ui.nodes['#job-state'].textContent).toBe(state);
    expect(ui.nodes['#job-stage'].textContent).toContain('Changes may already exist');
    expect(ui.nodes['#job-recovery'].textContent).toBe('Safe instruction.');
    expect(ui.scheduled).toHaveLength(0);
  });
}

test('job client uses bound presentation labels and never invents a live link on fixture completion', async () => {
  const ui = await jobHarness('completed');
  expect(ui.nodes['#job-stage'].textContent).toBe('Rehearsal complete');
  expect(ui.nodes['#publication-job-note'].textContent).toBe('Local only. No public site changed.');
  expect(ui.steps.every((step) => step.dataset.status === 'done')).toBe(true);
  expect(ui.requests[0].options.credentials).toBe('same-origin'); expect(ui.scheduled).toHaveLength(0);
});

function displayHarness({ supportDialog = true, explicitDetails = false, throwsOnOpen = false } = {}) {
  const listeners = {}; const requests = []; let active;
  const element = (id) => ({ id, dataset: {}, hidden: false, attributes: {}, children: [],
    addEventListener(type, callback) { listeners[`${id}:${type}`] = callback; },
    fire(type, event = {}) { listeners[`${id}:${type}`]?.({ preventDefault() {}, ...event }); },
    setAttribute(key, value) { this.attributes[key] = value; },
    contains(node) { return node === this || this.children.includes(node); },
    append(node) { if (node.parent) node.parent.children = node.parent.children.filter((child) => child !== node); this.children.push(node); node.parent = this; },
    getClientRects: () => [1],
    focus(options) { active = this; this.focusOptions = options; }, scrollIntoView(options) { this.scroll = options; } });
  const anchors = [element('one'), element('two')]; const tool = element('tool');
  const review = Object.assign(element('review'), { dataset: { marksVisible: 'true' }, querySelectorAll: (selector) => selector === '[data-change]' ? anchors : [tool] });
  const nodes = { '.publication-review-app': review, ...Object.fromEntries(['previous-change', 'next-change', 'toggle-marks', 'toggle-marks-tip', 'toggle-details', 'review-details', 'review-fallback', 'details-dialog', 'details-body', 'close-details', 'document-scroll', 'change-count', 'review-announcement'].map((id) => [`#publication-${id}`, element(id)])) };
  const get = (id) => nodes[`#publication-${id}`];
  get('toggle-marks').attributes['aria-label'] = 'Show changes'; get('toggle-marks').textContent = 'static SVG';
  const fallback = get('review-fallback'); fallback.open = explicitDetails; fallback.append(get('review-details'));
  const sheet = get('details-dialog'); sheet.open = false;
  sheet.showModal = supportDialog ? function () { if (throwsOnOpen) throw new Error('synthetic'); this.open = true; } : undefined;
  sheet.close = function () { this.open = false; this.fire('close'); };
  sheet.querySelectorAll = () => [get('close-details'), get('review-details')];
  get('toggle-details').hidden = true;
  get('document-scroll').scrollTop = 700; get('document-scroll').scrollLeft = 0;
  vm.runInNewContext(source, { document: { querySelector: (selector) => nodes[selector] ?? null, get activeElement() { return active; } }, fetch: (...args) => requests.push(args) });
  return { get, anchors, review, tool, requests, active: () => active };
}

test('icon navigation wraps, separates compact count from announcements and restores marks before focus without requests', () => {
  const ui = displayHarness(); const { get, review, anchors } = ui;
  get('previous-change').fire('click'); expect(ui.active()).toBe(anchors[1]); expect(get('change-count').textContent).toBe('2 / 2');
  get('next-change').fire('click'); expect(ui.active()).toBe(anchors[0]); expect(anchors[0].scroll.block).toBe('start');
  get('toggle-marks').fire('click'); expect(review.dataset.marksVisible).toBe('false');
  expect(get('toggle-marks').attributes['aria-pressed']).toBe('false'); expect(get('toggle-marks-tip').textContent).toBe('Changes hidden');
  const focus = anchors[1].focus;
  anchors[1].focus = function (options) { expect(review.dataset.marksVisible).toBe('true'); focus.call(this, options); };
  get('next-change').fire('click'); expect(review.dataset.marksVisible).toBe('true');
  expect(get('change-count').textContent).toBe('2 / 2');
  expect(get('review-announcement').textContent).toBe('Changes shown. Change 2 of 2.');
  expect(get('toggle-marks').attributes['aria-label']).toBe('Show changes');
  expect(get('toggle-marks').textContent).toBe('static SVG'); expect(get('toggle-marks-tip').textContent).toBe('Changes shown');
  expect(ui.requests).toHaveLength(0);
});

test('tooltips persist across focus and hover, dismiss on Escape and reset only after both leave', () => {
  const { tool } = displayHarness();
  tool.fire('focusin'); expect(tool.dataset.tooltipVisible).toBe('true');
  tool.fire('pointerenter'); tool.fire('focusout', { relatedTarget: null }); expect(tool.dataset.tooltipVisible).toBe('true');
  tool.fire('keydown', { key: 'Escape' }); expect(tool.dataset.tooltipVisible).toBe('false');
  tool.fire('focusin'); expect(tool.dataset.tooltipVisible).toBe('false');
  tool.fire('pointerleave'); tool.fire('focusout', { relatedTarget: null });
  tool.fire('focusin'); expect(tool.dataset.tooltipVisible).toBe('true');
});

test('Details moves existing DOM into its own modal, contains both Tab directions and restores opener and document scroll', () => {
  const ui = displayHarness(); const { get } = ui;
  expect(get('review-fallback').hidden).toBe(true); expect(get('toggle-details').hidden).toBe(false);
  expect(get('review-details').parent).toBe(get('details-body'));
  get('toggle-details').fire('click'); expect(get('details-dialog').open).toBe(true); expect(ui.active()).toBe(get('close-details'));
  expect(get('toggle-details').attributes['aria-expanded']).toBe('true');
  get('details-dialog').fire('keydown', { key: 'Tab', shiftKey: true }); expect(ui.active()).toBe(get('review-details'));
  get('details-dialog').fire('keydown', { key: 'Tab' }); expect(ui.active()).toBe(get('close-details'));
  get('document-scroll').scrollTop = 0;
  get('close-details').fire('click'); expect(get('details-dialog').open).toBe(false);
  expect(ui.active()).toBe(get('toggle-details')); expect(get('toggle-details').focusOptions.preventScroll).toBe(true);
  expect(get('document-scroll').scrollTop).toBe(700); expect(get('toggle-details').attributes['aria-expanded']).toBe('false');
  get('toggle-details').fire('click'); get('details-dialog').close(); // Native Escape close event.
  expect(ui.active()).toBe(get('toggle-details')); expect(ui.requests).toHaveLength(0);
});

test('unsupported dialog keeps native disclosure; explicit detail links open only the independent supported sheet', () => {
  const unsupported = displayHarness({ supportDialog: false });
  expect(unsupported.get('review-fallback').hidden).toBe(false); expect(unsupported.get('review-fallback').open).toBe(false);
  expect(unsupported.get('review-details').parent).toBe(unsupported.get('review-fallback'));
  expect(unsupported.get('toggle-details').hidden).toBe(true);
  const linked = displayHarness({ explicitDetails: true }); expect(linked.get('details-dialog').open).toBe(true);
  expect(linked.active()).toBe(linked.get('close-details'));
  const failed = displayHarness({ throwsOnOpen: true }); failed.get('toggle-details').fire('click');
  expect(failed.get('review-details').parent).toBe(failed.get('review-fallback'));
  expect(failed.get('review-fallback').hidden).toBe(false); expect(failed.get('review-fallback').open).toBe(true);
  expect(failed.requests).toHaveLength(0);
});

test('job polling failure remains uncertain and does not expose dependency diagnostics', async () => {
  const ui = await jobHarness('accepted', { reject: true });
  expect(ui.nodes['#job-error'].textContent).toContain('check the existing job; do not start another publication');
  expect(ui.nodes['#job-error'].textContent).not.toContain('not-public'); expect(ui.scheduled).toEqual([5000]);
});

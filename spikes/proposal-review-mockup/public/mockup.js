const modelNode = document.querySelector('#fixture-model');
const model = JSON.parse(modelNode.textContent);
const app = document.querySelector('#app');
const confirmation = document.querySelector('#confirmation-dialog');
const confirmationKicker = document.querySelector('#confirmation-kicker');
const confirmationTitle = document.querySelector('#confirmation-title');
const confirmationBody = document.querySelector('#confirmation-body');
const confirmPreview = document.querySelector('[data-confirm-preview]');
const cancelConfirmation = document.querySelector('[data-cancel-confirmation]');
const mobileBar = document.querySelector('#mobile-decision');
const mobileButton = document.querySelector('[data-open-mobile-decision]');
const decisionSheet = document.querySelector('#decision-sheet');
const decisionSheetBody = document.querySelector('#decision-sheet-body');
const decisionSheetProposal = document.querySelector('#decision-sheet-proposal');
const closeDecisionSheet = document.querySelector('[data-close-decision-sheet]');
const notes = new Map();
const receipts = [];
let activeFixture = null;
let activeOperation = 0;
let activeMode = 'changes';
let dockOpen = false;
let focusChanges = false;
let renderedReading = true;
let restoreModeFocus = false;
let highlightActiveChange = false;
let pendingAction = null;
let returnFocus = null;

function node(tag, options = {}, children = []) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(options)) {
    if (value === null || value === undefined) continue;
    if (key === 'className') element.className = value;
    else if (key === 'text') element.textContent = value;
    else if (key === 'htmlFor') element.htmlFor = value;
    else if (key.startsWith('data-')) element.setAttribute(key, value);
    else if (key === 'hidden') element.hidden = value;
    else element.setAttribute(key, value);
  }
  for (const child of children) element.append(child);
  return element;
}
const text = (value) => document.createTextNode(value);
const fixtureById = (id) => model.fixtures.find((fixture) => fixture.id === id) ?? null;
const link = (label, hash, className = '') => node('a', { href: hash, className, text: label });
const labelPair = (fixture) => node('div', { className: 'evidence-labels' }, [
  node('span', { className: `support-label support-${fixture.supportLevel}`, text: fixture.supportLabel }),
  node('span', { className: `evidence-label evidence-${fixture.evidenceClass}`, text: fixture.evidenceLabel }),
]);

function pageHeader(kicker, title, lede, extra = []) {
  return node('header', { className: 'page-heading' }, [
    node('p', { className: 'kicker', text: kicker }),
    node('h1', { text: title }),
    node('p', { className: 'lede', text: lede }),
    ...extra,
  ]);
}
function renderInboxGroup(title, description, fixtures) {
  const section = node('section', { className: 'inbox-group' }, [
    node('div', { className: 'group-heading' }, [node('div', {}, [node('h2', { text: title }), node('p', { text: description })]), node('span', { className: 'group-count', text: String(fixtures.length) })]),
  ]);
  const list = node('div', { className: 'proposal-list' });
  for (const fixture of fixtures) {
    const row = link('', `#review/${fixture.id}`, 'proposal-row');
    row.append(
      node('div', { className: 'row-title' }, [node('h3', { text: fixture.title }), node('span', { className: 'attention', text: fixture.attentionLabel })]),
      node('p', { className: 'row-summary', text: fixture.summary }),
      node('div', { className: 'row-meta' }, [
        node('span', { text: fixture.titleProvenance }), node('span', { text: fixture.category }), node('strong', { text: fixture.actualScope }),
      ]),
      labelPair(fixture),
    );
    list.append(row);
  }
  if (fixtures.length === 0) list.append(node('p', { className: 'empty', text: 'No items in this research projection.' }));
  section.append(list);
  return section;
}
function renderInbox() {
  activeFixture = null;
  mobileBar.hidden = true;
  app.replaceChildren(
    node('div', { className: 'page page-inbox' }, [
      pageHeader('Editorial inbox', 'Proposals that ask for a clear owner decision', 'Realistic intent leads. Paths, operation IDs, and digests remain secondary. Every row declares its support level and evidence ceiling.'),
      renderInboxGroup('Needs your decision', 'Executable v1 and target-research comparisons that support the static decision-flow preview.', model.groups.needs),
      renderInboxGroup('Blocked from decision', 'Retained evidence whose expiry, source binding, owner policy, or private-review availability prevents a decision. None is rewritten as an owner rejection.', model.groups.blocked),
      renderInboxGroup('Decided', 'Authority-model projections keep the immutable decision separate from application and publication effects.', model.groups.decided),
    ]),
  );
}

const MODES = Object.freeze([
  { key: 'changes', label: 'Changes', source: 'unified', hint: 'Removals and additions marked in place' },
  { key: 'proposed', label: 'Proposed', source: 'proposed', hint: 'The page as it would read if applied' },
  { key: 'current', label: 'Current', source: 'current', hint: 'The page as it reads today' },
  { key: 'compare', label: 'Compare', source: null, hint: 'Both sides at once' },
]);
const COLLAPSE_THRESHOLD = 420;
const COLLAPSE_MARGIN = 150;

function modeFor(value) {
  return MODES.some((mode) => mode.key === value) ? value : 'changes';
}
function appendContext(container, value) {
  if (!focusChanges || value.length <= COLLAPSE_THRESHOLD) { container.append(text(value)); return; }
  const hidden = value.slice(COLLAPSE_MARGIN, value.length - COLLAPSE_MARGIN);
  const holder = node('span', { className: 'collapsed-holder' });
  const expand = node('button', { type: 'button', className: 'collapsed-run', text: `⋯ show ${hidden.length} unchanged characters ⋯` });
  expand.addEventListener('click', () => holder.replaceChildren(text(hidden)));
  holder.append(expand);
  container.append(text(value.slice(0, COLLAPSE_MARGIN)), holder, text(value.slice(value.length - COLLAPSE_MARGIN)));
}
function segmentElement(item) {
  if (item.kind === 'removed') return node('del', { className: 'doc-removed', text: item.text });
  if (item.kind === 'added') return node('ins', { className: 'doc-added', text: item.text });
  return node('span', {
    className: 'doc-point',
    text: item.kind === 'insertion-point' ? `⟨insertion point · change ${item.operation}⟩` : `⟨removed here · change ${item.operation}⟩`,
  });
}
function appendSegments(container, segments) {
  for (const item of segments) {
    if (item.kind === 'context') { appendContext(container, item.text); continue; }
    const element = segmentElement(item);
    element.setAttribute('data-change', String(item.operation));
    if (highlightActiveChange && item.operation === activeOperation + 1) element.classList.add('is-active');
    container.append(element);
  }
}
function documentBody(segments, className = 'document-body') {
  const body = node('div', { className });
  appendSegments(body, segments);
  return body;
}
function documentEnd(source) {
  return source.blocks.at(-1)?.end ?? 0;
}
// A zero-width segment at the end of the document belongs to the final block,
// so an appended change stays visible. Mirrors segmentsWithinSpan in
// @cyberbaser/review-projection.
function segmentsInBlock(segments, block, end = null) {
  return segments.filter((item) => (item.end > item.start
    ? item.start < block.end && item.end > block.start
    : (item.start >= block.start && item.start < block.end)
      || (end !== null && item.start === end && block.end === end)));
}
function blockSegments(segments, block, end = null) {
  const scoped = [];
  for (const item of segmentsInBlock(segments, block, end)) {
    if (item.kind !== 'context') { scoped.push(item); continue; }
    if (item.text.length !== item.end - item.start) { scoped.push(item); continue; }
    const start = Math.max(item.start, block.start);
    const end = Math.min(item.end, block.end);
    const sliced = item.text.slice(start - item.start, end - item.start);
    if (sliced.length > 0) scoped.push({ ...item, text: sliced });
  }
  return scoped;
}
function tokenNode(item) {
  if (item.type === 'code') return node('code', { className: 'md-code', text: item.text });
  if (item.type === 'strong') return node('strong', { text: item.text });
  if (item.type === 'emphasis') return node('em', { text: item.text });
  if (item.type === 'link' || item.type === 'wikilink') {
    return node('span', { className: `md-link md-${item.type}`, title: `${item.target} · not resolved in this static concept`, text: item.text });
  }
  return text(item.text);
}
function blockNode(block) {
  const tokens = (block.tokens ?? []).map(tokenNode);
  if (block.kind === 'heading') return node('p', { className: `md-heading md-h${block.level}`, 'data-level': String(block.level) }, tokens);
  if (block.kind === 'paragraph') return node('p', { className: 'md-paragraph' }, tokens);
  if (block.kind === 'quote') return node('blockquote', { className: 'md-quote' }, tokens);
  if (block.kind === 'code') return node('pre', { className: 'md-codeblock', text: block.text });
  if (block.kind === 'rule') return node('hr', { className: 'md-rule' });
  if (block.kind === 'list' || block.kind === 'ordered-list') {
    return node(block.kind === 'list' ? 'ul' : 'ol', { className: 'md-list' }, block.items.map((item) => node('li', { className: item.depth > 0 ? 'md-nested' : null }, item.tokens.map(tokenNode))));
  }
  if (block.kind === 'frontmatter') {
    return node('div', { className: 'md-frontmatter' }, [
      node('p', { className: 'kicker', text: 'Page metadata' }),
      node('dl', {}, block.entries.map((entry) => node('div', {}, [node('dt', { text: entry.name }), node('dd', { text: entry.value })]))),
    ]);
  }
  return null;
}
function changedSegmentIds(segments, block, end = null) {
  return new Set(segmentsInBlock(segments, block, end)
    .filter((item) => item.kind !== 'context')
    .map((item) => item.operation ?? segments.indexOf(item)));
}
function readingRegions(source) {
  const end = documentEnd(source);
  const regions = [];
  let index = 0;
  while (index < source.blocks.length) {
    const changed = changedSegmentIds(source.segments, source.blocks[index], end);
    if (changed.size === 0) {
      regions.push({ changed: false, blocks: [source.blocks[index]] });
      index += 1;
      continue;
    }
    const blocks = [source.blocks[index]];
    let cursor = index + 1;
    while (cursor < source.blocks.length) {
      const next = changedSegmentIds(source.segments, source.blocks[cursor], end);
      if (next.size === 0 || [...next].every((id) => !changed.has(id))) break;
      for (const id of next) changed.add(id);
      blocks.push(source.blocks[cursor]);
      cursor += 1;
    }
    regions.push({ changed: true, blocks });
    index = cursor;
  }
  return regions;
}
function sourceRegion(source, span, label, className = 'md-source-wrap') {
  const exact = node('div', { className: 'md-source' });
  appendSegments(exact, blockSegments(source.segments, span, documentEnd(source)));
  return node('div', { className }, [node('p', { className: 'md-source-label', text: label }), exact]);
}
function readingBody(source, className = '') {
  const body = node('div', { className: `reading-body ${className}`.trim() });
  for (const region of readingRegions(source)) {
    const span = { start: region.blocks[0].start, end: region.blocks.at(-1).end };
    if (region.changed) {
      body.append(sourceRegion(source, span, 'Exact source · changed passage'));
      continue;
    }
    const [block] = region.blocks;
    if (block.uninterpreted?.length > 0) {
      body.append(sourceRegion(source, span, `Exact source · not interpreted here: ${block.uninterpreted.join(', ')}`, 'md-source-wrap md-source-uninterpreted'));
      continue;
    }
    const element = blockNode(block);
    if (element !== null) body.append(element);
  }
  return body;
}
function sideBody(source, className = 'document-body') {
  return renderedReading && source.blocks.length > 0 ? readingBody(source, className === 'document-body' ? '' : className) : documentBody(source.segments, className);
}
function unavailablePanel(reason) {
  const fallback = node('button', { type: 'button', className: 'button secondary', text: 'Show the declared change spans' });
  fallback.addEventListener('click', () => selectMode('compare'));
  return node('div', { className: 'mode-unavailable' }, [
    node('p', { className: 'kicker', text: 'Not derivable' }),
    node('p', { text: reason }),
    node('p', { className: 'mode-unavailable-note', text: 'This surface never invents a document it cannot derive from the pinned base and the declared exact operations.' }),
    fallback,
  ]);
}
function fileHeading(file) {
  return node('p', { className: 'document-heading' }, [
    node('code', { className: 'document-path', text: `${file.path}${file.exists ? '' : ' · absent in the pinned base'}` }),
  ]);
}
function readingPanel(fixture, mode) {
  const state = fixture.document.modes[mode.key];
  if (!state.available) return unavailablePanel(state.reason);
  const panel = node('div', { className: `document-view document-${mode.key}` });
  for (const file of fixture.document.files) {
    if (file.operationNumbers.length === 0) continue;
    panel.append(fileHeading(file), sideBody(file[mode.source]));
  }
  return panel;
}
function comparePanes(fixture) {
  const projection = fixture.document;
  if (projection.modes.current.available && projection.modes.proposed.available) {
    const grid = node('div', { className: 'proof-grid' });
    const insertionOnly = fixture.operations.every((item) => item.insertion);
    const deletionOnly = fixture.operations.every((item) => item.deletion);
    for (const [kind, source, label, note] of [
      ['current', 'current', 'Current source', insertionOnly ? 'No current text' : 'Removed'],
      ['proposed', 'proposed', 'Proposed change', deletionOnly ? 'Absent in proposed result · Not yet approved' : 'Added · Not yet approved'],
    ]) {
      const pane = node('section', { className: `proof proof-${kind}`, 'aria-label': label }, [
        node('div', { className: 'proof-heading' }, [node('p', { className: 'proof-label', text: label }), node('span', { className: 'semantic-label', text: note })]),
      ]);
      for (const file of projection.files) {
        if (file.operationNumbers.length === 0) continue;
        pane.append(sideBody(file[source], 'compare-body'));
      }
      grid.append(pane);
    }
    return grid;
  }
  const operation = fixture.operations[activeOperation];
  return node('div', { className: 'proof-grid' }, [proofPanel(operation, 'current'), proofPanel(operation, 'proposed')]);
}
function proofText(operation, kind) {
  const paragraph = node('p', { className: 'proposal-prose' });
  paragraph.append(text(operation.contextBefore));
  if (kind === 'current') {
    if (operation.insertion) paragraph.append(node('em', { className: 'empty-proof', text: 'No current text at this location' }));
    else paragraph.append(node('del', { text: operation.oldText }));
  } else if (operation.deletion) paragraph.append(node('em', { className: 'empty-proof', text: 'Notice removed here' }));
  else paragraph.append(node('ins', { text: operation.replacementText }));
  paragraph.append(text(operation.contextAfter));
  return paragraph;
}
function proofPanel(operation, kind) {
  const current = kind === 'current';
  return node('section', { className: `proof proof-${kind}`, 'aria-label': current ? 'Current source' : 'Proposed change' }, [
    node('div', { className: 'proof-heading' }, [
      node('p', { className: 'proof-label', text: current ? 'Current source' : 'Proposed change' }),
      node('span', { className: 'semantic-label', text: current ? operation.currentSemanticLabel : operation.proposedSemanticLabel }),
    ]),
    proofText(operation, kind),
  ]);
}
function selectMode(mode) {
  if (!activeFixture) return;
  restoreModeFocus = true;
  activeMode = modeFor(mode);
  location.hash = `review/${activeFixture.id}/${activeMode}`;
}
function modeTabs(fixture) {
  const tablist = node('div', { className: 'review-modes', role: 'tablist', 'aria-label': 'Review mode' });
  const buttons = [];
  MODES.forEach((mode) => {
    const selected = mode.key === activeMode;
    const state = fixture.document.modes[mode.key];
    const button = node('button', {
      type: 'button',
      id: `mode-tab-${mode.key}`,
      className: selected ? 'mode-tab active' : 'mode-tab',
      role: 'tab',
      'data-mode': mode.key,
      'aria-selected': selected ? 'true' : 'false',
      'aria-controls': 'mode-panel',
      'aria-label': mode.label,
      tabindex: selected ? '0' : '-1',
    }, [
      node('strong', { text: mode.label }),
      node('small', { text: state && !state.available ? 'Not derivable' : selected ? mode.hint : '' }),
    ]);
    button.addEventListener('click', () => selectMode(mode.key));
    button.addEventListener('keydown', (event) => {
      const index = MODES.findIndex((item) => item.key === mode.key);
      const target = event.key === 'ArrowRight' ? (index + 1) % MODES.length
        : event.key === 'ArrowLeft' ? (index - 1 + MODES.length) % MODES.length
          : event.key === 'Home' ? 0
            : event.key === 'End' ? MODES.length - 1 : null;
      if (target === null) return;
      event.preventDefault();
      selectMode(MODES[target].key);
    });
    buttons.push(button);
    tablist.append(button);
  });
  return tablist;
}
function markLegend() {
  return node('p', { className: 'mark-legend' }, [
    node('span', {}, [text('Removed text is '), node('del', { text: 'struck through' }), text('.')]),
    node('span', {}, [text('Added text is '), node('ins', { text: 'underlined' }), text('.')]),
    node('span', { text: 'Every other byte is unchanged.' }),
  ]);
}
function toggleControl(id, label, value, apply) {
  const input = node('input', { type: 'checkbox', id });
  input.checked = value;
  input.addEventListener('change', () => {
    apply(input.checked);
    renderReview(activeFixture, `#${id}`);
  });
  return node('div', { className: 'focus-toggle' }, [input, node('label', { htmlFor: id, text: label })]);
}
function readerToggles() {
  return node('div', { className: 'reader-toggles' }, [
    toggleControl('rendered-reading', 'Rendered reading', renderedReading, (value) => { renderedReading = value; }),
    toggleControl('focus-changes', 'Collapse long unchanged passages', focusChanges, (value) => { focusChanges = value; }),
  ]);
}
function technicalDisclosure(fixture, operation) {
  const payload = [
    `Fixture: ${fixture.id}`,
    `Support: ${fixture.supportLevel}`,
    `Evidence: ${fixture.evidenceClass}`,
    `Path: ${operation.path}`,
    `Base-relative range: ${operation.range}`,
    `Old UTF-8 bytes: ${JSON.stringify(operation.oldText)}`,
    `Replacement UTF-8 bytes: ${JSON.stringify(operation.replacementText)}`,
    `Proposal digest: ${fixture.technical.proposalDigest ?? 'none'}`,
    `Queue ID: ${fixture.technical.queueId ?? 'none'}`,
    `Execution block: ${fixture.technical.executionBlockReason ?? 'none'}`,
  ].join('\n');
  return node('details', { className: 'technical' }, [node('summary', { text: 'Technical evidence' }), node('pre', { text: payload })]);
}
function scrollToChange(number) {
  const target = app.querySelector(`#mode-panel [data-change="${number}"]`);
  if (target) target.scrollIntoView({ block: 'center', behavior: 'auto' });
}
function operationNavigator(fixture) {
  if (fixture.operations.length < 2) return node('span', { className: 'single-operation', hidden: true });
  const nav = node('nav', { className: 'operation-nav', 'aria-label': 'Exact changes' });
  fixture.operations.forEach((operation, index) => {
    const selected = index === activeOperation;
    const button = node('button', {
      type: 'button',
      className: selected ? 'operation-button active' : 'operation-button',
      text: `${index + 1}. ${operation.label}`,
      'data-operation-index': String(index),
      'aria-current': selected ? 'step' : null,
      'aria-pressed': selected ? 'true' : 'false',
    });
    button.addEventListener('click', () => {
      activeOperation = index;
      renderReview(fixture, `[data-operation-index="${index}"]`);
      scrollToChange(index + 1);
    });
    nav.append(button);
  });
  return nav;
}
function noteValidation(value) {
  const bytes = new TextEncoder().encode(value).length;
  if (value.length === 0 || value.trim().length === 0) return { valid: false, message: 'Write a bounded owner note before choosing an action.', bytes };
  if (value.trim() !== value) return { valid: false, message: 'Remove surrounding whitespace from the owner note.', bytes };
  if (/\p{Cc}/u.test(value)) return { valid: false, message: 'The owner note cannot contain line breaks or control characters.', bytes };
  if (bytes > 4096) return { valid: false, message: 'Shorten the owner note to 4096 UTF-8 bytes or fewer.', bytes };
  return { valid: true, message: 'Note is ready for deliberate confirmation.', bytes };
}
function ownerNote(fixture, suffix = '') {
  const id = `owner-note${suffix}`;
  const textarea = node('textarea', { id, rows: '4', placeholder: 'Explain the owner decision in plain language.' });
  textarea.value = notes.get(fixture.id) ?? '';
  const status = node('p', { className: 'note-status', role: 'status' });
  const update = () => {
    notes.set(fixture.id, textarea.value);
    const result = noteValidation(textarea.value);
    status.textContent = `${result.bytes} of 4096 UTF-8 bytes · ${result.message}`;
    status.className = result.valid ? 'note-status valid' : 'note-status invalid';
  };
  textarea.addEventListener('input', update);
  update();
  return { wrapper: node('div', { className: 'note-field' }, [node('label', { htmlFor: id, text: 'Required owner note' }), textarea, status]), textarea, status };
}
function noEffectList() {
  return node('ul', { className: 'no-effect-list' }, [
    node('li', { text: 'Records no durable decision in this static concept.' }),
    node('li', { text: 'Changes no queue lifecycle.' }),
    node('li', { text: 'Starts no application or source write.' }),
    node('li', { text: 'Creates no commit or push.' }),
    node('li', { text: 'Starts no rebuild, deployment, or publication.' }),
  ]);
}
function completeScope(fixture, className = 'complete-scope') {
  return node('section', { className }, [
    node('p', { className: 'scope-line', text: fixture.actualScope }),
    node('p', { className: 'atomic-scope', text: fixture.operations.length > 1 ? 'One atomic decision · partial approval unavailable' : 'One exact change' }),
    node('h3', { text: fixture.paths.length === 1 ? 'Affected page' : 'Affected pages' }),
    node('ul', { className: 'scope-paths' }, fixture.paths.map((path) => node('li', { text: `${path.path}${path.exists ? '' : ' · absent path'}` }))),
    node('h3', { text: fixture.operations.length === 1 ? 'Exact change' : 'Exact changes' }),
    node('ol', { className: 'scope-operations' }, fixture.operations.map((operation) => node('li', { text: `${operation.label} · ${operation.path}` }))),
  ]);
}
function actionButtons(fixture, noteField) {
  const approve = node('button', { type: 'button', className: 'button approve', text: 'Approve proposal' });
  const reject = node('button', { type: 'button', className: 'button reject', text: 'Reject proposal' });
  for (const [button, action] of [[approve, 'approve'], [reject, 'reject']]) {
    button.addEventListener('click', () => openConfirmation(fixture, action, noteField.value, button));
  }
  return node('div', { className: 'decision-actions' }, [approve, reject]);
}
function authorityPanel(fixture) {
  const axes = ['ownerDecision', 'exactBinding', 'applicationAuthority', 'applicationResult', 'deploymentObservation', 'publicationWitness'];
  const heading = fixture.operatingEvidence.ownerDecision.state === 'approved' ? 'Approval recorded in the illustrated history' : 'Illustrated authority history';
  return node('aside', { className: 'decision-rail authority-rail' }, [
    labelPair(fixture),
    node('p', { className: 'kicker', text: fixture.attentionLabel }),
    node('h2', { text: heading }),
    node('strong', { className: 'source-unchanged', text: 'Source unchanged' }),
    node('p', { text: 'This frame illustrates separate historical evidence axes. This static mockup recorded no decision and caused no effect.' }),
    node('dl', { className: 'authority-axes' }, axes.map((axis) => node('div', {}, [
      node('dt', { text: axis.replaceAll(/([A-Z])/gu, ' $1') }),
      node('dd', {}, [node('strong', { text: fixture.operatingEvidence[axis].state }), node('span', { text: fixture.operatingEvidence[axis].explanation })]),
    ]))),
    node('ul', { className: 'presentation-notes' }, fixture.presentationNotes.map((note) => node('li', { text: note }))),
  ]);
}
function blockedPanel(fixture) {
  const presentation = fixture.group === 'pre-admission'
    ? { title: 'Not admitted', statement: 'No queue proposal or owner decision exists' }
    : fixture.group === 'conceptual'
      ? { title: 'Conceptual only', statement: 'No decision is available by design' }
      : fixture.group === 'adversarial'
        ? { title: 'Evidence lab only', statement: 'No owner decision was recorded' }
        : { title: 'Decision unavailable', statement: 'No decision was recorded' };
  return node('aside', { className: 'decision-rail blocked-rail' }, [
    labelPair(fixture), node('p', { className: 'kicker', text: fixture.attentionLabel }), node('h2', { text: presentation.title }),
    node('p', { text: fixture.blocker ?? fixture.technical.executionBlockReason ?? 'This research evidence has no decision controls.' }),
    node('strong', { className: 'not-recorded', text: presentation.statement }),
    node('p', { className: 'scope-line', text: fixture.actualScope }),
  ]);
}
function decisionDock(fixture) {
  const field = ownerNote(fixture);
  const body = node('div', { id: 'dock-body', className: 'dock-body' }, [
    completeScope(fixture, 'dock-complete-scope'),
    field.wrapper,
    actionButtons(fixture, field.textarea),
    node('div', { className: 'boundary-copy' }, [node('strong', { text: 'Decision-only boundary' }), noEffectList()]),
  ]);
  body.hidden = !dockOpen;
  const toggle = node('button', {
    type: 'button',
    className: 'button dock-toggle',
    text: dockOpen ? 'Hide decision panel' : 'Decide this proposal',
    'aria-expanded': dockOpen ? 'true' : 'false',
    'aria-controls': 'dock-body',
  });
  toggle.addEventListener('click', () => {
    dockOpen = !dockOpen;
    renderReview(fixture, '.dock-toggle');
  });
  return node('aside', { className: dockOpen ? 'decision-dock open' : 'decision-dock', 'aria-label': 'Owner decision' }, [
    node('div', { className: 'dock-bar' }, [
      node('div', { className: 'dock-summary' }, [
        node('span', { className: 'dock-attention', text: 'Owner action required' }),
        node('strong', { className: 'scope-line', text: fixture.actualScope }),
        node('span', { className: 'dock-labels', text: `${fixture.supportLabel} · ${fixture.evidenceLabel}` }),
      ]),
      toggle,
    ]),
    body,
  ]);
}
function proposalIdentity(fixture) {
  const details = node('details', { className: 'identity-details' }, [
    node('summary', { text: 'Provenance and references' }),
    node('p', { text: fixture.identityDisclosure }),
    ...fixture.references.map((reference) => node('p', { className: 'reference-line' }, [
      node('span', { text: `${reference.label}: ` }),
      node('code', { text: reference.url }),
    ])),
  ]);
  return node('header', { className: 'proposal-identity' }, [
    node('p', { className: 'attention identity-attention', text: fixture.attentionLabel }),
    node('h1', { text: fixture.title }),
    node('p', { className: 'proposal-summary', text: fixture.summary }),
    node('p', { className: 'rationale-line', text: fixture.rationale }),
    node('div', { className: 'identity-meta' }, [
      node('strong', { text: fixture.actualScope }),
      node('span', { text: fixture.category }),
      node('span', { text: fixture.titleProvenance }),
      node('span', { className: 'support-label', text: fixture.supportLabel }),
      node('span', { className: 'evidence-label', text: fixture.evidenceLabel }),
    ]),
    details,
  ]);
}
function renderReview(fixture, focusSelector = null) {
  activeFixture = fixture;
  activeOperation = Math.min(activeOperation, fixture.operations.length - 1);
  highlightActiveChange = fixture.operations.length > 1;
  const mode = MODES.find((item) => item.key === activeMode) ?? MODES[0];
  const operation = fixture.operations[activeOperation];
  const panel = node('section', {
    id: 'mode-panel',
    className: `mode-panel mode-panel-${mode.key}`,
    role: 'tabpanel',
    'aria-labelledby': `mode-tab-${mode.key}`,
    tabindex: '0',
  }, [mode.key === 'compare' ? comparePanes(fixture) : readingPanel(fixture, mode)]);

  const multiple = fixture.operations.length > 1;
  const reader = node('section', {
    className: 'reader',
    ...(multiple ? { 'aria-labelledby': 'comparison-title' } : { 'aria-label': 'Proposed change' }),
  }, [
    ...(multiple ? [node('div', { className: 'change-bar' }, [
      node('p', { className: 'kicker', text: `Change ${activeOperation + 1} of ${fixture.operations.length}` }),
      node('h2', { id: 'comparison-title', text: operation.label }),
      node('span', { className: 'atomic-copy', text: 'One atomic decision · partial approval unavailable' }),
    ])] : []),
    operationNavigator(fixture),
    modeTabs(fixture),
    node('div', { className: 'reader-controls' }, [
      markLegend(),
      node('p', {
        className: 'projection-note',
        text: renderedReading
          ? 'Approximate reading projection. Changed passages always show exact source. This is not the published site rendering.'
          : 'Markdown source at reading width.',
      }),
      readerToggles(),
    ]),
    panel,
    technicalDisclosure(fixture, operation),
  ]);

  if (fixture.operations.length > 1) {
    const previous = node('button', { type: 'button', className: 'button secondary', text: 'Previous', 'data-previous-operation': '' });
    const next = node('button', { type: 'button', className: 'button secondary', text: 'Next', 'data-next-operation': '' });
    previous.disabled = activeOperation === 0;
    next.disabled = activeOperation === fixture.operations.length - 1;
    previous.addEventListener('click', () => { activeOperation -= 1; renderReview(fixture, `[data-operation-index="${activeOperation}"]`); scrollToChange(activeOperation + 1); });
    next.addEventListener('click', () => { activeOperation += 1; renderReview(fixture, `[data-operation-index="${activeOperation}"]`); scrollToChange(activeOperation + 1); });
    reader.append(node('div', { className: 'previous-next' }, [previous, next]));
  }

  const canvas = node('article', { className: 'review-canvas' }, [link('← Back to inbox', '#inbox', 'back-link'), proposalIdentity(fixture), reader]);
  const page = node('div', { className: 'page page-review' }, [canvas]);
  if (fixture.supportLevel === 'authority-model-only') canvas.append(authorityPanel(fixture));
  else if (!fixture.decisionControls) canvas.append(blockedPanel(fixture));
  else page.append(decisionDock(fixture));
  app.replaceChildren(page);
  const dock = page.querySelector('.decision-dock');
  page.style.paddingBottom = dock ? `${dock.offsetHeight + 48}px` : '';

  if (fixture.decisionControls) {
    mobileBar.hidden = false;
    mobileButton.textContent = `${fixture.operations.length} ${fixture.operations.length === 1 ? 'change' : 'changes'} · Decide`;
  } else mobileBar.hidden = true;
  if (focusSelector) app.querySelector(focusSelector)?.focus({ preventScroll: true });
  else if (restoreModeFocus) app.querySelector('.mode-tab.active')?.focus({ preventScroll: true });
  restoreModeFocus = false;
}

function confirmationCopy(fixture, action, note) {
  return node('div', { className: 'confirmation-copy' }, [
    labelPair(fixture), node('p', { className: 'confirmation-title-copy', text: fixture.title }),
    completeScope(fixture, 'confirmation-complete-scope'),
    node('dl', { className: 'confirmation-scope' }, [node('div', {}, [node('dt', { text: 'Owner note' }), node('dd', { text: note })])]),
    node('section', {}, [node('h3', { text: 'This records' }), node('p', { text: action === 'approve' ? 'An in-memory preview of approval intent.' : 'An in-memory preview of rejection intent.' })]),
    node('section', {}, [node('h3', { text: 'Source unchanged · this does not start' }), noEffectList()]),
  ]);
}
function openConfirmation(fixture, action, note, trigger) {
  const result = noteValidation(note);
  if (!result.valid) {
    const field = trigger.closest('.decision-dock, .decision-rail, .dialog-shell')?.querySelector('textarea');
    if (field) field.focus();
    return;
  }
  pendingAction = { fixture, action, note };
  returnFocus = trigger;
  confirmationKicker.textContent = action === 'approve' ? 'Approve proposal' : 'Reject proposal';
  confirmationTitle.textContent = action === 'approve' ? 'Confirm approval' : 'Confirm rejection';
  confirmationBody.replaceChildren(confirmationCopy(fixture, action, note));
  confirmPreview.textContent = action === 'approve' ? 'Confirm approval' : 'Confirm rejection';
  confirmPreview.className = action === 'approve' ? 'button approve' : 'button reject';
  if (decisionSheet.open) decisionSheet.close();
  confirmation.showModal();
  confirmPreview.focus();
}
function createReceipt() {
  if (!pendingAction) return;
  const { fixture, action, note } = pendingAction;
  receipts.unshift({
    kind: 'Private proposal decision receipt', result: action === 'approve' ? 'Approval recorded' : 'Proposal rejected', action, note,
    decidedAt: 'Preview time · not recorded', title: fixture.title, actualScope: fixture.actualScope,
    atomicity: fixture.operations.length > 1 ? 'One atomic decision · partial approval unavailable' : 'One exact change',
    paths: fixture.paths, operations: fixture.operations.map(({ number, label, path }) => ({ number, label, path })),
    supportLabel: fixture.supportLabel, evidenceLabel: fixture.evidenceLabel,
    sourceState: 'Source unchanged', noEffect: 'No application requested or started. No source write, commit, push, rebuild, deployment, or publication began. Queue lifecycle was not changed.',
    previewOnly: 'In-memory static receipt preview. Reloading removes it.',
  });
  confirmation.close();
  pendingAction = null;
  location.hash = 'receipts';
}
function receiptCard(receipt) {
  return node('article', { className: `receipt receipt-${receipt.action}` }, [
    node('p', { className: 'kicker', text: receipt.kind }), labelPair({ supportLevel: '', supportLabel: receipt.supportLabel, evidenceClass: '', evidenceLabel: receipt.evidenceLabel }),
    node('h2', { text: receipt.result }), node('blockquote', { text: receipt.note }), node('p', { className: 'receipt-time', text: receipt.decidedAt }),
    node('h3', { text: receipt.title }), node('p', { text: receipt.actualScope }), node('p', { className: 'atomic-scope', text: receipt.atomicity }),
    node('h4', { text: receipt.paths.length === 1 ? 'Affected page' : 'Affected pages' }),
    node('ul', { className: 'scope-paths' }, receipt.paths.map((path) => node('li', { text: path.path }))),
    node('h4', { text: receipt.operations.length === 1 ? 'Exact change' : 'Exact changes' }),
    node('ol', { className: 'scope-operations' }, receipt.operations.map((operation) => node('li', { text: `${operation.label} · ${operation.path}` }))),
    node('strong', { className: 'source-unchanged', text: receipt.sourceState }), node('p', { text: receipt.noEffect }), node('p', { className: 'preview-only', text: receipt.previewOnly }),
  ]);
}
function renderReceipts() {
  activeFixture = null; mobileBar.hidden = true;
  const content = receipts.length === 0
    ? node('div', { className: 'empty-receipts' }, [node('h2', { text: 'No decisions previewed yet' }), node('p', { text: 'Open a ready proposal, write a bounded note, choose an action, and confirm the preview. No server request or durable decision occurs.' }), link('Open the proposal inbox', '#inbox', 'button-link')])
    : node('div', { className: 'receipt-list' }, receipts.map(receiptCard));
  app.replaceChildren(node('div', { className: 'page' }, [pageHeader('Decisions', 'What a recorded decision looks like', 'A decision is a durable record of what you chose and why. It never starts a change by itself. Newest previews appear first, and reloading clears them.'), content]));
}
function renderSystem() {
  activeFixture = null; mobileBar.hidden = true;
  const detail = node('article', { id: 'system-frame-detail', className: 'system-frame-detail', tabindex: '-1' });
  const buttons = [];
  const showFrame = (frame) => {
    for (const button of buttons) {
      const selected = button.getAttribute('data-system-frame') === String(frame.number);
      button.classList.toggle('active', selected);
      if (selected) button.setAttribute('aria-current', 'step');
      else button.removeAttribute('aria-current');
    }
    detail.className = `system-frame-detail ${frame.number === 6 ? 'missing' : ''}`;
    detail.replaceChildren(
      node('p', { className: 'kicker', text: `Boundary ${frame.number} of ${model.systemFrames.length}` }),
      node('h2', { text: frame.title }),
      node('p', { className: 'system-status', text: frame.status }),
      node('dl', {}, [
        node('div', {}, [node('dt', { text: 'Owner' }), node('dd', { text: frame.owner })]),
        node('div', {}, [node('dt', { text: 'Runs' }), node('dd', { text: frame.runs })]),
        node('div', {}, [node('dt', { text: 'Authority' }), node('dd', { text: frame.authority })]),
        node('div', {}, [node('dt', { text: 'Evidence' }), node('dd', { text: frame.evidence })]),
      ]),
    );
  };
  const frameNav = node('nav', { className: 'system-frame-nav', 'aria-label': 'System boundaries' });
  for (const frame of model.systemFrames) {
    const button = node('button', { type: 'button', className: 'system-frame-button', 'data-system-frame': String(frame.number), 'aria-controls': 'system-frame-detail' }, [
      node('span', { className: 'frame-number', text: String(frame.number) }),
      node('span', { className: 'frame-button-copy' }, [node('strong', { text: frame.title }), node('small', { text: frame.status })]),
    ]);
    button.addEventListener('click', () => showFrame(frame));
    buttons.push(button);
    frameNav.append(button);
  }
  showFrame(model.systemFrames[0]);
  app.replaceChildren(node('div', { className: 'page page-system' }, [
    pageHeader('How this works', 'Where a proposal goes, and where it stops', 'Each step below is a separate boundary rather than one automatic pipeline. Select a step to see who owns it, where it runs, what it may decide, and what it cannot do.'),
    node('div', { className: 'system-labels' }, [node('span', { text: 'Target capability' }), node('span', { text: 'Static design only' })]),
    node('div', { className: 'system-walkthrough' }, [frameNav, detail]),
  ]));
}
function renderEvidence() {
  activeFixture = null; mobileBar.hidden = true;
  app.replaceChildren(node('div', { className: 'page page-evidence' }, [
    pageHeader('What the labels mean', 'Every label is a limit on what may be claimed', 'Each label says how far the evidence behind a screen actually goes. Examples that never reached the queue, later ideas, and deliberate failure cases live here instead of appearing as proposals waiting for you.'),
    node('div', { className: 'legend-list' }, model.evidenceLegend.map((item) => node('section', {}, [node('h2', { text: item.label }), node('code', { text: item.key }), node('p', { text: item.claim })]))),
    node('section', { className: 'accessibility-note' }, [node('h2', { text: 'Accessibility and evidence behavior' }), node('ul', {}, ['DOM and screen-reader order is Current then Proposed.', 'Color is reinforced by labels, rules, operation-specific semantics, and del/ins markup.', 'Focus returns after dialog cancellation; Escape closes modal previews.', 'Reduced motion disables nonessential transitions.', 'Technical evidence scrolls internally, bidi controls are exposed as named code points, and mobile touch targets are at least 44px.'].map((item) => node('li', { text: item }))) ]),
    renderInboxGroup('Conceptual later examples', 'Multi-file and new-file research with no artifact, queue evidence, decision, or application controls.', model.evidenceGroups.conceptual),
    renderInboxGroup('Failed before admission', 'Ambiguous, malformed, credential-like, no-op, whole-file, and invalid-boundary cases. No queue item exists.', model.evidenceGroups.preAdmission),
    renderInboxGroup('Adversarial evidence', 'Static rendering, containment, reference, identity, and stale-application checks that are not owner proposals.', model.evidenceGroups.adversarial),
  ]));
}
function renderCheckpoint() {
  activeFixture = null; mobileBar.hidden = true;
  app.replaceChildren(node('div', { className: 'page' }, [pageHeader('Questions for you', 'Only a person can answer these', 'Read the surface without help and answer in your own words. No test or screenshot can settle these.'), node('ol', { className: 'checkpoint-list' }, model.checkpointQuestions.map((question) => node('li', { text: question }))), node('aside', { className: 'checkpoint-boundary' }, [node('strong', { text: 'Waiting on your answers' }), node('p', { text: 'Green tests and screenshots remain necessary, but they cannot establish maintainer comprehension, independent-human usability, or live-effect evidence.' })])]));
}
function openDecisionSheet(fixture, trigger) {
  returnFocus = trigger;
  decisionSheetProposal.textContent = fixture.title;
  const field = ownerNote(fixture, '-sheet');
  decisionSheetBody.replaceChildren(labelPair(fixture), completeScope(fixture, 'sheet-complete-scope'), field.wrapper, actionButtons(fixture, field.textarea), node('div', { className: 'boundary-copy' }, [node('strong', { text: 'Static/no-effect boundary' }), noEffectList()]));
  decisionSheet.showModal();
  field.textarea.focus();
}
function route() {
  const value = location.hash.slice(1) || 'inbox';
  if (value.startsWith('review/')) {
    const [rawId, rawMode] = value.slice('review/'.length).split('/');
    const fixture = fixtureById(decodeURIComponent(rawId));
    if (fixture) {
      if (activeFixture?.id !== fixture.id) { activeOperation = 0; dockOpen = false; }
      activeMode = modeFor(rawMode);
      renderReview(fixture);
    } else renderInbox();
  } else if (value === 'receipts') renderReceipts();
  else if (value === 'system') renderSystem();
  else if (value === 'evidence') renderEvidence();
  else if (value === 'checkpoint') renderCheckpoint();
  else renderInbox();
  if (!app.contains(document.activeElement)) app.focus({ preventScroll: true });
}

mobileButton.addEventListener('click', () => { if (activeFixture?.decisionControls) openDecisionSheet(activeFixture, mobileButton); });
closeDecisionSheet.addEventListener('click', () => decisionSheet.close());
cancelConfirmation.addEventListener('click', () => confirmation.close());
confirmPreview.addEventListener('click', createReceipt);
for (const dialog of [confirmation, decisionSheet]) {
  dialog.addEventListener('close', () => { if (returnFocus?.isConnected) returnFocus.focus(); });
}
window.addEventListener('hashchange', route);
route();

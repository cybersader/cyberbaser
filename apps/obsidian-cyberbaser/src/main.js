// Cyberbaser for Obsidian: pair this device with your Cyberbaser node, see
// whether the open note is live, and send it for review or publish it.
// Talks only to your paired node, through Iroh. No analytics, no telemetry.
import { MarkdownView, Modal, Notice, Platform, Plugin, PluginSettingTab, Setting, debounce, setIcon } from 'obsidian';
import { lazyCarrier } from './carrier.js';
import { createNodeClient, NodeError } from './core/client.js';
import { createController, DEFAULT_SETTINGS, messageFor, publicSettings } from './core/controller.js';
import { draftPublishPlan, embeddedImages, notePublicStatus, prepareImages, withDraftOn } from './core/new-page.js';
import { createPublishTracker, failureWords, IN_FLIGHT, LIVE_SHOWN_MS, markFor, statusBarState, viewSteps } from './core/progress.js';
import { todayString } from './core/new-note.js';
import { firstPublishFields } from './core/site-model.js';
import { createDeviceStore, indexedDbBackend } from './core/device-store.js';
import { codeFromLink, PAIR_LINK_ACTION } from './core/pairing-code.js';
import { createSigningStore, ENROL_LINK_ACTION, signingDatabase, siteName } from './core/signing.js';
import { approvalHeading, renderPages, showsPages } from './core/approval-sheet.js';
import { describeStatus, STATUS, statusFor, textDigests } from './core/status.js';
import { ModelProblemsModal, NewPostModal, readSiteModel } from './new-post.js';

// The quiet note mark: [icon, label]. Shown only when the note needs something.
const MARKS = Object.freeze({
  older: ['upload', 'Unpublished changes. Click to send or publish.'],
  draft: ['pencil', 'Draft. Click to publish.'],
  queued: ['wifi-off', "Will send when you're back online"],
  waiting: ['clock', 'Waiting for approval'],
  publishing: ['loader', 'Publishing'],
  attention: ['alert-circle', 'Needs attention'],
});

const GRANT_WORDS = Object.freeze({ propose: 'send changes for review', publish: 'publish', publication: 'see what is live' });

function describeGrants(grants) {
  const words = grants.map((grant) => GRANT_WORDS[grant]).filter(Boolean);
  return words.length === 0 ? 'nothing yet' : words.join(', ');
}

class PairModal extends Modal {
  constructor(plugin, code = '') {
    super(plugin.app);
    this.plugin = plugin;
    this.code = code;
  }

  onOpen() {
    const { contentEl } = this;
    this.modalEl.addClass('cyberbaser-modal');
    this.setTitle?.('Pair with your Cyberbaser node');
    contentEl.createEl('p', { text: 'On your node, open Devices, start a pairing, and paste the code here.' });
    const input = contentEl.createEl('textarea', { cls: 'cyberbaser-code', attr: { rows: '3', placeholder: 'cb1.…', 'aria-label': 'Pairing code' } });
    input.value = this.code;
    const words = contentEl.createDiv({ cls: 'cyberbaser-words' });
    const message = contentEl.createEl('p', { cls: 'cyberbaser-message' });
    const button = contentEl.createEl('button', { text: 'Pair', cls: 'mod-cta cyberbaser-pair-button' });
    // One handler for Pair; once paired, the same button closes the dialog and
    // must not pair again (the code is spent, and a second request is refused).
    const pair = async () => {
      button.disabled = true;
      input.disabled = true;
      message.setText('Connecting to your node…');
      try {
        const result = await this.plugin.controller.pair(input.value, { onWords: (list) => {
          words.empty();
          words.createEl('p', { text: 'Check that your node shows the same four words:' });
          words.createDiv({ cls: 'cyberbaser-word-list', text: list.join(' · ') });
          message.setText("Then tap Confirm on your node's Devices page. Waiting…");
        } });
        words.empty();
        message.setText(`Paired. This device can ${describeGrants(result.grants)}.`);
        button.removeEventListener('click', pair);
        button.addEventListener('click', () => this.close());
        button.setText('Done');
        button.disabled = false;
        this.plugin.refreshStatus(true);
      } catch (error) {
        words.empty();
        message.setText(messageFor(error));
        button.disabled = false;
        input.disabled = false;
      }
    };
    button.addEventListener('click', pair);
  }

  onClose() { this.contentEl.empty(); }
}

class SendModal extends Modal {
  constructor(plugin, view) {
    super(plugin.app);
    this.plugin = plugin;
    this.view = view;
  }

  async onOpen() {
    const { contentEl } = this;
    this.modalEl.addClass('cyberbaser-modal');
    this.setTitle?.('Send to Cyberbaser');
    const file = this.view.file;
    contentEl.createEl('p', { cls: 'cyberbaser-path', text: file.path });
    const statusLine = contentEl.createEl('p', { cls: 'cyberbaser-status-line', text: `Status: ${STATUS.checking}` });
    const actions = contentEl.createDiv({ cls: 'cyberbaser-actions' });
    const result = contentEl.createEl('p', { cls: 'cyberbaser-result' });
    if (!(await this.plugin.controller.paired())) {
      statusLine.setText(`Status: ${STATUS.notPaired}`);
      actions.createEl('button', { text: 'Pair with your Cyberbaser node', cls: 'mod-cta' })
        .addEventListener('click', () => { this.close(); new PairModal(this.plugin).open(); });
      return;
    }
    const { status, reply } = await this.plugin.refreshStatus(true, { force: true });
    statusLine.setText(`Status: ${status.label}`);
    const run = async (button, action) => {
      for (const element of actions.querySelectorAll('button')) element.disabled = true;
      result.setText('Sending…');
      try {
        const outcome = await action(file, this.view.editor.getValue());
        result.setText(outcome.text);
        if (outcome.kind === 'publishing') {
          this.plugin.watchPublication();
          this.plugin.offerWaitingApproval(this);
        }
      } catch (error) {
        result.setText(messageFor(error));
        for (const element of actions.querySelectorAll('button')) element.disabled = false;
      }
    };
    // A note the site does not have yet: list its images (cleaned of where
    // they were taken, checked) before anything is sent.
    const publishYml = await this.plugin.readPublishYml();
    const siteYml = await this.plugin.readSiteYml();
    const text = this.view.editor.getValue();
    const local = publishYml === null ? null : notePublicStatus({ path: file.path, text, publishYml, siteYml });
    // First-publish dates (site model `default: first-publish`) are filled in
    // inside the change you approve, like Draft off.
    const stamps = await this.plugin.firstPublishStamps(file.path);
    // A draft: Publish turns Draft off inside the change you approve.
    const draft = local?.draft && !reply?.live ? draftPublishPlan({ path: file.path, text, publishYml, siteYml, stamps }) : null;
    const newPage = local?.published && !reply?.live ? local : draft?.status ?? null;
    if (newPage) {
      const { local: paths, remote } = embeddedImages({ path: file.path, text,
        resolve: (target, from) => this.plugin.app.metadataCache.getFirstLinkpathDest(target, from)?.path ?? null,
        exists: (path) => typeof this.plugin.app.vault.getAbstractFileByPath(path)?.extension === 'string' });
      const images = prepareImages(await Promise.all(paths.map(async (path) => ({ path,
        bytes: new Uint8Array(await this.plugin.app.vault.adapter.readBinary(path)) }))));
      const list = contentEl.createEl('ul', { cls: 'cyberbaser-images' });
      for (const image of images) {
        const size = `${Math.max(1, Math.round(image.size / 1024))} KB`;
        const note = image.refused ? messageFor(Object.assign(new Error(), { kind: 'refused', reason: image.refused }))
          : image.cleaned ? 'location removed' : '';
        list.createEl('li', { text: `${image.path} (${image.type ?? 'not allowed'}, ${size})${note ? `: ${note}` : ''}` });
      }
      for (const raw of remote) list.createEl('li', { cls: 'cyberbaser-warning', text: `${raw}: from another site, not allowed` });
      contentEl.createEl('p', { cls: 'cyberbaser-muted', text: `New public page: ${newPage.address}${images.length ? `, plus ${images.length} image${images.length === 1 ? '' : 's'}` : ''}` });
      if (draft) contentEl.createEl('p', { cls: 'cyberbaser-muted', text: 'Turns Draft off and sends it for your approval. Nothing goes live until you approve.' });
      // The sheet becomes the checklist; closing it never stops anything.
      const publish = actions.createEl('button', { text: draft ? 'Publish to your site' : 'Publish new page', cls: 'mod-cta' });
      publish.addEventListener('click', () => {
        const { item } = this.plugin.startPublish(file);
        this.setTitle?.('Publishing');
        contentEl.empty();
        this.progress = this.plugin.openProgressIn(contentEl, [item.id]);
        this.plugin.afterPublish(this, item);
      });
    } else if (local?.draft) {
      contentEl.createEl('p', { cls: 'cyberbaser-muted', text: 'Draft: turn Draft off in its properties to publish it.' });
    }
    if (this.plugin.controller.canPublish(reply)) {
      const publish = actions.createEl('button', { text: 'Publish to your site', cls: 'mod-cta' });
      publish.addEventListener('click', () => run(publish, (f, text) => this.plugin.controller.publish(f, text, reply)));
    }
    const propose = actions.createEl('button', { text: 'Send for review', cls: this.plugin.controller.canPublish(reply) ? '' : 'mod-cta' });
    propose.addEventListener('click', () => run(propose, (f, text) => this.plugin.controller.propose(f, text)));
  }

  onClose() { this.progress?.close(); this.contentEl.empty(); }
}

// The full status of one note, only when the owner asks for it.
class StatusModal extends Modal {
  constructor(plugin, view) {
    super(plugin.app);
    this.plugin = plugin;
    this.view = view;
  }

  async onOpen() {
    const { contentEl } = this;
    this.modalEl.addClass('cyberbaser-modal', 'cyberbaser-status-modal');
    this.setTitle?.('Cyberbaser status');
    contentEl.createEl('p', { cls: 'cyberbaser-path', text: this.view.file.path });
    const line = contentEl.createEl('p', { cls: 'cyberbaser-status-sentence', text: `${STATUS.checking}…` });
    const { status } = await this.plugin.refreshStatus(true, { force: true });
    line.setText(describeStatus(status) || STATUS.checking);
    const actions = contentEl.createDiv({ cls: 'cyberbaser-actions' });
    if (status.key === 'notPaired') {
      actions.createEl('button', { text: 'Pair with your Cyberbaser node', cls: 'mod-cta' })
        .addEventListener('click', () => { this.close(); new PairModal(this.plugin).open(); });
    } else if (status.key !== 'unreachable') {
      actions.createEl('button', { text: 'Send or publish…' })
        .addEventListener('click', () => { this.close(); new SendModal(this.plugin, this.view).open(); });
    }
  }

  onClose() { this.contentEl.empty(); }
}

// ---- After Publish: a short checklist, reopened from the status bar ----

const STEP_ICONS = Object.freeze({ done: 'check', failed: 'x', queued: 'wifi-off', todo: null });

// Draws every post on its way (or only ids) into container and keeps it up to
// date while it is open. Returns { close }.
function progressView(plugin, container, ids = null) {
  const root = container.createDiv({ cls: 'cyberbaser-progress-view' });
  const draw = () => {
    root.empty();
    const items = plugin.tracker.items().filter((item) => (ids === null ? !item.dismissed : ids.includes(item.id)));
    if (items.length === 0) { root.createEl('p', { cls: 'cyberbaser-muted', text: 'Nothing is on its way.' }); return; }
    for (const item of items) {
      const box = root.createDiv({ cls: 'cyberbaser-progress-item' });
      box.dataset.step = item.step;
      if (items.length > 1 || ids === null) box.createDiv({ cls: 'cyberbaser-progress-title', text: item.title });
      const list = box.createEl('ul', { cls: 'cyberbaser-steps' });
      for (const step of viewSteps(item, { canSign: plugin.signingEnrolled, site: plugin.siteLabel(item) })) {
        const li = list.createEl('li', { cls: `cyberbaser-step is-${step.state}` });
        const mark = li.createSpan({ cls: 'cyberbaser-step-mark' });
        if (step.state === 'current') mark.createSpan({ cls: 'cyberbaser-spinner', attr: { 'aria-label': 'In progress' } });
        else if (STEP_ICONS[step.state]) setIcon(mark, STEP_ICONS[step.state]);
        const words = li.createDiv({ cls: 'cyberbaser-step-words' });
        words.createDiv({ cls: 'cyberbaser-step-label', text: step.label });
        if (step.detail) words.createDiv({ cls: 'cyberbaser-step-detail', text: step.detail });
      }
      const actions = box.createDiv({ cls: 'cyberbaser-actions' });
      const url = item.pages?.find((page) => page.path === item.path)?.url ?? item.pages?.[0]?.url ?? null;
      if (item.step === 'failed' || item.step === 'declined') {
        const words = failureWords(item.step === 'declined' ? 'declined' : item.reason);
        box.insertBefore(box.createEl('p', { cls: 'cyberbaser-progress-error', text: item.message ?? words.text }), actions);
        const again = actions.createEl('button', { text: words.action === 'check' ? 'Check again' : 'Try again', cls: 'mod-cta' });
        again.addEventListener('click', () => (words.action === 'check' ? plugin.pollNow() : plugin.retryPublish(item.id)));
        actions.createEl('button', { text: 'Dismiss' }).addEventListener('click', () => plugin.tracker.dismiss(item.id));
        const details = box.createEl('details', { cls: 'cyberbaser-exact' });
        details.createEl('summary', { text: 'Details' });
        details.createEl('pre', { cls: 'cyberbaser-exact-text', text: words.detail });
      } else if (item.step === 'live' && url) {
        actions.createEl('button', { text: 'View on site', cls: 'mod-cta' }).addEventListener('click', () => window.open(url));
        actions.createEl('button', { text: 'Copy link' }).addEventListener('click', async () => {
          await navigator.clipboard?.writeText(url);
          new Notice('Link copied.');
        });
      } else if (item.step === 'withdrawn') {
        box.createEl('p', { cls: 'cyberbaser-muted', text: 'Withdrawn. Your post is a draft again.' });
      } else if (['queued', 'waiting', 'review'].includes(item.step)) {
        if (item.step === 'waiting' && plugin.signingEnrolled) {
          actions.createEl('button', { text: 'Approve now', cls: 'mod-cta' }).addEventListener('click', () => new ApprovalsModal(plugin).open());
        }
        actions.createEl('button', { text: 'Withdraw', cls: 'cyberbaser-withdraw' }).addEventListener('click', () => plugin.withdrawPublish(item.id));
      }
      if (actions.childElementCount === 0) actions.remove();
    }
  };
  draw();
  plugin.views.add(draw);
  plugin.pollSoon();
  return { close: () => plugin.views.delete(draw) };
}

class ProgressModal extends Modal {
  constructor(plugin, ids = null) {
    super(plugin.app);
    this.plugin = plugin;
    this.ids = ids;
  }

  onOpen() {
    this.modalEl.addClass('cyberbaser-modal', 'cyberbaser-progress');
    this.setTitle?.('Publishing');
    this.view = progressView(this.plugin, this.contentEl, this.ids);
  }

  onClose() { this.view?.close(); this.contentEl.empty(); }
}

// ---- Approving publishes with this device's own key ----

// Set this device up as one that approves publishing, from the code the
// installer shows (scanned as an obsidian:// link, or pasted).
class EnrolModal extends Modal {
  constructor(plugin, code = '') {
    super(plugin.app);
    this.plugin = plugin;
    this.code = code;
  }

  onOpen() {
    const { contentEl } = this;
    this.modalEl.addClass('cyberbaser-modal', 'cyberbaser-enrol');
    this.setTitle?.('Approve publishing here');
    contentEl.createEl('p', { text: 'Scan or paste the one-time code your Cyberbaser installer shows. After this, nothing is published until you approve it here.' });
    const input = contentEl.createEl('textarea', { cls: 'cyberbaser-code', attr: { rows: '3', placeholder: 'cyberbaser-enroll:v1?…', 'aria-label': 'Code from the installer' } });
    input.value = this.code;
    const nameRow = contentEl.createDiv({ cls: 'cyberbaser-field' });
    nameRow.createEl('label', { text: 'Name for this device', attr: { for: 'cyberbaser-device-name' } });
    const name = nameRow.createEl('input', { type: 'text', attr: { id: 'cyberbaser-device-name', maxlength: '64', autocomplete: 'off' } });
    name.value = Platform.isMobile ? 'Phone' : 'This computer';
    const message = contentEl.createEl('p', { cls: 'cyberbaser-message', attr: { role: 'status' } });
    const button = contentEl.createEl('button', { text: 'Set up approvals', cls: 'mod-cta cyberbaser-enrol-button' });
    const run = async (event) => {
      button.disabled = true;
      input.disabled = true;
      name.disabled = true;
      message.setText('Asking your publisher…');
      try {
        const result = await this.plugin.controller.enrol(input.value, { label: name.value, tap: event });
        this.plugin.signingEnrolled = true;
        contentEl.empty();
        contentEl.createEl('p', { text: `Done. ${result.label} now approves your publishes.` });
        contentEl.createEl('p', { cls: 'cyberbaser-muted', text: 'Your installer shows the same four groups:' });
        contentEl.createDiv({ cls: 'cyberbaser-fingerprint', text: result.fingerprint });
        contentEl.createEl('p', { cls: 'cyberbaser-muted', text: 'If they differ, remove this device on your node and ask for a new code.' });
        const done = contentEl.createEl('button', { text: 'Done', cls: 'mod-cta cyberbaser-enrol-done' });
        done.addEventListener('click', () => this.close());
      } catch (error) {
        message.setText(messageFor(error));
        button.disabled = false;
        input.disabled = false;
        name.disabled = false;
      }
    };
    button.addEventListener('click', run);
  }

  onClose() { this.contentEl.empty(); }
}

function renderPreview(container, file) {
  const block = container.createDiv({ cls: 'cyberbaser-change' });
  const head = block.createDiv({ cls: 'cyberbaser-change-head' });
  head.createEl('strong', { cls: 'cyberbaser-change-title', text: file.title });
  head.createSpan({ cls: 'cyberbaser-change-kind', text: file.image ? 'New image' : { edited: 'Edited', added: 'New note', deleted: 'Deleted' }[file.kind] });
  block.createDiv({ cls: 'cyberbaser-path', text: file.path });
  if (file.image) {
    block.createEl('p', { cls: 'cyberbaser-muted', text: `Image, ${Math.max(1, Math.round(file.byteLength / 1024))} KB, checked on this device.` });
  } else if (file.preview === null) {
    block.createEl('p', { cls: 'cyberbaser-muted', text: 'This file is not text, so its words cannot be shown.' });
  } else if (file.kind === 'deleted') {
    block.createEl('p', { cls: 'cyberbaser-muted', text: 'The whole note is removed.' });
  } else {
    const words = block.createDiv({ cls: 'cyberbaser-words-preview', attr: { 'aria-label': 'What changes' } });
    for (const part of file.preview) {
      if (part.kind === 'removed') words.createEl('del', { text: part.text });
      else if (part.kind === 'added') words.createEl('ins', { text: part.text });
      else if (part.kind === 'gap') words.createSpan({ cls: 'cyberbaser-gap', text: ' … ' });
      else words.appendText(part.text);
    }
  }
  if (file.modeChanged) block.createEl('p', { cls: 'cyberbaser-muted', text: 'Also changes whether the file can run.' });
}

// One publish to approve. Everything shown is built by this plugin from the
// signed intent and bytes it hashed itself; the buttons sign or decline.
class ApprovalModal extends Modal {
  constructor(plugin, requestId) {
    super(plugin.app);
    this.plugin = plugin;
    this.requestId = requestId;
  }

  async onOpen() {
    const { contentEl } = this;
    this.modalEl.addClass('cyberbaser-modal', 'cyberbaser-approval');
    this.setTitle?.('Approve publishing?');
    this.urls = [];
    const message = contentEl.createEl('p', { cls: 'cyberbaser-message', text: 'Checking the change…', attr: { role: 'status' } });
    let prepared;
    try {
      prepared = await this.plugin.controller.readApproval(this.requestId, { publishYml: await this.plugin.readPublishYml(),
        siteYml: await this.plugin.readSiteYml() });
    } catch (error) {
      message.setText(messageFor(error));
      return;
    }
    message.remove();
    const { summary } = prepared;
    const count = summary.files.length;
    this.setTitle?.(`${approvalHeading(summary)}?`);
    const lead = contentEl.createDiv({ cls: 'cyberbaser-approval-lead' });
    if (summary.changesBuild) contentEl.createEl('p', { cls: 'cyberbaser-warning', text: 'This changes how your site is built.' });
    if (showsPages(summary)) {
      // New pages: what each will look like, all read from the bytes being signed.
      lead.createEl('p', { cls: 'cyberbaser-approval-what', text: summary.counts });
      renderPages(contentEl, summary, { imageUrl: (bytes, type) => this.imageUrl(bytes, type) });
    } else {
      lead.createEl('p', { cls: 'cyberbaser-approval-what', text: count === 1 ? '1 change' : `${count} changes` });
      // A separate line for what becomes public: worked out on this device.
      for (const page of summary.newPages ?? []) {
        contentEl.createEl('p', { cls: 'cyberbaser-warning', text: `New public page: ${page.address}${summary.newImages ? `, plus ${summary.newImages} image${summary.newImages === 1 ? '' : 's'}` : ''}` });
      }
      const list = contentEl.createDiv({ cls: 'cyberbaser-changes' });
      for (const file of summary.files) renderPreview(list, file);
    }
    const minutes = Math.max(1, Math.round((summary.expiresAt - Date.now()) / 60_000));
    const actions = contentEl.createDiv({ cls: 'cyberbaser-actions cyberbaser-approval-actions' });
    const approve = actions.createEl('button', { text: 'Approve and publish', cls: 'mod-cta cyberbaser-approve' });
    const decline = actions.createEl('button', { text: 'Not now', cls: 'cyberbaser-decline' });
    const result = contentEl.createEl('p', { cls: 'cyberbaser-result', attr: { role: 'status' } });
    contentEl.createEl('p', { cls: 'cyberbaser-footnote', text: `Approved with this device's own key. Open for about ${minutes} min.` });
    const busy = (value) => { approve.disabled = value; decline.disabled = value; };
    // The click event itself is the proof of a tap; scripts cannot make one.
    approve.addEventListener('click', async (event) => {
      busy(true);
      result.setText('Approving…');
      try {
        await this.plugin.controller.approve(prepared, event);
        result.setText('Approved. Your node is publishing it now.');
        actions.empty();
        actions.createEl('button', { text: 'Done', cls: 'mod-cta' }).addEventListener('click', () => this.close());
      } catch (error) {
        result.setText(messageFor(error));
        busy(false);
      }
    });
    decline.addEventListener('click', async () => {
      busy(true);
      try {
        await this.plugin.controller.decline(this.requestId);
        result.setText('Not published. Nothing was signed.');
        actions.empty();
        actions.createEl('button', { text: 'Done' }).addEventListener('click', () => this.close());
      } catch (error) {
        result.setText(messageFor(error));
        busy(false);
      }
    });
  }

  // A picture from the exact signed bytes, held in memory on this device.
  imageUrl(bytes, mediaType) {
    const url = URL.createObjectURL(new Blob([bytes], { type: mediaType }));
    this.urls.push(url);
    return url;
  }

  onClose() {
    for (const url of this.urls ?? []) URL.revokeObjectURL(url);
    this.urls = [];
    this.contentEl.empty();
  }
}

// What is waiting for this device's approval. Opened from the command palette
// or the note menu; nothing about it stands in the header.
class ApprovalsModal extends Modal {
  constructor(plugin) {
    super(plugin.app);
    this.plugin = plugin;
  }

  async onOpen() {
    const { contentEl } = this;
    this.modalEl.addClass('cyberbaser-modal');
    this.setTitle?.('Approvals waiting');
    const line = contentEl.createEl('p', { cls: 'cyberbaser-message', text: 'Asking your node…', attr: { role: 'status' } });
    if (!(await this.plugin.controller.signingDevice())) {
      line.setText('This device does not approve publishing yet.');
      contentEl.createEl('button', { text: 'Set up approvals…', cls: 'mod-cta' })
        .addEventListener('click', () => { this.close(); new EnrolModal(this.plugin).open(); });
      return;
    }
    let waiting;
    try { waiting = await this.plugin.controller.waitingApprovals(); } catch (error) { line.setText(messageFor(error)); return; }
    if (waiting.length === 0) { line.setText('Nothing is waiting.'); return; }
    line.setText(waiting.length === 1 ? 'One publish is waiting for you.' : `${waiting.length} publishes are waiting for you.`);
    const list = contentEl.createDiv({ cls: 'cyberbaser-actions cyberbaser-waiting' });
    waiting.forEach((entry, index) => {
      list.createEl('button', { text: waiting.length === 1 ? 'Review it' : `Review publish ${index + 1}` })
        .addEventListener('click', () => { this.close(); new ApprovalModal(this.plugin, entry.requestId).open(); });
    });
  }

  onClose() { this.contentEl.empty(); }
}

class CyberbaserSettingTab extends PluginSettingTab {
  constructor(plugin) {
    super(plugin.app, plugin);
    this.plugin = plugin;
  }

  async display() {
    const { containerEl } = this;
    containerEl.empty();
    const paired = await this.plugin.controller.paired();
    new Setting(containerEl)
      .setName(paired ? 'Paired with your Cyberbaser node' : 'Not paired')
      .setDesc(paired ? `This device can ${describeGrants(paired.grants)}.` : 'Pair this device to see what is live and send changes.')
      .addButton((button) => (paired
        ? button.setButtonText('Unpair').setWarning().onClick(async () => {
          await this.plugin.controller.unpair();
          new Notice('Unpaired. Also revoke this device on your node.');
          this.plugin.refreshStatus(true);
          this.display();
        })
        : button.setButtonText('Pair with your Cyberbaser node').setCta().onClick(() => new PairModal(this.plugin).open())));
    const signer = await this.plugin.controller.signingDevice();
    new Setting(containerEl)
      .setName(signer ? 'Approves publishing' : 'Does not approve publishing')
      .setDesc(signer ? `${signer.label}, key ${signer.fingerprint}. Every publish waits for your approval here or on another device.`
        : 'Set up with the one-time code your Cyberbaser installer shows.')
      .addButton((button) => (signer
        ? button.setButtonText('Stop approving here').onClick(async () => {
          await this.plugin.controller.forgetSigning();
          this.plugin.signingEnrolled = false;
          new Notice('This device no longer approves. Also remove it under Devices that can publish.');
          this.display();
        })
        : button.setButtonText('Set up approvals').onClick(() => new EnrolModal(this.plugin).open())));
    new Setting(containerEl)
      .setName('Show a mark when a note has unpublished changes')
      .setDesc('Nothing shows while a note matches your site. For the full status, use "Cyberbaser: status" in the note menu.')
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.showMark).onChange(async (value) => {
        this.plugin.settings.showMark = value;
        await this.plugin.saveSettings();
        this.plugin.refreshStatus(true);
      }));
    new Setting(containerEl)
      .setName('Your author note')
      .setDesc('New posts written on this device name this note as their author, for example authors/the-chief.md. Kept on this device only.')
      .addText((text) => text.setPlaceholder('authors/your-name.md').setValue(this.plugin.authorNote() ?? '')
        .onChange((value) => this.plugin.setAuthorNote(value)));
    containerEl.createEl('p', { cls: 'setting-item-description',
      text: 'The pairing key and the approval key stay in this app on this device. They are never written to vault files, so they do not sync.' });
  }
}

export default class CyberbaserPlugin extends Plugin {
  async onload() {
    this.settings = { ...DEFAULT_SETTINGS, ...publicSettings(await this.loadData()) };
    const scope = `vault:${this.app.appId ?? this.app.vault.getName()}`;
    this.controller = createController({ client: createNodeClient({ carrier: lazyCarrier }),
      store: createDeviceStore(indexedDbBackend(), scope),
      // Its own database: the approval key never shares a record with pairing.
      signingStore: createSigningStore(indexedDbBackend(globalThis.indexedDB, signingDatabase()), scope) });
    this.signingEnrolled = false;
    this.controller.signingDevice().then((device) => { this.signingEnrolled = device !== null; }, () => {});
    this.replies = new Map(); // path -> last node reply, for local re-checks while typing
    this.headerActions = new WeakMap();
    this.lastStatus = new Map(); // path -> last status, for the quiet mark
    this.views = new Set(); // open progress views (redraw functions)
    this.siteYmlText = null;
    this.readSiteYml().then((text) => { this.siteYmlText = text; }, () => {});
    // Posts on their way. Queued posts (no connection) are kept on this device only.
    this.tracker = createPublishTracker({
      readProgress: (bundleId) => this.controller.bundleProgress(bundleId),
      withdraw: (bundleId) => this.controller.withdraw(bundleId),
      send: (item) => this.sendPost(item.path),
      isUnreachable: (error) => error instanceof NodeError && error.kind === 'unreachable',
      describeError: (error) => (error instanceof NodeError && error.kind === 'unreachable' ? null : messageFor(error)),
      save: (queue) => this.app.saveLocalStorage?.('cyberbaser-queue', queue.length ? JSON.stringify(queue) : null),
      load: () => { try { return JSON.parse(this.app.loadLocalStorage?.('cyberbaser-queue') ?? '[]'); } catch { return []; } },
      onEvent: (event) => this.onProgress(event),
    });

    this.addCommand({ id: 'pair', name: 'Pair with your Cyberbaser node', callback: () => new PairModal(this).open() });
    this.addCommand({ id: 'unpair', name: 'Unpair from your Cyberbaser node', callback: async () => {
      await this.controller.unpair();
      new Notice('Unpaired. Also revoke this device on your node.');
      this.refreshStatus(true);
    } });
    this.addCommand({ id: 'send', name: 'Send to Cyberbaser', checkCallback: (checking) => {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (!view?.file) return false;
      if (!checking) new SendModal(this, view).open();
      return true;
    } });
    this.addCommand({ id: 'status', name: 'Status of this note', checkCallback: (checking) => {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (!view?.file) return false;
      if (!checking) new StatusModal(this, view).open();
      return true;
    } });
    this.addCommand({ id: 'new-post', name: 'New post', callback: () => this.openNewPost() });
    this.addCommand({ id: 'approvals', name: 'Approvals waiting', callback: () => new ApprovalsModal(this).open() });
    this.addCommand({ id: 'progress', name: 'Publishing progress', callback: () => new ProgressModal(this).open() });
    this.addCommand({ id: 'enrol', name: 'Set up this device to approve publishing', callback: () => new EnrolModal(this).open() });
    // The note's "…" menu: status and send, on demand.
    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (!view?.file || view.file !== file) return;
      menu.addItem((item) => item.setTitle('Cyberbaser: status').setIcon('info').onClick(() => new StatusModal(this, view).open()));
      menu.addItem((item) => item.setTitle('Cyberbaser: send or publish').setIcon('upload').onClick(() => new SendModal(this, view).open()));
      if (this.signingEnrolled) menu.addItem((item) => item.setTitle('Cyberbaser: approvals waiting').setIcon('check-circle').onClick(() => new ApprovalsModal(this).open()));
    }));
    this.registerObsidianProtocolHandler(PAIR_LINK_ACTION, (params) => new PairModal(this, codeFromLink(params) ?? '').open());
    // obsidian://cyberbaser-enrol?publisher=…&code=… (the installer's QR code).
    this.registerObsidianProtocolHandler(ENROL_LINK_ACTION, (params) => {
      const code = typeof params?.publisher === 'string' && typeof params?.code === 'string'
        ? `cyberbaser-enroll:v1?publisher=${params.publisher}&code=${params.code}` : '';
      new EnrolModal(this, code).open();
    });
    this.addSettingTab(new CyberbaserSettingTab(this));

    // Desktop: one status bar item, only while a post is on its way or needs you.
    if (!Platform.isMobile) {
      this.statusBar = this.addStatusBarItem();
      this.statusBar.addClass('cyberbaser-status', 'mod-clickable');
      this.statusBar.hide();
      this.statusBar.addEventListener('click', () => new ProgressModal(this).open());
    }
    this.register(() => clearTimeout(this.pollTimer));
    this.register(() => clearTimeout(this.barTimer));
    if (this.tracker.inFlight()) this.app.workspace.onLayoutReady(() => this.pollSoon());
    this.registerEvent(this.app.workspace.on('file-open', () => this.refreshStatus(true)));
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.refreshStatus(false)));
    const local = debounce(() => this.refreshStatus(false), 800, true);
    this.registerEvent(this.app.workspace.on('editor-change', local));
    this.app.workspace.onLayoutReady(() => {
      this.refreshStatus(true);
      // A quiet New post button, only in vaults that describe their site.
      this.app.vault.adapter.exists('.cyberbaser/model.yml').then((found) => {
        if (found) this.addRibbonIcon('file-plus', 'New post', () => this.openNewPost());
      }, () => {});
    });
  }

  onunload() {
    clearInterval(this.watch);
  }

  // This vault's own publish.yml, read on this device: the device decides
  // for itself what a new page makes public. Null when there is none.
  async readPublishYml() {
    try { return await this.app.vault.adapter.read('publish.yml'); } catch { return null; }
  }

  // This vault's own .cyberbaser/site.yml (its address style), or null.
  async readSiteYml() {
    try { return await this.app.vault.adapter.read('.cyberbaser/site.yml'); } catch { return null; }
  }

  // { date: today } for each date the site model fills on first publish, for
  // the note at this path; {} when the vault has no (valid) model.
  async firstPublishStamps(path) {
    const result = await readSiteModel(this.app);
    if (!result?.ok) return {};
    const today = todayString();
    return Object.fromEntries(firstPublishFields(result.model, path).map((name) => [name, today]));
  }

  async openNewPost() {
    const result = await readSiteModel(this.app);
    if (result === null) { new Notice('This vault does not describe its site yet (.cyberbaser/model.yml).'); return; }
    if (!result.ok) { new ModelProblemsModal(this.app, result.errors).open(); return; }
    new NewPostModal(this, result.model).open();
  }

  // Which author note this device writes as. Device-local: never in data.json, which syncs.
  authorNote() {
    const value = this.app.loadLocalStorage?.('cyberbaser-author-note');
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
  }

  setAuthorNote(value) {
    const path = String(value ?? '').trim();
    const normalized = path === '' ? null : path.endsWith('.md') ? path : `${path}.md`;
    this.app.saveLocalStorage?.('cyberbaser-author-note', normalized);
  }

  async saveSettings() {
    await this.saveData(publicSettings(this.settings));
  }

  // fresh: ask the node; otherwise reuse its last answer and only re-hash the
  // text. With the mark turned off the node is asked only on demand (force).
  async refreshStatus(fresh, { force = false } = {}) {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view?.file || (!this.settings.showMark && !force)) { this.showStatus(view, null); return { status: { label: '' }, reply: null }; }
    const text = view.editor.getValue();
    let outcome;
    if (!fresh && this.replies.has(view.file.path)) {
      const reply = this.replies.get(view.file.path);
      outcome = { status: statusFor({ reply }, await textDigests(text)), reply };
    } else {
      outcome = await this.controller.status(view.file, text, { publishYml: await this.readPublishYml() });
      if (outcome.reply) this.replies.set(view.file.path, outcome.reply);
      else this.replies.delete(view.file.path);
    }
    this.showStatus(view, outcome.status);
    return outcome;
  }

  // Quiet by default: a small mark beside the note's title only when the note
  // needs something (Draft, waiting, publishing, needs attention, or changes
  // your site lacks). Nothing when it is live and unchanged; details on demand.
  showStatus(view, status) {
    if (view?.file && status) this.lastStatus.set(view.file.path, status);
    this.updateMark(view);
  }

  updateMark(view = this.app.workspace.getActiveViewOfType(MarkdownView)) {
    if (!view?.file) return;
    const status = this.lastStatus.get(view.file.path);
    const key = !this.settings.showMark ? null
      : markFor(this.tracker.items(), view.file.path) ?? (['older', 'draft'].includes(status?.key) ? status.key : null);
    let action = this.headerActions.get(view);
    if (action && action.dataset.status !== key) { action.remove(); this.headerActions.delete(view); action = null; }
    if (!key || action) return;
    const [icon, label] = MARKS[key];
    action = view.addAction(icon, label, () => (['older', 'draft'].includes(key) ? new SendModal(this, view).open() : new ProgressModal(this).open()));
    action.addClass('cyberbaser-mark');
    action.dataset.status = key;
    this.headerActions.set(view, action);
  }

  // ---- Posts on their way ----

  siteLabel(item) {
    const name = siteName(this.siteYmlText);
    if (name) return name;
    const url = item?.pages?.[0]?.url;
    try { return url ? new URL(url).host : null; } catch { return null; }
  }

  /** Publish the note at this path: everything read again from the vault, the same checks as the send sheet. */
  async sendPost(path) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file || typeof file.extension !== 'string') throw new NodeError('refused', 'create-path-refused');
    const text = await this.app.vault.read(file);
    const publishYml = await this.readPublishYml();
    const siteYml = await this.readSiteYml();
    this.siteYmlText = siteYml;
    const local = publishYml === null ? null : notePublicStatus({ path, text, publishYml, siteYml });
    const stamps = await this.firstPublishStamps(path);
    const draft = local?.draft ? draftPublishPlan({ path, text, publishYml, siteYml, stamps }) : null;
    const { local: paths, remote } = embeddedImages({ path, text,
      resolve: (target, from) => this.app.metadataCache.getFirstLinkpathDest(target, from)?.path ?? null,
      exists: (candidate) => typeof this.app.vault.getAbstractFileByPath(candidate)?.extension === 'string' });
    const images = prepareImages(await Promise.all(paths.map(async (candidate) => ({ path: candidate,
      bytes: new Uint8Array(await this.app.vault.adapter.readBinary(candidate)) }))));
    // The note turns Draft off in the vault only once your node has the change.
    const writeBack = (next) => this.app.vault.process(file, (current) => (current === text ? next : current));
    const outcome = draft
      ? await this.controller.publishDraft(file, text, { publishYml, siteYml, images, remote, stamps, writeBack })
      : await this.controller.publishNewPage(file, text, { status: local, images, remote, stamps, writeBack });
    if (outcome.kind === 'unchanged') return { reason: 'unchanged' };
    return { bundleId: outcome.bundleId, step: outcome.kind === 'publishing' ? 'waiting' : 'review',
      pages: outcome.address ? [{ path, address: outcome.address, url: null }] : [],
      sentText: draft?.text ?? null, originalText: text };
  }

  noteTitle(file) {
    const title = this.app.metadataCache.getFileCache(file)?.frontmatter?.title;
    return typeof title === 'string' && title.trim() !== '' ? title.trim() : file.basename;
  }

  /** The checklist for these items (or every item) drawn into container; { close }. */
  openProgressIn(container, ids = null) {
    return progressView(this, container, ids);
  }

  startPublish(file) {
    const started = this.tracker.publish({ path: file.path, title: this.noteTitle(file) });
    started.done.then(() => this.pollSoon(), () => {});
    return started;
  }

  async retryPublish(id) {
    await this.tracker.retry(id);
    this.pollSoon();
  }

  async withdrawPublish(id) {
    let item;
    try { item = await this.tracker.withdraw(id); } catch (error) { new Notice(messageFor(error)); return; }
    if (!item) return;
    // Back to Draft: the text as it was before Publish, or Draft turned on again.
    const file = this.app.vault.getAbstractFileByPath(item.path);
    if (file && typeof file.extension === 'string') {
      await this.app.vault.process(file, (current) => (item.sentText && current === item.sentText && item.originalText
        ? item.originalText : withDraftOn(current) ?? current));
    }
    this.refreshStatus(true);
  }

  // After Publish in the sheet: a device that signs goes straight to its approval.
  afterPublish(modal, item) {
    const check = () => {
      if (item.step === 'waiting') this.offerWaitingApproval(modal);
      else if (item.step === 'checking') setTimeout(check, 500);
    };
    check();
  }

  pollNow() {
    clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.pollSoon(0);
  }

  // Polite polling: every 3 s while a progress view is open, every 10 s
  // otherwise, and not at all once nothing is on its way.
  pollSoon(delay = null) {
    if (this.pollTimer || !this.tracker.inFlight()) return;
    const wait = delay ?? (this.views.size > 0 ? 3000 : 10_000);
    this.pollTimer = setTimeout(async () => {
      try { await this.tracker.poll(); } catch { /* next round */ }
      this.pollTimer = null;
      this.pollSoon();
    }, wait);
  }

  onProgress({ type, item }) {
    if (type === 'changed') {
      for (const draw of this.views) draw();
      this.updateBar();
      this.updateMark();
      if (IN_FLIGHT.includes(item.step)) this.pollSoon();
      return;
    }
    const open = () => new ProgressModal(this).open();
    const notice = (fragment, ms, onClick) => {
      const shown = new Notice(fragment, ms);
      const el = shown.noticeEl ?? shown.messageEl;
      if (el && onClick) { el.addClass('mod-clickable'); el.addEventListener('click', onClick); }
      return shown;
    };
    if (type === 'needs-approval' && item.step === 'waiting') {
      if (this.signingEnrolled) notice(`"${item.title}" is waiting for your approval. Tap to approve.`, 8000, () => new ApprovalsModal(this).open());
      else notice(`"${item.title}" is waiting for your approval. Open Cyberbaser on your phone to approve.`, 8000, open);
    } else if (type === 'live') {
      this.refreshStatus(true);
      const url = item.pages?.find((page) => page.path === item.path)?.url ?? item.pages?.[0]?.url ?? null;
      // Plain DOM, text only: the title is the author's own words.
      const doc = globalThis.activeDocument ?? document;
      const fragment = doc.createDocumentFragment();
      const line = doc.createElement('div');
      line.textContent = `"${item.title}" is live on ${this.siteLabel(item) ?? 'your site'}.`;
      fragment.append(line);
      if (url) {
        const row = doc.createElement('div');
        row.className = 'cyberbaser-notice-actions';
        for (const [text, cls, act] of [['View on site', 'mod-cta', () => window.open(url)], ['Copy link', '', () => navigator.clipboard?.writeText(url)]]) {
          const button = doc.createElement('button');
          button.textContent = text;
          if (cls) button.className = cls;
          button.addEventListener('click', act);
          row.append(button);
        }
        fragment.append(row);
      }
      notice(fragment, 10_000, null);
    } else if (type === 'failed') {
      notice(`Couldn't publish "${item.title}". Your post is safe.`, 10_000, open);
    } else if (type === 'queued') {
      notice(`No connection. "${item.title}" will send when you're back online.`, 6000, open);
    }
  }

  updateBar() {
    if (!this.statusBar) return;
    const state = statusBarState(this.tracker.items(), Date.now());
    this.statusBar.empty();
    clearTimeout(this.barTimer);
    if (state === null) { this.statusBar.hide(); this.statusBar.dataset.status = ''; return; }
    this.statusBar.show();
    this.statusBar.dataset.status = state.key;
    this.statusBar.setAttribute('aria-label', 'Show publishing progress');
    this.statusBar.setAttribute('data-tooltip-position', 'top');
    if (state.spin) this.statusBar.createSpan({ cls: 'cyberbaser-spinner' });
    else if (state.icon) setIcon(this.statusBar.createSpan({ cls: 'status-bar-item-icon cyberbaser-status-icon' }), state.icon);
    this.statusBar.createSpan({ cls: 'cyberbaser-status-text', text: state.text });
    // "Live ✓" for a few seconds, then nothing.
    if (state.key === 'live') this.barTimer = setTimeout(() => this.updateBar(), LIVE_SHOWN_MS + 50);
  }

  // After Publish from this device: if the node asks for its approval, show
  // it right away, so the one Publish tap leads straight to the confirmation.
  async offerWaitingApproval(modal) {
    if (!this.signingEnrolled) return;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const waiting = await this.controller.waitingApprovals().catch(() => []);
      if (waiting.length > 0) {
        modal.close();
        new ApprovalModal(this, waiting.at(-1).requestId).open();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }

  // After Publish: re-check every few seconds for two minutes.
  watchPublication() {
    clearInterval(this.watch);
    const until = Date.now() + 120_000;
    this.watch = setInterval(async () => {
      const { status } = await this.refreshStatus(true, { force: true });
      if (status.key === 'live' || Date.now() > until) clearInterval(this.watch);
    }, 4000);
  }
}

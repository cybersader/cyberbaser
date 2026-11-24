// Cyberbaser for Obsidian: pair this device with your Cyberbaser node, see
// whether the open note is live, and send it for review or publish it.
// Talks only to your paired node, through Iroh. No analytics, no telemetry.
import { MarkdownView, Modal, Notice, Platform, Plugin, PluginSettingTab, Setting, debounce, setIcon } from 'obsidian';
import { lazyCarrier } from './carrier.js';
import { createNodeClient } from './core/client.js';
import { createController, DEFAULT_SETTINGS, messageFor, publicSettings } from './core/controller.js';
import { draftPublishPlan, embeddedImages, notePublicStatus, prepareImages } from './core/new-page.js';
import { createDeviceStore, indexedDbBackend } from './core/device-store.js';
import { codeFromLink, PAIR_LINK_ACTION } from './core/pairing-code.js';
import { createSigningStore, ENROL_LINK_ACTION, signingDatabase } from './core/signing.js';
import { describeStatus, needsMark, STATUS, statusFor, textDigests } from './core/status.js';

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
    const text = this.view.editor.getValue();
    const local = publishYml === null ? null : notePublicStatus({ path: file.path, text, publishYml });
    // A draft: Publish turns Draft off inside the change you approve.
    const draft = local?.draft && !reply?.live ? draftPublishPlan({ path: file.path, text, publishYml }) : null;
    const newPage = local?.published && !reply?.live ? local : draft?.status ?? null;
    if (newPage) {
      const { local: paths, remote } = embeddedImages({ path: file.path, text,
        resolve: (target, from) => this.plugin.app.metadataCache.getFirstLinkpathDest(target, from)?.path ?? null });
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
      if (draft) {
        contentEl.createEl('p', { cls: 'cyberbaser-muted', text: 'Turns Draft off and sends it for your approval. Nothing goes live until you approve.' });
        const publish = actions.createEl('button', { text: 'Publish to your site', cls: 'mod-cta' });
        // The note in the vault turns Draft off only once your node has the change.
        const writeBack = (next) => this.plugin.app.vault.process(file, (current) => (current === text ? next : current));
        publish.addEventListener('click', () => run(publish, (f) => this.plugin.controller.publishDraft(f, text, { publishYml, images, remote, writeBack })));
      } else {
        const create = actions.createEl('button', { text: 'Publish new page', cls: 'mod-cta' });
        create.addEventListener('click', () => run(create, (f, value) => this.plugin.controller.publishNewPage(f, value, { status: local, images, remote })));
      }
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

  onClose() { this.contentEl.empty(); }
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
    const message = contentEl.createEl('p', { cls: 'cyberbaser-message', text: 'Checking the change…', attr: { role: 'status' } });
    let prepared;
    try {
      prepared = await this.plugin.controller.readApproval(this.requestId, { publishYml: await this.plugin.readPublishYml() });
    } catch (error) {
      message.setText(messageFor(error));
      return;
    }
    message.remove();
    const { summary } = prepared;
    const count = summary.files.length;
    const lead = contentEl.createDiv({ cls: 'cyberbaser-approval-lead' });
    lead.createEl('p', { cls: 'cyberbaser-approval-what', text: `Publish ${count === 1 ? '1 change' : `${count} changes`} to ${summary.repository}` });
    lead.createEl('p', { cls: 'cyberbaser-muted', text: `Branch ${summary.branch}` });
    if (summary.changesBuild) contentEl.createEl('p', { cls: 'cyberbaser-warning', text: 'This changes how your site is built.' });
    // A separate line for what becomes public: worked out on this device.
    for (const page of summary.newPages ?? []) {
      contentEl.createEl('p', { cls: 'cyberbaser-warning', text: `New public page: ${page.address}${summary.newImages ? `, plus ${summary.newImages} image${summary.newImages === 1 ? '' : 's'}` : ''}` });
    }
    const list = contentEl.createDiv({ cls: 'cyberbaser-changes' });
    for (const file of summary.files) renderPreview(list, file);
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

  onClose() { this.contentEl.empty(); }
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
    this.addCommand({ id: 'approvals', name: 'Approvals waiting', callback: () => new ApprovalsModal(this).open() });
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

    if (!Platform.isMobile) {
      this.statusBar = this.addStatusBarItem();
      this.statusBar.addClass('cyberbaser-status', 'mod-clickable');
      this.statusBar.hide();
      this.statusBar.addEventListener('click', () => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (view?.file) new SendModal(this, view).open();
      });
    }
    this.registerEvent(this.app.workspace.on('file-open', () => this.refreshStatus(true)));
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.refreshStatus(false)));
    const local = debounce(() => this.refreshStatus(false), 800, true);
    this.registerEvent(this.app.workspace.on('editor-change', local));
    this.app.workspace.onLayoutReady(() => this.refreshStatus(true));
  }

  onunload() {
    clearInterval(this.watch);
  }

  // This vault's own publish.yml, read on this device: the device decides
  // for itself what a new page makes public. Null when there is none.
  async readPublishYml() {
    try { return await this.app.vault.adapter.read('publish.yml'); } catch { return null; }
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

  // Quiet by default: a mark appears only when the note has changes your site
  // does not have yet. Not paired, unreachable or live notes show nothing; the
  // full status is in the note menu and the command palette.
  showStatus(view, status) {
    const mark = this.settings.showMark && needsMark(status);
    const label = 'Cyberbaser: unpublished changes';
    if (this.statusBar) {
      this.statusBar.dataset.status = mark ? status.key : '';
      this.statusBar.empty();
      if (!mark) { this.statusBar.hide(); return; }
      this.statusBar.show();
      this.statusBar.setAttribute('aria-label', `${label}. Click to send or publish.`);
      this.statusBar.setAttribute('data-tooltip-position', 'top');
      setIcon(this.statusBar.createSpan({ cls: 'status-bar-item-icon cyberbaser-status-icon' }), 'upload');
      this.statusBar.createSpan({ cls: 'cyberbaser-status-text', text: 'Unpublished changes' });
      return;
    }
    if (!view) return;
    // Mobile: one more icon among the note's header actions, only when marked.
    let action = this.headerActions.get(view);
    if (!mark) {
      if (action) { action.remove(); this.headerActions.delete(view); }
      return;
    }
    if (!action) {
      action = view.addAction('upload', `${label}. Tap to send or publish.`, () => new SendModal(this, view).open());
      action.addClass('cyberbaser-mark');
      this.headerActions.set(view, action);
    }
    action.dataset.status = status.key;
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

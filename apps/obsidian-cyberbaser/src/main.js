// Cyberbaser for Obsidian: pair this device with your Cyberbaser node, see
// whether the open note is live, and send it for review or publish it.
// Talks only to your paired node, through Iroh. No analytics, no telemetry.
import { MarkdownView, Modal, Notice, Platform, Plugin, PluginSettingTab, Setting, debounce, setIcon } from 'obsidian';
import { lazyCarrier } from './carrier.js';
import { createNodeClient } from './core/client.js';
import { createController, DEFAULT_SETTINGS, messageFor, publicSettings } from './core/controller.js';
import { createDeviceStore, indexedDbBackend } from './core/device-store.js';
import { codeFromLink, PAIR_LINK_ACTION } from './core/pairing-code.js';
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
    button.addEventListener('click', async () => {
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
        button.setText('Done');
        button.disabled = false;
        button.onclick = () => this.close();
        this.plugin.refreshStatus(true);
      } catch (error) {
        words.empty();
        message.setText(messageFor(error));
        button.disabled = false;
        input.disabled = false;
      }
    });
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
        if (outcome.kind === 'publishing') this.plugin.watchPublication();
      } catch (error) {
        result.setText(messageFor(error));
        for (const element of actions.querySelectorAll('button')) element.disabled = false;
      }
    };
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
    new Setting(containerEl)
      .setName('Show a mark when a note has unpublished changes')
      .setDesc('Nothing shows while a note matches your site. For the full status, use "Cyberbaser: status" in the note menu.')
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.showMark).onChange(async (value) => {
        this.plugin.settings.showMark = value;
        await this.plugin.saveSettings();
        this.plugin.refreshStatus(true);
      }));
    containerEl.createEl('p', { cls: 'setting-item-description',
      text: 'The pairing key stays in this app on this device. It is never written to vault files, so it does not sync.' });
  }
}

export default class CyberbaserPlugin extends Plugin {
  async onload() {
    this.settings = { ...DEFAULT_SETTINGS, ...publicSettings(await this.loadData()) };
    const scope = `vault:${this.app.appId ?? this.app.vault.getName()}`;
    this.controller = createController({ client: createNodeClient({ carrier: lazyCarrier }),
      store: createDeviceStore(indexedDbBackend(), scope) });
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
    // The note's "…" menu: status and send, on demand.
    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (!view?.file || view.file !== file) return;
      menu.addItem((item) => item.setTitle('Cyberbaser: status').setIcon('info').onClick(() => new StatusModal(this, view).open()));
      menu.addItem((item) => item.setTitle('Cyberbaser: send or publish').setIcon('upload').onClick(() => new SendModal(this, view).open()));
    }));
    this.registerObsidianProtocolHandler(PAIR_LINK_ACTION, (params) => new PairModal(this, codeFromLink(params) ?? '').open());
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
      outcome = await this.controller.status(view.file, text);
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

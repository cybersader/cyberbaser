// "New post": a form made from the vault's site model. The author picks what
// they are writing, fills in plain fields, and gets a note to write in. They
// never see the properties block; the model file stays the site builder's.
import { AbstractInputSuggest, FuzzySuggestModal, Modal, Notice, Setting, TFile, setIcon } from 'obsidian';
import { applyPlan, fileSlug, folderOptions, IMAGE_EXTENSIONS, newFolderParents, normalizeTag, planNewNote, tagRules, tagSuggestions, todayString } from './core/new-note.js';
import { creatableTypes, MODEL_PATH, parseSiteModel, patternSegments, typeNamed } from './core/site-model.js';

const NEW_FOLDER = '\u0000new';

/** This vault's model, or { errors } for the site builder, or null when there is none. */
export async function readSiteModel(app) {
  let text;
  try { text = await app.vault.adapter.read(MODEL_PATH); } catch { return null; }
  return parseSiteModel(text);
}

class ImageSuggestModal extends FuzzySuggestModal {
  constructor(app, onChoose) {
    super(app);
    this.onChoose = onChoose;
    this.setPlaceholder('Pick a photo from your vault');
  }

  getItems() { return this.app.vault.getFiles().filter((file) => IMAGE_EXTENSIONS.includes(file.extension.toLowerCase())); }
  getItemText(file) { return file.path; }
  onChooseItem(file) { this.onChoose(file); }
}

class TagSuggest extends AbstractInputSuggest {
  constructor(app, inputEl, tagsFor, onPick, rules) {
    super(app, inputEl);
    this.tagInput = inputEl;
    this.tagsFor = tagsFor;
    this.onPick = onPick;
    this.rules = rules;
  }

  getSuggestions(query) {
    const q = query.trim().toLowerCase().replace(/^#/u, '');
    const found = this.tagsFor().filter((tag) => tag.includes(q)).slice(0, 30);
    const typed = normalizeTag(q, ...this.rules).tag;
    return typed && !found.includes(typed) ? [...found, typed] : found;
  }

  renderSuggestion(tag, el) { el.setText(this.tagsFor().includes(tag) ? tag : `Add "${tag}"`); }

  selectSuggestion(tag) {
    this.onPick(tag);
    this.tagInput.value = '';
    this.close();
  }
}

export class NewPostModal extends Modal {
  constructor(plugin, model, typeName = null) {
    super(plugin.app);
    this.plugin = plugin;
    this.model = model;
    this.types = creatableTypes(model);
    this.typeName = typeName ?? this.types[0]?.name;
    this.values = {};
    this.errors = {};
  }

  vaultPaths() {
    return this.app.vault.getAllLoadedFiles().map((file) => file.path).filter((path) => path !== '/');
  }

  titleOf(path) {
    const file = this.app.vault.getAbstractFileByPath(path);
    const title = file instanceof TFile ? this.app.metadataCache.getFileCache(file)?.frontmatter?.title : null;
    return typeof title === 'string' ? title : null;
  }

  vaultTags() {
    return this.app.vault.getMarkdownFiles().map((file) => this.app.metadataCache.getFileCache(file)?.frontmatter?.tags ?? []);
  }

  onOpen() {
    this.modalEl.addClass('cyberbaser-modal', 'cyberbaser-new-post');
    this.render();
  }

  render() {
    const { contentEl } = this;
    contentEl.empty();
    const type = typeNamed(this.model, this.typeName);
    this.setTitle?.(`New ${type.label.toLowerCase()}`);
    if (this.types.length > 1) {
      new Setting(contentEl).setName('What are you writing?').addDropdown((dropdown) => {
        for (const candidate of this.types) dropdown.addOption(candidate.name, candidate.label);
        dropdown.setValue(this.typeName).onChange((value) => {
          const keep = { title: this.values.title, description: this.values.description, ...(this.values.slug !== undefined ? { slug: this.values.slug } : {}) };
          this.typeName = value;
          this.values = keep;
          this.errors = {};
          this.render();
        });
      });
    }
    const form = contentEl.createDiv({ cls: 'cyberbaser-form' });
    const last = patternSegments(type.location.pattern).at(-1);
    const nameLabel = last?.name === 'slug' ? 'File name' : 'Folder name';
    for (const field of type.fields) this.renderField(form, field, this.values, '', { nameLabel });
    if (this.errors.type) form.createDiv({ cls: 'cyberbaser-field-error', text: this.errors.type });
    const actions = contentEl.createDiv({ cls: 'cyberbaser-actions' });
    const create = actions.createEl('button', { text: 'Create', cls: 'mod-cta' });
    actions.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
    create.addEventListener('click', () => this.create(create));
  }

  renderField(container, field, values, prefix, { only = null, labelPrefix = '', nameLabel = null } = {}) {
    if (field.hidden || field.type === 'date' || field.type === 'author-reference') return;
    if (only && !only(field)) return;
    const key = `${prefix}${field.name}`;
    const setting = new Setting(container).setName(labelPrefix ? `${labelPrefix} ${field.label.toLowerCase()}` : field.label);
    setting.settingEl.addClass('cyberbaser-form-row');
    setting.settingEl.dataset.field = key;
    if (field.hint) setting.setDesc(field.hint);
    const error = this.errors[key];
    // Once the author changes a field, its error goes away.
    const touched = () => {
      if (!this.errors[key]) return;
      delete this.errors[key];
      setting.settingEl.removeClass('cyberbaser-has-error');
      setting.descEl.querySelector('.cyberbaser-field-error')?.remove();
    };
    const showError = () => {
      if (!error) return;
      setting.settingEl.addClass('cyberbaser-has-error');
      setting.descEl.createDiv({ cls: 'cyberbaser-field-error', text: error });
    };
    switch (field.type) {
      case 'text':
      case 'url':
      case 'number':
        setting.addText((text) => {
          text.setValue(values[field.name] ?? '').onChange((value) => { values[field.name] = value; touched(); });
          if (field.type === 'url') { text.inputEl.inputMode = 'url'; text.setPlaceholder(field.required ? 'Paste a link' : 'Paste a link (optional)'); }
          if (field.type === 'number') text.inputEl.inputMode = 'numeric';
          if (field.name === 'title') {
            text.inputEl.addClass('cyberbaser-title-input');
            // The name row below follows the title until the author edits it.
            text.inputEl.addEventListener('input', () => this.followTitle(values, key));
          }
        });
        if (field.name === 'title' && nameLabel) this.renderName(container, values, key, nameLabel);
        break;
      case 'long-text':
        setting.settingEl.addClass('cyberbaser-form-wide');
        setting.addTextArea((area) => {
          area.setValue(values[field.name] ?? '').onChange((value) => { values[field.name] = value; touched(); });
          area.inputEl.rows = 2;
        });
        break;
      case 'choice':
        setting.addDropdown((dropdown) => {
          if (!field.required) dropdown.addOption('', 'None');
          for (const option of field.options) dropdown.addOption(option, option);
          dropdown.setValue(values[field.name] ?? String(field.default ?? '')).onChange((value) => { values[field.name] = value; touched(); });
        });
        break;
      case 'checkbox':
        if (values[field.name] === undefined) values[field.name] = field.default === true;
        setting.addToggle((toggle) => toggle.setValue(values[field.name]).onChange((value) => { values[field.name] = value; touched(); }));
        break;
      case 'tags':
        this.renderTags(setting, field, values, touched);
        break;
      case 'image':
        this.renderImage(setting, field, values, touched);
        break;
      case 'choice-from-folder':
        this.renderFolder(container, setting, field, values, touched);
        break;
      default:
        break;
    }
    showError();
  }

  // The name in the vault (file or folder), made from the title by the site
  // model's rule and editable before Create. values.slug is set only once the
  // author edits it; until then it follows the title.
  renderName(container, values, titleKey, label) {
    const prefix = titleKey.slice(0, -'title'.length);
    const key = `${prefix}slug`;
    const setting = new Setting(container).setName(label);
    setting.settingEl.addClass('cyberbaser-form-row', 'cyberbaser-name-row');
    setting.settingEl.dataset.field = key;
    setting.setDesc(label === 'File name' ? 'Made from the title. Change it if you like.' : 'Made from the folder title. Change it if you like.');
    setting.addText((text) => {
      text.inputEl.addClass('cyberbaser-name-input');
      text.inputEl.spellcheck = false;
      text.inputEl.autocapitalize = 'off';
      text.setValue(values.slug ?? fileSlug(values.title)).onChange((value) => {
        values.slug = value;
        if (this.errors[key]) { delete this.errors[key]; setting.settingEl.removeClass('cyberbaser-has-error'); setting.descEl.querySelector('.cyberbaser-field-error')?.remove(); }
      });
      // Show the cleaned name once the author leaves the field.
      text.inputEl.addEventListener('blur', () => {
        if (values.slug === undefined) return;
        const cleaned = fileSlug(values.slug);
        if (cleaned === '' && String(values.slug).trim() === '') { delete values.slug; text.setValue(fileSlug(values.title)); return; }
        if (cleaned !== '') { values.slug = cleaned; text.setValue(cleaned); }
      });
    });
    const error = this.errors[key];
    if (error) { setting.settingEl.addClass('cyberbaser-has-error'); setting.descEl.createDiv({ cls: 'cyberbaser-field-error', text: error }); }
  }

  followTitle(values, titleKey) {
    if (values.slug !== undefined) return;
    const key = `${titleKey.slice(0, -'title'.length)}slug`;
    const input = this.contentEl.querySelector(`[data-field="${key}"] input`);
    if (input) input.value = fileSlug(values.title);
  }

  renderFolder(container, setting, field, values, touched) {
    const options = folderOptions(this.model, field, this.vaultPaths(), (path) => this.titleOf(path));
    const answer = values[field.name];
    // allow_root: the top level is a real choice (value ''); "Pick" needs another sentinel.
    const PICK = '\u0000pick';
    const current = answer?.new ? NEW_FOLDER : answer?.existing ?? PICK;
    setting.addDropdown((dropdown) => {
      dropdown.addOption(PICK, `Pick a ${field.label.toLowerCase()}`);
      for (const option of options) dropdown.addOption(option.value, option.label);
      if (field.allowNew) dropdown.addOption(NEW_FOLDER, 'New sub-folder…');
      dropdown.setValue(current).onChange((value) => {
        values[field.name] = value === NEW_FOLDER ? { new: { parent: '', values: {} } } : value !== PICK ? { existing: value } : undefined;
        touched();
        if (value === NEW_FOLDER || answer?.new) this.render();
      });
    });
    if (!answer?.new) return;
    // The new folder's own note: its name and the fields its type requires.
    const box = container.createDiv({ cls: 'cyberbaser-new-folder' });
    const folderType = typeNamed(this.model, field.ofType);
    const parents = newFolderParents(field, options, this.model, (path) => this.titleOf(path));
    if (parents.length > 1) {
      const parent = new Setting(box).setName('Inside').addDropdown((dropdown) => {
        for (const option of parents) dropdown.addOption(option.value, option.label);
        dropdown.setValue(answer.new.parent).onChange((value) => { answer.new.parent = value; });
      });
      parent.settingEl.addClass('cyberbaser-form-row');
      const error = this.errors[`${field.name}.new.parent`];
      if (error) parent.descEl.createDiv({ cls: 'cyberbaser-field-error', text: error });
    }
    for (const folderField of folderType.fields) {
      this.renderField(box, folderField, answer.new.values, `${field.name}.new.`, { only: (candidate) => candidate.required, labelPrefix: 'Folder', nameLabel: 'Folder name' });
    }
  }

  renderTags(setting, field, values, touched) {
    values[field.name] ??= [];
    const rules = tagRules(this.model);
    const [shape, { allowPlain }] = rules;
    const chips = setting.controlEl.createDiv({ cls: 'cyberbaser-tags' });
    const suggestions = tagSuggestions(this.model, this.vaultTags());
    const draw = () => {
      chips.empty();
      for (const tag of values[field.name]) {
        const chip = chips.createSpan({ cls: 'cyberbaser-tag', text: tag });
        const remove = chip.createSpan({ cls: 'cyberbaser-tag-remove', attr: { 'aria-label': `Remove ${tag}`, role: 'button', tabindex: '0' } });
        setIcon(remove, 'x');
        remove.addEventListener('click', () => { values[field.name] = values[field.name].filter((t) => t !== tag); draw(); });
      }
    };
    const add = (raw) => {
      const result = normalizeTag(raw, ...rules);
      if (result.error) { new Notice(result.error); return; }
      if (!values[field.name].includes(result.tag)) values[field.name].push(result.tag);
      touched();
      draw();
    };
    setting.addText((text) => {
      text.setPlaceholder(shape === 'group/value' ? (allowPlain ? 'Add a tag, like strategy or audience/executives' : 'Add a tag, like audience/executives') : 'Add a tag');
      // The list always ends with what was typed, so Enter adds a new tag too.
      new TagSuggest(this.app, text.inputEl, () => suggestions.filter((tag) => !values[field.name].includes(tag)), add, rules);
    });
    setting.settingEl.addClass('cyberbaser-form-wide');
    draw();
  }

  renderImage(setting, field, values, touched) {
    const chosen = values[field.name];
    if (chosen) {
      setting.controlEl.createSpan({ cls: 'cyberbaser-image-name', text: chosen.name });
      setting.addExtraButton((button) => button.setIcon('x').setTooltip('Remove photo').onClick(() => { values[field.name] = undefined; this.render(); }));
      return;
    }
    const input = setting.controlEl.createEl('input', { type: 'file', cls: 'cyberbaser-hidden-input',
      attr: { accept: IMAGE_EXTENSIONS.map((ext) => `.${ext}`).join(','), 'aria-label': `${field.label} from this device` } });
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) return;
      values[field.name] = { name: file.name, source: { file } };
      touched();
      this.render();
    });
    setting.addButton((button) => button.setButtonText('From vault').onClick(() => new ImageSuggestModal(this.app, (file) => {
      values[field.name] = { name: file.name, source: { vaultPath: file.path } };
      touched();
      this.render();
    }).open()));
    setting.addButton((button) => button.setButtonText('From device').onClick(() => input.click()));
  }

  async create(button) {
    const plan = planNewNote({ model: this.model, typeName: this.typeName, values: this.values, paths: this.vaultPaths(),
      today: todayString(), authorNote: this.plugin.authorNote(), titleOf: (path) => this.titleOf(path) });
    if (!plan.ok) {
      this.errors = plan.errors;
      this.render();
      this.contentEl.querySelector('.cyberbaser-has-error')?.scrollIntoView({ block: 'center' });
      return;
    }
    button.disabled = true;
    const { vault } = this.app;
    try {
      await applyPlan(plan, {
        createFolder: async (path) => { if (!vault.getAbstractFileByPath(path)) await vault.createFolder(path); },
        writeText: (path, text) => vault.create(path, text),
        copyImage: async (source, path) => {
          const bytes = source.file ? await source.file.arrayBuffer() : await vault.adapter.readBinary(source.vaultPath);
          await vault.createBinary(path, bytes);
        },
      });
    } catch (error) {
      button.disabled = false;
      new Notice(`Could not create the note: ${error?.message ?? error}`);
      return;
    }
    this.close();
    const file = vault.getAbstractFileByPath(plan.notePath);
    if (file instanceof TFile) {
      const leaf = this.app.workspace.getLeaf(false);
      await leaf.openFile(file, { active: true, state: { mode: 'source' } });
      const editor = leaf.view?.editor;
      if (editor) { const end = editor.lastLine(); editor.setCursor({ line: end, ch: editor.getLine(end).length }); editor.focus(); }
    }
  }

  onClose() { this.contentEl.empty(); }
}

/** For the site builder: what is wrong with model.yml, one line each. */
export class ModelProblemsModal extends Modal {
  constructor(app, errors) {
    super(app);
    this.errors = errors;
  }

  onOpen() {
    this.modalEl.addClass('cyberbaser-modal');
    this.setTitle?.('The site model needs fixing');
    this.contentEl.createEl('p', { text: `New posts use ${MODEL_PATH}. Fix these, then try again:` });
    const list = this.contentEl.createEl('ul', { cls: 'cyberbaser-model-errors' });
    for (const error of this.errors) list.createEl('li', { text: error });
  }

  onClose() { this.contentEl.empty(); }
}

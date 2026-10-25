import { StateField } from '@codemirror/state';
export const editorInfoField = StateField.define({ create: () => undefined, update: value => value });
export const notices = [];
export const modals = [];
export const Platform = { isMobile: false };
export class Menu {
	constructor() { this.items = []; }
	addItem(callback) { const item = { setTitle(value) { this.title = value; return this; }, setIcon() { return this; }, onClick(value) { this.callback = value; return this; } }; callback(item); this.items.push(item); return this; }
	showAtPosition() { return this; }
	hide() {}
}
export class Notice {
	constructor(message) {
		notices.push(message);
	}
}
export class TFile {
	constructor(path) {
		this.path = path;
	}
}
export class TFolder {
	constructor(path) {
		this.path = path;
		this.children = [];
	}
}
function element() {
	const classes = new Set();
	return {
		classList: {
			add: (...names) => names.forEach(name => classes.add(name)),
			remove: (...names) => names.forEach(name => classes.delete(name)),
			contains: name => classes.has(name),
			toggle: (name, force) => { const enabled = force ?? !classes.has(name); if (enabled) classes.add(name); else classes.delete(name); return enabled; },
		},
		querySelector() { return null; },
		text: '',
		value: '',
		isConnected: true,
		handlers: {},
		addClass() {},
		focus() {},
		remove() { this.isConnected = false; },
		addEventListener(name, callback) { (this.handlers[name] ??= []).push(callback); },
		settings: [],
		children: [],
		empty() {
			this.children = [];
			this.settings = [];
		},
		setText(text) {
			this.text = text;
		},
		createEl(tag, options = {}) {
			const child = element();
			child.tag = tag;
			child.text = options.text ?? '';
			this.children.push(child);
			return child;
		},
		createSpan(options) { return this.createEl('span', options); },
		createDiv(options) {
			return this.createEl('div', options);
		},
	};
}
export class Modal {
	constructor(app) {
		this.app = app;
		this.contentEl = element();
	}
	setTitle(title) {
		this.title = title;
	}
	open() {
		modals.push(this);
		this.onOpen();
	}
	close() {
		this.onClose();
	}
}
export class Plugin {
	constructor(app, manifest) {
		this.app = app;
		this.manifest = manifest;
		this.intervals = [];
		this.persisted = null;
	}
	async loadData() {
		return this.persisted;
	}
	async saveData(value) {
		this.persisted = structuredClone(value);
	}
	addStatusBarItem() {
		return element();
	}
	addSettingTab(tab) {
		this.settingTabs ??= [];
		this.settingTabs.push(tab);
	}
	addCommand(command) {
		this.commands ??= [];
		this.commands.push(command);
	}
	registerView() {}
	registerEvent() {}
	addRibbonIcon() {}
	registerInterval(timer) {
		this.intervals.push(timer);
	}
	dispose() {
		this.onunload();
		for (const timer of this.intervals) clearInterval(timer);
	}
}
export class ItemView {
	constructor() {
		this.contentEl = element();
	}
}
export class PluginSettingTab {
	update() {}
	constructor(app, plugin) {
		this.app = app;
		this.plugin = plugin;
		this.containerEl = element();
	}
}
export class Setting {
	constructor(container) {
		this.containerEl = container;
		this.settingEl = element();
		this.settingEl.parentElement = container;
		this.controls = [];
		container.settings?.push(this);
	}
	setName(name) {
		this.name = name;
		return this;
	}
	setHeading() {
		this.heading = true;
		return this;
	}
	setDesc(desc) {
		this.desc = desc;
		return this;
	}
	addControl(kind, callback) {
		const control = {
			kind,
			inputEl: {},
			setValue(value) {
				const previous = this.value;
				this.value = value;
				if (kind === 'toggle' && previous !== value) this.change?.(value);
				return this;
			},
			addOptions(options) {
				this.options = options;
				return this;
			},
			onChange(change) {
				this.change = change;
				return this;
			},
			setButtonText(text) {
				this.text = text;
				return this;
			},
			setDisabled(disabled) {
				this.disabled = disabled;
				return this;
			},
			onClick(click) {
				this.click = click;
				return this;
			},
		};
		this.controls.push(control);
		callback(control);
		return this;
	}
	addToggle(callback) {
		return this.addControl('toggle', callback);
	}
	addText(callback) {
		return this.addControl('text', callback);
	}
	addTextArea(callback) {
		return this.addControl('textarea', callback);
	}
	addDropdown(callback) {
		return this.addControl('dropdown', callback);
	}
	addButton(callback) {
		return this.addControl('button', callback);
	}
}
export function syntheticApp() {
	const files = new Map();
	const secrets = new Map();
	const deletionRequests = [];
	return {
		files,
		deletionRequests,
		fileManager: {
			trashFile: async (file) => {
				deletionRequests.push(file.path);
				files.delete(file.path);
			},
		},
		secretStorage: {
			getSecret: (key) => secrets.get(key) ?? null,
			setSecret: (key, value) => {
				if (!/^[a-z0-9-]{1,64}$/.test(key)) throw new Error('Invalid host secret ID');
				return secrets.set(key, value);
			},
		},
		workspace: { on: () => ({}), getActiveFile: () => (files.size ? new TFile([...files.keys()][0]) : null) },
		vault: {
			on: () => ({}),
			getFiles: () => [...files.keys()].map((path) => new TFile(path)),
			getAbstractFileByPath: (path) => (files.has(path) ? new TFile(path) : null),
			readBinary: async (file) => Uint8Array.from(files.get(file.path)).buffer,
			createFolder: async () => {},
			createBinary: async (path, data) => {
				files.set(path, new Uint8Array(data));
				return new TFile(path);
			},
			modifyBinary: async (file, data) => {
				files.set(file.path, new Uint8Array(data));
			},
			trash: async (file) => {
				files.delete(file.path);
			},
		},
	};
}

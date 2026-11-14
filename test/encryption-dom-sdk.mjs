import { StateField } from '@codemirror/state';
export const editorInfoField = StateField.define({ create: () => globalThis.encryptionEditorInfo, update: value => value });
export const Platform = { isMobile: false };
export const modals = [];
export const notices = [];
export const menus = [];
export function setIcon(element, name) { element.setAttribute('data-icon', name); }
export class Menu {
	constructor() { this.items = []; }
	addItem(callback) { const item = { setTitle(value) { this.title = value; return this; }, setIcon(value) { this.icon = value; return this; }, onClick(value) { this.callback = value; return this; } }; callback(item); this.items.push(item); return this; }
	showAtPosition(position, doc) { this.position = position; this.doc = doc; this.visible = true; menus.push(this); return this; }
	hide() { this.visible = false; }
}
export class Notice { constructor(message) { notices.push(message); } }
export class Modal {
	constructor(app) {
		this.app = app;
		this.modalEl = document.createElement('section'); this.modalEl.setAttribute('role', 'dialog');
		this.heading = this.modalEl.createEl('h2'); this.contentEl = this.modalEl.createDiv();
	}
	setTitle(text) { this.heading.setText(text); }
	open() { document.body.appendChild(this.modalEl); modals.push(this); this.onOpen?.(); }
	close() { this.onClose?.(); this.modalEl.remove(); }
}

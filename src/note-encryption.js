import { Modal, Menu, Notice, Platform, editorInfoField } from 'obsidian';
import { StateField, EditorState, Prec, Transaction } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, ViewPlugin } from '@codemirror/view';
import { formatStorageSize, t } from './i18n.js';
import { desktopFiles } from './desktop.js';
import { createSecureEditor } from './secure-note-editor.js';
import {
	createLocked, createAttachmentRevision, openLocked, updateLocked, rewrapLocked, lockedMarker, lockedRanges,
	decodeBox, encodeBox, replaceLocked, TEXT_PREFIX, containsLockedText, NOTE_LIMIT, NOTE_DRAFT_LIMIT,
} from './note-crypto.js';
import {
	findNoteAttachments, stageNoteAttachments, stageImportedAttachments, attachmentInsertion, parseAttachmentManifest, readAttachmentPackage,
	finishAttachmentLock, verifyNoteAttachments, restoreNoteAttachments, decryptAttachment, attachmentPreviewType, attachmentPackagePath,
} from './note-attachments.js';

const failure = error => new Notice(error instanceof Error ? error.message : t('encryption.text02'));
const button = (area, text, callback) => {
	const el = area.createEl('button', { text, attr: { type: 'button' } });
	el.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); callback(event); });
	return el;
};
const fileIsNote = file => typeof file?.path === 'string' && file.path.toLowerCase().endsWith('.md');
const safeId = id => typeof id === 'string' && /^[a-f0-9]{32}$/u.test(id);
const hasWholeNoteLock = text => text.includes('```wujie-encrypted') &&
	lockedRanges(text).some(range => range.box && range.box.kind !== 'text');

class PasswordWindow extends Modal {
	constructor(manager, title, box, creating, submit) {
		super(manager.app);
		Object.assign(this, { manager, titleText: title, box, creating, submit });
	}
	onOpen() {
		this.manager.prompts.add(this);
		this.setTitle(this.titleText);
		this.contentEl.addClass('wujie-crypto-form');
		const field = (label, type, max) => {
			const row = this.contentEl.createEl('label', { text: label });
			const input = row.createEl('input', { type, attr: { 'aria-label': label, maxlength: String(max), autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' } });
			input.addEventListener('keydown', event => {
				if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return;
				event.preventDefault(); event.stopPropagation();
				void this.run();
			});
			return input;
		};
		this.password = field(this.creating ? t('encryption.text03') : t('encryption.text04'), 'password', 1024);
		if (this.creating) {
			this.confirm = field(t('encryption.text05'), 'password', 1024);
			this.hint = field(t('encryption.text06'), 'text', 200);
			this.hint.value = this.box?.hint ?? '';
			this.contentEl.createEl('p', { text: t('encryption.text07') });
			if (this.externalImages) this.contentEl.createEl('p', { text: t('encryption.externalImageNotice') });
			if (this.attachments?.length) {
				this.contentEl.createEl('p', { text: t('encryption.attachmentConfirm', { count: this.attachments.length }) });
				const list = this.contentEl.createEl('ul');
				for (const file of this.attachments) list.createEl('li', { text: file.path });
			}
		} else if (this.box?.hint) {
			button(this.contentEl, t('encryption.text08'), () => {
				if (!this.hintShown) { this.hintShown = true; this.contentEl.createEl('p', { text: this.box.hint }); }
			});
		}
		if (this.titleText === t('encryption.text09')) this.contentEl.createEl('p', { text: t('encryption.text10') });
		if (this.titleText === t('encryption.removeBlock')) this.contentEl.createEl('p', { text: t('encryption.removeBlockConfirm') });
		this.status = this.contentEl.createDiv({ attr: { role: 'status', 'aria-live': 'polite' } });
		this.submitButton = button(this.contentEl, this.creating ? t('encryption.text11') : this.titleText, () => { void this.run(); });
		button(this.contentEl, t('encryption.text12'), () => this.close());
		this.password.focus();
	}
	async run() {
		if (this.busy || this.closed) return;
		if (this.creating && this.password.value !== this.confirm.value) { this.status.setText(t('encryption.text13')); return; }
		this.busy = true; this.submitButton.disabled = true;
		const epoch = this.manager.epoch;
		try {
			await this.submit(this.password.value, this.hint?.value ?? '', () => !this.closed && this.manager.active(epoch));
			if (!this.closed) this.close();
		} catch (error) {
			if (!this.closed) this.status.setText(error instanceof Error ? error.message : t('encryption.text14'));
		} finally {
			this.password.value = ''; if (this.confirm) this.confirm.value = '';
			this.busy = false; this.submitButton.disabled = false;
		}
	}
	onClose() {
		this.closed = true;
		if (this.password) this.password.value = '';
		if (this.confirm) this.confirm.value = '';
		this.submit = undefined;
		this.contentEl.empty();
		this.manager.prompts.delete(this);
	}
}

class EncryptionActions extends Modal {
	constructor(manager, actions) { super(manager.app); this.manager = manager; this.actions = actions; }
	onOpen() {
		this.setTitle(t('encryption.text15'));
		this.containerEl?.addClass('wujie-crypto-sheet-container');
		this.modalEl?.addClass('wujie-crypto-sheet');
		this.contentEl.addClass('wujie-crypto-sheet-actions');
		for (const [title, , action] of this.actions) button(this.contentEl, title, () => { this.close(); action(); });
		button(this.contentEl, t('encryption.text12'), () => this.close());
	}
	onClose() { this.contentEl.empty(); if (this.manager.actionMenu === this) this.manager.actionMenu = undefined; }
}

export class NoteEncryption {
	constructor(owner, addReadingAction) {
		this.owner = owner; this.app = owner.app; this.epoch = 0;
		this.addReadingAction = addReadingAction;
		this.prompts = new Set(); this.sessions = new Set(); this.stopped = false;
		this.pendingWrites = new Set(); this.busyFiles = new Set(); this.locks = new Map(); this.areas = new WeakMap();
		this.viewWrites = new WeakMap();
		this.widgetViews = new WeakMap();
		this.volatileDrafts = new Map();
		this.removingAttachments = new Set();
		this.fileLocks = new WeakMap();
		this.badgedRows = new Set();
		this.recoveryDir = `${this.app.vault.configDir}/plugins/${owner.manifest.id}/encrypted-drafts`;
	}
	async isWholeNoteLocked(file) {
		if (!fileIsNote(file)) return false;
		let item = this.fileLocks.get(file);
		if (!item) {
			item = {};
			item.ready = Promise.resolve().then(() => this.app.vault.cachedRead?.(file) ?? this.app.vault.read(file)).then(text => {
				item.locked = hasWholeNoteLock(text);
				return item.locked;
			}).catch(() => {
				if (this.fileLocks.get(file) === item) this.fileLocks.delete(file);
				return false;
			});
			this.fileLocks.set(file, item);
		}
		return item.ready;
	}
	addFileMenu(menu, file) {
		if (!fileIsNote(file)) return;
		void this.isWholeNoteLocked(file);
		if (!this.fileLocks.get(file)?.locked)
			menu.addItem(item => item.setTitle(t('encryption.encryptNote')).setIcon('lock').onClick(() => { void this.encryptNote(file).catch(failure); }));
	}
	async listLockedNotes() {
		const modal = new Modal(this.app);
		modal.setTitle(t('encryption.listLockedNotes'));
		const results = modal.contentEl.createDiv({ cls: 'wujie-locked-note-list' });
		const status = results.createDiv({ text: t('encryption.checkingLockedNotes'), attr: { role: 'status' } });
		modal.open();
		let count = 0;
		for (const file of this.app.vault.getMarkdownFiles().sort((a, b) => a.path.localeCompare(b.path))) {
			if (this.stopped || !results.isConnected) return;
			if (!await this.isWholeNoteLocked(file) || !results.isConnected) continue;
			count++;
			button(results, file.path, () => { modal.close(); void this.app.workspace.getLeaf(false).openFile(file).catch(failure); });
		}
		if (count) status.remove();
		else status.setText(t('encryption.noLockedNotes'));
	}
	watchExplorer(container) {
		if (!container || !container.ownerDocument?.defaultView?.MutationObserver) return;
		const selector = '.nav-file-title[data-path]';
		const update = () => {
			this.explorerTimer = undefined;
			for (const row of this.badgedRows) if (!row.isConnected) this.badgedRows.delete(row);
			for (const row of container.querySelectorAll(selector)) {
				const path = row.dataset.path;
				const file = this.app.vault.getAbstractFileByPath(path);
				if (!fileIsNote(file)) { row.classList.remove('wujie-locked-file'); this.badgedRows.delete(row); continue; }
				const status = this.isWholeNoteLocked(file);
				const snapshot = this.fileLocks.get(file);
				void status.then(locked => {
					if (this.stopped || !row.isConnected || row.dataset.path !== path || this.fileLocks.get(file) !== snapshot) return;
					row.classList.toggle('wujie-locked-file', locked);
					if (locked) this.badgedRows.add(row);
					else this.badgedRows.delete(row);
				});
			}
		};
		const refresh = this.refreshExplorer = () => {
			if (this.explorerTimer === undefined) this.explorerTimer = setTimeout(update, 60);
		};
		this.explorerObserver = new container.ownerDocument.defaultView.MutationObserver(records => {
			const hasRow = node => node.nodeType === 1 && (node.matches(selector) || node.querySelector(selector));
			if (records.some(record => record.type === 'attributes' || [...record.addedNodes, ...record.removedNodes].some(hasRow))) refresh();
		});
		this.explorerObserver.observe(container, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-path'] });
		refresh();
	}

	active(epoch) { return !this.stopped && epoch === this.epoch && !this.document?.hidden; }
	async capture(file, editor) {
		if (!fileIsNote(file)) throw Error(t('encryption.text16'));
		const leaves = this.app.workspace.getLeavesOfType('markdown').filter(leaf => leaf.view?.file === file);
		const view = leaves.find(leaf => leaf.view.editor === editor)?.view ?? leaves[0]?.view;
		const original = view?.editor?.getValue() ?? await this.app.vault.read(file);
		let from = 0, to = original.length;
		if (editor) {
			from = editor.posToOffset(editor.getCursor('from')); to = editor.posToOffset(editor.getCursor('to'));
			if (from === to) throw Error(t('encryption.text17'));
		}
		return { file, original, from, to, path: file.path };
	}
	async encryptSelection(editor, file = this.app.workspace.getActiveFile()) {
		const snapshot = await this.capture(file, editor);
		if (!editor) throw Error(t('encryption.text18'));
		return this.encrypt(snapshot, 'text');
	}
	readingMenu(event) {
		if (Platform.isMobile || this.stopped) return;
		const preview = event.target?.closest?.('.markdown-preview-view');
		const selection = this.document?.getSelection();
		if (!preview || !selection || selection.isCollapsed || selection.rangeCount !== 1) return;
		const range = selection.getRangeAt(0);
		if (!preview.contains(range.startContainer) || !preview.contains(range.endContainer)) return;
		if ([...preview.querySelectorAll('.wujie-encrypted')].some(area => range.intersectsNode(area))) return;
		const leaf = this.app.workspace.getLeavesOfType('markdown').find(leaf => leaf.view?.containerEl?.contains(preview));
		if (!fileIsNote(leaf?.view.file)) return;
		const text = selection.toString(), original = leaf.view.editor?.getValue(), file = leaf.view.file;
		if (!text.trim() || typeof original !== 'string') return;
		event.preventDefault(); event.stopPropagation(); this.closeActions();
		const menu = new Menu(); this.actionMenu = menu;
		menu.addItem(item => item.setTitle(t('encryption.text19')).setIcon('copy').onClick(() => {
			this.closeActions();
			const clipboard = this.document.defaultView.navigator.clipboard;
			if (clipboard) void clipboard.writeText(text).catch(failure);
			else new Notice(t('encryption.text20'));
		}));
		menu.addItem(item => item.setTitle(t('encryption.encryptSelection')).setIcon('lock').onClick(() => {
			this.closeActions(); void this.encryptReadingSelection(leaf, text, original, file).catch(failure);
		}));
		this.addReadingAction?.(menu, { view: leaf.view, preview, range, text, closeMenu: () => this.closeActions() });
		menu.showAtPosition({ x: event.clientX, y: event.clientY }, this.document);
	}
	async encryptReadingSelection(leaf, text, original, file = leaf.view.file) {
		if (leaf.view.file !== file) throw Error(t('encryption.text21'));
		const snapshot = await this.capture(file);
		if (snapshot.original !== original || !text) throw Error(t('encryption.text22'));
		const from = original.indexOf(text);
		if (from < 0 || original.indexOf(text, from + 1) >= 0) {
			const state = leaf.getViewState();
			await leaf.setViewState({ ...state, state: { ...state.state, mode: 'source' } });
			new Notice(t('encryption.text23'));
			return;
		}
		return this.encrypt({ ...snapshot, from, to: from + text.length }, 'text');
	}
	async encryptNote(file = this.app.workspace.getActiveFile()) {
		const snapshot = await this.capture(file);
		if (lockedRanges(snapshot.original).some(range => range.box?.kind !== 'text')) throw Error(t('encryption.text24'));
		if (await this.app.vault.read(file) !== snapshot.original) throw Error(t('encryption.attachmentIndex'));
		const attachments = findNoteAttachments(this.app, snapshot);
		return this.encrypt(snapshot, 'note', attachments);
	}
	encrypt(snapshot, kind, attachments = []) {
		const { original, from, to } = snapshot;
		const ranges = lockedRanges(original);
		if (ranges.some(range => range.box?.kind !== 'text')) throw Error(t('encryption.text24'));
		if (kind === 'text' && ranges.some(range => range.from < to && range.to > from)) throw Error(t('encryption.text25'));
		const prompt = new PasswordWindow(this, kind === 'note' ? t('encryption.encryptNote') : t('encryption.encryptSelection'), undefined, true, async (password, hint, active) => {
			if (attachments.length) return this.attachmentOperation(async () => {
				const latest = findNoteAttachments(this.app, snapshot);
				if (latest.length !== attachments.length || latest.some(file => !attachments.includes(file))) throw Error(t('encryption.attachmentIndex'));
				let staged, markerWritten = false;
				try {
					await this.verifyAttachmentPath(snapshot.path);
					const box = await createLocked('', password, hint, 'bundle', async (id, key) => {
						staged = await stageNoteAttachments(this.app.vault, id, key, original, latest, path => this.verifyAttachmentPath(path), { embedded: true });
						return staged;
					}, { embedded: true });
					const opened = await openLocked(box, password);
					await this.convert(snapshot, lockedMarker(box), active, async () => {
						markerWritten = true;
						await finishAttachmentLock(this.app, snapshot.path, box.id, opened.key, staged.manifest, active, file => this.removeAttachment(file), box.attachmentData);
					});
				} catch (error) {
					if (markerWritten && active()) throw Error(`${t('encryption.attachmentFinish')} ${error.message}`, { cause: error });
					throw error;
				}
			});
			const box = await createLocked(original.slice(from, to), password, hint, kind);
			if (!active()) throw Error(t('encryption.text26'));
			const next = original.slice(0, from) + lockedMarker(box) + original.slice(to);
			await this.convert(snapshot, next, active);
		});
		prompt.attachments = attachments;
		prompt.externalImages = kind === 'note' && /!\[[^\]\r\n]*\]\(\s*<?file:/iu.test(original);
		prompt.open();
	}
	async attachmentOperation(task) {
		if (!Platform.isMobile && this.app.vault.adapter?.getBasePath) {
			const load = this.document?.defaultView?.require;
			try { this.desktop ??= desktopFiles(this.app.vault, { load }); }
			catch { throw Error(t('encryption.safeWriteUnavailable')); }
			if (!this.desktop) throw Error(t('encryption.safeWriteUnavailable'));
		}
		if (this.owner.exclusive) {
			if (this.owner.running) await this.owner.running.catch(() => {});
			return this.owner.exclusive(task);
		}
		return task();
	}
	async verifyAttachmentPath(path, missing) {
		try { await this.desktop?.verifyAttachmentPath(path, missing); }
		catch { throw Error(t('encryption.attachmentChanged', { path })); }
	}
	async removeAttachment(file) {
		const leaves = [];
		this.app.workspace.iterateAllLeaves?.(leaf => { if (leaf.view?.file === file) leaves.push(leaf); });
		for (const leaf of leaves) await leaf.setViewState({ type: 'empty' });
		await this.verifyAttachmentPath(file.path);
		this.removingAttachments.add(file);
		try { await this.app.vault.delete(file, true); }
		finally { this.removingAttachments.delete(file); }
	}
	async convert(snapshot, next, active, afterWrite) {
		const { file, original, path } = snapshot;
		if (this.busyFiles.has(file)) throw Error(t('encryption.text27'));
		this.busyFiles.add(file);
		const leaves = this.app.workspace.getLeavesOfType('markdown').filter(leaf => leaf.view?.file === file);
		const states = leaves.map(leaf => ({ leaf, state: leaf.getViewState() }));
		try {
			if (!active() || file.path !== path) throw Error(t('encryption.text28'));
			// Save existing edits first, then retire every editor/undo history before the cipher write.
			for (const { leaf } of states) {
				if (leaf.view.editor?.getValue() !== original) throw Error(t('encryption.text22'));
				await leaf.view.save();
			}
			if (await this.app.vault.read(file) !== original) throw Error(t('encryption.text29'));
			const mtime = file.stat.mtime;
			this.owner.cancelEditorSaves?.();
			for (const { leaf } of states) await leaf.setViewState({ type: 'empty' });
			await replaceLocked(this.app.vault, file, original, next, mtime, () => active() && file.path === path);
			await this.forgetOldPlaintext(path);
			await afterWrite?.();
			new Notice(t('encryption.text30'));
		} finally {
			try {
				for (const { leaf, state } of states) {
					if (leaf.view.getViewType?.() === 'empty') await leaf.setViewState(state);
				}
			} finally { this.busyFiles.delete(file); }
		}
	}
	async forgetOldPlaintext(path) {
		for (const state of Object.values(this.owner.data?.connections ?? {})) {
			state.localEncryption ??= {}; state.localEncryption[path] = true;
			for (const note of Object.values(state.notes ?? {})) if (note.path === path) { delete note.base; delete note.baseAt; }
		}
		for (const view of this.owner.noteSearchViews ?? []) { view.index.clear(); view.resultsEl?.empty(); view.schedule?.(0); }
		if (this.owner.data) await this.owner.saveData(this.owner.data);
	}
	renderLock(area, path, marker, box, parentSession) {
		this.areas.set(area, { path, marker, box, parentSession });
		area.addClass('wujie-encrypted');
		area.classList?.remove('is-open', 'is-editing', 'is-unified');
		const whole = box && box.kind !== 'text';
		area.classList?.toggle('is-whole-note', Boolean(whole));
		button(area, whole ? t('encryption.text31') : box ? t('encryption.text32') : t('encryption.text33'), () => {
			if (box) this.unlock(area, path, marker, box, parentSession);
		});
		if (box) {
			const more = event => {
				event?.preventDefault(); event?.stopPropagation();
				const target = { area, path, marker, box, parentSession, version: 0, saved: 0 };
				this.openActions(target, event);
			};
			const moreButton = button(area, '⋯', more); moreButton.addClass('wujie-crypto-more');
			moreButton.setAttribute?.('aria-label', t('encryption.text34')); area.oncontextmenu = more;
		}
	}
	openActions(session, event) {
		event?.preventDefault(); event?.stopPropagation();
		this.closeActions();
		const unlocked = this.sessions.has(session) && !session.locked;
		const actions = unlocked ? [
			...(!session.editor ? [[t('encryption.text35'), 'pencil', () => this.editSession(session)]] : []),
			[t('encryption.text36'), 'lock', () => this.lock(session)],
		] : [[t('encryption.text37'), 'unlock', () => this.unlock(session.area, session.path, session.marker, session.box, session.parentSession)]];
		actions.push([t('encryption.text38'), 'key-round', () => this.changePassword(session)], [t('encryption.text09'), 'unlock', () => this.permanent(session)]);
		if (session.box.kind === 'text') actions.push([t('encryption.removeBlock'), 'trash-2', () => this.permanent(session, { remove: true })]);
		if (Platform.isMobile) { const modal = new EncryptionActions(this, actions); this.actionMenu = modal; modal.open(); return; }
		const menu = new Menu(); this.actionMenu = menu;
		for (const [title, icon, action] of actions) menu.addItem(item => item.setTitle(title).setIcon(icon).onClick(() => { this.closeActions(); action(); }));
		const bounds = session.area.getBoundingClientRect();
		menu.showAtPosition({ x: event?.clientX || bounds.left, y: event?.clientY || bounds.bottom }, session.area.ownerDocument);
	}
	closeActions() { const menu = this.actionMenu; this.actionMenu = undefined; if (menu?.hide) menu.hide(); else menu?.close(); }
	unlock(area, path, marker, box, parentSession) {
		new PasswordWindow(this, t('encryption.text37'), box, false, async (password, _hint, active) => {
			const retainWrappingKey = !parentSession && box.kind !== 'text';
			const opened = await openLocked(box, password, { retainWrappingKey });
			if (!active() || !area.isConnected) return;
			const file = this.app.vault.getAbstractFileByPath(path);
			const source = parentSession ? parentSession.locked ? '' : parentSession.text : file ? await this.app.vault.read(file) : '';
			const ranges = lockedRanges(source).filter(range => range.box?.id === box.id && encodeBox(range.box) === encodeBox(box));
			if (ranges.length !== 1 || !active()) throw Error(t('encryption.text39'));
			const manifest = box.kind === 'bundle' ? parseAttachmentManifest(opened.text) : undefined;
			let attachmentBytes;
			if (manifest) {
				if (manifest.restoring) throw Error(t('encryption.attachmentRestoring'));
				attachmentBytes = box.v === 3
					? await verifyNoteAttachments(this.app.vault, box.id, opened.key, manifest, box.attachmentData)
					: await this.attachmentOperation(() => finishAttachmentLock(this.app, path, box.id, opened.key, manifest, active, file => this.removeAttachment(file)));
				if (!active() || !area.isConnected || await this.app.vault.read(file) !== source) throw Error(t('encryption.text39'));
			}
			const session = { area, path, parentSession, marker: ranges[0].marker, box, key: opened.key, wrapKey: opened.wrapKey, text: manifest?.text ?? opened.text, manifest, attachmentBytes, epoch: this.epoch, lastUse: Date.now(), version: 0, saved: 0 };
			this.areas.set(area, session);
			this.sessions.add(session);
			session.unified = !parentSession && box.kind !== 'text' && !lockedRanges(session.text).length;
			if (session.unified) this.editSession(session, false);
			else this.showSession(session);
		}).open();
	}
	showSession(session) {
		const { area } = session;
		area.empty();
		area.classList?.toggle('is-open', true); area.classList?.toggle('is-editing', false);
		area.onpointerdown = () => { session.lastUse = Date.now(); };
		area.onkeydown = () => { session.lastUse = Date.now(); };
		const content = area.createSpan({ cls: 'wujie-decrypted-text', attr: { tabindex: '0', role: 'button', 'aria-label': t('encryption.text40') } });
		let offset = 0;
		for (const range of lockedRanges(session.text)) {
			content.createSpan({ text: session.text.slice(offset, range.from) });
			this.renderLock(content.createSpan(), session.path, range.marker, range.box, session);
			offset = range.to;
		}
		content.createSpan({ text: session.text.slice(offset) });
		if (session.manifest) this.showAttachments(session);
		const more = event => this.openActions(session, event);
		content.addEventListener('click', event => {
			if (event.target.closest?.('.wujie-encrypted') !== area || area.ownerDocument.getSelection()?.isCollapsed === false) return;
			more(event);
		});
		content.addEventListener('keydown', event => { if (event.target === content && (event.key === 'Enter' || event.key === ' ')) more(event); });
		const moreButton = button(area, '⋯', more); moreButton.addClass('wujie-crypto-more'); moreButton.setAttribute?.('aria-label', t('encryption.text34'));
		area.oncontextmenu = more;
	}
	async showAttachments(session) {
		const area = session.attachmentArea = session.area.createSpan({ cls: 'wujie-decrypted-attachments' });
		const urls = session.urls = new Set();
		for (const entry of session.manifest.entries) {
			const item = area.createSpan({ cls: 'wujie-decrypted-attachment' });
			item.createSpan({ text: entry.path });
			const url = await this.attachmentImage(session, entry, urls);
			if (url && session.urls === urls)
				item.createEl('img', { attr: { src: url, alt: entry.path, draggable: 'false', loading: 'lazy' } });
		}
	}
	async attachmentImage(session, entry, urls) {
		const window = session.area.ownerDocument.defaultView;
		const type = attachmentPreviewType(entry.path);
		if (!type || session.urls !== urls || session.locked || !window?.URL?.createObjectURL) return;
		try {
			const clear = await decryptAttachment(session.attachmentBytes, session.box.id, session.key, entry);
			try {
				if (session.urls !== urls || session.locked || !session.area.isConnected) return;
				const url = window.URL.createObjectURL(new window.Blob([clear], { type }));
				urls.add(url);
				return url;
			} finally { clear.fill(0); }
		} catch (error) {
			if (!session.locked && session.urls === urls) failure(error);
		}
	}
	async showInlineAttachments(session) {
		const editor = session.editor, urls = session.urls = new Set(), images = [];
		for (const entry of session.manifest.entries) {
			const url = await this.attachmentImage(session, entry, urls);
			if (session.urls !== urls || session.locked) return;
			if (url) images.push({ path: entry.path, url });
		}
		if (session.editor === editor) editor.setImages(images);
	}
	clearAttachmentPreviews(session) {
		const url = session.area.ownerDocument.defaultView?.URL;
		for (const value of session.urls ?? []) url?.revokeObjectURL(value);
		session.urls = undefined;
		session.attachmentArea?.remove();
		session.attachmentArea = undefined;
	}
	chooseAttachments(session) {
		if (session.locked || !session.wrapKey) return;
		this.cancelAttachmentPicker?.();
		const document = session.area.ownerDocument;
		const position = session.editor?.view.state.selection.main.head ?? session.text.length;
		const revision = session.version;
		const picker = document.body.createEl('input', { type: 'file' });
		picker.multiple = true;
		picker.hidden = true;
		const dispose = () => {
			document.removeEventListener('visibilitychange', selected);
			picker.remove();
			if (this.cancelAttachmentPicker === dispose) this.cancelAttachmentPicker = undefined;
		};
		const selected = () => {
			if (document.hidden) return;
			const files = [...picker.files ?? []];
			dispose();
			if (!files.length) return;
			if (session.version !== revision) { failure(Error(t('encryption.writeContextChanged'))); return; }
			void this.saveAttachments(session, files, position).catch(failure);
		};
		this.cancelAttachmentPicker = dispose;
		picker.addEventListener('cancel', dispose, { once: true });
		picker.addEventListener('change', () => {
			if (document.hidden) document.addEventListener('visibilitychange', selected);
			else selected();
		}, { once: true });
		picker.click();
	}
	async saveAttachments(session, files, position = session.editor?.view.state.selection.main.head ?? session.text.length) {
		const active = () => !session.locked && session.area.isConnected && this.active(session.epoch);
		if (!active() || !session.wrapKey) throw Error(t('encryption.importLocked'));
		if (session.attachmentWork) throw Error(t('encryption.attachmentBusy'));
		const saving = this.queueSave(session);
		const insertion = session.attachmentInsertion = { position };
		const work = saving.then(() => {
			if (!active()) throw Error(t('encryption.importLocked'));
			session.status?.setText(t('encryption.text43'));
			return this.importAttachments(session, files, active, insertion);
		}).catch(error => {
			if (active() && session.saved === session.version) session.status?.setText('');
			throw error;
		}).finally(() => {
			session.attachmentWork = undefined;
			session.attachmentInsertion = undefined;
			this.pendingWrites.delete(work);
			if (!session.locked && session.saved !== session.version) void this.queueSave(session);
		});
		session.attachmentWork = work;
		this.pendingWrites.add(work);
		return work;
	}
	async importAttachments(session, files, active, insertion) {
		await this.attachmentOperation(async () => {
			const { vault } = this.app;
			const file = vault.getAbstractFileByPath(session.path);
			const previous = session.box;
			const revision = session.version;
			const canCommit = () => active() && session.box === previous && session.version === revision && session.saved === revision;
			if (!fileIsNote(file) || !canCommit() || await vault.read(file) !== session.marker)
				throw Error(t('encryption.writeContextChanged'));
			await this.verifyAttachmentPath(session.path);
			const { manifest, text, wrapKey } = session;
			if (manifest?.restoring) throw Error(t('encryption.attachmentRestoring'));
			const prior = manifest && {
				id: previous.id, key: session.key, manifest, bytes: await readAttachmentPackage(vault, previous.id, manifest, previous.attachmentData),
			};
			let staged;
			try {
				let key;
				if (!canCommit()) throw Error(t('encryption.writeContextChanged'));
				const next = await createAttachmentRevision(previous, wrapKey, async (id, newKey) => {
					key = newKey;
					staged = await stageImportedAttachments(vault, id, key, text, session.path, files,
						prior, (path, missing) => this.verifyAttachmentPath(path, missing), canCommit, insertion.position);
					return staged;
				});
				for (const entry of staged.manifest.entries.slice(manifest?.entries.length ?? 0)) {
					if (vault.getAbstractFileByPath(entry.path) || await vault.adapter.exists(entry.path))
						throw Error(t('encryption.attachmentChanged', { path: entry.path }));
				}
				const marker = lockedMarker(next);
				session.writingMarker = marker;
				session.restoreInputFocus = session.editor?.view.hasFocus ?? false;
				await this.replaceMarker(session, marker, false, canCommit);
				session.box = next; session.marker = marker;
				for (const other of this.sessions) {
					if (other !== session && other.path === session.path) void this.lock(other);
				}
				const unchanged = session.version === revision;
				const { position } = insertion;
				const inserted = attachmentInsertion(session.text, position, staged.links);
				if (!session.locked || !unchanged) {
					session.key = key;
					session.manifest = staged.manifest;
					// The insertion tracks intervening edits while the saved marker is refreshed.
					session.text = session.text.slice(0, position) + inserted + session.text.slice(position);
				}
				if (!session.locked) {
					session.attachmentBytes = staged.bytes;
					if (session.editor) {
						session.editor.insertAttachmentText(position, inserted);
						this.clearAttachmentPreviews(session);
						void this.showInlineAttachments(session);
					} else this.showSession(session);
					session.status?.setText(t(unchanged ? 'encryption.attachmentsSaved' : 'encryption.text43'));
				} else this.refreshLockedSession(session);
				new Notice(t('encryption.attachmentsSaved'));
			} finally {
				session.writingMarker = undefined;
			}
			const oldPackage = previous.v === 2 && manifest && vault.getAbstractFileByPath(attachmentPackagePath(previous.id));
			if (oldPackage) await this.removeAttachment(oldPackage).catch(failure);
		});
	}
	editSession(session, focus = true) {
		if (session.locked) return;
		if (session.editor) {
			if (focus) session.editor.view.focus();
			return;
		}
		if ([...this.sessions].some(child => child.parentSession === session))
			return this.flushChildren(session).then(() => this.editSession(session)).catch(failure);
		this.clearAttachmentPreviews(session);
		session.lastUse = Date.now(); session.area.empty();
		session.area.oncontextmenu = null;
		session.area.onpointerdown = session.area.onkeydown = () => { session.lastUse = Date.now(); };
		session.area.classList?.add('is-open', 'is-editing');
		session.area.classList?.toggle('is-unified', Boolean(session.unified));
		const wholeNote = !session.parentSession && session.box.kind !== 'text';
		const canAttach = wholeNote && Boolean(session.wrapKey);
		session.area.createDiv({ cls: 'wujie-crypto-edit-hint', text: t(canAttach ? 'encryption.editWithAttachments' : 'encryption.editTextOnly') });
		const toolbar = session.area.createDiv({ cls: 'wujie-crypto-formatting' });
		const editorArea = session.area.createDiv({ cls: 'wujie-crypto-editor' });
		session.status = session.area.createDiv({ attr: { role: 'status', 'aria-live': 'polite' } });
		const editor = session.editor = createSecureEditor(editorArea, session.text, {
			label: t('encryption.text42'),
			path: session.path,
			onLimit: () => session.status.setText(t('encryption.editTooLarge', { limit: formatStorageSize(NOTE_LIMIT) })),
			onChange: (text, changes) => {
				if (session.locked) return;
				const insertion = session.attachmentInsertion;
				if (insertion) insertion.position = changes.mapPos(insertion.position, 1);
				session.text = text; session.version++; session.lastUse = Date.now();
				session.status.setText(t('encryption.text43')); this.queueSave(session);
			},
		});
		const importFiles = (event, files, position) => {
			if (!files?.length) return;
			event.preventDefault();
			event.stopPropagation();
			if (canAttach) void this.saveAttachments(session, [...files], position).catch(failure);
			else new Notice(t('encryption.editTextOnly'));
		};
		editorArea.addEventListener('paste', event => importFiles(event, event.clipboardData?.files), true);
		editorArea.addEventListener('dragover', event => {
			if (!canAttach || !Array.from(event.dataTransfer?.types ?? []).includes('Files')) return;
			event.preventDefault();
			event.stopPropagation();
			event.dataTransfer.dropEffect = 'copy';
		}, true);
		editorArea.addEventListener('drop', event => {
			const position = event.dataTransfer?.files?.length && Number.isFinite(event.clientX) && Number.isFinite(event.clientY)
				? editor.view.posAtCoords({ x: event.clientX, y: event.clientY }, false) : undefined;
			importFiles(event, event.dataTransfer?.files, position ?? undefined);
		}, true);
		const formats = [
			['H2', 'heading', '## ', true], ['B', 'bold', '**'], ['I', 'italic', '*'],
			['•', 'list', '- ', true], ['❝', 'quote', '> ', true], ['</>', 'code', '`'],
		];
		for (const [symbol, name, marker, lines] of formats) {
			const action = button(toolbar, symbol, () => editor.format(marker, lines));
			action.title = t(`encryption.format.${name}`);
			action.setAttribute('aria-label', action.title);
			action.addEventListener('mousedown', event => event.preventDefault());
		}
		if (canAttach) button(toolbar, t('encryption.addAttachments'), () => this.chooseAttachments(session));
		const imageSource = button(toolbar, t('encryption.imageSource'), () => {
			imageSource.setAttribute('aria-pressed', String(editor.toggleImageSource()));
		});
		imageSource.setAttribute('aria-pressed', 'false');
		if (session.unified) {
			const more = button(toolbar, '⋯', event => this.openActions(session, event));
			more.setAttribute('aria-label', t('encryption.text34'));
		}
		button(session.area, t('encryption.text44'), () => { void this.finishEditing(session); });
		button(session.area, t('encryption.text36'), () => this.lock(session));
		button(session.area, t('encryption.text70'), () => this.settings());
		if (session.manifest) void this.showInlineAttachments(session);
		this.watchRenderedEditor(session);
		if (focus) editor.view.focus();
	}
	watchRenderedEditor(session) {
		if (session.renderObserver || this.widgetViews.has(session.area)) return;
		const view = this.app.workspace.getLeavesOfType('markdown').map(leaf => leaf.view)
			.find(view => view?.file?.path === session.path && view.containerEl?.contains(session.area));
		if (!view) return;
		const { ownerDocument } = session.area;
		const restore = () => {
			if (session.locked || !session.editor || session.area.isConnected || view.file?.path !== session.path) return;
			const replacements = [...view.containerEl.querySelectorAll('.wujie-encrypted')].filter(area => {
				if (this.widgetViews.has(area)) return false;
				const lock = this.areas.get(area);
				return lock?.path === session.path && (lock.marker === session.writingMarker || lock.marker === session.marker);
			});
			if (replacements.length !== 1) return;
			replacements[0].replaceWith(session.area);
			if (session.restoreInputFocus && ownerDocument.activeElement === ownerDocument.body && ownerDocument.hasFocus())
				session.editor.view.focus();
			session.restoreInputFocus = false;
		};
		session.renderObserver = new ownerDocument.defaultView.MutationObserver(restore);
		session.renderObserver.observe(view.containerEl, { childList: true, subtree: true });
	}
	stopWatchingRenderedEditor(session) {
		session.renderObserver?.disconnect();
		session.renderObserver = undefined;
		session.restoreInputFocus = false;
	}
	async finishEditing(session) {
		await this.queueSave(session);
		if (!session.locked && session.saved === session.version) {
			if (session.unified) {
				session.editor?.view.contentDOM.blur();
				return;
			}
			this.stopWatchingRenderedEditor(session);
			session.editor?.destroy();
			session.editor = undefined;
			this.clearAttachmentPreviews(session);
			this.showSession(session);
		}
	}
	queueSave(session) {
		if (session.attachmentWork) return session.attachmentWork.catch(() => {});
		if (session.work) return session.work;
		if (session.saved === session.version) return Promise.resolve();
		const work = (async () => {
			while (session.saved < session.version) {
				const version = session.version, text = session.text;
				session.pendingBox = undefined;
				const nextBox = await updateLocked(session.box, session.key, session.manifest ? JSON.stringify({ ...session.manifest, text }) : text);
				const nextMarker = lockedMarker(nextBox);
				session.pendingBox = nextBox;
				// Journal contains ciphertext only, including when a concurrent edit prevents saving.
				await this.writeDraft(session, nextBox);
				try {
					session.writingMarker = nextMarker;
					session.restoreInputFocus = session.editor?.view.hasFocus ?? false;
					const preserveTime = session.preserveTime === true;
					session.preserveTime = false;
					await this.replaceMarker(session, nextMarker, preserveTime);
					session.box = nextBox; session.marker = nextMarker; session.saved = version;
					session.failed = false; this.volatileDrafts.delete(session.box.id);
					session.pendingBox = undefined;
					session.writingMarker = undefined;
					await this.removeDraft(session.box.id);
					if (!session.locked) session.status?.setText('');
				} catch {
					session.draft = nextBox;
					if (!session.locked) session.status?.setText(t('encryption.text46'));
					else new Notice(t('encryption.text47'));
					break;
				}
			}
		})().catch(() => {
			// Never announce durability when the encrypted journal itself failed.
			session.failed = true;
			if (session.pendingBox) this.volatileDrafts.set(session.box.id, this.draftEntry(session, session.pendingBox));
			if (!session.locked) session.status?.setText(t('encryption.text48'));
			new Notice(t('encryption.text49'));
		}).finally(() => {
			session.work = undefined;
			if (session.locked && !session.closing && (!session.failed || session.pendingBox)) { session.text = ''; session.key = undefined; }
			if (session.locked) this.refreshLockedSession(session);
			this.pendingWrites.delete(work);
		});
		session.work = work; this.pendingWrites.add(work);
		return work;
	}
	async replaceMarker(session, next, preserveTime, active = () => true) {
		if (session.parentSession) {
			const parent = session.parentSession;
			if (!active() || !parent.key) throw Error(t('encryption.text50'));
			const matches = lockedRanges(parent.text).filter(range => range.marker === session.marker);
			if (matches.length !== 1) throw Error(t('encryption.text51'));
			const [range] = matches;
			parent.text = parent.text.slice(0, range.from) + next + parent.text.slice(range.to); parent.version++;
			parent.preserveTime = preserveTime && parent.saved === parent.version - 1;
			await this.queueSave(parent);
			if (parent.saved !== parent.version) throw Error(t('encryption.text52'));
			return parent.text;
		}
		const file = this.app.vault.getAbstractFileByPath(session.path);
		if (!fileIsNote(file)) throw Error(t('encryption.text53'));
		if (this.busyFiles.has(file)) throw Error(t('encryption.text54'));
		const prior = this.locks.get(file) ?? Promise.resolve();
		const write = prior.catch(() => {}).then(async () => {
			if (!active()) throw Error(t('encryption.text55'));
			const current = await this.app.vault.read(file);
			const ranges = lockedRanges(current).filter(range => range.marker === session.marker);
			if (ranges.length !== 1) throw Error(t('encryption.text56'));
			const range = ranges[0];
			const nextText = current.slice(0, range.from) + next + current.slice(range.to);
			const openViews = () => this.app.workspace.getLeavesOfType('markdown')
				.map(leaf => leaf.view).filter(view => view?.file === file);
			const content = view => view.getViewData?.() ?? view.editor?.getValue();
			const unchanged = () => openViews().every(view => content(view) === current);
			// An editor containing newer unsaved surrounding text must not be overwritten.
			if (!unchanged()) throw Error(t('encryption.text57'));
			this.viewWrites.set(file, { current, next: nextText });
			try {
				await replaceLocked(this.app.vault, file, current, nextText, preserveTime ? file.stat.mtime : undefined,
					() => active() && unchanged());
				// Obsidian may update the saved baseline before refreshing the live editor.
				for (const view of openViews()) {
					if (content(view) === current) view.setViewData?.(nextText, false);
				}
			} finally { this.viewWrites.delete(file); }
			return nextText;
		});
		this.locks.set(file, write);
		try { return await write; } finally { if (this.locks.get(file) === write) this.locks.delete(file); }
	}
	changePassword(session) {
		new PasswordWindow(this, t('encryption.text58'), session.box, false, async (password, _hint, active) => {
			await this.flushChildren(session);
			await this.queueSave(session);
			if (session.saved !== session.version) throw Error(t('encryption.text59'));
			await openLocked(session.box, password);
			if (!active()) return;
			// Keep only a temporary non-extractable wrapping operation, never a saved password.
			const oldPassword = password;
			new PasswordWindow(this, t('encryption.text60'), session.box, true, async (nextPassword, hint, nextActive) => {
				const next = await rewrapLocked(session.box, oldPassword, nextPassword, hint);
				if (!nextActive()) return;
				await this.replaceMarker(session, lockedMarker(next), true, nextActive);
				session.box = next; session.marker = lockedMarker(next);
				this.lock(session);
			}).open();
		}).open();
	}
	permanent(session, { remove = false } = {}) {
		if (remove && session.box.kind !== 'text') return;
		const title = t(remove ? 'encryption.removeBlock' : 'encryption.text09');
		new PasswordWindow(this, title, session.box, false, async (password, _hint, active) => {
			await this.flushChildren(session);
			await this.queueSave(session);
			if (session.saved !== session.version) throw Error(t('encryption.text59'));
			const opened = await openLocked(session.box, password);
			if (session.box.kind === 'bundle') return this.attachmentOperation(() => this.restoreAttachmentBundle(session, opened, active));
			const text = remove ? '' : opened.text;
			if (!active()) return;
			const saved = await this.replaceMarker(session, text, !remove, active);
			if (!session.parentSession && !containsLockedText(saved)) {
				for (const state of Object.values(this.owner.data?.connections ?? {})) if (state.localEncryption) delete state.localEncryption[session.path];
				if (this.owner.data) await this.owner.saveData(this.owner.data);
			}
			this.clearSession(session);
			if (session.parentSession && !session.parentSession.locked) session.area.createSpan({ text });
			if (!remove) new Notice(t('encryption.text61'));
		}).open();
	}
	async restoreAttachmentBundle(session, opened, active) {
		const manifest = parseAttachmentManifest(opened.text);
		await this.verifyAttachmentPath(session.path);
		await restoreNoteAttachments(this.app.vault, session.box.id, opened.key, manifest, active,
			(path, missing) => this.verifyAttachmentPath(path, missing), {
				attachmentData: session.box.attachmentData,
				beforeRestore: async () => {
					if (manifest.restoring) return;
					const box = await updateLocked(session.box, opened.key, JSON.stringify({ ...manifest, restoring: true }));
					const marker = lockedMarker(box);
					session.writingMarker = marker;
					try {
						await this.replaceMarker(session, marker, true, active);
						session.box = box; session.marker = marker;
					} finally { session.writingMarker = undefined; }
				},
			});
		const saved = await this.replaceMarker(session, manifest.text, true, active);
		if (!containsLockedText(saved)) {
			for (const state of Object.values(this.owner.data?.connections ?? {})) if (state.localEncryption) delete state.localEncryption[session.path];
			if (this.owner.data) await this.owner.saveData(this.owner.data);
		}
		this.clearSession(session);
		const pack = session.box.v === 2 && this.app.vault.getAbstractFileByPath(attachmentPackagePath(session.box.id));
		if (pack) await this.removeAttachment(pack);
		new Notice(t('encryption.text61'));
	}
	clearSession(session, retaining = false) {
		this.closeActions();
		session.locked = true;
		session.wrapKey = undefined;
		this.stopWatchingRenderedEditor(session);
		this.clearAttachmentPreviews(session);
		session.attachmentBytes = undefined;
		session.manifest = session.work || session.saved !== session.version ? session.manifest : undefined;
		session.editor?.destroy();
		session.editor = undefined;
		session.area.empty(); this.sessions.delete(session);
		if (!retaining && !session.work && !session.failed) { session.text = ''; session.key = undefined; }
	}
	refreshLockedSession(session) {
		const current = this.areas.get(session.area);
		if (session.area.isConnected && (current === session || current?.lockOwner === session)) {
			session.area.empty(); this.renderLock(session.area, session.path, session.marker, session.box, session.parentSession);
			this.areas.get(session.area).lockOwner = session;
		}
	}
	async flushChildren(session) {
		const children = [...this.sessions].filter(child => child.parentSession === session);
		await Promise.all(children.map(child => this.lock(child)));
		if (children.some(child => child.saved !== child.version)) throw Error(t('encryption.text62'));
	}
	lock(session) {
		if (session.locked) return session.lockWork;
		const children = [...this.sessions].filter(child => child.parentSession === session);
		session.closing = true;
		const childWork = children.map(child => this.lock(child));
		this.clearSession(session, true);
		this.renderLock(session.area, session.path, session.marker, session.box, session.parentSession);
		this.areas.get(session.area).lockOwner = session;
		const lockWork = Promise.all([...childWork, session.attachmentWork?.catch(() => {})]).then(() => this.queueSave(session)).finally(() => {
			session.closing = false;
			if (!session.failed || session.pendingBox) { session.text = ''; session.key = undefined; session.manifest = undefined; }
			this.pendingWrites.delete(lockWork);
			this.refreshLockedSession(session);
		});
		session.lockWork = lockWork; this.pendingWrites.add(lockWork);
		return lockWork;
	}
	lockAll() {
		this.closeActions();
		this.epoch++;
		for (const prompt of [...this.prompts]) prompt.close();
		for (const session of [...this.sessions]) this.lock(session);
	}
	sweep() {
		if (this.document?.hidden) { this.lockAll(); return; }
		for (const session of [...this.sessions]) {
			const open = this.app.workspace.getLeavesOfType('markdown').some(leaf => leaf.view?.file?.path === session.path);
			const idle = this.owner.data?.encryptionPreferences?.idleMinutes ?? 5;
			const refreshing = session.writingMarker && session.renderObserver && (session.work || session.attachmentWork);
			if ((!session.area.isConnected && !refreshing) || !open || idle > 0 && Date.now() - session.lastUse >= idle * 60_000) this.lock(session);
		}
	}
	async writeDraft(session, box) {
		const adapter = this.app.vault.adapter;
		if (!adapter || typeof adapter.write !== 'function') throw Error(t('encryption.text63'));
		let parent = '';
		for (const part of this.recoveryDir.split('/')) {
			parent = parent ? parent + '/' + part : part;
			if (!await adapter.exists(parent)) await adapter.mkdir(parent);
		}
		await adapter.write(`${this.recoveryDir}/${box.id}.json`, JSON.stringify(this.draftEntry(session, box)));
	}
	draftEntry(session, box) {
		return { format: 1, source: session.path, iv: session.box.iv, wrapIV: session.box.wrapIV, box };
	}
	async recoverDraftEntry(entry, box) {
		const { vault } = this.app;
		if (box.kind !== 'bundle' || box.v === 3) return vault.create(`${t('encryption.recoveredName')}-${box.id}-${Date.now()}.md`, lockedMarker(box));
		const file = vault.getAbstractFileByPath(entry.source);
		if (!fileIsNote(file)) throw Error(t('encryption.writeContextChanged'));
		const current = await vault.read(file);
		const [range] = lockedRanges(current);
		if (range?.box?.id !== box.id || range.marker !== current || range.box.iv !== entry.iv || range.box.wrapIV !== entry.wrapIV)
			throw Error(t('encryption.writeContextChanged'));
		await this.convert({ file, original: current, path: file.path }, lockedMarker(box), () => !this.stopped);
		return file;
	}
	async removeDraft(id) {
		if (!safeId(id)) return;
		const path = `${this.recoveryDir}/${id}.json`;
		if (await this.app.vault.adapter.exists(path)) await this.app.vault.adapter.remove(path);
	}
	async recoverDrafts() {
		const adapter = this.app.vault.adapter;
		const files = adapter && await adapter.exists(this.recoveryDir) ? (await adapter.list(this.recoveryDir)).files : [];
		if (!files.length && !this.volatileDrafts.size) { new Notice(t('encryption.text64')); return; }
		const modal = new Modal(this.app); modal.setTitle(t('encryption.text65'));
		modal.contentEl.createEl('p', { text: t('encryption.text66') });
		for (const [id, entry] of this.volatileDrafts) button(modal.contentEl, t('encryption.text67'), () => { void (async () => {
			const file = await this.recoverDraftEntry(entry, entry.box);
			this.volatileDrafts.delete(id); await this.app.workspace.getLeaf(false).openFile(file); modal.close();
		})().catch(failure); });
		for (const path of files) {
			if (!/^([a-f0-9]{32})\.json$/u.test(path.slice(this.recoveryDir.length + 1)) || !path.startsWith(this.recoveryDir + '/')) continue;
			const row = modal.contentEl.createDiv();
			button(row, t('encryption.text68'), () => { void (async () => {
				const raw = await adapter.read(path);
				if (raw.length > NOTE_DRAFT_LIMIT) throw Error(t('encryption.text69'));
				const entry = JSON.parse(raw), box = decodeBox(encodeBox(entry.box));
				if (entry.format !== 1) throw Error(t('encryption.text69'));
				const file = await this.recoverDraftEntry(entry, box);
				await adapter.remove(path); await this.app.workspace.getLeaf(false).openFile(file); modal.close();
			})().catch(failure); });
		}
		modal.open();
	}
	settings() {
		const modal = new Modal(this.app); modal.setTitle(t('encryption.text70'));
		const row = modal.contentEl.createEl('label', { text: t('encryption.text71') });
		const select = row.createEl('select', { attr: { 'aria-label': t('encryption.text72') } });
		for (const [value, text] of [[1, t('encryption.text73')], [5, t('encryption.text74')], [15, t('encryption.text75')], [0, t('encryption.text76')]]) select.createEl('option', { text, value: String(value) });
		select.value = String(this.owner.data?.encryptionPreferences?.idleMinutes ?? 5);
		modal.contentEl.createEl('p', { text: t('encryption.text77') });
		button(modal.contentEl, t('encryption.text78'), () => { void (async () => {
			const minutes = Number(select.value);
			if (![0, 1, 5, 15].includes(minutes)) throw Error(t('encryption.text79'));
			this.owner.data.encryptionPreferences = { idleMinutes: minutes };
			await this.owner.saveData(this.owner.data); modal.close();
		})().catch(failure); });
		modal.open();
	}
	dispose() {
		this.cancelAttachmentPicker?.(); this.lockAll(); this.stopped = true;
		this.explorerObserver?.disconnect();
		clearTimeout(this.explorerTimer);
		for (const row of this.badgedRows) row.classList.remove('wujie-locked-file');
		this.badgedRows.clear();
	}
}

class LockWidget extends WidgetType {
	constructor(manager, marker, box, block) { super(); Object.assign(this, { manager, marker, box, block }); }
	eq(other) { return other.marker === this.marker && other.manager === this.manager && other.block === this.block; }
	toDOM(view) {
		const file = editorInfoField ? view.state.field(editorInfoField, false)?.file : undefined;
		// CodeMirror can recreate the widget when Obsidian refreshes the saved
		// marker. Keep the active secure editor attached to its own note.
		for (const session of this.manager.sessions) {
			if (session.path === file?.path && !session.parentSession && !session.locked &&
				(session.writingMarker === this.marker || session.marker === this.marker) &&
				this.manager.widgetViews.get(session.area) === view) return session.area;
		}
		const area = view.dom.ownerDocument.createElement('span');
		this.manager.widgetViews.set(area, view);
		this.manager.renderLock(area, file?.path, this.marker, this.box);
		area.addClass('wujie-crypto-source-lock');
		area.classList.toggle('wujie-crypto-block-lock', this.block);
		return area;
	}
	updateDOM(area) {
		if (area.classList.contains('wujie-crypto-block-lock') !== this.block) return false;
		const current = this.manager.areas.get(area);
		if (current?.writingMarker === this.marker && this.manager.sessions.has(current) && !current.locked) return true;
		if (current?.box?.id !== this.box?.id) return false;
		if (this.manager.sessions.has(current) && !current.locked) {
			if (current.marker === this.marker || current.writingMarker === this.marker) return true;
			this.manager.lock(current);
		}
		const owner = this.manager.areas.get(area)?.lockOwner;
		area.empty(); this.manager.renderLock(area, current.path, this.marker, this.box, current.parentSession);
		if (owner && (owner.marker === this.marker || owner.writingMarker === this.marker)) this.manager.areas.get(area).lockOwner = owner;
		return true;
	}
	ignoreEvent() { return true; }
	destroy(area) {
		const session = this.manager.areas.get(area);
		if (this.manager.sessions.has(session)) queueMicrotask(() => {
			if (!area.isConnected && this.manager.sessions.has(session)) this.manager.lock(session);
		});
	}
}

export function encryptionExtension(manager, addSelectionAction) {
	const inspect = doc => {
		const source = doc.toString();
		const ranges = lockedRanges(source);
		const isolated = ranges.length === 1 && !ranges[0].marker.startsWith(TEXT_PREFIX) &&
			!source.slice(0, ranges[0].from).trim() && !source.slice(ranges[0].to).trim();
		const decorations = Decoration.set(ranges.map(range => Decoration.replace({
			widget: new LockWidget(manager, range.marker, range.box, isolated),
			block: isolated,
		}).range(isolated ? 0 : range.from, isolated ? doc.length : range.to)), true);
		return { ranges, wholeNote: isolated || ranges.some(({ box }) => box && box.kind !== 'text'), decorations };
	};
	const field = StateField.define({
		create: state => inspect(state.doc),
		update: (value, transaction) => transaction.docChanged ? inspect(transaction.newDoc) : value,
		provide: value => [
			EditorView.decorations.from(value, state => state.decorations),
			EditorView.atomicRanges.of(view => view.state.field(value).decorations),
			Prec.highest(EditorState.readOnly.computeN([value], state => state.field(value).wholeNote ? [true] : [])),
			Prec.highest(EditorView.contentAttributes.computeN([value], state => state.field(value).wholeNote
				? [{ contenteditable: 'false' }] : [])),
		],
	});
	const hostInfo = state => editorInfoField ? state.field(editorInfoField, false) : undefined;
	const protect = EditorState.transactionFilter.of(transaction => {
		if (!transaction.docChanged) return transaction;
		const { startState, newDoc } = transaction;
		const { ranges, wholeNote } = startState.field(field);
		if (!ranges.length) return transaction;

		const info = hostInfo(startState);
		const allowed = info?.file && manager.viewWrites.get(info.file);
		const next = newDoc.toString();
		if (allowed?.current === startState.doc.toString() && allowed.next === next) return transaction;
		// Obsidian uses "set" both to reload disk data and to mirror edits between panes.
		// Only a confirmed saved baseline may bypass the lock, including sync/restore.
		if (info?.file && transaction.annotation(Transaction.userEvent) === 'set' &&
			info.lastSavedData?.replace(/\r\n/gu, '\n') === next) return transaction;
		if (wholeNote) return [];

		let touchesLock = false;
		transaction.changes.iterChangedRanges((from, to) => {
			if (ranges.some(range => from < range.to && to > range.from)) touchesLock = true;
		});
		return touchesLock ? [] : transaction;
	});
	const preserveHistory = EditorState.transactionExtender.of(transaction => {
		if (!transaction.docChanged) return null;
		const info = hostInfo(transaction.startState);
		const { ranges } = transaction.startState.field(field);
		let insertedLock = false;
		transaction.changes.iterChanges((_from, _to, _newFrom, _newTo, inserted) => {
			if (containsLockedText(inserted.toString())) insertedLock = true;
		});
		if (insertedLock || ranges.length && (transaction.annotation(Transaction.userEvent) === 'set' ||
			info?.file && manager.viewWrites.has(info.file))) {
			return { annotations: Transaction.addToHistory.of(false) };
		}
		return null;
	});
	const mobile = ViewPlugin.define(view => {
		let toolbar, disposeSelectionAction;
		const removeToolbar = () => {
			disposeSelectionAction?.();
			disposeSelectionAction = undefined;
			toolbar?.remove();
			toolbar = undefined;
		};
		const update = () => {
			if (!Platform.isMobile) return;
			const info = editorInfoField ? view.state.field(editorInfoField, false) : undefined;
			if (view.state.readOnly || view.state.selection.main.empty || !info?.editor || !fileIsNote(info.file)) { removeToolbar(); return; }
			if (toolbar) return;
			toolbar = view.dom.parentElement.createDiv({ cls: 'wujie-encryption-selection-tools' });
			const action = button(toolbar, t('encryption.encryptSelection'), () => { void manager.encryptSelection(info.editor, info.file).catch(failure); });
			action.addEventListener('pointerdown', event => event.preventDefault());
			disposeSelectionAction = addSelectionAction?.(toolbar, info.editor, info.file);
		};
		update();
		return { update, destroy: removeToolbar };
	});
	return [field, protect, preserveHistory, mobile];
}

export function registerNoteEncryption(owner, addSelectionAction, addReadingAction) {
	const manager = new NoteEncryption(owner, addReadingAction); owner.noteEncryption = manager;
	owner.encryptWholeNote = () => manager.encryptNote().catch(failure);
	owner.encryptSelectedText = () => {
		const view = owner.app.workspace.getMostRecentLeaf?.()?.view;
		return manager.encryptSelection(view?.editor, view?.file).catch(failure);
	};
	owner.lockEncryptedNotes = () => manager.lockAll();
	owner.recoverEncryptedDrafts = () => manager.recoverDrafts().catch(failure);
	owner.noteEncryptionSettings = () => manager.settings();
	owner.listEncryptedNotes = () => manager.listLockedNotes().catch(failure);
	for (const [id, name, method] of [
		['encrypt-selected-text', t('encryption.encryptSelection'), 'encryptSelectedText'],
		['encrypt-whole-note', t('encryption.encryptNote'), 'encryptWholeNote'],
		['lock-encrypted-notes', t('encryption.text80'), 'lockEncryptedNotes'],
		['recover-encrypted-drafts', t('encryption.text65'), 'recoverEncryptedDrafts'],
		['note-encryption-settings', t('encryption.text70'), 'noteEncryptionSettings'],
		['list-encrypted-notes', t('encryption.listLockedNotes'), 'listEncryptedNotes'],
	]) owner.addCommand({ id, name, callback: () => owner[method]() });
	const workspace = owner.app.workspace;
	if (workspace.on) {
		owner.registerEvent(workspace.on('editor-menu', (menu, editor, info) => {
			if (!editor.getSelection() || !fileIsNote(info.file)) return;
			menu.addItem(item => item.setTitle(t('encryption.encryptSelection')).setIcon('lock').onClick(() => { void manager.encryptSelection(editor, info.file).catch(failure); }));
		}));
		owner.registerEvent(workspace.on('file-menu', (menu, file) => manager.addFileMenu(menu, file)));
		owner.registerEvent(workspace.on('layout-change', () => manager.sweep()));
	}
	if (owner.app.vault.on) for (const event of ['create', 'modify', 'rename', 'delete']) owner.registerEvent(owner.app.vault.on(event, file => {
		manager.fileLocks.delete(file);
		manager.refreshExplorer?.();
		if (event === 'rename' || event === 'delete' && !manager.removingAttachments.has(file)) manager.lockAll();
	}));
	manager.document = workspace.containerEl?.ownerDocument;
	manager.watchExplorer(workspace.containerEl);
	if (manager.document && owner.registerDomEvent) {
		owner.registerDomEvent(manager.document, 'contextmenu', event => manager.readingMenu(event), true);
		owner.registerDomEvent(manager.document, 'visibilitychange', () => { if (manager.document.hidden) manager.lockAll(); });
		owner.registerDomEvent(manager.document.defaultView, 'pagehide', () => manager.lockAll());
	}
	owner.registerInterval(window.setInterval(() => manager.sweep(), 10_000));
	owner.registerEditorExtension?.(encryptionExtension(manager, addSelectionAction));
	owner.registerMarkdownCodeBlockProcessor?.('wujie-encrypted', (source, el, ctx) => {
		let box; try { box = decodeBox(source.trim()); } catch { /* Opaque damaged envelope. */ }
		const marker = box ? lockedMarker(box) : '';
		manager.renderLock(el, ctx.sourcePath, marker, box?.kind !== 'text' ? box : undefined);
		el.addClass('wujie-crypto-rendered-lock');
	});
	owner.registerMarkdownPostProcessor?.((el, ctx) => {
		const doc = el.ownerDocument;
		const walker = doc.createTreeWalker(el, 4);
		const nodes = []; while (walker.nextNode()) if (walker.currentNode.nodeValue.includes(TEXT_PREFIX)) nodes.push(walker.currentNode);
		for (const node of nodes) {
			const text = node.nodeValue, fragment = doc.createDocumentFragment(); let offset = 0;
			for (const range of lockedRanges(text)) {
				fragment.appendChild(doc.createTextNode(text.slice(offset, range.from)));
				const span = doc.createElement('span'); manager.renderLock(span, ctx.sourcePath, range.marker, range.box); fragment.appendChild(span); offset = range.to;
			}
			fragment.appendChild(doc.createTextNode(text.slice(offset))); node.replaceWith(fragment);
		}
	});
	return manager;
}

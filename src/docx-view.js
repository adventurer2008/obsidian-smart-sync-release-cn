import * as Obsidian from 'obsidian';
import { blankDocx, checkDocxImages, checkDocxRoundTrip, docxName, inspectDocx, sameBytes } from './docx.js';
import {
	DOCX_DISK_MAX_BYTES, createDocxProtection, isPasswordDocx, openPasswordDocx, openPasswordDocxWithKey, sealPasswordDocx,
} from './docx-password.js';
import { edition } from './edition.js';
import { locale, t } from './i18n.js';

const bundledViewType = `${edition.id}-docx`;
const autosaveDelay = 600;
const busyRetryDelay = 1500;
const isDocx = file => file instanceof Obsidian.TFile && /\.docx$/iu.test(file.path);
const knownErrors = new Set(['large', 'protected', 'password', 'unsupported', 'preservation', 'conflict', 'busy', 'openFailed', 'saveFailed']);
const errorText = (error, fallback) => t(`docx.${knownErrors.has(error?.message) ? error.message : fallback}`);

function fitMobilePages(target, ref) {
	const host = target.ownerDocument.defaultView;
	const gutter = 16;
	let frame, scroller, lastWidth, lastPageWidth;
	const schedule = () => {
		if (frame !== undefined) return;
		frame = host.requestAnimationFrame(() => {
			frame = undefined;
			const editor = ref.current;
			const scroll = target.querySelector('.docx-editor__scroll-container');
			const pageWidth = target.querySelector('.paged-editor__pages')?.offsetWidth;
			if (!editor || !scroll || !pageWidth || scroll.clientWidth <= gutter) return;
			if (scroller !== scroll) {
				if (scroller) observer?.unobserve(scroller);
				scroller = scroll;
				observer?.observe(scroller);
			}
			const width = scroller.clientWidth;
			let zoom = editor.getZoom();
			if (width !== lastWidth || pageWidth !== lastPageWidth) {
				lastWidth = width;
				lastPageWidth = pageWidth;
				zoom = Math.min(1, (width - gutter) / pageWidth);
				if (editor.getZoom() !== zoom) editor.setZoom(zoom);
				scroller.scrollLeft = 0;
			}
			// The editor scales the page with a transform, which leaves its layout width unchanged.
			target.style.setProperty('--smart-sync-docx-canvas-width', `${Math.ceil(zoom * pageWidth) + gutter}px`);
		});
	};
	const observer = host.ResizeObserver && new host.ResizeObserver(schedule);
	observer?.observe(target);
	return {
		schedule,
		dispose() {
			observer?.disconnect();
			if (frame !== undefined) host.cancelAnimationFrame(frame);
		},
	};
}

export function registerDocxEditor(owner, { syncActive = () => Boolean(owner.running), viewType = bundledViewType, openLabel = t('docx.open') } = {}) {
	const { EditableFileView, FuzzySuggestModal, Modal, Notice, Platform, TFolder } = Obsidian;
	const { vault, workspace } = owner.app;
	if (!EditableFileView || !vault.readBinary || !vault.createBinary || !vault.modifyBinary || !workspace.getLeaf) return;
	const canProtect = Boolean(globalThis.crypto?.subtle);
	const drafts = new WeakMap();

	async function open(file, protect = false) {
		if (owner.stopped || vault.getAbstractFileByPath(file.path) !== file) return;
		try {
			const existing = workspace.getLeavesOfType(viewType).find(leaf => leaf.getViewState().state?.file === file.path);
			const leaf = existing ?? workspace.getLeaf('tab');
			if (!existing) await leaf.setViewState({ type: viewType, active: true, state: { file: file.path } });
			await workspace.revealLeaf(leaf);
			if (protect) leaf.view?.requestProtection?.();
		} catch { new Notice(t('docx.openFailed')); }
	}

	function passwordForm(area, creating, submit) {
		const form = area.createEl('form', { cls: 'smart-sync-docx-name smart-sync-docx-password' });
		const field = label => {
			const input = form.createEl('label', { text: t(label) }).createEl('input', { type: 'password' });
			input.required = true;
			input.maxLength = 255;
			input.minLength = creating ? 4 : 1;
			input.autocomplete = 'off';
			return input;
		};
		const input = field(creating ? 'encryption.text03' : 'encryption.text04');
		const confirm = creating ? field('encryption.text05') : undefined;
		const status = form.createDiv({ attr: { role: 'status', 'aria-live': 'polite' } });
		const button = form.createEl('button', { text: t(creating ? 'encryption.text11' : 'encryption.text37'), type: 'submit', cls: 'mod-cta' });
		button.type = 'submit';
		const send = event => {
			event.preventDefault();
			if (button.disabled || input.value.length < input.minLength || input.value.length > input.maxLength) return;
			if (confirm && confirm.value !== input.value) { status.setText(t('encryption.text13')); return; }
			const password = input.value;
			input.value = '';
			if (confirm) confirm.value = '';
			button.disabled = true;
			input.disabled = true;
			if (confirm) confirm.disabled = true;
			status.setText(t(creating ? 'encryption.text43' : 'docx.loading'));
			void submit(password).catch(error => {
				status.setText(errorText(error, creating ? 'docx.saveFailed' : 'docx.openFailed'));
			}).finally(() => {
				if (form.isConnected) {
					button.disabled = false;
					input.disabled = false;
					if (confirm) confirm.disabled = false;
					input.focus();
				}
			});
		};
		button.addEventListener('click', send);
		form.addEventListener('submit', send);
		input.focus();
		return () => { input.value = ''; if (confirm) confirm.value = ''; form.remove(); };
	}

	class ProtectionModal extends Modal {
		onOpen() {
			this.setTitle(t('docx.protect'));
			this.active = true;
			this.disposeForm = passwordForm(this.contentEl, true, async password => {
				await this.apply(password, () => this.active);
				this.close();
			});
		}
		onClose() { this.active = false; this.disposeForm?.(); this.contentEl.empty(); }
	}

	class DocxNameModal extends Modal {
		onOpen() {
			this.setTitle(t('docx.new'));
			const form = this.contentEl.createEl('form', { cls: 'smart-sync-docx-name' });
			const label = form.createEl('label', { text: t('docx.name') });
			const input = label.createEl('input', { type: 'text' });
			input.required = true;
			const message = form.createDiv({ attr: { role: 'status' } });
			const create = form.createEl('button', { text: t('docx.create'), type: 'submit', cls: 'mod-cta' });
			form.addEventListener('submit', event => {
				event.preventDefault();
				if (create.disabled) return;
				const name = docxName(input.value);
				if (!name) { message.setText(t('docx.invalidName')); return; }
				const folder = this.folder;
				const path = folder.isRoot() ? name : `${folder.path}/${name}`;
				const foldedName = name.normalize('NFC').toLowerCase();
				if (vault.getAbstractFileByPath(path) ||
					folder.children?.some(child => child.name.normalize('NFC').toLowerCase() === foldedName)) {
					message.setText(t('docx.exists'));
					return;
				}
				create.disabled = true;
				void (async () => {
					try {
						if (owner.stopped || (!folder.isRoot() && vault.getAbstractFileByPath(folder.path) !== folder))
							throw Error('folder');
						const file = await vault.createBinary(path, blankDocx());
						this.close();
						await open(file);
					} catch {
						message.setText(t(vault.getAbstractFileByPath(path) ? 'docx.exists' : 'docx.createFailed'));
						create.disabled = false;
					}
				})();
			});
			input.focus();
		}
		onClose() { this.contentEl.empty(); }
	}

	let naming;
	const create = folder => {
		naming?.close();
		naming = new DocxNameModal(owner.app);
		naming.folder = folder;
		naming.open();
	};

	class DocxView extends EditableFileView {
		generation = 0;
		getViewType() { return viewType; }
		getIcon() { return 'file-text'; }
		getDisplayText() { return this.file?.basename ?? openLabel; }
		canAcceptExtension(extension) { return extension.toLowerCase() === 'docx'; }
		requestProtection() {
			const session = this.session;
			if (!session || session.protection || session.protecting) return;
			this.protectionModal?.close();
			const modal = new ProtectionModal(owner.app);
			modal.apply = (password, active) => session.protect(password, active);
			this.protectionModal = modal;
			modal.open();
		}

		async onOpen() {
			await super.onOpen();
			this.registerEvent(vault.on('modify', file => {
				const session = this.session;
				if (!session || session.file !== file || session.writing) return;
				if (session.changes !== session.saved) this.status.setText(t('docx.conflict'));
				else void this.onLoadFile(file);
			}));
			this.registerEvent(vault.on('delete', file => {
				if (this.session?.file === file) this.status.setText(t('docx.conflict'));
			}));
			this.registerEvent(workspace.on('active-leaf-change', leaf => {
				if (leaf !== this.leaf) void this.session?.flush();
			}));
		}

		async onLoadFile(file, unlocked) {
			this.clearEditor();
			const generation = this.generation;
			this.contentEl.classList.add('smart-sync-docx');
			const controls = this.contentEl.createDiv({ cls: 'smart-sync-docx-controls' });
			const save = controls.createEl('button', { text: t('docx.save'), type: 'button', cls: 'mod-cta' });
			save.disabled = true;
			const protect = controls.createEl('button', { text: t('docx.protect'), type: 'button' });
			protect.hidden = true;
			const status = controls.createSpan({ text: t('docx.loading'), attr: { role: 'status', 'aria-live': 'polite' } });
			this.status = status;
			const target = this.contentEl.createDiv({ cls: 'smart-sync-docx-editor' });
			const live = () => generation === this.generation && !owner.stopped;
			const current = () => live() && this.file === file;
			try {
				if (!isDocx(file)) throw Error('openFailed');
				if (file.stat.size > DOCX_DISK_MAX_BYTES) throw Error('large');
				const buffer = await vault.readBinary(file);
				if (!current()) return;
				const document = target.ownerDocument;
				const window = document.defaultView;
				const Parser = window.DOMParser;
				const passwordRequired = isPasswordDocx(buffer);
				const pendingDraft = drafts.get(file);
				const draft = pendingDraft?.protected === passwordRequired ? pendingDraft : undefined;
				const diskBase = draft?.base ?? buffer;
				if (passwordRequired && !canProtect) throw Error('unsupported');
				if (passwordRequired && !unlocked) {
					status.setText(t('docx.protected'));
					this.clearPasswordForm = passwordForm(target, false, async password => {
						const result = await openPasswordDocx(diskBase, password, Parser);
						if (!current()) return;
						await this.onLoadFile(file, { ...result, diskBase });
					});
					return;
				}
				if (passwordRequired && !sameBytes(new Uint8Array(diskBase), new Uint8Array(unlocked.diskBase)))
					throw Error('conflict');
				const base = passwordRequired ? unlocked.clear : diskBase;
				const protection = passwordRequired ? unlocked.protection : undefined;
				const editingBuffer = !draft ? base : protection ? await openPasswordDocxWithKey(draft.output, protection, Parser) : draft.output;
				const inspection = inspectDocx(base, Parser);
				const [{ DocxEditor }, { createElement, createRef }, { createRoot }, { locales }, { setGoogleFontsEnabled }, { registerDocxImageDrop }] = await Promise.all([
					import('@eigenpal/docx-editor-react'), import('react'), import('react-dom/client'),
					import('@eigenpal/docx-editor-i18n'), import('@eigenpal/docx-editor-core'), import('./docx-drop.js'),
				]);
				if (!current()) return;
				setGoogleFontsEnabled(false);
				const events = new window.AbortController();
				const session = { file, buffer: base, disk: diskBase, protection, inspection, changes: draft ? 1 : 0, saved: 0, ready: false, events, editor: createRef() };
				this.session = session;
				const fit = Platform.isMobile ? fitMobilePages(target, session.editor) : undefined;
				if (fit) {
					target.classList.add('smart-sync-docx-fit');
					events.signal.addEventListener('abort', fit.dispose, { once: true });
				}
				const dirty = () => session.changes !== session.saved;
				const updateSave = () => { save.disabled = !session.ready || inspection.readOnly || Boolean(session.saving || session.protecting) || !dirty(); };
				const updateProtection = () => protect.setText(t(session.protection ? 'encryption.text36' : 'docx.protect'));
				const writeDisk = async (output, preserveTime) => {
					if (syncActive() || owner.docxWrite) throw Error('busy');
					const path = file.path;
					const write = async () => {
						if (vault.getAbstractFileByPath(path) !== file || file.stat.size !== session.disk.byteLength)
							throw Error('conflict');
						const disk = await vault.readBinary(file);
						if (!live() || file.path !== path || vault.getAbstractFileByPath(path) !== file ||
							!sameBytes(new Uint8Array(disk), new Uint8Array(session.disk))) throw Error('conflict');
						if (!sameBytes(new Uint8Array(disk), new Uint8Array(output))) {
							session.writing = true;
							try { await vault.modifyBinary(file, output, preserveTime ? { mtime: file.stat.mtime } : undefined); }
							finally { session.writing = false; }
						}
					};
					const pending = Promise.resolve().then(write);
					owner.docxWrite = pending;
					try { await pending; }
					finally { if (owner.docxWrite === pending) owner.docxWrite = undefined; }
					session.disk = output;
				};
				const cancelTimer = () => window.clearTimeout(session.saveTimer);
				const scheduleSave = (delay = autosaveDelay) => {
					cancelTimer();
					session.saveTimer = window.setTimeout(() => { void saveFile(); }, delay);
				};
				events.signal.addEventListener('abort', cancelTimer, { once: true });
				const render = async selective => {
					const output = await session.editor.current?.save({ selective });
					if (!output) throw Error('saveFailed');
					const checked = inspectDocx(output, Parser);
					checkDocxImages(checked);
					return { output, checked };
				};
				const renderRevision = async () => {
					try { return await render(true); }
					catch (error) {
						// The selective writer can keep a new drawing while omitting its media part.
						if (error?.message !== 'missingImage' || !live()) throw error;
						try { return await render(false); }
						catch (failure) {
							if (failure?.message === 'missingImage') throw Error('preservation', { cause: failure });
							throw failure;
						}
					}
				};
				const writeRevision = async () => {
					status.setText(t('docx.saving'));
					const revision = session.changes;
					try {
						const { output, checked } = await renderRevision();
						if (!live()) return false;
						checkDocxRoundTrip(session.inspection, checked);
						const stored = session.protection ? await sealPasswordDocx(output, session.protection) : output;
						if (!live()) return false;
						const snapshot = { base: session.disk, output: stored, protected: Boolean(session.protection) };
						drafts.set(file, snapshot);
						await writeDisk(stored, false);
						session.buffer = output;
						session.inspection = checked;
						session.saved = revision;
						if (drafts.get(file) === snapshot) drafts.delete(file);
						if (live()) status.setText(t(dirty() ? 'docx.unsaved' : 'docx.saved'));
						return true;
					} catch (error) {
						if (live()) {
							status.setText(errorText(error, 'saveFailed'));
							if (error?.message === 'busy' && !session.leaving) scheduleSave(busyRetryDelay);
						}
						return false;
					}
				};
				const saveFile = () => {
					cancelTimer();
					if (session.saving) return session.saving;
					if (!live() || !session.ready || inspection.readOnly || session.protecting || !dirty()) return Promise.resolve(false);
					session.saving = writeRevision().then(saved => {
						session.saving = undefined;
						if (live()) {
							updateSave();
							if (saved && dirty() && !session.leaving) scheduleSave();
						}
						return saved;
					});
					updateSave();
					return session.saving;
				};
				session.flush = async () => {
					await Promise.resolve();
					while (dirty() && await saveFile()) { /* A newer edit can arrive during an asynchronous write. */ }
				};
				session.protect = async (password, active) => {
					cancelTimer();
					await session.saving;
					if (!active() || !current() || session.protection || session.protecting) throw Error('saveFailed');
					const revision = session.changes;
					const edited = dirty();
					const operation = (async () => {
						const { output, checked } = edited ? await renderRevision() : { output: session.buffer, checked: session.inspection };
						checkDocxRoundTrip(session.inspection, checked);
						const protection = await createDocxProtection(password);
						const stored = await sealPasswordDocx(output, protection);
						if (!active() || !current() || session.changes !== revision) throw Error('conflict');
						await writeDisk(stored, !edited);
						session.protection = protection;
						session.buffer = output;
						session.inspection = checked;
						session.saved = revision;
						drafts.delete(file);
						if (current()) { updateProtection(); status.setText(t('docx.saved')); }
					})();
					session.protecting = operation;
					updateSave();
					try { await operation; }
					finally {
						session.protecting = undefined;
						if (live()) {
							updateSave();
							if (dirty() && !session.leaving) scheduleSave();
						}
					}
				};
				protect.hidden = !canProtect;
				updateProtection();
				protect.addEventListener('click', () => {
					if (!session.protection) { this.requestProtection(); return; }
					void session.flush().then(() => { if (current() && !dirty()) return this.onLoadFile(file); });
				});
				window.addEventListener('blur', () => { void session.flush(); }, { signal: events.signal });
				document.addEventListener('visibilitychange', () => {
					if (document.hidden) void session.flush();
				}, { signal: events.signal });
				save.addEventListener('click', () => void saveFile());
				registerDocxImageDrop(target, {
					getEditor: () => session.editor.current,
					canEdit: () => current() && session.ready && !inspection.readOnly && !session.protecting && !session.leaving,
					current, sourceSize: () => session.buffer.byteLength,
					report: key => new Notice(t(key)), signal: events.signal,
				});
				target.addEventListener('keydown', event => {
					if (!event.altKey && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
						event.preventDefault();
						event.stopPropagation();
						void saveFile();
					}
				}, { capture: true });
				this.root = createRoot(target);
				this.root.render(createElement(DocxEditor, {
					ref: session.editor, documentBuffer: editingBuffer, readOnly: inspection.readOnly, showFileOpen: false, showHelpMenu: false,
					showOutlineButton: false, disableFindReplaceShortcuts: true,
					colorMode: this.contentEl.ownerDocument.body.classList.contains('theme-dark') ? 'dark' : 'light',
					documentName: file.basename, documentNameEditable: false, i18n: locales[locale],
					onRenderedDomContextReady: fit?.schedule,
					onEditorViewReady: () => {
						if (!current()) return;
						session.ready = true;
						updateSave();
						status.setText(t(inspection.readOnly ? 'docx.readOnly' : dirty() ? 'docx.unsaved' : 'docx.ready'));
						if (dirty()) scheduleSave();
					},
					onChange: () => {
						if (!live() || !session.ready || inspection.readOnly) return;
						session.changes++;
						updateSave();
						if (!session.saving) status.setText(t('docx.unsaved'));
						if (!session.leaving) scheduleSave();
					},
					onSave: () => { void saveFile(); },
					onError: () => { if (current()) status.setText(t('docx.openFailed')); },
				}));
			} catch (error) {
				if (current()) status.setText(errorText(error, 'openFailed'));
			}
		}

		clearEditor() {
			this.generation++;
			this.clearPasswordForm?.();
			this.clearPasswordForm = undefined;
			this.protectionModal?.close();
			this.protectionModal = undefined;
			this.session?.events.abort();
			this.root?.unmount();
			this.root = undefined;
			this.session = undefined;
			this.contentEl.empty();
		}

		async onUnloadFile() {
			const session = this.session;
			if (session) {
				session.leaving = true;
				await session.protecting?.catch(() => {});
				await session.flush();
			}
			if (this.session === session) this.clearEditor();
		}
		async onClose() { await this.onUnloadFile(); await super.onClose(); }
	}

	owner.registerView(viewType, leaf => new DocxView(leaf));
	const registerExtension = () => {
		if (owner.stopped || !owner.registerExtensions) return;
		try { owner.registerExtensions(['docx'], viewType); } catch { /* The explicit open action is still available. */ }
	};
	if (workspace.onLayoutReady) workspace.onLayoutReady(registerExtension);
	else registerExtension();
	const addFileMenu = (menu, file) => {
		if (file instanceof TFolder) menu.addItem(item => item.setTitle(t('docx.new')).setIcon('file-plus').onClick(() => create(file)));
		if (isDocx(file)) {
			menu.addItem(item => item.setTitle(openLabel).setIcon('file-text').onClick(() => open(file)));
			if (canProtect) menu.addItem(item => item.setTitle(t('encryption.text11')).setIcon('lock').onClick(() => open(file, true)));
		}
	};
	owner.registerEvent(workspace.on('file-menu', addFileMenu));
	owner.addCommand({ id: 'new-word-document', name: t('docx.new'), callback: () => create(workspace.getActiveFile()?.parent ?? vault.getRoot()) });
	class DocxPicker extends FuzzySuggestModal {
		getItems() { return vault.getFiles().filter(isDocx); }
		getItemText(file) { return file.path; }
		onChooseItem(file) { void open(file); }
	}
	let picker;
	owner.addCommand({ id: 'open-word-document', name: openLabel, callback() {
		picker?.close();
		picker = new DocxPicker(owner.app);
		picker.setPlaceholder(t('docx.find'));
		picker.open();
	} });
	owner.register(() => { naming?.close(); picker?.close(); });
	return addFileMenu;
}

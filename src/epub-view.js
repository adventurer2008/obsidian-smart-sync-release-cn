import * as Obsidian from 'obsidian';
import { edition } from './edition.js';
import { locale, t } from './i18n.js';
import { EPUB_MAX_BYTES, EpubError, openEpub, renderEpubChapter } from './epub.js';

const viewType = `${edition.id}-epub`;
const epubFile = file => file instanceof Obsidian.TFile && /\.epub$/iu.test(file.path);

export function registerEpubReader(owner) {
	const { EditableFileView, FuzzySuggestModal, Notice } = Obsidian;
	const { vault, workspace } = owner.app;
	if (!EditableFileView || !vault.readBinary || !workspace.getLeaf) return;

	class EpubView extends EditableFileView {
		revision = 0;
		index = 0;
		getViewType() { return viewType; }
		getIcon() { return 'book-open'; }
		canAcceptExtension(extension) { return extension.toLowerCase() === 'epub'; }
		getState() { return { ...super.getState(), epubChapter: this.index }; }
		async setState(state, result) {
			await super.setState(state, result);
			if (this.book && state.file === this.file?.path && Number.isInteger(state.epubChapter)) {
				const index = state.epubChapter;
				if (index >= 0 && index < this.book.chapters.length && index !== this.index) this.show(index);
			}
		}
		async onOpen() {
			await super.onOpen();
			this.registerEvent(vault.on('modify', file => {
				if (file === this.file) void this.loadBook(file, this.index);
			}));
		}
		async onLoadFile(file) { await this.loadBook(file); }
		async onUnloadFile() { this.clear(); }
		async onClose() {
			this.clear();
			await super.onClose();
		}
		clear() {
			this.revision++;
			this.disposeChapter?.();
			this.disposeChapter = this.book = this.anchors = undefined;
			this.contentEl.replaceChildren();
		}
		async loadBook(file, index = 0) {
			this.clear();
			this.index = index;
			const current = this.revision, el = this.contentEl;
			el.classList.add('smart-sync-epub');
			el.createEl('p', { cls: 'smart-sync-epub-status', text: t('epub.loading'), attr: { role: 'status' } });
			try {
				if (!epubFile(file)) throw new EpubError('unsupported');
				if (file.stat.size > EPUB_MAX_BYTES) throw new EpubError('large');
				const bytes = await vault.readBinary(file);
				if (current !== this.revision || this.file !== file || owner.stopped) return;
				this.book = openEpub(new Uint8Array(bytes), el.ownerDocument.defaultView.DOMParser);
				this.renderBook(file);
				this.show(index < this.book.chapters.length ? index : 0);
			} catch (error) {
				if (current !== this.revision || this.file !== file || owner.stopped) return;
				this.clear();
				this.index = index;
				el.createEl('p', { cls: 'smart-sync-epub-status', text: errorText(error), attr: { role: 'status' } });
				const retry = el.createEl('button', { cls: 'smart-sync-epub-retry', text: t('epub.retry'), attr: { type: 'button' } });
				retry.addEventListener('click', () => void this.loadBook(file, index));
			}
		}
		renderBook(file) {
			const el = this.contentEl;
			el.replaceChildren();
			el.createEl('h2', { cls: 'smart-sync-epub-title', text: this.book.title || file.basename, attr: { dir: 'auto' } });
			const controls = el.createEl('nav', { cls: 'smart-sync-epub-nav', attr: { 'aria-label': t('epub.chapters') } });
			const createButton = (label, offset) => {
				const button = controls.createEl('button', { text: t(label), attr: { type: 'button' } });
				button.addEventListener('click', () => this.go(this.index + offset));
				return button;
			};
			this.previous = createButton('epub.previous', -1);
			this.next = createButton('epub.next', 1);
			this.chapters = controls.createEl('select', { attr: { 'aria-label': t('epub.chapters') } });
			const numbers = new Intl.NumberFormat(locale);
			for (const [index, chapter] of this.book.chapters.entries()) {
				const number = t('epub.chapter', { number: numbers.format(index + 1) });
				this.chapters.createEl('option', { text: chapter.label ? `${number} · ${chapter.label}` : number, attr: { value: String(index) } });
			}
			this.chapters.addEventListener('change', () => this.go(Number(this.chapters.value)));
			this.scroller = el.createDiv({ cls: 'smart-sync-epub-scroll', attr: { tabindex: '0', role: 'region', 'aria-label': t('epub.content') } });
			this.chapter = this.scroller.createEl('article', { cls: 'smart-sync-epub-chapter', attr: { dir: 'auto' } });
		}
		go(index, fragment) {
			if (!this.book || index < 0 || index >= this.book.chapters.length) return;
			const changed = index !== this.index;
			if (changed) {
				this.show(index);
				workspace.requestSaveLayout?.();
			}
			if (fragment) this.anchors?.get(fragment)?.scrollIntoView({ block: 'nearest' });
			else if (!changed && this.scroller) this.scroller.scrollTop = 0;
		}
		show(index) {
			this.disposeChapter?.();
			this.disposeChapter = this.anchors = undefined;
			this.index = index;
			this.chapters.value = String(index);
			this.previous.disabled = index === 0;
			this.next.disabled = index === this.book.chapters.length - 1;
			this.chapter.replaceChildren();
			this.scroller.scrollTop = 0;
			try {
				const rendered = renderEpubChapter(this.book, index, this.chapter.ownerDocument, (next, fragment) => this.go(next, fragment));
				this.disposeChapter = rendered.dispose;
				this.anchors = rendered.anchors;
				this.chapter.append(rendered.fragment);
			} catch (error) {
				this.chapter.createEl('p', { text: errorText(error), attr: { role: 'status' } });
			}
		}
	}
	owner.registerView(viewType, leaf => new EpubView(leaf));
	const registerExtension = () => {
		if (owner.stopped || !owner.registerExtensions) return;
		// The host throws when another reader already owns the extension.
		try { owner.registerExtensions(['epub'], viewType); } catch { /* Menu and command remain available. */ }
	};
	const open = async file => {
		if (owner.stopped || vault.getAbstractFileByPath(file.path) !== file) return;
		try {
			const existing = workspace.getLeavesOfType(viewType).find(leaf => leaf.getViewState().state?.file === file.path);
			const leaf = existing ?? workspace.getLeaf('tab');
			if (!leaf) return;
			if (!existing) await leaf.setViewState({ type: viewType, active: true, state: { file: file.path } });
			await workspace.revealLeaf(leaf);
		} catch { new Notice(t('epub.invalid')); }
	};
	owner.registerEvent(workspace.on('file-menu', (menu, file) => {
		if (epubFile(file)) menu.addItem(item => item.setTitle(t('epub.open')).setIcon('book-open').onClick(() => open(file)));
	}));
	if (workspace.onLayoutReady) workspace.onLayoutReady(registerExtension);
	else registerExtension();
	if (FuzzySuggestModal) {
		class BookPicker extends FuzzySuggestModal {
			getItems() { return vault.getFiles().filter(epubFile); }
			getItemText(file) { return file.path; }
			onChooseItem(file) { void open(file); }
		}
		let picker;
		owner.addCommand({ id: 'open-epub', name: t('epub.open'), callback() {
			picker?.close();
			picker = new BookPicker(owner.app);
			picker.setPlaceholder(t('epub.find'));
			picker.open();
		} });
		owner.register(() => picker?.close());
	}
}

function errorText(error) {
	return t(error instanceof EpubError ? `epub.${error.code}` : 'epub.invalid');
}

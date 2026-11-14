import * as ObsidianSdk from 'obsidian';
import { showTooltip } from '@codemirror/view';
import { containsLockedText } from './note-crypto.js';
import { edition } from './edition.js';

const { Modal, Notice, Platform, editorInfoField } = ObsidianSdk;
const languages = {
	'zh-Hans': '简体中文', en: '英语', ja: '日语', ko: '韩语', fr: '法语',
	de: '德语', es: '西班牙语', ru: '俄语', pt: '葡萄牙语',
};
const selectionLimit = 1000;
const title = '翻译所选文字';
const dictionarySelection = /^[a-z]+(?:['’-][a-z]+)*(?: +[a-z]+(?:['’-][a-z]+)*){0,5}$/i;
const dictionaryWord = /^[a-z]+(?:['’-][a-z]+)*$/i;

function selectionText(file, text) {
	return /\.md$/i.test(file?.path ?? '') && text?.trim() && !containsLockedText(text) ? text : '';
}

function button(container, label) {
	return container.createEl('button', { text: label, attr: { type: 'button' } });
}

function iconButton(container, label, icon, cls) {
	const control = container.createEl('button', { cls, attr: { type: 'button', 'aria-label': label, title: label } });
	if (ObsidianSdk.setIcon) ObsidianSdk.setIcon(control, icon);
	else control.setText(label);
	return control;
}

function addTranslationMascot(container) {
	container.createEl('span', { cls: 'smart-sync-translation-mascot', attr: { 'aria-hidden': 'true' } });
}

function errorMessage(error) {
	switch (error?.status) {
		case 401:
		case 403: return '请登录无界同步后重试。';
		case 404: return '当前服务暂未开放翻译。';
		case 429: return '翻译达到用量上限或服务繁忙，请稍后重试。';
		default: return '翻译失败，请检查网络或稍后重试。';
	}
}

function renderDictionary(output, entry, text) {
	const card = output.createDiv({ cls: 'smart-sync-dictionary' });
	const hero = card.createDiv({ cls: 'smart-sync-dictionary-hero' });
	hero.createDiv({ cls: 'smart-sync-dictionary-kicker', text: '英汉词典' });
	hero.createEl('div', { cls: 'smart-sync-dictionary-word', text: entry.word || text.trim() });
	if (entry.uk || entry.us || entry.phonetic) {
		const phonetics = hero.createDiv({ cls: 'smart-sync-dictionary-phonetics' });
		if (entry.uk) phonetics.createEl('span', { text: '英 /' + entry.uk.replace(/^\/|\/$/g, '') + '/' });
		if (entry.us) phonetics.createEl('span', { text: '美 /' + entry.us.replace(/^\/|\/$/g, '') + '/' });
		if (!entry.uk && !entry.us) phonetics.createEl('span', { text: entry.phonetic });
	}
	const groups = new Map();
	for (const { part, meaning } of entry.definitions) {
		const group = groups.get(part) ?? [];
		group.push(meaning);
		groups.set(part, group);
	}
	card.createDiv({ cls: 'smart-sync-dictionary-label', text: '释义' });
	const definitions = card.createEl('dl', { cls: 'smart-sync-dictionary-definitions' });
	for (const [part, meanings] of groups) {
		definitions.createEl('dt', { text: part || '释义' });
		definitions.createEl('dd', { text: meanings.join('；') });
	}
	if (entry.forms?.length) {
		card.createDiv({ cls: 'smart-sync-dictionary-label', text: '词形' });
		const forms = card.createDiv({ cls: 'smart-sync-dictionary-forms' });
		for (const { label, value } of entry.forms) forms.createEl('span', { text: label ? label + ' ' + value : value });
	}
	if (entry.examples?.length) {
		card.createDiv({ cls: 'smart-sync-dictionary-label', text: '例句' });
		const examples = card.createEl('ol', { cls: 'smart-sync-dictionary-examples' });
		for (const { source, translation } of entry.examples) {
			const example = examples.createEl('li', { text: source });
			if (translation) example.createDiv({ cls: 'smart-sync-dictionary-example-translation', text: translation });
		}
	}
}

const dictionaryNames = new Map([
	['oxford-hk10', '牛津'],
	['oxford-v3', '牛津'],
	['longman-5pp', '朗文'],
	['bing', '必应词典'], ['youdao', '有道词典'], ['cambridge', '剑桥词典'], ['oxford', '牛津词典'],
	['ecdict', '自建词库'],
]);

function renderDictionaries(output, entries, text) {
	const openBySource = new Map([...output.querySelectorAll('details[data-source]')]
		.map(section => [section.dataset.source, section.open]));
	output.empty();
	if (!entries.length) {
		output.setText('未查到词条。');
		return;
	}
	const bySource = new Map(entries.map(entry => [entry.source, entry]));
	for (const [source, name] of dictionaryNames) {
		const entry = bySource.get(source);
		if (!entry) continue;
		const section = output.createEl('details', { cls: 'smart-sync-dictionary-source', attr: { 'data-source': source } });
		section.createEl('summary', { text: name });
		renderDictionary(section, entry, text);
		section.open = openBySource.get(source) ?? true;
	}
}

function renderTranslation(container, text, request, close) {
	const doc = container.ownerDocument;
	const header = container.createDiv({ cls: 'smart-sync-translation-header' });
	addTranslationMascot(header);
	header.createDiv({ cls: 'smart-sync-translation-source', text, attr: { dir: 'auto' } });
	const dismiss = iconButton(header, '关闭翻译', 'x', 'smart-sync-translation-dismiss');
	const output = container.createDiv({
		cls: 'smart-sync-translation-output', attr: { role: 'status', 'aria-live': 'polite', dir: 'auto' },
	});
	const controls = container.createDiv({ cls: 'smart-sync-translation-controls' });
	const target = controls.createEl('select', { attr: { 'aria-label': '目标语言' } });
	for (const [code, label] of Object.entries(languages))
		target.createEl('option', { text: label, attr: { value: code } });
	const letters = text.match(/\p{L}/gu)?.length ?? 0;
	target.value = !/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text) &&
		(text.match(/\p{Script=Han}/gu)?.length ?? 0) > letters / 2 ? 'en' : 'zh-Hans';
	const copy = button(controls, '复制译文');
	const retry = button(controls, '重试');
	let current, translation;
	const run = async () => {
		current?.abort();
		const controller = new AbortController();
		current = controller;
		translation = undefined;
		copy.hidden = true;
		retry.hidden = true;
		output.setText(target.value === 'zh-Hans' && dictionaryWord.test(text.trim()) ? '正在查询…' : '正在翻译…');
		let showedLocal = false;
		try {
			const result = await request(text, target.value, controller.signal, entries => {
				if (controller.signal.aborted || !entries.length) return;
				showedLocal = true;
				renderDictionaries(output, entries, text);
			});
			if (controller.signal.aborted) return;
			if (result.dictionaries) {
				if (result.dictionaries.length || !showedLocal)
					renderDictionaries(output, result.dictionaries, text);
				return;
			}
			if (result.dictionary) {
				output.empty();
				renderDictionary(output, result.dictionary, text);
				return;
			}
			translation = result.translation;
			output.setText(translation);
			copy.hidden = false;
		} catch (error) {
			if (controller.signal.aborted) return;
			if (!showedLocal) output.setText(errorMessage(error));
			retry.hidden = false;
		}
	};
	copy.addEventListener('click', async () => {
		if (!translation) return;
		const controller = current;
		try {
			await doc.defaultView.navigator.clipboard.writeText(translation);
			if (!controller.signal.aborted) new Notice('已复制译文。');
		} catch {
			if (!controller.signal.aborted) new Notice('无法访问剪贴板，可选中译文手动复制。');
		}
	});
	target.addEventListener('change', () => void run());
	retry.addEventListener('click', () => void run());
	dismiss.addEventListener('click', () => close(true));
	const onVisibility = () => { if (doc.hidden) close(); };
	doc.addEventListener('visibilitychange', onVisibility);
	void run();
	return () => {
		current?.abort();
		translation = undefined;
		doc.removeEventListener('visibilitychange', onVisibility);
		container.empty();
	};
}

function translationTooltip(open, trackControl) {
	return showTooltip.compute(['selection', 'doc'], state => {
		const { main, ranges } = state.selection;
		if (ranges.length !== 1 || main.empty || main.to - main.from > selectionLimit) return null;
		const file = state.field(editorInfoField, false)?.file;
		const text = selectionText(file, state.sliceDoc(main.from, main.to));
		if (!text) return null;
		return {
			pos: main.head, above: true, clip: true, offset: { x: 4, y: 6 },
			create(view) {
				const doc = view.dom.ownerDocument;
				const dom = doc.win.createDiv();
				dom.addClass('smart-sync-translation-tooltip');
				const untrack = trackControl(dom);
				const trigger = dom.createEl('button', { cls: 'smart-sync-translation-trigger', attr: {
					type: 'button', 'aria-label': title, title,
				} });
				addTranslationMascot(trigger);
				trigger.setAttribute('aria-expanded', 'false');
				let close;
				trigger.addEventListener('mousedown', event => event.preventDefault());
				trigger.addEventListener('click', () => { close = open(text, dom, trigger); });
				return { dom, destroy() { close?.(); untrack(); } };
			},
		};
	});
}

function protectedReadingSelection(preview, range) {
	return preview.closest('.markdown-embed, .wujie-encrypted') ||
		[...preview.querySelectorAll('.wujie-encrypted, .markdown-embed')].some(area => range.intersectsNode(area));
}

function registerReadingTranslation(owner, enabled, open) {
	const workspace = owner.app.workspace;
	const documents = new Map();
	let active;
	const clear = () => {
		if (!active) return;
		const previous = active;
		active = undefined;
		previous.close?.();
		previous.anchor.remove();
	};
	const readingSelection = doc => {
		const selection = doc.getSelection();
		if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return;
		const range = selection.getRangeAt(0);
		const start = range.startContainer;
		const preview = (start.nodeType === 1 ? start : start.parentElement)?.closest('.markdown-preview-view');
		if (!preview?.isConnected || !preview.contains(range.endContainer)) return;
		const view = workspace.getLeavesOfType('markdown').map(leaf => leaf.view).find(view =>
			view?.containerEl?.contains(preview) && view.getMode?.() === 'preview');
		const text = selectionText(view?.file, selection.toString());
		if (!text || text.length > selectionLimit) return;
		if (protectedReadingSelection(preview, range)) return;
		return { view, file: view.file, preview, text, range };
	};
	const update = doc => {
		if (doc.hidden || !enabled()) { if (active?.doc === doc) clear(); return; }
		const selection = doc.getSelection();
		if (active?.doc === doc && active.close && active.anchor.contains(selection?.anchorNode)) return;
		const selected = readingSelection(doc);
		if (!selected) { if (active?.doc === doc) clear(); return; }
		const { range } = selected;
		if (active?.doc === doc && active.file === selected.file && active.preview === selected.preview &&
			active.text === selected.text && active.range.compareBoundaryPoints(0, range) === 0 &&
			active.range.compareBoundaryPoints(2, range) === 0) return;
		clear();
		const rect = range.getBoundingClientRect?.();
		const win = doc.defaultView;
		if (!rect || !win || (!rect.width && !rect.height) || rect.bottom < 0 || rect.top > win.innerHeight) return;
		const anchor = doc.createElement('div');
		anchor.className = 'smart-sync-translation-tooltip smart-sync-reading-translation';
		const width = Math.min(480, win.innerWidth - 24);
		anchor.style.left = `${Math.max(12, Math.min(rect.right, win.innerWidth - width - 12))}px`;
		const below = rect.bottom + 8;
		const above = win.innerHeight - rect.top + 8;
		const placeBelow = win.innerHeight - below >= 240 || below < above;
		anchor.style[placeBelow ? 'top' : 'bottom'] = `${Math.max(8, placeBelow ? below : above)}px`;
		anchor.style.setProperty('--reading-translation-height', `${Math.max(40, (placeBelow ? win.innerHeight - below : win.innerHeight - above) - 12)}px`);
		const trigger = anchor.createEl('button', { cls: 'smart-sync-translation-trigger', attr: {
			type: 'button', 'aria-label': title, title,
		} });
		addTranslationMascot(trigger);
		trigger.setAttribute('aria-expanded', 'false');
		const candidate = { ...selected, range: range.cloneRange(), doc, anchor };
		active = candidate;
		trigger.addEventListener('pointerdown', event => event.preventDefault());
		trigger.addEventListener('click', () => {
			if (active !== candidate || !enabled() || !candidate.preview.isConnected ||
				candidate.view.file !== candidate.file || candidate.view.getMode() !== 'preview') return clear();
			if (Platform.isMobile) { clear(); open(candidate.text); }
			else candidate.close = open(candidate.text, anchor, trigger);
		});
		doc.body.appendChild(anchor);
	};
	const refreshDocuments = () => {
		const current = new Set(workspace.getLeavesOfType('markdown').map(leaf => leaf.view?.containerEl?.ownerDocument).filter(Boolean));
		for (const [doc, controller] of documents) if (!current.has(doc)) {
			if (active?.doc === doc) clear();
			controller.abort();
			documents.delete(doc);
		}
		for (const doc of current) if (!documents.has(doc)) {
			const controller = new doc.defaultView.AbortController();
			documents.set(doc, controller);
			const options = { signal: controller.signal, capture: true };
			doc.addEventListener('selectionchange', () => update(doc), options);
			doc.addEventListener('pointerdown', event => {
				if (active?.doc === doc && !active.anchor.contains(event.target)) clear();
			}, options);
			doc.addEventListener('pointerup', event => { if (!active?.anchor.contains(event.target)) update(doc); }, options);
			doc.addEventListener('keydown', event => { if (event.key === 'Escape' && active?.doc === doc && !active.close) clear(); }, options);
			doc.addEventListener('visibilitychange', () => { if (doc.hidden && active?.doc === doc) clear(); }, options);
			doc.addEventListener('scroll', event => { if (active?.doc === doc && !active.anchor.contains(event.target)) clear(); }, options);
			doc.defaultView.addEventListener('resize', () => { if (active?.doc === doc) clear(); }, options);
		}
	};
	if (workspace.getLeavesOfType && workspace.on && owner.register) {
		owner.registerEvent(workspace.on('layout-change', () => { clear(); refreshDocuments(); }));
		owner.registerEvent(workspace.on('active-leaf-change', () => { clear(); refreshDocuments(); }));
		owner.registerEvent(workspace.on('window-open', refreshDocuments));
		owner.registerEvent(workspace.on('window-close', refreshDocuments));
		owner.register(() => { clear(); for (const controller of documents.values()) controller.abort(); documents.clear(); });
		workspace.onLayoutReady ? workspace.onLayoutReady(() => { if (!owner.stopped) refreshDocuments(); }) : refreshDocuments();
	}
	return clear;
}

export function registerNoteTranslation(owner) {
	class TranslationModal extends Modal {
		constructor(app, text, request, onClose) {
			super(app);
			Object.assign(this, { text, request, afterClose: onClose });
		}
		onOpen() {
			this.setTitle('翻译');
			this.modalEl.addClass('smart-sync-translation-modal');
			if (Platform.isMobile) this.containerEl?.addClass('smart-sync-translation-sheet');
			this.cleanup = renderTranslation(this.contentEl, this.text, this.request, () => this.close());
		}
		onClose() {
			this.cleanup?.();
			this.cleanup = this.text = undefined;
			this.afterClose();
		}
	}
	const workspace = owner.app.workspace;
	const key = () => owner.secret('account') || owner.secret('access');
	const enabled = () => !owner.stopped && owner.data.settings.translationEnabled !== false;
	const controls = new Set();
	const trackControl = control => {
		controls.add(control);
		control.hidden = !enabled();
		return () => controls.delete(control);
	};
	let closeActive;
	const close = () => closeActive?.();
	const open = (text, anchor, trigger) => {
		if (!text || !enabled()) return;
		if (text.length > selectionLimit) return new Notice('请选中不超过 1000 字符的文字。');
		const secret = key();
		if (!secret) return new Notice('请登录无界同步后使用翻译。');
		close();
		const { localId, settings: { origin, workspace: vault } } = owner.data;
		const localLab = edition.development && /^http:\/\/127\.0\.0\.1(?::\d+)?$/.test(origin);
		const hostedDictionary = edition.edition === 'cn' && !localLab &&
			/^\d+\.\d+\.\d+(?:-alpha\.\d+)?$/.test(owner.manifest?.version);
		const current = () => enabled() && owner.data.localId === localId &&
			owner.data.settings.origin === origin && owner.data.settings.workspace === vault && key() === secret;
		const request = async (text, target, signal, showLocal) => {
			if (!current()) throw Object.assign(Error('Translation context changed'), { status: 401 });
			const api = owner.workspaceApi(origin, secret);
			api.signal = signal;
			const word = text.trim();
			const lookup = target === 'zh-Hans' && word.length <= 64 &&
				(localLab || hostedDictionary ? dictionarySelection : dictionaryWord).test(word);
			const input = { text, target };
			const knownEntries = entries => entries.filter(entry =>
				dictionaryNames.has(entry?.source) && Array.isArray(entry.definitions) && entry.definitions.length);
			if (lookup && hostedDictionary) {
				try {
					const local = await api.request('POST', 'account/translate', { ...input, dictionary: 'alpha-local' });
					if (!signal.aborted && current() && Array.isArray(local?.dictionaries))
						showLocal(knownEntries(local.dictionaries));
				} catch (error) {
					if (error?.status !== 400) throw error;
				}
				signal.throwIfAborted();
				if (!current()) throw Object.assign(Error('Translation context changed'), { status: 401 });
			}
			let result;
			try {
				result = await api.request('POST', 'account/translate',
					lookup ? { ...input, dictionary: hostedDictionary ? 'alpha' : true } : input);
			} catch (error) {
				// Older translation servers require exactly two request fields.
				if (!lookup || error?.status !== 400 || signal.aborted || !current()) throw error;
				result = await api.request('POST', 'account/translate', input);
			}
			if (!current()) throw Object.assign(Error('Translation context changed'), { status: 401 });
			if (lookup && Array.isArray(result?.dictionaries)) {
				const dictionaries = knownEntries(result.dictionaries);
				if (dictionaries.length || !result.dictionaries.length) return { dictionaries };
			}
			if (lookup && Array.isArray(result?.dictionary?.definitions) && result.dictionary.definitions.length)
				return { dictionary: result.dictionary };
			if (typeof result?.translation !== 'string' || !result.translation.trim() || result.translation.length > 12000)
				throw Error('Invalid translation response');
			return result;
		};
		if (!anchor) {
			const modal = new TranslationModal(owner.app, text, request, () => {
				if (closeActive === closeModal) closeActive = undefined;
			});
			const closeModal = () => modal.close();
			closeActive = closeModal;
			modal.open();
			return;
		}
		const panel = anchor.createDiv({ cls: 'smart-sync-translation-panel', attr: { role: 'group', 'aria-label': '划词翻译' } });
		const doc = anchor.ownerDocument;
		const focusPanel = doc.activeElement === trigger;
		trigger.hidden = true;
		trigger.setAttribute('aria-expanded', 'true');
		const outside = event => { if (!anchor.contains(event.target)) closePanel(); };
		const escape = event => { if (event.key === 'Escape') closePanel(anchor.contains(doc.activeElement)); };
		const closePanel = (restoreFocus = false) => {
			if (closeActive !== closePanel) return;
			closeActive = undefined;
			cleanup();
			panel.remove();
			trigger.hidden = false;
			trigger.setAttribute('aria-expanded', 'false');
			doc.removeEventListener('pointerdown', outside, true);
			doc.removeEventListener('keydown', escape, true);
			if (restoreFocus) trigger.focus();
		};
		const cleanup = renderTranslation(panel, text, request, closePanel);
		closeActive = closePanel;
		doc.addEventListener('pointerdown', outside, true);
		doc.addEventListener('keydown', escape, true);
		if (focusPanel) panel.querySelector('.smart-sync-translation-dismiss')?.focus();
		return closePanel;
	};
	const clearReading = registerReadingTranslation(owner, enabled, open);
	const closeAll = () => { clearReading(); close(); };
	owner.addCommand({
		id: 'translate-selection', name: title,
		editorCheckCallback(checking, editor, info) {
			if (!enabled()) return false;
			const text = selectionText(info?.file, editor.getSelection());
			if (!text) return false;
			if (!checking) open(text);
			return true;
		},
	});
	if (workspace.on) {
		owner.registerEvent(workspace.on('editor-menu', (menu, editor, info) => {
			if (!enabled()) return;
			const text = selectionText(info?.file, editor.getSelection());
			if (text) menu.addItem(item => item.setTitle(title).setIcon('languages').onClick(() => open(text)));
		}));
		owner.registerEvent(workspace.on('file-open', closeAll));
	}
	if (!Platform.isMobile && editorInfoField) owner.registerEditorExtension?.(translationTooltip(open, trackControl));
	return {
		close: closeAll,
		addReadingAction(menu, { view, preview, range, text, closeMenu }) {
			const file = view.file;
			const selected = selectionText(file, text);
			if (!enabled() || view.getMode?.() !== 'preview' || !selected || selected.length > selectionLimit ||
				protectedReadingSelection(preview, range)) return;
			menu.addItem(item => item.setTitle(title).setIcon('languages').onClick(() => {
				closeMenu();
				if (view.file !== file || view.getMode?.() !== 'preview' || !preview.isConnected) return;
				clearReading();
				open(selected);
			}));
		},
		refresh() {
			const visible = enabled();
			if (!visible) closeAll();
			for (const control of controls) control.hidden = !visible;
		},
		addMobileAction(toolbar, editor, file) {
			const trigger = button(toolbar, '翻译');
			trigger.classList.add('smart-sync-translation-mobile-trigger');
			trigger.addEventListener('pointerdown', event => event.preventDefault());
			trigger.addEventListener('click', () => open(selectionText(file, editor.getSelection())));
			return trackControl(trigger);
		},
	};
}

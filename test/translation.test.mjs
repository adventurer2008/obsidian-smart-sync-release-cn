import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { after, test } from 'node:test';
import { JSDOM, VirtualConsole } from 'jsdom';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

const errors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', error => errors.push(error.message));
const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true, virtualConsole });
const { window } = dom;
const { document } = window;
for (const key of ['window', 'document', 'Window', 'Element', 'Document', 'MutationObserver', 'HTMLElement', 'Node', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
	const value = { window, document }[key] ?? window[key];
	Object.defineProperty(globalThis, key, { configurable: true, value: ['getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'].includes(key) ? value.bind(window) : value });
}
document.win = window;
window.Range.prototype.getClientRects = () => [];
window.Range.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 });
window.HTMLElement.prototype.addClass = function (name) { this.classList.add(name); };
window.HTMLElement.prototype.empty = function () { this.replaceChildren(); };
window.HTMLElement.prototype.setText = function (text) { this.textContent = text; };
window.HTMLElement.prototype.createEl = function (tag, options = {}) {
	const element = document.createElement(tag);
	for (const [name, value] of Object.entries(options.attr ?? {})) element.setAttribute(name, value);
	if (options.text) element.textContent = options.text;
	if (options.cls) element.className = options.cls;
	return this.appendChild(element);
};
window.HTMLElement.prototype.createDiv = function (options) { return this.createEl('div', options); };
window.createDiv = () => document.createElement('div');
registerHooks({ resolve(specifier, context, next) {
	return specifier === 'obsidian' ? { url: new URL('./encryption-dom-sdk.mjs', import.meta.url).href, shortCircuit: true } : next(specifier, context);
} });
const { registerNoteTranslation } = await import('../src/translation.js');
const { NoteEncryption } = await import('../src/note-encryption.js');
const { Platform, Menu, editorInfoField, menus, modals } = await import('./encryption-dom-sdk.mjs');
const file = { path: 'fixture.md', stat: { mtime: 1577836800123 } };
const tick = () => new Promise(resolve => setImmediate(resolve));
after(() => { window.close(); assert.deepEqual(errors, []); });

function ownerFixture(view) {
	const handlers = new Map(), requests = [];
	const cleanups = [];
	const owner = {
		app: { workspace: { on: (event, callback) => handlers.set(event, callback) } },
		data: { localId: 'fixture', settings: { origin: 'https://sync.example.invalid', workspace: 'fixture' } },
		secret: name => name === 'account' ? 'synthetic-key' : '',
		addCommand(command) { this.command = command; },
		registerEvent() {},
		register(cleanup) { cleanups.push(cleanup); },
		registerEditorExtension(extension) { this.extension = extension; },
		workspaceApi(origin, key) {
			return { request(method, path, input) {
				return new Promise((resolve, reject) => requests.push({ origin, key, method, path, input, signal: this.signal, resolve, reject }));
			} };
		},
	};
	if (view) owner.app.workspace.getLeavesOfType = () => [{ view }];
	const actions = registerNoteTranslation(owner);
	return { owner, handlers, requests, dispose: actions.close, cleanups, addMobileAction: actions.addMobileAction,
		addReadingAction: actions.addReadingAction, refresh: actions.refresh };
}

test('reading right-click includes translation in the same menu and honors the switch', () => {
	const containerEl = document.body.createDiv();
	const preview = containerEl.createDiv({ cls: 'markdown-preview-view' });
	const paragraph = preview.createEl('p', { text: 'Access is limited.' });
	const view = { containerEl, file, getMode: () => 'preview', editor: { getValue: () => paragraph.textContent } };
	const { owner, requests, addReadingAction, cleanups, dispose } = ownerFixture(view);
	owner.manifest = { id: 'wujie-sync' };
	owner.app.vault = { configDir: '.fixture' };
	const manager = new NoteEncryption(owner, addReadingAction);
	manager.document = document;
	const range = document.createRange();
	range.setStart(paragraph.firstChild, 0);
	range.setEnd(paragraph.firstChild, 6);
	document.getSelection().addRange(range);
	const listener = event => manager.readingMenu(event);
	document.addEventListener('contextmenu', listener, true);
	const rightClick = () => {
		paragraph.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
		return menus.at(-1);
	};
	try {
		const menu = rightClick();
		assert.deepEqual(menu.items.map(item => item.title), ['复制', '加密所选文本', '翻译所选文字']);
		assert.equal(requests.length, 0);
		menu.items[2].callback();
		assert.equal(menu.visible, false);
		assert.equal(requests[0].input.text, 'Access');
		owner.data.settings.translationEnabled = false;
		assert.deepEqual(rightClick().items.map(item => item.title), ['复制', '加密所选文本']);
		owner.data.settings.translationEnabled = true;
		preview.classList.add('markdown-embed');
		assert.deepEqual(rightClick().items.map(item => item.title), ['复制', '加密所选文本']);
	} finally {
		manager.closeActions();
		dispose();
		cleanups.forEach(cleanup => cleanup());
		document.removeEventListener('contextmenu', listener, true);
		document.getSelection().removeAllRanges();
		containerEl.remove();
	}
});

test('reading mode translates only selected note text and closes on settings or view changes', async () => {
	const containerEl = document.createElement('div');
	containerEl.innerHTML = '<div class="markdown-preview-view"><p>Access is limited.</p><span class="wujie-encrypted">Private</span></div>';
	document.body.appendChild(containerEl);
	let mode = 'preview';
	const view = { containerEl, file, getMode: () => mode };
	const { owner, handlers, requests, cleanups, refresh } = ownerFixture(view);
	const select = (element, end) => {
		const range = document.createRange();
		range.setStart(element.firstChild, 0);
		range.setEnd(element.firstChild, end);
		document.getSelection().removeAllRanges();
		document.getSelection().addRange(range);
		document.dispatchEvent(new window.Event('selectionchange'));
	};
	const originalRect = window.Range.prototype.getBoundingClientRect;
	window.Range.prototype.getBoundingClientRect = () => ({ width: 50, height: 20, top: 60, right: 80, bottom: 80 });
	const anchor = () => document.querySelector('.smart-sync-reading-translation');
	const choose = () => anchor().querySelector('button').click();
	try {
		select(containerEl.querySelector('p'), 6);
		assert.equal(requests.length, 0);
		choose();
		assert.deepEqual(requests[0].input, { text: 'Access', target: 'zh-Hans', dictionary: true });
		requests[0].resolve({ translation: '访问' });
		await tick();
		assert.equal(anchor().querySelector('.smart-sync-translation-output').textContent, '访问');
		select(containerEl.querySelector('.wujie-encrypted'), 7);
		assert.equal(anchor(), null);
		assert.equal(requests.length, 1);
		select(containerEl.querySelector('p'), 18);
		choose();
		assert.deepEqual(requests[1].input, { text: 'Access is limited.', target: 'zh-Hans' });
		owner.data.settings.translationEnabled = false;
		refresh();
		assert.equal(requests[1].signal.aborted, true);
		assert.equal(anchor(), null);
		owner.data.settings.translationEnabled = true;
		Platform.isMobile = true;
		select(containerEl.querySelector('p'), 6);
		choose();
		assert.equal(anchor(), null);
		assert.equal(requests[2].input.text, 'Access');
		handlers.get('file-open')();
		assert.equal(requests[2].signal.aborted, true);
		mode = 'source';
		select(containerEl.querySelector('p'), 6);
		assert.equal(anchor(), null);
	} finally {
		Platform.isMobile = false;
		cleanups.forEach(cleanup => cleanup());
		containerEl.remove();
		window.Range.prototype.getBoundingClientRect = originalRect;
	}
});

test('disabling translation closes a pending lookup and hides existing selection controls', async () => {
	const { owner, handlers, requests, dispose, addMobileAction, refresh } = ownerFixture();
	const editor = { getSelection: () => 'access' };
	const toolbar = document.createElement('div');
	const untrack = addMobileAction(toolbar, editor, file);
	try {
		const button = toolbar.querySelector('button');
		assert.equal(button.hidden, false);
		assert.equal(owner.command.editorCheckCallback(false, editor, { file }), true);
		assert.equal(requests.length, 1);
		owner.data.settings.translationEnabled = false;
		refresh();
		assert.equal(requests[0].signal.aborted, true);
		assert.equal(button.hidden, true);
		assert.equal(owner.command.editorCheckCallback(false, editor, { file }), false);
		handlers.get('editor-menu')({ addItem: () => assert.fail('translation menu is disabled') }, editor, { file });
		button.click();
		assert.equal(requests.length, 1);
		owner.data.settings.translationEnabled = true;
		refresh();
		assert.equal(button.hidden, false);
		assert.equal(owner.command.editorCheckCallback(true, editor, { file }), true);
	} finally { untrack(); dispose(); }
});

test('desktop selection waits for a click and renders only the translation as plain text', async () => {
	const { owner, requests, dispose, refresh } = ownerFixture();
	globalThis.encryptionEditorInfo = { file };
	const text = 'Prefix Translate this. Suffix';
	const view = new EditorView({ parent: document.body, state: EditorState.create({
		doc: text, extensions: [editorInfoField, owner.extension],
	}) });
	try {
		view.dispatch({ selection: { anchor: 7, head: 22 } });
		assert.equal(requests.length, 0);
		const trigger = view.dom.querySelector('.smart-sync-translation-trigger');
		assert.equal(trigger.textContent, '');
		assert.equal(trigger.getAttribute('aria-label'), '翻译所选文字');
		assert.equal(view.dom.querySelector('.smart-sync-translation-panel'), null);
		trigger.click();
		assert.equal(trigger.getAttribute('aria-expanded'), 'true');
		assert.equal(view.dom.querySelector('.smart-sync-translation-source').textContent, 'Translate this.');
		assert.deepEqual(requests[0].input, { text: 'Translate this.', target: 'zh-Hans' });
		assert.equal(requests[0].path, 'account/translate');
		requests[0].resolve({ translation: '<b>译文</b>' });
		await tick();
		const output = view.dom.querySelector('.smart-sync-translation-output');
		assert.equal(output.textContent, '<b>译文</b>');
		assert.equal(output.childElementCount, 0);
		let copied;
		Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: { writeText: async value => { copied = value; } } });
		[...view.dom.querySelectorAll('button')].find(button => button.textContent === '复制译文').click();
		await tick();
		assert.equal(copied, '<b>译文</b>');
		assert.equal(view.state.doc.toString(), text);
		assert.equal(file.stat.mtime, 1577836800123);
		view.dom.querySelector('.smart-sync-translation-dismiss').focus();
		document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
		assert.equal(document.activeElement, trigger);
		assert.equal(trigger.getAttribute('aria-expanded'), 'false');
		trigger.click();
		view.dispatch({ selection: { anchor: 0 } });
		assert.equal(requests[0].signal.aborted, true);
		assert.equal(requests[1].signal.aborted, true);
		assert.equal(view.dom.querySelector('.smart-sync-translation-output'), null);
		view.dispatch({ selection: { anchor: 7, head: 22 } });
		const tooltip = view.dom.querySelector('.smart-sync-translation-tooltip');
		owner.data.settings.translationEnabled = false;
		refresh();
		assert.equal(tooltip.hidden, true);
		owner.data.settings.translationEnabled = true;
		refresh();
		assert.equal(tooltip.hidden, false);
	} finally { dispose(); view.destroy(); }
});

test('single-word results display a grouped dictionary card without audio controls', async () => {
	const { owner, requests, dispose } = ownerFixture();
	const editor = { getSelection: () => 'Access' };
	try {
		owner.command.editorCheckCallback(false, editor, { file });
		assert.deepEqual(requests[0].input, { text: 'Access', target: 'zh-Hans', dictionary: true });
		requests[0].resolve({ dictionary: {
			word: 'access', uk: 'ˈækses', us: 'ˈækˌses',
			definitions: [{ part: 'n.', meaning: '入口' }, { part: 'n.', meaning: '权限' }, { part: 'v.', meaning: '访问' }],
			forms: [{ label: '过去式', value: 'accessed' }],
			examples: [{ source: 'Access is limited.', translation: '访问受限。' }],
		} });
		await tick();
		const card = modals.at(-1).contentEl.querySelector('.smart-sync-dictionary');
		assert.deepEqual([...card.querySelectorAll('dd')].map(row => row.textContent), ['入口；权限', '访问']);
		for (const value of ['英 /ˈækses/', '美 /ˈækˌses/', '过去式 accessed', 'Access is limited.', '访问受限。'])
			assert.ok(card.textContent.includes(value));
		assert.equal(card.querySelector('audio,button'), null);
		dispose();
		owner.command.editorCheckCallback(false, editor, { file });
		requests[1].reject({ status: 400 });
		await tick();
		assert.deepEqual(requests[2].input, { text: 'Access', target: 'zh-Hans' });
		requests[2].resolve({ translation: '访问' });
		await tick();
		assert.equal(modals.at(-1).contentEl.querySelector('.smart-sync-translation-output').textContent, '访问');
	} finally { dispose(); }
});

test('dictionary hits open automatically in display order and can be collapsed', async () => {
	const { owner, requests, dispose } = ownerFixture();
	const editor = { getSelection: () => 'Access' };
	const entry = { word: 'access', definitions: [{ part: 'n.', meaning: '入口' }] };
	try {
		owner.command.editorCheckCallback(false, editor, { file });
		const modal = modals.at(-1).contentEl;
		assert.equal(modal.querySelector('details[open]'), null);
		requests[0].resolve({ dictionaries: [
			{ ...entry, source: 'oxford' }, { ...entry, source: 'cambridge' },
			{ ...entry, source: 'youdao' }, { ...entry, source: 'bing' }, { source: 'ecdict', definitions: [] },
		] });
		await tick();
		const sections = [...modal.querySelectorAll('details')];
		assert.deepEqual(sections.map(section => section.querySelector('summary').textContent),
			['必应词典', '有道词典', '剑桥词典', '牛津词典']);
		assert.ok(sections.every(section => section.open));
		sections[0].querySelector('summary').click();
		assert.equal(sections[0].open, false);
		assert.equal(sections[1].open, true);
	} finally { dispose(); }
});

test('mobile command/menu preserves the chosen text, supports explicit retry and closes on file change', async () => {
	Platform.isMobile = true;
	const { owner, handlers, requests, dispose, addMobileAction } = ownerFixture();
	try {
		assert.equal(owner.extension, undefined);
		let selection = '中文句子';
		const editor = { getSelection: () => selection };
		assert.equal(owner.command.editorCheckCallback(true, editor, { file }), true);
		assert.equal(requests.length, 0);
		const menu = new Menu();
		handlers.get('editor-menu')(menu, editor, { file });
		selection = '';
		menu.items[0].callback();
		assert.deepEqual(requests[0].input, { text: '中文句子', target: 'en' });
		const modal = modals.at(-1);
		requests[0].reject(new TypeError('Offline'));
		await tick();
		const retry = [...modal.contentEl.querySelectorAll('button')].find(button => button.textContent === '重试');
		assert.equal(retry.hidden, false);
		retry.click();
		assert.equal(requests.length, 2);
		handlers.get('file-open')();
		assert.equal(requests[1].signal.aborted, true);
		requests[1].resolve({ translation: 'late result' });
		await tick();
		assert.equal(modal.modalEl.isConnected, false);
		const toolbar = document.createElement('div');
		selection = 'toolbar text';
		addMobileAction(toolbar, editor, file);
		toolbar.querySelector('button').click();
		assert.deepEqual(requests[2].input, { text: selection, target: 'zh-Hans' });
		assert.equal(owner.command.editorCheckCallback(true, { getSelection: () => '⟦wujie-lock:v1:locked⟧' }, { file }), false);
	} finally { dispose(); Platform.isMobile = false; }
});

test('the local lab can send a phrase and displays the matching offline source', async () => {
	const { owner, requests, dispose } = ownerFixture();
	owner.data.settings.origin = 'http://127.0.0.1:39694';
	try {
		owner.command.editorCheckCallback(false, { getSelection: () => 'take off' }, { file });
		assert.deepEqual(requests[0].input, { text: 'take off', target: 'zh-Hans', dictionary: true });
		requests[0].resolve({ dictionaries: [{
			source: 'oxford-hk10', word: 'take off', definitions: [{ part: 'phrasal verb', meaning: '起飞' }],
		}] });
		await tick();
		const section = modals.at(-1).contentEl.querySelector('details');
		assert.ok(section.open);
		assert.equal(section.querySelector('summary').textContent, '牛津');
		assert.match(section.textContent, /起飞/);
	} finally { dispose(); }
});

for (const version of ['1.1.7-alpha.15', '1.1.7']) test(`the hosted China ${version} uses the hosted lookup for phrases and leaves sentences on translation`, async () => {
	const { owner, requests, dispose } = ownerFixture();
	owner.manifest = { version };
	try {
		owner.command.editorCheckCallback(false, { getSelection: () => 'take off' }, { file });
		assert.deepEqual(requests[0].input, { text: 'take off', target: 'zh-Hans', dictionary: 'alpha-local' });
		const oxford = { source: 'oxford-hk10', definitions: [{ part: '', meaning: '起飞' }] };
		const longman = { source: 'longman-5pp', definitions: [{ part: '', meaning: '脱下' }] };
		requests[0].resolve({ dictionaries: [oxford, longman] });
		await tick();
		const output = modals.at(-1).contentEl;
		const labels = () => [...output.querySelectorAll('summary')].map(section => section.textContent);
		assert.deepEqual(labels(), ['牛津', '朗文']);
		assert.deepEqual(requests[1].input, { text: 'take off', target: 'zh-Hans', dictionary: 'alpha' });
		output.querySelector('details').open = false;
		requests[1].resolve({ dictionaries: [oxford, longman, { ...oxford, source: 'bing' }] });
		await tick();
		assert.deepEqual(labels(), ['牛津', '朗文', '必应词典']);
		assert.equal(output.querySelector('details').open, false);
		const sentence = 'The plane will take off.';
		owner.command.editorCheckCallback(false, { getSelection: () => sentence }, { file });
		assert.deepEqual(requests[2].input, { text: sentence, target: 'zh-Hans' });
	} finally { dispose(); }
});

test('the hosted China Alpha falls back to the existing lookup on older servers', async () => {
	const { owner, requests, dispose } = ownerFixture();
	owner.manifest = { version: '1.1.7-alpha.14' };
	try {
		owner.command.editorCheckCallback(false, { getSelection: () => 'access' }, { file });
		requests[0].reject({ status: 400 });
		await tick();
		assert.deepEqual(requests[1].input, { text: 'access', target: 'zh-Hans', dictionary: 'alpha' });
		requests[1].resolve({ dictionaries: [{ source: 'oxford-v3', definitions: [{ part: '', meaning: '入口' }] }] });
		await tick();
		assert.equal(modals.at(-1).contentEl.querySelector('summary').textContent, '牛津');
	} finally { dispose(); }
});

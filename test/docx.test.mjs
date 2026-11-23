import { build } from 'esbuild';
import { docxBrowserCompatibility } from '../scripts/docx-dependencies.mjs';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { writeFile } from 'node:fs/promises';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { JSDOM } from 'jsdom';
import CFB from 'cfb';
import { freshSalt, packNote, unlockWorkspace } from '../src/codec.js';
import { blankDocx, checkDocxImages, checkDocxRoundTrip, docxName, inspectDocx } from '../src/docx.js';
import { createDocxProtection, isPasswordDocx, openPasswordDocx } from '../src/docx-password.js';
import { NotebookSynchronizer, emptyState } from '../src/synchronizer.js';
import { pendingWordSave, registerWordSyncState } from '../src/word-coordination.js';

test('a new DOCX has a portable name, an empty body and no filename inserted into the body', () => {
	const { window } = new JSDOM();
	try {
		assert.equal(docxName(' 项目计划.DOCX '), '项目计划.docx');
		for (const name of ['', '../Escape', 'con', 'LPT1.txt', 'com¹', '.docx', 'name.', 'path\\name'])
			assert.equal(docxName(name), undefined, name);
		const parts = inspectDocx(blankDocx(), window.DOMParser);
		assert.equal(parts.readOnly, false);
		assert.equal(parts.xml.get('word/document.xml').documentElement.textContent, '');
	} finally { window.close(); }
});

test('DOCX validation protects embedded data and refuses remote drawing resources and password containers', () => {
	const { window } = new JSDOM();
	const inspect = bytes => inspectDocx(bytes.buffer, window.DOMParser);
	try {
		const files = unzipSync(new Uint8Array(blankDocx()));
		files['word/embeddings/sample.bin'] = Uint8Array.of(4, 2);
		const source = inspect(zipSync(files));
		checkDocxRoundTrip(source, source);
		files['word/embeddings/sample.bin'] = Uint8Array.of(4, 3);
		assert.throws(() => checkDocxRoundTrip(source, inspect(zipSync(files))), /preservation/u);
		files['word/_rels/document.xml.rels'] = strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" TargetMode="External" Target="https://example.com/image.png"/></Relationships>');
		assert.throws(() => inspect(zipSync(files)), /unsupported/u);
		assert.throws(() => inspect(Uint8Array.of(0xd0, 0xcf, 0x11, 0xe0)), /protected/u);
	} finally { window.close(); }
});

test('Word password derivation does not depend on background renderer timers', async () => {
	const timer = globalThis.setTimeout;
	globalThis.setTimeout = () => { throw Error('Renderer timers are suspended'); };
	try {
		const protection = await createDocxProtection('test password');
		assert.equal(protection.descriptor.rounds, 100000);
		assert.equal(protection.key.extractable, false);
	} finally { globalThis.setTimeout = timer; }
});

const sdk = `
export class Plugin { constructor(app) { this.app = app; } }
export class TFolder { isRoot() { return this.path === ''; } }
export class TFile {}
export const Platform = { isMobile: false };
export class Notice { constructor(message) { throw new Error(message); } }
export class FuzzySuggestModal {}
export class Modal {
	constructor(app) { this.contentEl = app.document.createElement('div'); app.document.body.append(this.contentEl); }
	setTitle() {}
	open() { this.onOpen(); }
	close() { this.onClose(); }
}
export class EditableFileView {
	constructor(leaf) { this.contentEl = leaf.contentEl; }
	async onOpen() {}
	async onClose() {}
	registerEvent() {}
}
`;
const { outputFiles } = await build({
	stdin: { contents: "export { default } from 'jszip';", resolveDir: import.meta.dirname + '/..' },
	bundle: true, platform: 'browser', format: 'esm', write: false, plugins: [docxBrowserCompatibility()],
});
assert.doesNotMatch(outputFiles[0].text, /\.createElement\(\s*["']script["']\s*\)/u);
const browserZip = 'data:text/javascript;base64,' + Buffer.from(outputFiles[0].contents).toString('base64');

const hook = registerHooks({ resolve(specifier, context, next) {
	if (specifier === 'jszip') return { url: browserZip, shortCircuit: true };
	return specifier === 'obsidian' ? { url: 'data:text/javascript,' + encodeURIComponent(sdk), shortCircuit: true } : next(specifier, context);
} });
const { TFile, TFolder } = await import('obsidian');
const { default: WordPlugin } = await import('../src/word-plugin.js');
hook.deregister();

async function waitFor(check) {
	for (let attempt = 0; attempt < 100; attempt++) {
		const result = check();
		if (result) return result;
		await delay(20);
	}
	assert.fail('Timed out waiting for the editor');
}

test('DOCX editor autosaves, preserves images and conflicts, and saves password-protected edits', async t => {
	const styles = registerHooks({ resolve(specifier, context, next) {
		return specifier.endsWith('.css') ? { url: 'data:text/javascript,export%20{}', shortCircuit: true } : next(specifier, context);
	} });
	t.after(() => styles.deregister());
	const { window } = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true });
	const { document } = window;
	const canvas = { measureText: text => ({ width: text.length * 8 }) };
	window.HTMLCanvasElement.prototype.getContext = () => canvas;
	window.HTMLElement.prototype.scrollIntoView = () => {};
	window.Range.prototype.getClientRects = () => [];
	window.Range.prototype.getBoundingClientRect = () => new window.DOMRect();
	window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
	Object.defineProperty(document, 'fonts', { value: Object.assign(new window.EventTarget(), {
		check: () => true, load: async () => [], ready: Promise.resolve(),
	}) });
	const globals = { window, document, DOMParser: window.DOMParser, XMLSerializer: window.XMLSerializer,
		Event: window.Event, CustomEvent: window.CustomEvent, Node: window.Node, Element: window.Element,
		DocumentFragment: window.DocumentFragment, MouseEvent: window.MouseEvent, DOMRect: window.DOMRect,
		MutationObserver: window.MutationObserver, ResizeObserver: class { observe() {} disconnect() {} },
		requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
		getComputedStyle: window.getComputedStyle.bind(window), navigator: window.navigator };
	for (const key of Object.getOwnPropertyNames(window).filter(key => /^(?:HTML|SVG).*Element$/u.test(key))) globals[key] = window[key];
	const previous = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
	for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	let view;
	t.after(() => {
		view?.clearEditor();
		window.close();
		for (const [key, descriptor] of Object.entries(previous)) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else delete globalThis[key];
		}
	});
	const element = window.HTMLElement.prototype;
	const make = function (tag, options = {}) {
		const node = document.createElement(tag);
		if (options.text) node.textContent = options.text;
		if (options.cls) node.className = options.cls;
		if (options.type) node.type = options.type;
		for (const [key, value] of Object.entries(options.attr ?? {})) node.setAttribute(key, value);
		this.append(node);
		return node;
	};
	element.createEl = make;
	element.createDiv = function (options) { return make.call(this, 'div', options); };
	element.createSpan = function (options) { return make.call(this, 'span', options); };
	element.setText = function (text) { this.textContent = text; };
	element.empty = function () { this.replaceChildren(); };

	let file, bytes, writes = 0, create, navigatorFolderMenu;
	const firstWrite = Promise.withResolvers();
	t.after(() => firstWrite.resolve());
	const events = new Map();
	const folder = Object.assign(new TFolder(), { path: 'Projects' });
	const leaf = {
		contentEl: document.body.appendChild(document.createElement('div')),
		getViewState() { return { state: { file: view.file?.path } }; },
		async setViewState({ state }) {
			view.file = vault.getAbstractFileByPath(state.file);
			await view.onLoadFile(view.file);
		},
	};
	const vault = {
		getAbstractFileByPath: path => path === file?.path ? file : path === folder.path ? folder : null,
		createBinary: async (path, content) => {
			bytes = content;
			file = Object.assign(new TFile(), { path, basename: path.split('/').at(-1).slice(0, -5), extension: 'docx', stat: { size: bytes.byteLength, mtime: 123 } });
			return file;
		},
		readBinary: async () => bytes.slice(0),
		modifyBinary: async (changed, content, options) => {
			assert.equal(changed, file);
			if (!writes) await firstWrite.promise;
			bytes = content;
			file.stat = { size: bytes.byteLength, mtime: options?.mtime ?? 456 };
			writes++;
		},
	};
	const workspace = { getLeaf: () => leaf, getLeavesOfType: () => [leaf], revealLeaf() {},
		on(name, listener) { events.set(name, listener); }, trigger(name, ...args) { events.get(name)?.(...args); }, onLayoutReady: callback => callback() };
	const syncOwner = { separateWordEditor: true, app: { workspace }, registerEvent() {} };
	registerWordSyncState(syncOwner);
	const plugins = { 'wujie-sync': syncOwner, 'notebook-navigator': { api: { menus: {
		registerFolderMenu(callback) { navigatorFolderMenu = callback; },
	} } } };
	const owner = Object.assign(new WordPlugin({ document, workspace, vault, plugins: { plugins } }), {
		register() {}, registerEvent() {}, addCommand() {},
		registerExtensions(extensions) { assert.deepEqual(extensions, ['docx']); },
		registerView(type, factory) { assert.equal(type, 'wujie-word-docx'); leaf.view = view = factory(leaf); },
	});
	owner.onload();
	navigatorFolderMenu({ folder, addItem: callback => callback({ setTitle() { return this; }, setIcon() { return this; }, onClick(action) { create = action; } }) });
	create();
	const form = document.querySelector('form');
	form.querySelector('input').value = '项目计划';
	form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
	const save = await waitFor(() => document.querySelector('.smart-sync-docx-controls button'));
	await waitFor(() => {
		assert.notEqual(view.status.textContent, '无法打开此 Word 文档。', leaf.contentEl.textContent.slice(0, 600));
		return view.session?.ready;
	});
	assert.equal(file.path, 'Projects/项目计划.docx');
	assert.equal(view.getDisplayText(), '项目计划');
	assert.equal(save.disabled, true);
	assert.equal(file.stat.mtime, 123);
	const blankFixture = bytes;

	const editor = document.querySelector('[contenteditable="true"]');
	assert.ok(editor);
	const current = editor.querySelector('p') ?? editor;
	current.textContent = 'Edited in Obsidian';
	await waitFor(() => !save.disabled);
	const pending = await waitFor(() => pendingWordSave(workspace) && { promise: pendingWordSave(workspace) });
	assert.equal(writes, 0, 'The synchronization component can observe an unfinished Word save');
	firstWrite.resolve();
	await pending.promise;
	await waitFor(() => writes === 1 && save.disabled);
	assert.equal(pendingWordSave(workspace), undefined);
	const saved = inspectDocx(bytes, window.DOMParser);
	assert.match(saved.xml.get('word/document.xml').documentElement.textContent, /Edited in Obsidian/u);
	assert.equal(file.stat.mtime, 456);
	if (process.env.SMART_SYNC_DOCX_WORD_FIXTURE) {
		await writeFile(process.env.SMART_SYNC_DOCX_WORD_FIXTURE + '-blank.docx', new Uint8Array(blankFixture));
		await writeFile(process.env.SMART_SYNC_DOCX_WORD_FIXTURE + '-edited.docx', new Uint8Array(bytes));
	}

	const source = new Uint8Array(bytes);
	const scope = 'synthetic-word';
	const keys = await unlockWorkspace('isolated word fixture', freshSalt());
	const packet = await packNote(keys, scope, file.path, source, undefined, undefined, 'file', file.stat.mtime);
	const objects = new Map(packet.objects.map(object => [object.address, object.body]));
	let received;
	const sync = new NotebookSynchronizer({
		api: { workspace: scope, load: async id => objects.get(id), feed: async after => ({
			entries: after ? [] : [{ sequence: 1, note: packet.id, manifest: packet.manifest, removed: false }], more: false,
		}) },
		keys, state: emptyState(), direction: 'receive', attachmentLimit: source.byteLength + 1, save: async () => {},
		host: { list: async () => [], read: async () => null, write: async (...args) => { received = args; } },
	});
	await sync.run();
	assert.deepEqual(received.slice(0, 3), [file.path, source, 456]);

	(editor.querySelector('p') ?? editor).textContent = 'Saved when switching windows';
	await waitFor(() => !save.disabled);
	const picture = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG2kAAAAASUVORK5CYII=';
	const paged = view.session.editor.current.getEditorRef();
	const pm = paged.getView();
	const run = await waitFor(() => [...document.querySelectorAll('.layout-page-content span[data-pm-start][data-pm-end]')]
		.find(span => span.textContent.includes('Saved when switching windows')));
	const dropPosition = Number(run.dataset.pmStart);
	paged.setSelection(pm.state.doc.content.size - 1);
	document.elementsFromPoint = () => [run, run.closest('.layout-page')];
	window.Image = class {
		naturalWidth = 1;
		naturalHeight = 1;
		set src(value) { queueMicrotask(() => value.includes(picture) ? this.onload() : this.onerror()); }
	};
	const transfer = { types: ['Files'], files: [new window.File([Buffer.from(picture, 'base64')], 'Dropped image.png')] };
	const dispatchDrag = (target, type) => {
		const event = new window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: -1 });
		Object.defineProperty(event, 'dataTransfer', { value: transfer });
		target.dispatchEvent(event);
		return event;
	};
	assert.equal(dispatchDrag(run, 'dragover').defaultPrevented, true);
	assert.equal(transfer.dropEffect, 'copy');
	assert.equal(dispatchDrag(run, 'drop').defaultPrevented, true);
	await waitFor(() => pm.state.doc.nodeAt(dropPosition)?.type.name === 'image');
	window.dispatchEvent(new window.Event('blur'));
	await Promise.resolve();
	assert.ok(view.session.saving);
	await waitFor(() => writes === 2 && save.disabled);
	const withImage = inspectDocx(bytes, window.DOMParser);
	const imageFixture = bytes;
	assert.match(withImage.xml.get('word/document.xml').documentElement.textContent, /switching windows/u);
	checkDocxImages(withImage);
	const media = [...withImage.zip.names()].filter(path => /^word\/media\/.*\.png$/u.test(path));
	assert.equal(media.length, 1);
	assert.equal(Buffer.from(withImage.zip.read(media[0])).toString('base64'), picture);
	if (process.env.SMART_SYNC_DOCX_WORD_FIXTURE)
		await writeFile(process.env.SMART_SYNC_DOCX_WORD_FIXTURE + '-image.docx', new Uint8Array(bytes));

	pm.dispatch(pm.state.tr.insertText('Saved when switching files', dropPosition + 1, pm.state.doc.content.size - 1));
	view.file = null;
	await view.onUnloadFile(file);
	assert.equal(writes, 3);
	assert.match(inspectDocx(bytes, window.DOMParser).xml.get('word/document.xml').documentElement.textContent, /switching files/u);
	view.file = file;
	await view.onLoadFile(file);
	await waitFor(() => view.session?.ready);
	const nextEditor = document.querySelector('[contenteditable="true"]');
	const nextSave = document.querySelector('.smart-sync-docx-controls button');
	assert.ok(nextEditor.textContent.includes('Saved when switching files'));
	assert.ok(document.querySelector('img[alt="Dropped image.png"]'));

	(nextEditor.querySelector('p') ?? nextEditor).textContent = 'Unsaved local edit';
	await waitFor(() => !nextSave.disabled);
	bytes = blankDocx();
	file.stat = { size: bytes.byteLength, mtime: 789 };
	await view.onUnloadFile(file);
	assert.equal(writes, 3);
	assert.equal(file.stat.mtime, 789);
	await view.onLoadFile(file);
	await waitFor(() => view.session?.ready);
	assert.ok(document.querySelector('[contenteditable="true"]').textContent.includes('Unsaved local edit'));
	await waitFor(() => view.status.textContent.includes('原文件'));
	assert.equal(writes, 3);

	await view.onUnloadFile(file);
	const secured = await vault.createBinary('Projects/Password fixture.docx', imageFixture);
	view.file = secured;
	await view.onLoadFile(secured);
	await waitFor(() => view.session?.ready);
	const menu = new Map();
	events.get('file-menu')({ addItem: callback => callback({
		setTitle(title) { this.title = title; return this; }, setIcon() { return this; },
		onClick(action) { menu.set(this.title, action); },
	}) }, secured);
	await menu.get('加密')();
	const password = 'WordTest9876';
	const submit = (form, ...values) => {
		form.querySelectorAll('input').forEach((input, index) => { input.value = values[index]; });
		form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
	};
	submit(document.querySelector('.smart-sync-docx-password'), password, password);
	await waitFor(() => writes === 4 && view.session.protection);
	assert.equal(secured.stat.mtime, 123);
	assert.ok(isPasswordDocx(bytes));
	assert.deepEqual(new Uint8Array((await openPasswordDocx(bytes, password, window.DOMParser)).clear), new Uint8Array(imageFixture));
	document.querySelector('.smart-sync-docx-controls button:nth-child(2)').click();
	await waitFor(() => !view.session && leaf.contentEl.querySelector('.smart-sync-docx-password'));
	assert.ok(!leaf.contentEl.querySelector('[contenteditable="true"]'));
	submit(leaf.contentEl.querySelector('.smart-sync-docx-password'), 'wrong password');
	await waitFor(() => leaf.contentEl.textContent.includes('打开密码不正确'));
	assert.equal(writes, 4);
	submit(leaf.contentEl.querySelector('.smart-sync-docx-password'), password);
	await waitFor(() => view.session?.ready);
	const unlockedView = view.session.editor.current.getEditorRef().getView();
	unlockedView.dispatch(unlockedView.state.tr.insertText('Edited with the opening password ', dropPosition + 1));
	await waitFor(() => writes === 5 && view.session.saved === view.session.changes);
	assert.ok(isPasswordDocx(bytes));
	assert.equal(secured.stat.mtime, 456);
	const reopened = inspectDocx((await openPasswordDocx(bytes, password, window.DOMParser)).clear, window.DOMParser);
	checkDocxImages(reopened);
	assert.ok(reopened.zip.has(media[0]));
	assert.match(reopened.xml.get('word/document.xml').documentElement.textContent, /with the opening password/u);
	const tampered = CFB.read(new Uint8Array(bytes), { type: 'array' });
	CFB.find(tampered, '/EncryptedPackage').content[12] ^= 1;
	await assert.rejects(openPasswordDocx(Uint8Array.from(CFB.write(tampered, { type: 'array' })).buffer,
		password, window.DOMParser), /unsupported/u);
	await view.onUnloadFile(secured);
	await view.onLoadFile(secured);
	assert.ok(leaf.contentEl.querySelector('input[type=password]'));
	if (process.env.SMART_SYNC_DOCX_WORD_FIXTURE)
		await writeFile(process.env.SMART_SYNC_DOCX_WORD_FIXTURE + '-password.docx', new Uint8Array(bytes));
});

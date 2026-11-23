import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { registerHooks } from 'node:module';
import { JSDOM, VirtualConsole } from 'jsdom';
import { createLocked, openLocked, rewrapLocked, updateLocked, lockedMarker, lockedRanges } from '../src/note-crypto.js';
import { freshSalt, packNote, unlockWorkspace, workspaceProof } from '../src/codec.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WorkspaceApi } from '../src/client.js';
import { emptyState, NotebookSynchronizer } from '../src/synchronizer.js';
import { attachmentPackagePath, decryptAttachment, stageNoteAttachments, verifyNoteAttachments } from '../src/note-attachments.js';

const domErrors = [], console = new VirtualConsole();
console.on('jsdomError', error => domErrors.push(error.message));
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://127.0.0.1/', virtualConsole: console });
for (const key of ['window', 'document', 'Window', 'Element', 'Document', 'MutationObserver', 'HTMLElement', 'Node', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'])
	Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? dom.window : key === 'document' ? dom.window.document : typeof dom.window[key] === 'function' && ['getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'].includes(key) ? dom.window[key].bind(dom.window) : dom.window[key] });
dom.window.Range.prototype.getClientRects = () => [];
dom.window.Range.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 });
const proto = dom.window.HTMLElement.prototype;
proto.empty = function () { this.replaceChildren(); };
proto.setText = function (text) { this.textContent = text; };
proto.addClass = function (...names) { this.classList.add(...names); };
proto.createEl = function (tag, options = {}) {
	const el = document.createElement(tag);
	if (options.text !== undefined) el.textContent = options.text;
	if (options.cls) el.className = options.cls;
	for (const key of ['type', 'value', 'placeholder']) if (options[key] !== undefined) el[key] = options[key];
	for (const [key, value] of Object.entries(options.attr ?? {})) el.setAttribute(key, value);
	this.appendChild(el); return el;
};
proto.createSpan = function (options) { return this.createEl('span', options); };
proto.createDiv = function (options) { return this.createEl('div', options); };
registerHooks({ resolve(specifier, context, next) {
	return specifier === 'obsidian' ? { url: new URL('./encryption-dom-sdk.mjs', import.meta.url).href, shortCircuit: true } : next(specifier, context);
} });
const { NoteEncryption, encryptionExtension } = await import('../src/note-encryption.js');
const { editorInfoField, modals, menus, Platform } = await import('./encryption-dom-sdk.mjs');
const { EditorState } = await import('@codemirror/state');
const { EditorView } = await import('@codemirror/view');
const edit = (view, text) => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
const contents = view => view.state.doc.toString();
after(() => { dom.window.close(); assert.deepEqual(domErrors, [], 'DOM/CodeMirror asynchronous errors must not be ignored'); });

test('reading view selection menu preserves copy and encrypts only an exact unambiguous source range', async () => {
	const container = document.body.createDiv(), preview = container.createDiv({ cls: 'markdown-preview-view' });
	const paragraph = preview.createEl('p', { text: '请选中这段测试文字，右键加密。' });
	const file = { path: 'reading.md' }; let source = paragraph.textContent, changedMode;
	const leaf = { view: { file, containerEl: container, editor: { getValue: () => source } },
		getViewState: () => ({ type: 'markdown', state: { file: file.path, mode: 'preview' } }),
		setViewState: async state => { changedMode = state.state.mode; } };
	const manager = new NoteEncryption({ app: { vault: { configDir: '.fixture' }, workspace: { getLeavesOfType: () => [leaf] } }, manifest: { id: 'test' } });
	manager.document = document;
	let captured; manager.encrypt = (snapshot, kind) => { captured = { snapshot, kind }; };
	const range = document.createRange(); range.setStart(paragraph.firstChild, 3); range.setEnd(paragraph.firstChild, 9);
	const selection = document.getSelection(); selection.removeAllRanges(); selection.addRange(range);
	const event = new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true });
	const listener = event => manager.readingMenu(event); document.addEventListener('contextmenu', listener, true);
	try {
		paragraph.dispatchEvent(event);
		assert.equal(event.defaultPrevented, true);
		assert.deepEqual(menus.at(-1).items.map(item => item.title), ['复制', '加密所选文本']);
		await menus.at(-1).items[1].callback(); await Promise.resolve();
		assert.equal(captured.kind, 'text');
		assert.equal(captured.snapshot.original.slice(captured.snapshot.from, captured.snapshot.to), selection.toString());
		captured = undefined; source = '重复 重复';
		await manager.encryptReadingSelection(leaf, '重复', source);
		assert.equal(captured, undefined); assert.equal(changedMode, 'source');
		source = '含 **格式** 的文字';
		await manager.encryptReadingSelection(leaf, '含 格式 的文字', source);
		assert.equal(captured, undefined);
		await assert.rejects(manager.encryptReadingSelection(leaf, '文字', '已过期'), /笔记已修改/);
		await assert.rejects(manager.encryptReadingSelection(leaf, '文字', source, { path: 'another.md' }), /笔记已切换/);
		preview.classList.add('wujie-encrypted'); paragraph.classList.add('wujie-encrypted');
		const protectedEvent = new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }); paragraph.dispatchEvent(protectedEvent);
		assert.equal(protectedEvent.defaultPrevented, false, 'unlocked plaintext must not map into ordinary source');
	} finally { manager.closeActions(); selection.removeAllRanges(); document.removeEventListener('contextmenu', listener, true); container.remove(); }
});
const password = 'actual DOM fixture password';

async function fixture(kind = 'text', original = '初始秘密', { refreshInProcess = true, received } = {}) {
	const box = await createLocked(original, password, '公开的提示', kind);
	let disk = received ?? (kind === 'text' ? '前文 ' + lockedMarker(box) + ' 后文' : lockedMarker(box));
	const file = { path: 'Visible title.md', stat: { mtime: 1577836800123 } }, drafts = new Map(), dirs = new Set();
	let view;
	const editor = {
		getValue: () => view.state.doc.toString(),
		getCursor: direction => direction === 'from' ? view.state.selection.main.from : view.state.selection.main.to,
		posToOffset: value => value,
	};
	const info = { file, editor };
	const applyViewText = text => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
	const markdownView = {
		file, editor, getViewData: editor.getValue,
		setViewData(text) {
			const previous = editor.getValue();
			let start = 0, end = 0;
			while (start < previous.length && previous[start] === text[start]) start++;
			while (end < Math.min(previous.length, text.length) - start && previous.at(-1 - end) === text.at(-1 - end)) end++;
			view.dispatch({ changes: { from: start, to: previous.length - end, insert: text.slice(start, text.length - end) } });
		},
	};
	globalThis.encryptionEditorInfo = info;
	const app = {
		vault: { configDir: '.fixture', read: async () => disk, getAbstractFileByPath: path => path === file.path ? file : null,
			process: async (_file, change, options) => {
				disk = change(disk); file.stat.mtime = options?.mtime ?? Date.now();
				if (refreshInProcess) applyViewText(disk);
				return disk;
			},
			adapter: { exists: async path => dirs.has(path) || drafts.has(path), mkdir: async path => dirs.add(path), write: async (path, raw) => drafts.set(path, raw), remove: async path => drafts.delete(path) },
		},
		workspace: { getLeavesOfType: () => [{ view: markdownView }] },
	};
	const manager = new NoteEncryption({ app, manifest: { id: 'wujie-sync' }, data: {} });
	const container = document.body.createDiv();
	view = new EditorView({ state: EditorState.create({ doc: disk, extensions: [editorInfoField, encryptionExtension(manager)] }), parent: container });
	return { manager, view, file, box, container, drafts, read: () => disk, dispose() { manager.dispose(); view.destroy(); container.remove(); } };
}
async function submit() {
	const prompt = modals.at(-1); prompt.password.value = password; await prompt.run(); assert.equal(prompt.closed, true);
}

for (const connected of [false, true]) test(
	'whole-note encryption, attachment picker and restoration in ' + (connected ? 'a connected vault' : 'an independent vault'),
	async () => {
	const file = { path: 'Private.md', stat: { mtime: 1577836800123 } };
	const photo = { path: 'image.png', stat: { mtime: 1577836800123, ctime: 1577836800123, size: 4 } };
	const body = 'before ![[image.png|200]] after\nprivate image note';
	let disk = body;
	const files = new Map([[file.path, file], [photo.path, photo]]);
	const stored = new Map([[photo, Uint8Array.of(1, 2, 3, 4).buffer]]);
	const vault = {
		configDir: '.fixture', getMarkdownFiles: () => [file], getFiles: () => [...files.values()], getAbstractFileByPath: path => files.get(path),
		adapter: { exists: async path => files.has(path) },
		read: async () => disk, readBinary: async file => stored.get(file).slice(0),
		process: async (_file, update) => { disk = update(disk); },
		async createBinary(path, bytes, options) {
			const result = { path, stat: { size: bytes.byteLength, ...options } };
			files.set(path, result); stored.set(result, bytes.slice(0));
			return result;
		},
		async delete(file) { files.delete(file.path); stored.delete(file); },
	};
	const manager = new NoteEncryption({ app: { vault, workspace: { getLeavesOfType: () => [] }, metadataCache: {
		getFileCache: () => ({ embeds: [{ link: 'image.png|200', original: '![[image.png|200]]' }] }), getFirstLinkpathDest: path => files.get(path),
	} }, manifest: { id: 'wujie-sync' }, data: { settings: connected ? { workspace: 'fixture' } : {} }, async saveData() {} });
	const activeURLs = new Map();
	const area = document.body.createDiv();
	const url = area.ownerDocument.defaultView.URL;
	url.createObjectURL = blob => { activeURLs.set('blob:fixture', blob); return 'blob:fixture'; };
	url.revokeObjectURL = value => activeURLs.delete(value);
	try {
		let encrypt;
		manager.addFileMenu({ addItem: callback => callback({ setTitle: () => ({ setIcon: () => ({ onClick: callback => { encrypt = callback; } }) }) }) }, file);
		encrypt();
		await new Promise(resolve => setImmediate(resolve));
		const passwordForm = modals.at(-1);
		assert.ok(passwordForm.contentEl.textContent.includes('image.png'));
		passwordForm.confirm.value = password;
		await submit();
		assert.equal(files.has(photo.path), false);
		const [range] = lockedRanges(disk);
		assert.equal(range.box.kind, 'bundle');
		assert.equal(range.box.v, 3);
		assert.equal(files.size, 1);
		manager.renderLock(area, file.path, range.marker, range.box);
		area.querySelector('button').click();
		await submit();
		for (let tries = 0; tries < 20 && !area.querySelector('.wujie-editor-image'); tries++) await new Promise(resolve => setImmediate(resolve));
		const inlineImage = area.querySelector('.wujie-editor-image');
		assert.equal(inlineImage?.src, 'blob:fixture');
		assert.equal(inlineImage?.width, 200);
		assert.equal(inlineImage?.closest('.cm-line')?.textContent, 'before  after');
		assert.equal(area.querySelectorAll('.wujie-decrypted-attachments').length, 0);
		assert.equal(activeURLs.get('blob:fixture').type, 'image/png');
		assert.equal(files.has(photo.path), false);
		assert.equal(disk, range.marker);
		const [session] = manager.sessions;
		const sameEditor = session.editor.view;
		await manager.finishEditing(session);
		assert.equal(session.editor.view, sameEditor);
		manager.editSession(session);
		const pdf = new File(['private PDF bytes'], 'file name.pdf', { lastModified: photo.stat.mtime });
		const addedImage = new File([Uint8Array.of(5, 6, 7)], 'new image.png', { lastModified: photo.stat.mtime });
		const process = vault.process;
		vault.process = async () => { throw Error('fixture interrupted before marker commit'); };
		await assert.rejects(manager.saveAttachments(session, [pdf]), /fixture interrupted/u);
		vault.process = process;
		assert.equal(disk, range.marker);
		assert.equal(files.size, 1, 'failed import leaves the former encrypted note in place');

		[...area.querySelectorAll('button')].find(el => el.textContent === '添加附件').click();
		const picker = document.querySelector('input[type=file]');
		assert.ok(picker.multiple);
		Object.defineProperty(picker, 'files', { value: [pdf, addedImage] });
		const modalCount = modals.length;
		picker.dispatchEvent(new dom.window.Event('change'));
		assert.ok(session.attachmentWork);
		await session.attachmentWork;
		assert.equal(modals.length, modalCount);
		const [updated] = lockedRanges(disk);
		assert.notEqual(updated.box.id, range.box.id);
		assert.equal(files.has('file name.pdf'), false);
		assert.equal(files.has(`wujie-locked-${range.box.id}.wujie-lock`), false);
		assert.ok(contents(session.editor.view).includes('[file name.pdf](<./file%20name.pdf>)'));
		for (let tries = 0; tries < 20 && !area.querySelector('.wujie-editor-image[alt="new image.png"]'); tries++)
			await new Promise(resolve => setImmediate(resolve));
		assert.ok(area.querySelector('.wujie-editor-image[alt="new image.png"]')?.closest('.cm-line'));
		assert.equal(files.has('new image.png'), false);
		assert.ok(!disk.includes('file name.pdf') && !disk.includes('private PDF bytes'));
		await manager.lock(session);
		assert.equal(area.querySelectorAll('.wujie-editor-image').length, 0);
		assert.equal(activeURLs.size, 0);
		assert.equal(files.has(photo.path), false);
		manager.permanent({ area, path: file.path, marker: updated.marker, box: updated.box, saved: 0, version: 0 });
		await submit();
		assert.ok(disk.startsWith(body));
		assert.deepEqual(new Uint8Array(await vault.readBinary(files.get(photo.path))), Uint8Array.of(1, 2, 3, 4));
		assert.equal(files.get(photo.path).stat.mtime, photo.stat.mtime);
		assert.equal(new TextDecoder().decode(await vault.readBinary(files.get('file name.pdf'))), 'private PDF bytes');
		assert.equal(files.get('file name.pdf').stat.mtime, pdf.lastModified);
		assert.deepEqual(new Uint8Array(await vault.readBinary(files.get('new image.png'))), Uint8Array.of(5, 6, 7));
		assert.equal(await pdf.text(), 'private PDF bytes');
	} finally {
		manager.dispose(); area.remove();
		delete url.createObjectURL; delete url.revokeObjectURL;
	}
});

test('real CodeMirror DOM replaces inline and multiline full-note ciphertext with clickable lock controls', async () => {
	for (const kind of ['text', 'note']) {
		const value = await fixture(kind);
		try {
			assert.ok(value.container.textContent.includes(kind === 'note' ? '此笔记已加密' : '加密内容'));
			assert.ok(!value.container.textContent.includes('wujie-lock:') && !value.container.textContent.includes('初始秘密'));
			assert.ok(value.read().includes(kind === 'note' ? 'wujie-encrypted' : 'wujie-lock:'));
			value.container.querySelector('.wujie-encrypted button').click(); await submit();
			assert.ok(value.container.textContent.includes('初始秘密'));
			assert.ok(!value.read().includes('初始秘密'));
		} finally { value.dispose(); await Promise.all(value.manager.pendingWrites); }
	}
});

test('a picker returning after lock cannot import until the note is reopened', async () => {
	const value = await fixture('note');
	const vault = value.manager.app.vault;
	const packages = new Map();
	const find = vault.getAbstractFileByPath, exists = vault.adapter.exists;
	Object.assign(vault, {
		getFiles: () => [value.file, ...packages.values()],
		getAbstractFileByPath: path => find(path) ?? packages.get(path),
		createBinary: async (path, bytes) => {
			assert.ok(!packages.has(path));
			const file = { path, bytes, stat: { size: bytes.byteLength } };
			packages.set(path, file);
			return file;
		},
		readBinary: async file => file.bytes.slice(0),
		delete: async file => packages.delete(file.path),
	});
	vault.adapter.exists = async path => packages.has(path) || await exists(path);
	try {
		value.container.querySelector('button').click(); await submit();
		const [session] = value.manager.sessions;
		value.manager.editSession(session);
		const add = [...value.container.querySelectorAll('button')].find(el => el.textContent === '添加附件');
		assert.ok(add);
		add.click();
		const picker = document.querySelector('input[type=file]');
		const photo = new File([Uint8Array.of(7, 8, 9)], 'photo.png', { lastModified: 123 });
		const before = value.read(), modalCount = modals.length;
		assert.equal(session.wrapKey.extractable, false);
		await value.manager.lock(session);
		assert.equal(session.wrapKey, undefined);
		Object.defineProperty(picker, 'files', { value: [photo] });
		picker.dispatchEvent(new dom.window.Event('change'));
		await new Promise(resolve => setImmediate(resolve));
		assert.equal(modals.length, modalCount);
		assert.equal(value.read(), before);
		assert.equal(packages.size, 0);
		assert.equal(value.container.querySelector('.wujie-crypto-editor'), null);
		value.container.querySelector('button').click(); await submit();
		const [reopened] = value.manager.sessions;
		await value.manager.saveAttachments(reopened, [photo]);
		const [range] = lockedRanges(value.read());
		assert.equal(range.box.kind, 'bundle');
		assert.equal(range.box.v, 3);
		assert.equal(packages.size, 0);
		assert.equal(packages.has('photo.png'), false);
		const { text } = await openLocked(range.box, password);
		assert.match(JSON.parse(text).text, /初始秘密[\s\S]*!\[\]\(<\.\/photo\.png>\)/u);
		assert.equal(reopened.box.id, range.box.id);
		assert.equal(range.box.salt, session.box.salt);
		await assert.rejects(openLocked(range.box, 'wrong password'));
	} finally { value.dispose(); await Promise.all(value.manager.pendingWrites); }
});

test('adding to an existing sidecar bundle migrates it only after saving the new note', async () => {
	const original = Uint8Array.of(6, 8, 9);
	const old = { path: 'old.png', stat: { size: 3, mtime: 50, ctime: 40 } };
	let sidecar;
	const legacy = await createLocked('', password, '', 'bundle', async (id, key) => {
		const vault = {
			getAbstractFileByPath: path => path === sidecar?.path ? sidecar : null,
			readBinary: async file => (file === old ? original.buffer : sidecar.bytes).slice(0),
			async createBinary(path, bytes) { return sidecar = { path, bytes, stat: { size: bytes.byteLength } }; },
		};
		return (await stageNoteAttachments(vault, id, key, '![[old.png]]', [old])).value;
	});
	const value = await fixture('note', undefined, { received: lockedMarker(legacy) });
	const vault = value.manager.app.vault;
	const getFile = vault.getAbstractFileByPath;
	Object.assign(vault, {
		getFiles: () => sidecar ? [value.file, sidecar] : [value.file],
		getAbstractFileByPath: path => path === sidecar?.path ? sidecar : getFile(path),
		readBinary: async () => sidecar.bytes.slice(0),
		async delete(file) { assert.equal(file.path, attachmentPackagePath(legacy.id)); sidecar = undefined; },
	});
	try {
		value.manager.owner.data.settings = { workspace: 'test-vault' };
		value.container.querySelector('button').click(); await submit();
		const [session] = value.manager.sessions;
		const extra = new File(['original bytes'], 'next.pdf');
		const process = vault.process;
		vault.process = async () => { throw Error('interrupted migration'); };
		await assert.rejects(value.manager.saveAttachments(session, [extra]), /interrupted migration/u);
		assert.ok(sidecar);
		assert.equal(value.read(), lockedMarker(legacy));
		vault.process = process;
		await value.manager.saveAttachments(session, [extra]);
		assert.equal(sidecar, undefined);
		assert.equal(session.box.v, 3);
		assert.equal(session.manifest.entries[0].mtime, old.stat.mtime);
		assert.deepEqual(await decryptAttachment(session.attachmentBytes, session.box.id, session.key, session.manifest.entries[0]), original);
	} finally { value.dispose(); await Promise.all(value.manager.pendingWrites); }
});

test('connected vault drop travels as one note and unlocks with attachments on the second device', async t => {
	const source = await fixture('note');
	let receiver;
	const image = new File([Uint8Array.of(1, 3, 7)], 'photo.png', { lastModified: 1577836800456 });
	const pdfContents = '%PDF-1.7\nprivate document bytes\n' + 'a'.repeat(2400000);
	const pdf = new File([pdfContents], 'report.pdf', { lastModified: 1577836800789 });
	const opts = { workspace: 'synthetic-connected-vault' };
	const previews = new Map();
	const url = dom.window.URL;
	url.createObjectURL = blob => {
		const address = 'blob:connected-' + previews.size;
		previews.set(address, blob); return address;
	};
	url.revokeObjectURL = address => previews.delete(address);
	try {
		source.manager.owner.data.settings = opts;
		const vault = source.manager.app.vault;
		vault.getFiles = () => [source.file];
		vault.createBinary = () => assert.fail('Connected import must not write plaintext or a sidecar');
		source.container.querySelector('button').click(); await submit();
		const [session] = source.manager.sessions;
		assert.ok([...session.area.querySelectorAll('button')].some(control => control.textContent === '添加附件'));
		const transfer = { types: ['Files'], files: [image, pdf] };
		const fire = type => {
			const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true });
			Object.defineProperty(event, 'dataTransfer', { value: transfer });
			session.editor.view.contentDOM.dispatchEvent(event);
			return event;
		};
		assert.equal(fire('dragover').defaultPrevented, true);
		assert.equal(transfer.dropEffect, 'copy');
		const before = modals.length;
		assert.equal(fire('drop').defaultPrevented, true);
		assert.ok(session.attachmentWork);
		await session.attachmentWork;
		assert.equal(modals.length, before);
		const serialized = source.read();
		assert.ok(serialized.length > 4 * 1024 * 1024, 'cover envelopes exceeding the former decode limit');
		assert.ok(!serialized.includes('private document bytes') && !serialized.includes('report.pdf'));
		const box = lockedRanges(serialized)[0].box;
		assert.equal(box.v, 3);
		const mtime = source.file.stat.mtime;
		const salt = freshSalt();
		const keys = await unlockWorkspace('synthetic sync password', salt);
		const bytes = new TextEncoder().encode(serialized);
		let api;
		if (process.env.SMART_SYNC_SERVER_DIR) {
			const fixtureUrl = pathToFileURL(resolve(process.env.SMART_SYNC_SERVER_DIR, 'test/service-fixture.mjs'));
			const { createTestService } = await import(fixtureUrl.href);
			const directory = await mkdtemp(join(tmpdir(), 'ss2-connected-attachments-'));
			const access = 'synthetic-connected-attachments-0123456789012345';
			const service = await createTestService({ directory, credentials: [{ owner: 'synthetic', key: access }] });
			t.after(async () => { await service.stop(); await rm(directory, { recursive: true, force: true }); });
			api = new WorkspaceApi(await service.listen(), access);
			api.workspace = (await api.create('Connected attachments', salt, await workspaceProof(keys))).id;
			const sender = new NotebookSynchronizer({
				api, keys, direction: 'send', attachmentLimit: 0, save: async () => {},
				host: {
					list: async () => [source.file.path], read: async () => bytes, mtime: async () => mtime,
				},
			});
			await sender.run();
		} else {
			const packet = await packNote(keys, opts.workspace, source.file.path, bytes, undefined, undefined, 'file', mtime);
			const objects = new Map(packet.objects.map(object => [object.address, object.body]));
			api = { workspace: opts.workspace, load: async id => objects.get(id), feed: async after => ({
				entries: after ? [] : [{ sequence: 1, note: packet.id, manifest: packet.manifest, removed: false }], more: false,
			}) };
		}
		let received;
		const sync = new NotebookSynchronizer({
			api, keys, state: emptyState(), direction: 'receive', attachmentLimit: 0, ignored: ['*.wujie-lock'],
			save: async () => {}, host: { list: async () => [], read: async () => null, write: async (...args) => { received = args; } },
		});
		await sync.run();
		assert.equal(received[0], source.file.path);
		assert.equal(received[2], mtime);
		const text = new TextDecoder().decode(received[1]);
		assert.equal(text, serialized);
		await source.manager.lock(session);
		assert.equal(session.wrapKey, undefined);
		receiver = await fixture('note', undefined, { received: text });
		receiver.manager.owner.data.settings = opts;
		receiver.manager.app.vault.createBinary = () => assert.fail('Temporary unlock must not create a file');
		receiver.container.querySelector('button').click(); await submit();
		const [reopened] = receiver.manager.sessions;
		assert.match(contents(reopened.editor.view), /report\.pdf/u);
		for (let tries = 0; tries < 20 && !receiver.container.querySelector('.wujie-editor-image'); tries++)
			await new Promise(resolve => setImmediate(resolve));
		assert.match(receiver.container.querySelector('.wujie-editor-image')?.src ?? '', /^blob:connected-/u);
		const manifest = reopened.manifest;
		assert.equal(manifest.entries[0].mtime, image.lastModified);
		assert.equal(manifest.entries[1].mtime, pdf.lastModified);
		assert.deepEqual(await decryptAttachment(reopened.attachmentBytes, box.id, reopened.key, manifest.entries[0]), Uint8Array.of(1, 3, 7));
		assert.equal(new TextDecoder().decode(await decryptAttachment(reopened.attachmentBytes, box.id, reopened.key, manifest.entries[1])), pdfContents);
		const rotated = await rewrapLocked(box, password, 'replacement note password');
		assert.equal(rotated.attachmentData, box.attachmentData);
		await assert.rejects(openLocked(rotated, password));
		assert.equal((await openLocked(rotated, 'replacement note password')).text, (await openLocked(box, password)).text);
		const corrupted = (box.attachmentData[0] === 'A' ? 'B' : 'A') + box.attachmentData.slice(1);
		await assert.rejects(verifyNoteAttachments(receiver.manager.app.vault, box.id, reopened.key, manifest, corrupted));
		await receiver.manager.lock(reopened);
		assert.equal(receiver.container.querySelector('.wujie-editor-image'), null);
		assert.equal(previews.size, 0);
	} finally {
		source.dispose();
		receiver?.dispose();
		await Promise.all([...source.manager.pendingWrites, ...(receiver?.manager.pendingWrites ?? [])]);
		delete url.createObjectURL; delete url.revokeObjectURL;
	}
});

test('actual DOM auto-save keeps the same secure editor alive across host reloads and locks updated ciphertext', async () => {
	const value = await fixture();
	try {
		value.container.querySelector('.wujie-encrypted button').click(); await submit();
		const session = [...value.manager.sessions][0]; value.manager.editSession(session);
		const editor = session.editor.view;
		edit(editor, '第一版修改');
		await value.manager.queueSave(session);
		assert.equal(session.status.textContent, '');
		assert.ok(editor.dom.isConnected, 'host reload must not replace the active secure editor');
		assert.equal(session.locked, undefined);
		edit(editor, '第二版中文👩‍💻'); await value.manager.queueSave(session);
		assert.equal(session.editor.view, editor);
		assert.equal((await openLocked(lockedRanges(value.read())[0].box, password)).text, '第二版中文👩‍💻');
		await value.manager.lock(session);
		assert.equal(contents(editor), ''); assert.equal(session.key, undefined);
		assert.equal(editor.dom.isConnected, false);
		assert.ok(!value.container.textContent.includes('第二版中文'));
		assert.equal(value.drafts.size, 0);
	} finally { value.dispose(); await Promise.all(value.manager.pendingWrites); }
});

test('secure live preview renders formatting in place, keeps Markdown on save and treats HTML as text', async () => {
	const value = await fixture('note', '# 标题\n\n粗体内容\n\n- 列表项\n\n<img src="https://example.test/private.png">\n\n结尾');
	try {
		value.container.querySelector('.wujie-encrypted button').click(); await submit();
		const [session] = value.manager.sessions;
		value.manager.editSession(session);
		const view = session.editor.view;
		const selection = contents(view).indexOf('粗体内容');
		view.dispatch({ selection: { anchor: selection, head: selection + '粗体内容'.length } });
		session.area.querySelector('button[aria-label="加粗"]').click();
		view.dispatch({ selection: { anchor: view.state.doc.length } });
		assert.equal(view.dom.querySelector('.wujie-editor-h1').textContent, '标题');
		assert.equal(view.dom.querySelector('strong').textContent, '粗体内容');
		assert.ok(view.dom.textContent.includes('• 列表项'));
		assert.ok(view.dom.textContent.includes('<img src="https://example.test/private.png">'));
		assert.equal(view.dom.querySelectorAll('img[src]').length, 0);
		await value.manager.queueSave(session);
		const plain = (await openLocked(lockedRanges(value.read())[0].box, password)).text;
		assert.ok(plain.includes('**粗体内容**'));
		assert.ok(!value.read().includes('粗体内容'));
		await value.manager.lock(session);
		assert.equal(contents(view), '');
		assert.ok(!value.container.textContent.includes('粗体内容'));
	} finally { value.dispose(); await Promise.all(value.manager.pendingWrites); }
});

test('encrypted autosave refreshes a stale host editor and still refuses new surrounding edits', async () => {
	const value = await fixture('text', '初始秘密', { refreshInProcess: false });
	try {
		value.container.querySelector('.wujie-encrypted button').click();
		await submit();
		const [session] = value.manager.sessions;
		value.manager.editSession(session);
		const editor = session.editor.view;
		for (const text of ['第一次修改', '第二次修改']) {
			edit(editor, text);
			await value.manager.queueSave(session);
			assert.equal(value.view.state.doc.toString(), value.read());
			assert.equal((await openLocked(lockedRanges(value.read())[0].box, password)).text, text);
			assert.ok(editor.dom.isConnected);
		}
		value.view.dispatch({ changes: { from: 0, insert: '外部未保存修改 ' } });
		edit(editor, '只留在加密草稿中的修改');
		await value.manager.queueSave(session);
		assert.ok(value.view.state.doc.toString().startsWith('外部未保存修改'));
		assert.equal((await openLocked(lockedRanges(value.read())[0].box, password)).text, '第二次修改');
		assert.equal(value.drafts.size, 1);
	} finally { value.dispose(); await Promise.all(value.manager.pendingWrites); }
});

test('live-preview code block redraw keeps the same secure editor through consecutive saves', async () => {
	const value = await fixture('note');
	const { manager, file, container } = value;
	try {
		manager.app.workspace.getLeavesOfType()[0].view.containerEl = container;
		const [original] = lockedRanges(value.read());
		const area = container.createDiv();
		manager.renderLock(area, file.path, original.marker, original.box);
		area.querySelector('button').click();
		await submit();
		const [session] = manager.sessions;
		manager.editSession(session);
		const editor = session.editor.view;
		const { vault } = manager.app;
		const write = vault.process;
		vault.process = async (...args) => {
			const saved = await write(...args);
			const [range] = lockedRanges(saved);
			const fresh = document.createElement('div');
			manager.renderLock(fresh, file.path, range.marker, range.box);
			area.replaceWith(fresh);
			return saved;
		};
		for (const text of ['第一次预览编辑', '第二次预览编辑', '第三次预览编辑']) {
			edit(editor, text);
			await manager.queueSave(session);
			assert.equal((await openLocked(lockedRanges(value.read())[0].box, password)).text, text);
			assert.equal(session.editor.view, editor);
			assert.ok(editor.dom.isConnected);
		}
		await manager.lock(session);
		assert.equal(contents(editor), '');
		assert.equal(session.renderObserver, undefined);
	} finally { value.dispose(); await Promise.all(manager.pendingWrites); }
});

test('partial ciphertext edits are rejected while deleting a whole encrypted block remains possible', async () => {
	const value = await fixture();
	try {
		const original = value.view.state.doc.toString(), [range] = lockedRanges(original);
		value.view.dispatch({ changes: { from: range.from + 20, to: range.from + 21, insert: 'X' } });
		assert.equal(value.view.state.doc.toString(), original);
		value.view.dispatch({ changes: { from: range.from, to: range.to, insert: '' } });
		assert.equal(value.view.state.doc.toString(), '前文  后文');
	} finally { value.dispose(); await Promise.all(value.manager.pendingWrites); }
});

test('a remote replacement locks the old session without redrawing its stale ciphertext controls', async () => {
	for (const sameObject of [true, false]) {
	const value = await fixture();
	try {
		value.container.querySelector('.wujie-encrypted button').click(); await submit();
		const old = [...value.manager.sessions][0];
		const replacement = sameObject ? await updateLocked(old.box, old.key, '远端新内容') : await createLocked('远端新内容', password);
		await value.manager.app.vault.process(value.file, current => current.replace(old.marker, lockedMarker(replacement)));
		await Promise.all(value.manager.pendingWrites);
		assert.equal(old.key, undefined); assert.equal(value.manager.sessions.size, 0);
		assert.ok(!value.container.textContent.includes('初始秘密'));
		value.container.querySelector('.wujie-encrypted button').click(); await submit();
		assert.equal([...value.manager.sessions][0].text, '远端新内容');
	} finally { value.dispose(); await Promise.all(value.manager.pendingWrites); }
	}
});

test('an unwritable ciphertext journal reports failure and a successful retry clears the volatile draft', async () => {
	const value = await fixture();
	try {
		value.container.querySelector('.wujie-encrypted button').click(); await submit();
		const session = [...value.manager.sessions][0]; value.manager.editSession(session);
		const adapter = value.manager.app.vault.adapter, originalWrite = adapter.write, original = value.read();
		adapter.write = async () => { throw Error('synthetic disk full'); };
		edit(session.editor.view, '需要重试的秘密');
		await value.manager.queueSave(session);
		assert.equal(value.read(), original); assert.equal(session.failed, true);
		assert.equal(value.manager.volatileDrafts.size, 1);
		assert.ok(session.status.textContent.includes('尚未确认保存'));
		adapter.write = originalWrite;
		await value.manager.queueSave(session);
		assert.equal(session.status.textContent, '');
		assert.equal(session.failed, false); assert.equal(value.manager.volatileDrafts.size, 0);
		assert.equal((await openLocked(lockedRanges(value.read())[0].box, password)).text, '需要重试的秘密');
		await value.manager.lock(session); assert.equal(session.key, undefined);
	} finally { value.dispose(); await Promise.all(value.manager.pendingWrites); }
});

test('mobile selection action appears only with a selection and retains the selected range while opening the password form', async () => {
	Platform.isMobile = true;
	const value = await fixture();
	try {
		assert.equal(value.container.querySelector('.wujie-encryption-selection-tools'), null);
		value.view.dispatch({ selection: { anchor: 0, head: 2 } });
		const action = value.container.querySelector('.wujie-encryption-selection-tools button'); assert.ok(action);
		action.click(); await new Promise(resolve => setTimeout(resolve, 0));
		assert.equal(modals.at(-1).titleText, '加密所选文本');
		assert.equal(modals.at(-1).password.getAttribute('aria-label'), '密码（至少4个字符）');
		assert.equal(value.view.state.selection.main.from, 0); assert.equal(value.view.state.selection.main.to, 2);
		modals.at(-1).close();
	} finally { value.dispose(); await Promise.all(value.manager.pendingWrites); Platform.isMobile = false; }
});

test('inline locks and unlocked plaintext keep actions outside the document; desktop native menu closes on lock', async () => {
	const value = await fixture();
	try {
		const area = value.container.querySelector('.wujie-encrypted');
		area.querySelector('.wujie-crypto-more').click();
		assert.deepEqual(menus.at(-1).items.map(item => item.title), ['解锁', '修改密码', '永久解密']);
		assert.equal(area.querySelector('.wujie-crypto-menu'), null);
		value.manager.closeActions();
		area.querySelector('button').click(); await submit();
		assert.ok(area.classList.contains('is-open'));
		assert.equal(area.querySelector('pre'), null);
		assert.equal(area.querySelectorAll('button').length, 1, 'only a discreet more trigger stays in the sentence');
		area.querySelector('.wujie-decrypted-text').click();
		assert.deepEqual(menus.at(-1).items.map(item => item.title), ['编辑', '锁定', '修改密码', '永久解密']);
		assert.ok(!area.textContent.includes('永久解密'));
		await value.manager.lock([...value.manager.sessions][0]);
		assert.equal(menus.at(-1).visible, false);
	} finally { value.dispose(); await Promise.all(value.manager.pendingWrites); }
});

test('touch actions use a modal bottom sheet and opening a password form removes the action sheet', async () => {
	Platform.isMobile = true; const value = await fixture();
	try {
		const area = value.container.querySelector('.wujie-encrypted');
		area.querySelector('.wujie-crypto-more').click();
		const sheet = modals.at(-1);
		assert.ok(sheet.modalEl.classList.contains('wujie-crypto-sheet'));
		assert.equal(area.querySelector('.wujie-crypto-sheet'), null);
		assert.deepEqual([...sheet.contentEl.querySelectorAll('button')].map(el => el.textContent), ['解锁', '修改密码', '永久解密', '取消']);
		sheet.contentEl.querySelector('button').click();
		assert.equal(sheet.modalEl.isConnected, false);
		assert.equal(modals.at(-1).titleText, '解锁'); modals.at(-1).close();
		area.querySelector('.wujie-crypto-more').click(); value.manager.lockAll();
		assert.equal(modals.at(-1).modalEl.isConnected, false);
	} finally { value.dispose(); await Promise.all(value.manager.pendingWrites); Platform.isMobile = false; }
});

test('nested encrypted blocks unlock separately and inner edits survive outer encryption save and recursive lock', async () => {
	const inner = await createLocked('内层原文', password);
	const value = await fixture('note', '外层文字 ' + lockedMarker(inner));
	try {
		value.container.querySelector('.wujie-encrypted button').click(); await submit();
		const outer = [...value.manager.sessions][0];
		const innerArea = outer.area.querySelector('.wujie-encrypted'); assert.ok(innerArea);
		innerArea.querySelector('button').click(); await submit();
		const nested = [...value.manager.sessions].find(session => session.parentSession === outer); assert.ok(nested);
		assert.equal(nested.text, '内层原文');
		value.manager.editSession(nested); edit(nested.editor.view, '内层新内容');
		await value.manager.editSession(outer);
		assert.equal(nested.key, undefined, 'outer editing must flush and lock nested editors first');
		assert.equal((await openLocked(lockedRanges(contents(outer.editor.view))[0].box, password)).text, '内层新内容');
		await value.manager.lock(outer);
		assert.equal(value.manager.sessions.size, 0); assert.equal(outer.key, undefined); assert.equal(nested.key, undefined);
		const outerText = (await openLocked(lockedRanges(value.read())[0].box, password)).text;
		assert.ok(!outerText.includes('内层新内容'));
		assert.equal((await openLocked(lockedRanges(outerText)[0].box, password)).text, '内层新内容');
	} finally { value.dispose(); await Promise.all(value.manager.pendingWrites); }
});

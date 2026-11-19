import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { strToU8, zipSync } from 'fflate';
import { EPUB_MAX_BYTES, openEpub, renderEpubChapter } from '../src/epub.js';
import { freshSalt, packNote, unlockWorkspace } from '../src/codec.js';
import { NotebookSynchronizer, emptyState } from '../src/synchronizer.js';

const ns = 'http://www.w3.org/1999/xhtml';
const page = body => `<!DOCTYPE html><html xmlns="${ns}"><body>${body}</body></html>`;
const container = '<container><rootfiles><rootfile full-path="Pkg/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>';
const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5X8AAAAASUVORK5CYII=', 'base64'));
const metadata = '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Test book</dc:title></metadata>';
const opf = (version = '3.0', extraMetadata = metadata) => `<package version="${version}">${extraMetadata}<manifest>
	<item id="one" href="Text/Chapter%201.xhtml" media-type="application/xhtml+xml"/>
	<item id="two" href="Text/two.xhtml" media-type="application/xhtml+xml"/>
	<item id="logo" href="Images/dot.png" media-type="image/png"/>
	<item id="toc" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
	<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
	</manifest><spine toc="ncx"><itemref idref="one"/><itemref idref="two"/></spine></package>`;
const nav = `<html xmlns="${ns}" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc">
	<a href="Text/two.xhtml#start">The second chapter</a><a href="Text/Chapter%201.xhtml">The first chapter</a>
	</nav></body></html>`;
const two = 'Pkg/Text/two.xhtml';
const makeBook = (overrides = {}) => zipSync(Object.fromEntries(Object.entries({
	mimetype: [strToU8('application/epub+zip'), { level: 0 }],
	'META-INF/container.xml': container,
	'Pkg/book.opf': opf(),
	'Pkg/nav.xhtml': nav,
	'Pkg/Text/Chapter 1.xhtml': page('<h1>First chapter</h1><p>Hello&nbsp;reader.</p><img src="../Images/dot.png" alt="Dot"/><a href="two.xhtml#start">Next</a>'),
	[two]: page('<h1 id="start">Second chapter</h1>'),
	'Pkg/Images/dot.png': png,
	...overrides,
}).filter(([, content]) => content !== null)
  .map(([path, content]) => [path, typeof content === 'string' ? strToU8(content) : content])));

function fixture(t) {
	const { window } = new JSDOM('<main></main>');
	t.after(() => window.close());
	const blobs = new Map(), revoked = [];
	let sequence = 0;
	window.URL.createObjectURL = blob => {
		const url = 'blob:epub-test-' + ++sequence;
		blobs.set(url, blob);
		return url;
	};
	window.URL.revokeObjectURL = url => { revoked.push(url); blobs.delete(url); };
	window.HTMLElement.prototype.createEl = function (tag, options = {}) {
		const el = this.ownerDocument.createElement(tag);
		if (options.cls) el.className = options.cls;
		if (options.text) el.textContent = options.text;
		for (const [name, value] of Object.entries(options.attr ?? {})) el.setAttribute(name, value);
		this.append(el);
		return el;
	};
	window.HTMLElement.prototype.createDiv = function (options) { return this.createEl('div', options); };
	return { window, doc: window.document, blobs, revoked };
}

test('EPUB 3 reads spine order and local illustrations and links; EPUB 2 accepts an NCX table of contents', t => {
	const { window, doc, blobs, revoked } = fixture(t);
	const book = openEpub(makeBook(), window.DOMParser);
	assert.equal(book.title, 'Test book');
	assert.deepEqual(book.chapters.map(item => item.label), ['The first chapter', 'The second chapter']);
	const targets = [];
	const rendered = renderEpubChapter(book, 0, doc, (...args) => targets.push(args));
	doc.body.append(rendered.fragment);
	assert.match(doc.body.textContent, /Hello\u00a0reader\./u);
	assert.equal(doc.querySelector('img').alt, 'Dot');
	assert.equal(blobs.get(doc.querySelector('img').getAttribute('src')).type, 'image/png');
	doc.querySelector('a').click();
	assert.deepEqual(targets, [[1, 'start']]);
	rendered.dispose();
	assert.equal(blobs.size, 0);
	assert.equal(revoked.length, 1);
	const older = openEpub(makeBook({
		'Pkg/book.opf': opf('2.0').replace(' properties="nav"', ''),
		'Pkg/toc.ncx': '<!DOCTYPE ncx SYSTEM "urn:example:offline"><ncx><navMap><navPoint><navLabel><text>Old chapter</text></navLabel><content src="Text/two.xhtml#start"/></navPoint></navMap></ncx>',
	}), window.DOMParser);
	assert.equal(older.chapters[1].label, 'Old chapter');
});

test('only fresh, inert markup and bounded manifest images reach the reading DOM', t => {
	const { window, doc, blobs } = fixture(t);
	const book = openEpub(makeBook({ [two]: page(`
		<p id="section" class="unsafe" onclick="noop()" style="color:red">Visible</p>
		<script>script body</script><style>remote CSS</style><iframe src="https://example.invalid/"></iframe>
		<form><input value="data"/></form><svg xmlns="http://www.w3.org/2000/svg"><title>SVG body</title></svg>
		<img src="https://example.invalid/img.png" alt="External picture" srcset="https://example.invalid/other.png"/>
		<img src="../Images/dot.png" alt="Not a PNG"/>
		<a href="https://example.invalid/">external link</a><a href="../../../vault.md">outside archive</a>
		<a href="#section" onclick="noop()">inside</a>
	`), 'Pkg/Images/dot.png': '<svg/>' }), window.DOMParser);
	const rendered = renderEpubChapter(book, 1, doc, () => {});
	doc.body.append(rendered.fragment);
	assert.equal(blobs.size, 0);
	assert.equal(doc.querySelectorAll('script, style, iframe, form, input, svg, img, [onclick], [style], [id], [srcset]').length, 0);
	assert.equal(doc.querySelectorAll('a').length, 1);
	assert.equal(rendered.anchors.get('section').textContent, 'Visible');
	assert.match(doc.body.textContent, /External picture/u);
	assert.doesNotMatch(doc.body.textContent, /script body|remote CSS|SVG body/u);
});

test('protected, fixed layout, malformed and oversized books fail safely', t => {
	const { window } = fixture(t);
	const read = bytes => openEpub(bytes, window.DOMParser);
	assert.throws(() => read(new Uint8Array(0)), { code: 'invalid' });
	assert.throws(() => read(new Uint8Array(EPUB_MAX_BYTES + 1)), { code: 'large' });
	assert.throws(() => read(makeBook({ 'META-INF/encryption.xml':
		'<encryption><EncryptedData><EncryptionMethod Algorithm="urn:example:protected"/></EncryptedData></encryption>' })), { code: 'protected' });
	assert.equal(read(makeBook({ 'META-INF/encryption.xml':
		'<encryption><EncryptedData><EncryptionMethod Algorithm="http://www.idpf.org/2008/embedding"/></EncryptedData></encryption>' })).chapters.length, 2);
	assert.throws(() => read(makeBook({ 'Pkg/book.opf': opf('3.0',
		metadata.replace('</metadata>', '<meta property="rendition:layout">pre-paginated</meta></metadata>')) })), { code: 'unsupported' });
	assert.throws(() => read(makeBook({ 'META-INF/container.xml': '<container>' })), { code: 'invalid' });
	assert.throws(() => read(makeBook({ '../outside': 'x' })), { code: 'invalid' });
	assert.throws(() => read(makeBook({ [two]: page('a'.repeat(1024 * 1024)) })).readChapter(1), { code: 'large' });
	assert.throws(() => read(makeBook({ [two]: '<!DOCTYPE html [<!ENTITY hidden "test">]><html><body>&hidden;</body></html>' })).readChapter(1),
		{ code: 'unsupported' });
});

test('an EPUB received as an encrypted attachment retains its original bytes and modification time', async t => {
	const { window } = fixture(t);
	const path = 'books/Test.epub', source = makeBook(), mtime = 1731000123456;
	const workspace = 'synthetic-epub', keys = await unlockWorkspace('synthetic ebook', freshSalt());
	const packet = await packNote(keys, workspace, path, source, undefined, undefined, 'file', mtime);
	const objects = new Map(packet.objects.map(object => [object.address, object.body]));
	const state = emptyState();
	let received;
	const engine = new NotebookSynchronizer({ api: { workspace, load: async id => objects.get(id),
		feed: async after => ({ entries: after ? [] : [{ sequence: 1, note: packet.id, manifest: packet.manifest, removed: false }], more: false }) },
		keys, state, direction: 'receive', attachmentLimit: EPUB_MAX_BYTES, save: async () => {},
		host: { list: async () => [], read: async () => null, write: async (...args) => { received = args; } },
	});
	await engine.run();
	assert.equal(received[0], path);
	assert.deepEqual(received[1], source);
	assert.equal(received[2], mtime);
	assert.equal(openEpub(received[1], window.DOMParser).title, 'Test book');
});

const sdk = `
export class TFile {}
export class Notice { constructor(message) { throw new Error(message); } }
export class EditableFileView {
	constructor(leaf) { this.contentEl = leaf.contentEl; this.app = leaf.app; }
	getState() { return this.file ? { file: this.file.path } : {}; }
	async setState(state) {
		const file = this.app.vault.getAbstractFileByPath(state.file);
		if (file !== this.file) {
			if (this.file) await this.onUnloadFile(this.file);
			this.file = file;
			await this.onLoadFile(file);
		}
	}
	async onOpen() {}
	async onClose() { if (this.file) await this.onUnloadFile(this.file); this.file = undefined; }
	registerEvent() {}
}
`;
const hook = registerHooks({ resolve(specifier, context, next) {
	return specifier === 'obsidian' ? { url: 'data:text/javascript,' + encodeURIComponent(sdk), shortCircuit: true } : next(specifier, context);
} });
const { TFile } = await import('obsidian');
const { registerEpubReader } = await import('../src/epub-view.js');
hook.deregister();

test('file menu opens a vault-local reader alongside an existing EPUB plugin, restores chapter and reloads changed books', async t => {
	const { doc } = fixture(t);
	const bytes = makeBook();
	const file = Object.assign(new TFile(), { path: 'Books/Test.EPUB', basename: 'Test', stat: { size: bytes.length, mtime: 12345 } });
	let snapshot = bytes;
	const fileRead = [];
	const handlers = {};
	const workspace = {
		getLeaf: () => leaf,
		getLeavesOfType: () => [],
		revealLeaf: () => {},
		requestSaveLayout() { this.saved = true; },
		onLayoutReady: callback => callback(),
		on: (event, callback) => { handlers[event] = callback; },
	};
	const app = {
		workspace, vault: {
			getAbstractFileByPath: path => path === file.path ? file : null,
			readBinary: async target => { fileRead.push(target); return snapshot.buffer; },
			on: (event, callback) => { handlers[event] = callback; },
		},
	};
	const leaf = {
		app, contentEl: doc.querySelector('main'),
		async setViewState(state) {
			assert.equal(state.type, 'wujie-sync-epub');
			this.view ??= owner.createView(this);
			await this.view.onOpen();
			await this.view.setState(state.state, {});
		},
	};
	const owner = {
		app, registerEvent() {},
		registerView(type, callback) { this.createView = callback; },
		registerExtensions() { throw new Error('Already owned'); },
	};
	registerEpubReader(owner);
	let action;
	handlers['file-menu']({ addItem: callback => callback({
		setTitle() { return this; }, setIcon() { return this; }, onClick(callback) { action = callback; },
	}) }, file);
	await action();
	assert.deepEqual(fileRead, [file]);
	assert.match(leaf.contentEl.querySelector('article').textContent, /First chapter/);
	assert.equal(leaf.view.previous.disabled, true);
	leaf.view.next.click();
	assert.equal(workspace.saved, true);
	assert.deepEqual(leaf.view.getState(), { file: file.path, epubChapter: 1 });
	assert.match(leaf.contentEl.querySelector('article').textContent, /Second chapter/);
	await leaf.view.setState({ file: file.path, epubChapter: 0 }, {});
	assert.match(leaf.contentEl.querySelector('article').textContent, /First chapter/);
	snapshot = makeBook({ [two]: page('<h1>Chapter after sync</h1>') });
	leaf.view.next.click();
	handlers.modify(file);
	await new Promise(resolve => setImmediate(resolve));
	assert.match(leaf.contentEl.querySelector('article').textContent, /Chapter after sync/);
	assert.equal(leaf.view.getState().epubChapter, 1);
	assert.equal(file.stat.mtime, 12345);
	await leaf.view.onClose();
	assert.equal(leaf.contentEl.childElementCount, 0);
});

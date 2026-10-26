import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
globalThis.window = globalThis;
registerHooks({ resolve(specifier, context, next) {
	return specifier === 'obsidian' ? { url: new URL('./obsidian-double.mjs', import.meta.url).href, shortCircuit: true } : next(specifier, context);
} });
const { RecentFiles, NoteSearchView, registerNoteSearch } = await import('../src/search.js');
const { Platform } = await import('./obsidian-double.mjs');

function fixture() {
	const files = new Map(Array.from({ length: 25 }, (_, index) => {
		const path = `目录/文件${index}.md`;
		return [path, { path, stat: { mtime: index }, name: `文件${index}.md` }];
	}));
	const storage = new Map();
	const app = { vault: { getFileByPath: path => files.get(path) }, workspace: { getLastOpenFiles: () => [...files.keys()].slice(0, 3) },
		loadLocalStorage: key => storage.get(key), saveLocalStorage: (key, value) => storage.set(key, structuredClone(value)) };
	return { files, storage, app };
}

test('recent files cap at 20, reopen to front, restore locally and preserve file metadata', () => {
	const { files, app } = fixture();
	const before = structuredClone([...files.values()]);
	const recent = new RecentFiles(app, 'test');
	assert.equal(recent.files().length, 3);
	for (const file of files.values()) recent.opened(file);
	assert.equal(recent.files().length, 20);
	assert.equal(recent.paths[0], '目录/文件24.md');
	recent.opened(files.get('目录/文件10.md'));
	recent.opened(null);
	assert.equal(recent.paths[0], '目录/文件10.md');
	assert.equal(new Set(recent.paths).size, 20);
	assert.deepEqual(new RecentFiles(app, 'test').paths, recent.paths);
	assert.deepEqual([...files.values()], before);
});

test('folder/file renames and deletions update history with directory boundaries', () => {
	const { files, app } = fixture();
	const recent = new RecentFiles(app, 'test');
	const oldPath = recent.paths[0];
	const file = files.get(oldPath);
	files.delete(oldPath); file.path = '目录/改名.md'; files.set(file.path, file);
	recent.renamed(file, oldPath);
	assert.equal(recent.paths[0], file.path);
	recent.renamed({ path: '新目录' }, '目录');
	assert.ok(recent.paths.every(path => path.startsWith('新目录/')));
	recent.deleted({ path: '新' });
	assert.equal(recent.paths.length, 3);
	recent.deleted({ path: '新目录' });
	assert.deepEqual(recent.paths, []);
});

test('ignore malformed, duplicated and missing history entries; empty saved history stays empty', () => {
	const { storage, app } = fixture();
	storage.set('test', ['目录/文件0.md', null, 'missing.md', '目录/文件0.md']);
	assert.deepEqual(new RecentFiles(app, 'test').paths, ['目录/文件0.md']);
	storage.set('test', []);
	assert.deepEqual(new RecentFiles(app, 'test').paths, []);
});

test('recent file click uses central workspace leaf and opens attachments too', async () => {
	const file = { path: '附件/图.png' };
	let opened;
	const view = { owner: { app: { vault: { getFileByPath: path => path === file.path ? file : null },
		workspace: { getLeaf: split => { assert.equal(split, false); return { view: {}, openFile: async target => { opened = target; } }; } } } } };
	await NoteSearchView.prototype.openResult.call(view, { path: file.path });
	assert.equal(opened, file);
});

test('recent and search open as separate left sidebar tabs', async () => {
	const { app } = fixture();
	let opened;
	app.workspace.getLeaf = () => ({ view: {}, openFile: async file => { opened = file.path; } });
	const factories = new Map(), leaves = new Map(), ribbons = [];
	app.workspace.on = app.vault.on = () => ({});
	const owner = { app, manifest: { id: 'test' }, registerEvent() {}, addCommand() {},
		registerView: (type, factory) => factories.set(type, factory),
		addRibbonIcon: (icon, title, callback) => ribbons.push({ icon, title, callback }) };
	registerNoteSearch(owner);
	const dom = new JSDOM('<div></div>');
	const decorate = element => {
		element.empty = () => element.replaceChildren();
		element.addClass = value => element.classList.add(value);
		element.setText = value => { element.textContent = value; };
		element.createEl = (tag, options = {}) => {
			const child = decorate(dom.window.document.createElement(tag));
			if (options.text) child.textContent = options.text;
			if (options.cls) child.className = options.cls;
			for (const [key, value] of Object.entries(options.attr ?? {})) child.setAttribute(key, value);
			for (const key of ['type', 'placeholder', 'value']) if (options[key]) child[key] = options[key];
			element.append(child); return child;
		};
		element.createDiv = options => element.createEl('div', options);
		return element;
	};
	app.workspace.getLeavesOfType = type => leaves.has(type) ? [leaves.get(type)] : [];
	app.workspace.getLeftLeaf = () => ({ async setViewState({ type }) {
		if (this.view?.getViewType() === type) return;
		this.view = factories.get(type)(this);
		this.view.contentEl = decorate(dom.window.document.createElement('div'));
		leaves.set(type, this); await this.view.onOpen();
	} });
	app.workspace.revealLeaf = async leaf => { app.workspace.revealed = leaf; };
	assert.equal(ribbons.length, 0);
	await owner.openRecentFiles();
	const view = leaves.get('test-recent-files').view;
	assert.equal(view.getDisplayText(), '最近');
	assert.equal(view.getIcon(), 'history');
	assert.equal(view.contentEl.querySelector('input'), null);
	view.recentArea.querySelector('button').click();
	await Promise.resolve();
	assert.equal(opened, '目录/文件0.md');
	await owner.openNoteSearch();
	const search = leaves.get('test-note-search').view;
	assert.equal(search.getIcon(), 'file-search-2');
	assert.ok(search.input);
	assert.equal(search.contentEl.querySelector('.wujie-note-tabs'), null);
	search.query = search.input.value = '保留关键词';
	await owner.openRecentFiles(); await owner.openNoteSearch();
	assert.equal(leaves.get('test-note-search').view, search);
	assert.equal(search.input.value, '保留关键词');
	view.invalidate();
	view.schedule(0);
	assert.equal(view.timer, undefined, 'encryption search invalidation does not schedule search in recent view');
	await search.onClose();
	await view.onClose();
	dom.window.close();
});

test('feature switches remove entrances and views, stop recent recording and reenable without duplicates', async () => {
	const { app, files } = fixture();
	const events = new Map(), commands = new Map(), icons = [], closed = [];
	app.workspace.on = (name, callback) => { events.set(name, callback); return {}; };
	app.vault.on = () => ({});
	app.workspace.getLeavesOfType = type => [{ detach() { closed.push(type); } }];
	app.workspace.getLeftLeaf = () => { throw Error('disabled feature tried to open'); };
	const owner = { app, manifest: { id: 'test' }, data: { settings: {} }, registerEvent() {}, registerView() {},
		addCommand: command => commands.set(command.id, command), removeCommand: id => commands.delete(id),
		addRibbonIcon: icon => { const item = { icon, removed: false, remove() { this.removed = true; } }; icons.push(item); return item; } };
	registerNoteSearch(owner);
	assert.equal(icons.length, 0);
	assert.deepEqual([...commands.keys()], ['recent-files', 'search-notes']);
	const before = [...owner.recentFiles.paths];
	owner.data.settings.recentEnabled = false;
	await owner.refreshNoteTools();
	events.get('file-open')(files.get('目录/文件10.md'));
	assert.deepEqual(owner.recentFiles.paths, before);
	assert.deepEqual(closed, ['test-recent-files']);
	assert.equal(commands.has('recent-files'), false);
	assert.equal(icons.length, 0);
	await owner.openRecentFiles();
	owner.data.settings.noteSearchEnabled = false;
	await owner.refreshNoteTools();
	assert.equal(commands.has('search-notes'), false);
	await owner.openNoteSearch();
	owner.data.settings.recentEnabled = owner.data.settings.noteSearchEnabled = true;
	await owner.refreshNoteTools(); await owner.refreshNoteTools();
	assert.equal(icons.length, 0);
	assert.equal(commands.size, 2);
	events.get('file-open')(files.get('目录/文件10.md'));
	assert.equal(owner.recentFiles.paths[0], '目录/文件10.md');
});

test('mobile recent selection opens the note then collapses the drawer', async () => {
	const file = { path: '手机笔记.md' }; let opened = false, collapsed = false;
	const view = { owner: { app: { vault: { getFileByPath: () => file }, workspace: {
		getLeaf: () => ({ view: {}, openFile: async () => { opened = true; } }),
		leftSplit: { collapse() { assert.equal(opened, true); collapsed = true; } },
	} } } };
	Platform.isMobile = true;
	try { await NoteSearchView.prototype.openResult.call(view, file); assert.equal(collapsed, true); }
	finally { Platform.isMobile = false; }
});


test('layout ready adds enabled left tabs once without activating, revealing or overwriting restored views', async () => {
 const {app}=fixture(), leaves=new Map(), created=[], commands=new Map(); let ready, dispose;
 const restored={marker:'restored'}; leaves.set('test-note-search',[restored]);
 app.workspace.on=app.vault.on=()=>({});
 app.workspace.onLayoutReady=callback=>{ready=callback;};
 app.workspace.getLeavesOfType=type=>leaves.get(type)??[];
 app.workspace.revealLeaf=()=>{throw Error('startup must not reveal a sidebar');};
 app.workspace.getLeftLeaf=split=>{
  assert.equal(split,false);
  const leaf={async setViewState(state){created.push(state);leaves.set(state.type,[leaf]);},detach(){for(const [type,list] of leaves) if(list.includes(leaf)) leaves.delete(type);}};
  return leaf;
 };
 const owner={app,manifest:{id:'test'},data:{settings:{}},registerEvent(){},registerView(){},register:callback=>{dispose=callback;},
 addCommand:command=>commands.set(command.id,command),removeCommand:id=>commands.delete(id),addRibbonIcon(){throw Error('no left ribbon tools');}};
 registerNoteSearch(owner); assert.equal(created.length,0);
 ready(); await owner.refreshNoteTools(); await owner.refreshNoteTools();
 assert.deepEqual(created,[{type:'test-recent-files',active:false}]);
 assert.equal(leaves.get('test-note-search')[0],restored);
 owner.data.settings.recentEnabled=false; await owner.refreshNoteTools(); assert.equal(leaves.has('test-recent-files'),false);
 owner.data.settings.recentEnabled=true; await owner.refreshNoteTools(); assert.equal(created.length,2);
 dispose(); leaves.delete('test-recent-files'); ready(); await owner.refreshNoteTools(); assert.equal(created.length,2);
});

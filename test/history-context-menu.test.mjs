import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerHooks } from 'node:module';
import { syntheticApp, TFile, TFolder, Menu, modals } from './obsidian-double.mjs';
import { t } from '../src/i18n.js';

const sdk = 'data:text/javascript,' + encodeURIComponent(`
 export * from ${JSON.stringify(new URL('./obsidian-double.mjs', import.meta.url).href)};
 export class EditableFileView {}
 export class FuzzySuggestModal {}
`);
registerHooks({ resolve(specifier, context, next) {
 return specifier === 'obsidian'
  ? { url: sdk, shortCircuit: true }
  : next(specifier, context);
} });
globalThis.window = { setInterval, clearInterval, setTimeout, clearTimeout };
const { default: Plugin } = await import('../src/plugin.js');

test('history follows Pin/Unpin and targets the clicked note rather than the active note', async context => {
 const app = syntheticApp(), events = {};
 app.workspace.on = (name, callback) => { (events[name] ??= []).push(callback); return {}; };
 app.workspace.getActiveFile = () => new TFile('other.md');
 const plugin = new Plugin(app, { id: 'wujie-sync', version: 'synthetic' });
 await plugin.onload(); context.after(() => plugin.dispose());
 const calls = [];
 plugin.history = async (...args) => calls.push(args);
 for (const pinned of [false, true]) {
  plugin.isNotePinned = () => pinned;
  const menu = new Menu(), clicked = new TFile('folder/selected.MD');
  for (const callback of events['file-menu']) callback(menu, clicked);
  assert.deepEqual(menu.items.slice(0, 3).map(item => item.title), [t(pinned ? 'pin.unpin' : 'pin.pin'), t('pin.bottom'), t('history.contextMenu')]);
  app.workspace.getActiveFile = () => new TFile('changed.md');
  menu.items[2].callback();
  assert.deepEqual(calls.at(-1), [undefined, clicked.path]);
 }
 for (const entry of [new TFolder('folder'), new TFile('image.png')]) {
  const menu = new Menu();
  for (const callback of events['file-menu']) callback(menu, entry);
  assert.equal(menu.items[0].title, t('pin.unpin'));
  assert.equal(menu.items.some(item => item.title === t('history.contextMenu')), false);
 }
 const multiple = new Menu(); plugin.isNotePinned = () => false;
 for (const callback of events['files-menu']) callback(multiple, [new TFile('a.md'), new TFile('b.md')]);
 assert.equal(multiple.items[0].title, t('pin.pin'));
 assert.equal(multiple.items.some(item => item.title === t('history.contextMenu')), false);
 assert.equal(calls.length, 2);
});

test('Navigator menus use their clicked file or selection and detach when either plugin reloads', async context => {
 const app = syntheticApp(), events = {}, layoutReady = [];
 app.workspace.on = (name, callback) => { (events[name] ??= []).push(callback); return {}; };
 app.workspace.onLayoutReady = callback => layoutReady.push(callback);
 app.workspace.getActiveFile = () => new TFile('active.md');
 app.plugins = { plugins: { 'notebook-navigator': { api: {} } } };
 const word = new TFile('folder/report.DOCX'), book = new TFile('folder/book.EPUB'), folder = new TFolder('folder');
 const entries = new Map([word, book, folder].map(file => [file.path, file]));
 app.vault.getAbstractFileByPath = path => entries.get(path) ?? null;
 const opened = [];
 const leaf = {
  view: { requestProtection() { opened.push(['encrypt', leaf.state.state.file]); } },
  async setViewState(state) { this.state = state; opened.push([state.type, state.state.file]); }
 };
 app.workspace.getLeaf = () => leaf;
 app.workspace.getLeavesOfType = () => [];
 app.workspace.revealLeaf = () => {};
 const plugin = new Plugin(app, { id: 'wujie-sync', version: 'synthetic' });
 plugin.register = () => {};
 await plugin.onload();
 context.after(() => { if (!plugin.stopped) plugin.dispose(); });

 const menus = () => {
  const file = new Set(), folder = new Set();
  return { file, folder, registerFileMenu(callback) {
   file.add(callback); return () => file.delete(callback);
  }, registerFolderMenu(callback) {
   folder.add(callback); return () => folder.delete(callback);
  } };
 };
 const first = menus();
 app.plugins.plugins['notebook-navigator'].api.menus = first;
 for (const callback of layoutReady) callback();
 for (const callback of events['layout-change']) callback();
 assert.equal(first.file.size, 1);
 assert.equal(first.folder.size, 1);

 const clicked = new TFile('folder/clicked.MD'), other = new TFile('other.md');
 const calls = [];
 plugin.history = async (_event, path) => calls.push(['history', path]);
 plugin.noteEncryption.encryptNote = async file => calls.push(['encrypt', file]);
 plugin.setNoteBottoms = async (files, bottomed) => calls.push(['bottom', files, bottomed]);
 const render = (callbacks, target) => {
  const menu = new Menu();
  for (const callback of callbacks) callback({ ...target, addItem: menu.addItem.bind(menu) });
  return menu.items;
 };
 const explorer = key => t('pin.explorerAction', { action: t(key) });
 const items = render(first.file, { file: clicked, selection: { mode: 'single', files: [clicked] } });
 assert.deepEqual(items.map(item => item.title), [explorer('pin.pin'), explorer('pin.bottom'), t('history.contextMenu'), t('encryption.encryptNote')]);
 items[2].callback();
 items[3].callback();
 const multiple = render(first.file, { file: clicked, selection: { mode: 'multiple', files: [clicked, other] } });
 assert.deepEqual(multiple.map(item => item.title), [explorer('pin.pin'), explorer('pin.bottom')]);
 multiple[1].callback();
 assert.deepEqual(calls, [['history', clicked.path], ['encrypt', clicked], ['bottom', [clicked, other], true]]);
 assert.deepEqual(render(first.file, { file: new TFile('image.png') }).map(item => item.title), [explorer('pin.pin'), explorer('pin.bottom')]);

 const wordItems = render(first.file, { file: word });
 const bookItems = render(first.file, { file: book });
 const folderItems = render(first.folder, { folder });
 assert.deepEqual(wordItems.map(item => item.title), [explorer('pin.pin'), explorer('pin.bottom'), t('docx.open'), t('encryption.text11')]);
 assert.deepEqual(bookItems.map(item => item.title), [explorer('pin.pin'), explorer('pin.bottom'), t('epub.open')]);
 assert.deepEqual(folderItems.map(item => item.title), [explorer('pin.pin'), explorer('pin.bottom'), t('docx.new')]);
 assert.deepEqual(render(first.file, { file: word, selection: { mode: 'multiple', files: [word, book] } }).map(item => item.title),
  [explorer('pin.pin'), explorer('pin.bottom')]);
 await wordItems[2].callback();
 await wordItems[3].callback();
 await bookItems[2].callback();
 assert.deepEqual(opened, [['wujie-sync-docx', word.path], ['wujie-sync-docx', word.path], ['encrypt', word.path], ['wujie-sync-epub', book.path]]);
 folderItems[2].callback();
 assert.equal(modals.at(-1).folder, folder);
 for (const [entry, titles] of [[word, [t('docx.open'), t('encryption.text11')]], [book, [t('epub.open')]], [folder, [t('docx.new')]]]) {
  const native = new Menu();
  for (const callback of events['file-menu']) callback(native, entry);
  assert.deepEqual(native.items.slice(2).map(item => item.title), titles);
 }

 const replacement = menus();
 app.plugins.plugins['notebook-navigator'].api.menus = replacement;
 for (const callback of events['layout-change']) callback();
 assert.equal(first.file.size + first.folder.size, 0);
 assert.equal(replacement.file.size + replacement.folder.size, 2);
 plugin.dispose();
 for (const callback of events['layout-change']) callback();
 assert.equal(replacement.file.size + replacement.folder.size, 0);
});

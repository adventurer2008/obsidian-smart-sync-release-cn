import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerHooks } from 'node:module';
import { syntheticApp, TFile, TFolder, Menu } from './obsidian-double.mjs';
import { t } from '../src/i18n.js';

registerHooks({ resolve(specifier, context, next) {
 return specifier === 'obsidian'
  ? { url: new URL('./obsidian-double.mjs', import.meta.url).href, shortCircuit: true }
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
 const plugin = new Plugin(app, { id: 'wujie-sync', version: 'synthetic' });
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
 assert.deepEqual(render(first.folder, { folder: new TFolder('folder') }).map(item => item.title), [explorer('pin.pin'), explorer('pin.bottom')]);

 const replacement = menus();
 app.plugins.plugins['notebook-navigator'].api.menus = replacement;
 for (const callback of events['layout-change']) callback();
 assert.equal(first.file.size + first.folder.size, 0);
 assert.equal(replacement.file.size + replacement.folder.size, 2);
 plugin.dispose();
 for (const callback of events['layout-change']) callback();
 assert.equal(replacement.file.size + replacement.folder.size, 0);
});

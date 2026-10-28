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

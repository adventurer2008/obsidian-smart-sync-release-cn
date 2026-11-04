import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerHooks } from 'node:module';
import { freshSalt, unlockWorkspace, encryptNotePin, encryptNotePosition, decryptNotePosition } from '../src/codec.js';
import { notePinState, queueNotePosition, moveNotePins, pinPathSet, synchronizeNotePins } from '../src/pinning.js';
import { syntheticApp, TFile, TFolder, Menu } from './obsidian-double.mjs';
import { t as translate } from '../src/i18n.js';
registerHooks({ resolve(specifier, context, next) { return specifier === 'obsidian' ? { url: new URL('./obsidian-double.mjs', import.meta.url).href, shortCircuit: true } : next(specifier, context); } });
globalThis.window = { setInterval, clearInterval, setTimeout, clearTimeout };
const { default: Plugin, attachExplorerSorting } = await import('../src/plugin.js');

test('encrypted positions bind identity and workspace and upgrade an already-consumed legacy cursor', async () => {
 const keys = await unlockWorkspace('synthetic position passphrase', freshSalt()), note = 'a'.repeat(64), workspace = 'synthetic';
 const value = await encryptNotePin(keys, workspace, note, false), position = await encryptNotePosition(keys, workspace, note, 'bottom');
 assert.equal(await decryptNotePosition(keys, workspace, note, position), 'bottom');
 await assert.rejects(decryptNotePosition(keys, 'other', note, position));
 await assert.rejects(decryptNotePosition(keys, workspace, 'b'.repeat(64), position));
 const state = notePinState(); state.cursor = 9; state.entries[note] = { pinned: false, sequence: 9, path: 'folder/note.md' };
 const notes = { [note]: { path: 'folder/note.md' } }; let after;
 const api = { workspace, positions: async cursor => { after = cursor; return { entries: [{ note, sequence: 9, value, position }], more: false }; } };
 await synchronizeNotePins({ api, keys, state, notes, positions: true, direction: 'receive', save: async () => {} });
 assert.equal(after, 0); assert.deepEqual([...pinPathSet(state, notes, 'bottomed')], ['folder/note.md']);
 moveNotePins(state, 'folder', 'renamed'); notes[note].path = 'renamed/note.md';
 assert.deepEqual([...pinPathSet(state, notes, 'bottomed')], ['renamed/note.md']);
 queueNotePosition(state, notes, 'renamed/note.md', 'top');
 assert.equal(pinPathSet(state, notes, 'bottomed').size, 0); assert.equal(pinPathSet(state, notes).size, 1);
 await assert.rejects(synchronizeNotePins({ api, keys, state, notes, save: async () => {} }), error => error.code === 'PIN_SERVICE_UPGRADE');
 assert.equal(Object.keys(state.pending).length, 1);
});

test('batch top/bottom are mutually exclusive, save failures restore state, and native/custom sorts place folders last', async t => {
 const app = syntheticApp(), plugin = new Plugin(app, { id: 'wujie-sync', version: 'synthetic' });
 const events = {};
 app.workspace.on = (name, callback) => { (events[name] ??= []).push(callback); return {}; };
 await plugin.onload(); t.after(() => plugin.dispose());
 const top = new TFile('top.md'), normal = new TFile('normal.md'), bottom = new TFolder('bottom');
 await plugin.setNotePins([top], true); await plugin.setNoteBottoms([bottom], true);
 assert.equal(plugin.isNoteBottomed(bottom.path), true);
 const menu = new Menu(); for (const callback of events['file-menu']) callback(menu, bottom);
 assert.deepEqual(menu.items.slice(0, 2).map(item => item.title), [translate('pin.pin'), translate('pin.unbottom')]);
 const multiple = new Menu(); for (const callback of events['files-menu']) callback(multiple, [top, normal, bottom]);
 assert.ok(multiple.items.some(item => item.title === translate('pin.bottom')));
 assert.ok(multiple.items.some(item => item.title === translate('pin.unbottom')));
 await plugin.setNotePins([bottom], true); assert.equal(plugin.isNoteBottomed(bottom.path), false);
 await plugin.setNoteBottoms([bottom], true); assert.equal(plugin.isNotePinned(bottom.path), false);
 const save = plugin.saveData; plugin.saveData = async () => { throw Error('disk full'); };
 await assert.rejects(plugin.setNoteBottoms([top], true));
 assert.equal(plugin.isNotePinned(top.path), true); assert.equal(plugin.isNoteBottomed(top.path), false); plugin.saveData = save;
 const items = [bottom, normal, top].map(file => ({ file })); let enabled = false;
 const view = { getSortedFolderItems: () => items, requestSort() {} };
 const detach = attachExplorerSorting(view, () => ({ enabled, grouping: 'folders-first', primary: 'name-desc' }), undefined, file => plugin.isNotePinned(file.path), file => plugin.isNoteBottomed(file.path));
 for (const custom of [false, true]) { enabled = custom; assert.deepEqual(view.getSortedFolderItems().map(x => x.file.path), ['top.md', 'normal.md', 'bottom']); }
 await plugin.setNotePins([top, bottom], false); assert.equal(plugin.isNoteBottomed(bottom.path), true, 'unpin leaves already-bottomed items alone');
 await plugin.setNoteBottoms([bottom], false); assert.equal(plugin.isNoteBottomed(bottom.path), false);
 detach(); assert.equal(view.getSortedFolderItems(), items);
});

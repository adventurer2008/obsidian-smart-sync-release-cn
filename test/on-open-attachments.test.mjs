import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerHooks } from 'node:module';
import { syntheticApp, TFile, Platform } from './obsidian-double.mjs';
import { pendingAttachment } from '../src/synchronizer.js';
registerHooks({ resolve(specifier, context, next) { return specifier === 'obsidian' ? { url: new URL('./obsidian-double.mjs', import.meta.url).href, shortCircuit: true } : next(specifier, context); } });
globalThis.window = { setInterval, clearInterval, setTimeout, clearTimeout };
const { default: Plugin } = await import('../src/plugin.js');

test('deferred shortest links resolve cloud subfolders without guessing duplicate names', () => {
 const notes = { image: { path: 'attachments/Pasted image 20260101010101.png', downloaded: false } };
 assert.equal(pendingAttachment(notes, 'Pasted image 20260101010101.png', 'races/synthetic-trip.md')?.[0], 'image');
 assert.equal(pendingAttachment(notes, 'Pasted%20image%2020260101010101.png|300', 'races/synthetic-trip.md')?.[0], 'image');
 notes.other = { path: 'other/Pasted image 20260101010101.png', downloaded: true };
 assert.equal(pendingAttachment(notes, 'Pasted image 20260101010101.png', 'races/synthetic-trip.md'), undefined);
 assert.equal(pendingAttachment(notes, '../attachments/Pasted image 20260101010101.png', 'races/synthetic-trip.md')?.[0], 'image');
 assert.equal(pendingAttachment(notes, 'https://example.com/image.png'), undefined);
 assert.equal(pendingAttachment(notes, '../../Pasted image 20260101010101.png', 'races/synthetic-trip.md'), undefined);
});

test('relative attachment takes precedence over a same-named root attachment', () => {
 const notes = { root: { path: 'photo.png' }, local: { path: 'races/photo.png' } };
 assert.equal(pendingAttachment(notes, 'photo.png', 'races/note.md')?.[0], 'local');
 notes.local.downloaded = true;
 assert.equal(pendingAttachment(notes, 'photo.png', 'races/note.md'), undefined);
});

test('mobile file-open and restored layout download missing embedded images from cloud inventory', async t => {
 Platform.isMobile = true; t.after(() => { Platform.isMobile = false; });
 const app = syntheticApp(), ready = [], events = {};
 const file = new TFile('races/synthetic-trip.md');
 app.files.set(file.path, new TextEncoder().encode('![[Pasted image 20260101010101.png]]\n![[Pasted image 20260102020202.png]]'));
 app.vault.getFileByPath = path => app.vault.getAbstractFileByPath(path);
 app.workspace.getActiveFile = () => file;
 app.workspace.on = (name, callback) => { (events[name] ??= []).push(callback); return {}; };
 app.workspace.onLayoutReady = callback => ready.push(callback);
 app.metadataCache = { getFileCache: () => null, getFirstLinkpathDest: () => null };
 const plugin = new Plugin(app, { id: 'wujie-sync', version: 'synthetic' });
 await plugin.onload(); t.after(() => plugin.dispose());
 Object.assign(plugin.data.settings, { workspace: 'synthetic', attachmentMiB: 0, autoTimer: false });
 const state = { notes: { first: { path: 'attachments/Pasted image 20260101010101.png' }, second: { path: 'attachments/Pasted image 20260102020202.png' } } };
 const downloaded = [];
 plugin.connection = async () => ({ api: {}, engine: { state, direction: 'both', download: async id => { downloaded.push(id); state.notes[id].downloaded = true; } } });
 plugin.ensureCurrent = () => {};
 for (const callback of events['file-open']) callback(file);
 await plugin.running;
 assert.deepEqual(downloaded, ['first', 'second']);
 downloaded.length = 0; for (const note of Object.values(state.notes)) note.downloaded = false;
 for (const callback of ready) callback();
 await plugin.running;
 assert.deepEqual(downloaded, ['first', 'second']);
 downloaded.length = 0;
 await plugin.downloadNoteAttachments(file);
 assert.deepEqual(downloaded, []);
});

test('newest note supersedes queued opens and skips remaining attachments of the old note', async t => {
 const app = syntheticApp(), plugin = new Plugin(app, { id: 'wujie-sync', version: 'synthetic' });
 await plugin.onload(); t.after(() => plugin.dispose());
 Object.assign(plugin.data.settings, { workspace: 'synthetic', attachmentMiB: 0, autoTimer: false });
 const files = ['old.md', 'middle.md', 'current.md'].map(path => new TFile(path));
 files.forEach((file, index) => app.files.set(file.path, new TextEncoder().encode(index ? `![[${index}.pdf]]` : '![[0.pdf]] ![[skip.pdf]]')));
 app.metadataCache = { getFileCache: () => null, getFirstLinkpathDest: () => null };
 let release, started;
 const gate = new Promise(done => { release = done; }), ready = new Promise(done => { started = done; });
 t.after(() => release());
 const state = { notes: Object.fromEntries(['0', '1', '2', 'skip'].map(id => [id, { path: `${id}.pdf` }])) }, downloads = [];
 plugin.connection = async () => ({ api: {}, engine: { state, direction: 'both', download: async id => {
  downloads.push(id); if (id === '0') { started(); await gate; } state.notes[id].downloaded = true;
 } } });
 plugin.ensureCurrent = () => {};
 const old = plugin.downloadNoteAttachments(files[0]); await ready;
 const middle = plugin.downloadNoteAttachments(files[1]), current = plugin.downloadNoteAttachments(files[2]);
 release(); await Promise.all([old, middle, current]);
 assert.deepEqual(downloads, ['0', '2']);
 assert.equal(state.notes.skip.downloaded, undefined);
});

test('queued note download does not cross a settings object replacement into another notebook', async t => {
 const app = syntheticApp(), plugin = new Plugin(app, { id: 'wujie-sync', version: 'synthetic' });
 await plugin.onload(); t.after(() => plugin.dispose());
 Object.assign(plugin.data.settings, { workspace: 'synthetic', attachmentMiB: 0, autoTimer: false });
 let release;
 const gate = new Promise(done => { release = done; }); t.after(() => release());
 const busy = plugin.exclusive(() => gate);
 plugin.connection = async () => assert.fail('stale note opened in the new notebook');
 const waiting = plugin.downloadNoteAttachments(new TFile('old.md'));
 plugin.data.settings = { ...plugin.data.settings, workspace: 'different' };
 release(); await Promise.all([busy, waiting]);
});

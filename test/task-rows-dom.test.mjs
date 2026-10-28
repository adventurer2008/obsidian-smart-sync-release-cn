import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { TaskJournal } from '../src/tasks.js';
registerHooks({ resolve(specifier, context, next) { return specifier === 'obsidian' ? { url: new URL('./settings-dom-sdk.mjs', import.meta.url).href, shortCircuit: true } : next(specifier, context); } });
globalThis.window = globalThis;
const { default: Plugin } = await import('../src/plugin.js');
const scope = 'a'.repeat(64), note = 'b'.repeat(64);
function fixture(t) {
	const dom = new JSDOM('<main></main>'), proto = dom.window.HTMLElement.prototype;
	proto.empty = function () { this.replaceChildren(); };
	proto.setText = function (text) { this.textContent = text; };
	proto.createEl = function (tag, options = {}) { const node = dom.window.document.createElement(tag); node.textContent = options.text ?? ''; node.className = options.cls ?? ''; this.append(node); return node; };
	proto.createDiv = function (options) { return this.createEl('div', options); };
	const plugin = new Plugin({}, { version: '1.1.0' });
	Object.assign(plugin, { journal: new TaskJournal(), taskScope: scope, taskSyncState: () => 'synthetic syncing', data: { taskOutbox: [] }, refreshTasks() {} });
	const area = dom.window.document.querySelector('main');
	t.after(() => dom.window.close());
	return { plugin, area, render: () => plugin.renderTaskRows(area), view: () => plugin.taskRowViews.get(area) };
}

test('unchanged task rows retain their DOM, details expansion and pagination across progress refreshes', t => {
	const f = fixture(t), a = f.plugin.journal.start(scope, { note, direction: 'receive' });
	const b = f.plugin.journal.start(scope, { note: 'c'.repeat(64), direction: 'receive' });
	f.render(); const view = f.view(), aNode = view.rows.get(a).node.firstChild, bNode = view.rows.get(b).node.firstChild;
	const details = f.area.querySelector('details'); details.open = true;
	f.render(); assert.equal(view.rows.get(a).node.firstChild, aNode); assert.equal(view.rows.get(b).node.firstChild, bNode);
	f.plugin.journal.update(a, { status: 'progress', bytes: 1024 }); f.render();
	assert.notEqual(view.rows.get(a).node.firstChild, aNode); assert.equal(view.rows.get(b).node.firstChild, bNode);
	assert.equal(f.area.querySelector('details'), details); assert.equal(details.open, true);
	assert.equal(view.list.children.length, 2);
});

test('failure, retry resolution, retention and scope/page changes cannot leave stale rows or actions', async t => {
	const f = fixture(t), id = f.plugin.journal.start(scope, { note, direction: 'receive' });
	f.render(); f.plugin.journal.update(id, { status: 'failed', error: new Error('synthetic fault') }); f.render();
	const failed = f.view().rows.get(id).node; assert.ok(failed.querySelector('.setting-item'));
	const retry = f.plugin.journal.start(scope, { note, direction: 'receive' }); f.plugin.journal.update(retry, { status: 'done' }); f.render();
	assert.equal(f.view().rows.get(id).node.querySelector('.setting-item'), null);
	for (let i = 0; i < 55; i++) f.plugin.journal.start(scope, { note, direction: 'receive' });
	f.render(); assert.equal(f.view().rows.size, 50);
	f.plugin.taskPage = 1; f.render(); assert.equal(f.view().rows.size, 7);
	f.plugin.taskScope = 'd'.repeat(64); f.render(); assert.equal(f.view().rows.size, 0); assert.equal(f.plugin.taskPage, 0);
	assert.equal(f.view().list.children.length, 0);
	f.plugin.taskSaveFailed = true; f.render(); assert.equal(f.view().error.hidden, false);
});

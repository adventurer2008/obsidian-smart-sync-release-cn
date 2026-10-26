import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
registerHooks({ resolve(specifier, context, next) { return specifier === 'obsidian' ? { url: new URL('./settings-dom-sdk.mjs', import.meta.url).href, shortCircuit: true } : next(specifier, context); } });
globalThis.window = globalThis;
const { IndependentSettings } = await import('../src/plugin.js');
const { PluginSettingTab } = await import('./obsidian-double.mjs');
const { cleanConfiguration } = await import('../src/configuration.js');

function fixture(t) {
	const dom = new JSDOM('<main></main>');
	const proto = dom.window.HTMLElement.prototype;
	proto.empty = function () { this.replaceChildren(); };
	proto.setText = function (text) { this.textContent = text; };
	proto.createEl = function (tag, options = {}) {
		const child = dom.window.document.createElement(tag);
		child.className = options.cls ?? ''; child.textContent = options.text ?? '';
		for (const [name, value] of Object.entries(options.attr ?? {})) child.setAttribute(name, value);
		this.append(child); return child;
	};
	proto.createDiv = function (options) { return this.createEl('div', options); };
	proto.createSpan = function (options) { return this.createEl('span', options); };
	const timers = new Map(); let sequence = 0;
	t.mock.method(window, 'setInterval', callback => { timers.set(++sequence, callback); return sequence; });
	t.mock.method(window, 'clearInterval', id => timers.delete(id));
	const plugin = { data: { localId: 'synthetic', settings: { origin: 'https://example.invalid', workspace: '', direction: 'both', interval: 60, excludedExtensions: [], configuration: cleanConfiguration({}) } },
		manifest: { version: '1.0.5' }, status: { text: 'Disconnected' }, secret: () => '', registerInterval() {},
		lanSummary: () => 'Offline', checkClientVersion: async () => undefined, statusListeners: new Set(),
		setting: async (key, value) => { plugin.data.settings[key] = value; } };
	const tab = new IndependentSettings({}, plugin); tab.containerEl = dom.window.document.querySelector('main');
	t.after(() => { tab.hide(); dom.window.close(); });
	return { tab, plugin, timers };
}

test('legacy host renders all shared definitions offline, refreshes and releases listeners/timers', async t => {
	const { tab, plugin, timers } = fixture(t);
	let finishVersion;
	plugin.checkClientVersion = () => new Promise(resolve => { finishVersion = resolve; });
	const definitions = tab.getSettingDefinitions();
	const count = definitions.reduce((sum, item) => sum + (item.items?.length ?? 1), 0);
	tab.display();
	assert.equal(tab.containerEl.querySelectorAll('.setting-item').length, count);
	assert.equal(tab.containerEl.querySelectorAll('details').length, definitions.filter(item => item.type === 'group').length);
	assert.ok(count > 50); assert.equal(timers.size, 2);
	const first = tab.containerEl.querySelector('details'); first.open = true;
	first.dispatchEvent(new first.ownerDocument.defaultView.Event('toggle'));
	const toggle = [...tab.containerEl.querySelectorAll('.setting-item')].flatMap(el => el.setting.controls).find(control => control.kind === 'toggle');
	await toggle.change(false); assert.equal(plugin.data.settings.autoChanges, false);
	tab.update(); assert.equal(timers.size, 2); assert.equal(tab.containerEl.querySelector('details').open, true);
	assert.equal(plugin.statusListeners.size, 2);
	tab.hide(); assert.equal(timers.size, 0); assert.equal(plugin.statusListeners.size, 0);
	finishVersion('9.0.0'); await Promise.resolve();
	tab.containerEl.empty(); tab.update(); assert.equal(tab.containerEl.children.length, 0);
});

test('modern host delegates updates to the host without using the legacy renderer', t => {
	const { tab } = fixture(t); let updates = 0;
	Object.defineProperty(PluginSettingTab.prototype, 'getSettingDefinitions', { configurable: true, value() { return []; } });
	t.after(() => { delete PluginSettingTab.prototype.getSettingDefinitions; });
	t.mock.method(PluginSettingTab.prototype, 'update', () => { updates++; });
	tab.display = () => assert.fail('modern update must not call legacy display');
	tab.update(); assert.equal(updates, 1);
});

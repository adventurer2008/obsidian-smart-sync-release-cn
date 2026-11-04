import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
registerHooks({ resolve(specifier, context, next) { return specifier === 'obsidian' ? { url: new URL('./settings-dom-sdk.mjs', import.meta.url).href, shortCircuit: true } : next(specifier, context); } });
globalThis.window = globalThis;
const { IndependentSettings } = await import('../src/plugin.js');
const { default: IndependentSync } = await import('../src/plugin.js');
const { PluginSettingTab } = await import('./obsidian-double.mjs');
const { Setting } = await import('./settings-dom-sdk.mjs');
const { Platform } = await import('./obsidian-double.mjs');
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
		lanSummary: (details = false) => details ? '局域网已收 1 KB' : 'Offline', checkClientVersion: async () => undefined, statusListeners: new Set(),
		setting: async (key, value) => { plugin.data.settings[key] = value; } };
	const tab = new IndependentSettings({}, plugin); tab.containerEl = dom.window.document.querySelector('main');
	t.after(() => { tab.hide(); dom.window.close(); });
	return { tab, plugin, timers };
}

test('integrated identity retains the full account value without a separate reveal action', t => {
	const { tab, plugin } = fixture(t);
	plugin.secret = key => key === 'account' ? 'synthetic-account-key' : '';
	plugin.accountEmail = 'a-very-long-synthetic-account@example.invalid';
	const flatten = items => items.flatMap(item => item.items ? flatten(item.items) : [item]);
	const definition = flatten(tab.getSettingDefinitions()).find(item => item.name === '当前账号');
	const setting = new Setting(tab.containerEl);
	const info = setting.settingEl.createDiv({ cls: 'setting-item-info' });
	const description = info.createDiv({ cls: 'setting-item-description' });
	setting.setDesc = text => { description.textContent = text; return setting; };
	const dispose = definition.render(setting);
	assert.equal(description.textContent, plugin.accountEmail);
	assert.equal(info.title, plugin.accountEmail);
	assert.equal(info.hasAttribute('role'), false);
	dispose();
});

test('integrated overview preserves all identity and synchronization routes and pairing guidance', async t => {
	const { tab, plugin } = fixture(t), calls = [];
	plugin.data.settings.workspace = 'synthetic';
	for (const method of ['signOut', 'manageNotebooks', 'devices', 'addDevice', 'requestSynchronization', 'stopSynchronization', 'logs'])
		plugin[method] = async () => { calls.push(method); };
	const definitions = tab.getSettingDefinitions();
	const overview = definitions.find(item => item.cls === 'smart-sync-overview-group');
	assert.deepEqual(overview.items.slice(0, 3).map(item => item.name), ['当前笔记库', '当前账号', '同步设备']);
	assert.ok(!overview.items.some(item => item.name === '同步方向'));
	assert.ok(definitions.find(item => item.name === '同步偏好').items.some(item => item.name === '同步方向'));
	const cleanups = [];
	for (const name of ['当前笔记库', '当前账号', '同步设备', '立即同步', '同步记录']) {
		const definition = overview.items.find(item => item.name === name), setting = new Setting(tab.containerEl);
		const cleanup = definition.render(setting, { listEl: tab.containerEl });
		if (cleanup) cleanups.push(cleanup);
		for (const control of setting.controls) if (control.kind === 'button') await control.click();
	}
	assert.match(tab.containerEl.querySelector('.smart-sync-pair-help').textContent, /新设备获取六位码.*添加设备.*批准/);
	assert.deepEqual(calls, ['manageNotebooks', 'signOut', 'devices', 'addDevice', 'requestSynchronization', 'stopSynchronization', 'logs']);
	for (const cleanup of cleanups) cleanup();
});

test('reusing the native device setting across refreshes keeps only one pairing instruction', t => {
	const { tab, plugin } = fixture(t);
	const setting = new Setting(tab.containerEl);
	for (const workspace of ['synthetic', '']) {
		plugin.data.settings.workspace = workspace;
		const overview = tab.getSettingDefinitions().find(item => item.cls === 'smart-sync-overview-group');
		const definition = overview.items.find(item => item.name === '同步设备');
		for (let refresh = 0; refresh < 4; refresh++) {
			definition.render(setting);
			assert.equal(setting.settingEl.querySelectorAll('.smart-sync-pair-help').length, 1);
		}
		const help = setting.settingEl.querySelector('.smart-sync-pair-help').textContent;
		assert.match(help, workspace ? /新设备获取六位码.*添加设备.*批准/ : /已经连接的设备批准/);
	}
});

test('reusing the native LAN row replaces old details and displays only the current connection state', t => {
	const { tab, plugin, timers } = fixture(t);
	plugin.data.settings.workspace = 'synthetic';
	let state = '暂无直连，使用云端';
	plugin.lanSummary = details => details ? `${state}；局域网已收 1 KB` : state;
	const setting = new Setting(tab.containerEl);
	let dispose;
	for (let refresh = 0; refresh < 4; refresh++) {
		dispose?.();
		const overview = tab.getSettingDefinitions().find(item => item.cls === 'smart-sync-overview-group');
		const definition = overview.items.find(item => item.name === '局域网连接状态');
		state = refresh ? '已直连 2 台设备' : '暂无直连，使用云端';
		dispose = definition.render(setting);
		const details = setting.settingEl.querySelectorAll('.smart-sync-lan-details');
		assert.equal(details.length, 1);
		assert.equal(details[0].querySelector('.smart-sync-lan-state').textContent, state);
		if (refresh) assert.equal(details[0].open, true);
		details[0].open = true;
		if (refresh) assert.doesNotMatch(setting.settingEl.textContent, /暂无直连/);
		assert.equal(timers.size, 1);
	}
	dispose(); assert.equal(timers.size, 0);
	assert.equal(setting.settingEl.querySelectorAll('.smart-sync-lan-details').length, 0);
});

test('legacy host renders all shared definitions offline, refreshes and releases listeners/timers', async t => {
	const { tab, plugin, timers } = fixture(t);
	let finishVersion;
	plugin.checkClientVersion = () => new Promise(resolve => { finishVersion = resolve; });
	const definitions = tab.getSettingDefinitions();
	const count = definitions.reduce((sum, item) => sum + (item.items?.length ?? 1), 0);
	tab.display();
	assert.equal(tab.containerEl.querySelectorAll('.setting-item').length, count);
	assert.equal(tab.containerEl.querySelectorAll('details.smart-sync-section').length, definitions.filter(item => item.type === 'group' && item.cls === 'smart-sync-setting-group').length);
	const connectionDetails = tab.containerEl.querySelector('details.smart-sync-lan-details');
	assert.equal(connectionDetails.open, false);
	assert.equal(connectionDetails.querySelector('.smart-sync-lan-title').textContent, '局域网连接状态');
	assert.equal(connectionDetails.querySelector('.smart-sync-lan-state').textContent, 'Offline');
	assert.equal(connectionDetails.querySelector('.smart-sync-lan-entry').textContent, '连接详情');
	assert.match(connectionDetails.textContent, /局域网已收 1 KB/);
	assert.doesNotMatch(connectionDetails.textContent, /回退|直连未取得内容/);
	connectionDetails.open = true;
	connectionDetails.dispatchEvent(new connectionDetails.ownerDocument.defaultView.Event('toggle'));
	assert.equal(tab.containerEl.querySelectorAll('.smart-sync-overview-card').length, 1);
	assert.match(tab.containerEl.querySelector('.smart-sync-pair-help').textContent, /批准/);
	assert.ok(count > 50); assert.equal(timers.size, 2);
	const first = tab.containerEl.querySelector('details.smart-sync-section'); first.open = true;
	first.dispatchEvent(new first.ownerDocument.defaultView.Event('toggle'));
	const toggle = [...tab.containerEl.querySelectorAll('.setting-item')].flatMap(el => el.setting.controls).find(control => control.kind === 'toggle');
	await toggle.change(false); assert.equal(plugin.data.settings.autoChanges, false);
	tab.update(); assert.equal(timers.size, 2); assert.equal(tab.containerEl.querySelector('details.smart-sync-section').open, true);
	assert.equal(tab.containerEl.querySelector('details.smart-sync-lan-details').open, true);
	assert.equal(plugin.statusListeners.size, 3); // Overview, LAN and the adjacent quick-stop state.
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

test('background tray follows search in Advanced, defaults on, persists changes and is absent on mobile', async t => {
	const { tab, plugin } = fixture(t);
	const advanced = tab.getSettingDefinitions().find(group => group.items?.some(item => item.name === '启用搜索'));
	const searchIndex = advanced.items.findIndex(item => item.name === '启用搜索');
	assert.equal(advanced.items[searchIndex + 1].name, '后台运行与托盘');
	tab.display();
	const row = [...tab.containerEl.querySelectorAll('.setting-item')].find(el => el.setting.name === '后台运行与托盘');
	const toggle = row.setting.controls.find(control => control.kind === 'toggle');
	assert.equal(toggle.value, true);
	await toggle.change(false); assert.equal(plugin.data.settings.backgroundTray, false);
	Platform.isMobile = true;
	try { assert.ok(!tab.getSettingDefinitions().some(group => group.items?.some(item => item.name === '后台运行与托盘'))); }
	finally { Platform.isMobile = false; }
});

test('tray changes persist before runtime changes; failed storage preserves the active state and synchronization stop', async () => {
	let refreshed = 0;
	const plugin = { data: { manualSyncStopped: true, settings: { backgroundTray: true } },
		saveData: async () => { throw Error('Storage full'); }, refreshBackgroundTray() { refreshed++; } };
	await assert.rejects(IndependentSync.prototype.setting.call(plugin, 'backgroundTray', false));
	assert.equal(plugin.data.settings.backgroundTray, true); assert.equal(refreshed, 0);
	plugin.saveData = async () => {};
	await IndependentSync.prototype.setting.call(plugin, 'backgroundTray', false);
	assert.equal(plugin.data.settings.backgroundTray, false); assert.equal(refreshed, 1);
	assert.equal(plugin.data.manualSyncStopped, true);
});

test('launch to tray is opt-in inside Advanced on Windows only, follows tray settings and preserves the toggle after failure', async t => {
	const { tab, plugin } = fixture(t), original = window.require;
	window.require = name => { assert.equal(name, 'node:process'); return { platform: 'win32' }; };
	try {
		const advanced = tab.getSettingDefinitions().find(group => group.items?.some(item => item.name === '开机后自动运行并最小化到托盘'));
		assert.ok(advanced); const index = advanced.items.findIndex(item => item.name === '开机后自动运行并最小化到托盘');
		assert.equal(advanced.items[index - 1].name, '后台运行与托盘');
		tab.display();
		const row = [...tab.containerEl.querySelectorAll('.setting-item')].find(el => el.setting.name === '开机后自动运行并最小化到托盘');
		const toggle = row.setting.controls.find(control => control.kind === 'toggle'); assert.equal(toggle.value, false);
		await toggle.change(true); assert.equal(plugin.data.settings.launchAtLogin, true);
		Platform.isMobile = true;
		assert.ok(!tab.getSettingDefinitions().some(group => group.items?.some(item => item.name === '开机后自动运行并最小化到托盘')));
		Platform.isMobile = false; window.require = () => ({ platform: 'darwin' });
		assert.ok(!tab.getSettingDefinitions().some(group => group.items?.some(item => item.name === '开机后自动运行并最小化到托盘')));
	} finally { window.require = original; Platform.isMobile = false; }
});

test('a copied startup flag with no native registration displays off instead of falsely activated', t => {
	const { tab, plugin } = fixture(t), original = window.require;
	window.require = () => ({ platform:'win32' });
	plugin.data.settings.launchAtLogin = true; plugin.startupStatus = false;
	try {
		tab.display();
		const row = [...tab.containerEl.querySelectorAll('.setting-item')].find(el=>el.setting.name==='开机后自动运行并最小化到托盘');
		assert.equal(row.setting.controls.find(control=>control.kind==='toggle').value,false);
		assert.equal(row.setting.desc,'这台电脑的开机启动尚未设置好，请关闭此选项后重新打开。');
	} finally { window.require=original; }
});

test('attachment selector restores the saved value and reports a rejected change', async t => {
	const { tab, plugin } = fixture(t);
	plugin.data.settings.attachmentMiB = 256;
	const messages = [];
	plugin.notify = message => messages.push(message);
	let rejectChange;
	plugin.setAttachmentDownload = () => new Promise((_, reject) => { rejectChange = reject; });
	tab.display();
	const control = [...tab.containerEl.querySelectorAll('.setting-item')]
		.flatMap(el => el.setting.controls).find(control => control.options?.['on-note-open']);
	control.value = 'on-note-open';
	const changing = control.change('on-note-open');
	assert.equal(control.disabled, true);
	rejectChange(Object.assign(Error('busy'), {code: 'SYNC_BUSY'}));
	await changing;
	assert.equal(control.value, 'always'); assert.equal(control.disabled, false);
	assert.equal(messages.length, 1);
	assert.equal(plugin.data.settings.attachmentMiB, 256);
});

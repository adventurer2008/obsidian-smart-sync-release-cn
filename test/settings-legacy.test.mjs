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
	const email = 'a-very-long-synthetic-account@example.invalid';
	plugin.overviewIdentity = { scope: 'https://example.invalid||synthetic',
		credential: 'synthetic-account-key', accountCredential: 'synthetic-account-key', email };
	const flatten = items => items.flatMap(item => item.items ? flatten(item.items) : [item]);
	const definition = flatten(tab.getSettingDefinitions()).find(item => item.name === '当前账号');
	const setting = new Setting(tab.containerEl);
	const info = setting.settingEl.createDiv({ cls: 'setting-item-info' });
	const description = info.createDiv({ cls: 'setting-item-description' });
	setting.setDesc = text => { description.textContent = text; return setting; };
	const dispose = definition.render(setting);
	assert.equal(description.textContent, email);
	assert.equal(info.title, email);
	assert.equal(info.hasAttribute('role'), false);
	dispose();
});

test('overview retains verified details through a vault reopen and rejects another credential or revoked session', async t => {
	const saved = new Map();
	const first = fixture(t);
	const email = 'fixture@example.invalid';
	const label = 'Fixture notebook';
	let credential = 'fixture-access-one', offline = false, revoked = false, requestedSignal;
	const configure = ({ plugin }) => {
		plugin.manifest.id = 'wujie-sync';
		plugin.data.settings.workspace = '11111111-1111-1111-1111-111111111111';
		plugin.app = { vault: { getFiles: () => [] }, secretStorage: { setSecret: (key, value) => saved.set(key, value) } };
		plugin.abortController = new AbortController();
		plugin.abortController.abort();
		plugin.secret = name => name === 'access' ? credential : saved.get('wujie-sync-synthetic-' + name) ?? '';
		plugin.workspaceApi = () => {
			const result = async value => {
				requestedSignal = api.signal;
				if (revoked) throw Object.assign(Error('Unauthorized'), { status: 401 });
				if (offline) throw Error('Offline');
				return value;
			};
			const api = {
				request: (_method, path) => result(path === 'account' ? { email } : { logicalBytes: 25 * 1024 ** 2 }),
				info: () => result({ label }), scope: path => path,
			};
			return api;
		};
	};
	const waitFor = async predicate => {
		for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 5));
		assert.ok(predicate());
	};
	const shown = ({ tab }, value) => [...tab.containerEl.querySelectorAll('.setting-item')]
		.some(row => row.setting.desc?.includes(value) || row.textContent.includes(value));
	configure(first);
	first.tab.display();
	await waitFor(() => shown(first, email) && shown(first, label) && shown(first, '25 MB'));
	assert.notEqual(requestedSignal, first.plugin.abortController.signal);
	assert.equal(requestedSignal.aborted, false);
	first.tab.hide();
	assert.equal(requestedSignal.aborted, true);

	offline = true;
	const reopened = fixture(t);
	configure(reopened);
	reopened.tab.display();
	await waitFor(() => shown(reopened, email) && shown(reopened, label) && shown(reopened, '25 MB'));
	credential = 'fixture-access-two';
	reopened.tab.hide();
	reopened.tab.display();
	await waitFor(() => shown(reopened, '邮箱暂未提供'));
	assert.equal(shown(reopened, email), false);
	assert.equal(shown(reopened, label), false);
	assert.equal(shown(reopened, '25 MB'), false);

	credential = 'fixture-access-one';
	offline = false;
	revoked = true;
	reopened.tab.hide();
	reopened.tab.display();
	await waitFor(() => !!reopened.plugin.overviewIdentity && !reopened.plugin.overviewIdentity.email &&
		!JSON.parse(saved.get('wujie-sync-synthetic-overview-display')).email);
	assert.equal(shown(reopened, email), false);
	assert.equal(shown(reopened, label), false);
	assert.equal(shown(reopened, '25 MB'), false);
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

test('signed-in accounts without a vault offer device management and never request pairing themselves', async t => {
	const { tab, plugin } = fixture(t), calls = [];
	plugin.accountAuthorized = true;
	plugin.devices = async () => calls.push('devices');
	plugin.addDevice = async () => calls.push('addDevice');
	plugin.pairThisDevice = () => assert.fail('A signed-in account is not an anonymous recipient');
	const definition = tab.getSettingDefinitions().find(item => item.cls === 'smart-sync-overview-group').items.find(item => item.name === '同步设备');
	const setting = new Setting(tab.containerEl);
	const cleanup = definition.render(setting);
	assert.match(setting.desc, /已登录账号.*管理笔记库.*六位码/);
	assert.deepEqual(setting.controls.map(control => control.text), ['设备管理', '添加设备']);
	for (const control of setting.controls) await control.click();
	assert.deepEqual(calls, ['devices', 'addDevice']);
	cleanup();
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

test('account danger controls survive repeated native renders once and clean up before row reuse', async t => {
	const { tab, plugin } = fixture(t);
	plugin.accountAuthorized = true;
	let deletions = 0;
	plugin.deleteAccount = () => { deletions++; };
	const definition = tab.getSettingDefinitions().find(group => group.name === '账号').items.find(item => item.name === '危险操作');
	const setting = new Setting(tab.containerEl);
	const oldDispose = definition.render(setting);
	const dispose = definition.render(setting); // Reproduce a host refresh that retains custom children.
	oldDispose(); // A late cleanup must not hide/remove the new controls.
	assert.equal(setting.settingEl.querySelectorAll('.smart-sync-account-danger').length, 1);
	assert.equal(setting.settingEl.classList.contains('smart-sync-danger-row'), true);
	assert.equal(deletions, 0);
	await setting.settingEl.querySelector('.smart-sync-account-danger .setting-item').setting.controls[0].click();
	assert.equal(deletions, 1);
	dispose();
	assert.equal(setting.settingEl.querySelectorAll('.smart-sync-account-danger').length, 0);
	assert.equal(setting.settingEl.classList.contains('smart-sync-danger-row'), false);
	plugin.accountAuthorized = false;
	assert.equal(tab.getSettingDefinitions().some(group => group.name === '账号'), false);
});

test('native group reuse replaces the account heading with current preferences and keeps one wrapper', t => {
	const { tab, plugin } = fixture(t);
	const wrapper = tab.containerEl.createDiv(), listEl = wrapper.createDiv();
	const setting = new Setting(listEl);
	let dispose;
	for (const connected of [true, false, true, false]) {
		dispose?.();
		plugin.accountAuthorized = connected;
		const group = tab.getSettingDefinitions().find(group => group.name === (connected ? '账号' : '同步偏好'));
		dispose = group.items[0].render(setting, { listEl });
		assert.equal(wrapper.querySelectorAll('details.smart-sync-section').length, 1);
		assert.equal(wrapper.querySelector('.smart-sync-section-title').textContent, group.name);
		assert.equal(wrapper.querySelector('.smart-sync-section-description').textContent, connected ? '账号设置' : '自动同步、提醒、附件下载与局域网加速');
	}
	dispose();
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

test('translation follows search in Advanced and defaults on for desktop and mobile', async t => {
	const { tab, plugin } = fixture(t);
	const advanced = tab.getSettingDefinitions().find(group => group.items?.some(item => item.name === '启用搜索'));
	const searchIndex = advanced.items.findIndex(item => item.name === '启用搜索');
	assert.deepEqual(advanced.items.slice(searchIndex + 1, searchIndex + 3).map(item => item.name),
		['启用翻译功能', '后台运行与托盘']);
	tab.display();
	const translation = [...tab.containerEl.querySelectorAll('.setting-item')].find(el => el.setting.name === '启用翻译功能');
	const translationToggle = translation.setting.controls.find(control => control.kind === 'toggle');
	assert.equal(translationToggle.value, true);
	await translationToggle.change(false);
	assert.equal(plugin.data.settings.translationEnabled, false);
	const row = [...tab.containerEl.querySelectorAll('.setting-item')].find(el => el.setting.name === '后台运行与托盘');
	const toggle = row.setting.controls.find(control => control.kind === 'toggle');
	assert.equal(toggle.value, true);
	await toggle.change(false); assert.equal(plugin.data.settings.backgroundTray, false);
	Platform.isMobile = true;
	try {
		assert.ok(tab.getSettingDefinitions().some(group => group.items?.some(item => item.name === '启用翻译功能')));
		assert.ok(!tab.getSettingDefinitions().some(group => group.items?.some(item => item.name === '后台运行与托盘')));
	}
	finally { Platform.isMobile = false; }
});

test('translation preference refreshes controls after saving and restores the value on failure', async () => {
	let refreshed = 0;
	const plugin = { data: { settings: { translationEnabled: true } },
		saveData: async () => { throw Error('Storage full'); }, refreshTranslation() { refreshed++; } };
	await assert.rejects(IndependentSync.prototype.setting.call(plugin, 'translationEnabled', false));
	assert.equal(plugin.data.settings.translationEnabled, true);
	assert.equal(refreshed, 0);
	plugin.saveData = async () => {};
	await IndependentSync.prototype.setting.call(plugin, 'translationEnabled', false);
	assert.equal(plugin.data.settings.translationEnabled, false);
	assert.equal(refreshed, 1);
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

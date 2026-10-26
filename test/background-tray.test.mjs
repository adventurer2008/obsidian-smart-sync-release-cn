import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { createBackgroundTray } from '../src/background-tray.js';

function fixture({ failMenu = false, empty = false } = {}) {
	const app = new EventEmitter();
	const renderer = new EventTarget();
	const contents = Object.assign(new EventEmitter(), {
		throttled: true, getBackgroundThrottling() { return this.throttled; },
		setBackgroundThrottling(value) { this.throttled = value; }, isDestroyed: () => false,
	});
	const win = Object.assign(new EventEmitter(), {
		webContents: contents, visible: true, minimized: false,
		isDestroyed: () => false, isMinimized() { return this.minimized; },
		restore() { this.minimized = false; }, show() { this.visible = true; },
		hide() { this.visible = false; }, focus() { this.focused = true; },
	});
	let tray, menu, imageData;
	const remote = { app, getCurrentWindow: () => win,
		nativeImage: { createFromDataURL(value) { imageData = value; return { isEmpty: () => empty, resize: () => 'branded-32px' }; } },
		Menu: { buildFromTemplate(value) { if (failMenu) throw Error('Menu failed'); menu = value; return value; } },
		Tray: class extends EventEmitter {
			constructor(image) { super(); assert.equal(image, 'branded-32px'); tray = this; }
			setToolTip(value) { this.tooltip = value; }
			setContextMenu() {} isDestroyed() { return this.destroyed === true; }
			destroy() { this.destroyed = true; }
		},
	};
	app.quit = () => { app.emit('before-quit'); };
	const open = (load = () => remote) => createBackgroundTray({ load, renderer, name: 'Brand', vaultName: 'Synthetic vault',
		labels: { show: 'Show', quit: 'Quit' }, logo: 'data:image/png;base64,synthetic' });
	const close = () => { let prevented = false; win.emit('close', { preventDefault() { prevented = true; } }); return prevented; };
	const unload = () => { const event = new Event('beforeunload', { cancelable: true }); renderer.dispatchEvent(event); return event.defaultPrevented; };
	return { app, renderer, unload, win, contents, remote, open, close, tray: () => tray, menu: () => menu, imageData: () => imageData };
}

test('closing keeps this vault alive; branded icon restores minimized windows and disabling restores closing', () => {
	const f = fixture(), controller = f.open();
	assert.match(f.imageData(), /^data:image\/png/);
	assert.equal(f.tray().tooltip, 'Brand · Synthetic vault');
	assert.equal(f.contents.throttled, false);
	assert.equal(f.close(), true); assert.equal(f.win.visible, false);
	f.win.minimized = true; f.tray().emit('click');
	assert.equal(f.win.visible, true); assert.equal(f.win.minimized, false); assert.equal(f.win.focused, true);
	f.close(); controller.dispose(); controller.dispose();
	assert.equal(f.win.visible, true); assert.equal(f.close(), false);
	assert.equal(f.contents.throttled, true); assert.equal(f.tray().destroyed, true);
	assert.equal(f.app.listenerCount('before-quit'), 0);
	assert.equal(f.win.listenerCount('closed'), 0);
	assert.equal(f.contents.listenerCount('will-prevent-unload'), 0);
});

test('explicit quit and system shutdown bypass close interception; a cancelled unload permits later background use', () => {
	for (const quit of [f => f.menu()[2].click(), f => f.win.emit('query-session-end'), f => f.win.emit('session-end')]) {
		const f = fixture(), controller = f.open();
		quit(f); assert.equal(f.close(), false);
		assert.equal(f.unload(), false);
		f.contents.emit('will-prevent-unload'); assert.equal(f.close(), true);
		controller.dispose();
	}
});

test('renderer cancels unload before host handlers even when remote close notification arrives too late', () => {
	const f = fixture(), controller = f.open();
	let hostUnloaded = false;
	f.renderer.addEventListener('beforeunload', () => { hostUnloaded = true; });
	// Model Electron remote delivery: the renderer is unloading before the remote
	// close callback has arrived. The synchronous renderer listener must save it.
	assert.equal(f.unload(), true);
	assert.equal(hostUnloaded, false); assert.equal(f.win.visible, false);
	f.tray().emit('click'); assert.equal(f.win.visible, true);
	controller.dispose();
	assert.equal(f.unload(), false); assert.equal(hostUnloaded, true);
});

test('initialization errors leave normal close behavior and no leaked resources', () => {
	for (const options of [{ failMenu: true }, { empty: true }]) {
		const f = fixture(options);
		assert.throws(() => f.open()); assert.equal(f.close(), false);
		assert.equal(f.app.listenerCount('before-quit'), 0);
		assert.equal(f.contents.throttled, true);
		assert.ok(!f.tray() || f.tray().destroyed);
	}
	const f = fixture(); assert.throws(() => f.open(() => ({}))); assert.equal(f.close(), false);
});

test('controllers isolate vaults, support legacy remote, and clean up when the vault closes', () => {
	const first = fixture(), second = fixture();
	const one = first.open(), two = second.open(name => { if (name === '@electron/remote') throw Error('Legacy'); return { remote: second.remote }; });
	first.close(); assert.equal(second.win.visible, true);
	one.dispose(); assert.equal(second.close(), true);
	second.win.emit('closed'); assert.equal(second.tray().destroyed, true);
	two.dispose();
});

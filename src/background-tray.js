/* global __SMART_SYNC_TRAY_LOGO__ -- Embedded from the existing brand asset by the build. */
const brandLogo = typeof __SMART_SYNC_TRAY_LOGO__ === 'undefined' ? '' : __SMART_SYNC_TRAY_LOGO__;

// One controller per vault window. Never touch other vaults or auxiliary windows.
export function createBackgroundTray({ load, name, vaultName, labels, renderer, logo = brandLogo }) {
	if (!renderer?.addEventListener || !renderer?.removeEventListener) throw Error('Vault renderer is unavailable');
	let remote;
	try { remote = load('@electron/remote'); }
	catch { remote = load('electron').remote; }
	if (!remote?.Tray || !remote?.Menu || !remote?.nativeImage || !remote?.app || !remote?.getCurrentWindow)
		throw Error('System tray is unavailable in this host');
	const win = remote.getCurrentWindow();
	if (!win || win.isDestroyed()) throw Error('Vault window is unavailable');
	let tray, disposed = false, quitting = false, hidden = false;
	const alive = () => !disposed && !win.isDestroyed();
	const show = () => {
		if (!alive()) return;
		// Explicitly restoring the window abandons any pending close request.
		quitting = false;
		if (win.isMinimized()) win.restore();
		win.show(); win.focus(); hidden = false;
	};
	const close = event => {
		if (!alive() || quitting || !tray || tray.isDestroyed()) return;
		event.preventDefault();
		win.hide(); hidden = true;
	};
	// Remote main-process listeners run asynchronously: they cannot reliably cancel
	// close alone. Cancel synchronously in this vault's renderer before Obsidian's
	// own unload handler runs, retaining the main listener for its delayed close path.
	const beforeUnload = event => {
		if (!alive() || quitting || !tray || tray.isDestroyed()) return;
		event.preventDefault();
		event.stopImmediatePropagation();
		event.returnValue = false;
		win.hide(); hidden = true;
	};
	const beforeQuit = () => { quitting = true; };
	// A prevented unload can mean the host is still saving and will close again.
	// Keep the close intent until teardown, failure, or explicit tray restoration.
	const contents = win.webContents;
	const priorThrottle = contents?.getBackgroundThrottling?.();
	const dispose = () => {
		if (disposed) return;
		// A hidden vault must remain reachable after disabling/unloading the plugin.
		if (hidden && !quitting) show();
		disposed = true;
		renderer.removeEventListener('beforeunload', beforeUnload, true);
		renderer.removeEventListener('pagehide', finishUnload, true);
		renderer.removeEventListener('unload', finishUnload, true);
		// Destroy while this renderer can still call into the main process.
		if (tray && !tray.isDestroyed()) tray.destroy();
		win.removeListener('close', close);
		win.removeListener('closed', dispose);
		win.removeListener('session-end', beforeQuit);
		win.removeListener('query-session-end', beforeQuit);
		remote.app.removeListener('before-quit', beforeQuit);
		if (priorThrottle !== undefined && !contents.isDestroyed()) contents.setBackgroundThrottling(priorThrottle);
	};
	const finishUnload = () => { quitting = true; dispose(); };
	try {
		const image = remote.nativeImage.createFromDataURL(logo);
		if (image.isEmpty()) throw Error('Tray logo is unavailable');
		tray = new remote.Tray(image.resize({ width: 32, height: 32 }));
		tray.setToolTip(`${name} · ${vaultName}`);
		tray.setContextMenu(remote.Menu.buildFromTemplate([
			{ label: labels.show, click: show },
			{ type: 'separator' },
			{ label: labels.quit, click: () => {
				if (!alive() || quitting) return;
				// Close this vault through the host's normal unload/save path.
				// app.quit() would close every vault sharing the Electron process.
				show();
				quitting = true;
				try { win.close(); }
				catch (error) { quitting = false; throw error; }
			} },
		]));
		tray.on('click', show);
		tray.on('double-click', show);
		remote.app.on('before-quit', beforeQuit);
		win.on('session-end', beforeQuit);
		win.on('query-session-end', beforeQuit);
		win.on('close', close);
		win.on('closed', dispose);
		renderer.addEventListener('beforeunload', beforeUnload, true);
		renderer.addEventListener('pagehide', finishUnload, true);
		renderer.addEventListener('unload', finishUnload, true);
		if (priorThrottle !== undefined) contents.setBackgroundThrottling(false);
		return { dispose };
	} catch (error) { dispose(); throw error; }
}

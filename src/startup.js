// Desktop-only operations are loaded on explicit user changes, never during build.
export function windowsStartupSupported(load) {
	try { return typeof load === 'function' && load('node:process').platform === 'win32'; }
	catch { return false; }
}

export function startupRequestMatches(params, settings) {
	return settings.launchAtLogin === true && settings.backgroundTray !== false &&
		typeof settings.launchAtLoginToken === 'string' && settings.launchAtLoginToken.length >= 32 &&
		typeof settings.launchAtLoginVault === 'string' && settings.launchAtLoginVault.length > 0 &&
		params?.token === settings.launchAtLoginToken && params?.target === settings.launchAtLoginVault &&
		(params.vault === undefined || params.vault === settings.launchAtLoginVault);
}

export async function windowsStartup({ load, pluginId, vaultPath, registeredPath, expectedVaultId }) {
	if (!windowsStartupSupported(load) || !/^[a-z][a-z0-9-]{1,63}$/.test(pluginId)) throw Error('Windows startup is unavailable');
	const fs = load('node:fs/promises'), path = load('node:path').win32, { createHash } = load('node:crypto');
	let remote;
	try { remote = load('@electron/remote'); } catch { remote = load('electron').remote; }
	const shell = load('electron').shell ?? remote?.shell;
	if (!remote?.app?.getPath || !shell?.writeShortcutLink || !shell?.readShortcutLink || !path.isAbsolute(vaultPath ?? ''))
		throw Error('Windows startup is unavailable');
	const normalize = value => path.resolve(value).toLowerCase();
	const quote = value => `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
	const userData = remote.app.getPath('userData');
	if (!path.isAbsolute(userData) || /[\r\n\0]/.test(userData)) throw Error('Invalid Obsidian profile path');
	const profileArgument = `--user-data-dir=${quote(userData)} `;
	// Obsidian's warm-launch CLI pipe is keyed by Windows user, not profile.
	// A custom profile's URI can therefore reach the default live instance.
	const defaultProfile = normalize(userData) === normalize(path.join(remote.app.getPath('appData'), 'obsidian'));
	const root = normalize(vaultPath);
	const priorRoot = typeof registeredPath === 'string' && path.isAbsolute(registeredPath) ? normalize(registeredPath) : root;
	const directory = path.join(remote.app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
	let vaultId, boundPath = root;
	const resolveVault = async () => {
		const host = JSON.parse(await fs.readFile(path.join(remote.app.getPath('userData'), 'obsidian.json'), 'utf8'));
		const matches = Object.entries(host.vaults ?? {}).filter(([, vault]) => typeof vault?.path === 'string' && normalize(vault.path) === root);
		if (matches.length !== 1 || !/^[a-zA-Z0-9-]{1,128}$/.test(matches[0][0])) throw Error('Cannot identify the current vault for Windows startup');
		return (vaultId = matches[0][0]);
	};
	const binding = async needsVault => {
		if (needsVault || priorRoot !== root) await resolveVault();
		// A moved vault keeps its host ID. A copied vault has another ID and must
		// never alter the source vault's entry, even when its settings were copied.
		boundPath = priorRoot !== root && vaultId === expectedVaultId ? priorRoot : root;
		const identity = `${pluginId}-${createHash('sha256').update(boundPath).digest('hex').slice(0, 24)}`;
		return { shortcut: path.join(directory, identity + '.lnk'), description: `Obsidian vault startup: ${identity}` };
	};
	const read = async ({ shortcut, description }) => {
		let info;
		try { info = await fs.lstat(shortcut); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
		const link = shell.readShortcutLink(shortcut);
		if (!info.isFile() || info.isSymbolicLink() || link.description !== description ||
			(typeof link.args === 'string' && link.args.startsWith('--user-data-dir=') && !link.args.startsWith(profileArgument)))
			throw Error('Startup shortcut is not owned by this vault');
		return fs.readFile(shortcut);
	};
	const uriFor = token => `obsidian://${pluginId}-startup?vault=${encodeURIComponent(vaultId)}&target=${encodeURIComponent(vaultId)}&token=${encodeURIComponent(token)}`;
	return { get vaultId() { return vaultId; }, get boundPath() { return boundPath; },
		async isConfigured(token) {
			try {
				if (!defaultProfile) return false;
				if (!/^[a-f0-9-]{32,64}$/.test(token ?? '')) return false;
				const entry = await binding(true);
				if (expectedVaultId && vaultId !== expectedVaultId) return false;
				if (!await read(entry)) return false;
				const link = shell.readShortcutLink(entry.shortcut);
				return typeof link.target === 'string' && path.isAbsolute(link.target) && normalize(link.target) === normalize(remote.app.getPath('exe')) && link.args === `${profileArgument}${quote(uriFor(token))}`;
			} catch { return false; }
		}, async change(enabled, token) {
		if (enabled && !defaultProfile) throw Object.assign(Error('Launch at login is unavailable for custom Obsidian profiles'), { code: 'STARTUP_CUSTOM_PROFILE' });
		if (enabled && !/^[a-f0-9-]{32,64}$/.test(token ?? '')) throw Error('Invalid startup marker');
		const entry = await binding(enabled), { shortcut, description } = entry;
		const before = await read(entry);
		const restore = async applied => {
			const current = await read(entry);
			if ((current === undefined) !== (applied === undefined) || (current && !current.equals(applied)))
				throw Error('Startup shortcut changed before rollback');
			if (before) await fs.writeFile(shortcut, before);
			else if (current) await fs.unlink(shortcut);
		};
		let applied;
		try { if (enabled) {
			const uri = uriFor(token);
			await fs.mkdir(directory, { recursive: true });
			if (!shell.writeShortcutLink(shortcut, 'create', {
				target: remote.app.getPath('exe'), args: `${profileArgument}${quote(uri)}`, description,
			})) throw Error('Could not create the Windows startup shortcut');
		} else if (before) await fs.unlink(shortcut);
		applied = await read(entry);
		if (enabled && !applied) throw Error('Startup shortcut was not saved');
		} catch (error) { await restore(await read(entry)); throw error; }
		return () => restore(applied);
	} };
}

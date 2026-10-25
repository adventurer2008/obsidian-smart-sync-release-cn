import { safeNotePath, safeHostPath } from './codec.js';

export const CONFIG_NAMESPACE = '__smart_sync_configuration__';
const ordinary = {
	'app.json': 'editor',
	'appearance.json': 'appearance',
	'hotkeys.json': 'hotkeys',
	'bookmarks.json': 'bookmarks',
	'core-plugins.json': 'coreEnabled',
	'community-plugins.json': 'pluginEnabled',
};
export const coreFiles = ['daily-notes.json', 'templates.json', 'graph.json'];
export function cleanConfiguration(input = {}) {
	const result = {};
	for (const key of [
		'settings',
		'themes',
		'editor',
		'appearance',
		'hotkeys',
		'bookmarks',
		'coreEnabled',
		'pluginCode',
		'pluginData',
		'pluginEnabled',
		'codeSnippets',
	])
		if (typeof input[key] === 'boolean') result[key] = input[key];
	for (const key of ['themeNames', 'snippets', 'coreSettings'])
		if (Array.isArray(input[key]))
			result[key] = [
				...new Set(
					input[key].filter(
						(name) =>
							typeof name === 'string' &&
							name.length <= 120 &&
							!/[\\/]/.test(name) &&
							!name.includes(String.fromCharCode(0)) &&
							name !== '.' &&
							name !== '..',
					),
				),
			].slice(0, 200);
	result.plugins = ['none', 'settings', 'all'].includes(input.plugins) ? input.plugins : 'none';
	result.pluginRules = Object.create(null);
	for (const [id, rule] of Object.entries(input.pluginRules ?? {}).slice(0, 200))
		if (
			/^[a-zA-Z0-9_-]{1,100}$/.test(id) &&
			!['__proto__', 'constructor', 'prototype'].includes(id) &&
			rule &&
			typeof rule === 'object'
		)
			result.pluginRules[id] = {
				...(typeof rule.code === 'boolean' ? { code: rule.code } : {}),
				...(typeof rule.data === 'boolean' ? { data: rule.data } : {}),
			};
	return result;
}
export function filterPreset(settings, name) {
	if (typeof name !== 'string' || !name.trim() || name.length > 80)
		throw new Error('Enter a short preset name');
	const configuration = cleanConfiguration(settings.configuration);
	configurationScope(configuration);
	return {
		name: name.trim(),
		filters: structuredClone({
			ignored: settings.ignored ?? [],
			excludedExtensions: settings.excludedExtensions ?? [],
			attachmentMiB: settings.attachmentMiB === 0 ? 0 : 256,
			configuration,
		}),
	};
}
export function configurationScope({
	settings = false,
	themes = false,
	plugins = 'none',
	pluginCode,
	pluginData,
	pluginEnabled = false,
	codeSnippets,
	editor,
	appearance,
	hotkeys,
	bookmarks = false,
	coreEnabled = false,
	coreSettings = [],
	themeNames,
	snippets = [],
	pluginRules = {},
	ownId,
	mobile = false,
} = {}) {
	if (!['none', 'settings', 'all'].includes(plugins))
		throw new Error('Invalid plugin synchronization mode');
	const forbidden = new Set([
		ownId?.toLowerCase(),
		'smartsync',
		'smart-sync',
		'wujie-sync',
		'smart-sync-global',
		'smart-sync-v2-test',
		'ss2-native-driver',
	]);
	function allowed(relative) {
		try {
			safeNotePath(relative);
		} catch {
			return false;
		}
		const category = ordinary[relative];
		if (category)
			return (
				{
					editor: editor ?? settings,
					appearance: appearance ?? settings,
					hotkeys: hotkeys ?? settings,
					bookmarks,
					coreEnabled,
					pluginEnabled,
				}[category] === true
			);
		if (coreFiles.includes(relative)) return coreSettings.includes(relative);
		const theme = /^themes\/([^/]+)\/[^/]+$/.exec(relative);
		if (theme) return themes && (!themeNames || themeNames.includes(theme[1]));
		const snippet = /^snippets\/([^/]+\.css)$/.exec(relative);
		if (snippet)
			return (
				(codeSnippets === true && (snippets.length === 0 || snippets.includes(snippet[1]))) ||
				(codeSnippets !== false && snippets.includes(snippet[1]))
			);
		const match = /^plugins\/([^/]+)\/([^/]+)$/.exec(relative);
		if (
			!match ||
			forbidden.has(match[1].toLowerCase()) ||
			/secret|credential|token|\.env/i.test(match[2])
		)
			return false;
		const rule = Object.hasOwn(pluginRules, match[1]) ? pluginRules[match[1]] : undefined;
		if (match[2] === 'data.json')
			return (
				pluginData !== false &&
				(typeof rule?.data === 'boolean'
					? rule.data
					: (pluginData ?? ['all', 'settings'].includes(plugins)))
			);
		return (
			pluginCode !== false &&
			['manifest.json', 'main.js', 'styles.css'].includes(match[2]) &&
			(typeof rule?.code === 'boolean' ? rule.code : (pluginCode ?? plugins === 'all'))
		);
	}
	return {
		allowed,
		mobile,
		protectedPlugin: (id) => forbidden.has(id.toLowerCase()),
		encode: (relative) => {
			if (!allowed(relative)) throw new Error('Configuration path is excluded');
			return `${CONFIG_NAMESPACE}/${relative}`;
		},
		decode: (path) => {
			const relative = path.slice(CONFIG_NAMESPACE.length + 1);
			if (!path.startsWith(`${CONFIG_NAMESPACE}/`) || !allowed(relative))
				throw new Error('Configuration path is excluded');
			return relative;
		},
	};
}

export function configurationHost(vault, normal, scope, { stopped = () => false, onPluginStateChanged = () => {}, windows = false } = {}) {
	const adapter = vault.adapter;
	if (!adapter) return normal;
	const root = vault.configDir;
	if (typeof root !== 'string' || !root)
		throw new Error('Obsidian configuration directory is unavailable');
	const pathFor = (path) => `${root}/${safeHostPath(scope.decode(path), windows)}`;
	const isVirtual = (path) => path.startsWith(`${CONFIG_NAMESPACE}/`);
	const pluginStatePath = `${root}/community-plugins.json`;
	const parsePluginState = (bytes) => {
		const ids = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
		if (!Array.isArray(ids) || ids.length > 10000 || !ids.every(id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(id)))
			throw Error('Invalid community plugin state');
		return [...new Set(ids)].sort();
	};
	const encodePluginState = ids => new TextEncoder().encode(JSON.stringify([...new Set(ids)].sort()));
	async function readPluginState() {
		return await adapter.exists(pluginStatePath) ? parsePluginState(new Uint8Array(await adapter.readBinary(pluginStatePath))) : [];
	}
	async function writePluginState(bytes) {
		const incoming = parsePluginState(bytes).filter(id => !scope.protectedPlugin(id));
		const previous = await readPluginState();
		const merged = [...incoming, ...previous.filter(id => scope.protectedPlugin(id))];
		const encoded = encodePluginState(merged);
		if (JSON.stringify([...new Set(merged)].sort()) === JSON.stringify(previous)) return;
		if (stopped()) throw new Error('Plugin is unloading');
		await adapter.writeBinary(pluginStatePath, encoded.buffer);
		onPluginStateChanged();
	}
	const mobileManifests = new Map();
	let configurationFiles;
	async function listConfiguration(folder) {
		if (stopped()) throw new DOMException('Configuration scan stopped', 'AbortError');
		if (!(await adapter.exists(folder))) return [];
		const listing = await adapter.list(folder);
		const result = [];
		for (const file of listing.files) {
			const relative = file.slice(root.length + 1);
			if (scope.allowed(relative)) {
				if (scope.mobile && relative.startsWith('plugins/')) {
					const manifest = `${root}/${relative.split('/').slice(0, 2).join('/')}/manifest.json`;
					try {
						if (!mobileManifests.has(manifest)) mobileManifests.set(manifest, JSON.parse(await adapter.read(manifest)).isDesktopOnly === false);
						if (!mobileManifests.get(manifest)) continue;
					} catch {
						continue;
					}
				}
				result.push(scope.encode(relative));
			}
		}
		// Only traverse explicit safe categories; never inspect this plugin's state or local workspaces.
		for (const child of listing.folders) {
			const relative = child.slice(root.length + 1);
			if (
				relative === 'themes' ||
				relative === 'snippets' ||
				/^themes\/[^/]+$/.test(relative) ||
				relative === 'plugins' ||
				/^plugins\/[^/]+$/.test(relative)
			) {
				if (
					relative.startsWith('plugins/') &&
					!scope.allowed(`${relative}/data.json`) &&
					!scope.allowed(`${relative}/manifest.json`)
				)
					continue;
				result.push(...(await listConfiguration(child)));
			}
		}
		return result.sort(
			(a, b) =>
				Number(b.endsWith('/manifest.json')) - Number(a.endsWith('/manifest.json')) ||
				a.localeCompare(b),
		);
	}
	return {
		configurationVersion: async () => {
			configurationFiles = await listConfiguration(root);
			if (typeof adapter.stat !== 'function') return undefined;
			const stamps = [];
			for (let offset = 0; offset < configurationFiles.length; offset += 4) {
				if (stopped()) throw new DOMException('Configuration scan stopped', 'AbortError');
				const batch = configurationFiles.slice(offset, offset + 4);
				const stats = await Promise.all(batch.map(path => adapter.stat(pathFor(path))));
				for (let index = 0; index < batch.length; index++) {
					const stat = stats[index];
					if (!stat || ![stat.size, stat.mtime, stat.ctime].every(Number.isFinite)) return undefined;
					stamps.push([batch[index], stat.size, stat.mtime, stat.ctime]);
				}
			}
			return JSON.stringify(stamps);
		},
		mtime: (path) => isVirtual(path) ? undefined : normal.mtime?.(path),
		...(normal.sink
			? {
						sink: (path, bytes, digest, mtime) => {
						if (isVirtual(path)) throw Error('Configuration streaming is excluded');
						return normal.sink(path, bytes, digest, mtime);
					},
				}
			: {}),
		listFolders: () => normal.listFolders?.() ?? [],
		...(normal.canonicalPath ? { canonicalPath: path => isVirtual(path) ? path : normal.canonicalPath(path) } : {}),
		stamp: async (path) => {
			if (isVirtual(path)) {
				const stat = await adapter.stat?.(pathFor(path));
				return stat && [stat.size, stat.mtime, stat.ctime].every(Number.isFinite)
					? JSON.stringify([stat.size, stat.mtime, stat.ctime])
					: undefined;
			}
			return normal.stamp?.(path);
		},
		exists: (path) =>
			isVirtual(path)
				? adapter.exists(pathFor(path))
				: normal.exists
					? normal.exists(path)
					: normal.read(path).then((bytes) => bytes !== null),
		sameEntry: (from, to) => !isVirtual(from) && !isVirtual(to) && normal.sameEntry?.(from, to),
		mkdir: (path) => normal.mkdir?.(path),
		removeFolder: (path) => normal.removeFolder?.(path),
		removeTree: (path, expected) => !isVirtual(path) && normal.removeTree?.(path, expected),
		move: async (from, to) => {
			if (isVirtual(from) || isVirtual(to))
				throw new Error('Configuration moves require explicit configuration selection');
			if (normal.move) return normal.move(from, to);
			await normal.write(to, await normal.read(from));
			await normal.remove(from);
		},
		conflictPath: (path, sequence, digest) =>
			isVirtual(path)
				? `Smart Sync conflicts/configuration/${path.slice(CONFIG_NAMESPACE.length + 1)}.conflict-${sequence}-${digest.slice(0, 12)}.txt`
				: undefined,
		list: async () => [
			...(await normal.list()).filter((path) => !isVirtual(path)),
			...(configurationFiles ?? await listConfiguration(root)),
		],
		read: async (path) => {
			if (!isVirtual(path)) return normal.read(path);
			let target;
			try {
				target = pathFor(path);
			} catch {
				return null;
			}
			if (scope.decode(path) === 'community-plugins.json')
				return await adapter.exists(target) ? encodePluginState((await readPluginState()).filter(id => !scope.protectedPlugin(id))) : null;
			return (await adapter.exists(target))
				? new Uint8Array(await adapter.readBinary(target))
				: null;
		},
		write: async (path, bytes, mtime) => {
			if (!isVirtual(path)) return normal.write(path, bytes, mtime);
			if (stopped()) throw new Error('Plugin is unloading');
			const relative = scope.decode(path),
				target = pathFor(path);
			if (relative === 'community-plugins.json') return writePluginState(bytes);
			if (relative === 'core-plugins.json') {
				const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
				const id = (name) => typeof name === 'string' && /^[a-z0-9-]{1,80}$/.test(name);
				if (
					Array.isArray(value)
						? !value.every(id)
						: !value ||
							typeof value !== 'object' ||
							!Object.entries(value).every(
								([name, enabled]) => id(name) && typeof enabled === 'boolean',
							)
				)
					throw Error('Invalid core plugin state');
			}
			if (scope.mobile && relative.startsWith('plugins/')) {
				if (relative.endsWith('/manifest.json')) {
					if (JSON.parse(new TextDecoder().decode(bytes)).isDesktopOnly !== false)
						throw Object.assign(new Error('Desktop-only plugin is excluded on mobile'), {
							code: 'CONFIG_MOBILE_PLUGIN',
						});
				} else {
					const manifest = `${root}/${relative.split('/').slice(0, 2).join('/')}/manifest.json`;
					if (
						!(await adapter.exists(manifest)) ||
						JSON.parse(await adapter.read(manifest)).isDesktopOnly !== false
					)
						throw Object.assign(new Error('Validate the mobile plugin manifest first'), {
							code: 'CONFIG_MOBILE_PLUGIN',
						});
				}
			}
			const parent = target.split('/').slice(0, -1).join('/');
			if (!(await adapter.exists(parent))) await adapter.mkdir(parent);
			await adapter.writeBinary(target, Uint8Array.from(bytes).buffer);
		},
		remove: async (path) => {
			if (!isVirtual(path)) return normal.remove(path);
			if (stopped()) throw new Error('Plugin is unloading');
			const target = pathFor(path);
			if (scope.decode(path) === 'community-plugins.json') return writePluginState(encodePluginState([]));
			if (await adapter.exists(target)) await adapter.trashLocal(target);
		},
	};
}

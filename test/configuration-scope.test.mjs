import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	cleanConfiguration,
	configurationScope,
	configurationHost,
	CONFIG_NAMESPACE,
} from '../src/configuration.js';
import { messages, englishDraft, t, localizedFailure, createTranslator } from '../src/i18n.js';
import { TaskJournal } from '../src/tasks.js';
import { diagnosticReport } from '../src/planning.js';

test('configuration inventory fingerprints detect additions edits and removals without reading unchanged bodies', async () => {
	const files = new Map([['custom/app.json', { size: 2, mtime: 10, ctime: 1 }]]);
	let reads = 0;
	const adapter = {
		exists: async path => path === 'custom' || files.has(path),
		list: async () => ({ files: [...files.keys()], folders: [] }),
		stat: async path => files.get(path),
		readBinary: async () => { reads++; return new ArrayBuffer(0); },
	};
	const scope = configurationScope({ editor: true, hotkeys: true });
	const host = () => configurationHost({ configDir: 'custom', adapter }, { list: async () => ['note.md'], listFolders: async () => [] }, scope);
	const original = await host().configurationVersion();
	assert.equal(await host().configurationVersion(), original);
	files.set('custom/app.json', { size: 2, mtime: 11, ctime: 1 });
	assert.notEqual(await host().configurationVersion(), original);
	files.set('custom/hotkeys.json', { size: 2, mtime: 12, ctime: 1 });
	const expanded = host();
	const added = await expanded.configurationVersion();
	assert.equal((await expanded.list()).length, 3);
	files.delete('custom/hotkeys.json');
	assert.notEqual(await host().configurationVersion(), added);
	delete adapter.stat;
	assert.equal(await host().configurationVersion(), undefined);
	assert.equal(reads, 0);
});

test('product language catalogs contain no development-stage test-vault prompts', () => {
	for (const catalog of [messages, englishDraft]) {
		for (const [key, value] of Object.entries(catalog))
			assert.doesNotMatch(JSON.stringify(value), /测试|合成|\btest\b/i, key);
	}
	assert.equal(t('msg_586de4b2a5'), '创建笔记库');
	assert.equal(t('msg_de177cf69f'), '选择已有笔记库');
	assert.equal(t('version.value', { version: '0.1.12' }), '当前版本 0.1.12');
});

test('startup preferences and sync identities cannot be transferred by plugin-data sync across desktop or mobile scopes', () => {
	for (const ownId of ['wujie-sync', 'smart-sync-global']) for (const mobile of [false, true]) {
		const scope = configurationScope({ plugins:'all', pluginCode:true, pluginData:true, ownId, mobile });
		for (const id of ['wujie-sync','smart-sync-global']) {
			assert.equal(scope.allowed(`plugins/${id}/data.json`),false);
			assert.equal(scope.allowed(`plugins/${id}/main.js`),false);
		}
		assert.equal(scope.allowed('plugins/synthetic-other/data.json'),true);
	}
});

test('granular scope separates each plugin code/data and category while protecting own state and enable lists', () => {
	const c = cleanConfiguration({
		editor: true,
		hotkeys: false,
		bookmarks: true,
		themes: true,
		themeNames: ['A'],
		snippets: ['one.css'],
		coreSettings: ['templates.json'],
		coreEnabled: false,
		pluginRules: {
			alpha: { code: true, data: false },
			beta: { code: false, data: true },
			'smart-sync': { code: true, data: true },
		},
	});
	const scope = configurationScope({ ...c, ownId: 'smart-sync' });
	for (const path of [
		'app.json',
		'bookmarks.json',
		'themes/A/theme.css',
		'snippets/one.css',
		'templates.json',
		'plugins/alpha/main.js',
		'plugins/beta/data.json',
	])
		assert.equal(scope.allowed(path), true, path);
	for (const path of [
		'hotkeys.json',
		'appearance.json',
		'core-plugins.json',
		'themes/B/theme.css',
		'snippets/two.css',
		'graph.json',
		'plugins/alpha/data.json',
		'plugins/beta/main.js',
		'plugins/smart-sync/data.json',
		'community-plugins.json',
		'workspace.json',
		'plugins/alpha/secret.json',
	])
		assert.equal(scope.allowed(path), false, path);
	assert.equal(configurationScope({ coreEnabled: true }).allowed('core-plugins.json'), true);
	const sanitized = cleanConfiguration(
		JSON.parse(
			'{"accessKey":"secret","pluginRules":{"__proto__":{"code":true}},"snippets":["../secret","ok.css"]}',
		),
	);
	assert.deepEqual(sanitized.snippets, ['ok.css']);
	assert.equal(Object.hasOwn(sanitized.pluginRules, '__proto__'), false);
	assert.equal(JSON.stringify(sanitized).includes('secret'), false);
});
test('configuration host traverses snippets only when selected and validates core enable state before writing', async () => {
	const files = new Map([
		['custom/snippets/one.css', 'body{}'],
		['custom/snippets/private.css', 'secret'],
	]);
	const adapter = {
		exists: async (path) => path === 'custom' || path === 'custom/snippets' || files.has(path),
		list: async (path) =>
			path === 'custom'
				? { files: [], folders: ['custom/snippets'] }
				: { files: [...files.keys()], folders: [] },
		readBinary: async (path) => new TextEncoder().encode(files.get(path)).buffer,
		mkdir: async () => {},
		writeBinary: async (path, bytes) => files.set(path, new TextDecoder().decode(bytes)),
	};
	const host = configurationHost(
		{ adapter, configDir: 'custom' },
		{ list: async () => [] },
		configurationScope({ snippets: ['one.css'], coreEnabled: true }),
	);
	assert.deepEqual(await host.list(), [`${CONFIG_NAMESPACE}/snippets/one.css`]);
	await assert.rejects(
		host.write(
			`${CONFIG_NAMESPACE}/core-plugins.json`,
			new TextEncoder().encode('{"secret":"value"}'),
		),
		/Invalid core/,
	);
	assert.equal(files.has('custom/core-plugins.json'), false);
	await host.write(
		`${CONFIG_NAMESPACE}/core-plugins.json`,
		new TextEncoder().encode('["bookmarks","templates"]'),
	);
	assert.equal(files.get('custom/core-plugins.json'), '["bookmarks","templates"]');
});
test('Chinese resources enforce named parameters and diagnostics contain no names, credentials or raw errors', () => {
	for (const [key, value] of Object.entries(messages)) {
		const params = Object.fromEntries(
			[...value.matchAll(/\{(\w+)\}/g)].map((match) => [match[1], '示例']),
		);
		assert.equal(/\{\w+\}/.test(t(key, params)), false, key);
		if (englishDraft[key])
			assert.deepEqual(
				[...new Set([...value.matchAll(/\{(\w+)\}/g)].map((x) => x[1]))].sort(),
				[...new Set([...englishDraft[key].matchAll(/\{(\w+)\}/g)].map((x) => x[1]))].sort(),
				key,
			);
	}
	const dynamic = Object.keys(messages).find((key) => messages[key].includes('{path}'));
	assert.throws(() => t(dynamic), /Missing language/);
	assert.match(localizedFailure({ code: 'PLAN_CHANGED' }), /重新同步/);
	assert.match(localizedFailure({ code: 'PLAN_CHANGED', reviewRequired: true }), /重新查看/);
	const missing = [];
	const translate = createTranslator(
		'en-US',
		{ items: { one: '{count} item', other: '{count} items' } },
		{
			fallback: { fallback: 'Fallback {name}' },
			onMissing: (key) => missing.push(key),
		},
	);
	assert.equal(translate('items', { count: 1 }), '1 item');
	assert.equal(translate('items', { count: 1200 }), '1,200 items');
	assert.equal(translate('fallback', { name: 'text' }), 'Fallback text');
	assert.throws(() => translate('absent'), /Unknown language resource/);
	assert.deepEqual(missing, ['fallback', 'absent']);
	const journal = new TaskJournal(),
		scope = 'a'.repeat(64),
		id = journal.start(scope, { note: 'b'.repeat(64), direction: 'send' });
	journal.update(id, {
		status: 'failed',
		path: 'private-note.md',
		error: new Error('Bearer key-secret'),
	});
	const report = diagnosticReport({
		journal,
		scope,
		version: '0.1.4',
		platform: 'desktop',
		counts: { notes: 1, conflicts: 0 },
	});
	for (const value of ['private-note.md', 'Bearer', 'key-secret', 'accessKey', 'origin'])
		assert.equal(JSON.stringify(report).includes(value), false);
	assert.equal(report.tasks.length, 1);
});

test('community plugin files, data, built-in state, appearance and theme snippets have independent gates', () => {
	const make = (options) =>
		configurationScope({ ...cleanConfiguration(options), ownId: 'smart-sync' });
	const code = make({ pluginCode: true, pluginData: false });
	for (const path of [
		'plugins/alpha/main.js',
		'plugins/alpha/manifest.json',
		'plugins/alpha/styles.css',
		'plugins/newly-installed/main.js',
	])
		assert.equal(code.allowed(path), true, path);
	for (const path of [
		'plugins/alpha/data.json',
		'core-plugins.json',
		'community-plugins.json',
		'appearance.json',
		'plugins/smart-sync/main.js',
		'plugins/ss2-native-driver/data.json',
		'plugins/alpha/token.json',
	])
		assert.equal(code.allowed(path), false, path);
	const data = make({
		pluginCode: false,
		pluginData: true,
		pluginRules: { alpha: { code: true } },
	});
	assert.equal(data.allowed('plugins/alpha/main.js'), false);
	assert.equal(data.allowed('plugins/newly-installed/data.json'), true);
	const selected = make({ plugins: 'none', pluginRules: { alpha: { data: true } } });
	assert.equal(selected.allowed('plugins/alpha/data.json'), true);
	assert.equal(selected.allowed('plugins/beta/data.json'), false);
	assert.equal(selected.allowed('plugins/alpha/main.js'), false);
	const themes = make({ themes: true, codeSnippets: true, appearance: false });
	assert.equal(themes.allowed('themes/A/theme.css'), true);
	assert.equal(themes.allowed('snippets/new.css'), true);
	assert.equal(themes.allowed('appearance.json'), false);
	const off = make({ themes: false, codeSnippets: false, snippets: ['old.css'] });
	assert.equal(off.allowed('snippets/old.css'), false);
	assert.equal(
		make({ coreEnabled: true, pluginCode: false, pluginData: false }).allowed('core-plugins.json'),
		true,
	);
});

test('Chinese product messages contain no English prose or confirmation words', () => {
	for (const [key, value] of Object.entries(messages)) {
		if (key === 'overview.spaceMiB') { assert.equal(value, '{value} MB'); continue; }
		if (key === 'overview.spaceGiB') { assert.equal(value, '{value} GB'); continue; }
		const text = value.replace(/\{[^}]+\}/g, '').replace(/Obsidian|Smart Sync/g, '').replace(/\b(?:KB|MB|GB|B)\b|\/s/g, '');
		assert.equal(/[A-Za-z]/.test(text), false, key + ': ' + value);
	}
});


test('R256 activation state has an independent gate and protects sync IDs on upload, apply and removal', async () => {
 const encode = value => new TextEncoder().encode(JSON.stringify(value));
 const path = `${CONFIG_NAMESPACE}/community-plugins.json`;
 assert.equal(configurationScope({ pluginCode: true }).allowed('community-plugins.json'), false);
 const scope = configurationScope({ pluginEnabled: true, ownId: 'custom-sync' });
 assert.equal(scope.allowed('community-plugins.json'), true);
 assert.equal(scope.allowed('plugins/example/main.js'), false);
 assert.equal(cleanConfiguration({ pluginEnabled: false }).pluginEnabled, false);
 const files = new Map([['custom/community-plugins.json', encode(['wujie-sync', 'custom-sync', 'alpha'])]]);
 let changed = 0, stopped = false;
 const adapter = {
  exists: async path => path === 'custom' || files.has(path),
  readBinary: async path => files.get(path).buffer,
  writeBinary: async (path, bytes) => files.set(path, new Uint8Array(bytes)),
  list: async () => ({ files: [...files.keys()], folders: [] }),
  trashLocal: async () => assert.fail('Activation removal must preserve sync plugins'),
 };
 const host = configurationHost({ adapter, configDir: 'custom' }, {}, scope, { stopped: () => stopped, onPluginStateChanged: () => changed++ });
 assert.deepEqual(JSON.parse(new TextDecoder().decode(await host.read(path))), ['alpha']);
 await host.write(path, encode(['beta', 'smart-sync', 'smart-sync-global', 'wujie-sync', 'beta']));
 assert.deepEqual(JSON.parse(new TextDecoder().decode(files.get('custom/community-plugins.json'))), ['beta', 'custom-sync', 'wujie-sync']);
 assert.deepEqual(JSON.parse(new TextDecoder().decode(await host.read(path))), ['beta']);
 assert.equal(changed, 1);
 await host.write(path, encode(['beta'])); assert.equal(changed, 1);
 for (const invalid of [{ alpha: true }, ['../bad'], [''], [null]]) await assert.rejects(host.write(path, encode(invalid)), /Invalid community/);
 assert.equal(changed, 1);
 stopped = true; await assert.rejects(host.write(path, encode([])), /unloading/); stopped = false;
 await host.remove(path);
 assert.deepEqual(JSON.parse(new TextDecoder().decode(files.get('custom/community-plugins.json'))), ['custom-sync', 'wujie-sync']);
 assert.equal(changed, 2);
});

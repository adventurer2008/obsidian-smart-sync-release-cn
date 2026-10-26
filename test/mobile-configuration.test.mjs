import assert from 'node:assert/strict';
import { test } from 'node:test';
import { packNote, freshSalt, unlockWorkspace } from '../src/codec.js';
import { NotebookSynchronizer, emptyState } from '../src/synchronizer.js';
import { configurationHost, configurationScope, CONFIG_NAMESPACE } from '../src/configuration.js';
import { TaskJournal } from '../src/tasks.js';
const encode = value => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value));
const prefix = `${CONFIG_NAMESPACE}/`;
const keys = await unlockWorkspace('synthetic platform compatibility', freshSalt());

async function fixture(items, mobile = true) {
	const objects = new Map(), entries = [], files = new Map(), notes = new Map(), mtimes = new Map(), events = [];
	let loads = 0, commits = 0;
	async function add(path, content, identity) {
		const packed = await packNote(keys, 'synthetic-platform', path, encode(content), undefined, identity, 'file', 1577836800123);
		for (const object of packed.objects) objects.set(object.address, object.body);
		entries.push({ note: packed.id, sequence: entries.length + 1, manifest: packed.manifest, removed: false });
		return packed.id;
	}
	for (const [path, content] of items) await add(path, content);
	const api = { workspace: 'synthetic-platform', feed: async after => ({ entries: entries.filter(entry => entry.sequence > after), more: false }),
		load: async address => { loads++; const bytes = objects.get(address); if (!bytes) throw Error('Missing object'); return bytes; },
		commit: async () => { commits++; assert.fail('Receivers must not delete or overwrite source plugins'); } };
	const adapter = { exists: async path => path === 'custom' || files.has(path) || [...files.keys()].some(file => file.startsWith(path + '/')),
		read: async path => new TextDecoder().decode(files.get(path)), readBinary: async path => Uint8Array.from(files.get(path)).buffer,
		writeBinary: async (path, bytes) => files.set(path, new Uint8Array(bytes)), mkdir: async () => {},
		trashLocal: async path => { files.delete(path); },
		list: async path => ({ files: [...files.keys()].filter(file => file.slice(0, file.lastIndexOf('/')) === path),
			folders: [...new Set([...files.keys()].filter(file => file.startsWith(path + '/')).map(file => file.slice(path.length + 1).split('/')).filter(parts => parts.length > 1).map(parts => path + '/' + parts[0]))] }) };
	const normal = { list: async () => [...notes.keys()], read: async path => notes.get(path) ?? null,
		write: async (path, bytes, mtime) => { notes.set(path, bytes); mtimes.set(path, mtime); }, remove: async path => notes.delete(path), mtime: async path => mtimes.get(path) };
	let state = emptyState();
	const scope = configurationScope({ mobile, ownId: 'wujie-sync', pluginCode: true, pluginData: true, pluginEnabled: true });
	function host() { return configurationHost({ configDir: 'custom', adapter }, normal, scope, { mobileBlocked: Object.values(state.notes).filter(note => note.platformSkipped === 'desktop-plugin').map(note => note.path) }); }
	async function run(direction = 'both') {
		const engine = new NotebookSynchronizer({ api, keys, host: host(), state, direction, save: async () => {}, onTask: async event => events.push(event), accepts: path => !path.startsWith(prefix) || scope.allowed(path.slice(prefix.length)) });
		await engine.run(); return engine;
	}
	return { add, run, files, notes, mtimes, events, api, objects, entries, host, state: () => state, restart: () => { state = JSON.parse(JSON.stringify(state)); }, loads: () => loads, commits: () => commits };
}

test('mobile skips every desktop-only plugin file in any order and continues notes, attachments and compatible plugins', async () => {
	for (const manifestFirst of [false, true]) {
		const desktop = [
			[prefix + 'plugins/arbitrary-desktop/main.js', 'desktop code'],
			[prefix + 'plugins/arbitrary-desktop/data.json', '{}'],
			[prefix + 'plugins/arbitrary-desktop/styles.css', 'desktop styles'],
			[prefix + 'plugins/arbitrary-desktop/manifest.json', { isDesktopOnly: true }],
		];
		if (manifestFirst) desktop.reverse();
		const f = await fixture([...desktop, ['note.md', 'note'], ['attachment.bin', 'attachment'],
			[prefix + 'plugins/mobile-ok/data.json', '{}'], [prefix + 'plugins/mobile-ok/main.js', 'mobile code'],
			[prefix + 'plugins/mobile-ok/manifest.json', { isDesktopOnly: false }]]);
		await f.run();
		assert.equal(f.state().cursor, 9); assert.equal(f.commits(), 0);
		assert.equal([...f.files.keys()].some(path => path.includes('arbitrary-desktop')), false);
		assert.equal(f.files.has('custom/plugins/mobile-ok/main.js'), true);
		assert.equal(new TextDecoder().decode(f.notes.get('note.md')), 'note');
		assert.equal(f.mtimes.get('attachment.bin'), 1577836800123);
		assert.equal(f.events.filter(event => event.status === 'skipped' && event.skipReason === 'desktop-plugin').length, 4);
		assert.equal(f.events.some(event => event.status === 'failed'), false);
		const loaded = f.loads(); f.restart(); await f.run();
		assert.equal(f.loads(), loaded); assert.equal(f.commits(), 0);
		// A later mobile-compatible release re-enables the previously skipped code and settings.
		await f.add(prefix + 'plugins/arbitrary-desktop/manifest.json', { isDesktopOnly: false });
		await f.run(); assert.equal(f.files.has('custom/plugins/arbitrary-desktop/main.js'), true);
		assert.equal(f.files.has('custom/plugins/arbitrary-desktop/data.json'), true);
	}
});

test('mobile enable state filters desktop plugins locally while preserving shared desktop enable entries', async () => {
	const f = await fixture([[prefix + 'community-plugins.json', ['desktop-tool', 'mobile-tool']],
		[prefix + 'plugins/desktop-tool/manifest.json', { isDesktopOnly: true }],
		[prefix + 'plugins/mobile-tool/manifest.json', { isDesktopOnly: false }]]);
	f.files.set('custom/community-plugins.json', encode(['wujie-sync']));
	await f.run();
	assert.deepEqual(JSON.parse(new TextDecoder().decode(f.files.get('custom/community-plugins.json'))), ['mobile-tool', 'wujie-sync']);
	assert.equal(f.commits(), 0);
});

test('mobile resolves reinstalled manifest identities and ignores a stale mobile-compatible local manifest', async () => {
	const path = prefix + 'plugins/reinstalled/main.js';
	const f = await fixture([[path, 'desktop code'], ['note.md', 'continues']]);
	f.files.set('custom/plugins/reinstalled/manifest.json', encode({ isDesktopOnly: false }));
	await f.add(prefix + 'plugins/reinstalled/manifest.json', { isDesktopOnly: true }, 'e'.repeat(64));
	await f.run();
	assert.equal(f.files.has('custom/plugins/reinstalled/main.js'), false);
	assert.equal(f.notes.has('note.md'), true); assert.equal(f.commits(), 0);
});

test('desktop still receives desktop plugins; unknown manifests and corrupt or denied objects remain errors', async () => {
	const path = prefix + 'plugins/arbitrary/main.js', manifest = prefix + 'plugins/arbitrary/manifest.json';
	const desktop = await fixture([[path, 'code'], [manifest, { isDesktopOnly: true }]], false);
	await desktop.run(); assert.equal(desktop.files.has('custom/plugins/arbitrary/main.js'), true);
	for (const content of [null, '{bad json', {}]) {
		const f = await fixture([[path, 'code'], ...(content === null ? [] : [[manifest, content]])]);
		await assert.rejects(f.run()); assert.equal(f.files.size, 0);
		assert.equal(f.state().cursor, 0);
	}
	for (const status of [401, 403]) {
		const f = await fixture([[path, 'code'], [manifest, { isDesktopOnly: true }]]);
		f.api.load = async () => { throw Object.assign(Error('Denied'), { status }); };
		await assert.rejects(f.run(), error => error.status === status); assert.equal(f.state().cursor, 0);
	}
});

test('desktop skip reason survives the bounded task journal and resolves the prior failed attempt without retry', () => {
	const journal = new TaskJournal(), scope = 'a'.repeat(64), note = 'b'.repeat(64);
	const failed = journal.start(scope, { note, direction: 'receive' }); journal.update(failed, { status: 'failed' });
	const skipped = journal.start(scope, { note, direction: 'receive' }); journal.update(skipped, { status: 'skipped', skipReason: 'desktop-plugin' });
	const restored = new TaskJournal(journal.snapshot());
	assert.equal(restored.rows[0].status, 'resolved'); assert.equal(restored.rows[1].skipReason, 'desktop-plugin');
	assert.match(restored.message(restored.rows[1]), /仅支持电脑/); assert.equal(restored.canRetry(restored.rows[1], scope), false);
});

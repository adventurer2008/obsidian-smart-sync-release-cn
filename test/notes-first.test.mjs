import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NotebookSynchronizer, IncrementalInventory, emptyState } from '../src/synchronizer.js';
import { freshSalt, unlockWorkspace, packNote, inspectNote } from '../src/codec.js';

const keys = await unlockWorkspace('synthetic notes before attachments', freshSalt());
const workspace = 'synthetic-notes-first', mtime = 1700000000123;
const bytes = text => new TextEncoder().encode(text);

function fixture(batch) {
	const objects = new Map(), entries = [], files = new Map(), times = new Map(), events = [];
	let durable = emptyState();
	const api = { workspace,
		feed: async after => ({ entries: entries.filter(entry => entry.sequence > after), more: false }),
		load: async address => { events.push(['load', address]); assert.ok(objects.has(address)); return objects.get(address); },
		store: async object => objects.set(object.address, object.body),
		loadBatch: async addresses => new Map(await Promise.all(addresses.map(async address => [address, await api.load(address)]))),
		storeBatch: async values => { for (const object of values) await api.store(object); },
		commit: async (note, input) => {
			assert.equal(entries.findLast(entry => entry.note === note)?.sequence ?? 0, input.expected);
			const entry = { note, manifest: input.manifest, removed: input.removed, sequence: entries.length + 1 };
			entries.push(entry);
			const info = await inspectNote(keys, workspace, note, input.manifest, address => objects.get(address));
			events.push(['send', info.path]); return entry;
		},
		commitBatch: async inputs => ({ entries: await Promise.all(inputs.map(input => api.commit(input.note, input))) })
	};
	const host = { list: async () => [...files.keys()], read: async path => files.get(path) ?? null,
		mtime: async path => times.get(path), stamp: async path => files.has(path) ? `${times.get(path)}:${files.get(path).join(',')}` : undefined,
		write: async (path, body, time) => { events.push(['receive', path]); files.set(path, body); times.set(path, time); },
		remove: async path => { files.delete(path); times.delete(path); } };
	return { api, host, files, times, events, entries, objects,
		set(path, text, time = mtime) { files.set(path, bytes(text)); times.set(path, time); },
		async add(path, text, id) {
			const packet = await packNote(keys, workspace, path, bytes(text), undefined, id, 'file', mtime);
			for (const object of packet.objects) objects.set(object.address, object.body);
			entries.push({ note: packet.id, manifest: packet.manifest, removed: false, sequence: entries.length + 1 });
			return packet;
		},
		engine(options = {}) { return new NotebookSynchronizer({ api, host, keys, state: structuredClone(durable),
			batchTransfer: batch, batchFiles: 2, checkpointSize: 1,
			save: async state => { durable = structuredClone(state); }, ...options }); },
		durable: () => structuredClone(durable)
	};
}

for (const batch of [false, true]) {
	test(`notes first: ${batch ? 'batch' : 'ordinary'} full and incremental downloads preserve bytes and source time`, async () => {
		const f = fixture(batch);
		const attachment = await f.add('a.bin', 'attachment');
		const note = await f.add('folder/NOTE.MD', 'note');
		await f.add('b.pdf', 'pdf'); await f.add('second.md', 'second');
		await f.engine({ direction: 'receive' }).run();
		assert.deepEqual(f.events.filter(([kind]) => kind === 'receive').map(([, path]) => path), ['folder/NOTE.MD', 'second.md', 'a.bin', 'b.pdf']);
		for (const [path, text] of [['a.bin', 'attachment'], ['folder/NOTE.MD', 'note'], ['b.pdf', 'pdf'], ['second.md', 'second']]) {
			assert.deepEqual(f.files.get(path), bytes(text)); assert.equal(f.times.get(path), mtime);
		}
		f.events.length = 0;
		await f.add('a.bin', 'changed attachment', attachment.id);
		await f.add('folder/NOTE.MD', 'changed note', note.id);
		await f.engine({ direction: 'receive' }).run();
		assert.deepEqual(f.events.filter(([kind]) => kind === 'receive').map(([, path]) => path), ['folder/NOTE.MD', 'a.bin']);
		assert.equal(f.durable().cursor, 6); assert.deepEqual(f.durable().pendingReceives ?? {}, {});
	});

	test(`notes first: ${batch ? 'batch' : 'ordinary'} uploads and inventory deltas commit notes before attachments`, async () => {
		const f = fixture(batch), inventory = new IncrementalInventory();
		f.set('a.bin', 'attachment'); f.set('NOTE.MD', 'note'); f.set('b.pdf', 'pdf'); f.set('second.md', 'second');
		await f.engine({ direction: 'send', incrementalInventory: inventory, scanPolicy: 'test' }).run();
		assert.deepEqual(f.events.filter(([kind]) => kind === 'send').map(([, path]) => path), ['NOTE.MD', 'second.md', 'a.bin', 'b.pdf']);
		f.events.length = 0;
		f.set('a.bin', 'changed attachment', mtime + 100); inventory.changed('modify', 'a.bin');
		f.set('NOTE.MD', 'changed note', mtime + 100); inventory.changed('modify', 'NOTE.MD');
		await f.engine({ direction: 'send', incrementalInventory: inventory, scanPolicy: 'test' }).run();
		assert.deepEqual(f.events.filter(([kind]) => kind === 'send').map(([, path]) => path), ['NOTE.MD', 'a.bin']);
		const received = fixture(batch); received.api.feed = f.api.feed; received.api.load = f.api.load; received.api.loadBatch = f.api.loadBatch;
		await received.engine({ direction: 'receive' }).run();
		for (const [path, body] of f.files) { assert.deepEqual(received.files.get(path), body); assert.equal(received.times.get(path), f.times.get(path)); }
	});
}

test('reordered cursor survives cancellation and process replacement without losing the earlier attachment', async () => {
	const f = fixture(true), attachment = await f.add('first.bin', 'attachment');
	await f.add('last.md', 'note');
	const controller = new AbortController(); f.api.signal = controller.signal;
	const engine = f.engine({ direction: 'receive', onTask: async event => {
		if (event.status === 'done' && event.path === 'last.md') controller.abort(new DOMException('stop after note checkpoint', 'AbortError'));
	} });
	await assert.rejects(engine.run(), { name: 'AbortError' });
	assert.equal(f.durable().cursor, 2); assert.equal(f.durable().pendingReceives[attachment.id].sequence, 1);
	assert.equal(f.files.has('first.bin'), false); assert.deepEqual(f.files.get('last.md'), bytes('note'));
	f.api.signal = undefined; f.events.length = 0;
	await f.engine({ direction: 'receive' }).run();
	assert.deepEqual(f.events.filter(([kind]) => kind === 'receive'), [['receive', 'first.bin']]);
	assert.equal(f.times.get('first.bin'), mtime); assert.deepEqual(f.durable().pendingReceives, {});
});

test('failed note remains retryable while attachments finish; checkpoint failure prevents reordered writes', async () => {
	const f = fixture(false); await f.add('first.bin', 'attachment'); const note = await f.add('last.md', 'note');
	const write = f.host.write;
	f.host.write = async (...args) => { if (args[0] === 'last.md') throw Error('synthetic note write failed'); await write(...args); };
	await assert.rejects(f.engine({ direction: 'receive' }).run(), error => error.pendingReceiveCount === 1);
	assert.deepEqual(f.files.get('first.bin'), bytes('attachment')); assert.ok(f.durable().pendingReceives[note.id]);
	f.host.write = write; await f.engine({ direction: 'receive' }).run(); assert.deepEqual(f.durable().pendingReceives, {});
	const g = fixture(false); await g.add('first.bin', 'attachment'); await g.add('last.md', 'note');
	await assert.rejects(g.engine({ direction: 'receive', save: async () => { throw Error('checkpoint failed'); } }).run(), /checkpoint failed/);
	assert.equal(g.files.size, 0); assert.equal(g.durable().cursor, 0);
});

test('bidirectional synchronization commits local notes before downloading remote attachment bodies', async () => {
	const f = fixture(true), attachment = await f.add('remote.bin', 'remote attachment');
	await f.add('remote.md', 'remote note'); f.set('local.md', 'local note');
	await f.engine().run();
	const sent = f.events.findIndex(([kind, path]) => kind === 'send' && path === 'local.md');
	const body = attachment.objects.find(object => object.address !== attachment.manifest).address;
	assert.ok(sent >= 0); assert.ok(f.events.findIndex(([kind, address]) => kind === 'load' && address === body) > sent);
	assert.equal(f.times.get('remote.bin'), mtime); assert.equal(f.times.get('local.md'), mtime);
});

test('a new local Markdown edit interrupts attachment work at the next file boundary', async () => {
	const f = fixture(true), priorities = new Map();
	await f.add('first.bin', 'first'); await f.add('second.bin', 'second');
	await f.engine({ contentPriorities: priorities, onTask: async event => {
		if (event.status === 'done' && event.path === 'first.bin') {
			f.set('new.md', 'new note', mtime + 100); priorities.set('new.md', 1);
		}
	} }).run();
	const transferred = f.events.filter(([kind]) => ['send', 'receive'].includes(kind));
	assert.deepEqual(transferred, [['receive', 'first.bin'], ['send', 'new.md'], ['receive', 'second.bin']]);
	assert.equal(priorities.size, 0); assert.equal(f.times.get('new.md'), mtime + 100);
});

test('bounded classification reuses verified manifests without a second metadata decryption', async () => {
	const f = fixture(true);
	for (let i = 0; i < 24; i++) await f.add(`note-${i}.md`, `body ${i}`);
	const decrypt = crypto.subtle.decrypt.bind(crypto.subtle); let decryptions = 0;
	crypto.subtle.decrypt = async (...args) => { decryptions++; return decrypt(...args); };
	try { await f.engine({ direction: 'receive', batchFiles: 32 }).run(); }
	finally { crypto.subtle.decrypt = decrypt; }
	assert.equal(f.files.size, 24); assert.ok(decryptions <= 48, `repeated metadata decryptions: ${decryptions}`);
	for (let i = 0; i < 24; i++) { assert.deepEqual(f.files.get(`note-${i}.md`), bytes(`body ${i}`)); assert.equal(f.times.get(`note-${i}.md`), mtime); }
});

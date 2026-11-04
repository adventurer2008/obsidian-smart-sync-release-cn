import assert from 'node:assert/strict';
import { test } from 'node:test';
import { freshSalt, unlockWorkspace, packNote } from '../src/codec.js';
import { NotebookSynchronizer, emptyState } from '../src/synchronizer.js';

const keys = await unlockWorkspace('synthetic small file read ahead', freshSalt());
const workspace = 'synthetic-batch-ahead', mtime = 1577836800123;
async function fixture({ count = 6, batchFiles = 2, mixed = false } = {}) {
	const packets = [];
	for (let i = 0; i < count; i++) {
		const bytes = mixed ? new Uint8Array(1 + (i * 7919) % 32768) : new Uint8Array([i % 256, 2, 3]);
		if (mixed) for (let j = 0; j < bytes.length; j++) bytes[j] = (i + j * 31) % 251;
		packets.push(await packNote(keys, workspace, `${i}.${mixed && i % 2 ? 'bin' : 'md'}`, bytes, undefined, undefined, 'file', mtime));
	}
	const objects = new Map(packets.flatMap(p => p.objects.map(o => [o.address, o.body])));
	const entries = packets.map((p, i) => ({ sequence: i + 1, note: p.id, manifest: p.manifest, removed: false }));
	const files = new Map(), times = new Map(), writes = [], saved = [];
	const api = { workspace, load: async address => objects.get(address),
		loadBatch: async (addresses, limit) => { const result = new Map(); let size = 0; for (const address of addresses) { const bytes = objects.get(address); if (size + bytes.length > limit) break; result.set(address, bytes); size += bytes.length; } return result; },
		feed: async after => ({ entries: entries.filter(e => e.sequence > after), more: false }) };
	const host = { list: async () => [...files.keys()], read: async name => files.get(name) ?? null,
		write: async (name, body, time) => { writes.push(name); files.set(name, body); times.set(name, time); } };
	const state = emptyState();
	const engine = new NotebookSynchronizer({ api, keys, host, state, direction: 'receive', batchTransfer: true, batchFiles,
		checkpointSize: 100, save: async next => { saved.push(structuredClone(next)); if (saved.length > 2) saved.shift(); } });
	return { engine, api, host, packets, files, times, writes, saved, state, objects, entries };
}

test('serial fallback retains a priority-inspected rename manifest without downloading it twice', async () => {
	const f = await fixture({ count: 1 });
	await f.engine.run();
	const original = f.files.get('0.md');
	const renamed = await packNote(keys, workspace, 'moved.bin', original, undefined, f.packets[0].id, 'file', mtime);
	for (const object of renamed.objects) f.objects.set(object.address, object.body);
	f.entries.push({ sequence: 2, note: renamed.id, manifest: renamed.manifest, removed: false });
	f.host.remove = async path => { f.files.delete(path); f.times.delete(path); };
	f.engine.batchTransfer = false;
	const load = f.api.load; let manifests = 0;
	f.api.load = async address => { if (address === renamed.manifest) manifests++; return load(address); };
	await f.engine.run();
	assert.equal(manifests, 1);
	assert.deepEqual(f.files.get('moved.bin'), original);
	assert.equal(f.times.get('moved.bin'), mtime);
	assert.equal(f.state.cursor, 2);
});

test('one next batch prepares while the current file write waits, without concurrent receive or advancing its cursor', async () => {
	const f = await fixture(); let release, ready, batches = 0;
	const gate = new Promise(resolve => { release = resolve; }), prefetched = new Promise(resolve => { ready = resolve; });
	const loadBatch = f.api.loadBatch, write = f.host.write;
	f.api.loadBatch = async (...args) => { const result = await loadBatch(...args); if (++batches === 4) ready(); return result; };
	let active = 0, peak = 0;
	f.host.write = async (...args) => { active++; peak = Math.max(peak, active); try { if (!f.writes.length) await gate; return await write(...args); } finally { active--; } };
	const run = f.engine.run();
	try {
		await prefetched;
		assert.equal(f.state.cursor, 0); assert.equal(f.files.size, 0); assert.equal(batches, 4);
	} finally { release(); }
	await run;
	assert.equal(peak, 1); assert.deepEqual(f.writes, ['0.md', '1.md', '2.md', '3.md', '4.md', '5.md']);
	for (let i = 0; i < 6; i++) { assert.deepEqual(f.files.get(`${i}.md`), new Uint8Array([i, 2, 3])); assert.equal(f.times.get(`${i}.md`), mtime); }
	assert.equal(f.state.cursor, 6); assert.equal(f.saved.at(-1).cursor, 6);
});

test('cancellation drains the pending batch before finishing and cannot write or checkpoint speculative files', async () => {
	const f = await fixture(), controller = new AbortController(); f.api.signal = controller.signal;
	let ready, release, settled = false, batches = 0;
	const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { ready = resolve; });
	const loadBatch = f.api.loadBatch, write = f.host.write;
	f.api.loadBatch = async (...args) => { if (++batches === 3) { ready(); await gate; } return loadBatch(...args); };
	f.host.write = async () => { await started; controller.abort(new DOMException('synthetic Stop', 'AbortError')); throw controller.signal.reason; };
	const run = f.engine.run().finally(() => { settled = true; });
	const failure = assert.rejects(run, { name: 'AbortError' });
	await started; await new Promise(resolve => setImmediate(resolve));
	assert.equal(settled, false); assert.equal(f.state.cursor, 0); assert.equal(f.files.size, 0);
	release(); await failure; assert.equal(f.files.size, 0);
	f.api.signal = new AbortController().signal; f.api.loadBatch = loadBatch; f.host.write = write;
	await f.engine.run(); assert.equal(f.state.cursor, 6); assert.equal(f.files.size, 6);
});

test('4096 synthetic small files cross many windows with serial writes, intact content/mtime and restart checkpoints', async () => {
	const f = await fixture({ count: 4096, batchFiles: 128 });
	await f.engine.run();
	assert.equal(f.state.cursor, 4096); assert.equal(f.files.size, 4096);
	for (let i = 0; i < 4096; i++) {
		assert.deepEqual(f.files.get(`${i}.md`), new Uint8Array([i % 256, 2, 3]));
		assert.equal(f.times.get(`${i}.md`), mtime);
	}
	const durable = f.saved.at(-1); assert.equal(durable.cursor, 4096);
	const resumed = new NotebookSynchronizer({ api: f.api, keys, host: f.host, state: structuredClone(durable), direction: 'receive',
		batchTransfer: true, batchFiles: 128, save: async () => {} });
	const before = f.writes.length; await resumed.run(); assert.equal(f.writes.length, before);
});

test('a speculative authorization failure cannot apply or checkpoint the next window', async () => {
	const f = await fixture(), loadBatch = f.api.loadBatch;
	f.api.loadBatch = async (addresses, limit) => {
		if (addresses.includes(f.packets[2].manifest)) throw Object.assign(Error('synthetic authorization fault'), { status: 403 });
		return loadBatch(addresses, limit);
	};
	await assert.rejects(f.engine.run(), /authorization fault/);
	assert.deepEqual(f.writes, ['0.md', '1.md']); assert.equal(f.state.cursor, 2);
	assert.ok(f.saved.every(s => s.cursor <= 2));
	// Ordinary retry resumes the continuous cursor, not the speculative window.
	f.api.loadBatch = loadBatch;
	await f.engine.run(); assert.equal(f.state.cursor, 6); assert.equal(f.files.size, 6);
});

test('2048 mixed-size notes and attachments preserve exact bytes, original mtime and ordered application', async () => {
	const f = await fixture({ count: 2048, batchFiles: 128, mixed: true });
	await f.engine.run();
	let total = 0;
	for (let i = 0; i < 2048; i++) {
		const name = `${i}.${i % 2 ? 'bin' : 'md'}`, actual = f.files.get(name);
		assert.equal(f.writes[i], name); assert.equal(actual.length, 1 + (i * 7919) % 32768);
		for (let j = 0; j < actual.length; j++) assert.equal(actual[j], (i + j * 31) % 251);
		assert.equal(f.times.get(name), mtime); total += actual.length;
	}
	assert.ok(total > 30 * 1024 * 1024); assert.equal(f.state.cursor, 2048);
});

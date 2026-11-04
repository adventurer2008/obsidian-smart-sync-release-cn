globalThis.window ??= globalThis;
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LanPeers, intersectDirection } from '../src/peers.js';
import { fingerprint } from '../src/codec.js';

test('starting a cycle waits for an in-flight presence poll then refreshes changed remote restrictions', async t => {
	let release, entered, calls = 0;
	const ready = new Promise(resolve => { entered = resolve; });
	const hold = new Promise(resolve => { release = resolve; });
	const peers = new LanPeers({ workspace: 'synthetic', request: async () => {
		calls++;
		if (calls === 1) { entered(); await hold; return { id: 'device', mode: 'both', peers: [] }; }
		return { id: 'device', mode: 'paused', peers: [] };
	} }, { enabled: false });
	t.after(() => { release(); peers.close(); });
	const previous = peers.tick(); await ready;
	const start = peers.start(); release();
	await previous; await start;
	assert.equal(peers.mode, 'paused'); assert.equal(calls, 2);
});

test('stuck WebRTC negotiation expires and closes the link for cloud fallback', async () => {
	let closed = 0;
	const peers = new LanPeers({});
	const link = { id: 'synthetic-timeout', pc: { close: () => { closed++; } } };
	peers.links.set(link.id, link);
	await assert.rejects(peers.negotiate(link, () => new Promise(() => {})), error => error.name === 'TimeoutError');
	assert.equal(closed, 1);
	assert.equal(peers.links.size, 0);
	peers.close();
});

test('closing peers or cancelling the cycle releases a stuck WebRTC offer without late signaling', async () => {
	for (const close of [true, false]) {
		const parent = new AbortController();
		let resolveOffer;
		let descriptions = 0;
		let requests = 0;
		let closed = 0;
		const peers = new LanPeers({ signal: parent.signal, request: async () => { requests++; } });
		const link = { id: 'synthetic-peer', pc: {
			createOffer: () => new Promise(resolve => { resolveOffer = resolve; }),
			setLocalDescription: async () => { descriptions++; },
			close: () => { closed++; },
		} };
		peers.links.set(link.id, link);
		const work = peers.describe(link, 'offer');
		await new Promise(resolve => setImmediate(resolve));
		if (close) peers.close();
		else parent.abort();
		await assert.rejects(work, error => error.name === 'AbortError');
		resolveOffer({ type: 'offer', sdp: '' });
		await new Promise(resolve => setImmediate(resolve));
		assert.equal(descriptions, 0);
		assert.equal(requests, 0);
		assert.equal(closed, 1);
		peers.close();
	}
});
test('peer object frames verify the complete digest, reject corruption and release pending transfers on disable', async () => {
	const a = new LanPeers({}),
		b = new LanPeers({});
	a.id = 'a';
	b.id = 'b';
	a.mode = b.mode = 'both';
	const left = {
			id: 'b',
			pc: { close() {} },
			channel: { readyState: 'open', bufferedAmount: 0, close() {} },
		},
		right = {
			id: 'a',
			pc: { close() {} },
			channel: { readyState: 'open', bufferedAmount: 0, close() {} },
		};
	left.channel.send = (raw) => queueMicrotask(() => void b.message(right, raw));
	right.channel.send = (raw) => queueMicrotask(() => void a.message(left, raw));
	a.links.set('b', left);
	b.links.set('a', right);
	const body = new Uint8Array(96000);
	for (let offset = 0; offset < body.length; offset += 32000)
		crypto.getRandomValues(body.subarray(offset, offset + 32000));
	const address = await fingerprint(body);
	a.remember(address, body);
	assert.deepEqual(await b.load(address), body);
	assert.equal(b.pending.size, 0);
	// Force a fresh request rather than the newly reusable verified local cache.
	b.cache.clear(); b.cacheBytes = 0;
	a.cache.set(address, new Uint8Array(body.length));
	assert.equal(await b.load(address), null);
	a.cache.clear();
	assert.equal(await b.load(address), null);
	b.enabled = false;
	assert.equal(await b.load(address), null);
	a.close();
	b.close();
	assert.equal(a.cacheBytes, 0);
});
test('direction intersection never permits a forbidden transfer and keeps update-only restrictions', () => {
	assert.equal(intersectDirection('send', 'receive'), 'paused');
	assert.equal(intersectDirection('both', 'paused'), 'paused');
	assert.equal(intersectDirection('both', 'receive'), 'receive');
	assert.equal(intersectDirection('update', 'send'), 'update');
	assert.equal(intersectDirection('receive', 'both'), 'receive');
});

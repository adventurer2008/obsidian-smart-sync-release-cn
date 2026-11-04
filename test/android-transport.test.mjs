import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import { androidFallback, supportsAndroidNativeVersion } from '../src/android-transport.js';
import { WorkspaceApi } from '../src/client.js';
import { freshSalt, unlockWorkspace, packNote, unpackNote } from '../src/codec.js';

const origin = 'https://synthetic.invalid';
test('Android native release gate includes stable 1.1.2 and later without accepting unknown metadata', () => {
	for (const version of ['1.1.2', '1.1.2-alpha.10', '1.1.3', '1.2.0', '2.0.0', '1.1.3-alpha.1']) assert.equal(supportsAndroidNativeVersion(version), true, version);
	for (const version of [undefined, null, false, {}, '', 'synthetic QA', '1.1.1', '0.9.9-alpha.1', '01.1.2', '1.1.2-alpha.0', '1.1.2-alpha.01', '1.1.2-beta.1', '1.1.2+unknown', '999999999999999999999.1.2']) assert.equal(supportsAndroidNativeVersion(version), false, String(version));
});
const tick = () => new Promise(resolve => setImmediate(resolve));
const bytes = value => new TextEncoder().encode(JSON.stringify(value)).buffer;
function fixture(options = {}) {
	const keys = generateKeyPairSync('ed25519');
	const key = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
	const calls = [], pins = [];
	const fetcher = options.fetcher ?? (async (url, init) => { calls.push({ kind: 'fetch', url, init }); throw TypeError('synthetic connection reset'); });
	const requestUrl = async init => {
		calls.push({ kind: 'native', init });
		const url = new URL(init.url);
		if (url.pathname === '/ss2/identity') {
			const nonce = url.searchParams.get('nonce');
			const signature = sign(null, Buffer.from(`smart-sync-service-identity:2:${origin}:${nonce}`), keys.privateKey).toString('base64');
			return { status: 200, headers: { 'content-type': 'application/json' }, arrayBuffer: bytes({ origin, nonce, key, signature: options.badSignature ? 'AAAA' : signature }) };
		}
		return options.handler?.(init) ?? { status: 200, headers: { 'content-type': 'application/json' }, arrayBuffer: bytes({ ok: true }) };
	};
	const transport = androidFallback({ android: true, origin, fetcher, requestUrl, getPin: () => options.pin, savePin: async value => pins.push(value) });
	return { transport, calls, pins, key, requestUrl, fetcher };
}
test('non-Android hosts, HTTP development and missing native API retain the original function', () => {
	const fetcher = () => {};
	for (const config of [{ android: false }, { android: true, requestUrl: undefined }, { android: true, origin: 'http://127.0.0.1:14809' }])
		assert.equal(androidFallback({ android: true, origin, requestUrl: () => {}, fetcher, ...config }), fetcher);
});
test('healthy Android fetch never probes native or persists route state', async () => {
	const response = new Response('{}');
	const f = fixture({ fetcher: async () => response });
	assert.equal(await f.transport(`${origin}/ss2/account`), response);
	assert.equal(f.calls.length, 0); assert.equal(f.pins.length, 0);
});
test('network failure selects native only after a signed credential-free identity proof', async () => {
	const f = fixture();
	const reply = await f.transport(`${origin}/ss2/account`, { headers: { authorization: 'Bearer synthetic' } });
	assert.equal((await reply.json()).ok, true);
	assert.equal(f.pins[0], f.key);
	const native = f.calls.filter(c => c.kind === 'native');
	assert.equal(native.length, 2);
	assert.equal(native[0].init.headers.authorization, undefined);
	assert.equal(native[1].init.headers.authorization, 'Bearer synthetic');
});
test('HTTP failures never select native', async () => {
	for (const status of [401, 403, 409, 429, 500, 503]) {
		const f = fixture({ fetcher: async () => new Response('{}', { status }) });
		assert.equal((await f.transport(`${origin}/ss2/account`)).status, status);
		assert.equal(f.calls.length, 0);
	}
});
test('invalid signatures and a different pinned authority fail closed', async () => {
	for (const options of [{ badSignature: true }, { pin: 'different-synthetic-key' }]) {
		const f = fixture(options);
		await assert.rejects(f.transport(`${origin}/ss2/account`));
		assert.equal(f.pins.length, 0);
		assert.equal(f.calls.filter(c => c.kind === 'native').length, 1);
	}
});
test('failed POST/PUT/DELETE are never replayed by fallback; only a later call uses native', async () => {
	for (const method of ['POST', 'PUT', 'DELETE']) {
		const f = fixture();
		await assert.rejects(f.transport(`${origin}/ss2/workspaces`, { method, body: '{}' }), /connection reset/);
		assert.equal(f.calls.filter(c => c.kind === 'native' && c.init.method !== 'GET').length, 0);
		await f.transport(`${origin}/ss2/workspaces`, { method, body: '{}' });
		assert.equal(f.calls.filter(c => c.kind === 'native' && c.init.method === method).length, 1);
	}
});
test('parent cancellation and non-network errors never trigger fallback', async () => {
	const controller = new AbortController(); controller.abort();
	const f = fixture();
	await assert.rejects(f.transport(`${origin}/ss2/account`, { signal: controller.signal }), e => e.name === 'AbortError');
	assert.equal(f.calls.length, 0);
	const other = fixture({ fetcher: async () => { throw Error('synthetic validation failure'); } });
	await assert.rejects(other.transport(`${origin}/ss2/account`), /validation/);
	assert.equal(other.calls.length, 0);
});
test('LAN/other origins and non-API paths do not enter the native path', async () => {
	const f = fixture();
	for (const url of ['https://lan.synthetic.invalid/ss2/account', `${origin}/download/file`])
		await assert.rejects(f.transport(url), /connection reset/);
	assert.equal(f.calls.filter(c => c.kind === 'native').length, 0);
});
test('native body conversion preserves typed-array slices and handles empty responses', async () => {
	let observed;
	const f = fixture({ handler: init => { observed = init; return { status: 204, headers: {}, arrayBuffer: new ArrayBuffer(0) }; } });
	await f.transport(`${origin}/ss2/account`);
	const data = new Uint8Array([99, 1, 2, 88]);
	const response = await f.transport(`${origin}/ss2/objects`, { method: 'PUT', body: data.subarray(1, 3) });
	assert.deepEqual(new Uint8Array(observed.body), new Uint8Array([1, 2]));
	assert.equal(response.status, 204); assert.equal(response.body, null);
});
test('visible redirects, foreign final URL and oversized buffered replies are rejected', async () => {
	for (const reply of [{ status: 302, headers: {}, arrayBuffer: bytes({}) }, { status: 200, url: 'https://other.invalid/', headers: {}, arrayBuffer: bytes({}) }, { status: 200, headers: {}, arrayBuffer: new ArrayBuffer(8 * 1024 * 1024 + 1) }]) {
		const f = fixture({ handler: () => reply });
		await assert.rejects(f.transport(`${origin}/ss2/account`));
	}
});
test('concurrent failures deduplicate identity probing', async () => {
	const f = fixture();
	await Promise.all(Array.from({ length: 8 }, () => f.transport(`${origin}/ss2/account`)));
	assert.equal(f.calls.filter(c => c.kind === 'native' && c.init.url.includes('/identity?')).length, 1);
});
test('diagnostics include bounded runtime/version markers but never request credentials or bodies', async () => {
	const f = fixture();
	const events = [];
	const fetcher = androidFallback({ android: true, origin, fetcher: f.fetcher, requestUrl: f.requestUrl,
		onDiagnostic: event => events.push(event), runtime: { obsidian: '1.14.4', plugin: '1.1.2-alpha.9', webViewChromium: '130.0' } });
	await fetcher(`${origin}/ss2/account`, { headers: { authorization: 'Bearer secret-must-not-be-logged' } });
	assert.deepEqual(events.map(event => event.stage), ['primary-network-failed', 'native-probe-start', 'native-selected']);
	assert.equal(events[2].runtime.obsidian, '1.14.4');
	assert.equal(events[2].runtime.webViewChromium, '130.0');
	assert.equal(JSON.stringify(events).includes('secret-must-not-be-logged'), false);
	assert.match(f.calls.find(call => call.kind === 'native').init.headers['x-smart-sync-probe'], /^ss2a9-[a-f0-9-]{36}$/);
});
test('cancelled native work retains its slot until settlement, limiting late operations to four', async () => {
	const pending = [];
	const f = fixture({ handler: () => new Promise(resolve => pending.push(resolve)) });
	// Select without starting a business request.
	await assert.rejects(f.transport(`${origin}/ss2/workspaces`, { method: 'POST' }));
	const controls = Array.from({ length: 6 }, () => new AbortController());
	const tasks = controls.map(control => f.transport(`${origin}/ss2/account`, { signal: control.signal }).catch(error => error));
	await tick(); assert.equal(pending.length, 4);
	controls.forEach(control => control.abort());
	const errors = await Promise.all(tasks); assert.ok(errors.every(error => error.name === 'AbortError'));
	assert.equal(pending.length, 4);
	pending.forEach(resolve => resolve({ status: 200, headers: {}, arrayBuffer: bytes({}) }));
	await tick();
	assert.equal(pending.length, 4);
});
test('encrypted objects roundtrip through native WorkspaceApi retaining body and source mtime', async () => {
	const objects = new Map();
	const f = fixture({ handler: init => {
		const address = new URL(init.url).pathname.split('/').at(-1);
		if (init.method === 'PUT') { objects.set(address, init.body); return { status: 200, headers: {}, arrayBuffer: bytes({ saved: true }) }; }
		return { status: 200, headers: { 'content-type': 'application/octet-stream', 'content-encoding': 'gzip' }, arrayBuffer: objects.get(address) };
	} });
	await assert.rejects(f.transport(`${origin}/ss2/workspaces`, { method: 'POST' }));
	const workspace = 'a'.repeat(36), keys = await unlockWorkspace('synthetic android passphrase', freshSalt());
	const body = new TextEncoder().encode('Android native encrypted body '.repeat(200));
	const packed = await packNote(keys, workspace, 'synthetic.md', body, undefined, undefined, 'file', 1577836800123);
	const api = new WorkspaceApi(origin, 'synthetic-access', workspace, f.transport);
	for (const object of packed.objects) await api.store(object);
	const unpacked = await unpackNote(keys, workspace, packed.id, packed.manifest, address => api.load(address));
	assert.deepEqual(unpacked.contents, body);
	const { inspectNote } = await import('../src/codec.js');
	assert.equal((await inspectNote(keys, workspace, packed.id, packed.manifest, address => api.load(address))).mtime, 1577836800123);
});

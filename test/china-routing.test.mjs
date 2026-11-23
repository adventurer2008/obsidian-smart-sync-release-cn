import { strict as assert } from 'node:assert';
import { generateKeyPairSync, sign } from 'node:crypto';
import { test } from 'node:test';
import { chinaIdentityTimeout, chinaSyncFetch, chinaSyncOrigin, routedFetch } from '../src/routing.js';

const first = 'https://key.106-15-232-208.sslip.io';
const second = 'https://new.106-15-232-208.sslip.io';
const api = chinaSyncOrigin + '/ss2/account';
const keys = generateKeyPairSync('ed25519');
const key = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

function fixture({ preferred, unavailable = new Set(), stalled = new Set(), untrusted, request = () => Response.json({ ok: true }) } = {}) {
	const calls = [], saved = [];
	const fetcher = chinaSyncFetch({
		getPreferred: () => preferred,
		getPin: () => key,
		savePreferred: async origin => { saved.push(origin); },
		fetchFor: origin => async (url, init) => {
			const target = new URL(url);
			assert.equal(target.origin, origin);
			const proof = target.pathname === '/ss2/identity';
			calls.push([origin, proof ? 'proof' : init.method]);
			if (stalled.has(origin)) return new Promise((_, reject) => {
				init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
			});
			if (unavailable.has(origin)) throw new TypeError('unreachable');
			if (!proof) return request(origin, init);
			assert.equal(init.headers, undefined);
			const nonce = target.searchParams.get('nonce');
			assert.equal(target.searchParams.get('audience'), chinaSyncOrigin);
			const signature = sign(null, Buffer.from(`smart-sync-service-identity:2:${chinaSyncOrigin}:${nonce}`), keys.privateKey).toString('base64');
			return Response.json({ origin: chinaSyncOrigin, key: origin === untrusted ? 'incorrect' : key, signature });
		},
	});
	return { calls, saved, fetcher };
}

test('remembers the working host across instances and skips an untrusted backup', async () => {
	const route = fixture({ unavailable: new Set([chinaSyncOrigin]), untrusted: first });
	assert.equal((await route.fetcher(api, { method: 'GET', headers: { authorization: 'Bearer synthetic' } })).status, 200);
	assert.deepEqual(route.calls, [[chinaSyncOrigin, 'proof'], [first, 'proof'], [second, 'proof'], [second, 'GET']]);
	assert.deepEqual(route.saved, [second]);
	const restart = fixture({ preferred: route.saved[0] });
	await restart.fetcher(api, { method: 'GET' });
	await restart.fetcher(api, { method: 'GET' });
	assert.deepEqual(restart.calls, [[second, 'proof'], [second, 'GET'], [second, 'GET']]);
});

test('the connection identity deadline leaves time for the third host after two DNS stalls', async () => {
	const route = fixture({ stalled: new Set([chinaSyncOrigin, first]) });
	const transport = await routedFetch({ origin: chinaSyncOrigin, pinned: key, fetcher: route.fetcher, identityTimeout: chinaIdentityTimeout });
	assert.equal(transport.key, key);
	await transport.fetcher(api, { method: 'GET' });
	assert.deepEqual(route.calls.slice(0, 3), [[chinaSyncOrigin, 'proof'], [first, 'proof'], [second, 'proof']]);
	assert.deepEqual(route.calls.at(-1), [second, 'GET']);
});

test('failed writes are not replayed and 401 does not change the route', async () => {
	const route = fixture({ preferred: first, request(origin, init) {
		if (init.method === 'POST') throw new TypeError('response lost after submission');
		return new Response(null, { status: 401 });
	} });
	await assert.rejects(route.fetcher(api, { method: 'POST' }), /response lost/);
	assert.deepEqual(route.calls, [[first, 'proof'], [first, 'POST']]);
	assert.equal((await route.fetcher(api, { method: 'GET' })).status, 401);
	assert.deepEqual(route.calls.slice(2), [[second, 'proof'], [second, 'GET']]);
	await route.fetcher(api, { method: 'GET' });
	assert.deepEqual(route.calls.at(-1), [second, 'GET']);
});

test('a transient gateway response switches only safe reads', async () => {
	const route = fixture({ preferred: first, request(origin) {
		return new Response(null, { status: origin === first ? 503 : 200 });
	} });
	assert.equal((await route.fetcher(api, { method: 'GET' })).status, 200);
	assert.deepEqual(route.calls, [[first, 'proof'], [first, 'GET'], [second, 'proof'], [second, 'GET']]);
	assert.deepEqual(route.saved, [second]);
});

import { responseBytes, withCancellation, fetchWithDeadline, waitForSignal } from './client.js';
import { verifyIdentitySignature } from './compatibility.js';
import { base64, unbase64 } from './codec.js';

export function serviceOrigin(value) {
	const url = new URL(value);
	if (
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.pathname !== '/' ||
		(url.protocol !== 'https:' &&
			!(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
	)
		throw new Error('Use HTTPS outside loopback; LAN HTTP cannot protect access credentials');
	return url.origin;
}
const message = (nonce, origin) =>
	new TextEncoder().encode(`smart-sync-service-identity:2:${origin}:${nonce}`);
export async function verifyService(origin, pinned, fetcher = fetch, timeout = 1500, parentSignal, audience = origin) {
	return withCancellation([parentSignal], timeout, async signal => {
		const nonce = base64(crypto.getRandomValues(new Uint8Array(24)));
		const response = await waitForSignal(fetcher(
			`${origin}/ss2/identity?nonce=${encodeURIComponent(nonce)}&audience=${encodeURIComponent(audience)}`,
			{
				redirect: 'error',
				signal,
			},
		), signal, reply => reply.body?.cancel());
		if (!response.ok) {
			void response.body?.cancel().catch(() => {});
			throw new Error('Service identity unavailable');
		}
		const proof = JSON.parse(
			new TextDecoder('utf8', { fatal: true }).decode(await responseBytes(response, 4096, undefined, signal)),
		);
		if (
			proof.origin !== audience ||
			typeof proof.key !== 'string' ||
			proof.key.length > 256 ||
			(pinned && proof.key !== pinned)
		)
			throw new Error('Service identity differs from the pinned authority');
		if (!(await verifyIdentitySignature(unbase64(proof.key), unbase64(proof.signature), message(nonce, audience))))
			throw new Error('Service identity proof rejected');
		return proof.key;
	});
}

export const chinaSyncOrigin = 'https://sync.wujiesync.cc';
export const chinaIdentityTimeout = 10000;
const chinaSyncAlternates = ['https://key.106-15-232-208.sslip.io', 'https://new.106-15-232-208.sslip.io'];
export const chinaAuthority = 'MCowBQYDK2VwAyEAlfM2lPY0TzCXT+VTzNkJTxjtge6uwN5YRf042oOyqfI=';
const gatewayUnavailable = new Set([502, 503, 504]);

export function chinaSyncFetch({ fetchFor, getPin, getPreferred, savePreferred }) {
	const origins = [chinaSyncOrigin, ...chinaSyncAlternates];
	const verifiedUntil = new Map(), unavailableUntil = new Map();
	let selected = origins.includes(getPreferred()) ? getPreferred() : chinaSyncOrigin;
	let selection = 0;
	function unavailable(origin) {
		verifiedUntil.delete(origin);
		if (selected === origin && (unavailableUntil.get(origin) ?? 0) <= Date.now()) selection++;
		unavailableUntil.set(origin, Date.now() + 15000);
	}
	return async (url, options = {}) => {
		const target = new URL(url);
		// Keep the configured LAN route and its existing verification separate.
		if (target.origin !== chinaSyncOrigin) return fetchFor(chinaSyncOrigin)(url, options);
		if (!target.pathname.startsWith('/ss2/')) throw new Error('Request left the synchronization API');
		const start = origins.indexOf(selected);
		const order = [...origins.slice(start), ...origins.slice(0, start)];
		const available = order.filter(origin => (unavailableUntil.get(origin) ?? 0) <= Date.now());
		const candidates = available.length ? available : order;
		const read = /^(?:GET|HEAD)$/.test(options.method ?? 'GET');
		let lastError;
		for (const origin of candidates) {
			const revision = selection;
			const transport = fetchFor(origin);
			if (options.signal?.aborted) throw options.signal.reason;
			try {
				const pin = getPin() ?? (origin === chinaSyncOrigin ? undefined : chinaAuthority);
				const verified = verifiedUntil.get(origin);
				if (!verified || verified.pin !== pin || verified.until <= Date.now()) {
					await verifyService(origin, pin, transport, 2800, options.signal, chinaSyncOrigin);
					verifiedUntil.set(origin, { pin, until: Date.now() + 20000 });
				}
			} catch (error) {
				if (options.signal?.aborted) throw options.signal.reason;
				unavailable(origin);
				lastError = error;
				continue;
			}
			let response;
			try {
				response = await transport(origin + target.pathname + target.search, { ...options, redirect: 'error' });
			} catch (error) {
				if (options.signal?.aborted) throw options.signal.reason;
				if (!(error instanceof TypeError) && !['TimeoutError', 'NetworkError'].includes(error?.name)) throw error;
				unavailable(origin);
				if (!read) throw error;
				lastError = error;
				continue;
			}
			if (gatewayUnavailable.has(response.status)) {
				unavailable(origin);
				if (!read || origin === candidates[candidates.length - 1]) return response;
				void response.body?.cancel().catch(() => {});
				lastError = new Error(`Synchronization gateway unavailable (${response.status})`);
				continue;
			}
			if (!options.signal?.aborted && revision === selection && origin !== selected) {
				selected = origin;
				selection++;
				void Promise.resolve().then(() => savePreferred(origin)).catch(() => {});
			}
			return response;
		}
		throw lastError ?? new Error('Synchronization service unavailable');
	};
}
export async function routedFetch({
	origin,
	lan,
	pinned,
	savePin = async () => {},
	fetcher = fetch,
	signal,
	identityTimeout = 5000,
}) {
	origin = serviceOrigin(origin);
	const pin = pinned ?? (await verifyService(origin, undefined, fetcher, identityTimeout, signal));
	if (!pinned) await savePin(pin);
	let preferred;
	if (lan) {
		try {
			preferred = serviceOrigin(lan);
			await verifyService(preferred, pin, fetcher, 1500, signal);
		} catch {
			if (signal?.aborted) throw signal.reason;
			preferred = undefined;
		}
	}
	if (!preferred && pinned) await verifyService(origin, pin, fetcher, identityTimeout, signal);
	const request = async (url, options) => {
		if (!url.startsWith(`${origin}/`)) throw new Error('Request left the configured authority');
		if (preferred) {
			try {
				const reply = await fetchWithDeadline(fetcher, `${preferred}${url.slice(origin.length)}`, {
					...options,
					redirect: 'error',
				}, 3500);
				if (![502, 503, 504].includes(reply.status) || !['GET', 'PUT'].includes(options.method))
					return reply;
				await reply.body?.cancel();
			} catch (error) {
				if (options.signal?.aborted || !['GET', 'PUT'].includes(options.method)) throw error;
			}
			preferred = undefined;
			await verifyService(origin, pin, fetcher, identityTimeout, options.signal);
		}
		return fetcher(url, options);
	};
	return { fetcher: request, key: pin, route: preferred ? 'lan' : 'primary' };
}

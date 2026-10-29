import { verifyService } from './routing.js';
import { waitForSignal } from './client.js';

// CHG-20261029-112-STABLE: promote the guarded Android path, not unknown builds.
export function supportsAndroidNativeVersion(version) {
	if (typeof version !== 'string') return false;
	const parsed = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-alpha\.[1-9]\d*)?$/.exec(version);
	if (!parsed) return false;
	const [major, minor, patch] = parsed.slice(1).map(Number);
	if (![major, minor, patch].every(Number.isSafeInteger)) return false;
	return major > 1 || (major === 1 && (minor > 1 || (minor === 1 && patch >= 2)));
}

// CHG-20261029-ANDROID-FALLBACK: memory-only, same-authority Android compatibility.
export function androidFallback({ android, origin, requestUrl, fetcher = fetch, getPin = () => undefined, savePin = async () => {}, onDiagnostic = () => {}, runtime = {} }) {
	if (!android || typeof requestUrl !== 'function' || new URL(origin).protocol !== 'https:') return fetcher;
	let native = false, selecting, active = 0;
	const traceId = crypto.randomUUID();
	let diagnosticRequests = 0;
	const safeRuntime = Object.fromEntries(['obsidian', 'plugin', 'webViewChromium'].map(key => [key, String(runtime[key] ?? '').slice(0, 512)]));
	const diagnostic = (stage, error, started = Date.now()) => {
		try { Promise.resolve(onDiagnostic({ stage, traceId, at: Date.now(), durationMs: Math.max(0, Date.now() - started), errorType: error ? String(error.name ?? 'Error').slice(0, 60) : '', runtime: safeRuntime })).catch(() => {}); } catch { /* Diagnostics must not interrupt synchronization. */ }
	};
	const waiting = [];
	const aborted = signal => {
		if (signal?.aborted) throw signal.reason ?? new DOMException('Cancelled', 'AbortError');
	};
	async function acquire(signal) {
		aborted(signal);
		if (active < 4) { active++; return; }
		let wake;
		const pending = new Promise(resolve => { wake = resolve; waiting.push(wake); });
		try { await waitForSignal(pending, signal); }
		catch (error) {
			const index = waiting.indexOf(wake);
			if (index >= 0) waiting.splice(index, 1);
			else release();
			throw error;
		}
	}
	function release() {
		const wake = waiting.shift();
		if (wake) wake(); else active--;
	}
	async function nativeFetch(url, options = {}) {
		const target = new URL(url);
		if (target.origin !== origin || target.username || target.password || target.hash || !target.pathname.startsWith('/ss2/'))
			throw Error('Native request left the configured authority');
		await acquire(options.signal);
		try { aborted(options.signal); } catch (error) { release(); throw error; }
		const headers = Object.fromEntries(new Headers(options.headers));
		if (diagnosticRequests++ < 20) {
			headers['x-smart-sync-probe'] = `ss2a9-${traceId}`;
			headers['x-smart-sync-runtime'] = encodeURIComponent(JSON.stringify(safeRuntime));
		}
		const body = options.body;
		if (body !== undefined && typeof body !== 'string' && !(body instanceof Uint8Array) && !(body instanceof ArrayBuffer)) {
			release(); throw Error('Unsupported native request body');
		}
		const work = Promise.resolve().then(() => requestUrl({
			url: target.href, method: options.method ?? 'GET', headers, throw: false,
			...(body === undefined ? {} : { body: body instanceof Uint8Array ? body.slice().buffer : body }),
		})).then(reply => {
			if (reply.status >= 300 && reply.status < 400) throw Error('Native service redirect rejected');
			if (reply.url && new URL(reply.url).origin !== origin) throw Error('Native response left the configured authority');
			const bytes = reply.arrayBuffer;
			if (!(bytes instanceof ArrayBuffer) || bytes.byteLength > 8 * 1024 * 1024) throw Error('Native response exceeds the transport limit');
			const responseHeaders = new Headers(reply.headers);
			responseHeaders.delete('content-encoding');
			responseHeaders.set('content-length', String(bytes.byteLength));
			return new Response([204, 205, 304].includes(reply.status) ? null : bytes, { status: reply.status, headers: responseHeaders });
		});
		// requestUrl cannot abort its underlying operation. Keep its slot until settlement,
		// ignore late results, and never replay a write because of caller cancellation.
		work.then(release, release);
		return waitForSignal(work, options.signal, response => response.body?.cancel());
	}
	async function select(signal) {
		const started = Date.now();
		diagnostic('native-probe-start');
		try {
			const pin = await verifyService(origin, getPin(), nativeFetch, 5000, signal);
			aborted(signal);
			if (!getPin()) await savePin(pin);
			aborted(signal);
			native = true;
			diagnostic('native-selected', undefined, started);
		} catch (error) { diagnostic('native-probe-failed', error, started); throw error; }
	}
	return async (url, options = {}) => {
		const target = new URL(url);
		if (target.origin !== origin || !target.pathname.startsWith('/ss2/')) return fetcher(url, options);
		aborted(options.signal);
		if (native) {
			const started = Date.now();
			try { return await nativeFetch(url, options); }
			catch (error) { if (!options.signal?.aborted) diagnostic('native-request-failed', error, started); throw error; }
		}
		try { return await fetcher(url, options); }
		catch (error) {
			aborted(options.signal);
			if (error?.name !== 'TypeError' && error?.name !== 'TimeoutError') throw error;
			diagnostic('primary-network-failed', error);
			// Only the signed, credential-free identity GET is probed/retried. A failed
			// write is returned to the existing recovery path without a second send.
			if (!selecting) {
				selecting = select(options.signal);
				selecting.finally(() => { selecting = undefined; }).catch(() => {});
			}
			await waitForSignal(selecting, options.signal);
			if ((options.method ?? 'GET') !== 'GET') throw error;
			return nativeFetch(url, options);
		}
	};
}

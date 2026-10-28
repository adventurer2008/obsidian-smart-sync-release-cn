// A scoped alternative to AbortSignal.any/timeout; supported on older mobile WebViews.
export function cancellationScope(signals = [], milliseconds) {
	if (milliseconds !== undefined && (!Number.isInteger(milliseconds) || milliseconds < 0 || milliseconds > 2147483647)) throw Error('Invalid cancellation deadline');
	const controller = new AbortController(), listeners = [];
	const schedule = typeof window === 'undefined' ? setTimeout : window.setTimeout.bind(window);
	const cancel = typeof window === 'undefined' ? clearTimeout : window.clearTimeout.bind(window);
	let timer;
	const dispose = () => {
		cancel(timer);
		for (const [signal, listener] of listeners.splice(0)) signal.removeEventListener('abort', listener);
	};
	const abort = reason => { if (!controller.signal.aborted) controller.abort(reason); dispose(); };
	for (const signal of new Set(signals.filter(Boolean))) {
		if (signal.aborted) { abort(signal.reason ?? new DOMException('Operation cancelled', 'AbortError')); break; }
		const listener = () => abort(signal.reason ?? new DOMException('Operation cancelled', 'AbortError'));
		signal.addEventListener('abort', listener, { once: true });
		listeners.push([signal, listener]);
	}
	if (!controller.signal.aborted && milliseconds !== undefined)
		timer = schedule(() => abort(new DOMException('Operation timed out', 'TimeoutError')), milliseconds);
	return { signal: controller.signal, dispose };
}
export function waitForSignal(work, signal, onLate = () => {}) {
	return new Promise((resolve, reject) => {
		let settled = false;
		const abort = () => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener('abort', abort);
			reject(signal.reason ?? new DOMException('Operation cancelled', 'AbortError'));
		};
		signal?.addEventListener('abort', abort, { once: true });
		if (signal?.aborted) abort();
		Promise.resolve(work).then(value => {
			if (settled) { Promise.resolve().then(() => onLate(value)).catch(() => {}); return; }
			settled = true;
			signal?.removeEventListener('abort', abort);
			resolve(value);
		}, error => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener('abort', abort);
			reject(error);
		});
	});
}
export async function withCancellation(signals, milliseconds, work) {
	const scope = cancellationScope(signals, milliseconds);
	try {
		if (scope.signal.aborted) throw scope.signal.reason ?? new DOMException('Operation cancelled', 'AbortError');
		return await waitForSignal(Promise.resolve().then(() => {
			if (scope.signal.aborted) throw scope.signal.reason;
			return work(scope.signal);
		}), scope.signal);
	} finally { scope.dispose(); }
}
// A routed fetch must keep cancellation alive until its response body is consumed.
export async function fetchWithDeadline(fetcher, url, options, milliseconds) {
	const scope = cancellationScope([options?.signal], milliseconds);
	try {
		if (scope.signal.aborted) throw scope.signal.reason ?? new DOMException('Operation cancelled', 'AbortError');
		const response = await waitForSignal(fetcher(url, { ...options, signal: scope.signal }), scope.signal, reply => reply.body?.cancel());
		if (!response.body) { scope.dispose(); return response; }
		const reader = response.body.getReader();
		const body = new ReadableStream({
			async pull(target) {
				try {
					const next = await waitForSignal(reader.read(), scope.signal);
					if (next.done) { scope.dispose(); target.close(); }
					else target.enqueue(next.value);
				} catch (error) { void reader.cancel(error).catch(() => {}); scope.dispose(); target.error(error); }
			},
			cancel(reason) { void reader.cancel(reason).catch(() => {}); scope.dispose(); },
		});
		return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
	} catch (error) { scope.dispose(); throw error; }
}

export const BATCH_BYTES = 8 * 1024 * 1024;
export function encodeObjectBatch(objects) {
	if (!Array.isArray(objects) || objects.length < 1 || objects.length > 256) throw Error('Invalid object batch count');
	if (objects.some(object => typeof object?.address !== 'string' || !/^[a-f0-9]{64}$/.test(object.address) || !(object.body instanceof Uint8Array) || object.body.length < 33 || object.body.length > 2 * 1024 * 1024) || new Set(objects.map(object => object.address)).size !== objects.length) throw Error('Invalid batch object');
	const header = new TextEncoder().encode(JSON.stringify(objects.map(object => ({ address: object.address, bytes: object.body.length }))));
	const size = 4 + header.length + objects.reduce((sum, object) => sum + object.body.length, 0);
	if (header.length > 128 * 1024 || size > BATCH_BYTES) throw Error('Object batch exceeds transport limit');
	const result = new Uint8Array(size);
	new DataView(result.buffer).setUint32(0, header.length);
	result.set(header, 4);
	let offset = 4 + header.length;
	for (const object of objects) { result.set(object.body, offset); offset += object.body.length; }
	return result;
}
export function decodeObjectBatch(bytes) {
	if (!(bytes instanceof Uint8Array) || bytes.length < 6 || bytes.length > BATCH_BYTES) throw Error('Invalid object batch size');
	const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
	if (length > 128 * 1024 || length + 4 > bytes.length) throw Error('Invalid object batch header');
	const entries = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes.subarray(4, 4 + length)));
	if (!Array.isArray(entries) || entries.length < 1 || entries.length > 256) throw Error('Invalid object batch count');
	let offset = 4 + length;
	const seen = new Set(), objects = [];
	for (const entry of entries) {
		if (typeof entry?.address !== 'string' || !/^[a-f0-9]{64}$/.test(entry.address) || seen.has(entry.address) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 33 || entry.bytes > 2 * 1024 * 1024 || offset + entry.bytes > bytes.length) throw Error('Invalid batch object');
		seen.add(entry.address);
		objects.push({ address: entry.address, body: bytes.subarray(offset, offset + entry.bytes) });
		offset += entry.bytes;
	}
	if (offset !== bytes.length) throw Error('Trailing object batch bytes');
	return objects;
}
export class ApiFault extends Error {
	constructor(status) {
		super(`Synchronization service returned HTTP ${status}`);
		this.status = status;
	}
}
export async function responseBytes(response, limit, onProgress = () => {}, signal) {
	if (Number(response.headers.get('content-length') ?? 0) > limit) {
		void response.body?.cancel().catch(() => {});
		throw new Error('Service response exceeds the allowed size');
	}
	const reader = response.body?.getReader();
	if (!reader) throw new Error('Service returned no response body');
	const chunks = [];
	let length = 0;
	try {
		for (;;) {
			const { value, done } = await waitForSignal(reader.read(), signal);
			if (done) break;
			length += value.length;
			if (length > limit) throw new Error('Service response exceeds the allowed size');
			chunks.push(value);
			onProgress({ loaded: length, total: Number(response.headers.get('content-length') ?? 0) });
		}
	} catch (error) {
		void reader.cancel().catch(() => {});
		throw error;
	}
	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.length;
	}
	return bytes;
}
export function failureMessage(error) {
	const messages = {
		401: 'Access key is invalid or revoked. Sign in again.',
		403: 'This device cannot perform this action.',
		404: 'The selected cloud notebook or version is unavailable.',
		409: 'Cloud state changed or a destination is occupied. Synchronize, review the destination and retry.',
		413: 'Storage quota or file size limit exceeded. Review usage.',
		429: 'Too many requests. Wait a minute before retrying.',
	};
	if (messages[error?.status]) return messages[error.status];
	if (error?.code === 'PIN_SERVICE_UPGRADE')
		return 'Upgrade the synchronization service to sync note positions. Local pin and bottom changes remain pending.';
	if (error?.code === 'RENAME_CONFLICT')
		return 'Rename conflict: both versions are preserved. Move aside the occupied destination or choose the same name on both devices, then retry.';
	if (error?.code === 'WRONG_NOTEBOOK_KEY')
		return 'Notebook encryption passphrase does not match. Enter the original notebook key.';
	if (error?.code === 'RESTORED_SERVICE')
		return 'The service was restored. Sign out and explicitly reconnect before replaying pending state.';
	if (error?.name === 'OperationError')
		return 'Encrypted data authentication failed. Check the notebook key and object integrity.';
	if (error instanceof TypeError || ['TimeoutError', 'AbortError'].includes(error?.name))
		return 'The synchronization service is unreachable. Local edits remain pending; check the address or network and retry.';
	return 'The operation stopped before completion. Check the selected notebook and service, then retry.';
}
export class WorkspaceApi {
	constructor(
		endpoint,
		accessKey,
		workspace = '',
		fetcher = (url, options) => fetch(url, options),
	) {
		const url = new URL(endpoint);
		if (
			url.protocol !== 'https:' &&
			!(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
		)
			throw new Error('Use HTTPS outside loopback connections');
		if (
			url.username ||
			url.password ||
			url.search ||
			url.hash ||
			(url.pathname !== '/' && url.pathname !== '')
		)
			throw new Error('Enter a service origin without credentials or a path');
		this.origin = url.origin;
		this.accessKey = accessKey;
		this.workspace = workspace;
		this.fetcher = fetcher;
	}
	async request(method, suffix, data, onProgress) {
		return withCancellation([this.signal], 30_000, async signal => {
			const binary = data instanceof Uint8Array;
		const response = await waitForSignal(this.fetcher(`${this.origin}/ss2/${suffix}`, {
				method,
				headers: {
					authorization: `Bearer ${this.accessKey}`,
					...(data === undefined
						? {}
						: { 'content-type': binary ? 'application/octet-stream' : 'application/json' }),
				},
				...(data === undefined ? {} : { body: binary ? data : JSON.stringify(data) }),
				signal,
				redirect: 'error',
		}), signal, reply => reply.body?.cancel());
		if (!response.ok) {
			void response.body?.cancel().catch(() => {});
			throw new ApiFault(response.status);
		}
		const isBinary = response.headers.get('content-type')?.startsWith('application/octet-stream'),
			limit = isBinary ? (suffix.endsWith('/objects/read') ? BATCH_BYTES : 2 * 1024 * 1024) : 1024 * 1024;
		const bytes = await responseBytes(response, limit, onProgress, signal);
		return isBinary ? bytes : JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes));
		});
	}
	workspaces() {
		return this.request('GET', 'workspaces');
	}
	create(label, salt, proof, createdDevice, accountWrapped) {
		return this.request('POST', 'workspaces', { label, salt, proof, createdDevice, ...(accountWrapped?{accountWrapped}:{}) });
	}
	info() {
		return this.request('GET', `workspaces/${this.workspace}`);
	}
	scope(path) {
		if (!/^[a-f0-9-]{36}$/.test(this.workspace)) throw new Error('Select a protocol 2 workspace');
		return `workspaces/${this.workspace}/${path}`;
	}
	load(address, onProgress) {
		return this.request('GET', this.scope(`objects/${address}`), undefined, onProgress);
	}
	store(object) {
		return this.request('PUT', this.scope(`objects/${object.address}`), object.body);
	}
	storeBatch(objects) {
		return this.request('POST', this.scope('objects/batch'), encodeObjectBatch(objects));
	}
	async loadBatch(addresses, limit = 2 * 1024 * 1024) {
		const objects = decodeObjectBatch(await this.request('POST', this.scope('objects/read'), { addresses, limit }));
		const allowed = new Set(addresses);
		if (objects.some(object => !allowed.has(object.address))) throw Error('Unexpected batch object');
		return new Map(objects.map(object => [object.address, object.body]));
	}
	commitBatch(entries) {
		return this.request('POST', this.scope('notes/batch'), { entries });
	}
	pins(after = 0) {
		return this.request('GET', this.scope(`pins?after=${after}`));
	}
	setPin(note, input) {
		return this.request('PUT', this.scope(`pins/${note}`), input);
	}
	positions(after = 0) {
		return this.request('GET', this.scope(`positions?after=${after}`));
	}
	setPosition(note, input) {
		return this.request('PUT', this.scope(`positions/${note}`), input);
	}
	feed(after) {
		return this.request('GET', this.scope(`changes?after=${after}`));
	}
	commit(note, input) {
		return this.request('POST', this.scope(`notes/${note}`), input);
	}
	versions(note, before) {
		return this.request(
			'GET',
			this.scope(`notes/${note}/versions${before === undefined ? '' : `?before=${before}`}`),
		);
	}
	trash(before) {
		return this.request(
			'GET',
			this.scope(`trash${before === undefined ? '' : `?before=${before}`}`),
		);
	}
	usage() {
		return this.request('GET', this.scope('usage'));
	}
	restore(note, source, expected) {
		return this.request('POST', this.scope(`notes/${note}/restore`), { source, expected });
	}
}

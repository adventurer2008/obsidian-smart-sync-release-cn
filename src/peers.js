import { base64, unbase64, fingerprint, packNote, inspectNote, unpackNote, unpackToSink } from './codec.js';
import { withCancellation } from './client.js';

// SDK metadata only: no content reads, hidden caches or synchronization filters.
export function sampleVaultSize(vault, sampledAt = Date.now()) {
	try {
		let bytes = 0;
		for (const file of vault.getFiles()) {
			if (!Number.isSafeInteger(file.stat?.size) || file.stat.size < 0) return undefined;
			bytes += file.stat.size;
			if (!Number.isSafeInteger(bytes)) return undefined;
		}
		return { bytes, sampledAt };
	} catch { return undefined; }
}

export function intersectDirection(local, remote) {
	if (local === 'paused' || remote === 'paused') return 'paused';
	if (remote === 'both') return local;
	if (local === 'both') return remote;
	if (local === 'update') return 'update';
	return local === remote ? local : 'paused';
}
const delay = (ms) => new Promise((done) => window.setTimeout(done, ms));
const localSDP = (sdp) =>
	sdp
		.split('\r\n')
		.filter(
			(line) =>
				!line.startsWith('a=candidate:') ||
				(/ typ host(?: |$)/.test(line) &&
					/(?:\s(?:127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|::1\s|f[cd][a-f0-9:]+|fe80:)|\.local\s)/i.test(
						line,
					)),
		)
		.join('\r\n');
// Signaling is workspace-authorized; data channels carry content-addressed ciphertext only.
export class LanPeers {
	constructor(
		api,
		{ Peer = window.RTCPeerConnection, period = 2500, enabled = true, onState = () => {}, vaultUsage = () => undefined } = {},
	) {
		Object.assign(this, { api, Peer, period, enabled, onState, vaultUsage });
		this.links = new Map();
		this.cache = new Map();
		this.cacheBytes = 0;
		this.pending = new Map();
		this.bundles = new Map();
		this.queuedNotes = new Map();
		this.preparing = false;
		this.metrics = { receivedBytes: 0, sentBytes: 0, cloudBytes: 0, receivedObjects: 0, fallbacks: 0, failures: 0 };
		this.after = 0;
		this.closed = false;
		this.cancellation = new AbortController();
	}
	async start() {
		if (this.closed) return;
		try {
			await this.presenceWork;
			await this.tick();
		} finally {
			if (!this.timer && !this.closed)
				this.timer = window.setInterval(
					() => void this.tick().catch(() => this.drop()),
					this.period,
				);
		}
	}
	async tick() {
		if (this.closed) return;
		if (this.presenceWork) return this.presenceWork;
		const work = this.poll();
		this.presenceWork = work;
		try { return await work; }
		finally { if (this.presenceWork === work) this.presenceWork = undefined; }
	}
	async poll() {
		if (this.closed || this.busy) return;
		this.busy = true;
		try {
			const presence = await this.api.request('POST', 'device-presence', {
				workspace: this.api.workspace,
				vaultUsage: this.vaultUsage(this.api),
			});
			if (this.closed) return;
			this.id = presence.id;
			this.mode = presence.mode;
			if (!this.enabled || !this.Peer || presence.mode !== 'both') {
				this.drop();
				return;
			}
			const available = new Set(presence.peers.map((p) => p.id));
			for (const id of this.links.keys()) if (!available.has(id)) this.remove(id);
			for (const [id, link] of this.links)
				if (link.channel?.readyState !== 'open' && Date.now() - link.created > 15000)
					this.remove(id);
			for (const id of [...available].slice(0, 4))
				if (this.id < id && !this.links.has(id)) {
					const link = this.connect(id, true);
					await this.describe(link, 'offer');
				}
			for (let pages = 0; pages < 4; pages++) {
				const batch = await this.api.request(
					'GET',
					`device-signals?workspace=${this.api.workspace}&after=${this.after}`,
				);
				if (this.closed) return;
				for (const row of batch.entries) {
					this.after = Math.max(this.after, row.sequence);
					if (!available.has(row.sender)) continue;
					let link = this.links.get(row.sender);
					if (row.payload.type === 'offer') {
						if (link) this.remove(row.sender);
						link = this.connect(row.sender, false);
						await this.negotiate(link, () => link.pc.setRemoteDescription(row.payload));
						await this.describe(link, 'answer');
					} else if (link && link.pc.signalingState === 'have-local-offer')
						await this.negotiate(link, () => link.pc.setRemoteDescription(row.payload));
				}
				if (!batch.more) break;
			}
		} finally {
			this.busy = false;
		}
	}
	connect(id, initiator) {
		const pc = new this.Peer({ iceServers: [] }),
			link = { id, pc, created: Date.now() };
		this.links.set(id, link);
		pc.onconnectionstatechange = () => {
			if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) this.remove(id);
		};
		const attach = (channel) => {
			link.channel = channel;
			channel.onmessage = (event) =>
				void this.message(link, event.data).catch(() => this.remove(id));
			channel.onopen = () => { channel.send(JSON.stringify({ type: 'hello', id: 'capabilities', notes: 1 })); this.onState('connected'); };
			channel.onclose = () => this.remove(id);
		};
		if (initiator) attach(pc.createDataChannel('smart-sync-ciphertext', { ordered: true }));
		else pc.ondatachannel = (event) => attach(event.channel);
		return link;
	}
	async negotiate(link, work) {
		try {
			return await withCancellation([this.api.signal, this.cancellation.signal], 4000, work);
		} catch (error) {
			this.remove(link.id);
			throw error;
		}
	}
	async describe(link, type) {
		const description = await this.negotiate(link, () => type === 'offer' ? link.pc.createOffer() : link.pc.createAnswer());
		await this.negotiate(link, () => link.pc.setLocalDescription(description));
		const deadline = Date.now() + 2500;
		while (link.pc.iceGatheringState !== 'complete' && Date.now() < deadline && !this.closed && !this.api.signal?.aborted)
			await delay(25);
		if (this.closed || this.api.signal?.aborted) return;
		await this.api.request('POST', 'device-signals', {
			workspace: this.api.workspace,
			target: link.id,
			payload: { type, sdp: localSDP(link.pc.localDescription.sdp) },
		});
	}
	remember(address, body) {
		if (
			!/^[a-f0-9]{64}$/.test(address) ||
			!(body instanceof Uint8Array) ||
			body.length > 2 * 1024 * 1024
		)
			return;
		if (this.cache.has(address)) return;
		this.cache.set(address, body);
		this.cacheBytes += body.length;
		while (this.cacheBytes > 16 * 1024 * 1024) {
			const [key, value] = this.cache.entries().next().value;
			this.cache.delete(key);
			this.cacheBytes -= value.length;
		}
	}
	async reserveServe(link, acquire, active = () => true) {
		// Brief contention is not a cache miss. Bound both waiting work and time,
		// and claim capacity inside the loop so concurrent waiters cannot race.
		if ((link.serveWaiters ?? 0) >= 4) return false;
		link.serveWaiters = (link.serveWaiters ?? 0) + 1;
		const deadline = Date.now() + 500;
		try {
			do {
				if (this.closed || !this.enabled || this.mode !== 'both' || this.api.signal?.aborted || this.canServe?.() === false || link.channel?.readyState !== 'open' || !active()) return false;
				if (acquire()) return true;
				await delay(10);
			} while (Date.now() < deadline);
			return false;
		} finally { link.serveWaiters--; }
	}
	async message(link, raw) {
		if (typeof raw !== 'string' || raw.length > 65536) throw Error('Invalid peer frame');
		const frame = JSON.parse(raw);
		if (typeof frame.id !== 'string' || frame.id.length > 40) throw Error('Invalid peer request');
		if (frame.type === 'hello' && frame.id === 'capabilities') { link.notes = frame.notes === 1; return; }
		if (frame.type === 'release-note') { this.releaseBundle(link.id + '|' + frame.id); return; }
		if (frame.type === 'get-note') { await this.serveNote(link, frame); return; }
		if (frame.type === 'note') {
			const task = this.pending.get(frame.id);
			if (task?.peer === link.id && task.kind === 'note' && /^[a-f0-9]{64}$/.test(frame.address)) task.resolve(frame.address);
			return;
		}
		if (frame.type === 'get') {
			if (!/^[a-f0-9]{64}$/.test(frame.address)) throw Error('Invalid ciphertext address');
			if (this.closed || !this.enabled || this.mode !== 'both' || this.canServe?.() === false) return;
			const reserved = await this.reserveServe(link, () => {
				if (link.sending) return false;
				link.sending = true; return true;
			});
			if (!reserved) {
				if (link.channel.readyState === 'open') link.channel.send(JSON.stringify({ type: 'miss', id: frame.id }));
				return;
			}
			try {
				if (this.closed || !this.enabled || this.mode !== 'both' || this.api.signal?.aborted || this.canServe?.() === false || link.channel.readyState !== 'open') return;
				let bytes = this.cache.get(frame.address);
				if (!bytes) for (const bundle of this.bundles.values()) {
					if (bundle.peer !== link.id || bundle.cancelled || !bundle.objects?.has(frame.address)) continue;
					this.touchBundle(bundle);
					const object = bundle.objects.get(frame.address);
					bytes = object.body ?? await object.load();
					if (bundle.cancelled || this.closed || !this.enabled || this.mode !== 'both' || this.canServe?.() === false) return;
					break;
				}
				if (!bytes) {
					link.channel.send(JSON.stringify({ type: 'miss', id: frame.id }));
					return;
				}
				for (let offset = 0; offset < bytes.length; offset += 32768) {
					const deadline = Date.now() + 1500;
					while (link.channel.bufferedAmount > 131072 && Date.now() < deadline) await delay(10);
					if (this.closed || !this.enabled || this.mode !== 'both' || this.canServe?.() === false || link.channel.readyState !== 'open' || Date.now() >= deadline)
						throw Error('Peer backpressure timeout');
					link.channel.send(
						JSON.stringify({
							type: 'part',
							id: frame.id,
							index: offset / 32768,
							total: bytes.length,
							data: base64(bytes.subarray(offset, offset + 32768)),
						}),
					);
					this.metrics.sentBytes += Math.min(32768, bytes.length - offset);
				}
			} finally {
				link.sending = false;
			}
		} else {
			const task = this.pending.get(frame.id);
			if (!task || task.peer !== link.id) return;
			if (frame.type === 'miss') {
				task.resolve(null);
				return;
			}
			if (task.kind === 'note') throw Error('Invalid peer note reply');
			if (
				frame.type !== 'part' ||
				!Number.isSafeInteger(frame.total) ||
				frame.total < 1 ||
				frame.total > 2 * 1024 * 1024 ||
				frame.index !== task.parts.length
			)
				throw Error('Invalid peer object');
			const bytes = unbase64(frame.data);
			if (bytes.length < 1 || bytes.length > 32768) throw Error('Invalid peer segment');
			if (task.total !== undefined && task.total !== frame.total)
				throw Error('Changing peer length');
			task.total = frame.total;
			task.parts.push(bytes);
			task.bytes += bytes.length;
			task.progress?.();
			if (task.bytes > task.total) throw Error('Peer overflow');
			if (task.bytes === task.total) {
				const body = new Uint8Array(task.bytes);
				let at = 0;
				for (const part of task.parts) {
					body.set(part, at);
					at += part.length;
				}
				const valid = (await fingerprint(body)) === task.address;
				if (this.pending.get(frame.id) !== task || this.closed || !this.enabled || this.api.signal?.aborted) return;
				if (valid) { this.metrics.receivedBytes += body.length; this.metrics.receivedObjects++; this.remember(task.address, body); }
				else this.metrics.failures++;
				task.resolve(valid ? body : null);
			}
		}
	}
	async load(address) {
		if (this.closed || !this.enabled || this.mode !== 'both') return null;
		const cached = this.cache.get(address);
		if (cached) return cached;
		const deadline = Date.now() + 2000;
		let attempted = false;
		for (const link of [...this.links.values()].filter(
			(link) => link.channel?.readyState === 'open' && !(link.cachePauseUntil > Date.now()),
		)) {
			const remaining = deadline - Date.now();
			if (remaining <= 0) break;
			attempted = true;
			const body = await this.loadFrom(link, address, Math.min(1500, remaining));
			if (body) return body;
		}
		if (attempted) this.metrics.fallbacks++;
		return null;
	}
	async loadFrom(link, address, timeout) {
		if (this.pending.size >= 4) return null;
		const id = crypto.randomUUID();
		let timer, finish, settled = false;
		const signals = [this.api.signal, this.cancellation.signal].filter(Boolean);
		const abort = () => finish?.(null);
		const started = Date.now();
		try {
			return await new Promise((resolve) => {
				const done = (value) => {
					if (settled) return;
					settled = true;
					link.cacheMisses = value ? 0 : (link.cacheMisses ?? 0) + 1;
					if (link.cacheMisses >= 3) link.cachePauseUntil = Date.now() + 2500;
					window.clearTimeout(timer);
					this.pending.delete(id);
					resolve(value);
				};
				finish = done;
				const progress = () => { window.clearTimeout(timer); timer = window.setTimeout(() => done(null), Math.max(1, Math.min(2000, 10000 - (Date.now() - started)))); };
				this.pending.set(id, { peer: link.id, address, parts: [], bytes: 0, resolve: done, progress });
				for (const signal of signals) signal.addEventListener('abort', abort, { once: true });
				if (signals.some(signal => signal.aborted)) { done(null); return; }
				timer = window.setTimeout(() => done(null), timeout);
				try {
					link.channel.send(JSON.stringify({ type: 'get', id, address }));
				} catch {
					done(null);
				}
			});
		} finally {
			for (const signal of signals) signal.removeEventListener('abort', abort);
			window.clearTimeout(timer);
			this.pending.delete(id);
		}
	}
	snapshot() {
		return { enabled: this.enabled && !this.closed, supported: Boolean(this.Peer), connected: [...this.links.values()].filter(link => link.channel?.readyState === 'open').length, ...this.metrics };
	}
	touchBundle(bundle) {
		window.clearTimeout(bundle.timer);
		bundle.timer = window.setTimeout(() => this.releaseBundle(bundle.key), 60000);
	}
	releaseBundle(key) {
		const queued = this.queuedNotes.get(key);
		if (queued) queued.cancelled = true;
		const bundle = this.bundles.get(key);
		if (!bundle) return;
		bundle.cancelled = true;
		window.clearTimeout(bundle.timer);
		this.bundles.delete(key);
		const dispose = bundle.dispose;
		void Promise.resolve().then(() => dispose?.()).catch(() => {});
	}
	async serveNote(link, frame) {
		const miss = () => { if (link.channel?.readyState === 'open') link.channel.send(JSON.stringify({ type: 'miss', id: frame.id })); };
		if (!/^[a-f0-9]{64}$/.test(frame.note ?? '') || !/^[a-f0-9]{64}$/.test(frame.manifest ?? '')) throw Error('Invalid peer note request');
		if (this.closed || !this.enabled || this.mode !== 'both' || this.canServe?.() === false || !this.provideNote) { miss(); return; }
		const key = link.id + '|' + frame.id;
		if (this.bundles.has(key) || this.queuedNotes.has(key) || this.queuedNotes.size >= 16) { miss(); return; }
		const queued = { peer: link.id, cancelled: false };
		this.queuedNotes.set(key, queued);
		let reserved;
		try {
			reserved = await this.reserveServe(link, () => {
				if (this.preparing || this.bundles.size >= 2) return false;
				this.preparing = true; return true;
			}, () => !queued.cancelled);
			if (!reserved) { miss(); return; }
			if (queued.cancelled || this.closed || !this.enabled || this.mode !== 'both' || this.api.signal?.aborted || this.canServe?.() === false || link.channel?.readyState !== 'open') {
				this.preparing = false; miss(); return;
			}
		} finally { this.queuedNotes.delete(key); }
		const bundle = { key, peer: link.id, cancelled: false };
		this.bundles.set(key, bundle); this.touchBundle(bundle);
		try {
			const packed = await this.provideNote(frame.note, frame.manifest, () => !bundle.cancelled && !this.closed && this.enabled && this.mode === 'both' && this.canServe?.() !== false);
			if (!packed) { this.releaseBundle(key); miss(); return; }
			bundle.dispose = packed.dispose;
			if (bundle.cancelled || this.closed || !this.enabled || this.mode !== 'both' || this.canServe?.() === false || link.channel?.readyState !== 'open') { await packed.dispose?.(); return; }
			bundle.objects = new Map(packed.objects.map(object => [object.address, object]));
			link.channel.send(JSON.stringify({ type: 'note', id: frame.id, address: packed.manifest }));
		} catch { this.releaseBundle(key); miss(); }
		finally { this.preparing = false; }
	}
	async noteSession(note, manifest) {
		if (this.closed || !this.enabled || this.mode !== 'both' || this.api.signal?.aborted || this.pending.size >= 4) return null;
		const deadline = Date.now() + 15000;
		let attempted = false;
		for (const link of this.links.values()) {
			if (Date.now() >= deadline) break;
			if (!link.notes || link.channel?.readyState !== 'open') continue;
			attempted = true;
			const id = crypto.randomUUID(); let timer, finish;
			const release = () => { if (link.channel?.readyState === 'open') link.channel.send(JSON.stringify({ type: 'release-note', id })); };
			const signals = [this.api.signal, this.cancellation.signal].filter(Boolean), abort = () => finish?.(null);
			try {
				const address = await new Promise(resolve => {
					finish = value => { window.clearTimeout(timer); this.pending.delete(id); resolve(value); };
					this.pending.set(id, { peer: link.id, kind: 'note', resolve: finish });
					for (const signal of signals) signal.addEventListener('abort', abort, { once: true });
					if (signals.some(signal => signal.aborted)) { finish(null); return; }
					timer = window.setTimeout(() => finish(null), Math.max(1, deadline - Date.now()));
					try { link.channel.send(JSON.stringify({ type: 'get-note', id, note, manifest })); } catch { finish(null); }
				});
				if (address) return { address, load: value => this.loadFrom(link, value, 2000), dispose: release };
			} finally { window.clearTimeout(timer); this.pending.delete(id); for (const signal of signals) signal.removeEventListener('abort', abort); }
			release();
		}
		if (attempted) this.metrics.fallbacks++;
		return null;
	}
	remove(id) {
		const link = this.links.get(id);
		if (!link) return;
		this.links.delete(id);
		for (const queued of this.queuedNotes.values()) if (queued.peer === id) queued.cancelled = true;
		for (const [key, bundle] of this.bundles) if (bundle.peer === id) this.releaseBundle(key);
		link.channel?.close();
		link.pc.close();
		for (const task of this.pending.values()) if (task.peer === id) task.resolve(null);
	}
	drop() {
		for (const id of this.links.keys()) this.remove(id);
		this.onState('cloud');
	}
	close() {
		this.closed = true;
		this.cancellation.abort(new DOMException('Peer connection closed', 'AbortError'));
		window.clearInterval(this.timer);
		this.drop();
		this.cache.clear();
		this.cacheBytes = 0;
	}
}

// Read only committed, explicitly selected local files. Fresh AES-GCM envelopes
// retain the cloud-confirmed plaintext digest; no original ciphertext nonce is reused.
export function localNoteProvider({ keys, workspace, state, host, cache, accepts = () => true }) {
	return async (note, manifest, active = () => true) => {
		const previous = state.notes[note];
		if (!active() || !previous?.downloaded || previous.removed || (previous.kind ?? 'file') !== 'file' || previous.manifest !== manifest || !accepts(previous.path)) return null;
		const path = previous.path, digest = previous.digest;
		let source, packed;
		try {
			const before = await host.stamp?.(path), mtime = await host.mtime?.(path);
			const reusable = cache && await cache.bundle(manifest, note, before, mtime);
			if (reusable && active()) return reusable;
			source = await host.read(path);
			if (!active() || source === null || await fingerprint(source) !== digest) { await source?.dispose?.(); return null; }
			if (source.streamed) {
				const chunk = source.chunk.bind(source);
				source = { ...source, chunk: (...args) => { if (!active()) throw new DOMException('Peer transfer cancelled', 'AbortError'); return chunk(...args); } };
			}
			packed = await packNote(keys, workspace, path, source, undefined, note, 'file', mtime);
			if (!active() || state.notes[note] !== previous || previous.path !== path || previous.manifest !== manifest || previous.digest !== digest || !accepts(path) || (before !== undefined && await host.stamp?.(path) !== before) || (host.mtime && await host.mtime(path) !== mtime)) { await packed.dispose?.(); return null; }
			if (cache && packed.info.bytes > 8 * 1024 * 1024) await cache.saveBundle(manifest, note, packed, before, mtime, active);
			if (!active()) { await packed.dispose?.(); return null; }
			return packed;
		} catch { await (packed?.dispose?.() ?? source?.dispose?.()); return null; }
	};
}

export async function receivePeerNote(peers, keys, workspace, note, manifest, expected, sinkFor, onTiming) {
	const cache = expected.bytes > 8 * 1024 * 1024 ? peers.resumeCache : undefined;
	let session = await peers.noteSession(note, manifest);
	if (!session && cache) {
		const saved = await cache.readLink('receive', manifest);
		if (saved?.note === note) session = { address: saved.manifest, load: async () => null, dispose() {} };
	}
	if (!session) return null;
	try {
		const load = async address => {
			const cached = cache && await cache.get(address);
			if (cached) return cached;
			const bytes = await session.load(address);
			if (!bytes) throw Error('Peer object unavailable');
			if (cache) await cache.put(address, bytes);
			return bytes;
		};
		const info = await inspectNote(keys, workspace, note, session.address, load);
		for (const key of ['path', 'kind', 'bytes', 'digest']) if (info[key] !== expected[key]) throw Error('Peer note differs from cloud revision');
		if (expected.mtime !== undefined && info.mtime !== expected.mtime) throw Error('Peer modification time differs');
		if (cache) await cache.writeLink('receive', manifest, { note, manifest: session.address, objects: [session.address, ...info.segments.map(piece => piece.address)] });
		if (sinkFor) {
			// A legacy cloud revision without mtime must not borrow the peer's local time.
			await unpackToSink(keys, workspace, note, session.address, load, (_, bytes, digest) => sinkFor(expected.path, bytes, digest, expected.mtime), info, onTiming);
			return { streamed: true };
		}
		return await unpackNote(keys, workspace, note, session.address, load, info, onTiming);
	} catch { peers.metrics.failures++; peers.metrics.fallbacks++; return null; }
	finally { try { session.dispose(); } catch { /* A disconnected peer expires its bounded lease. */ } }
}

const bindings = new WeakMap();
export function bindLanTransfers(api, peers) {
	const prior = bindings.get(api);
	if (prior?.peers === peers) return;
	const base = prior?.base ?? { load: api.load.bind(api), store: api.store.bind(api), loadBatch: api.loadBatch?.bind(api), storeBatch: api.storeBatch?.bind(api) };
	bindings.set(api, { peers, base });
	api.load = async (address, onProgress) => {
		const direct = await peers.load(address);
		if (api.signal?.aborted) throw api.signal.reason;
		if (direct) { onProgress?.({ loaded: direct.length, total: direct.length }); return direct; }
		const body = await base.load(address, onProgress);
		peers.metrics.cloudBytes += body.length; peers.remember(address, body);
		return body;
	};
	api.store = async object => { const result = await base.store(object); peers.remember(object.address, object.body); return result; };
	if (base.storeBatch) api.storeBatch = async objects => {
		const result = await base.storeBatch(objects);
		for (const object of objects) peers.remember(object.address, object.body);
		return result;
	};
	if (base.loadBatch) api.loadBatch = async (addresses, limit = 2 * 1024 * 1024) => {
		const result = new Map(), unique = [...new Set(addresses)], deadline = Date.now() + 2000; let used = 0;
		for (let at = 0; at < unique.length; at++) {
			if (Date.now() >= deadline || used >= limit) break;
			// One object at a time respects the peer channel's bounded sender.
			const part = unique.slice(at, at + 1);
			const bodies = await Promise.all(part.map(address => peers.load(address)));
			if (api.signal?.aborted) throw api.signal.reason;
			for (let index = 0; index < part.length; index++) if (bodies[index] && used + bodies[index].length <= limit) { result.set(part[index], bodies[index]); used += bodies[index].length; }
		}
		const missing = unique.filter(address => !result.has(address));
		if (missing.length && used < limit) for (const [address, body] of await base.loadBatch(missing, limit - used)) {
			if (!missing.includes(address) || !(body instanceof Uint8Array) || used + body.length > limit) throw Error('Invalid cloud batch fallback');
			result.set(address, body); used += body.length; peers.metrics.cloudBytes += body.length; peers.remember(address, body);
		}
		return result;
	};
	api.hasLanNotes = () => !peers.closed && peers.enabled && peers.mode === 'both' && [...peers.links.values()].some(link => link.notes && link.channel?.readyState === 'open');
}

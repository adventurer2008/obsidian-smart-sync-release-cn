import { base64, unbase64, fingerprint } from './codec.js';
import { withCancellation } from './client.js';

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
		{ Peer = window.RTCPeerConnection, period = 2500, enabled = true, onState = () => {} } = {},
	) {
		Object.assign(this, { api, Peer, period, enabled, onState });
		this.links = new Map();
		this.cache = new Map();
		this.cacheBytes = 0;
		this.pending = new Map();
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
			channel.onopen = () => this.onState('connected');
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
	async message(link, raw) {
		if (typeof raw !== 'string' || raw.length > 65536) throw Error('Invalid peer frame');
		const frame = JSON.parse(raw);
		if (typeof frame.id !== 'string' || frame.id.length > 40) throw Error('Invalid peer request');
		if (frame.type === 'get') {
			if (!/^[a-f0-9]{64}$/.test(frame.address)) throw Error('Invalid ciphertext address');
			const bytes = this.cache.get(frame.address);
			if (!bytes) {
				link.channel.send(JSON.stringify({ type: 'miss', id: frame.id }));
				return;
			}
			if (link.sending) {
				link.channel.send(JSON.stringify({ type: 'miss', id: frame.id }));
				return;
			}
			link.sending = true;
			try {
				for (let offset = 0; offset < bytes.length; offset += 32768) {
					const deadline = Date.now() + 1500;
					while (link.channel.bufferedAmount > 131072 && Date.now() < deadline) await delay(10);
					if (this.closed || link.channel.readyState !== 'open' || Date.now() >= deadline)
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
			if (task.bytes > task.total) throw Error('Peer overflow');
			if (task.bytes === task.total) {
				const body = new Uint8Array(task.bytes);
				let at = 0;
				for (const part of task.parts) {
					body.set(part, at);
					at += part.length;
				}
				task.resolve((await fingerprint(body)) === task.address ? body : null);
			}
		}
	}
	async load(address) {
		if (this.closed || !this.enabled || this.mode !== 'both') return null;
		const deadline = Date.now() + 2000;
		for (const link of [...this.links.values()].filter(
			(link) => link.channel?.readyState === 'open',
		)) {
			const remaining = deadline - Date.now();
			if (remaining <= 0) break;
			const body = await this.loadFrom(link, address, Math.min(700, remaining));
			if (body) return body;
		}
		return null;
	}
	async loadFrom(link, address, timeout) {
		if (this.pending.size >= 4) return null;
		const id = crypto.randomUUID();
		let timer;
		try {
			return await new Promise((resolve) => {
				const done = (value) => {
					window.clearTimeout(timer);
					this.pending.delete(id);
					resolve(value);
				};
				this.pending.set(id, { peer: link.id, address, parts: [], bytes: 0, resolve: done });
				timer = window.setTimeout(() => done(null), timeout);
				try {
					link.channel.send(JSON.stringify({ type: 'get', id, address }));
				} catch {
					done(null);
				}
			});
		} finally {
			window.clearTimeout(timer);
			this.pending.delete(id);
		}
	}
	remove(id) {
		const link = this.links.get(id);
		if (!link) return;
		this.links.delete(id);
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

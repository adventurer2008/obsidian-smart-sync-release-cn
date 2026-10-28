import { t, formatStorageSize } from './i18n.js';
import {
	fingerprint,
	inspectNote,
	opaqueNoteId,
	packNote,
	repathNote,
	safeNotePath,
	unpackNote,
	unpackToSink,
} from './codec.js';
import { mergeNote, rememberBase } from './merge.js';
import { BATCH_BYTES } from './client.js';

// Dirty state follows the connection across short-lived engine instances, including failed saves.
const unsavedStates = new WeakSet();

export function emptyState() {
	return { format: 3, cursor: 0, notes: {}, conflicts: [] };
}
export function renamedFrom(path, renames) {
	const source = Object.keys(renames)
		.filter((to) => path === to || path.startsWith(`${to}/`))
		.sort((a, b) => b.length - a.length)[0];
	return source ? `${renames[source]}${path.slice(source.length)}` : undefined;
}
function renameSources(path, renames) {
	return Object.keys(renames)
		.filter(to => path === to || path.startsWith(`${to}/`))
		.map(to => `${renames[to]}${path.slice(to.length)}`);
}
function renameDestinations(path, renames) {
	return [...new Set(Object.entries(renames)
		.filter(([, from]) => path === from || path.startsWith(`${from}/`))
		.map(([to, from]) => `${to}${path.slice(from.length)}`))];
}
export function recordRename(renames, from, to, knownPaths = []) {
	const has = path => knownPaths instanceof Set ? knownPaths.has(path) : knownPaths.includes(path);
	if (renamedFrom(to, renames) === from) return;
	const inherited = renamedFrom(from, renames);
	const origin = has(from) ? from : (inherited ?? from);
	// An earlier folder rename may already be committed for only some children.
	// Preserve the unsent children's original identities when the parent moves again.
	if (inherited && inherited !== origin)
		for (const path of knownPaths)
			if (path.startsWith(`${inherited}/`) && !has(`${from}${path.slice(inherited.length)}`))
				renames[`${to}${path.slice(inherited.length)}`] = path;
	for (const path of Object.keys(renames))
		if (path === from || path.startsWith(`${from}/`)) {
			const old = has(path) ? path : renames[path];
			delete renames[path];
			renames[`${to}${path.slice(from.length)}`] = old;
		}
	delete renames[from];
	renames[to] = origin;
	for (const path of Object.keys(renames))
		if (path.startsWith(`${to}/`) && renames[path] === `${origin}${path.slice(to.length)}`)
			delete renames[path];
}
export function pendingAttachment(notes, href, source = '') {
	if (typeof href !== 'string' || /^[a-z][a-z0-9+.-]*:/i.test(href)) return undefined;
	try {
		const raw = decodeURIComponent(href.split('#')[0].split('|')[0]),
			parent = source.split('/').slice(0, -1),
			parts = [...parent];
		for (const item of raw.split('/')) {
			if (item === '..') {
				if (!parts.length) return undefined;
				parts.pop();
			} else if (item && item !== '.') parts.push(item);
		}
		const path = safeNotePath(parts.join('/'));
		const attachments = Object.entries(notes).filter(
			([, note]) =>
				!note.removed &&
				!note.path.toLowerCase().endsWith('.md'),
		);
		// Deferred files are absent from Obsidian's local link index. Resolve
		// shortest wiki links against the remote inventory, retaining ambiguity
		// even when one of the same-named attachments is already downloaded.
		let matches = attachments.filter(([, note]) => note.path === path);
		if (!matches.length) matches = attachments.filter(([, note]) => note.path === raw);
		if (!matches.length && !raw.startsWith('/') && !raw.split('/').some(part => part === '..' || part === '.'))
			matches = attachments.filter(([, note]) => note.path.endsWith(`/${raw}`));
		return matches.length === 1 && !matches[0][1].downloaded ? matches[0] : undefined;
	} catch {
		return undefined;
	}
}
function validEntry(entry, previous) {
	return (
		entry &&
		Number.isSafeInteger(entry.sequence) &&
		entry.sequence > previous &&
		/^[a-f0-9]{64}$/.test(entry.note) &&
		/^[a-f0-9]{64}$/.test(entry.manifest) &&
		typeof entry.removed === 'boolean'
	);
}
function renameConflict(message) {
	const error = new Error(message);
	error.code = 'RENAME_CONFLICT';
	return error;
}
// Device-local event hints are an optimization, never a deletion inventory.
// A new process, structural change, policy change or expired audit always scans fully.
export class IncrementalInventory {
	constructor({ auditMs = 60000, limit = 4096, now = () => Date.now() } = {}) {
		this.auditMs = auditMs; this.limit = limit; this.now = now;
		this.revision = 0; this.structural = 0; this.dirty = new Map();
	}
	changed(event, path) {
		const revision = ++this.revision;
		if (event !== 'modify' || typeof path !== 'string' || this.dirty.size >= this.limit) {
			this.structural = revision; this.dirty.clear();
		} else this.dirty.set(path, revision);
	}
	invalidate() { this.structural = ++this.revision; this.baseline = undefined; }
	begin(state, policy, force = false) {
		const baseline = this.baseline, now = this.now();
		return { revision: this.revision, state, policy, at: now,
			full: force || !baseline || baseline.state !== state || baseline.policy !== policy ||
				this.structural > baseline.revision || now < baseline.at || now - baseline.at >= this.auditMs,
			paths: [...this.dirty.keys()] };
	}
	finish(plan) {
		for (const [path, revision] of this.dirty) if (revision <= plan.revision) this.dirty.delete(path);
		this.baseline = { state: plan.state, policy: plan.policy, revision: plan.revision,
			at: plan.full ? plan.at : this.baseline.at };
	}
}

export class NotebookSynchronizer {
	#running;
	#active;
	#batching = false;
	#pendingSaves = 0;
	#pendingBytes = 0;
	#completed = [];
	#savedAt = 0;
	#cachedObjects = new Map();
	#windowManifests = new Map();
	#prefetchedInfo = new Map();
	#queuedUploads = [];
	#contentPoll;
	#bulkRemoved = new Set();
	#remoteHeads = new Map();
	#remoteFiles = new Map();
	async #remoteFile(path) {
		if (this.#remoteFiles.has(path)) return this.#remoteFiles.get(path);
		this.assertActive();
		const known = Object.entries(this.state.notes).filter(([, note]) => note.path === path).sort((a, b) => b[1].revision - a[1].revision)[0];
		const id = known?.[0] ?? await opaqueNoteId(this.keys, path);
		const previous = known?.[1];
		let entry = this.#remoteHeads.get(id) ?? (previous?.manifest ? { note: id, manifest: previous.manifest, removed: previous.removed } : undefined);
		const load = address => this.#load(address);
		let info = entry && !entry.removed ? await inspectNote(this.keys, this.api.workspace, entry.note, entry.manifest, load) : undefined;
		if (info?.path !== path) {
			// Reinstalled or renamed files can have a non-derived identity. Match authenticated paths.
			entry = undefined;
			for (const current of this.#remoteHeads.values()) {
				if (current.removed) continue;
				const inspected = await inspectNote(this.keys, this.api.workspace, current.note, current.manifest, load);
				if (inspected.path === path) { entry = current; info = inspected; break; }
			}
		}
		if (!entry || !info || info.path !== path) { this.#remoteFiles.set(path, undefined); return undefined; }
		const maximum = path.endsWith('/community-plugins.json') ? 1024 * 1024 : 65536;
		if (info.path !== path || info.kind !== 'file' || info.bytes > maximum) throw Error('Invalid plugin compatibility metadata');
		const result = await unpackNote(this.keys, this.api.workspace, entry.note, entry.manifest, load, info);
		this.#remoteFiles.set(path, result.contents);
		while (this.#remoteFiles.size > 128) this.#remoteFiles.delete(this.#remoteFiles.keys().next().value);
		return result.contents;
	}
	constructor({
		api,
		keys,
		host,
		state = emptyState(),
		save,
		ignored = [],
		attachmentLimit = Infinity,
		direction = 'both',
		accepts = () => true,
		renames = {},
		onProgress = () => {},
		onTask = async () => {},
		remoteMode = 'both',
		checkpointSize = 1,
		checkpointInterval = 500,
		checkpointBytes = 4 * 1024 * 1024,
		onTiming,
		snapshotBeforeSave = true,
		uploadConcurrency = 1,
		batchTransfer = false,
		batchDeletes = false,
		batchBytes = 2 * 1024 * 1024,
		batchFiles = 64,
		batchWaitMs = 250,
		beforeDelete = async () => {},
		yieldWork = async () => {},
		contentPriorities = new Map(),
		scanCache,
		scanVersion,
		incrementalInventory,
		scanPolicy,
		commitJournal,
		saveRequired = false,
	}) {
		if (
			state.format !== 3 ||
			!Number.isSafeInteger(state.cursor) ||
			state.cursor < 0 ||
			!state.notes ||
			!Array.isArray(state.conflicts)
		)
			throw new Error('Unsupported local synchronization state');
		if (!['both', 'receive', 'send', 'paused', 'update'].includes(direction))
			throw new Error('Unknown synchronization direction');
		if (!Number.isInteger(uploadConcurrency) || uploadConcurrency < 1 || uploadConcurrency > 4)
			throw new Error('Upload concurrency must be between one and four');
		if (!Number.isInteger(batchBytes) || batchBytes < 256 * 1024 || batchBytes > BATCH_BYTES || !Number.isInteger(batchWaitMs) || batchWaitMs < 0 || batchWaitMs > 1000)
			throw new Error('Invalid transfer batch bounds');
		if (!Number.isInteger(batchFiles) || batchFiles < 1 || batchFiles > 128) throw new Error('Invalid transfer batch file count');
		if (!Number.isSafeInteger(checkpointBytes) || checkpointBytes < 256 * 1024 || checkpointBytes > 256 * 1024 * 1024) throw Error('Invalid checkpoint byte bound');
		Object.assign(this, {
			contentPriorities,
			scanCache,
			scanVersion,
			incrementalInventory,
			scanPolicy,
			commitJournal,
			remoteMode,
			checkpointSize,
			checkpointInterval,
			checkpointBytes,
			onTiming,
			snapshotBeforeSave,
			uploadConcurrency,
			batchTransfer,
			batchDeletes,
			batchBytes,
			batchFiles,
			batchWaitMs,
			beforeDelete,
			yieldWork,
			api,
			keys,
			host,
			state,
			save,
			ignored,
			attachmentLimit,
			direction,
			accepts,
			renames,
			onProgress,
			onTask,
		});
		if (
			!this.state.localIndex ||
			typeof this.state.localIndex !== 'object' ||
			Array.isArray(this.state.localIndex)
		)
			{ this.state.localIndex = {}; unsavedStates.add(this.state); }
		if (state.pendingReceives !== undefined && (!state.pendingReceives || Array.isArray(state.pendingReceives) ||
			typeof state.pendingReceives !== 'object' || Object.entries(state.pendingReceives).some(([note, entry]) =>
				note !== entry?.note || !validEntry(entry, 0) || (entry.path !== undefined && safeNotePath(entry.path) !== entry.path))))
			throw Error('Invalid pending receive state');
		const durableCommit = this.commitJournal?.current();
		if (durableCommit !== undefined) this.state.pendingCommit = durableCommit;
		this.#validateCommitJournal();
		if (saveRequired) unsavedStates.add(this.state);
	}
	#validateCommitJournal() {
		const journal = this.state.pendingCommit;
		if (journal === undefined) return;
		if (!journal || journal.format !== 1 || journal.workspace !== this.api.workspace || journal.origin !== (this.api.origin ?? '') ||
			!['prepared', 'acknowledged'].includes(journal.phase) || !Array.isArray(journal.entries) || !journal.entries.length || journal.entries.length > 128 ||
			new Set(journal.entries.map(item => item?.note)).size !== journal.entries.length || journal.entries.some(item =>
				!item || !/^[a-f0-9]{64}$/.test(item.note) || !/^[a-f0-9]{64}$/.test(item.manifest) ||
				!Number.isSafeInteger(item.expected) || item.expected < 0 || typeof item.removed !== 'boolean' ||
				!item.next || safeNotePath(item.next.path) !== item.next.path || !['file','folder'].includes(item.next.kind) ||
				!/^[a-f0-9]{64}$/.test(item.next.digest) ||
				((journal.phase === 'acknowledged' || item.receipt !== undefined) && !this.#matchesCommit(item.receipt, item)))) throw Error('Invalid pending commit journal');
	}
	#matchesCommit(receipt, item) {
		return validEntry(receipt, item.expected) && receipt.note === item.note && receipt.manifest === item.manifest && receipt.removed === item.removed;
	}
	async #submitCommit(inputs, next, batch = false) {
		this.assertActive();
		if (this.state.pendingCommit && (!this.commitJournal || this.state.pendingCommit.phase !== 'acknowledged')) throw Error('Pending commit must be reconciled before submitting');
		if ((this.state.pendingCommit?.entries.length ?? 0) + inputs.length > 128) await this.#flush();
		const prior = this.state.pendingCommit?.entries ?? [];
		const journal = { format: 1, workspace: this.api.workspace, origin: this.api.origin ?? '', phase: 'prepared',
			entries: [...prior, ...inputs.map((input, index) => ({ note: input.note, expected: input.expected ?? 0,
				manifest: input.manifest ?? next[index].manifest, removed: input.removed,
				next: { path: next[index].path, kind: next[index].kind ?? 'file', digest: next[index].digest } }))] };
		this.state.pendingCommit = journal;
		this.#validateCommitJournal();
		unsavedStates.add(this.state);
		if (this.commitJournal) await this.commitJournal.write(journal);
		else await this.#flush(); // Intent is durable before any request may publish a revision.
		this.assertActive();
		const receipts = batch ? (await this.api.commitBatch(inputs))?.entries : [await this.api.commit(inputs[0].note, inputs[0])];
		if (!Array.isArray(receipts) || receipts.length !== inputs.length || receipts.some((entry, index) => !this.#matchesCommit(entry, journal.entries[prior.length + index])))
			throw Error('Invalid commit acknowledgement');
		for (let index = 0; index < receipts.length; index++) journal.entries[prior.length + index].receipt = receipts[index];
		journal.phase = 'acknowledged';
		unsavedStates.add(this.state);
		// Piggyback receipts on the next journal write or normal checkpoint.
		// Until then the durable intent is sufficient to reconcile a lost response.
		if (!this.commitJournal) await this.#flush();
		return receipts;
	}
	async #finishCommit(force = false, alreadyPersisted = false) {
		if (this.commitJournal && !force) { if (!alreadyPersisted) await this.#persist(); return; }
		const journal = this.state.pendingCommit;
		delete this.state.pendingCommit;
		unsavedStates.add(this.state);
		try { await this.#flush(); await this.commitJournal?.clear(); }
		catch (error) { this.state.pendingCommit = journal; unsavedStates.add(this.state); throw error; }
	}
	async #recoverCommit() {
		const journal = this.state.pendingCommit;
		if (!journal) return;
		this.#validateCommitJournal();
		this.incrementalInventory?.invalidate();
		for (const item of journal.entries) {
			this.assertActive();
			let receipt = item.receipt;
			if (journal.phase === 'prepared' && !receipt) {
				if (typeof this.api.versions !== 'function') throw Error('Commit recovery requires revision history');
				let before, resolved = false;
				for (let page = 0; page < 128; page++) {
					const history = await this.api.versions(item.note, before);
					if (!Array.isArray(history?.entries) || typeof history.more !== 'boolean' || (history.more && !history.entries.length)) throw Error('Invalid commit recovery history');
					let previous = before ?? Number.MAX_SAFE_INTEGER;
					for (const entry of history.entries) {
						if (!validEntry(entry, 0) || entry.note !== item.note || entry.sequence >= previous) throw Error('Invalid commit recovery sequence');
						previous = entry.sequence;
					}
					receipt = history.entries.find(entry => this.#matchesCommit(entry, item));
					if (receipt || !history.more || previous <= item.expected) { resolved = true; break; }
					before = previous;
				}
				if (!resolved) throw Error('Commit recovery history exceeds the bounded window');
			}
			if (!receipt) continue; // Never blindly resend an uncertain upload or deletion.
			if ((this.state.notes[item.note]?.revision ?? 0) >= receipt.sequence) continue;
			const info = await inspectNote(this.keys, this.api.workspace, item.note, item.manifest, address => this.api.load(address));
			if (info.path !== item.next.path || info.digest !== item.next.digest || info.kind !== item.next.kind) throw Error('Commit recovery metadata mismatch');
			this.state.notes[item.note] = { ...item.next, revision: receipt.sequence, manifest: item.manifest,
				removed: item.removed, downloaded: !item.removed };
		}
		await this.#finishCommit(true);
	}
	async timed(stage, work) {
		const started = performance.now();
		try { return await work(); }
		finally { try { this.onTiming?.(stage, performance.now() - started); } catch { /* Measurement cannot fail synchronization. */ } }
	}
	assertActive() {
		if (this.api.signal?.aborted) throw new DOMException('Synchronization stopped', 'AbortError');
	}
	async localFile(path, fresh = false) {
		const mtime = await this.host.mtime?.(path);
		const stamp = await this.host.stamp?.(path);
		const cached = Object.hasOwn(this.state.localIndex, path) && this.state.localIndex[path];
		if (
			!fresh &&
			typeof stamp === 'string' &&
			cached?.stamp === stamp &&
			/^[a-f0-9]{64}$/.test(cached.digest) &&
			Number.isSafeInteger(cached.size) &&
			cached.size >= 0
		)
			return { digest: cached.digest, size: cached.size, mtime };
		const contents = await this.host.read(path);
		this.assertActive();
		if (contents === null) {
			if (Object.hasOwn(this.state.localIndex, path)) unsavedStates.add(this.state);
			delete this.state.localIndex[path];
			return null;
		}
		const digest = await this.timed('hash', () => fingerprint(contents));
		if (typeof stamp === 'string') {
			if (stamp !== (await this.host.stamp(path)))
				throw Object.assign(new Error('Source changed during inspection'), {
					code: 'PLAN_CHANGED',
				});
			unsavedStates.add(this.state);
			Object.defineProperty(this.state.localIndex, path, {
				value: { stamp, digest, size: contents.length },
				writable: true,
				enumerable: true,
				configurable: true,
			});
		} else { if (Object.hasOwn(this.state.localIndex, path)) unsavedStates.add(this.state); delete this.state.localIndex[path]; }
		return { digest, size: contents.length, contents, mtime };
	}
	excluded(path, receiving = false) {
		return (
			path === 'Smart Sync conflicts' ||
			path.startsWith('Smart Sync conflicts/') ||
			!this.accepts(path) ||
			(!receiving && this.host.excluded?.(path)) ||
			this.ignored.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
		);
	}
	#receivePaths = new Map();
	#receiveFailures = new Map();
	#receiveAttempts = new Set();
	#checkpointFailed = false;
	run(target, ceiling) {
		if (this.#running) return this.#running;
		this.#receivePaths.clear();
		this.#receiveFailures.clear();
		this.#receiveAttempts.clear();
		this.#checkpointFailed = false;
		this.#batching = true;
		this.#running = this.#cycle(target, ceiling)
			.then(async () => {
				await this.#flush();
				if (this.#receiveFailures.size) {
					const error = this.#receiveFailures.values().next().value;
					error.pendingReceiveCount = Object.keys(this.state.pendingReceives ?? {}).length;
					throw error;
				}
			})
			.catch(async (error) => {
				unsavedStates.add(this.state);
				if (this.scanCache) this.scanCache.state = undefined;
				this.incrementalInventory?.invalidate();
				for (const job of this.#queuedUploads.splice(0))
					await this.onTask({ ...job.task, status: 'failed', error }).catch(() => {});
				for (const task of this.#completed.splice(0))
					await this.onTask({ ...task, status: 'failed', error }).catch(() => {});
				throw error;
			})
			.finally(() => {
				this.#remoteFiles.clear();
				this.#remoteHeads.clear();
				this.#cachedObjects.clear();
				this.#windowManifests.clear();
				this.#prefetchedInfo.clear();
				this.#contentPoll = undefined;
				this.#batching = false;
				this.#running = undefined;
			});
		return this.#running;
	}
	async #task(event, work) {
		if (this.#completed.length && (this.#completed.some(task => task.direction !== event.direction) || Date.now() - this.#savedAt >= this.checkpointInterval)) await this.#flush();
		const prior = this.#active;
		const task = { ...event, token: crypto.randomUUID(), bytes: 0, total: 0, status: 'running', workStartedAt: performance.now() };
		this.#active = task;
		try {
			await this.onTask({ ...task });
			const result = await work();
			if (result === 'staged') return result;
			const completed = { ...task, status: result ?? 'done', workMilliseconds: Math.max(0, performance.now() - task.workStartedAt), completedAt: performance.now() };
			if (this.#batching && this.checkpointSize > 1) this.#completed.push(completed);
			else await this.onTask(completed);
			return result;
		} catch (error) {
			await this.onTask({ ...task, status: 'failed', error }).catch(() => {});
			throw error;
		} finally {
			this.#active = prior;
		}
	}
	async #load(address) {
		this.assertActive();
		const task = this.#active;
		let reported = 0;
		if (this.#cachedObjects.has(address)) {
			const bytes = this.#cachedObjects.get(address);
			this.#cachedObjects.delete(address);
			if (task) {
				task.bytes += bytes.length;
				task.total = Math.max(task.total, task.bytes);
				await this.onTask({ ...task, status: 'progress' });
			}
			return bytes;
		}
		if (this.#windowManifests.has(address)) return this.#windowManifests.get(address);
		const bytes = await this.timed('download', () => this.api.load(address, ({ loaded, total }) => {
			if (!task) return;
			task.bytes += Math.max(0, loaded - reported);
			reported = Math.max(reported, loaded);
			task.total = Math.max(task.total, task.bytes + Math.max(0, total - loaded));
			void this.onTask({ ...task, status: 'progress' }).catch(() => {});
		}));
		if (task) {
			task.bytes += Math.max(0, bytes.length - reported);
			task.total = Math.max(task.total, task.bytes);
			await this.onTask({ ...task, status: 'progress' });
		}
		return bytes;
	}
	#alreadyApplied(entry) {
		const previous = this.state.notes[entry.note];
		return (previous?.revision ?? 0) >= entry.sequence &&
			(previous.revision !== entry.sequence || previous.downloaded || previous.removed || entry.removed || this.excluded(previous.path));
	}
	async #prefetch(entries) {
		this.#cachedObjects.clear();
		this.#prefetchedInfo.clear();
		if (!this.batchTransfer || typeof this.api.loadBatch !== 'function') return entries.length;
		const live = entries.filter(entry => !entry.removed && !this.#alreadyApplied(entry));
		if (!live.length) { this.#windowManifests.clear(); return entries.length; }
		try {
			const wanted = new Set(live.map(entry => entry.manifest));
			for (const address of this.#windowManifests.keys()) if (!wanted.has(address)) this.#windowManifests.delete(address);
			const manifests = new Map(this.#windowManifests);
			const missing = [...wanted].filter(address => !manifests.has(address));
			const remaining = this.batchBytes - 128 * 1024 - [...manifests.values()].reduce((sum, body) => sum + body.length, 0);
			if (missing.length && remaining < 1024) { this.#windowManifests.clear(); return 1; }
			if (missing.length) for (const [address, body] of await this.timed('download', () => this.api.loadBatch(missing, remaining))) manifests.set(address, body);
			this.#windowManifests.clear();
			let metadataBudget = 128 * 1024;
			for (const [address, body] of manifests) if (body.length <= metadataBudget) { this.#windowManifests.set(address, body); metadataBudget -= body.length; }
			this.#cachedObjects = manifests;
			let available = this.batchBytes - 128 * 1024 - [...manifests.values()].reduce((sum, body) => sum + body.length, 0);
			const pieces = new Set();
			let covered = 0;
			for (const entry of entries) {
				if (entry.removed || this.#alreadyApplied(entry)) { covered++; continue; }
				if (!manifests.has(entry.manifest)) break;
				let info;
				try { info = await inspectNote(this.keys, this.api.workspace, entry.note, entry.manifest, async address => manifests.get(address)); }
				catch { covered++; continue; } // The ordinary per-file task performs and reports the integrity failure.
				this.#prefetchedInfo.set(entry.note + entry.manifest, info);
				const previous = this.state.notes[entry.note];
				// Reuse the local body for path-only revisions. The receive path still
				// checks local content and fetches on demand if it is absent or changed.
				if (previous?.downloaded && !previous.removed && previous.digest === info.digest) { covered++; continue; }
				if (this.excluded(info.path) || info.bytes > Math.min(4 * 1024 * 1024, this.batchBytes - 128 * 1024) || (!info.path.toLowerCase().endsWith('.md') && info.bytes > this.attachmentLimit)) { covered++; continue; }
				if (this.api.hasLanNotes?.()) { covered++; continue; }
				// A reconnect may retain the latest local bytes without its prior
				// checkpoint. Let receive verify them before fetching any body;
				// different or disappearing files still fetch through the normal path.
				if (!previous && this.host.exists && await this.host.exists(info.path)) { covered++; continue; }
				const required = info.segments.filter(piece => !pieces.has(piece.address)).reduce((sum, piece) => sum + piece.bytes + 256, 0);
				if (required > available) break;
				for (const piece of info.segments) {
					if (!pieces.has(piece.address) && piece.bytes + 256 <= available) { pieces.add(piece.address); available -= piece.bytes + 256; }
				}
				covered++;
			}
			if (pieces.size) for (const [address, bytes] of await this.timed('download', () => this.api.loadBatch([...pieces], this.batchBytes))) this.#cachedObjects.set(address, bytes);
			return Math.max(1, covered);
		} catch (error) {
			this.#cachedObjects.clear();
			this.#windowManifests.clear();
			this.#prefetchedInfo.clear();
			if (error?.status === 401 || error?.status === 403 || error?.name === 'AbortError') throw error;
			return 1;
		}
	}
	async #persist(count = 1) {
		unsavedStates.add(this.state);
		this.#pendingSaves += count;
		if (
			!this.#batching ||
			this.#pendingSaves >= this.checkpointSize ||
			this.#pendingBytes >= this.checkpointBytes ||
			Date.now() - this.#savedAt > this.checkpointInterval
		)
			await this.#flush();
	}
	async #flush() {
		if (!unsavedStates.has(this.state) && !this.#completed.length) return;
		const journal = this.state.pendingCommit;
		const retire = this.commitJournal && journal?.phase === 'acknowledged' &&
			journal.entries.every(item => (this.state.notes[item.note]?.revision ?? 0) >= item.receipt.sequence);
		if (retire) delete this.state.pendingCommit;
		try {
			await this.save(this.snapshotBeforeSave ? structuredClone(this.state) : this.state,
				retire && this.commitJournal.atomicCheckpoint === true ? { retireCommit: journal } : undefined);
			if (retire) await this.commitJournal.clear({ checkpointed: this.commitJournal.atomicCheckpoint === true });
		} catch (error) {
			if (retire) this.state.pendingCommit = journal;
			this.#checkpointFailed = true; throw error;
		}
		unsavedStates.delete(this.state);
		this.#pendingSaves = 0;
		this.#pendingBytes = 0;
		this.#savedAt = Date.now();
		for (const task of this.#completed.splice(0)) await this.onTask({ ...task, checkpointMilliseconds: Math.max(0, performance.now() - task.completedAt) });
	}
	async #preserve(path, contents, sequence) {
		const digest = await fingerprint(contents);
		const split = path.lastIndexOf('.');
		const stem = split > path.lastIndexOf('/') ? path.slice(0, split) : path;
		const extension = split > path.lastIndexOf('/') ? path.slice(split) : '';
		const copy =
			this.host.conflictPath?.(path, sequence, digest) ??
			`${stem}.conflict-${sequence}-${digest.slice(0, 12)}${extension}`;
		const prior = await this.host.read(copy);
		if (prior === null) await this.host.write(copy, contents);
		else if ((await fingerprint(prior)) !== digest)
			throw new Error('Conflict copy name is already occupied');
		if (!this.state.conflicts.some((entry) => entry.copy === copy))
			this.state.conflicts.push({ path, copy, sequence });
	}
	async #recordReceiveFailure(entry, error) {
		if (this.#checkpointFailed || this.api.signal?.aborted || error?.name === 'AbortError' ||
			[401, 403, 409, 410, 429].includes(error?.status) ||
			(error?.code && !['TEMP_SPACE', 'RENAME_CONFLICT', 'ENOENT', 'EIO', 'ENOSPC', 'EACCES'].includes(error.code))) throw error;
		const pending = this.state.pendingReceives ??= {};
		pending[entry.note] = { note: entry.note, sequence: entry.sequence, manifest: entry.manifest, removed: entry.removed,
			...(this.#receivePaths.get(entry.note) ? { path: this.#receivePaths.get(entry.note) } : {}) };
		this.#receiveFailures.set(entry.note, error);
		unsavedStates.add(this.state);
		// Commit the retry obligation before a later cursor can pass it.
		await this.#flush();
	}
	async #receive(entry, force = false) {
		const key = entry.note + ':' + entry.sequence;
		if (this.#batching && this.#receiveAttempts.has(key)) return;
		if (this.#batching) this.#receiveAttempts.add(key);
		try {
			await this.#receiveAttempt(entry, force);
			if ((this.state.pendingReceives?.[entry.note]?.sequence ?? Infinity) <= entry.sequence) {
				delete this.state.pendingReceives[entry.note];
				this.#receiveFailures.delete(entry.note);
				unsavedStates.add(this.state);
			}
		} catch (error) {
			if (!this.#batching) throw error;
			await this.#recordReceiveFailure(entry, error);
		}
	}
	async #receiveAttempt(entry, force = false) {
		const previous = this.state.notes[entry.note];
		if ((previous?.revision ?? 0) >= entry.sequence && !force) {
			if (
				previous.revision !== entry.sequence ||
				previous.downloaded ||
				previous.removed ||
				entry.removed ||
				this.excluded(previous.path)
			)
				return;
			const info = await inspectNote(
				this.keys,
				this.api.workspace,
				entry.note,
				entry.manifest,
				(address) => this.#load(address),
			);
			if (info.kind === 'folder' || (!info.path.startsWith('__smart_sync_configuration__/') && (this.attachmentLimit === 0 || info.bytes > this.attachmentLimit))) return;
		}
		return this.#task({ note: entry.note, direction: 'receive' }, async () => {
			await this.#receiveCore(entry, force);
			// The feed loop persists the file and its new cursor together.
			if (!this.#batching || this.checkpointSize === 1) await this.#persist();
			if (this.#active.skipReason) return 'skipped';
			if (!this.#active.path || this.excluded(this.#active.path)) return 'skipped';
			if (!entry.removed && !this.state.notes[entry.note]?.downloaded) return 'deferred';
		});
	}
	async #receiveCore(entry, force) {
		this.assertActive();
		if (entry.removed && this.#bulkRemoved.has(entry.note)) {
			const prior = this.state.notes[entry.note];
			this.#active.path = prior.path;
			this.state.notes[entry.note] = { ...prior, revision: entry.sequence, removed: true, downloaded: false, manifest: entry.manifest };
			return;
		}
		const load = (address) => this.#load(address);
		const infoKey = entry.note + entry.manifest;
		const info = this.#prefetchedInfo.get(infoKey) ?? await inspectNote(this.keys, this.api.workspace, entry.note, entry.manifest, load);
		this.#prefetchedInfo.delete(infoKey);
		if (this.excluded(info.path, true)) return;
		this.#active.path = info.path;
		this.#receivePaths.set(entry.note, info.path);
		let decoded;
		if (!entry.removed && this.host.validationContent?.(info.path)) decoded = await unpackNote(this.keys, this.api.workspace, entry.note, entry.manifest, load, info);
		const skipReason = await this.host.validateReceive?.(info.path, decoded?.contents);
		if (skipReason === 'desktop-plugin') {
			this.#active.skipReason = skipReason;
			this.state.notes[entry.note] = { path: info.path, kind: info.kind, revision: entry.sequence, digest: info.digest, manifest: entry.manifest, removed: entry.removed, downloaded: false, platformSkipped: skipReason };
			return;
		}
		const previous = this.state.notes[entry.note];
		const cloudPath = info.path;
		// A parent move can update the physical path before this child's manifest.
		// Delete its tracked location directly; a tombstone must never move it back.
		if (entry.removed && previous && !previous.removed && previous.downloaded && !this.excluded(previous.path)) info.path = previous.path;
		this.#active.path = cloudPath;
		if (
			this.direction === 'update' &&
			(info.kind === 'folder' || (previous && previous.path !== cloudPath))
		) {
			this.state.notes[entry.note] = {
				path: cloudPath,
				kind: info.kind,
				revision: entry.sequence,
				digest: info.digest,
				downloaded: false,
				removed: entry.removed,
				manifest: entry.manifest,
			};
			return;
		}
		if (previous && previous.path !== cloudPath && !entry.removed && Object.keys(this.renames).length) {
			const pending = [];
			for (const path of renameDestinations(previous.path, this.renames))
				if (path !== cloudPath && !this.excluded(path) && (this.host.exists ? await this.host.exists(path) : await this.host.read(path) !== null)) pending.push(path);
			if (pending.length === 1 && renameSources(pending[0], this.renames).includes(cloudPath))
				info.path = pending[0];
			else if (pending.length)
				throw renameConflict('Concurrent renames require choosing one destination before retrying');
		}
		// Receive content at a locally renamed path before publishing that pending rename.
		// In particular, a remote edit must not recreate the old path and lose the local move.
		if (previous && previous.path === cloudPath && !entry.removed && Object.keys(this.renames).length) {
			const candidates = [];
			for (const path of renameDestinations(cloudPath, this.renames))
				if (path !== cloudPath && !this.excluded(path) && !Object.entries(this.state.notes).some(([id, note]) => id !== entry.note && !note.removed && note.path === path) && (this.host.exists ? await this.host.exists(path) : await this.host.read(path) !== null)) candidates.push(path);
			if (candidates.length === 1) info.path = candidates[0];
		}
		try {
			// Never overwrite an unrelated destination. A failed host move leaves the cursor unchanged.
			if (
				previous &&
				!entry.removed &&
				!previous.removed &&
				previous.path !== info.path &&
				!this.excluded(previous.path)
			) {
				const exists = (path) =>
					this.host.exists
						? this.host.exists(path)
						: this.host.read(path).then((bytes) => bytes !== null);
				if (await exists(previous.path)) {
					if ((await exists(info.path)) && !(await this.host.sameEntry?.(previous.path, info.path)))
						throw renameConflict(`Rename destination is occupied: ${info.path}`);
					if (this.host.move) {
						await this.host.move(previous.path, info.path);
						if (info.kind === 'folder') {
							// The physical move includes every child. Reflect that locally now,
							// so a partially published remote rename cannot look like new uploads.
							for (const note of Object.values(this.state.notes))
								if (!note.removed && note.path.startsWith(`${previous.path}/`))
									note.path = `${info.path}${note.path.slice(previous.path.length)}`;
						}
					}
					else if (info.kind === 'file') {
						const mtime = (await this.host.mtime?.(previous.path)) ?? info.mtime;
						const bytes = await this.host.read(previous.path);
						this.assertActive();
						await this.host.write(info.path, bytes, mtime);
						await this.host.remove(previous.path);
					}
				}
			}
			if (info.kind === 'folder') {
				if (entry.removed) await this.host.removeFolder?.(info.path);
				else await this.host.mkdir?.(info.path);
				this.state.notes[entry.note] = {
					path: info.path,
					kind: 'folder',
					revision: entry.sequence,
					digest: info.digest,
					downloaded: !entry.removed,
					removed: entry.removed,
					manifest: entry.manifest,
				};
				return;
			}
			const inspectedLocal = await this.localFile(info.path);
			let local = inspectedLocal?.contents ?? (inspectedLocal ? { length: inspectedLocal.size } : null);
			let localDigest = inspectedLocal?.digest;
			if (inspectedLocal && !inspectedLocal.contents && (entry.removed || inspectedLocal.digest !== info.digest)) {
				local = await this.host.read(info.path);
				localDigest = local === null ? undefined : await fingerprint(local);
				delete this.state.localIndex[info.path];
			}
			if (this.direction === 'update' && (local === null || entry.removed)) {
				this.state.notes[entry.note] = {
					path: info.path,
					revision: entry.sequence,
					digest: info.digest,
					downloaded: local !== null,
					removed: entry.removed,
					manifest: entry.manifest,
					origin: info.origin,
				};
				return;
			}
			const dirty = local !== null && localDigest !== previous?.digest;
			if (entry.removed) {
				if (dirty) await this.#preserve(info.path, local, entry.sequence);
				if (local !== null) await this.host.remove(info.path);
				delete this.state.localIndex[info.path];
				this.state.notes[entry.note] = {
					path: info.path,
					revision: entry.sequence,
					removed: true,
					downloaded: false,
				};
				return;
			}
			if (local !== null && localDigest === info.digest) {
				if (!(local instanceof Uint8Array) && info.path.toLowerCase().endsWith('.md') && info.bytes <= 262144) {
					local = await this.host.read(info.path);
					if (local === null || await fingerprint(local) !== info.digest) throw Object.assign(new Error('Local content changed during receive'), { code: 'PLAN_CHANGED' });
				}
				if (info.mtime !== undefined && this.host.mtime && await this.host.mtime(info.path) !== info.mtime)
					await this.host.write(info.path, local instanceof Uint8Array ? local : await this.host.read(info.path), info.mtime);
				this.state.notes[entry.note] = {
					path: info.path,
					revision: entry.sequence,
					digest: info.digest,
					downloaded: true,
					removed: false,
					manifest: entry.manifest,
					origin: info.origin,
				};
				if (local instanceof Uint8Array) rememberBase(this.state, entry.note, local);
				return;
			}
			if (
				dirty &&
				local.length <= 262144 &&
				info.bytes <= 262144 &&
				info.path.toLowerCase().endsWith('.md') &&
				typeof previous?.base === 'string'
			) {
				decoded = await this.api.peerContents?.(entry.note, entry.manifest, info, undefined, this.onTiming);
				this.assertActive();
				decoded ??= await unpackNote(this.keys, this.api.workspace, entry.note, entry.manifest, load, info, this.onTiming);
				const merged = mergeNote(previous.base, local, decoded.contents);
				if (merged !== undefined) {
					await this.host.write(info.path, merged);
					this.state.notes[entry.note] = {
						path: info.path,
						revision: entry.sequence,
						digest: info.digest,
						downloaded: true,
						removed: false,
						manifest: entry.manifest,
						origin: info.origin,
					};
					rememberBase(this.state, entry.note, decoded.contents);
					return;
				}
			}
			if (dirty) await this.#preserve(info.path, local, entry.sequence);
			const wantsBytes =
				force || info.path.toLowerCase().endsWith('.md') || info.path.startsWith('__smart_sync_configuration__/') || (this.attachmentLimit > 0 && info.bytes <= this.attachmentLimit);
			if (wantsBytes) {
				// Explicit attachment opens use a bounded window; background cycles retain their existing scheduling.
				const downloadOptions = { concurrency: force ? 4 : 1, signal: this.api.signal };
				const resumedLoad = info.bytes > 8 * 1024 * 1024 && this.api.resumeCache
					? this.api.resumeCache.loader(load, info.segments.map(piece => piece.address)) : load;
				if (
					this.host.sink &&
					info.bytes > 8 * 1024 * 1024 &&
					!info.path.startsWith('__smart_sync_configuration__/')
				) {
					const sinkFor = (_, bytes, digest, mtime) => { this.assertActive(); return this.host.sink(info.path, bytes, digest, mtime); };
					const peer = await this.api.peerContents?.(entry.note, entry.manifest, info, sinkFor, this.onTiming);
					this.assertActive();
					if (!peer) await unpackToSink(
						this.keys,
						this.api.workspace,
						entry.note,
						entry.manifest,
						resumedLoad,
						sinkFor,
						info,
						this.onTiming,
						downloadOptions,
					);
				} else {
					const file =
						decoded ??
						(await this.api.peerContents?.(entry.note, entry.manifest, info, undefined, this.onTiming)) ??
						(await unpackNote(this.keys, this.api.workspace, entry.note, entry.manifest, resumedLoad, info, this.onTiming, downloadOptions));
					this.assertActive();
					const written = await this.host.write(info.path, file.contents, info.mtime);
					if (typeof written?.stamp === 'string' && this.host.stamp && written.stamp === await this.host.stamp(info.path)) {
						this.state.localIndex[info.path] = { stamp: written.stamp, digest: info.digest, size: info.bytes };
						unsavedStates.add(this.state);
					}
					decoded = file;
				}
				this.#pendingBytes += info.bytes;
			} else if (local !== null) {
				// Do not overwrite existing bytes with an attachment placeholder or stale content.
				await this.host.remove(info.path);
			}
			this.state.notes[entry.note] = {
				path: info.path,
				revision: entry.sequence,
				digest: info.digest,
				downloaded: wantsBytes,
				removed: false,
				manifest: entry.manifest,
				origin: info.origin,
			};
			if (decoded) rememberBase(this.state, entry.note, decoded.contents);
		} finally {
			if (info.path !== cloudPath && this.state.notes[entry.note])
				this.state.notes[entry.note].path = cloudPath;
		}
	}
	async #removeCompleteTrees(changes) {
		this.#bulkRemoved.clear();
		if (!this.host.removeTree || this.direction === 'update') return;
		const heads = new Map(), counts = new Map();
		for (const entry of changes) { heads.set(entry.note, entry); counts.set(entry.note, (counts.get(entry.note) ?? 0) + 1); }
		const folders = changes.filter(entry => entry.removed && this.state.notes[entry.note]?.kind === 'folder').sort((a,b) => this.state.notes[a.note].path.length - this.state.notes[b.note].path.length);
		if (!folders.length) return;
		const files = await this.host.list(), dirs = await this.host.listFolders?.() ?? [];
		const known = new Map(Object.entries(this.state.notes).filter(([,note]) => !note.removed).map(([id,note]) => [note.path, [id,note]]));
		for (const entry of folders) {
			if (this.#bulkRemoved.has(entry.note)) continue;
			const root = this.state.notes[entry.note].path;
			if (this.host.exists && !await this.host.exists(root)) continue;
			const paths = [...new Set([root,...files.filter(path => path.startsWith(`${root}/`)),...dirs.filter(path => path.startsWith(`${root}/`))])];
			const stamps = [], ids = [];
			let safe = true;
			for (const path of paths) {
				const item = known.get(path), head = item && heads.get(item[0]);
				if (this.excluded(path) || !item || !head?.removed || head.manifest !== item[1].manifest || counts.get(item[0]) !== 1) { safe = false; break; }
				ids.push(item[0]);
				if (item[1].kind !== 'folder') {
					const before = await this.host.stamp?.(path), bytes = await this.host.read(path);
					if (bytes === null || await fingerprint(bytes) !== item[1].digest) { safe = false; break; }
					stamps.push([path,before]);
				}
			}
			if (!safe) continue;
			const current = [...new Set([root,...(await this.host.list()).filter(path => path.startsWith(`${root}/`)),...((await this.host.listFolders?.()) ?? []).filter(path => path.startsWith(`${root}/`))])];
			if (current.length !== paths.length || current.some(path => !known.has(path))) continue;
			for (const [path, stamp] of stamps) {
				if (typeof stamp === 'string') { if (stamp !== await this.host.stamp(path)) safe = false; }
				else { const bytes = await this.host.read(path); if (bytes === null || await fingerprint(bytes) !== known.get(path)[1].digest) safe = false; }
				if (!safe) break;
			}
			if (safe && await this.host.removeTree(root, paths)) for (const id of ids) this.#bulkRemoved.add(id);
		}
	}
	#treeDeletions() {
		return this.state.pendingTreeDeletions ??= {};
	}
	#heldTree(note) {
		return Object.values(this.#treeDeletions()).find(tree => tree.members.includes(note));
	}
	#heldPath(path) {
		return Object.values(this.state.pendingReceives ?? {}).some(entry =>
			[entry.path, this.state.notes[entry.note]?.path].some(held => held &&
				(path === held || path.startsWith(held + '/') || held.startsWith(path + '/')))) ||
			Object.values(this.#treeDeletions()).some(tree => path === tree.path || path.startsWith(tree.path + '/'));
	}
	async #stageTreeDeletions(changes) {
		if (!this.host.removeTree || this.direction === 'update') return;
		const pending = this.#treeDeletions(), heads = new Map(changes.map(entry => [entry.note,entry]));
		const roots = changes.filter(entry => entry.removed && this.state.notes[entry.note]?.kind === 'folder')
			.sort((a,b) => this.state.notes[a.note].path.length - this.state.notes[b.note].path.length);
		for (const entry of roots) {
			if (this.#heldTree(entry.note)) continue;
			const prior = this.state.notes[entry.note];
			if (prior.removed || this.excluded(prior.path)) continue;
			const members = Object.entries(this.state.notes).filter(([,note]) => !note.removed &&
				(note.path === prior.path || note.path.startsWith(prior.path + '/')));
			if (members.some(([,note]) => this.excluded(note.path)) || members.every(([id]) => heads.get(id)?.removed)) continue;
			pending[entry.note] = { path:prior.path, members:members.map(([id]) => id), entries:{}, startedAt:Date.now() };
			unsavedStates.add(this.state);
			await this.#task({note:entry.note,direction:'receive',path:prior.path},async()=> 'deferred');
		}
	}
	async #finishTreeDeletions() {
		const pending = this.#treeDeletions();
		for (const [id,tree] of Object.entries(pending)) {
			const entries = Object.values(tree.entries).sort((a,b) => a.sequence-b.sequence);
			const complete = tree.members.every(note => tree.entries[note]?.removed || this.state.notes[note]?.removed);
			const cancelled = entries.some(entry => !entry.removed);
			if (!complete && !cancelled && Date.now()-tree.startedAt < 300000) continue;
			if (complete && !cancelled) await this.#removeCompleteTrees(entries);
			for (const entry of entries) if (!this.#alreadyApplied(entry)) {
				await this.#receive(entry);
				await this.#persist();
			}
			const live = new Set(Object.values(this.state.notes).filter(note=>!note.removed).map(note=>note.path));
			for (const entry of entries.map(entry=>this.state.notes[entry.note]).filter(note=>note?.removed && note.kind==='folder' && !live.has(note.path)).sort((a,b)=>b.path.length-a.path.length))
				await this.host.removeFolder?.(entry.path);
			delete pending[id];
			unsavedStates.add(this.state);
			await this.#persist();
		}
	}
	async #receiveContent(entries) {
		const paths = [];
		for (const entry of new Map(entries.map(item => [item.note, item])).values()) {
			const previous = this.state.notes[entry.note];
			if (entry.removed || !previous?.downloaded || previous.removed || (previous.kind ?? 'file') !== 'file' ||
				this.#alreadyApplied(entry) || this.excluded(previous.path) || this.#heldPath(previous.path)) continue;
			if (this.#receiveAttempts.has(entry.note + ':' + entry.sequence)) continue;
			try {
				this.assertActive();
				let manifest = this.#windowManifests.get(entry.manifest);
				if (!manifest && this.batchTransfer && typeof this.api.loadBatch === 'function' && this.batchBytes >= 256 * 1024) {
					try { manifest = (await this.timed('download', () => this.api.loadBatch([entry.manifest], this.batchBytes - 128 * 1024))).get(entry.manifest); }
					catch (error) { if ([401, 403].includes(error?.status) || error?.name === 'AbortError') throw error; }
				}
				manifest ??= await this.api.load(entry.manifest);
				const info = await inspectNote(this.keys, this.api.workspace, entry.note, entry.manifest, async () => manifest);
				if (manifest.length <= 128 * 1024) {
					let retained = [...this.#windowManifests.values()].reduce((sum, body) => sum + body.length, 0);
					for (const [address, body] of this.#windowManifests) {
						if (retained + manifest.length <= 128 * 1024) break;
						this.#windowManifests.delete(address); retained -= body.length;
					}
					this.#windowManifests.set(entry.manifest, manifest);
				}
				// Paths and deletions keep their dependency order; only existing file content jumps the queue.
				if (info.path !== previous.path || info.kind === 'folder' || info.digest === previous.digest) continue;
				this.#prefetchedInfo.set(entry.note + entry.manifest, info);
				await this.#receive(entry);
				await this.#persist();
				paths.push(previous.path);
			} catch (error) {
				this.#receiveAttempts.add(entry.note + ':' + entry.sequence);
				await this.#recordReceiveFailure(entry, error);
			}
		}
		return paths;
	}
	async #prioritizeContent() {
		if (['receive', 'paused'].includes(this.direction) || ['receive', 'paused'].includes(this.remoteMode)) return [];
		const selected = [...this.contentPriorities].slice(0, 16);
		if (!selected.length) return [];
		this.assertActive();
		await this.#send(undefined, undefined, undefined, false, selected.map(([path]) => path).filter(path => !renameSources(path, this.renames).length));
		for (const [path, generation] of selected)
			if (this.contentPriorities.get(path) === generation) this.contentPriorities.delete(path);
		return selected.map(([path]) => path);
	}
	async #cycle(target, ceiling) {
		this.host.setRemoteReader?.(path => this.#remoteFile(path));
		this.#bulkRemoved.clear();
		const targets = target ? new Set(Array.isArray(target) ? target : [target]) : undefined;
		if (this.direction === 'paused' || this.remoteMode === 'paused') return;
		this.assertActive();
		await this.#recoverCommit();
		const version = this.scanVersion?.();
		let remoteChanged = false;
		const receivedRemovals = new Set();
		if (this.direction !== 'send' && this.remoteMode !== 'send') {
			const changes = [];
			let replayCursorDirty = false;
			let cursor = this.state.cursor;
			for (;;) {
				const batch = await this.api.feed(cursor);
				if (
					!batch ||
					!Array.isArray(batch.entries) ||
					typeof batch.more !== 'boolean' ||
					(batch.more && batch.entries.length === 0)
				)
					throw new Error('Invalid change feed');
				for (const entry of batch.entries) {
					if (ceiling !== undefined && entry.sequence > ceiling)
						throw Object.assign(new Error('Plan changed'), { code: 'PLAN_CHANGED' });
					if (!validEntry(entry, cursor)) throw new Error('Invalid change sequence');
					remoteChanged = true;
					cursor = entry.sequence;
					changes.push(entry);
				}
				if (!batch.more) break;
			}
			// Read all pages before applying: historical intermediate paths can be
			// occupied by the latest files retained across a reconnect. Only each
			// note's newest validated revision describes the desired remote state.
			const newest = new Map(changes.map(entry => [entry.note, entry.sequence]));
			const pending = Object.values(this.state.pendingReceives ?? {}).filter(entry =>
				(newest.get(entry.note) ?? 0) < entry.sequence);
			if (ceiling !== undefined && pending.some(entry => entry.sequence > ceiling))
				throw Object.assign(Error('Plan changed'), { code: 'PLAN_CHANGED' });
			changes.push(...pending);
			changes.sort((a, b) => a.sequence - b.sequence);
			const heads = new Map(changes.map((entry) => [entry.note, entry]));
			this.#remoteHeads = heads;
			const current = changes.filter(entry => heads.get(entry.note) === entry);
			await this.beforeDelete(
				[...heads.values()].filter(
					(entry) =>
						entry.removed && (this.state.notes[entry.note]?.revision ?? 0) < entry.sequence,
				).length,
				{ direction: 'receive' },
			);
			if (!targets && ceiling === undefined) {
				await this.#receiveContent(current);
				this.#contentPoll = async () => {
					const fresh = [];
					for (;;) {
						this.assertActive();
						const batch = await this.api.feed(cursor);
						if (!Array.isArray(batch?.entries) || typeof batch.more !== 'boolean' || (batch.more && !batch.entries.length)) throw Error('Invalid change feed');
						for (const entry of batch.entries) {
							if (!validEntry(entry, cursor)) throw Error('Invalid change sequence');
							cursor = entry.sequence;
							this.#remoteHeads.set(entry.note, entry);
							this.#remoteFiles.clear();
							fresh.push(entry);
						}
						if (!batch.more) break;
					}
					// Applying ahead never advances the durable feed cursor across pending bulk entries.
					return this.#receiveContent(fresh);
				};
			}
			await this.#stageTreeDeletions(current);
			await this.#removeCompleteTrees(current.filter(entry => !this.#heldTree(entry.note)));
			let windowIndex = 0, nextPrefetch = 0;
			for (const entry of changes) {
				if (!targets && ceiling === undefined) await this.#prioritizeContent();
				const held = this.#heldTree(entry.note);
				if (held && heads.get(entry.note) === entry) {
					held.entries[entry.note] = entry;
					this.state.cursor = Math.max(this.state.cursor, entry.sequence);
					unsavedStates.add(this.state);
					await this.#persist();
					replayCursorDirty = false;
					continue;
				}
				if (this.#alreadyApplied(entry) && (this.state.pendingReceives?.[entry.note]?.sequence ?? Infinity) <= entry.sequence) {
					delete this.state.pendingReceives[entry.note];
					this.#receiveFailures.delete(entry.note);
				}
				if (heads.get(entry.note) !== entry || this.#alreadyApplied(entry)) {
					this.state.cursor = Math.max(this.state.cursor, entry.sequence);
					replayCursorDirty = true;
					continue;
				}
				while (current[windowIndex] !== entry) windowIndex++;
				if (windowIndex >= nextPrefetch) {
					if (windowIndex > 0) await this.#contentPoll?.();
					const windowEntries = current.slice(windowIndex, windowIndex + this.batchFiles);
					if (!windowEntries.some(item => item.removed)) nextPrefetch = windowIndex + await this.#prefetch(windowEntries);
				}
				this.onProgress(t('msg_f6a511393c', { sequence: entry.sequence }));
				await this.#receive(entry);
				const applied = this.state.notes[entry.note];
				if (entry.removed && applied?.removed && applied.revision === entry.sequence) receivedRemovals.add(applied.path);
				this.state.cursor = Math.max(this.state.cursor, entry.sequence);
				await this.#persist();
				replayCursorDirty = false;
			}
			// Unapplied revisions remain in the durable retry queue. Skipped
			// history after the final applied change needs only one checkpoint.
			if (replayCursorDirty) await this.#persist();
		}
		// A mobile-compatible manifest update can unblock files skipped on an earlier run.
		for (const [note, value] of Object.entries(this.state.notes)) {
			if (value.platformSkipped === 'desktop-plugin' && !value.removed && !this.excluded(value.path)) {
				await this.#receive({ note, manifest: value.manifest, sequence: value.revision, removed: false });
				await this.#persist();
			}
		}
		await this.#finishTreeDeletions();
		if (receivedRemovals.size) {
			const removedPaths = [...receivedRemovals];
			const livePaths = new Set(Object.values(this.state.notes).filter(note => !note.removed).map(note => note.path));
			for (const note of Object.values(this.state.notes)
				.filter(note => note.removed && note.kind === 'folder' && !livePaths.has(note.path) &&
					removedPaths.some(path => path === note.path || path.startsWith(`${note.path}/`)))
				.sort((a, b) => b.path.length - a.path.length))
				await this.host.removeFolder?.(note.path);
		}
		if (this.direction === 'receive' || this.remoteMode === 'receive') return;
		await this.#send(targets, ceiling, version, remoteChanged);
	}
	async #send(targets, ceiling, version, remoteChanged, priorityPaths) {
		if (this.#completed.some(task => task.direction === 'receive')) await this.#flush();
		if (Object.values(this.state.pendingReceives ?? {}).some(entry => !entry.path)) return;
		const cache = this.scanCache;
		let incrementalPlan;
		if (!priorityPaths && !targets && ceiling === undefined && this.incrementalInventory && this.scanPolicy !== undefined) {
			incrementalPlan = this.incrementalInventory.begin(this.state, this.scanPolicy,
				remoteChanged || Object.keys(this.renames).length > 0 || Object.keys(this.state.pendingReceives ?? {}).length > 0 || Object.keys(this.state.pendingTreeDeletions ?? {}).length > 0);
			if (!incrementalPlan.full) {
				if (!incrementalPlan.paths.length) { this.incrementalInventory.finish(incrementalPlan); return; }
				const known = new Map();
				for (const note of Object.values(this.state.notes)) if (!note.removed && note.downloaded && (note.kind ?? 'file') === 'file')
					known.set(note.path, (known.get(note.path) ?? 0) + 1);
				if (incrementalPlan.paths.some(path => known.get(path) !== 1 || this.excluded(path))) incrementalPlan.full = true;
				else {
					priorityPaths = incrementalPlan.paths;
				}
			}
		}
		if (!incrementalPlan && !targets && ceiling === undefined && !remoteChanged && version !== undefined &&
			!Object.keys(this.renames).length && cache?.state === this.state &&
			cache.version === version && Date.now() >= cache.at && Date.now() - cache.at < 60000) return;
		let files = (priorityPaths ?? await this.host.list()).filter(path => !this.#heldPath(path));
		const listedFolders = (priorityPaths ? [] : ((await this.host.listFolders?.()) ?? [])).filter(
			(path) => !this.excluded(path) && !this.#heldPath(path),
		);
		const folderAliases = new Map();
		if (this.host.canonicalPath) {
			for (let offset = 0; offset < listedFolders.length; offset += 16) {
				const batch = listedFolders.slice(offset, offset + 16);
				const canonical = await Promise.all(batch.map(path => this.host.canonicalPath(path)));
				for (let index = 0; index < batch.length; index++) folderAliases.set(batch[index], safeNotePath(canonical[index]));
			}
			files = [...new Set(files.map(path => {
				const slash = path.lastIndexOf('/'), parent = path.slice(0, slash);
				return slash >= 0 && folderAliases.has(parent) ? folderAliases.get(parent) + path.slice(slash) : path;
			}))];
		}
		const folders = [...new Set(listedFolders.map(path => folderAliases.get(path) ?? path))].filter(path => !this.excluded(path));
		const paths = [
			...folders.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b)),
			...files,
		];
		const present = new Set(paths);
		const folderSet = new Set(folders);
		const known = Object.entries(this.state.notes);
		const removedFolders = new Map();
		for (const [,note] of known) if (note.removed && note.kind === 'folder')
			removedFolders.set(note.path, Math.max(removedFolders.get(note.path) ?? 0, note.revision));
		const pendingDeletedFolders = new Set();
		for (const [,note] of known) if (!note.removed && note.downloaded) {
			let parent = note.path;
			while (parent.includes('/')) {
				parent = parent.slice(0,parent.lastIndexOf('/'));
				if ((removedFolders.get(parent) ?? 0) > note.revision) pendingDeletedFolders.add(parent);
			}
		}
		const byPath = new Map(
			known.filter(([, note]) => !note.removed).map((entry) => [entry[1].path, entry]),
		);
		const bySpelling = new Map();
		for (const item of known) if (!item[1].removed) {
			const key = item[1].path.toLowerCase();
			if (!bySpelling.has(key)) bySpelling.set(key, []);
			bySpelling.get(key).push(item);
		}
		const missing = (priorityPaths ? [] : known).filter(
			([, note]) =>
				!note.removed && note.downloaded && !present.has(note.path) && !this.excluded(note.path) && !this.#heldPath(note.path),
		);
		const repathCandidates = missing.filter(([,note]) => (note.kind ?? 'file') === 'file');
		const repathPositions = new Map(repathCandidates.map(([id],index)=>[id,index]));
		let repathObjects = new Map(), repathBatchFailed = false;
		const reusableInfo = async (id,previous) => {
			if (this.batchTransfer && !repathBatchFailed && typeof this.api.loadBatch === 'function' && (previous.kind ?? 'file') === 'file' && !repathObjects.has(previous.manifest)) {
				const offset = repathPositions.get(id);
				const candidates = offset === undefined ? [] : repathCandidates.slice(offset,offset+this.batchFiles);
				const addresses = [...new Set([previous.manifest,...candidates.filter(([note,value])=>this.state.notes[note]===value).map(([,value])=>value.manifest)])].slice(0,this.batchFiles);
				repathObjects.clear();
				try {
					repathObjects = await this.timed('download', () => this.api.loadBatch(addresses,this.batchBytes));
					this.assertActive();
				} catch (error) {
					repathObjects.clear();
					if (error?.status===401 || error?.status===403 || error?.name==='AbortError') throw error;
					repathBatchFailed = true;
				}
			}
			// Every manifest still passes the original note/workspace/address authentication.
			return inspectNote(this.keys,this.api.workspace,id,previous.manifest,async address=>{
				if (!repathObjects.has(address)) return this.api.load(address);
				const bytes = repathObjects.get(address);repathObjects.delete(address);return bytes;
			});
		};
		const used = new Set(Object.keys(this.state.notes));
		let queuedBytes = 0, queuedStartedAt = 0;
		const flushUploads = async () => {
			const groupedCheckpoint = this.commitJournal && this.checkpointSize > 1;
			const jobs = this.#queuedUploads.splice(0);
			queuedBytes = 0;
			queuedStartedAt = 0;
			if (!jobs.length) return;
			try {
				const objects = jobs.flatMap(job => job.packed.objects);
				await this.api.storeBatch(objects);
				for (const job of jobs) {
					job.task.bytes = job.packed.objects.reduce((sum, object) => sum + object.body.length, 0);
					job.task.total = job.task.bytes;
					await this.onTask({ ...job.task, status: 'progress' });
					if (job.repath && typeof job.stamp === 'string') {
						if (job.stamp !== await this.host.stamp(job.path)) throw Object.assign(new Error('Source changed during batch rename'), { code: 'PLAN_CHANGED' });
					} else {
						const current = await this.host.read(job.path);
						if (current === null || (await fingerprint(current)) !== job.digest) throw Object.assign(new Error('Source changed during batch upload'), { code: 'PLAN_CHANGED' });
					}
					if (job.repath && job.mtime !== undefined && job.mtime !== await this.host.mtime(job.path)) throw Object.assign(new Error('Source time changed during batch rename'), { code: 'PLAN_CHANGED' });
					if (job.packed.info.mtime !== undefined && await this.host.mtime(job.path) !== job.packed.info.mtime)
						throw Object.assign(new Error('Source time changed during batch upload'), { code: 'PLAN_CHANGED' });
				}
				const reply = { entries: await this.#submitCommit(jobs.map(job => ({ note: job.id, pathKey: job.pathKey, expected: job.previous?.revision ?? 0, manifest: job.packed.manifest, logicalBytes: job.packed.info.bytes, objects: [...job.packed.info.segments.map(piece => piece.address), job.packed.manifest], removed: false })), jobs.map(job => ({ path: job.path, kind: 'file', digest: job.digest })), true) };
				if (!Array.isArray(reply?.entries) || reply.entries.length !== jobs.length || reply.entries.some((entry, index) => !validEntry(entry, 0) || entry.note !== jobs[index].id || entry.manifest !== jobs[index].packed.manifest || entry.removed)) throw Error('Invalid batch commit acknowledgement');
				for (let index = 0; index < jobs.length; index++) {
					const job = jobs[index];
					this.state.notes[job.id] = { ...(job.repath ? job.previous : {}), path: job.path, kind: 'file', revision: reply.entries[index].sequence, digest: job.digest, downloaded: true, removed: false, manifest: job.packed.manifest };
					used.add(job.id);
					if (job.previous) byPath.delete(job.previous.path);
					byPath.set(job.path, [job.id, this.state.notes[job.id]]);
					if (job.contents !== undefined) rememberBase(this.state, job.id, job.contents);
					this.#completed.push({ ...job.task, status: 'done', workMilliseconds: Math.max(0, performance.now() - job.task.workStartedAt), completedAt: performance.now() });
					if (!groupedCheckpoint) await this.#persist();
				}
				// The durable intent covers the entire bounded batch until every receipt is applied.
				if (groupedCheckpoint) await this.#persist(jobs.length);
				await this.#finishCommit(false, true);
			} catch (error) {
				for (const job of jobs) await this.onTask({ ...job.task, status: 'failed', error }).catch(() => {});
				throw error;
			}
		};

		const digests = new Map();
		// Fingerprints, never whole-vault file bytes, are retained for tree matching.
		let digestsReady = false;
		const ensureTreeDigests = async () => {
			if (digestsReady) return;
			for (const path of files)
				if (!this.excluded(path)) {
					const file = await this.localFile(path);
					if (file !== null) digests.set(path, file.digest);
				}
			digestsReady = true;
		};
		const treeDigest = async (root, entries) =>
			fingerprint(
				new TextEncoder().encode(
					JSON.stringify(
						entries
							.filter(([path]) => path.startsWith(`${root}/`))
							.map(([path, kind, digest]) => [path.slice(root.length + 1), kind, digest])
							.sort((a, b) => a[0].localeCompare(b[0])),
					),
				),
			);
		const priorTrees = known
			.filter(([, note]) => !note.removed)
			.map(([, note]) => [
				note.path,
				note.kind ?? 'file',
				note.kind === 'folder' ? '' : note.digest,
			]);
		const currentTrees = () => paths
			.filter((path) => !this.excluded(path))
			.map((path) => [
				path,
				folderSet.has(path) ? 'folder' : 'file',
				folderSet.has(path) ? '' : digests.get(path),
			]);
		const scanTotal = paths.filter(path => !this.excluded(path)).length;
		this.onProgress(t('sync.checked', { checked: 0, total: scanTotal }), { checked: 0, total: scanTotal });
		let checked = 0,
			lastYield = Date.now();
		for (const raw of paths) {
			if (!priorityPaths && !targets && ceiling === undefined && (this.contentPriorities.size || (checked > 0 && checked % this.batchFiles === 0 && this.#contentPoll))) {
				// Finish an existing batch before sharing the normal send pipeline.
				await flushUploads();
				const prioritized = new Set([...(await this.#contentPoll?.() ?? []), ...await this.#prioritizeContent()]);
				for (const [id, note] of Object.entries(this.state.notes))
					if (!note.removed && prioritized.has(note.path)) { byPath.set(note.path, [id, note]); used.add(id); present.add(note.path); }
			}
			this.assertActive();
			const path = safeNotePath(raw);
			if (this.excluded(path)) continue;
			const kind = folderSet.has(path) ? 'folder' : 'file';
			const file =
				kind === 'folder'
					? { contents: new Uint8Array(), digest: await fingerprint(new Uint8Array()) }
					: await this.localFile(path);
			if (file === null && priorityPaths && !incrementalPlan) continue;
			if (file === null)
				throw Object.assign(new Error('Inventory changed during synchronization'), {
					code: 'PLAN_CHANGED',
				});
			const digest = file.digest;
			this.assertActive();
			let found = byPath.get(path);
			if (++checked % 100 === 0 || checked === scanTotal) {
				this.onProgress(t('sync.checked', { checked, total: scanTotal }), { checked, total: scanTotal });
				if (Date.now() - lastYield >= 16) {
					await this.yieldWork();
					lastYield = Date.now();
				}
			}
			// A parent tombstone may arrive before its children. The still occupied
			// physical folder belongs to that deletion, rather than a user recreation.
			if (kind === 'folder' && !found && pendingDeletedFolders.has(path)) continue;
			if (!found) {
				const aliases = [];
				if (this.host.sameEntry) for (const candidate of bySpelling.get(path.toLowerCase()) ?? []) {
					const [id, note] = candidate;
					if (note.path !== path && note.downloaded && (note.kind ?? 'file') === kind && this.state.notes[id] === note &&
						!this.excluded(note.path) && await this.host.sameEntry(note.path, path)) aliases.push(candidate);
				}
				if (aliases.length === 1) found = aliases[0];
			}
			if (!found) {
				let candidates = missing.filter(
					([id, note]) =>
						!note.removed &&
						note.downloaded &&
						(note.kind ?? 'file') === kind &&
						!present.has(note.path) &&
						!this.excluded(note.path) &&
						this.state.notes[id] === note,
				);
				const sources = new Set(renameSources(path, this.renames));
				const explicit = candidates.filter(([, note]) => sources.has(note.path));
				if (explicit.length) candidates = explicit;
				else {
					let folderDigest;
					if (kind === 'folder' && candidates.length) {
						// Explicit SDK renames already identify the folder. Only an
						// ambiguous physical move needs descendant fingerprints first.
						await ensureTreeDigests();
						folderDigest = await treeDigest(path, currentTrees());
					}
					const matches = [];
					for (const candidate of candidates)
						if (
							kind === 'folder'
								? (await treeDigest(candidate[1].path, priorTrees)) === folderDigest
								: candidate[1].digest === digest
						)
							matches.push(candidate);
					candidates = matches;
				}
				if (candidates.length === 1) found = candidates[0];
			}
			const previous = found?.[1];
			if (previous && previous.path === path && previous.digest === digest) continue;
			const pathKey = await opaqueNoteId(this.keys, path);
			let id = found?.[0] ?? pathKey;
			if (!found && used.has(id))
				id = await fingerprint(crypto.getRandomValues(new Uint8Array(32)));
			if (targets && !targets.has(id) && !targets.has(pathKey)) continue;
			if (this.direction === 'update' && (!previous || previous.removed)) continue;
			if (this.batchTransfer && typeof this.api.storeBatch === 'function' && typeof this.api.commitBatch === 'function' && kind === 'file' && previous?.digest === digest) {
				await this.#task({ note: id, pathKey, direction: 'send', path }, async () => {
					const reusable = await reusableInfo(id,previous);
					const packed = await repathNote(this.keys, this.api.workspace, id, path, reusable);
					const size = packed.objects.reduce((sum, object) => sum + object.body.length + 128, 0);
					if (this.#queuedUploads.length >= this.batchFiles || queuedBytes + size > this.batchBytes - 128 * 1024 || (this.#queuedUploads.length && Date.now() - queuedStartedAt >= this.batchWaitMs)) await flushUploads();
					this.#queuedUploads.push({ repath: true, task: this.#active, packed, id, pathKey, path, digest, previous, stamp: await this.host.stamp?.(path), mtime: file.mtime });
					if (!queuedStartedAt) queuedStartedAt = Date.now();
					queuedBytes += size;
					return 'staged';
				});
				continue;
			}
			const contents = file.contents ?? (await this.host.read(path));
			if (contents === null || (await fingerprint(contents)) !== digest)
				throw Object.assign(new Error('Source changed before transfer'), { code: 'PLAN_CHANGED' });
			if (this.batchTransfer && typeof this.api.storeBatch === 'function' && typeof this.api.commitBatch === 'function' && kind === 'file' && !missing.length && !contents.streamed && contents.length <= Math.min(512 * 1024, this.batchBytes - 128 * 1024)) {
				const packed = await this.timed('pack', () => packNote(this.keys, this.api.workspace, path, contents, undefined, id, kind, file.mtime));
				// Count retained plaintext too, so highly compressible files cannot fill an oversized queue.
				const size = contents.length + packed.objects.reduce((sum, object) => sum + object.body.length + 128, 0);
				if (this.#queuedUploads.length >= this.batchFiles || queuedBytes + size > this.batchBytes - 128 * 1024 || (this.#queuedUploads.length && Date.now() - queuedStartedAt >= this.batchWaitMs)) await flushUploads();
				await this.#task({ note: id, pathKey, direction: 'send', path }, async () => {
					this.#queuedUploads.push({ task: this.#active, packed, id, pathKey, path, digest, contents, previous });
					if (!queuedStartedAt) queuedStartedAt = Date.now();
					queuedBytes += size;
					return 'staged';
				});
				continue;
			}
			await flushUploads();
			await this.#task({ note: id, pathKey, direction: 'send', path }, async () => {
				const reusable =
					previous && previous.digest === digest
						? await reusableInfo(id,previous)
						: undefined;
				const packed = reusable
					? await repathNote(this.keys, this.api.workspace, id, path, reusable)
					: await this.timed('pack', () => packNote(this.keys, this.api.workspace, path, contents, undefined, id, kind, file.mtime));
				try {
					this.onProgress(t('msg_a8abfc9b25', { path: path, length: formatStorageSize(contents.length) }));
					const uploadStarted = Date.now(),
						total = packed.objects.reduce(
							(sum, object) => sum + (object.body?.length ?? object.bytes),
							0,
						);
					let sent = 0;
					this.#active.total = total;
					const store = async object => {
						const body = object.body ?? (await object.load());
						await this.api.store({ address: object.address, body });
						sent += body.length;
						this.#active.bytes = sent;
						await this.onTask({ ...this.#active, status: 'progress' });
						const rate = sent / Math.max(0.001, (Date.now() - uploadStarted) / 1000),
							eta = Math.ceil((total - sent) / rate);
						this.onProgress(
							t('msg_de18758129', {
								path: path,
								sent: formatStorageSize(sent),
								total: formatStorageSize(total),
								value3: formatStorageSize(rate),
								eta: eta,
							}),
						);
					};
					for (let offset = 0; offset < packed.objects.length; offset += this.uploadConcurrency) {
						// Drain every started request before disposal or retry; commit only after all objects exist.
						const batch = await Promise.allSettled(packed.objects.slice(offset, offset + this.uploadConcurrency).map(store));
						const failed = batch.find(result => result.status === 'rejected');
						if (failed) throw failed.reason;
					}
					if (kind === 'file') {
						const current = await this.host.read(path);
						if (current === null || (await fingerprint(current)) !== digest)
							throw Object.assign(new Error('Local content changed during upload'), {
								code: 'PLAN_CHANGED',
							});
						if (file.mtime !== undefined && await this.host.mtime(path) !== file.mtime)
							throw Object.assign(new Error('Source time changed during upload'), { code: 'PLAN_CHANGED' });
					}
					const [committed] = await this.#submitCommit([{ note: id,
						pathKey,
						expected: previous?.revision ?? 0,
						manifest: packed.manifest,
						logicalBytes: packed.info.bytes,
						objects: [...packed.info.segments.map((piece) => piece.address), packed.manifest],
						removed: false,
					}], [{ path, kind, digest }]);
					if (
						!validEntry(committed, 0) ||
						committed.note !== id ||
						committed.removed ||
						committed.manifest !== packed.manifest
					)
						throw new Error('Invalid commit acknowledgement');
					this.state.notes[id] = {
						path,
						kind,
						revision: committed.sequence,
						digest,
						downloaded: true,
						removed: false,
						manifest: packed.manifest,
					};
					used.add(id);
					if (previous) byPath.delete(previous.path);
					byPath.set(path, [id, this.state.notes[id]]);
					if (kind === 'file') rememberBase(this.state, id, contents);
					await this.#finishCommit();
				} finally {
					await packed.dispose?.();
				}
			});
		}
		await flushUploads();
		if (priorityPaths) {
			if (incrementalPlan) this.incrementalInventory.finish(incrementalPlan);
			return;
		}
		if (!targets && ceiling === undefined) await this.#prioritizeContent();
		const deletions = [];
		for (const [id, previous] of Object.entries(this.state.notes)) {
			if (targets && !targets.has(id)) continue;
			if (this.direction === 'update') break;
			if (
				previous.removed ||
				this.#heldPath(previous.path) ||
				!previous.downloaded ||
				present.has(previous.path) ||
				this.excluded(previous.path)
			)
				continue;
			const exists = this.host.exists
				? await this.host.exists(previous.path)
				: (await this.host.read(previous.path)) !== null;
			if (exists)
				throw Object.assign(new Error('Incomplete local inventory'), { code: 'PLAN_CHANGED' });
			deletions.push([id, previous]);
		}
		await this.beforeDelete(deletions.length, { direction: 'send', items: deletions.map(([note, previous]) => ({ note, revision: previous.revision, path: previous.path, kind: previous.kind })) });
		const batchDelete = this.batchDeletes && typeof this.api.commitBatch === 'function';
		if (batchDelete) {
			for (let offset = 0; offset < deletions.length; offset += 128) {
				const batch = deletions.slice(offset, offset + 128);
				for (const [, previous] of batch)
					if (this.host.exists ? await this.host.exists(previous.path) : await this.host.read(previous.path) !== null)
						throw Object.assign(new Error('Local path reappeared before batch deletion'), { code: 'PLAN_CHANGED' });
				const reply = { entries: await this.#submitCommit(batch.map(([note, previous]) => ({ note, expected: previous.revision, removed: true })), batch.map(([, previous]) => previous), true) };
				if (!Array.isArray(reply?.entries) || reply.entries.length !== batch.length || reply.entries.some((entry,index) => !validEntry(entry,0) || entry.note !== batch[index][0] || !entry.removed)) throw Error('Invalid batch deletion acknowledgement');
				for (let index = 0; index < batch.length; index++) {
					const [id, previous] = batch[index];
					await this.#task({ note: id, direction: 'delete', path: previous.path }, async () => {
						this.state.notes[id] = { ...previous, revision: reply.entries[index].sequence, removed: true, downloaded: false };
						await this.#persist();
					});
				}
				await this.#finishCommit(false, true);
			}
		}
		for (const [id, previous] of batchDelete ? [] : deletions) {
			await this.#task({ note: id, direction: 'delete', path: previous.path }, async () => {
				if (
					this.host.exists
						? await this.host.exists(previous.path)
						: (await this.host.read(previous.path)) !== null
				)
					throw Object.assign(new Error('Local path reappeared before deletion'), {
						code: 'PLAN_CHANGED',
					});
				const [committed] = await this.#submitCommit([{ note: id, expected: previous.revision, removed: true }], [previous]);
				if (!validEntry(committed, 0) || committed.note !== id || !committed.removed)
					throw new Error('Invalid deletion acknowledgement');
				this.state.notes[id] = {
					...previous,
					revision: committed.sequence,
					removed: true,
					downloaded: false,
				};
				await this.#finishCommit();
			});
		}
		for (const path of Object.keys(this.state.localIndex))
			if (!present.has(path)) { delete this.state.localIndex[path]; unsavedStates.add(this.state); }
		if (incrementalPlan) this.incrementalInventory.finish(incrementalPlan);
		if (cache && !targets && ceiling === undefined && version !== undefined && this.scanVersion() === version)
			Object.assign(cache, { state: this.state, version, at: Date.now() });
	}
	async download(note) {
		const current = this.state.notes[note];
		if (!current || current.removed || !current.manifest)
			throw new Error('Attachment is not available');
		await this.#receive(
			{
				note,
				sequence: current.revision,
				manifest: current.manifest,
				removed: false,
			},
			true,
		);
		await this.#persist();
	}
	async evict(note) {
		const current = this.state.notes[note];
		if (!current || current.removed || current.path.toLowerCase().endsWith('.md'))
			throw new Error('Select a downloaded attachment');
		const bytes = await this.host.read(current.path);
		if (bytes !== null && (await fingerprint(bytes)) !== current.digest)
			throw new Error('Synchronize the edited attachment before removing its local copy');
		if (bytes !== null) await this.host.remove(current.path);
		current.downloaded = false;
		await this.#persist();
	}
	async resolve(copy, choice) {
		if (!['local', 'remote', 'both'].includes(choice)) throw new Error('Invalid conflict choice');
		const conflict = this.state.conflicts.find((entry) => entry.copy === copy);
		if (!conflict) return;
		if (choice === 'local') {
			const contents = await this.host.read(conflict.copy);
			if (contents === null) throw new Error('Local conflict copy is missing');
			await this.host.write(conflict.path, contents);
		}
		if (choice !== 'both') await this.host.remove(conflict.copy);
		this.state.conflicts = this.state.conflicts.filter((entry) => entry !== conflict);
		await this.#persist();
	}
}

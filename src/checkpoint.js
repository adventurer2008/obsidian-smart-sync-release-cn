import { fingerprint } from './codec.js';

const encoder = new TextEncoder();
const filename = /^(?:base|patch|archive)-[a-f0-9-]{36}\.json$/;
const own = (object, key, value) => Object.defineProperty(object, key, { value, enumerable: true, writable: true, configurable: true });

function encodeRecord(value, previous) {
	// Notes and local-index records normally contain only primitive fields.
	// Compare those fields, not object identity: the engine updates records in place.
	// Unknown/nested shapes always use the original serializer to observe mutations.
	if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype)
		return { text: JSON.stringify(value) };
	const keys = Object.keys(value);
	if (keys.some(key => value[key] !== null && ['object', 'function'].includes(typeof value[key])))
		return { text: JSON.stringify(value) };
	if (previous?.keys?.length === keys.length && keys.every((key, index) => key === previous.keys[index] && Object.is(value[key], previous.values[index]))) return previous;
	return { keys, values: keys.map(key => value[key]), text: JSON.stringify(value) };
}

// Immutable files are staged before the small SDK configuration commits their
// descriptor. An interrupted/failed write can never publish an incomplete delta.
export class ConnectionCheckpoints {
	constructor(adapter, folder, commit) {
		this.adapter = adapter;
		this.folder = folder;
		this.commit = commit;
		this.serial = Promise.resolve();
		this.shadow = new Map();
		this.descriptor = undefined;
		this.deltaBytes = 0;
		this.archiveEntries = new WeakMap();
		this.lastConfiguration = undefined;
		this.recordEncodings = new Map();
	}
	encode(connections) {
		const result = new Map();
		const encodings = new Map();
		for (const [id, state] of Object.entries(connections)) {
			const { notes = {}, localIndex = {}, ...rest } = state;
			result.set(JSON.stringify([id]), JSON.stringify(rest));
			for (const [kind, values] of [['notes', notes], ['localIndex', localIndex]])
				for (const key in values) if (Object.hasOwn(values, key)) {
					const recordKey = JSON.stringify([id, kind, key]);
					const encoded = encodeRecord(values[key], this.recordEncodings.get(recordKey));
					encodings.set(recordKey, encoded);
					result.set(recordKey, encoded.text);
				}
		}
		// Keep only the current capture, including after deletions/workspace changes.
		this.recordEncodings = encodings;
		return result;
	}
	decode(records) {
		const result = {};
		for (const [key, value] of records) {
			const parts = JSON.parse(key);
			if (!Array.isArray(parts) || ![1, 3].includes(parts.length) || !parts.every(part => typeof part === 'string') || (parts.length === 3 && !['notes', 'localIndex'].includes(parts[1]))) throw Error('Invalid checkpoint key');
			if (parts.length === 1) own(result, parts[0], { ...JSON.parse(value), notes: {}, localIndex: {} });
		}
		for (const [key, value] of records) {
			const [id, kind, name] = JSON.parse(key);
			if (kind) {
				if (!Object.hasOwn(result, id)) throw Error('Missing checkpoint connection');
				own(result[id][kind], name, JSON.parse(value));
			}
		}
		return result;
	}
	async read(entry, size) {
		if (!entry || !filename.test(entry.file) || !/^[a-f0-9]{64}$/.test(entry.hash)) throw Error('Invalid checkpoint descriptor');
		const text = await this.adapter.read(`${this.folder}/${entry.file}`);
		const bytes = encoder.encode(text);
		if (await fingerprint(bytes) !== entry.hash) throw Error('Checkpoint integrity check failed');
		if (size) size.bytes += bytes.length;
		return JSON.parse(text);
	}
	async load(data) {
		if (![4, 5].includes(data?.format)) return data;
		const descriptor = data.checkpoint;
		if (!descriptor || descriptor.format !== 1 || !Array.isArray(descriptor.patches) || descriptor.patches.length > 64) throw Error('Invalid connection checkpoints');
		const base = await this.read(descriptor.base);
		if (base.format !== 1 || !Array.isArray(base.records)) throw Error('Invalid checkpoint base');
		const records = new Map(base.records), size = { bytes: 0 };
		for (const entry of descriptor.patches) {
			const patch = await this.read(entry, size);
			if (patch.format !== 1 || !Array.isArray(patch.set) || !Array.isArray(patch.remove)) throw Error('Invalid checkpoint patch');
			for (const key of patch.remove) records.delete(key);
			for (const [key, value] of patch.set) records.set(key, value);
		}
		const { checkpoint, archiveCheckpoint, ...rest } = data;
		if (data.format === 5) {
			if (Object.hasOwn(data, 'archives') || archiveCheckpoint?.format !== 1 || !Array.isArray(archiveCheckpoint.entries)) throw Error('Invalid archive checkpoints');
			rest.archives = [];
			for (const entry of archiveCheckpoint.entries) {
				if (!/^archive-[a-f0-9-]{36}\.json$/.test(entry?.file)) throw Error('Invalid archive descriptor');
				const archived = await this.read(entry);
				if (archived.format !== 1 || !archived.value || typeof archived.value !== 'object' || Array.isArray(archived.value)) throw Error('Invalid archive checkpoint');
				this.captureArchive(archived.value);
				this.archiveEntries.get(archived.value).entry = { ...entry };
				rest.archives.push(archived.value);
			}
		} else if (archiveCheckpoint !== undefined) throw Error('Unexpected archive checkpoints');
		this.descriptor = descriptor;
		this.shadow = records;
		// Keep the verified delta budget across restarts; byte/count caps still compact.
		this.deltaBytes = size.bytes;
		return { ...rest, format: 3, connections: this.decode(records) };
	}
	captureArchive(value) {
		if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid archive');
		if (!this.archiveEntries.has(value)) {
			// An archived connection is detached history. Freeze once so later
			// saves can safely reuse its immutable reference without deep clones.
			const visit = [value], seen = new WeakSet();
			while (visit.length) {
				const item = visit.pop();
				if (seen.has(item)) continue;
				seen.add(item);
				for (const child of Object.values(item)) if (child && typeof child === 'object') visit.push(child);
				Object.freeze(item);
			}
			this.archiveEntries.set(value, { value });
		}
		return this.archiveEntries.get(value);
	}
	configuration(data) {
		const { connections, archives, archiveCheckpoint, ...config } = data;
		if (archives !== undefined && !Array.isArray(archives)) throw Error('Invalid archives');
		return { config: structuredClone(config), archives: archives?.map(value => this.captureArchive(value)) };
	}
	async commitConfiguration(snapshot, descriptor) {
		const { config, archives } = snapshot;
		const saved = { ...config, format: archives?.length ? 5 : 4, checkpoint: descriptor };
		if (archives?.length) {
			const entries = [];
			for (const archived of archives) {
				if (!archived.entry) archived.entry = (await this.stage('archive', { format: 1, value: archived.value })).entry;
				entries.push(archived.entry);
			}
			saved.archiveCheckpoint = { format: 1, entries };
		} else if (archives) saved.archives = [];
		const text = JSON.stringify(saved);
		if (text === this.lastConfiguration) return;
		await this.commit(saved);
		this.lastConfiguration = text;
	}

	saveConfiguration(data) {
		if (!this.descriptor) return this.save(data);
		// Configuration writes are ordering barriers: never merge across them.
		this.pendingSave = undefined;
		const snapshot = this.configuration(data);
		const work = this.serial.catch(() => {}).then(() => this.commitConfiguration(snapshot, this.descriptor));
		this.serial = work;
		return work;
	}
	save(data) {
		// Capture changes synchronously, before a queued SDK write can yield to
		// another operation mutating the live engine state.
		const records = this.encode(data.connections ?? {});
		const settings = this.configuration(data);
		if (this.pendingSave) {
			this.pendingSave.settings = settings;
			this.pendingSave.records = records;
			return this.pendingSave.promise;
		}
		const pending = { settings, records };
		const work = this.serial.catch(() => {}).then(() => {
			if (this.pendingSave === pending) this.pendingSave = undefined;
			return this.write(pending.settings, pending.records);
		});
		pending.promise = work;
		this.pendingSave = pending;
		this.serial = work;
		return work;
	}
	async saveAndRetireCommit(data, connectionId, journal) {
		if (data.commitJournals?.[connectionId] !== journal) throw Error('Commit journal changed before checkpoint');
		delete data.commitJournals[connectionId];
		try { await this.save(data); }
		catch (error) {
			data.commitJournals[connectionId] = journal;
			throw error;
		}
	}
	async stage(kind, value) {
		if (!await this.adapter.exists(this.folder)) await this.adapter.mkdir(this.folder);
		const file = `${kind}-${crypto.randomUUID()}.json`;
		const text = JSON.stringify(value);
		const encoded = encoder.encode(text);
		const hash = await fingerprint(encoded);
		// Unique final filenames need no overwrite and no rename of an active file.
		await this.adapter.write(`${this.folder}/${file}.tmp`, text);
		await this.adapter.rename(`${this.folder}/${file}.tmp`, `${this.folder}/${file}`);
		return { entry: { file, hash }, bytes: encoded.length };
	}
	async write(config, records) {
		// Traverse once without materializing complete entry arrays on every save.
		const set = [], remove = [];
		for (const [key, value] of records) if (this.shadow.get(key) !== value) set.push([key, value]);
		for (const key of this.shadow.keys()) if (!records.has(key)) remove.push(key);
		let descriptor = this.descriptor, bytes = this.deltaBytes;
		const previous = descriptor;
		if (!descriptor || (set.length + remove.length > 0 && (descriptor.patches.length >= 64 || bytes >= 8 * 1024 * 1024))) {
			const staged = await this.stage('base', { format: 1, records: [...records] });
			descriptor = { format: 1, base: staged.entry, patches: [] };
			bytes = 0;
		} else if (set.length || remove.length) {
			const staged = await this.stage('patch', { format: 1, set, remove });
			descriptor = { ...descriptor, patches: [...descriptor.patches, staged.entry] };
			bytes += staged.bytes;
		}
		await this.commitConfiguration(config, descriptor);
		this.descriptor = descriptor;
		this.shadow = records;
		this.deltaBytes = bytes;
		// Only retire the fully superseded committed generation. Files left by a
		// failed commit are retained; recovery follows only the SDK descriptor.
		if (previous && previous.base.file !== descriptor.base.file) {
			const retired = [previous.base, ...previous.patches];
			for (let offset = 0; offset < retired.length; offset += 4)
				await Promise.all(retired.slice(offset, offset + 4).map(entry => this.adapter.remove(`${this.folder}/${entry.file}`).catch(() => {})));
		}
	}
}

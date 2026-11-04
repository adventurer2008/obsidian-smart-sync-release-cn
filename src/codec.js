import { compressBytes, decompressBytes } from './compatibility.js';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
export const SEGMENT_BYTES = 1024 * 1024;
export const KDF_ROUNDS = 310_000;
export const MAX_NOTE_BYTES = 256 * 1024 * 1024;
const signature = Uint8Array.of(83, 83, 50, 0);
const verifiedManifests = new WeakMap();

export function safeNotePath(value) {
	if (typeof value !== 'string' || value.length === 0 || value.includes(String.fromCharCode(0)))
		throw new Error('Invalid note path');
	const path = value.replaceAll(String.fromCharCode(92), '/').normalize('NFC');
	if (path.startsWith('/') || /^[a-z]:/i.test(path))
		throw new Error('Absolute paths are not allowed');
	const parts = path.split('/');
	if (parts.some((part) => part === '' || part === '.' || part === '..'))
		throw new Error('Invalid path segment');
	// Reject reserved legacy/default metadata even when the current vault has another configDir.
	if (['.obsidian', '.trash', '.git'].includes(parts[0].toLowerCase()))
		throw new Error('Internal vault files are excluded');
	return path;
}
// Validate host filesystem semantics in addition to the portable protocol path.
// Colons remain valid on POSIX hosts; on Windows they address NTFS streams.
export function safeHostPath(value, windows = false) {
	const path = safeNotePath(value);
	if (windows && path.split('/').some((part) =>
		/[<>:"|?*]/.test(part) || [...part].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) || /[. ]$/.test(part) ||
		/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)(?:\.|$)/i.test(part)))
		throw new Error('Unsafe Windows file name');
	return path;
}
export function hex(bytes) {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
export function base64(bytes) {
	let text = '';
	for (let start = 0; start < bytes.length; start += 16_384)
		text += String.fromCharCode(...bytes.subarray(start, start + 16_384));
	return btoa(text);
}
export function unbase64(text) {
	if (
		typeof text !== 'string' ||
		!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)
	)
		throw new Error('Invalid base64');
	return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}
export async function fingerprint(bytes) {
	if (
		bytes?.streamed === true &&
		Number.isSafeInteger(bytes.length) &&
		/^[a-f0-9]{64}$/.test(bytes.digest)
	)
		return bytes.digest;
	return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}
export function freshSalt() {
	return base64(crypto.getRandomValues(new Uint8Array(24)));
}

export async function unlockWorkspace(passphrase, salt) {
	if (typeof passphrase !== 'string' || passphrase.length < 12)
		throw new Error('Use at least 12 characters for the encryption password');
	const saltBytes = unbase64(salt);
	if (saltBytes.byteLength !== 24) throw new Error('Invalid workspace salt');
	const password = await crypto.subtle.importKey(
		'raw',
		encoder.encode(passphrase),
		'PBKDF2',
		false,
		['deriveBits'],
	);
	const bits = new Uint8Array(
		await crypto.subtle.deriveBits(
			{
				name: 'PBKDF2',
				hash: 'SHA-256',
				salt: saltBytes,
				iterations: KDF_ROUNDS,
			},
			password,
			512,
		),
	);
	try {
		return {
			box: await crypto.subtle.importKey('raw', bits.subarray(0, 32), 'AES-GCM', false, [
				'encrypt',
				'decrypt',
			]),
			names: await crypto.subtle.importKey(
				'raw',
				bits.subarray(32),
				{ name: 'HMAC', hash: 'SHA-256' },
				false,
				['sign'],
			),
		};
	} finally {
		bits.fill(0);
	}
}
export async function workspaceProof(keys) {
	return hex(
		new Uint8Array(
			await crypto.subtle.sign(
				'HMAC',
				keys.names,
				encoder.encode('smart-sync-protocol-2-workspace-check'),
			),
		),
	);
}
export async function accountProof(keys) {
	return hex(new Uint8Array(await crypto.subtle.sign('HMAC',keys.names,encoder.encode('smart-sync-account-encryption-1'))));
}
export async function wrapWorkspacePassword(keys, owner, workspace, password) {
	const nonce=crypto.getRandomValues(new Uint8Array(12));
	const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv:nonce,additionalData:encoder.encode(JSON.stringify(['account-key-1',owner,workspace]))},keys.box,encoder.encode(password));
	return {nonce:base64(nonce),ciphertext:base64(new Uint8Array(ciphertext))};
}
export async function unwrapWorkspacePassword(keys, owner, workspace, wrapped) {
	const clear=await crypto.subtle.decrypt({name:'AES-GCM',iv:unbase64(wrapped.nonce),additionalData:encoder.encode(JSON.stringify(['account-key-1',owner,workspace]))},keys.box,unbase64(wrapped.ciphertext));
	const password=decoder.decode(clear);
	if(password.length<12)throw Error('Invalid wrapped workspace key');
	return password;
}
export async function opaqueNoteId(keys, path) {
	return hex(
		new Uint8Array(
			await crypto.subtle.sign('HMAC', keys.names, encoder.encode(safeNotePath(path))),
		),
	);
}

async function encryptObject(keys, plaintext, binding) {
	const packed = await compressBytes(plaintext, plaintext.length + 1024 * 1024);
	const compressed = packed.length < plaintext.length;
	const nonce = crypto.getRandomValues(new Uint8Array(12));
	const header = new Uint8Array(17);
	header.set(signature);
	header[4] = Number(compressed);
	header.set(nonce, 5);
	const aad = new Uint8Array(header.length + encoder.encode(binding).length);
	aad.set(header);
	aad.set(encoder.encode(binding), header.length);
	const payload = new Uint8Array(
		await crypto.subtle.encrypt(
			{ name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128 },
			keys.box,
			compressed ? packed : plaintext,
		),
	);
	const body = new Uint8Array(header.length + payload.length);
	body.set(header);
	body.set(payload, header.length);
	return { address: await fingerprint(body), body };
}
async function decryptObject(keys, body, binding, maximum) {
	if (
		!(body instanceof Uint8Array) ||
		body.length < 33 ||
		!signature.every((byte, index) => body[index] === byte) ||
		body[4] > 1
	)
		throw new Error('Unsupported encrypted object');
	const header = body.subarray(0, 17);
	const aad = new Uint8Array(header.length + encoder.encode(binding).length);
	aad.set(header);
	aad.set(encoder.encode(binding), header.length);
	const clear = new Uint8Array(
		await crypto.subtle.decrypt(
			{
				name: 'AES-GCM',
				iv: body.subarray(5, 17),
				additionalData: aad,
				tagLength: 128,
			},
			keys.box,
			body.subarray(17),
		),
	);
	if (body[4] === 1) return decompressBytes(clear, maximum);
	if (clear.length > maximum) throw new Error('Object exceeds its declared limit');
	return clear;
}

export function validMtime(value) {
	return Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000;
}
export async function reconcileLogicalUsage(api, keys) {
	let after = 0;
	while (true) {
		const page = await api.request('GET', api.scope(`usage/missing?after=${after}`));
		if (!Array.isArray(page?.entries) || page.entries.length > 128 || typeof page.more !== 'boolean' || (page.more && !page.entries.length)) throw Error('Invalid size accounting page');
		const entries = [];
		for (const entry of page.entries) {
			if (!Number.isSafeInteger(entry.sequence) || entry.sequence <= after) throw Error('Invalid size accounting cursor');
			const info = await inspectNote(keys, api.workspace, entry.note, entry.manifest, address => api.load(address));
			entries.push({ ...entry, bytes: info.bytes });
			after = entry.sequence;
		}
		if (entries.length) await api.request('POST', api.scope('usage/declarations'), { entries });
		if (!page.more) return;
	}
}
export async function packNote(keys, workspace, path, contents, origin, identity, kind = 'file', mtime) {
	if (mtime !== undefined && !validMtime(mtime)) throw Error('Invalid file modification time');
	path = safeNotePath(path);
	const streamed = contents?.streamed === true;
	const byteLength = streamed ? contents.length : contents.byteLength;
	if (
		(!streamed && !(contents instanceof Uint8Array)) ||
		!Number.isSafeInteger(byteLength) ||
		byteLength > MAX_NOTE_BYTES
	)
		throw new Error('Files up to 256 MB are supported');
	const id = identity ?? (await opaqueNoteId(keys, path));
	if (!/^[a-f0-9]{64}$/.test(id) || !['file', 'folder'].includes(kind))
		throw new Error('Invalid note identity or kind');
	const objects = [];
	const segments = [];
	const check = streamed ? contents.createDigest() : undefined;
	// One segment ahead: overlap disk reads with compression/encryption without
	// retaining whole files. Settled results prevent orphaned read rejections.
	const readPiece = offset => Promise.resolve().then(() => contents.chunk(offset, Math.min(SEGMENT_BYTES, byteLength - offset))).then(body => ({ body }), error => ({ error }));
	let ahead = streamed && byteLength ? readPiece(0) : undefined;
	const packing = [];
	const consume = async () => {
		const result = await packing.shift();
		if (result.error) throw result.error;
		objects.push(streamed ? await contents.spool(result.object) : result.object);
		segments.push({ address: result.object.address, bytes: result.bytes });
	};
	try {
		for (let offset = 0; offset < byteLength; offset += SEGMENT_BYTES) {
			const loaded = streamed ? await ahead : undefined;
			if (loaded?.error) throw loaded.error;
			const piece = streamed ? loaded.body : contents.subarray(offset, offset + SEGMENT_BYTES);
			ahead = streamed && offset + SEGMENT_BYTES < byteLength ? readPiece(offset + SEGMENT_BYTES) : undefined;
			check?.update(piece);
			// Two ordered segments overlap compression/encryption. Each still uses
			// its original ordinal binding; failures drain work before spool cleanup.
			const ordinal = offset / SEGMENT_BYTES;
			packing.push(encryptObject(
				keys,
				piece,
				`ss2:${workspace}:${id}:segment:${ordinal}`,
			).then(object => ({ object, bytes: piece.length }), error => ({ error })));
			if (packing.length === 2) await consume();
		}
		while (packing.length) await consume();
		if (streamed) {
			if (check.finish() !== contents.digest) throw Error('Source digest changed during packing');
			await contents.verify();
		}
		const info = {
			format: 3,
			id,
			kind,
			...(kind === 'file' && mtime !== undefined ? { mtime } : {}),
			path,
			bytes: byteLength,
			digest: await fingerprint(contents),
			segments,
			...(origin
				? {
						origin: {
							path: safeNotePath(origin.path),
							note: origin.note,
							revision: origin.revision,
						},
					}
				: {}),
		};
		const manifest = await encryptObject(
			keys,
			encoder.encode(JSON.stringify(info)),
			`ss2:${workspace}:${id}:manifest`,
		);
		return {
			id,
			manifest: manifest.address,
			objects: [...objects, manifest],
			digest: info.digest,
			info,
			dispose: streamed ? () => contents.dispose() : undefined,
		};
	} catch (error) {
		await Promise.all(packing);
		if (streamed) { await ahead; await contents.dispose(); }
		throw error;
	}
}
// A rename changes only the authenticated manifest. Existing ciphertext remains bound to id.
export async function repathNote(keys, workspace, id, path, info) {
	if (info.id !== id || info.format !== 3) throw new Error('Invalid reusable note');
	const next = { ...info, path: safeNotePath(path) };
	const manifest = await encryptObject(
		keys,
		encoder.encode(JSON.stringify(next)),
		`ss2:${workspace}:${id}:manifest`,
	);
	return {
		id,
		manifest: manifest.address,
		objects: [manifest],
		digest: next.digest,
		info: next,
	};
}
export async function inspectNote(keys, workspace, id, address, load) {
	if (!/^[a-f0-9]{64}$/.test(address)) throw new Error('Invalid object address');
	const object = await load(address);
	if ((await fingerprint(object)) !== address) throw new Error('Encrypted object digest mismatch');
	const clear = await decryptObject(keys, object, `ss2:${workspace}:${id}:manifest`, 1024 * 1024);
	const info = JSON.parse(decoder.decode(clear));
	if (
		info?.format !== 3 ||
		info.id !== id ||
		!['file', 'folder'].includes(info.kind) ||
		!Number.isSafeInteger(info.bytes) ||
		info.bytes < 0 ||
		info.bytes > MAX_NOTE_BYTES ||
		!/^[a-f0-9]{64}$/.test(info.digest) ||
		!Array.isArray(info.segments) ||
		info.segments.length > 65_536
	)
		throw new Error('Invalid encrypted manifest');
	if (info.mtime !== undefined && !validMtime(info.mtime)) throw Error('Invalid encrypted modification time');
	safeNotePath(info.path);
	if (
		info.origin &&
		(!/^[a-f0-9]{64}$/.test(info.origin.note) ||
			!Number.isSafeInteger(info.origin.revision) ||
			info.origin.revision < 1 ||
			(await opaqueNoteId(keys, safeNotePath(info.origin.path))) !== info.origin.note)
	)
		throw new Error('Invalid encrypted rename lineage');
	if (info.kind === 'folder' && (info.bytes !== 0 || info.segments.length !== 0))
		throw new Error('Folder has file content');
	let length = 0;
	for (const piece of info.segments) {
		if (
			!piece ||
			!/^[a-f0-9]{64}$/.test(piece.address) ||
			!Number.isInteger(piece.bytes) ||
			piece.bytes <= 0 ||
			piece.bytes > SEGMENT_BYTES
		)
			throw new Error('Invalid manifest segment');
		length += piece.bytes;
	}
	if (length !== info.bytes) throw new Error('Manifest length mismatch');
	verifiedManifests.set(info, { keys, workspace, id, address, info: structuredClone(info) });
	return info;
}
function reuseManifest(inspected, keys, workspace, id, address) {
	const cached = verifiedManifests.get(inspected);
	if (!cached || cached.keys !== keys || cached.workspace !== workspace || cached.id !== id || cached.address !== address)
		throw new Error('Verified manifest does not match this object');
	return cached.info;
}
async function measuredDecode(stage, work, onTiming) {
	const started = performance.now();
	try { return await work(); }
	finally { await Promise.resolve().then(() => onTiming?.(stage, performance.now() - started)).catch(() => undefined); }
}
function assertDownloadActive(options) {
	if (options?.signal?.aborted) throw options.signal.reason ?? new DOMException('Download stopped', 'AbortError');
}
async function* decodedSegments(keys, workspace, id, info, load, onTiming, options = {}) {
	const width = Math.max(1, Math.min(4, Math.floor(options.concurrency) || 1));
	const pending = new Map();
	let failure;
	const active = () => assertDownloadActive(options);
	const read = index => {
		if (index >= info.segments.length || failure || options.signal?.aborted) return;
		pending.set(index, Promise.resolve().then(() => {
			active();
			return load(info.segments[index].address);
		}).then(body => ({ body }), error => { failure ??= error ?? new Error('Segment download failed'); return { error: failure }; }));
	};
	try {
		active();
		for (let index = 0; index < width; index++) read(index);
		for (const [index, piece] of info.segments.entries()) {
			active();
			if (!pending.has(index)) throw failure ?? new Error('Segment download did not start');
			const result = await pending.get(index);
			pending.delete(index);
			active();
			if (result.error) throw result.error;
			if ((await measuredDecode('hash', () => fingerprint(result.body), onTiming)) !== piece.address)
				throw Error('Encrypted object digest mismatch');
			active();
			read(index + width);
			const bytes = await measuredDecode('decrypt', () => decryptObject(
				keys, result.body, `ss2:${workspace}:${id}:segment:${index}`, piece.bytes,
			), onTiming);
			active();
			if (bytes.length !== piece.bytes) throw Error('Segment length mismatch');
			yield bytes;
		}
	} finally { await Promise.all(pending.values()); pending.clear(); }
}
export async function unpackNote(keys, workspace, id, address, load, inspected, onTiming, options) {
	assertDownloadActive(options);
	const info = inspected ? reuseManifest(inspected, keys, workspace, id, address) : await inspectNote(keys, workspace, id, address, load);
	assertDownloadActive(options);
	const result = new Uint8Array(info.bytes);
	let offset = 0;
	for await (const data of decodedSegments(keys, workspace, id, info, load, onTiming, options)) {
		result.set(data, offset);
		offset += data.length;
	}
	if ((await measuredDecode('hash', () => fingerprint(result), onTiming)) !== info.digest) throw new Error('Note integrity check failed');
	assertDownloadActive(options);
	return { path: info.path, contents: result, digest: info.digest };
}

export async function unpackToSink(keys, workspace, id, address, load, sinkFor, inspected, onTiming, options) {
	assertDownloadActive(options);
	const info = inspected ? reuseManifest(inspected, keys, workspace, id, address) : await inspectNote(keys, workspace, id, address, load);
	assertDownloadActive(options);
	const sink = await sinkFor(info.path, info.bytes, info.digest, info.mtime);
	try {
		for await (const bytes of decodedSegments(keys, workspace, id, info, load, onTiming, options)) {
			await sink.write(bytes);
		}
		assertDownloadActive(options);
		await sink.commit();
		return { path: info.path, digest: info.digest };
	} catch (error) {
		await sink.abort();
		throw error;
	}
}

// R241: a separate authenticated register; note bytes and timestamps are untouched.
export async function encryptNotePin(keys, workspace, note, pinned) {
	if (!/^[a-f0-9]{64}$/.test(note) || typeof pinned !== 'boolean') throw Error('Invalid note pin');
	const object = await encryptObject(keys, Uint8Array.of(Number(pinned)), `note-pin-1|${workspace}|${note}`);
	return base64(object.body);
}
export async function decryptNotePin(keys, workspace, note, value) {
	if (!/^[a-f0-9]{64}$/.test(note) || typeof value !== 'string' || value.length > 512) throw Error('Invalid note pin');
	const clear = await decryptObject(keys, unbase64(value), `note-pin-1|${workspace}|${note}`, 64);
	if (clear.length !== 1 || clear[0] > 1) throw Error('Invalid note pin');
	return clear[0] === 1;
}

export async function encryptNotePosition(keys, workspace, note, position) {
	if (!/^[a-f0-9]{64}$/.test(note) || !['normal', 'top', 'bottom'].includes(position)) throw Error('Invalid note position');
	return base64((await encryptObject(keys, Uint8Array.of(['normal', 'top', 'bottom'].indexOf(position)), `note-position-1|${workspace}|${note}`)).body);
}
export async function decryptNotePosition(keys, workspace, note, value) {
	if (!/^[a-f0-9]{64}$/.test(note) || typeof value !== 'string' || value.length > 512) throw Error('Invalid note position');
	const clear = await decryptObject(keys, unbase64(value), `note-position-1|${workspace}|${note}`, 64);
	if (clear.length !== 1 || clear[0] > 2) throw Error('Invalid note position');
	return ['normal', 'top', 'bottom'][clear[0]];
}

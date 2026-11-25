import { hex } from './codec.js';
import { formatStorageSize, t } from './i18n.js';
import { ATTACHMENT_BYTES as maxBytes, ATTACHMENT_FILES as maxFiles, ATTACHMENT_OVERHEAD as overhead, decodeAttachmentData } from './note-crypto.js';

const imageTypes = new Map([
	['png', 'image/png'], ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'], ['gif', 'image/gif'],
	['webp', 'image/webp'], ['avif', 'image/avif'], ['bmp', 'image/bmp'],
]);
const encoder = new TextEncoder();
const markdown = path => /\.md$/iu.test(path);
const safePath = path => typeof path === 'string' && !/[\\:]/u.test(path) && ![...path].some(char => char.charCodeAt(0) < 32) &&
	path.split('/').every(part => part && part !== '.' && part !== '..' && !part.startsWith('.'));
const digest = async bytes => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
const error = (key, params) => Error(t(`encryption.${key}`, params));
export const attachmentPackagePath = id => `wujie-locked-${id}.wujie-lock`;

export function findNoteAttachments(app, snapshot) {
	const cache = app.metadataCache;
	const metadata = cache?.getFileCache(snapshot.file);
	if (!metadata) throw error('attachmentIndex');
	const attachments = new Map();
	const refs = [...metadata.embeds ?? [], ...metadata.links ?? [], ...metadata.frontmatterLinks ?? []];
	for (const match of snapshot.original.matchAll(/!\[\[([^\]\r\n]+)\]\]|!\[[^\]\r\n]*\]\(\s*(<[^>\r\n]+>|[^\s)]+)[^\r\n)]*\)/gu)) {
		const section = metadata.sections?.find(({ position }) => position.start.offset <= match.index && position.end.offset >= match.index + match[0].length);
		if (section?.type === 'code' || /^(?:[a-z][a-z\d+.-]*:|\/\/)/iu.test(match[1] ?? match[2].replace(/^<|>$/gu, ''))) continue;
		if (!refs.some(ref => ref.original === match[0] || ref.original === match[0].slice(1))) throw error('attachmentIndex');
	}
	for (const ref of refs) {
		const href = ref.link.split('#')[0].split('|')[0];
		if (!href || /^(?:[a-z][a-z\d+.-]*:|\/\/)/iu.test(href)) continue;
		if (ref.position) {
			const { start, end } = ref.position;
			if (snapshot.original.slice(start.offset, end.offset) !== ref.original) throw error('attachmentIndex');
		}
		const file = cache.getFirstLinkpathDest(href, snapshot.path);
		if (!file) {
			if (metadata.embeds?.includes(ref) || /\.[^./]+$/u.test(href) && !markdown(href))
				throw error('attachmentMissing', { path: href });
			continue;
		}
		if (markdown(file.path)) continue;
		if (!safePath(file.path) || file.path.endsWith('.wujie-lock')) throw error('attachmentChanged', { path: file.path });
		attachments.set(file.path, file);
	}
	checkShared(app, snapshot.path, attachments.keys());
	return [...attachments.values()];
}

function checkShared(app, source, paths) {
	const wanted = new Set(paths);
	if (!wanted.size) return;
	for (const file of app.vault.getMarkdownFiles()) {
		if (file.path === source) continue;
		const cache = app.metadataCache.getFileCache(file);
		if (!cache) throw error('attachmentIndex');
		for (const ref of [...cache.embeds ?? [], ...cache.links ?? [], ...cache.frontmatterLinks ?? []]) {
			const dest = app.metadataCache.getFirstLinkpathDest(ref.link.split('#')[0].split('|')[0], file.path);
			if (dest && wanted.has(dest.path)) throw error('attachmentShared', { path: dest.path, note: file.path });
		}
	}
}

export function parseAttachmentManifest(value) {
	const manifest = JSON.parse(value);
	if (typeof manifest?.text !== 'string' || ![false, true].includes(manifest.restoring) ||
		!Array.isArray(manifest.entries) || !manifest.entries.length || manifest.entries.length > maxFiles)
		throw error('invalidContent');
	let offset = 0;
	const paths = new Set();
	for (const entry of manifest.entries) {
		if (!safePath(entry.path) || markdown(entry.path) || paths.has(entry.path) || entry.path.endsWith('.wujie-lock') ||
			!Number.isSafeInteger(entry.size) || entry.size < 0 || !Number.isSafeInteger(entry.mtime) || entry.mtime < 0 ||
			!Number.isSafeInteger(entry.ctime) || entry.ctime < 0 || entry.offset !== offset || !/^[a-f\d]{64}$/u.test(entry.hash))
			throw error('invalidContent');
		paths.add(entry.path);
		offset += entry.size + overhead;
		if (offset > maxBytes + maxFiles * overhead) throw error('invalidContent');
	}
	return { ...manifest, size: offset };
}

const cipherParams = (id, entry, iv) => ({
	name: 'AES-GCM', iv, additionalData: encoder.encode(JSON.stringify(['wujie-attachment-2', id, entry.path, entry.offset, entry.size, entry.hash])),
});

async function sealAttachment(bytes, id, key, entry, clear) {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	bytes.set(iv, entry.offset);
	bytes.set(new Uint8Array(await crypto.subtle.encrypt(cipherParams(id, entry, iv), key, clear)), entry.offset + iv.length);
}

export async function stageNoteAttachments(vault, id, key, text, files, verifyPath = async () => {}, { embedded = false } = {}) {
	const total = files.reduce((size, file) => size + file.stat.size, 0);
	if (total > maxBytes || files.length > maxFiles) throw error('attachmentLimit', { limit: formatStorageSize(maxBytes) });
	const bytes = new Uint8Array(total + overhead * files.length);
	const entries = [];
	let offset = 0;
	for (const file of files) {
		const { size, mtime, ctime } = file.stat;
		const path = file.path;
		await verifyPath(path);
		const clear = new Uint8Array(await vault.readBinary(file));
		try {
			if (clear.length !== size || file.stat.mtime !== mtime || file.path !== path) throw error('attachmentChanged', { path });
			const entry = { path, offset, size, mtime, ctime, hash: await digest(clear) };
			await sealAttachment(bytes, id, key, entry, clear);
			entries.push(entry);
			offset += size + overhead;
		} finally { clear.fill(0); }
	}
	return writeAttachmentPackage(vault, id, key, text, entries, bytes, embedded);
}

const foldPath = path => path.normalize('NFC').toLowerCase();

export function attachmentInsertion(text, position, links) {
	const before = text.slice(0, position), after = text.slice(position);
	const prefix = before && !before.endsWith('\n') ? '\n' : '';
	const suffix = after.startsWith('\n') ? '' : '\n';
	return prefix + links.join('\n') + suffix;
}

export async function stageImportedAttachments(vault, id, key, text, notePath, files, prior, verifyPath, active, position = text.length) {
	const oldEntries = prior?.manifest.entries ?? [];
	const total = oldEntries.reduce((size, entry) => size + entry.size, 0) + files.reduce((size, file) => size + file.size, 0);
	const count = oldEntries.length + files.length;
	if (!files.length || count > maxFiles || !Number.isSafeInteger(total) || total > maxBytes)
		throw error('attachmentLimit', { limit: formatStorageSize(maxBytes) });
	const bytes = new Uint8Array(total + count * overhead);
	const entries = [...oldEntries];
	const occupied = new Set([...vault.getFiles().map(file => file.path), ...oldEntries.map(entry => entry.path)].map(foldPath));
	const directory = notePath.slice(0, notePath.lastIndexOf('/') + 1);
	const assertActive = () => { if (!active()) throw error('writeContextChanged'); };
	for (const entry of oldEntries) {
		assertActive();
		const clear = await decryptAttachment(prior.bytes, prior.id, prior.key, entry);
		try { await sealAttachment(bytes, id, key, entry, clear); }
		finally { clear.fill(0); }
	}
	let offset = prior?.manifest.size ?? 0;
	const links = [];
	for (const file of files) {
		assertActive();
		const name = file.name.normalize('NFC');
		if (!safePath(name) || /[<>:"|?*/]|[. ]$/u.test(name) || /^[ .]/u.test(name) ||
			/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(name) ||
			markdown(name) || name.toLowerCase().endsWith('.wujie-lock') || encoder.encode(name).length > 240)
			throw error('attachmentChanged', { path: name });
		const dot = name.lastIndexOf('.');
		const stem = dot < 0 ? name : name.slice(0, dot), extension = dot < 0 ? '' : name.slice(dot);
		let basename = name, path = directory + basename;
		for (let suffix = 2; occupied.has(foldPath(path)) || await vault.adapter.exists(path); suffix++) {
			basename = `${stem}-${suffix}${extension}`;
			path = directory + basename;
		}
		await verifyPath(path, true);
		const clear = new Uint8Array(await file.arrayBuffer());
		try {
			assertActive();
			if (clear.length !== file.size) throw error('attachmentChanged', { path });
			const mtime = Number.isSafeInteger(file.lastModified) && file.lastModified >= 0 ? file.lastModified : Date.now();
			const entry = { path, offset, size: file.size, mtime, ctime: mtime, hash: await digest(clear) };
			await sealAttachment(bytes, id, key, entry, clear);
			occupied.add(foldPath(path));
			entries.push(entry);
			offset += entry.size + overhead;
			const image = attachmentPreviewType(path);
			const label = image ? '' : basename.replace(/[[\]]/gu, '\\$&');
			links.push(`${image ? '!' : ''}[${label}](<./${encodeURIComponent(basename)}>)`);
		} finally { clear.fill(0); }
	}
	assertActive();
	const content = text.slice(0, position) + attachmentInsertion(text, position, links) + text.slice(position);
	return { ...await writeAttachmentPackage(vault, id, key, content, entries, bytes, true), links };
}

async function writeAttachmentPackage(vault, id, key, text, entries, bytes, embedded) {
	const value = JSON.stringify({ text, restoring: false, entries });
	const manifest = parseAttachmentManifest(value);
	if (embedded) return { value, manifest, bytes };
	const file = await vault.createBinary(attachmentPackagePath(id), bytes.buffer);
	let verified;
	try {
		verified = await verifyNoteAttachments(vault, id, key, manifest);
	} catch (problem) {
		await vault.delete(file, true);
		throw problem;
	}
	return { value, manifest, file, bytes: verified };
}

export async function readAttachmentPackage(vault, id, manifest, attachmentData) {
	if (attachmentData !== undefined) {
		const bytes = decodeAttachmentData(attachmentData);
		if (bytes.length !== manifest.size) throw error('invalidContent');
		return bytes;
	}
	const file = vault.getAbstractFileByPath(attachmentPackagePath(id));
	if (!file?.stat || file.stat.size !== manifest.size) throw error('attachmentPackageMissing');
	const bytes = new Uint8Array(await vault.readBinary(file));
	if (bytes.length !== manifest.size) throw error('invalidContent');
	return bytes;
}

export async function decryptAttachment(bytes, id, key, entry) {
	const { offset, size } = entry;
	const iv = bytes.subarray(offset, offset + 12);
	try {
		return new Uint8Array(await crypto.subtle.decrypt(cipherParams(id, entry, iv), key,
			bytes.subarray(offset + 12, offset + size + overhead)));
	} catch { throw error('invalidContent'); }
}

export async function verifyNoteAttachments(vault, id, key, manifest, attachmentData) {
	const bytes = await readAttachmentPackage(vault, id, manifest, attachmentData);
	for (const entry of manifest.entries) {
		const clear = await decryptAttachment(bytes, id, key, entry);
		clear.fill(0);
	}
	return bytes;
}

async function checkOriginal(vault, entry) {
	const file = vault.getAbstractFileByPath(entry.path);
	if (!file) {
		if (await vault.adapter.exists(entry.path)) throw error('attachmentChanged', { path: entry.path });
		return null;
	}
	if (file.stat?.size !== entry.size || file.stat.mtime !== entry.mtime) throw error('attachmentChanged', { path: entry.path });
	const clear = new Uint8Array(await vault.readBinary(file));
	try {
		if (await digest(clear) !== entry.hash || file.path !== entry.path || file.stat.mtime !== entry.mtime)
			throw error('attachmentChanged', { path: entry.path });
	} finally { clear.fill(0); }
	return file;
}

export async function finishAttachmentLock(app, source, id, key, manifest, active, remove, attachmentData) {
	const { vault } = app;
	const bytes = await verifyNoteAttachments(vault, id, key, manifest, attachmentData);
	if (manifest.restoring) throw error('attachmentRestoring');
	const existing = [];
	for (const entry of manifest.entries) if (await checkOriginal(vault, entry)) existing.push(entry);
	checkShared(app, source, existing.map(entry => entry.path));
	for (const entry of existing) {
		const file = await checkOriginal(vault, entry);
		if (!active()) throw error('writeContextChanged');
		if (file) await remove(file);
		if (await vault.adapter.exists(entry.path)) throw error('attachmentChanged', { path: entry.path });
	}
	return bytes;
}

export async function restoreNoteAttachments(vault, id, key, manifest, active, verifyPath = async () => {}, { attachmentData, beforeRestore } = {}) {
	const bytes = await verifyNoteAttachments(vault, id, key, manifest, attachmentData);
	for (const entry of manifest.entries) {
		await verifyPath(entry.path, true);
		await checkOriginal(vault, entry);
	}
	await beforeRestore?.();
	for (const entry of manifest.entries) {
		if (await checkOriginal(vault, entry)) continue;
		const clear = await decryptAttachment(bytes, id, key, entry);
		try {
			await verifyPath(entry.path, true);
			if (!active()) throw error('writeContextChanged');
			await vault.createBinary(entry.path, clear.buffer, { mtime: entry.mtime, ctime: entry.ctime });
		} finally { clear.fill(0); }
	}
}

export function attachmentPreviewType(path) {
	return imageTypes.get(path.split('.').at(-1).toLowerCase());
}

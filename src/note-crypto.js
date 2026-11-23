import { base64, unbase64, hex } from './codec.js';
import { compressBytes, decompressBytes } from './compatibility.js';
import { t } from './i18n.js';

// R270: a separate local encryption layer. No workspace/account secrets are used.
export const NOTE_LIMIT = 2 * 1024 * 1024;
export const ATTACHMENT_BYTES = 32 * 1024 * 1024;
export const ATTACHMENT_FILES = 128;
export const ATTACHMENT_OVERHEAD = 28; // AES-GCM IV and tag
const attachmentBase64Limit = Math.ceil((ATTACHMENT_BYTES + ATTACHMENT_FILES * ATTACHMENT_OVERHEAD) / 3) * 4;
export const NOTE_DRAFT_LIMIT = 5 * 1024 * 1024 + attachmentBase64Limit;
const encodedBoxLimit = 4 * 1024 * 1024 + Math.ceil(attachmentBase64Limit / 3) * 4;
export const NOTE_ROUNDS = 600_000;
export const TEXT_PREFIX = '⟦wujie-lock:v1:';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const random = size => crypto.getRandomValues(new Uint8Array(size));
const fault = () => Error(t('encryption.invalidContent'));
const fields = ['v', 'kind', 'id', 'rounds', 'salt', 'hint', 'wrapIV', 'wrappedKey', 'iv', 'size', 'body'];
const wrapAAD = box => encoder.encode(JSON.stringify([box.v === 3 ? 'wujie-note-wrap-3' : 'wujie-note-wrap-1', box.kind, box.id, box.rounds, box.salt, box.hint]));
const bodyAAD = box => encoder.encode(JSON.stringify([box.v === 3 ? 'wujie-note-body-3' : 'wujie-note-body-1', box.kind, box.id, box.size, 'deflate']));

export function containsLockedText(text) {
	return text.includes('wujie-lock:') || text.includes('```wujie-encrypted');
}
export function validateBox(box) {
	const embedded = box?.v === 3;
	if (!box || Object.keys(box).length !== fields.length + Number(embedded) || fields.some(key => !Object.hasOwn(box, key)) ||
		!(box.v === 1 && ['text', 'note'].includes(box.kind) || [2, 3].includes(box.v) && box.kind === 'bundle') || !/^[a-f0-9]{32}$/u.test(box.id) ||
		box.rounds !== NOTE_ROUNDS || typeof box.hint !== 'string' || box.hint.length > 200 ||
		!Number.isSafeInteger(box.size) || box.size < 0 || box.size > NOTE_LIMIT) throw fault();
	for (const [key, size] of [['salt', 24], ['wrapIV', 12], ['wrappedKey', 48], ['iv', 12]])
		if (unbase64(box[key]).length !== size) throw fault();
	if (typeof box.body !== 'string' || box.body.length > (NOTE_LIMIT + 65536) * 1.4 || unbase64(box.body).length < 16) throw fault();
	if (embedded && (typeof box.attachmentData !== 'string' || !box.attachmentData.length ||
		box.attachmentData.length > attachmentBase64Limit || !isBase64(box.attachmentData))) throw fault();
	return box;
}
// Avoid the repeated-group base64 expression on large encrypted note envelopes.
const isBase64 = value => value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/u.test(value);
export function decodeAttachmentData(value) {
	if (!isBase64(value)) throw fault();
	const text = atob(value), bytes = new Uint8Array(text.length);
	for (let offset = 0; offset < bytes.length; offset++) bytes[offset] = text.charCodeAt(offset);
	return bytes;
}
export function encodeBox(box) { return base64(encoder.encode(JSON.stringify(validateBox(box)))); }
export function decodeBox(value) {
	try {
		if (typeof value !== 'string' || value.length > encodedBoxLimit) throw fault();
		return validateBox(JSON.parse(decoder.decode(decodeAttachmentData(value))));
	} catch { throw fault(); }
}
export function lockedMarker(box) {
	const encoded = encodeBox(box);
	return box.kind === 'text' ? TEXT_PREFIX + encoded + '⟧' : '```wujie-encrypted\n' + encoded + '\n```\n';
}
export function lockedRanges(text) {
	const ranges = [];
	const pattern = /⟦wujie-lock:v1:([A-Za-z0-9+/=]+)⟧|```wujie-encrypted\r?\n([A-Za-z0-9+/=]+)\r?\n```(?:\r?\n)?/gu;
	for (const match of text.matchAll(pattern)) {
		let box;
		try { box = decodeBox(match[1] ?? match[2]); } catch { /* Damaged content stays opaque. */ }
		if (box && (box.kind === 'text') !== Boolean(match[1])) box = undefined;
		ranges.push({ from: match.index, to: match.index + match[0].length, marker: match[0], box });
	}
	return ranges;
}
export function searchableText(text) {
	return lockedRanges(text).reduceRight((result, range) => result.slice(0, range.from) + ' '.repeat(range.to - range.from) + result.slice(range.to), text);
}
function passwordBytes(password, creating = false) {
	if (typeof password !== 'string' || password.length > 1024 || !password.length || creating && password.length < 4)
		throw Error(t('encryption.invalidPassword'));
	return encoder.encode(password);
}
async function wrappingKey(password, box, creating = false) {
	const bytes = passwordBytes(password, creating);
	try {
		const material = await crypto.subtle.importKey('raw', bytes, 'PBKDF2', false, ['deriveKey']);
		return await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: unbase64(box.salt), iterations: box.rounds, hash: 'SHA-256' },
			material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
	} finally { bytes.fill(0); }
}
async function importDataKey(raw) { return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']); }
async function dataBytes(box, key) {
	return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unbase64(box.wrapIV), additionalData: wrapAAD(box) }, key, unbase64(box.wrappedKey)));
}
async function wrap(raw, key, box) {
	box.wrapIV = base64(random(12));
	box.wrappedKey = base64(new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: unbase64(box.wrapIV), additionalData: wrapAAD(box) }, key, raw)));
}
export async function updateLocked(box, key, text) {
	const clear = encoder.encode(text);
	try {
		if (clear.length > NOTE_LIMIT) throw Error(t('encryption.contentTooLarge'));
		const packed = await compressBytes(clear, NOTE_LIMIT + 65536);
		try {
			const next = { ...box, iv: base64(random(12)), size: clear.length };
			next.body = base64(new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: unbase64(next.iv), additionalData: bodyAAD(next) }, key, packed)));
			return validateBox(next);
		} finally { packed.fill(0); }
	} finally { clear.fill(0); }
}
export async function createLocked(text, password, hint = '', kind = 'text', prepare, { embedded = false } = {}) {
	passwordBytes(password, true).fill(0);
	if (typeof hint !== 'string' || hint.length > 200 || !['text', 'note', 'bundle'].includes(kind)) throw fault();
	const raw = random(32);
	try {
		const box = { v: kind === 'bundle' ? embedded ? 3 : 2 : 1, kind, id: hex(random(16)), rounds: NOTE_ROUNDS, salt: base64(random(24)), hint };
		await wrap(raw, await wrappingKey(password, box, true), box);
		const key = await importDataKey(raw);
		return await finishBox(box, key, prepare ? await prepare(box.id, key) : text);
	} finally { raw.fill(0); }
}
async function finishBox(box, key, prepared) {
	if (box.v !== 3) return updateLocked(box, key, prepared);
	box.attachmentData = base64(prepared.bytes);
	return updateLocked(box, key, prepared.value);
}
export async function createAttachmentRevision(previous, wrapKey, prepare) {
	const { rounds, salt, hint } = validateBox(previous);
	const box = { v: 3, kind: 'bundle', id: hex(random(16)), rounds, salt, hint };
	const raw = random(32);
	try {
		await wrap(raw, wrapKey, box);
		const key = await importDataKey(raw);
		return await finishBox(box, key, await prepare(box.id, key));
	} finally { raw.fill(0); }
}
export async function openLocked(box, password, { retainWrappingKey = false } = {}) {
	let raw, packed, clear;
	try {
		validateBox(box);
		const wrapKey = await wrappingKey(password, box);
		raw = await dataBytes(box, wrapKey);
		const key = await importDataKey(raw);
		packed = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unbase64(box.iv), additionalData: bodyAAD(box) }, key, unbase64(box.body)));
		clear = await decompressBytes(packed, box.size);
		if (clear.length !== box.size) throw fault();
		const opened = { text: decoder.decode(clear), key };
		if (retainWrappingKey) opened.wrapKey = wrapKey;
		return opened;
	} catch { throw fault(); }
	finally { raw?.fill(0); packed?.fill(0); clear?.fill(0); }
}
export async function rewrapLocked(box, password, nextPassword, hint = '') {
	let raw;
	try {
		// Verify the content as well as the password before changing its protection.
		await openLocked(box, password);
		raw = await dataBytes(box, await wrappingKey(password, box));
		if (typeof hint !== 'string' || hint.length > 200) throw fault();
		const next = { ...box, salt: base64(random(24)), hint };
		await wrap(raw, await wrappingKey(nextPassword, next, true), next);
		return validateBox(next);
	} finally { raw?.fill(0); }
}

// The host's process() callback is atomic. Never replace a newer remote/local edit.
export async function replaceLocked(vault, file, expected, replacement, mtime, guard = () => true) {
	if (typeof vault.process !== 'function') throw Error(t('encryption.safeWriteUnavailable'));
	return vault.process(file, current => {
		if (!guard() || current !== expected) throw Error(t('encryption.writeContextChanged'));
		return replacement;
	}, mtime === undefined ? undefined : { mtime });
}

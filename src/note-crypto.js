import { base64, unbase64, hex } from './codec.js';
import { compressBytes, decompressBytes } from './compatibility.js';
import { t } from './i18n.js';

// R270: a separate local encryption layer. No workspace/account secrets are used.
export const NOTE_LIMIT = 2 * 1024 * 1024;
export const NOTE_ROUNDS = 600_000;
export const TEXT_PREFIX = '⟦wujie-lock:v1:';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const random = size => crypto.getRandomValues(new Uint8Array(size));
const fault = () => Error(t('encryption.invalidContent'));
const fields = ['v', 'kind', 'id', 'rounds', 'salt', 'hint', 'wrapIV', 'wrappedKey', 'iv', 'size', 'body'];
const wrapAAD = box => encoder.encode(JSON.stringify(['wujie-note-wrap-1', box.kind, box.id, box.rounds, box.salt, box.hint]));
const bodyAAD = box => encoder.encode(JSON.stringify(['wujie-note-body-1', box.kind, box.id, box.size, 'deflate']));

export function containsLockedText(text) {
	return text.includes('wujie-lock:') || text.includes('```wujie-encrypted');
}
export function validateBox(box) {
	if (!box || Object.keys(box).length !== fields.length || fields.some(key => !Object.hasOwn(box, key)) ||
		box.v !== 1 || !['text', 'note'].includes(box.kind) || !/^[a-f0-9]{32}$/u.test(box.id) ||
		box.rounds !== NOTE_ROUNDS || typeof box.hint !== 'string' || box.hint.length > 200 ||
		!Number.isSafeInteger(box.size) || box.size < 0 || box.size > NOTE_LIMIT) throw fault();
	for (const [key, size] of [['salt', 24], ['wrapIV', 12], ['wrappedKey', 48], ['iv', 12]])
		if (unbase64(box[key]).length !== size) throw fault();
	if (typeof box.body !== 'string' || box.body.length > (NOTE_LIMIT + 65536) * 1.4 || unbase64(box.body).length < 16) throw fault();
	return box;
}
export function encodeBox(box) { return base64(encoder.encode(JSON.stringify(validateBox(box)))); }
export function decodeBox(value) {
	try {
		if (typeof value !== 'string' || value.length > 4 * 1024 * 1024) throw fault();
		return validateBox(JSON.parse(decoder.decode(unbase64(value))));
	} catch { throw fault(); }
}
export function lockedMarker(box) {
	const encoded = encodeBox(box);
	return box.kind === 'note' ? '```wujie-encrypted\n' + encoded + '\n```\n' : TEXT_PREFIX + encoded + '⟧';
}
export function lockedRanges(text) {
	const ranges = [];
	const pattern = /⟦wujie-lock:v1:([A-Za-z0-9+/=]+)⟧|```wujie-encrypted\r?\n([A-Za-z0-9+/=]+)\r?\n```(?:\r?\n)?/gu;
	for (const match of text.matchAll(pattern)) {
		let box;
		try { box = decodeBox(match[1] ?? match[2]); } catch { /* Damaged content stays opaque. */ }
		if (box && box.kind !== (match[1] ? 'text' : 'note')) box = undefined;
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
async function dataBytes(box, password) {
	validateBox(box);
	const key = await wrappingKey(password, box);
	return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unbase64(box.wrapIV), additionalData: wrapAAD(box) }, key, unbase64(box.wrappedKey)));
}
async function wrap(raw, password, box) {
	const key = await wrappingKey(password, box, true);
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
export async function createLocked(text, password, hint = '', kind = 'text') {
	passwordBytes(password, true).fill(0);
	if (typeof hint !== 'string' || hint.length > 200 || !['text', 'note'].includes(kind)) throw fault();
	const raw = random(32);
	try {
		const box = { v: 1, kind, id: hex(random(16)), rounds: NOTE_ROUNDS, salt: base64(random(24)), hint };
		await wrap(raw, password, box);
		return await updateLocked(box, await importDataKey(raw), text);
	} finally { raw.fill(0); }
}
export async function openLocked(box, password) {
	let raw, packed, clear;
	try {
		raw = await dataBytes(box, password);
		const key = await importDataKey(raw);
		packed = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unbase64(box.iv), additionalData: bodyAAD(box) }, key, unbase64(box.body)));
		clear = await decompressBytes(packed, box.size);
		if (clear.length !== box.size) throw fault();
		return { text: decoder.decode(clear), key };
	} catch { throw fault(); }
	finally { raw?.fill(0); packed?.fill(0); clear?.fill(0); }
}
export async function rewrapLocked(box, password, nextPassword, hint = '') {
	let raw;
	try {
		// Verify the content as well as the password before changing its protection.
		await openLocked(box, password);
		raw = await dataBytes(box, password);
		if (typeof hint !== 'string' || hint.length > 200) throw fault();
		const next = { ...box, salt: base64(random(24)), hint };
		await wrap(raw, nextPassword, next);
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

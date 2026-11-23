import CFB from 'cfb';
import { sha512 } from '@noble/hashes/sha2.js';
import { DOCX_MAX_BYTES } from './docx.js';

const agile = 'http://schemas.microsoft.com/office/2006/encryption';
const passwords = 'http://schemas.microsoft.com/office/2006/keyEncryptor/password';
const prefix = Uint8Array.of(4, 0, 4, 0, 64, 0, 0, 0);
const cfbSignature = Uint8Array.of(208, 207, 17, 224, 161, 177, 26, 225);
const blockKeys = {
	verifier: Uint8Array.of(254, 167, 210, 118, 59, 75, 158, 121),
	verifierHash: Uint8Array.of(215, 170, 15, 109, 48, 97, 52, 78),
	key: Uint8Array.of(20, 110, 11, 231, 171, 172, 208, 214),
	hmacKey: Uint8Array.of(95, 178, 173, 1, 12, 185, 225, 246),
	hmacValue: Uint8Array.of(160, 103, 127, 2, 178, 44, 132, 51),
};
const spinCount = 100000;
const segment = 4096;
const properties = { saltSize: '16', blockSize: '16', keyBits: '256', hashSize: '64',
	cipherAlgorithm: 'AES', cipherChaining: 'ChainingModeCBC', hashAlgorithm: 'SHA512' };
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
export const DOCX_DISK_MAX_BYTES = DOCX_MAX_BYTES + 256 * 1024;
export const isPasswordDocx = buffer => {
	const bytes = new Uint8Array(buffer);
	return cfbSignature.every((byte, index) => byte === bytes[index]);
};

const random = size => crypto.getRandomValues(new Uint8Array(size));
const base64 = bytes => btoa(String.fromCharCode(...bytes));
const unbase64 = (text, length) => {
	if (!text || text.length > 128 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(text)) throw Error('unsupported');
	const bytes = Uint8Array.from(atob(text), char => char.charCodeAt(0));
	if (bytes.length !== length) throw Error('unsupported');
	return bytes;
};
const concat = (left, right) => {
	const bytes = new Uint8Array(left.length + right.length);
	bytes.set(left); bytes.set(right, left.length);
	return bytes;
};
const uint32 = value => {
	const out = new Uint8Array(4);
	new DataView(out.buffer).setUint32(0, value, true);
	return out;
};
const join = (...parts) => parts.reduce(concat, new Uint8Array());
function utf16Field(text) {
	const length = text.length * 2;
	const out = new Uint8Array(4 + Math.ceil(length / 4) * 4);
	const view = new DataView(out.buffer);
	view.setUint32(0, length, true);
	for (let index = 0; index < text.length; index++) view.setUint16(4 + index * 2, text.charCodeAt(index), true);
	return out;
}
function addDataSpaces(container) {
	const space = 'StrongEncryptionDataSpace';
	const transform = 'StrongEncryptionTransform';
	const root = '\u0006DataSpaces/';
	const version = uint32(1);
	const mapping = join(uint32(1), uint32(0), utf16Field('EncryptedPackage'), utf16Field(space));
	const transformId = utf16Field('{FF9A3F03-56EF-4613-BDD5-5A41C1D07246}');
	const transformHeader = join(uint32(8 + transformId.length), uint32(1), transformId,
		utf16Field('Microsoft.Container.EncryptionTransform'), version, version, version);
	const streams = {
		Version: join(utf16Field('Microsoft.Container.DataSpaces'), version, version, version),
		DataSpaceMap: join(uint32(8), uint32(1), uint32(4 + mapping.length), mapping),
		[`DataSpaceInfo/${space}`]: join(uint32(8), uint32(1), utf16Field(transform)),
		[`TransformInfo/${transform}/\u0006Primary`]: join(transformHeader, uint32(0), uint32(0), uint32(0), uint32(4)),
	};
	for (const [name, stream] of Object.entries(streams)) CFB.utils.cfb_add(container, root + name, stream);
}
const ivFor = (salt, blockKey) => sha512(concat(salt, blockKey)).subarray(0, 16);
const aes = raw => crypto.subtle.importKey('raw', raw, 'AES-CBC', false, ['encrypt', 'decrypt']);
const hmac = raw => crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-512' }, false, ['sign', 'verify']);
const blockLength = length => Math.ceil(length / 16) * 16;

// Office pads to AES block boundaries with zeros. Web Crypto adds a mandatory
// PKCS#7 block, which is removed on encrypt or synthesized on decrypt.
async function encryptBlocks(key, iv, clear) {
	const padded = new Uint8Array(blockLength(clear.length));
	padded.set(clear);
	try {
		const output = await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, padded);
		return new Uint8Array(output, 0, padded.length);
	} finally { padded.fill(0); }
}
async function decryptBlocks(key, iv, cipher) {
	const last = cipher.subarray(cipher.length - 16);
	const padding = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv: last }, key, new Uint8Array()));
	return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, concat(cipher, padding)));
}

async function stretch(password, salt, rounds) {
	if (typeof password !== 'string' || !password.length || password.length > 255) throw Error('password');
	const input = new Uint8Array(salt.length + password.length * 2);
	input.set(salt);
	const words = new DataView(input.buffer, salt.length);
	for (let index = 0; index < password.length; index++) words.setUint16(index * 2, password.charCodeAt(index), true);
	const block = new Uint8Array(68);
	const counter = new DataView(block.buffer);
	block.set(sha512(input), 4);
	input.fill(0);
	// Renderer timers can be delayed while Obsidian is in the background.
	// Yield through a message port so the Office iteration count stays intact.
	const channel = new MessageChannel();
	const yieldToRenderer = () => new Promise(resolve => {
		channel.port1.onmessage = resolve;
		channel.port2.postMessage(null);
	});
	try {
		for (let index = 0; index < rounds; index++) {
			counter.setUint32(0, index, true);
			block.set(sha512(block), 4);
			if (index % 8192 === 8191) await yieldToRenderer();
		}
		return block.slice(4);
	} finally {
		channel.port1.close();
		channel.port2.close();
		block.fill(0);
	}
}
async function passwordAes(hash, key) {
	const digest = sha512(concat(hash, key));
	try { return await aes(digest.subarray(0, 32)); }
	finally { digest.fill(0); }
}

function readContainer(buffer, Parser) {
	if (buffer.byteLength > DOCX_DISK_MAX_BYTES) throw Error('large');
	let container;
	try { container = CFB.read(new Uint8Array(buffer), { type: 'array' }); }
	catch { throw Error('unsupported'); }
	const stream = (name, min, max) => {
		const data = CFB.find(container, '/' + name)?.content;
		if (!data || data.length < min || data.length > max) throw Error('unsupported');
		return Uint8Array.from(data);
	};
	const info = stream('EncryptionInfo', 9, 16 * 1024);
	const payload = stream('EncryptedPackage', 24, DOCX_MAX_BYTES + 8);
	if (!prefix.every((byte, index) => byte === info[index])) throw Error('unsupported');
	const size = new DataView(payload.buffer).getUint32(0, true);
	if (!size || size > DOCX_MAX_BYTES || new DataView(payload.buffer).getUint32(4, true) || payload.length !== blockLength(size) + 8)
		throw Error('unsupported');
	const text = decoder.decode(info.subarray(8));
	if (/<!DOCTYPE|<!ENTITY/iu.test(text)) throw Error('unsupported');
	const doc = new Parser().parseFromString(text, 'application/xml');
	const first = (ns, name) => {
		const elements = doc.getElementsByTagNameNS(ns, name);
		if (elements.length !== 1) throw Error('unsupported');
		return elements[0];
	};
	const data = first(agile, 'keyData'), dataIntegrity = first(agile, 'dataIntegrity'), key = first(passwords, 'encryptedKey');
	const rounds = Number(key.getAttribute('spinCount'));
	if (!Number.isInteger(rounds) || rounds < 1 || rounds > 1000000 ||
		![data, key].every(node => Object.entries(properties).every(([name, value]) => node.getAttribute(name) === value)))
		throw Error('unsupported');
	const descriptor = {
		rounds,
		salt: unbase64(key.getAttribute('saltValue'), 16),
		encryptedVerifierHashInput: unbase64(key.getAttribute('encryptedVerifierHashInput'), 16),
		encryptedVerifierHashValue: unbase64(key.getAttribute('encryptedVerifierHashValue'), 64),
		encryptedKeyValue: unbase64(key.getAttribute('encryptedKeyValue'), 32),
	};
	return { descriptor, size, payload, salt: unbase64(data.getAttribute('saltValue'), 16),
		hmacKey: unbase64(dataIntegrity.getAttribute('encryptedHmacKey'), 64),
		hmacValue: unbase64(dataIntegrity.getAttribute('encryptedHmacValue'), 64) };
}

export async function openPasswordDocx(buffer, password, Parser) {
	const record = readContainer(buffer, Parser);
	const { descriptor } = record;
	const hash = await stretch(password, descriptor.salt, descriptor.rounds);
	try {
		const decrypt = async (kind, data) => decryptBlocks(await passwordAes(hash, blockKeys[kind]), descriptor.salt, data);
		const verifier = sha512(await decrypt('verifier', descriptor.encryptedVerifierHashInput));
		const expected = await decrypt('verifierHash', descriptor.encryptedVerifierHashValue);
		let difference = 0;
		for (let index = 0; index < verifier.length; index++) difference |= verifier[index] ^ expected[index];
		if (difference) throw Error('password');
		const raw = await decrypt('key', descriptor.encryptedKeyValue);
		try {
			const protection = { key: await aes(raw), descriptor };
			return { protection, clear: await openPasswordDocxWithKey(record, protection) };
		} finally { raw.fill(0); }
	} finally { hash.fill(0); }
}

export async function openPasswordDocxWithKey(record, protection, Parser) {
	if (record instanceof ArrayBuffer) record = readContainer(record, Parser);
	const { key } = protection;
	const raw = await decryptBlocks(key, ivFor(record.salt, blockKeys.hmacKey), record.hmacKey);
	try {
		const expected = await decryptBlocks(key, ivFor(record.salt, blockKeys.hmacValue), record.hmacValue);
		if (!await crypto.subtle.verify('HMAC', await hmac(raw), expected, record.payload)) throw Error('unsupported');
	} finally { raw.fill(0); }
	const out = new Uint8Array(record.size);
	for (let offset = 0; offset < out.length; offset += segment) {
		const length = Math.min(segment, out.length - offset);
		const start = offset + 8;
		const deciphered = await decryptBlocks(key, ivFor(record.salt, uint32(offset / segment)), record.payload.subarray(start, start + blockLength(length)));
		out.set(deciphered.subarray(0, length), offset);
		deciphered.fill(0);
	}
	return out.buffer;
}

export async function createDocxProtection(password) {
	const salt = random(16);
	const hash = await stretch(password, salt, spinCount);
	const raw = random(32);
	try {
		const encrypt = async (kind, value) => encryptBlocks(await passwordAes(hash, blockKeys[kind]), salt, value);
		const verifier = random(16);
		return { key: await aes(raw), descriptor: { rounds: spinCount, salt,
			encryptedVerifierHashInput: await encrypt('verifier', verifier),
			encryptedVerifierHashValue: await encrypt('verifierHash', sha512(verifier)),
			encryptedKeyValue: await encrypt('key', raw) } };
	} finally { hash.fill(0); raw.fill(0); }
}

export async function sealPasswordDocx(buffer, protection) {
	const input = new Uint8Array(buffer);
	if (!input.length || input.length > DOCX_MAX_BYTES) throw Error('large');
	const { key, descriptor } = protection;
	const salt = random(16);
	const payload = new Uint8Array(blockLength(input.length) + 8);
	payload.set(uint32(input.length));
	for (let offset = 0; offset < input.length; offset += segment) {
		const encrypted = await encryptBlocks(key, ivFor(salt, uint32(offset / segment)), input.subarray(offset, offset + segment));
		payload.set(encrypted, offset + 8);
	}
	const raw = random(64);
	try {
		const hash = new Uint8Array(await crypto.subtle.sign('HMAC', await hmac(raw), payload));
		const integrityKey = await encryptBlocks(key, ivFor(salt, blockKeys.hmacKey), raw);
		const integrityValue = await encryptBlocks(key, ivFor(salt, blockKeys.hmacValue), hash);
		const attr = Object.entries(properties).map(([name, value]) => `${name}="${value}"`).join(' ');
		const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
			`<encryption xmlns="${agile}" xmlns:p="${passwords}"><keyData ${attr} saltValue="${base64(salt)}"/>` +
			`<dataIntegrity encryptedHmacKey="${base64(integrityKey)}" encryptedHmacValue="${base64(integrityValue)}"/>` +
			`<keyEncryptors><keyEncryptor uri="${passwords}"><p:encryptedKey ${attr} spinCount="${descriptor.rounds}" ` +
			`saltValue="${base64(descriptor.salt)}" encryptedVerifierHashInput="${base64(descriptor.encryptedVerifierHashInput)}" ` +
			`encryptedVerifierHashValue="${base64(descriptor.encryptedVerifierHashValue)}" encryptedKeyValue="${base64(descriptor.encryptedKeyValue)}"/>` +
			`</keyEncryptor></keyEncryptors></encryption>`;
		const cfb = CFB.utils.cfb_new();
		addDataSpaces(cfb);
		CFB.utils.cfb_add(cfb, 'EncryptionInfo', concat(prefix, encoder.encode(xml)));
		CFB.utils.cfb_add(cfb, 'EncryptedPackage', payload);
		CFB.utils.cfb_del(cfb, '\u0001Sh33tJ5');
		return Uint8Array.from(CFB.write(cfb, { type: 'array' })).buffer;
	} finally { raw.fill(0); }
}

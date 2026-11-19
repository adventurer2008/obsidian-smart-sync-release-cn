import { inflateSync } from 'fflate';

const MiB = 1024 * 1024;
export const EPUB_MAX_BYTES = 48 * MiB;
const MARKUP_BYTES = MiB;
const MAX_ENTRIES = 4096;
const MAX_NODES = 12000;
const XHTML = 'http://www.w3.org/1999/xhtml';
const EPUB_NS = 'http://www.idpf.org/2007/ops';
const textDecoder = new TextDecoder('utf-8', { fatal: true });

export class EpubError extends Error {
	constructor(code = 'invalid') { super(code); this.code = code; }
}
const fail = code => { throw new EpubError(code); };
const hasControl = value => {
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code < 32 || code === 127) return true;
	}
	return false;
};
const localPath = path => path && !path.startsWith('/') && !path.includes('\\') && !hasControl(path) &&
	path.split('/').every(part => part && part !== '.' && part !== '..');

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
	for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
	return value;
});
function checksum(bytes) {
	let value = 0xffffffff;
	for (const byte of bytes) value = (value >>> 8) ^ crcTable[(value ^ byte) & 255];
	return (value ^ 0xffffffff) >>> 0;
}

function archive(bytes) {
	if (bytes.length > EPUB_MAX_BYTES) fail('large');
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const u16 = offset => view.getUint16(offset, true);
	const u32 = offset => view.getUint32(offset, true);
	let end = bytes.length - 22;
	for (; end >= Math.max(0, bytes.length - 65557); end--) {
		if (u32(end) === 0x06054b50 && end + 22 + u16(end + 20) === bytes.length) break;
	}
	if (end < Math.max(0, bytes.length - 65557) || u16(end + 4) || u16(end + 6)) fail();
	const count = u16(end + 10), directory = u32(end + 16);
	if (count > MAX_ENTRIES) fail('large');
	if (!count || u16(end + 8) !== count || directory + u32(end + 12) !== end) fail();
	const entries = new Map();
	let at = directory;
	for (let index = 0; index < count; index++) {
		if (at + 46 > end || u32(at) !== 0x02014b50) fail();
		const nameEnd = at + 46 + u16(at + 28);
		const next = nameEnd + u16(at + 30) + u16(at + 32);
		if (next > end || u16(at + 34)) fail();
		const name = textDecoder.decode(bytes.subarray(at + 46, nameEnd));
		const flags = u16(at + 8), method = u16(at + 10);
		const packed = u32(at + 20), size = u32(at + 24), header = u32(at + 42);
		if (flags & 0x41) fail('protected');
		if (!localPath(name.replace(/\/$/u, '')) || entries.has(name) || header + 30 > directory ||
			u32(header) !== 0x04034b50 || u16(header + 6) !== flags || u16(header + 8) !== method) fail();
		const headerNameEnd = header + 30 + u16(header + 26);
		const data = headerNameEnd + u16(header + 28);
		if (data + packed > directory ||
			textDecoder.decode(bytes.subarray(header + 30, headerNameEnd)) !== name) fail();
		entries.set(name, { method, packed, size, data, crc: u32(at + 16) });
		at = next;
	}
	if (at !== end) fail();
	return {
		has: path => entries.has(path),
		read(path, limit = MARKUP_BYTES) {
			const entry = entries.get(path);
			if (!entry) fail();
			const { method, packed, size, data, crc } = entry;
			if (size > limit || packed > limit + 65536) fail('large');
			const source = bytes.subarray(data, data + packed);
			// One spare byte makes a forged undersized ZIP entry fail after bounded inflation.
			if (method !== 0 && method !== 8) fail('unsupported');
			const result = method === 0 ? source : inflateSync(source, { out: new Uint8Array(size + 1) });
			if (result.length !== size || checksum(result) !== crc) fail();
			return result;
		},
	};
}

function resolveReference(base, reference) {
	if (!reference || /^[\s/]/u.test(reference) || /[?\\]/u.test(reference) || hasControl(reference)) return;
	const hash = reference.indexOf('#');
	const path = hash < 0 ? reference : reference.slice(0, hash);
	if (/^[^/]*:/u.test(path)) return;
	try {
		const fragment = hash < 0 ? '' : decodeURIComponent(reference.slice(hash + 1));
		if (!path) return { path: base, fragment };
		const pieces = base.split('/').slice(0, -1);
		for (const encoded of path.split('/')) {
			const part = decodeURIComponent(encoded);
			if (!part || /[/\\:]/u.test(part) || hasControl(part)) return;
			if (part === '..') { if (!pieces.length) return; pieces.pop(); }
			else if (part !== '.') pieces.push(part);
		}
		if (pieces.length) return { path: pieces.join('/'), fragment };
	} catch { /* Malformed escapes cannot resolve to an archive resource. */ }
}

function markup(bytes, Parser, contentType) {
	let source;
	if (bytes[0] === 0xff && bytes[1] === 0xfe) source = new TextDecoder('utf-16le', { fatal: true }).decode(bytes);
	else if (bytes[0] === 0xfe && bytes[1] === 0xff) source = new TextDecoder('utf-16be', { fatal: true }).decode(bytes);
	else source = textDecoder.decode(bytes);
	// Accept the usual external XHTML doctype without ever exposing it to the XML parser.
	if (contentType) source = source.replace(/^(\s*(?:<\?xml[^?]*\?>\s*)?)<!DOCTYPE\s+(html|ncx)(?:\s+(?:PUBLIC\s+(?:"[^"]*"|'[^']*')\s+(?:"[^"]*"|'[^']*')|SYSTEM\s+(?:"[^"]*"|'[^']*')))?\s*>/iu,
		(match, prefix, name) => name.toLowerCase() === contentType ? prefix : match);
	if (/<!DOCTYPE|<!ENTITY/iu.test(source)) fail('unsupported');
	if (contentType === 'html') source = source.replace(/<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|&(nbsp|ndash|mdash|lsquo|rsquo|ldquo|rdquo|hellip|copy|reg);/gu,
		(match, name) => name ? '&#' + ({ nbsp: 160, ndash: 8211, mdash: 8212, lsquo: 8216, rsquo: 8217,
			ldquo: 8220, rdquo: 8221, hellip: 8230, copy: 169, reg: 174 })[name] + ';' : match);
	const doc = new Parser().parseFromString(source, 'application/xml');
	if (doc.getElementsByTagNameNS('*', 'parsererror').length || !doc.documentElement) fail();
	return doc.documentElement;
}

const children = (node, name) => [...(node?.children ?? [])].filter(child => child.localName === name);
const elements = (node, name) => [...node.getElementsByTagNameNS('*', name)];
const one = (node, name) => children(node, name)[0];
const tokens = value => (value ?? '').split(/\s+/u);
const heading = value => value?.replace(/\s+/gu, ' ').trim().slice(0, 200);
const chaptersType = 'application/xhtml+xml';
const imageTypes = new Set(['image/jpeg', 'image/png']);
const obfuscation = new Set(['http://www.idpf.org/2008/embedding', 'http://ns.adobe.com/pdf/enc#RC']);

export function openEpub(bytes, Parser) {
	const zip = archive(bytes);
	if (textDecoder.decode(zip.read('mimetype', 32)) !== 'application/epub+zip') fail();
	if (zip.has('META-INF/encryption.xml')) {
		const encrypted = markup(zip.read('META-INF/encryption.xml'), Parser);
		const methods = elements(encrypted, 'EncryptedData').map(entry => one(entry, 'EncryptionMethod')?.getAttribute('Algorithm'));
		if (!methods.length || methods.some(method => !obfuscation.has(method))) fail('protected');
	}
	const container = markup(zip.read('META-INF/container.xml'), Parser);
	const root = children(one(container, 'rootfiles'), 'rootfile').find(el =>
		el.getAttribute('media-type') === 'application/oebps-package+xml');
	const packagePath = root?.getAttribute('full-path');
	if (container.localName !== 'container' || !localPath(packagePath)) fail();
	const opf = markup(zip.read(packagePath), Parser);
	if (opf.localName !== 'package' || !/^[23](?:\.\d+)?$/u.test(opf.getAttribute('version') ?? '')) fail('unsupported');
	const metadata = one(opf, 'metadata');
	const spine = one(opf, 'spine');
	if (children(metadata, 'meta').some(el => el.getAttribute('property') === 'rendition:layout' && el.textContent.trim() === 'pre-paginated') ||
		children(spine, 'itemref').some(el => tokens(el.getAttribute('properties')).includes('rendition:layout-pre-paginated'))) fail('unsupported');
	const displayOptions = 'META-INF/com.apple.ibooks.display-options.xml';
	if (zip.has(displayOptions) && elements(markup(zip.read(displayOptions), Parser), 'option').some(el =>
		el.getAttribute('name') === 'fixed-layout' && el.textContent.trim() === 'true')) fail('unsupported');

	const items = new Map(), resources = new Map();
	for (const item of children(one(opf, 'manifest'), 'item')) {
		const id = item.getAttribute('id');
		const target = resolveReference(packagePath, item.getAttribute('href'));
		if (!id || !target || target.fragment || !zip.has(target.path)) continue;
		const resource = { path: target.path, type: item.getAttribute('media-type'), nav: tokens(item.getAttribute('properties')).includes('nav') };
		if (items.has(id)) fail();
		items.set(id, resource);
		resources.set(resource.path, resource);
	}
	const chapters = children(spine, 'itemref').flatMap(ref => {
		const item = items.get(ref.getAttribute('idref'));
		if (item?.type !== chaptersType) {
			if (ref.getAttribute('linear') === 'no') return [];
			fail('unsupported');
		}
		return [{ path: item.path, label: '' }];
	});
	if (!chapters.length) fail('unsupported');
	if (chapters.length > 1500) fail('large');
	const byPath = new Map();
	for (const [index, chapter] of chapters.entries())
		if (!byPath.has(chapter.path)) byPath.set(chapter.path, index);
	const recordLabel = (base, reference, text) => {
		const index = byPath.get(resolveReference(base, reference)?.path);
		if (index !== undefined && !chapters[index].label) chapters[index].label = heading(text);
	};
	const nav = [...items.values()].find(item => item.nav && item.type === chaptersType);
	const ncx = items.get(spine.getAttribute('toc'));
	try {
		if (nav) {
			const page = markup(zip.read(nav.path), Parser, 'html');
			const toc = elements(page, 'nav').find(el => tokens(el.getAttributeNS(EPUB_NS, 'type')).includes('toc'));
			if (toc) for (const link of elements(toc, 'a')) recordLabel(nav.path, link.getAttribute('href'), link.textContent);
		} else if (ncx?.type === 'application/x-dtbncx+xml') {
			const toc = markup(zip.read(ncx.path), Parser, 'ncx');
			for (const point of elements(toc, 'navPoint'))
				recordLabel(ncx.path, one(point, 'content')?.getAttribute('src'), one(one(point, 'navLabel'), 'text')?.textContent);
		}
	} catch { /* The spine is still usable if an optional table of contents is invalid. */ }
	return {
		title: heading(one(metadata, 'title')?.textContent), chapters,
		readChapter: index => markup(zip.read(chapters[index].path), Parser, 'html'),
		link(base, href) {
			const target = resolveReference(base, href);
			const index = byPath.get(target?.path);
			return index === undefined ? undefined : { index, fragment: target.fragment };
		},
		image(base, src) {
			const path = resolveReference(base, src)?.path;
			const item = resources.get(path);
			if (!imageTypes.has(item?.type)) return;
			try { return { type: item.type, bytes: zip.read(path, 4 * MiB) }; } catch { return; }
		},
	};
}

const allowed = new Set('article section header footer main aside div p span h1 h2 h3 h4 h5 h6 ul ol li dl dt dd figure figcaption blockquote pre code strong em b i u s small mark sub sup ruby rt rp abbr cite q br hr table thead tbody tfoot tr th td caption'.split(' '));
const discard = new Set('script style link meta base iframe frame object embed form input button select textarea video audio source picture canvas svg math template noscript'.split(' '));

function rasterPixels(type, bytes) {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (type === 'image/png' && bytes.length >= 33 && view.getUint32(0) === 0x89504e47 &&
		view.getUint32(4) === 0x0d0a1a0a && view.getUint32(8) === 13 && view.getUint32(12) === 0x49484452)
		return view.getUint32(16) * view.getUint32(20);
	if (type !== 'image/jpeg' || bytes[0] !== 0xff || bytes[1] !== 0xd8) return 0;
	for (let at = 2; at + 4 < bytes.length;) {
		if (bytes[at++] !== 0xff) return 0;
		while (bytes[at] === 0xff) at++;
		const marker = bytes[at++];
		if (marker === 0xda || marker === 0xd9 || at + 2 > bytes.length) return 0;
		const length = view.getUint16(at);
		if (length < 2 || at + length > bytes.length) return 0;
		if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 8)
			return view.getUint16(at + 3) * view.getUint16(at + 5);
		at += length;
	}
	return 0;
}

// Build fresh DOM and never attach parsed EPUB nodes, attributes, styles or external URLs.
export function renderEpubChapter(book, index, doc, navigate) {
	const source = book.readChapter(index);
	const body = one(source, 'body');
	if (source.localName !== 'html' || !body || (body.namespaceURI && body.namespaceURI !== XHTML)) fail('unsupported');
	const fragment = doc.createDocumentFragment(), anchors = new Map(), urls = [];
	const win = doc.defaultView;
	const base = book.chapters[index].path;
	let nodes = 0, pixels = 0, imageBytes = 0, imageAttempts = 0;
	const keepAnchor = (from, to) => {
		for (const id of [from.getAttribute('id'), from.localName === 'a' ? from.getAttribute('name') : null])
			if (id && !anchors.has(id)) anchors.set(id, to);
	};
	const append = (parent, child, depth) => {
		if (++nodes > MAX_NODES || depth > 60) fail('large');
		if (child.nodeType === 3 || child.nodeType === 4) { parent.append(doc.createTextNode(child.data)); return; }
		if (child.nodeType !== 1 || (child.namespaceURI && child.namespaceURI !== XHTML) || child.hasAttribute('hidden')) return;
		const tag = child.localName.toLowerCase();
		if (discard.has(tag)) return;
		let el;
		if (tag === 'img') {
			const alt = child.getAttribute('alt') ?? '';
			const image = imageAttempts++ < 20 && win.URL.createObjectURL && book.image(base, child.getAttribute('src'));
			const count = image && rasterPixels(image.type, image.bytes);
			if (count > 0 && pixels + count <= 20_000_000 && imageBytes + image.bytes.length <= 12 * MiB) {
				pixels += count; imageBytes += image.bytes.length;
				const url = win.URL.createObjectURL(new win.Blob([image.bytes], { type: image.type }));
				urls.push(url);
				el = doc.createElement('img');
				el.alt = alt;
				el.src = url;
				el.decoding = 'async';
			} else {
				el = doc.createElement('span');
				el.textContent = alt;
			}
		} else if (tag === 'a') {
			const target = book.link(base, child.getAttribute('href'));
			el = doc.createElement(target ? 'a' : 'span');
			if (target) {
				el.href = '#';
				el.addEventListener('click', event => {
					event.preventDefault();
					navigate(target.index, target.fragment);
				});
				el.addEventListener('auxclick', event => event.preventDefault());
			}
		} else el = doc.createElement(allowed.has(tag) ? tag : 'span');
		const lang = child.getAttribute('lang') ?? child.getAttributeNS('http://www.w3.org/XML/1998/namespace', 'lang');
		const dir = child.getAttribute('dir');
		if (/^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/iu.test(lang ?? '')) el.lang = lang;
		if (['ltr', 'rtl', 'auto'].includes(dir)) el.dir = dir;
		keepAnchor(child, el);
		parent.append(el);
		if (tag !== 'img') for (const node of child.childNodes) append(el, node, depth + 1);
	};
	const dispose = () => { for (const url of urls.splice(0)) win.URL.revokeObjectURL(url); };
	try { for (const node of body.childNodes) append(fragment, node, 0); }
	catch (error) { dispose(); throw error; }
	return { fragment, anchors, dispose };
}

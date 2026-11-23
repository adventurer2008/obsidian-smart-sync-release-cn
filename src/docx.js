import { strToU8, zipSync } from 'fflate';
import { openZipArchive } from './epub.js';

const MiB = 1024 * 1024;
export const DOCX_MAX_BYTES = 16 * MiB;
const expandedLimit = 48 * MiB;
const xmlLimit = 8 * MiB;
const word = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const relationships = 'http://schemas.openxmlformats.org/package/2006/relationships';
const office = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const types = 'http://schemas.openxmlformats.org/package/2006/content-types';
const documentType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
const declaration = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const decoder = new TextDecoder('utf-8', { fatal: true });
const main = 'word/document.xml';

export function docxName(value) {
	const name = value.trim().replace(/\.docx$/iu, '').trim();
	if (!name || name.startsWith('.') || name.endsWith('.') || /[<>:"/\\|?*]/u.test(name) ||
		[...name].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) ||
		/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(name) ||
		strToU8(name).length > 240) return;
	return `${name}.docx`;
}

export function blankDocx() {
	const parts = {
		'[Content_Types].xml': `<Types xmlns="${types}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/${main}" ContentType="${documentType}"/></Types>`,
		'_rels/.rels': `<Relationships xmlns="${relationships}"><Relationship Id="rId1" Type="${office}/officeDocument" Target="${main}"/></Relationships>`,
		[main]: `<w:document xmlns:w="${word}"><w:body><w:p/><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`,
	};
	return zipSync(Object.fromEntries(Object.entries(parts).map(([path, xml]) => [path, strToU8(declaration + xml)]))).buffer;
}

export function inspectDocx(buffer, Parser) {
	const bytes = new Uint8Array(buffer);
	if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0)
		throw Error('protected');
	const zip = openZipArchive(bytes, DOCX_MAX_BYTES);
	const xml = new Map();
	let total = 0;
	let readOnly = false;
	for (const path of zip.names()) {
		const size = zip.size(path);
		total += size;
		if (total > expandedLimit || size > expandedLimit) throw Error('large');
		if (path.endsWith('/')) continue;
		const isXml = /\.(?:xml|rels|svg)$/iu.test(path);
		const content = zip.read(path, isXml ? xmlLimit : expandedLimit);
		if (!isXml) continue;
		let source;
		if (content[0] === 0xff && content[1] === 0xfe) source = new TextDecoder('utf-16le', { fatal: true }).decode(content);
		else if (content[0] === 0xfe && content[1] === 0xff) source = new TextDecoder('utf-16be', { fatal: true }).decode(content);
		else source = decoder.decode(content);
		if (/<!DOCTYPE|<!ENTITY/iu.test(source)) throw Error('unsupported');
		const doc = new Parser().parseFromString(source, 'application/xml');
		if (doc.getElementsByTagNameNS('*', 'parsererror').length) throw Error('invalid');
		if (path.endsWith('.rels')) {
			for (const relation of doc.getElementsByTagNameNS(relationships, 'Relationship')) {
				if (relation.getAttribute('TargetMode')?.toLowerCase() !== 'external') continue;
				if (relation.getAttribute('Type') !== `${office}/hyperlink` ||
					!/^(?:https?:\/\/|mailto:)/iu.test(relation.getAttribute('Target') ?? '')) throw Error('unsupported');
			}
		}
		if (/^_xmlsignatures\//iu.test(path) || doc.getElementsByTagNameNS(word, 'documentProtection').length ||
			doc.getElementsByTagNameNS(word, 'altChunk').length) readOnly = true;
		xml.set(path, doc);
	}
	const format = [...(xml.get('[Content_Types].xml')?.getElementsByTagNameNS(types, 'Override') ?? [])]
		.find(item => item.getAttribute('PartName') === `/${main}`);
	if (format?.getAttribute('ContentType') !== documentType ||
		xml.get(main)?.documentElement.namespaceURI !== word ||
		!xml.get(main)?.getElementsByTagNameNS(word, 'body').length) throw Error('invalid');
	return { zip, xml, readOnly };
}

export function sameBytes(left, right) {
	return left.length === right.length && left.every((byte, offset) => byte === right[offset]);
}

export function checkDocxImages({ xml, zip }) {
	const origin = 'https://docx.invalid';
	const contentTypes = xml.get('[Content_Types].xml');
	const defaults = new Map([...contentTypes.getElementsByTagNameNS(types, 'Default')]
		.map(node => [node.getAttribute('Extension')?.toLowerCase(), node.getAttribute('ContentType')]));
	const overrides = new Map([...contentTypes.getElementsByTagNameNS(types, 'Override')]
		.map(node => [node.getAttribute('PartName'), node.getAttribute('ContentType')]));
	for (const [path, part] of xml) {
		if (!path.startsWith('word/') || !path.endsWith('.xml')) continue;
		const ids = new Set();
		for (const name of ['blip', 'svgBlip', 'imagedata']) {
			for (const image of part.getElementsByTagNameNS('*', name)) {
				const id = image.getAttributeNS(office, 'embed') || image.getAttributeNS(office, 'id');
				if (id) ids.add(id);
			}
		}
		if (!ids.size) continue;
		const split = path.lastIndexOf('/') + 1;
		const rels = xml.get(`${path.slice(0, split)}_rels/${path.slice(split)}.rels`);
		const byId = new Map([...(rels?.getElementsByTagNameNS(relationships, 'Relationship') ?? [])]
			.map(node => [node.getAttribute('Id'), node]));
		for (const id of ids) {
			const rel = byId.get(id);
			const target = rel?.getAttribute('Target');
			if (!target || rel.getAttribute('Type') !== `${office}/image`) throw Error('missingImage');
			let partName;
			try {
				const url = new URL(target, `${origin}/${path}`);
				if (url.origin !== origin || url.search || url.hash) throw Error('target');
				partName = decodeURIComponent(url.pathname).slice(1);
			} catch { throw Error('missingImage'); }
			const extension = partName.split('.').at(-1).toLowerCase();
			const format = overrides.get(`/${partName}`) ?? defaults.get(extension);
			if (!format?.startsWith('image/') || !zip.size(partName)) throw Error('missingImage');
		}
	}
}

// These parts have presentation or payload data that the rich-text editor may not
// expose. Keep the source available if serialization drops their payload or anchors.
export function checkDocxRoundTrip(before, after) {
	for (const path of before.zip.names()) {
		if (!/^(?:word\/(?:embeddings|activeX|charts|diagrams)\/|customXml\/)/iu.test(path) || path.endsWith('/')) continue;
		if (!after.zip.has(path) ||
			!sameBytes(before.zip.read(path, expandedLimit), after.zip.read(path, expandedLimit))) throw Error('preservation');
	}
	for (const [path, doc] of before.xml) {
		const next = after.xml.get(path);
		if (path.endsWith('.rels')) {
			const opaque = node => /\/(?:oleObject|package|chart|diagramData|diagramLayout|diagramColors|diagramQuickStyle|control)$/u
				.test(node.getAttribute('Type') ?? '');
			const key = node => ['Id', 'Type', 'Target', 'TargetMode'].map(attribute => node.getAttribute(attribute)).join('\n');
			const remaining = new Set([...(next?.getElementsByTagNameNS(relationships, 'Relationship') ?? [])].map(key));
			for (const relation of doc.getElementsByTagNameNS(relationships, 'Relationship'))
				if (opaque(relation) && !remaining.has(key(relation))) throw Error('preservation');
			continue;
		}
		const protectedNodes = ['object', 'control', 'altChunk', 'commentRangeStart', 'commentRangeEnd', 'commentReference', 'ins', 'del', 'moveFrom', 'moveTo'];
		for (const name of protectedNodes) {
			const original = doc.getElementsByTagNameNS(word, name);
			if (original.length && original.length !== next?.getElementsByTagNameNS(word, name).length) throw Error('preservation');
		}
	}
}

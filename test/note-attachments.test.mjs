import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { createLocked, openLocked, lockedRanges, lockedMarker } from '../src/note-crypto.js';
import { desktopFiles } from '../src/desktop.js';
import { findNoteAttachments, stageNoteAttachments, finishAttachmentLock, parseAttachmentManifest,
	restoreNoteAttachments, decryptAttachment, attachmentPackagePath } from '../src/note-attachments.js';

const password = 'isolated attachment lab password';
const mtime = 1577836800123;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');

async function fixture(t) {
	const directory = await mkdtemp(join(tmpdir(), 'smart-sync-attachment-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	await mkdir(join(directory, 'assets'));
	const files = new Map();
	const vault = {
		adapter: { exists: path => readFile(join(directory, path)).then(() => true, () => false) },
		getAbstractFileByPath: path => files.get(path),
		getMarkdownFiles: () => [...files.values()].filter(file => file.path.endsWith('.md')),
		readBinary: async file => Uint8Array.from(await readFile(join(directory, file.path))).buffer,
		async createBinary(path, bytes, options = {}) {
			await writeFile(join(directory, path), Buffer.from(bytes), { flag: 'wx' });
			const file = { path, stat: { size: bytes.byteLength, mtime: options.mtime ?? mtime, ctime: options.ctime ?? mtime } };
			files.set(path, file);
			return file;
		},
		async delete(file) { await rm(join(directory, file.path)); files.delete(file.path); },
	};
	const photo = await vault.createBinary('assets/photo.png', png);
	const pdf = await vault.createBinary('assets/sample.pdf', Buffer.from('%PDF-1.7\nSample fixture'));
	const file = await vault.createBinary('private.md', Buffer.from('test'));
	const app = { vault, metadataCache: { getFileCache: file => file.metadata ?? {}, getFirstLinkpathDest: path => files.get(path) } };
	return { app, vault, photo, pdf, file, directory };
}

test('encrypted attachment package authenticates bytes and interrupted lock or restore can retry', async t => {
	const { app, vault, photo, pdf, file, directory } = await fixture(t);
	const text = 'private ![[assets/photo.png]]';
	let staged;
	const box = await createLocked('', password, '', 'bundle', async (id, key) => {
		staged = await stageNoteAttachments(vault, id, key, text, [photo, pdf]);
		return staged.value;
	});
	const disk = await readFile(join(directory, attachmentPackagePath(box.id)));
	assert.equal(disk.includes(png), false);
	assert.equal(disk.includes('%PDF'), false);
	assert.equal(lockedRanges(lockedMarker(box))[0].box.kind, 'bundle');
	await assert.rejects(openLocked(box, 'wrong password'));
	const opened = await openLocked(box, password);
	const manifest = parseAttachmentManifest(opened.text);
	assert.equal(manifest.text, text);
	const finish = (signal, remove = vault.delete) => finishAttachmentLock(app, file.path, box.id, opened.key, manifest, signal, remove);
	const corrupted = Buffer.from(disk);
	corrupted[corrupted.length - 1] ^= 1;
	await writeFile(join(directory, staged.file.path), corrupted);
	await assert.rejects(finish(() => true));
	assert.equal(await vault.adapter.exists(photo.path), true);
	await writeFile(join(directory, staged.file.path), disk);
	let count = 0;
	await assert.rejects(finish(() => ++count === 1));
	assert.equal(await vault.adapter.exists(photo.path), false);
	assert.equal(await vault.adapter.exists(pdf.path), true);
	const bytes = await finish(() => true);
	assert.deepEqual(Buffer.from(await decryptAttachment(bytes, box.id, opened.key, manifest.entries[0])), png);
	assert.equal(await vault.adapter.exists(photo.path), false);
	assert.equal(await vault.adapter.exists(pdf.path), false);
	count = 0;
	await assert.rejects(restoreNoteAttachments(vault, box.id, opened.key, manifest, () => ++count === 1));
	await restoreNoteAttachments(vault, box.id, opened.key, manifest, () => true);
	assert.deepEqual(await readFile(join(directory, photo.path)), png);
	assert.equal(vault.getAbstractFileByPath(photo.path).stat.mtime, mtime);
	assert.match(await readFile(join(directory, pdf.path), 'utf8'), /^%PDF/);
});

test('attachment discovery deduplicates embeds and links, prevents shared files, and fails on missing local files', async t => {
	const { app, vault, photo, pdf, file } = await fixture(t);
	const snapshot = { file, path: file.path, original: 'test' };
	file.metadata = { embeds: [{ link: photo.path }], links: [{ link: photo.path }, { link: pdf.path + '#page=1' }, { link: 'https://example.com/photo.png' }] };
	assert.deepEqual(findNoteAttachments(app, snapshot), [photo, pdf]);
	const other = await vault.createBinary('other.md', Buffer.from('test'));
	other.metadata = { frontmatterLinks: [{ link: photo.path }] };
	assert.throws(() => findNoteAttachments(app, snapshot), /other\.md/);
	delete other.metadata;
	file.metadata.embeds.push({ link: 'missing.png' });
	assert.throws(() => findNoteAttachments(app, snapshot), /missing\.png/);
});

test('desktop path checks refuse aliases and hard-linked attachments before a destructive conversion', async t => {
	const { directory, photo } = await fixture(t);
	const require = createRequire(import.meta.url);
	let hardLinked = false;
	const filesystem = { ...fs, async lstat(path) {
		if (basename(path) === 'alias') return { isDirectory: () => false, isSymbolicLink: () => true };
		const stat = await fs.lstat(path);
		if (hardLinked && basename(path) === 'photo.png') stat.nlink = 2;
		return stat;
	} };
	const load = name => name === 'node:fs/promises' ? filesystem : require(name);
	const desktop = desktopFiles({ adapter: { getBasePath: () => directory } }, { load });
	await desktop.verifyAttachmentPath(photo.path);
	await desktop.verifyAttachmentPath('assets/restore.png', true);
	await assert.rejects(desktop.verifyAttachmentPath('alias/photo.png'));
	await assert.rejects(desktop.verifyAttachmentPath('alias/restore.png', true));
	hardLinked = true;
	await assert.rejects(desktop.verifyAttachmentPath(photo.path));
});

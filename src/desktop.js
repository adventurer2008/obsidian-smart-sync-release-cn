import { safeHostPath, SEGMENT_BYTES, MAX_NOTE_BYTES } from './codec.js';

export const DESKTOP_THRESHOLD = 8 * 1024 * 1024;
const activeByVault = new Map(),
	lastPruned = new Map();
export function desktopFiles(vault, { load, stopped = () => false } = {}) {
	if (typeof load !== 'function' || typeof vault.adapter?.getBasePath !== 'function')
		return undefined;
	const fs = load('node:fs/promises'),
		path = load('node:path'),
		cryptoNode = load('node:crypto');
	const safePath = value => safeHostPath(value, path.sep === '\\');
	const base = path.resolve(vault.adapter.getBasePath());
	const inside = (parent, target) => {
		const relative = path.relative(parent, target);
		if (relative.startsWith('..') || path.isAbsolute(relative))
			throw Error('Desktop path leaves vault');
		return target;
	};
	const filePath = async (name) => {
		const target = inside(base, path.resolve(base, safePath(name)));
		inside(await fs.realpath(base), await fs.realpath(target));
		return target;
	};
	const active = activeByVault.get(base) ?? new Set();
	activeByVault.set(base, active);
	const assertActive = () => {
		if (stopped()) throw new DOMException('Transfer stopped', 'AbortError');
	};
	const stamp = (stat) => [stat.size, stat.mtimeMs, stat.ino].join(':');
	const hash = async (target) => {
		assertActive();
		const handle = await fs.open(target, 'r'),
			digest = cryptoNode.createHash('sha256');
		try {
			const before = await handle.stat();
			if (!before.isFile() || before.size > MAX_NOTE_BYTES) throw Error('File size exceeds bound');
			let offset = 0;
			const buffer = new Uint8Array(SEGMENT_BYTES);
			for (;;) {
				assertActive();
				const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
				if (!bytesRead) break;
				digest.update(buffer.subarray(0, bytesRead));
				offset += bytesRead;
			}
			if (stamp(before) !== stamp(await handle.stat()) || offset !== before.size)
				throw Error('Source changed while hashing');
			return { digest: digest.digest('hex'), length: offset, stamp: stamp(before) };
		} finally {
			await handle.close();
		}
	};
	const transferRoot = async () => {
		const relative = vault.configDir;
		if (
			typeof relative !== 'string' ||
			!relative ||
			path.isAbsolute(relative) ||
			relative.split(/[\\/]/).some((p) => p === '..')
		)
			throw Error('Invalid host config directory');
		const root = inside(base, path.resolve(base, relative, 'plugins', 'smart-sync', 'transfers'));
		await fs.mkdir(root, { recursive: true });
		inside(await fs.realpath(base), await fs.realpath(root));
		return root;
	};
	const reserve = async (bytes) => {
		const root = await transferRoot();
		if (typeof fs.statfs === 'function') {
			const space = await fs.statfs(root).catch((error) => {
				if (['ENOSYS', 'ENOTSUP'].includes(error.code)) return null;
				throw error;
			});
			if (space && Number(space.bavail) * Number(space.bsize) < bytes + 16 * 1024 * 1024)
				throw Object.assign(Error('Temporary disk budget unavailable'), { code: 'TEMP_SPACE' });
		}
		return root;
	};
	async function prepare() {
		if (Date.now() - (lastPruned.get(base) ?? 0) < 60000) return;
		const root = await transferRoot();
		lastPruned.set(base, Date.now());
		for (const entry of await fs.readdir(root, { withFileTypes: true })) {
			if (!/^[a-f0-9-]{36}(?:\.part)?$/.test(entry.name) || entry.isSymbolicLink()) continue;
			const target = inside(root, path.join(root, entry.name));
			if (active.has(target)) continue;
			if (Date.now() - (await fs.stat(target)).mtimeMs < 60 * 60 * 1000) continue;
			if (
				entry.isDirectory() &&
				!(await fs.readdir(target)).every((name) => /^[a-f0-9]{64}$/.test(name))
			)
				continue;
			await fs.rm(target, { recursive: entry.isDirectory(), force: true });
		}
	}
	async function source(name) {
		let target;
		try {
			target = await filePath(name);
		} catch (error) {
			if (error.code === 'ENOENT') return null;
			throw error;
		}
		const stat = await fs.stat(target);
		if (stat.size <= DESKTOP_THRESHOLD) return undefined;
		const info = await hash(target);
		let folder;
		const source = {
			streamed: true,
			...info,
			createDigest: () => {
				const state = cryptoNode.createHash('sha256');
				return { update: (bytes) => state.update(bytes), finish: () => state.digest('hex') };
			},
			chunk: async (offset, length) => {
				assertActive();
				if (length > SEGMENT_BYTES) throw Error('Unbounded source chunk');
				const handle = await fs.open(await filePath(name), 'r');
				try {
					if (stamp(await handle.stat()) !== info.stamp) throw Error('Source changed');
					const buffer = new Uint8Array(length);
					let at = 0;
					while (at < length) {
						const read = await handle.read(buffer, at, length - at, offset + at);
						if (!read.bytesRead) throw Error('Truncated source');
						at += read.bytesRead;
					}
					return buffer;
				} finally {
					await handle.close();
				}
			},
			verify: async () => {
				const now = await hash(await filePath(name));
				if (now.digest !== info.digest || now.stamp !== info.stamp) throw Error('Source changed');
			},
			spool: async (object) => {
				assertActive();
				if (!folder) {
					folder = path.join(await reserve(info.length), cryptoNode.randomUUID());
					await fs.mkdir(folder);
					active.add(folder);
				}
				const target = path.join(folder, object.address);
				await fs.writeFile(target, object.body, { flag: 'wx' });
				return {
					address: object.address,
					bytes: object.body.length,
					load: async () => {
						assertActive();
						return new Uint8Array(await fs.readFile(target));
					},
				};
			},
			dispose: async () => {
				if (folder) {
					const root = await transferRoot();
					inside(root, folder);
					active.delete(folder);
					await fs.rm(folder, { recursive: true, force: true });
					folder = undefined;
				}
			},
			target,
		};
		return source;
	}
	async function sink(name, expectedBytes, expectedDigest, mtime) {
		if (mtime !== undefined && (!Number.isSafeInteger(mtime) || mtime < 0 || mtime > 8640000000000000)) throw Error('Invalid file modification time');
		assertActive();
		const root = await reserve(expectedBytes),
			temporary = path.join(root, cryptoNode.randomUUID() + '.part');
		const target = inside(base, path.resolve(base, safePath(name)));
		await fs.mkdir(path.dirname(target), { recursive: true });
		inside(await fs.realpath(base), await fs.realpath(path.dirname(target)));
		const initial = await fs.stat(target).then(stamp, (error) => {
			if (error.code === 'ENOENT') return null;
			throw error;
		});
		const handle = await fs.open(temporary, 'wx'),
			digest = cryptoNode.createHash('sha256');
		let length = 0,
			closed = false;
		active.add(temporary);
		const abort = async () => {
			if (!closed) {
				closed = true;
				await handle.close();
			}
			active.delete(temporary);
			await fs.rm(inside(root, temporary), { force: true });
		};
		return {
			write: async (bytes) => {
				assertActive();
				if (bytes.length > SEGMENT_BYTES || length + bytes.length > expectedBytes)
					throw Error('Transfer length bound');
				let at = 0;
				while (at < bytes.length) {
					const { bytesWritten } = await handle.write(bytes, at, bytes.length - at, length + at);
					if (!bytesWritten) throw Error('Short disk write');
					at += bytesWritten;
				}
				digest.update(bytes);
				length += bytes.length;
			},
			commit: async () => {
				assertActive();
				if (length !== expectedBytes || digest.digest('hex') !== expectedDigest)
					throw Error('Transfer integrity mismatch');
				const current = await fs.stat(target).then(stamp, (error) => {
					if (error.code === 'ENOENT') return null;
					throw error;
				});
				if (current !== initial) throw Error('Local target changed during download');
				inside(await fs.realpath(base), await fs.realpath(path.dirname(target)));
				if (mtime !== undefined) await handle.utimes(new Date(), new Date(mtime));
				await handle.sync();
				await handle.close();
				closed = true;
				await fs.rename(temporary, target);
				active.delete(temporary);
			},
			abort,
		};
	}
	async function copy(name, from, mtime) {
		const output = await sink(name, from.length, from.digest, mtime);
		try {
			for (let offset = 0; offset < from.length; offset += SEGMENT_BYTES)
				await output.write(await from.chunk(offset, Math.min(SEGMENT_BYTES, from.length - offset)));
			await output.commit();
		} catch (error) {
			await output.abort();
			throw error;
		}
	}
	const sameEntry = async (from, to) => {
		assertActive();
		// Limit aliases to spelling changes; unrelated hard links are distinct destinations.
		if (safePath(from).toLowerCase() !== safePath(to).toLowerCase()) return false;
		try {
			const [a, b] = await Promise.all([filePath(from), filePath(to)]);
			const [left, right] = await Promise.all([fs.lstat(a, { bigint: true }), fs.lstat(b, { bigint: true })]);
			return !left.isSymbolicLink() && !right.isSymbolicLink() && left.ino !== 0n && left.dev === right.dev && left.ino === right.ino;
		} catch (error) {
			if (error.code === 'ENOENT') return false;
			throw error;
		}
	};
	const canonicalPath = async name => {
		const input = safePath(name);
		const actual = path.relative(await fs.realpath(base), await fs.realpath(await filePath(input))).split(path.sep).join('/');
		// Correct casing only; never redirect a logical path through an internal link.
		return actual.toLowerCase() === input.toLowerCase() ? safePath(actual) : input;
	};
	return { source, sink, copy, active, prepare, sameEntry, canonicalPath };
}

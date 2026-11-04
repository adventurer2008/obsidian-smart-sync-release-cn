import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, readdir, stat, rename, unlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ReceiveCache } from '../src/resume.js';
import { packNote, freshSalt, unlockWorkspace, fingerprint } from '../src/codec.js';
import { NotebookSynchronizer, emptyState } from '../src/synchronizer.js';
import { LanPeers, localNoteProvider, receivePeerNote } from '../src/peers.js';

globalThis.window ??= globalThis;
const workspace = '12345678-1234-1234-1234-123456789012';
const keys = await unlockWorkspace('synthetic-resume-passphrase', freshSalt());
const originalTime = 1700000000123;
export async function diskAdapter(t) {
 const root = await mkdtemp(join(tmpdir(), 'ss2-resume-')); t.after(() => rm(root, { recursive: true, force: true }));
 const path = name => join(root, name);
 const adapter = {
  exists: async name => { try { await stat(path(name)); return true; } catch { return false; } },
  mkdir: name => mkdir(path(name), { recursive: true }),
  list: async name => { const entries = await readdir(path(name), { withFileTypes: true }); return { files: entries.filter(e => e.isFile()).map(e => `${name}/${e.name}`), folders: [] }; },
  stat: async name => { try { const s = await stat(path(name)); return { size: s.size, mtime: s.mtimeMs }; } catch { return null; } },
  read: name => readFile(path(name), 'utf8'), write: (name, text) => writeFile(path(name), text),
  readBinary: async name => { const bytes = await readFile(path(name)); return Uint8Array.from(bytes).buffer; },
  writeBinary: (name, bytes) => writeFile(path(name), new Uint8Array(bytes)), rename: (from, to) => rename(path(from), path(to)), remove: name => unlink(path(name)),
 };
 return { adapter, root };
}
function receiving(packed, cache, { files = new Map(), state = emptyState(), failAfter = Infinity, direction = 'receive', checkpointBytes } = {}) {
 const objects = new Map(packed.objects.map(object => [object.address, object.body])), delivered = [], times = new Map(); let bodyReads = 0, localReads = 0, stamp = 0, durable = structuredClone(state);
 const api = { workspace, resumeCache: cache, feed: async after => ({ entries: after >= 1 ? [] : [{ sequence: 1, note: packed.id, manifest: packed.manifest, removed: false }], more: false }),
  load: async address => { if (address !== packed.manifest && ++bodyReads > failAfter) throw Error('synthetic disconnect'); delivered.push(address); return objects.get(address); } };
 const host = { list: async () => [...files.keys()], stamp: async name => files.has(name) ? `stamp-${stamp}` : undefined,
  read: async name => { localReads++; return files.get(name) ?? null; },
  write: async (name, bytes, mtime) => { files.set(name, bytes); times.set(name, mtime); stamp++; return { stamp: `stamp-${stamp}` }; }, remove: async name => files.delete(name) };
 const engine = new NotebookSynchronizer({ api, keys, host, state, direction, save: async value => { durable = structuredClone(value); }, checkpointSize: 100, checkpointInterval: 5000, ...(checkpointBytes === undefined ? {} : { checkpointBytes }) });
 return { engine, host, api, files, times, delivered, durable: () => durable, localReads: () => localReads };
}

test('cloud attachment resumes after repeated process replacement using only missing verified ciphertext; body and original time survive', async t => {
 const { adapter } = await diskAdapter(t), contents = new Uint8Array(randomBytes(9 * 1024 * 1024));
 const packed = await packNote(keys, workspace, 'attachment.bin', contents, undefined, undefined, 'file', originalTime);
 const first = receiving(packed, new ReceiveCache(adapter, 'metadata/resume'), { failAfter: 2 });
 await assert.rejects(first.engine.run(), /synthetic disconnect/); assert.equal(first.files.size, 0);
 const second = receiving(packed, new ReceiveCache(adapter, 'metadata/resume'), { failAfter: 2 });
 await assert.rejects(second.engine.run(), /synthetic disconnect/); assert.equal(second.files.size, 0);
 const third = receiving(packed, new ReceiveCache(adapter, 'metadata/resume'));
 await third.engine.run();
 const firstBodies = first.delivered.filter(address => address !== packed.manifest);
 const secondBodies = second.delivered.filter(address => address !== packed.manifest);
 const thirdBodies = third.delivered.filter(address => address !== packed.manifest);
 assert.equal(secondBodies.some(address => firstBodies.includes(address)), false);
 assert.equal(thirdBodies.some(address => [...firstBodies, ...secondBodies].includes(address)), false);
 assert.equal(new Set([...firstBodies, ...secondBodies, ...thirdBodies]).size, packed.info.segments.length);
 assert.deepEqual(third.files.get('attachment.bin'), contents); assert.equal(third.times.get('attachment.bin'), originalTime);
});

test('completed receive seeds the validated local index before the send scan and byte checkpoint; restart performs no body read', async t => {
 const { adapter } = await diskAdapter(t), contents = new Uint8Array(randomBytes(5 * 1024 * 1024));
 const packed = await packNote(keys, workspace, 'attachment.bin', contents, undefined, undefined, 'file', originalTime);
 const f = receiving(packed, new ReceiveCache(adapter, 'metadata/resume'), { direction: 'both' });
 await f.engine.run(); assert.equal(f.localReads(), 1); // Only the pre-receive missing-file check.
 assert.equal(f.durable().localIndex['attachment.bin'].digest, packed.info.digest);
 const next = receiving(packed, new ReceiveCache(adapter, 'metadata/resume'), { direction: 'both', files: f.files, state: f.durable() });
 next.host.stamp = f.host.stamp;
 await next.engine.run(); assert.equal(next.localReads(), 0); assert.equal(next.delivered.length, 0);
});

test('byte checkpoint commits a completed attachment before the next file fails; a changed local stamp cannot reuse its old digest', async t => {
 const { adapter } = await diskAdapter(t), contents = new Uint8Array(randomBytes(5 * 1024 * 1024));
 const packed = await packNote(keys, workspace, 'attachment.bin', contents, undefined, undefined, 'file', originalTime);
 const next = await packNote(keys, workspace, 'next.bin', new Uint8Array([1, 2]), undefined, undefined, 'file', originalTime);
 const f = receiving(packed, new ReceiveCache(adapter, 'metadata/resume'), { direction: 'both' });
 const entry = { sequence: 2, note: next.id, manifest: next.manifest, removed: false };
 f.api.feed = async after => ({ entries: [{ sequence: 1, note: packed.id, manifest: packed.manifest, removed: false }, entry].filter(e => e.sequence > after), more: false });
 const load = f.api.load;
 f.api.load = address => address === next.manifest ? Promise.reject(Error('synthetic next file failure')) : load(address);
 await assert.rejects(f.engine.run(), /next file failure/);
 assert.equal(f.durable().cursor, 2); assert.equal(f.durable().pendingReceives[next.id].sequence, 2); assert.equal(f.durable().notes[packed.id].downloaded, true);
 assert.equal(f.durable().localIndex['attachment.bin'].digest, packed.info.digest);
 // A different local stamp causes a real body read, even with a valid saved digest.
 const restart = receiving(packed, new ReceiveCache(adapter, 'metadata/resume'), { files: f.files, state: f.durable(), direction: 'both' });
 const restartLoad = restart.api.load, nextObjects = new Map(next.objects.map(object => [object.address, object.body]));
 restart.api.load = address => nextObjects.get(address) ?? restartLoad(address);
 restart.host.stamp = async () => 'changed-after-restart';
 await restart.engine.run(); assert.equal(restart.localReads(), 3); // Existing attachment plus the retried file before receive and send.
 assert.deepEqual(restart.files.get('next.bin'), new Uint8Array([1, 2]));
});

test('storage-full and unsupported adapters retain verified cloud behavior without a false durable-cache claim', async t => {
 const { adapter } = await diskAdapter(t), bytes = new Uint8Array(randomBytes(512)), address = await fingerprint(bytes);
 const cache = new ReceiveCache({ ...adapter, writeBinary: async () => { throw Error('synthetic disk full'); } }, 'metadata/full');
 assert.deepEqual(await cache.loader(async () => bytes, [address])(address), bytes);
 assert.equal(cache.metrics.savedBytes, 0); assert.equal(cache.metrics.storageFailures, 1);
 assert.equal(await new ReceiveCache({}, 'metadata/unsupported').get(address), null);
});

test('a cached local digest cannot suppress a concurrent edit discovered when reading conflict content', async t => {
 const { adapter } = await diskAdapter(t), old = new Uint8Array([1]), changed = new Uint8Array([2, 3]), incoming = new Uint8Array([4, 5, 6]);
 const packed = await packNote(keys, workspace, 'attachment.bin', incoming, undefined, undefined, 'file', originalTime);
 const state = emptyState(); state.notes[packed.id] = { path: 'attachment.bin', revision: 0, downloaded: true, digest: await fingerprint(old), manifest: 'a'.repeat(64) };
 state.localIndex = { 'attachment.bin': { stamp: 'stamp-0', digest: await fingerprint(old), size: 1 } };
 const f = receiving(packed, new ReceiveCache(adapter, 'metadata/resume'), { files: new Map([['attachment.bin', old]]), state });
 const read = f.host.read; let injected = false;
 f.host.read = name => { if (name === 'attachment.bin' && !injected) { injected = true; f.files.set(name, changed); } return read(name); };
 await f.engine.run();
 assert.deepEqual(f.files.get('attachment.bin'), incoming);
 const conflict = [...f.files.keys()].find(name => name.includes('.conflict-')); assert.ok(conflict);
 assert.deepEqual(f.files.get(conflict), changed); assert.equal(f.times.get('attachment.bin'), originalTime);
});

test('corrupt objects, partial temporary writes, different scopes, bounded storage and cancellation cannot supply unverified data', async t => {
 const { adapter } = await diskAdapter(t), bytes = new Uint8Array(randomBytes(512)), address = await fingerprint(bytes);
 const cache = new ReceiveCache(adapter, 'metadata/a', { maximum: 700 }); assert.equal(await cache.put(address, bytes), true);
 await adapter.writeBinary(`metadata/a/${address}.bin`, new Uint8Array(512).buffer);
 assert.equal(await cache.get(address), null); assert.equal(cache.metrics.corruptObjects, 1);
 const other = new ReceiveCache(adapter, 'metadata/b'); assert.equal(await other.get(address), null);
 assert.equal(await cache.put(address, bytes), true);
 const another = new Uint8Array(randomBytes(512)), anotherAddress = await fingerprint(another);
 assert.equal(await cache.put(anotherAddress, another), true); assert.ok(cache.bytes <= 700); assert.equal(await cache.get(address), null);
 await adapter.writeBinary(`metadata/a/00000000-0000-4000-8000-000000000000.tmp`, bytes.buffer);
 const reloaded = new ReceiveCache(adapter, 'metadata/a'); await reloaded.init();
 assert.equal(await adapter.exists('metadata/a/00000000-0000-4000-8000-000000000000.tmp'), true); // A different live writer may own this temporary file.
 assert.equal(reloaded.files.has('00000000-0000-4000-8000-000000000000.tmp'), false);
 assert.equal(await cache.put(address, new Uint8Array(512)), false);
 let active = true; const stopped = new ReceiveCache(adapter, 'metadata/a', { active: () => active }); active = false;
 await assert.rejects(stopped.get(anotherAddress), { name: 'AbortError' });
 await assert.rejects(cache.loader(async () => bytes, [address])('f'.repeat(64)), /outside authenticated manifest/);
});

test('LAN attachment retains its authenticated encrypted bundle across both endpoints restarting; cached receiver chunks are not requested again', async t => {
 const { adapter } = await diskAdapter(t), contents = new Uint8Array(randomBytes(9 * 1024 * 1024));
 const packed = await packNote(keys, workspace, 'attachment.bin', contents, undefined, undefined, 'file', originalTime);
 const state = { notes: { [packed.id]: { path: 'attachment.bin', downloaded: true, digest: packed.info.digest, manifest: packed.manifest } } };
 let sourceReads = 0;
 const host = { stamp: async () => 'stable-source', mtime: async () => originalTime, read: async () => { sourceReads++; return contents; } };
 function endpoints(fail = false) {
  const a = new LanPeers({ workspace }), b = new LanPeers({ workspace }), requests = [], manifests = [], errors = [];
  a.mode = b.mode = 'both';
  const left = { id: 'b', notes: true, pc: { close() {} }, channel: { readyState: 'open', bufferedAmount: 0, close() { this.readyState = 'closed'; } } };
  const right = { id: 'a', notes: true, pc: { close() {} }, channel: { readyState: 'open', bufferedAmount: 0, close() { this.readyState = 'closed'; } } };
  left.channel.send = raw => { const frame = JSON.parse(raw); if (frame.type === 'note') manifests.push(frame.address); queueMicrotask(() => b.message(right, raw).catch(error => errors.push(error))); };
  right.channel.send = raw => { const frame = JSON.parse(raw); if (frame.type === 'get') requests.push(frame.address); queueMicrotask(() => a.message(left, raw).catch(error => errors.push(error))); };
  a.links.set('b', left); b.links.set('a', right);
  a.provideNote = localNoteProvider({ keys, workspace, state, host, cache: new ReceiveCache(adapter, 'metadata/source') });
  b.resumeCache = new ReceiveCache(adapter, 'metadata/receiver');
  const load = b.loadFrom.bind(b); let count = 0;
  if (fail) b.loadFrom = (...args) => ++count > 3 ? Promise.resolve(null) : load(...args);
  return { a, b, requests, manifests, errors, close() { a.close(); b.close(); } };
 }
 const first = endpoints(true);
 assert.equal(await receivePeerNote(first.b, keys, workspace, packed.id, packed.manifest, packed.info), null);
 first.close(); assert.deepEqual(first.errors, []);
 const second = endpoints();
 const received = await receivePeerNote(second.b, keys, workspace, packed.id, packed.manifest, packed.info);
 second.close(); assert.deepEqual(second.errors, []);
 assert.deepEqual(received.contents, contents); assert.equal(sourceReads, 1);
 assert.equal(first.manifests[0], second.manifests[0]);
 assert.equal(second.requests.some(address => first.requests.includes(address)), false);
 assert.ok(second.b.resumeCache.metrics.reusedBytes > 2 * 1024 * 1024);
});

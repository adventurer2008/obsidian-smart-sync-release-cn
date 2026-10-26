import assert from 'node:assert/strict';
import { test } from 'node:test';
import { packNote, freshSalt, unlockWorkspace } from '../src/codec.js';
import { NotebookSynchronizer, emptyState } from '../src/synchronizer.js';
import { ConnectionCheckpoints } from '../src/checkpoint.js';
const keys = await unlockWorkspace('synthetic receive isolation', freshSalt());
const workspace = 'synthetic-isolation', mtime = 1700000000123;
const bytes = value => new TextEncoder().encode(value);
async function fixture() {
 const objects = new Map(), entries = [], files = new Map(), times = new Map(), events = [];
 let durable = emptyState(), writes = [], failed = 'bad.pdf', failSave = false, fatal;
 async function add(path, content, id) {
  const packed = await packNote(keys, workspace, path, bytes(content), undefined, id, 'file', mtime);
  packed.objects.forEach(object => objects.set(object.address, object.body));
  entries.push({ sequence: entries.length + 1, note: packed.id, manifest: packed.manifest, removed: false });
  return packed;
 }
 const bad = await add('bad.pdf', 'bad'), good = await add('good.md', 'good'), last = await add('last.bin', 'last');
 const api = { workspace, feed: async after => ({ entries: entries.filter(e => e.sequence > after), more: false }),
  load: async address => { if (fatal) throw fatal; return objects.get(address); } };
 const host = { list: async () => [...files.keys()], read: async path => files.get(path) ?? null,
  write: async (path, body, time) => { if (path === failed) throw Error('synthetic unreadable file'); files.set(path, body); times.set(path, time); writes.push(path); },
  remove: async path => files.delete(path) };
 const engine = (state, direction = 'receive') => new NotebookSynchronizer({ api, keys, host, state: state ?? structuredClone(durable), direction,
  checkpointSize: 100, checkpointInterval: 60000,
  save: async state => { if (failSave) throw Error('synthetic checkpoint failure'); durable = structuredClone(state); },
  onTask: async event => events.push(event) });
 return { bad, good, last, api, host, entries, files, times, events, add, engine, durable: () => durable,
  fail: path => { failed = path; }, failSave: () => { failSave = true; }, fatal: error => { fatal = error; }, writes: () => writes };
}
test('failed receive does not block later files; durable retry survives restart and keeps original mtime', async () => {
 const f = await fixture();
 await assert.rejects(f.engine().run(), error => error.pendingReceiveCount === 1);
 assert.equal(f.durable().cursor, 3);
 assert.equal(f.durable().pendingReceives[f.bad.id].sequence, 1);
 for (const [path, content] of [['good.md', 'good'], ['last.bin', 'last']]) {
  assert.deepEqual(f.files.get(path), bytes(content)); assert.equal(f.times.get(path), mtime);
 }
 assert.ok(f.events.some(e => e.note === f.good.id && e.status === 'done'));
 assert.equal(f.events.some(e => e.note === f.good.id && e.status === 'failed'), false);
 // Exercise real checkpoint serialization, not just an in-memory clone.
 const checkpoints = new ConnectionCheckpoints({}, 'synthetic', () => {});
 const restored = checkpoints.decode(checkpoints.encode({ scope: f.durable() })).scope;
 f.fail(undefined); await f.engine(restored).run();
 assert.equal(Object.keys(f.durable().pendingReceives).length, 0);
 assert.deepEqual(f.files.get('bad.pdf'), bytes('bad')); assert.equal(f.times.get('bad.pdf'), mtime);
 assert.deepEqual(f.writes().sort(), ['bad.pdf', 'good.md', 'last.bin']);
});
test('newer revision supersedes failed receive after cursor has advanced', async () => {
 const f = await fixture(); await assert.rejects(f.engine().run());
 await f.add('bad.pdf', 'new revision', f.bad.id);
 f.fail(undefined); await f.engine().run();
 assert.deepEqual(f.files.get('bad.pdf'), bytes('new revision'));
 assert.equal(f.durable().notes[f.bad.id].revision, 4); assert.equal(f.durable().cursor, 4);
 assert.equal(Object.keys(f.durable().pendingReceives).length, 0);
});
test('remote tombstone replaces a failed receive without recreating the missing file', async () => {
 const f = await fixture(); await assert.rejects(f.engine().run());
 f.entries.push({ ...f.entries[0], sequence: 4, removed: true });
 await f.engine().run(); assert.equal(f.files.has('bad.pdf'), false);
 assert.equal(Object.keys(f.durable().pendingReceives).length, 0);
});
test('checkpoint failure and global authorization or cancellation stop the cycle', async () => {
 const f = await fixture(); f.failSave(); await assert.rejects(f.engine().run(), /checkpoint failure/);
 assert.equal(f.durable().cursor, 0); assert.equal(f.files.size, 0);
 for (const error of [Object.assign(Error('denied'), { status: 401 }), Object.assign(Error('denied'), { status: 403 }),
  new DOMException('stopped', 'AbortError'), Object.assign(Error('key'), { code: 'WRONG_NOTEBOOK_KEY' })]) {
  const g = await fixture(); g.fatal(error); await assert.rejects(g.engine().run(), caught => caught === error);
  assert.equal(g.files.size, 0); assert.equal(g.durable().cursor, 0);
 }
});
test('multiple unreadable files are queued while remaining files complete', async () => {
 const f = await fixture(), write = f.host.write;
 f.host.write = async (...args) => { if (args[0] === 'last.bin') throw Error('second unreadable file'); return write(...args); };
 await assert.rejects(f.engine().run(), error => error.pendingReceiveCount === 2);
 assert.equal(f.durable().cursor, 3); assert.deepEqual(f.files.get('good.md'), bytes('good'));
 assert.equal(Object.keys(f.durable().pendingReceives).length, 2);
});

test('existing file read failure is isolated from priority content updates and cannot publish a deletion', async () => {
 const f = await fixture(); f.fail(undefined); await f.engine().run();
 await f.add('bad.pdf', 'remote update', f.bad.id); await f.add('good.md', 'good update', f.good.id);
 const read = f.host.read;
 f.host.read = async path => { if (path === 'bad.pdf') throw Error('synthetic unreadable local PDF'); return read(path); };
 f.files.delete('bad.pdf');
 const commits = [];
 f.api.commit = async (note, value) => { commits.push(note); return { note, ...value, sequence: 6 }; };
 await assert.rejects(f.engine(undefined, 'both').run(), error => error.pendingReceiveCount === 1);
 assert.deepEqual(f.files.get('good.md'), bytes('good update')); assert.equal(f.times.get('good.md'), mtime);
 assert.equal(commits.includes(f.bad.id), false); assert.equal(f.durable().cursor, 5);
});

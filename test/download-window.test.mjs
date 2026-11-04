import assert from 'node:assert/strict';
import { test } from 'node:test';
import { packNote, unpackToSink, freshSalt, unlockWorkspace, inspectNote, SEGMENT_BYTES } from '../src/codec.js';
import { NotebookSynchronizer, emptyState } from '../src/synchronizer.js';

const keys = await unlockWorkspace('synthetic bounded attachment downloads', freshSalt());
const workspace = 'download-window', mtime = 1577836800123;
const bytes = new Uint8Array(SEGMENT_BYTES * 8 + 31);
for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
const packet = await packNote(keys, workspace, 'attachments/large.pdf', bytes, undefined, undefined, 'file', mtime);
const objects = new Map(packet.objects.map(object => [object.address, object.body]));

test('explicit attachment download overlaps at most four requests, preserves bytes/mtime and counts concurrent progress', async () => {
 let active = 0, peak = 0, written, time;
 const events = [], state = emptyState();
 state.notes[packet.id] = { path: packet.info.path, manifest: packet.manifest, revision: 1, downloaded: false };
 const api = { workspace, load: async (address, progress) => {
  const body = objects.get(address); active++; peak = Math.max(peak, active);
  try {
   progress?.({ loaded: Math.floor(body.length / 2), total: body.length });
   await new Promise(resolve => setTimeout(resolve, 5));
   progress?.({ loaded: body.length, total: body.length });
   return body;
  } finally { active--; }
 } };
 const host = { read: async () => null, list: async () => [], write: async (_path, body, sourceTime) => { written = body; time = sourceTime; } };
 const engine = new NotebookSynchronizer({ api, keys, host, state, direction: 'receive', save: async () => {}, onTask: async event => events.push(event) });
 await engine.download(packet.id);
 assert.equal(peak, 4); assert.equal(active, 0);
 assert.deepEqual(written, bytes); assert.equal(time, mtime); assert.equal(state.notes[packet.id].downloaded, true);
 const progress = events.filter(event => event.status === 'progress').map(event => event.bytes);
 assert.ok(progress.every((value, index) => index === 0 || value >= progress[index - 1]));
 assert.equal(progress.at(-1), packet.objects.reduce((sum, object) => sum + object.body.length, 0));
});

test('corrupt parallel segment drains in-flight reads before aborting the sink without partial commit', async () => {
 const info = await inspectNote(keys, workspace, packet.id, packet.manifest, async address => objects.get(address));
 let release, reads = 0, aborted = false, settled = false, active = 0;
 const gate = new Promise(resolve => { release = resolve; });
 const work = unpackToSink(keys, workspace, packet.id, packet.manifest, async address => {
  const ordinal = reads++; active++;
  try { if (ordinal) await gate; const body = objects.get(address).slice(); if (!ordinal) body[0] ^= 1; return body; }
  finally { active--; }
 }, async () => ({ write: async () => assert.fail('corrupt content written'), commit: async () => assert.fail('partial commit'), abort: async () => { assert.equal(active, 0); aborted = true; } }), info, undefined, { concurrency: 4 }).finally(() => { settled = true; });
 const rejected = assert.rejects(work, /digest mismatch/);
 await new Promise(resolve => setTimeout(resolve, 20));
 assert.equal(reads, 4); assert.equal(settled, false); assert.equal(aborted, false);
 release(); await rejected; assert.equal(aborted, true);
});

test('Stop during parallel sink delivery prevents more writes or commit and drains bounded requests', async () => {
 const info = await inspectNote(keys, workspace, packet.id, packet.manifest, async address => objects.get(address));
 const controller = new AbortController(); let reads = 0, writes = 0, aborted = false, active = 0;
 await assert.rejects(unpackToSink(keys, workspace, packet.id, packet.manifest, async address => {
  reads++; active++;
  try { await new Promise(resolve => setTimeout(resolve, 5)); return objects.get(address); }
  finally { active--; }
 }, async () => ({ write: async () => { writes++; controller.abort(new DOMException('synthetic Stop', 'AbortError')); }, commit: async () => assert.fail('commit after Stop'), abort: async () => { assert.equal(active, 0); aborted = true; } }), info, undefined, { concurrency: 4, signal: controller.signal }), { name: 'AbortError' });
 assert.equal(writes, 1); assert.ok(reads <= 5); assert.equal(aborted, true); assert.equal(active, 0);
});

test('Stop on the final sink write also prevents commit for a one-segment attachment', async () => {
 const small = await packNote(keys, workspace, 'small.pdf', new Uint8Array([1, 2, 3]));
 const store = new Map(small.objects.map(object => [object.address, object.body]));
 const controller = new AbortController(); let aborted = false;
 await assert.rejects(unpackToSink(keys, workspace, small.id, small.manifest, async address => store.get(address), async () => ({
  write: async () => controller.abort(new DOMException('Stop at final write', 'AbortError')),
  commit: async () => assert.fail('commit after final-write Stop'), abort: async () => { aborted = true; }
 }), undefined, undefined, { concurrency: 4, signal: controller.signal }), { name: 'AbortError' });
 assert.equal(aborted, true);
});

test('already stopped downloads do not fetch a manifest or create output storage', async () => {
 const controller = new AbortController(); controller.abort(new DOMException('Already stopped', 'AbortError'));
 await assert.rejects(unpackToSink(keys, workspace, packet.id, packet.manifest,
  async () => assert.fail('manifest fetched after Stop'), async () => assert.fail('output created after Stop'),
  undefined, undefined, { concurrency: 4, signal: controller.signal }), { name: 'AbortError' });
});

test('four-request streaming download preserves ordered bytes and original mtime at commit', async () => {
 const state = emptyState(); let committed = false;
 state.notes[packet.id] = { path: packet.info.path, manifest: packet.manifest, revision: 1, downloaded: false };
 const engine = new NotebookSynchronizer({ keys, state, direction: 'receive', save: async () => {},
  api: { workspace, load: async address => {
   const ordinal = packet.info.segments.findIndex(piece => piece.address === address);
   await new Promise(resolve => setTimeout(resolve, ordinal % 3 === 0 ? 8 : 1));
   return objects.get(address);
  } },
  host: { read: async () => null, list: async () => [], sink: async (path, length, _digest, time) => {
   assert.equal(path, packet.info.path); assert.equal(length, bytes.length); assert.equal(time, mtime);
   let offset = 0;
   return { write: async part => { assert.deepEqual(part, bytes.subarray(offset, offset + part.length)); offset += part.length; },
    commit: async () => { assert.equal(offset, bytes.length); committed = true; }, abort: async () => assert.fail('successful stream aborted') };
  } }
 });
 await engine.download(packet.id); assert.equal(committed, true); assert.equal(state.notes[packet.id].downloaded, true);
});

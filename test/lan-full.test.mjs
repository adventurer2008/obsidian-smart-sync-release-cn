import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, stat, utimes, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { LanPeers, bindLanTransfers, localNoteProvider, receivePeerNote } from '../src/peers.js';
import { freshSalt, unlockWorkspace, packNote, fingerprint } from '../src/codec.js';
import { NotebookSynchronizer, emptyState } from '../src/synchronizer.js';
import { desktopFiles } from '../src/desktop.js';

globalThis.window ??= globalThis;
const workspace = '12345678-1234-1234-1234-123456789012';
const mtime = 1700000000123;
const keys = await unlockWorkspace('synthetic-lan-passphrase', freshSalt());
const tick = () => new Promise(resolve => setImmediate(resolve));

function pair(t) {
    const a = new LanPeers({ workspace }), b = new LanPeers({ workspace }), frames = [], errors = [];
    a.mode = b.mode = 'both';
    const left = { id: 'b', notes: true, pc: { close() {} }, channel: { readyState: 'open', bufferedAmount: 0, close() { this.readyState = 'closed'; } } };
    const right = { id: 'a', notes: true, pc: { close() {} }, channel: { readyState: 'open', bufferedAmount: 0, close() { this.readyState = 'closed'; } } };
    left.channel.send = raw => { frames.push(raw); queueMicrotask(() => b.message(right, raw).catch(error => { errors.push(error); b.remove('a'); })); };
    right.channel.send = raw => { frames.push(raw); queueMicrotask(() => a.message(left, raw).catch(error => { errors.push(error); a.remove('b'); })); };
    a.links.set('b', left); b.links.set('a', right);
    t.after(() => { a.close(); b.close(); assert.deepEqual(errors, []); });
    return { a, b, left, right, frames };
}

async function setup(t, { batch = true, size = 96000, disk = false, unknownTime = false } = {}) {
    const p = pair(t), bytes = new Uint8Array(randomBytes(size)), path = 'private-synthetic/attachment.bin';
    const packed = await packNote(keys, workspace, path, bytes, undefined, undefined, 'file', unknownTime ? undefined : mtime);
    const objects = new Map(packed.objects.map(object => [object.address, object.body]));
    const state = emptyState(); state.notes[packed.id] = { path, kind: 'file', revision: 1, digest: packed.digest, downloaded: true, removed: false, manifest: packed.manifest };
    let stamp = 'unchanged', fileMtime = mtime, allowed = true, reads = 0, ports;
    if (disk) {
        const root = await mkdtemp(join(tmpdir(), 'ss2-lan-source-'));
        t.after(() => rm(root, { recursive: true, force: true }));
        await mkdir(join(root, 'private-synthetic'));
        await writeFile(join(root, path), bytes); await utimes(join(root, path), mtime / 1000, mtime / 1000);
        ports = desktopFiles({ adapter: { getBasePath: () => root }, configDir: '.obsidian' }, { load: createRequire(import.meta.url) });
        await ports.prepare();
        fileMtime = Math.trunc((await stat(join(root, path))).mtimeMs);
    }
    const sourceHost = { read: async () => { reads++; return disk ? await ports.source(path) : bytes; }, mtime: async () => fileMtime, stamp: async () => stamp };
    p.a.provideNote = localNoteProvider({ keys, workspace, state, host: sourceHost, accepts: () => allowed });
    const cloudReads = [];
    const api = { workspace, load: async address => { cloudReads.push(address); return objects.get(address); },
        store: async () => {}, storeBatch: async () => {},
        loadBatch: async (addresses, limit) => { const result = new Map(); let used = 0; for (const address of addresses) { const body = objects.get(address); if (used + body.length <= limit) { result.set(address, body); used += body.length; cloudReads.push(address); } } return result; },
        feed: async after => ({ entries: after ? [] : [{ sequence: 1, note: packed.id, manifest: packed.manifest, removed: false }], more: false }) };
    p.b.api = api; bindLanTransfers(api, p.b);
    api.peerContents = (...args) => receivePeerNote(p.b, keys, workspace, ...args);
    const files = new Map(), times = new Map(); let chunks = 0;
    const host = { list: async () => [...files.keys()], read: async name => files.get(name) ?? null,
        write: async (name, body, time) => { files.set(name, body); times.set(name, time); }, remove: async name => files.delete(name) };
    if (disk) host.sink = async (name, length, digest, time) => {
        const hash = createHash('sha256'); let total = 0;
        return { write: async part => { assert.ok(part.length <= 1024 * 1024); chunks++; total += part.length; hash.update(part); },
            commit: async () => { assert.equal(total, length); assert.equal(hash.digest('hex'), digest); files.set(name, { streamed: true, length }); times.set(name, time); }, abort: async () => {} };
    };
    const engine = new NotebookSynchronizer({ api, keys, state: emptyState(), host, save: async () => {}, direction: 'receive', attachmentLimit: 256 * 1024 * 1024, batchTransfer: batch });
    return { ...p, api, engine, packed, state, bytes, path, files, times, cloudReads, ports,
        reads: () => reads, chunks: () => chunks, deny: () => { allowed = false; }, changeStamp: () => { stamp = 'changed'; }, changeTime: () => { fileMtime++; } };
}

test('local scan progress starts at zero and completes with an eligible total after receiving', async t => {
    const f = await setup(t), progress = [];
    f.files.set('ignored/private.bin', new Uint8Array([1]));
    f.engine.ignored = ['ignored'];
    f.engine.direction = 'both';
    f.engine.onProgress = (_, scan) => { if (scan) progress.push(scan); };
    await f.engine.run();
    assert.deepEqual(progress, [{ checked: 0, total: 1 }, { checked: 1, total: 1 }]);
    assert.deepEqual(f.files.get(f.path), f.bytes);
    assert.equal(f.times.get(f.path), mtime);
});

test('repeated cache misses briefly bypass raw peer probes and resume probing after the backoff', async t => {
    const p = pair(t), bytes = new Uint8Array(randomBytes(512)), address = await fingerprint(bytes);
    for (let i = 0; i < 3; i++) assert.equal(await p.b.load(address), null);
    const count = p.frames.length;
    assert.equal(await p.b.load(address), null); assert.equal(p.frames.length, count);
    p.b.links.get('a').cachePauseUntil = 0; p.a.remember(address, bytes);
    assert.deepEqual(await p.b.load(address), bytes); assert.equal(p.b.links.get('a').cacheMisses, 0);
});

test('cold local libraries supply authenticated content to ordinary and batch receive without cloud body downloads', async t => {
    for (const batch of [false, true]) {
        const f = await setup(t, { batch });
        assert.equal(f.a.cache.size, 0);
        await f.engine.run(); await tick();
        assert.deepEqual(f.files.get(f.path), f.bytes); assert.equal(f.times.get(f.path), mtime);
        assert.ok(f.cloudReads.length > 0); assert.ok(f.cloudReads.every(address => address === f.packed.manifest));
        assert.ok(f.b.snapshot().receivedBytes > f.bytes.length); assert.ok(f.a.snapshot().sentBytes > 0);
        assert.equal(f.a.bundles.size, 0); assert.equal(f.b.pending.size, 0);
        assert.equal(f.engine.state.notes[f.packed.id].manifest, f.packed.manifest);
        assert.ok(f.frames.every(raw => !raw.includes(f.path)));
    }
});

test('legacy cloud revisions without original mtime never acquire a peer timestamp through a sink', async t => {
    const f = await setup(t, { unknownTime: true }); let receivedTime = 'not-called', total = 0;
    const result = await receivePeerNote(f.b, keys, workspace, f.packed.id, f.packed.manifest, f.packed.info,
        async (path, length, digest, time) => { receivedTime = time; return { write: async bytes => { total += bytes.length; }, commit: async () => assert.equal(total, length), abort: async () => {} }; });
    assert.equal(result.streamed, true); assert.equal(receivedTime, undefined);
});

test('large attachments use a real streamed disk source and bounded receiver chunks, retaining source time', async t => {
    const f = await setup(t, { size: 9 * 1024 * 1024 + 31, disk: true });
    await f.engine.run(); await tick();
    assert.equal(f.files.get(f.path).length, f.bytes.length); assert.ok(f.chunks() > 8);
    assert.equal(f.times.get(f.path), mtime);
    assert.ok(f.cloudReads.every(address => address === f.packed.manifest));
    assert.equal(f.a.bundles.size, 0); assert.equal(f.b.pending.size, 0);
});

test('excluded, unsynchronized and stale revisions cannot expose local file content', async t => {
    for (const mutation of [f => f.deny(), f => f.state.notes[f.packed.id].downloaded = false,
        f => f.state.notes[f.packed.id].manifest = 'f'.repeat(64), f => f.state.notes[f.packed.id].removed = true]) {
        const f = await setup(t); mutation(f);
        await f.engine.run();
        assert.equal(f.reads(), 0); assert.deepEqual(f.files.get(f.path), f.bytes);
        assert.ok(f.cloudReads.some(address => address !== f.packed.manifest));
    }
});

test('a peer with different original time falls back to verified cloud content and cannot rewrite mtime', async t => {
    const f = await setup(t); f.changeTime();
    await f.engine.run(); await tick();
    assert.deepEqual(f.files.get(f.path), f.bytes); assert.equal(f.times.get(f.path), mtime);
    assert.ok(f.b.metrics.failures > 0); assert.ok(f.b.metrics.fallbacks > 0);
    assert.equal(f.a.bundles.size, 0);
});

test('batch routing combines peer hits with bounded cloud misses and remembers successful batch uploads', async t => {
    const p = pair(t), one = new Uint8Array(randomBytes(1024)), two = new Uint8Array(randomBytes(2048));
    const a = await fingerprint(one), b = await fingerprint(two); p.a.remember(a, one);
    let missing, uploaded = 0;
    const api = { load: async () => two, store: async () => {}, storeBatch: async () => { uploaded++; },
        loadBatch: async addresses => { missing = addresses; return new Map([[b, two]]); } };
    bindLanTransfers(api, p.b); bindLanTransfers(api, p.b);
    const result = await api.loadBatch([a, b], 4096);
    assert.deepEqual(missing, [b]); assert.deepEqual(result.get(a), one); assert.deepEqual(result.get(b), two);
    assert.equal(p.b.metrics.receivedBytes, one.length); assert.equal(p.b.metrics.cloudBytes, two.length);
    await api.storeBatch([{ address: a, body: one }]); assert.equal(uploaded, 1); assert.deepEqual(p.b.cache.get(a), one);
});

test('old or disabled peers keep cloud batch behavior and receive no new note requests', async t => {
    for (const disabled of [false, true]) {
        const f = await setup(t); f.right.notes = false; if (disabled) f.b.enabled = false;
        await f.engine.run(); assert.deepEqual(f.files.get(f.path), f.bytes);
        assert.ok(f.frames.every(raw => JSON.parse(raw).type !== 'get-note'));
    }
});

test('batch peer hits survive sender backpressure without spilling the second object to cloud', async t => {
    const p = pair(t), bytes = new Uint8Array(randomBytes(96000)), other = new Uint8Array(randomBytes(96000));
    const first = await fingerprint(bytes), second = await fingerprint(other);
    p.a.remember(first, bytes); p.a.remember(second, other);
    p.left.channel.bufferedAmount = 131073;
    const drain = setTimeout(() => { p.left.channel.bufferedAmount = 0; }, 30); t.after(() => clearTimeout(drain));
    const api = { load: async () => assert.fail('no cloud body read'), store: async () => {}, loadBatch: async () => assert.fail('both objects are local') };
    bindLanTransfers(api, p.b);
    const result = await api.loadBatch([first, second], 256 * 1024);
    assert.deepEqual(result.get(first), bytes); assert.deepEqual(result.get(second), other);
});

test('concurrent mobile object requests wait through brief sender backpressure instead of using cloud', async t => {
    const p = pair(t), bodies = Array.from({ length: 4 }, () => new Uint8Array(randomBytes(96000)));
    const addresses = await Promise.all(bodies.map(fingerprint));
    addresses.forEach((address, i) => p.a.remember(address, bodies[i]));
    p.left.channel.bufferedAmount = 131073;
    const drain = setTimeout(() => { p.left.channel.bufferedAmount = 0; }, 40);
    t.after(() => clearTimeout(drain));
    const api = { load: async () => assert.fail('all four objects are available on LAN'), store: async () => {} };
    bindLanTransfers(api, p.b);
    const received = await Promise.all(addresses.map(address => api.load(address)));
    assert.deepEqual(received, bodies);
    assert.equal(p.b.metrics.fallbacks, 0); assert.equal(p.b.metrics.cloudBytes, 0);
    assert.equal(p.b.pending.size, 0); assert.equal(p.left.serveWaiters, 0);
    // A verified LAN receipt can be reused even after the source goes away.
    const frames = p.frames.length; p.b.remove('a');
    assert.deepEqual(await api.load(addresses[0]), bodies[0]);
    assert.equal(p.frames.length, frames); assert.equal(p.b.metrics.cloudBytes, 0);
});

test('a phone and iPad sharing one source wait briefly and keep both authenticated LAN sessions', async t => {
    const f = await setup(t), provider = f.a.provideNote;
    const ipad = new LanPeers({ workspace }), errors = [];
    ipad.mode = 'both';
    const link = id => ({ id, notes: true, pc: { close() {} }, channel: {
        readyState: 'open', bufferedAmount: 0, close() { this.readyState = 'closed'; }
    } });
    const sourceLink = link('ipad'), ipadLink = link('source');
    sourceLink.channel.send = raw => queueMicrotask(() => ipad.message(ipadLink, raw).catch(error => errors.push(error)));
    ipadLink.channel.send = raw => queueMicrotask(() => f.a.message(sourceLink, raw).catch(error => errors.push(error)));
    f.a.links.set('ipad', sourceLink); ipad.links.set('source', ipadLink);
    t.after(() => { ipad.close(); assert.deepEqual(errors, []); });
    let calls = 0;
    f.a.provideNote = async (...args) => {
        calls++; await new Promise(resolve => setTimeout(resolve, 35)); return provider(...args);
    };
    const results = await Promise.all([f.b, ipad].map(receiver => receivePeerNote(receiver, keys, workspace,
        f.packed.id, f.packed.manifest, f.packed.info)));
    for (const result of results) {
        assert.ok(result); assert.equal(result.path, f.path); assert.deepEqual(result.contents, f.bytes);
    }
    assert.equal(calls, 2);
    assert.equal(f.b.metrics.fallbacks, 0); assert.equal(f.b.metrics.failures, 0);
    assert.equal(ipad.metrics.fallbacks, 0); assert.equal(ipad.metrics.failures, 0);
    await tick(); assert.equal(f.a.bundles.size, 0);
});

test('persistent sender contention still falls back to cloud with bounded waiting', async t => {
    const p = pair(t), bytes = new Uint8Array(randomBytes(1024)), address = await fingerprint(bytes);
    p.a.remember(address, bytes); p.left.sending = true;
    let cloud = 0;
    const api = { load: async () => { cloud++; return bytes; }, store: async () => {} };
    bindLanTransfers(api, p.b);
    const started = Date.now();
    assert.deepEqual(await api.load(address), bytes);
    assert.ok(Date.now() - started < 2000); assert.equal(cloud, 1);
    assert.equal(p.b.metrics.fallbacks, 1); assert.equal(p.left.serveWaiters, 0);
});

test('stopping or restricting a sender while preparation is queued prevents late content reads', async t => {
    for (const stop of [f => { f.a.enabled = false; }, f => { f.a.canServe = () => false; }, f => { f.a.close(); }]) {
        const f = pair(t); let reads = 0;
        f.a.preparing = true;
        f.a.provideNote = async () => { reads++; assert.fail('queued preparation must not start'); };
        const pending = f.b.noteSession('a'.repeat(64), 'b'.repeat(64));
        await tick(); stop(f); f.a.preparing = false;
        // Close the remote end as a real channel closure would do.
        if (f.a.closed) f.b.remove('a');
        assert.equal(await pending, null); assert.equal(reads, 0);
        await new Promise(resolve => setTimeout(resolve, 25));
        assert.equal(f.left.serveWaiters, 0); assert.equal(f.a.bundles.size, 0);
    }
});

test('receiver cancellation releases queued preparation before the sender reads local content', async t => {
    const f = pair(t), controller = new AbortController(); let reads = 0;
    f.b.api = { signal: controller.signal }; f.a.preparing = true;
    f.a.provideNote = async () => { reads++; assert.fail('cancelled request must not prepare content'); };
    const pending = f.b.noteSession('a'.repeat(64), 'b'.repeat(64)); await tick();
    assert.equal(f.a.queuedNotes.size, 1); controller.abort();
    assert.equal(await pending, null); await tick(); f.a.preparing = false;
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(reads, 0); assert.equal(f.a.queuedNotes.size, 0); assert.equal(f.a.bundles.size, 0);
});

test('disabling during note preparation cancels the lease and disposes late encrypted packages', async t => {
    const f = pair(t); let resolve, disposed = 0;
    f.a.provideNote = () => new Promise(done => { resolve = done; });
    const pending = f.b.noteSession('a'.repeat(64), 'b'.repeat(64)); await tick();
    f.b.enabled = false; f.b.drop();
    assert.equal(await pending, null);
    resolve({ manifest: 'c'.repeat(64), objects: [], dispose: async () => { disposed++; } });
    f.a.remove('b'); await tick();
    assert.equal(f.a.bundles.size, 0); assert.equal(disposed, 1);
});

test('ciphertext corruption and another workspace key never bypass the cloud-confirmed digest', async t => {
    for (const corrupt of [true, false]) {
        const f = await setup(t);
        if (corrupt) {
            const original = f.left.channel.send;
            f.left.channel.send = raw => { const frame = JSON.parse(raw); if (frame.type === 'part') { frame.data = frame.data.replace(/^./, frame.data[0] === 'A' ? 'B' : 'A'); raw = JSON.stringify(frame); } original(raw); };
        } else {
            const otherKeys = await unlockWorkspace('different-synthetic-workspace', freshSalt());
            f.api.peerContents = (...args) => receivePeerNote(f.b, otherKeys, workspace, ...args);
        }
        await f.engine.run(); await tick();
        assert.deepEqual(f.files.get(f.path), f.bytes); assert.equal(f.times.get(f.path), mtime);
        assert.ok(f.b.metrics.failures > 0); assert.equal(f.a.bundles.size, 0);
    }
});

test('changed local bytes, source mutation and missing files do not publish an encrypted peer lease', async t => {
    const bytes = new Uint8Array(randomBytes(4096)), packed = await packNote(keys, workspace, 'synthetic.md', bytes, undefined, undefined, 'file', mtime);
    for (const kind of ['dirty', 'changed', 'missing']) {
        const f = pair(t); let stamp = 'before';
        const state = { notes: { [packed.id]: { path: 'synthetic.md', digest: packed.digest, downloaded: true, manifest: packed.manifest } } };
        const provider = localNoteProvider({ keys, workspace, state, host: {
            stamp: async () => stamp, mtime: async () => mtime,
            read: async () => { if (kind === 'changed') stamp = 'after'; return kind === 'missing' ? null : kind === 'dirty' ? new Uint8Array(4096) : bytes; }
        } });
        assert.equal(await provider(packed.id, packed.manifest), null);
        assert.equal(f.a.bundles.size, 0);
    }
});

test('cancelled receive cannot start cloud fallback after cancellation', async t => {
    const f = pair(t), controller = new AbortController();
    f.b.api = { signal: controller.signal };
    f.a.provideNote = () => new Promise(() => {});
    const work = f.b.noteSession('a'.repeat(64), 'b'.repeat(64)); await tick(); controller.abort();
    assert.equal(await work, null); assert.equal(f.b.pending.size, 0);
    f.a.remove('b');
});

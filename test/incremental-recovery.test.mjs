import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NotebookSynchronizer, IncrementalInventory, emptyState, recordRename } from '../src/synchronizer.js';
import { freshSalt, unlockWorkspace, fingerprint, packNote } from '../src/codec.js';

const keys = await unlockWorkspace('synthetic incremental and commit recovery', freshSalt());
const workspace = '12345678-1234-1234-1234-123456789012';
const encode = text => new TextEncoder().encode(text);
const originalTime = 1700000000123;
function fixture() {
 const objects = new Map(), revisions = [], files = new Map(), times = new Map(), stamps = new Map();
 let durable = emptyState(), fault, lost = false, saves = 0, uploads = 0, lists = 0, reads = 0, writes = 0;
 const append = input => {
  const previous = revisions.findLast(row => row.note === input.note);
  if ((previous?.sequence ?? 0) !== input.expected) throw Object.assign(Error('CAS'), {status: 409});
  const row = {note: input.note, manifest: input.manifest ?? previous.manifest, removed: input.removed, sequence: revisions.length + 1};
  revisions.push(row); return row;
 };
 const api = {workspace, origin: 'https://synthetic.invalid',
  store: async ({address,body}) => {uploads++; objects.set(address, body);},
  storeBatch: async values => {for (const item of values) {uploads++; objects.set(item.address,item.body);}},
  load: async address => {assert.ok(objects.has(address), 'object must exist'); return objects.get(address);},
  feed: async after => ({entries: revisions.filter(row => row.sequence > after), more: false}),
  versions: async (note,before=Number.MAX_SAFE_INTEGER) => ({entries: revisions.filter(row => row.note === note && row.sequence < before).reverse(), more: false}),
  commit: async (note,input) => {if(fault==='before-request') {fault=undefined;throw Error('disconnected before submit');} const row=append({...input,note}); if(lost) {lost=false;throw Error('response lost');} return row;},
  commitBatch: async inputs => {const entries=inputs.map(append);if(lost) {lost=false;throw Error('response lost');}return {entries};}
 };
 const inventory = new IncrementalInventory();
 const host = {
  list: async () => {lists++; return [...files.keys()];}, listFolders: async () => [],
  exists: async path => files.has(path), stamp: async path => files.has(path) ? String(stamps.get(path) ?? 1) : undefined,
  mtime: async path => times.get(path), read: async path => {reads++;return files.get(path) ?? null;},
  write: async (path,body,mtime) => {writes++;files.set(path,body);times.set(path,mtime);stamps.set(path,(stamps.get(path) ?? 0)+1);},
  remove: async path => {files.delete(path);times.delete(path);}
 };
 const save = async state => {
  saves++;
  if(fault==='prepare-save' && state.pendingCommit?.phase==='prepared') {fault=undefined;throw Error('prepare storage failure');}
  if(fault==='ack-save' && state.pendingCommit?.phase==='acknowledged') {fault=undefined;throw Error('ack storage failure');}
  if(fault==='apply-save' && !state.pendingCommit && Object.keys(state.notes).length) {fault=undefined;throw Error('apply storage failure');}
  durable=structuredClone(state);
 };
 const engine = (options={}) => new NotebookSynchronizer({api,keys,host,state:structuredClone(durable),save,...options});
 return {api,host,files,times,objects,revisions,inventory,engine,
  set(path,text,mtime=originalTime,event='modify') {files.set(path,typeof text==='string'?encode(text):text);times.set(path,mtime);stamps.set(path,(stamps.get(path)??0)+1);inventory.changed(event,path);},
  fail(value) {fault=value;}, lose() {lost=true;}, durable:()=>structuredClone(durable),
  counts:()=>({saves,uploads,lists,reads,writes})};
}

for (const batch of [false,true]) test(`lost ${batch?'batch':'ordinary'} commit response recovers in send-only mode without duplicate upload; receiver preserves original times`, async () => {
 const f=fixture(); f.set('first.md','first private body'); if(batch)f.set('second.bin',new Uint8Array(300000).fill(91));
 const options={direction:'send',batchTransfer:batch,checkpointSize:100,checkpointInterval:5000};
 f.lose(); await assert.rejects(f.engine(options).run(),/response lost/);
 const before=f.counts(); assert.equal(f.durable().pendingCommit.phase,'prepared');
 assert.ok(!JSON.stringify(f.durable().pendingCommit).includes('first private body'));
 const feed=f.api.feed; f.api.feed=async()=>assert.fail('send-only recovery must not read the feed');
 await f.engine(options).run(); f.api.feed=feed;
 assert.equal(f.counts().uploads,before.uploads); assert.equal(f.revisions.length,batch?2:1);
 assert.equal(f.durable().pendingCommit,undefined);
 const received=new Map(), receivedTimes=new Map();
 const receiver=new NotebookSynchronizer({api:f.api,keys,state:emptyState(),direction:'receive',save:async()=>{},host:{
  read:async path=>received.get(path)??null,
  write:async(path,bytes,mtime)=>{received.set(path,bytes);receivedTimes.set(path,mtime);},remove:async path=>received.delete(path)}});
 await receiver.run();
 for(const [path,bytes] of f.files) {assert.deepEqual(received.get(path),bytes);assert.equal(receivedTimes.get(path),originalTime);}
});

for(const failure of ['prepare-save','before-request','ack-save','apply-save']) test(`commit restart safely reconciles ${failure} without changing local body or mtime`, async () => {
 const f=fixture();f.set('note.md','unchanged source');f.fail(failure);
 await assert.rejects(f.engine({direction:'send'}).run(),/failure|before submit/);
 if(failure==='prepare-save')assert.equal(f.revisions.length,0);
 const writes=f.counts().writes;
 await f.engine({direction:'send'}).run();
 assert.equal(f.revisions.length,1);assert.equal(f.counts().writes,writes);
 assert.equal(f.times.get('note.md'),originalTime);assert.equal(f.durable().pendingCommit,undefined);
});

test('a newer local edit after a lost receipt remains local and is published with its own source time', async () => {
 const f=fixture();f.set('note.md','old edit');f.lose();await assert.rejects(f.engine({direction:'send'}).run());
 f.set('note.md','new edit',originalTime+5000);
 await f.engine({direction:'send'}).run();assert.equal(f.revisions.length,2);
 assert.equal(new TextDecoder().decode(f.files.get('note.md')),'new edit');assert.equal(f.times.get('note.md'),originalTime+5000);
});

for(const batch of [false,true]) test(`lost ${batch?'batch':'single'} deletion response is reconciled without deleting a recreated local file`, async () => {
 const f=fixture(),options={direction:'send',batchDeletes:batch};f.set('note.md','original');await f.engine(options).run();
 f.files.delete('note.md');f.lose();await assert.rejects(f.engine(options).run(),/response lost/);
 assert.equal(f.durable().pendingCommit.entries[0].removed,true);
 f.set('note.md','recreated',originalTime+7000,'create');
 await f.engine(options).run();
 assert.equal(f.revisions.filter(row=>row.removed).length,1);assert.equal(f.times.get('note.md'),originalTime+7000);
 assert.equal(new TextDecoder().decode(f.files.get('note.md')),'recreated');
});

test('concurrent remote and local edits after uncertain publication preserve both versions', async () => {
 const f=fixture();f.set('note.md','own edit');f.lose();await assert.rejects(f.engine({direction:'send'}).run());
 const first=f.revisions[0],remote=await packNote(keys,workspace,'note.md',encode('remote edit'),undefined,first.note,'file',originalTime+1000);
 for(const object of remote.objects)await f.api.store(object);
 await f.api.commit(first.note,{expected:first.sequence,manifest:remote.manifest,removed:false});
 f.set('note.md','new local edit',originalTime+2000);
 await f.engine({direction:'both'}).run();
 const bodies=[...f.files.values()].map(bytes=>new TextDecoder().decode(bytes));
 assert.ok(bodies.includes('new local edit'));assert.ok(bodies.includes('remote edit'));
 assert.ok(f.durable().conflicts.length>0);
});

test('malformed or cross-workspace journals fail closed, and unavailable history keeps uncertain intent', async () => {
 const f=fixture();f.set('note.md','source');f.lose();await assert.rejects(f.engine({direction:'send'}).run());
 const state=f.durable();state.pendingCommit.workspace='other';
 assert.throws(()=>new NotebookSynchronizer({api:f.api,keys,host:f.host,state,save:async()=>{}}),/Invalid pending/);
 f.api.versions=async()=>{throw Error('history offline');};
 await assert.rejects(f.engine({direction:'send'}).run(),/history offline/);
 assert.equal(f.durable().pendingCommit.phase,'prepared');
});

test('incremental inventory skips host enumeration for known modifications and still forces structural, policy and timed audits', async () => {
 const f=fixture();f.set('a.md','alpha');f.set('b.md','bravo');
 let now=100;
 const inventory=new IncrementalInventory({now:()=>now}),engine=f.engine({direction:'send',incrementalInventory:inventory,scanPolicy:'policy'});
 await engine.run();const initial=f.counts();
 f.set('a.md','edited',originalTime+1000);inventory.changed('modify','a.md');
 await engine.run();assert.equal(f.counts().lists,initial.lists);assert.equal(f.times.get('a.md'),originalTime+1000);
 const quiet=f.counts();await engine.run();assert.deepEqual(f.counts(),quiet);
 inventory.changed('create','new.md');await engine.run();assert.equal(f.counts().lists,initial.lists+1);
 engine.scanPolicy='changed exclusions';await engine.run();assert.equal(f.counts().lists,initial.lists+2);
 now+=60001;await engine.run();assert.equal(f.counts().lists,initial.lists+3);
 const restart=f.engine({direction:'send',incrementalInventory:new IncrementalInventory(),scanPolicy:'changed exclusions'});
 await restart.run();assert.equal(f.counts().lists,initial.lists+4);
});

test('10,000 known files inspect only the changed path; arrivals during a scan survive acknowledgement', async () => {
 const f=fixture(),state=emptyState(),digest=await fingerprint(encode('same'));
 for(let n=0;n<10000;n++)state.notes[n.toString(16).padStart(64,'0')]={path:`note-${n}.md`,kind:'file',revision:n+1,digest,downloaded:true,removed:false,manifest:'a'.repeat(64)};
 const inventory=new IncrementalInventory();inventory.finish(inventory.begin(state,'policy'));
 inventory.changed('modify','note-42.md');f.set('note-42.md','same');
 f.host.list=async()=>assert.fail('incremental pass must not enumerate the vault');
 const engine=new NotebookSynchronizer({api:f.api,keys,host:f.host,state,save:async()=>{},direction:'send',incrementalInventory:inventory,scanPolicy:'policy'});
 await engine.run();assert.equal(f.counts().reads,1);
 inventory.changed('modify','first');const plan=inventory.begin(state,'policy');inventory.changed('modify','later');inventory.finish(plan);
 assert.deepEqual(inventory.begin(state,'policy').paths,['later']);
 inventory.changed('rename','folder');assert.equal(inventory.begin(state,'policy').full,true);
});


function journalStore() {
 let durable, writes=0;
 return {current:()=>structuredClone(durable),write:async value=>{writes++;durable=structuredClone(value);},clear:async()=>{durable=undefined;},writes:()=>writes};
}

test('lightweight journals retain checkpoint batching and recover all uncheckpointed receipts after a restart', async () => {
 const f=fixture(),journal=journalStore();
 for(let n=0;n<80;n++)f.set(`n${n}.md`,`body ${n}`);
 const engine=f.engine({direction:'send',commitJournal:journal,checkpointSize:25,checkpointInterval:1000000});
 await engine.run();assert.ok(f.counts().saves<15);assert.equal(journal.current(),undefined);assert.equal(f.revisions.length,80);
 const latest=f.engine({direction:'send',commitJournal:journal,checkpointSize:25,checkpointInterval:1000000});
 f.set('n0.md','next');f.set('n1.md','another');f.set('n2.md','third');
 const commit=f.api.commit;let calls=0;
 f.api.commit=async(...args)=>{calls++;if(calls===3)f.lose();return commit(...args);};
 await assert.rejects(latest.run(),/response lost/);
 const pending=journal.current();assert.ok(pending.entries.some(item=>item.receipt));assert.equal(pending.phase,'prepared');
 const uploads=f.counts().uploads;
 await f.engine({direction:'send',commitJournal:journal}).run();
 assert.equal(f.counts().uploads,uploads);assert.equal(f.revisions.length,83);assert.equal(journal.current(),undefined);
});

test('failed journal persistence prevents publication and failed clear preserves replayable acknowledgement', async () => {
 const f=fixture(),journal=journalStore();f.set('note.md','journal failure');
 const write=journal.write;journal.write=async()=>{throw Error('journal offline');};
 await assert.rejects(f.engine({direction:'send',commitJournal:journal}).run(),/journal offline/);assert.equal(f.revisions.length,0);
 journal.write=write;const clear=journal.clear;journal.clear=async()=>{throw Error('clear offline');};
 await assert.rejects(f.engine({direction:'send',commitJournal:journal}).run(),/clear offline/);assert.equal(f.revisions.length,1);
 journal.clear=clear;await f.engine({direction:'send',commitJournal:journal}).run();assert.equal(f.revisions.length,1);assert.equal(journal.current(),undefined);
});


test('event-guided scans retain rename identity and deletion semantics without changing the source time', async () => {
 const f=fixture(),renames={},engine=f.engine({direction:'send',incrementalInventory:f.inventory,scanPolicy:'same',renames});
 f.set('before.md','original');await engine.run();const note=f.revisions[0].note;
 f.set('after.md',f.files.get('before.md'),originalTime,'rename');f.files.delete('before.md');
 recordRename(renames,'before.md','after.md',['before.md']);await engine.run();
 assert.equal(f.revisions.at(-1).note,note);assert.equal(engine.state.notes[note].path,'after.md');assert.equal(f.times.get('after.md'),originalTime);
 f.files.delete('after.md');f.inventory.changed('delete','after.md');await engine.run();
 assert.equal(f.revisions.at(-1).note,note);assert.equal(f.revisions.at(-1).removed,true);
});

test('an incomplete dirty inventory fails safely and forces a full inventory before any deletion', async () => {
 const f=fixture(),engine=f.engine({direction:'send',incrementalInventory:f.inventory,scanPolicy:'same'});
 f.set('note.md','original');await engine.run();const revisions=f.revisions.length;
 f.files.delete('note.md');f.inventory.changed('modify','note.md');
 await assert.rejects(engine.run(),error=>error.code==='PLAN_CHANGED');assert.equal(f.revisions.length,revisions);
 assert.equal(f.inventory.begin(engine.state,'same').full,true);
 await engine.run();assert.equal(f.revisions.at(-1).removed,true);
});

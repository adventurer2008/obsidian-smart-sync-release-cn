import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConnectionCheckpoints } from '../src/checkpoint.js';

function fixture(){
 const files=new Map();let durable,fail,bytes=0;
 const adapter={async exists(){return true},async mkdir(){},async write(path,text){if(fail==='write')throw Error('write fault');files.set(path,text);bytes+=text.length},async rename(from,to){if(fail==='rename')throw Error('rename fault');files.set(to,files.get(from));files.delete(from)},async read(path){if(!files.has(path))throw Error('missing');return files.get(path)},async remove(path){files.delete(path)}};
 const commit=async data=>{if(fail==='commit')throw Error('commit fault');durable=structuredClone(data)};
 const store=()=>new ConnectionCheckpoints(adapter,'metadata',commit);
 return{files,adapter,store,durable:()=>durable,fail(value){fail=value},bytes:()=>bytes};
}
function data(){return{format:3,settings:{direction:'paused'},connections:{w:{format:3,cursor:0,notes:{a:{path:'a.md',digest:'old',base:'x'.repeat(10000)}},localIndex:{'a.md':'stamp'},conflicts:[]}}};}

test('unchanged primitive records reuse serialization while in-place edits, removed keys and nested mutations remain durable', async () => {
 const f=fixture(),store=f.store(),value=data();
 value.connections.w.notes.nested={path:'nested.md',origin:{device:'before'}};
 await store.save(value);
 const key=JSON.stringify(['w','notes','a']),captured=store.recordEncodings.get(key);
 value.connections.w.cursor=1;await store.save(value);
 assert.equal(store.recordEncodings.get(key),captured);
 value.connections.w.notes.a.digest='changed';delete value.connections.w.notes.a.base;
 value.connections.w.notes.nested.origin.device='after';
 await store.save(value);assert.notEqual(store.recordEncodings.get(key),captured);
 assert.deepEqual(await f.store().load(f.durable()),value);
 delete value.connections.w.notes.a;await store.save(value);
 assert.equal(store.recordEncodings.has(key),false);
 assert.deepEqual(await f.store().load(f.durable()),value);
});

test('applied state and commit-journal retirement publish through one descriptor with no separate clear write', async () => {
 const f=fixture(),store=f.store(),value=data(),journal={phase:'acknowledged',entries:[{note:'synthetic',receipt:{sequence:2}}]};
 value.commitJournals={w:journal};await store.save(value);
 let commits=0;const commit=store.commit;store.commit=async saved=>{commits++;await commit(saved)};
 value.connections.w.cursor=2;
 await store.saveAndRetireCommit(value,'w',journal);
 assert.equal(commits,1);
 const loaded=await f.store().load(f.durable());
 assert.equal(loaded.connections.w.cursor,2);assert.equal(loaded.commitJournals.w,undefined);assert.equal(value.commitJournals.w,undefined);
});

for(const fault of ['write','rename','commit'])test(`atomic journal retirement ${fault} failure retains old durable intent and restores live retry`,async()=>{
 const f=fixture(),store=f.store(),value=data(),journal={phase:'acknowledged',entries:[{note:'synthetic',receipt:{sequence:2}}]};
 value.commitJournals={w:journal};await store.save(value);const old=structuredClone(f.durable());
 value.connections.w.cursor=2;f.fail(fault);
 await assert.rejects(store.saveAndRetireCommit(value,'w',journal),/fault/);
 assert.equal(value.commitJournals.w,journal);assert.deepEqual(f.durable(),old);
 const loaded=await f.store().load(old);assert.equal(loaded.connections.w.cursor,0);assert.deepEqual(loaded.commitJournals.w,journal);
 f.fail();await store.saveAndRetireCommit(value,'w',journal);
 assert.equal((await f.store().load(f.durable())).connections.w.cursor,2);assert.equal(f.durable().commitJournals.w,undefined);
});

test('metadata-only saves reuse the last committed connection snapshot and serialize behind queued saves',async()=>{
 const f=fixture(),store=f.store(),value=data();await store.save(value);const bytes=f.bytes();
 value.connections.w.cursor=1;value.settings.direction='both';await store.saveConfiguration(value);
 assert.equal(f.bytes(),bytes);assert.equal((await f.store().load(f.durable())).connections.w.cursor,0);assert.equal(f.durable().settings.direction,'both');
 const pending=store.save(value);value.connections.w.cursor=2;const metadata=store.saveConfiguration(value);await pending;await metadata;
 assert.equal((await f.store().load(f.durable())).connections.w.cursor,1);
 value.settings.direction='receive';f.fail('commit');await assert.rejects(store.saveConfiguration(value),/fault/);f.fail();await store.save(value);assert.deepEqual(await f.store().load(f.durable()),value);
});

test('checkpoints persist deltas, deletions and prototype-like paths, restoring only committed state',async()=>{
 const f=fixture(),store=f.store(),value=data();await store.save(value);const initial=f.bytes();
 value.connections.w.cursor=1;value.connections.w.notes.b={path:'b.md',digest:'new'};delete value.connections.w.localIndex['a.md'];
 Object.defineProperty(value.connections.w.localIndex,'__proto__',{value:'safe',enumerable:true,configurable:true});
 await store.save(value);assert.ok(f.bytes()-initial<1000);assert.equal(f.durable().format,4);assert.equal(f.durable().connections,undefined);
 const restored=await f.store().load(f.durable());assert.deepEqual(restored,value);assert.equal({}.safe,undefined);
 delete value.connections.w;await store.save(value);assert.deepEqual((await f.store().load(f.durable())).connections,{});
});
for(const fault of ['write','rename','commit'])test('checkpoint '+fault+' failure retains prior durable generation and retry is complete',async()=>{
 const f=fixture(),store=f.store(),value=data();await store.save(value);const before=structuredClone(f.durable());
 value.connections.w.cursor=2;value.connections.w.notes.a.digest='new';f.fail(fault);
 await assert.rejects(store.save(value),/fault/);assert.deepEqual(f.durable(),before);assert.equal((await f.store().load(before)).connections.w.cursor,0);
 f.fail();await store.save(value);assert.deepEqual(await f.store().load(f.durable()),value);
});
test('queued saves capture mutations before yielding, and damaged or escaping descriptors fail closed',async()=>{
 const f=fixture(),store=f.store(),value=data();await store.save(value);
 value.connections.w.cursor=1;const first=store.save(value);value.connections.w.cursor=2;const second=store.save(value);await first;await second;
 assert.equal((await f.store().load(f.durable())).connections.w.cursor,2);
 const descriptor=f.durable().checkpoint,patch=descriptor.patches.at(-1);f.files.set('metadata/'+patch.file,'{}');await assert.rejects(f.store().load(f.durable()),/integrity/);
 const evil=structuredClone(f.durable());evil.checkpoint.base.file='../data.json';await assert.rejects(f.store().load(evil),/descriptor/);
});
test('compaction bounds patch count and keeps a complete recoverable snapshot',async()=>{
 const f=fixture(),store=f.store(),value=data();await store.save(value);const old=f.durable().checkpoint.base.file;
 for(let i=1;i<=65;i++){value.connections.w.cursor=i;await store.save(value);}
 assert.notEqual(f.durable().checkpoint.base.file,old);assert.equal(f.durable().checkpoint.patches.length,0);assert.equal(f.files.has('metadata/'+old),false);
 assert.deepEqual(await f.store().load(f.durable()),value);
});

test('compaction retires only superseded files after commit with at most four removals in flight', async () => {
 const f=fixture(),store=f.store(),value=data();await store.save(value);
 for(let index=1;index<=64;index++){value.connections.w.cursor=index;await store.save(value);}
 const retired=new Set([f.durable().checkpoint.base,...f.durable().checkpoint.patches].map(entry=>'metadata/'+entry.file));
 const remove=f.adapter.remove;let active=0,peak=0,removed=0;
 f.adapter.remove=async path=>{
  assert.ok(retired.has(path));
  assert.ok(![f.durable().checkpoint.base,...f.durable().checkpoint.patches].some(entry=>'metadata/'+entry.file===path));
  active++;peak=Math.max(peak,active);
  try{await new Promise(resolve=>setImmediate(resolve));await remove(path);removed++;}finally{active--;}
 };
 value.connections.w.cursor=65;await store.save(value);
 assert.equal(peak,4);assert.equal(removed,65);assert.equal(active,0);
 assert.deepEqual(await f.store().load(f.durable()),value);
});

test('checkpoint bursts retain one running and one pending full snapshot and recover the latest committed state',async()=>{
 const f=fixture(),store=f.store(),value=data();await store.save(value);
 let release;const wait=new Promise(resolve=>release=resolve);const original=store.write.bind(store);let writes=0;
 store.write=async(...args)=>{writes++;if(writes===1)await wait;return original(...args);};
 value.connections.w.cursor=1;const first=store.save(value);await new Promise(resolve=>setImmediate(resolve));
 const saves=[];for(let i=2;i<502;i++){value.connections.w.cursor=i;saves.push(store.save(value));}
 assert.equal(new Set(saves).size,1);release();await first;await Promise.all(saves);
 assert.equal(writes,2);assert.equal((await f.store().load(f.durable())).connections.w.cursor,501);
});

test('restart continues verified deltas without rewriting the base and still bounds the patch count',async()=>{
 const f=fixture(),value=data();let store=f.store();await store.save(value);const base=f.durable().checkpoint.base.file;
 for(let i=1;i<=64;i++){store=f.store();const restored=await store.load(f.durable());restored.connections.w.cursor=i;await store.save(restored);assert.equal(f.durable().checkpoint.base.file,base);assert.equal(f.durable().checkpoint.patches.length,i);}
 store=f.store();const restored=await store.load(f.durable());restored.connections.w.cursor=65;await store.save(restored);
 assert.notEqual(f.durable().checkpoint.base.file,base);assert.equal(f.durable().checkpoint.patches.length,0);assert.deepEqual(await f.store().load(f.durable()),restored);
});

test('restart counts verified patch bytes and compacts again at the existing byte budget',async()=>{
 const f=fixture(),value=data(),store=f.store();await store.save(value);
 for(let i=0;i<4;i++){value.connections.w.notes.a.base+='x'.repeat(1024*1024);await store.save(value);}
 const base=f.durable().checkpoint.base.file,restarted=f.store(),restored=await restarted.load(f.durable());
 const actual=f.durable().checkpoint.patches.reduce((n,p)=>n+new TextEncoder().encode(f.files.get('metadata/'+p.file)).length,0);
 assert.ok(actual>=8*1024*1024);assert.equal(restarted.deltaBytes,actual);
 restored.connections.w.cursor++;await restarted.save(restored);assert.notEqual(f.durable().checkpoint.base.file,base);assert.equal(f.durable().checkpoint.patches.length,0);
 assert.deepEqual(await f.store().load(f.durable()),restored);
});

test('allocation-light checkpoint traversal excludes inherited records and keeps Unicode deltas and nested mutations',async()=>{
 const f=fixture(),store=f.store(),value=data();
 Object.setPrototypeOf(value.connections.w.notes,{inherited:{path:'not-a-note'}});
 await store.save(value);
 value.connections.w.notes.a.base='中文🙂';value.connections.w.notes.a.revision=2;
 Object.defineProperty(value.connections.w.notes,'__proto__',{value:{path:'safe.md',revision:1},enumerable:true,configurable:true});
 await store.save(value);const restored=await f.store().load(f.durable());
 assert.equal(restored.connections.w.notes.inherited,undefined);assert.equal(restored.connections.w.notes.a.base,'中文🙂');
 assert.equal(restored.connections.w.notes.a.revision,2);assert.equal(Object.hasOwn(restored.connections.w.notes,'__proto__'),true);
 const patch=f.durable().checkpoint.patches.at(-1),bytes=new TextEncoder().encode(f.files.get('metadata/'+patch.file)).length;
 assert.equal(store.deltaBytes,bytes);
});


test('legacy inline archives migrate once without changing history, file times or the active connection',async()=>{
 const f=fixture(),store=f.store(),value=data();
 value.archives=[{at:12,session:'prior',connections:{old:{notes:{a:{path:'旧笔记.md',mtime:1577836800123,base:'正文🙂'.repeat(10000)}},cursor:9}}}];
 const original=structuredClone(value);await store.save(value);
 assert.equal(f.durable().format,5);assert.equal(f.durable().archives,undefined);
 assert.equal(f.durable().archiveCheckpoint.entries.length,1);assert.ok(JSON.stringify(f.durable()).length<1000);
 assert.deepEqual(await f.store().load(f.durable()),original);
 const archived=f.durable().archiveCheckpoint.entries[0],bytes=f.bytes();
 value.tasks=[{status:'done'}];await store.saveConfiguration(value);
 assert.equal(f.bytes(),bytes);assert.deepEqual(f.durable().archiveCheckpoint.entries[0],archived);
 assert.throws(()=>{value.archives[0].connections.old.cursor=10},TypeError);
 const restarted=f.store(),loaded=await restarted.load(f.durable());await restarted.saveConfiguration(loaded);
 assert.equal(f.bytes(),bytes);assert.deepEqual(await f.store().load(f.durable()),loaded);
});

for(const fault of ['write','rename','commit'])test('archive migration '+fault+' failure preserves the previous inline generation and can retry',async()=>{
 const f=fixture(),value=data(),initial=f.store();await initial.save(value);
 const legacy=structuredClone(f.durable());legacy.archives=[{at:1,connections:{old:{notes:{a:{mtime:11,base:'keep'}}}}}];
 await initial.commit(legacy);const store=f.store(),loaded=await store.load(legacy);f.fail(fault);
 await assert.rejects(store.saveConfiguration(loaded),/fault/);assert.deepEqual(f.durable(),legacy);
 assert.deepEqual((await f.store().load(legacy)).archives,legacy.archives);
 f.fail();await store.saveConfiguration(loaded);assert.deepEqual((await f.store().load(f.durable())).archives,legacy.archives);
});

test('archive snapshots respect queued configuration barriers, appends and restarts',async()=>{
 const f=fixture(),store=f.store(),value=data();value.archives=[{at:1,connections:{one:{cursor:1}}}];await store.save(value);
 const old=f.durable().archiveCheckpoint.entries[0];let release;const waiting=new Promise(resolve=>release=resolve),commit=store.commit;
 store.commit=async saved=>{await waiting;await commit(saved)};
 value.tasks=[{status:'first'}];const first=store.saveConfiguration(value);
 value.archives.push({at:2,connections:{two:{cursor:2}}});value.tasks=[{status:'second'}];const second=store.saveConfiguration(value);
 release();await first;await second;assert.equal(f.durable().archiveCheckpoint.entries.length,2);
 assert.deepEqual(f.durable().archiveCheckpoint.entries[0],old);assert.deepEqual(await f.store().load(f.durable()),value);
 const restored=f.store();const loaded=await restored.load(f.durable()),bytes=f.bytes();loaded.settings.direction='both';await restored.saveConfiguration(loaded);assert.equal(f.bytes(),bytes);
});

test('archive corruption, missing files and traversal descriptors fail closed without clearing state',async()=>{
 const f=fixture(),store=f.store(),value=data();value.archives=[{at:1,connections:{}}];await store.save(value);
 const before=structuredClone(f.durable()),entry=before.archiveCheckpoint.entries[0],path='metadata/'+entry.file,original=f.files.get(path);
 f.files.set(path,'{}');await assert.rejects(f.store().load(before),/integrity/);assert.deepEqual(f.durable(),before);
 f.files.delete(path);await assert.rejects(f.store().load(before),/missing/);f.files.set(path,original);
 const evil=structuredClone(before);evil.archiveCheckpoint.entries[0].file='../data.json';await assert.rejects(f.store().load(evil),/descriptor/);
 const ambiguous=structuredClone(before);ambiguous.archives=[];await assert.rejects(f.store().load(ambiguous),/archive/);
 assert.deepEqual(await f.store().load(before),value);
});

test('identical saves skip durable commits while changes and failed commits remain retryable',async()=>{
 const f=fixture(),store=f.store(),value=data(),commit=store.commit;let commits=0;store.commit=async saved=>{commits++;await commit(saved)};
 await store.save(value);await store.save(value);await store.saveConfiguration(value);assert.equal(commits,1);
 value.settings.direction='both';f.fail('commit');await assert.rejects(store.saveConfiguration(value),/fault/);assert.equal(commits,2);
 f.fail();await store.saveConfiguration(value);assert.equal(commits,3);await store.saveConfiguration(value);assert.equal(commits,3);
 value.connections.w.cursor++;await store.save(value);assert.equal(commits,4);assert.deepEqual(await f.store().load(f.durable()),value);
});

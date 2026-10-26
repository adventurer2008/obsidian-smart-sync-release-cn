import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerHooks } from 'node:module';
import { syntheticApp, TFile } from './obsidian-double.mjs';
registerHooks({resolve(specifier,context,next){return specifier==='obsidian'?{url:new URL('./obsidian-double.mjs',import.meta.url).href,shortCircuit:true}:next(specifier,context);}});
globalThis.window = {setInterval,clearInterval,setTimeout,clearTimeout};
const {default:Plugin} = await import('../src/plugin.js');
async function fixture(t, saved) {
 const plugin = new Plugin(syntheticApp(), {id:'wujie-sync',version:'1.0.6'});
 if (saved) plugin.persisted = saved;
 await plugin.onload(); t.after(()=>plugin.dispose());
 plugin.data.settings.workspace = 'synthetic'; plugin.data.settings.autoTimer = true; plugin.data.settings.interval = 0;
 plugin.data.settings.autoChanges = true; plugin.data.settings.direction = 'both';
 let connections = 0;
 plugin.connection = async()=>{connections++;throw Error('synthetic connection probe');};
 return {plugin,connections:()=>connections};
}
test('manual stop survives later timer ticks, change events, automatic retry and restart; explicit sync resumes',async t=>{
 const f = await fixture(t), p = f.plugin;
 await p.stopSynchronization();
 assert.equal(p.data.manualSyncStopped,true); assert.equal(p.persisted.manualSyncStopped,true);
 assert.match(p.status.text,/自动同步已暂停/);
 p.requestChangedSynchronization(); await p.synchronize(undefined,undefined,true);
 await new Promise(resolve=>setTimeout(resolve,650)); assert.equal(f.connections(),0);
 assert.equal(p.automaticChangesAllowed(),false);
 const restored = await fixture(t,structuredClone(p.persisted));
 await restored.plugin.synchronize(undefined,undefined,true); assert.equal(restored.connections(),0);
 restored.plugin.data.settings.autoTimer=false; // Resume assertions use explicit calls after the timer-stop probe.
 await restored.plugin.synchronize(); assert.equal(restored.connections(),1);
 assert.equal(restored.plugin.data.manualSyncStopped,undefined); assert.equal(restored.plugin.persisted.manualSyncStopped,undefined);
 await restored.plugin.synchronize(undefined,undefined,true); assert.equal(restored.connections(),2);
});
test('stopping cancels pending changes and on-open attachment downloads without changing synchronization direction',async t=>{
 const f=await fixture(t),p=f.plugin; p.data.settings.attachmentMiB=0;
 let opened=0;p.exclusive=async()=>{opened++;};
 p.pendingTimer=setTimeout(()=>p.requestChangedSynchronization(),20);
 await p.stopSynchronization(); await p.downloadNoteAttachments(new TFile('note.md'));
 await new Promise(resolve=>setTimeout(resolve,40));
 assert.equal(opened,0);assert.equal(f.connections(),0);assert.equal(p.data.settings.direction,'both');
});
test('failed persistence keeps manual stop active and cannot silently resume background work',async t=>{
 const f=await fixture(t),p=f.plugin; await p.stopSynchronization();
 p.checkpoints={saveConfiguration:async()=>{throw Error('synthetic storage full');}};
 await p.synchronize(); assert.equal(p.data.manualSyncStopped,true);assert.equal(f.connections(),0);
 await p.synchronize(undefined,undefined,true);assert.equal(f.connections(),0);
 p.checkpoints=undefined;
});

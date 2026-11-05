import assert from 'node:assert/strict';
import {test} from 'node:test';
import {registerHooks} from 'node:module';
globalThis.__SMART_SYNC_EDITION__={edition:'global',id:'smart-sync-global',locale:'en',serviceOrigin:'https://sync.smartsync.cc',stagingOrigin:'https://staging-sync.smartsync.cc'};
globalThis.window={open(){},setTimeout,clearTimeout};
registerHooks({resolve(specifier,context,next){return specifier==='obsidian'?{url:new URL('./obsidian-double.mjs',import.meta.url).href,shortCircuit:true}:next(specifier,context);}});
const {default:Plugin}=await import('../src/plugin.js');
const {billingCard}=await import('../src/billing.js');

test('Global staging sign-in, email and billing use staging only and preserve pending-flow isolation',async context=>{
 const opened=[],seen=[],writes=[];window.open=url=>opened.push(url);
 const original=globalThis.fetch;context.after(()=>{globalThis.fetch=original;});
 globalThis.fetch=async(url,options)=>{seen.push(url);return Response.json({providers:['google'],emailEnabled:true});};
 const plugin={manifest:{id:'smart-sync-global',version:'1.1.4'},data:{localId:'synthetic',settings:{origin:'https://staging-sync.smartsync.cc'}},app:{secretStorage:{setSecret:(...values)=>writes.push(values)}},secret:()=>'',deviceDisplayName:()=> 'Synthetic',stopped:false};
 await Plugin.prototype.billingApi.call(plugin,'key').request('GET','auth/config');
 assert.equal(seen[0],'https://staging-pay.smartsync.cc/ss2/auth/config');
 plugin.billingApi=()=>({request:async()=>({id:'f'.repeat(43),url:'https://staging-pay.smartsync.cc/auth/login#flow='+'f'.repeat(43),expires:Date.now()+60000})});
 const flow=await Plugin.prototype.beginGlobalSignIn.call(plugin,'google');
 assert.match(opened[0],/^https:\/\/staging-pay\.smartsync\.cc\/auth\/login#flow=/);
 assert.equal(flow.origin,plugin.data.settings.origin);assert.equal(writes.length,1);
 plugin.data.settings.origin='https://sync.smartsync.cc';
 await assert.rejects(Plugin.prototype.finishGlobalSignIn.call(plugin,flow),/context changed/);
});

test('Global plan card displays 20 GB and later configured capacities without a fixed tier list',()=>{
 for(const size of [20,40]){
  const card=billingCard({entitlement:{plan:`global-${size}gb-year`,paid:true,logical:size*1073741824,ends:Date.now()+86400000}},true);
  assert.equal(card.title,`Current plan: ${size} GB · Yearly`);
 }
});

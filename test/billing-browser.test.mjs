import assert from 'node:assert/strict';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';
import {launchBillingBrowser} from '../src/billing.js';

function fixture(t,{throws=false}={}){
 const dom=new JSDOM('',{pretendToBeVisual:true}),view=dom.window,timers=new Map(),opened=[];
 let fallback=0,valid=true,hidden=false,sequence=0;
 Object.defineProperty(view.document,'hidden',{get:()=>hidden});
 view.setTimeout=callback=>{timers.set(++sequence,callback);return sequence;};view.clearTimeout=id=>timers.delete(id);
 view.open=(...args)=>{opened.push(args);if(throws)throw Error('Host browser unavailable');return null;};
 t.after(()=>dom.window.close());
 const cancel=launchBillingBrowser(view,'https://pay.example.invalid/plans#ticket=synthetic',{live:()=>valid,fallback:()=>{fallback++;}});
 return {view,cancel,timers,opened,fallback:()=>fallback,invalidate:()=>{valid=false;},hide:()=>{hidden=true;view.document.dispatchEvent(new view.Event('visibilitychange'));},event:name=>view.dispatchEvent(new view.Event(name)),tick:()=>{for(const callback of [...timers.values()])callback();}};
}
test('mobile opening is immediate; a null noopener result does not itself show a fallback',t=>{
 const f=fixture(t);assert.equal(f.opened.length,1);assert.deepEqual(f.opened[0],['https://pay.example.invalid/plans#ticket=synthetic','_blank','noopener,noreferrer']);assert.equal(f.fallback(),0);
 const late=[...f.timers.values()][0];f.event('blur');assert.equal(f.timers.size,0);late();assert.equal(f.fallback(),0);
});
test('a thrown launch failure exposes exactly one fallback and releases its monitoring',t=>{
 const f=fixture(t,{throws:true});assert.equal(f.fallback(),1);assert.equal(f.timers.size,0);f.tick();f.event('blur');assert.equal(f.fallback(),1);
});
test('without an observed handoff the bounded timeout offers one fallback; changed identities suppress it',t=>{
 const f=fixture(t);f.tick();assert.equal(f.fallback(),1);f.tick();assert.equal(f.fallback(),1);assert.equal(f.timers.size,0);
 const stale=fixture(t);stale.invalidate();stale.tick();assert.equal(stale.fallback(),0);assert.equal(stale.timers.size,0);
});
test('background, page departure and disposal suppress late fallback dialogs',t=>{
 for(const action of [f=>f.hide(),f=>f.event('pagehide'),f=>f.cancel()]){const f=fixture(t);const late=[...f.timers.values()][0];action(f);late();assert.equal(f.fallback(),0);assert.equal(f.timers.size,0);}
});

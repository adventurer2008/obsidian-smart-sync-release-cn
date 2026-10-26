import assert from 'node:assert/strict';
import {test} from 'node:test';
import {registerHooks} from 'node:module';
import {JSDOM} from 'jsdom';
registerHooks({resolve(specifier,context,next){return specifier==='obsidian'?{url:new URL('./obsidian-double.mjs',import.meta.url).href,shortCircuit:true}:next(specifier,context);}});
globalThis.window={};
const {bindManualSyncAction}=await import('../src/plugin.js');
function fixture(){
 const dom=new JSDOM('<div></div>'), root=dom.window.document.querySelector('div'), timers=new Map();let sequence=0, finish, fail; const buttons=[];
 globalThis.window={setInterval:callback=>{timers.set(++sequence,callback);return sequence;},clearInterval:id=>timers.delete(id)};
 root.createDiv=options=>{const node=dom.window.document.createElement('div');node.className=options.cls;for(const [key,value] of Object.entries(options.attr))node.setAttribute(key,value);node.setText=text=>{node.textContent=text;};root.append(node);return node;};
 const setting={settingEl:root,addButton(callback){const node=dom.window.document.createElement('button');root.append(node);const button={disabled:false,setButtonText(value){node.textContent=value;this.text=value;return this;},setDisabled(value){node.disabled=value;this.disabled=value;return this;},onClick(value){this.click=value;return this;}};buttons.push(button);callback(button);}};
 let calls=0;const plugin={data:{localId:'synthetic',settings:{origin:'https://example.invalid',workspace:'synthetic'}},requestSynchronization(){calls++;return new Promise((resolve,reject)=>{finish=resolve;fail=reject;});}};
 const dispose=bindManualSyncAction(setting,plugin);
 return {dom,root,button:buttons[0],stopButton:buttons[1],plugin,timers,dispose,click:()=>buttons[0].click(),finish:()=>finish(),fail:error=>fail(error),calls:()=>calls,tick:()=>{for(const callback of timers.values())callback();},status:()=>root.querySelector('[role=status]')};
}
test('manual sync shows preparation, live stage, stalled guidance and actual completion; repeated clicks do not duplicate work',async()=>{
 const f=fixture();try{
 assert.equal(f.status().hidden,true);const running=f.click();assert.match(f.status().textContent,/正在准备同步/);assert.equal(f.button.disabled,true);
 await f.click();assert.equal(f.calls(),1);
 f.plugin.cycleActivity={stage:'uploading',progressAt:Date.now()};f.tick();assert.match(f.status().textContent,/正在上传文件/);
 f.plugin.cycleActivity.progressAt-=16000;f.tick();assert.match(f.status().textContent,/仍在等待.*上传文件.*停止本轮/);
 f.plugin.overviewStatusText='同步完成';f.finish();await running;assert.equal(f.status().textContent,'同步完成');assert.equal(f.button.disabled,false);assert.equal(f.timers.size,0);
 }finally{f.dispose();f.dom.window.close();}
});
test('failure restores the action and clears its timer without claiming success',async()=>{
 const f=fixture();try{const running=f.click();f.fail(Object.assign(new Error('synthetic'),{code:'SYNC_BUSY'}));await running;assert.match(f.status().textContent,/同步未完成/);assert.equal(f.button.disabled,false);assert.equal(f.timers.size,0);}finally{f.dispose();f.dom.window.close();}
});

test('manual feedback exposes actual item counts while local reads continue and retains counts when stalled',async()=>{
 const f=fixture();try{
 const running=f.click();
 f.plugin.cycleActivity={stage:'read',progressAt:Date.now(),scan:{checked:100,total:13942},received:446};
 f.tick();assert.match(f.status().textContent,/读取本地文件.*本地已检查 100\/13,942 项.*接收处理已完成 446 项/);
 f.plugin.cycleActivity.scan.checked=200;f.tick();assert.match(f.status().textContent,/200\/13,942/);
 f.plugin.cycleActivity.progressAt-=16000;f.tick();assert.match(f.status().textContent,/仍在等待.*200\/13,942.*停止本轮/);
 assert.doesNotMatch(f.status().textContent,/%|同步完成/);
 f.finish();await running;assert.equal(f.button.disabled,false);assert.equal(f.timers.size,0);
 }finally{f.dispose();f.dom.window.close();}
});
test('closed settings and changed identities ignore late progress or results',async()=>{
 for(const close of [false,true]){const f=fixture();try{const running=f.click();if(close)f.dispose();else f.plugin.data.settings.workspace='another';const previous=f.status()?.textContent;f.plugin.cycleActivity={stage:'receiving',progressAt:Date.now()};f.tick();f.plugin.overviewStatusText='stale result';f.finish();await running;if(!close)assert.equal(f.status().textContent,previous);assert.equal(f.timers.size,0);}finally{f.dispose();f.dom.window.close();}}
});

test('quick Stop is immediately after Sync now and uses the shared persistent-stop action',async()=>{
 const f=fixture();let stops=0,release;
 try{
  f.plugin.stopSynchronization=()=>{stops++;return new Promise(resolve=>release=()=>{f.plugin.data.manualSyncStopped=true;resolve();});};
  assert.deepEqual([...f.root.querySelectorAll('button')].map(button=>button.textContent),['立即同步','停止']);
  const stop=f.stopButton.click();assert.equal(stops,1);assert.equal(f.stopButton.disabled,true);assert.match(f.stopButton.text,/正在停止/);
  await f.stopButton.click();assert.equal(stops,1);release();await stop;
  assert.equal(f.stopButton.disabled,true);assert.match(f.status().textContent,/自动同步已暂停/);
  delete f.plugin.data.manualSyncStopped;for(const listener of f.plugin.statusListeners)listener();assert.equal(f.stopButton.disabled,false);
 }finally{f.dispose();assert.equal(f.plugin.statusListeners.size,0);f.dom.window.close();}
});
test('quick Stop ignores stale identities and reports stop persistence failures without claiming success',async()=>{
 for(const stale of [false,true]){const f=fixture();let calls=0;try{
  f.plugin.stopSynchronization=async()=>{calls++;throw Error('synthetic stop persistence failure');};
  if(stale)f.plugin.data.settings.workspace='another';await f.stopButton.click();assert.equal(calls,stale?0:1);
  if(!stale){assert.doesNotMatch(f.status().textContent,/已停止/);assert.equal(f.stopButton.disabled,false);}
 }finally{f.dispose();f.dom.window.close();}}
});

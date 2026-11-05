import assert from 'node:assert/strict';
import {test} from 'node:test';
import {registerHooks} from 'node:module';
globalThis.window={setTimeout,clearTimeout};
globalThis.__SMART_SYNC_EDITION__={edition:'cn',id:'wujie-sync',locale:'zh-CN',serviceOrigin:'https://sync.wujiesync.cc'};
registerHooks({resolve(specifier,context,next){return specifier==='obsidian'?{url:new URL('./obsidian-double.mjs',import.meta.url).href,shortCircuit:true}:next(specifier,context);}});
const {default:Plugin}=await import('../src/plugin.js');
const {modals}=await import('./obsidian-double.mjs');

test('CN deletion shares cloud-first confirmation, asks for the original key and never initiates email or OAuth',async()=>{
 const calls=[];let status={vaults:1,pending:0,requiresReauthentication:true,verification:'login-key'},signedOut=0;
 const plugin={app:{},data:{localId:'synthetic',settings:{origin:'https://sync.wujiesync.cc'}},secret:()=> 'current-account',stopped:false,
  accountApi:async()=>({request:async(method,path,input)=>{calls.push({method,path,input});return method==='GET'?status:{erased:true};}}),
  globalEnrollment:()=>assert.fail('No third-party login in CN'),exclusive:async work=>work(),signOut:async()=>{signedOut++;},notify(){},manageNotebooks:async()=>{}};
 await Plugin.prototype.deleteAccount.call(plugin);
 assert.equal(modals.at(-1).contentEl.settings[0].controls[0].text,'管理云端库');
 assert.equal(calls.some(call=>call.method==='POST'),false);
 status={...status,vaults:0};await Plugin.prototype.deleteAccount.call(plugin);
 await modals.at(-1).contentEl.settings[0].controls[0].click();
 const form=modals.at(-1),key=form.contentEl.settings[0].controls[0],confirm=form.contentEl.settings[1].controls[0],submit=form.contentEl.settings[2].controls[0];
 key.change('synthetic-original-key');confirm.change('delete');await submit.click();assert.equal(signedOut,0);
 confirm.change('注销账号');await submit.click();
 assert.deepEqual(calls.filter(call=>call.method==='POST'),[{method:'POST',path:'account/close',input:{confirm:'DELETE',loginKey:'synthetic-original-key'}}]);assert.equal(signedOut,1);
});

test('CN deletion on an older service safely requests an upgrade without using legacy bulk erase',async()=>{
 const calls=[],plugin={data:{localId:'same',settings:{origin:'https://sync.wujiesync.cc'}},secret:()=> 'key',accountApi:async()=>({request:async(method,path)=>{calls.push(path);throw Object.assign(Error('Not found'),{status:404});}})};
 await assert.rejects(Plugin.prototype.deleteAccount.call(plugin),{code:'ACCOUNT_CLOSE_UPGRADE'});
 assert.deepEqual(calls,['account/close']);
});

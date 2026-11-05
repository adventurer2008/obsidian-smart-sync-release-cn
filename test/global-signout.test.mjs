import assert from 'node:assert/strict';
import {test} from 'node:test';
import {registerHooks} from 'node:module';
globalThis.window={open(){},setTimeout,clearTimeout,setInterval,clearInterval};
globalThis.__SMART_SYNC_EDITION__={edition:'global',id:'smart-sync-global',name:'Smart Sync',locale:'en',development:false,serviceOrigin:'https://sync.smartsync.cc'};
registerHooks({resolve(specifier,context,next){return specifier==='obsidian'?{url:new URL('./obsidian-double.mjs',import.meta.url).href,shortCircuit:true}:next(specifier,context);}});
const {default:Plugin}=await import('../src/plugin.js');
for(const offline of [false,true])test(`Global sign-out ${offline?'offline':'online'} clears local access and isolates late login/billing state`,async()=>{
 const secrets=new Map(),calls=[],originalId='synthetic-signout';let saved=0,canceled=0,closed=0;
 const plugin={manifest:{id:'smart-sync-global'},data:{localId:originalId,settings:{origin:'https://sync.smartsync.cc',workspace:'synthetic-vault',direction:'both'},connections:{retained:'metadata'},renames:{old:'new'},lastDeletedWorkspace:'old'},
  accountEmail:'user@example.invalid',accountAuthorized:true,overviewIdentity:{owner:'old'},preparedBillingEntry:{url:'old'},journal:{names:new Map([['old','name']])},
  billingHandoffCancel:()=>{canceled++;},billingFallbackWindow:{close:()=>{closed++;}},lanPeers:{close:()=>{closed++;}},
  secret:name=>secrets.get(`smart-sync-global-${plugin.data.localId}-${name}`)||'',
  setSecret:(name,value)=>secrets.set(`smart-sync-global-${plugin.data.localId}-${name}`,value),
  app:{secretStorage:{setSecret:(name,value)=>secrets.set(name,value)}},
  api:()=>({request:async(verb,path)=>{calls.push(['scoped',verb,path]);if(offline)throw Error('Synthetic offline');return path==='account'?{scope:'synthetic-vault',deviceId:'scoped'}:{};}}),
  workspaceApi:(origin,key)=>{assert.equal(key,'synthetic-account');return{request:async(verb,path)=>{calls.push(['account',verb,path]);if(offline)throw Error('Synthetic offline');return path==='account'?{accountDevice:true}:{};}};},
  saveData:async()=>{saved++;},refreshTasks(){},setStatus(){},notify(){},tab:{update(){}},
 };
 for(const name of ['account','access','enc','crypto','create','oauth'])secrets.set(`smart-sync-global-${originalId}-${name}`,'synthetic-'+name);
 const result=await Plugin.prototype.signOut.call(plugin);
 assert.equal(result.revocationStatus,offline?'unconfirmed':'confirmed');assert.equal(result.revocationConfirmed,!offline);
 for(const name of ['account','access','enc','crypto','create'])assert.equal(secrets.get(`smart-sync-global-${originalId}-${name}`),'',name);
 assert.notEqual(plugin.data.localId,originalId);assert.equal(plugin.secret('oauth'),'');
 assert.equal(plugin.data.settings.workspace,'');assert.equal(plugin.accountAuthorized,false);assert.equal(plugin.accountEmail,'');
 assert.equal(plugin.preparedBillingEntry,undefined);assert.equal(plugin.overviewIdentity,undefined);assert.equal(plugin.lanPeers,undefined);
 assert.equal(plugin.journal.names.size,0);assert.equal(saved,1);assert.equal(canceled,1);assert.equal(closed,2);
 assert.deepEqual(plugin.data.connections,{});assert.deepEqual(plugin.data.archives[0].connections,{retained:'metadata'});
 if(!offline)assert.deepEqual(calls.filter(row=>row[2]==='session/revoke').map(row=>row[0]),['scoped','account']);
 // The fixture exposes no vault write/delete API: sign-out must only forget credentials and connection state.
});

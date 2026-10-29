import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import crypto from 'node:crypto';
import { registerHooks } from 'node:module';
import { windowsStartup, windowsStartupSupported, startupRequestMatches } from '../src/startup.js';
registerHooks({ resolve(specifier, context, next) { return specifier === 'obsidian' ? { url: new URL('./obsidian-double.mjs', import.meta.url).href, shortCircuit: true } : next(specifier, context); } });
globalThis.window ??= globalThis;
const { default: Plugin } = await import('../src/plugin.js');
function fixture() {
 const files = new Map(), roots = { userData:'C:\\Synthetic\\Roaming\\obsidian', appData:'C:\\Synthetic\\Roaming', exe:'C:\\Program Files\\Obsidian\\Obsidian.exe' };
 const config=path.win32.join(roots.userData,'obsidian.json');
 files.set(config,Buffer.from(JSON.stringify({vaults:{abc123:{path:'E:\\Synthetic & notes\\库 A'},other:{path:'E:\\Other'}}})));
 const missing=()=>Object.assign(Error('missing'),{code:'ENOENT'});
 const fs={async readFile(p,encoding){if(!files.has(p))throw missing();return encoding?files.get(p).toString(encoding):Buffer.from(files.get(p));},async writeFile(p,b){files.set(p,Buffer.from(b));},async lstat(p){if(!files.has(p))throw missing();return {isFile:()=>true,isSymbolicLink:()=>false};},async mkdir(){},async unlink(p){files.delete(p);}};
 let failWrite=false;
 const shell={readShortcutLink(p){return JSON.parse(files.get(p));},writeShortcutLink(p,operation,options){assert.equal(operation,'create');files.set(p,Buffer.from(JSON.stringify(options)));return !failWrite;}};
 const load=name=>({'node:process':{platform:'win32'},'node:fs/promises':fs,'node:path':path,'node:crypto':crypto,'@electron/remote':{app:{getPath:key=>roots[key]}},electron:{shell}}[name]);
 const create=(options={})=>windowsStartup({load,pluginId:'wujie-sync',vaultPath:'E:\\Synthetic & notes\\库 A',...options});
 return {files,load,create,config,failWrite(){failWrite=true;},links:()=>[...files.keys()].filter(p=>p.endsWith('.lnk'))};
}
test('startup is Windows-only; request markers isolate enabled vaults and require a usable tray',()=>{
 assert.equal(windowsStartupSupported(()=>({platform:'linux'})),false);
 assert.equal(windowsStartupSupported(undefined),false);
 const settings={launchAtLogin:true,backgroundTray:true,launchAtLoginToken:'a'.repeat(32),launchAtLoginVault:'abc123'};
 assert.equal(startupRequestMatches({token:'a'.repeat(32),target:'abc123',vault:'abc123'},settings),true);
 assert.equal(startupRequestMatches({token:'a'.repeat(32),target:'abc123'},settings),true);
 assert.equal(startupRequestMatches({token:'a'.repeat(32),target:'other',vault:'other'},settings),false);
 assert.equal(startupRequestMatches({token:'a'.repeat(32),target:'abc123',vault:'other'},settings),false);
 assert.equal(startupRequestMatches({},settings),false);
 assert.equal(startupRequestMatches({token:'a'.repeat(32),target:'abc123'},{...settings,backgroundTray:false}),false);
 assert.equal(startupRequestMatches({token:'a'.repeat(32),target:'abc123'},{...settings,launchAtLogin:false}),false);
});
test('explicit enable creates only this vault shortcut, targets exact vault ID, and disable is reversible',async()=>{
 const f=fixture(),s=await f.create();assert.equal(f.links().length,0);
 const undo=await s.change(true,'a'.repeat(32));
 assert.equal(f.links().length,1);
 const p=f.links()[0],bytes=f.files.get(p),link=JSON.parse(bytes);
 assert.equal(link.target,'C:\\Program Files\\Obsidian\\Obsidian.exe');
 assert.match(link.args,/^--user-data-dir="C:\\Synthetic\\Roaming\\obsidian" "obsidian:\/\/wujie-sync-startup\?vault=abc123&target=abc123&token=a+"$/);
 const undoDisable=await s.change(false,'');assert.equal(f.links().length,0);
 await undoDisable();assert.deepEqual(f.files.get(p),bytes);
 await undo();assert.equal(f.links().length,0);
});
test('failed shortcut creation restores the prior state; foreign files are never overwritten or removed',async()=>{
 const f=fixture(),s=await f.create();f.failWrite();
 await assert.rejects(s.change(true,'a'.repeat(32)));assert.equal(f.links().length,0);
 const g=fixture(),t=await g.create();await t.change(true,'a'.repeat(32));
 const p=g.links()[0];g.files.set(p,Buffer.from(JSON.stringify({description:'another application'})));
 await assert.rejects(t.change(false,''),/not owned/);
 assert.equal(JSON.parse(g.files.get(p)).description,'another application');
});
test('rollback refuses to clobber a shortcut modified after the operation',async()=>{
 const f=fixture(),s=await f.create(),undo=await s.change(true,'a'.repeat(32)),p=f.links()[0];
 const link=JSON.parse(f.files.get(p));link.args='changed by another action';f.files.set(p,Buffer.from(JSON.stringify(link)));
 await assert.rejects(undo(),/changed before rollback/);assert.equal(JSON.parse(f.files.get(p)).args,'changed by another action');
});
test('settings save failure restores startup entry and only startup settings, preserving unrelated current values',async()=>{
 const f=fixture(),before=window.require;window.require=f.load;
 const plugin={data:{settings:{backgroundTray:false,interval:60}},manifest:{id:'wujie-sync'},app:{vault:{adapter:{getBasePath:()=> 'E:\\Synthetic & notes\\库 A'}}},
  async saveData(){this.data.settings.interval=120;throw Error('synthetic full disk');},refreshBackgroundTray(){assert.fail('must not change tray on failed save');},notify(){}};
 try{await assert.rejects(Plugin.prototype.setLaunchAtLogin.call(plugin,true),/synthetic full disk/);
 assert.equal(plugin.data.settings.backgroundTray,false);assert.equal(plugin.data.settings.launchAtLogin,undefined);assert.equal(plugin.data.settings.launchAtLoginToken,undefined);assert.equal(plugin.data.settings.interval,120);assert.equal(f.links().length,0);}
 finally{window.require=before;}
});
test('enable preserves manual sync stop and other settings; disabling removes only the owned startup entry',async()=>{
 const f=fixture(),before=window.require;window.require=f.load;let saves=0,trays=0;
 const plugin={data:{manualSyncStopped:true,settings:{backgroundTray:false,interval:60}},manifest:{id:'wujie-sync'},app:{vault:{adapter:{getBasePath:()=> 'E:\\Synthetic & notes\\库 A'}}},async saveData(){saves++;},refreshBackgroundTray(){trays++;},notify(){}};
 try{await Plugin.prototype.setLaunchAtLogin.call(plugin,true);assert.equal(plugin.data.settings.launchAtLogin,true);assert.equal(plugin.data.settings.backgroundTray,true);assert.equal(plugin.data.manualSyncStopped,true);
 await Plugin.prototype.setLaunchAtLogin.call(plugin,false);assert.equal(plugin.data.settings.launchAtLogin,false);assert.equal(f.links().length,0);assert.equal(saves,2);assert.equal(trays,2);assert.equal(plugin.data.settings.interval,60);}
 finally{window.require=before;}
});

test('an unavailable host vault registry must not prevent removal of this owned startup entry',async()=>{
 const f=fixture(),s=await f.create();await s.change(true,'a'.repeat(32));f.files.delete(f.config);
 const reopened=await f.create();await reopened.change(false,'');assert.equal(f.links().length,0);
});
test('copied Windows settings cannot block switching off the tray on macOS or Linux',async()=>{
 const before=window.require;
 try{for(const platform of ['darwin','linux']){
  window.require=()=>({platform});let saves=0;
  const plugin={data:{settings:{backgroundTray:true,launchAtLogin:true}},async saveData(){saves++;},refreshBackgroundTray(){}};
  await Plugin.prototype.setting.call(plugin,'backgroundTray',false);
  assert.equal(plugin.data.settings.backgroundTray,false);assert.equal(saves,1);
 }}finally{window.require=before;}
});

test('registration is verified locally rather than trusting copied flags or the wrong marker',async()=>{
 const f=fixture(),s=await f.create();assert.equal(await s.isConfigured('a'.repeat(32)),false);
 await s.change(true,'a'.repeat(32));assert.equal(await s.isConfigured('a'.repeat(32)),true);
 assert.equal(await s.isConfigured('b'.repeat(32)),false);
 const copied=await f.create({expectedVaultId:'different-device-id'});assert.equal(await copied.isConfigured('a'.repeat(32)),false);
 f.files.delete(f.config);assert.equal(await s.isConfigured('a'.repeat(32)),false);
});
test('two vaults and two editions own independent entries; removing one leaves all others intact',async()=>{
 const f=fixture(),a=await f.create(),b=await f.create({vaultPath:'E:\\Other'}),global=await f.create({pluginId:'smart-sync-global'});
 await a.change(true,'a'.repeat(32));await b.change(true,'b'.repeat(32));await global.change(true,'c'.repeat(32));
 assert.equal(f.links().length,3);await a.change(false,'');assert.equal(f.links().length,2);
 assert.equal(await b.isConfigured('b'.repeat(32)),true);assert.equal(await global.isConfigured('c'.repeat(32)),true);
});
test('moving a registered vault with the same native ID can inspect and remove its original owned shortcut',async()=>{
 const f=fixture(),a=await f.create();await a.change(true,'a'.repeat(32));
 const host=JSON.parse(f.files.get(f.config));host.vaults.abc123.path='F:\\Moved library';f.files.set(f.config,Buffer.from(JSON.stringify(host)));
 const moved=await f.create({vaultPath:'F:\\Moved library',registeredPath:a.boundPath,expectedVaultId:'abc123'});
 assert.equal(await moved.isConfigured('a'.repeat(32)),true);
 await moved.change(false,'');assert.equal(f.links().length,0);
});
test('a copied vault with a new native ID cannot remove or replace the source vault startup entry',async()=>{
 const f=fixture(),a=await f.create();await a.change(true,'a'.repeat(32));
 const original=f.links()[0],bytes=Buffer.from(f.files.get(original));
 const host=JSON.parse(f.files.get(f.config));host.vaults.copy123={path:'F:\\Copied library'};f.files.set(f.config,Buffer.from(JSON.stringify(host)));
 const copy=await f.create({vaultPath:'F:\\Copied library',registeredPath:a.boundPath,expectedVaultId:'abc123'});
 assert.equal(await copy.isConfigured('a'.repeat(32)),false);
 await copy.change(false,'');assert.deepEqual(f.files.get(original),bytes);
 await copy.change(true,'b'.repeat(32));assert.equal(f.links().length,2);assert.deepEqual(f.files.get(original),bytes);
 await copy.change(false,'');assert.equal(f.links().length,1);assert.deepEqual(f.files.get(original),bytes);
});
test('startup handler requires a real local registration and defers hiding until layout ready, rejecting late vault changes',async()=>{
 const previous=window.require;window.require=()=>({platform:'win32'});
 const params={token:'a'.repeat(32),target:'abc123',vault:'abc123'};let configured=false,hidden=0,ready;
 const settings={launchAtLogin:true,backgroundTray:true,launchAtLoginToken:params.token,launchAtLoginVault:params.vault};
 const plugin={data:{localId:'synthetic',settings},startupController:async()=>({isConfigured:async()=>configured}),app:{workspace:{onLayoutReady(cb){ready=cb;}}},backgroundTray:{hide(){hidden++;return true;}},notify(){}};
 try {
  await Plugin.prototype.handleLoginStartup.call(plugin,params);assert.equal(ready,undefined);assert.equal(hidden,0);
  configured=true;await Plugin.prototype.handleLoginStartup.call(plugin,params);assert.equal(hidden,0);ready();assert.equal(hidden,1);
  await Plugin.prototype.handleLoginStartup.call(plugin,params);plugin.data.localId='another-vault';ready();assert.equal(hidden,1);
 }finally{window.require=previous;}
});
test('late startup status checks cannot overwrite a newer user change',async()=>{
 const previous=window.require;window.require=()=>({platform:'win32'});let finish;
 const plugin={data:{localId:'synthetic',settings:{launchAtLogin:true,launchAtLoginToken:'a'.repeat(32)}},startupStatus:true,
  startupController:async()=>({isConfigured:()=>new Promise(resolve=>{finish=resolve;})}),tab:{update(){assert.fail('stale status must not update UI');}}};
 try{const pending=Plugin.prototype.refreshStartupRegistration.call(plugin);await Promise.resolve();await Promise.resolve();
 plugin.startupStatusRevision=1;finish(false);await pending;assert.equal(plugin.startupStatus,true);
 }finally{window.require=previous;}
});

test('invalid migrated startup markers are repaired by explicit opt-in, without changing other settings',async()=>{
 const f=fixture(),before=window.require;window.require=f.load;
 const plugin={data:{localId:'synthetic',settings:{launchAtLogin:true,launchAtLoginToken:'corrupt',interval:60}},manifest:{id:'wujie-sync'},app:{vault:{adapter:{getBasePath:()=> 'E:\\Synthetic & notes\\库 A'}}},async saveData(){},refreshBackgroundTray(){},notify(){}};
 try{await Plugin.prototype.setLaunchAtLogin.call(plugin,true);assert.match(plugin.data.settings.launchAtLoginToken,/^[a-f0-9-]{36}$/);assert.equal(plugin.startupStatus,true);assert.equal(plugin.data.settings.interval,60);assert.equal(f.links().length,1);}
 finally{window.require=before;}
});

test('a shortcut bound to another Obsidian profile is neither overwritten nor removed',async()=>{
 const f=fixture(),original=await f.create();await original.change(true,'a'.repeat(32));const p=f.links()[0],before=Buffer.from(f.files.get(p));
 const secondProfile='C:\\Synthetic\\Another profile';f.files.set(path.win32.join(secondProfile,'obsidian.json'),Buffer.from(f.files.get(f.config)));
 const load=name=>name==='@electron/remote'?{app:{getPath:key=>key==='userData'?secondProfile:({appData:'C:\\Synthetic\\Roaming',exe:'C:\\Program Files\\Obsidian\\Obsidian.exe'})[key]}}:f.load(name);
 const second=await f.create({load});assert.equal(await second.isConfigured('a'.repeat(32)),false);
 await assert.rejects(second.change(true,'b'.repeat(32)),{code:'STARTUP_CUSTOM_PROFILE'});await assert.rejects(second.change(false,''),/not owned/);
 assert.deepEqual(f.files.get(p),before);
});
test('legacy startup links without a profile are not reported configured and explicit re-enable binds this profile',async()=>{
 const f=fixture(),s=await f.create();await s.change(true,'a'.repeat(32));const p=f.links()[0],link=JSON.parse(f.files.get(p));
 link.args=link.args.replace(/^--user-data-dir="[^"]+" /,'');f.files.set(p,Buffer.from(JSON.stringify(link)));
 assert.equal(await s.isConfigured('a'.repeat(32)),false);await s.change(true,'a'.repeat(32));assert.equal(await s.isConfigured('a'.repeat(32)),true);
 assert.match(JSON.parse(f.files.get(p)).args,/^--user-data-dir=/);
});

 test('custom profiles refuse registration without writes, remain inactive, and can remove their owned legacy entry',async()=>{
 const f=fixture(),s=await f.create();await s.change(true,'a'.repeat(32));const p=f.links()[0],link=JSON.parse(f.files.get(p)),custom='C:\\Synthetic\\Isolated';
 link.args=link.args.replace('C:\\Synthetic\\Roaming\\obsidian',custom);f.files.set(p,Buffer.from(JSON.stringify(link)));
 const before=Buffer.from(f.files.get(p));const load=name=>name==='@electron/remote'?{app:{getPath:key=>key==='userData'?custom:f.load('@electron/remote').app.getPath(key)}}:f.load(name);
 const isolated=await f.create({load});assert.equal(await isolated.isConfigured('a'.repeat(32)),false);
 await assert.rejects(isolated.change(true,'b'.repeat(32)),{code:'STARTUP_CUSTOM_PROFILE'});assert.deepEqual(f.files.get(p),before);
 await isolated.change(false,'');assert.equal(f.links().length,0);
 });

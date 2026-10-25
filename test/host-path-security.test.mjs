import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {mkdtemp, writeFile, readFile, stat, utimes, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {safeHostPath} from '../src/codec.js';
import {desktopFiles} from '../src/desktop.js';
import {configurationHost, configurationScope} from '../src/configuration.js';

test('Windows host rejects streams, devices and ambiguous names while POSIX names remain usable', () => {
 for (const name of ['notes/file.md:stream','NUL.md','con','dir/COM1.txt','LPT².log','CONOUT$','notes/trailing.','notes/trailing ','dir/x\u001f.md','notes/a?.md'])
  assert.throws(()=>safeHostPath(name,true), /Windows/, name);
 assert.equal(safeHostPath('notes/file.md:stream',false),'notes/file.md:stream');
 assert.equal(safeHostPath('中文/笔记.md',true),'中文/笔记.md');
 assert.equal(safeHostPath('notes/console.md',true),'notes/console.md');
 for (const name of ['../escape','a/../escape','C:/absolute','/absolute','.obsidian/config.json'])
  for (const windows of [false,true]) assert.throws(()=>safeHostPath(name,windows));
});

test('configuration host blocks Windows stream paths before any adapter operation', async () => {
 let calls=0;
 const adapter={exists:async()=>{calls++;return false;},writeBinary:async()=>{calls++;}};
 const scope=configurationScope({themes:true});
 const host=configurationHost({configDir:'.obsidian',adapter},{},scope,{windows:true});
 await assert.rejects(host.write(scope.encode('themes/name:stream/theme.css'),new Uint8Array([1])),/Windows/);
 assert.equal(calls,0);
});

test('native Windows file access rejects NTFS streams without changing existing file content or mtime', {skip:process.platform!=='win32'}, async t => {
 const root=await mkdtemp(join(tmpdir(),'ss2-host-boundary-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const file=join(root,'canary.md'),mtime=Date.UTC(2020,0,2);
 await writeFile(file,'original');await utimes(file,mtime/1000,mtime/1000);
 const before=await stat(file);
 const host=desktopFiles({adapter:{getBasePath:()=>root},configDir:'.obsidian'},{load:createRequire(import.meta.url)});
 await assert.rejects(host.source('canary.md:payload'),/Windows/);
 await assert.rejects(host.sink('canary.md:payload',1,'0'.repeat(64),mtime),/Windows/);
 assert.equal(await readFile(file,'utf8'),'original');assert.equal((await stat(file)).mtimeMs,before.mtimeMs);
});

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {regionalServices} from '../src/edition.js';
import {loadEdition,validateEdition} from '../scripts/edition-config.mjs';
import {fileURLToPath} from 'node:url';

test('regional configuration confines production, staging, payment and sign-in to the matching environment',async()=>{
 for(const selected of ['cn','global']){
  const config=await loadEdition(selected,fileURLToPath(new URL('../',import.meta.url))),prod=regionalServices(config),stage=regionalServices(config,config.stagingOrigin);
  assert.equal(prod.pay,config.payOrigin);assert.equal(prod.purchase,config.payOrigin+'/pay');
  assert.equal(stage.pay,config.stagingPayOrigin);assert.equal(stage.purchase,config.stagingPayOrigin+(selected==='cn'?'/pay-test':'/pay'));
  assert.equal(stage.login,config.stagingPayOrigin+'/auth/login');assert.equal(stage.staging,true);
  assert.throws(()=>regionalServices(config,selected==='cn'?'https://sync.smartsync.cc':'https://sync.wujiesync.cc'),{code:'EDITION_SERVICE_MISMATCH'});
  assert.throws(()=>regionalServices({...config,payOrigin:'https://evil.example'},config.serviceOrigin),{code:'EDITION_UNCONFIGURED'});
  assert.throws(()=>validateEdition({...config,stagingPayOrigin:'https://evil.example'},selected));
  for(const origin of [config.serviceOrigin+'/',config.serviceOrigin+'/path',config.serviceOrigin+'?token=x','https://evil.example'])assert.throws(()=>regionalServices(config,origin));
 }
});

test('only explicit development loopback uses a local payment service',()=>{
 const config={edition:'cn',development:true};
 assert.equal(regionalServices(config,'http://127.0.0.1:45678').purchase,'http://127.0.0.1:45678');
 for(const origin of ['http://127.0.0.1.evil.example','http://10.0.0.1:45678','http://localhost:45678/path'])assert.throws(()=>regionalServices(config,origin));
 assert.throws(()=>regionalServices({...config,development:false},'http://127.0.0.1:45678'));
});

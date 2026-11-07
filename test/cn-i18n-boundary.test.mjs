import {test} from 'node:test';import assert from 'node:assert/strict';
globalThis.__SMART_SYNC_EDITION__={edition:'cn',id:'wujie-sync',locale:'zh-CN'};
const {configureLanguage,t,locale}=await import('../src/i18n.js');
const {billingCard}=await import('../src/billing.js');
test('China keeps its language, free quota and region when the host/Global preference differ',()=>{
 assert.equal(configureLanguage('ja','de'),'zh-CN');assert.equal(locale,'zh-CN');assert.equal(t('account.closePhrase'),'注销账号');
 const model=billingCard({entitlement:{plan:'cn-free',logical:100*1024**2,paid:false}},true);assert.match(model.title,/100MB/);assert.equal(model.title.includes('50'),false);
});

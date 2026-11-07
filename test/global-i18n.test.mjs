import {test} from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
globalThis.window={setTimeout,clearTimeout,setInterval,clearInterval,open(){}};
globalThis.__SMART_SYNC_EDITION__={edition:'global',id:'smart-sync-global',locale:'en'};
registerHooks({resolve(s,c,n){return s==='obsidian'?{url:new URL('./obsidian-double.mjs',import.meta.url).href,shortCircuit:true}:n(s,c);}});
const {supportedLanguages,resolveLanguage,configureLanguage,englishDraft,t,localizedFailure}=await import('../src/i18n.js');
const {catalogs}=await import('../src/locales/catalogs.js');
const {billingCard,capacityWarning}=await import('../src/billing.js');
const slots=value=>[...value.matchAll(/\{(\w+)\}/g)].map(m=>m[1]).sort();
test('Manage plan remains visible for a paid annual subscription long before expiry',()=>{
 configureLanguage('en');
 const card=billingCard({entitlement:{plan:'global-1gb-year',paid:true,logical:1024**3,ends:Date.now()+300*86400000}},true);
 assert.equal(card.prominent,true);assert.equal(card.label,'Manage plan');
});
test('all ten Global locales are complete, retain placeholders and the machine deletion token',()=>{
 assert.equal(Object.keys(supportedLanguages).length,10);
 for(const code of Object.keys(supportedLanguages)){
  configureLanguage(code);
  for(const [key,source] of Object.entries(englishDraft)){
   if(code!=='en'){assert.equal(typeof catalogs[code][key],'string',code+':'+key);assert.deepEqual(slots(catalogs[code][key]),slots(source),code+':'+key);}
   const params=Object.fromEntries(slots(source).map(key=>[key,'SYNTHETIC_VALUE']));
   assert.equal(/\{\w+\}/.test(t(key,params)),false,code+':'+key);
  }
  assert.equal(t('account.closePhrase'),'DELETE');
  assert.ok(localizedFailure({code:'DEVICE_LIMIT_REACHED',limit:12}).includes('12'));
 }
 configureLanguage('en');
});
test('host aliases, unknown locales and explicit per-vault overrides resolve without changing the region',()=>{
 for(const [input,expected]of [['en-GB','en'],['zh_hans','zh-CN'],['zh-Hant-HK','zh-TW'],['zh-HK','zh-TW'],['pt-br','pt-BR'],['pt-PT','pt-BR'],['ja-JP','ja'],['unknown','en'],['__proto__','en']])assert.equal(resolveLanguage(input),expected);
 assert.equal(configureLanguage('ja','de'),'de');assert.equal(configureLanguage('ja','auto'),'ja');assert.equal(globalThis.__SMART_SYNC_EDITION__.edition,'global');configureLanguage('en');
});
test('translated Global billing keeps the actual Global free quota and subscription identity',()=>{
 for(const code of Object.keys(supportedLanguages)){
  configureLanguage(code);
  const data={entitlement:{plan:'global-free',logical:50*1024**2,paid:false},usage:{logicalBytes:1}};
  const model=billingCard(data,true);assert.ok(model.title.includes('50'),code);assert.equal(model.title.includes('100'),false,code);assert.equal(model.free,true);assert.equal(data.entitlement.plan,'global-free');
  const paid={entitlement:{plan:'global-1gb-month',logical:1024**3,paid:true,ends:Date.UTC(2028,0,1)},usage:{logicalBytes:2*1024**3}};
  const paidModel=billingCard(paid,true,Date.UTC(2026,10,6));assert.equal(/\{\w+\}/.test(paidModel.usage+paidModel.expires),false);
  if(code!=='en'){assert.equal(paidModel.usage.startsWith('Used '),false,code);assert.equal(paidModel.expires.startsWith('Access ends:'),false,code);}
  assert.equal(/\{\w+\}/.test(capacityWarning(paid).message),false);
 }
 configureLanguage('en');
});

test('Global plan cards omit generic capacity prose but retain actionable billing notices',()=>{
 const now=Date.UTC(2026,10,6);
 const paid={entitlement:{plan:'global-1gb-month',paid:true,logical:1024**3,ends:now+86400000},usage:{logicalBytes:416*1024**2}};
 for(const code of Object.keys(supportedLanguages)){
  configureLanguage(code);
  const card=billingCard(paid,true,now);
  assert.equal(card.help,'',code);assert.ok(card.title);assert.ok(card.usage);assert.ok(card.expires);assert.ok(card.label);assert.equal(card.prominent,true);
  assert.equal(billingCard({entitlement:{plan:'global-free',paid:false,logical:50*1024**2}},true,now).help,'',code);
  assert.ok(billingCard({...paid,testMode:true},true,now).help,code);
  assert.ok(billingCard({everPurchased:true,lastPurchase:{plan:'global-1gb-month',status:'refunded',ends:now+86400000}},true,now).help,code);
  assert.ok(billingCard({everPurchased:true,lastPurchase:{plan:'global-1gb-month',ends:now-1}},true,now).help,code);
 }
 configureLanguage('en');
});

test('Global confirmation hints match the exact existing validation words in every language',()=>{
 for(const code of Object.keys(supportedLanguages)){
  configureLanguage(code);
  for(const [hint,word] of [['notebooks.revokeConfirm','notebooks.revokeWord'],['msg_5211f581d5','msg_36f33adaf0'],['account.closeConfirm','account.closePhrase']]){
   assert.ok(t(hint).includes(t(word)),code+':'+hint+' must show the case-sensitive accepted input');
  }
  assert.ok(t('error.ACCOUNT_ERASE_CONFIRMATION').includes('DELETE'),code);
 }
 configureLanguage('en');
});

test('Global runtime catalogs retain product brands and contain no untranslated prose paragraphs',()=>{
 const brands=['Obsidian','Smart Sync','Stripe','Google','GitHub','Dodo Payments','Windows','macOS','Linux','Android','iPhone','iPad','Markdown'];
 const count=(text,brand)=>text.toLowerCase().split(brand.toLowerCase()).length-1;
 for(const [code,catalog] of Object.entries(catalogs))for(const [key,source]of Object.entries(englishDraft)){
  const translated=catalog[key];
  for(const brand of brands)assert.ok(count(translated,brand)>=count(source,brand),code+':'+key+':'+brand);
  const prose=source.replace(/\{\w+\}/g,'').replace(/Smart Sync/g,'').replace(/[^A-Za-z]/g,'');
  if(prose.length>=40)assert.notEqual(translated,source,code+':'+key);
 }
});

test('language selection persists outside synchronized settings and applies only after reload',async()=>{
 configureLanguage('en');
 const {IndependentSettings}=await import('../src/plugin.js');
 const settings={origin:'https://sync.smartsync.cc',workspace:'synthetic',direction:'both',interval:60,attachmentMiB:256,excludedExtensions:[],configuration:{}};
 const connection={synthetic:{key:'synthetic'}};let saves=0,changed,notice,selected;
 const owner={data:{localId:'synthetic',settings,connections:connection},manifest:{version:'synthetic'},secret:()=>'',statusListeners:new Set(),status:{textContent:''},lanSummary:()=>'',saveData:async()=>{saves++;},notify:value=>{notice=value;}};
 const definitions=IndependentSettings.prototype.getSettingDefinitions.call({owner,expanded:new Set()});
 const row=definitions.find(item=>item.name===t('language.title'));assert.ok(row);
 const classes=new Set();
 const control={settingEl:{classList:{add(value){classes.add(value);}}},setDesc(){assert.fail('Language row must not show a description');},addDropdown(callback){const input={addOptions(){return this;},setValue(value){selected=value;return this;},onChange(callback){changed=callback;return this;}};callback(input);return this;}};
 row.render(control);assert.equal(selected,'auto');
 assert.ok(classes.has('smart-sync-language-row'));
 configureLanguage('zh-Hans');owner.data.interfaceLanguage='auto';row.render(control);assert.equal(selected,'auto');
 configureLanguage('en');delete owner.data.interfaceLanguage;
 await changed('de');assert.equal(owner.data.interfaceLanguage,'de');assert.equal(owner.data.settings,settings);assert.equal(owner.data.connections,connection);assert.equal(settings.direction,'both');assert.equal(saves,1);assert.match(notice,/Reload/);assert.equal(t('language.auto'),'Follow Obsidian');
 row.render(control);assert.equal(selected,'de');
 await changed('not-a-locale');assert.equal(saves,1);
 owner.saveData=async()=>{throw Error('Synthetic disk full');};await changed('ja');assert.equal(owner.data.interfaceLanguage,'de');assert.equal(settings.origin,'https://sync.smartsync.cc');
 let rejectFirst,attempt=0;owner.saveData=()=>++attempt===1?new Promise((resolve,reject)=>{rejectFirst=reject;}):Promise.resolve();
 const first=changed('fr');await changed('ja');rejectFirst(Error('Synthetic first save failed'));await first;assert.equal(owner.data.interfaceLanguage,'ja','a failed older choice must not roll back a newer saved language');
});

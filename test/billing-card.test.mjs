import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { billingCard, mountBillingCard, renewalReminderAt } from '../src/billing.js';

const at = Date.UTC(2026, 9, 22), gb = 1024 ** 3;
const paid = ends => ({ everPurchased:true, entitlement:{paid:true,plan:'cn-5gb-year',logical:5*gb,ends}, usage:{logicalBytes:1.2*gb} });

test('an operator-closed unpaid order is terminal and has no resume action',()=>{
 const card=billingCard({entitlement:{paid:false},currentOrder:{id:'synthetic-closed',status:'expired',purpose:'purchase',title:'5GB'}},true,at);
 assert.equal(card.order,'订单已关闭');assert.equal(card.resume,undefined);assert.doesNotMatch(card.order,/处理中|等待付款/);
});
test('signing in remounts one free card and discards the old guest view and pending response', async () => {
 const dom = new JSDOM('<div id="setting"><div id="info"><span>我的套餐</span></div><div id="controls"></div></div>', {pretendToBeVisual:true}), doc = dom.window.document;
 const setting = {settingEl:doc.querySelector('#setting'), infoEl:doc.querySelector('#info'), controlEl:doc.querySelector('#controls'), setName(){}};
 const free = {entitlement:{plan:'cn-free',paid:false,logical:100*1024**2,starts:at},usage:{logicalBytes:0}};
 let resolveOld, loads=0;
 const old = mountBillingCard(setting, {connected:false, live:()=>true, now:()=>at, target:dom.window, load:async()=>{ if (++loads===1) return free; return new Promise(resolve=>{resolveOld=resolve;}); }, open:async()=>{}, onError:e=>{throw e;}});
 await new Promise(resolve=>setImmediate(resolve)); assert.match(doc.body.textContent,/请使用邮件/);
 dom.window.dispatchEvent(new dom.window.Event('focus')); await new Promise(resolve=>setImmediate(resolve));
 const current = mountBillingCard({...setting}, {connected:true, live:()=>true, now:()=>at, target:dom.window, load:async()=>free, open:async()=>{}, onError:e=>{throw e;}});
 await new Promise(resolve=>setImmediate(resolve)); resolveOld(free); await new Promise(resolve=>setImmediate(resolve));
 old();
 assert.equal(doc.querySelectorAll('.smart-sync-plan-title').length,1); assert.equal(doc.querySelectorAll('.smart-sync-plan-expiry').length,1); assert.equal(doc.querySelectorAll('button').length,1);
 assert.equal((doc.body.textContent.match(/免费 · 100MB/g)||[]).length,1); assert.equal((doc.body.textContent.match(/开通日期/g)||[]).length,1); assert.doesNotMatch(doc.body.textContent,/请使用邮件/); assert.match(doc.body.textContent,/已用 0 B/);
 current(); assert.equal(doc.querySelectorAll('.smart-sync-plan-title').length,0); assert.equal(doc.body.textContent,'我的套餐'); dom.window.close();
});
test('upgrading a free account replaces its card with only the current 5GB plan', async () => {
 const dom = new JSDOM('<div id="setting"><div id="info"></div><div id="controls"></div></div>', {pretendToBeVisual:true}),doc = dom.window.document;
 const setting = {settingEl:doc.querySelector('#setting'),infoEl:doc.querySelector('#info'),controlEl:doc.querySelector('#controls'),setName(){}};
 const free={entitlement:{plan:'cn-free',paid:false,logical:100*1024**2,starts:at},usage:{logicalBytes:0}};
 const options={connected:true,live:()=>true,now:()=>at,target:dom.window,open:async()=>{},onError:e=>{throw e;}};
 const old=mountBillingCard(setting,{...options,load:async()=>free});await new Promise(resolve=>setImmediate(resolve));assert.match(doc.body.textContent,/免费 · 100MB/);
 const dispose=mountBillingCard({...setting},{...options,load:async()=>paid(Date.UTC(2027,9,23))});await new Promise(resolve=>setImmediate(resolve));old();
 assert.equal(doc.querySelectorAll('.smart-sync-plan-title').length,1);assert.equal(doc.querySelector('.smart-sync-plan-title').textContent,'当期套餐：5GB 年付');assert.doesNotMatch(doc.body.textContent,/免费|100MB|开通日期|登录信息/);assert.match(doc.body.textContent,/到期时间/);assert.match(doc.body.textContent,/5 GB/);assert.equal(doc.querySelector('button').hidden,true);
 dispose();dom.window.close();
});
test('purchase and renewal states use one calendar month, including short months and expired plans', () => {
	assert.equal(billingCard(undefined, false, at).label, '购买');
	for (const connected of [false, true]) {
		const unpaid = billingCard({entitlement:{paid:false,logical:10*gb},usage:{logicalBytes:0}}, connected, at);
		assert.equal(unpaid.prominent, true); assert.equal(unpaid.usage, ''); assert.equal(unpaid.ratio, null);
		assert.equal(unpaid.title, ''); assert.equal(unpaid.help, ''); assert.equal(unpaid.badge, '');
	}
	const signedOut = billingCard(paid(Date.UTC(2027,0,1)), false, at);
	assert.equal(signedOut.usage, ''); assert.equal(signedOut.ratio, null);
	const pending = billingCard({entitlement:{paid:false,logical:10*gb},currentOrder:{id:'a'.repeat(32),title:'10GB',status:'pending',purpose:'purchase'}},true,at);
	assert.match(billingCard({currentOrder:{status:'paid',failureCode:'paid_plan_conflict'}},false,at).order,/待核对/);
	assert.equal(pending.order,'等待付款'); assert.equal(pending.title,''); assert.equal(pending.usage,''); assert.equal(pending.label,'购买'); assert.equal(pending.resume,'a'.repeat(32));
	const active = billingCard({...paid(Date.UTC(2027,0,1)),currentOrder:{title:'5GB',status:'paid',purpose:'purchase'}}, true, at);
	assert.equal(active.order, '');
	assert.equal(active.label, '续费'); assert.equal(active.prominent, false); assert.equal(active.title, '当期套餐：5GB 年付'); assert.equal(active.ratio, .24);
	assert.match(active.usage, /1.2.*5/);
	assert.equal(billingCard(paid(Date.UTC(2026,10,22)), true, at).prominent, true);
	assert.equal(renewalReminderAt(Date.UTC(2027,2,31)), Date.UTC(2027,1,28));
	assert.equal(renewalReminderAt(Date.UTC(2028,2,31)), Date.UTC(2028,1,29));
	const expired = billingCard({everPurchased:true,entitlement:{paid:false,ends:at-1},lastPurchase:{plan:'cn-5gb-year',logical:5*gb,ends:at-1}}, true, at);
	assert.equal(expired.label, '续费'); assert.equal(expired.badge, '已到期'); assert.equal(expired.prominent, true);
	const refunded = billingCard({everPurchased:true,entitlement:{paid:false},lastPurchase:{plan:'cn-5gb-year',status:'refunded',ends:at+86400000}},true,at);
	assert.equal(refunded.badge,'已退款'); assert.equal(refunded.expires,''); assert.equal(refunded.prominent,true);
	assert.equal(billingCard({...paid(at+1),usage:{logicalBytes:null}}, true, at).ratio, null);
	assert.match(billingCard({currentOrder:{title:'联调',purpose:'test',status:'paid'}}, true, at).order, /权益未改变/);
});
test('the mounted purchase action opens plans despite a pending order, refreshes on return and discards responses after identity change/disposal', async () => {
	const dom = new JSDOM('<div id="setting"><div id="info"></div><div id="controls"></div></div>', {pretendToBeVisual:true});
	const doc = dom.window.document;
	const setting = {settingEl:doc.querySelector('#setting'),infoEl:doc.querySelector('#info'),controlEl:doc.querySelector('#controls'),setName() {}};
	let live = true, calls = 0, resolve, opened = 'not-called';
	const value = {...paid(Date.UTC(2026,10,10)),currentOrder:{id:'a'.repeat(32),title:'5GB',status:'pending'}};
	const dispose = mountBillingCard(setting, {connected:true,live:()=>live,now:()=>at,target:dom.window,
		load:async()=>{calls++; if(calls===1) return value; return new Promise(done=>{resolve=done;});}, open:async id=>{opened=id;},onError:error=>{throw error;}});
	await new Promise(done=>setImmediate(done));
	const button = doc.querySelector('button'); assert.equal(button.textContent, '续费'); assert.equal(button.classList.contains('is-prominent'), true);
	button.click(); await new Promise(done=>setImmediate(done)); assert.equal(opened, undefined); assert.equal(calls,2);
	live = false; resolve({entitlement:{paid:false}}); await new Promise(done=>setImmediate(done)); assert.equal(button.textContent,'续费');
	dispose(); dom.window.dispatchEvent(new dom.window.Event('focus')); assert.equal(calls,2);
	assert.doesNotMatch(doc.body.textContent, /订单记录|刷新套餐|压缩|逻辑/); dom.window.close();
});


test('renewal action is hidden for a healthy plan and uses the purchase CTA within one calendar month', async () => {
    for (const [ends,visible] of [[Date.UTC(2027,0,1),false],[Date.UTC(2026,10,22),true],[at-1,true]]) {
        const dom=new JSDOM('<div id="setting"><div id="info"></div><div id="controls"></div></div>',{pretendToBeVisual:true}),doc=dom.window.document;
        const setting={settingEl:doc.querySelector('#setting'),infoEl:doc.querySelector('#info'),controlEl:doc.querySelector('#controls'),setName(){}};
        const dispose=mountBillingCard(setting,{connected:true,live:()=>true,now:()=>at,target:dom.window,load:async()=>paid(ends),open:async()=>{},onError:error=>{throw error;}});
        await new Promise(done=>setImmediate(done));const button=doc.querySelector('button');
        assert.equal(button.hidden,!visible);assert.equal(button.classList.contains('is-prominent'),visible);assert.equal(button.textContent,'续费');
        dispose();dom.window.close();
    }
});


test('current and scheduled packages are distinct in the account card',()=>{
    const value=paid(Date.UTC(2028,9,22));value.entitlement.upcoming={plan:'cn-20gb-year',starts:Date.UTC(2027,9,22)};
    const card=billingCard(value,true,at);assert.equal(card.title,'当期套餐：5GB 年付');assert.match(card.upcoming,/20GB 年付/);assert.match(card.upcoming,/生效/);
});


test('returning after paid renewal refreshes both package rows and the extended expiry',async()=>{
 const dom=new JSDOM('<div id="setting"><div id="info"></div><div id="controls"></div></div>',{pretendToBeVisual:true}),doc=dom.window.document;
 const setting={settingEl:doc.querySelector('#setting'),infoEl:doc.querySelector('#info'),controlEl:doc.querySelector('#controls'),setName(){}};
 const boundary=Date.UTC(2026,10,10),renewed=Date.UTC(2027,10,10);let value=paid(boundary);
 const dispose=mountBillingCard(setting,{connected:true,live:()=>true,now:()=>at,target:dom.window,load:async()=>value,open:async()=>{},onError:e=>{throw e;}});
 try{
  await new Promise(done=>setImmediate(done));assert.equal(doc.querySelector('button').hidden,false);
  value={...paid(renewed),entitlement:{...paid(renewed).entitlement,upcoming:{plan:'cn-20gb-year',starts:boundary}}};
  dom.window.dispatchEvent(new dom.window.Event('focus'));await new Promise(done=>setImmediate(done));
  const current=doc.querySelector('.smart-sync-plan-title');assert.equal(current.textContent,'当期套餐：5GB 年付');assert.match(current.nextElementSibling.textContent,/下期套餐：20GB 年付/);
  assert.match(doc.querySelector('.smart-sync-plan-expiry').textContent,/2027/);assert.equal(doc.querySelector('button').hidden,true);
 }finally{dispose();dom.window.close();}
});


test('a paid renewal never asks a returning purchase session to use login mail',()=>{
 const value={...paid(Date.UTC(2028,9,22)),lastPurchase:{status:'paid',renewal:true}};
 for(const connected of [false,true]){const card=billingCard(value,connected,at);assert.match(card.help,/续费成功/);assert.doesNotMatch(card.help,/邮件|请使用|登录信息登录/);}
});


test('free card shows 100MB, opening date only and a prominent purchase-more action below',async()=>{
 const value={entitlement:{plan:'cn-free',paid:false,logical:100*1024**2,starts:at,ends:null},usage:{logicalBytes:50*1024**2}};
 const card=billingCard(value,true,at+60*86400000);assert.equal(card.title,'免费 · 100MB');assert.equal(card.label,'购买更多额度');assert.equal(card.prominent,true);assert.match(card.expires,/开通日期/);assert.equal(card.ratio,.5);assert.doesNotMatch(card.help+card.expires,/体验|到期|永久|不限时间|14天/);
 const dom=new JSDOM('<div id="setting"><div id="info"></div><div id="controls"></div></div>',{pretendToBeVisual:true}),doc=dom.window.document;
 const setting={settingEl:doc.querySelector('#setting'),infoEl:doc.querySelector('#info'),controlEl:doc.querySelector('#controls'),setName(){}};let opened=0;
 const dispose=mountBillingCard(setting,{connected:true,live:()=>true,now:()=>at,target:dom.window,load:async()=>value,open:async()=>{opened++;},onError:e=>{throw e;}});
 try{await new Promise(done=>setImmediate(done));assert.equal(setting.settingEl.classList.contains('is-free'),true);assert.equal(doc.querySelector('button').textContent,'购买更多额度');doc.querySelector('button').click();await new Promise(done=>setImmediate(done));assert.equal(opened,1);}finally{dispose();dom.window.close();}
});

test('an active subscription hides unrelated unfinished orders but preserves payment polling', () => {
 const card = billingCard({...paid(Date.UTC(2027,0,1)),currentOrder:{id:'another',title:'5GB',status:'pending',purpose:'purchase'}},true,at);
 assert.equal(card.badge,'已开通'); assert.equal(card.title,'当期套餐：5GB 年付');
 assert.equal(card.order,'');
 for (const status of ['creating','pending','uncertain']) assert.equal(billingCard({...paid(Date.UTC(2027,0,1)),currentOrder:{status,purpose:'purchase'}},true,at).order,'');
 assert.match(billingCard({...paid(Date.UTC(2027,0,1)),currentOrder:{status:'paid',failureCode:'paid_plan_conflict'}},true,at).order,/待核对/);
 assert.match(billingCard({...paid(at-1),currentOrder:{status:'pending'}},true,at).order,/等待付款/);
 assert.equal(card.resume,'another');
});

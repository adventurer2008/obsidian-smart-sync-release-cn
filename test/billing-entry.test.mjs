import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerHooks } from 'node:module';
globalThis.window = { open() {} };
registerHooks({ resolve(specifier, context, next) {
    return specifier === 'obsidian' ? { url: new URL('./obsidian-double.mjs', import.meta.url).href, shortCircuit: true } : next(specifier, context);
} });
globalThis.__SMART_SYNC_EDITION__ = { edition: 'cn', development: true, stagingOrigin: 'http://127.0.0.1:24819' };
const { default: Plugin } = await import('../src/plugin.js');

test('Alpha purchase action uses authenticated real billing at the new pay origin', async () => {
    const opened=[]; window.open=(...args)=>opened.push(args);
    const plugin={data:{localId:'synthetic',settings:{origin:'https://sync.wujiesync.cc'}},manifest:{version:'1.1.2-alpha.8'},stopped:false,
        secret:()=> 'synthetic-key',accountApi:async()=>({request:async()=>({url:'https://sync.wujiesync.cc/pay/plans#ticket='+'b'.repeat(43)})})};
    await Plugin.prototype.openBilling.call(plugin);
    assert.deepEqual(opened,[['https://pay.wujiesync.cc/pay/plans#ticket='+'b'.repeat(43),'_blank','noopener,noreferrer']]);
    plugin.stopped=true;await Plugin.prototype.openBilling.call(plugin);
    assert.equal(opened.length,1);
});

test('Alpha existing orders use the new pay origin with the original authenticated ticket', async () => {
    const opened=[];window.open=(...args)=>opened.push(args);
    const order='a'.repeat(32),ticket='b'.repeat(43);
    const plugin={data:{localId:'synthetic',settings:{origin:'https://sync.wujiesync.cc'}},manifest:{version:'1.1.2-alpha.8'},secret:()=> 'synthetic-key',
        accountApi:async()=>({request:async(method,path,body)=>{assert.equal(path,'billing/entry');assert.deepEqual(body,{orderId:order});return {url:'https://sync.wujiesync.cc/pay/checkout/'+order+'#ticket='+ticket};}})};
    await Plugin.prototype.openBilling.call(plugin,order);
    assert.equal(opened[0][0],'https://pay.wujiesync.cc/pay/checkout/'+order+'#ticket='+ticket);
});

test('guest entry opens plans directly and keeps its scoped handoff while the browser collects matching emails', async () => {
    const opened = []; window.open = url => opened.push(url);
    const secrets = new Map(), origin = 'http://127.0.0.1:43519';
    let requests = 0;
    const plugin = { data:{localId:'guest',settings:{origin}}, manifest:{id:'wujie-sync'},
        app:{secretStorage:{setSecret:(key,value)=>secrets.set(key,value)}},
        secret:name=>secrets.get('wujie-sync-guest-'+name)??'',
        purchaseSession:()=>Plugin.prototype.purchaseSession.call(plugin),
        workspaceApi:()=>({origin,request:async()=>{requests++;throw Object.assign(Error('not registered yet'),{status:401});}}) };
    await Plugin.prototype.openBilling.call(plugin);
    assert.equal(requests,0); assert.match(opened[0],/^http:\/\/127\.0\.0\.1:43519\/plans#register=[A-Za-z0-9_-]{43}$/);
    const capability = plugin.purchaseSession().capability;
    assert.equal(await Plugin.prototype.billingSummary.call(plugin),undefined);
    assert.equal(plugin.purchaseSession().capability,capability);
    await Plugin.prototype.openBilling.call(plugin);
    assert.equal(opened[1],opened[0]); assert.equal(requests,2);
});

test('purchase entry uses account auth, pins HTTPS origin and never opens a late response for another account', async () => {
    const opened = []; window.open = (...args) => opened.push(args);
    let key = 'synthetic-key', next;
    const api = { origin: 'https://sync.example.invalid', request: async (method, path, body) => {
        assert.equal(method, 'POST'); assert.equal(path, 'billing/entry'); assert.deepEqual(body, {});
        return next();
    } };
    const plugin = { data: { localId: 'one', settings: { origin: api.origin } }, secret: () => key, accountApi: async () => api };
    next = async () => ({ url: 'https://sync.wujiesync.cc/pay/plans#ticket=' + 'a'.repeat(43) });
    await Plugin.prototype.openBilling.call(plugin, true);
    assert.equal(opened[0][0], 'https://pay.wujiesync.cc/pay/orders#ticket=' + 'a'.repeat(43));
    assert.equal(opened[0][2], 'noopener,noreferrer');
    next = async () => ({ url: 'https://untrusted.example.invalid/plans#ticket=' + 'a'.repeat(43) });
    await assert.rejects(Plugin.prototype.openBilling.call(plugin), /Invalid purchase entry/);
    next = async () => ({ url: 'https://sync.wujiesync.cc/pay/plans?extra=1#ticket=' + 'a'.repeat(43) });
    await assert.rejects(Plugin.prototype.openBilling.call(plugin), /Invalid purchase entry/);
    next = async () => { key = 'changed-account'; return { url: 'https://sync.wujiesync.cc/pay/plans#ticket=' + 'b'.repeat(43) }; };
    await Plugin.prototype.openBilling.call(plugin);
    assert.equal(opened.length, 1);
});

test('purchase entry isolates local simulation, staging and production origins', async () => {
    const opened = []; window.open = url => opened.push(url);
    for (const [origin, purchase] of [
        ['http://127.0.0.1:42560', 'http://127.0.0.1:42560'],
        ['http://127.0.0.1:24819', 'https://sync.wujiesync.cc/pay-test'],
        ['https://sync.wujiesync.cc', 'https://pay.wujiesync.cc/pay'],
    ]) {
        let destination = purchase;
        const plugin = { data: { localId: 'synthetic', settings: { origin } }, secret: () => 'synthetic',
            accountApi: async () => ({ origin, request: async () => ({ url: destination + '/plans#ticket=' + 'a'.repeat(43) }) }) };
        await Plugin.prototype.openBilling.call(plugin);
        assert.equal(opened.at(-1), purchase + '/plans#ticket=' + 'a'.repeat(43));
        destination = purchase === 'https://pay.wujiesync.cc/pay' ? 'https://sync.wujiesync.cc/pay-test' : 'https://pay.wujiesync.cc/pay';
        await assert.rejects(Plugin.prototype.openBilling.call(plugin), /Invalid purchase entry/);
    }
});


test('CN historical access command routes to plan opening, with no signup form or application request',async()=>{
 let opened=0;
 const plugin={openBilling:async()=>{opened++;return 'plans';},workspaceApi:()=>assert.fail('no manual application request')};
 assert.equal(await Plugin.prototype.requestAccess.call(plugin),'plans');assert.equal(opened,1);
});

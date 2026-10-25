import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerHooks } from 'node:module';

globalThis.window = {};
registerHooks({ resolve(specifier, context, next) {
    return specifier === 'obsidian' ? { url: new URL('./obsidian-double.mjs', import.meta.url).href, shortCircuit: true } : next(specifier, context);
} });
const { default: Plugin } = await import('../src/plugin.js');

function fixture() {
    const calls = [];
    const secrets = {};
    const plugin = { app: {}, data: { localId: 'guest', settings: { origin: 'https://sync.example.invalid', workspace: '', direction: 'both' } },
        secret: name => secrets[name] ?? '',
        openBilling: async () => calls.push('purchase'), enrollment: async () => calls.push('login'),
        synchronize: async () => calls.push('sync'), warnCapacity: async () => calls.push('capacity') };
    plugin.synchronizeManually = () => Plugin.prototype.synchronizeManually.call(plugin);
    return { plugin, calls, secrets, clickSync: () => Plugin.prototype.requestSynchronization.call(plugin) };
}

test('first-use Sync now immediately offers purchase and login, without network or synchronization', async () => {
    for (const [index, expected] of [[0, 'purchase'], [1, 'login']]) {
        const f = fixture(), dialog = await f.clickSync();
        assert.equal(dialog.title, '请先开通套餐');
        assert.match(dialog.contentEl.children[0].text, /购买.*开通.*登录/);
        assert.deepEqual(dialog.contentEl.settings.map(row => row.controls[0].text), ['购买', '已有账号登录']);
        assert.deepEqual(f.calls, []);
        assert.equal(await f.clickSync(), dialog);
        const click = dialog.contentEl.settings[index].controls[0].click;
        await click(); await click();
        assert.deepEqual(f.calls, [expected]);
        assert.equal(f.plugin.syncSetupWindow, undefined);
    }
});

test('dismissed or stale setup actions cannot open purchase or login', async () => {
    for (const change of [f => f.secrets.account = 'new-account', f => f.secrets.access = 'new-device',
        f => f.plugin.data.settings.workspace = 'connected', f => f.plugin.data.settings.origin = 'https://other.example.invalid',
        f => f.plugin.data.localId = 'other', f => f.plugin.stopped = true, f => f.plugin.connecting = true,
        f => f.plugin.syncSetupWindow.close()]) {
        const f = fixture(), dialog = await f.clickSync();
        const click = dialog.contentEl.settings[0].controls[0].click;
        change(f); await click(); assert.deepEqual(f.calls, []);
    }
});

test('signed-in and paired users retain manual synchronization, including free plans; stopped entry stays quiet', async () => {
    for (const name of ['account', 'access']) {
        const f = fixture(); f.secrets[name] = 'synthetic';
        await f.clickSync(); assert.deepEqual(f.calls, ['sync']);
        f.calls.length = 0; f.plugin.data.settings.workspace = 'connected';
        await f.clickSync(); assert.deepEqual(f.calls, ['capacity', 'sync']);
    }
    const f = fixture(); f.plugin.stopped = true;
    await f.clickSync(); assert.deepEqual(f.calls, []);
});

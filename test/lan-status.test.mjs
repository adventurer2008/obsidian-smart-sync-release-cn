import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, next) {
    return specifier === 'obsidian' ? { url: new URL('./obsidian-double.mjs', import.meta.url).href, shortCircuit: true } : next(specifier, context);
} });
globalThis.window ??= globalThis;
const { default: Plugin } = await import('../src/plugin.js');

test('LAN overview shows state only while connection details retain measured payloads', () => {
    const plugin = { data: { settings: { workspace: 'synthetic', lanAcceleration: true } } };
    const summary = (details = false) => Plugin.prototype.lanSummary.call(plugin, details);
    assert.match(summary(), /暂无直连，使用云端/);
    plugin.lanPeers = { snapshot: () => ({ supported: true, connected: 2, receivedBytes: 1024, sentBytes: 2048, cloudBytes: 4096, fallbacks: 3 }) };
    assert.match(summary(), /已直连 2 台设备/);
    assert.doesNotMatch(summary(), /KB|回退|已收/);
    const text = summary(true);
    assert.match(text, /已直连 2 台设备/); assert.match(text, /已收 1 KB、已发 2 KB/);
    assert.match(text, /云端已收 4 KB/); assert.match(text, /回退 3 次/);
    plugin.data.settings.lanAcceleration = false; assert.match(summary(), /已关闭/);
    plugin.data.settings.workspace = ''; assert.match(summary(), /尚未连接/);
});

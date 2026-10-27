import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerHooks } from 'node:module';
import { sampleVaultSize, LanPeers } from '../src/peers.js';
globalThis.window = globalThis;
registerHooks({ resolve(specifier, context, next) {
 return specifier === 'obsidian' ? { url: new URL('./obsidian-double.mjs', import.meta.url).href, shortCircuit: true } : next(specifier, context);
} });
const { default: Plugin } = await import('../src/plugin.js');

test('local size uses only SDK file metadata including attachments and empty vaults', () => {
 const vault = { getFiles: () => [{ path: 'note.md', stat: { size: 23 } }, { path: 'asset.bin', stat: { size: 2048 } }], read: () => assert.fail('no body reads') };
 assert.deepEqual(sampleVaultSize(vault, 123), { bytes: 2071, sampledAt: 123 });
 assert.deepEqual(sampleVaultSize({ getFiles: () => [] }, 123), { bytes: 0, sampledAt: 123 });
 for (const size of [undefined, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])
  assert.equal(sampleVaultSize({ getFiles: () => [{ stat: { size } }] }), undefined);
 assert.equal(sampleVaultSize({ getFiles: () => [{ stat: { size: Number.MAX_SAFE_INTEGER } }, { stat: { size: 1 } }] }), undefined);
 assert.equal(sampleVaultSize({ getFiles() { throw Error('unavailable'); } }), undefined);
});

test('size report accompanies presence even with LAN disabled and paused remote mode', async () => {
 const requests = [];
 const peers = new LanPeers({ workspace: 'synthetic', request: async (...args) => {
  requests.push(args); return { id: 'one', mode: 'paused', peers: [] };
 } }, { enabled: false, vaultUsage: () => ({ bytes: 0, sampledAt: 123 }) });
 try {
  await peers.tick();
  assert.deepEqual(requests, [['POST', 'device-presence', { workspace: 'synthetic', vaultUsage: { bytes: 0, sampledAt: 123 } }]]);
 } finally { peers.close(); }
});

test('device dialog shows online and offline samples, zero and missing data; refresh reports only current device', async () => {
 const sampledAt = Date.now() - 120000, calls = [];
 const api = { workspace: 'synthetic', request: async (method, path, body) => {
  calls.push({ method, path, body });
  if (path === 'account') return { scope: 'synthetic', deviceId: 'current' };
  if (path.startsWith('devices?')) return { entries: [
   { id: 'current', label: 'Windows', online: true, vaultUsage: { bytes: 1024, sampledAt } },
   { id: 'offline', label: 'iPad', online: false, vaultUsage: { bytes: 2048, sampledAt } },
   { id: 'zero', label: 'Empty', vaultUsage: { bytes: 0, sampledAt } },
   { id: 'legacy', label: 'Legacy' },
  ] };
  return {};
 } };
 const plugin = { app: { vault: { getFiles: () => [{ stat: { size: 512 } }] } }, api: () => api,
  ensureCurrent: () => {}, updateDeviceLabel: async () => {}, abortController: new AbortController() };
 const dialog = await Plugin.prototype.devices.call(plugin);
 try {
  const list = dialog.contentEl.children.find(child => child.children.some(row => row.children.some(p => p.text.includes('Windows'))));
  const texts = list.children.map(row => row.children.filter(child => child.tag === 'p').map(child => child.text).join(' '));
  assert.match(texts[0], /库大小：1 KB.*统计/);
  assert.doesNotMatch(texts[0], /活跃/);
  assert.equal((texts[0].match(/统计/g) ?? []).length, 1);
  assert.match(texts[1], /离线.*库大小：2 KB.*统计/);
  assert.match(texts[2], /库大小：0 B.*统计/);
  assert.match(texts[3], /库大小：暂无数据/);
  assert.equal(calls.filter(row => row.path === 'device-presence').length, 1);
  assert.equal(calls.find(row => row.path === 'device-presence').body.vaultUsage.bytes, 512);
 } finally { dialog.close(); }
});

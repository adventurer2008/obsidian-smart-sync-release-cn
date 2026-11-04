import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, next) { return specifier === 'obsidian' ? { url: new URL('./obsidian-double.mjs', import.meta.url).href, shortCircuit: true } : next(specifier, context); } });
globalThis.window = globalThis;
const { default: Plugin } = await import('../src/plugin.js');
const { modals } = await import('./obsidian-double.mjs');
function fixture(request) {
  const plugin = new Plugin({}, { id: 'wujie-sync', version: '1.1.2-alpha.1' });
  const api = { origin: 'https://example.invalid', accessKey: 'synthetic', request,
    workspaces: async () => ({ workspaces: ['a', 'b', 'c'].map(id => ({ id, label: id })) }) };
  Object.assign(plugin, { data: { localId: 'synthetic', settings: { origin: api.origin, workspace: 'a' } },
    secret: () => 'synthetic', accountApi: async () => api, workspaceDisplayName: w => w.label });
  return plugin;
}
test('notebook summaries preserve current marker, distinguish zero from unknown and isolate failures', async () => {
  const calls = [];
  const plugin = fixture(async (method, route) => {
    calls.push([method, route]);
    if (route.includes('/a/')) return { logicalBytes: 0 };
    if (route.includes('/b/')) throw Error('synthetic unavailable');
    return { logicalBytes: 1024 ** 3 };
  });
  const dialog = await plugin.manageNotebooks(), rows = dialog.contentEl.settings.filter(row => ['a', 'b', 'c'].includes(row.name));
  assert.equal(rows.length, 3);
  assert.match(rows[0].desc, /当前连接.*云端容量：0 B/);
  assert.equal(rows[1].desc, '云端容量：暂不可用');
  assert.equal(rows[2].desc, '云端容量：1 GB');
  assert.ok(calls.every(([method, route]) => method === 'GET' && route.endsWith('/usage?summary=1')));
  dialog.close();
});
test('a late capacity response cannot update a closed dialog or continue requests', async () => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  let calls = 0;
  const plugin = fixture(async () => { calls++; entered(); return new Promise(resolve => { release = resolve; }); });
  const loading = plugin.manageNotebooks();
  await started;
  const dialog = modals.at(-1), row = dialog.contentEl.settings.find(row => row.name === 'a'), before = row.desc;
  dialog.close();
  release({ logicalBytes: 1024 ** 3 });
  await loading;
  assert.equal(row.desc, before);
  assert.equal(calls, 1);
  assert.equal(dialog.contentEl.settings.length, 0);
});

test('account changes discard pending capacity responses and stop subsequent library requests',async()=>{
 let entered,release,key='synthetic',calls=0;const started=new Promise(resolve=>{entered=resolve;});
 const plugin=fixture(async()=>{calls++;entered();return new Promise(resolve=>{release=resolve;});});plugin.secret=()=>key;
 const loading=plugin.manageNotebooks();await started;
 const dialog=modals.at(-1),row=dialog.contentEl.settings.find(row=>row.name==='a'),before=row.desc;
 key='another-account';release({logicalBytes:1024**3});await loading;
 assert.equal(row.desc,before);assert.equal(calls,1);dialog.close();
});
test('refreshing while capacity is pending cannot update detached rows with old results',async()=>{
 let entered,release,first=true;const started=new Promise(resolve=>{entered=resolve;});
 const plugin=fixture(async()=>{if(first){first=false;entered();return new Promise(resolve=>{release=resolve;});}return {logicalBytes:1024**3};});
 const initial=plugin.manageNotebooks();await started;
 const dialog=modals.at(-1),oldRow=dialog.contentEl.settings.find(row=>row.name==='a'),before=oldRow.desc;
 const refresh=dialog.contentEl.settings.flatMap(row=>row.controls).find(control=>control.text==='刷新笔记库列表');
 await refresh.click();release({logicalBytes:999});await initial;
 assert.equal(oldRow.desc,before);const current=dialog.contentEl.settings.find(row=>row.name==='a');assert.match(current.desc,/1 GB/);
 dialog.close();
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerHooks } from 'node:module';
import { syntheticApp, modals } from './obsidian-double.mjs';

globalThis.window = { setInterval, clearInterval, setTimeout, clearTimeout };
globalThis.__SMART_SYNC_EDITION__ = { edition: 'global', id: 'smart-sync-global', name: 'Smart Sync', locale: 'en', development: false, serviceOrigin: 'https://sync.smartsync.cc' };
registerHooks({ resolve(specifier, context, next) {
 return specifier === 'obsidian' ? { url: new URL('./obsidian-double.mjs', import.meta.url).href, shortCircuit: true } : next(specifier, context);
} });
const { default: Plugin } = await import('../src/plugin.js');
const { WorkspaceApi } = await import('../src/client.js');
const { freshSalt, unlockWorkspace, workspaceProof } = await import('../src/codec.js');

test('lost creation response survives plugin restart with the same identifier and encrypted vault password', async () => {
 const stored=new Map(),calls=[],keys=await unlockWorkspace('synthetic-account-password',freshSalt());
 const context={keys,owner:'owner',localId:'local',origin:'https://sync.smartsync.cc'};
 const api={origin:context.origin,create:async(...input)=>{calls.push(input);if(calls.length===1)throw new TypeError('Lost reply');return{id:input[4].workspace,salt:input[1],proof:input[2]};}};
 const plugin=()=>({checkAccountEncryption(){},secret:name=>stored.get(name)||'',setSecret:(name,value)=>stored.set(name,value),creationDeviceName:()=> 'Synthetic device'});
 await assert.rejects(Plugin.prototype.createAccountWorkspace.call(plugin(),api,'Retry vault',context),TypeError);
 const pending=JSON.parse(stored.get('create'));
 await assert.rejects(Plugin.prototype.createAccountWorkspace.call(plugin(),api,'Different vault',context),{code:'CREATE_PENDING'});
 const restored=await Plugin.prototype.createAccountWorkspace.call(plugin(),api,'Retry vault',context);
 assert.deepEqual(calls[1],calls[0]);assert.equal(restored.workspace.id,pending.wrapped.workspace);assert.equal(restored.password,pending.password);
 assert.equal(stored.size,1);
 stored.set('create','{broken');
 await assert.rejects(Plugin.prototype.createAccountWorkspace.call(plugin(),api,'Retry vault',context),{code:'CREATE_PENDING'});
 stored.set('create',JSON.stringify({...pending,wrapped:{}}));
 await assert.rejects(Plugin.prototype.createAccountWorkspace.call(plugin(),api,'Retry vault',context),{code:'CREATE_PENDING'});
});

test('Global first vault connection stores encryption using a real UUID within host secret-ID limits and survives reload', async context => {
 const app = syntheticApp(), manifest = { id: 'smart-sync-global', version: '1.1.4' };
 const plugin = new Plugin(app, manifest);
 await plugin.onload(); context.after(() => plugin.dispose());
 assert.equal(plugin.data.localId.length, 36);
 const password = 'synthetic-encryption-password', salt = freshSalt();
 const workspace = { id: crypto.randomUUID(), salt, proof: await workspaceProof(await unlockWorkspace(password, salt)) };
 const accountKey = 'a'.repeat(43), deviceKey = 'd'.repeat(43);
 const transport = async (url, options) => {
  const path = new URL(url).pathname;
  if (path === '/ss2/account') return Response.json({ owner: 'synthetic-owner', scope: options.headers.authorization === `Bearer ${deviceKey}` ? workspace.id : null });
  if (path === '/ss2/session') return Response.json({ key: deviceKey });
  if (path === `/ss2/workspaces/${workspace.id}`) return Response.json(workspace);
  throw Error('Unexpected connection route');
 };
 plugin.workspaceApi = (origin, key, scope) => new WorkspaceApi(origin, key, scope, transport);
 plugin.setSecret('create',JSON.stringify({origin:'https://sync.smartsync.cc',wrapped:{workspace:workspace.id}}));
 await plugin.connectWorkspace(plugin.workspaceApi('https://sync.smartsync.cc', accountKey), workspace, password);
 assert.equal(plugin.secret('create'),'');
 assert.equal(plugin.secret('encryption'), password);
 assert.equal(plugin.secret('account'), accountKey);
 assert.equal(plugin.secret('access'), deviceKey);
 assert.equal(plugin.persisted.settings.workspace, workspace.id);
 const restored = new Plugin(app, manifest);
 restored.persisted = structuredClone(plugin.persisted);
 await restored.onload(); context.after(() => restored.dispose());
 assert.equal(restored.secret('encryption'), password);
 restored.setSecret('encryption', 'replacement-synthetic-password');
 assert.equal(restored.secret('encryption'), 'replacement-synthetic-password');
 assert.equal(restored.secret('account'), accountKey);
 const other = new Plugin(app, manifest);
 other.data = { localId: crypto.randomUUID() };
 assert.equal(other.secret('encryption'), '');
 await restored.detachDeletedNotebook(workspace.id);
 assert.equal(restored.secret('encryption'), '');
 assert.equal(restored.secret('account'), accountKey);
 assert.equal(restored.persisted.settings.workspace, '');
});

test('pending creation cleanup preserves other origins and vaults and tolerates malformed state', () => {
 const plugin = new Plugin(syntheticApp(), { id: 'smart-sync-global' });
 plugin.data = { localId: crypto.randomUUID() };
 const origin = 'https://sync.smartsync.cc';
 const pending = JSON.stringify({ origin, wrapped: { workspace: 'target' } });
 plugin.setSecret('create', pending);
 plugin.clearPendingCreation('other', origin);
 assert.equal(plugin.secret('create'), pending);
 plugin.clearPendingCreation('target', 'https://staging-sync.smartsync.cc');
 assert.equal(plugin.secret('create'), pending);
 plugin.clearPendingCreation('target', 'invalid');
 assert.equal(plugin.secret('create'), pending);
 plugin.setSecret('create', '{broken');
 assert.doesNotThrow(() => plugin.clearPendingCreation('target', origin));
 plugin.setSecret('create', pending);
 plugin.clearPendingCreation('target', origin);
 assert.equal(plugin.secret('create'), '');
});

test('China keeps its existing encryption secret identifier', () => {
 const app = syntheticApp(), plugin = new Plugin(app, { id: 'wujie-sync' });
 plugin.data = { localId: crypto.randomUUID() };
 const legacyId = `wujie-sync-${plugin.data.localId}-encryption`;
 app.secretStorage.setSecret(legacyId, 'existing-synthetic-password');
 assert.equal(plugin.secret('encryption'), 'existing-synthetic-password');
 plugin.setSecret('encryption', 'updated-synthetic-password');
 assert.equal(app.secretStorage.getSecret(legacyId), 'updated-synthetic-password');
});

test('Continue after a successful create and failed local connection reuses that vault', async () => {
 let creates = 0, connects = 0;
 const workspace = { id: crypto.randomUUID() }, context = { localId: 'synthetic' };
 const plugin = {
  app: {}, data: { settings: { workspace: '' } },
  withAccountEncryption: Plugin.prototype.withAccountEncryption,
  unlockAccountEncryption: async (api, password) => {
   if (!password) throw Object.assign(Error('Unlock'), { code: 'ACCOUNT_ENCRYPTION_LOCKED' });
   return context;
  },
  checkAccountEncryption: (api, value) => assert.equal(value, context),
  createAccountWorkspace: async () => { creates++; return { workspace, password: 'synthetic-vault-password' }; },
  connectWorkspace: async (api, value) => {
   assert.equal(value, workspace); connects++;
   if (connects === 1) throw Error('Local persistence failed');
  },
 };
 await Plugin.prototype.selectAccountWorkspace.call(plugin, {}, { close() {} }, []);
 await modals.at(-1).contentEl.settings[0].controls[0].click();
 const nameForm = modals.at(-1);
 nameForm.contentEl.settings[0].controls[0].change('Synthetic vault');
 await nameForm.contentEl.settings[1].controls[0].click();
 const unlockForm = modals.at(-1);
 unlockForm.contentEl.settings[0].controls[0].change('synthetic-account-password');
 const submit = unlockForm.contentEl.settings[1].controls[0];
 await submit.click(); assert.equal(creates, 1); assert.equal(connects, 1);
 await submit.click(); assert.equal(creates, 1); assert.equal(connects, 2);
});

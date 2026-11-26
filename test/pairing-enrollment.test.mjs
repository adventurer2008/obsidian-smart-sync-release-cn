import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { approvePairing, pairingFingerprint } from '../src/pairing.js';
import { modals, notices } from './obsidian-double.mjs';

registerHooks({ resolve(name, context, next) {
	return name === 'obsidian' ? { url: new URL('./obsidian-double.mjs', import.meta.url).href, shortCircuit: true } : next(name, context);
} });
globalThis.window = {};
const { default: Plugin } = await import('../src/plugin.js');
const workspace = '01234567-89ab-4def-0123-456789abcdef';
const origin = 'https://sync.example.invalid';
const code = '123456';

function fixture(t, applyConfiguration) {
	modals.length = notices.length = 0;
	const timers = new Set();
	const original = globalThis.window;
	globalThis.window = {
		setInterval() { const timer = Symbol(); timers.add(timer); return timer; },
		clearInterval(timer) { timers.delete(timer); },
	};
	t.after(() => { globalThis.window = original; });
	let clearRequest, sealed;
	const api = {
		origin, workspace,
		async request(method, endpoint, body) {
			switch (endpoint) {
				case 'pairing/start':
					clearRequest = { id: 'synthetic-pairing', code, claim: 'fixture-claim', expires: Date.now() + 60000, publicKey: body.publicKey };
					return clearRequest;
				case 'pairing/' + code:
					return clearRequest;
				case 'pairing/' + code + '/grant':
					return { id: 'synthetic-grant', publicKey: clearRequest.publicKey, key: 'x'.repeat(40) };
				case 'pairing/' + code + '/approve':
					sealed = body.sealed;
					return {};
				case 'pairing/claim':
					return { sealed };
				default:
					assert.fail(endpoint);
			}
		},
	};
	const plugin = Object.assign(Object.create(Plugin.prototype), {
		app: {}, data: { settings: { origin } },
		workspaceApi: () => api, pairingApi: candidate => candidate, registerInterval() {}, applyConfiguration,
	});
	const approve = async () => approvePairing(api, code, 'synthetic note password', await pairingFingerprint(clearRequest.publicKey));
	return { plugin, approve, timers };
}

const button = (modal, text) => modal.contentEl.settings
	.flatMap(row => row.controls).find(control => control.kind === 'button' && control.text === text);

async function openPairing(plugin, approve) {
	await plugin.enrollment();
	const connection = modals.at(-1);
	await button(connection, '使用六位代码配对').click();
	const pairing = modals.at(-1);
	assert.notEqual(pairing, connection);
	await approve();
	await button(pairing, '获取已批准的连接配置').click();
	const confirmation = modals.at(-1);
	confirmation.contentEl.settings.flatMap(row => row.controls).find(control => control.kind === 'toggle').setValue(true);
	return { connection, pairing, confirmation };
}

test('verified pairing closes the originating connection dialog only after configuration saves', async t => {
	let accept, notified;
	const saving = new Promise(resolve => { accept = resolve; });
	const started = new Promise(resolve => { notified = resolve; });
	const { plugin, approve, timers } = fixture(t, async config => {
		assert.equal(config.workspace, workspace);
		notified();
		await saving;
	});
	const { connection, pairing, confirmation } = await openPairing(plugin, approve);
	const click = button(confirmation, '应用已验证的配置').click();
	await started;
	assert.ok(connection.contentEl.settings.length > 0);
	assert.equal(timers.size, 1);
	accept();
	await click;
	for (const dialog of [connection, pairing, confirmation]) assert.equal(dialog.contentEl.settings.length, 0);
	assert.equal(timers.size, 0);
});

test('failed save and canceled confirmation keep the connection dialog available', async t => {
	const { plugin, approve, timers } = fixture(t, async () => { throw Error('synthetic save failure'); });
	const { connection, pairing, confirmation } = await openPairing(plugin, approve);
	await button(confirmation, '应用已验证的配置').click();
	assert.equal(notices.length, 1);
	assert.ok(button(connection, '使用六位代码配对'));
	assert.ok(button(confirmation, '应用已验证的配置'));
	confirmation.close();
	pairing.close();
	assert.ok(button(connection, '使用六位代码配对'));
	assert.equal(timers.size, 0);
});

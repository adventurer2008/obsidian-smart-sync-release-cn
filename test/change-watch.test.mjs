import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';

registerHooks({
	resolve(specifier, context, next) {
		return specifier === 'obsidian'
			? { url: new URL('./obsidian-double.mjs', import.meta.url).href, shortCircuit: true }
			: next(specifier, context);
	},
});
globalThis.window = { navigator: { onLine: true }, setTimeout, clearTimeout };
const { default: Plugin } = await import('../src/plugin.js');
globalThis.document = { visibilityState: 'visible' };

test('one idle watch triggers synchronization and a stale response cannot cross notebooks', async () => {
	const plugin = Object.create(Plugin.prototype);
	const parent = new AbortController();
	const settings = { origin: 'https://example.invalid', workspace: 'notebook', direction: 'both', interval: 3 };
	plugin.data = { settings };
	plugin.secret = () => 'synthetic-key';
	plugin.lastFinished = Date.now();
	const calls = [];
	let finish;
	let syncs = 0;
	plugin.synchronize = async () => { syncs++; };
	const api = {
		origin: settings.origin, workspace: settings.workspace, accessKey: plugin.secret(),
		watchChanges(after, pinsAfter) {
			calls.push([after, pinsAfter, this.signal]);
			return new Promise(resolve => { finish = resolve; });
		},
	};
	plugin.remoteWatchTarget = { api, parentSignal: parent.signal, cursor: 12, pinsCursor: 4 };
	assert.equal(plugin.pollRemoteChanges(), true);
	assert.equal(plugin.pollRemoteChanges(), true);
	assert.deepEqual(calls.map(call => call.slice(0, 2)), [[12, 4]]);
	finish(true);
	await nextTurn();
	assert.equal(syncs, 1);
	assert.equal(plugin.pollRemoteChanges(), true);
	settings.workspace = 'other';
	assert.equal(plugin.pollRemoteChanges(), false);
	assert.equal(calls[1][2].aborted, true);
	finish(true);
	await nextTurn();
	assert.equal(syncs, 1);
	settings.workspace = 'notebook';
	api.watchChanges = async () => { throw Error('synthetic disconnect'); };
	assert.equal(plugin.pollRemoteChanges(), true);
	await nextTurn();
	assert.equal(plugin.pollRemoteChanges(), false);
});

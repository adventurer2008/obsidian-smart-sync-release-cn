import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, next) { return specifier === 'obsidian' ? { url: new URL('./obsidian-double.mjs', import.meta.url).href, shortCircuit: true } : next(specifier, context); } });
globalThis.window = globalThis;
const { default: Sync } = await import('../src/plugin.js');
const { Platform } = await import('./obsidian-double.mjs');
function fixture() {
	const data = { localId: 'synthetic-local', settings: { origin: 'https://synthetic.invalid', workspace: 'a'.repeat(36) }, taskOutbox: [] };
	const subject = { data, manifest: { version: '1.1.2-alpha.9' }, saveData: async value => { assert.equal(value, data); }, queueDiagnostic: Sync.prototype.queueDiagnostic };
	const binding = JSON.stringify([data.localId, data.settings.origin, data.settings.workspace]);
	return { subject, binding };
}
const event = (stage, at = 200000) => ({ stage, at, durationMs: 20, traceId: crypto.randomUUID(), errorType: stage.includes('failed') ? 'TypeError' : '', runtime: { obsidian: '1.14.4', plugin: '1.1.2-alpha.9', webViewChromium: '130.0' } });
test('Android diagnostics persist locally and queue existing-schema events without changing settings', async () => {
	const { subject, binding } = fixture(), before = JSON.stringify(subject.data.settings), entry = event('native-selected');
	await Sync.prototype.recordAndroidTransportDiagnostic.call(subject, entry, binding);
	assert.equal(JSON.stringify(subject.data.settings), before);
	assert.equal(subject.data.androidTransportDiagnostics[0], entry);
	assert.equal(subject.data.taskOutbox[0].id, entry.traceId);
	assert.equal(subject.data.taskOutbox[0].version, '1.1.2');
	assert.match(subject.data.taskOutbox[0].note, /^[a-f0-9]{64}$/);
	assert.equal(subject.data.taskOutbox[0].status, 'done');
});
test('repeated failures are limited per stage and local retention is bounded', async () => {
	const { subject, binding } = fixture();
	for (let i = 0; i < 105; i++) await Sync.prototype.recordAndroidTransportDiagnostic.call(subject, event('primary-network-failed', 200000 + i * 61000), binding);
	assert.equal(subject.data.androidTransportDiagnostics.length, 100);
	assert.equal(subject.data.taskOutbox.length, 105);
	await Sync.prototype.recordAndroidTransportDiagnostic.call(subject, event('primary-network-failed', 200000 + 104 * 61000), binding);
	assert.equal(subject.data.taskOutbox.length, 105);
});
test('stale account/notebook binding cannot enqueue diagnostics into the new scope', async () => {
	const { subject, binding } = fixture();
	subject.data.settings.workspace = 'b'.repeat(36);
	await Sync.prototype.recordAndroidTransportDiagnostic.call(subject, event('native-selected'), binding);
	assert.equal(subject.data.androidTransportDiagnostics, undefined);
	assert.equal(subject.data.taskOutbox.length, 0);
});
test('guarded transport includes Android stable releases while unknown metadata and non-Android retain default fetch', t => {
	const previous = Platform.isAndroidApp;
	t.after(() => { Platform.isAndroidApp = previous; });
	for (const [android, version, expected] of [[true, '1.1.2-alpha.10', true], [true, '1.1.2', true], [true, '1.1.3', true], [true, undefined, false], [true, 'unknown', false], [true, '1.1.1', false], [false, '1.1.2', false], [false, '1.1.2-alpha.10', false]]) {
		Platform.isAndroidApp = android;
		const { subject } = fixture(); subject.manifest.version = version;
		Sync.prototype.workspaceApi.call(subject, 'https://synthetic.invalid', 'synthetic-access');
		assert.equal(Boolean(subject.androidTransport), expected);
	}
});

test('stable Android preserves an explicitly supplied workspace transport', t => {
	const previous = Platform.isAndroidApp;
	t.after(() => { Platform.isAndroidApp = previous; });
	Platform.isAndroidApp = true;
	const { subject } = fixture(); subject.manifest.version = '1.1.2';
	const supplied = async () => { throw Error('synthetic caller transport'); };
	const api = Sync.prototype.workspaceApi.call(subject, 'https://synthetic.invalid', 'synthetic-access', 'a'.repeat(36), supplied);
	assert.equal(api.fetcher, supplied);
	assert.equal(subject.androidTransport, undefined);
});

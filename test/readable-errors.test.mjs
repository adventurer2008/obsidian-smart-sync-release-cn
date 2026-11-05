import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WorkspaceApi, failureMessage } from '../src/client.js';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

globalThis.__SMART_SYNC_EDITION__ = { edition: 'global', locale: 'en' };
const { localizedFailure } = await import('../src/i18n.js');
const requestError = async (body, status = 409) => {
 const api = new WorkspaceApi('https://sync.example.invalid', 'synthetic', '', async () => new Response(body, { status }));
 try { await api.workspaces(); assert.fail('Expected API failure'); }
 catch (error) { assert.equal(error.status, status); return error; }
};

test('deployed quota responses show configured limits and distinct recovery actions', async () => {
 for (const limit of [0, 3, 17]) {
  const vault = await requestError(JSON.stringify({ error: `This plan supports up to ${limit} vaults. Remove an unused vault or upgrade your plan.` }));
  assert.equal(vault.code, 'VAULT_LIMIT_REACHED'); assert.equal(vault.limit, limit);
  assert.match(localizedFailure(vault), /Connect an existing vault/);
  assert.ok(localizedFailure(vault).includes(`(${limit})`));
  const device = await requestError(JSON.stringify({ error: `Free supports up to ${limit} devices. Revoke an unused device or upgrade your plan.` }));
  assert.equal(device.code, 'DEVICE_LIMIT_REACHED');
  assert.match(localizedFailure(device), /Revoke an unused device/);
  assert.equal(failureMessage(device), localizedFailure(device));
 }
});

test('structured quota codes are constrained by HTTP status and validated numeric limits', async () => {
 const valid = await requestError(JSON.stringify({ code: 'VAULT_LIMIT_REACHED', limit: 5 }));
 assert.equal(valid.limit, 5);
 for (const limit of [-1, '3', 1.5, Number.MAX_SAFE_INTEGER + 1]) {
  const invalid = await requestError(JSON.stringify({ code: 'DEVICE_LIMIT_REACHED', limit }));
  assert.equal(invalid.limit, undefined); assert.doesNotMatch(localizedFailure(invalid), /undefined|NaN/);
 }
 const unauthorized = await requestError(JSON.stringify({ code: 'VAULT_LIMIT_REACHED', limit: 3 }), 401);
 assert.equal(unauthorized.code, undefined); assert.match(localizedFailure(unauthorized), /Sign in again/);
});

test('untrusted, malformed, oversized and ordinary conflict responses never expose server text', async () => {
 for (const body of [null, 'not-json', '<html>private-token</html>', JSON.stringify({ error: 'private-token supports up to 3 vaults' }), JSON.stringify({ code: 'NOT_KNOWN', error: 'private-token' }), JSON.stringify({ error: 'x'.repeat(17000) })]) {
  const error = await requestError(body);
  assert.equal(error.code, undefined); assert.match(localizedFailure(error), /cloud revision changed/);
  assert.doesNotMatch(localizedFailure(error), /private-token|<html>/);
 }
});

test('common service, storage, encryption, account and validation errors explain the next step in English', () => {
 for (const status of [400, 401, 403, 404, 408, 409, 410, 413, 422, 428, 429, 500, 502, 503, 504]) {
  const message = localizedFailure({ status });
  assert.notEqual(message, localizedFailure({})); assert.doesNotMatch(message, /HTTP|[\u3400-\u9fff]/);
 }
 for (const message of ['Type DELETE exactly to confirm', 'Confirm revocation', 'Account changed', 'Account does not match', 'No connected notebook', 'Sign in before connecting', 'Sign-in expired or context changed', 'Invalid Global sign-in link', 'Notebook encryption passphrase does not match', 'A file occupies the folder path', 'Open a note first', 'Synchronize the note before opening history', 'Attachment limit must be between 0 and 256 MB', 'Plugin is unloaded']) {
  assert.notEqual(localizedFailure(Error(message)), localizedFailure({}), message);
 }
 for (const code of ['EACCES', 'EPERM', 'ENOENT', 'ENOSPC', 'ACCOUNT_ENCRYPTION_WRONG', 'PAIRING_EXPIRED', 'RESTORED_SERVICE', 'RENAME_CONFLICT']) {
  assert.notEqual(localizedFailure({ code }), localizedFailure({}), code);
 }
 assert.equal(localizedFailure(Error('secret-password')), localizedFailure({}));
 assert.match(localizedFailure(new TypeError('secret-password')), /network/);
});

test('every declared failure has an English translation and China retains readable localized errors', async () => {
 const source = await readFile(new URL('../src/i18n.js', import.meta.url), 'utf8');
 const declarations = source.slice(source.indexOf('const failures = {'), source.indexOf('const localErrorCodes'));
 const codes = [...declarations.matchAll(/^\t([A-Za-z_0-9]+):/gm)].map(match => match[1]);
 for (const code of codes) {
  const message = localizedFailure({ code });
  assert.equal(typeof message, 'string', code); assert.ok(message.length > 10, code);
  assert.doesNotMatch(message, /[\u3400-\u9fff]|undefined/, code);
 }
 const cn = spawnSync(process.execPath, ['--input-type=module', '-e', `
  import assert from 'node:assert/strict';
  import {localizedFailure} from './src/i18n.js';
  assert.match(localizedFailure({code:'VAULT_LIMIT_REACHED',limit:3}),/上限（3）/);
  assert.match(localizedFailure(Error('Type DELETE exactly to confirm')),/DELETE/);
  assert.match(localizedFailure({status:503}),/暂时不可用/);
  assert.match(localizedFailure({status:401}),/重新登录/);
 `], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
 assert.equal(cn.status, 0, cn.stderr);
});

test('aborted error-body reads stay cancellable and preserve the cancellation reason', async () => {
 const controller = new AbortController();
 let cancelled = false;
 const api = new WorkspaceApi('https://sync.example.invalid', 'synthetic', '', async () => new Response(new ReadableStream({
  start() { setTimeout(() => controller.abort(new DOMException('Stopped', 'AbortError')), 10); },
  cancel() { cancelled = true; },
 }), { status: 409 }));
 api.signal = controller.signal;
 await assert.rejects(api.workspaces(), { name: 'AbortError' });
 assert.equal(cancelled, true);
 assert.match(localizedFailure(controller.signal.reason), /operation stopped/);
});

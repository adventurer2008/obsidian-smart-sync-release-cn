import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const identities = Object.freeze({
  cn: { id: 'wujie-sync', name: 'Wujie Sync', locale: 'zh-CN', repository: 'adventurer2008/obsidian-smart-sync-release-cn', channel: 'brat' },
  global: { id: 'smart-sync-global', name: 'Smart Sync', locale: 'en', repository: 'adventurer2008/obsidian-smart-sync-release-global', channel: 'community' },
});
export function publicUrl(value, originOnly = false) {
  assert.equal(typeof value, 'string', 'A public HTTPS URL is required');
  const url = new URL(value);
  assert.equal(url.protocol, 'https:');
  assert.ok(!url.username && !url.password && !url.search && !url.hash, 'URL credentials, query and fragment are forbidden');
  assert.ok(!/^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[)/i.test(url.hostname) && url.hostname.includes('.') && !/\.(invalid|local|test|example)$/i.test(url.hostname), 'A public hostname is required');
  if (originOnly) assert.equal(value, url.origin, 'Service URL must be a canonical origin without a path or trailing slash');
  return value;
}
export function validateEdition(config, selected) {
  assert.ok(Object.hasOwn(identities, selected), 'Unknown edition');
  assert.equal(config.edition, selected);
  for (const [key, value] of Object.entries(identities[selected])) assert.equal(config[key], value, `Edition identity mismatch: ${key}`);
  for (const key of ['serviceOrigin', 'website', 'privacyUrl']) if (config[key] !== null) publicUrl(config[key], key === 'serviceOrigin');
  if (config.serviceOrigin !== null) assert.equal(config.serviceOrigin, selected === 'cn' ? 'https://sync.wujiesync.cc' : 'https://sync.smartsync.cc', 'Wrong regional service domain');
  if (config.stagingOrigin !== undefined) {
    assert.equal(config.stagingOrigin, selected === 'cn' ? 'http://127.0.0.1:24819' : 'https://staging-sync.smartsync.cc', 'Wrong regional staging service');
  }
  for (const [key, expected] of Object.entries(selected === 'cn' ? { payOrigin: 'https://pay.wujiesync.cc', stagingPayOrigin: 'https://pay.wujiesync.cc' } : { payOrigin: 'https://pay.smartsync.cc', stagingPayOrigin: 'https://staging-pay.smartsync.cc' })) assert.equal(config[key], expected, 'Wrong regional payment service: ' + key);
  if (config.website !== null) assert.ok((selected === 'cn'
    ? ['https://wujiesync.cc', 'https://github.com/adventurer2008/obsidian-smart-sync-release-cn']
    : ['https://smartsync.cc']).includes(config.website), 'Wrong regional website');
  if (config.mailFrom !== null) assert.match(config.mailFrom, /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/);
  assert.ok(selected === 'cn' ? config.hostingRegion === 'china' : config.hostingRegion === null || ['singapore', 'united-states'].includes(config.hostingRegion));
  return config;
}
export async function loadEdition(selected, root = process.cwd()) {
  return validateEdition(JSON.parse(await readFile(resolve(root, 'editions', `${selected}.json`), 'utf8')), selected);
}
export function configurationBlockers(config) {
  const keys = ['serviceOrigin', 'website', 'privacyUrl', 'hostingRegion', ...(config.edition === 'global' ? ['mailFrom'] : ['mailProfile'])];
  return [...keys.filter(key => !config[key]).map(key => `${config.edition}: ${key} is not configured`), ...(config.edition === 'global' && config.smtpVerified !== true ? ['global: SMTP configuration and delivery have not been verified'] : [])];
}

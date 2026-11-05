/* global __SMART_SYNC_EDITION__ -- Injected by the explicit regional build; absent in source-based local tests. */
// The fallback is only for existing source-based synthetic tests and local builds.
// Explicit distribution builds always inject an edition, including an unset origin.
export const edition = typeof __SMART_SYNC_EDITION__ === 'undefined'
	? Object.freeze({ edition: 'cn', id: 'wujie-sync', name: '无界同步', locale: 'zh-CN', development: true, serviceOrigin: 'http://127.0.0.1:14809' })
	: Object.freeze(__SMART_SYNC_EDITION__);

export function assertEditionOrigin(origin) {
	if (edition.development) return;
	if (!edition.serviceOrigin) throw Object.assign(new Error('Service is not configured for this edition'), { code: 'EDITION_UNCONFIGURED' });
	const staging = origin === edition.stagingOrigin && (edition.edition === 'cn' && origin === 'http://127.0.0.1:24819' || edition.edition === 'global' && origin === 'https://staging-sync.smartsync.cc');
	if (origin !== edition.serviceOrigin && !staging)
		throw Object.assign(new Error('Connection belongs to another service'), { code: 'EDITION_SERVICE_MISMATCH' });
}

export function regionalServices(config = edition, origin = config.serviceOrigin) {
	const defaults = config.edition === 'global'
		? { serviceOrigin: 'https://sync.smartsync.cc', payOrigin: 'https://pay.smartsync.cc', stagingOrigin: 'https://staging-sync.smartsync.cc', stagingPayOrigin: 'https://staging-pay.smartsync.cc' }
		: { serviceOrigin: 'https://sync.wujiesync.cc', payOrigin: 'https://pay.wujiesync.cc', stagingOrigin: 'http://127.0.0.1:24819', stagingPayOrigin: 'https://pay.wujiesync.cc' };
	const resolved = { ...defaults, ...config };
	if (config.development && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin) && origin !== resolved.stagingOrigin)
		return { sync: origin, pay: origin, purchase: origin, login: origin + '/auth/login', staging: false, local: true };
	const staging = origin === resolved.stagingOrigin;
	if (origin !== resolved.serviceOrigin && !staging) throw Object.assign(new Error('Connection belongs to another service'), { code: 'EDITION_SERVICE_MISMATCH' });
	for (const key of ['serviceOrigin', 'payOrigin', 'stagingOrigin', 'stagingPayOrigin'])
		if (resolved[key] !== defaults[key]) throw Object.assign(new Error('Service is not configured for this edition'), { code: 'EDITION_UNCONFIGURED' });
	const pay = staging ? resolved.stagingPayOrigin : resolved.payOrigin;
	return { sync: origin, pay, purchase: pay + (staging && config.edition === 'cn' ? '/pay-test' : '/pay'), login: pay + '/auth/login', staging, local: false };
}

export const logViewType = `${edition.id}-log`;

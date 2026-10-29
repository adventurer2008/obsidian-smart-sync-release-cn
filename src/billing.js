import { formatStorageSize } from './i18n.js';

const pending = new Set(['creating', 'pending', 'uncertain']);
const mountedCards = new WeakMap();
const statuses = { creating: '正在生成订单', pending: '等待付款', expired: '订单已关闭', uncertain: '正在核实付款结果，请勿重复付款', paid: '付款成功', rejected: '支付订单创建失败', refund_pending: '退款处理中', refunded: '已退款' };
export function capacityWarning(data) {
	const used = data?.usage?.logicalBytes, capacity = data?.entitlement?.logical;
	if (!Number.isSafeInteger(used) || !Number.isSafeInteger(capacity) || capacity < 0 || used <= capacity) return undefined;
	return { title: '套餐容量不足', message: `已用 ${formatStorageSize(used)} / ${formatStorageSize(capacity)}，请增加额度后继续上传。`, action: '购买更多额度' };
}
export function renewalReminderAt(ends) {
	const value = new Date(ends), day = value.getUTCDate();
	value.setUTCDate(1);
	value.setUTCMonth(value.getUTCMonth() - 1);
	const last = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 0)).getUTCDate();
	value.setUTCDate(Math.min(day, last));
	return value.getTime();
}
export function billingCard(data, connected, now = Date.now()) {
	const rights = data?.entitlement, order = data?.currentOrder;
	const hidePendingOrder = rights?.paid === true && rights.ends > now && pending.has(order?.status) && order.failureCode !== 'paid_plan_conflict';
	const showOrder = order && !hidePendingOrder && (order.status !== 'paid' || order.purpose === 'test' || order.failureCode === 'paid_plan_conflict');
	const free = rights?.plan === 'cn-free' && rights?.paid !== true;
	const purchased = !free && (rights?.paid === true || data?.everPurchased === true);
	const ends = rights?.ends ?? data?.lastPurchase?.ends;
	const renewed = data?.lastPurchase?.status === 'paid' && data.lastPurchase.renewal === true;
	const refunded = purchased && rights?.paid !== true && data?.lastPurchase?.status === 'refunded';
	const expired = purchased && (rights?.paid !== true || !ends || ends <= now);
	const due = purchased && !expired && now >= renewalReminderAt(ends);
	const titles = { 'cn-5gb-year': '5GB 年付', 'cn-10gb-year': '10GB 年付', 'cn-20gb-year': '20GB 年付' };
	// A service fallback quota is not an activated subscription owned by this user.
	const capacity = connected && (rights?.paid === true || free) ? rights.logical : undefined;
	const usage = data?.usage?.logicalBytes;
	return {
		overage: connected && capacityWarning(data) ? '已超出套餐容量' : '',
		free, label: free ? '购买更多额度' : purchased ? '续费' : '购买', prominent: !purchased || due || expired,
		badge: !purchased ? '' : refunded ? '已退款' : expired ? '已到期' : due ? '即将到期' : '已开通',
		title: free ? '免费 · 100MB' : purchased ? (rights?.paid ? '当期套餐：' : '') + (titles[rights?.paid ? rights.plan : data?.lastPurchase?.plan] ?? '年度套餐') : '',
		usage: connected && Number.isFinite(capacity) ? Number.isFinite(usage) ? `已用 ${formatStorageSize(usage)} / ${formatStorageSize(capacity)}` : `套餐容量 ${formatStorageSize(capacity)} · 用量待核算` : '',
		ratio: Number.isFinite(usage) && capacity > 0 ? Math.max(0, Math.min(1, usage / capacity)) : null,
		upcoming: rights?.upcoming ? `下期套餐：${titles[rights.upcoming.plan] ?? '年度套餐'}，${new Date(rights.upcoming.starts).toLocaleDateString('zh-CN')}生效` : '',
		expires: free && rights.starts ? `开通日期：${new Date(rights.starts).toLocaleDateString('zh-CN')}` : purchased && ends && !refunded ? `到期时间：${new Date(ends).toLocaleDateString('zh-CN')}` : '',
		help: free ? connected ? '账号下所有笔记库共用100MB容量，免费套餐规则以届时公布为准。' : ['failed','uncertain','purchase_conflict'].includes(data?.registration) ? '免费套餐已开通，登录信息发送待处理，请联系支持。' : '免费套餐已开通，请使用邮件中的登录信息登录。' : !purchased ? '' : renewed ? '续费成功，原账号及登录信息继续有效。' : !connected ? ['failed','uncertain','purchase_conflict'].includes(data?.registration) ? '付款已确认，登录信息发送待处理，请联系支持。' : '付款已确认，请使用邮件中的登录信息登录。'
			: refunded ? '套餐已退款，可重新购买开通。' : expired ? '套餐已到期，续费后继续使用。' : due ? '距离到期不足一个月，可提前续费，不自动扣款。' : '账号下所有笔记库共用套餐容量，不自动扣款。',
		order: showOrder ? [purchased ? order.title : '', order.purpose === 'test' ? '1分钱测试' : '', order.failureCode === 'paid_plan_conflict' ? '付款已收到，待核对' : statuses[order.status] ?? '订单处理中'].filter(Boolean).join(' · ') + (order.status === 'paid' && order.purpose === 'test' ? '，套餐权益未改变' : '') : '',
		resume: order && pending.has(order.status) ? order.id : undefined,
	};
}

// Mounted only in the CN settings view. Every request/result is tied to its identity.
export function mountBillingCard(setting, { connected, load, open, live, onError, target, now = Date.now }) {
	if (!setting.infoEl || !setting.controlEl) return () => {};
	mountedCards.get(setting.settingEl)?.();
	setting.setName('我的套餐');
	setting.settingEl.classList.add('smart-sync-billing');
	const doc = setting.infoEl.ownerDocument;
	const view = target ?? doc.defaultView;
	const add = (parent, tag, cls) => { const node = doc.createElement(tag); node.className = cls; parent.append(node); return node; };
	const badge = add(setting.infoEl, 'span', 'smart-sync-plan-badge');
	const title = add(setting.infoEl, 'div', 'smart-sync-plan-title');
	const upcoming = add(setting.infoEl, 'div', 'smart-sync-plan-help');
	const usage = add(setting.infoEl, 'div', 'smart-sync-plan-usage');
	const overage = add(setting.infoEl, 'div', 'smart-sync-plan-order'); overage.setAttribute('role', 'status');
	const progress = add(setting.infoEl, 'progress', 'smart-sync-plan-progress'); progress.max = 1; progress.setAttribute('aria-label', '套餐容量使用情况');
	const expires = add(setting.infoEl, 'div', 'smart-sync-plan-expiry');
	const help = add(setting.infoEl, 'div', 'smart-sync-plan-help');
	const status = add(setting.infoEl, 'div', 'smart-sync-plan-order'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
	const button = add(setting.controlEl, 'button', 'smart-sync-plan-action'); button.type = 'button';
	let disposed = false, loading = false, acting = false, data, timer, deadline = now() + 15 * 60000;
	const current = () => !disposed && live();
	function render() {
		const model = billingCard(data, connected, now());
		badge.textContent = model.badge; title.textContent = model.title; usage.textContent = model.usage; expires.textContent = model.expires;
		overage.textContent = model.overage; overage.hidden = !model.overage;
		badge.hidden = !model.badge;
		title.hidden = !model.title;
		setting.settingEl.classList.toggle('is-compact', !model.title && !model.order);
		setting.settingEl.classList.toggle('is-free', model.free);
		upcoming.textContent = model.upcoming; upcoming.hidden = !model.upcoming;
		help.textContent = model.help; status.textContent = model.order;
		usage.hidden = !model.usage; expires.hidden = !model.expires; help.hidden = !model.help;
		progress.hidden = model.ratio === null; progress.value = model.ratio ?? 0;
		button.textContent = model.label; button.disabled = acting; button.hidden = !model.prominent;
		button.classList.toggle('mod-cta', model.prominent); button.classList.toggle('is-prominent', model.prominent);
		if (connected && !data) { badge.textContent = '读取中'; badge.hidden = false; title.textContent = '正在读取套餐信息'; title.hidden = false; button.textContent = '读取中…'; button.disabled = true; }
	}
	async function refresh() {
		view.clearTimeout(timer);
		if (!current() || loading || now() >= deadline || doc.hidden) return;
		loading = true;
		try { const result = await load(); if (current()) { data = result; render(); } }
		catch { if (current()) status.textContent = '套餐信息暂时无法更新，请稍后重新打开设置。'; }
		finally { loading = false; if (current() && now() < deadline) timer = view.setTimeout(() => { void refresh(); }, billingCard(data, connected, now()).resume ? 5000 : 30000); }
	}
	const focus = () => { if (current()) { deadline = now() + 15 * 60000; void refresh(); } };
	const click = async () => {
		if (!current() || acting || !billingCard(data, connected, now()).prominent) return;
		acting = true; render();
		try { await open(); }
		catch (error) { if (current()) onError(error); }
		finally { acting = false; if (current()) { render(); focus(); } }
	};
	button.addEventListener('click', click); view.addEventListener('focus', focus); doc.addEventListener('visibilitychange', focus);
	render(); void refresh();
	const dispose = () => {
		disposed = true; view.clearTimeout(timer); button.removeEventListener('click', click); view.removeEventListener('focus', focus); doc.removeEventListener('visibilitychange', focus);
		for (const node of [badge, title, upcoming, usage, overage, progress, expires, help, status, button]) node.remove();
		if (mountedCards.get(setting.settingEl) === dispose) { mountedCards.delete(setting.settingEl); setting.settingEl.classList.remove('smart-sync-billing', 'is-compact', 'is-free'); }
	};
	mountedCards.set(setting.settingEl, dispose);
	return dispose;
}

import { t, localizedFailure as failureMessage } from './i18n.js';

const statuses = new Set([
	'running',
	'done',
	'failed',
	'interrupted',
	'resolved',
	'deferred',
	'skipped',
]);
const directions = new Set(['send', 'receive', 'delete', 'cycle']);
const opaque = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0);
const version = (value) =>
	typeof value === 'string' && /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value) ? value : '0.1.3';
const retryable = (row) => ['failed', 'interrupted'].includes(row.status);
function taskTimings(row) {
	return Object.fromEntries(['workMilliseconds', 'checkpointMilliseconds']
		.filter(key => Number.isFinite(row[key]) && row[key] >= 0 && row[key] <= 1e12)
		.map(key => [key, row[key]]));
}

// Only these fields reach disk. Names, content, endpoints and raw errors never enter the journal.
export class TaskJournal {
	constructor(rows = [], limit = 500) {
		this.limit = limit === 2000 ? 2000 : 500;
		this.names = new Map();
		this.rows = (Array.isArray(rows) ? rows : [])
			.filter((row) => opaque(row?.scope) && opaque(row?.note) && directions.has(row.direction))
			.slice(-this.limit)
			.map((row) => ({
				id:
					typeof row.id === 'string' && /^[a-f0-9-]{36}$/.test(row.id)
						? row.id
						: crypto.randomUUID(),
				scope: row.scope,
				note: row.note,
				pathKey: opaque(row.pathKey) ? row.pathKey : row.note,
				direction: row.direction,
				version: version(row.version),
				status:
					row.status === 'running'
						? 'interrupted'
						: statuses.has(row.status)
							? row.status
							: 'interrupted',
				started: count(row.started),
				finished: count(row.finished),
				bytes: count(row.bytes),
				total: count(row.total),
				failure: count(row.failure),
				...(row.skipReason === 'desktop-plugin' ? { skipReason: row.skipReason } : {}),
				...taskTimings(row),
			}));
	}
	start(scope, event) {
		if (!opaque(scope) || !opaque(event.note) || !directions.has(event.direction))
			throw new Error('Invalid task identity');
		const row = {
			id: crypto.randomUUID(),
			scope,
			note: event.note,
			pathKey: opaque(event.pathKey) ? event.pathKey : event.note,
			direction: event.direction,
			version: version(event.version),
			status: 'running',
			started: Date.now(),
			finished: 0,
			bytes: 0,
			total: 0,
			failure: 0,
		};
		this.rows.push(row);
		while (this.rows.length > this.limit) {
			const removable = this.rows.findIndex(entry => entry.direction !== 'cycle' || entry.status !== 'running');
			this.rows.splice(removable < 0 ? 0 : removable, 1);
		}
		const live = new Set(this.rows.map((entry) => `${entry.scope}:${entry.note}`));
		for (const key of this.names.keys()) if (!live.has(key)) this.names.delete(key);
		return row.id;
	}
	update(id, event) {
		const row = this.rows.find((value) => value.id === id);
		if (!row || row.status !== 'running') return;
		if (typeof event.path === 'string') this.names.set(`${row.scope}:${row.note}`, event.path);
		row.bytes = Math.max(row.bytes, count(event.bytes));
		row.total = Math.max(row.total, row.bytes, count(event.total));
		if (['done', 'failed', 'deferred', 'skipped'].includes(event.status)) {
			row.status = event.status;
			row.finished = Date.now();
			Object.assign(row, taskTimings(event));
			row.failure = event.status === 'failed' ? failureCode(event.error) : 0;
			if (event.status === 'skipped' && event.skipReason === 'desktop-plugin') row.skipReason = event.skipReason;
			if (event.status === 'done' || (event.status === 'skipped' && event.skipReason === 'desktop-plugin'))
				for (const old of this.rows)
					if (
						old !== row &&
						old.scope === row.scope &&
						old.note === row.note &&
						old.direction === row.direction &&
						retryable(old)
					)
						old.status = 'resolved';
		}
	}
	select(scope, { status = 'all', direction = 'all', search = '' } = {}) {
		return this.rows.filter(
			(row) =>
				row.scope === scope &&
				(status === 'all' || (status === 'pending' ? retryable(row) : row.status === status)) &&
				(direction === 'all' || row.direction === direction) &&
				(!search ||
					(this.names.get(`${scope}:${row.note}`) ?? row.note)
						.toLowerCase()
						.includes(search.toLowerCase())),
		);
	}
	snapshot() {
		return this.rows.map((row) => ({ ...row }));
	}
	canRetry(row, scope) {
		return row?.scope === scope && retryable(row);
	}
	message(row) {
		return row.skipReason === 'desktop-plugin' ? t('configuration.desktopSkipped') : row.status === 'interrupted' ? t('msg_023c523155') : failureText(row.failure);
	}
}
const failures = [
	undefined,
	401,
	403,
	404,
	409,
	413,
	429,
	'RENAME_CONFLICT',
	'WRONG_NOTEBOOK_KEY',
	'RESTORED_SERVICE',
	'OperationError',
	'TypeError',
	'PLAN_CHANGED',
	'TEMP_SPACE',
];
function failureCode(error) {
	const key =
		failures.includes(error?.status) && error?.status
			? error.status
			: failures.includes(error?.code) && error?.code
				? error.code
				: ['TypeError', 'TimeoutError', 'AbortError'].includes(error?.name)
					? 'TypeError'
					: error?.name;
	return Math.max(0, failures.indexOf(key));
}
function failureText(code) {
	const value = failures[count(code)];
	return failureMessage(
		typeof value === 'number'
			? { status: value }
			: value === 'TypeError'
				? new TypeError()
				: value === 'OperationError'
					? { name: value }
					: { code: value },
	);
}

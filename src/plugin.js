import { edition, assertEditionOrigin, logViewType } from './edition.js';
import { mountBillingCard, capacityWarning } from './billing.js';
import { t, locale, formatStorageSize, localizedFailure as failureMessage } from './i18n.js';
import { ConnectionCheckpoints } from './checkpoint.js';
import { notePinState, queueNotePin, moveNotePins, pinPathSet, synchronizeNotePins } from './pinning.js';
import { registerNoteSearch } from './search.js';
import { registerNoteEncryption } from './note-encryption.js';
import {
	ItemView,
	Modal,
	Notice,
	Platform,
	Plugin,
	PluginSettingTab,
	requireApiVersion,
	Setting,
	TFile,
	TFolder,
} from 'obsidian';
import { WorkspaceApi, BATCH_BYTES, cancellationScope } from './client.js';
import { requireRuntime } from './compatibility.js';
import {
	freshSalt,
	fingerprint,
	inspectNote,
	reconcileLogicalUsage,
	safeNotePath,
	safeHostPath,
	unlockWorkspace,
	unpackNote,
	workspaceProof,
	accountProof,
	wrapWorkspacePassword,
	unwrapWorkspacePassword,
} from './codec.js';
import {
	CONFIG_NAMESPACE,
	configurationHost,
	configurationScope,
	filterPreset,
	cleanConfiguration,
	coreFiles,
} from './configuration.js';
import { synchronizationPlan, planChanged, diagnosticReport } from './planning.js';
import { compareText } from './merge.js';
import {
	approvePairing,
	beginPairing,
	finishPairing,
	inspectPairing,
	pairingCode,
	pairingFault,
} from './pairing.js';
import { decryptRecovery, encryptRecovery } from './recovery.js';
import { routedFetch } from './routing.js';
import { sampleVaultSize, LanPeers, intersectDirection, bindLanTransfers, localNoteProvider, receivePeerNote } from './peers.js';
import { ReceiveCache } from './resume.js';
import { desktopFiles } from './desktop.js';
import { createBackgroundTray } from './background-tray.js';
import {
	emptyState,
	IncrementalInventory,
	NotebookSynchronizer,
	pendingAttachment,
	recordRename,
} from './synchronizer.js';
import { TaskJournal } from './tasks.js';

export function isNewerClientVersion(latest, current) {
	const parse = value => typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)
		? value.split('.').map(Number) : undefined;
	const next = parse(latest), installed = parse(current);
	if (!next || !installed || ![...next, ...installed].every(Number.isSafeInteger)) return false;
	for (let index = 0; index < 3; index++) {
		if (next[index] !== installed[index]) return next[index] > installed[index];
	}
	return false;
}

export async function publishedClientVersion(fetcher = fetch, signal) {
	const scope = cancellationScope([signal], 5000);
	try {
		const response = await fetcher('https://raw.githubusercontent.com/adventurer2008/obsidian-smart-release/main/manifest.json', {
			signal: scope.signal, credentials: 'omit', redirect: 'error', cache: 'no-store',
		});
		if (!response.ok || Number(response.headers.get('content-length') ?? 0) > 16384) {
			await response.body?.cancel();
			return undefined;
		}
		const reader = response.body?.getReader();
		if (!reader) return undefined;
		const chunks = []; let length = 0;
		try {
			while (true) {
				const { value, done } = await reader.read();
				if (done) break;
				length += value.length;
				if (length > 16384) throw Error('Release metadata too large');
				chunks.push(value);
			}
		} finally { await reader.cancel().catch(() => {}); }
		const bytes = new Uint8Array(length); let offset = 0;
		for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
		const metadata = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
		return metadata.id === edition.id && isNewerClientVersion(metadata.version, '0.0.0') ? metadata.version : undefined;
	} finally { scope.dispose(); }
}

class ChoiceWindow extends Modal {
	constructor(app, title, render) {
		super(app);
		this.heading = title;
		this.render = render;
	}
	onOpen() {
		this.setTitle(this.heading);
		this.contentEl.empty();
		this.contentEl.classList.add('smart-sync-dialog');
		this.render(this.contentEl);
	}
	onClose() {
		this.contentEl.empty();
	}
}
function bindAction(setting, label, callback) {
	setting.addButton((button) => {
		let pending = false;
		button.setButtonText(label).onClick(async () => {
			if (pending) return;
			pending = true;
			button.setDisabled(true);
			try {
				await callback();
			} catch (error) {
				new Notice(failureMessage(error));
			} finally {
				pending = false;
				button.setDisabled(false);
			}
		});
	});
}
export function bindManualSyncAction(setting, plugin) {
 const status = setting.settingEl.createDiv({ cls: 'smart-sync-manual-feedback', attr: { role: 'status', 'aria-live': 'polite' } });
 setting.settingEl.classList.add('smart-sync-manual-action');
 status.hidden = true;
 let disposed = false, timer, startedAt, stopButton, stopping = false;
 const binding = () => JSON.stringify([plugin.data.localId, plugin.data.settings.origin, plugin.data.settings.workspace]);
 const expected = binding();
 const live = () => !disposed && !plugin.stopped && binding() === expected;
 const update = () => {
  if (!live()) return;
  if (stopping || plugin.stopping) { status.setText(t('task.stateStopping')); return; }
  const activity = plugin.cycleActivity;
  const stage = activity ? t(`sync.stage.${activity.stage}`) : '准备同步';
  const counts = [];
  if (activity?.scan && Number.isSafeInteger(activity.scan.checked) && Number.isSafeInteger(activity.scan.total))
   counts.push(t('sync.scanCount', activity.scan));
  if (activity?.received > 0) counts.push(t('sync.receiveCount', { count: activity.received }));
  const detail = counts.length ? ` ${counts.join('；')}。` : '';
  status.setText((Date.now() - (activity?.progressAt ?? startedAt)) >= 15000
   ? `仍在等待：${stage}。${detail}可在“同步记录”中查看详情或停止本轮。`
   : `正在${stage}，请稍候…${detail}`);
 };
 bindAction(setting, t('msg_36e7a43a1c'), async () => {
  if (!live()) return;
  startedAt = Date.now(); status.hidden = false; update();
  timer = window.setInterval(update, 1000);
  try {
   await plugin.requestSynchronization();
   if (live()) status.setText(plugin.overviewStatusText ?? '本次操作已结束，请查看同步记录或按弹窗提示继续。');
  } catch (error) {
   if (live()) status.setText(`同步未完成：${failureMessage(error)}`);
   throw error;
  } finally { window.clearInterval(timer); timer = undefined; }
 });
 const refreshStop = () => {
  if (!live() || !stopButton) return;
  stopButton.setButtonText(t(stopping || plugin.stopping ? 'task.stateStopping' : 'sync.stop'));
  stopButton.setDisabled(stopping || Boolean(plugin.stopping) || plugin.data.manualSyncStopped === true);
 };
 setting.addButton(button => {
  stopButton = button;
  button.onClick(async () => {
   if (!live() || stopping || plugin.stopping || plugin.data.manualSyncStopped) return;
   stopping = true; refreshStop(); status.hidden = false; status.setText(t('task.stateStopping'));
   try {
    await plugin.stopSynchronization();
    if (live()) status.setText(t('task.stopped'));
   } catch (error) {
    if (live()) status.setText(failureMessage(error));
    new Notice(failureMessage(error));
   } finally { stopping = false; refreshStop(); }
  });
 });
 plugin.statusListeners ??= new Set();
 plugin.statusListeners.add(refreshStop);
 refreshStop();
 return () => { disposed = true; window.clearInterval(timer); plugin.statusListeners.delete(refreshStop); status.remove(); };
}
function action(container, label, callback) {
	bindAction(new Setting(container), label, callback);
}
function operationBusy(code = 'SYNC_BUSY') {
	return Object.assign(new Error('Operation must wait for active work'), { code });
}
function notebookAlreadyConnected() {
	return Object.assign(new Error('Sign out before connecting another notebook'), {
		code: 'NOTEBOOK_ALREADY_CONNECTED',
	});
}
function configurationEnabled(config, kind) {
	if (kind === 'themes')
		return (
			config.themes === true ||
			config.codeSnippets === true ||
			(config.codeSnippets !== false && (config.snippets?.length ?? 0) > 0)
		);
	const value = config[kind === 'code' ? 'pluginCode' : 'pluginData'];
	if (typeof value === 'boolean') return value;
	return (
		(kind === 'code' ? config.plugins === 'all' : ['all', 'settings'].includes(config.plugins)) ||
		Object.values(config.pluginRules ?? {}).some((rule) => rule[kind] === true)
	);
}
function formWindow(app, title, fields, submit, submitLabel = t('msg_31fbef1625')) {
	const values = Object.fromEntries(fields.map((field) => [field.key, field.value ?? '']));
	const window = new ChoiceWindow(app, title, (container) => {
		for (const field of fields) {
			if (field.confirmName) container.createDiv({cls:'smart-sync-confirm-name',text:t('notebooks.confirmNameEmphasis',{name:field.confirmName})});
			const setting = new Setting(container).setName(field.label);
			if (field.description) setting.setDesc(field.description);
			if (field.multiline)
				setting.addTextArea((input) =>
					input.setValue(values[field.key]).onChange((value) => {
						values[field.key] = value;
					}),
				);
			else
				setting.addText((input) => {
					if (field.password) input.inputEl.type = 'password';
					if (field.className) input.inputEl.classList?.add(field.className);
					if (field.maxLength) input.inputEl.maxLength = field.maxLength;
					if (field.inputMode) input.inputEl.inputMode = field.inputMode;
					input.setValue(values[field.key]).onChange((value) => {
						values[field.key] = value;
					});
				});
		}
		action(container, submitLabel, async () => {
			await submit(values);
			window.close();
		});
	});
	window.open();
	return window;
}
function applicationDetails(area, changed) {
 const values = { requestedAmount: '', requestedUnit: 'M', purpose: '' };
 area.createEl('p', { text: '请填写账号开通信息。' });
 new Setting(area).setName('预计使用空间')
  .addText(input => {
   input.inputEl.type = 'number'; input.inputEl.min = '1'; input.inputEl.max = '1048576'; input.inputEl.step = '1';
   input.inputEl.placeholder = '输入数值'; input.onChange(value => { values.requestedAmount = value; changed(); });
  })
  .addDropdown(input => input.addOptions({ M: 'MB', G: 'GB' }).setValue('M').onChange(value => { values.requestedUnit = value; changed(); }));
 new Setting(area).setName('使用用途').setDesc('请简要说明用途，最多500字。')
  .addTextArea(input => { input.inputEl.maxLength = 500; input.onChange(value => { values.purpose = value; changed(); }); });
 return () => {
  const amount = Number(values.requestedAmount), purpose = values.purpose.trim();
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > 1048576 || !['M','G'].includes(values.requestedUnit) || !purpose || purpose.length > 500)
   throw new Error('请填写有效的预计空间（正整数、MB或GB）及使用用途（1至500字）。');
  return { requestedAmount: amount, requestedUnit: values.requestedUnit, purpose };
 };
}
class SyncLogView extends ItemView {
	constructor(leaf, owner) {
		super(leaf);
		this.owner = owner;
	}
	getViewType() {
		return logViewType;
	}
	getDisplayText() {
		return t('msg_6dc05b92e9');
	}
	getIcon() {
		return 'refresh-cw';
	}
	async onOpen() {
		this.owner.logViews.add(this);
		this.render();
	}
	async onClose() {
		this.owner.logViews.delete(this);
		this.body = undefined;
	}
	render() {
		if (!this.body) this.body = this.owner.renderTasks(this.contentEl);
		this.owner.renderTaskRows(this.body);
	}
}
const defaults = () => ({
	recentEnabled: true,
	noteSearchEnabled: true,
	backgroundTray: true,
	explorerSorting: { enabled: true, grouping: 'files-first', primary: 'mtime-desc', secondary: 'none', folderPrimary: 'name-asc', folderSecondary: 'none', includeUpdated: true },
	origin: edition.serviceOrigin ?? '',
	workspace: '',
	label: t('msg_0b72b4fc33'),
	direction: 'both',
	interval: 3,
	autoChanges: true,
	autoStartup: true,
	autoTimer: true,
	notifications: 'all',
	attachmentMiB: 256,
	ignored: [],
	configuration: {
		settings: true,
		editor: true,
		appearance: true,
		hotkeys: true,
		bookmarks: true,
		coreEnabled: true,
		coreSettings: [],
		plugins: 'all',
		pluginCode: true,
		pluginData: true,
		pluginEnabled: true,
		themes: true,
		codeSnippets: true,
	},
	lan: '',
	lanAcceleration: true,
	excludedExtensions: [],
});
const runtimeKey = Symbol.for('smart-sync:active-runtime-per-app');
window[runtimeKey] ??= new WeakMap();
const runtimes = window[runtimeKey];

export function abortableYield(signal, schedule = done => window.setTimeout(done, 0), cancel = handle => window.clearTimeout(handle)) {
	return new Promise((resolve, reject) => {
		if (signal.aborted) { reject(new DOMException('Synchronization stopped', 'AbortError')); return; }
		let handle;
		const abort = () => { cancel(handle); signal.removeEventListener('abort', abort); reject(new DOMException('Synchronization stopped', 'AbortError')); };
		signal.addEventListener('abort', abort, { once: true });
		try { handle = schedule(() => { signal.removeEventListener('abort', abort); resolve(); }); }
		catch (error) { signal.removeEventListener('abort', abort); reject(error); }
	});
}

// R169: display ordering only; never rename files or change transfer order.
export function parseUpdatedTime(value) {
	if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : undefined;
	if (typeof value !== 'string') return undefined;
	const text = value.trim();
	const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(text);
	if (!match) return undefined;
	const [, year, month, day, hour = '0', minute = '0', second = '0'] = match;
	const y = Number(year), m = Number(month), d = Number(day);
	if (y < 1000 || m < 1 || m > 12 || d < 1 || d > new Date(y, m, 0).getDate() || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return undefined;
	const time = Date.parse(text.length === 10 ? `${text}T00:00:00` : text.replace(' ', 'T'));
	return Number.isFinite(time) ? time : undefined;
}
export function frontmatterUpdatedTime(frontmatter) {
	let latest;
	for (const [key, value] of Object.entries(frontmatter ?? {})) {
		if (key.toLowerCase() !== 'updated') continue;
		const time = parseUpdatedTime(value);
		if (time !== undefined) latest = latest === undefined ? time : Math.max(latest, time);
	}
	return latest;
}
export function explorerComparator(options, readUpdated, readPinned) {
	const names = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
	const dates = new WeakMap();
	const folder = file => Array.isArray(file.children);
	const timestamp = (file, key) => {
		if (!folder(file)) {
			const base = Number.isFinite(file.stat?.[key]) ? file.stat[key] : undefined;
			if (key !== 'mtime' || options.includeUpdated === false || !file.path.toLowerCase().endsWith('.md')) return base;
			let cached = dates.get(file);
			if (!cached) {
				const updated = readUpdated?.(file);
				cached = { mtime: Number.isFinite(updated) ? base === undefined ? updated : Math.max(base, updated) : base };
				dates.set(file, cached);
			}
			return cached.mtime;
		}
		let cached = dates.get(file);
		if (!cached) { cached = {}; dates.set(file, cached); }
		if (Object.hasOwn(cached, key)) return cached[key];
		let result;
		for (const child of file.children) {
			const value = timestamp(child, key);
			if (value !== undefined) result = result === undefined ? value : (key === 'ctime' ? Math.min(result, value) : Math.max(result, value));
		}
		cached[key] = result;
		return result;
	};
	const compare = (a, b, rule) => {
		if (!rule || rule === 'none') return 0;
		const [key, order] = rule.split('-');
		const sign = order === 'desc' ? -1 : 1;
		if (key === 'name') return sign * names.compare(a.name, b.name);
		const av = timestamp(a, key), bv = timestamp(b, key);
		// Empty folders and absent timestamps always follow dated entries.
		if (av === undefined || bv === undefined) return av === bv ? 0 : av === undefined ? 1 : -1;
		return sign * (av - bv);
	};
	return (left, right) => {
		const a = left.file ?? left, b = right.file ?? right;
		const pinned = Number(readPinned?.(b) === true) - Number(readPinned?.(a) === true);
		if (pinned) return pinned;
		if (folder(a) !== folder(b) && options.grouping !== 'mixed')
			return (folder(a) ? -1 : 1) * (options.grouping === 'files-first' ? -1 : 1);
		const separateFolders = options.grouping !== 'mixed' && folder(a) && folder(b);
		const primary = separateFolders ? options.folderPrimary ?? options.primary : options.primary;
		const secondary = separateFolders ? options.folderSecondary ?? options.secondary : options.secondary;
		return compare(a, b, primary) || compare(a, b, secondary) || names.compare(a.name, b.name) || a.path.localeCompare(b.path);
	};
}

export function cleanExplorerSorting(value, readLevels = true) {
	const rules = ['name-asc', 'name-desc', 'ctime-asc', 'ctime-desc', 'mtime-asc', 'mtime-desc'];
	const result = {
		enabled: value?.enabled === true,
		grouping: ['folders-first', 'files-first', 'mixed'].includes(value?.grouping) ? value.grouping : 'folders-first',
		primary: rules.includes(value?.primary) ? value.primary : 'name-asc',
		secondary: rules.includes(value?.secondary) ? value.secondary : 'none',
		folderPrimary: rules.includes(value?.folderPrimary) ? value.folderPrimary : rules.includes(value?.primary) ? value.primary : 'name-asc',
		folderSecondary: [...rules, 'none'].includes(value?.folderSecondary) ? value.folderSecondary : rules.includes(value?.secondary) ? value.secondary : 'none',
		includeUpdated: value?.includeUpdated !== false,
	};
	if (readLevels) {
		const levels = {};
		let inherited = { ...result };
		for (const level of ['2', '3', '4', 'other']) {
			const entry = value?.levels?.[level];
			if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
			const custom = cleanExplorerSorting({ ...inherited, ...entry }, false);
			delete custom.enabled;
			levels[level] = { ...custom, inherit: entry.inherit !== false };
			if (entry.inherit === false) inherited = { ...custom, enabled: result.enabled };
		}
		if (Object.keys(levels).length) result.levels = levels;
	}
	return result;
}

export function explorerSortingAtDepth(value, depth = 1) {
	const sorting = cleanExplorerSorting(value);
	let effective = { ...sorting };
	delete effective.levels;
	const band = Number.isSafeInteger(depth) && depth > 1 ? Math.min(depth, 5) : 1;
	for (let number = 2; number <= band; number++) {
		const entry = sorting.levels?.[number === 5 ? 'other' : String(number)];
		if (entry?.inherit === false) effective = { ...effective, ...entry, enabled: sorting.enabled };
	}
	delete effective.inherit;
	return effective;
}

export function attachExplorerSorting(view, readOptions, readUpdated, readPinned) {
	if (typeof view?.getSortedFolderItems !== 'function' || typeof view.requestSort !== 'function') return undefined;
	const own = Object.getOwnPropertyDescriptor(view, 'getSortedFolderItems');
	const original = view.getSortedFolderItems;
	const decorated = new Set();
	const wrapped = function (...args) {
		const items = original.apply(this, args);
		const path = args[0]?.path ?? '';
		const options = explorerSortingAtDepth(readOptions(), path.split('/').filter(Boolean).length + 1);
		if (!Array.isArray(items)) return items;
		for (const item of items) {
			const title = item.el?.querySelector?.('.nav-file-title, .nav-folder-title') ?? item.selfEl;
			if (!title?.classList) continue;
			title.classList.toggle('smart-sync-note-pinned', readPinned?.(item.file ?? item) === true);
			decorated.add(title);
		}
		if (options.enabled) return items.slice().sort(explorerComparator(options, readUpdated, readPinned));
		return readPinned ? items.slice().sort((a,b) => Number(readPinned(b.file ?? b) === true) - Number(readPinned(a.file ?? a) === true)) : items;
	};
	view.getSortedFolderItems = wrapped;
	return () => {
		for (const title of decorated) title.classList.remove('smart-sync-note-pinned');
		decorated.clear();
		// Leave a later plugin's wrapper intact; it will see disabled options on unload.
		if (view.getSortedFolderItems === wrapped) {
			if (own) Object.defineProperty(view, 'getSortedFolderItems', own);
			else delete view.getSortedFolderItems;
		}
		view.requestSort();
	};
}

export async function refreshPreservedNote(vault, cache, file) {
	if (!file?.path?.toLowerCase().endsWith('.md') || typeof cache?.saveFileCache !== 'function' ||
		typeof cache.computeFileMetadataAsync !== 'function' || typeof vault?.trigger !== 'function') return;
	cache.saveFileCache(file.path, null);
	await cache.computeFileMetadataAsync(file);
	vault.trigger('modify', file);
}

// Only preserve time for the exact positional replacements supplied by the
// host's active link-maintenance operation; extra prose changes never qualify.
export function attachLinkMaintenanceTimes(vault, cache) {
	if (typeof vault?.process !== 'function' || typeof vault.trigger !== 'function' || typeof cache?.updateInternalLinks !== 'function' ||
		typeof cache.saveFileCache !== 'function' || typeof cache.computeFileMetadataAsync !== 'function') return undefined;
	const pending = new Map();
	let active = true;
	const processOwn = Object.getOwnPropertyDescriptor(vault, 'process');
	const updateOwn = Object.getOwnPropertyDescriptor(cache, 'updateInternalLinks');
	const process = vault.process, update = cache.updateInternalLinks;
	const processWrapped = function (file, transform, options) {
		const candidates = pending.get(file?.path);
		if (!active || !candidates?.size || !file.path.toLowerCase().endsWith('.md') || options?.mtime !== undefined)
			return process.call(this, file, transform, options);
		const writeOptions = { ...options };
		let preserved = false;
		const writing = process.call(this, file, data => {
			const mtime = file.stat?.mtime;
			const result = transform(data);
			delete writeOptions.mtime;
			if (!active || typeof data !== 'string' || typeof result !== 'string' || result === data ||
				!Number.isSafeInteger(mtime) || mtime < 0 || mtime > 8640000000000000) return result;
			for (const edits of candidates) {
				let offset = 0, valid = true;
				const pieces = [];
				for (const edit of edits) {
					if (edit.start < offset || edit.end > data.length || data.slice(edit.start, edit.end) !== edit.original) { valid = false; break; }
					pieces.push(data.slice(offset, edit.start), edit.text);
					offset = edit.end;
				}
				if (valid && pieces.concat(data.slice(offset)).join('') === result) {
					writeOptions.mtime = mtime;
					preserved = true;
					break;
				}
			}
			return result;
		}, writeOptions);
		return Promise.resolve(writing).then(async result => {
			if (preserved) {
				// Equal-size links can change without changing the stat signature.
				// Invalidate via the host cache API and publish its normal modify
				// event so metadata, editors and sync fingerprints see the new text.
				await refreshPreservedNote(vault, cache, file);
			}
			return result;
		});
	};
	const updateWrapped = function (updates, ...args) {
		if (!active) return update.call(this, updates, ...args);
		const registered = [];
		// Unknown reference shapes (including YAML reserialization) keep the
		// host's normal time rather than guessing whether prose also changed.
		if (typeof updates?.keys === 'function' && typeof updates?.get === 'function')
			for (const path of updates.keys()) {
				const entries = updates.get(path);
				if (!Array.isArray(entries) || !entries.length) continue;
				const edits = entries.map(entry => ({ start: entry?.reference?.position?.start?.offset,
					end: entry?.reference?.position?.end?.offset, original: entry?.reference?.original, text: entry?.change }));
				if (edits.some(edit => !Number.isSafeInteger(edit.start) || !Number.isSafeInteger(edit.end) || edit.start < 0 ||
					edit.end < edit.start || typeof edit.original !== 'string' || typeof edit.text !== 'string')) continue;
				edits.sort((a, b) => a.start - b.start);
				const candidates = pending.get(path) ?? new Set();
				candidates.add(edits); pending.set(path, candidates); registered.push([path, candidates, edits]);
			}
		const cleanup = () => {
			for (const [path, candidates, edits] of registered) {
				candidates.delete(edits);
				if (!candidates.size && pending.get(path) === candidates) pending.delete(path);
			}
		};
		try { return Promise.resolve(update.call(this, updates, ...args)).finally(cleanup); }
		catch (error) { cleanup(); throw error; }
	};
	vault.process = processWrapped; cache.updateInternalLinks = updateWrapped;
	return () => {
		active = false; pending.clear();
		for (const [owner, key, wrapped, own] of [[vault, 'process', processWrapped, processOwn], [cache, 'updateInternalLinks', updateWrapped, updateOwn]])
			if (owner[key] === wrapped) {
				if (own) Object.defineProperty(owner, key, own);
				else delete owner[key];
			}
	};
}

export default class IndependentSync extends Plugin {
	syncStage(stage) {
		if (!['connecting', 'unlocking', 'device', 'scanning', 'read', 'write', 'uploading', 'receiving', 'checkpoint', 'pins', 'diagnostics'].includes(stage) || !this.cycleActivity) return;
		const now = Date.now();
		this.cycleActivity.stage = stage;
		this.cycleActivity.progressAt = now;
		this.cycleActivity.stages[stage] = (this.cycleActivity.stages[stage] ?? 0) + 1;
	}
	recordTiming(stage, milliseconds) {
		if (!['read', 'write', 'hash', 'pack', 'checkpoint', 'removeTree', 'move', 'download', 'decrypt'].includes(stage) || !Number.isFinite(milliseconds)) return;
		this.phaseTimings ??= {};
		const item = this.phaseTimings[stage] ??= { calls: 0, milliseconds: 0 };
		item.calls++; item.milliseconds += Math.max(0, milliseconds);
	}
	async measurePhase(stage, work) {
		this.syncStage(stage);
		const started = performance.now();
		try { return await work(); } finally { this.syncStage(stage); this.recordTiming(stage, performance.now() - started); }
	}
	async loadData() {
		const saved = await super.loadData();
		const adapter = this.app.vault.adapter;
		if (!this.checkpoints && adapter && ['read', 'write', 'exists', 'mkdir', 'rename', 'remove'].every(name => typeof adapter[name] === 'function')) {
			if (typeof this.app.vault.configDir !== 'string') throw Error('Plugin metadata directory is unavailable');
			const folder = `${this.app.vault.configDir}/plugins/${this.manifest.id}/checkpoint-v1`;
			if (folder.split('/').some(part => !part || part === '.' || part === '..' || part.includes('\\'))) throw Error('Invalid plugin metadata directory');
			this.checkpoints = new ConnectionCheckpoints(adapter, folder, data => super.saveData(data));
		}
		if ([4, 5].includes(saved?.format) && !this.checkpoints) throw Error('Connection checkpoint storage is unavailable');
		return this.checkpoints ? this.checkpoints.load(saved) : saved;
	}
	async saveData(data) {
		return this.checkpoints ? this.checkpoints.save(data) : super.saveData(data);
	}
	notify(message, important = true) {
		if (important || this.data.settings.notifications === 'all') new Notice(message);
	}
	async onload() {
		try { requireRuntime(); } catch (error) { new Notice(failureMessage(error)); throw error; }
		const retired = runtimes.get(this.app);
		if (retired && retired !== this && retired.manifest.id !== this.manifest.id && !retired.stopped) {
			const error = Object.assign(new Error('Disable the other sync edition in this vault first'), { code: 'EDITION_ALREADY_ACTIVE' });
			new Notice(failureMessage(error)); throw error;
		}
		if (retired && retired !== this) await retired.running?.catch(() => {});
		runtimes.set(this.app, this);
		this.abortController = new AbortController();
		const prior = await this.loadData();
		if (prior && prior.format !== 3) throw new Error('Unsupported plugin configuration format');
		this.data = prior ?? {
			format: 3,
			localId: crypto.randomUUID(),
			settings: defaults(),
			connections: {},
		};
		this.data.settings = { ...defaults(), ...this.data.settings };
		if (typeof this.data.settings.configuration.pluginEnabled !== 'boolean')
			this.data.settings.configuration.pluginEnabled = true;
		this.data.settings.explorerSorting = cleanExplorerSorting(this.data.settings.explorerSorting);
		this.explorerSortViews = new Map();
		this.data.notePins ??= {};
		this.detachLinkMaintenanceTimes = attachLinkMaintenanceTimes(this.app.vault, this.app.metadataCache);
		const workspace = this.app.workspace;
		workspace.onLayoutReady?.(() => this.refreshExplorerSorting());
		if (workspace.on) this.registerEvent(workspace.on('layout-change', () => this.refreshExplorerSorting()));
		if (this.app.metadataCache?.on) {
			const refresh = () => {
				if (this.stopped || !this.data.settings.explorerSorting.enabled || this.data.settings.explorerSorting.includeUpdated === false) return;
				window.clearTimeout(this.explorerSortTimer);
				this.explorerSortTimer = window.setTimeout(() => this.refreshExplorerSorting(), 150);
			};
			for (const event of ['changed', 'resolved']) this.registerEvent(this.app.metadataCache.on(event, file => {
				refresh();
				for (const view of this.noteSearchViews ?? []) view.invalidate(file);
			}));
		}
		if (this.app.vault.on)
			for (const event of ['create', 'modify', 'delete', 'rename'])
				this.registerEvent(this.app.vault.on(event, () => {
					if (!this.data.settings.explorerSorting.enabled && !this.pinnedPaths?.size) return;
					window.clearTimeout(this.explorerSortTimer);
					this.explorerSortTimer = window.setTimeout(() => this.refreshExplorerSorting(), 150);
				}));
		// R138 replaces legacy size presets with always / on-note-open.
		if (workspace.on) this.registerEvent(workspace.on('file-menu', (menu, file) => {
			if (!this.canPinEntry(file)) return;
			menu.addItem(item => item.setTitle(t(this.isNotePinned(file.path) ? 'pin.unpin' : 'pin.pin'))
				.setIcon('pin').onClick(() => { void this.toggleNotePin(file).catch(error => this.notify(failureMessage(error))); }));
		}));
		if (workspace.on) this.registerEvent(workspace.on('files-menu', (menu, files) => {
			const entries = files.filter(file => this.canPinEntry(file));
			if (!entries.length) return;
			for (const pinned of [true, false]) {
				if (!entries.some(file => this.isNotePinned(file.path) !== pinned)) continue;
				menu.addItem(item => item.setTitle(t(pinned ? 'pin.pin' : 'pin.unpin')).setIcon('pin')
					.onClick(() => { void this.setNotePins(entries, pinned).catch(error => this.notify(failureMessage(error))); }));
			}
		}));
		if (this.app.vault.on) {
			this.registerEvent(this.app.vault.on('rename', (file, from) => {
				const { pins } = this.notePinContext();
				if (!moveNotePins(pins, from, file.path)) return;
				this.refreshExplorerSorting();
				this.scheduleNotePinSave();
			}));
			this.registerEvent(this.app.vault.on('delete', file => {
				const { pins, notes } = this.notePinContext();
				let changed = false;
				for (const path of pinPathSet(pins, notes)) if (path === file.path || path.startsWith(`${file.path}/`)) {
					changed = true;
					queueNotePin(pins, notes, path, false);
					pins.pending[path].deleted = true;
				}
				if (!changed) return;
				this.refreshExplorerSorting();
				this.scheduleNotePinSave();
			}));
		}
		this.data.settings.attachmentMiB = this.data.settings.attachmentMiB === 0 ? 0 : 256;
		if (!this.data.settings.workspace) this.data.settings.direction = 'both';
		delete this.data.settings.testOnly;
		this.data.renames ??= {};
		this.journal = new TaskJournal(this.data.tasks);
		this.taskTokens = new Map();
		this.taskScope = await fingerprint(
			new TextEncoder().encode(`${this.data.settings.origin}|${this.data.settings.workspace}`),
		);
		this.data.tasks = this.journal.snapshot();
		this.data.taskOutbox = new TaskJournal(this.data.taskOutbox, 2000)
			.snapshot()
			.filter((row) => row.status !== 'running');
		if (this.app.vault.on)
			this.registerEvent(
				this.app.vault.on('rename', (file, oldPath) => {
					if (this.applyingRemoteMove) return;
					this.recordLocalRename(oldPath, file.path);
				}),
			);
		this.running = undefined;
		this.events = [];
		this.data.reviewed ??= {};
		this.reviewApprovals = this.data.reviewed;
		this.accountAuthorized = this.secret('account').length >= 32;
		this.fileChanges = new Map();
		this.contentPriorities = new Map();
		this.startupInventory = new Set();
		for (const state of Object.values(this.data.connections))
			for (const [path, cached] of Object.entries(state.localIndex ?? {})) {
				try {
					const stamp = JSON.parse(cached.stamp);
					if (stamp.length !== 4 || !stamp.every(Number.isFinite) || !Number.isSafeInteger(stamp[3]) || stamp[3] < 0) continue;
					this.fileChanges.set(path, Math.max(this.fileChanges.get(path) ?? 0, stamp[3]));
					this.startupInventory.add(path);
				} catch { /* Invalid caches are rehashed through the normal path. */ }
			}
		this.logViews = new Set();
		registerNoteSearch(this);
		registerNoteEncryption(this);
		this.refreshBackgroundTray();
		this.registerView(logViewType, (leaf) => new SyncLogView(leaf, this));
		this.addRibbonIcon('refresh-cw', t('msg_6dc05b92e9'), async () => {
			const leaf =
				this.app.workspace.getLeavesOfType(logViewType)[0] ??
				this.app.workspace.getRightLeaf(false);
			if (!leaf) return;
			await leaf.setViewState({ type: logViewType, active: true });
			this.app.workspace.revealLeaf(leaf);
		});
		if (this.app.vault.on)
			for (const event of ['create', 'modify', 'delete', 'rename'])
				this.registerEvent(
					this.app.vault.on(event, (file, oldPath) => {
						for (const view of this.noteSearchViews) view.invalidate(file, oldPath);
						this.idleRounds = 0;
						this.inventoryRevision = (this.inventoryRevision ?? 0) + 1;
						for (const inventory of this.incrementalInventories?.values() ?? []) inventory.changed(event, file?.path);
						if (event === 'create' && file instanceof TFile && this.startupInventory.delete(file.path)) {
							const stat = file.stat;
							if (stat && [stat.size, stat.mtime, stat.ctime].every(Number.isFinite) && Object.values(this.data.connections).some(state => {
								const cached = state.localIndex?.[file.path];
								try { const stamp = JSON.parse(cached.stamp); return /^[a-f0-9]{64}$/.test(cached.digest) && cached.size === stat.size && stamp[0] === stat.size && stamp[1] === stat.mtime && stamp[2] === stat.ctime; } catch { return false; }
							})) return;
						}
						for (const path of [file?.path, oldPath].filter(Boolean)) {
							this.startupInventory.delete(path);
							this.fileChanges.set(path, (this.fileChanges.get(path) ?? 0) + 1);
							for (const state of Object.values(this.data.connections))
								if (file instanceof TFile) delete state.localIndex?.[path];
								else if (event !== 'create')
									for (const indexed of Object.keys(state.localIndex ?? {}))
										if (indexed === path || indexed.startsWith(`${path}/`))
											delete state.localIndex[indexed];
						}
						if (
							this.stopped ||
							this.data.settings.direction === 'paused' ||
							this.data.settings.autoChanges === false
						)
							return;
						if (event === 'modify' && file instanceof TFile && this.data.settings.workspace) {
							const binding = new URL(this.data.settings.origin).origin + '|' + this.data.settings.workspace;
							if (!this.contentPriorities.has(binding)) this.contentPriorities.set(binding, new Map());
							this.contentPriorities.get(binding).set(file.path, this.inventoryRevision);
						}
						window.clearTimeout(this.pendingTimer);
						this.pendingTimer = window.setTimeout(() => {
							this.requestChangedSynchronization();
						}, 250);
					}),
				);
		if (this.app.workspace.on) this.registerEvent(this.app.workspace.on('editor-change', (editor, view) => this.scheduleEditorSave(editor, view)));
		if (typeof document !== 'undefined' && this.registerDomEvent) {
			this.registerDomEvent(document, 'compositionstart', () => { this.editorComposing = true; });
			this.registerDomEvent(document, 'compositionend', () => {
				this.editorComposing = false;
				for (const item of this.editorSaves?.values() ?? []) this.scheduleEditorSave(item.editor, item.view);
			});
			this.registerDomEvent(document, 'visibilitychange', () => {
				if (document.visibilityState === 'visible' && this.automaticChangesAllowed()) {
					this.idleRounds = 0;
					void this.synchronize(undefined, undefined, true);
				}
			});
			this.registerDomEvent(window, 'online', () => {
				this.idleRounds = 0;
				if (this.automaticChangesAllowed()) void this.synchronize(undefined, undefined, true);
			});
		}
		this.status = this.addStatusBarItem();
		this.setStatus(t(this.data.manualSyncStopped ? 'task.stopped' : this.data.settings.direction === 'paused' ? 'msg_c4f91c861a' : 'sync.ready'));
		this.tab = new IndependentSettings(this.app, this);
		this.addSettingTab(this.tab);
		this.addCommand({
			id: 'synchronize-test-notebook',
			name: t('msg_bad42f9d54'),
			callback: () => {
				void this.requestSynchronization();
			},
		});
		this.addCommand({
			id: 'download-attachment',
			name: t('msg_b2836fd105'),
			callback: () => {
				void this.attachments();
			},
		});
		this.addCommand({
			id: 'version-history',
			name: t('msg_053298914b'),
			callback: () => {
				void this.history();
			},
		});
		this.addCommand({
			id: 'deleted-notes',
			name: t('msg_ac49330d61'),
			callback: () => {
				void this.trash();
			},
		});
		this.addCommand({
			id: 'conflict-copies',
			name: t('msg_9421ffe1ed'),
			callback: () => {
				void this.conflicts();
			},
		});
		for (const [id, name, method] of [
			['toggle-note-pin', t('pin.toggle'), 'toggleActiveNotePin'],
			['request-access', edition.edition === 'cn' ? t('billing.openPlans') : t('msg_35d9a6514c'), 'requestAccess'],
			['registered-login', t('msg_b567a0c85b'), 'enrollment'],
			['pair-new-device', t('msg_8b943b0cfd'), 'pairThisDevice'],
			['approve-device', t('msg_0fb566edf8'), 'approveDevice'],
			['manage-devices', t('msg_076ea01191'), 'devices'],
			['export-recovery', t('msg_e4a9223d61'), 'exportRecovery'],
			['import-recovery', t('msg_a8e75b0e80'), 'importRecovery'],
			['storage-controls', t('msg_b2a2c9dc30'), 'storageControls'],
			['sign-out', t('msg_23bf159dfc'), 'signOut'],
			['erase-account', t('msg_a7a1b0977a'), 'eraseAccount'],
			['local-presets', t('msg_92757d2798'), 'presets'],
			['sync-log', t('msg_4933e1a72c'), 'logs'],
		])
			this.addCommand({
				id,
				name,
				callback: () => {
					void this[method]().catch(error => this.notify(failureMessage(error)));
				},
			});
		const automaticStartedAt = Date.now();
		this.registerInterval(
			window.setInterval(() => {
				if (
					this.data.settings.direction !== 'paused' &&
					this.data.settings.autoTimer !== false &&
					Date.now() - (this.lastFinished ?? this.lastStarted ?? automaticStartedAt) >= this.data.settings.interval * 1000 * (this.idleRounds >= 3 ? Math.min(4, 1 + Math.floor(this.idleRounds / 3)) : 1)
				)
					void this.synchronize(undefined, undefined, true);
			}, 250),
		);
		this.registerInterval(
			window.setInterval(() => {
				if (
					!this.stopped &&
					!this.connecting &&
					!this.running &&
					!this.deviceStarting &&
					!this.data.manualSyncStopped &&
					!this.lanPeers &&
					this.data.settings.workspace &&
					this.secret('access').length >= 32
				) {
					this.deviceStarting = true;
					void this.connection()
						.catch(() => {})
						.finally(() => {
							this.deviceStarting = false;
						});
				}
			}, 5000),
		);
		if (
			this.data.settings.workspace &&
			this.data.settings.autoStartup !== false &&
			this.data.settings.direction !== 'paused'
		)
			this.pendingTimer = window.setTimeout(() => {
				void this.synchronize(undefined, undefined, true);
			}, 1000);
		if (this.app.workspace.on)
			this.registerEvent(
				this.app.workspace.on('file-open', (file) => {
					void this.downloadNoteAttachments(file).catch((error) =>
						this.notify(failureMessage(error)),
					);
				}),
			);
		this.app.workspace.onLayoutReady?.(() => {
			void this.downloadNoteAttachments(this.app.workspace.getActiveFile()).catch((error) =>
				this.notify(failureMessage(error)),
			);
		});

		if (typeof document !== 'undefined' && this.registerDomEvent)
			this.registerDomEvent(
				document,
				'click',
				(event) => {
					const anchor = event.target?.closest?.('a.internal-link');
					if (!anchor) return;
					const config = this.data.settings,
						state = this.data.connections[`${new URL(config.origin).origin}|${config.workspace}`];
					if (!state || this.running) return;
					const source = this.app.workspace.getActiveFile()?.path ?? '',
						entry = pendingAttachment(
							state.notes,
							anchor.getAttribute('data-href') ?? anchor.getAttribute('href'),
							source,
						);
					if (!entry) return;
					event.preventDefault();
					event.stopImmediatePropagation();
					void this.exclusive(async () => {
						const { engine } = await this.connection();
						await engine.download(entry[0]);
						await this.app.workspace.openLinkText(entry[1].path, source);
					}).catch((error) => this.notify(failureMessage(error)));
				},
				true,
			);
	}
	secret(name) {
		return (
			this.app.secretStorage.getSecret(`${this.manifest.id}-${this.data.localId}-${name}`) ?? ''
		);
	}
	setSecret(name, value) {
		if (this.stopped) throw new Error('Plugin is unloaded');
		if (this.running) {
			this.notify(t('msg_bea1edccdc'));
			this.tab?.update();
			return;
		}
		this.workspaceKeys = undefined;
		this.verifiedRoute = undefined;
		this.app.secretStorage.setSecret(`${this.manifest.id}-${this.data.localId}-${name}`, value);
	}
	async setting(name, value, configurationReady = false) {
		if (this.stopped) throw new Error('Plugin is unloaded');
		if (name === 'backgroundTray') {
			const previous = this.data.settings.backgroundTray;
			this.data.settings.backgroundTray = value === true;
			try { await this.saveData(this.data); }
			catch (error) { this.data.settings.backgroundTray = previous; throw error; }
			this.refreshBackgroundTray();
			return;
		}
		if (['recentEnabled', 'noteSearchEnabled'].includes(name)) {
			const previous = this.data.settings[name];
			this.data.settings[name] = value === true;
			try { await this.saveData(this.data); }
			catch (error) { this.data.settings[name] = previous; throw error; }
			await this.refreshNoteTools();
			return;
		}
		this.idleRounds = 0;
		if (['origin', 'workspace', 'lan'].includes(name)) {
			this.workspaceKeys = undefined;
			this.verifiedRoute = undefined;
		}
		if (name === 'configuration' && !configurationReady) {
			const binding = this.editorBinding();
			this.configurationPending = (this.configurationPending ?? 0) + 1;
			const previous = this.configurationSave;
			const saving = Promise.resolve().then(async () => {
				await previous?.catch(() => {});
				await this.running?.catch(() => {});
				if (this.stopped || binding !== this.editorBinding()) throw new Error('Configuration scope changed');
				const original = this.data.settings.configuration;
				const next = typeof value === 'function' ? value(original) : value;
				try { return await this.setting(name, next, true); }
				catch (error) {
					if (binding === this.editorBinding() && this.data.settings.configuration === next)
						this.data.settings.configuration = original;
					throw error;
				}
			}).finally(() => {
				this.configurationPending--;
				if (this.configurationSave === saving) this.configurationSave = undefined;
			});
			this.configurationSave = saving;
			return saving;
		}
		if (this.running) {
			this.notify(t('msg_bea1edccdc'));
			this.tab?.update();
			return;
		}
		this.data.settings[name] = value;
		if (['configuration', 'ignored', 'excludedExtensions', 'attachmentMiB'].includes(name)) {
			const connection =
				this.data.connections[
					`${new URL(this.data.settings.origin).origin}|${this.data.settings.workspace}`
				];
			if (connection) connection.cursor = 0;
		}
		if (
			[
				'configuration',
				'ignored',
				'excludedExtensions',
				'attachmentMiB',
				'direction',
				'origin',
				'workspace',
			].includes(name)
		)
			this.pendingPlan = undefined;
		await this.saveData(this.data);
		if (name === 'direction') {
			this.setStatus(t(value === 'paused' ? 'msg_c4f91c861a' : 'sync.ready'));
			this.tab?.update();
		}
	}
	updatedNoteTime(file) {
		return frontmatterUpdatedTime(this.app.metadataCache?.getFileCache(file)?.frontmatter);
	}
	async refreshPreservedWrite(path, previousTime, mtime) {
		if (path.toLowerCase().endsWith('.md') && mtime !== undefined && previousTime === mtime)
			await refreshPreservedNote(this.app.vault, this.app.metadataCache, this.app.vault.getAbstractFileByPath(path));
	}
	scheduleNotePinSave() {
		if (this.notePinSaveTimer) return;
		this.notePinSaveTimer = window.setTimeout(() => {
			this.notePinSaveTimer = undefined;
			void this.saveData(this.data).catch(() => this.notify(t('pin.saveFailed')));
		}, 250);
	}
	notePinContext() {
		const settings = this.data.settings;
		const binding = settings.workspace ? `${new URL(settings.origin).origin}|${settings.workspace}` : 'local';
		this.data.notePins ??= {};
		const pins = this.data.notePins[binding] ??= notePinState();
		// Only never-bound local operations are adopted. Bound libraries stay isolated.
		const local = this.data.notePins.local;
		if (binding !== 'local' && local) {
			for (const operation of Object.values(local.pending).sort((a,b) => a.counter - b.counter))
				if (!operation.deleted) queueNotePin(pins, {}, operation.path, operation.pinned);
			delete this.data.notePins.local;
		}
		return { pins, notes: this.data.connections[binding]?.notes ?? {}, binding };
	}
	isNotePinned(path) {
		const { pins, notes } = this.notePinContext();
		return pinPathSet(pins, notes).has(path);
	}
	async toggleActiveNotePin() {
		const file = this.app.workspace.getActiveFile();
		if (file instanceof TFile && file.path.toLowerCase().endsWith('.md')) await this.toggleNotePin(file);
	}
	async toggleNotePin(file) {
		if (!this.canPinEntry(file)) return;
		await this.setNotePins([file], !this.isNotePinned(file.path));
	}
	canPinEntry(file) {
		return (file instanceof TFile || file instanceof TFolder) && Boolean(file.path);
	}
	async setNotePins(files, pinned) {
		if (this.stopped) return;
		const { pins, notes } = this.notePinContext();
		const changes = new Map();
		for (const file of files) {
			if (!this.canPinEntry(file) || changes.has(file.path) || this.isNotePinned(file.path) === pinned) continue;
			const previous = pins.pending[file.path];
			queueNotePin(pins, notes, file.path, pinned);
			changes.set(file.path, { previous, operation: pins.pending[file.path] });
		}
		if (!changes.size) return;
		try { await this.saveData(this.data); }
		catch (error) {
			for (const [path, { previous, operation }] of changes) if (pins.pending[path] === operation) {
				if (previous) pins.pending[path] = previous; else delete pins.pending[path];
			}
			this.refreshExplorerSorting();
			throw error;
		}
		this.refreshExplorerSorting();
		this.notify(t(pinned ? 'pin.pinnedPending' : 'pin.unpinnedPending'));
		this.requestChangedSynchronization();
	}
	refreshExplorerSorting() {
		if (this.stopped) return;
		const { pins, notes } = this.notePinContext();
		this.pinnedPaths = pinPathSet(pins, notes);
		const enabled = this.data.settings.explorerSorting.enabled || this.pinnedPaths.size > 0;
		const views = new Set((this.app.workspace.getLeavesOfType?.('file-explorer') ?? []).map(leaf => leaf.view));
		for (const [view, detach] of this.explorerSortViews) {
			if (!views.has(view) || !enabled) {
				detach();
				this.explorerSortViews.delete(view);
			}
		}
		if (!enabled) return;
		for (const view of views) {
			if (!this.explorerSortViews.has(view)) {
				const detach = attachExplorerSorting(view, () => this.stopped ? { enabled: false } : this.data.settings.explorerSorting,
					file => this.updatedNoteTime(file), file => !this.stopped && this.pinnedPaths.has(file.path));
				if (detach) this.explorerSortViews.set(view, detach);
			}
			if (this.explorerSortViews.has(view)) view.requestSort();
		}
	}
	async setExplorerSorting(key, value, level = 'root') {
		if (this.stopped) throw new Error('Plugin is unloaded');
		const previous = this.data.settings.explorerSorting;
		if (level === 'root') this.data.settings.explorerSorting = cleanExplorerSorting({ ...previous, [key]: value });
		else {
			if (!['2', '3', '4', 'other'].includes(level)) throw Error('Invalid sorting level');
			const current = previous.levels?.[level] ?? { ...explorerSortingAtDepth(previous, level === 'other' ? 5 : Number(level)), inherit: true };
			this.data.settings.explorerSorting = cleanExplorerSorting({ ...previous,
				levels: { ...previous.levels, [level]: { ...current, [key]: value } } });
		}
		try { await this.saveData(this.data); }
		catch (error) { this.data.settings.explorerSorting = previous; throw error; }
		this.refreshExplorerSorting();
	}
	async reviewContext() {
		const settings = { ...this.data.settings };
		delete settings.explorerSorting;
		return {
			settings,
			generation: Object.values(this.data.connections).map((state) => state.generation),
		};
	}
	async reviewKey() {
		return fingerprint(
			new TextEncoder().encode(
				JSON.stringify({
					origin: this.data.settings.origin,
					workspace: this.data.settings.workspace,
					configuration: this.data.settings.configuration,
					ignored: this.data.settings.ignored,
					excludedExtensions: this.data.settings.excludedExtensions,
					direction: this.data.settings.direction,
					attachmentMiB: this.data.settings.attachmentMiB,
				}),
			),
		);
	}
	async connectionWizard() {
		new ChoiceWindow(this.app, t('msg_b9909135b2'), (area) => {
			area.createEl('p', { text: t('msg_44527e0e27') });
			action(area, t('msg_b9c3ee7c9e'), () => this.enrollment());
			action(area, t('msg_2c7acec995'), () => this.pairThisDevice());
			action(area, t('msg_b8ba8e75b9'), () => this.chooseWorkspace());
			action(area, t('msg_f33adfb467'), () => this.showSyncPlan());
		}).open();
	}
	async setAttachmentDownload(mode) {
		if (!['always', 'on-note-open'].includes(mode)) throw Error('Invalid attachment mode');
		if (this.running && !this.stopRun) throw operationBusy();
		const binding = this.editorBinding();
		const previousSave = this.attachmentSave;
		// Stop drains writes asynchronously. Reserve the settings change now so a
		// manual/automatic cycle cannot resume with the old policy during the save.
		this.configurationPending = (this.configurationPending ?? 0) + 1;
		const saving = (async () => {
			await previousSave?.catch(() => {});
			await this.stopRun;
			if (this.stopped || binding !== this.editorBinding()) throw Error('Configuration scope changed');
			if (this.running) throw operationBusy();
			const previous = this.data.settings.attachmentMiB;
			const connection = this.data.connections[`${new URL(this.data.settings.origin).origin}|${this.data.settings.workspace}`];
			const cursor = connection?.cursor;
			const plan = this.pendingPlan;
			try { await this.setting('attachmentMiB', mode === 'always' ? 256 : 0); }
			catch (error) {
				this.data.settings.attachmentMiB = previous;
				if (connection) connection.cursor = cursor;
				this.pendingPlan = plan;
				throw error;
			}
		})().finally(() => {
			this.configurationPending--;
			if (this.attachmentSave === saving) this.attachmentSave = undefined;
		});
		this.attachmentSave = saving;
		await saving;
		this.tab?.update();
		if (mode === 'on-note-open' && !this.configurationPending)
			await this.downloadNoteAttachments(this.app.workspace.getActiveFile());
	}
	async downloadNoteAttachments(file) {
		if (!(file instanceof TFile) || !file.path.toLowerCase().endsWith('.md')) return;
		const settings = this.data.settings;
		if (
			this.stopped || this.stopping || this.data.manualSyncStopped ||
			settings.attachmentMiB !== 0 ||
			settings.direction === 'paused' ||
			!settings.workspace
		)
			return;
		const scope = `${settings.origin}|${settings.workspace}`;
		if (this.running) await this.running.catch(() => {});
		if (
			this.stopped || this.stopping || this.data.manualSyncStopped ||
			this.running ||
			scope !== `${settings.origin}|${settings.workspace}` ||
			settings.attachmentMiB !== 0 ||
			settings.direction === 'paused'
		)
			return;
		await this.exclusive(async () => {
			const { api, engine } = await this.connection();
			if (
				engine.direction === 'send' ||
				engine.direction === 'paused' ||
				engine.remoteMode === 'send' ||
				engine.remoteMode === 'paused'
			)
				return;
			const cache = this.app.metadataCache?.getFileCache(file);
			let links = [...(cache?.embeds ?? []), ...(cache?.links ?? [])].map((link) => link.link);
			if (!cache || !links.length) {
				const text = new TextDecoder().decode(await this.app.vault.readBinary(file));
				links = [
					...Array.from(text.matchAll(/!?\[\[([^\]]+)\]\]/g), (match) => match[1]),
					...Array.from(
						text.matchAll(/!?\[[^\]]*\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+[^)]*)?\)/g),
						(match) => match[1].replace(/^<|>$/g, ''),
					),
				];
			}
			const notes = new Set();
			for (const href of links) {
				const resolved = this.app.metadataCache?.getFirstLinkpathDest(
					href.split('#')[0].split('|')[0],
					file.path,
				);
				const entry = pendingAttachment(
					engine.state.notes,
					resolved?.path ?? href,
					resolved ? '' : file.path,
				);
				if (entry) notes.add(entry[0]);
			}
			for (const note of notes) {
				this.ensureCurrent(api);
				if (
					this.stopped ||
					this.data.settings.direction === 'paused' ||
					this.data.settings.attachmentMiB !== 0
				)
					return;
				await engine.download(note);
			}
		});
	}

	async applyDevicePreset(name) {
		if (!['phone', 'tablet', 'desktop', 'all'].includes(name)) return;
		await this.applyAttachmentLimit({ phone: 2, tablet: 8, desktop: 32, all: 256 }[name]);
	}
	async applyAttachmentLimit(limit) {
		if (!Number.isFinite(limit) || limit < 0 || limit > 256)
			throw Error('Attachment limit must be between 0 and 256 MB');
		if (this.running) throw operationBusy();
		await this.setting('direction', 'paused');
		await this.setting('attachmentMiB', limit);
		this.tab?.update();
		this.notify(t('msg_170f59f23f'));
	}
	confirmCoreSync(input) {
		input.setValue(false);
		const dialog = new ChoiceWindow(this.app, t('msg_2aaf490ae8'), (area) => {
			area.createEl('p', { text: t('core.explain') });
			action(area, t('core.enable'), async () => {
				await this.setting(
					'configuration',
					current => cleanConfiguration({ ...current, coreEnabled: true }),
				);
				if (this.data.settings.configuration.coreEnabled !== true) return;
				input.setValue(true);
				this.notify(t('core.saved'));
				dialog.close();
			});
			action(area, t('core.cancel'), async () => dialog.close());
		});
		dialog.open();
		return dialog;
	}
	async setConfigurationCategory(kind, enabled) {
		const update = (current) => {
			const next = cleanConfiguration(current);
			if (kind === 'code' || kind === 'data') {
				next[kind === 'code' ? 'pluginCode' : 'pluginData'] = enabled;
				if (enabled)
					for (const [id, rule] of Object.entries(next.pluginRules)) {
						delete rule[kind];
						if (!Object.keys(rule).length) delete next.pluginRules[id];
					}
			} else if (kind === 'themes') {
				next.themes = enabled;
				next.codeSnippets = enabled;
				if (enabled) {
					delete next.themeNames;
					next.snippets = [];
				}
			} else throw Error('Unknown configuration category');
			return next;
		};
		try {
			await this.setting('configuration', update);
		} catch (error) {
			this.notify(failureMessage(error));
			return false;
		}
		this.tab?.update();
		return true;
	}
	async configurationPicker(kind = 'all') {
		if (this.configurationWindow) return this.configurationWindow;
		const adapter = this.app.vault.adapter,
			root = this.app.vault.configDir;
		if (!adapter || !root) throw Error('Configuration directory unavailable');
		let config = cleanConfiguration(this.data.settings.configuration),
			closed = false,
			loading = false;
		const scopeKey = () =>
			`${this.data.settings.origin}|${this.data.settings.workspace}|${this.data.localId}`;
		const scope = scopeKey();
		const live = () => !closed && !this.stopped && scopeKey() === scope;
		let controller = new AbortController();
		const pluginNames = new Set(Object.keys(config.pluginRules));
		const themeNames = new Set(config.themeNames ?? []),
			snippetNames = new Set(config.snippets ?? []);
		const cache =
			this.configurationCatalog?.scope === scope
				? this.configurationCatalog
				: { scope, after: 0, entries: new Map() };
		this.configurationCatalog = cache;
		const includePath = (path) => {
			const prefix = `${CONFIG_NAMESPACE}/`;
			if (!path?.startsWith(prefix)) return;
			const parts = path.slice(prefix.length).split('/');
			if (parts[0] === 'plugins' && parts.length === 3) pluginNames.add(parts[1]);
			if (parts[0] === 'themes' && parts.length === 3) themeNames.add(parts[1]);
			if (parts[0] === 'snippets' && parts.length === 2 && parts[1].endsWith('.css'))
				snippetNames.add(parts[1]);
		};
		for (const entry of cache.entries.values()) includePath(entry.path);
		let statusText = t('configuration.localLoading'),
			feedback;
		const setFeedback = (text) => {
			statusText = text;
			if (live()) feedback?.setText(text);
		};
		const allowedPlugin = (id) =>
			configurationScope({ plugins: 'all', ownId: this.manifest.id }).allowed(
				`plugins/${id}/data.json`,
			);
		const save = async (next) => {
			if (!live()) return false;
			try {
				await this.setting('configuration', current => cleanConfiguration(next(cleanConfiguration(current))));
				this.tab?.update();
			} catch (error) {
				this.notify(failureMessage(error));
				return false;
			}
			config = cleanConfiguration(this.data.settings.configuration);
			return true;
		};
		const dialog = new ChoiceWindow(this.app, t('msg_d06a85ea95'), (area) => {
			feedback = area.createEl('p', { text: statusText });
			area.createEl('p', { text: t('configuration.reload') });
			if (kind === 'all' || kind === 'code' || kind === 'data') {
				for (const channel of kind === 'all' ? ['code', 'data'] : [kind]) {
					new Setting(area)
						.setName(
							t(channel === 'code' ? 'configuration.pluginCode' : 'configuration.pluginData'),
						)
						.addToggle((input) => {
							const enabled = configurationEnabled(config, channel);
							input.setValue(enabled).onChange(async (value) => {
								if (live()) await this.setConfigurationCategory(channel, value);
								config = cleanConfiguration(this.data.settings.configuration);
								if (live()) {
									area.empty();
									dialog.render(area);
								}
							});
						});
				}
				area.createEl('p', { text: t('configuration.individualHelp') });
				for (const id of [...pluginNames].sort()) {
					if (!allowedPlugin(id)) continue;
					const rule = config.pluginRules[id] ?? {};
					for (const channel of kind === 'all' ? ['code', 'data'] : [kind]) {
						const enabled = channel === 'code' ? config.pluginCode : config.pluginData;
						const fallback =
							channel === 'code'
								? config.plugins === 'all'
								: ['all', 'settings'].includes(config.plugins);
						new Setting(area)
							.setName(`${id} · ${t(channel === 'code' ? 'msg_d6e5b68ca0' : 'msg_b1bc554af4')}`)
							.addToggle((input) =>
								input
									.setValue(enabled !== false && (rule[channel] ?? enabled ?? fallback))
									.onChange(async (value) => {
										const result = await save(next => {
										const currentRule = next.pluginRules[id] ?? {};
										const property = channel === 'code' ? 'pluginCode' : 'pluginData';
										if (next[property] === false) {
											const other = channel === 'code' ? 'pluginData' : 'pluginCode';
											next[other] ??=
												other === 'pluginCode'
													? next.plugins === 'all'
													: ['all', 'settings'].includes(next.plugins);
											next.plugins = 'none';
											delete next[property];
											for (const rule of Object.values(next.pluginRules)) rule[channel] = false;
										}
										next.pluginRules[id] = {
											code: currentRule.code ?? next.pluginCode ?? next.plugins === 'all',
											data:
												currentRule.data ??
												next.pluginData ??
												['all', 'settings'].includes(next.plugins),
											...(next.pluginRules[id] ?? {}),
											[channel]: value,
										};
										return next;
										});
										if (result) config = cleanConfiguration(this.data.settings.configuration);
										if (live()) {
											area.empty();
											dialog.render(area);
										}
									}),
							);
					}
				}
			}
			if (kind === 'all' || kind === 'themes' || kind === 'core') {
				const groups =
					kind === 'core' ? [[coreFiles, 'coreSettings']] : [[...themeNames].sort(), 'themeNames'];
				const selectedGroups =
					kind === 'core'
						? groups
						: [
								groups,
								[[...snippetNames].sort(), 'snippets'],
								...(kind === 'all' ? [[coreFiles, 'coreSettings']] : []),
							];
				for (const [names, key] of selectedGroups)
					for (const name of names) {
						const selected =
							key === 'themeNames'
								? config.themes === true && (!config.themeNames || config.themeNames.includes(name))
								: key === 'snippets'
									? (config.codeSnippets === true &&
											(!config.snippets?.length || config.snippets.includes(name))) ||
										(config.codeSnippets !== false && config.snippets?.includes(name))
									: config.coreSettings?.includes(name);
						new Setting(area)
							.setName(
								`${t(key === 'themeNames' ? 'msg_788db1cfec' : key === 'snippets' ? 'msg_2c179f3e94' : 'msg_a4de27e3cc')} · ${name}`,
							)
							.addToggle((input) =>
								input.setValue(!!selected).onChange(async (value) => {
									await save(next => {
									let chosen = next[key] ?? [];
									if (key === 'themeNames' && !next.themeNames && next.themes)
										chosen = [...themeNames];
									if (key === 'snippets' && next.codeSnippets && !chosen.length)
										chosen = [...snippetNames];
									next[key] = value
										? [...new Set([...chosen, name])]
										: chosen.filter((item) => item !== name);
									if (key === 'themeNames') next.themes = next[key].length > 0;
									if (key === 'snippets') next.codeSnippets = next[key].length > 0;
									return next;
									});
									if (live()) {
										area.empty();
										dialog.render(area);
									}
								}),
							);
					}
			}
			if (this.data.settings.workspace && kind !== 'core')
				action(area, t('configuration.cloudRefresh'), async () => {
					if (!loading && live()) dialog.ready = loadCloud();
				});
		});
		this.configurationWindow = dialog;
		dialog.onClose = () => {
			closed = true;
			controller.abort();
			dialog.contentEl.empty();
			if (this.configurationWindow === dialog) this.configurationWindow = undefined;
		};
		const loadCloud = async () => {
			if (!live() || loading || !this.data.settings.workspace || kind === 'core') return;
			loading = true;
			if (controller.signal.aborted) controller = new AbortController();
			setFeedback(t('configuration.cloudLoading', { count: 0 }));
			const timeout = window.setTimeout(() => controller.abort(), 20000);
			const cancellation = cancellationScope([this.abortController.signal, controller.signal]);
			try {
				const api = this.api();
				api.signal = cancellation.signal;
				const info = await api.info();
				const keys = await unlockWorkspace(this.secret('encryption'), info.salt);
				if ((await workspaceProof(keys)) !== info.proof)
					throw Error('Notebook encryption check failed');
				const known = this.data.connections[`${api.origin}|${api.workspace}`]?.notes ?? {};
				let count = 0;
				for (;;) {
					if (!live()) return;
					const page = await api.feed(cache.after);
					if (
						!Array.isArray(page.entries) ||
						typeof page.more !== 'boolean' ||
						(page.more && !page.entries.length)
					)
						throw Error('Invalid configuration feed');
					for (const entry of page.entries) {
						if (!live()) return;
						if (!Number.isSafeInteger(entry.sequence) || entry.sequence <= cache.after)
							throw Error('Invalid configuration sequence');
						if (entry.removed) cache.entries.delete(entry.note);
						else {
							const prior = known[entry.note];
							const info =
								prior && prior.revision >= entry.sequence
									? { path: prior.path }
									: await inspectNote(keys, api.workspace, entry.note, entry.manifest, (address) =>
											api.load(address),
										);
							if (!live()) return;
							if (info.path.startsWith(`${CONFIG_NAMESPACE}/`)) {
								cache.entries.set(entry.note, { path: info.path });
								includePath(info.path);
							}
						}
						cache.after = entry.sequence;
						if (++count % 25 === 0) setFeedback(t('configuration.cloudLoading', { count }));
					}
					if (!page.more) break;
				}
				setFeedback(t('configuration.ready'));
			} catch {
				if (live()) setFeedback(t('configuration.offline'));
			} finally {
				window.clearTimeout(timeout);
				cancellation.dispose();
				loading = false;
				if (live()) {
					dialog.contentEl.empty();
					dialog.render(dialog.contentEl);
				}
			}
		};
		dialog.open();
		dialog.ready = (async () => {
			try {
				const list = async (path) =>
					(await adapter.exists(path)) ? adapter.list(path) : { files: [], folders: [] };
				const [plugins, themes, snippets] = await Promise.all([
					list(`${root}/plugins`),
					list(`${root}/themes`),
					list(`${root}/snippets`),
				]);
				if (!live()) return;
				for (const path of plugins.folders) pluginNames.add(path.split('/').at(-1));
				for (const path of themes.folders) themeNames.add(path.split('/').at(-1));
				for (const path of snippets.files)
					if (path.endsWith('.css')) snippetNames.add(path.split('/').at(-1));
				setFeedback(t('configuration.ready'));
				dialog.contentEl.empty();
				dialog.render(dialog.contentEl);
				await loadCloud();
			} catch {
				if (live()) setFeedback(t('configuration.localUnavailable'));
			}
		})();
		return dialog;
	}
	async exclusionPicker() {
		if (this.exclusionWindow) return this.exclusionWindow;
		const selected = new Set(this.data.settings.ignored), paths = new Map();
		const binding = () => JSON.stringify([this.data.settings.origin, this.data.settings.workspace, this.data.localId, this.secret('access'), this.secret('encryption')]);
		const expected = binding();
		let controller = new AbortController();
		let closed = false, loading = true, complete = false, query = '', page = 0, status = t('exclusions.loading');
		const live = () => !closed && !this.stopped && binding() === expected;
		const rebuild = entries => {
			paths.clear();
			for (const info of entries.values()) {
				if (info.path.startsWith(CONFIG_NAMESPACE + '/')) continue;
				const path = safeNotePath(info.path);
				paths.set(path, info.kind === 'folder' ? 'folder' : 'file');
				const parents = path.split('/'); parents.pop();
				while (parents.length) { paths.set(parents.join('/'), 'folder'); parents.pop(); }
			}
			for (const path of selected) if (!paths.has(path)) paths.set(path, 'savedRule');
		};
		rebuild(new Map());
		const dialog = new ChoiceWindow(this.app, t('exclusions.title'), area => {
			area.createEl('p', { text: t('exclusions.help') });
			area.createEl('p', { text: status });
			const list = area.createDiv();
			const render = () => {
				list.empty();
				const matches = [...paths].filter(([path]) => path.toLowerCase().includes(query.toLowerCase())).sort((a,b) => a[0].localeCompare(b[0]));
				if (page * 100 >= matches.length) page = 0;
				list.createEl('p', { text: t('exclusions.count', { count: selected.size, total: matches.length }) });
				for (const [path,kind] of matches.slice(page * 100, (page + 1) * 100))
					new Setting(list).setName(t('exclusions.' + kind) + ' · ' + path).addToggle(input => input.setValue(selected.has(path)).onChange(value => {
						if (value) selected.add(path); else selected.delete(path);
					}));
				if (matches.length > 100) action(list, t('exclusions.next'), async () => { page = (page + 1) % Math.ceil(matches.length / 100); render(); });
			};
			new Setting(area).setName(t('exclusions.search')).addText(input => input.setValue(query).onChange(value => { query = value; page = 0; render(); }));
			if (!loading && !complete) action(area, t('exclusions.retry'), async () => { dialog.ready = load(); await dialog.ready; });
			action(area, t('exclusions.save'), async () => {
				if (!live()) { this.notify(t('exclusions.changed')); return; }
				if (!complete) { this.notify(status); return; }
				if (this.running) { this.notify(t('msg_bea1edccdc')); return; }
				const previous = this.data.settings.ignored;
				try { await this.setting('ignored', [...selected].sort()); }
				catch (error) { this.data.settings.ignored = previous; throw error; }
				this.notify(t('exclusions.saved')); dialog.close();
			});
			render();
		});
		const refresh = () => { if (live()) { dialog.contentEl.empty(); dialog.render(dialog.contentEl); } };
		const load = async () => {
			if (controller.signal.aborted) controller = new AbortController();
			loading = true; complete = false; status = t('exclusions.loading'); refresh();
			let timeout;
			const heartbeat = () => { window.clearTimeout(timeout); timeout = window.setTimeout(() => controller.abort(), 30000); };
			heartbeat();
			const cancellation = cancellationScope([this.abortController.signal, controller.signal]);
			try {
				if (!this.data.settings.workspace) throw Error('No connected notebook');
				const api = this.api(); api.signal = cancellation.signal;
				const info = await api.info(), keys = await unlockWorkspace(this.secret('encryption'), info.salt);
				if ((await workspaceProof(keys)) !== info.proof) throw Error('Notebook encryption check failed');
				const entries = new Map(); let after = 0;
				for (;;) {
					if (!live()) return;
					const batch = await api.feed(after); heartbeat();
					if (!Array.isArray(batch.entries) || typeof batch.more !== 'boolean' || (batch.more && !batch.entries.length)) throw Error('Invalid cloud directory feed');
					for (const entry of batch.entries) {
						if (!live()) return;
						if (!Number.isSafeInteger(entry.sequence) || entry.sequence <= after) throw Error('Invalid cloud directory sequence');
						if (entry.removed) entries.delete(entry.note);
						else entries.set(entry.note, await inspectNote(keys, api.workspace, entry.note, entry.manifest, address => api.load(address)));
						after = entry.sequence; heartbeat();
					}
					if (!live()) return;
					rebuild(entries); status = t('exclusions.progress', { count: entries.size }); refresh();
					if (!batch.more) break;
				}
				complete = true; status = t(paths.size ? 'exclusions.ready' : 'exclusions.empty');
			} catch { if (live()) status = t('exclusions.unavailable'); }
			finally { window.clearTimeout(timeout); cancellation.dispose(); loading = false; refresh(); }
		};
		this.exclusionWindow = dialog;
		dialog.onClose = () => { closed = true; controller.abort(); if (this.exclusionWindow === dialog) this.exclusionWindow = undefined; };
		dialog.open(); dialog.ready = load(); return dialog;
	}

	async showSyncPlan() {
		if (this.lanPeers?.mode === 'paused') {
			this.notify(t('device.paused'));
			return;
		}
		if (this.running) { this.notify(failureMessage(operationBusy())); return; }
		if (this.previewWindow) return;
		return this.exclusive(async () => {
			const { engine, api } = await this.connection();
			if (engine.direction === 'paused') engine.direction = 'both';
			const context = await this.reviewContext(),
				plan = await synchronizationPlan(engine, context),
				key = await this.reviewKey();
			this.pendingPlan = { plan, key };
			let page = 0,
				details = false;
			const names = {
				upload: t('msg_49efd10178'),
				download: t('msg_6e68458688'),
				updateLocal: t('msg_5a787a8fca'),
				moveLocal: t('msg_005281db0d'),
				moveCloud: t('msg_ae10caca31'),
				deleteLocal: t('msg_d9599ba702'),
				deleteCloud: t('msg_4c079853d0'),
				conflict: t('msg_848a148ba5'),
				skip: t('msg_dda3f1ce08'),
				metadata: t('msg_02d4e6c7d7'),
			};
			const window = new ChoiceWindow(this.app, t('msg_fb895c45fc'), (area) => {
				if (this.data.settings.direction === 'paused')
					area.createEl('p', { text: t('plan.paused') });
				area.createEl('p', { text: t('msg_1b4e8dcd88', { length: plan.operations.length }) });
				const count = (actions) =>
					plan.operations.filter((row) => actions.includes(row.action)).length;
				area.createEl('p', {
					text: t('plan.counts', {
						uploads: count(['upload']),
						downloads: count(['download', 'updateLocal']),
						moves: count(['moveLocal', 'moveCloud']),
						deletes: count(['deleteLocal', 'deleteCloud']),
						conflicts: count(['conflict']),
					}),
				});
				const risky = plan.operations.filter((row) =>
					['deleteLocal', 'deleteCloud', 'conflict'].includes(row.action),
				);
				const groups = new Map();
				for (const item of plan.operations) {
					const folder = item.path.split('/').slice(0, -1).join('/') || '/';
					groups.set(folder, (groups.get(folder) ?? 0) + 1);
				}
				if (!details) {
					for (const [folder, count] of [...groups].slice(0, 20))
						area.createEl('p', { text: t('plan.folder', { folder, count }) });
					action(area, t('plan.details'), async () => {
						details = true;
						area.empty();
						window.render(area);
					});
				}
				for (const row of details
					? plan.operations.slice(page * 100, (page + 1) * 100)
					: risky.slice(0, 20))
					area.createEl('p', {
						text: `${names[row.action]} · ${row.path}${row.deferred ? t('msg_b3866f2fe4') : ''}`,
					});
				action(area, t('msg_ab3252fcee'), async () => {
					window.close();
					await this.synchronize(undefined, {
						...plan,
						key,
						origin: api.origin,
						workspace: api.workspace,
					});
				});
				action(area, t('msg_2f351d9f91'), async () => window.close());
				if (details && plan.operations.length > 100)
					action(area, t('plan.next'), async () => {
						page = (page + 1) % Math.ceil(plan.operations.length / 100);
						area.empty();
						window.render(area);
					});
			});
			this.previewWindow = window;
			window.onClose = () => {
				window.contentEl.empty();
				this.previewWindow = undefined;
			};
			window.open();
		});
	}
	async exportDiagnostics() {
		const scope = await fingerprint(
			new TextEncoder().encode(
				`${new URL(this.data.settings.origin).origin}|${this.data.settings.workspace}`,
			),
		);
		const state =
			this.data.connections[
				`${new URL(this.data.settings.origin).origin}|${this.data.settings.workspace}`
			];
		const report = diagnosticReport({
			journal: this.journal,
			scope,
			version: this.manifest.version,
			platform: Platform.isMobile ? 'mobile' : 'desktop',
			counts: {
				notes: Object.keys(state?.notes ?? {}).length,
				conflicts: state?.conflicts?.length ?? 0,
			},
		});
		const activity = this.cycleActivity ?? this.lastCycleActivity;
		report.lan = this.lanPeers?.snapshot();
		report.receiveCache = this.receiveCache?.snapshot();
		report.timingScope = 'plugin-session';
		report.timings = structuredClone(this.phaseTimings ?? {});
		report.pendingDiagnostics = this.data.taskOutbox?.length ?? 0;
		if (activity) report.activity = {
			stage: activity.stage,
			elapsedMs: Math.max(0, (activity.finishedAt ?? Date.now()) - activity.startedAt),
			quietMs: Math.max(0, (activity.finishedAt ?? Date.now()) - activity.progressAt),
			stages: { ...activity.stages },
		};
		new ChoiceWindow(this.app, t('msg_849f5c8be8'), (area) => {
			area.createEl('p', { text: t('msg_1300264f75') });
			const box = area.createEl('textarea');
			box.value = JSON.stringify(report, null, 2);
			box.readOnly = true;
			box.rows = 16;
			area.createEl('p', { text: t('msg_4ec67f60a5') });
			action(area, t('diagnostic.save'), async () => {
				const adapter = this.app.vault.adapter,
					root = this.app.vault.configDir;
				if (!adapter || !root) throw Error('Configuration directory unavailable');
				const folder = `${root}/plugins/${this.manifest.id}/diagnostics`;
				if (!(await adapter.exists(folder))) await adapter.mkdir(folder);
				await adapter.write(`${folder}/report-${Date.now()}.json`, JSON.stringify(report, null, 2));
				this.notify(t('diagnostic.saved'));
			});
		}).open();
		return report;
	}
	lanSummary(details = false) {
		const stats = this.lanPeers?.snapshot();
		const state = !this.data.settings.workspace ? t('sync.notConnected')
			: this.data.settings.lanAcceleration === false ? t('lan.disabled')
			: stats?.supported === false ? t('lan.unsupported')
			: stats?.connected ? t('lan.connected', { count: stats.connected }) : t('lan.cloud');
		return details ? t('lan.summary', { state, received: formatStorageSize(stats?.receivedBytes ?? 0), sent: formatStorageSize(stats?.sentBytes ?? 0), cloud: formatStorageSize(stats?.cloudBytes ?? 0), fallbacks: stats?.fallbacks ?? 0 }) : state;
	}
	workspaceApi(origin, ...args) {
		assertEditionOrigin(origin);
		return new WorkspaceApi(origin, ...args);
	}
	api() {
		const config = this.data.settings;
		if (this.secret('access').length < 32) throw new Error('Sign in before connecting');
		const api = this.workspaceApi(config.origin, this.secret('access'), config.workspace);
		api.signal = this.abortController.signal;
		return api;
	}
	async prepareDevice(api) {
		if (this.devicePreparing) {
			await this.devicePreparing;
			api.accessKey = this.secret('access');
		}
		this.devicePreparing = (async () => {
			api.accessKey = this.secret('access');
			let account = await api.request('GET', 'account');
			this.ensureCurrent(api);
			this.accountEmail = typeof account.email === 'string' ? account.email : '';
			if (!account.scope) {
				this.app.secretStorage.setSecret(`${this.manifest.id}-${this.data.localId}-account`,api.accessKey);
				this.accountAuthorized = true;
				const issued = await api.request('POST', 'session', {
					workspace: api.workspace,
					label: this.deviceDisplayName(),
				});
				this.ensureCurrent(api);
				this.app.secretStorage.setSecret(`${this.manifest.id}-${this.data.localId}-access`,issued.key);
				api.accessKey = issued.key;
				account = { scope: api.workspace, deviceId: issued.id };
			}
			await this.updateDeviceLabel(api, account);
			const binding = `${api.origin}|${api.workspace}|${account.deviceId}`;
			if (!this.lanPeers || this.peerBinding !== binding || this.lanPeers.closed) {
				this.lanPeers?.close();
				this.peerBinding = binding;
				this.lanPeers = new LanPeers(api, {
					enabled: this.data.settings.lanAcceleration !== false,
					vaultUsage: currentApi => {
						this.ensureCurrent(currentApi);
						const now = Date.now();
						if (!this.deviceVaultSample || now < this.deviceVaultSample.sampledAt || now - this.deviceVaultSample.sampledAt >= 30000)
							this.deviceVaultSample = sampleVaultSize(this.app.vault, now);
						return this.deviceVaultSample;
					},
				});
			}
			const peers = this.lanPeers;
			peers.api = api;
			peers.enabled = this.data.settings.lanAcceleration !== false;
			try {
				await peers.start();
			} catch (error) {
				if (!peers.mode) throw error;
				peers.drop();
			}
			bindLanTransfers(api, peers);
		})().finally(() => {
			this.devicePreparing = undefined;
		});
		await this.devicePreparing;
	}
	async connection({ allowIdleScan = false } = {}) {
		const notePath = value => safeHostPath(value, Platform.isWin === true);
		const api = this.api();
		this.syncStage('connecting');
		const pinId = `authority:${api.origin}`;
		const routeBinding = JSON.stringify([api.origin, this.data.settings.lan, this.data[pinId]]);
		const cachedRoute = this.verifiedRoute;
		const transport = cachedRoute?.binding === routeBinding && cachedRoute.signal === api.signal &&
			Date.now() >= cachedRoute.at && Date.now() - cachedRoute.at < 30000 ? cachedRoute.transport : await routedFetch({
			origin: api.origin,
			signal: api.signal,
			lan: this.data.settings.lan,
			pinned: this.data[pinId],
			savePin: async (key) => {
				this.data[pinId] = key;
				await this.saveData(this.data);
			},
		});
		this.ensureCurrent(api);
		this.verifiedRoute = { binding: JSON.stringify([api.origin, this.data.settings.lan, this.data[pinId]]), signal: api.signal, at: cachedRoute?.transport === transport ? cachedRoute.at : Date.now(), transport };
		api.fetcher = transport.fetcher;
		let info;
		try { info = await api.info(); } catch (error) {
			if (error?.status === 410) await this.detachDeletedNotebook(api.workspace);
			throw error;
		}
		this.ensureCurrent(api);
		this.syncStage('unlocking');
		const keyBinding = JSON.stringify([api.origin, api.workspace, this.secret('encryption'), info.salt, info.proof]);
		const cachedKeys = this.workspaceKeys;
		const keys = cachedKeys?.binding === keyBinding && Date.now() >= cachedKeys.at && Date.now() - cachedKeys.at < 60000
			? cachedKeys.keys : await unlockWorkspace(this.secret('encryption'), info.salt);
		if ((await workspaceProof(keys)) !== info.proof)
			throw Object.assign(new Error('Notebook key mismatch'), {
				code: 'WRONG_NOTEBOOK_KEY',
			});
		this.ensureCurrent(api);
		this.workspaceKeys = { binding: keyBinding, at: cachedKeys?.keys === keys ? cachedKeys.at : Date.now(), keys };
		const connectionId = `${api.origin}|${api.workspace}`;
		const taskScope = await fingerprint(new TextEncoder().encode(connectionId));
		this.taskScope = taskScope;
		const state = this.data.connections[connectionId] ?? emptyState();
		const saveRequired = !state.generation;
		if (state.generation && state.generation !== info.generation)
			throw Object.assign(new Error('Restored service generation'), {
				code: 'RESTORED_SERVICE',
			});
		state.generation = info.generation;
		this.syncStage('device');
		await this.prepareDevice(api);
		this.ensureCurrent(api);
		if (info.logicalStorage === 1 && this.lanPeers?.mode !== 'paused') {
			await reconcileLogicalUsage(api, keys);
			this.ensureCurrent(api);
		}
		const desktop = !Platform.isMobile
			? desktopFiles(this.app.vault, {
					load: window.require,
					stopped: () => this.stopped || api.signal.aborted,
				})
			: undefined;
		const waitForDesktop = async (path) => {
			for (let attempt = 0; attempt < 100; attempt++) {
				if (this.stopped || api.signal.aborted)
					throw new DOMException('Transfer stopped', 'AbortError');
				if (this.app.vault.getAbstractFileByPath(path) instanceof TFile) return;
				await new Promise((done) => window.setTimeout(done, 50));
			}
			throw Error('Host did not observe the streamed file; retry safely');
		};
		this.syncStage('scanning');
		await desktop?.prepare();
		let aliasRevision, aliasIndex;
		const abstractForPath = async path => {
			const direct = this.app.vault.getAbstractFileByPath(path);
			if (direct || !desktop) return direct;
			if (!aliasIndex || aliasRevision !== this.inventoryRevision) {
				aliasRevision = this.inventoryRevision;
				aliasIndex = new Map();
				for (const item of [...this.app.vault.getFiles(), ...(this.app.vault.getAllLoadedFiles?.() ?? [])]) {
					if (!item.path) continue;
					const key = item.path.toLowerCase();
					if (!aliasIndex.has(key)) aliasIndex.set(key, new Map());
					aliasIndex.get(key).set(item.path, item);
				}
			}
			const candidates = [...(aliasIndex.get(path.toLowerCase())?.values() ?? [])];
			return candidates.length === 1 && await desktop.sameEntry(candidates[0].path, path) ? candidates[0] : null;
		};
		const host = {
			...(desktop ? { canonicalPath: async path => {
				try { return await desktop.canonicalPath(path); }
				catch (error) { if (error.code === 'ENOENT') throw planChanged(); throw error; }
			} } : {}),
			mtime: async (path) => {
				const file = await abstractForPath(notePath(path));
				return file instanceof TFile && Number.isFinite(file.stat?.mtime) ? Math.trunc(file.stat.mtime) : undefined;
			},
			stamp: async (path) => {
				this.startupInventory.delete(path);
				if (this.stopped || api.signal.aborted)
					throw new DOMException('Transfer stopped', 'AbortError');
				const file = await abstractForPath(notePath(path));
				const stat = file instanceof TFile ? file.stat : undefined;
				return stat && [stat.size, stat.mtime, stat.ctime].every(Number.isFinite)
					? JSON.stringify([stat.size, stat.mtime, stat.ctime, Math.max(this.fileChanges.get(path) ?? 0, this.fileChanges.get(file.path) ?? 0)])
					: undefined;
			},
			...(desktop
				? {
						sink: async (path, bytes, digest, mtime) => {
							const previousTime = this.app.vault.getAbstractFileByPath(path)?.stat?.mtime;
							const sink = await desktop.sink(path, bytes, digest, mtime);
							return {
								...sink,
								write: (...args) => this.measurePhase('write', () => sink.write(...args)),
								commit: async () => {
									await this.measurePhase('write', () => sink.commit());
									await waitForDesktop(path);
									await this.refreshPreservedWrite(path, previousTime, mtime);
								},
							};
						},
					}
				: {}),
			listFolders: async () =>
				(this.app.vault.getAllLoadedFiles?.() ?? [])
					.filter((file) => !(file instanceof TFile) && file.path && file.path !== '/')
					.map((file) => file.path)
					.filter((path) => {
						try {
							notePath(path);
							return true;
						} catch {
							return false;
						}
					}),
			exists: async (path) =>
				this.app.vault.adapter?.exists
					? this.app.vault.adapter.exists(notePath(path))
					: this.app.vault.getAbstractFileByPath(notePath(path)) !== null,
			sameEntry: async (from, to) =>
				(this.app.vault.getAbstractFileByPath(from) !== null && this.app.vault.getAbstractFileByPath(from) === this.app.vault.getAbstractFileByPath(to)) || (await desktop?.sameEntry(from, to)) === true,
			mkdir: async (path) => {
				if (this.stopped) throw new Error('Plugin is unloading');
				if (api.signal.aborted) throw new DOMException('Synchronization stopped', 'AbortError');
				let parent = '';
				for (const segment of notePath(path).split('/')) {
					parent = parent ? `${parent}/${segment}` : segment;
					const item = await abstractForPath(parent);
					if (item instanceof TFile) throw new Error('A file occupies the folder path');
					if (item && item.path !== parent && desktop && await desktop.canonicalPath(parent) !== parent)
						throw Object.assign(new Error('A differently cased folder occupies the path'), { code: 'RENAME_CONFLICT' });
					if (item === null) await this.app.vault.createFolder(parent);
				}
			},
			move: async (from, to) => {
				if (this.stopped) throw new Error('Plugin is unloading');
				if (api.signal.aborted) throw new DOMException('Synchronization stopped', 'AbortError');
				from = notePath(from);
				to = notePath(to);
				if (to.startsWith(`${from}/`)) throw new Error('Cannot move a folder inside itself');
				const file = await abstractForPath(from);
				const destination = await abstractForPath(to);
				if (!file) throw planChanged();
				if (destination && destination !== file && !(await desktop?.sameEntry(from, to)))
					throw Object.assign(new Error('Move destination is occupied'), { code: 'RENAME_CONFLICT' });
				let parent = '';
				for (const segment of to.split('/').slice(0, -1)) {
					parent = parent ? `${parent}/${segment}` : segment;
					if (!await abstractForPath(parent))
						await this.app.vault.createFolder(parent);
				}
				this.applyingRemoteMove = true;
				try {
					await this.measurePhase('move', () => this.app.vault.rename(file, to));
				} finally {
					this.applyingRemoteMove = false;
				}
			},
			removeFolder: async (path) => {
				if (this.stopped) throw new Error('Plugin is unloading');
				if (api.signal.aborted) throw new DOMException('Synchronization stopped', 'AbortError');
				const folder = this.app.vault.getAbstractFileByPath(notePath(path));
				if (folder && !(folder instanceof TFile) && folder.children?.length === 0)
					await this.app.fileManager.trashFile(folder);
			},
			removeTree: async (path, expected) => {
				if (this.stopped || api.signal.aborted) throw new DOMException('Transfer stopped', 'AbortError');
				const adapter = this.app.vault.adapter;
				if (!adapter?.list) return false;
				const actual = new Set([path]);
				const visit = async folder => {
					const result = await adapter.list(folder);
					for (const file of result.files) actual.add(file);
					for (const child of result.folders) { actual.add(child); await visit(child); }
				};
				await visit(path);
				if (actual.size !== expected.length || expected.some(name => !actual.has(name))) return false;
				const folder = this.app.vault.getAbstractFileByPath(notePath(path));
				if (!folder || folder instanceof TFile) return false;
				await this.measurePhase('removeTree', () => this.app.fileManager.trashFile(folder));
				return true;
			},
			list: async () =>
				this.app.vault
					.getFiles()
					.map((file) => file.path)
					.filter((path) => {
						try {
							notePath(path);
							return true;
						} catch {
							return false;
						}
					}),
			read: async (path) => {
				if (desktop) {
					const source = await desktop.source(path);
					if (source !== undefined) return source;
				}
				const file = await abstractForPath(notePath(path));
				if (file === null && (await this.app.vault.adapter?.exists?.(path)))
					throw planChanged();
				return file instanceof TFile ? new Uint8Array(await this.app.vault.readBinary(file)) : null;
			},
			write: async (path, bytes, mtime) => {
				if (this.stopped) throw new Error('Plugin is unloading');
				if (api.signal.aborted) throw new DOMException('Synchronization stopped', 'AbortError');
				path = notePath(path);
				if (bytes?.streamed) {
					const previousTime = this.app.vault.getAbstractFileByPath(path)?.stat?.mtime;
					if (!desktop) throw Error('Streaming copy unavailable');
					await desktop.copy(path, bytes, mtime);
					await waitForDesktop(path);
					await this.refreshPreservedWrite(path, previousTime, mtime);
					return;
				}
				const folders = path.split('/').slice(0, -1);
				let parent = '';
				// A live immediate parent implies its ancestors exist. Recheck for
				// every file; no directory cache survives a deletion or rename.
				const immediate = folders.length ? await abstractForPath(folders.join('/')) : null;
				if (immediate instanceof TFile) throw new Error('A file occupies the folder path');
				if (!immediate) for (const folder of folders) {
					parent = parent ? `${parent}/${folder}` : folder;
					const item = await abstractForPath(parent);
					if (item instanceof TFile) throw new Error('A file occupies the folder path');
					if (!item) await this.app.vault.createFolder(parent);
				}
				const existing = await abstractForPath(path);
				const previousTime = existing?.stat?.mtime;
				const buffer = bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
					? bytes.buffer : Uint8Array.from(bytes).buffer;
				const options = mtime === undefined ? undefined : { mtime };
				const changeBefore = this.fileChanges.get(path) ?? 0;
				if (existing instanceof TFile) await this.app.vault.modifyBinary(existing, buffer, options);
				else if (existing === null) await this.app.vault.createBinary(path, buffer, options);
				else throw new Error('A folder occupies the remote note path');
				await this.refreshPreservedWrite(path, previousTime, mtime);
				const changeAfter = this.fileChanges.get(path) ?? 0;
				// Extra edits or missing SDK notifications require ordinary read/hash.
				if (changeAfter === changeBefore + 1) {
					const written = this.app.vault.getAbstractFileByPath(path);
					if (written instanceof TFile && written.stat?.size === bytes.length &&
						(mtime === undefined || Math.trunc(written.stat.mtime) === mtime) && Number.isFinite(written.stat.ctime))
						return { stamp: JSON.stringify([written.stat.size, written.stat.mtime, written.stat.ctime, changeAfter]) };
				}
			},
			remove: async (path) => {
				if (this.stopped) throw new Error('Plugin is unloading');
				if (api.signal.aborted) throw new DOMException('Synchronization stopped', 'AbortError');
				const file = this.app.vault.getAbstractFileByPath(notePath(path));
				if (file instanceof TFile) await this.app.fileManager.trashFile(file);
			},
		};
		const scope = configurationScope({
			...this.data.settings.configuration,
			ownId: this.manifest.id,
			mobile: Platform.isMobile,
		});
		const scopedHost = configurationHost(this.app.vault, host, scope, {
			mobileBlocked: Object.values(state.notes).filter(note => note.platformSkipped === 'desktop-plugin').map(note => note.path),
			windows: Platform.isWin === true,
			stopped: () => this.stopped || api.signal.aborted,
			onPluginStateChanged: () => { this.pluginStateRestartPending = true; },
		});
		this.incrementalInventories ??= new Map();
		if (!this.incrementalInventories.has(connectionId)) this.incrementalInventories.set(connectionId, new IncrementalInventory());
		this.idleScans ??= new Map();
		if (!this.idleScans.has(connectionId)) this.idleScans.set(connectionId, {});
		// Configuration files can change outside vault events, so they retain full scans.
		const ordinaryOnly = Object.entries(this.data.settings.configuration ?? {}).every(([key, value]) =>
			value === false || (key === 'plugins' && value === 'none') ||
			(Array.isArray(value) && !value.length) || (value && typeof value === 'object' && !Object.keys(value).length));
		const configurationVersion = allowIdleScan ? await scopedHost.configurationVersion?.() ?? (ordinaryOnly ? '[]' : undefined) : undefined;
		this.contentPriorities ??= new Map();
		if (!this.contentPriorities.has(connectionId)) this.contentPriorities.set(connectionId, new Map());
		const receiveCache = new ReceiveCache(this.app.vault.adapter, `${this.app.vault.configDir}/plugins/${this.manifest.id}/resume-v1/${taskScope}`, {
			active: () => !this.stopped && !api.signal.aborted && new URL(this.data.settings.origin).origin === api.origin && this.data.settings.workspace === api.workspace && this.secret('access') === api.accessKey,
		});
		api.resumeCache = receiveCache;
		this.receiveCache = receiveCache;
		if (this.lanPeers) this.lanPeers.resumeCache = receiveCache;
		const engine = new NotebookSynchronizer({
			contentPriorities: this.contentPriorities.get(connectionId),
			incrementalInventory: this.incrementalInventories.get(connectionId),
			commitJournal: this.checkpoints ? {
				current: () => this.data.commitJournals?.[connectionId],
				write: async journal => {
					this.ensureCurrent(api);
					this.data.commitJournals ??= {};
					this.data.commitJournals[connectionId] = journal;
					await this.checkpoints.saveConfiguration(this.data);
				},
				clear: async () => {
					const journal = this.data.commitJournals?.[connectionId];
					delete this.data.commitJournals?.[connectionId];
					try { await this.checkpoints.saveConfiguration(this.data); }
					catch (error) { this.data.commitJournals[connectionId] = journal; throw error; }
				},
			} : undefined,
			scanPolicy: allowIdleScan && configurationVersion !== undefined ? JSON.stringify([this.data.settings, this.lanPeers?.mode ?? 'both', configurationVersion]) : undefined,
			saveRequired,
			scanCache: this.idleScans.get(connectionId),
			scanVersion: allowIdleScan && configurationVersion !== undefined ? () => JSON.stringify([this.inventoryRevision ?? 0, this.data.settings, this.lanPeers?.mode ?? 'both', configurationVersion]) : undefined,
			api,
			keys,
			host: { ...scopedHost, read: (...args) => this.measurePhase('read', () => scopedHost.read(...args)), write: (...args) => this.measurePhase('write', () => scopedHost.write(...args)) },
			accepts: (path) =>
				!this.data.settings.excludedExtensions.some((extension) =>
					path.toLowerCase().endsWith(`.${extension.toLowerCase()}`),
				) &&
				(!path.startsWith(`${CONFIG_NAMESPACE}/`) ||
					scope.allowed(path.slice(CONFIG_NAMESPACE.length + 1))),
			state,
			checkpointSize: 100,
			checkpointInterval: 5000,
			snapshotBeforeSave: !this.checkpoints,
			onTiming: (stage, milliseconds) => this.recordTiming(stage, milliseconds),
			uploadConcurrency: 2,
			batchTransfer: info.batchBytes === BATCH_BYTES,
			batchDeletes: info.batchDeletes === true,
			batchBytes: (Platform.isMobile ? 2 : 4) * 1024 * 1024,
			batchFiles: Platform.isMobile ? 64 : 128,
			yieldWork: () => {
				const timers = !Platform.isMobile && typeof window.require === 'function' ? window.require('node:timers') : undefined;
				return timers ? abortableYield(api.signal, timers.setImmediate, timers.clearImmediate) : abortableYield(api.signal);
			},
			renames: this.data.renames,
			onProgress: (text, scan) => {
				if (this.cycleActivity && Number.isSafeInteger(scan?.checked) && Number.isSafeInteger(scan?.total) && scan.checked >= 0 && scan.total >= scan.checked)
					this.cycleActivity.scan = { checked: scan.checked, total: scan.total };
				this.syncStage('scanning');
				this.setStatus(t('msg_242eab2e90', { text: text }), { overview: this.transferPhase ?? t('overview.scanning') });
				this.logEvent(text);
			},
			onTask: async (event) => {
				if (this.cycleActivity) this.cycleActivity.changed = true;
				if (this.cycleActivity && event.direction === 'receive' && event.status === 'done')
					this.cycleActivity.received = (this.cycleActivity.received ?? 0) + 1;
				if (event.direction === 'send' || event.direction === 'receive') {
					this.syncStage(event.direction === 'send' ? 'uploading' : 'receiving');
					window.clearTimeout(this.backgroundStatusTimer);
					this.deferBackgroundStatus = false;
					this.backgroundStatus = undefined;
					this.transferPhase = t(event.direction === 'send' ? 'overview.uploading' : 'overview.receiving');
					this.publishOverview(this.transferPhase);
				}
				let id = this.taskTokens.get(event.token);
				if (!id) {
					id = this.journal.start(taskScope, { ...event, version: this.manifest.version });
					this.taskTokens.set(event.token, id);
				}
				if (this.cycleActivity && !this.cycleActivity.persisted) {
					this.cycleActivity.persisted = true;
					await this.persistTasks();
				}
				this.journal.update(id, event.status === 'failed' && event.error?.code === 'PLAN_CHANGED' ? { ...event, status: 'skipped' } : event);
				if (event.status !== 'progress') {
					if (event.status !== 'running') {
						const row = this.journal.rows.find((value) => value.id === id);
						if (row) this.queueDiagnostic(row, api);
					}
					if (event.status !== 'running') this.taskTokens.delete(event.token);
				}
				this.refreshTasks();
			},
			save: async (next) => {
				this.data.connections[connectionId] = next;
				this.data.tasks = this.journal.snapshot();
				try { await this.measurePhase('checkpoint', () => this.saveData(this.data)); }
				catch (error) {
					// Keep the dirty engine identity when a cloned SDK snapshot failed to commit.
					this.data.connections[connectionId] = state;
					throw error;
				}
			},
			ignored: this.data.settings.ignored,
			attachmentLimit: this.data.settings.attachmentMiB * 1024 * 1024,
			direction: intersectDirection(this.data.settings.direction, this.lanPeers?.mode ?? 'both'),
			remoteMode: this.lanPeers?.mode ?? 'both',
		});
		const peers = this.lanPeers;
		if (peers) {
			const selection = () => JSON.stringify([this.data.localId, this.data.settings.origin, this.data.settings.workspace, this.data.settings.ignored, this.data.settings.excludedExtensions, this.data.settings.configuration]);
			const selected = selection();
			peers.canServe = () => !this.stopped && !api.signal.aborted && selection() === selected && !['paused', 'receive'].includes(this.data.settings.direction);
			peers.provideNote = localNoteProvider({ keys, workspace: api.workspace, state, host: scopedHost, cache: receiveCache, accepts: path => !engine.excluded(path) });
			api.peerContents = (note, manifest, info, sinkFor, onTiming) => receivePeerNote(peers, keys, api.workspace, note, manifest, info, sinkFor, onTiming);
		}
		return { api, keys, engine, host: scopedHost, pinsSupported: info.notePins === 1 };
	}
	async exclusive(task) {
		if (this.stopped) throw new Error('Plugin is unloaded');
		if (this.configurationPending) throw operationBusy('CONFIGURATION_BUSY');
		if (this.running) throw operationBusy();
		this.running = Promise.resolve()
			.then(() => {
				if (this.stopped) throw new Error('Plugin is unloaded');
				return task();
			})
			.finally(() => {
				this.running = undefined;
			});
		return this.running;
	}
	publishOverview(text) {
		if (this.overviewStatusText === text) return;
		this.overviewStatusText = text;
		for (const update of this.statusListeners ?? []) update(text);
		if (this.logViews?.size) this.refreshTasks();
	}
	setStatus(text, { overview = text } = {}) {
		if (this.deferBackgroundStatus && [t('msg_4c9b675ab6'), t('overview.scanning')].includes(overview)) {
			this.backgroundStatus = { text, overview };
			return;
		}
		window.clearTimeout(this.backgroundStatusTimer);
		this.deferBackgroundStatus = false;
		this.backgroundStatus = undefined;
		if (!this.data?.settings.workspace) text = t(this.data?.lastDeletedWorkspace ? 'notebooks.deletedStatus' : 'sync.notConnected');
		this.status.setText(text);
		this.publishOverview(this.data?.settings.workspace ? overview : text);
	}

	automaticChangesAllowed(sending = false) {
		return !this.stopped && !this.stopping && !this.connecting && !this.data.manualSyncStopped && this.data.settings.workspace &&
			this.data.settings.autoChanges !== false && this.data.settings.direction !== 'paused' &&
			(!sending || this.data.settings.direction !== 'receive');
	}
	editorBinding() {
		return JSON.stringify([this.data.localId, this.data.settings.origin, this.data.settings.workspace]);
	}
	scheduleEditorSave(editor, view) {
		if (!this.automaticChangesAllowed(true) || !(view?.file instanceof TFile) ||
			view.getViewType?.() !== 'markdown' || view.editor !== editor ||
			typeof view.save !== 'function' || typeof view.getViewData !== 'function' || typeof this.app.vault.read !== 'function') return;
		this.editorSaves ??= new Map();
		window.clearTimeout(this.editorSaves.get(view)?.timer);
		const item = { editor, view, file: view.file, path: view.file.path, binding: this.editorBinding() };
		item.timer = window.setTimeout(() => { void this.flushEditorSave(item); }, 300);
		this.editorSaves.set(view, item);
	}
	async flushEditorSave(item) {
		const { view, editor, file, path, binding } = item;
		if (this.editorSaves?.get(view) !== item || this.editorComposing) return;
		this.editorSaves.delete(view);
		const active = () => this.automaticChangesAllowed(true) && !this.editorComposing && binding === this.editorBinding() &&
			view.file === file && file.path === path && view.editor === editor && this.app.vault.getAbstractFileByPath(path) === file;
		if (!active()) return;
		if (this.editorSaveWork?.has(view)) { this.scheduleEditorSave(editor, view); return; }
		this.editorSaveWork ??= new Map();
		const work = Promise.resolve().then(async () => {
			const text = view.getViewData(), mtime = file.stat?.mtime;
			const saved = await this.app.vault.read(file);
			// TextFileView.data may already track the editor's unsaved content.
			// Compare the host's saved file and recheck after the asynchronous read.
			if (saved !== text && active() && view.getViewData() === text && file.stat?.mtime === mtime) await view.save();
		});
		this.editorSaveWork.set(view, work);
		try { await work; } catch { this.notify(failureMessage({ code: 'EDITOR_SAVE_FAILED' })); }
		finally { if (this.editorSaveWork.get(view) === work) this.editorSaveWork.delete(view); }
	}
	cancelEditorSaves() {
		for (const item of this.editorSaves?.values() ?? []) window.clearTimeout(item.timer);
		this.editorSaves?.clear();
		this.changeWait = undefined;
	}
	requestChangedSynchronization() {
		if (!this.automaticChangesAllowed()) return;
		if (!this.running) { void this.synchronize(undefined, undefined, true); return; }
		const pending = this.running;
		if (this.changeWait === pending) return;
		this.changeWait = pending;
		const binding = this.editorBinding(), controller = this.abortController;
		void pending.catch(() => {}).then(() => {
			if (this.changeWait !== pending) return;
			this.changeWait = undefined;
			if (this.automaticChangesAllowed() && !controller.signal.aborted && this.abortController === controller && binding === this.editorBinding()) void this.synchronize(undefined, undefined, true);
		});
	}

	refreshBackgroundTray() {
		this.backgroundTray?.dispose();
		this.backgroundTray = undefined;
		if (Platform.isMobile || this.stopped || this.data.settings.backgroundTray === false || typeof window.require !== 'function') return;
		try {
			this.backgroundTray = createBackgroundTray({
				load: name => window.require(name), renderer: window, name: edition.name, vaultName: this.app.vault.getName(),
				labels: { show: t('tray.show'), quit: t('tray.quit') },
			});
		} catch { this.notify(t('tray.unavailable')); }
	}
	onunload() {
		this.backgroundTray?.dispose();
		this.backgroundTray = undefined;
		this.tab?.disposeLegacySettings?.();
		this.syncSetupWindow?.close();
		this.capacityWindow?.close();
		this.noteEncryption?.dispose();
		for (const view of this.noteSearchViews ?? []) void view.onClose();
		if (this.notePinSaveTimer) {
			window.clearTimeout(this.notePinSaveTimer);
			this.notePinSaveTimer = undefined;
			void this.saveData(this.data).catch(() => this.notify(t('pin.saveFailed')));
		}
		this.cancelEditorSaves();
		this.detachLinkMaintenanceTimes?.();
		window.clearTimeout(this.explorerSortTimer);
		this.stopped = true;
		for (const detach of this.explorerSortViews?.values() ?? []) detach();
		this.explorerSortViews?.clear();
		this.statusListeners?.clear();
		window.clearInterval(this.stageTimer);
		this.verifiedRoute = undefined;
		this.workspaceKeys = undefined;
		window.clearTimeout(this.backgroundStatusTimer);
		this.deferBackgroundStatus = false;
		this.backgroundStatus = undefined;
		this.lanPeers?.close();
		window.clearTimeout(this.pendingTimer);
		window.clearTimeout(this.taskSaveTimer);
		window.clearTimeout(this.taskRenderTimer);
		window.clearTimeout(this.diagnosticTimer);
		this.abortController?.abort();
	}
	async checkClientVersion(fetcher, now = Date.now()) {
		if (this.stopped) return undefined;
		if (this.clientVersionCache?.expires > now) return this.clientVersionCache.version;
		if (this.clientVersionCheck) return this.clientVersionCheck;
		this.clientVersionCheck = (async () => {
			let version;
			try { version = await publishedClientVersion(fetcher, this.abortController?.signal); }
			catch { /* Version checks must not interrupt settings or synchronization. */ }
			if (this.stopped) return undefined;
			this.clientVersionCache = { version, expires: now + (version ? 3600000 : 300000) };
			return version;
		})().finally(() => { this.clientVersionCheck = undefined; });
		return this.clientVersionCheck;
	}
	ensureCurrent(api) {
		if (this.stopped) throw new Error('Plugin is unloaded');
		if (api.signal?.aborted) throw api.signal.reason ?? new DOMException('Synchronization stopped', 'AbortError');
		if (
			api.workspace !== this.data.settings.workspace ||
			api.origin !== new URL(this.data.settings.origin).origin
		)
			throw new Error('The selected workspace changed');
	}
	async requestSynchronization() {
		if (this.stopped || this.stopping || this.connecting) return;
		if (!this.data.settings.workspace || !['paused', 'send', 'receive', 'update'].includes(this.data.settings.direction) || this.running)
			return this.synchronizeManually();
		if (this.resumeSyncWindow) return this.resumeSyncWindow;
		const scope = () => `${this.data.localId}|${this.data.settings.origin}|${this.data.settings.workspace}`;
		const expected = scope(), direction = this.data.settings.direction;
		const paused = direction === 'paused';
		let closed = false;
		const dialog = new ChoiceWindow(this.app, t(paused ? 'sync.resumeTitle' : 'sync.directionTitle'), area => {
			area.createEl('p', { text: t(paused ? 'sync.resumeHelp' : `sync.${direction}Help`) });
			const proceed = async adjust => {
				if (closed || this.stopped || this.stopping || this.connecting || this.running || scope() !== expected) {
					this.notify(t('sync.resumeChanged'));
					dialog.close();
					return;
				}
				if (adjust && this.data.settings.direction === direction) await this.setting('direction', 'both');
				if (closed || this.stopped || this.stopping || this.connecting || scope() !== expected) return;
				dialog.close();
				await this.synchronizeManually();
			};
			action(area, t('sync.resumeConfirm'), () => proceed(true));
			if (paused) action(area, t('sync.resumeCancel'), async () => dialog.close());
			else action(area, t('sync.currentConfirm'), () => proceed(false));
		});
		dialog.onClose = () => {
			closed = true;
			dialog.contentEl.empty();
			if (this.resumeSyncWindow === dialog) this.resumeSyncWindow = undefined;
		};
		this.resumeSyncWindow = dialog;
		dialog.open();
		return dialog;
	}
	async synchronizeManually() {
		if (edition.edition === 'cn' && !this.stopped && !this.stopping && !this.connecting && !this.running && !this.data.settings.workspace && !this.secret('account') && !this.secret('access')) {
			if (this.syncSetupWindow) return this.syncSetupWindow;
			const binding = () => JSON.stringify([this.data.localId, this.data.settings.origin, this.data.settings.workspace, this.secret('account'), this.secret('access')]);
			const expected = binding();
			const live = () => !this.stopped && !this.stopping && !this.connecting && !this.running && binding() === expected;
			const dialog = new ChoiceWindow(this.app, '请先开通套餐', area => {
				area.createEl('p', { text: '请先点击“购买”选择套餐并开通，再登录账号开始同步。已有账号可直接登录。' });
				const proceed = async callback => {
					if (this.syncSetupWindow !== dialog || !live()) { dialog.close(); return; }
					dialog.close();
					await callback();
				};
				action(area, '购买', () => proceed(() => this.openBilling()));
				action(area, '已有账号登录', () => proceed(() => this.enrollment()));
			});
			dialog.onClose = () => {
				dialog.contentEl.empty();
				if (this.syncSetupWindow === dialog) this.syncSetupWindow = undefined;
			};
			this.syncSetupWindow = dialog;
			dialog.open();
			return dialog;
		}
		if (!this.running && !this.stopped && !this.stopping && !this.connecting && this.data.settings.workspace && this.data.settings.direction !== 'receive') await this.warnCapacity();
		return this.synchronize();
	}
	recordLocalRename(from, to) {
		if (!this.renameKnownPaths) {
			const settings = this.data.settings;
			const state = this.data.connections[`${new URL(settings.origin).origin}|${settings.workspace}`];
			this.renameKnownPaths = new Set(Object.values(state?.notes ?? {}).filter(note => !note.removed).map(note => note.path));
		}
		recordRename(this.data.renames, from, to, this.renameKnownPaths);
		if (this.renameSaveTimer) return;
		this.renameSaveTimer = window.setTimeout(() => {
			this.renameSaveTimer = undefined;
			this.renameKnownPaths = undefined;
			const save = this.checkpoints ? this.checkpoints.saveConfiguration(this.data) : this.saveData(this.data);
			void save.catch(() => this.notify(t('msg_4439f34880')));
		}, 100);
	}
	async synchronize(retryRow, approval, automatic = false) {
		if (automatic && this.data?.manualSyncStopped) return;
		if (this.stopped) return;
		if (this.configurationPending) return;
		if (this.stopping) return;
		if (this.connecting) return;
		if (this.running) return this.running;
		if (!this.data.settings.workspace) {
			this.setStatus(t('sync.notConnected'));
			return;
		}
		this.lastStarted = Date.now();
		const coalesceCycle = automatic && !retryRow && !approval && this.lastQuietCycleAt !== undefined && Date.now() >= this.lastQuietCycleAt && Date.now() - this.lastQuietCycleAt < 60000;
		this.cycleActivity = { startedAt: this.lastStarted, progressAt: this.lastStarted, stage: 'connecting', stages: {}, changed: false, persisted: !coalesceCycle };
		this.stageTimer = window.setInterval(() => {
			const activity = this.cycleActivity;
			if (activity && Date.now() - activity.progressAt >= 15000)
				this.setStatus(t('sync.waitingStage', { stage: t(`sync.stage.${activity.stage}`) }), { overview: t('sync.waitingStage', { stage: t(`sync.stage.${activity.stage}`) }) });
		}, 1000);
		this.deferBackgroundStatus = automatic && this.overviewStatusText === t('overview.synced');
		if (this.deferBackgroundStatus) this.backgroundStatusTimer = window.setTimeout(() => {
			this.deferBackgroundStatus = false;
			if (this.backgroundStatus) this.setStatus(this.backgroundStatus.text, this.backgroundStatus);
		}, 1000);
		this.running = (async () => {
			let cycle;
			let diagnosticApi;
			try {
				if (!automatic && this.data.manualSyncStopped) {
					delete this.data.manualSyncStopped;
					try {
						if (this.checkpoints) await this.checkpoints.saveConfiguration(this.data);
						else await this.saveData(this.data);
					} catch (error) { this.data.manualSyncStopped = true; throw error; }
					if (this.stopping || this.stopped || this.data.manualSyncStopped) return;
				}
				if (this.data.settings.direction === 'paused' && !approval) {
					this.setStatus(t('msg_c4f91c861a'));
					if (retryRow) this.notify(t('msg_3ce8632e0d'));
					return;
				}
				this.transferPhase = undefined;
				this.setStatus(t('msg_4c9b675ab6'));
				this.taskScope = await fingerprint(
					new TextEncoder().encode(
						`${new URL(this.data.settings.origin).origin}|${this.data.settings.workspace}`,
					),
				);
				const retries = retryRow ? (Array.isArray(retryRow) ? retryRow : [retryRow]) : [];
				if (retries.some((row) => !this.journal.canRetry(row, this.taskScope)))
					throw new Error('Task is not retryable in this workspace');
				cycle = this.journal.start(this.taskScope, {
					note: this.taskScope,
					direction: 'cycle',
					version: this.manifest.version,
				});
				if (!coalesceCycle) await this.persistTasks();
				const { engine, keys, pinsSupported } = await this.connection({ allowIdleScan: automatic && !retryRow && !approval });
				if (engine.remoteMode === 'paused' || (!approval && engine.direction === 'paused')) {
					this.journal.update(cycle, { status: 'skipped' });
					await this.persistTasks();
					this.setStatus(t('device.paused'));
					return;
				}
				if (approval) engine.direction = approval.direction;
				if (approval) {
					this.ensureCurrent(engine.api);
					const current = await synchronizationPlan(engine, await this.reviewContext());
					if (
						current.token !== approval.token ||
						(await this.reviewKey()) !== approval.key ||
						engine.api.origin !== approval.origin ||
						engine.api.workspace !== approval.workspace
					)
						throw planChanged();
				}
				diagnosticApi = engine.api;
				const files = retries.filter((row) => row.direction !== 'cycle');
				for (let attempt = 0; ; attempt++) {
					try {
						await engine.run(files.length ? files.flatMap((row) => [row.note, row.pathKey]) : undefined, approval?.ceiling);
						break;
					} catch (error) {
						const changed = error?.code === 'PLAN_CHANGED' || error?.status === 409;
						if (approval || !changed || attempt >= 2 || this.stopped || engine.api.signal?.aborted) throw error;
						if (error?.status === 409) await abortableYield(engine.api.signal, done => window.setTimeout(done, 250 * (attempt + 1)));
						this.ensureCurrent(engine.api);
						if (this.secret('access') !== engine.api.accessKey) throw error;
						engine.direction = intersectDirection(this.data.settings.direction, engine.remoteMode);
						if (engine.direction === 'paused') throw error;
						this.setStatus(t('sync.changedRetry'), { overview: t('overview.scanning') });
					}
				}
				if (this.pluginStateRestartPending) {
					this.pluginStateRestartPending = false;
					this.notify(t('configuration.pluginEnabledRestart'), true);
				}
				const { pins } = this.notePinContext();
				this.syncStage('pins');
				if (!pinsSupported && Object.keys(pins.pending).length) throw Object.assign(new Error('Pin service upgrade required'), { code: 'PIN_SERVICE_UPGRADE' });
				if (pinsSupported) {
					try {
						await synchronizeNotePins({ api: engine.api, keys, state: pins, notes: engine.state.notes,
							direction: engine.remoteMode !== 'both' ? engine.remoteMode : engine.direction, save: () => this.saveData(this.data), active: () => {
								this.ensureCurrent(engine.api); return !this.stopped;
							} });
					} finally { this.refreshExplorerSorting(); }
				}
				if (approval) {
					this.data.settings.direction = approval.direction;
					this.reviewApprovals[approval.key] = true;
					this.reviewApprovals[await this.reviewKey()] = true;
					this.data.reviewed = this.reviewApprovals;
				}
				const remaining = files.some((row) => this.journal.canRetry(row, this.taskScope));
				const waitingForTree = Object.keys(engine.state.pendingTreeDeletions ?? {}).length > 0;
				const idle = automatic && !retryRow && !approval && !remaining && !waitingForTree && !this.cycleActivity.changed && !Object.keys(pins.pending).length;
				this.idleRounds = idle ? (this.idleRounds ?? 0) + 1 : 0;
				if (remaining) this.notify(t('msg_6ca31e24a5'));
				this.journal.update(cycle, { status: 'done' });
				if (idle && coalesceCycle && !this.cycleActivity.changed) {
					this.journal.rows = this.journal.rows.filter(row => row.id !== cycle);
				} else {
					this.queueDiagnostic(this.journal.rows.find((row) => row.id === cycle), diagnosticApi);
					await this.persistTasks();
					this.lastQuietCycleAt = idle ? Date.now() : undefined;
				}
				this.setStatus(
					waitingForTree ? t('sync.changedWait') : remaining
						? t('msg_f59132e78d')
						: files.length
							? t('msg_06cee02649')
							: t('msg_01a417d025', { value0: new Date().toLocaleTimeString(locale) }),
					{ overview: waitingForTree ? t('overview.receiving') : remaining ? t('overview.retryNeeded') : t('overview.synced') },
				);
			} catch (error) {
				this.idleRounds = 0;
				this.verifiedRoute = undefined;
				if (!approval && error?.code === 'PLAN_CHANGED') {
					if (cycle) { this.journal.update(cycle, { status: 'skipped' }); await this.persistTasks(); }
					this.setStatus(t('sync.changedWait'), { overview: t('task.stateIdle') });
					const binding = () => JSON.stringify([this.data.localId, this.data.settings, this.secret('access')]);
					const expected = binding(), controller = this.abortController, pending = this.running;
					window.clearTimeout(this.pendingTimer);
					this.pendingTimer = window.setTimeout(async () => {
						await pending?.catch(() => {});
						if (!this.stopped && !this.stopping && !controller.signal.aborted && this.abortController === controller && binding() === expected && this.data.settings.direction !== 'paused')
							void this.synchronize(undefined, undefined, true);
					}, 1500);
					return;
				}
				if (approval && error?.code === 'PLAN_CHANGED') error.reviewRequired = true;
				if (error?.status === 410) await this.detachDeletedNotebook(diagnosticApi?.workspace ?? this.data.settings.workspace);
				if (error?.code === 'PLAN_CHANGED') {
					delete this.reviewApprovals[await this.reviewKey()];
					this.data.reviewed = this.reviewApprovals;
				}
				if (cycle) {
					this.journal.update(cycle, { status: 'failed', error });
					this.queueDiagnostic(this.journal.rows.find((row) => row.id === cycle), diagnosticApi);
					await this.persistTasks().catch(() => {
						this.taskSaveFailed = true;
					});
				}
				this.setStatus(error?.pendingReceiveCount
					? t('sync.partialReceive', { count: error.pendingReceiveCount })
					: t('msg_c0d9fccf36', { value0: failureMessage(error) }),
					{ overview: error?.pendingReceiveCount ? t('overview.retryNeeded') : t('overview.failed') });
			} finally {
				if (diagnosticApi) await this.flushDiagnostics(diagnosticApi, { automatic });
				this.refreshTasks();
			}
		})().finally(() => {
			window.clearInterval(this.stageTimer);
			this.lastCycleActivity = { ...this.cycleActivity, finishedAt: Date.now() };
			this.cycleActivity = undefined;
			window.clearTimeout(this.backgroundStatusTimer);
			this.deferBackgroundStatus = false;
			this.backgroundStatus = undefined;
			this.lastFinished = Date.now();
			this.running = undefined;
		});
		return this.running;
	}
	creationDeviceName() {
		if (!Platform.isMobile) {
			try {
				const name = window.require?.('node:os').hostname();
				if (typeof name === 'string' && name.trim())
					return [...name]
						.filter((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
						.join('')
						.trim()
						.slice(0, 120);
			} catch {
				/* A host without Node uses the platform name. */
			}
		}
		return Platform.isIosApp
			? 'iPhone / iPad'
			: Platform.isAndroidApp
				? 'Android'
				: t('notebook.computer');
	}
	devicePlatform() {
		if (Platform.isIosApp) return Platform.isTablet ? 'iPadOS' : 'iOS';
		if (Platform.isAndroidApp) return 'Android';
		let system;
		try { system = window.require?.('node:os').platform?.(); }
		catch { system = undefined; }
		if (system) return ({ win32: 'Windows', darwin: 'macOS', linux: 'Linux' })[system] ?? system;
		if (Platform.isWin) return 'Windows';
		if (Platform.isMacOS) return 'macOS';
		return t('notebook.computer');
	}
	deviceDisplayName() {
		const platform = this.devicePlatform();
		const name = !Platform.isMobile ? this.creationDeviceName() : platform === 'iPadOS' ? 'iPad' : platform === 'iOS' ? 'iPhone' : platform;
		const suffix = Platform.isMobile ? ` (${this.data.localId.slice(0, 8)})` : '';
		return [...`${platform} · ${name}${suffix}`].filter(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127).join('').slice(0, 80);
	}
	async updateDeviceLabel(api, principal) {
		const label = this.deviceDisplayName(), binding = `${api.origin}|${api.workspace}|${principal.deviceId}|${label}`;
		if (!principal.scope || !principal.deviceId || this.deviceLabelBinding === binding) return;
		this.ensureCurrent(api);
		try {
			await api.request('POST', 'session/label', { workspace: api.workspace, label });
		} catch { return; }
		this.ensureCurrent(api);
		this.deviceLabelBinding = binding;
	}
	workspaceDisplayName(workspace) {
		return `${workspace.label}_${workspace.createdDevice || t('notebook.originUnknown')}`;
	}
	async chooseWorkspace() {
		try {
			const api = await this.accountApi();
			const { workspaces } = await api.workspaces();
			new ChoiceWindow(this.app, t('msg_c464003218'), (container) => {
				for (const workspace of workspaces)
					action(container, this.workspaceDisplayName(workspace), async () => {
						await this.withWorkspaceEncryption(api,workspace,passphrase=>this.connectWorkspace(api,workspace,passphrase));
					});
			}).open();
		} catch {
			this.notify(t('msg_0830688f1a'));
		}
	}
	async createWorkspace() {
		await this.exclusive(async () => {
			if (this.data.settings.workspace) throw notebookAlreadyConnected();
			const api = this.api();
			const accountContext=await this.unlockAccountEncryption(api,this.secret('encryption'));
			const {workspace}=await this.createAccountWorkspace(api,this.data.settings.label,accountContext,this.secret('encryption'));
			this.data.settings.workspace = workspace.id;
			this.data.settings.direction = 'both';
			await this.saveData(this.data);
			this.notify(t('msg_3ef6f58fe8'), false);
			this.setStatus(t('sync.ready'));
			this.tab?.update();
		});
	}
	async signOut() {
		this.accountEmail = '';
		this.overviewIdentity = undefined;
		this.lanPeers?.close();
		this.lanPeers = undefined;
		this.data.settings.direction = 'paused';
		if (this.running) await this.running;
		let revocationStatus = 'not-required';
		if (this.secret('access')) {
			revocationStatus = 'unconfirmed';
			try {
				const api = this.api();
				const principal = await api.request('GET', 'account');
				if (principal.scope && principal.deviceId) {
					await api.request('POST', 'session/revoke', {});
					revocationStatus = 'confirmed';
				} else revocationStatus = 'not-required';
			} catch (error) {
				if (error?.status === 401) revocationStatus = 'confirmed';
				// Offline local sign-out still completes, without claiming remote revocation.
			}
		}
		this.data.archives ??= [];
		this.data.archives.push({
			at: Date.now(),
			session: this.data.localId,
			connections: this.data.connections,
		});
		this.data.connections = {};
		this.data.renames = {};
		this.app.secretStorage.setSecret(`${this.manifest.id}-${this.data.localId}-access`, '');
		this.app.secretStorage.setSecret(`${this.manifest.id}-${this.data.localId}-encryption`, '');
		this.app.secretStorage.setSecret(`${this.manifest.id}-${this.data.localId}-crypto`, '');
		const accountKey = this.secret('account');
		if (accountKey) {
			try {const accountApi = this.workspaceApi(this.data.settings.origin, accountKey);const principal = await accountApi.request('GET','account');if (principal.accountDevice) await accountApi.request('POST','session/revoke',{});} catch { /* Local sign-out still forgets authorization. */ }
		}
		this.app.secretStorage.setSecret(`${this.manifest.id}-${this.data.localId}-account`, '');
		this.accountAuthorized = false;
		this.data.localId = crypto.randomUUID();
		delete this.data.lastDeletedWorkspace;
		this.data.settings.workspace = '';
		this.data.settings.direction = 'both';
		this.journal.names.clear();
		this.taskScope = await fingerprint(
			new TextEncoder().encode(`${new URL(this.data.settings.origin).origin}|`),
		);
		await this.saveData(this.data);
		this.refreshTasks();
		this.setStatus(t('sync.notConnected'));
		this.notify(revocationStatus === 'unconfirmed' ? t('msg_df7eea58c8') : t('msg_a5bfd733fb'));
		this.tab?.update();
		return { revocationConfirmed: revocationStatus === 'confirmed', revocationStatus };
	}
	async storageControls() {
		// Usage and retention are metadata requests; opening this view must not
		// initialize another engine or contend with the active file transfer.
		const api = this.api();
		this.ensureCurrent(api);
		let usage = await api.usage(),
			policy = await api.request('GET', api.scope('retention'));
		this.ensureCurrent(api);
		const refresh = async () => {
			const [nextUsage, nextPolicy] = await Promise.all([
				api.usage(),
				api.request('GET', api.scope('retention')),
			]);
			this.ensureCurrent(api);
			usage = nextUsage;
			policy = nextPolicy;
			dialog.contentEl.empty();
			dialog.render(dialog.contentEl);
		};
		const dialog = new ChoiceWindow(this.app, t('msg_cfbe09811a'), (area) => {
			action(area, t('storage.refresh'), refresh);
			area.createEl('p', {
				text: t('msg_94eddf4cf3', {
					bytes: Number.isSafeInteger(usage.logicalBytes) ? formatStorageSize(usage.logicalBytes) : t('overview.spaceUnknown'),
					maximumStoredBytes: Number.isSafeInteger(usage.maximumLogicalBytes) ? formatStorageSize(usage.maximumLogicalBytes) : t('overview.spaceUnknown'),
					accountBytes: Number.isSafeInteger(usage.accountLogicalBytes) ? formatStorageSize(usage.accountLogicalBytes) : t('overview.spaceUnknown'),
				}),
			});
			let days = policy.days,
				minimum = policy.minimum,
				daysInput,
				minimumInput;
			new Setting(area).setName(t('msg_36342cf528')).addDropdown((input) =>
				input
					.addOptions({
						90: t('msg_a31f0d5da8'),
						30: t('msg_2fff7456f2'),
						7: t('msg_7635f2db97'),
						0: t('msg_e3fb03d459'),
						custom: t('msg_494ca78f73'),
					})
					.setValue(
						days === 0 && minimum === 1
							? '0'
							: minimum === 10 && [7, 30, 90].includes(days)
								? String(days)
								: 'custom',
					)
					.onChange((value) => {
						if (value === 'custom') return;
						days = Number(value);
						minimum = days === 0 ? 1 : 10;
						daysInput?.setValue(String(days));
						minimumInput?.setValue(String(minimum));
					}),
			);
			new Setting(area).setName(t('msg_51de0850f6')).addText((input) => {
				daysInput = input;
				input.setValue(String(days)).onChange((value) => {
					days = Number(value);
				});
			});
			new Setting(area).setName(t('msg_9d34177b21')).addText((input) => {
				minimumInput = input;
				input.setValue(String(minimum)).onChange((value) => {
					minimum = Number(value);
				});
			});
			action(area, t('msg_11b553f933'), () =>
				this.exclusive(async () => {
					this.ensureCurrent(api);
					await api.request('POST', api.scope('retention'), { days, minimum });
					this.notify(t('msg_9c322a261c'));
					await refresh();
				}),
			);
			area.createEl('p', {
				text: t('storage.logicalHelp'),
			});
			area.createEl('p', {
				text: t('msg_17a1d5cfb3', { workspace: api.workspace }),
			});
			let confirm = '';
			const confirmed = () => {
				if (confirm === api.workspace) return true;
				this.notify(t('storage.confirmRequired', { workspace: api.workspace }));
				return false;
			};
			new Setting(area).setName(t('storage.confirmLabel')).addDropdown((input) =>
				input.addOptions({ '': t('storage.confirmChoose'), [api.workspace]: t('storage.confirmCurrent') }).setValue('').onChange((value) => {
					confirm = value;
				}),
			);
			bindAction(new Setting(area).setDesc(t('storage.purgeHelp')), t('msg_d12185b679'), () =>
				this.exclusive(async () => {
					this.ensureCurrent(api);
					if (!confirmed()) return;
					const result = await api.request('POST', api.scope('trash/purge'), {
						confirm,
					});
					this.notify(t('msg_5280de73c3', { purgedNotes: result.purgedNotes }));
					await refresh();
				}),
			);
			for (const [label, currentOnly, help] of [
				[t('msg_6aa7a7fb4d'), false, t('storage.policyHelp')],
				[t('msg_a58295f5c5'), true, t('storage.currentHelp')],
			])
				bindAction(new Setting(area).setDesc(help), label, () =>
					this.exclusive(async () => {
						this.ensureCurrent(api);
						if (!confirmed()) return;
						const result = await api.request('POST', api.scope('maintenance'), {
							confirm,
							currentOnly,
						});
						this.notify(
							t('storage.cleaned', { revisions: result.revisions, objects: result.objects }),
						);
						await refresh();
					}),
				);
		});
		dialog.open();
		return dialog;
	}
	async logs() {
		const leaf =
			this.app.workspace.getLeavesOfType(logViewType)[0] ??
			this.app.workspace.getRightLeaf(false);
		if (!leaf) return;
		await leaf.setViewState({ type: logViewType, active: true });
		this.app.workspace.revealLeaf(leaf);
	}
	async stopSynchronization() {
		if (this.stopRun) return this.stopRun;
		this.stopping = true;
		if (this.data) this.data.manualSyncStopped = true;
		this.cancelEditorSaves();
		this.abortController.abort();
		window.clearTimeout(this.diagnosticTimer);
		this.diagnosticTimer = undefined;
		this.idleRounds = 0;
		this.verifiedRoute = undefined;
		this.workspaceKeys = undefined;
		window.clearTimeout(this.pendingTimer);
		this.lanPeers?.close();
		this.lanPeers = undefined;
		const running = this.running;
		const started = performance.now();
		this.stopRun = (async () => {
			try {
				await Promise.allSettled([...(this.editorSaveWork?.values() ?? [])]);
				if (running) {
					await running.catch(() => {});
				}
				await this.diagnosticRun;
				if (this.data) {
					if (this.checkpoints) await this.checkpoints.saveConfiguration(this.data);
					else await this.saveData(this.data);
				}
				this.setStatus(t('task.stopped'));
			} finally { if (!this.stopped) this.abortController = new AbortController(); this.lastStopMilliseconds = performance.now() - started; this.stopping = false; }
		})().finally(() => { this.stopRun = undefined; });
		return this.stopRun;
	}
	async persistTasks() {
		this.taskSaveDirty = true;
		if (this.taskSave) return this.taskSave;
		this.taskSave = Promise.resolve().then(async () => {
			try {
				while (this.taskSaveDirty) {
					this.taskSaveDirty = false;
					this.data.tasks = this.journal.snapshot();
					if (this.checkpoints) await this.checkpoints.saveConfiguration(this.data);
					else await this.saveData(this.data);
					this.taskSaveFailed = false;
				}
			} finally { this.taskSave = undefined; }
		});
		return this.taskSave;
	}
	queueDiagnostic(row, api) {
		if (!row || ['running', 'resolved'].includes(row.status)) return;
		const entries = this.data.taskOutbox ?? [];
		if (!entries.some((entry) => entry.id === row.id)) entries.push({ ...row });
		this.data.taskOutbox = entries.slice(-2000);
		if (api) this.scheduleDiagnostics(api);
	}
	scheduleDiagnostics(api) {
		if (this.stopped || this.stopping || api.signal?.aborted || this.diagnosticTimer || this.diagnosticRun) return;
		const delay = Math.max(1000, (this.diagnosticRetryAt ?? 0) - Date.now());
		this.diagnosticTimer = window.setTimeout(() => {
			this.diagnosticTimer = undefined;
			void this.flushDiagnostics(api, { automatic: true });
		}, delay);
	}
	flushDiagnostics(api, { automatic = false } = {}) {
		if (this.diagnosticRun) return this.diagnosticRun;
		if (this.stopped || this.stopping || api.signal?.aborted || (automatic && Date.now() < (this.diagnosticRetryAt ?? 0))) return Promise.resolve();
		window.clearTimeout(this.diagnosticTimer);
		this.diagnosticTimer = undefined;
		this.diagnosticRun = this.drainDiagnostics(api).finally(() => {
			this.diagnosticRun = undefined;
			if (this.diagnosticPending) this.scheduleDiagnostics(api);
		});
		return this.diagnosticRun;
	}
	async drainDiagnostics(api) {
		let cancellation, scope, changed = false;
		try {
			this.ensureCurrent(api);
			if (api.accessKey !== this.secret('access')) return;
			scope = await fingerprint(new TextEncoder().encode(`${api.origin}|${api.workspace}`));
			const device = await fingerprint(new TextEncoder().encode(this.data.localId));
			const reporter = this.workspaceApi(api.origin, api.accessKey, api.workspace, api.fetcher);
			cancellation = cancellationScope([api.signal, this.abortController.signal], 3000);
			reporter.signal = cancellation.signal;
			for (let batch = 0; batch < 8; batch++) {
				this.ensureCurrent(api);
				if (this.stopped || this.stopping || cancellation.signal.aborted || api.accessKey !== this.secret('access')) break;
				const pending = this.data.taskOutbox.filter(row => row.scope === scope);
				const priority = row => row.direction === 'cycle' ? 0 : ['failed', 'interrupted'].includes(row.status) ? 1 : 2;
				const queued = pending.sort((first, second) => priority(first) - priority(second)).slice(0, 64);
				if (!queued.length) break;
				const entries = queued.map((row) => ({
					id: row.id,
					note: row.note,
					device,
					direction: row.direction,
					status: row.status,
					bytes: row.bytes,
					total: row.total,
					failure: row.failure,
					duration: Math.max(0, Math.min(1e12, row.finished - row.started)),
					version: row.version,
					reportedAt: row.finished || row.started,
				}));
				const reply = await reporter.request('POST', reporter.scope('diagnostics'), { entries });
				this.ensureCurrent(api);
				if (this.stopped || this.stopping || api.accessKey !== this.secret('access')) break;
				const accepted = new Set(
					Array.isArray(reply.accepted)
						? reply.accepted.filter((id) => queued.some((row) => row.id === id))
						: [],
				);
				if (!accepted.size) { this.diagnosticRetryAt = Date.now() + 15000; break; }
				this.data.taskOutbox = this.data.taskOutbox.filter((row) => !accepted.has(row.id));
				changed = true;
				this.diagnosticRetryAt = undefined;
			}
		} catch {
			this.diagnosticRetryAt = Date.now() + 15000;
		} finally {
			cancellation?.dispose();
			this.diagnosticPending = scope ? this.data.taskOutbox.filter(row => row.scope === scope).length : 0;
			if (changed) await this.persistTasks().catch(() => { this.taskSaveFailed = true; });
		}
	}
	refreshTasks() {
		if (this.taskRenderTimer || this.stopped) return;
		this.taskRenderTimer = window.setTimeout(() => {
			this.taskRenderTimer = undefined;
			for (const view of this.logViews) view.render();
		}, 100);
	}
	taskSyncState() {
		if (!this.data.settings.workspace) return t('task.stateDisconnected');
		const phase = this.overviewStatusText;
		if (this.stopping) return t('task.stateStopping');
		if (this.data.settings.direction === 'paused' || [t('msg_c4f91c861a'), t('device.paused'), t('task.stopped')].includes(phase)) return t('task.statePaused');
		if (phase === t('overview.synced')) return t('overview.synced');
		if ([t('overview.failed'), t('overview.retryNeeded')].includes(phase)) return t('task.stateIncomplete');
		if (this.running || [t('overview.scanning'), t('overview.uploading'), t('overview.receiving'), t('msg_4c9b675ab6')].includes(phase)) return t('task.stateSyncing');
		return t('task.stateIdle');
	}
	renderTasks(area) {
		area.empty();
		area.createEl('h3', { text: t('msg_6dc05b92e9') });
		const state = area.createEl('p', { cls: 'smart-sync-task-status', text: t('task.stateLine', { state: this.taskSyncState() }) });
		const toolbar = new Setting(area.createDiv({ cls: 'smart-sync-task-actions' }));
		bindAction(toolbar, t('task.stop'), () => this.stopSynchronization());
		bindAction(toolbar, t('msg_068b3edb46'), async () => {
			const pending = this.journal.select(this.taskScope, { status: 'pending' });
			if (!pending.length) return;
			await this.synchronize(pending);
		});
		bindAction(toolbar, t('msg_42e67eb3e4'), async () => {
			this.journal.rows = this.journal.rows.filter(
				(row) =>
					row.scope !== this.taskScope || ['running', 'failed', 'interrupted'].includes(row.status),
			);
			await this.persistTasks();
			this.refreshTasks();
		});
		const body = area.createDiv();
		this.taskStatusRows ??= new WeakMap();
		this.taskStatusRows.set(body, state);
		return body;
	}
	renderTaskRows(area) {
		this.taskStatusRows?.get(area)?.setText(t('task.stateLine', { state: this.taskSyncState() }));
		area.empty();
		if (this.taskSaveFailed) area.createEl('p', { text: t('msg_294afd29d6') });
		const all = this.journal.select(this.taskScope);
		const cycle = [...all].reverse().find((row) => row.direction === 'cycle');
		const batch = cycle
			? all.filter((row) => row.direction !== 'cycle' && row.started >= cycle.started)
			: [];
		const completed = batch.filter((row) =>
			['done', 'skipped', 'deferred'].includes(row.status),
		).length;
		const failed = batch.filter((row) => ['failed', 'interrupted'].includes(row.status)).length;
		area.createEl('p', {
			text: cycle
				? t('msg_4bf9ffadb3', {
						completed: completed,
						length: batch.length,
						failed: failed,
						value3: formatStorageSize(batch.reduce((sum, row) => sum + row.bytes, 0)),
						value4:
							cycle.status === 'running'
								? t('msg_70bfc0cf0f')
								: cycle.status === 'done'
									? t('msg_aa5d3b7313')
									: t('msg_c96c0e3fa1'),
					})
				: t('msg_3e69303d70'),
		});
		const names = {
			send: t('msg_9e07e3c053'),
			receive: t('msg_6e68458688'),
			delete: t('msg_2f9daa8289'),
			cycle: t('msg_3cc6d03c6c'),
		};
		const states = {
			running: t('msg_dc9591e56d'),
			done: t('msg_f28461bb49'),
			failed: t('msg_28384d7afd'),
			interrupted: t('msg_88cf2dc00c'),
			resolved: t('msg_78ca181f89'),
			deferred: t('msg_935fc43ed9'),
			skipped: t('msg_fdfd26af96'),
		};
		const rows = this.journal.select(this.taskScope).slice().reverse();
		this.taskPage = Math.min(this.taskPage ?? 0, Math.max(0, Math.ceil(rows.length / 50) - 1));
		area.createEl('p', {
			text: t('msg_26db91f789', {
				length: rows.length,
				value1: this.taskPage + 1,
				value2: Math.max(1, Math.ceil(rows.length / 50)),
			}),
		});
		for (const row of rows.slice(this.taskPage * 50, (this.taskPage + 1) * 50)) {
			const title =
				row.direction === 'cycle'
					? t('msg_d8876950ea')
					: (this.journal.names.get(`${row.scope}:${row.note}`) ??
						t('msg_3099d6379d', { value0: row.note.slice(0, 12) }));
			area.createEl('p', {
				text: `${new Date(row.started).toLocaleString(locale)} · ${names[row.direction]} · ${title} · ${states[row.status]} · ${formatStorageSize(row.bytes)}${row.direction === 'send' && row.total ? ` / ${formatStorageSize(row.total)} (${Math.floor((row.bytes / row.total) * 100)}%)` : ''}${row.status === 'running' && row.direction === 'receive' ? t('msg_c1a2a577cd') : ''}`,
			});
			if (row.skipReason === 'desktop-plugin') area.createEl('p', { text: this.journal.message(row) });
			if (this.journal.canRetry(row, this.taskScope)) {
				area.createEl('p', { text: this.journal.message(row) });
				action(area, t('msg_a6d7a1c530'), async () => this.synchronize(row));
			}
		}
		const pagination = new Setting(area.createDiv());
		bindAction(pagination, t('msg_c9b9ae7a61'), async () => {
			this.taskPage = Math.max(0, (this.taskPage ?? 0) - 1);
			this.refreshTasks();
		});
		bindAction(pagination, t('msg_8a8542f696'), async () => {
			this.taskPage = (this.taskPage ?? 0) + 1;
			this.refreshTasks();
		});
		const details = area.createEl('details');
		details.createEl('summary', { text: t('task.recordDetails') });
		details.createEl('p', { text: t('msg_1202d86812') });
		details.createEl('p', {
			text: t('msg_b4391a4866', {
				value0: this.diagnosticPending ?? this.data.taskOutbox?.length ?? 0,
			}),
		});
	}
	logEvent(text) {
		this.events.push({ at: Date.now(), text });
		if (this.events.length > 200) this.events.shift();
		this.refreshTasks();
	}
	async presets() {
		this.data.presets ??= [];
		const dialog = new ChoiceWindow(this.app, t('msg_edb7cc572e'), (area) => {
			area.createEl('p', {
				text: t('msg_ebc860842a'),
			});
			for (const preset of this.data.presets)
				action(area, t('msg_e283e2fc15', { name: preset.name }), async () => {
					if (this.running) throw operationBusy();
					Object.assign(this.data.settings, structuredClone(preset.filters), {
						direction: 'paused',
					});
					this.data.settings.attachmentMiB = this.data.settings.attachmentMiB === 0 ? 0 : 256;
					await this.saveData(this.data);
					this.pendingPlan = undefined;
					this.setStatus(t('msg_c4f91c861a'));
					this.tab?.update();
					this.notify(t('msg_300a2093ce'));
				});
			action(area, t('msg_3b70db4d79'), async () => {
				formWindow(
					this.app,
					t('msg_afadbad990'),
					[{ key: 'name', label: t('msg_e534a6662a') }],
					async ({ name }) => {
						this.data.presets.push(filterPreset(this.data.settings, name));
						await this.saveData(this.data);
						this.notify(t('msg_246af2bffc'), false);
						dialog.contentEl.empty();
						dialog.render(dialog.contentEl);
					},
				);
			});
		});
		dialog.open();
		return dialog;
	}
	async eraseAccount() {
		formWindow(
			this.app,
			t('msg_cda8bc73dc'),
			[
				{ key: 'email', label: t('msg_316ef5f989') },
				{
					key: 'key',
					label: t('msg_104f734a38'),
					description: t('account.eraseWarning'),
					password: true,
				},
				{
					key: 'confirm',
					label: t('msg_b3588ca8a2'),
				},
			],
			async (input) => {
				if (input.confirm !== t('account.erasePhrase'))
					throw Object.assign(new Error('Account confirmation required'), {
						code: 'ACCOUNT_ERASE_CONFIRMATION',
					});
				const api = this.workspaceApi(this.data.settings.origin, input.key);
				await this.exclusive(() =>
					api.request('POST', 'account/erase', {
						email: input.email,
						confirm: 'ERASE ACCOUNT',
					}),
				);
				await this.signOut();
				this.notify(t('msg_85ffefa0e5'));
			},
		);
	}

	async requestAccess() {
  if (edition.edition === 'cn') return this.openBilling();
  let email = '';
  const dialog = new ChoiceWindow(this.app, t('msg_98d23d7e0e'), area => {
   new Setting(area).setName('邮箱').addText(input => { input.inputEl.type = 'email'; input.onChange(value => { email = value; }); });
   const details = applicationDetails(area, () => {});
   action(area, t('msg_31fbef1625'), async () => {
    const api = this.workspaceApi(this.data.settings.origin, '');
    const result = await api.request('POST', 'applications', { email: email.trim(), ...details() });
    const status = ['pending','sending','sent','failed','uncertain','revoked'].includes(result.status) ? result.status : 'unknown';
    this.notify(t('msg_043fd8bfeb', {status:t(`application.${status}`)}));
    dialog.close();
   });
  });
  dialog.open();
 }
	async applyConfiguration(config, { replace = false } = {}) {
		if (
			!config ||
			typeof config.accessKey !== 'string' ||
			config.accessKey.length < 32 ||
			typeof config.encryptionPassword !== 'string'
		)
			throw new Error('Invalid connection configuration');
		await this.exclusive(async () => {
			if (
				!replace && this.data.settings.workspace &&
				(this.data.settings.workspace !== config.workspace ||
					new URL(this.data.settings.origin).origin !== new URL(config.origin).origin)
			)
				throw notebookAlreadyConnected();
			const api = this.workspaceApi(config.origin, config.accessKey, config.workspace);
			const info = await api.info();
			const keys = await unlockWorkspace(config.encryptionPassword, info.salt);
			if ((await workspaceProof(keys)) !== info.proof)
				throw new Error('Workspace encryption check failed');
			const principal = await api.request('GET', 'account');
			if (!principal.scope) {this.app.secretStorage.setSecret(`${this.manifest.id}-${this.data.localId}-account`, config.accessKey);this.accountAuthorized=true;}
			if(config.accountEncryptionPassword && !principal.scope)await this.unlockAccountEncryption(api,config.accountEncryptionPassword);
			if(config.accountAccessKey){
				const accountApi=this.workspaceApi(api.origin,config.accountAccessKey),account=await accountApi.request('GET','account');
				if(account.scope || account.owner!==principal.owner)throw Error('Recovery account does not match');
				if(config.accountEncryptionPassword)await this.unlockAccountEncryption(accountApi,config.accountEncryptionPassword);
				this.app.secretStorage.setSecret(`${this.manifest.id}-${this.data.localId}-account`,config.accountAccessKey);this.accountAuthorized=true;
			}
			const accessKey = principal.scope
				? config.accessKey
				: (
						await api.request('POST', 'session', {
							workspace: api.workspace,
							label: this.deviceDisplayName(),
						})
					).key;
			this.app.secretStorage.setSecret(
				`${this.manifest.id}-${this.data.localId}-access`,
				accessKey,
			);
			this.app.secretStorage.setSecret(
				`${this.manifest.id}-${this.data.localId}-encryption`,
				config.encryptionPassword,
			);
			this.lanPeers?.close();
			this.lanPeers = undefined;
			delete this.data.lastDeletedWorkspace;
			Object.assign(this.data.settings, {
				origin: api.origin,
				workspace: api.workspace,
				direction: 'both',
			});
			await this.saveData(this.data);
		});
		this.notify(t('msg_1616ece37e'));
		this.setStatus(t('sync.ready'));
		this.tab?.update();
	}
	async enrollment(initialMode = 'registered') {
		let mode = edition.edition !== 'cn' && initialMode === 'new' ? 'new' : 'registered',
			version = 0;
		const dialog = new ChoiceWindow(this.app, t('msg_911a5a5fee'), (area) => {
			const render = () => {
				version++;
				area.empty();
				if (edition.edition !== 'cn') {
				action(area, t('msg_6d3f7c7e30'), async () => {
					mode = 'registered';
					render();
				});
				action(area, t('msg_bdbdb86464'), async () => {
					mode = 'new';
					render();
				});
				}
				let value = '',
					pending = false;
				new Setting(area)
					.setName(mode === 'registered' ? t('msg_2f6f0adc32') : t('msg_f2488fd4ef'))
					.addText((input) => {
						if (mode === 'registered') input.inputEl.type = 'password';
						input.onChange((text) => {
							value = text;
							version++;
							feedback.setText('');
						});
					});
				const details = mode === 'new' ? applicationDetails(area, () => { version++; }) : null;
				const feedback = area.createEl('p', {
					text: mode === 'registered' ? t('msg_3f56b1794d') : t('msg_369780c1a6'),
				});
				action(
					area,
					mode === 'registered' ? t('msg_bcd99fecff') : t('msg_e977bbb068'),
					async () => {
						if (pending) return;
						const currentMode = mode,
							requestVersion = version;
						pending = true;
						try {
							if (!value.trim()) {
								feedback.setText(
									currentMode === 'registered' ? t('msg_a152f8d825') : t('msg_280f46b896'),
								);
								return;
							}
							const api = this.workspaceApi(
								this.data.settings.origin,
								currentMode === 'registered' ? value.trim() : '',
							);
							if (currentMode === 'new') {
								await api.request('POST', 'applications', {
									email: value.trim(),
									...details(),
								});
								if (version === requestVersion) feedback.setText(t('msg_0f5179405d'));
								return;
							}
							const { workspaces } = await api.workspaces();
							if (version !== requestVersion) return;
							const loggedIn = await api.request('GET', 'account');
							if (version !== requestVersion) return;
							if (!loggedIn.scope) {this.app.secretStorage.setSecret(`${this.manifest.id}-${this.data.localId}-account`, api.accessKey);this.accountAuthorized=true;}
							const picker = new ChoiceWindow(this.app, t('msg_1b5cc18c43'), (container) => {
								for (const workspace of workspaces) action(container,this.workspaceDisplayName(workspace),async()=>{
									await this.withWorkspaceEncryption(api,workspace,async passphrase=>{
										await this.connectWorkspace(api,workspace,passphrase);
										picker.close();dialog.close();
									});
								});
								action(container,t('msg_4647ca53a9'),async()=>{
									if(this.data.settings.workspace)throw notebookAlreadyConnected();
									formWindow(this.app,t('msg_372e614bfe'),[{key:'label',label:t('msg_4e9bfa704d')}],async({label})=>{
										await this.withAccountEncryption(api,async context=>{
											if(this.data.settings.workspace)throw notebookAlreadyConnected();
											const {workspace,password}=await this.createAccountWorkspace(api,label,context);
											await this.connectWorkspace(api,workspace,password);
											picker.close();dialog.close();
										});
									});
								});
							});
							picker.open();
						} catch (error) {
							if (version === requestVersion)
								feedback.setText(
									error?.status === 401
										? t('msg_8e60cde0d2')
										: error?.status === 400
											? t('msg_4e5ad8c798')
											: t('msg_9b1d6b4113'),
								);
						} finally {
							pending = false;
						}
					},
				);
				if (mode === 'registered') action(area, t('msg_a070395fba'), () => this.pairThisDevice());
			};
			render();
		});
		dialog.onClose = () => {
			version++;
			dialog.contentEl.empty();
		};
		dialog.open();
	}
	async connectWorkspace(api, workspace, passphrase, { replace = false } = {}) {
		if (this.connecting) throw new Error('A notebook connection is already in progress');
		this.connecting = true;
		try {
		if (api.origin !== new URL(this.data.settings.origin).origin)
			throw new Error('Service selection changed; start connection again');
		if (!replace && this.data.settings.workspace && this.data.settings.workspace !== workspace.id)
			throw notebookAlreadyConnected();
		const scoped = this.workspaceApi(api.origin, api.accessKey, workspace.id),
			info = await scoped.info();
		const keys = await unlockWorkspace(passphrase, info.salt);
		if ((await workspaceProof(keys)) !== info.proof)
			throw new Error('Notebook encryption passphrase does not match');
		const principal = await api.request('GET', 'account');
		if (!principal.scope) {this.app.secretStorage.setSecret(`${this.manifest.id}-${this.data.localId}-account`, api.accessKey);this.accountAuthorized=true;}
		const device = await api.request('POST', 'session', {
			workspace: workspace.id,
			label: this.deviceDisplayName(),
		});
		await this.applyConfiguration({
			origin: api.origin,
			workspace: workspace.id,
			accessKey: device.key,
			encryptionPassword: passphrase,
		}, { replace });
		} finally {
			this.connecting = false;
		}
	}
	purchaseSession() {
		try {
			const value = JSON.parse(this.secret('purchase'));
			return value.origin === new URL(this.data.settings.origin).origin && /^[A-Za-z0-9_-]{43}$/.test(value.capability) ? value : undefined;
		} catch { return undefined; }
	}
	async warnCapacity() {
		if (edition.edition !== 'cn' || this.stopped || (!this.secret('account') && !this.secret('access'))) return;
		const binding = () => JSON.stringify([this.data.localId, this.data.settings.origin, this.data.settings.workspace, this.secret('account') || this.secret('access')]);
		const expected = binding(), live = () => !this.stopped && binding() === expected;
		let summary;
		try { summary = await this.billingSummary(); }
		catch { return; } // Capacity lookup must not disable downloads, cleanup or existing sync error handling.
		if (!live()) return;
		const warning = capacityWarning(summary);
		if (!warning) { this.capacityWindow?.close(); return; }
		if (this.capacityWindow && !this.capacityWindowLive?.()) this.capacityWindow.close();
		if (this.capacityWindow) return this.capacityWindow;
		const dialog = new ChoiceWindow(this.app, warning.title, area => {
			area.createEl('p', { text: warning.message });
			action(area, warning.action, async () => {
				if (this.capacityWindow !== dialog || !live()) { dialog.close(); return; }
				await this.openBilling();
				dialog.close();
			});
		});
		dialog.onClose = () => { dialog.contentEl.empty(); if (this.capacityWindow === dialog) { this.capacityWindow = undefined; this.capacityWindowLive = undefined; } };
		this.capacityWindow = dialog;
		this.capacityWindowLive = live;
		dialog.open();
		return dialog;
	}
	async billingSummary() {
		if (this.secret('account') || this.secret('access')) {
			const api = await this.accountApi(), key = this.secret('account');
			const data = await api.request('GET', 'billing/entitlement');
			if (key !== this.secret('account')) throw pairingFault('PAIRING_CHANGED');
			return data;
		}
		const purchase = this.purchaseSession();
		if (!purchase) return undefined;
		try { return await this.workspaceApi(purchase.origin, purchase.capability).request('GET', 'billing/guest'); }
		catch (error) {
			if (error.status === 401 && this.purchaseSession()?.capability === purchase.capability) {
				return undefined;
			}
			throw error;
		}
	}
	async openBilling(orderId) {
		if (edition.edition !== 'cn') return;
		const localId = this.data.localId, origin = new URL(this.data.settings.origin).origin;
		const guest = !this.secret('account') && !this.secret('access');
		const live = () => !this.stopped && localId === this.data.localId && origin === new URL(this.data.settings.origin).origin && guest === (!this.secret('account') && !this.secret('access'));
		const service = new URL(origin);
		const purchaseBase = origin === edition.stagingOrigin ? 'https://sync.wujiesync.cc/pay-test'
			: edition.development && service.protocol === 'http:' && ['127.0.0.1','localhost'].includes(service.hostname) ? origin : 'https://sync.wujiesync.cc/pay';
		if (guest && !this.purchaseSession()) {
			const capability = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll('+','-').replaceAll('/','_').replace(/=+$/, '');
			this.app.secretStorage.setSecret(`${this.manifest.id}-${localId}-purchase`, JSON.stringify({origin,capability}));
			if (live()) window.open(purchaseBase + '/plans#register=' + capability, '_blank', 'noopener,noreferrer');
			return;
		}
		const purchase = guest ? this.purchaseSession() : undefined;
		const api = guest ? this.workspaceApi(origin, purchase.capability) : await this.accountApi(), key = this.secret('account');
		let entry;
		try { entry = await api.request('POST', guest ? 'billing/guest/entry' : 'billing/entry', typeof orderId === 'string' ? {orderId} : {}); }
		catch (error) {
			if (guest && error.status === 401 && live()) { window.open(purchaseBase + '/plans#register=' + purchase.capability, '_blank', 'noopener,noreferrer'); return; }
			throw error;
		}
		if (!live() || key !== this.secret('account') || (guest && purchase.capability !== this.purchaseSession()?.capability)) return;
		const url = new URL(entry.url);
		const expected = new URL(purchaseBase + '/plans');
		const checkout = expected.pathname.replace(/plans$/, 'checkout/');
		const allowedPath = typeof orderId === 'string' && /^[a-f0-9]{32}$/.test(orderId) ? checkout + orderId : expected.pathname;
		if (url.origin !== expected.origin || url.pathname !== allowedPath || url.search || !/^#ticket=[A-Za-z0-9_-]{43}$/.test(url.hash)) throw Error('Invalid purchase entry');
		if (orderId === true) url.pathname = expected.pathname.replace(/plans$/, 'orders');
		window.open(url.href, '_blank', 'noopener,noreferrer');
	}
	async accountApi() {
		const key = this.secret('account') || this.secret('access');
		const localId = this.data.localId;
		const api = this.workspaceApi(this.data.settings.origin, key);
		const principal = await api.request('GET', 'account');
		if (this.stopped || localId !== this.data.localId || api.origin !== new URL(this.data.settings.origin).origin || key !== (this.secret('account') || this.secret('access')))
			throw pairingFault('PAIRING_CHANGED');
		if (principal.scope) throw Object.assign(new Error('Account authorization required'), {code:'ACCOUNT_LOGIN_REQUIRED'});
		this.app.secretStorage.setSecret(`${this.manifest.id}-${this.data.localId}-account`, key);
		this.accountAuthorized = true;
		api.workspace = this.data.settings.workspace;
		return api;
	}
	async unlockAccountEncryption(api, password) {
		const localId=this.data.localId;
		const principal=await api.request('GET','account');
		if(principal.scope)throw Object.assign(Error('Account authorization required'),{code:'ACCOUNT_LOGIN_REQUIRED'});
		const {encryption}=await api.request('GET','account/encryption');
		if(!password){
			try{const saved=JSON.parse(this.secret('crypto')||'null');if(saved?.origin===api.origin && saved.owner===principal.owner)password=saved.password;}catch{/* No usable account password. */}
		}
		if(!password)throw Object.assign(Error('Unlock account encryption'),{code:encryption?'ACCOUNT_ENCRYPTION_LOCKED':'ACCOUNT_ENCRYPTION_SETUP'});
		if(typeof password!=='string'||password.length<12)throw Object.assign(Error('Account password too short'),{code:'ACCOUNT_ENCRYPTION_SHORT'});
		const salt=encryption?.salt??freshSalt(),keys=await unlockWorkspace(password,salt),proof=await accountProof(keys);
		if(encryption && proof!==encryption.proof)throw Object.assign(Error('Account password does not match'),{code:'ACCOUNT_ENCRYPTION_WRONG'});
		this.checkAccountEncryption(api,{localId,origin:api.origin});
		if(!encryption)await api.request('POST','account/encryption',{salt,proof});
		const currentAuthorization=this.secret('account')||this.secret('access');
		if(this.stopped || this.data.localId!==localId || new URL(this.data.settings.origin).origin!==api.origin || (currentAuthorization && currentAuthorization!==api.accessKey))throw Error('Account changed while unlocking');
		this.app.secretStorage.setSecret(`${this.manifest.id}-${this.data.localId}-crypto`,JSON.stringify({origin:api.origin,owner:principal.owner,password}));
		return {keys,password,owner:principal.owner,localId,origin:api.origin};
	}
	checkAccountEncryption(api,context){
		const currentAuthorization=this.secret('account')||this.secret('access');
		if(this.stopped||context.localId!==this.data.localId||context.origin!==new URL(this.data.settings.origin).origin||api.origin!==context.origin||(currentAuthorization && currentAuthorization!==api.accessKey))throw Error('Account encryption context changed');
	}
	async withAccountEncryption(api, callback) {
		try{return await callback(await this.unlockAccountEncryption(api));}
		catch(error){
			if(!['ACCOUNT_ENCRYPTION_LOCKED','ACCOUNT_ENCRYPTION_SETUP','ACCOUNT_ENCRYPTION_WRONG'].includes(error.code))throw error;
			return formWindow(this.app,t(error.code==='ACCOUNT_ENCRYPTION_SETUP'?'accountEncryption.setup':'accountEncryption.unlock'),[
				{key:'password',label:t('accountEncryption.password'),description:t('accountEncryption.help'),password:true},
				...(error.code==='ACCOUNT_ENCRYPTION_SETUP'?[{key:'confirmation',label:t('accountEncryption.confirm'),password:true}]:[]),
			],async({password,confirmation})=>{
				if(confirmation!==undefined && password!==confirmation)throw Object.assign(Error('Account password confirmation mismatch'),{code:'ACCOUNT_ENCRYPTION_CONFIRM'});
				return callback(await this.unlockAccountEncryption(api,password));
			});
		}
	}
	async saveWrappedPassword(api, context, workspace, password) {
		this.checkAccountEncryption(api,context);
		const wrapped=await wrapWorkspacePassword(context.keys,context.owner,workspace,password);
		try{await api.request('PUT',`account/encryption/workspaces/${workspace}`,wrapped);}
		catch(error){
			if(error.status!==409)throw error;
			const result=await api.request('GET',`account/encryption/workspaces/${workspace}`);
			if(!result.wrapped || await unwrapWorkspacePassword(context.keys,context.owner,workspace,result.wrapped)!==password)throw error;
		}
	}
	async withWorkspaceEncryption(api, workspace, callback) {
		return this.withAccountEncryption(api,async context=>{
			const {wrapped}=await api.request('GET',`account/encryption/workspaces/${workspace.id}`);
			if(wrapped){const password=await unwrapWorkspacePassword(context.keys,context.owner,workspace.id,wrapped);this.checkAccountEncryption(api,context);return callback(password);}
			const info=await api.request('GET',`workspaces/${workspace.id}`);
			const matches=async password=>await workspaceProof(await unlockWorkspace(password,info.salt))===info.proof;
			let password=context.password;
			if(this.data.settings.workspace===workspace.id && this.secret('encryption'))password=this.secret('encryption');
			const adopt=async password=>{
				this.checkAccountEncryption(api,context);
				if(!await matches(password))throw Object.assign(Error('Original workspace password does not match'),{code:'WRONG_NOTEBOOK_KEY'});
				await this.saveWrappedPassword(api,context,workspace.id,password);
				return callback(password);
			};
			if(await matches(password))return adopt(password);
			return formWindow(this.app,t('accountEncryption.importTitle'),[
				{key:'password',label:t('accountEncryption.original'),description:t('accountEncryption.importHelp'),password:true},
			],async({password})=>adopt(password));
		});
	}
	async createAccountWorkspace(api,label,context,password=Array.from(crypto.getRandomValues(new Uint8Array(32)),byte=>byte.toString(16).padStart(2,'0')).join('')) {
		this.checkAccountEncryption(api,context);
		const salt=freshSalt(),keys=await unlockWorkspace(password,salt);
		const id=crypto.randomUUID(),wrapped=await wrapWorkspacePassword(context.keys,context.owner,id,password);
		this.checkAccountEncryption(api,context);
		const workspace=await api.create(label,salt,await workspaceProof(keys),this.creationDeviceName(),{workspace:id,...wrapped});
		return {workspace,password};
	}
	async detachDeletedNotebook(workspace) {
		if (!workspace || this.data.settings.workspace !== workspace) return;
		this.lanPeers?.close(); this.lanPeers = undefined;
		this.abortController.abort();
		this.abortController = new AbortController();
		this.data.lastDeletedWorkspace = workspace;
		this.data.settings.workspace = '';
		this.pendingPlan = undefined;
		this.app.secretStorage.setSecret(`${this.manifest.id}-${this.data.localId}-access`, '');
		this.app.secretStorage.setSecret(`${this.manifest.id}-${this.data.localId}-encryption`, '');
		await this.saveData(this.data);
		this.overviewIdentity = undefined;
		this.setStatus(t('notebooks.deletedStatus'));
		this.tab?.update();
	}
	async manageNotebooks() {
		let api, lastDeletion, closed = false, revision = 0;
		const localId = this.data.localId;
		const dialog = new ChoiceWindow(this.app,t('overview.manageNotebooks'), () => {});
		const valid = () => !closed && !this.stopped && localId === this.data.localId && (!api || (api.origin === new URL(this.data.settings.origin).origin && api.accessKey === this.secret('account')));
		const load = async () => {
			const version = ++revision;
			dialog.contentEl.empty();
			dialog.contentEl.createEl('p',{text:t('notebooks.loading')});
			try {
				api = await this.accountApi();
				const result = await api.workspaces();
				if (lastDeletion) lastDeletion = await api.request('GET',`workspaces/${lastDeletion.workspace}/erasure`);
				if (!valid() || version !== revision) return;
				dialog.contentEl.empty();
				dialog.contentEl.createEl('p',{text:t('notebooks.help')});
				action(dialog.contentEl,t('notebooks.refresh'),load);
				action(dialog.contentEl,t('accountEncryption.unlock'),()=>this.withAccountEncryption(api,async()=>this.notify(t('accountEncryption.ready'))));
				if (!result.workspaces.length) dialog.contentEl.createEl('p',{text:t('notebooks.empty')});
				for (const workspace of result.workspaces) {
					const current = this.data.settings.workspace === workspace.id;
					const row = new Setting(dialog.contentEl).setName(this.workspaceDisplayName(workspace)).setDesc(current ? t('notebooks.current') : '');
					if (current) row.addButton(button => button.setButtonText(t('notebooks.connected')).setDisabled(true));
					else bindAction(row,t('notebooks.connect'), async () => {
						const replacing = !!this.data.settings.workspace;
						const originalWorkspace = this.data.settings.workspace;
						let confirmed = !replacing;
						const form = new ChoiceWindow(this.app,t('notebooks.confirmConnect'), area => {
							if (replacing) new Setting(area).setName(t('notebooks.switchConfirm')).setDesc(t('notebooks.switchHelp')).addToggle(input => input.onChange(value => {confirmed=value;}));
							action(area,t('notebooks.confirmConnect'),async () => {
								if (!valid() || !confirmed || this.data.settings.workspace !== originalWorkspace) throw Error('Confirm the current connection');
								await this.withWorkspaceEncryption(api,workspace,async passphrase=>{
									if (!valid() || this.data.settings.workspace!==originalWorkspace)throw Error('Connection changed');
									await this.stopSynchronization();
									const previous = this.secret('access') ? this.api() : undefined;
									await this.connectWorkspace(api,workspace,passphrase,{replace:replacing});
									if (previous && replacing) {try {await previous.request('POST','session/revoke',{});} catch {/* new connection is already established */}}
									form.close(); if (valid()) await load();
								});
							});
						}); form.open();
					});
					bindAction(row,t('notebooks.delete'), async () => {
						formWindow(this.app,`${t('notebooks.deleteTitle')}：${this.workspaceDisplayName(workspace)}`,[
							{key:'confirm',confirmName:workspace.label,label:t('notebooks.confirmName'),description:t('notebooks.confirmNameHelp')+'\n'+t('notebooks.deleteHelp')},
						],async ({confirm}) => {
							if (!valid()) throw Error('Notebook management state changed');
							if (confirm !== workspace.label) throw Object.assign(new Error('Notebook name confirmation mismatch'),{code:'NOTEBOOK_NAME_CONFIRMATION'});
							if (this.data.settings.workspace === workspace.id) await this.stopSynchronization();
							const result = await api.request('POST',`workspaces/${workspace.id}/erase`,{confirm});
							lastDeletion = result;
							await this.detachDeletedNotebook(workspace.id);
							this.notify(t(result.state === 'complete' ? 'notebooks.deleted' : 'notebooks.cleaning'));
							if (valid()) await load();
						},t('notebooks.confirmDelete'));
					});
				}
				for (const job of [...(result.deletions ?? []).filter(job=>job.workspace!==lastDeletion?.workspace),...(lastDeletion?[lastDeletion]:[])]) dialog.contentEl.createEl('p',{text:t(job.state==='complete'?'notebooks.deleted':job.state==='retrying'?'notebooks.retrying':'notebooks.cleaning')});
				// Account authorization is reused; creating does not sign in again.
				action(dialog.contentEl,t('msg_586de4b2a5'),async () => {
					formWindow(this.app,t('msg_372e614bfe'),[
						{key:'label',label:t('msg_4e9bfa704d')},
					],async ({label}) => {
						if (!valid()) return;
						await this.withAccountEncryption(api,async context=>{
							if (!valid())return;
							await this.createAccountWorkspace(api,label,context);
							if (valid()) await load();
						});
					});
				});

			} catch (error) {
				if (!valid() || version !== revision) return;
				dialog.contentEl.empty();
				dialog.contentEl.createEl('p',{text:error.code==='ACCOUNT_LOGIN_REQUIRED' ? t('notebooks.accountRequired') : failureMessage(error)});
				let key='';
				new Setting(dialog.contentEl).setName(t('notebooks.accountKey')).addText(input=>{input.inputEl.type='password';input.onChange(value=>{key=value;});});
				action(dialog.contentEl,t('notebooks.authorize'),async()=>{
					const next=this.workspaceApi(this.data.settings.origin,key.trim());
					const principal=await next.request('GET','account');
					if (principal.scope) throw Error('Use account authorization');
					const currentKey=this.secret('access');
					if(currentKey){
						let previous;
						try { previous=await this.api().request('GET','account'); }
						catch(error) {
							if(error.status!==401 && error.status!==410) throw error;
							// A rejected device session cannot validate a fresh login. Verify ownership with the supplied account instead.
							if(this.data.settings.workspace) {
								try {await next.request('GET',`workspaces/${this.data.settings.workspace}`);}
								catch(ownershipError){if(ownershipError.status!==410)throw ownershipError;}
							}
						}
						if(previous && previous.owner!==principal.owner)throw Error('Account does not match');
					}
					this.app.secretStorage.setSecret(`${this.manifest.id}-${this.data.localId}-account`,key.trim());
					this.accountAuthorized = true;
					key=''; await load();
				});
			}
		};
		dialog.onClose=()=>{closed=true;revision++;dialog.contentEl.empty();};
		dialog.open(); dialog.ready=load(); await dialog.ready;
		return dialog;
	}
	async addDevice() {
		const connected = Boolean(this.data.settings.workspace);
		const dialog = new ChoiceWindow(this.app, t('overview.addDevice'), (area) => {
			area.createEl('p', { text: t(connected ? 'overview.approveHelp' : 'overview.pairHelp') });
			if (connected) action(area, t('msg_99bd7e2889'), () => this.approveDevice(dialog));
			else action(area, t('msg_7db459b789'), () => this.pairThisDevice());
		});
		dialog.open();
		return dialog;
	}
	async pairThisDevice() {
		const api = this.pairingApi(this.workspaceApi(this.data.settings.origin, ''));
		let pending = await beginPairing(api);
		let received,
			generation = 0,
			closed = false,
			timer;
		const pairingDialog = new ChoiceWindow(this.app, t('msg_c288195ec5'), (container) => {
			const status = container.createEl('p');
			const update = () => {
				const seconds = Math.max(0, Math.ceil((pending.expires - Date.now()) / 1000));
				if (!seconds) {
					status.setText(t('pairing.expired'));
					return;
				}
				const message = t('msg_54c6e80fc2', {
					code: pending.code,
					fingerprint: pending.fingerprint,
					seconds,
				});
				const codeStart = message.indexOf(pending.code);
				if (codeStart < 0) {
					status.setText(message);
					return;
				}
				status.empty();
				status.createSpan({ text: message.slice(0, codeStart) });
				status.createSpan({
					text: pending.code,
					cls: 'smart-sync-pairing-code',
				});
				status.createSpan({ text: message.slice(codeStart + pending.code.length) });
			};
			update();
			timer = window.setInterval(update, 1000);
			this.registerInterval(timer);
			action(container, t('pairing.refresh'), async () => {
				if (closed || this.stopped || api.origin !== new URL(this.data.settings.origin).origin)
					throw pairingFault('PAIRING_CHANGED');
				const current = ++generation;
				const next = await beginPairing(api);
				if (closed || this.stopped || current !== generation) return;
				pending = next;
				received = undefined;
				update();
			});
			action(container, t('msg_72041afaaf'), async () => {
				if (closed || this.stopped) throw pairingFault('PAIRING_CHANGED');
				if (!received && pending.expires <= Date.now()) throw pairingFault('PAIRING_EXPIRED');
				const current = generation;
				const config = received ?? (await finishPairing(api, pending));
				if (closed || this.stopped || current !== generation) return;
				received = config;
				const confirmation = new ChoiceWindow(this.app, t('msg_0ce5c19b92'), (area) => {
					area.createEl('p', {
						text: t('msg_b2054ece22', { verification: config.verification }),
					});
					let compared = false;
					new Setting(area).setName(t('msg_2c21cae1e2')).addToggle((toggle) =>
						toggle.onChange((value) => {
							compared = value;
						}),
					);
					action(area, t('msg_428b7dee79'), async () => {
						if (closed || this.stopped || current !== generation)
							throw pairingFault('PAIRING_CHANGED');
						if (!compared || api.origin !== new URL(this.data.settings.origin).origin)
							throw new Error('Verify the devices and service first');
						await this.applyConfiguration(config);
						confirmation.close();
						pairingDialog.close();
					});
				});
				confirmation.open();
			});
		});
		pairingDialog.onClose = () => {
			closed = true;
			generation++;
			window.clearInterval(timer);
			pairingDialog.contentEl.empty();
		};
		pairingDialog.open();
	}
	pairingApi(api) {
		const binding = this.editorBinding(), encryption = this.secret('encryption'), accountCrypto = this.secret('crypto');
		const current = () => {
			if (this.stopped || binding !== this.editorBinding() || api.origin !== new URL(this.data.settings.origin).origin ||
				(api.accessKey && api.accessKey !== (this.secret('account') || this.secret('access'))) ||
				encryption !== this.secret('encryption') || accountCrypto !== this.secret('crypto'))
				throw pairingFault('PAIRING_CHANGED');
		};
		// Pairing only transfers an encrypted bootstrap; it never owns the file sync lock.
		const request = api.request.bind(api);
		api.request = async (...args) => {
			current();
			const result = await request(...args);
			current();
			return result;
		};
		current();
		return api;
	}
	async approveDevice(parentDialog) {
		return formWindow(
			this.app,
			t('msg_8ec71b949e'),
			[{ key: 'code', label: t('msg_79d9be81e0'), className: 'smart-sync-pairing-code', maxLength: 6, inputMode: 'numeric' }],
			async ({ code }) => {
				code = pairingCode(code);
				const api = this.pairingApi(await this.accountApi());
				const encryptionPassword = this.secret('encryption'), accountCrypto = this.secret('crypto');
				const observed = await inspectPairing(api, code);
				const reviewDialog = new ChoiceWindow(this.app, t('msg_41173eda61'), (container) => {
					container.createEl('p', {
						text: t('msg_80dee0162c', { fingerprint: observed.fingerprint }),
					});
					let confirmed = false;
					new Setting(container).setName(t('msg_be27a8c7ce')).addToggle((toggle) =>
						toggle.onChange((value) => {
							confirmed = value;
						}),
					);
					action(container, t('msg_bf6cb9c478'), async () => {
						if (!confirmed) throw new Error('Verify the recipient first');
						const result = await approvePairing(
							api,
							code,
							encryptionPassword,
							observed.fingerprint,
							t('msg_0c3e2183aa'),
							JSON.parse(accountCrypto||'null')?.password,
						);
						let closed = false, checking = false, timer;
						const verificationDialog = new ChoiceWindow(this.app, t('msg_706cd535a5'), (area) => {
							area.createEl('p', {
								text: t('msg_b94e615c6e', { verification: result.verification }),
							});
						});
						const check = async () => {
							if (closed || checking) return;
							if (this.stopped || Date.now() >= observed.expires || api.workspace !== this.data.settings.workspace || api.origin !== new URL(this.data.settings.origin).origin) {
								window.clearInterval(timer);
								return;
							}
							checking = true;
							try {
								const { entries } = await api.request('GET', `devices?workspace=${api.workspace}`);
								this.ensureCurrent(api);
								if (closed) return;
								if (entries.some(device => (device.id === result.grantId || device.accountDeviceId === result.grantId) && !device.accountDevice && !device.revoked && device.lastSeen > 0)) {
									verificationDialog.close();
									reviewDialog.close();
									parentDialog?.close();
								}
							} catch { return; }
							finally { checking = false; }
						};
						verificationDialog.onClose = () => {
							closed = true;
							window.clearInterval(timer);
							verificationDialog.contentEl.empty();
						};
						verificationDialog.open();
						timer = window.setInterval(() => { verificationDialog.ready = check(); }, 2000);
						this.registerInterval(timer);
						verificationDialog.ready = check();
					});
				});
				reviewDialog.open();
			},
		);
	}
	async devices() {
		let api, managingIdentity, currentDeviceId, entries, loadError, closed = false;
		const refresh = async () => {
			loadError = undefined;
			entries = undefined;
			const render = () => {
				if (closed) return;
				dialog.contentEl.empty();
				dialog.render(dialog.contentEl);
			};
			render();
			try {
				api ??= this.accountAuthorized ? await this.accountApi() : this.api();
				api.signal = this.abortController.signal;
				this.ensureCurrent(api);
				managingIdentity = await api.request('GET', 'account');
				const localApi = this.accountAuthorized && this.secret('access') ? this.api() : api;
				const localIdentity = localApi === api ? managingIdentity : await localApi.request('GET', 'account');
				currentDeviceId = localIdentity.deviceId;
				await this.updateDeviceLabel(localApi, localIdentity);
				if (localIdentity.scope && localIdentity.deviceId) {
					this.ensureCurrent(localApi);
					const vaultUsage = sampleVaultSize(this.app.vault);
					if (vaultUsage) await localApi.request('POST', 'device-presence', { workspace: localApi.workspace, vaultUsage });
				}
				const result = await api.request('GET', `devices?workspace=${api.workspace}`);
				this.ensureCurrent(api);
				entries = result.entries;
			} catch (error) {
				loadError = failureMessage(error);
			} finally {
				render();
			}
		};
		const dialog = new ChoiceWindow(this.app, t('msg_43935c12b5'), (container) => {
			if (!dialog.titleEl) action(container, t('device.refresh'), refresh);
			if (!entries) {
				container.createEl('p', { text: loadError ?? t('device.loading') });
				return;
			}
			const revoked = entries.filter(device => device.revoked);
			const active = entries.some(device => !device.revoked) ? container.createDiv({ cls: 'smart-sync-device-list' }) : undefined;
			const history = revoked.length ? container.createEl('details', { cls: 'smart-sync-device-history' }) : undefined;
			history?.createEl('summary', { text: t('device.revokedHistory', { count: revoked.length }) });
			for (const device of [...entries.filter(item => !item.revoked), ...revoked]) {
				const row = (device.revoked ? history : active).createDiv({ cls: 'smart-sync-device-card' });
				const current = !device.revoked && (device.id === currentDeviceId || (device.accountDevice && device.id === managingIdentity.deviceId));
				const deviceInfo = row.createEl('p', {
					text: t('device.state', {
						label: `${device.label?.trim() || `${t('device.unnamed')} · ${device.id.slice(0, 8)}`}${current ? ` · ${t('device.current')}` : ''}`,
						status: device.revoked
							? t('device.revoked')
							: device.online
								? t('device.online')
								: t('device.offline'),
					}),
				});
				deviceInfo.title = `${device.id}${device.accountDevice ? ` · ${t('notebooks.accountDevice')}` : ''}${device.lastSeen ? ` · ${new Date(device.lastSeen).toLocaleString(locale)}` : ''}`;
				const usage = device.vaultUsage;
				const sizeInfo = row.createEl('p', { text: usage && Number.isSafeInteger(usage.bytes) && usage.bytes >= 0 && Number.isSafeInteger(usage.sampledAt) && usage.sampledAt > 0
					? t('device.vaultUsage', { size: formatStorageSize(usage.bytes), time: new Date(usage.sampledAt).toLocaleString(locale, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) })
					: t('device.vaultUsageUnknown') });
				sizeInfo.title = `${t('device.vaultUsageHelp')}${usage?.sampledAt ? ` · ${new Date(usage.sampledAt).toLocaleString(locale)}` : ''}`;
				if (!device.revoked && (device.accountDevice || device.accountDeviceId)) {
					action(row,t('msg_5faac43bc7'),async()=>{
						formWindow(this.app,t('notebooks.revokeAccountDevice'),[{key:'confirm',label:t('notebooks.revokeConfirm'),description:t('notebooks.revokeHelp')}],async({confirm})=>{
							if(confirm!==t('notebooks.revokeWord'))throw Error('Confirm revocation');
							this.ensureCurrent(api);
							await api.request('POST','devices/revoke',{id:device.accountDeviceId ?? device.id,workspace:api.workspace});
							if (device.id === managingIdentity.deviceId) {await this.signOut();dialog.close();return;}
							await refresh();
						});
					});
				}
				if (!device.revoked && !device.accountDevice) {
					if (!device.accountDeviceId) action(row, t('msg_5faac43bc7'), async () => {
						this.ensureCurrent(api);
						await api.request('POST', 'devices/revoke', {
							id: device.id,
							workspace: api.workspace,
						});
						this.notify(t('msg_3dda76845a'));
						await refresh();
					},
					);
				}
			}
		});
		dialog.onClose = () => { closed = true; dialog.contentEl.empty(); };
		dialog.open();
		if (dialog.titleEl) {
			dialog.titleEl.classList.add('smart-sync-device-header');
			action(dialog.titleEl, t('device.refresh'), refresh);
		}
		dialog.ready = refresh();
		await dialog.ready;
		return dialog;
	}
	async exportRecovery() {
		await this.exclusive(() => this.connection());
		formWindow(
			this.app,
			t('msg_4014ed1760'),
			[
				{
					key: 'password',
					label: t('msg_d8ad61a613'),
					password: true,
				},
			],
			async ({ password }) => {
				const config = {
					origin: this.data.settings.origin,
					workspace: this.data.settings.workspace,
					accessKey: this.secret('access'),
					encryptionPassword: this.secret('encryption'),
					accountAccessKey: this.secret('account'),
					accountEncryptionPassword: JSON.parse(this.secret('crypto')||'null')?.password,
				};
				const encoded = await encryptRecovery(config, password);
				new ChoiceWindow(this.app, t('msg_db6716f3a2'), (container) => {
					new Setting(container).setName(t('msg_e6c1993381')).addTextArea((input) => {
						input.setValue(encoded);
						input.inputEl.readOnly = true;
					});
				}).open();
			},
		);
	}
	async importRecovery() {
		formWindow(
			this.app,
			t('msg_9d3055b1c7'),
			[
				{ key: 'encoded', label: t('msg_db6716f3a2'), multiline: true },
				{ key: 'password', label: t('msg_3e39703b6e'), password: true },
				{
					key: 'replacement',
					label: t('msg_bb170489f7'),
					password: true,
				},
			],
			async ({ encoded, password, replacement }) => {
				const config = await decryptRecovery(encoded, password);
				if (replacement.trim()) config.accessKey = replacement.trim();
				new ChoiceWindow(this.app, t('msg_f833981bdb'), (container) => {
					container.createEl('p', {
						text: t('msg_b9070a5af5', { origin: config.origin, workspace: config.workspace }),
					});
					action(container, t('msg_61b792d4de'), () => this.applyConfiguration(config));
				}).open();
			},
		);
	}
	async attachments() {
		try {
			if (this.running) throw operationBusy();
			const { engine } = await this.exclusive(() => this.connection());
			new ChoiceWindow(this.app, t('msg_a560e43292'), (container) => {
				for (const [id, note] of Object.entries(engine.state.notes))
					if (!note.downloaded && !note.removed)
						action(container, note.path, async () => {
							await this.exclusive(async () => {
								this.ensureCurrent(engine.api);
								const fresh = await this.connection();
								await fresh.engine.download(id);
							});
							this.notify(t('msg_22ab7d735f'), false);
						});
				for (const [id, note] of Object.entries(engine.state.notes))
					if (note.downloaded && !note.removed && !note.path.toLowerCase().endsWith('.md'))
						action(container, t('msg_3b18c9eb76', { path: note.path }), () =>
							this.exclusive(async () => {
								this.ensureCurrent(engine.api);
								const fresh = await this.connection();
								await fresh.engine.evict(id);
								this.notify(t('msg_0bd1ef30b4'));
							}),
						);
			}).open();
		} catch (error) {
			this.notify(['SYNC_BUSY', 'CONFIGURATION_BUSY'].includes(error?.code) ? failureMessage(error) : t('msg_7e74d82a07'));
		}
	}
	async history(before, previousPath) {
		try {
			if (this.running) throw operationBusy();
			const file = previousPath ? { path: previousPath } : this.app.workspace.getActiveFile();
			if (!file) throw new Error('Open a note first');
			const { api, keys, engine, host } = await this.exclusive(() => this.connection());
			const id = Object.entries(engine.state.notes).find(
				([, note]) => !note.removed && note.path === file.path,
			)?.[0];
			if (!id) throw new Error('Synchronize the note before opening history');
			const { entries, more } = await api.versions(id, before);
			const expected =
				before === undefined
					? (entries[0]?.sequence ?? 0)
					: ((await api.versions(id)).entries[0]?.sequence ?? 0);
			new ChoiceWindow(this.app, t('msg_b2a7a26b25', { path: file.path }), (container) => {
				const origin = engine.state.notes[id]?.origin;
				if (origin)
					action(container, t('msg_ec88de41b0', { path: origin.path }), () =>
						this.history(undefined, origin.path),
					);
				container.createEl('p', {
					text: t('msg_5a1a3e56be'),
				});
				for (const revision of entries)
					if (!revision.removed) {
						action(
							container,
							t('msg_fe9a2874be', {
								sequence: revision.sequence,
								value1: new Date(revision.at).toLocaleString(locale),
							}),
							async () => {
								const note = await unpackNote(
									keys,
									api.workspace,
									id,
									revision.manifest,
									(address) => api.load(address),
								);
								new ChoiceWindow(this.app, t('msg_3945c0a1fc'), (area) => {
									area.createEl('pre', {
										cls: 'smart-sync-v2-preview',
										text: file.path.endsWith('.md')
											? new TextDecoder().decode(note.contents.subarray(0, 65536))
											: t('msg_3752702ba1', { length: formatStorageSize(note.contents.length) }),
									});
									action(area, t('msg_13ae10d349'), async () => {
										const local = await host.read(file.path);
										if (local === null) throw new Error('No local bytes at this historical path');
										new ChoiceWindow(this.app, t('msg_1ebda2b56b'), (pane) =>
											pane.createEl('pre', {
												cls: 'smart-sync-v2-preview',
												text: compareText(note.contents, local),
											}),
										).open();
									});
								}).open();
							},
						);
						action(container, t('msg_9cdb16f30a', { sequence: revision.sequence }), async () => {
							const preview = await unpackNote(
								keys,
								api.workspace,
								id,
								revision.manifest,
								(address) => api.load(address),
							);
							new ChoiceWindow(this.app, t('msg_50684eccf5', { path: file.path }), (area) => {
								area.createEl('p', {
									text: t('msg_7628eb97f7', {
										sequence: revision.sequence,
										length: formatStorageSize(preview.contents.length),
									}),
								});
								area.createEl('pre', {
									cls: 'smart-sync-v2-preview',
									text: file.path.toLowerCase().endsWith('.md')
										? new TextDecoder().decode(preview.contents.subarray(0, 65536))
										: t('msg_227ddcef1b'),
								});
								action(area, t('msg_6510744c83'), async () => {
									await this.exclusive(async () => {
										this.ensureCurrent(api);
										await api.restore(id, revision.sequence, expected);
									});
									await this.synchronize();
								});
							}).open();
						});
					}
				if (more)
					action(container, t('msg_11ad78ef61'), () =>
						this.history(entries.at(-1).sequence, previousPath),
					);
			}).open();
		} catch (error) {
			this.notify(['SYNC_BUSY', 'CONFIGURATION_BUSY'].includes(error?.code) ? failureMessage(error) : t('msg_6932212aba'));
		}
	}
	async trash(before) {
		try {
			if (this.running) throw operationBusy();
			const { api, keys } = await this.exclusive(() => this.connection());
			const { entries, more } = await api.trash(before);
			for (let start = 0; start < entries.length; start += 8)
				await Promise.all(
					entries.slice(start, start + 8).map(async (entry) => {
						entry.path = (
							await inspectNote(keys, api.workspace, entry.note, entry.manifest, (address) =>
								api.load(address),
							)
						).path;
					}),
				);
			new ChoiceWindow(this.app, t('msg_e30cf15ed2'), (container) => {
				container.createEl('p', {
					text: t('msg_56ee5a5715'),
				});
				for (const entry of entries)
					if (entry.restorable !== false)
						action(
							container,
							t('msg_8e6eae39cc', {
								path: entry.path,
								value1: new Date(entry.at).toLocaleString(locale),
							}),
							async () => {
								await this.exclusive(async () => {
									this.ensureCurrent(api);
									await api.restore(entry.note, 'latest', entry.sequence);
								});
								await this.synchronize();
							},
						);
				for (const entry of entries)
					if (entry.restorable !== false)
						action(container, t('msg_2874c963f6', { path: entry.path }), async () => {
							formWindow(
								this.app,
								t('msg_623bb7479a'),
								[
									{
										key: 'confirm',
										label: t('msg_16bbcd2494', { note: entry.note }),
									},
								],
								async ({ confirm }) =>
									this.exclusive(async () => {
										this.ensureCurrent(api);
										await api.request('POST', api.scope(`notes/${entry.note}/purge`), {
											confirm,
											expected: entry.sequence,
										});
										this.notify(t('msg_a73ffd521d'));
									}),
							);
						});
				for (const entry of entries)
					if (entry.restorable === false)
						container.createEl('p', {
							text: t('msg_709507d1e0', { path: entry.path }),
						});
				if (more) action(container, t('msg_0874f67492'), () => this.trash(entries.at(-1).sequence));
			}).open();
		} catch (error) {
			this.notify(['SYNC_BUSY', 'CONFIGURATION_BUSY'].includes(error?.code) ? failureMessage(error) : t('msg_a0e29e4ac6'));
		}
	}
	async conflicts() {
		try {
			if (this.running) throw operationBusy();
			const { engine } = await this.exclusive(() => this.connection());
			new ChoiceWindow(this.app, t('msg_462b8ec2ff'), (container) => {
				container.createEl('p', {
					text: t('conflict.count', { count: engine.state.conflicts.length }),
				});
				for (const conflict of engine.state.conflicts) {
					container.createEl('p', {
						text: t('msg_67c5e24f78', { path: conflict.path, copy: conflict.copy }),
					});
					action(container, t('conflict.compare'), async () => {
						this.ensureCurrent(engine.api);
						const { host } = await this.exclusive(() => this.connection());
						const [local, remote] = await Promise.all([
							host.read(conflict.copy),
							host.read(conflict.path),
						]);
						const decode = (bytes) => {
							try {
								if (!bytes || bytes.length > 65536) return null;
								const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
								return text.includes(String.fromCharCode(0)) ? null : text;
							} catch {
								return null;
							}
						};
						const a = decode(local),
							b = decode(remote);
						new ChoiceWindow(this.app, t('conflict.compare'), (area) => {
							if (a === null || b === null) {
								area.createEl('p', { text: t('conflict.binary') });
								return;
							}
							const grid = area.createDiv({ cls: 'smart-sync-conflict-grid' });
							for (const [name, text] of [
								[t('conflict.local'), a],
								[t('conflict.remote'), b],
							]) {
								const column = grid.createDiv();
								column.createEl('h4', { text: name });
								column.createEl('pre', { text, cls: 'smart-sync-v2-preview' });
							}
						}).open();
					});
					for (const [label, choice] of [
						[t('msg_239fdbb5ec'), 'local'],
						[t('msg_9f4fe48396'), 'remote'],
						[t('msg_dff83f1a9e'), 'both'],
					])
						action(container, label, async () => {
							await this.exclusive(async () => {
								this.ensureCurrent(engine.api);
								const fresh = await this.connection();
								await fresh.engine.resolve(conflict.copy, choice);
								this.notify(t('conflict.resolved'));
							});
						});
				}
			}).open();
		} catch (error) {
			this.notify(['SYNC_BUSY', 'CONFIGURATION_BUSY'].includes(error?.code) ? failureMessage(error) : t('msg_bd4ea9288d'));
		}
	}
}
export class IndependentSettings extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.owner = plugin;
	}
	// CHG-20261026-04: older hosts call display(), newer hosts render the same definitions.
	disposeLegacySettings() {
		this.legacyVisible = false;
		for (const cleanup of this.legacyCleanups ?? []) cleanup();
		this.legacyCleanups = [];
	}
	hide() {
		this.disposeLegacySettings();
		super.hide?.();
	}
	update() {
		if (requireApiVersion('1.13.0')) return super.update();
		if (this.legacyVisible) this.renderLegacySettings();
	}
	display() {
		this.renderLegacySettings();
	}
	renderLegacySettings() {
		this.disposeLegacySettings();
		this.containerEl.empty();
		this.legacyVisible = true;
		const render = (definitions, container, group) => {
			for (const definition of definitions) {
				if (definition.type === 'group') {
					const wrapper = container.createDiv({ cls: definition.cls });
					const listEl = wrapper.createDiv();
					render(definition.items, listEl, { listEl });
					continue;
				}
				const setting = new Setting(container).setName(definition.name);
				if (definition.desc !== undefined) setting.setDesc(definition.desc);
				const cleanup = definition.render?.(setting, group);
				if (typeof cleanup === 'function') this.legacyCleanups.push(cleanup);
			}
		};
		try { render(this.getSettingDefinitions(), this.containerEl); }
		catch (error) { this.disposeLegacySettings(); throw error; }
	}
	getSettingDefinitions() {
		const plugin = this.owner,
			config = plugin.data.settings;
		const row = (name, render, desc) => ({ name, desc, render });
		const toggle = (name, key, desc) =>
			row(
				name,
				(setting) =>
					setting.addToggle((input) =>
						input.setValue(config[key] !== false).onChange((value) => plugin.setting(key, value)),
					),
				desc,
			);
		const open = (name, method, desc) =>
			row(
				name,
				(setting) => bindAction(setting, t('msg_c771248e51'), () => plugin[method]()),
				desc,
			);
		const heading = (name) => row(name, (setting) => setting.setHeading());
		const direction = row(t('msg_507c2d5815'), (setting) =>
			setting.addDropdown((input) =>
				input
					.addOptions({
						paused: t('msg_8d12fc0d4e'),
						both: t('msg_3bd92a9264'),
						send: t('msg_5d00b2a3a1'),
						receive: t('msg_8d2013c20f'),
						update: t('msg_c8b249e6e2'),
					})
					.setValue(config.direction)
					.onChange((value) => plugin.setting('direction', value)),
			),
		);
		const basic = [
			row(t('msg_b848f4c702'), (setting) =>
				setting.setHeading().setName('无界同步').setDesc('Smart Sync'),
			),
			row(t('version.title'), (setting) => {
				let disposed = false;
				const current = t('version.value', { version: plugin.manifest.version ?? t('version.unknown') });
				setting.setDesc(current);
				void plugin.checkClientVersion().then(latest => {
					if (!disposed && !plugin.stopped && isNewerClientVersion(latest, plugin.manifest.version))
						setting.setDesc(current + '\n' + t('version.upgrade', { version: latest }));
				});
				return () => { disposed = true; };
			}),
			direction,
			open(t('msg_fd2d01b08e'), 'showSyncPlan', t('msg_d1b456ced0')),
			row(t('msg_36e7a43a1c'), setting => bindManualSyncAction(setting, plugin)),
			open(t('msg_6dc05b92e9'), 'logs'),
			toggle(t('msg_abca78082c'), 'autoChanges'),
			toggle(t('msg_26c7fcb6f0'), 'autoStartup'),
			toggle(t('msg_2c85e193c8'), 'autoTimer'),
			row(t('msg_7f8a1742e1'), (setting) =>
				setting.addText((input) =>
					input.setValue(String(config.interval)).onChange((value) => {
						const n = Number(value);
						if (Number.isInteger(n) && n >= 1 && n <= 86400) return plugin.setting('interval', n);
					}),
				),
			),
			row(t('msg_4b5aba5d20'), (setting) =>
				setting.addDropdown((input) =>
					input
						.addOptions({
							all: t('msg_5c55a67935'),
							important: t('msg_2d52321540'),
							silent: t('msg_b7577eab19'),
						})
						.setValue(config.notifications ?? 'all')
						.onChange((value) => plugin.setting('notifications', value)),
				),
			),
			row(t('msg_8564b2ea7c'), (setting) =>
				setting.setDesc(t('attachment.help')).addDropdown((input) =>
					input
						.addOptions({
							always: t('attachment.always'),
							'on-note-open': t('attachment.onNoteOpen'),
						})
						.setValue(config.attachmentMiB === 0 ? 'on-note-open' : 'always')
						.onChange(async (value) => {
							input.setDisabled(true);
							try { await plugin.setAttachmentDownload(value); }
							catch (error) { plugin.notify(failureMessage(error)); }
							finally {
								input.setValue(plugin.data.settings.attachmentMiB === 0 ? 'on-note-open' : 'always');
								input.setDisabled(false);
								this.update();
							}
						}),
				),
			),
		];
		basic.push(
			row(t('lan.title'), (setting) =>
				setting.setDesc(t('lan.help')).addToggle((input) =>
					input.setValue(config.lanAcceleration !== false).onChange(async (value) => {
						await plugin.setting('lanAcceleration', value);
						if (plugin.lanPeers) {
							plugin.lanPeers.enabled = value;
							if (!value) plugin.lanPeers.drop();
						}
					}),
				),
			),
		);
		basic.push(heading(t('daily.heading')));
		for (const [name, method] of [
			[t('daily.attachments'), 'attachments'],
			[t('daily.history'), 'history'],
			[t('daily.trash'), 'trash'],
			[t('daily.conflicts'), 'conflicts'],
		])
			basic.push(open(name, method));
		const scope = [row(t('scope.explainTitle'), (setting) => setting.setDesc(t('scope.help')))];
		for (const [kind, name, description] of [
			['code', 'configuration.pluginCode', 'configuration.pluginCodeHelp'],
			['data', 'configuration.pluginData', 'configuration.pluginDataHelp'],
			['themes', 'configuration.themes', 'configuration.themesHelp'],
		])
			scope.push(
				row(t(name), (setting) => {
					setting.settingEl?.classList.add('smart-sync-scope-choice');
					bindAction(setting, t('configuration.select'), () => plugin.configurationPicker(kind));
					setting.setDesc(t(description)).addToggle((input) => {
						let reflecting = false;
						input
							.setValue(configurationEnabled(config.configuration, kind))
							.onChange(async (enabled) => {
								if (reflecting) return;
								await plugin.setConfigurationCategory(kind, enabled);
								reflecting = true;
								try {
									input.setValue(configurationEnabled(plugin.data.settings.configuration, kind));
								} finally {
									reflecting = false;
								}
							});
					});
				}),
			);
		scope.push(row(t('configuration.pluginEnabled'), setting => setting
			.setDesc(t('configuration.pluginEnabledHelp'))
			.addToggle(input => input.setValue(config.configuration.pluginEnabled === true)
				.onChange(value => plugin.setting('configuration', current => cleanConfiguration({ ...current, pluginEnabled: value }))))));
		for (const [key, name] of [
			['editor', t('msg_475c4996a5')],
			['appearance', t('msg_94ed88da98')],
			['hotkeys', t('msg_ee2638183d')],
			['bookmarks', t('msg_94b8975ca7')],
		])
			scope.push(
				row(name, (setting) =>
					setting
						.setDesc(t(`configuration.${key}Help`))
						.addToggle((input) =>
							input
								.setValue(config.configuration[key] === true)
								.onChange((value) =>
									plugin.setting(
										'configuration',
										current => cleanConfiguration({ ...current, [key]: value }),
									),
								),
						),
				),
			);
		scope.push(
			row(t('msg_d3a5941068'), (setting) => {
				setting.settingEl?.classList.add('smart-sync-scope-choice');
				bindAction(setting, t('configuration.select'), () => plugin.configurationPicker('core'));
				return setting.setDesc(t('core.explain')).addToggle((input) => {
					let reflecting = false;
					const reflect = (value) => {
						reflecting = true;
						try {
							input.setValue(value);
						} finally {
							reflecting = false;
						}
					};
					input.setValue(config.configuration.coreEnabled === true).onChange((value) => {
						if (reflecting) return;
						if (!value)
							return plugin.setting(
								'configuration',
								current => cleanConfiguration({ ...current, coreEnabled: false }),
							);
						plugin.confirmCoreSync({ setValue: reflect });
					});
				});
			}),
		);
		const advanced = [open(t('exclusions.title'), 'exclusionPicker', t('exclusions.help'))];
		advanced.push(
			row(t('msg_21fee58852'), (setting) =>
				setting.addText((input) =>
					input.setValue(config.excludedExtensions.join(',')).onChange((value) =>
						plugin.setting(
							'excludedExtensions',
							value
								.split(',')
								.map((x) => x.trim().replace(/^\./, ''))
								.filter((x) => /^[a-zA-Z0-9]+$/.test(x)),
						),
					),
				),
			),
		);
		for (const [name, method] of [
			[t('msg_ffc876a129'), 'exportRecovery'],
			[t('msg_332cd0cac0'), 'importRecovery'],
			[t('msg_199bb21681'), 'storageControls'],
			[t('msg_36ce61c3ca'), 'presets'],
			[t('msg_09b029b24d'), 'exportDiagnostics'],
		])
			advanced.push(open(name, method));
		this.expanded ??= new Set();
		const main = new Set(
			[
				'msg_b848f4c702',
				'version.title',
				'msg_d871435514',
				'msg_36e7a43a1c',
				'msg_6dc05b92e9',
			].map((key) => t(key)),
		);
		const daily = new Set(
			['daily.attachments', 'daily.history', 'daily.trash', 'daily.conflicts'].map((key) => t(key)),
		);
		const fold = (title, description, items) => ({
			type: 'group',
			name: title,
			cls: 'smart-sync-setting-group',
			items: [
				{
					name: title,
					render: (setting, group) => {
						setting.setHeading().setDesc(description);
						if (!group?.listEl || !setting.settingEl) return;
						setting.settingEl.classList.add('smart-sync-fold-sentinel');
						const list = group.listEl;
						list.classList.add('smart-sync-section-body');
						let section = list.parentElement;
						if (!section.matches('details.smart-sync-section')) {
							section = list.parentElement.createEl('details', { cls: 'smart-sync-section' });
							list.parentElement.insertBefore(section, list);
							const summary = section.createEl('summary');
							const copy = summary.createSpan({ cls: 'smart-sync-summary-copy' });
							copy.createSpan({ cls: 'smart-sync-section-title', text: title });
							copy.createSpan({ cls: 'smart-sync-section-description', text: description });
							section.appendChild(list);
						}
						section.open = this.expanded.has(title);
						const changed = () => {
							if (section.open) this.expanded.add(title);
							else this.expanded.delete(title);
						};
						section.addEventListener('toggle', changed);
						const focus = () => {
							section.open = true;
						};
						list.addEventListener('focusin', focus);
						return () => {
							section.removeEventListener('toggle', changed);
							list.removeEventListener('focusin', focus);
						};
					},
				},
				...items,
			],
		});
		const actions = new Set(
			['msg_d871435514', 'msg_fd2d01b08e', 'msg_36e7a43a1c', 'msg_6dc05b92e9'].map((key) => t(key)),
		);
		const present = (definition) => ({
			...definition,
			render: (setting, group) => {
				const cleanup = definition.render?.(setting);
				const element = setting.settingEl;
				if (!element) return cleanup;
				this.containerEl.classList.add('smart-sync-settings-page');
				(group?.listEl ?? element.parentElement).classList.add('smart-sync-common');
				if ([t('version.title'), t('msg_b848f4c702'), '我的套餐'].includes(definition.name))
					(group?.listEl ?? element.parentElement).classList.add('smart-sync-layout-root');
				if (definition.name === t('version.title')) element.classList.add('smart-sync-version');
				if (definition.name === t('msg_b848f4c702')) element.classList.add('smart-sync-title');
				if (definition.name === t('sections.status') || actions.has(definition.name)) {
					if (actions.has(definition.name)) {
						element.classList.add('smart-sync-overview-action');
						const button = element.querySelector('button');
						if (button) {
							button.setText(definition.name);
							if (definition.name === t('msg_36e7a43a1c')) button.classList.add('mod-cta');
						}
					} else {
						element.classList.add('smart-sync-overview-status');
					}
				}
				return cleanup;
			},
		});
		const overviewItem = definition => {
			const decorated = present(definition);
			return { ...decorated, render: (setting, group) => {
				const cleanup = decorated.render(setting, group);
				(group?.listEl ?? setting.settingEl?.parentElement)?.classList.add('smart-sync-overview-card');
				return cleanup;
			} };
		};
		const connected = Boolean(config.workspace);
		const identityScope = () =>
			`${plugin.data.settings.origin}|${plugin.data.settings.workspace}|${plugin.data.localId}`;
		const scopeKey = identityScope();
		const accountConnected = connected || plugin.accountAuthorized === true;
		const status = row(t('sections.status'), (setting) => {
			let disposed = false;
			let phase = plugin.overviewStatusText ?? plugin.status.textContent ?? plugin.status.text ?? t('sections.disconnected');
			let server = t('overview.spaceUnknown'), local = t('overview.spaceUnknown'), sizeLoading = false, lastDescription;
			const descriptionEl = setting.descEl ?? setting.settingEl?.querySelector('.setting-item-description');
			const phaseEl = descriptionEl?.createSpan({ cls: 'smart-sync-status-phase' });
			const spaceEl = descriptionEl?.createSpan({ cls: 'smart-sync-status-storage' });
			const update = (text) => {
				phase = text;
				const description = connected ? t('overview.statusSpace', { state: phase, server, local }) : phase;
				if (description !== lastDescription) {
					if (phaseEl && spaceEl) {
						phaseEl.setText(phase);
						phaseEl.classList.toggle('is-synced', phase === t('overview.synced'));
						spaceEl.setText(connected ? t('overview.compactSpace', { server, local }) : '');
					} else setting.setDesc(description);
					lastDescription = description;
				}
			};
			const refreshSizes = async () => {
				if (disposed || sizeLoading || !connected || identityScope() !== scopeKey) return;
				sizeLoading = true;
				local = formatStorageSize(plugin.app.vault.getFiles().reduce((sum, file) => sum + (Number.isFinite(file.stat?.size) ? file.stat.size : 0), 0));
				try {
					const api = plugin.api();
					const usage = await api.request('GET', api.scope('usage?summary=1'));
					if (disposed || identityScope() !== scopeKey) return;
					server = Number.isSafeInteger(usage.logicalBytes) && usage.logicalBytes >= 0 ? formatStorageSize(usage.logicalBytes) : t('overview.spaceUnknown');
				} catch { /* Keep the last successful space sample during an outage. */ }
				finally { sizeLoading = false; }
				if (!disposed && identityScope() === scopeKey) update(phase);
			};
			let accountLoading = false;
			const refreshAccount = async () => {
				if (!accountConnected || accountLoading || disposed || identityScope() !== scopeKey) return;
				accountLoading = true;
				try {
					const api = connected ? plugin.api() : plugin.workspaceApi(config.origin,plugin.secret('account'));
					const credential = plugin.secret(connected ? 'access' : 'account');
					const current = () => !disposed && identityScope() === scopeKey && credential === plugin.secret(connected ? 'access' : 'account');
					const publish = fields => {
						if (!current()) return;
						plugin.overviewIdentity = { ...(plugin.overviewIdentity?.scope === scopeKey ? plugin.overviewIdentity : {}), scope: scopeKey, ...fields };
						for (const listener of plugin.statusListeners ?? [])
							listener(plugin.overviewStatusText ?? plugin.status.textContent ?? plugin.status.text ?? t('sections.disconnected'));
					};
					await Promise.all([
						api.request('GET', 'account').then(account => {
							if (!current()) return;
							const email = typeof account.email === 'string' ? account.email.trim() : '';
							plugin.accountEmail = email;
							publish({ email });
						}).catch(() => {}),
						connected ? api.info().then(notebook => publish({ label: typeof notebook.label === 'string' ? notebook.label : '' })).catch(() => {}) : Promise.resolve(),
					]);
				} catch {
					/* An unavailable account must not block settings or expose raw errors. */
				} finally { accountLoading = false; }
			};
			void refreshAccount();
			update(phase);
			void refreshSizes();
			const sizeTimer = window.setInterval(() => {
				void refreshSizes();
				if (!plugin.overviewIdentity?.email || (connected && !plugin.overviewIdentity?.label)) void refreshAccount();
			}, 30000);
			plugin.registerInterval(sizeTimer);
			plugin.statusListeners ??= new Set();
			plugin.statusListeners.add(update);
			return () => {
				disposed = true;
				window.clearInterval(sizeTimer);
				plugin.statusListeners.delete(update);
			};
		});
		const identityRow = (name, field, fallback, buttons) =>
			row(
				t(name),
				(setting) => {
					let fullValue;
					const info = setting.settingEl?.querySelector('.setting-item-info');
					const update = () => {
						const identity = plugin.overviewIdentity;
						fullValue = !plugin.data.settings.workspace
								? (name === 'overview.account' && plugin.secret('account') ? (plugin.accountEmail || t('notebooks.accountSignedIn')) : t(name === 'overview.account' ? 'overview.signedOut' : 'sync.notConnected'))
								: identityScope() === scopeKey && identity?.scope === scopeKey && identity[field]
									? identity[field]
									: t(fallback);
						setting.setDesc(fullValue);
						if (info) info.title = fullValue;
					};
					update();
					for (const [label, method, argument] of buttons)
						bindAction(setting, t(label), () => plugin[method](argument));
					setting.settingEl?.classList.add('smart-sync-identity-row', field === 'label' ? 'smart-sync-library-row' : 'smart-sync-account-row');
					plugin.statusListeners ??= new Set();
					plugin.statusListeners.add(update);
					return () => plugin.statusListeners.delete(update);
				},
				t(name === 'overview.account' ? 'overview.accountSearch' : 'overview.notebookSearch'),
			);
		const account = identityRow(
			'overview.account',
			'email',
			accountConnected ? 'overview.emailUnavailable' : 'overview.signedOut',
			accountConnected
				? [['msg_cd2d74373d', 'signOut']]
				: [
						['overview.login', 'enrollment'],
						...(edition.edition === 'cn' ? [] : [['overview.apply', 'requestAccess']]),
					],
		);
		const notebook = identityRow('overview.notebook', 'label', 'overview.notebookUnavailable', [
			['overview.manageNotebooks', 'manageNotebooks'],
		]);
		const lan = row(t('lan.statusTitle'), setting => {
			let timer, disposed = false;
			setting.settingEl?.classList.add('smart-sync-lan-status');
			for (const previous of setting.settingEl?.querySelectorAll('.smart-sync-lan-details') ?? []) previous.remove();
			const details = setting.settingEl?.createEl('details', { cls: 'smart-sync-lan-details' });
			const summary = details?.createEl('summary');
			summary?.createSpan({ cls: 'smart-sync-lan-title', text: t('lan.statusTitle') });
			const connectionState = summary?.createSpan({ cls: 'smart-sync-lan-state' });
			summary?.createSpan({ cls: 'smart-sync-lan-entry', text: t('lan.details') });
			if (details) {
				details.open = this.expanded.has('lan.details');
				details.addEventListener('toggle', () => {
					if (disposed) return;
					if (details.open) this.expanded.add('lan.details');
					else this.expanded.delete('lan.details');
				});
			}
			const metrics = details?.createEl('p');
			details?.createEl('p', { text: t('lan.fallbackHelp') });
			const update = () => {
				if (disposed || plugin.stopped || identityScope() !== scopeKey) { window.clearInterval(timer); return; }
				setting.setDesc(plugin.lanSummary());
				connectionState?.setText(plugin.lanSummary());
				metrics?.setText(plugin.lanSummary(true));
			};
			update(); timer = window.setInterval(update, 1000); plugin.registerInterval(timer);
			return () => {
				disposed = true; window.clearInterval(timer);
				if (details?.open) this.expanded.add('lan.details');
				else this.expanded.delete('lan.details');
				details?.remove();
			};
		});
		const billing = edition.edition === 'cn' ? row('我的套餐', setting => {
			const credential = plugin.secret('account') || plugin.secret('access');
			return mountBillingCard(setting, {
				connected: accountConnected, load: () => plugin.billingSummary(), open: orderId => plugin.openBilling(orderId),
				live: () => !plugin.stopped && identityScope() === scopeKey && credential === (plugin.secret('account') || plugin.secret('access')),
				onError: error => plugin.notify(failureMessage(error)),
			});
		}) : undefined;
		const devices = row(
			t('overview.devices'),
			(setting) => {
				setting.setDesc(t(connected ? 'overview.approveHelp' : 'overview.pairHelp'));
				setting.settingEl?.classList.add('smart-sync-devices-row');
				// Native settings refreshes can reuse the row and leave custom children.
				for (const previous of setting.settingEl?.querySelectorAll('.smart-sync-pair-help') ?? []) previous.remove();
				const help = setting.settingEl?.createEl('p', { cls: 'smart-sync-pair-help', text: t(connected ? 'overview.pairHint' : 'overview.pairHelp') });
				if (connected) {
					bindAction(setting, t('overview.deviceManagement'), () => plugin.devices());
					bindAction(setting, t('overview.addDevice'), () => plugin.addDevice());
				} else bindAction(setting, t('overview.pair'), () => plugin.pairThisDevice());
				setting.settingEl?.classList.add('smart-sync-identity-row');
				return () => help?.remove();
			},
			t('overview.deviceSearch'),
		);
		const pick = (items, keys) =>
			items.filter((item) => keys.map((key) => t(key)).includes(item.name));
		const scopeExtras = pick(advanced, ['exclusions.title', 'msg_21fee58852']);
		const recovery = pick(advanced, ['msg_ffc876a129', 'msg_332cd0cac0', 'msg_199bb21681']);
		const advancedItems = [...pick(basic, ['msg_fd2d01b08e']), ...pick(advanced, ['msg_36ce61c3ca', 'msg_09b029b24d'])];
		const common = basic.filter((item) => main.has(item.name));
		const header = pick(common, ['msg_b848f4c702', 'version.title']);
		const levelNames = { '2': t('sorting.level2'), '3': t('sorting.level3'), '4': t('sorting.level4'), other: t('sorting.deeper') };
		const sortingRuleRows = (options, level = 'root') => {
			const label = name => level === 'root' ? name : `${levelNames[level]}：${name}`;
			const save = async (key, value) => {
				try { await plugin.setExplorerSorting(key, value, level); }
				catch { plugin.notify(t('sorting.saveFailed')); this.update(); }
				if (key === 'grouping') this.update();
			};
			return [
				...['grouping', 'primary', 'secondary', ...(options.grouping === 'mixed' ? [] : ['folderPrimary', 'folderSecondary'])].map(key => {
					const name = options.grouping !== 'mixed' && ['primary', 'secondary'].includes(key) ? key === 'primary' ? 'filePrimary' : 'fileSecondary' : key;
					return row(label(t(`sorting.${name}`)), setting => {
						const values = key === 'grouping' ? ['folders-first', 'files-first', 'mixed'] : [
							...(['secondary', 'folderSecondary'].includes(key) ? ['none'] : []), 'name-asc', 'name-desc', 'ctime-asc', 'ctime-desc', 'mtime-asc', 'mtime-desc',
						];
						setting.addDropdown(input => input.addOptions(Object.fromEntries(values.map(value => [value, t(`sorting.${value}`)])))
							.setValue(options[key]).onChange(value => save(key, value)));
					});
				}),
			];
		};
		const sorting = cleanExplorerSorting(config.explorerSorting);
		const levelRows = ['2', '3', '4', 'other'].flatMap(level => {
			const inherited = sorting.levels?.[level]?.inherit !== false;
			return [row(levelNames[level], setting => setting.setDesc(t(level === 'other' ? 'sorting.deeperHelp' : 'sorting.inheritHelp'))
				.addDropdown(input => input.addOptions({ inherit: t('sorting.inherit'), custom: t('sorting.custom') }).setValue(inherited ? 'inherit' : 'custom')
					.onChange(async value => {
						try { await plugin.setExplorerSorting('inherit', value === 'inherit', level); } catch { plugin.notify(t('sorting.saveFailed')); }
						this.update();
					}))),
				...(inherited ? [] : sortingRuleRows(explorerSortingAtDepth(sorting, level === 'other' ? 5 : Number(level)), level)),
			];
		});
		return [
			...header.map(present),
			{ type: 'group', name: t('overview.card'), cls: 'smart-sync-overview-group', items: [
				...(accountConnected ? [overviewItem(notebook)] : []),
				overviewItem(account), overviewItem(devices), overviewItem(status),
				...common.filter(item => !header.includes(item)).map(overviewItem),
				overviewItem(lan),
			] },
			...(billing ? [present(billing)] : []),
			fold(t('overview.moreAccount'), t('overview.moreAccountHelp'), [
				open(t('msg_87e1f4cf91'), 'eraseAccount'),
			]),
			fold(t('layout.preferences'), t('layout.preferencesHelp'), [
				...basic.filter(
					(item) =>
						!main.has(item.name) && !daily.has(item.name) && item.name !== t('daily.heading') && item.name !== t('msg_fd2d01b08e'),
				),
				...pick(basic, ['daily.attachments']),
				...pick(advanced, ['msg_aaadf021ad']),
			]),
			fold(t('layout.scope'), t('layout.scopeHelp'), [
				...scope.sort((a, b) => {
					const order = [
						'scope.explainTitle',
						'msg_d3a5941068',
						'configuration.pluginCode',
						'configuration.pluginEnabled',
						'configuration.pluginData',
						'msg_475c4996a5',
						'msg_94ed88da98',
						'configuration.themes',
						'msg_ee2638183d',
						'msg_94b8975ca7',
					].map((key) => t(key));
					return order.indexOf(a.name) - order.indexOf(b.name);
				}),
				...scopeExtras,
			]),
			fold(t('sorting.title'), t('sorting.help'), [
				row(t('sorting.enabled'), setting => setting
					.setDesc(t(config.explorerSorting?.enabled && plugin.explorerSortViews?.size === 0 ? 'sorting.unavailable' : 'sorting.enabledHelp'))
					.addToggle(input => input.setValue(config.explorerSorting?.enabled === true).onChange(async value => {
						try { await plugin.setExplorerSorting('enabled', value); } catch { plugin.notify(t('sorting.saveFailed')); }
						this.update();
					}))),
				heading(t('sorting.root')),
				...sortingRuleRows(explorerSortingAtDepth(sorting, 1)),
				...levelRows,
				row(t('sorting.folderDates'), setting => setting.setDesc(t('sorting.folderDatesHelp'))),
			]),
			fold(t('layout.recovery'), t('layout.recoveryHelp'), [
				...recovery,
				...basic.filter((item) => daily.has(item.name) && item.name !== t('daily.attachments')),
			]),
			fold(t('layout.advanced'), t('layout.advancedHelp'), [
				...['recentEnabled', 'noteSearchEnabled'].map(key => row(t(`notes.${key}`), setting => setting
					.setDesc(t(`notes.${key}Help`))
					.addToggle(input => input.setValue(config[key] !== false).onChange(async value => {
						try { await plugin.setting(key, value); }
						catch { plugin.notify(t('notes.saveFailed')); this.update(); }
					})))),
				...(!Platform.isMobile ? [row(t('tray.enabled'), setting => setting
					.setDesc(t('tray.help'))
					.addToggle(input => input.setValue(config.backgroundTray !== false).onChange(async value => {
						try { await plugin.setting('backgroundTray', value); }
						catch { plugin.notify(t('notes.saveFailed')); this.update(); }
					})))] : []),
				...advancedItems,
			]),
		];
	}
}

import { ItemView, Notice, Platform } from 'obsidian';
import { searchableText } from './note-crypto.js';

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const CACHE_BYTES = 24 * 1024 * 1024;
const PAGE_SIZE = 40;
const yieldToHost = () => new Promise(resolve => window.setTimeout(resolve, 0));
const literal = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function searchTerms(query) {
	return [...query.matchAll(/"([^"]+)"|([^\s"]+)/gu)].map(match => match[1] ?? match[2]).slice(0, 32);
}

export function searchHits(text, terms, limit = 80) {
	if (!terms.length) return [];
	const pattern = new RegExp(terms.slice().sort((a, b) => b.length - a.length).map(literal).join('|'), 'giu');
	const hits = [];
	for (const match of text.matchAll(pattern)) {
		hits.push({ start: match.index, end: match.index + match[0].length });
		if (hits.length >= limit) break;
	}
	return hits;
}

function inSearchScope(note, filters) {
	const folder = filters.folder?.replace(/\/$/u, '') ?? '';
	return !(folder && !(filters.recursive === false ? note.folder === folder : note.path.startsWith(folder + '/')))
		&& !(filters.tags?.length && !filters.tags.every(tag => note.tags.includes(tag.replace(/^#/u, ''))))
		&& !(filters.from && note.mtime < filters.from || filters.to && note.mtime > filters.to);
}
function prepareMatch(query, filters) {
	const terms = searchTerms(query), patterns = terms.map(term => new RegExp(literal(term), 'iu'));
	return note => {
		if (!terms.length || !inSearchScope(note, filters)) return undefined;
		const titleMatches = patterns.every(pattern => pattern.test(note.title));
		const target = filters.location === 'title' ? note.title : filters.location === 'body' ? note.body : note.title + '\n' + note.body;
		if (!patterns.every(pattern => pattern.test(target))) return undefined;
		return { ...note, rank: note.title.toLowerCase() === terms.join(' ').toLowerCase() ? 0 : titleMatches ? 1 : 2,
			hits: filters.location === 'title' ? [] : searchHits(note.body, terms) };
	};
}
export function matchNote(note, query, filters = {}) { return prepareMatch(query, filters)(note); }
function sortSearchResults(results, filters) {
	return results.sort((a, b) => (filters.sort === 'title' ? a.title.localeCompare(b.title, 'zh-CN', { numeric: true })
		: filters.sort === 'modified' ? b.mtime - a.mtime : a.rank - b.rank || b.mtime - a.mtime) || a.path.localeCompare(b.path));
}

// Read-only, device-local cache. Never serialize note text, queries or results into plugin data.
export class NoteSearchIndex {
	constructor(app, readTime = file => file.stat.mtime) {
		this.app = app;
		this.readTime = readTime;
		this.cache = new Map();
		this.bytes = 0;
		this.revision = 0;
	}
	clear() { this.cache.clear(); this.bytes = 0; this.revision++; }
	invalidate(file, oldPath) {
		this.revision++;
		for (const path of [file?.path, oldPath].filter(Boolean)) for (const [cachedPath, entry] of this.cache)
			if (cachedPath === path || cachedPath.startsWith(path + '/')) { this.bytes -= entry.body.length * 2; this.cache.delete(cachedPath); }
	}
	async search(query, filters = {}, cancelled = () => false, progress = () => {}) {
		const files = this.app.vault.getMarkdownFiles();
		const revision = this.revision, results = [], match = prepareMatch(query, filters);
		let skipped = 0, failed = 0, processed = 0, cursor = 0, reported = 0, lastReport = 0;
		const stale = () => cancelled() || revision !== this.revision;
		const report = () => {
			if (stale()) return;
			const now = Date.now();
			if (processed === files.length || !reported || now - lastReport >= 150) {
				progress(processed, files.length, { results: sortSearchResults([...results], filters).slice(0, PAGE_SIZE), matches: results.length });
				reported++; lastReport = now;
			}
		};
		const worker = async () => {
			while (!stale() && cursor < files.length) {
				const file = files[cursor++];
				try {
					const metadata = this.app.metadataCache.getFileCache(file);
					const frontTags = metadata?.frontmatter?.tags;
					const tags = [...(metadata?.tags ?? []).map(tag => tag.tag), ...(Array.isArray(frontTags) ? frontTags : typeof frontTags === 'string' ? frontTags.split(/[,\s]+/u) : [])]
						.filter(tag => typeof tag === 'string').map(tag => tag.replace(/^#/u, ''));
					const note = { path: file.path, title: file.basename, folder: file.parent?.path === '/' ? '' : file.parent?.path ?? '',
						body: '', mtime: Math.max(this.readTime(file) ?? file.stat.mtime, file.stat.mtime), tags };
					if (inSearchScope(note, filters)) {
						if (filters.location !== 'title') {
							if (file.stat.size > MAX_FILE_BYTES) { skipped++; }
							else {
								const stamp = `${file.stat.mtime}:${file.stat.ctime}:${file.stat.size}`;
								let cached = this.cache.get(file.path);
								if (cached?.stamp !== stamp) {
									if (cached) { this.bytes -= cached.body.length * 2; this.cache.delete(file.path); }
									const body = await this.app.vault.cachedRead(file);
									if (stale()) return;
									cached = { stamp, body: searchableText(body) };
									if (this.bytes + cached.body.length * 2 <= CACHE_BYTES) { this.cache.set(file.path, cached); this.bytes += cached.body.length * 2; }
								}
								note.body = cached.body;
							}
						}
						if (filters.location === 'title' || file.stat.size <= MAX_FILE_BYTES) {
							const result = match(note);
							if (result) results.push(result);
						}
					}
				} catch { failed++; }
				processed++; report();
				if (processed % 20 === 0) await yieldToHost();
			}
		};
		await Promise.all(Array.from({ length: Math.min(4, files.length) }, worker));
		if (stale()) return undefined;
		return { results: sortSearchResults(results, filters), total: files.length, skipped, failed };
	}

}

export class RecentFiles {
	constructor(app, key) {
		this.app = app;
		this.key = key;
		const saved = app.loadLocalStorage?.(key);
		this.paths = [...new Set((Array.isArray(saved) ? saved : app.workspace.getLastOpenFiles?.() ?? [])
			.filter(path => typeof path === 'string' && app.vault.getFileByPath(path)))].slice(0, 20);
	}
	opened(file) {
		if (!file || !this.app.vault.getFileByPath(file.path)) return;
		this.paths = [file.path, ...this.paths.filter(path => path !== file.path)].slice(0, 20);
		this.save();
	}
	renamed(file, oldPath) {
		this.paths = [...new Set(this.paths.map(path => path === oldPath ? file.path
			: path.startsWith(oldPath + '/') ? file.path + path.slice(oldPath.length) : path))];
		this.save();
	}
	deleted(file) {
		this.paths = this.paths.filter(path => path !== file.path && !path.startsWith(file.path + '/'));
		this.save();
	}
	save() { this.app.saveLocalStorage?.(this.key, this.paths); }
	files() { return this.paths.map(path => this.app.vault.getFileByPath(path)).filter(Boolean); }
}

export function registerNoteSearch(owner) {
	const viewType = owner.manifest.id + '-note-search';
	const recentType = owner.manifest.id + '-recent-files';
	owner.noteSearchViews = new Set();
	owner.recentFiles = new RecentFiles(owner.app, owner.manifest.id + ':recent-files');
	const enabled = recent => owner.data?.settings?.[recent ? 'recentEnabled' : 'noteSearchEnabled'] !== false;
	const refreshRecent = () => { for (const view of owner.noteSearchViews) view.renderRecent(); };
	owner.registerEvent(owner.app.workspace.on?.('file-open', file => { if (enabled(true)) owner.recentFiles.opened(file); refreshRecent(); }));
	owner.registerEvent(owner.app.vault.on('rename', (file, oldPath) => { owner.recentFiles.renamed(file, oldPath); refreshRecent(); }));
	owner.registerEvent(owner.app.vault.on('delete', file => { owner.recentFiles.deleted(file); refreshRecent(); }));
	owner.registerView(viewType, leaf => new NoteSearchView(leaf, owner, viewType));
	owner.registerView(recentType, leaf => new NoteSearchView(leaf, owner, recentType, true));
	const openView = async (type, focus) => {
		if (!enabled(type === recentType)) return;
		const leaf = owner.app.workspace.getLeavesOfType(type)[0] ?? owner.app.workspace.getLeftLeaf(false);
		if (!leaf) return;
		await leaf.setViewState({ type, active: true });
		await owner.app.workspace.revealLeaf(leaf);
		if (focus) leaf.view.focusSearch();
	};
	owner.openRecentFiles = () => openView(recentType, false);
	owner.openNoteSearch = () => openView(viewType, true);
	let layoutReady = false, disposed = false;
	owner.register?.(() => { disposed = true; });
	const opening = new Map();
	const ensureDefaultView = type => {
		if (disposed || owner.app.workspace.getLeavesOfType(type).length) return;
		if (opening.has(type)) return opening.get(type);
		const leaf = owner.app.workspace.getLeftLeaf(false);
		if (!leaf) return;
		const task = leaf.setViewState({ type, active: false }).then(() => {
			if (disposed || !enabled(type === recentType)) leaf.detach();
		}).finally(() => opening.delete(type));
		opening.set(type, task);
		return task;
	};
	let searchCommand = false, recentCommand = false;
	owner.refreshNoteTools = async () => {
		const closing = [];
		for (const [recent, type] of [[true, recentType], [false, viewType]]) {
			if (enabled(recent)) {
				if (layoutReady) await ensureDefaultView(type);
			} else {
				for (const leaf of owner.app.workspace.getLeavesOfType?.(type) ?? []) closing.push(leaf.detach());
			}
		}
		if (enabled(true) && !recentCommand) {
			owner.addCommand({ id: 'recent-files', name: '最近打开的文件', callback: () => { void owner.openRecentFiles(); } });
			recentCommand = true;
		} else if (!enabled(true) && recentCommand) {
			owner.removeCommand('recent-files'); recentCommand = false;
		}
		if (enabled(false) && !searchCommand) {
			owner.addCommand({ id: 'search-notes', name: '搜索笔记', callback: () => { void owner.openNoteSearch(); } });
			searchCommand = true;
		} else if (!enabled(false) && searchCommand) {
			owner.removeCommand('search-notes'); searchCommand = false;
		}
		await Promise.all(closing);
	};
	void owner.refreshNoteTools();
	owner.app.workspace.onLayoutReady?.(() => {
		layoutReady = true;
		if (!disposed) void owner.refreshNoteTools().catch(() => new Notice('最近和搜索侧栏暂时无法打开，请通过命令面板重试。'));
	});
}

export class NoteSearchView extends ItemView {
	constructor(leaf, owner, viewType, recent = false) {
		super(leaf);
		this.owner = owner;
		this.viewType = viewType;
		this.recentMode = recent;
		this.query = '';
		this.filters = {};
		this.generation = 0;
		this.index = new NoteSearchIndex(owner.app, file => owner.updatedNoteTime(file));
	}
	getViewType() { return this.viewType; }
	getDisplayText() { return this.recentMode ? '最近' : '搜索笔记'; }
	getIcon() { return this.recentMode ? 'history' : 'file-search-2'; }
	focusSearch() { this.input?.focus(); }
	async onOpen() {
		this.closed = false;
		this.owner.noteSearchViews.add(this);
		const root = this.contentEl;
		root.empty(); root.addClass('wujie-note-search');
		if (this.recentMode) {
			this.recentArea = root.createDiv({ cls: 'wujie-recent-files' });
			this.renderRecent();
			return;
		}
		const area = root;
		this.input = area.createEl('input', { type: 'search', placeholder: '输入关键词…', attr: { 'aria-label': '搜索笔记', maxlength: '512' } });
		this.input.value = this.query;
		this.input.addEventListener('compositionstart', () => { this.composing = true; this.generation++; window.clearTimeout(this.timer); });
		this.input.addEventListener('compositionend', () => { this.composing = false; this.query = this.input.value; this.schedule(); });
		this.input.addEventListener('input', () => { this.query = this.input.value; if (!this.composing) this.schedule(); });
		area.createDiv({ cls: 'wujie-search-scope', text: '仅搜索本机已有的 Markdown 笔记' });
		const toolbar = area.createDiv({ cls: 'wujie-search-toolbar' });
		const details = toolbar.createEl('details');
		details.createEl('summary', { text: '筛选' });
		const form = details.createDiv({ cls: 'wujie-search-filters' });
		this.select(form, '搜索位置', { '': '标题和正文', title: '仅标题', body: '仅正文' }, 'location');
		this.text(form, '目录', 'folder', '例如：工作/项目A');
		const recursive = form.createEl('label', { text: '包含子目录 ' });
		const checkbox = recursive.createEl('input', { type: 'checkbox' }); checkbox.checked = this.filters.recursive !== false;
		checkbox.addEventListener('change', () => { this.filters.recursive = checkbox.checked; this.schedule(); });
		this.text(form, '标签', 'tagText', '多个标签用空格分隔');
		this.select(form, '修改时间', { '': '不限', week: '最近7天', month: '最近30天', custom: '自定义' }, 'period');
		const dates = form.createDiv({ cls: 'wujie-search-dates' });
		this.text(dates, '开始日期', 'startDate', '', 'date'); this.text(dates, '结束日期', 'endDate', '', 'date');
		this.dateArea = dates; dates.hidden = this.filters.period !== 'custom';
		this.select(toolbar, '排序', { '': '相关程度', modified: '最近修改', title: '标题名称' }, 'sort');
		this.chips = area.createDiv({ cls: 'wujie-search-chips' });
		this.status = area.createDiv({ cls: 'wujie-search-status', attr: { role: 'status', 'aria-live': 'polite' } });
		this.resultsEl = area.createDiv({ cls: 'wujie-search-results' });
		this.schedule(0);
	}
	renderRecent() {
		if (!this.recentArea) return;
		this.recentArea.empty();
		this.recentArea.createDiv({ cls: 'wujie-search-scope', text: '最近打开的20个文件' });
		const files = this.owner.recentFiles.files();
		if (!files.length) this.recentArea.createDiv({ text: '还没有最近打开的文件。' });
		for (const file of files) {
			const row = this.recentArea.createDiv({ cls: 'wujie-search-result' });
			row.createEl('button', { cls: 'wujie-search-title', text: (file.name ?? file.path.split('/').pop()).replace(/\.md$/iu, ''),
				attr: { title: file.path } }).addEventListener('click', () => { void this.openResult({ path: file.path }); });
		}
	}
	select(area, label, options, key) {
		const row = area.createEl('label', { text: label + ' ' });
		const input = row.createEl('select', { attr: { 'aria-label': label } });
		for (const [value, text] of Object.entries(options)) input.createEl('option', { value, text });
		input.value = this.filters[key] ?? '';
		input.addEventListener('change', () => { this.filters[key] = input.value; if (this.dateArea) this.dateArea.hidden = this.filters.period !== 'custom'; this.schedule(); });
	}
	text(area, label, key, placeholder, type = 'text') {
		const row = area.createEl('label', { text: label + ' ' });
		const input = row.createEl('input', { type, placeholder, attr: { 'aria-label': label } }); input.value = this.filters[key] ?? '';
		input.addEventListener('input', () => { this.filters[key] = input.value; this.schedule(); });
	}
	schedule(delay = 220) {
		if (this.recentMode) return;
		this.generation++; window.clearTimeout(this.timer);
		if (this.closed) return;
		this.timer = window.setTimeout(() => { void this.run(); }, delay);
	}
	invalidate(file, oldPath) {
		if (this.recentMode) { this.renderRecent(); return; }
		this.index.invalidate(file, oldPath); this.schedule();
	}
	async run() {
		const generation = this.generation;
		this.resultsEl.empty(); this.chips.empty();
		const active = Object.entries(this.filters).filter(([key, value]) => value && !['sort', 'recursive', 'startDate', 'endDate'].includes(key));
		const labels = { location: '位置', folder: '目录', tagText: '标签', period: '时间' };
		const names = { title: '仅标题', body: '仅正文', week: '最近7天', month: '最近30天', custom: '自定义' };
		for (const [key, value] of active) {
			const chip = this.chips.createEl('button', { text: `${labels[key]}：${names[value] ?? value} ×` });
			chip.addEventListener('click', () => { delete this.filters[key]; void this.onOpen(); });
		}
		if (active.length) this.chips.createEl('button', { text: '清除筛选' }).addEventListener('click', () => { this.filters = { sort: this.filters.sort }; void this.onOpen(); });
		if (!searchTerms(this.query).length) { this.status.setText('输入关键词，搜索标题和正文。空格表示同时包含，双引号表示完整短语。'); return; }
		const filters = { ...this.filters, tags: (this.filters.tagText ?? '').split(/\s+/u).filter(Boolean) };
		if (filters.period === 'week' || filters.period === 'month') filters.from = Date.now() - (filters.period === 'week' ? 7 : 30) * 86400000;
		if (filters.period === 'custom') {
			filters.from = filters.startDate ? new Date(filters.startDate + 'T00:00:00').getTime() : undefined;
			filters.to = filters.endDate ? new Date(filters.endDate + 'T23:59:59.999').getTime() : undefined;
			if (filters.from > filters.to) { this.status.setText('开始日期不能晚于结束日期。'); return; }
		}
		this.status.setText('正在搜索…');
		const cancelled = () => this.closed || generation !== this.generation;
		try {
			let previewKey;
			const response = await this.index.search(this.query, filters, cancelled, (done, total, partial) => {
				if (cancelled()) return;
				this.status.setText(`已找到 ${partial.matches} 篇 · 搜索中 ${done}/${total}`);
				const key = JSON.stringify(partial.results.map(result => result.path));
				if (key !== previewKey) {
					previewKey = key; this.resultsEl.empty();
					for (const result of partial.results) this.renderResult(result);
				}
			});
			if (!response || cancelled()) return;
			this.resultsEl.empty();
			this.status.setText(`${response.failed || response.skipped ? '部分结果：' : ''}找到 ${response.results.length} 篇笔记` +
				(response.skipped ? `；${response.skipped} 篇超过8 MB，未搜索` : '') + (response.failed ? `；${response.failed} 篇读取失败` : ''));
			if (response.failed) this.resultsEl.createEl('button', { text: '重试' }).addEventListener('click', () => this.schedule(0));
			let shown = 0;
			const append = () => {
				for (const result of response.results.slice(shown, shown + PAGE_SIZE)) this.renderResult(result);
				shown += PAGE_SIZE;
				more.hidden = shown >= response.results.length;
				this.resultsEl.appendChild(more);
			};
			const more = this.resultsEl.createEl('button', { text: '加载更多' }); more.addEventListener('click', append); append();
		} catch { if (!cancelled()) this.status.setText('搜索失败，请重新输入关键词或重试。'); }
	}
	highlight(area, text) {
		let offset = 0;
		for (const hit of searchHits(text, searchTerms(this.query))) {
			area.createSpan( { text: text.slice(offset, hit.start) });
			area.createEl('mark', { text: text.slice(hit.start, hit.end) }); offset = hit.end;
		}
		area.createSpan( { text: text.slice(offset) });
	}
	renderResult(result) {
		const card = this.resultsEl.createDiv({ cls: 'wujie-search-result' });
		const title = card.createEl('button', { cls: 'wujie-search-title' }); this.highlight(title, result.title);
		title.addEventListener('click', () => { void this.openResult(result); });
		card.createDiv({ cls: 'wujie-search-path', text: result.folder || '笔记库根目录' });
		const renderHit = hit => {
			const start = Math.max(0, result.body.lastIndexOf('\n', hit.start - 1) + 1, hit.start - 45);
			const end = Math.min(result.body.length, hit.end + 95);
			const snippet = card.createEl('button', { cls: 'wujie-search-snippet' });
			this.highlight(snippet, (start ? '…' : '') + result.body.slice(start, end).replace(/\s+/gu, ' ') + (end < result.body.length ? '…' : ''));
			snippet.addEventListener('click', () => { void this.openResult(result, hit); });
		};
		if (result.hits.length) renderHit(result.hits[0]);
		if (result.hits.length > 1) {
			const expand = card.createEl('button', { cls: 'wujie-search-expand', text: `展开其余 ${result.hits.length - 1} 处命中${result.hits.length === 80 ? '（最多展示80处）' : ''}` });
			expand.addEventListener('click', () => { expand.remove(); result.hits.slice(1).forEach(renderHit); });
		}
		card.createDiv({ cls: 'wujie-search-time', text: '修改于 ' + new Date(result.mtime).toLocaleString() });
	}
	async openResult(result, hit) {
		try {
			const file = this.owner.app.vault.getFileByPath(result.path);
			if (!file) { this.invalidate(); new Notice('笔记已移动或删除，请查看更新后的结果。'); return; }
			let state = {};
			if (hit) {
				const body = await this.owner.app.vault.cachedRead(file);
				if (searchableText(body) !== result.body) { this.invalidate(); new Notice('笔记已更新，请从最新结果定位。'); return; }
				const before = body.slice(0, hit.start), line = before.split('\n').length - 1;
				const ch = hit.start - (before.lastIndexOf('\n') + 1);
				state = { line, startLoc: { line, ch }, endLoc: { line, ch: ch + hit.end - hit.start } };
			}
			const leaf = this.owner.app.workspace.getLeaf(false);
			await leaf.openFile(file, { active: true, eState: state });
			const editor = leaf.view.editor;
			if (hit && editor) {
				editor.setSelection(state.startLoc, state.endLoc);
				editor.scrollIntoView({ from: state.startLoc, to: state.endLoc }, true);
			}
			if (Platform.isMobile) this.owner.app.workspace.leftSplit.collapse();
		} catch { new Notice('无法打开笔记，请重试。'); }
	}
	async onClose() {
		this.closed = true; this.generation++; window.clearTimeout(this.timer); this.index.clear();
		this.owner.noteSearchViews.delete(this);
	}
}

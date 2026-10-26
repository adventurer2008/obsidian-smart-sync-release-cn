import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerHooks } from 'node:module';
globalThis.window = globalThis;
registerHooks({ resolve(specifier, context, next) {
	return specifier === 'obsidian' ? { url: new URL('./obsidian-double.mjs', import.meta.url).href, shortCircuit: true } : next(specifier, context);
} });
const { matchNote, searchTerms, searchHits, NoteSearchIndex, NoteSearchView } = await import('../src/search.js');
const note = { path: '工作/项目A/会议.md', folder: '工作/项目A', title: '同步速度', body: '讨论同步速度。\nSync testing [a+b] <script>\n第二次同步', mtime: 100, tags: ['工作', '同步'] };

test('Chinese fragments, AND across title/body, phrases, case and literal punctuation', () => {
	assert.ok(matchNote(note, '同步 TESTING'));
	assert.equal(matchNote(note, '同步 missing'), undefined);
	assert.ok(matchNote(note, '"Sync testing"'));
	assert.equal(matchNote(note, '"testing Sync"'), undefined);
	assert.ok(matchNote(note, '[a+b]'));
	assert.equal(matchNote(note, 'TESTING', { location: 'title' }), undefined);
	assert.equal(matchNote(note, '同步速度').rank, 0);
	assert.deepEqual(searchTerms('同步 "Sync testing"'), ['同步', 'Sync testing']);
	assert.deepEqual(searchHits('İ NOTE note', ['note']), [{ start: 2, end: 6 }, { start: 7, end: 11 }]);
});

test('folder boundary, recursive scope, tags and inclusive original modification dates', () => {
	assert.ok(matchNote(note, '同步', { folder: '工作', tags: ['#工作', '同步'], from: 100, to: 100 }));
	assert.equal(matchNote(note, '同步', { folder: '工作', recursive: false }), undefined);
	assert.equal(matchNote(note, '同步', { folder: '工作/项目' }), undefined);
	assert.equal(matchNote(note, '同步', { tags: ['不存在'] }), undefined);
	assert.equal(matchNote(note, '同步', { from: 101 }), undefined);
	assert.equal(matchNote(note, '同步', { to: 99 }), undefined);
});

function fixture() {
	const files = [{ path: 'A.md', basename: 'A', parent: { path: '/' }, stat: { size: 10, mtime: 1234, ctime: 12 } },
		{ path: 'B.md', basename: '同步', parent: { path: '/' }, stat: { size: 10, mtime: 10, ctime: 12 } }];
	const bodies = new Map([['A.md', '同步 <script> 中文'], ['B.md', 'another note']]);
	let reads = 0;
	const app = { vault: { getMarkdownFiles: () => files, cachedRead: async file => { reads++; return bodies.get(file.path); } },
		metadataCache: { getFileCache: () => ({ frontmatter: { tags: ['工作'] } }) } };
	return { files, bodies, app, reads: () => reads };
}

test('read-only incremental index, ranking, rename/delete and max(updated, original mtime)', async () => {
	const f = fixture(), index = new NoteSearchIndex(f.app, () => 500);
	const before = structuredClone(f.files);
	assert.deepEqual((await index.search('同步')).results.map(row => row.path), ['B.md', 'A.md']);
	assert.equal((await index.search('同步', { sort: 'modified' })).results[0].mtime, 1234);
	assert.equal(f.reads(), 2);
	f.bodies.set('A.md', 'updated text'); index.invalidate(f.files[0]);
	assert.equal((await index.search('同步')).results.length, 1); assert.equal(f.reads(), 3);
	f.files[1].path = 'renamed.md'; f.bodies.set('renamed.md', '同步'); index.invalidate(f.files[1], 'B.md');
	assert.equal((await index.search('同步')).results[0].path, 'renamed.md');
	f.files.splice(1); index.invalidate({ path: 'renamed.md' });
	assert.equal((await index.search('同步')).results.length, 0);
	assert.deepEqual(f.files[0], before[0]);
	index.clear(); assert.equal(index.bytes, 0); assert.equal(index.cache.size, 0);
});

test('cancel stale reads, report unreadable/oversized notes and bound cached text', async () => {
	const f = fixture(), index = new NoteSearchIndex(f.app);
	let cancel = false;
	f.app.vault.cachedRead = async () => { cancel = true; return '同步'; };
	assert.equal(await index.search('同步', {}, () => cancel), undefined);
	assert.equal(index.cache.size, 0);
	f.files[0].stat.size = 9 * 1024 * 1024;
	f.app.vault.cachedRead = async () => { throw Error('unreadable'); };
	const result = await index.search('同步'); assert.equal(result.skipped, 1); assert.equal(result.failed, 1);
	f.files[0].stat.size = 10;
	f.app.vault.cachedRead = async () => 'x'.repeat(7 * 1024 * 1024);
	await index.search('missing'); assert.ok(index.bytes <= 24 * 1024 * 1024);
});


test('title and metadata filters avoid unrelated body reads including oversized title hits', async () => {
 const f = fixture(), index = new NoteSearchIndex(f.app);
 f.files[1].stat.size = 9 * 1024 * 1024;
 assert.deepEqual((await index.search('同步', { location: 'title' })).results.map(row => row.path), ['B.md']);
 assert.equal(f.reads(), 0);
 assert.equal((await index.search('同步', { folder: 'missing' })).results.length, 0);
 assert.equal((await index.search('同步', { tags: ['missing'] })).results.length, 0);
 assert.equal((await index.search('同步', { from: 99999 })).results.length, 0);
 assert.equal(f.reads(), 0);
});

test('cold searches bound concurrent reads, publish partial hits before the last read, and reuse warm metadata', async () => {
 const files = Array.from({length: 12}, (_, n) => ({path: `${n}.md`, basename: `${n}`, stat: {mtime: 1, ctime: 1, size: 16}}));
 let active = 0, peak = 0, reads = 0, releaseLast;
 const held = new Promise(resolve => {releaseLast = resolve;});
 let signalLast; const lastStarted = new Promise(resolve => {signalLast = resolve;});
 const app = {vault: {getMarkdownFiles: () => files, cachedRead: async file => {
  reads++; active++; peak = Math.max(peak, active);
  try {
   if (file === files.at(-1)) { signalLast(); await held; }
   else await new Promise(resolve => setTimeout(resolve, 2));
   return 'needle';
  } finally {active--;}
 }}, metadataCache: {getFileCache: () => ({})}};
 const index = new NoteSearchIndex(app), previews = [];
 const running = index.search('needle', {}, () => false, (done,total,partial) => previews.push({done,total,partial}));
 await lastStarted;
 assert.ok(peak > 1 && peak <= 4);
 assert.ok(previews.some(row => row.partial.matches > 0 && row.done < row.total));
 releaseLast(); const result = await running;
 assert.equal(result.results.length, 12);
 await index.search('needle'); assert.equal(reads, 12);
 assert.equal(previews.at(-1).done, 12);
});

test('cancelling a concurrent search cannot publish late results or populate its cache', async () => {
 const f = fixture(), index = new NoteSearchIndex(f.app);
 let release, cancelled = false, reports = 0;
 const held = new Promise(resolve => {release = resolve;});
 f.app.vault.cachedRead = async () => {await held; return '同步';};
 const running = index.search('同步', {}, () => cancelled, () => {reports++;});
 cancelled = true; release();
 assert.equal(await running, undefined); assert.equal(reports, 0); assert.equal(index.cache.size, 0);
});

test('search view shows partial results while scanning and discards late completion after a query change', async () => {
 let release, cards = [], status = '';
 const held = new Promise(resolve => {release = resolve;});
 const view = {generation: 0, query: 'test', filters: {}, chips: {empty() {}},
  resultsEl: {empty() {cards = [];}, createEl() {return {addEventListener() {}};}, appendChild() {}},
  status: {setText(value) {status = value;}}, renderResult(result) {cards.push(result.path);},
  index: {async search(query, filters, cancelled, progress) {
   progress(1, 2, {results: [{path: 'first.md'}], matches: 1});
   await held; return {results: [{path: 'late.md'}], failed: 0, skipped: 0};
  }}};
 const running = NoteSearchView.prototype.run.call(view);
 assert.deepEqual(cards, ['first.md']); assert.match(status, /已找到 1 篇.*搜索中 1\/2/);
 view.generation++; release(); await running;
 assert.deepEqual(cards, ['first.md']);
});

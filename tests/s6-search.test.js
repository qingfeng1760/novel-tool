'use strict';
/**
 * s6-search.test.js —— S6 阶段验收：全文检索与筛选（模块 8）。
 *
 * 对应 PRD §11 S6「跨书搜索可用」与模块 8 的全部要求：
 * 全书内 / 全库搜索、命中片段与次数、索引增量更新与一键重建、
 * 多条件叠加筛选、重名书检测与合并。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const searchModule = require('../server/services/search');
const { startTestServer, expectOk, expectErr } = require('./helpers/env');

const ROOT = path.resolve(__dirname, '..');
const ASSETS = path.join(ROOT, 'web', 'assets');

/** 造两本书，正文里埋不同的关键词 */
async function seed(srv) {
  const a = srv.ctx.library.create({ title: '剑来', author: '烽火戏诸侯', source_site: 'a.com', tags: ['仙侠'] }).book;
  srv.ctx.library.writeChapters(a.book_id, [
    { index: 1, title: '第一章 山间', content: '少年握紧了手里的剑，这座山的名字叫骊珠洞天。' },
    { index: 2, title: '第二章 出山', content: '他走出了骊珠洞天，回头看了一眼那座山。' },
    { index: 3, title: '第三章 归乡', content: '山还是那座山，人已经不是那个人了。' },
  ]);

  const b = srv.ctx.library.create({ title: '别的小说', author: '别的作者', source_site: 'b.com', tags: ['玄幻'] }).book;
  srv.ctx.library.writeChapters(b.book_id, [
    { index: 1, title: '第一章 开始', content: '这里没有那座山，只有一片海。' },
    { index: 2, title: '第二章 远行', content: '他划着小船出海，海的名字没人知道。' },
  ]);

  return { a, b };
}

// ============================================================ 索引

test('S6 · reindex 建好索引：元信息 + 每本书一个分片', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());
  const { a, b } = await seed(srv);

  const result = expectOk(t, await srv.post('/api/search/reindex', {}), '重建索引');
  assert.equal(result.indexed, 2);
  assert.ok(result.message.includes('2 本书'));

  // 元信息文件用 PRD 约定的名字
  assert.ok(srv.ctx.storage.exists('index/fulltext.json'), 'index/fulltext.json 必须存在');
  const meta = srv.ctx.storage.readJson('index/fulltext.json');
  assert.equal(meta.books.length, 2);
  assert.equal(meta.schemaVersion, 1);
  assert.equal(meta.syncState, 'local');
  assert.ok(meta.builtAt);

  // 每本书一个分片
  assert.ok(srv.ctx.storage.exists(`index/books/${a.book_id}.json`));
  assert.ok(srv.ctx.storage.exists(`index/books/${b.book_id}.json`));
  const shard = srv.ctx.storage.readJson(`index/books/${a.book_id}.json`);
  assert.equal(shard.chapters.length, 3);
  assert.ok(shard.chapters[0].text.includes('骊珠洞天'));

  const status = expectOk(t, await srv.get('/api/search/status'), '索引状态');
  assert.equal(status.built, true);
  assert.equal(status.indexedBooks, 2);
  assert.equal(status.shelfBooks, 2);
  assert.equal(status.stale, false);
});

test('S6 · 导入新书后索引自动增量更新（不用手动重建）', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());
  await seed(srv);
  expectOk(t, await srv.post('/api/search/reindex', {}), '先建索引');

  expectOk(
    t,
    await srv.post('/api/import/paste', { text: '第一章 甲\n这里的暗号是青莲剑仙。', title: '新导入的书' }),
    '导入'
  );

  const found = expectOk(t, await srv.get(`/api/search?q=${encodeURIComponent('青莲剑仙')}`), '搜新书');
  assert.equal(found.results.length, 1, '导入完立刻就应该能搜到');
  assert.equal(found.results[0].title, '新导入的书');

  const status = expectOk(t, await srv.get('/api/search/status'), '索引状态');
  assert.equal(status.stale, false, '导入之后索引不该是过期的');
});

test('S6 · 分片丢了会自动补回来，而不是让用户搜不到', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());
  const { a } = await seed(srv);
  expectOk(t, await srv.post('/api/search/reindex', {}), '建索引');

  srv.ctx.storage.remove(`index/books/${a.book_id}.json`);
  const found = expectOk(t, await srv.get(`/api/search?q=${encodeURIComponent('骊珠洞天')}`), '搜');
  assert.equal(found.results.length, 1, '分片不在也要能搜到');
  assert.ok(srv.ctx.storage.exists(`index/books/${a.book_id}.json`), '搜的时候应该顺便把分片补上');
});

test('S6 · 一键重建会把旧索引清掉重来', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());
  await seed(srv);
  expectOk(t, await srv.post('/api/search/reindex', {}), '第一次');

  // 塞一个垃圾分片，重建之后应该不见
  srv.ctx.storage.writeJson('index/books/ghost.json', { book_id: 'ghost', chapters: [] });
  expectOk(t, await srv.post('/api/search/reindex', {}), '第二次');
  assert.equal(srv.ctx.storage.exists('index/books/ghost.json'), false, '重建要清理垃圾分片');
});

// ============================================================ 搜索

test('S6 · 全库搜索：按书分组，带章节、命中次数与前后文片段', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());
  await seed(srv);
  expectOk(t, await srv.post('/api/search/reindex', {}), '建索引');

  const result = expectOk(t, await srv.get(`/api/search?q=${encodeURIComponent('山')}`), '搜索');
  assert.equal(result.scope, 'library');
  assert.ok(result.matchedBooks >= 2, '两本书里都有"山"');
  assert.ok(result.totalHits >= 4);

  const jianlai = result.results.find((r) => r.title === '剑来');
  assert.ok(jianlai, '应该找到《剑来》');
  assert.equal(jianlai.chapterCount, 3);
  assert.ok(jianlai.hitCount >= 4);
  assert.ok(jianlai.author === '烽火戏诸侯');

  const chapter1 = jianlai.chapters.find((ch) => ch.chapter_index === 1);
  assert.equal(chapter1.chapter_title, '第一章 山间');
  assert.ok(chapter1.count >= 1);
  assert.ok(chapter1.snippets.length >= 1);
  const snippet = chapter1.snippets[0];
  assert.ok(snippet.text.includes('山'), '片段必须包含关键词');
  assert.equal(snippet.text.slice(snippet.offset_in_snippet, snippet.offset_in_snippet + 1), '山');
  assert.equal(typeof snippet.prefix_trimmed, 'boolean');
});

test('S6 · 全书内搜索（只在指定这本书里找）', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());
  const { a, b } = await seed(srv);
  expectOk(t, await srv.post('/api/search/reindex', {}), '建索引');

  const scoped = expectOk(
    t,
    await srv.get(`/api/search?q=${encodeURIComponent('海')}&scope=book&book_id=${a.book_id}`),
    '全书内搜索'
  );
  assert.equal(scoped.scope, 'book');
  assert.equal(scoped.results.length, 0, '《剑来》里没有"海"');

  const scopedB = expectOk(
    t,
    await srv.get(`/api/search?q=${encodeURIComponent('海')}&scope=book&book_id=${b.book_id}`),
    '第二本书内搜索'
  );
  assert.equal(scopedB.results.length, 1);
  assert.equal(scopedB.results[0].book_id, b.book_id);
});

test('S6 · 搜不到时给出引导，空关键词给人话', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());
  await seed(srv);
  expectOk(t, await srv.post('/api/search/reindex', {}), '建索引');

  const none = expectOk(t, await srv.get(`/api/search?q=${encodeURIComponent('这几个字肯定没有')}`), '搜不到');
  assert.equal(none.results.length, 0);
  assert.ok(none.hint.includes('换个词'));

  expectErr(t, await srv.get('/api/search?q='), 400, 'EMPTY_QUERY', '空关键词');
  expectErr(t, await srv.get('/api/search?q=a&scope=book'), 400, 'NO_BOOK_FOR_SCOPE', '全书内但没给书');
});

test('S6 · 搜索大小写不敏感，跨换行也能命中', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());
  await seed(srv);
  expectOk(t, await srv.post('/api/search/reindex', {}), '建索引');

  expectOk(
    t,
    await srv.post('/api/import/paste', { text: '第一章 甲\nHello\nWorld 混排的内容。', title: '大小写测试' }),
    '导入'
  );

  const upper = expectOk(t, await srv.get('/api/search?q=hello'), '小写搜大写');
  assert.equal(upper.results.length, 1);

  const crossLine = expectOk(t, await srv.get(`/api/search?q=${encodeURIComponent('World 混排')}`), '跨换行');
  assert.equal(crossLine.results.length, 1, '换行被规范化成空格，应该能跨行命中');
});

// ============================================================ 筛选

test('S6 · /api/filter/options 给出状态/标签/站点/作者的可选值', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());
  await seed(srv);

  const options = expectOk(t, await srv.get('/api/filter/options'), '筛选项');
  assert.deepEqual(options.tags.sort(), ['仙侠', '玄幻']);
  assert.deepEqual(options.sites.sort(), ['a.com', 'b.com']);
  assert.deepEqual(options.authors.sort(), ['别的作者', '烽火戏诸侯']);
  assert.ok(options.status.includes('在读'));
});

test('S6 · 多条件叠加筛选可以同时生效', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());
  const { a } = await seed(srv);
  srv.ctx.library.patch(a.book_id, { status: '在读' });

  const both = expectOk(
    t,
    await srv.get(`/api/books?tag=${encodeURIComponent('仙侠')}&site=a.com&author=${encodeURIComponent('烽火戏诸侯')}`),
    '三条件叠加'
  );
  assert.equal(both.total, 1);

  const conflict = expectOk(t, await srv.get(`/api/books?tag=${encodeURIComponent('仙侠')}&site=b.com`), '冲突条件');
  assert.equal(conflict.total, 0, '条件之间应该是"且"的关系');
});

// ============================================================ 重名书

test('S6 · 书名骨架与相似度（去标点 / 去括号 / 二元组）', () => {
  // 括号里的"精校版 / 全本"这类后缀是噪声，去掉之后才看得出是同一本书
  assert.equal(searchModule.titleSkeleton('《剑来》（精校版）'), '剑来');
  assert.equal(searchModule.titleSkeleton('剑 来'), '剑来');
  assert.equal(searchModule.titleSkeleton('剑来'), searchModule.titleSkeleton('《剑来》'));
  assert.equal(searchModule.titleSkeleton('诡秘之主【全本】'), '诡秘之主');

  const a = searchModule.bigrams('诡秘之主');
  const b = searchModule.bigrams('诡秘之主');
  assert.equal(searchModule.jaccard(a, b), 1);
  const c = searchModule.bigrams('完全不同的书名');
  assert.ok(searchModule.jaccard(a, c) < 0.2);
});

test('S6 · 检测重名书：书名相似 + 作者相同才成组', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());

  const one = srv.ctx.library.create({ title: '诡秘之主', author: '爱潜水的乌贼', source_site: 'x.com' }).book;
  srv.ctx.library.writeChapters(one.book_id, [
    { index: 1, title: '第一章', content: '内容一。' },
    { index: 2, title: '第二章', content: '内容二。' },
    { index: 3, title: '第三章', content: '内容三。' },
  ]);
  const two = srv.ctx.library.create({ title: '《诡秘之主》（全本）', author: '爱潜水的乌贼', source_site: 'y.com' }).book;
  srv.ctx.library.writeChapter(two.book_id, 1, '内容一。');
  // 同名但作者不同：不能建议合并
  const three = srv.ctx.library.create({ title: '诡秘之主', author: '另一个人', source_site: 'z.com' }).book;
  srv.ctx.library.writeChapter(three.book_id, 1, '别的。');

  const result = expectOk(t, await srv.get('/api/books/duplicates'), '查重');
  assert.equal(result.total, 1, '只应该有一组');
  const group = result.groups[0];
  assert.equal(group.books.length, 2);
  assert.ok(group.reason.length > 0);
  assert.equal(group.keep.book_id, one.book_id, '应该建议保留章节多的那一份');
  assert.ok(group.others.some((b) => b.book_id === two.book_id));
  assert.ok(!group.books.some((b) => b.book_id === three.book_id), '作者不同的同名书不能混进来');
});

test('S6 · 合并重名书：保留章节多的，另一本进回收站，索引同步', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());

  const big = srv.ctx.library.create({ title: '长夜余火', author: '爱潜水的乌贼' }).book;
  srv.ctx.library.writeChapters(big.book_id, [
    { index: 1, title: '一', content: '独有内容甲。' },
    { index: 2, title: '二', content: '独有内容乙。' },
    { index: 3, title: '三', content: '独有内容丙。' },
  ]);
  const small = srv.ctx.library.create({ title: '长夜余火', author: '爱潜水的乌贼', source_site: 'other.com' }).book;
  srv.ctx.library.writeChapter(small.book_id, 1, '别的内容。');
  expectOk(t, await srv.post('/api/search/reindex', {}), '建索引');

  const result = expectOk(
    t,
    await srv.post('/api/books/merge', { keep_id: small.book_id, drop_id: big.book_id }),
    '合并（故意把参数传反）'
  );
  // 即使调用方传反了，也应当保留章节多的那一份
  assert.equal(result.kept.book_id, big.book_id, '要保留章节多的那一份');
  assert.equal(result.removed.book_id, small.book_id);
  assert.ok(result.trashed.startsWith('.trash/'), '被合并掉的那本要进回收站');

  assert.equal(srv.ctx.library.list().length, 1);
  assert.equal(srv.ctx.library.get(big.book_id).total_chapters, 3);

  // 索引同步：被合并掉的书不能再出现在搜索结果里
  const found = expectOk(t, await srv.get(`/api/search?q=${encodeURIComponent('别的内容')}`), '搜被合并的书');
  assert.equal(found.results.length, 0, '合并之后索引里不该还留着那本书');
  assert.equal(srv.ctx.storage.exists(`index/books/${small.book_id}.json`), false);

  const stillThere = expectOk(t, await srv.get(`/api/search?q=${encodeURIComponent('独有内容乙')}`), '搜保留的书');
  assert.equal(stillThere.results.length, 1);

  expectErr(
    t,
    await srv.post('/api/books/merge', { keep_id: big.book_id, drop_id: big.book_id }),
    400,
    'MERGE_SAME_BOOK',
    '自己合自己'
  );
});

// ============================================================ 索引与备份的关系

test('S6 · 索引不进备份包（它是可以重建的缓存）', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());
  await seed(srv);
  expectOk(t, await srv.post('/api/search/reindex', {}), '建索引');

  const result = await srv.ctx.backup.exportZip();
  const AdmZip = require('adm-zip');
  const names = new AdmZip(result.file).getEntries().map((e) => e.entryName);
  assert.ok(names.includes('data/library.json'), '书库索引（数据）要进备份');
  assert.ok(
    !names.some((n) => n.startsWith('data/index/')),
    '全文检索索引不该进备份：它能一键重建，带进去只会让备份包白白变大'
  );
  fs.rmSync(result.file, { force: true });
});

// ============================================================ 前端产物

test('S6 · 检索页有「找内容 / 筛书 / 重名书」三块，且能高亮跳转', () => {
  const js = fs.readFileSync(path.join(ASSETS, 'views', 'search.js'), 'utf8');

  assert.ok(js.includes('/api/search'), '缺少全文检索');
  assert.ok(js.includes('/api/filter/options'), '缺少筛选项');
  assert.ok(js.includes('/api/books/duplicates'), '缺少重名书检测');
  assert.ok(js.includes('/api/books/merge'), '缺少合并');
  assert.ok(js.includes('data-tab="content"') && js.includes('data-tab="filter"') && js.includes('data-tab="duplicates"'));
  assert.ok(js.includes('hit-snippet'), '要展示前后文片段');
  assert.ok(js.includes('命中'), '要显示命中次数');
  // 点结果跳到阅读器并带关键词高亮
  assert.ok(js.includes('&q='), '跳转要带上关键词，阅读器才能高亮');

  const reader = fs.readFileSync(path.join(ASSETS, 'reader.js'), 'utf8');
  assert.ok(reader.includes('highlightKeywordInElement'), '阅读器要支持命中高亮');
  assert.ok(reader.includes('search-hit'), '阅读器要高亮样式名');
  assert.ok(reader.includes("qs('q')"), '阅读器要读 q 参数');
  assert.ok(reader.includes('scrollToFirstHit'), '要能滚到第一处命中');

  const css = fs.readFileSync(path.join(ASSETS, 'pages.css'), 'utf8');
  for (const cls of ['.search-book', '.hit-snippet', 'mark.hit', '.dup-group']) {
    assert.ok(css.includes(cls), `缺少样式 ${cls}`);
  }
  const readerCss = fs.readFileSync(path.join(ASSETS, 'reader.css'), 'utf8');
  assert.ok(readerCss.includes('.search-hit'), '阅读器缺高亮样式');

  // 检索页要真的注册进路由
  const index = fs.readFileSync(path.join(ASSETS, 'views', 'index.js'), 'utf8');
  assert.ok(index.includes("from './search.js'"), '检索视图没接进路由表');
});

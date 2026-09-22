'use strict';
/**
 * s5-chapters.test.js —— S5 阶段验收：书籍详情与章节目录（模块 4）。
 *
 * 对应 PRD §11 S5「详情与目录（含体检 / 手工调章）」与验收项"目录质量可自查"。
 * 这里格外看重一件事：**手工调章不能把正文搞错位**。
 * 章节正文文件是按序号命名的，拆章/合并/删章都会让后面所有章平移，
 * 所以每条用例都要回到磁盘上核对"第 N 章读出来的还是原来那一章的内容"。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const chaptersService = require('../server/services/chapters');
const { startTestServer, expectOk, expectErr } = require('./helpers/env');

const ROOT = path.resolve(__dirname, '..');
const ASSETS = path.join(ROOT, 'web', 'assets');

/** 造一本 7 章的书，内容可辨认：第N章的正文是"N-正文"x3 */
async function seed(srv, count = 7) {
  const { book } = srv.ctx.library.create({ title: '目录测试书' });
  const chapters = [];
  for (let i = 1; i <= count; i++) {
    chapters.push({
      index: i,
      title: `第${i}章 标题${i}`,
      content: `${i}-正文第一段。\n${i}-正文第二段。\n${i}-正文第三段。`,
    });
  }
  srv.ctx.library.writeChapters(book.book_id, chapters);
  return book;
}

/** 断言第 index 章的正文里带的是 expectNo 那个编号的内容 */
function assertChapterContent(srv, bookId, index, expectNo) {
  const content = srv.ctx.library.readChapterText(bookId, index);
  assert.ok(content != null, `第 ${index} 章应该存在`);
  assert.ok(
    content.startsWith(`${expectNo}-正文第一段。`),
    `第 ${index} 章的内容应该来自原来的第 ${expectNo} 章，实际是：${content.slice(0, 24)}`
  );
  const meta = srv.ctx.library.get(bookId).chapters[index - 1];
  assert.equal(meta.char_count, content.replace(/\s/g, '').length, '字数要和正文对得上');
}

// ============================================================ 章节号识别

test('S5 · 从标题里抽章节号（含中文数字）', () => {
  assert.equal(chaptersService.extractChapterNumber('第12章 标题'), 12);
  assert.equal(chaptersService.extractChapterNumber('第 3 回 标题'), 3);
  assert.equal(chaptersService.extractChapterNumber('第十二章 标题'), 12);
  assert.equal(chaptersService.extractChapterNumber('第一百零五章'), 105);
  assert.equal(chaptersService.extractChapterNumber('第二十三章'), 23);
  assert.equal(chaptersService.extractChapterNumber('Chapter 42'), 42);
  assert.equal(chaptersService.extractChapterNumber('12. 标题'), 12);
  assert.equal(chaptersService.extractChapterNumber('序章'), null);
  assert.equal(chaptersService.extractChapterNumber('', null), null);
});

// ============================================================ 目录列表

test('S5 · 章节目录列出序号、标题、字数与状态', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());
  const book = await seed(srv);

  const data = expectOk(t, await srv.get(`/api/books/${book.book_id}/chapters`), '目录');
  assert.equal(data.total, 7);
  assert.equal(data.chapters[0].index, 1);
  assert.equal(data.chapters[0].title, '第1章 标题1');
  assert.equal(data.chapters[0].state, '成功');
  assert.ok(data.chapters[0].char_count > 0);

  // 手工把第 3 章标成抓取失败，状态要跟着变
  const detail = srv.ctx.library.get(book.book_id);
  detail.chapters[2].is_ok = false;
  detail.chapters[2].fetched_at = new Date().toISOString();
  srv.ctx.library.save(detail);
  const again = expectOk(t, await srv.get(`/api/books/${book.book_id}/chapters`), '再取目录');
  assert.equal(again.chapters[2].state, '失败');
});

test('S5 · 读单章正文，越界给人话', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());
  const book = await seed(srv);

  const chapter = expectOk(t, await srv.get(`/api/books/${book.book_id}/chapters/2`), '第 2 章');
  assert.equal(chapter.title, '第2章 标题2');
  assert.ok(chapter.content.includes('2-正文第一段。'));
  assert.equal(chapter.missing_file, false);

  expectErr(t, await srv.get(`/api/books/${book.book_id}/chapters/99`), 404, 'CHAPTER_NOT_FOUND', '越界');
});

// ============================================================ 目录体检

test('S5 · 目录体检能挑出序号跳跃 / 标题重复 / 空章节，并定位到具体章', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());
  const book = await seed(srv);

  // 造三种异常
  const detail = srv.ctx.library.get(book.book_id);
  detail.chapters[2].title = '第9章 忽然跳到九'; // 序号跳跃
  detail.chapters[4].title = '第9章 忽然跳到九'; // 标题重复
  detail.chapters[5].char_count = 0; // 空章节
  srv.ctx.library.save(detail);
  srv.ctx.library.writeChapter(book.book_id, 6, '', { title: '第6章 标题6' });

  const result = expectOk(t, await srv.get(`/api/books/${book.book_id}/diagnose`), '体检');
  assert.equal(result.hasIssues, true);
  assert.ok(result.summary.jump >= 1, '应该发现序号跳跃');
  assert.ok(result.summary.duplicate >= 1, '应该发现标题重复');
  assert.ok(result.summary.empty >= 1, '应该发现空章节');

  for (const issue of result.issues) {
    assert.ok(issue.chapter_index >= 1, '每条问题都要能定位到章');
    assert.ok(issue.message.length > 0, '每条问题都要有人话说明');
    assert.ok(issue.hint.length > 0, '每条问题都要给出下一步建议');
    assert.ok(['error', 'warn'].includes(issue.level));
  }
  assert.ok(result.verdict.includes('需要留意'));

  // 干净的书应该报"没有异常"
  const clean = srv.ctx.library.create({ title: '干净的书' }).book;
  srv.ctx.library.writeChapters(clean.book_id, [
    { index: 1, title: '第1章 甲', content: '内容一。' },
    { index: 2, title: '第2章 乙', content: '内容二。' },
  ]);
  const cleanResult = expectOk(t, await srv.get(`/api/books/${clean.book_id}/diagnose`), '干净体检');
  assert.equal(cleanResult.hasIssues, false);
  assert.ok(cleanResult.verdict.includes('干净'));
});

// ============================================================ 更新对比

test('S5 · 更新对比：没有快照时说清楚；有快照时给出新增/修订/无变化明细', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());
  const book = await seed(srv);

  const none = expectOk(t, await srv.get(`/api/books/${book.book_id}/diff`), '无快照');
  assert.equal(none.hasSnapshot, false);
  assert.ok(none.summary.includes('没法对比'));

  // 存一份快照，然后模拟"抓取之后目录变了"
  expectOk(t, await srv.post(`/api/books/${book.book_id}/toc-snapshot`, {}), '存快照');

  const same = expectOk(t, await srv.get(`/api/books/${book.book_id}/diff`), '无变化');
  assert.equal(same.hasSnapshot, true);
  assert.equal(same.added.length, 0);
  assert.equal(same.revised.length, 0);
  assert.ok(same.summary.includes('没有变化'));

  // 改动：第 2 章内容变了（修订），末尾追加一章（新增）
  srv.ctx.library.writeChapter(book.book_id, 2, '2-正文被重新抓取过了。', { title: '第2章 标题2' });
  const detail = srv.ctx.library.get(book.book_id);
  detail.chapters.push({ index: 8, title: '第8章 新的一章', char_count: 0, is_ok: true, fetched_at: new Date().toISOString() });
  srv.ctx.library.save(detail);
  srv.ctx.library.writeChapter(book.book_id, 8, '8-新内容。', { title: '第8章 新的一章' });

  const changed = expectOk(t, await srv.get(`/api/books/${book.book_id}/diff`), '有变化');
  assert.equal(changed.added.length, 1);
  assert.equal(changed.added[0].index, 8);
  assert.equal(changed.revised.length, 1);
  assert.equal(changed.revised[0].index, 2);
  assert.equal(changed.revised[0].title_before, '第2章 标题2');
  assert.ok(changed.summary.includes('新增 1 章'));
  assert.ok(changed.summary.includes('修订 1 章'));
  assert.ok(changed.takenAt, '要告诉用户对比基准是什么时候的');
});

// ============================================================ 重新分章

test('S5 · 重新分章必须先预览；确认后才动数据', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());
  const book = await seed(srv);
  const before = srv.ctx.library.get(book.book_id).chapters.length;

  // 预览：不写盘
  const preview = expectOk(
    t,
    await srv.post(`/api/books/${book.book_id}/rechapterize`, { rule_id: 'default' }),
    '预览'
  );
  assert.equal(preview.applied, false);
  assert.equal(preview.before, before);
  assert.equal(preview.after, before, '原来的标题就是章节头，重切之后章数应当不变');
  assert.ok(preview.hint.includes('确认无误再应用'));
  assert.equal(srv.ctx.library.get(book.book_id).chapters.length, before, '预览不能改数据');

  // 用一个"切不出东西"的规则：章数会变 1，并且要拦住用户
  const useless = expectOk(
    t,
    await srv.post(`/api/books/${book.book_id}/rechapterize`, { pattern: '^\\s*(【不存在】)\\s*$' }),
    '无效规则预览'
  );
  assert.equal(useless.matched, 0);
  assert.ok(useless.hint.includes('换一套规则'));

  // 确认应用
  const applied = expectOk(
    t,
    await srv.post(`/api/books/${book.book_id}/rechapterize`, { rule_id: 'default', confirm: true }),
    '应用'
  );
  assert.equal(applied.applied, true);
  const after = srv.ctx.library.get(book.book_id);
  assert.equal(after.chapters.length, applied.after);
  // 正文内容不能丢
  assert.ok(after.chapters[0].char_count > 0);
  const firstContent = srv.ctx.library.readChapterText(book.book_id, 1);
  assert.ok(firstContent.includes('1-正文第一段'), '重分章不能把正文弄丢');
});

test('S5 · 重新分章后旧目录会留一份快照（出问题能对照）', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());
  const book = await seed(srv);

  expectOk(t, await srv.post(`/api/books/${book.book_id}/rechapterize`, { rule_id: 'default', confirm: true }), '重分');
  const snapshot = expectOk(t, await srv.get(`/api/books/${book.book_id}/toc-snapshot`), '快照');
  assert.ok(snapshot.snapshot, '重分章前必须留快照');
  assert.equal(snapshot.snapshot.chapters.length, 7);
});

// ============================================================ 拆章

test('S5 · 拆章：内容一分不丢，后面的章序号平移且内容不错位', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());
  const book = await seed(srv);
  const original2 = srv.ctx.library.readChapterText(book.book_id, 2);

  const result = expectOk(
    t,
    await srv.post(`/api/books/${book.book_id}/chapters/split`, { index: 2 }),
    '拆第 2 章'
  );
  assert.equal(result.total, 8, '拆完之后应该多一章');
  assert.deepEqual(result.split_into, [2, 3]);

  // 拆出来的两章拼起来 == 原来的第二章
  const part1 = srv.ctx.library.readChapterText(book.book_id, 2);
  const part2 = srv.ctx.library.readChapterText(book.book_id, 3);
  assert.equal(`${part1}\n${part2}`.replace(/\n+/g, '\n'), original2.replace(/\n+/g, '\n'), '拆章不能丢字');
  assert.ok(part1.length > 0 && part2.length > 0);

  // 原来的第 3 章现在应该是第 4 章，内容必须跟着走
  assertChapterContent(srv, book.book_id, 4, 3);
  assertChapterContent(srv, book.book_id, 8, 7);

  const titles = srv.ctx.library.get(book.book_id).chapters.map((c) => c.title);
  assert.equal(titles[2], '第2章 标题2（下）', '拆出来的下半章要有默认标题');
});

test('S5 · 拆章可以指定拆分位置，越界给人话', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());
  const book = await seed(srv);

  const before = srv.ctx.library.readChapterText(book.book_id, 1);
  const result = expectOk(
    t,
    await srv.post(`/api/books/${book.book_id}/chapters/split`, { index: 1, at_offset: 6, title: '自定义下半章' }),
    '指定位置拆'
  );
  assert.equal(result.total, 8);

  // 按字符位置切：前 6 个字留在上半章，剩下的进下半章
  const upper = srv.ctx.library.readChapterText(book.book_id, 1);
  const lower = srv.ctx.library.readChapterText(book.book_id, 2);
  assert.equal(upper, '1-正文第一');
  assert.ok(lower.startsWith('段。'), `下半章应以剩下的字开头，实际：${lower.slice(0, 10)}`);
  assert.equal(
    `${upper}${lower}`.replace(/\s+/g, ''),
    before.replace(/\s+/g, ''),
    '按位置拆章不能丢字（换行处会被规整）'
  );
  assert.equal(srv.ctx.library.get(book.book_id).chapters[1].title, '自定义下半章');

  expectErr(
    t,
    await srv.post(`/api/books/${book.book_id}/chapters/split`, { index: 1, at_offset: 99999 }),
    400,
    'SPLIT_POSITION_INVALID',
    '位置越界'
  );
});

// ============================================================ 合并

test('S5 · 合并：两章并一章，原标题作为小标题保留，后面章不错位', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());
  const book = await seed(srv);

  const result = expectOk(
    t,
    await srv.post(`/api/books/${book.book_id}/chapters/merge`, { index: 3, count: 2 }),
    '合并第 3、4 章'
  );
  assert.equal(result.total, 6);

  const merged = srv.ctx.library.readChapterText(book.book_id, 3);
  assert.ok(merged.includes('【第3章 标题3】'), '原名要保留成小标题');
  assert.ok(merged.includes('【第4章 标题4】'));
  assert.ok(merged.includes('3-正文第一段。'));
  assert.ok(merged.includes('4-正文第三段。'));
  assert.equal(srv.ctx.library.get(book.book_id).chapters[2].title, '第3章 标题3 ～ 第4章 标题4');

  // 原来的第 5 章现在是第 4 章
  assertChapterContent(srv, book.book_id, 4, 5);
  assertChapterContent(srv, book.book_id, 6, 7);

  // 多出来的 0007.txt 必须被清掉，否则重分章时会多出一章
  assert.equal(
    fs.existsSync(path.join(srv.dataDir, 'books', book.book_id, 'chapters', '0007.txt')),
    false,
    '合并之后不能留下越界的章节文件'
  );

  expectErr(
    t,
    await srv.post(`/api/books/${book.book_id}/chapters/merge`, { index: 6, count: 5 }),
    400,
    'MERGE_OUT_OF_RANGE',
    '超范围合并'
  );
});

// ============================================================ 改名 / 删章

test('S5 · 改章节标题', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());
  const book = await seed(srv);

  expectOk(
    t,
    await srv.post(`/api/books/${book.book_id}/chapters/rename`, { index: 3, title: '改过的标题' }),
    '改名'
  );
  assert.equal(srv.ctx.library.get(book.book_id).chapters[2].title, '改过的标题');
  // 正文不受影响
  assertChapterContent(srv, book.book_id, 3, 3);

  expectErr(
    t,
    await srv.post(`/api/books/${book.book_id}/chapters/rename`, { index: 3, title: '   ' }),
    400,
    'TITLE_REQUIRED',
    '空标题'
  );
});

test('S5 · 删除一章：后面的章内容必须往前补齐（不能错位）', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());
  const book = await seed(srv);

  const result = expectOk(
    t,
    await srv.post(`/api/books/${book.book_id}/chapters/delete`, { index: 3 }),
    '删第 3 章'
  );
  assert.equal(result.total, 6);
  assert.ok(result.message.includes('序号已经往前补上'));

  // 删掉的第 3 章内容应该彻底不见了，原来的第 4 章顶上来
  assertChapterContent(srv, book.book_id, 3, 4);
  assertChapterContent(srv, book.book_id, 6, 7);

  const all = srv.ctx.library.get(book.book_id);
  assert.deepEqual(
    all.chapters.map((c) => c.index),
    [1, 2, 3, 4, 5, 6],
    '序号必须是从 1 开始的连续序列'
  );
  const leftover = srv.ctx.library.readChapterText(book.book_id, 7);
  assert.equal(leftover, null, '越界的章节文件应该被清掉');
});

// ============================================================ 单章重抓 / 导出

test('S5 · 单章重新抓取：导入进来的书没有来源页，要明确说明', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());
  const book = await seed(srv);

  const error = expectErr(
    t,
    await srv.post(`/api/books/${book.book_id}/chapters/2/refetch`, {}),
    400,
    'NO_SOURCE',
    '没有来源页'
  );
  assert.ok(error.message.includes('导入进来'));
  assert.ok(error.hint.includes('重新导入') || error.hint.includes('手工调整'));
});

test('S5 · 单章导出为 txt，文件名带书名与章节名', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());
  const book = await seed(srv);

  const res = await fetch(`${srv.url}/api/books/${book.book_id}/chapters/3/export`);
  assert.equal(res.status, 200);
  assert.ok((res.headers.get('content-type') || '').includes('text/plain'));
  const disposition = res.headers.get('content-disposition') || '';
  assert.ok(disposition.includes("filename*=UTF-8''"), '中文文件名要按 RFC 5987 编码');

  const text = await res.text();
  assert.ok(text.startsWith('第3章 标题3'), '导出内容要以章节标题开头');
  assert.ok(text.includes('3-正文第一段。'));
});

// ============================================================ 前端产物

test('S5 · 详情页有体检 / 只看异常 / 更新对比 / 重新分章 / 手工调章', () => {
  const js = fs.readFileSync(path.join(ASSETS, 'views', 'book.js'), 'utf8');

  assert.ok(js.includes('/diagnose'), '缺少目录体检');
  assert.ok(js.includes('onlyIssues'), '缺少「只看异常」');
  assert.ok(js.includes('/diff'), '缺少更新对比');
  assert.ok(js.includes('/rechapterize'), '缺少重新分章');

  // 手工调章四个动作
  for (const act of ['split', 'merge', 'rename', 'delete']) {
    assert.ok(js.includes(`data-act="${act}"`), `手工调章缺少 ${act}`);
  }
  assert.ok(js.includes('refetch'), '缺少单章重新抓取');
  assert.ok(js.includes('/export'), '缺少导出');

  // 重新分章必须先预览再确认
  assert.ok(js.includes('rcPreview') && js.includes('rcApply'), '重分章要有预览与确认两个按钮');
  assert.ok(js.includes('confirm: true'), '应用时必须显式确认');

  // 来源信息（模块 4 要求展示站点 / 目录页 / 首次抓取 / 最后检查）
  for (const field of ['source_site', 'toc_url', 'first_fetched_at', 'last_checked_at']) {
    assert.ok(js.includes(field), `来源信息缺少 ${field}`);
  }

  // 目录必须是虚拟滚动
  assert.ok(js.includes('VirtualList'), '目录必须用虚拟滚动（禁止一次性渲染整本书）');

  const css = fs.readFileSync(path.join(ASSETS, 'pages.css'), 'utf8');
  for (const cls of ['.issue-list', '.state-dot-error', '.chapter-issue', '.rechapterize-panel']) {
    assert.ok(css.includes(cls), `缺少样式 ${cls}`);
  }
});

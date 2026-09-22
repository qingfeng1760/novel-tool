'use strict';
/**
 * s4-reader.test.js —— S4 阶段验收：阅读器 + 进度 / 书签 / 笔记（模块 5、6）。
 *
 * 对应 PRD §11 S4 与验收项 5、6：
 *   - 随便读到某处，关掉浏览器再打开，回到原位置（偏差不超过一段）
 *   - 关掉服务窗口再重启，书架、进度、书签、笔记全在
 * 以及模块 5 的性能约定：bootstrap 只回轻量目录，绝不一次性把整本带回来。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { startTestServer, expectOk, expectErr, rmrf } = require('./helpers/env');

const ROOT = path.resolve(__dirname, '..');
const WEB = path.join(ROOT, 'web');
const ASSETS = path.join(WEB, 'assets');

/** 造一本 5 章的书 */
async function seed(srv, options = {}) {
  const chapterCount = options.chapterCount || 5;
  const { book } = srv.ctx.library.create({
    title: options.title || '阅读测试书',
    author: options.author || '测试作者',
  });
  const chapters = [];
  for (let i = 1; i <= chapterCount; i++) {
    chapters.push({
      index: i,
      title: `第${i}章 标题${i}`,
      // 正文要够长，"章内偏移"才有意义（太短的章里偏移会立刻越界）
      content:
        `第${i}章的正文第一段。`.repeat(8) +
        '\n' +
        `第${i}章的正文第二段，长度用于计算章内比例。`.repeat(8),
    });
  }
  srv.ctx.library.writeChapters(book.book_id, chapters);
  return book;
}

// ============================================================ bootstrap

test('S4 · bootstrap 只回轻量目录，不把整本正文带回来（性能硬指标）', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());
  const book = await seed(srv, { chapterCount: 3000 });

  const started = Date.now();
  const boot = expectOk(t, await srv.get(`/api/reader/${book.book_id}/bootstrap`), 'bootstrap');
  const elapsed = Date.now() - started;

  assert.equal(boot.book.title, '阅读测试书');
  assert.equal(boot.toc.length, 3000);
  assert.ok(elapsed < 1000, `bootstrap 用了 ${elapsed}ms，太慢了`);

  // 轻量目录只允许有这几个字段，绝不能夹带正文
  for (const item of boot.toc.slice(0, 3)) {
    assert.deepEqual(Object.keys(item).sort(), ['char_count', 'index', 'is_ok', 'title']);
    assert.equal(item.content, undefined);
  }
  const raw = JSON.stringify(boot);
  assert.ok(raw.length < 400 * 1024, `bootstrap 返回了 ${raw.length} 字节，太重了`);

  assert.ok(boot.settings.fontSize > 0, '要带上全局阅读偏好');
  assert.equal(boot.position.chapter_index, 1);
  assert.equal(boot.position.mode, 'fresh');
  assert.deepEqual(boot.counts, { bookmarks: 0, notes: 0 });
});

test('S4 · 单章按需加载，带上下章指针与总数', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());
  const book = await seed(srv);

  const chapter = expectOk(t, await srv.get(`/api/reader/${book.book_id}/chapters/3`), '第 3 章');
  assert.equal(chapter.index, 3);
  assert.equal(chapter.title, '第3章 标题3');
  assert.ok(chapter.content.includes('第3章的正文第一段'));
  assert.equal(chapter.prev, 2);
  assert.equal(chapter.next, 4);
  assert.equal(chapter.total, 5);
  assert.equal(chapter.missing, false);

  const first = expectOk(t, await srv.get(`/api/reader/${book.book_id}/chapters/1`), '第 1 章');
  assert.equal(first.prev, null);
  const last = expectOk(t, await srv.get(`/api/reader/${book.book_id}/chapters/5`), '第 5 章');
  assert.equal(last.next, null);

  expectErr(t, await srv.get(`/api/reader/${book.book_id}/chapters/99`), 404, 'CHAPTER_NOT_FOUND', '越界');
  expectErr(t, await srv.get('/api/reader/不存在的书/bootstrap'), 404, 'BOOK_NOT_FOUND', '书不存在');
});

test('S4 · 章节正文文件缺失时如实说明，而不是给一个空白章', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());
  const book = await seed(srv);

  // 模拟正文文件被误删（清单里还有，磁盘上没有）
  srv.ctx.storage.remove(path.posix.join('books', book.book_id, 'chapters', '0003.txt'));

  const chapter = expectOk(t, await srv.get(`/api/reader/${book.book_id}/chapters/3`), '缺失章');
  assert.equal(chapter.missing, true);
  assert.equal(chapter.content, '');
  assert.ok(chapter.note.includes('重新抓取') || chapter.note.includes('重新导入'), '要告诉用户怎么补');
});

// ============================================================ 阅读偏好

test('S4 · 阅读偏好读写并落盘，重启后还在（换书不用重设）', async (t) => {
  const srv = await startTestServer();
  const book = await seed(srv);

  const defaults = expectOk(t, await srv.get('/api/settings/reader'), '默认偏好');
  assert.ok(defaults.fontSize > 0);
  assert.ok(['day', 'night', 'eye'].includes(defaults.theme));
  assert.ok(['scroll', 'page'].includes(defaults.mode));
  assert.ok(['serif', 'sans', 'mono', 'system'].includes(defaults.fontFamily));

  const saved = expectOk(
    t,
    await srv.request('PUT', '/api/settings/reader', { fontSize: 26, theme: 'night', mode: 'page', indent: 1.5 }),
    '保存偏好'
  );
  assert.equal(saved.fontSize, 26);
  assert.equal(saved.theme, 'night');
  assert.equal(saved.mode, 'page');

  const dataDir = srv.dataDir;
  const backupDir = srv.backupDir;
  await srv.close();

  const again = await startTestServer({ dataDir, backupDir });
  t.after(async () => {
    await again.close();
    rmrf(dataDir);
  });
  const reloaded = expectOk(t, await again.get('/api/settings/reader'), '重启后偏好');
  assert.equal(reloaded.fontSize, 26);
  assert.equal(reloaded.theme, 'night');
  assert.equal(reloaded.mode, 'page');

  // bootstrap 里也要带上这份偏好，阅读器一打开就是用户上次的排版
  const boot = expectOk(t, await again.get(`/api/reader/${book.book_id}/bootstrap`), '重启后 bootstrap');
  assert.equal(boot.settings.fontSize, 26);
  assert.equal(boot.settings.theme, 'night');
});

test('S4 · 离谱的排版参数会被夹回合理范围', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());

  const saved = expectOk(
    t,
    await srv.request('PUT', '/api/settings/reader', { fontSize: 999, lineHeight: 0.1, contentWidth: 99, indent: 99, theme: '乱填' }),
    '夹取'
  );
  assert.equal(saved.fontSize, 40);
  assert.equal(saved.lineHeight, 1.2);
  assert.equal(saved.contentWidth, 420);
  assert.equal(saved.indent, 4);
  assert.equal(saved.theme, 'day', '非法主题回落到日间');
});

// ============================================================ 进度与位置恢复

test('S4 · 进度读写带章内偏移与比例，并同步回书架（PRD §5.1）', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());
  const book = await seed(srv);

  const written = expectOk(
    t,
    await srv.post('/api/reading/progress', {
      book_id: book.book_id,
      chapter_index: 3,
      char_offset: 20,
      chapter_ratio: 0.5,
      percent: 0.5,
    }),
    '写进度'
  );
  assert.equal(written.progress.char_offset, 20);
  assert.equal(written.book.read_chapters, 3, '书架的已读章数要跟着更新');
  assert.equal(written.book.status, '在读');
  assert.ok(written.book.last_read_at, '最后阅读时间要更新');

  const read = expectOk(t, await srv.get(`/api/reading/progress?book_id=${book.book_id}`), '读进度');
  assert.equal(read.progress.char_offset, 20);
  assert.equal(read.position.mode, 'exact');
  assert.equal(read.position.char_offset, 20);

  // 首页的「继续阅读」也要指向这个位置
  const cont = expectOk(t, await srv.get('/api/library/continue'), '继续阅读');
  assert.equal(cont.chapter_index, 3);
  assert.ok(cont.reader_url.includes('ch=3'));
});

test('S4 · 位置恢复：正常情况用章内偏移原样回位', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());
  const book = await seed(srv);

  await srv.post('/api/reading/progress', {
    book_id: book.book_id,
    chapter_index: 4,
    char_offset: 30,
    chapter_ratio: 0.6,
    percent: 0.7,
  });

  const position = srv.ctx.reading.resolvePosition(book.book_id);
  assert.equal(position.chapter_index, 4);
  assert.equal(position.char_offset, 30);
  assert.equal(position.mode, 'exact');
});

test('S4 · 位置恢复：章内容长度变了，按章内比例重定位（不回到开头）', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());
  const book = await seed(srv);

  // 原文第 2 章较长，读到 60% 处
  await srv.post('/api/reading/progress', {
    book_id: book.book_id,
    chapter_index: 2,
    char_offset: 500,
    chapter_ratio: 0.6,
    percent: 0.3,
  });

  // 重新抓取/重分章之后第 2 章变短了，原来的 500 已经越界
  srv.ctx.library.writeChapter(book.book_id, 2, '短'.repeat(100), { title: '第2章 标题2' });

  const position = srv.ctx.reading.resolvePosition(book.book_id);
  assert.equal(position.mode, 'by-ratio');
  assert.equal(position.chapter_index, 2, '不能回到第一章');
  assert.equal(position.char_offset, 60, '100 字的 60% 应该是 60');
  assert.ok(position.note.includes('比例'));
});

test('S4 · 位置恢复：章节总数变少了，按全书比例重新定位', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());
  const book = await seed(srv, { chapterCount: 10 });

  await srv.post('/api/reading/progress', {
    book_id: book.book_id,
    chapter_index: 10,
    char_offset: 0,
    chapter_ratio: 0,
    percent: 1,
  });

  // 这本书被重分章，只剩 4 章
  srv.ctx.library.setChapters(
    book.book_id,
    Array.from({ length: 4 }, (_, i) => ({ index: i + 1, title: `第${i + 1}章`, char_count: 10 }))
  );

  const position = srv.ctx.reading.resolvePosition(book.book_id);
  assert.equal(position.mode, 'by-percent');
  assert.equal(position.chapter_index, 4, '读完了的比例应该落到最后一章');
  assert.ok(position.note.includes('章节数变了'));
});

test('S4 · 关掉浏览器再打开能回到原位置（验收项 5）', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());
  const book = await seed(srv);

  // 模拟读到第 4 章 35 字处，然后页面被关掉（进度已经落盘）
  await srv.post('/api/reading/progress', {
    book_id: book.book_id,
    chapter_index: 4,
    char_offset: 35,
    chapter_ratio: 0.62,
    percent: 0.7,
  });

  // 重新打开阅读器 = 重新 bootstrap
  const boot = expectOk(t, await srv.get(`/api/reader/${book.book_id}/bootstrap`), '重开');
  assert.equal(boot.position.chapter_index, 4);
  assert.equal(boot.position.char_offset, 35);

  const chapter = expectOk(t, await srv.get(`/api/reader/${book.book_id}/chapters/4`), '取第 4 章');
  // 偏差不超过一段：偏移落在第 4 章正文范围内
  assert.ok(boot.position.char_offset <= chapter.content.length);
});

// ============================================================ 书签

test('S4 · 书签增删改查，重复加不产生两条', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());
  const book = await seed(srv);

  const first = expectOk(
    t,
    await srv.post('/api/bookmarks', { book_id: book.book_id, chapter_index: 2, char_offset: 15 }),
    '加书签'
  );
  assert.equal(first.created, true);

  const again = expectOk(
    t,
    await srv.post('/api/bookmarks', { book_id: book.book_id, chapter_index: 2, char_offset: 15 }),
    '重复加'
  );
  assert.equal(again.created, false);
  assert.equal(expectOk(t, await srv.get(`/api/bookmarks?book_id=${book.book_id}`), '列表').total, 1);

  const id = first.bookmark.id;
  const patched = expectOk(t, await srv.request('PATCH', `/api/bookmarks/${id}`, { content: '这里写得好' }), '改备注');
  assert.equal(patched.content, '这里写得好');

  expectOk(t, await srv.request('DELETE', `/api/bookmarks/${id}`), '删书签');
  assert.equal(expectOk(t, await srv.get('/api/bookmarks'), '空列表').total, 0);
  expectErr(t, await srv.request('DELETE', `/api/bookmarks/${id}`), 404, 'BOOKMARK_NOT_FOUND', '重复删');
});

// ============================================================ 笔记

test('S4 · 笔记：摘录 + 备注 + 所在章节，列表能跳回', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());
  const book = await seed(srv);

  const note = expectOk(
    t,
    await srv.post('/api/notes', {
      book_id: book.book_id,
      chapter_index: 3,
      char_offset: 8,
      selected_text: '第3章的正文第一段。',
      content: '这句话记一下',
    }),
    '新建笔记'
  );
  assert.ok(note.id.startsWith('note_'));
  assert.equal(note.selected_text, '第3章的正文第一段。');
  assert.equal(note.content, '这句话记一下');

  const list = expectOk(t, await srv.get(`/api/notes?book_id=${book.book_id}`), '笔记列表');
  assert.equal(list.total, 1);
  assert.equal(list.notes[0].chapter_index, 3);

  expectOk(t, await srv.request('PATCH', `/api/notes/${note.id}`, { content: '改过之后的备注' }), '改笔记');
  assert.equal(srv.ctx.reading.getNote(note.id).content, '改过之后的备注');

  expectErr(t, await srv.post('/api/notes', { book_id: book.book_id, chapter_index: 1 }), 400, 'NOTE_EMPTY', '空笔记');

  expectOk(t, await srv.request('DELETE', `/api/notes/${note.id}`), '删笔记');
  assert.equal(expectOk(t, await srv.get('/api/notes'), '空').total, 0);
});

// ============================================================ 跳章历史

test('S4 · 跳章历史能像浏览器后退一样连续返回上一处', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());
  const book = await seed(srv);

  for (const index of [2, 4, 5]) {
    expectOk(
      t,
      await srv.post('/api/reading/history', { book_id: book.book_id, chapter_index: index, char_offset: 0 }),
      `记录第 ${index} 章`
    );
  }

  const list = expectOk(t, await srv.get(`/api/reading/history?book_id=${book.book_id}`), '历史');
  assert.equal(list.length, 3);
  assert.equal(list[0].chapter_index, 5, '最新的排最前');

  const back1 = expectOk(t, await srv.post('/api/reading/history', { book_id: book.book_id, action: 'back' }), '后退 1');
  assert.equal(back1.entry.chapter_index, 4);
  const back2 = expectOk(t, await srv.post('/api/reading/history', { book_id: book.book_id, action: 'back' }), '后退 2');
  assert.equal(back2.entry.chapter_index, 2);
  const back3 = expectOk(t, await srv.post('/api/reading/history', { book_id: book.book_id, action: 'back' }), '后退 3');
  assert.equal(back3.entry, null);
  assert.ok(back3.message.includes('最开始'), '到头了要说明白');
});

// ============================================================ 阅读时长

test('S4 · 阅读时长按书 / 按天统计并上报', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());
  const book = await seed(srv);

  const today = srv.ctx.reading.localDay(new Date());
  const result = expectOk(
    t,
    await srv.post('/api/reading/session', {
      book_id: book.book_id,
      started_at: new Date(Date.now() - 90000).toISOString(),
      ended_at: new Date().toISOString(),
      duration_ms: 90000,
    }),
    '上报时长'
  );
  assert.equal(result.session.duration_ms, 90000);
  assert.equal(result.session.day, today);
  assert.equal(result.overview.totalMs, 90000);

  const stats = expectOk(t, await srv.get(`/api/reading/stats?book_id=${book.book_id}`), '统计');
  assert.equal(stats.totalMs, 90000);
  assert.equal(stats.byBook[0].book_id, book.book_id);
  assert.equal(stats.byDay[0].day, today);
  assert.equal(stats.weekMs, 90000);

  // 首页底部概览用的就是这份数据
  const shelfStats = expectOk(t, await srv.get('/api/library/stats'), '书架概览');
  assert.equal(shelfStats.totalMs, 90000);
  assert.equal(shelfStats.weekMs, 90000);
});

// ============================================================ 进度导出 / 导入

test('S4 · 阅读进度可以单独导出、再导入（换电脑时用）', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());
  const book = await seed(srv);

  await srv.post('/api/reading/progress', {
    book_id: book.book_id,
    chapter_index: 3,
    char_offset: 22,
    chapter_ratio: 0.4,
    percent: 0.6,
  });

  const res = await fetch(`${srv.url}/api/reading/progress/export`);
  assert.equal(res.status, 200);
  assert.ok((res.headers.get('content-disposition') || '').includes('attachment'));
  const payload = await res.json();
  assert.equal(payload.format, 'novel-tool-reading-progress');
  assert.equal(payload.formatVersion, 1);
  assert.equal(payload.syncState, 'local');
  assert.equal(payload.books.length, 1);
  assert.equal(payload.books[0].title, '阅读测试书', '要带上书名，换电脑后能对上号');

  // 清掉进度再导入，模拟"新电脑上把进度恢复回来"
  srv.ctx.reading.removeProgress(book.book_id);
  assert.equal(srv.ctx.reading.getProgress(book.book_id), null);

  const imported = expectOk(t, await srv.post('/api/reading/progress/import', payload), '导入进度');
  assert.equal(imported.imported, 1);
  assert.equal(imported.skipped, 0);
  const restored = srv.ctx.reading.getProgress(book.book_id);
  assert.equal(restored.chapter_index, 3);
  assert.equal(restored.char_offset, 22);

  // 书架里没有的书要跳过，而不是生成孤儿进度
  const withGhost = {
    ...payload,
    books: [...payload.books, { book_id: 'ghost0000000', chapter_index: 1, percent: 0.1 }],
  };
  const skipped = expectOk(t, await srv.post('/api/reading/progress/import', withGhost), '带孤儿条目导入');
  assert.equal(skipped.imported, 1);
  assert.equal(skipped.skipped, 1);
  assert.equal(srv.ctx.reading.getProgress('ghost0000000'), null);

  expectErr(t, await srv.post('/api/reading/progress/import', { 随便: '什么' }), 400, 'BAD_PROGRESS_FILE', '坏文件');
});

// ============================================================ 重启后全在

test('S4 · 重启服务后进度、书签、笔记、时长全在（验收项 6）', async (t) => {
  const srv = await startTestServer();
  const book = await seed(srv);

  await srv.post('/api/reading/progress', {
    book_id: book.book_id,
    chapter_index: 3,
    char_offset: 18,
    chapter_ratio: 0.3,
    percent: 0.5,
  });
  await srv.post('/api/bookmarks', { book_id: book.book_id, chapter_index: 3, char_offset: 18, content: '书签备注' });
  await srv.post('/api/notes', {
    book_id: book.book_id,
    chapter_index: 2,
    char_offset: 4,
    selected_text: '摘录',
    content: '笔记内容',
  });
  await srv.post('/api/reading/session', {
    book_id: book.book_id,
    started_at: new Date().toISOString(),
    duration_ms: 45000,
  });

  const dataDir = srv.dataDir;
  const backupDir = srv.backupDir;
  await srv.close();

  const again = await startTestServer({ dataDir, backupDir });
  t.after(async () => {
    await again.close();
    rmrf(dataDir);
  });

  const boot = expectOk(t, await again.get(`/api/reader/${book.book_id}/bootstrap`), '重启后 bootstrap');
  assert.equal(boot.position.chapter_index, 3);
  assert.equal(boot.position.char_offset, 18);
  assert.equal(boot.counts.bookmarks, 1);
  assert.equal(boot.counts.notes, 1);

  const stats = expectOk(t, await again.get('/api/reading/stats'), '重启后统计');
  assert.equal(stats.totalMs, 45000);

  const shelf = expectOk(t, await again.get('/api/library'), '重启后书架');
  const item = shelf.piles['全部'].find((b) => b.book_id === book.book_id);
  assert.equal(item.read_chapters, 3);
  assert.equal(item.status, '在读');
});

// ============================================================ 阅读器前端产物

test('S4 · reader.html 该有的零件都在（目录抽屉 / 标记侧栏 / 排版条 / 翻页热区）', () => {
  const html = fs.readFileSync(path.join(WEB, 'reader.html'), 'utf8');
  for (const id of [
    'readerContent',
    'readerScroller',
    'tocDrawer',
    'tocSearch',
    'markDrawer',
    'typoBar',
    'setFontSize',
    'setLineHeight',
    'setWidth',
    'setIndent',
    'setFontFamily',
    'themeSeg',
    'modeSeg',
    'btnPrevChapter',
    'btnNextChapter',
    'btnTop',
    'btnBottom',
    'btnBookmark',
    'btnFocus',
    'selectionTools',
    'pagePrev',
    'pageNext',
  ]) {
    assert.ok(html.includes(`id="${id}"`), `reader.html 缺少 #${id}`);
  }
  assert.ok(html.includes('data-theme="day"'));
  assert.ok(html.includes('data-mode="scroll"'));
  // 三套主题的按钮都要有
  for (const theme of ['day', 'night', 'eye']) {
    assert.ok(html.includes(`data-theme="${theme}"`), `缺少 ${theme} 主题按钮`);
  }
  // 两种模式
  for (const mode of ['scroll', 'page']) {
    assert.ok(html.includes(`data-mode="${mode}"`), `缺少 ${mode} 模式按钮`);
  }
  // 快捷键说明要在界面上写清楚
  assert.ok(html.includes('快捷键'));
  assert.ok(!/https?:\/\/(?!127\.0\.0\.1|localhost)/.test(html), '不许有外链资源');
});

test('S4 · reader.js 落实了模块 5 的硬要求（按需加载 / 节流 / 快捷键 / 记忆位置）', () => {
  const js = fs.readFileSync(path.join(ASSETS, 'reader.js'), 'utf8');

  // 按需加载：三章窗口
  assert.ok(js.includes('ensureWindow'), '缺少章节窗口管理');
  assert.ok(/\[aroundIndex - 1, aroundIndex, aroundIndex \+ 1\]/.test(js), '滚动模式必须只保留当前章及前后各一章');
  assert.ok(js.includes('state.cache'), '缺少章节缓存');
  assert.ok(js.includes('fetchChapter(index).catch'), '缺少前后章预取');

  // 进度节流 ≤ 2 秒
  assert.ok(js.includes('PROGRESS_THROTTLE_MS = 2000'), '节流间隔必须是 2000 毫秒');
  assert.ok(js.includes('char_offset'), '进度要记章内偏移');
  assert.ok(js.includes('chapter_ratio'), '进度要记章内比例（章长变了才能重定位）');

  // 快捷键表
  for (const key of ['ArrowLeft', 'ArrowRight', 'PageDown', 'PageUp', "'t'", "'+'", "'-'", "'f'", 'Escape', "'b'"]) {
    assert.ok(js.includes(key), `快捷键缺少 ${key}`);
  }
  assert.ok(js.includes("case ' '"), '空格翻页要支持');

  // 切模式停在原位置
  assert.ok(/切模式要停在原位置/.test(js), '注释里要说明这个约定');
  assert.ok(/const pos = readPosition\(\)/.test(js));

  // 沉浸模式：收掉顶栏底栏并进系统全屏（源码里对应 body 的 dataset.focus）
  assert.ok(js.includes('dataset.focus'), '缺少沉浸模式');
  assert.ok(js.includes('requestFullscreen'), '沉浸要能进系统全屏');

  // 时长上报
  assert.ok(js.includes('/api/reading/session'));
  assert.ok(js.includes('beforeunload'), '关页面前要把进度钉死');
});

test('S4 · reader.css 定义了日间/夜间/护眼三套主题，夜间不是纯黑', () => {
  const css = fs.readFileSync(path.join(ASSETS, 'reader.css'), 'utf8');
  for (const theme of ['day', 'night', 'eye']) {
    assert.ok(css.includes(`body[data-theme='${theme}']`), `缺少 ${theme} 主题`);
  }
  // 夜间底色不能是纯黑（PRD 明确要求），也不要纯白
  const night = /body\[data-theme='night'\]\s*\{([\s\S]*?)\}/.exec(css);
  assert.ok(night, '取不到夜间主题定义');
  const block = night[1];
  assert.ok(!/#000\b|#000000\b/.test(block), '夜间底色不能用纯黑');
  assert.ok(!/#fff\b|#ffffff\b/i.test(block), '夜间不该出现纯白');
  // 护眼是米黄底
  assert.ok(/body\[data-theme='eye'\]/.test(css));

  // 排版参数走变量，才能实时生效
  for (const v of ['--reader-font-size', '--reader-line-height', '--reader-content-width', '--reader-indent', '--reader-font-family']) {
    assert.ok(css.includes(v), `缺少排版变量 ${v}`);
  }
  // 翻页模式的多列排版
  assert.ok(css.includes('column-width'), '翻页模式要用多列排版');
  assert.ok(css.includes("body[data-mode='page']"));
});

test('S4 · 阅读器页面与静态资源都能取到', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());

  for (const asset of ['/reader.html', '/assets/reader.js', '/assets/reader.css', '/assets/virtual-list.js']) {
    const res = await fetch(srv.url + asset);
    assert.equal(res.status, 200, `${asset} 取不到`);
  }
  const html = await (await fetch(`${srv.url}/reader.html`)).text();
  assert.ok(html.includes('小说工具'), '阅读器页面标题要对');
});

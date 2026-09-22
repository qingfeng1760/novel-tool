'use strict';
/**
 * s3-shelf.test.js —— S3 阶段验收：书架首页（模块 1）。
 *
 * 对应 PRD §11 S3 与验收项 2（部分）、6，以及 §3 / §6 的首页显示规则。
 * 除了接口行为，这里还检查前端产物的"该有的零件有没有"，
 * 因为首页的很多要求（继续阅读卡片、更新角标、三页签、空书架引导）是界面层的约定。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const { startTestServer, expectOk, expectErr, rmrf } = require('./helpers/env');

const ROOT = path.resolve(__dirname, '..');
const WEB = path.join(ROOT, 'web');
const ASSETS = path.join(WEB, 'assets');

/** 造几本书，返回 { srv, books } */
async function seed(srv) {
  const a = srv.ctx.library.create({ title: '剑来', author: '烽火戏诸侯', tags: ['仙侠'] }).book;
  srv.ctx.library.writeChapters(a.book_id, [
    { index: 1, title: '第一章 山间', content: '正文一。' },
    { index: 2, title: '第二章 出山', content: '正文二。' },
    { index: 3, title: '第三章 归乡', content: '正文三。' },
  ]);

  const b = srv.ctx.library.create({ title: '诡秘之主', author: '爱潜水的乌贼', source_site: 'example.com' }).book;
  srv.ctx.library.writeChapters(b.book_id, [
    { index: 1, title: '第一节', content: '正文。' },
    { index: 2, title: '第二节', content: '正文。' },
  ]);

  const c = srv.ctx.library.create({ title: '已读完的书' }).book;
  srv.ctx.library.writeChapter(c.book_id, 1, '正文。');
  srv.ctx.library.patch(c.book_id, { status: '已读完' });

  return { a, b, c };
}

// ============================================================ /api/library

test('S3 · /api/library 返回四个分堆与每本进度', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());
  const { a } = await seed(srv);

  // 给《剑来》留一条阅读记录，让它进「在读」
  srv.ctx.reading.setProgress({ book_id: a.book_id, chapter_index: 2, char_offset: 40, chapter_ratio: 0.5, percent: 0.5 });
  srv.ctx.reading.syncBookFromProgress(a.book_id);

  const data = expectOk(t, await srv.get('/api/library'), '分堆');
  assert.deepEqual(data.order, ['在读', '追更中', '已读完', '全部']);
  assert.equal(data.counts['全部'], 3);
  assert.ok(data.piles['在读'].some((x) => x.book_id === a.book_id));
  assert.ok(data.piles['已读完'].length === 1);

  const inPile = data.piles['在读'].find((x) => x.book_id === a.book_id);
  assert.ok(inPile.progress_percent > 0, '每本都要带上进度供封面进度条使用');
  assert.equal(inPile.update_badge, 0);
  assert.ok(inPile.progress, '进度条数据要带上');
});

test('S3 · 分堆内按最后阅读时间倒序，没读过的排在后面', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());
  const { a, b } = await seed(srv);

  srv.ctx.reading.setProgress({ book_id: a.book_id, chapter_index: 1 });
  srv.ctx.reading.syncBookFromProgress(a.book_id);
  await new Promise((r) => setTimeout(r, 8));
  srv.ctx.reading.setProgress({ book_id: b.book_id, chapter_index: 1 });
  srv.ctx.reading.syncBookFromProgress(b.book_id);

  const data = expectOk(t, await srv.get('/api/library'), '分堆');
  const all = data.piles['全部'];
  assert.equal(all[0].book_id, b.book_id, '最近读的排最前');
  assert.equal(all[1].book_id, a.book_id);
});

test('S3 · 「追更中」堆把有待更新章节的书也算进来（更新角标）', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());
  const { a } = await seed(srv);

  // 追更检查发现新章节后只写标记（S9 的行为），这里直接模拟那个状态
  srv.ctx.library.patch(a.book_id, { status: '追更中', new_chapters: 3 });

  const data = expectOk(t, await srv.get('/api/library'), '分堆');
  const item = data.piles['追更中'].find((x) => x.book_id === a.book_id);
  assert.ok(item, '应该出现在「追更中」堆里');
  assert.equal(item.update_badge, 3, '封面右上角要能显示「+3 章」');
});

// ============================================================ 继续阅读

test('S3 · 没有阅读记录时「继续阅读」返回 null（界面据此隐藏整张卡片）', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());
  await seed(srv);

  const data = expectOk(t, await srv.get('/api/library/continue'), '继续阅读');
  assert.equal(data, null);
});

test('S3 · 有阅读记录时「继续阅读」带回书名、进度、第几章章节名与直达地址', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());
  const { a } = await seed(srv);

  srv.ctx.reading.setProgress({ book_id: a.book_id, chapter_index: 2, char_offset: 12, chapter_ratio: 0.4, percent: 0.4 });
  srv.ctx.reading.syncBookFromProgress(a.book_id);

  const data = expectOk(t, await srv.get('/api/library/continue'), '继续阅读');
  assert.ok(data);
  assert.equal(data.book.title, '剑来');
  assert.equal(data.chapter_index, 2);
  assert.equal(data.chapter_title, '第二章 出山');
  // 「上次读到 第 N 章 · 章节名」这句就是界面直接展示的那一行
  assert.equal(data.label, '第 2 章 · 第二章 出山');
  assert.ok(data.last_read_at);
  assert.ok(data.percent > 0);
  assert.ok(data.reader_url.includes('/reader.html?book='), '要能一键回到原位置');
  assert.ok(data.reader_url.includes('ch=2'));
});

// ============================================================ 底部概览

test('S3 · /api/library/stats 返回共 N 本、总时长、本周时长', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());
  const { a } = await seed(srv);

  const today = srv.ctx.reading.localDay(new Date());
  srv.ctx.reading.recordSession({ book_id: a.book_id, started_at: new Date().toISOString(), duration_ms: 120000, day: today });

  const stats = expectOk(t, await srv.get('/api/library/stats'), '概览');
  assert.equal(stats.bookCount, 3);
  assert.equal(stats.totalMs, 120000);
  assert.equal(stats.weekMs, 120000);
  assert.equal(stats.chapterCount, 6);
});

// ============================================================ 筛选与搜索

test('S3 · /api/books 支持状态/标签/站点/作者/关键词，可叠加', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());
  await seed(srv);

  const all = expectOk(t, await srv.get('/api/books'), '全部');
  assert.equal(all.total, 3);

  const byStatus = expectOk(t, await srv.get('/api/books?status=' + encodeURIComponent('已读完')), '按状态');
  assert.equal(byStatus.total, 1);

  const byTag = expectOk(t, await srv.get('/api/books?tag=' + encodeURIComponent('仙侠')), '按标签');
  assert.equal(byTag.total, 1);
  assert.equal(byTag.books[0].title, '剑来');

  const bySite = expectOk(t, await srv.get('/api/books?site=example.com'), '按站点');
  assert.equal(bySite.total, 1);

  const byAuthor = expectOk(t, await srv.get('/api/books?author=' + encodeURIComponent('爱潜水的乌贼')), '按作者');
  assert.equal(byAuthor.total, 1);

  // 书名即时搜索：本地匹配，输入即过滤
  const byQ = expectOk(t, await srv.get('/api/books?q=' + encodeURIComponent('剑')), '搜书名');
  assert.equal(byQ.total, 1);
  assert.equal(byQ.books[0].title, '剑来');

  // 叠加：作者 + 状态，应该互相求交
  const combined = expectOk(
    t,
    await srv.get(`/api/books?author=${encodeURIComponent('烽火戏诸侯')}&status=${encodeURIComponent('在读')}`),
    '叠加筛选'
  );
  assert.equal(combined.total, 0, '《剑来》还没读过，叠加后应该没有结果');
});

// ============================================================ 单本

test('S3 · 单本详情与 404 话术', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());
  const { a } = await seed(srv);

  const book = expectOk(t, await srv.get(`/api/books/${a.book_id}`), '单本');
  assert.equal(book.title, '剑来');
  assert.equal(book.chapters.length, 3);
  assert.ok(book.source_kind);

  const error = expectErr(t, await srv.get('/api/books/不存在的编号'), 404, 'BOOK_NOT_FOUND', '404');
  assert.ok(error.message.includes('不存在的编号'));
  assert.ok(error.hint.includes('书架'));
});

test('S3 · PATCH 重命名/改作者/加标签/改状态，并且落盘', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());
  const { a } = await seed(srv);

  const updated = expectOk(
    t,
    await srv.request('PATCH', `/api/books/${a.book_id}`, { title: '剑来（修改版）', tags: ['仙侠', '经典'], status: '在读' }),
    '改名'
  );
  assert.equal(updated.title, '剑来（修改版）');
  assert.deepEqual(updated.tags, ['仙侠', '经典']);
  assert.equal(updated.status, '在读');

  // 索引摘要也要跟着变，否则书架还显示旧名字
  const list = expectOk(t, await srv.get('/api/library'), '分堆');
  const item = list.piles['全部'].find((x) => x.book_id === a.book_id);
  assert.equal(item.title, '剑来（修改版）');

  expectErr(t, await srv.request('PATCH', `/api/books/${a.book_id}`, { title: '   ' }), 400, 'TITLE_REQUIRED', '空书名');
  expectErr(t, await srv.request('PATCH', `/api/books/${a.book_id}`, { 无关字段: 1 }), 400, 'NOTHING_TO_UPDATE', '无改动');
  expectErr(t, await srv.request('PATCH', '/api/books/不存在', { title: 'x' }), 404, 'BOOK_NOT_FOUND', '改不存在的书');
});

test('S3 · 从书架移除：索引删掉、正文进回收站（PRD §3）', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());
  const { a, c } = await seed(srv);

  const result = expectOk(t, await srv.request('DELETE', `/api/books/${a.book_id}?mode=trash`), '移除');
  assert.ok(result.trashed.startsWith('.trash/'));
  assert.equal(srv.ctx.library.get(a.book_id), null);
  assert.ok(
    fs.existsSync(path.join(srv.dataDir, result.trashed, 'chapters', '0001.txt')),
    '正文必须还在回收站里'
  );

  expectErr(t, await srv.get(`/api/books/${a.book_id}`), 404, 'BOOK_NOT_FOUND', '已移除');
  expectErr(t, await srv.request('DELETE', `/api/books/${a.book_id}`), 404, 'BOOK_NOT_FOUND', '重复移除');

  // 非法模式：必须在动数据之前就拦住
  expectErr(
    t,
    await srv.request('DELETE', `/api/books/${c.book_id}?mode=乱填`),
    400,
    'BAD_DELETE_MODE',
    '非法模式'
  );
  assert.ok(srv.ctx.library.get(c.book_id), '模式不对时这本书必须毫发无损');

  // 显式 purge：这一次才是真的删掉目录
  const purged = expectOk(t, await srv.request('DELETE', `/api/books/${c.book_id}?mode=purge`), '彻底删除');
  assert.equal(purged.trashed, null, 'purge 不进回收站');
  assert.equal(fs.existsSync(path.join(srv.dataDir, 'books', c.book_id)), false);
});

test('S3 · 导出这一本：TXT 能直接读，JSON 结构带格式标识', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());
  const { a } = await seed(srv);

  const txtRes = await fetch(`${srv.url}/api/books/${a.book_id}/export?format=txt`);
  assert.equal(txtRes.status, 200);
  assert.ok((txtRes.headers.get('content-type') || '').includes('text/plain'));
  const disposition = txtRes.headers.get('content-disposition') || '';
  assert.ok(disposition.includes("filename*=UTF-8''"), '中文书名要按 RFC 5987 编码，否则会乱码');
  assert.ok(disposition.includes(encodeURIComponent('剑来')), `文件名不对：${disposition}`);

  const text = await txtRes.text();
  assert.ok(text.startsWith('剑来'));
  assert.ok(text.includes('作者：烽火戏诸侯'));
  assert.ok(text.includes('第一章 山间'));
  assert.ok(text.includes('正文二'));

  const jsonRes = await fetch(`${srv.url}/api/books/${a.book_id}/export?format=json`);
  const payload = await jsonRes.json();
  assert.equal(payload.format, 'novel-tool-book');
  assert.equal(payload.formatVersion, 1);
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.syncState, 'local');
  assert.equal(payload.book.title, '剑来');
  assert.equal(payload.chapters.length, 3);
  assert.equal(payload.chapters[1].content, '正文二。', 'JSON 导出要带上正文，才能直接导入回来');

  expectErr(
    t,
    await srv.get(`/api/books/${a.book_id}/export?format=epub`),
    400,
    'BAD_EXPORT_FORMAT',
    '不支持的格式'
  );
});

test('S3 · 空书架：分堆全为 0、继续阅读为 null', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());

  const pile = expectOk(t, await srv.get('/api/library'), '空分堆');
  assert.equal(pile.counts['全部'], 0);
  assert.deepEqual(pile.piles['全部'], []);
  assert.equal(expectOk(t, await srv.get('/api/library/continue'), '空继续阅读'), null);

  const stats = expectOk(t, await srv.get('/api/library/stats'), '空概览');
  assert.equal(stats.bookCount, 0);
  assert.equal(stats.totalMs, 0);
});

test('S3 · 重启服务后书架与阅读进度原样还在（验收项 6）', async (t) => {
  const first = await startTestServer();
  const { a } = await seed(first);
  first.ctx.reading.setProgress({ book_id: a.book_id, chapter_index: 2, char_offset: 30, chapter_ratio: 0.3, percent: 0.3 });
  first.ctx.reading.syncBookFromProgress(a.book_id);
  const dataDir = first.dataDir;
  await first.close();

  // 用同一个数据目录重新起一次服务，等价于"关掉窗口再双击启动.bat"
  const second = await startTestServer({ dataDir, backupDir: first.backupDir });
  t.after(async () => {
    await second.close();
    rmrf(dataDir);
  });

  const pile = expectOk(t, await second.get('/api/library'), '重启后分堆');
  assert.equal(pile.counts['全部'], 3);

  const cont = expectOk(t, await second.get('/api/library/continue'), '重启后继续阅读');
  assert.ok(cont, '阅读记录必须还在');
  assert.equal(cont.book.title, '剑来');
  assert.equal(cont.chapter_index, 2);
});

// ============================================================ 前端产物检查

test('S3 · 首页 HTML 结构：顶栏只有书架/阅读器/加书这一层', () => {
  const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
  assert.ok(html.includes('id="view"'));
  assert.ok(html.includes('id="btnAddBook"'), '第一层必须有显眼的「加书」主按钮');
  assert.ok(html.includes('id="quickSearch"'), '要有书名搜索框');
  assert.ok(html.includes('/assets/app.js'));
  assert.ok(html.includes('/assets/pages.css'));
  // 硬约束 3：不许出现任何外链资源
  assert.ok(!/https?:\/\/(?!127\.0\.0\.1|localhost)/.test(html), '页面里不允许有外部地址');
  assert.ok(!html.includes('cdn.'), '不允许任何 CDN');
});

test('S3 · 首页 JS 里该有的零件都在（继续阅读 / 分堆 / 角标 / 三页签 / 空书架引导 / 右键菜单）', () => {
  const shelf = fs.readFileSync(path.join(ASSETS, 'views', 'shelf.js'), 'utf8');
  const addbook = fs.readFileSync(path.join(ASSETS, 'views', 'addbook.js'), 'utf8');

  // 1. 继续阅读大卡片，且没有记录时整张隐藏
  assert.ok(shelf.includes('continue-card'), '缺少「继续阅读」卡片');
  assert.ok(/renderContinueCard\(cont\)/.test(shelf));
  assert.ok(/if \(!cont\) return ''/.test(shelf), '没有阅读记录时必须隐藏整张卡片');
  assert.ok(shelf.includes('上次阅读'), '卡片要显示上次阅读时间');
  assert.ok(shelf.includes('continue-bar'), '卡片要有进度条');

  // 2. 分堆切换 + 加书主按钮
  assert.ok(shelf.includes('pile-tab'), '缺少分堆切换');
  assert.ok(shelf.includes('openAddBookDialog'), '缺少「加书」入口');

  // 3. 封面墙：书名、作者、细进度条、更新角标
  assert.ok(shelf.includes('cover-wall'), '缺少封面墙');
  assert.ok(shelf.includes('book-progress'), '缺少封面角上的细进度条');
  assert.ok(shelf.includes('book-badge'), '缺少更新角标');
  assert.ok(shelf.includes('book-author'), '缺少作者展示');

  // 4. 底部轻量数据概览
  assert.ok(shelf.includes('shelf-stats'), '缺少底部数据概览');
  assert.ok(shelf.includes('本周读了'), '概览要显示本周读了多久');

  // 5. 空书架引导：三张卡片分别对应三条加书路径
  assert.ok(addbook.includes('emptyGuideHtml'), '缺少空书架引导');
  assert.equal((addbook.match(/id: '(link|file|paste)'/g) || []).length, 3, '三条加书路径缺一不可');

  // 6. 单本右键菜单五项
  for (const act of ['open', 'rename', 'tags', 'export', 'remove']) {
    assert.ok(shelf.includes(`data-act="${act}"`), `右键菜单缺少 ${act}`);
  }
  assert.ok(shelf.includes('contextmenu'), '缺少右键处理');
  assert.ok(shelf.includes('touchstart'), '缺少长按处理');

  // 7. 书名即时搜索（本地匹配，输入即过滤）
  assert.ok(shelf.includes('shelf:filter'), '缺少即时搜索事件');

  // 8. 首页不该出现技术参数（界面分层纪律）
  assert.ok(!/版本号|schemaVersion|端口/.test(shelf), '首页代码里不该出现技术参数展示');
});

test('S3 · 前端所有 ES 模块语法正确（浏览器里不会因为一个逗号白屏）', () => {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) files.push(full);
    }
  };
  walk(ASSETS);
  assert.ok(files.length >= 6, `前端脚本数量不对：${files.length}`);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-esm-'));
  const broken = [];
  for (const file of files) {
    // 复制成 .mjs 后用 node --check 做纯语法解析：
    // 这能抓住括号不配对、注释写坏等"一打开就白屏"的问题，而且不会真的执行代码
    const target = path.join(tmpDir, path.basename(file).replace(/\.js$/, '.mjs'));
    fs.writeFileSync(target, fs.readFileSync(file));
    const result = spawnSync(process.execPath, ['--check', target], { encoding: 'utf8' });
    if (result.status !== 0) {
      broken.push(`${path.relative(ROOT, file)}: ${(result.stderr || '').split('\n')[0]}`);
    }
  }
  rmrf(tmpDir);
  assert.deepEqual(broken, [], '以下前端脚本语法有错：\n' + broken.join('\n'));
});

test('S3 · 服务端也能把新增的静态资源发出去', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());

  for (const asset of ['/assets/pages.css', '/assets/virtual-list.js', '/assets/views/shelf.js', '/assets/views/import.js']) {
    const res = await fetch(srv.url + asset);
    assert.equal(res.status, 200, `${asset} 应该能取到`);
  }
});

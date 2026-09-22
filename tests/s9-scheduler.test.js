'use strict';
/**
 * s9-scheduler.test.js —— S9 阶段验收：定时追更（只提示不下载）。
 *
 * 对应 PRD §11 S9 与验收项 11：
 *   - 追更检查发现新章节时只出角标，不自动下载
 * 以及模块 2 的其它要求：
 *   - 可以为每本书单独设置检查频率（每天 / 每 3 天 / 每周 / 手动），也可以整批设置
 *   - 能看到"这本书上次检查时间 / 下次检查时间"
 *   - 检查前同样要过合规自检，被拦截时不能改动任何数据
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const schedulerModule = require('../server/services/scheduler');
const { startTestServer, expectOk, expectErr } = require('./helpers/env');
const { createFakeSite } = require('./helpers/fake-site');

const ROOT = path.resolve(__dirname, '..');
const ASSETS = path.join(ROOT, 'web', 'assets');

/** 先抓一本进来（用假站点），返回 { site, srv, bookId } */
async function seedFetchedBook(t, siteOptions = {}) {
  const site = await createFakeSite({
    chapterCount: 10,
    bookTitle: '追更测试书',
    author: '作者',
    ...siteOptions,
  });
  const srv = await startTestServer();
  t.after(async () => {
    await site.close();
    await srv.close();
  });

  const probe = expectOk(t, await srv.post('/api/fetch/probe', { url: site.tocUrl }), '探测');
  const created = expectOk(t, await srv.post('/api/fetch/tasks', { url: site.tocUrl, probe }), '抓取');

  // 等抓完
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const task = expectOk(null, await srv.get(`/api/fetch/tasks/${created.task_id}`), '轮询');
    if (['done', 'failed', 'cancelled'].includes(task.status)) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 50));
  }

  return { site, srv, bookId: created.book_id };
}

/** 让站点多出 N 章（模拟作者更新） */
function appendChapters(site, count) {
  // 假站点的章节页是按 chapterCount 动态生成的，改大就行
  site.config.chapterCount += count;
}

// ============================================================ 频率与排期

test('S9 · 频率排期：每天 / 每 3 天 / 每周 各自算出正确的下次检查时间', () => {
  const base = new Date('2026-09-22T10:00:00.000Z');
  assert.equal(schedulerModule.addDays(base, 1).toISOString().slice(0, 10), '2026-09-23');
  assert.equal(schedulerModule.addDays(base, 3).toISOString().slice(0, 10), '2026-09-25');
  assert.equal(schedulerModule.addDays(base, 7).toISOString().slice(0, 10), '2026-09-29');
});

test('S9 · 可以给单本书设置追更频率，也可以整批设置', async (t) => {
  const { srv, bookId } = await seedFetchedBook(t);

  const one = expectOk(
    t,
    await srv.request('PUT', '/api/fetch/schedule', { book_ids: [bookId], mode: 'daily' }),
    '单本设置'
  );
  assert.equal(one.mode, 'daily');
  assert.equal(one.modeLabel, '每天');
  assert.ok(one.message.includes('每天'));
  const target = one.books[0];
  assert.equal(target.check_mode, 'daily');
  assert.ok(target.next_check_at, '设置频率后必须算出下次检查时间');

  // 手动的书手动检查，不排期
  const manual = expectOk(
    t,
    await srv.request('PUT', '/api/fetch/schedule', { book_ids: [bookId], mode: 'manual' }),
    '手动'
  );
  assert.equal(manual.books[0].next_check_at, null);

  // 批量
  const other = srv.ctx.library.create({ title: '另一本抓来的书', source_site: 'x.com', toc_url: 'http://x.com/toc' }).book;
  const many = expectOk(t, await srv.request('PUT', '/api/fetch/schedule', { all: true, mode: 'weekly' }), '批量');
  assert.equal(many.books.length, 2);
  assert.ok(many.message.includes('2 本书'));
  assert.equal(srv.ctx.library.get(other.book_id).check_mode, 'weekly');

  expectErr(
    t,
    await srv.request('PUT', '/api/fetch/schedule', { all: true, mode: '每小时' }),
    400,
    'BAD_CHECK_MODE',
    '非法频率'
  );
  expectErr(
    t,
    await srv.request('PUT', '/api/fetch/schedule', { mode: 'daily' }),
    400,
    'NO_SCHEDULE_TARGET',
    '没给目标'
  );
});

test('S9 · 状态总览能看到每本书的上次检查 / 下次检查时间', async (t) => {
  const { srv, bookId } = await seedFetchedBook(t);
  expectOk(t, await srv.request('PUT', '/api/fetch/schedule', { book_ids: [bookId], mode: 'daily' }), '设置');

  // 导入进来的书不能追更
  srv.ctx.library.create({ title: '导入的书' });

  const status = expectOk(t, await srv.get('/api/fetch/schedule/status'), '状态');
  assert.ok(status.checkModes.length === 4, '四种频率都要列出来');
  assert.equal(status.autoCheckEnabled, true);
  assert.equal(status.timerRunning, false, '测试环境不起定时器');

  const mine = status.books.find((b) => b.book_id === bookId);
  assert.equal(mine.schedulable, true);
  assert.equal(mine.check_mode_label, '每天');
  assert.equal(mine.last_checked_at, null, '还没检查过');
  assert.ok(mine.next_check_at);

  const imported = status.books.find((b) => b.title === '导入的书');
  assert.equal(imported.schedulable, false, '没有目录页的书不能追更');
});

// ============================================================ 检查更新

test('S9 · 发现新章节时只出角标和通知，绝不自动下载（验收项 11）', async (t) => {
  const { site, srv, bookId } = await seedFetchedBook(t);
  // 先设成每天检查，这样"下次检查时间"才有意义（默认是手动，不排期）
  expectOk(t, await srv.request('PUT', '/api/fetch/schedule', { book_ids: [bookId], mode: 'daily' }), '设置频率');

  const before = srv.ctx.library.get(bookId);
  assert.equal(before.total_chapters, 10);

  // 站点多出 3 章
  appendChapters(site, 3);
  site.reset();

  const result = expectOk(t, await srv.post('/api/fetch/schedule/check', { book_id: bookId }), '检查');
  assert.equal(result.checked, true);
  assert.equal(result.hasNew, true);
  assert.equal(result.newChapters.length, 3);
  assert.equal(result.siteChapters, 13);
  assert.equal(result.existingChapters, 10);
  assert.equal(result.needs_user_action, true);
  assert.ok(result.message.includes('3 章新内容'));
  assert.ok(result.hint.includes('点「更新」'), '要告诉用户怎么把新章节抓下来');

  // 关键：一次正文请求都没发出去
  assert.equal(site.countOf('/book/ch'), 0, '检查更新绝对不能下载正文');

  // 书架上出角标
  const after = srv.ctx.library.get(bookId);
  assert.equal(after.new_chapters, 3, '要写入待更新标记供封面出角标');
  assert.equal(after.status, '追更中');
  assert.equal(after.total_chapters, 10, '正文没变，章数不该变');
  assert.ok(after.last_checked_at);
  assert.ok(after.next_check_at);

  const pile = expectOk(t, await srv.get('/api/library'), '书架');
  const item = pile.piles['追更中'].find((b) => b.book_id === bookId);
  assert.ok(item, '有更新的书要出现在「追更中」堆里');
  assert.equal(item.update_badge, 3, '封面右上角要显示 +3 章');

  // 通知
  const notices = expectOk(t, await srv.get('/api/notifications?unread=true'), '通知');
  assert.equal(notices.unreadCount, 1);
  assert.equal(notices.notifications[0].book_id, bookId);
  assert.equal(notices.notifications[0].new_chapters, 3);
  assert.equal(notices.notifications[0].auto_downloaded, false, '通知里要写明没有自动下载');

  // 检查两次不会重复堆积通知
  expectOk(t, await srv.post('/api/fetch/schedule/check', { book_id: bookId }), '再检查一次');
  const again = expectOk(t, await srv.get('/api/notifications?unread=true'), '再取通知');
  assert.equal(again.unreadCount, 1, '同一本书的同类通知只留最新一条');
});

test('S9 · 用户点更新（重新抓取）之后，待更新标记会被清掉', async (t) => {
  const { site, srv, bookId } = await seedFetchedBook(t);
  appendChapters(site, 2);

  expectOk(t, await srv.post('/api/fetch/schedule/check', { book_id: bookId }), '检查');
  assert.equal(srv.ctx.library.get(bookId).new_chapters, 2);

  // 走抓取链路把新章节抓下来（重跑任务时会跳过已完成的章节）
  const probe = expectOk(t, await srv.post('/api/fetch/probe', { url: site.tocUrl }), '探测');
  const created = expectOk(t, await srv.post('/api/fetch/tasks', { url: site.tocUrl, probe }), '更新');
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const task = expectOk(null, await srv.get(`/api/fetch/tasks/${created.task_id}`), '轮询');
    if (['done', 'failed', 'cancelled'].includes(task.status)) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 50));
  }

  const book = srv.ctx.library.get(bookId);
  assert.equal(book.total_chapters, 12, '新章节应该被抓进来');
  assert.equal(book.new_chapters, 0, '更新之后角标要清掉');
});

test('S9 · 没有更新时如实说没有更新', async (t) => {
  const { srv, bookId } = await seedFetchedBook(t);

  const result = expectOk(t, await srv.post('/api/fetch/schedule/check', { book_id: bookId }), '检查');
  assert.equal(result.hasNew, false);
  assert.equal(result.newChapters.length, 0);
  assert.ok(result.message.includes('没有更新'));
  assert.equal(srv.ctx.library.get(bookId).new_chapters, 0);
});

test('S9 · 检查前同样要过合规自检，被拦截时不改动任何数据', async (t) => {
  const { site, srv, bookId } = await seedFetchedBook(t);
  const before = srv.ctx.library.get(bookId);

  // 让目录页被 robots 禁止
  site.config.robotsTxt = 'User-agent: *\nDisallow: /book\n';
  srv.ctx.compliance.clearRobotsCache();

  const result = expectOk(t, await srv.post('/api/fetch/schedule/check', { book_id: bookId }), '检查');
  assert.equal(result.checked, true);
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'robots');
  assert.ok(result.message.includes('被拦下'));
  assert.ok(result.hint.includes('Disallow') || result.hint.includes('规则'));

  const after = srv.ctx.library.get(bookId);
  assert.equal(after.new_chapters, before.new_chapters, '被拦截时不该改待更新标记');
  assert.ok(after.last_checked_at, '但检查时间是记上了（说明确实检查过）');
});

test('S9 · 导入的书没有目录页，检查时明确说明而不是报错', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());
  const { book } = srv.ctx.library.create({ title: '导入的书' });

  const result = expectOk(t, await srv.post('/api/fetch/schedule/check', { book_id: book.book_id }), '检查');
  assert.equal(result.checked, false);
  assert.equal(result.reason, 'no_toc_url');
  assert.ok(result.message.includes('没有记录目录页地址'));

  expectErr(
    t,
    await srv.post('/api/fetch/schedule/check', { book_id: '不存在的书' }),
    404,
    'BOOK_NOT_FOUND',
    '书不存在'
  );
});

test('S9 · 到点才检查：未到时间的书会被跳过，强制检查时才会看', async (t) => {
  const { srv, bookId } = await seedFetchedBook(t);

  // 每天检查一次，但下次检查时间排在明天 → 现在不该被检查
  expectOk(t, await srv.request('PUT', '/api/fetch/schedule', { book_ids: [bookId], mode: 'daily' }), '设置');

  const now = new Date();
  const due = await srv.ctx.scheduler.runDueChecks(now);
  assert.equal(due.checked, 0, '还没到点，不该检查');

  // 手工把手动模式的书也纳入强制检查
  const forced = await srv.ctx.scheduler.runDueChecks(now, { force: true });
  assert.equal(forced.checked, 1);
  assert.ok(forced.message.includes('1 本书'));

  // 把下次检查时间改到过去 → 到点了
  srv.ctx.library.patch(bookId, { next_check_at: new Date(Date.now() - 60000).toISOString() });
  const due2 = await srv.ctx.scheduler.runDueChecks(new Date());
  assert.equal(due2.checked, 1);
});

test('S9 · 通知可以标记已读', async (t) => {
  const { site, srv, bookId } = await seedFetchedBook(t);
  appendChapters(site, 1);
  expectOk(t, await srv.post('/api/fetch/schedule/check', { book_id: bookId }), '检查');

  assert.equal(expectOk(t, await srv.get('/api/notifications?unread=true'), '未读').unreadCount, 1);
  const after = expectOk(t, await srv.post('/api/notifications/read', {}), '标记已读');
  assert.equal(after.unreadCount, 0);
  assert.equal(after.notifications[0].read, true);

  // 通知要落盘，重启后还在
  assert.ok(srv.ctx.storage.exists('notifications.json'), '通知要落下盘');
});

test('S9 · 定时器：设置里关掉自动检查就不启定时器，手动检查仍然可用', async (t) => {
  const { srv, bookId } = await seedFetchedBook(t);

  const timer = srv.ctx.scheduler.start();
  assert.ok(timer, '默认应当能起定时器');
  srv.ctx.scheduler.stop();

  srv.ctx.settings.putFetch({ autoCheckUpdates: false });
  // 重新装配一个上下文，读到的就是新设置
  const running = srv.ctx.scheduler.start();
  assert.equal(running, null, '关了自动检查就不该起定时器');
  assert.equal(srv.ctx.scheduler.stop(), undefined);

  // 手动检查不受影响
  const result = expectOk(t, await srv.post('/api/fetch/schedule/check', { book_id: bookId }), '手动检查');
  assert.equal(result.checked, true);
});

test('S9 · 重启服务后追更设置与通知都还在', async (t) => {
  const { srv, bookId } = await seedFetchedBook(t);
  expectOk(t, await srv.request('PUT', '/api/fetch/schedule', { book_ids: [bookId], mode: 'weekly' }), '设置');
  srv.ctx.scheduler.pushNotification({ type: 'update', book_id: bookId, book_title: '追更测试书', message: '测试通知' });

  const dataDir = srv.dataDir;
  const backupDir = srv.backupDir;
  await srv.close();

  const again = await startTestServer({ dataDir, backupDir });
  t.after(async () => {
    await again.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const status = expectOk(t, await again.get('/api/fetch/schedule/status'), '重启后状态');
  const mine = status.books.find((b) => b.book_id === bookId);
  assert.equal(mine.check_mode, 'weekly');
  assert.ok(mine.next_check_at);

  const notices = expectOk(t, await again.get('/api/notifications?unread=true'), '重启后通知');
  assert.equal(notices.unreadCount, 1);
});

// ============================================================ 前端产物

test('S9 · 详情页有追更区，书架有通知条，且都写明"不会自动下载"', () => {
  const book = fs.readFileSync(path.join(ASSETS, 'views', 'book.js'), 'utf8');
  assert.ok(book.includes('/api/fetch/schedule'), '详情页缺少追更设置');
  assert.ok(book.includes('/api/fetch/schedule/check'), '缺少「立即检查」');
  assert.ok(book.includes('checkMode'), '缺少频率选择');
  assert.ok(book.includes('下次检查'), '要显示下次检查时间');
  assert.ok(book.includes('不会自动下载'), '要明确告诉用户不会自动下载');
  assert.ok(book.includes('newChapters'), '要把新章节列出来');

  const shelf = fs.readFileSync(path.join(ASSETS, 'views', 'shelf.js'), 'utf8');
  assert.ok(shelf.includes('/api/notifications'), '书架缺少通知');
  assert.ok(shelf.includes('notice-bar'), '缺少通知条');
  assert.ok(shelf.includes('只提示，没有自动下载'), '通知里要写明只提示不下载');

  const css = fs.readFileSync(path.join(ASSETS, 'pages.css'), 'utf8');
  for (const cls of ['.notice-bar', '.notice-item', '.notice-note']) {
    assert.ok(css.includes(cls), `缺少样式 ${cls}`);
  }
});

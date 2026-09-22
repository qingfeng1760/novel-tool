'use strict';
/**
 * s7-fetch.test.js —— S7 阶段验收：抓取控制台 + 合规自检（模块 2、§9）。
 *
 * 对应 PRD §11 S7 与验收项 8、9、10：
 *   - 贴一个目录页链接，能探测出结构、试抓 3 章给我确认（8）
 *   - 抓取中途关窗口，重跑不重抓已完成的章节（9）
 *   - 对 robots 禁止的站点发起抓取，被拒绝且有明确原因（10）
 *
 * 所有请求都打到本机的一个假小说站（tests/helpers/fake-site.js），
 * 不去碰任何真实站点 —— 既是合规要求，也让这些用例稳定可重复。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { startTestServer, expectOk, expectErr } = require('./helpers/env');
const { createFakeSite } = require('./helpers/fake-site');

const ROOT = path.resolve(__dirname, '..');
const ASSETS = path.join(ROOT, 'web', 'assets');

/** 等任务跑到终态（或超时） */
async function waitTask(srv, taskId, timeoutMs = 40000) {
  const started = Date.now();
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const task = expectOk(null, await srv.get(`/api/fetch/tasks/${taskId}`), '轮询任务');
    if (['done', 'failed', 'cancelled'].includes(task.status)) return task;
    if (Date.now() - started > timeoutMs) {
      throw new Error(`任务 ${taskId} 超时未结束，当前状态：${task.status}`);
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 60));
  }
}

// ============================================================ 合规自检

test('S7 · robots 明确禁止的路径会被拒绝，并指出具体是哪条规则（验收项 10）', async (t) => {
  const site = await createFakeSite();
  const srv = await startTestServer();
  t.after(async () => {
    await site.close();
    await srv.close();
  });

  const check = expectOk(t, await srv.get(`/api/fetch/compliance?url=${encodeURIComponent(site.privateUrl)}`), '合规');
  assert.equal(check.allowed, false);
  assert.equal(check.reason, 'robots');
  assert.equal(check.robots.known, true);
  assert.ok(check.robots.ruleText.length > 0, '必须说清楚命中了哪条规则');
  assert.ok(check.robots.ruleText.includes('Disallow'), `规则原文不对：${check.robots.ruleText}`);
  assert.ok(check.message.includes('robots.txt'));
  assert.ok(check.hint.includes('Disallow') || check.hint.includes('规则'));

  // 允许的路径要能通过
  const ok = expectOk(t, await srv.get(`/api/fetch/compliance?url=${encodeURIComponent(site.tocUrl)}`), '合规通过');
  assert.equal(ok.allowed, true);
  assert.equal(ok.reason, null);
  assert.ok(ok.robots.allowed);
});

test('S7 · 登录墙被识别并拒绝，不给"强制继续"的口子', async (t) => {
  const site = await createFakeSite();
  const srv = await startTestServer();
  t.after(async () => {
    await site.close();
    await srv.close();
  });

  const check = expectOk(t, await srv.get(`/api/fetch/compliance?url=${encodeURIComponent(site.loginUrl)}`), '登录墙');
  assert.equal(check.allowed, false);
  assert.equal(check.reason, 'login');
  assert.ok(check.login.detected);
  assert.ok(check.login.evidence.length > 0, '要列出识别到的特征');
  assert.ok(check.message.includes('登录'));
  assert.ok(!/仍要继续|强制|忽略风险/.test(JSON.stringify(check)), '不允许出现"强制继续"的选项');
});

test('S7 · 付费 / VIP 墙被识别并拒绝', async (t) => {
  const site = await createFakeSite();
  const srv = await startTestServer();
  t.after(async () => {
    await site.close();
    await srv.close();
  });

  const check = expectOk(t, await srv.get(`/api/fetch/compliance?url=${encodeURIComponent(site.vipUrl)}`), '付费墙');
  assert.equal(check.allowed, false);
  assert.equal(check.reason, 'paywall');
  assert.ok(check.paywall.detected);
  assert.ok(check.paywall.evidence.length > 0);
  assert.ok(check.hint.includes('粘贴正文'), '要给出可行的替代路径');
});

test('S7 · 非网页地址、坏地址直接给人话', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());

  const bad = expectOk(t, await srv.get(`/api/fetch/compliance?url=${encodeURIComponent('不是网址')}`), '坏地址');
  assert.equal(bad.allowed, false);
  assert.equal(bad.reason, 'bad_url');

  const ftp = expectOk(t, await srv.get(`/api/fetch/compliance?url=${encodeURIComponent('ftp://example.com/a')}`), 'ftp');
  assert.equal(ftp.allowed, false);

  expectErr(t, await srv.get('/api/fetch/compliance'), 400, 'NO_URL', '没给地址');
});

// ============================================================ 探测

test('S7 · 自动探测出目录区、章节链接、正文区和书名作者（验收项 8）', async (t) => {
  const site = await createFakeSite({ chapterCount: 12 });
  const srv = await startTestServer();
  t.after(async () => {
    await site.close();
    await srv.close();
  });

  const probe = expectOk(t, await srv.post('/api/fetch/probe', { url: site.tocUrl }), '探测');
  assert.equal(probe.ok, true);
  assert.equal(probe.provider, 'generic-web');
  assert.equal(probe.book.title, '测试小说', `书名没认出来：${probe.book.title}`);
  assert.equal(probe.book.author, '测试作者');
  assert.equal(probe.book.source_site, `127.0.0.1:${site.port}`);

  assert.equal(probe.toc.linkCount, 12, '应该认出 12 个章节链接');
  assert.equal(probe.toc.sample[0].title, '第1章 测试标题1');
  assert.ok(probe.toc.selector.length > 0);
  assert.ok(probe.toc.sample[0].url.includes('/book/ch1'), '章节链接要是绝对地址');

  assert.ok(probe.content.selector.length > 0, '要能认出正文区');
  assert.ok(probe.content.charCount > 20);
  assert.ok(probe.content.sampleText.includes('第 1 章的第一段'), `正文样例不对：${probe.content.sampleText.slice(0, 40)}`);
});

test('S7 · GBK 页面也能正确认出结构（编码按字节自己判）', async (t) => {
  const site = await createFakeSite({ chapterCount: 3, encoding: 'gbk' });
  const srv = await startTestServer();
  t.after(async () => {
    await site.close();
    await srv.close();
  });

  const probe = expectOk(t, await srv.post('/api/fetch/probe', { url: site.tocUrl }), 'GBK 探测');
  assert.equal(probe.ok, true);
  assert.ok(['GBK', 'GB18030'].includes(probe.encoding), `编码识别不对：${probe.encoding}`);
  assert.equal(probe.book.title, '测试小说', '中文不能变成乱码');
  assert.equal(probe.toc.linkCount, 3);
  assert.ok(probe.content.sampleText.includes('第 1 章的第一段'));
});

test('S7 · 手动点选候选区后重新探测（探测失败时的自助修复）', async (t) => {
  const site = await createFakeSite({ chapterCount: 5 });
  const srv = await startTestServer();
  t.after(async () => {
    await site.close();
    await srv.close();
  });

  const candidates = expectOk(t, await srv.post('/api/fetch/candidates', { url: site.tocUrl }), '候选区');
  assert.ok(candidates.toc.length > 0, '要给出候选目录区');
  assert.ok(candidates.toc[0].selector.length > 0);
  assert.ok(candidates.toc[0].sample.length > 0, '候选要带样例文字，用户才好判断');
  assert.ok(candidates.content.length > 0, '要给出候选正文区');
  assert.ok(candidates.content[0].sample.length > 0);
  assert.ok(candidates.chapter_url.includes('/book/ch'), '要顺带取一章来看正文区');

  // 用候选里的选择器手动探测
  const manual = expectOk(
    t,
    await srv.post('/api/fetch/probe/manual', {
      url: site.tocUrl,
      toc_selector: candidates.toc[0].selector,
      content_selector: candidates.content[0].selector,
    }),
    '手动探测'
  );
  assert.equal(manual.ok, true);
  assert.equal(manual.toc.selector, candidates.toc[0].selector);
  assert.equal(manual.content.selector, candidates.content[0].selector);
  assert.equal(manual.toc.linkCount, 5);

  expectErr(t, await srv.post('/api/fetch/probe/manual', { url: site.tocUrl }), 400, 'NO_SELECTOR', '没给选择器');
  const notFound = expectOk(
    t,
    await srv.post('/api/fetch/probe/manual', { url: site.tocUrl, toc_selector: '#根本不存在' }),
    '选择器找不到'
  );
  assert.equal(notFound.ok, false);
  assert.equal(notFound.reason, 'toc_selector_not_found');
  assert.ok(notFound.hint.includes('候选'), '要引导用户去点选候选');
});

test('S7 · 试抓前 3 章：正文干净，被剔除的广告行会列出来（验收项 8）', async (t) => {
  const site = await createFakeSite({ chapterCount: 8 });
  const srv = await startTestServer();
  t.after(async () => {
    await site.close();
    await srv.close();
  });

  const probe = expectOk(t, await srv.post('/api/fetch/probe', { url: site.tocUrl }), '探测');
  const preview = expectOk(
    t,
    await srv.post('/api/fetch/probe/preview', { probe, count: 3 }),
    '试抓预览'
  );

  assert.equal(preview.count, 3);
  for (const chapter of preview.chapters) {
    assert.ok(chapter.preview.length > 20, '每章都要有正文预览');
    assert.ok(chapter.preview.includes('第一段正文'));
    assert.ok(!chapter.preview.includes('请记住本站域名'), '站点推广行要在试抓阶段就被剔除');
    assert.ok(!chapter.preview.includes('下一章'), '导航文字不该出现在正文里');
    assert.ok(chapter.charCount > 20);
  }
  assert.ok(
    preview.chapters[0].removed.some((r) => r.reason === '站点推广语'),
    '要如实报告剔除了什么，供用户抽查'
  );

  expectErr(t, await srv.post('/api/fetch/probe/preview', {}), 400, 'NEED_PROBE_FIRST', '没探测就试抓');
});

// ============================================================ 整本抓取

test('S7 · 整本抓取：任务跑完、章节落库、书架能看到', async (t) => {
  const site = await createFakeSite({ chapterCount: 12 });
  const srv = await startTestServer();
  t.after(async () => {
    await site.close();
    await srv.close();
  });

  const created = expectOk(t, await srv.post('/api/fetch/tasks', { url: site.tocUrl }), '创建任务');
  assert.ok(created.task_id, '长任务要返回 task_id');
  assert.equal(created.total, 12);

  const task = await waitTask(srv, created.task_id);
  assert.equal(task.status, 'done', `任务没成功：${JSON.stringify(task.error)}`);
  assert.equal(task.progress.done, 12);
  assert.equal(task.progress.failed, 0);
  assert.ok(task.timing.elapsedMs >= 0);

  const book = srv.ctx.library.get(created.book_id);
  assert.equal(book.title, '测试小说');
  assert.equal(book.total_chapters, 12);
  assert.equal(book.fetch_status, '完成');
  assert.equal(book.source_kind, 'web');
  assert.equal(book.toc_url, site.tocUrl);

  const content = srv.ctx.library.readChapterText(created.book_id, 5);
  assert.ok(content.includes('第 5 章的第一段正文'));
  assert.ok(!content.includes('请记住本站域名'), '广告行不该落进正文');

  // 书架首页上能看到这本书
  const pile = expectOk(t, await srv.get('/api/library'), '书架');
  assert.ok(pile.piles['全部'].some((b) => b.book_id === created.book_id));

  // 抓完之后立刻能搜到
  const found = expectOk(t, await srv.get(`/api/search?q=${encodeURIComponent('第 5 章的第一段正文')}`), '搜索');
  assert.ok(found.results.length >= 1, '抓完的章节要已经进索引');
});

test('S7 · 抓取报告：成功失败章数、原因归类、被剔除片段、分页合并次数', async (t) => {
  const site = await createFakeSite({ chapterCount: 10, paginateChapters: 2 });
  const srv = await startTestServer();
  t.after(async () => {
    await site.close();
    await srv.close();
  });

  const created = expectOk(t, await srv.post('/api/fetch/tasks', { url: site.tocUrl }), '创建任务');
  await waitTask(srv, created.task_id);

  const report = expectOk(t, await srv.get(`/api/fetch/tasks/${created.task_id}/report`), '报告');
  assert.equal(report.total, 10);
  assert.equal(report.success, 10);
  assert.equal(report.failed, 0);
  assert.ok(report.paginationMerges >= 2, `分页合并次数不对：${report.paginationMerges}`);
  assert.ok(report.removedCount > 0, '要报告剔除了多少处疑似广告文本');
  assert.ok(report.removedSamples.length > 0, '要列出被剔除的片段供抽查');
  assert.ok(report.removedSamples[0].reason.length > 0);
  assert.ok(report.removedSamples[0].snippet.length > 0);
  assert.ok(report.elapsedMs >= 0);
  assert.ok(report.limiter.intervalMs >= 0);

  // 第二章的第二页内容要真的被接上
  const chapter2 = srv.ctx.library.readChapterText(created.book_id, 2);
  assert.ok(chapter2.includes('续页的内容'), '分页内容必须被合并进来');
});

test('S7 · 单章失败不中断整个任务，失败章可单独重试', async (t) => {
  const site = await createFakeSite({ chapterCount: 8, failChapters: [3], emptyChapters: [6] });
  const srv = await startTestServer();
  t.after(async () => {
    await site.close();
    await srv.close();
  });

  const created = expectOk(t, await srv.post('/api/fetch/tasks', { url: site.tocUrl }), '创建任务');
  const task = await waitTask(srv, created.task_id);

  assert.equal(task.status, 'done', '有章节失败也要把任务跑完');
  assert.equal(task.progress.total, 8);
  assert.equal(task.progress.failed, 2, '第 3 章（500）和第 6 章（空内容）应该失败');
  assert.equal(task.progress.done, 6, '剩下 6 章应该抓到');

  const book = srv.ctx.library.get(created.book_id);
  assert.equal(book.fetch_status, '部分失败');
  assert.equal(book.chapters[2].is_ok, false);
  assert.equal(book.chapters[5].is_ok, false);
  assert.equal(book.chapters[0].is_ok, true, '其他章节要正常抓到');

  const report = expectOk(t, await srv.get(`/api/fetch/tasks/${created.task_id}/report`), '报告');
  assert.equal(report.failed, 2);
  assert.ok(report.reasonSummary.length >= 1, '失败原因要归类');
  assert.ok(report.failures.length === 2);
  for (const failure of report.failures) {
    assert.ok(failure.index >= 1);
    assert.ok(failure.message.length > 0);
    assert.ok(failure.attempts >= 1);
  }

  // 让假站点恢复正常，再单章重试
  site.config.failChapters = [];
  site.config.emptyChapters = [];
  const retried = expectOk(
    t,
    await srv.post(`/api/fetch/tasks/${created.task_id}/retry`, { chapter_index: 3 }),
    '单章重试'
  );
  assert.equal(retried.retried, 1);
  assert.equal(retried.failed, 0, `重试仍失败：${JSON.stringify(retried.failures)}`);
  assert.equal(srv.ctx.library.get(created.book_id).chapters[2].is_ok, true);

  // 再重试剩下那个失败章
  const rest = expectOk(t, await srv.post(`/api/fetch/tasks/${created.task_id}/retry`, {}), '重试全部失败章');
  assert.equal(rest.retried, 1);
  assert.equal(srv.ctx.library.get(created.book_id).fetch_status, '完成');
});

test('S7 · 断点续抓：重跑任务不会重抓已经完成的章节（验收项 9）', async (t) => {
  const site = await createFakeSite({ chapterCount: 10 });
  const srv = await startTestServer();
  t.after(async () => {
    await site.close();
    await srv.close();
  });

  // 先自己探测一次（探测本身会取第一章来看正文区），之后就把它直接传给任务，
  // 这样请求计数才干净、能精确核对"哪些章真的被请求了"
  const probe = expectOk(t, await srv.post('/api/fetch/probe', { url: site.tocUrl }), '探测');
  site.reset();

  const first = expectOk(t, await srv.post('/api/fetch/tasks', { url: site.tocUrl, probe }), '第一次抓取');
  await waitTask(srv, first.task_id);
  assert.equal(site.countOf('/book/ch'), 10, '第一次应该把 10 章都抓一遍');

  // 模拟"抓取中途关窗口后重跑"：重新发一次同样的抓取
  site.reset();
  const second = expectOk(t, await srv.post('/api/fetch/tasks', { url: site.tocUrl, probe }), '第二次抓取');
  const task2 = await waitTask(srv, second.task_id);

  assert.equal(second.book_id, first.book_id, '同一本书必须落到同一个 book_id，不能变成两条');
  assert.equal(srv.ctx.library.list().length, 1, '书架上只能有一本');
  assert.equal(site.countOf('/book/ch'), 0, '已经抓好的章节不能再抓一遍');
  assert.equal(task2.progress.done, 10, '跳过也算已处理');
  assert.equal(task2.progress.failed, 0);

  const report = expectOk(t, await srv.get(`/api/fetch/tasks/${second.task_id}/report`), '第二次报告');
  assert.equal(report.skipped, 10, '报告里要说明跳过了多少章');
});

test('S7 · 暂停 / 继续 / 取消，取消之后已经抓到的章节必须保留', async (t) => {
  const site = await createFakeSite({ chapterCount: 40 });
  const srv = await startTestServer();
  t.after(async () => {
    await site.close();
    await srv.close();
  });

  const created = expectOk(t, await srv.post('/api/fetch/tasks', { url: site.tocUrl }), '创建任务');

  // 先让它真的抓几章，这样"取消后内容还在"才验证得有意义
  const started = Date.now();
  let current = null;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    current = expectOk(null, await srv.get(`/api/fetch/tasks/${created.task_id}`), '看进度');
    if (current.progress.done >= 2 || Date.now() - started > 8000) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 40));
  }

  const paused = expectOk(t, await srv.post(`/api/fetch/tasks/${created.task_id}/pause`, {}), '暂停');
  assert.equal(paused.status, 'paused');
  assert.ok(paused.message.includes('保留'));

  const resumed = expectOk(t, await srv.post(`/api/fetch/tasks/${created.task_id}/resume`, {}), '继续');
  assert.equal(resumed.status, 'running');

  expectOk(t, await srv.post(`/api/fetch/tasks/${created.task_id}/cancel`, {}), '取消');

  const task = await waitTask(srv, created.task_id);
  assert.equal(task.status, 'cancelled');

  // 取消不等于清空：已经抓到的章节要保留
  const book = srv.ctx.library.get(created.book_id);
  assert.ok(book.chapters.some((ch) => ch.is_ok), '取消之后已经抓到的章节必须还在');
  assert.equal(book.chapters.length, 40, '目录清单要保持完整');

  expectErr(t, await srv.post('/api/fetch/tasks/t_不存在/pause', {}), 409, 'TASK_NOT_RUNNING', '任务不存在');
});

// ============================================================ 合规闸门

test('S7 · 合规不通过时不允许创建抓取任务（没有强制继续的路）', async (t) => {
  const site = await createFakeSite();
  const srv = await startTestServer();
  t.after(async () => {
    await site.close();
    await srv.close();
  });

  const robotsDenied = expectErr(
    t,
    await srv.post('/api/fetch/tasks', { url: site.privateUrl }),
    403,
    'COMPLIANCE_REJECTED',
    'robots 拒绝'
  );
  assert.ok(robotsDenied.message.includes('robots'));
  assert.equal(srv.ctx.library.list().length, 0, '被拒绝时不能建书');

  expectErr(t, await srv.post('/api/fetch/tasks', { url: site.loginUrl }), 403, 'COMPLIANCE_REJECTED', '登录墙');
  expectErr(t, await srv.post('/api/fetch/tasks', { url: site.vipUrl }), 403, 'COMPLIANCE_REJECTED', '付费墙');
  assert.equal(srv.ctx.library.list().length, 0);

  // 就算把 force 传进来也不认
  expectErr(
    t,
    await srv.post('/api/fetch/tasks', { url: site.vipUrl, force: true, skip_compliance: true }),
    403,
    'COMPLIANCE_REJECTED',
    '强制继续也不行'
  );
  assert.equal(srv.ctx.library.list().length, 0);
});

test('S7 · 抓取时对每一章再过一次 robots（总目录允许但某章被禁也要拦住）', async (t) => {
  const site = await createFakeSite({
    chapterCount: 4,
    robotsTxt: 'User-agent: *\nDisallow: /book/ch3\n',
  });
  const srv = await startTestServer();
  t.after(async () => {
    await site.close();
    await srv.close();
  });

  const created = expectOk(t, await srv.post('/api/fetch/tasks', { url: site.tocUrl }), '创建任务');
  const task = await waitTask(srv, created.task_id);

  assert.equal(task.progress.total, 4);
  assert.equal(task.progress.done, 3, '除了被禁的那一章，其余三章应该抓到');
  assert.equal(task.progress.failed, 1);
  const report = expectOk(t, await srv.get(`/api/fetch/tasks/${created.task_id}/report`), '报告');
  assert.equal(report.failed, 1, '只应该失败被禁的那一章');
  assert.equal(report.failures[0].index, 3);
  assert.equal(report.failures[0].reason, 'ROBOTS_DISALLOWED');
  assert.ok(report.reasonSummary.some((r) => r.label.includes('robots')));
});

test('S7 · 抓过的书可以单章重新抓取（模块 4 的入口）', async (t) => {
  const site = await createFakeSite({ chapterCount: 3 });
  const srv = await startTestServer();
  t.after(async () => {
    await site.close();
    await srv.close();
  });

  const created = expectOk(t, await srv.post('/api/fetch/tasks', { url: site.tocUrl }), '创建任务');
  await waitTask(srv, created.task_id);

  const result = expectOk(
    t,
    await srv.post(`/api/books/${created.book_id}/chapters/2/refetch`, {}),
    '单章重抓'
  );
  assert.equal(result.index, 2);
  assert.ok(result.charCount > 10);
  assert.ok(result.message.includes('重新抓取'));
});

// ============================================================ 前端产物

test('S7 · 抓取控制台前端：合规 → 探测 → 手动点选 → 试抓 → 任务 → 报告', () => {
  const js = fs.readFileSync(path.join(ASSETS, 'views', 'fetch.js'), 'utf8');

  assert.ok(js.includes('/api/fetch/compliance'), '缺少合规自检');
  assert.ok(js.includes('/api/fetch/probe'), '缺少结构探测');
  assert.ok(js.includes('/api/fetch/candidates'), '缺少候选区（手动点选）');
  assert.ok(js.includes('/api/fetch/probe/preview'), '缺少试抓确认');
  assert.ok(js.includes('/api/fetch/tasks'), '缺少任务创建');
  for (const action of ['pause', 'resume', 'cancel']) {
    assert.ok(js.includes(`controlTask('${action}')`), `缺少 ${action}`);
  }
  assert.ok(js.includes('/retry'), '缺少重试');
  assert.ok(js.includes('/report'), '缺少抓取报告');
  assert.ok(js.includes('removedSamples'), '报告里要展示被剔除的片段供抽查');

  // 三色进度
  for (const cls of ['tri-done', 'tri-pending', 'tri-failed']) {
    assert.ok(js.includes(cls), `缺少三色进度里的 ${cls}`);
  }

  const index = fs.readFileSync(path.join(ASSETS, 'views', 'index.js'), 'utf8');
  assert.ok(index.includes("from './fetch.js'"), '抓取视图没接进路由表');

  const css = fs.readFileSync(path.join(ASSETS, 'pages.css'), 'utf8');
  for (const cls of ['.tri-bar', '.fetch-step', '.candidate-item', '.report-block']) {
    assert.ok(css.includes(cls), `缺少样式 ${cls}`);
  }
});

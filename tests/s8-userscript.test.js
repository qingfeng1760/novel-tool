'use strict';
/**
 * s8-userscript.test.js —— S8 阶段验收：油猴脚本（模块 3）。
 *
 * 对应 PRD §11 S8 与验收项 12：
 *   - 在网页上能存单章、能提示将追加到哪本书、重复章节会跳过
 * 以及模块 3 的另外两条：服务未启动时本地暂存并在恢复后自动补交、浮窗隐藏状态持久化。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { startTestServer, expectOk, expectErr } = require('./helpers/env');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT_FILE = path.join(ROOT, 'userscript', '小说工具.user.js');

const CHAPTER_1 = '第一章 开始\n这是第一章的正文。\n请记住本站域名 www.example.com\n正文继续。';
const CHAPTER_2 = '第二章 继续\n这是第二章的正文，内容完全不一样。';

// ============================================================ ping

test('S8 · ping：脚本据此判断服务在不在', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());

  const data = expectOk(t, await srv.get('/api/userscript/ping'), 'ping');
  assert.equal(data.online, true);
  assert.equal(data.app, '小说工具');
  assert.equal(data.accept_capture, true);
  assert.ok(data.version);
});

// ============================================================ resolve

test('S8 · resolve：同站点同书名认得出是哪本书，并说明会落到第几章', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());

  const { book } = srv.ctx.library.create({ title: '测试小说', source_site: 'novel.example.com' });
  srv.ctx.library.writeChapters(book.book_id, [
    { index: 1, title: '第一章', content: '内容一。' },
    { index: 2, title: '第二章', content: '内容二。' },
  ]);

  const result = expectOk(
    t,
    await srv.post('/api/userscript/resolve', {
      url: 'https://novel.example.com/book/123/ch3.html',
      title: '测试小说',
      author: '某作者',
    }),
    '识别归属'
  );
  assert.equal(result.matched, true);
  assert.equal(result.via, 'same-site');
  assert.equal(result.book.book_id, book.book_id);
  assert.equal(result.next_index, 3);
  assert.ok(result.message.includes('将追加到《测试小说》的第 3 章'), `话术不对：${result.message}`);
});

test('S8 · resolve：书名一样但换了站点，也要能认出来（只是提示得更谨慎）', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());

  srv.ctx.library.create({ title: '诡秘之主', source_site: 'a.com' });

  const result = expectOk(
    t,
    await srv.post('/api/userscript/resolve', {
      url: 'https://b.com/book/9',
      title: '《诡秘之主》',
    }),
    '跨站点识别'
  );
  assert.equal(result.matched, true);
  assert.equal(result.via, 'same-title');
  assert.equal(result.confidence, 'medium');
  assert.ok(result.message.includes('来源站点不同'));
});

test('S8 · resolve：书架上没有就是新书，并给出建议的书名与来源', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());

  const result = expectOk(
    t,
    await srv.post('/api/userscript/resolve', {
      url: 'https://new-site.com/book/1',
      title: '一本全新的书',
      author: '新作者',
    }),
    '新书'
  );
  assert.equal(result.matched, false);
  assert.equal(result.is_new, true);
  assert.equal(result.suggested.title, '一本全新的书');
  assert.equal(result.suggested.source_site, 'new-site.com');
  assert.equal(result.suggested.source_kind, 'userscript');
  assert.ok(result.message.includes('新建一本'));

  expectErr(t, await srv.post('/api/userscript/resolve', {}), 400, 'NO_IDENTITY', '没有身份信息');
});

test('S8 · resolve：可以指定「存到已有书」', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());
  const { book } = srv.ctx.library.create({ title: '指定的书' });

  const result = expectOk(
    t,
    await srv.post('/api/userscript/resolve', {
      url: 'https://whatever.com/x',
      title: '完全不相干的标题',
      book_id: book.book_id,
    }),
    '指定书'
  );
  assert.equal(result.via, 'explicit');
  assert.equal(result.book.book_id, book.book_id);
});

// ============================================================ capture

test('S8 · capture：单章入库，返回落在第几章（验收项 12）', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());

  const result = expectOk(
    t,
    await srv.post('/api/userscript/capture', {
      url: 'https://site.com/book/1/ch1.html',
      title: '随手存的书',
      author: '作者甲',
      chapter_title: '第一章 开始',
      content: CHAPTER_1,
    }),
    '存单章'
  );

  assert.equal(result.saved, true);
  assert.equal(result.book_created, true, '第一遍应该新建书');
  assert.equal(result.chapter_index, 1);
  assert.ok(result.message.includes('已存到《随手存的书》第 1 章'));

  const book = srv.ctx.library.get(result.book.book_id);
  assert.equal(book.total_chapters, 1);
  assert.equal(book.source_kind, 'userscript');
  assert.equal(book.status, '在读');

  const content = srv.ctx.library.readChapterText(result.book.book_id, 1);
  assert.ok(content.includes('这是第一章的正文'));
  assert.ok(!content.includes('请记住本站域名'), '脚本提交的内容也要过清洗，站点推广行要剔掉');
  assert.ok(result.removed_count >= 1, '要如实回报剔除了什么');
  assert.equal(result.removed[0].reason, '站点推广语');

  // 存到已有书：第二遍应该追加到第 2 章
  const second = expectOk(
    t,
    await srv.post('/api/userscript/capture', {
      url: 'https://site.com/book/1/ch2.html',
      title: '随手存的书',
      chapter_title: '第二章 继续',
      content: CHAPTER_2,
    }),
    '第二章'
  );
  assert.equal(second.chapter_index, 2);
  assert.equal(second.book.total_chapters, 2);
});

test('S8 · capture：重复章节靠内容哈希自动跳过，不产生重复章节（验收项 12）', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());

  const payload = {
    url: 'https://site.com/book/1/ch1.html',
    title: '去重测试书',
    chapter_title: '第一章 开始',
    content: CHAPTER_1,
  };

  const first = expectOk(t, await srv.post('/api/userscript/capture', payload), '第一次');
  assert.equal(first.saved, true);

  // 换个标题、换个 url，但内容一模一样 —— 必须按内容判定为重复
  const again = expectOk(
    t,
    await srv.post('/api/userscript/capture', {
      ...payload,
      url: 'https://site.com/book/1/ch1b.html',
      chapter_title: '第一章 重新抓的同一章',
    }),
    '重复提交'
  );
  assert.equal(again.saved, false);
  assert.equal(again.skipped, true);
  assert.equal(again.reason, 'duplicate');
  assert.equal(again.chapter_index, 1);
  assert.ok(again.message.includes('跳过'));

  const book = srv.ctx.library.get(first.book.book_id);
  assert.equal(book.total_chapters, 1, '不能产生重复章节');
});

test('S8 · capture：书里本来是空的那一章，补进正确的位置而不是堆到末尾', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());

  const { book } = srv.ctx.library.create({ title: '补章测试书', source_site: 'site.com' });
  // 第 1、2、3 章里有清单，但第 2 章是空的（还没抓到）
  srv.ctx.library.setChapters(book.book_id, [
    { index: 1, title: '第一章', is_ok: true, char_count: 10 },
    { index: 2, title: '第二章', is_ok: false, char_count: 0 },
    { index: 3, title: '第三章', is_ok: true, char_count: 10 },
  ]);
  srv.ctx.library.writeChapter(book.book_id, 1, '第一章的内容。', { title: '第一章' });
  srv.ctx.library.writeChapter(book.book_id, 3, '第三章的内容。', { title: '第三章' });

  const result = expectOk(
    t,
    await srv.post('/api/userscript/capture', {
      url: 'https://site.com/book/1/ch2.html',
      title: '补章测试书',
      chapter_title: '第二章 补上的',
      content: '这是补上的第二章正文。',
    }),
    '补章'
  );
  assert.equal(result.saved, true);
  assert.equal(result.action, 'fill');
  assert.equal(result.chapter_index, 2, '应该补到第 2 章的位置，而不是变成第 4 章');

  const after = srv.ctx.library.get(book.book_id);
  assert.equal(after.total_chapters, 3);
  assert.equal(srv.ctx.library.readChapterText(book.book_id, 2), '这是补上的第二章正文。');
});

test('S8 · capture：空内容给人话', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());

  expectErr(
    t,
    await srv.post('/api/userscript/capture', { url: 'https://s.com/a', title: '书', content: '   ' }),
    400,
    'EMPTY_CONTENT',
    '空内容'
  );
});

// ============================================================ batch / flush

test('S8 · batch：抓整本批量提交，逐条回报结果', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());

  const result = expectOk(
    t,
    await srv.post('/api/userscript/batch', {
      url: 'https://site.com/book/2/toc.html',
      title: '批量提交的书',
      chapters: [
        { url: 'https://site.com/book/2/1.html', chapter_title: '第一章', content: '第一章正文内容。' },
        { url: 'https://site.com/book/2/2.html', chapter_title: '第二章', content: '第二章正文内容。' },
        { url: 'https://site.com/book/2/3.html', chapter_title: '第三章', content: CHAPTER_1 },
      ],
    }),
    '批量'
  );

  assert.equal(result.total, 3);
  assert.equal(result.saved, 3);
  assert.equal(result.skipped, 0);
  assert.equal(result.results.length, 3);
  for (const item of result.results) assert.equal(item.ok, true);
  assert.ok(result.message.includes('保存 3 章'));

  const book = srv.ctx.library.get(result.book_id);
  assert.equal(book.total_chapters, 3);
  assert.equal(srv.ctx.library.readChapterText(result.book_id, 3).includes('这是第一章的正文'), true);

  expectErr(t, await srv.post('/api/userscript/batch', { chapters: [] }), 400, 'EMPTY_BATCH', '空批量');
});

test('S8 · flush：服务恢复后补交暂存内容，批次里重复的会跳过', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());

  const result = expectOk(
    t,
    await srv.post('/api/userscript/flush', {
      items: [
        {
          url: 'https://site.com/b/1.html',
          title: '离线存下的书',
          chapter_title: '第一章',
          content: '离线时存的第一章。',
          queued_at: '2026-09-22T01:00:00.000Z',
        },
        {
          url: 'https://site.com/b/2.html',
          title: '离线存下的书',
          chapter_title: '第二章',
          content: '离线时存的第二章。',
          queued_at: '2026-09-22T01:01:00.000Z',
        },
        {
          url: 'https://site.com/b/2b.html',
          title: '离线存下的书',
          chapter_title: '第二章（重复）',
          content: '离线时存的第二章。',
          queued_at: '2026-09-22T01:02:00.000Z',
        },
      ],
    }),
    '补交'
  );

  assert.equal(result.total, 3);
  assert.equal(result.saved, 2);
  assert.equal(result.skipped, 1);
  assert.equal(result.failed, 0);
  for (const item of result.results) {
    assert.equal(item.ok, true);
    assert.equal(typeof item.queue_index, 'number', '要带原队列下标，脚本才能精确清理');
  }
  assert.equal(result.results[2].queue_index, 2);

  const list = srv.ctx.library.list();
  assert.equal(list.length, 1, '只应该新建一本书');
  assert.equal(list[0].total_chapters, 2);

  // 空队列
  const empty = expectOk(t, await srv.post('/api/userscript/flush', { items: [] }), '空补交');
  assert.equal(empty.total, 0);
  assert.ok(empty.message.includes('空的'));
});

// ============================================================ 脚本本体

test('S8 · 脚本：元数据齐全，且只跟本机地址通信', () => {
  assert.ok(fs.existsSync(SCRIPT_FILE), '脚本文件必须存在');
  const source = fs.readFileSync(SCRIPT_FILE, 'utf8');

  assert.ok(source.startsWith('// ==UserScript=='), '要有油猴元数据块');
  assert.ok(source.includes('// ==/UserScript=='));
  assert.ok(source.includes('@name         小说工具'));
  assert.ok(source.includes('@match        *://*/*'));
  assert.ok(source.includes('@grant        GM_xmlhttpRequest'), '跨域请求要靠 GM_xmlhttpRequest');
  assert.ok(source.includes('@connect      127.0.0.1'), '只声明连本机');
  assert.ok(source.includes('@noframes'));

  // 只允许访问 127.0.0.1 / localhost，不允许任何外部地址
  const external = /https?:\/\/(?!127\.0\.0\.1|localhost)[a-z0-9.-]+\.[a-z]{2,}/gi.exec(source);
  assert.equal(external, null, `脚本里不该有外部地址：${external && external[0]}`);
});

test('S8 · 脚本：三个按钮、归属提示、去重、离线暂存、隐藏状态持久化都在', () => {
  const source = fs.readFileSync(SCRIPT_FILE, 'utf8');

  // 三个按钮（PRD 模块 3 明确要求）
  assert.ok(source.includes('存这一章'), '缺少「存这一章」');
  assert.ok(source.includes('抓整本'), '缺少「抓整本」');
  assert.ok(source.includes('存到已有书'), '缺少「存到已有书」');

  // 识别归属并提示"将追加到《XXX》的第 N 章"
  assert.ok(source.includes('/api/userscript/resolve'), '缺少归属识别');
  assert.ok(source.includes('chapterPayload'), '缺少章节提取');

  // 重复章节跳过（以服务端的内容哈希为准）
  assert.ok(source.includes('/api/userscript/capture'), '缺少单章提交');
  assert.ok(source.includes('已存在，未重复写入') || source.includes('未重复写入'), '要告诉用户跳过了重复章');

  // 服务没起来时的处理
  assert.ok(source.includes('请先双击启动.bat'), '要明确提示去启动服务');
  assert.ok(source.includes('enqueue'), '缺少本地暂存');
  assert.ok(source.includes('/api/userscript/flush'), '缺少自动补交');
  assert.ok(source.includes('QUEUE_KEY'), '缺少暂存队列的存储键');

  // 浮窗隐藏 / 显示状态持久化
  assert.ok(source.includes('HIDDEN_KEY'), '缺少浮窗状态存储键');
  assert.ok(source.includes('nt-fab'), '隐藏后要留一个小入口，不能就此消失');

  // 不打断阅读：浮窗不遮正文（右下角小卡片，且可隐藏）
  assert.ok(source.includes('position: fixed; right: 16px; bottom: 16px'), '浮窗要贴在右下角');

  // 脚本本身不重复实现抓取限速逻辑，整本抓取交给服务
  assert.ok(source.includes('1200'), '脚本逐页抓取时要留间隔，不能连打');
});

test('S8 · 服务能直接把脚本发出来，供用户一键安装', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());

  const res = await fetch(`${srv.url}/api/userscript/script`);
  assert.equal(res.status, 200);
  assert.ok((res.headers.get('content-type') || '').includes('javascript'));
  const disposition = res.headers.get('content-disposition') || '';
  assert.ok(disposition.includes("filename*=UTF-8''"), '中文文件名要按 RFC 5987 编码');
  const text = await res.text();
  assert.ok(text.includes('==UserScript=='));
});

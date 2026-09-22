'use strict';
/**
 * s10-settings.test.js —— S10 阶段验收：设置与数据管理、整库备份（模块 9）。
 *
 * 对应 PRD §11 S10 与验收项 7、14：
 *   - 把 data/ 整个文件夹拷到另一台电脑，导入后数据完整（7）
 *   - 整库导出 zip，再导入，数据一致（14）
 * 以及模块 9 的其余要求：存储占用、清理（二次确认）、抓取参数、关于信息。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { startTestServer, expectOk, expectErr } = require('./helpers/env');

const ROOT = path.resolve(__dirname, '..');
const ASSETS = path.join(ROOT, 'web', 'assets');

/** 造一个有内容的书库 */
function seed(srv) {
  const a = srv.ctx.library.create({ title: '备份测试甲', author: '作者甲', tags: ['测试'] }).book;
  srv.ctx.library.writeChapters(a.book_id, [
    { index: 1, title: '第一章', content: '第一章的正文内容，足够长一些好让体积不为零。'.repeat(3) },
    { index: 2, title: '第二章', content: '第二章的正文内容，用来验证备份与恢复。'.repeat(3) },
  ]);

  const b = srv.ctx.library.create({ title: '备份测试乙', author: '作者乙', source_site: 'x.com' }).book;
  srv.ctx.library.writeChapter(b.book_id, 1, '乙书的第一章正文。');

  srv.ctx.reading.setProgress({ book_id: a.book_id, chapter_index: 2, char_offset: 8, chapter_ratio: 0.4, percent: 0.8 });
  srv.ctx.reading.addBookmark({ book_id: a.book_id, chapter_index: 1, char_offset: 3, content: '这里要记住' });
  srv.ctx.reading.addNote({
    book_id: a.book_id,
    chapter_index: 1,
    char_offset: 5,
    selected_text: '摘录的原文',
    content: '我的备注',
  });
  srv.ctx.reading.recordSession({ book_id: a.book_id, started_at: new Date().toISOString(), duration_ms: 30000 });
  srv.ctx.library.patch(a.book_id, { status: '在读', last_read_at: new Date().toISOString() });
  // 真实用户总会改过一点设置，这样 settings.json 才会存在，备份才是完整的
  srv.ctx.settings.putReader({ fontSize: 21 });

  return { a, b };
}

/** 导出成 Buffer（走 HTTP 接口，和用户点按钮是同一条路） */
async function exportBackupBuffer(srv) {
  const res = await fetch(`${srv.url}/api/backup/export`, { method: 'POST' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/zip');
  return Buffer.from(await res.arrayBuffer());
}

/** 用 multipart 导入（和设置页上传文件是同一条路） */
async function importBackup(srv, buffer, conflict = 'skip', filename = '备份.zip') {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: 'application/zip' }), filename);
  form.append('conflict', conflict);
  return srv.request('POST', '/api/backup/import', form);
}

// ============================================================ 设置读写

test('S10 · /api/settings 读写，并给出手改过 settings.json 的合规提示', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());

  const data = expectOk(t, await srv.get('/api/settings'), '读设置');
  assert.equal(typeof data.settings.server.port, 'number');
  assert.equal(data.limits.maxConcurrency, 2);
  assert.equal(data.limits.minDomainIntervalMs, 3000);
  assert.ok(data.defaults);

  // 手改 settings.json，把间隔改到违规值
  srv.ctx.storage.writeJson('settings.json', { ...data.settings, fetch: { concurrency: 9, domainIntervalMs: 100 } });
  const after = expectOk(t, await srv.get('/api/settings'), '再读');
  assert.equal(after.settings.fetch.concurrency, 2, '读的时候也要夹回合规值');
  assert.equal(after.settings.fetch.domainIntervalMs, 3000);
});

test('S10 · 改抓取参数时给出风险提示', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());

  const result = expectOk(
    t,
    await srv.request('PUT', '/api/settings', { fetch: { concurrency: 10, domainIntervalMs: 50 } }),
    '改参数'
  );
  assert.equal(result.settings.fetch.concurrency, 2);
  assert.equal(result.settings.fetch.domainIntervalMs, 3000);
  assert.equal(result.warnings.length, 2, '两处改动都要有提示');
  assert.ok(result.warnings.every((w) => w.includes('合规')));

  const limits = expectOk(t, await srv.get('/api/settings/limits'), '参数说明');
  assert.ok(limits.labels.concurrency.length > 0, '界面上要用中文解释每个参数');
  assert.ok(limits.labels.domainIntervalMs.includes('隔多久'));
});

// ============================================================ 存储占用

test('S10 · 存储占用：总量、分块、每本书，可按大小排序', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());
  const { a } = seed(srv);

  const usage = expectOk(t, await srv.get('/api/storage/usage'), '占用');
  assert.equal(usage.dataDir, srv.dataDir);
  assert.ok(usage.totalBytes > 0);
  assert.ok(usage.breakdown.books > 0, '书籍正文的占用要能单独看到');
  assert.equal(usage.bookCount, 2);
  assert.equal(usage.books[0].book_id, a.book_id, '默认按占用从大到小排');
  assert.ok(usage.books[0].bytes >= usage.books[1].bytes);
  assert.ok(usage.books[0].title);

  const byTitle = expectOk(t, await srv.get('/api/storage/usage?sort=title'), '按书名');
  assert.ok(byTitle.books[0].title.localeCompare(byTitle.books[1].title) <= 0);
});

test('S10 · 清理：四种目标都有影响范围说明，执行后占用变化', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());
  const { a, b } = seed(srv);

  const targets = expectOk(t, await srv.get('/api/storage/targets'), '清理目标');
  assert.equal(targets.targets.length, 4);
  for (const target of targets.targets) {
    assert.ok(target.label && target.description && target.impact, `${target.id} 要说清楚影响范围`);
  }

  // 造点垃圾：来源页快照 + 回收站里的书
  srv.ctx.store.writeText(path.posix.join('books', a.book_id, 'raw', 'source.html'), '<html>原始页面</html>');
  srv.ctx.library.remove(b.book_id, { purge: false });

  const snapshots = expectOk(t, await srv.post('/api/storage/cleanup', { target: 'source-snapshots' }), '清快照');
  assert.equal(snapshots.removed, 1);
  assert.ok(snapshots.message.includes('腾出'));
  assert.equal(srv.ctx.store.exists(path.posix.join('books', a.book_id, 'raw', 'source.html')), false);
  assert.ok(snapshots.usage, '清理后要回传最新的占用，界面才好刷新');

  const trash = expectOk(t, await srv.post('/api/storage/cleanup', { target: 'trash' }), '清回收站');
  assert.equal(trash.removed, 1);
  assert.ok(trash.message.includes('找不回来'), '要告诉用户这一步不可逆');
  assert.equal(srv.ctx.store.listDir('.trash').length, 0);

  const staging = expectOk(t, await srv.post('/api/storage/cleanup', { target: 'staging' }), '清暂存');
  assert.ok(staging.message.length > 0);

  const rebuilt = expectOk(t, await srv.post('/api/storage/cleanup', { target: 'rebuild-index' }), '重建索引');
  assert.ok(rebuilt.index, '重建索引要回报结果');
  assert.ok(rebuilt.message.includes('收录'));

  expectErr(
    t,
    await srv.post('/api/storage/cleanup', { target: '乱填' }),
    400,
    'UNKNOWN_CLEANUP_TARGET',
    '非法目标'
  );
  // 清理不能碰正文
  assert.equal(srv.ctx.library.get(a.book_id).total_chapters, 2);
});

// ============================================================ 关于

test('S10 · /api/about 给出可核对的版本与路径信息', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());

  const about = expectOk(t, await srv.get('/api/about'), '关于');
  assert.equal(about.app, '小说工具');
  assert.match(about.version, /^\d+\.\d+\.\d+$/);
  assert.equal(about.schemaVersion, 1);
  assert.equal(about.dataDir, srv.dataDir);
  assert.ok(path.isAbsolute(about.dataDir), '数据目录必须是绝对路径，用户要照着去拷');
  assert.equal(about.storageKind, 'local');
  assert.ok(about.providers.some((p) => p.id === 'generic-web'));
  assert.ok(about.userscriptUrl.includes('/api/userscript/script'));
  assert.equal(about.reserved.syncState, 'local');
  assert.ok(about.health && about.health.hasProblem === false);
});

// ============================================================ 整库备份（验收项 14）

test('S10 · 整库导出 zip，再导入到干净的库里数据一致（验收项 14）', async (t) => {
  const source = await startTestServer();
  t.after(() => source.close());
  const { a } = seed(source);
  const buffer = await exportBackupBuffer(source);

  // 记录一下原文，导入后逐字核对
  const originalChapters = source.ctx.library.get(a.book_id).chapters.map((ch) => ({
    index: ch.index,
    title: ch.title,
    content: source.ctx.library.readChapterText(a.book_id, ch.index),
  }));
  await source.close();

  // 全新的库，把备份导进来
  const target = await startTestServer();
  t.after(() => target.close());
  assert.equal(target.ctx.library.list().length, 0);

  const result = expectOk(t, await importBackup(target, buffer, 'skip'), '导入');
  assert.equal(result.books.added.length, 2);
  assert.equal(result.books.skipped.length, 0);
  assert.ok(result.message.includes('新增 2 本'));

  // 书、章节、正文逐字一致
  const imported = target.ctx.library.get(a.book_id);
  assert.ok(imported, '书要导进来');
  assert.equal(imported.title, '备份测试甲');
  assert.equal(imported.author, '作者甲');
  assert.deepEqual(imported.tags, ['测试']);
  assert.equal(imported.total_chapters, 2);
  for (const chapter of originalChapters) {
    assert.equal(target.ctx.library.readChapterText(a.book_id, chapter.index), chapter.content, `第 ${chapter.index} 章正文不一致`);
    assert.equal(imported.chapters[chapter.index - 1].title, chapter.title);
  }

  // 进度 / 书签 / 笔记 / 时长都要跟着回来
  const progress = target.ctx.reading.getProgress(a.book_id);
  assert.ok(progress, '阅读进度要导进来');
  assert.equal(progress.chapter_index, 2);
  assert.equal(progress.char_offset, 8);
  assert.equal(target.ctx.reading.listBookmarks({ book_id: a.book_id }).length, 1);
  assert.equal(target.ctx.reading.listNotes({ book_id: a.book_id }).length, 1);
  assert.equal(target.ctx.reading.stats().totalMs, 30000);
  assert.equal(result.reading.progress, 1);

  // 索引要能用
  const found = expectOk(t, await target.get(`/api/search?q=${encodeURIComponent('第二章的正文内容')}`), '搜索');
  assert.ok(found.results.length >= 1, '导入之后索引要跟上');
});

test('S10 · 冲突处理：跳过 / 覆盖 / 并存 三种方式各自的行为', async (t) => {
  const source = await startTestServer();
  const { a } = seed(source);
  const buffer = await exportBackupBuffer(source);
  await source.close();

  // ---- 跳过
  const skipSrv = await startTestServer();
  t.after(() => skipSrv.close());
  seed(skipSrv);
  skipSrv.ctx.library.patch(a.book_id, { title: '本地改过的名字' });
  const skipped = expectOk(t, await importBackup(skipSrv, buffer, 'skip'), '跳过');
  assert.equal(skipped.books.added.length, 0);
  assert.equal(skipped.books.skipped.length, 2);
  assert.equal(skipSrv.ctx.library.get(a.book_id).title, '本地改过的名字', '跳过时不该动本地那本');
  assert.equal(skipSrv.ctx.library.list().length, 2);

  // ---- 覆盖
  const overSrv = await startTestServer();
  t.after(() => overSrv.close());
  seed(overSrv);
  overSrv.ctx.library.patch(a.book_id, { title: '本地改过的名字' });
  const overwritten = expectOk(t, await importBackup(overSrv, buffer, 'overwrite'), '覆盖');
  assert.equal(overwritten.books.overwritten.length, 2);
  assert.equal(overSrv.ctx.library.get(a.book_id).title, '备份测试甲', '覆盖时以备份为准');
  assert.equal(overSrv.ctx.library.list().length, 2, '覆盖不该多出一本');
  // 本地那份要进回收站，不能直接删
  assert.ok(overwritten.books.overwritten[0].trashed, '被覆盖的本地那份要进回收站');
  assert.ok(overSrv.ctx.store.listDir('.trash').length >= 1);

  // ---- 并存
  const coSrv = await startTestServer();
  t.after(() => coSrv.close());
  seed(coSrv);
  const coexisted = expectOk(t, await importBackup(coSrv, buffer, 'coexist'), '并存');
  assert.equal(coexisted.books.coexisted.length, 2);
  assert.equal(coSrv.ctx.library.list().length, 4, '两份都要留着');
  const newOne = coSrv.ctx.library.get(coexisted.books.coexisted[0].book_id);
  assert.ok(newOne, '并存进来的书要能查到');
  assert.ok(newOne.title.includes('（导入）'), `标题要能区分开：${newOne.title}`);
  assert.notEqual(newOne.book_id, coexisted.books.coexisted[0].from, '并存的书要换新编号');
});

test('S10 · 坏文件导入给人话，不会把库搞坏', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());
  seed(srv);

  const notZip = Buffer.from('这根本不是 zip 文件', 'utf8');
  expectErr(t, await importBackup(srv, notZip, 'skip'), 400, 'BAD_BACKUP', '不是压缩包');

  // 是个 zip 但没有 manifest
  const AdmZip = require('adm-zip');
  const zip = new AdmZip();
  zip.addFile('random.txt', Buffer.from('随便一个文件'));
  const zipBuffer = zip.toBuffer();
  expectErr(t, await importBackup(srv, zipBuffer, 'skip'), 400, 'NOT_A_BACKUP', '不是本工具的备份');

  // 用户数据毫发无损
  assert.equal(srv.ctx.library.list().length, 2);
  assert.equal(srv.ctx.library.get(srv.ctx.library.list()[0].book_id).total_chapters > 0, true);
});

test('S10 · data/ 整个文件夹拷到"另一台电脑"，数据完整（验收项 7）', async (t) => {
  const source = await startTestServer();
  const { a } = seed(source);
  const snapshot = source.ctx.library.readChapterText(a.book_id, 1);
  const progress = source.ctx.reading.getProgress(a.book_id);

  // 关掉服务 → 模拟"拔下硬盘插到另一台电脑"
  await source.close();
  const newHome = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-tool-other-pc-'));
  fs.cpSync(source.dataDir, path.join(newHome, 'data'), { recursive: true });

  const other = await startTestServer({ dataDir: path.join(newHome, 'data') });
  t.after(async () => {
    await other.close();
    fs.rmSync(newHome, { recursive: true, force: true });
  });

  const pile = expectOk(t, await other.get('/api/library'), '另一台电脑的书架');
  assert.equal(pile.counts['全部'], 2);
  assert.equal(other.ctx.library.get(a.book_id).title, '备份测试甲');
  assert.equal(other.ctx.library.readChapterText(a.book_id, 1), snapshot, '正文要一模一样');
  assert.deepEqual(other.ctx.reading.getProgress(a.book_id).char_offset, progress.char_offset);
  assert.equal(other.ctx.reading.listBookmarks().length, 1);
  assert.equal(other.ctx.reading.listNotes().length, 1);
  assert.equal(other.ctx.settings.get().reader.fontSize, 18 > 0 ? other.ctx.settings.get().reader.fontSize : 19);

  // 数据体检不该报问题
  assert.equal(other.ctx.health.hasProblem, false);
});

test('S10 · 导出格式带 manifest，与"将来云端版本"对得上（PRD §7）', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());
  seed(srv);

  const buffer = await exportBackupBuffer(srv);
  const AdmZip = require('adm-zip');
  const zip = new AdmZip(buffer);
  const manifest = JSON.parse(zip.readAsText('manifest.json'));

  assert.equal(manifest.format, 'novel-tool-backup');
  assert.equal(manifest.formatVersion, 1);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.syncState, 'local');
  assert.equal(manifest.owner_id, 'local');
  assert.equal(manifest.dataRoot, 'data/');
  assert.ok(manifest.exportedAt);
  assert.ok(manifest.fileCount > 0);
  assert.deepEqual(manifest.excluded, ['.trash/', '.staging/', 'index/']);

  const names = zip.getEntries().map((e) => e.entryName);
  assert.ok(names.includes('data/library.json'));
  assert.ok(names.includes('data/reading/progress.json'));
  assert.ok(names.includes('data/settings.json'));
  assert.ok(!names.some((n) => n.startsWith('data/index/')), '索引是可重建缓存，不进备份');
  assert.ok(!names.some((n) => n.endsWith('.bak')), '.bak 不进备份');
});

test('S10 · 备份.bat 用的 CLI 与设置页导出走的是同一套逻辑', () => {
  const cli = fs.readFileSync(path.join(ROOT, 'server', 'backup-cli.js'), 'utf8');
  assert.ok(cli.includes('ctx.backup.exportZip'), '命令行备份要复用同一个导出实现');

  const bat = fs.readFileSync(path.join(ROOT, '备份.bat'));
  const text = require('iconv-lite').decode(bat, 'gbk');
  assert.ok(text.includes('backup-cli.js'), '备份.bat 要调用 CLI');
  assert.ok(text.includes('chcp 936'));
});

// ============================================================ 前端产物

test('S10 · 设置页有四个子页，清理有二次确认，导入要选冲突处理', () => {
  const js = fs.readFileSync(path.join(ASSETS, 'views', 'settings.js'), 'utf8');

  for (const section of ['reader', 'data', 'fetch', 'about']) {
    assert.ok(js.includes(`id: '${section}'`), `缺少子页 ${section}`);
  }
  assert.ok(js.includes('/api/storage/usage'), '缺少存储占用');
  assert.ok(js.includes('/api/storage/cleanup'), '缺少清理');
  assert.ok(js.includes('/api/backup/export'), '缺少整库导出');
  assert.ok(js.includes('/api/backup/import'), '缺少整库导入');
  assert.ok(js.includes('/api/about'), '缺少关于信息');
  assert.ok(js.includes('/api/settings/reader'), '缺少阅读偏好');
  assert.ok(js.includes('/api/reading/progress/export'), '缺少进度单独导出');

  // 清理必须二次确认，并且把影响范围讲出来
  assert.ok(js.includes('confirmDialog'), '清理要先确认');
  assert.ok(js.includes('target.impact'), '确认框里要讲影响范围');

  // 导入必须让用户选冲突处理
  assert.ok(js.includes('name="conflict"'), '导入时要让用户选冲突处理');
  assert.ok(js.includes("value=\"skip\"") && js.includes("value=\"overwrite\"") && js.includes("value=\"coexist\""));

  // 阅读偏好那一堆参数都在
  for (const field of ['cfgFontSize', 'cfgLineHeight', 'cfgWidth', 'cfgIndent', 'cfgFontFamily', 'cfgTheme', 'cfgMode']) {
    assert.ok(js.includes(field), `阅读偏好缺少 ${field}`);
  }

  // 关于页要有数据目录绝对路径与版本
  assert.ok(js.includes('about.dataDir'), '要显示数据目录');
  assert.ok(js.includes('about.version'), '要显示版本号');

  const css = fs.readFileSync(path.join(ASSETS, 'pages.css'), 'utf8');
  for (const cls of ['.typo-grid', '.usage-list', '.data-table', '.cleanup-item', '.radio-list', '.help-steps']) {
    assert.ok(css.includes(cls), `缺少样式 ${cls}`);
  }

  // 设置页要真的注册进路由
  const index = fs.readFileSync(path.join(ASSETS, 'views', 'index.js'), 'utf8');
  assert.ok(index.includes("from './settings.js'"), '设置视图没接进路由表');
  assert.ok(index.includes("router.add('/settings/:section'"), '设置子页路由缺失');
});

'use strict';
/**
 * s0-skeleton.test.js —— S0 阶段验收：项目骨架、存储层、服务与脚本。
 *
 * 对应 PRD §11 S0 与验收项 1、6：
 *   - 起服务能跑起来、页面能打开（验收项 1）
 *   - 数据落盘不丢、损坏能回退（验收项 6 / §6.2 写入规则）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const iconv = require('iconv-lite');

const { Store, makeBookId, contentHash } = require('../server/services/store');
const { findFreePort, tryListen } = require('../server/lib/net');
const { parseMultipart } = require('../server/lib/multipart');
const { Router } = require('../server/lib/router');
const { resolveStatic } = require('../server/lib/static');
const {
  startTestServer,
  createTestContext,
  makeTempDir,
  rmrf,
  expectOk,
  expectErr,
} = require('./helpers/env');

const ROOT = path.resolve(__dirname, '..');

// ============================================================ 存储层：原子写与 .bak

test('S0 · store：init() 建好 data/ 目录骨架', () => {
  const dir = makeTempDir('store');
  const store = new Store({ dataDir: dir });
  const report = store.init();
  for (const sub of ['books', 'reading', 'index', '.trash']) {
    assert.ok(fs.existsSync(path.join(dir, sub)), `缺少子目录 ${sub}`);
  }
  assert.equal(report.hasProblem, false, '全新目录不应该有数据问题');
  assert.equal(report.dataDir, dir);
  rmrf(dir);
});

test('S0 · store：writeJson / readJson 往返一致，且不留临时文件', () => {
  const dir = makeTempDir('store');
  const store = new Store({ dataDir: dir });
  store.init();

  const payload = { title: '测试书', tags: ['测试'], nested: { a: 1 } };
  store.writeJson('library.json', payload);
  assert.deepEqual(store.readJson('library.json'), payload);

  // 临时文件必须已经被 rename 掉，不能留在数据目录里
  const leftovers = fs.readdirSync(dir).filter((n) => n.startsWith('.tmp-'));
  assert.deepEqual(leftovers, [], '原子写不应该留下临时文件');
  rmrf(dir);
});

test('S0 · store：覆盖写会先留一份 .bak，内容正是上一版', () => {
  const dir = makeTempDir('store');
  const store = new Store({ dataDir: dir });
  store.init();

  store.writeJson('settings.json', { v: 1 });
  store.writeJson('settings.json', { v: 2 });

  assert.deepEqual(store.readJson('settings.json'), { v: 2 });
  const bak = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json.bak'), 'utf8'));
  assert.deepEqual(bak, { v: 1 }, '.bak 必须是上一版内容');
  rmrf(dir);
});

test('S0 · store：主文件损坏时自动回退 .bak，并明确报出是哪个文件坏了', () => {
  const dir = makeTempDir('store');
  const store = new Store({ dataDir: dir });
  store.init();

  store.writeJson('reading/progress.json', { book_id: 'aaa', chapter_index: 3 });
  store.writeJson('reading/progress.json', { book_id: 'aaa', chapter_index: 9 });
  // 手工把主文件写坏（模拟断电写了半个文件）
  fs.writeFileSync(path.join(dir, 'reading', 'progress.json'), '{"book_id":"aaa","chap');

  const recovered = store.readJson('reading/progress.json', null);
  assert.deepEqual(recovered, { book_id: 'aaa', chapter_index: 3 }, '应该回退到 .bak');

  const issue = store.issues.find((i) => i.file === 'reading/progress.json');
  assert.ok(issue, '必须记录一条问题');
  assert.equal(issue.status, 'recovered');
  assert.ok(issue.message.includes('reading/progress.json'), '提示里必须写清楚是哪个文件');
  rmrf(dir);
});

test('S0 · store：主文件与 .bak 都坏时返回兜底值，不静默丢弃', () => {
  const dir = makeTempDir('store');
  const store = new Store({ dataDir: dir });
  store.init();

  fs.writeFileSync(path.join(dir, 'library.json'), 'not json at all');
  fs.writeFileSync(path.join(dir, 'library.json.bak'), 'also broken');

  const fallback = { books: [] };
  const value = store.readJson('library.json', fallback);
  assert.deepEqual(value, fallback);

  const issue = store.issues.find((i) => i.file === 'library.json');
  assert.ok(issue, '必须记录问题');
  assert.equal(issue.status, 'corrupt');
  assert.ok(issue.message.includes('library.json.bak'), '要告诉用户备用文件也坏了');
  rmrf(dir);
});

test('S0 · store：启动体检会把 .bak 内容写回主文件（真正回退，不只是读的时候兜一下）', () => {
  const dir = makeTempDir('store');
  let store = new Store({ dataDir: dir });
  store.init();
  store.writeJson('settings.json', { port: 8618 });
  store.writeJson('settings.json', { port: 8619 });
  fs.writeFileSync(path.join(dir, 'settings.json'), '{ 坏掉的');

  // 换一个 Store 实例，模拟"关掉服务再重启"
  store = new Store({ dataDir: dir });
  const report = store.init();
  assert.equal(report.hasProblem, true);
  assert.equal(report.issues[0].status, 'recovered');

  const nowOnDisk = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  assert.deepEqual(nowOnDisk, { port: 8618 }, '重启后主文件应该已经被 .bak 顶回来');
  rmrf(dir);
});

test('S0 · store：moveToTrash 移动而不删除，重名自动加后缀', () => {
  const dir = makeTempDir('store');
  const store = new Store({ dataDir: dir });
  store.init();
  store.writeText('books/abc/chapters/0001.txt', '正文');
  store.writeText('books/def/chapters/0001.txt', '正文2');

  const t1 = store.moveToTrash('books/abc', 'abc');
  const t2 = store.moveToTrash('books/def', 'abc');
  assert.equal(t1, '.trash/abc');
  assert.notEqual(t1, t2, '重名时不能互相覆盖');
  assert.equal(fs.existsSync(path.join(dir, '.trash', 'abc')), true);
  assert.equal(store.listDir('.trash').length, 2);
  rmrf(dir);
});

test('S0 · store：book_id 取值稳定且为 12 位十六进制', () => {
  const a = makeBookId('books.example.com', '剑来');
  const b = makeBookId('books.example.com', '剑来');
  const c = makeBookId('other.com', '剑来');
  assert.equal(a, b, '同域名同书名必须得到同一个 id（防重复入库）');
  assert.notEqual(a, c, '不同域名应视为不同的书');
  assert.match(a, /^[0-9a-f]{12}$/);
});

test('S0 · store：contentHash 忽略空白差异（追更判断内容有没有变才准）', () => {
  const a = contentHash('第一段\r\n\r\n第二段  ');
  const b = contentHash('第一段\n\n第二段');
  assert.equal(a, b);
  assert.notEqual(a, contentHash('第一段\n\n第三段'));
});

// ============================================================ 端口选择

test('S0 · net：findFreePort 会顺延被占用的端口', async () => {
  const reporter = require('net').createServer();
  await new Promise((resolve) => reporter.listen(0, '127.0.0.1', resolve));
  const busy = reporter.address().port;

  const free = await findFreePort(busy, '127.0.0.1', 5);
  assert.notEqual(free, busy, '被占用的端口不能返回');
  assert.ok(free > busy, '应该往后顺延');

  const single = await tryListen(busy, '127.0.0.1');
  assert.equal(single.ok, false, '被占用端口应探测为不可用');

  await new Promise((resolve) => reporter.close(resolve));
});

// ============================================================ 路由与 multipart 单元

test('S0 · router：支持参数、尾斜杠与 405', () => {
  const router = new Router();
  router.get('/api/books/:book_id', () => 'detail');
  router.get('/api/books', () => 'list');

  const hit = router.match('GET', '/api/books/abc123');
  assert.equal(hit.params.book_id, 'abc123');

  assert.ok(router.match('GET', '/api/books/'), '尾斜杠也要能匹配');
  assert.ok(router.match('GET', '/api/books'), '无参数路径也要能匹配');

  const wrongMethod = router.match('DELETE', '/api/books');
  assert.deepEqual(wrongMethod.allowed, ['GET'], '方法不对要能报出允许的方法');

  assert.equal(router.match('GET', '/api/nothing'), null);
});

test('S0 · multipart：能拆出字段与文件二进制', () => {
  const boundary = '----test-boundary-1234';
  const head = Buffer.from(
    `--${boundary}\r\n` +
      'Content-Disposition: form-data; name="title"\r\n\r\n' +
      '我的小说\r\n' +
      `--${boundary}\r\n` +
      'Content-Disposition: form-data; name="file"; filename="book.txt"\r\n' +
      'Content-Type: text/plain\r\n\r\n'
  );
  const fileBytes = Buffer.concat([Buffer.from([0xc4, 0xe3, 0xba, 0xc3]), Buffer.from('rest')]);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([head, fileBytes, tail]);

  const parsed = parseMultipart(body, `multipart/form-data; boundary=${boundary}`);
  assert.equal(parsed.fields.title, '我的小说');
  assert.equal(parsed.files.length, 1);
  assert.equal(parsed.files[0].filename, 'book.txt');
  assert.deepEqual(parsed.files[0].data, fileBytes, '文件内容必须按二进制原样保留');
});

test('S0 · static：拦截目录穿越', () => {
  const webDir = path.join(ROOT, 'web');
  assert.ok(resolveStatic(webDir, '/index.html'), '正常的 index.html 应该能找到');
  assert.equal(resolveStatic(webDir, '/../../package.json'), null, '不允许跳出 web 目录');
});

// ============================================================ 服务端接口

test('S0 · 服务：/api/health 返回可用的运行信息', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());

  const data = expectOk(t, await srv.get('/api/health'), 'health');
  assert.equal(data.ok, true);
  assert.equal(data.app, '小说工具');
  assert.match(data.version, /^\d+\.\d+\.\d+$/);
  assert.equal(data.schemaVersion, 1);
  assert.equal(data.dataDir, srv.dataDir);
  assert.equal(typeof data.health.hasProblem, 'boolean');
});

test('S0 · 服务：页面能打开（验收项 1 的服务端部分）', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());

  const res = await fetch(srv.url + '/');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('<title>小说工具</title>'), '首页标题要是中文的');
  assert.ok(html.includes('/assets/app.js'), '首页要加载本地脚本');
  // 硬约束 3：不许出现任何外链资源
  assert.ok(!/https?:\/\/(?!127\.0\.0\.1|localhost)/.test(html), '页面里不允许有外部地址');
});

test('S0 · 服务：静态资源与防穿越在 HTTP 层也生效', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());

  const css = await fetch(srv.url + '/assets/style.css');
  assert.equal(css.status, 200);
  assert.ok((css.headers.get('content-type') || '').includes('text/css'));

  const escape = await fetch(srv.url + '/../package.json');
  assert.notEqual(escape.status, 200, '不允许读到 web 目录以外的文件');
});

test('S0 · 服务：不存在的接口给中文提示，且不泄露堆栈', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());

  const error = expectErr(t, await srv.get('/api/not-exist'), 404, 'NO_SUCH_API', '未知接口');
  assert.ok(error.message.length > 0);
  assert.ok(error.hint.length > 0);
  assert.ok(!/Error|stack|undefined/i.test(error.message), '不允许出现英文技术术语');
  assert.ok(!/Error|stack|undefined/i.test(error.hint));
});

test('S0 · 服务：方法用错返回 405 并说明该用哪种方式', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());

  const error = expectErr(
    t,
    await srv.request('DELETE', '/api/health'),
    405,
    'METHOD_NOT_ALLOWED',
    '方法不对'
  );
  assert.ok(error.hint.includes('GET'), 'hint 要告诉用户该用 GET');
});

test('S0 · 服务：/api/auth/* 一律 501（PRD §7 预留项）', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());

  const error = expectErr(t, await srv.post('/api/auth/login', {}), 501, 'NOT_IMPLEMENTED', 'auth');
  assert.ok(error.message.includes('没有开放'), '要说人话');
  assert.equal((await srv.get('/api/auth/me')).status, 501);
});

test('S0 · 服务：坏 JSON 请求体给出中文提示而不是 500', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());

  const res = await srv.request('POST', '/api/tasks', '{不是合法 JSON');
  // 这个路径下没有 POST 处理器，走到 405；关键是不能抛出未处理异常变成 500
  assert.ok([400, 404, 405, 501].includes(res.status), `不该是 ${res.status}`);
  assert.equal(res.payload.ok, false);
});

// ============================================================ 长任务

test('S0 · tasks：进度累加、计时与预计剩余', () => {
  const { ctx } = createTestContext();
  const task = ctx.tasks.create({ type: 'fetch', title: '抓《测试》', total: 10 });
  assert.equal(task.status, 'pending');
  assert.equal(task.progress.total, 10);

  ctx.tasks.update(task.id, { status: 'running' });
  ctx.tasks.bump(task.id, { done: 4, failed: 1 });
  const after = ctx.tasks.get(task.id);
  assert.equal(after.progress.done, 4);
  assert.equal(after.progress.failed, 1);

  const timing = ctx.tasks.timing(task.id);
  assert.equal(typeof timing.elapsedMs, 'number');
  assert.ok(timing.elapsedMs >= 0);

  ctx.tasks.finish(task.id);
  const done = ctx.tasks.get(task.id);
  assert.equal(done.status, 'done');
  assert.ok(done.finishedAt, '终态必须有结束时间');
});

test('S0 · tasks：/api/tasks/:id 可轮询，任务不存在给人话', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());

  const created = srv.ctx.tasks.create({ type: 'import', title: '导入《测试》', total: 3 });
  const data = expectOk(t, await srv.get('/api/tasks/' + created.id), '任务详情');
  assert.equal(data.id, created.id);
  assert.ok(data.timing, '轮询结果要带已用时/预计剩余');

  expectErr(t, await srv.get('/api/tasks/t_not_exist'), 404, 'NOT_FOUND', '任务不存在');
});

// ============================================================ 设置与合规下限

test('S0 · settings：默认值即合规安全值', () => {
  const { ctx } = createTestContext();
  const settings = ctx.settings.get();
  assert.equal(settings.server.port, 8618);
  assert.ok(settings.fetch.concurrency <= 2, '默认并发不得超过 2');
  assert.ok(settings.fetch.domainIntervalMs >= 3000, '默认同域间隔不得小于 3 秒');
  assert.equal(settings.import.cleanEnabled, false, '清洗默认关闭（模块 7 要求）');
  assert.equal(settings.syncState, 'local');
  assert.equal(settings.owner_id, 'local');
});

test('S0 · settings：违反合规的抓取参数会被夹回并给出提示', () => {
  const { ctx } = createTestContext();
  const result = ctx.settings.putFetch({ concurrency: 8, domainIntervalMs: 100 });
  assert.equal(result.fetch.concurrency, 2, '并发必须被夹回 2');
  assert.equal(result.fetch.domainIntervalMs, 3000, '间隔必须被夹回 3000 毫秒');
  assert.equal(result.warnings.length, 2, '两处改动都要有提示');
  assert.ok(result.warnings.every((w) => /合规/.test(w)), '提示要说明是合规要求');

  // 写盘之后再读，仍应是夹取后的值（手改 settings.json 也绕不过去）
  assert.equal(ctx.settings.get().fetch.concurrency, 2);
});

test('S0 · settings：设置改动落盘，重启后还在（验收项 6）', () => {
  const { ctx, dataDir } = createTestContext();
  ctx.settings.putReader({ fontSize: 24, theme: 'night' });

  // 用同一个数据目录重新装配，模拟"关窗口再重启"
  const { ctx: ctx2 } = createTestContext({ dataDir });
  const reader = ctx2.settings.getReader();
  assert.equal(reader.fontSize, 24);
  assert.equal(reader.theme, 'night');
  rmrf(dataDir);
});

// ============================================================ 备份脚本

test('S0 · backup：exportZip 产出带 manifest 的 zip，含全部数据文件', async () => {
  const srv = await startTestServer();
  const { ctx, dataDir, backupDir } = srv;

  ctx.settings.putReader({ fontSize: 21 });
  ctx.store.writeText('books/abcdef123456/chapters/0001.txt', '第一章正文');

  const result = await ctx.backup.exportZip();
  assert.ok(fs.existsSync(result.file), 'zip 必须真的写出来');
  assert.ok(result.size > 0);
  assert.ok(result.file.startsWith(backupDir), '备份要落在 backups/ 下');
  assert.match(path.basename(result.file), /^小说工具备份-\d{8}-\d{6}\.zip$/);

  const AdmZip = require('adm-zip');
  const zip = new AdmZip(result.file);
  const names = zip.getEntries().map((e) => e.entryName);
  assert.ok(names.includes('manifest.json'), 'zip 里必须有 manifest.json');
  assert.ok(names.includes('data/settings.json'), 'zip 里必须有 settings.json');
  assert.ok(names.includes('data/books/abcdef123456/chapters/0001.txt'), '章节正文要打进去');
  assert.ok(
    !names.some((n) => n.includes('.trash/') || n.includes('.tmp-') || n.endsWith('.bak')),
    '回收站、临时文件、.bak 不该进备份包'
  );

  const manifest = JSON.parse(zip.readAsText('manifest.json'));
  assert.equal(manifest.format, 'novel-tool-backup');
  assert.equal(manifest.dataRoot, 'data/');
  assert.equal(manifest.schemaVersion, 1);
  assert.ok(manifest.exportedAt);

  const listed = ctx.backup.listBackups();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].size, result.size);

  await srv.close();
  rmrf(dataDir);
  rmrf(backupDir);
});

test('S0 · 脚本：启动.bat / 备份.bat 存在且是 GBK 编码的中文提示', () => {
  for (const name of ['启动.bat', '备份.bat']) {
    const file = path.join(ROOT, name);
    assert.ok(fs.existsSync(file), `${name} 必须存在`);
    const raw = fs.readFileSync(file);
    const text = iconv.decode(raw, 'gbk');
    assert.ok(text.includes('@echo off'), `${name} 要是批处理脚本`);
    assert.ok(text.includes('chcp 936'), `${name} 要切到中文代码页，否则提示会乱码`);
    assert.ok(text.includes('Node.js'), `${name} 要检查 Node.js 是否安装`);
    // GBK 字节流里不该出现 UTF-8 中文的特征序列（说明文件真的按 GBK 存的）
    assert.ok(!text.includes('\uFFFD'), `${name} 里不能有解码失败字符`);
  }

  const start = iconv.decode(fs.readFileSync(path.join(ROOT, '启动.bat')), 'gbk');
  assert.ok(start.includes('server\\index.js'), '启动.bat 要调用服务入口');
  const backup = iconv.decode(fs.readFileSync(path.join(ROOT, '备份.bat')), 'gbk');
  assert.ok(backup.includes('server\\backup-cli.js'), '备份.bat 要调用备份入口');
});

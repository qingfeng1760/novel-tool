'use strict';
/**
 * s1-models.test.js —— S1 阶段验收：数据模型、存储适配器、书库与阅读仓储。
 *
 * 对应 PRD §11 S1「数据模型落地（Book / Chapter / Progress / Bookmark / Note / History
 * + schemaVersion）」与 §7 的预留接口清单。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const models = require('../server/schema/models');
const migrations = require('../server/schema/migrations');
const {
  StorageAdapter,
  LocalFileAdapter,
  registerAdapter,
  createAdapter,
  ADAPTERS,
} = require('../server/services/adapters/storage-adapter');
const { createTestContext, makeTempDir, rmrf, catchErr } = require('./helpers/env');
const { makeBookId } = require('../server/services/store');

// ============================================================ 模型：字段与默认值

test('S1 · Book：归一化补齐全部字段，且带同步与迁移字段', () => {
  const book = models.normBook({ book_id: 'abc123456789', title: '剑来' });

  assert.equal(book.book_id, 'abc123456789');
  assert.equal(book.title, '剑来');
  assert.equal(book.author, '');
  assert.equal(book.cover, null);
  assert.equal(book.source_site, 'local');
  assert.equal(book.toc_url, null);
  assert.deepEqual(book.tags, []);
  assert.equal(book.status, models.BOOK_STATUS.UNREAD);
  assert.equal(book.fetch_status, models.FETCH_STATUS.NONE);
  assert.equal(book.total_chapters, 0);
  assert.equal(book.read_chapters, 0);
  assert.ok(book.created_at, 'created_at 必须自动补上');

  // PRD §7：所有实体都带 updatedAt / schemaVersion / syncState
  assert.ok(book.updatedAt);
  assert.equal(book.schemaVersion, 1);
  assert.equal(book.syncState, 'local');
  assert.equal(book.owner_id, 'local');
});

test('S1 · Book：validateBook 能挑出具体问题', () => {
  assert.deepEqual(models.validateBook(models.normBook({ book_id: 'a1', title: '书' })), []);

  assert.ok(models.validateBook(models.normBook({ title: '没有编号' }))[0].includes('book_id'));
  assert.ok(models.validateBook(models.normBook({ book_id: 'a1' }))[0].includes('书名'));
  assert.ok(
    models.validateBook({ ...models.normBook({ book_id: 'a1', title: '书' }), status: '乱填' })[0].includes(
      '状态'
    )
  );
  // 这里要绕过 normBook 的自动夹取，直接构造一份"字段自相矛盾"的数据，验证校验器能拦住它
  assert.ok(
    models
      .validateBook({
        ...models.normBook({ book_id: 'a1', title: '书' }),
        total_chapters: 3,
        read_chapters: 5,
      })[0].includes('已读')
  );
  assert.ok(
    models
      .validateBook({ ...models.normBook({ book_id: 'a1', title: '书' }), book_id: '有 空格' })[0].includes(
        '字母'
      )
  );
  assert.ok(
    models
      .validateBook({ ...models.normBook({ book_id: 'a1', title: '书' }), syncState: 'cloud' })[0].includes(
        'local'
      )
  );
});

test('S1 · Book：已读章节数自动夹到总章节数以内（进度条不会超过 100%）', () => {
  const book = models.normBook({ book_id: 'a1', title: '书', total_chapters: 2, read_chapters: 99 });
  assert.equal(book.read_chapters, 2);
});

test('S1 · Book：索引摘要不含章节清单，但带 chapter_count', () => {
  const book = models.normBook({
    book_id: 'a1',
    title: '书',
    chapters: [{ index: 1, title: '第一章' }, { index: 2, title: '第二章' }],
  });
  const summary = models.bookSummary(book);
  assert.equal(summary.chapters, undefined, '摘要里不该有章节清单（会让索引膨胀）');
  assert.equal(summary.chapter_count, 2);
  assert.equal(summary.title, '书');
});

test('S1 · Chapter：默认标题与三种状态', () => {
  const ch = models.normChapter({}, 7);
  assert.equal(ch.index, 7);
  assert.equal(ch.title, '第 7 章');
  assert.equal(ch.char_count, 0);
  assert.equal(ch.is_ok, false);
  assert.equal(ch.origin, 'manual');

  assert.equal(models.chapterState({ is_ok: true }), '成功');
  assert.equal(models.chapterState({ is_ok: false, fetched_at: '2026-01-01T00:00:00.000Z' }), '失败');
  assert.equal(models.chapterState({ is_ok: false, fetched_at: null }), '缺失');
  assert.equal(models.chapterState(null), '缺失');
});

test('S1 · Progress：必须记住章内比例（章节总数变了才能重定位）', () => {
  const p = models.normProgress({
    book_id: 'a1',
    chapter_index: 12,
    char_offset: 800,
    chapter_ratio: 0.62,
    percent: 0.31,
  });
  assert.equal(p.chapter_index, 12);
  assert.equal(p.char_offset, 800);
  assert.ok(Math.abs(p.chapter_ratio - 0.62) < 1e-9);
  assert.ok(Math.abs(p.percent - 0.31) < 1e-9);
  assert.ok(p.updated_at);

  // 越界的比例要被夹回 [0,1]
  assert.equal(models.normProgress({ book_id: 'a1', chapter_ratio: 3.2 }).chapter_ratio, 1);
  assert.equal(models.normProgress({ book_id: 'a1', chapter_ratio: -2 }).chapter_ratio, 0);
  // 章节序号从 1 开始，0 或负数都归到第 1 章
  assert.equal(models.normProgress({ book_id: 'a1', chapter_index: 0 }).chapter_index, 1);
});

test('S1 · Bookmark / Note / History / Session：字段齐全', () => {
  const bm = models.normBookmark({ book_id: 'a1', chapter_index: 2, char_offset: 10 });
  assert.equal(bm.id, '', 'id 由仓储层生成，模型层不该自己编一个');
  assert.equal(bm.content, '', '书签的备注可以为空');
  assert.ok(bm.created_at);

  const note = models.normNote({ book_id: 'a1', chapter_index: 3, selected_text: '原文', content: '备注' });
  assert.equal(note.selected_text, '原文');
  assert.equal(note.content, '备注');

  const h = models.normHistoryEntry({ book_id: 'a1', chapter_index: 9 });
  assert.equal(h.chapter_index, 9);
  assert.ok(h.at);

  const s = models.normSession({ book_id: 'a1', started_at: '2026-09-22T10:00:00.000Z', duration_ms: 60000 });
  assert.equal(s.day, '2026-09-22');
  assert.equal(s.duration_ms, 60000);
});

test('S1 · 所有实体都带 updatedAt / schemaVersion / syncState / owner_id（PRD §7 逐条核对）', () => {
  const samples = {
    book: models.normBook({ book_id: 'a1', title: '书' }),
    chapter: models.normChapter({ index: 1 }),
    progress: models.normProgress({ book_id: 'a1' }),
    bookmark: models.normBookmark({ book_id: 'a1' }),
    note: models.normNote({ book_id: 'a1' }),
    history: models.normHistoryEntry({ book_id: 'a1' }),
    session: models.normSession({ book_id: 'a1' }),
  };
  for (const [type, entity] of Object.entries(samples)) {
    assert.ok(entity.updatedAt, `${type} 缺 updatedAt`);
    assert.equal(entity.schemaVersion, 1, `${type} 的 schemaVersion 不对`);
    assert.equal(entity.syncState, 'local', `${type} 的 syncState 应该是 local`);
    assert.equal(entity.owner_id, 'local', `${type} 缺 owner_id`);
  }
});

test('S1 · normalize 统一入口认识所有模型', () => {
  assert.equal(models.normalize('book', { book_id: 'a1', title: '书' }).title, '书');
  assert.throws(() => models.normalize('不存在的模型', {}), /没有这个数据模型/);
});

// ============================================================ 迁移骨架

test('S1 · migrate：同版本原样返回', () => {
  const data = { schemaVersion: 1, books: [] };
  assert.equal(migrations.migrate(data, 1, 1), data);
});

test('S1 · migrate：遇到更新版本的数据给人话，不猜测', () => {
  const err = catchErr(() => migrations.migrate({ schemaVersion: 9 }, 9, 1));
  assert.ok(err, '应该抛错');
  assert.equal(err.code, 'SCHEMA_TOO_NEW');
  assert.ok(err.message.includes('更新版本'));
  assert.ok(err.hint.includes('数据没有被改动'));
});

test('S1 · migrate：缺步骤时明确报错而不是默默升一半', () => {
  const err = catchErr(() => migrations.migrate({ schemaVersion: 1 }, 1, 2));
  assert.ok(err, '应该抛错');
  assert.equal(err.code, 'MIGRATION_MISSING');
  assert.equal(err.status, 500);
});

test('S1 · migrate：MIGRATIONS 是空表但结构已定义（v1 空实现）', () => {
  assert.ok(Array.isArray(migrations.MIGRATIONS));
  assert.equal(migrations.CURRENT_VERSION, 1);
  assert.equal(migrations.detectVersion({}), 1);
  assert.equal(migrations.detectVersion({ schemaVersion: 4 }), 4);
});

// ============================================================ 存储适配器

test('S1 · StorageAdapter：LocalFileAdapter 实现了全部接口', () => {
  const { ctx } = createTestContext();
  const io = ctx.storage;
  assert.ok(io instanceof StorageAdapter);
  assert.ok(io instanceof LocalFileAdapter);
  assert.equal(io.kind, 'local');

  const methods = [
    'readJson',
    'writeJson',
    'readText',
    'writeText',
    'readBuffer',
    'writeBuffer',
    'exists',
    'remove',
    'removeDir',
    'ensureDir',
    'listDir',
    'listFiles',
    'moveToTrash',
    'dirSize',
    'healthReport',
    'generateId',
  ];
  for (const name of methods) {
    assert.equal(typeof io[name], 'function', `适配器缺方法 ${name}`);
  }
});

test('S1 · StorageAdapter：接口逐个跑通（写读往返 / 目录 / 回收站 / 占用）', () => {
  const { ctx } = createTestContext();
  const io = ctx.storage;

  io.writeJson('a/b.json', { n: 1 });
  assert.deepEqual(io.readJson('a/b.json', null), { n: 1 });
  io.writeText('a/c.txt', '你好');
  assert.equal(io.readText('a/c.txt'), '你好');
  io.writeBuffer('a/d.bin', Buffer.from([1, 2, 3]));
  assert.deepEqual(io.readBuffer('a/d.bin'), Buffer.from([1, 2, 3]));

  assert.equal(io.exists('a/b.json'), true);
  assert.deepEqual(io.listDir('a').sort(), ['b.json', 'c.txt', 'd.bin']);
  assert.equal(io.listFiles('a').length, 3);
  assert.ok(io.dirSize('a') > 0);
  assert.equal(io.readJson('不存在.json', '兜底'), '兜底');

  const trashed = io.moveToTrash('a/c.txt', 'c.txt');
  assert.equal(trashed, '.trash/c.txt');
  assert.equal(io.exists('a/c.txt'), false);

  assert.ok(io.healthReport().dataDir);
  io.remove('a/b.json');
  assert.equal(io.exists('a/b.json'), false);

  // 生成 id 要唯一
  const ids = new Set(Array.from({ length: 50 }, () => io.generateId('x')));
  assert.equal(ids.size, 50);
});

test('S1 · StorageAdapter：接口未实现时明确报错，不会静默成功', () => {
  const base = new StorageAdapter();
  assert.throws(() => base.readJson('x'), /未实现/);
  assert.throws(() => base.moveToTrash('x'), /未实现/);
});

test('S1 · StorageAdapter：注册表可扩展（换 CloudAdapter 时业务代码不用改）', () => {
  class FakeCloudAdapter extends LocalFileAdapter {
    constructor(store) {
      super(store);
      this.kind = 'cloud';
    }
  }
  registerAdapter('cloud-test', (store) => new FakeCloudAdapter(store));
  assert.ok(ADAPTERS.has('cloud-test'));

  const { ctx } = createTestContext();
  const cloud = createAdapter('cloud-test', ctx.store);
  assert.equal(cloud.kind, 'cloud');
  // 业务代码只认接口，因此换适配器后行为一样
  cloud.writeJson('x.json', { ok: 1 });
  assert.deepEqual(cloud.readJson('x.json'), { ok: 1 });

  assert.throws(() => createAdapter('不存在的适配器', ctx.store), /没有名为/);
  ADAPTERS.delete('cloud-test');
});

// ============================================================ 书库仓储

test('S1 · library：新建书同时落 book.json 与 library.json 摘要', () => {
  const { ctx, dataDir } = createTestContext();
  const { book, created } = ctx.library.create({ title: '剑来', author: '烽火戏诸侯', tags: ['仙侠'] });
  assert.equal(created, true);
  assert.equal(book.book_id, makeBookId('local', '剑来'));

  // 索引里是摘要（没有章节清单）
  const index = ctx.library.readIndex();
  assert.equal(index.books.length, 1);
  assert.equal(index.books[0].title, '剑来');
  assert.equal(index.books[0].chapters, undefined);
  assert.equal(index.books[0].chapter_count, 0);
  assert.equal(index.schemaVersion, 1);
  assert.equal(index.syncState, 'local');

  // 单本详情文件独立存在
  assert.ok(fs.existsSync(path.join(dataDir, 'books', book.book_id, 'book.json')));
  rmrf(dataDir);
});

test('S1 · library：同一来源同一书名重复导入不会变成两条（PRD §6.1）', () => {
  const { ctx, dataDir } = createTestContext();
  const first = ctx.library.create({ title: '诡秘之主', source_site: 'example.com' });
  const second = ctx.library.create({ title: '诡秘之主', source_site: 'example.com' });

  assert.equal(first.book.book_id, second.book.book_id);
  assert.equal(second.created, false, '第二次应该是命中已有书');
  assert.equal(ctx.library.list().length, 1, '书架里只能有一条');

  // 不同站点是同名不同书，要分开
  const other = ctx.library.create({ title: '诡秘之主', source_site: 'other.com' });
  assert.notEqual(other.book.book_id, first.book.book_id);
  assert.equal(ctx.library.list().length, 2);

  // 明确要求冲突时应该报错
  assert.throws(
    () => ctx.library.create({ title: '诡秘之主', source_site: 'example.com' }, { onExists: 'error' }),
    (err) => err.code === 'CONFLICT' && err.message.includes('已经有')
  );
  rmrf(dataDir);
});

test('S1 · library：写章节会自动更新字数、哈希与状态，正文是 UTF-8 无 BOM', () => {
  const { ctx, dataDir } = createTestContext();
  const { book } = ctx.library.create({ title: '测试书' });
  const text = '第一章　初见\n这是正文内容。';

  const chapter = ctx.library.writeChapter(book.book_id, 1, text, { title: '初见', origin: 'import' });

  assert.equal(chapter.index, 1);
  assert.equal(chapter.title, '初见');
  assert.equal(chapter.is_ok, true);
  assert.ok(chapter.fetched_at);
  assert.equal(chapter.char_count, text.replace(/\s/g, '').length);
  assert.match(chapter.content_hash, /^[0-9a-f]{40}$/);

  const file = path.join(dataDir, 'books', book.book_id, 'chapters', '0001.txt');
  const bytes = fs.readFileSync(file);
  assert.notDeepEqual(bytes.subarray(0, 3), Buffer.from([0xef, 0xbb, 0xbf]), '不能带 UTF-8 BOM');
  assert.equal(bytes.toString('utf8'), text);
  assert.equal(ctx.library.readChapterText(book.book_id, 1), text);

  const reloaded = ctx.library.get(book.book_id);
  assert.equal(reloaded.chapters.length, 1);
  assert.equal(reloaded.total_chapters, 1);
  rmrf(dataDir);
});

test('S1 · library：writeChapters 批量落库 + 复用同一份章节清单', () => {
  const { ctx, dataDir } = createTestContext();
  const { book } = ctx.library.create({ title: '批量书' });
  const count = ctx.library.writeChapters(book.book_id, [
    { index: 1, title: '第一章', content: '一' },
    { index: 2, title: '第二章', content: '二二' },
    { index: 3, title: '第三章', content: '三三三' },
  ]);
  assert.equal(count, 3);

  const reloaded = ctx.library.get(book.book_id);
  assert.equal(reloaded.total_chapters, 3);
  assert.deepEqual(
    reloaded.chapters.map((c) => c.title),
    ['第一章', '第二章', '第三章']
  );
  assert.deepEqual(
    reloaded.chapters.map((c) => c.char_count),
    [1, 2, 3]
  );
  assert.equal(ctx.library.readChapterText(book.book_id, 2), '二二');
  rmrf(dataDir);
});

test('S1 · library：patch 改元数据会同步更新索引', () => {
  const { ctx, dataDir } = createTestContext();
  const { book } = ctx.library.create({ title: '旧名字' });
  ctx.library.patch(book.book_id, { title: '新名字', tags: ['玄幻'], status: '在读' });

  const fromIndex = ctx.library.list().find((b) => b.book_id === book.book_id);
  assert.equal(fromIndex.title, '新名字');
  assert.deepEqual(fromIndex.tags, ['玄幻']);
  assert.equal(fromIndex.status, '在读');
  assert.equal(ctx.library.get(book.book_id).title, '新名字');
  rmrf(dataDir);
});

test('S1 · library：移除只删索引，正文进回收站（PRD §3）', () => {
  const { ctx, dataDir } = createTestContext();
  const { book } = ctx.library.create({ title: '要被移除的书' });
  ctx.library.writeChapter(book.book_id, 1, '正文不能丢');

  const result = ctx.library.remove(book.book_id);
  assert.equal(ctx.library.list().length, 0, '索引里应该没有这本书了');
  assert.equal(ctx.library.get(book.book_id), null);
  assert.ok(result.trashed.startsWith('.trash/'), '正文应该被移进回收站');

  const trashedDir = path.join(dataDir, result.trashed);
  assert.ok(fs.existsSync(trashedDir), '回收站里必须能找到它');
  assert.ok(
    fs.existsSync(path.join(trashedDir, 'chapters', '0001.txt')),
    '章节正文文件必须还在（不直接抹掉）'
  );
  assert.equal(ctx.store.listDir('books').length, 0);
  rmrf(dataDir);
});

test('S1 · library：索引丢了也能从 book.json 重建', () => {
  const { ctx, dataDir } = createTestContext();
  ctx.library.create({ title: '书甲' });
  ctx.library.create({ title: '书乙', source_site: 'site2.com' });
  assert.equal(ctx.library.list().length, 2);

  // 模拟索引文件损坏被删
  ctx.store.remove('library.json');
  assert.equal(ctx.library.list().length, 0);

  const restored = ctx.library.rebuildIndex();
  assert.equal(restored, 2);
  assert.equal(ctx.library.list().length, 2);
  rmrf(dataDir);
});

test('S1 · library：stats 汇总书库情况', () => {
  const { ctx, dataDir } = createTestContext();
  const a = ctx.library.create({ title: '书甲' }).book;
  const b = ctx.library.create({ title: '书乙' }).book;
  ctx.library.writeChapters(a.book_id, [
    { index: 1, title: 'a1', content: 'x' },
    { index: 2, title: 'a2', content: 'y' },
  ]);
  ctx.library.writeChapter(b.book_id, 1, 'z');
  ctx.library.patch(b.book_id, { status: '已读完' });

  const stats = ctx.library.stats();
  assert.equal(stats.bookCount, 2);
  assert.equal(stats.chapterCount, 3);
  assert.equal(stats.byStatus['已读完'], 1);
  rmrf(dataDir);
});

test('S1 · library：重启后书架还在（验收项 6 的模型层）', () => {
  const dataDir = makeTempDir('restart');
  const first = createTestContext({ dataDir });
  const { book } = first.ctx.library.create({ title: '重启测试书' });
  first.ctx.library.writeChapters(book.book_id, [{ index: 1, title: '第一章', content: '正文' }]);

  // 换一个全新的上下文，数据目录不变 —— 等价于关掉服务再重启
  const second = createTestContext({ dataDir });
  assert.equal(second.ctx.library.list().length, 1);
  const reloaded = second.ctx.library.get(book.book_id);
  assert.equal(reloaded.title, '重启测试书');
  assert.equal(reloaded.chapters.length, 1);
  assert.equal(second.ctx.library.readChapterText(book.book_id, 1), '正文');
  rmrf(dataDir);
});

// ============================================================ 阅读仓储

test('S1 · reading：进度落盘、回读一致，节流场景只留最后一次', () => {
  const { ctx, dataDir } = createTestContext();
  const { book } = ctx.library.create({ title: '进度书' });

  ctx.reading.setProgress({ book_id: book.book_id, chapter_index: 3, char_offset: 100, chapter_ratio: 0.1, percent: 0.05 });
  ctx.reading.setProgress({ book_id: book.book_id, chapter_index: 3, char_offset: 900, chapter_ratio: 0.7, percent: 0.07 });

  const p = ctx.reading.getProgress(book.book_id);
  assert.equal(p.char_offset, 900, '只应该保留最后一次上报');
  assert.ok(Math.abs(p.chapter_ratio - 0.7) < 1e-9);

  const { ctx: ctx2 } = createTestContext({ dataDir });
  assert.equal(ctx2.reading.getProgress(book.book_id).char_offset, 900, '重启后进度必须还在');
  rmrf(dataDir);
});

test('S1 · reading：recentProgress 按更新时间倒序（继续阅读卡片要用）', async () => {
  const { ctx, dataDir } = createTestContext();
  const a = ctx.library.create({ title: '书甲' }).book;
  const b = ctx.library.create({ title: '书乙', source_site: 'x.com' }).book;

  ctx.reading.setProgress({ book_id: a.book_id, chapter_index: 1 });
  await new Promise((r) => setTimeout(r, 5));
  ctx.reading.setProgress({ book_id: b.book_id, chapter_index: 2 });

  const recent = ctx.reading.recentProgress();
  assert.equal(recent[0].book_id, b.book_id, '最近读的应该排前面');
  assert.equal(recent[1].book_id, a.book_id);
  rmrf(dataDir);
});

test('S1 · reading：进度会反向更新书架的阅读时间/已读章数/状态（PRD §5.1）', () => {
  const { ctx, dataDir } = createTestContext();
  const { book } = ctx.library.create({ title: '状态书' });
  ctx.library.writeChapters(book.book_id, [
    { index: 1, title: '一', content: 'a' },
    { index: 2, title: '二', content: 'b' },
  ]);

  ctx.reading.setProgress({ book_id: book.book_id, chapter_index: 1, char_offset: 3 });
  ctx.reading.syncBookFromProgress(book.book_id);
  let updated = ctx.library.get(book.book_id);
  assert.equal(updated.status, '在读');
  assert.equal(updated.read_chapters, 1);
  assert.ok(updated.last_read_at);

  ctx.reading.setProgress({ book_id: book.book_id, chapter_index: 2, char_offset: 1 });
  ctx.reading.syncBookFromProgress(book.book_id);
  updated = ctx.library.get(book.book_id);
  assert.equal(updated.read_chapters, 2);
  assert.equal(updated.status, '已读完', '读到最后一章应自动变已读完');

  // 索引里的摘要也要跟着变
  const summary = ctx.library.list().find((b) => b.book_id === book.book_id);
  assert.equal(summary.status, '已读完');
  assert.equal(summary.read_chapters, 2);
  rmrf(dataDir);
});

test('S1 · reading：书签增删改查，重复加同一位置不产生两条', () => {
  const { ctx, dataDir } = createTestContext();
  const { book } = ctx.library.create({ title: '书签书' });

  const first = ctx.reading.addBookmark({ book_id: book.book_id, chapter_index: 2, char_offset: 50, selected_text: '一句话' });
  assert.equal(first.created, true);
  assert.ok(first.bookmark.id.startsWith('bm_'));

  const again = ctx.reading.addBookmark({ book_id: book.book_id, chapter_index: 2, char_offset: 50, selected_text: '一句话' });
  assert.equal(again.created, false);
  assert.equal(ctx.reading.listBookmarks({ book_id: book.book_id }).length, 1);

  ctx.reading.patchBookmark(first.bookmark.id, { content: '回头再看' });
  assert.equal(ctx.reading.listBookmarks()[0].content, '回头再看');

  ctx.reading.deleteBookmark(first.bookmark.id);
  assert.equal(ctx.reading.listBookmarks().length, 0);
  assert.throws(() => ctx.reading.deleteBookmark(first.bookmark.id), (e) => e.code === 'BOOKMARK_NOT_FOUND');
  rmrf(dataDir);
});

test('S1 · reading：笔记要求有内容，空笔记给中文提示', () => {
  const { ctx, dataDir } = createTestContext();
  const { book } = ctx.library.create({ title: '笔记书' });

  const note = ctx.reading.addNote({
    book_id: book.book_id,
    chapter_index: 1,
    char_offset: 12,
    selected_text: '摘录的原文',
    content: '我的备注',
  });
  assert.ok(note.id.startsWith('note_'));

  assert.throws(
    () => ctx.reading.addNote({ book_id: book.book_id, chapter_index: 1 }),
    (err) => err.code === 'NOTE_EMPTY' && err.hint.includes('选中')
  );
  assert.throws(
    () => ctx.reading.addNote({ chapter_index: 1, content: '没带书' }),
    (err) => err.code === 'NOTE_NO_BOOK'
  );

  ctx.reading.patchNote(note.id, { content: '改过的备注' });
  assert.equal(ctx.reading.getNote(note.id).content, '改过的备注');
  assert.throws(() => ctx.reading.patchNote('note_不存在', {}), (e) => e.code === 'NOTE_NOT_FOUND');

  ctx.reading.deleteNote(note.id);
  assert.equal(ctx.reading.listNotes().length, 0);
  rmrf(dataDir);
});

test('S1 · reading：跳章历史能连续「返回上一处」', () => {
  const { ctx, dataDir } = createTestContext();
  const { book } = ctx.library.create({ title: '历史书' });

  ctx.reading.pushHistory({ book_id: book.book_id, chapter_index: 5, char_offset: 0 });
  ctx.reading.pushHistory({ book_id: book.book_id, chapter_index: 20, char_offset: 0 });
  ctx.reading.pushHistory({ book_id: book.book_id, chapter_index: 33, char_offset: 0 });

  // 当前位置是第 33 章，点两次后退应该依次回到 20 和 5
  assert.equal(ctx.reading.historyBack(book.book_id).entry.chapter_index, 20);
  assert.equal(ctx.reading.historyBack(book.book_id).entry.chapter_index, 5);
  assert.equal(ctx.reading.historyBack(book.book_id).entry, null, '回到底了要明确返回空');

  // 同一位置反复记录不重复入栈
  const before = ctx.reading.listHistory({ book_id: book.book_id }).length;
  ctx.reading.pushHistory({ book_id: book.book_id, chapter_index: 33, char_offset: 0 });
  ctx.reading.pushHistory({ book_id: book.book_id, chapter_index: 33, char_offset: 5 });
  assert.equal(ctx.reading.listHistory({ book_id: book.book_id }).length, before);

  assert.throws(() => ctx.reading.historyBack(null), (e) => e.code === 'HISTORY_NO_BOOK');
  rmrf(dataDir);
});

test('S1 · reading：阅读时长按书、按天统计，本周时长可单独取', () => {
  const { ctx, dataDir } = createTestContext();
  const a = ctx.library.create({ title: '时长书甲' }).book;
  const b = ctx.library.create({ title: '时长书乙', source_site: 'x.com' }).book;

  const today = ctx.reading.localDay(new Date());
  ctx.reading.recordSession({ book_id: a.book_id, started_at: new Date().toISOString(), duration_ms: 60000, day: today });
  ctx.reading.recordSession({ book_id: a.book_id, started_at: new Date().toISOString(), duration_ms: 30000, day: today });
  ctx.reading.recordSession({ book_id: b.book_id, started_at: '2020-01-01T00:00:00.000Z', duration_ms: 5000, day: '2020-01-01' });

  const stats = ctx.reading.stats();
  assert.equal(stats.totalMs, 95000);
  assert.equal(stats.sessionCount, 3);

  const byBookA = stats.byBook.find((x) => x.book_id === a.book_id);
  assert.equal(byBookA.ms, 90000, '同一本书的多次会话要累加');
  const day = stats.byDay.find((x) => x.day === today);
  assert.equal(day.ms, 90000);

  assert.equal(ctx.reading.weekMs(), 90000, '本周时长不该把 2020 年的算进来');

  const overview = ctx.reading.overview();
  assert.equal(overview.totalMs, 95000);
  assert.equal(overview.weekMs, 90000);

  assert.throws(() => ctx.reading.recordSession({ duration_ms: 1 }), (e) => e.code === 'SESSION_NO_BOOK');
  rmrf(dataDir);
});

'use strict';
/**
 * routes/reading.js —— 模块 6「进度 · 书签 · 笔记」的接口。
 *
 * 接口清单（PRD 模块 6）：
 *   GET  / POST        /api/reading/progress          读写进度（节流上报）
 *   GET  / POST / DELETE /api/bookmarks               书签增删查（PATCH 改备注）
 *   GET  / POST / PATCH / DELETE /api/notes           笔记增删改查
 *   GET  / POST        /api/reading/history           跳章历史与「返回上一处」
 *   POST               /api/reading/session           阅读时长上报
 *   GET                /api/reading/stats             按书 / 按天的时长统计
 *   GET  / POST        /api/reading/progress/export|import   进度单文件导出、导入
 *
 * 注意：这些行为都会反向影响书架（PRD §5.1），所以写进度之后统一调用
 * syncBookFromProgress，让书架的"继续阅读卡片 / 进度条 / 分堆归属"跟着变。
 */

const { ApiError } = require('../lib/errors');
const { sendFile } = require('../lib/http-utils');

module.exports = {
  mount(router, ctx) {
    const { reading, library, shelf } = ctx;

    const requireBook = (bookId) => {
      if (!bookId) {
        throw new ApiError('NO_BOOK_ID', '这次请求没有指明是哪本书。', '请回到书架重新打开这本书。', 400);
      }
      if (!library.exists(bookId)) {
        throw new ApiError(
          'BOOK_NOT_FOUND',
          '找不到这本书，它可能已经被移除了。',
          '请返回书架刷新一下列表。',
          404
        );
      }
      return bookId;
    };

    // ------------------------------------------------------------ 进度

    router.get('/api/reading/progress', (c) => {
      const bookId = c.q('book_id');
      if (bookId) {
        requireBook(bookId);
        return { progress: reading.getProgress(bookId), position: reading.resolvePosition(bookId) };
      }
      return { progress: reading.allProgress(), recent: reading.recentProgress(20) };
    });

    router.post('/api/reading/progress', async (c) => {
      const body = await c.json();
      requireBook(body && body.book_id);
      const result = reading.setProgress(body);
      // 阅读行为回写书架：继续阅读卡片、封面进度条、分堆归属都靠这一步
      const book = reading.syncBookFromProgress(body.book_id);
      return { progress: result.progress, book };
    });

    // ------------------------------------------------------------ 书签

    router.get('/api/bookmarks', (c) => {
      const filter = {};
      if (c.q('book_id')) filter.book_id = c.q('book_id');
      if (c.q('chapter_index') !== undefined) filter.chapter_index = c.qNum('chapter_index');
      const items = reading.listBookmarks(filter);
      return { bookmarks: items, total: items.length };
    });

    router.post('/api/bookmarks', async (c) => {
      const body = await c.json();
      requireBook(body && body.book_id);
      const result = reading.addBookmark(body);
      return {
        bookmark: result.bookmark,
        created: result.created,
        message: result.created ? '书签已加上。' : '这个位置已经有书签了。',
      };
    });

    router.patch('/api/bookmarks/:id', async (c) => {
      const body = await c.json();
      return reading.patchBookmark(c.params.id, body);
    });

    router.delete('/api/bookmarks/:id', (c) => {
      reading.deleteBookmark(c.params.id);
      return { deleted: true, message: '书签已删除。' };
    });

    // ------------------------------------------------------------ 笔记

    router.get('/api/notes', (c) => {
      const filter = {};
      if (c.q('book_id')) filter.book_id = c.q('book_id');
      if (c.q('chapter_index') !== undefined) filter.chapter_index = c.qNum('chapter_index');
      const items = reading.listNotes(filter);
      return { notes: items, total: items.length };
    });

    router.post('/api/notes', async (c) => {
      const body = await c.json();
      requireBook(body && body.book_id);
      return reading.addNote(body);
    });

    router.patch('/api/notes/:id', async (c) => {
      const body = await c.json();
      return reading.patchNote(c.params.id, body);
    });

    router.delete('/api/notes/:id', (c) => {
      reading.deleteNote(c.params.id);
      return { deleted: true, message: '笔记已删除。' };
    });

    // ------------------------------------------------------------ 跳章历史

    router.get('/api/reading/history', (c) =>
      reading.listHistory({ book_id: c.q('book_id'), limit: c.qNum('limit', 50) })
    );

    router.post('/api/reading/history', async (c) => {
      const body = await c.json();
      const action = body && body.action;

      // 「返回上一处」：带 action=back 时不是记录，而是往回退一格
      if (action === 'back') {
        requireBook(body.book_id);
        const result = reading.historyBack(body.book_id);
        if (!result.entry) {
          return { entry: null, message: '没有更早的记录了，已经在最开始的地方。' };
        }
        return { entry: result.entry, cursor: result.cursor };
      }

      requireBook(body && body.book_id);
      const result = reading.pushHistory(body);
      return { entry: result.entry, skipped: result.skipped };
    });

    // ------------------------------------------------------------ 阅读时长

    router.post('/api/reading/session', async (c) => {
      const body = await c.json();
      requireBook(body && body.book_id);
      const session = reading.recordSession(body);
      return { session, overview: reading.overview() };
    });

    router.get('/api/reading/stats', (c) => {
      const filter = {};
      if (c.q('book_id')) filter.book_id = c.q('book_id');
      if (c.q('from')) filter.from = c.q('from');
      if (c.q('to')) filter.to = c.q('to');
      const stats = reading.stats(filter);
      return { ...stats, weekMs: reading.weekMs(), overview: reading.overview() };
    });

    // ------------------------------------------------------------ 进度导出 / 导入

    router.get('/api/reading/progress/export', (c) => {
      const progress = reading.allProgress();
      const payload = {
        format: 'novel-tool-reading-progress',
        formatVersion: 1,
        schemaVersion: ctx.schemaVersion,
        syncState: 'local',
        owner_id: 'local',
        exportedAt: new Date().toISOString(),
        /** 带上书名，换电脑后用户能一眼看出哪条对应哪本书 */
        books: Object.values(progress).map((p) => {
          const book = library.get(p.book_id);
          return { ...p, title: book ? book.title : '', author: book ? book.author : '' };
        }),
      };
      sendFile(c.res, {
        filename: `阅读进度-${new Date().toISOString().slice(0, 10)}.json`,
        contentType: 'application/json; charset=utf-8',
        buffer: Buffer.from(JSON.stringify(payload, null, 2), 'utf8'),
      });
      return undefined;
    });

    router.post('/api/reading/progress/import', async (c) => {
      const body = await c.json();
      const list = Array.isArray(body) ? body : body && Array.isArray(body.books) ? body.books : null;
      if (!list) {
        throw new ApiError(
          'BAD_PROGRESS_FILE',
          '这个文件不是阅读进度文件。',
          '请选择用本工具「导出进度」生成的那个 json 文件。',
          400
        );
      }

      let imported = 0;
      let skipped = 0;
      for (const item of list) {
        if (!item || !item.book_id) {
          skipped++;
          continue;
        }
        // 只导入书架上确实存在的书：否则会留下一堆指向不存在书的孤儿进度
        if (!library.exists(item.book_id)) {
          skipped++;
          continue;
        }
        reading.setProgress(item);
        reading.syncBookFromProgress(item.book_id);
        imported++;
      }

      return {
        imported,
        skipped,
        total: list.length,
        message:
          `导入了 ${imported} 本书的阅读进度。` +
          (skipped ? `另有 ${skipped} 条在书架里找不到对应的书，已跳过。` : ''),
      };
    });
  },
};

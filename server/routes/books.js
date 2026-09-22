'use strict';
/**
 * routes/books.js —— 模块 1「书架首页」的接口实现，兼作模块 4 / 8 的单本入口。
 *
 * 接口清单（PRD 模块 1）：
 *   GET    /api/library                书架分堆数据 + 每本进度条与角标
 *   GET    /api/library/continue       「继续阅读」大卡片；无记录返回 null
 *   GET    /api/library/stats          共 N 本、总时长、本周时长
 *   GET    /api/books                  带筛选/搜索的书籍列表（模块 8 复用）
 *   GET    /api/books/:book_id         单本详情
 *   PATCH  /api/books/:book_id         重命名、改作者/标签/状态
 *   DELETE /api/books/:book_id?mode=trash  从书架移除（索引删除 + 正文进回收站）
 *   GET    /api/books/:book_id/export  导出这一本（默认 TXT，可要 JSON）
 */

const { ApiError, Errors } = require('../lib/errors');
const { sendFile } = require('../lib/http-utils');

/** PATCH 允许改的字段白名单（不在表里的字段一律忽略，避免前端误传覆盖内部字段） */
const EDITABLE_FIELDS = ['title', 'author', 'tags', 'status', 'cover', 'intro'];

module.exports = {
  mount(router, ctx) {
    const { shelf, library } = ctx;

    router.get('/api/library', () => shelf.pile());

    router.get('/api/library/continue', () => shelf.continueReading());

    router.get('/api/library/stats', () => shelf.stats());

    router.get('/api/books', (c) => {
      const books = shelf.filter({
        status: c.q('status'),
        tag: c.q('tag'),
        site: c.q('site'),
        author: c.q('author'),
        q: c.q('q'),
      });
      return { books, total: books.length };
    });

    router.get('/api/books/:book_id', (c) => {
      const book = library.get(c.params.book_id);
      if (!book) throw Errors.bookNotFound(c.params.book_id);
      return book;
    });

    router.patch('/api/books/:book_id', async (c) => {
      const body = await c.json();
      const book = library.require(c.params.book_id);

      const changes = {};
      for (const key of EDITABLE_FIELDS) {
        if (body[key] !== undefined) changes[key] = body[key];
      }
      if (!Object.keys(changes).length) {
        throw new ApiError(
          'NOTHING_TO_UPDATE',
          '这次没有要修改的内容。',
          '请填写要改的书名、作者或标签后重试。',
          400
        );
      }
      if (changes.title !== undefined && !String(changes.title).trim()) {
        throw new ApiError('TITLE_REQUIRED', '书名不能改成空的。', '请填写一个书名。', 400);
      }

      return library.patch(book.book_id, changes);
    });

    router.delete('/api/books/:book_id', (c) => {
      const bookId = c.params.book_id;
      const mode = c.q('mode') || 'trash';
      if (mode !== 'trash' && mode !== 'purge') {
        throw new ApiError(
          'BAD_DELETE_MODE',
          '不知道要把这本书怎么处理。',
          '正常情况请用「从书架移除」，正文会被放进回收站。',
          400
        );
      }
      // 只有显式 purge 才真的删；默认一律进回收站（PRD §3：不直接抹掉）
      return library.remove(bookId, { purge: mode === 'purge' });
    });

    router.get('/api/books/:book_id/export', (c) => {
      const bookId = c.params.book_id;
      const format = (c.q('format') || 'txt').toLowerCase();

      if (format === 'json') {
        const payload = library.exportBookJson(bookId);
        sendFile(c.res, {
          filename: `${payload.book.title}.json`,
          contentType: 'application/json; charset=utf-8',
          buffer: Buffer.from(JSON.stringify(payload, null, 2), 'utf8'),
        });
        return undefined;
      }

      if (format !== 'txt') {
        throw new ApiError(
          'BAD_EXPORT_FORMAT',
          '这个导出格式还不支持。',
          '目前可以导出为 txt（直接能读）或 json（给程序用）。',
          400
        );
      }

      const { filename, text } = library.exportBookText(bookId);
      sendFile(c.res, {
        filename,
        contentType: 'text/plain; charset=utf-8',
        buffer: Buffer.from(text, 'utf8'),
      });
      return undefined;
    });
  },
};

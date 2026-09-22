'use strict';
/**
 * routes/reader.js —— 模块 5「阅读器」的接口。
 *
 * 接口清单（PRD 模块 5）：
 *   GET /api/reader/:book_id/bootstrap          书籍元数据 + 轻量目录 + 阅读偏好 + 恢复位置
 *   GET /api/reader/:book_id/chapters/:index    单章正文（按需加载）
 *   GET / PUT /api/settings/reader              全局阅读偏好读写
 *
 * 设计要点（对应模块 5 的性能硬指标）：
 *   bootstrap 只回"标题 + 序号"的轻量目录，绝不回正文 ——
 *   3000 章的书如果 bootstrap 就把整本带上，打开阅读器要等好几秒，违背"3 秒内可读"。
 */

const { ApiError, Errors } = require('../lib/errors');

/** 轻量目录：只保留虚拟滚动需要的最小字段 */
function lightToc(chapters) {
  return chapters.map((ch) => ({
    index: ch.index,
    title: ch.title,
    char_count: ch.char_count,
    is_ok: ch.is_ok,
  }));
}

module.exports = {
  mount(router, ctx) {
    const { library, reading, settings } = ctx;

    router.get('/api/reader/:book_id/bootstrap', (c) => {
      const bookId = c.params.book_id;
      const book = library.get(bookId);
      if (!book) throw Errors.bookNotFound(bookId);

      const position = reading.resolvePosition(bookId);
      const bookmarks = reading.listBookmarks({ book_id: bookId });
      const notes = reading.listNotes({ book_id: bookId });

      return {
        book: {
          book_id: book.book_id,
          title: book.title,
          author: book.author,
          source_site: book.source_site,
          total_chapters: book.total_chapters,
          read_chapters: book.read_chapters,
          status: book.status,
        },
        /** 轻量目录，供目录抽屉做虚拟滚动 */
        toc: lightToc(book.chapters),
        /** 全局阅读偏好（换书不用重设） */
        settings: settings.getReader(),
        /** 该停在哪儿：章号 + 章内偏移（含"章节数变了怎么重定位"的说明） */
        position,
        counts: { bookmarks: bookmarks.length, notes: notes.length },
      };
    });

    router.get('/api/reader/:book_id/chapters/:index', (c) => {
      const bookId = c.params.book_id;
      const index = Number(c.params.index);
      const book = library.get(bookId);
      if (!book) throw Errors.bookNotFound(bookId);

      const total = book.chapters.length;
      if (!Number.isFinite(index) || index < 1 || index > total) {
        throw Errors.chapterNotFound(c.params.index);
      }

      const meta = book.chapters[index - 1];
      const content = library.readChapterText(bookId, index);
      if (content === null) {
        // 章节清单说有、磁盘上却没有：如实说清楚，并告诉用户怎么补
        return {
          index,
          title: meta.title,
          content: '',
          char_count: 0,
          missing: true,
          prev: index > 1 ? index - 1 : null,
          next: index < total ? index + 1 : null,
          total,
          note: '这一章的正文文件不在了（可能被误删）。可以在详情页对这一章重新抓取，或者重新导入一次。',
        };
      }

      return {
        index,
        title: meta.title,
        content,
        char_count: meta.char_count,
        missing: false,
        prev: index > 1 ? index - 1 : null,
        next: index < total ? index + 1 : null,
        total,
      };
    });

    router.get('/api/settings/reader', () => settings.getReader());

    router.put('/api/settings/reader', async (c) => {
      const body = await c.json();
      if (!body || typeof body !== 'object') {
        throw new ApiError('BAD_READER_SETTINGS', '阅读偏好数据格式不对。', '请刷新页面后重新调整一次。', 400);
      }
      return settings.putReader(body);
    });
  },
};

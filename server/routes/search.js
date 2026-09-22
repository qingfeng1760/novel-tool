'use strict';
/**
 * routes/search.js —— 模块 8「全文检索与筛选」的接口。
 *
 * 接口清单（PRD 模块 8）：
 *   GET  /api/search?q=&scope=book|library&book_id=
 *   POST /api/search/reindex
 *   GET  /api/filter/options
 *   GET  /api/books/duplicates
 *   POST /api/books/merge
 *
 * 注意：这个模块必须挂在 books 模块**前面**。
 * 因为 /api/books/duplicates 和 /api/books/:book_id 的形状一样，
 * 谁先注册谁先匹配 —— 放在后面的话 "duplicates" 会被当成一本书的编号。
 */

const { ApiError } = require('../lib/errors');

module.exports = {
  mount(router, ctx) {
    const { search, shelf } = ctx;

    router.get('/api/search', (c) => {
      const scope = c.q('scope') === 'book' ? 'book' : 'library';
      return search.search({
        q: c.q('q'),
        scope,
        book_id: c.q('book_id'),
        limit: c.qNum('limit', 100),
      });
    });

    router.post('/api/search/reindex', () => search.reindex());

    router.get('/api/search/status', () => search.status());

    router.get('/api/filter/options', () => shelf.filterOptions());

    router.get('/api/books/duplicates', () => search.duplicates());

    router.post('/api/books/merge', async (c) => {
      const body = await c.json();
      if (!body.keep_id && !body.drop_id) {
        throw new ApiError(
          'MERGE_NEEDS_TWO',
          '合并需要指明保留哪一本、去掉哪一本。',
          '请在重复的书里挑一本保留。',
          400
        );
      }
      return search.merge(body);
    });
  },
};

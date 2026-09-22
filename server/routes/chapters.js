'use strict';
/**
 * routes/chapters.js —— 模块 4「书籍详情与章节目录」的接口。
 *
 * 接口清单（PRD 模块 4）：
 *   GET  /api/books/:id/chapters                     章节目录（含状态与字数）
 *   GET  /api/books/:id/chapters/:index              读取单章正文
 *   GET  /api/books/:id/diagnose                     目录体检
 *   GET  /api/books/:id/diff                         更新对比明细
 *   POST /api/books/:id/rechapterize                 重分章（先预览再确认）
 *   POST /api/books/:id/chapters/split|merge|rename|delete   手工调章
 *   POST /api/books/:id/chapters/:index/refetch      单章重新抓取
 *   GET  /api/books/:id/chapters/:index/export       单章导出
 *
 * 路由顺序很重要：字面量路径（chapters/split）必须排在参数路径（chapters/:index）前面，
 * 否则 "split" 会被当成章节号。
 */

const { ApiError } = require('../lib/errors');
const { sendFile } = require('../lib/http-utils');

module.exports = {
  mount(router, ctx) {
    const { chapters, library } = ctx;

    router.get('/api/books/:id/chapters', (c) => chapters.list(c.params.id));

    // ---- 字面量路由必须放在 :index 之前 ----
    router.post('/api/books/:id/chapters/split', async (c) => {
      const body = await c.json();
      if (!body.index && body.index !== 0) {
        throw new ApiError('NO_CHAPTER_INDEX', '没有指明要拆哪一章。', '请先在目录里选中一章。', 400);
      }
      return chapters.split(c.params.id, body.index, body);
    });

    router.post('/api/books/:id/chapters/merge', async (c) => {
      const body = await c.json();
      if (!body.index && body.index !== 0) {
        throw new ApiError('NO_CHAPTER_INDEX', '没有指明要从哪一章开始合并。', '请先在目录里选中一章。', 400);
      }
      return chapters.merge(c.params.id, body.index, body);
    });

    router.post('/api/books/:id/chapters/rename', async (c) => {
      const body = await c.json();
      if (!body.index && body.index !== 0) {
        throw new ApiError('NO_CHAPTER_INDEX', '没有指明要改哪一章的标题。', '请先在目录里选中一章。', 400);
      }
      return chapters.rename(c.params.id, body.index, body.title);
    });

    router.post('/api/books/:id/chapters/delete', async (c) => {
      const body = await c.json();
      if (!body.index && body.index !== 0) {
        throw new ApiError('NO_CHAPTER_INDEX', '没有指明要删哪一章。', '请先在目录里选中一章。', 400);
      }
      return chapters.removeChapter(c.params.id, body.index);
    });

    // ---- 体检 / 对比 / 重分章 ----
    router.get('/api/books/:id/diagnose', (c) => chapters.diagnose(c.params.id));

    router.get('/api/books/:id/diff', (c) => chapters.diff(c.params.id));

    router.post('/api/books/:id/rechapterize', async (c) => {
      const body = await c.json();
      return chapters.rechapterize(c.params.id, body);
    });

    router.get('/api/books/:id/toc-snapshot', (c) => ({
      snapshot: chapters.readSnapshot(c.params.id),
    }));

    router.post('/api/books/:id/toc-snapshot', (c) => chapters.writeSnapshot(c.params.id));

    // ---- 单章 ----
    router.get('/api/books/:id/chapters/:index', (c) => chapters.read(c.params.id, c.params.index));

    router.post('/api/books/:id/chapters/:index/refetch', (c) => chapters.refetch(c.params.id, c.params.index));

    router.get('/api/books/:id/chapters/:index/export', (c) => {
      void library;
      const { filename, text } = chapters.exportChapter(c.params.id, c.params.index);
      sendFile(c.res, {
        filename,
        contentType: 'text/plain; charset=utf-8',
        buffer: Buffer.from(text, 'utf8'),
      });
      return undefined;
    });
  },
};

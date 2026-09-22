'use strict';
/**
 * routes/schedule.js —— 追更相关接口（PRD 模块 2 的追更部分 + 通知）。
 *
 *   GET  /api/fetch/schedule         追更配置总览（每本的频率与上次/下次检查时间）
 *   PUT  /api/fetch/schedule         设置频率（单本或批量）
 *   GET  /api/fetch/schedule/status  同上，另给一份"哪些书可追更"的判断
 *   POST /api/fetch/schedule/check   手动立即检查（某本，或全部到点的）
 *   GET  /api/notifications          通知列表（角标之外的那份"提示"）
 *   POST /api/notifications/read     标记已读
 *
 * 强调一点：这些接口**不会**下载任何正文。
 * 发现新章节只写标记 + 出通知，下载必须由用户在详情页点「更新」触发。
 */

const { Errors } = require('../lib/errors');

module.exports = {
  mount(router, ctx) {
    const { scheduler } = ctx;

    router.get('/api/fetch/schedule', () => scheduler.status());

    router.get('/api/fetch/schedule/status', () => {
      const data = scheduler.status();
      const notifications = scheduler.listNotifications({ unreadOnly: true });
      return { ...data, unreadNotifications: notifications.unreadCount };
    });

    router.put('/api/fetch/schedule', async (c) => {
      const body = await c.json();
      return scheduler.setSchedule(body);
    });

    router.post('/api/fetch/schedule/check', async (c) => {
      const body = await c.json();
      const bookId = body && (body.book_id || body.bookId);
      // 先确认这本书真的在书架上，不然会得到一个"找不到书"的中文提示
      if (bookId && !ctx.library.exists(bookId)) throw Errors.bookNotFound(bookId);
      return scheduler.checkNow(bookId);
    });

    router.get('/api/notifications', (c) =>
      scheduler.listNotifications({ unreadOnly: c.q('unread') === 'true' })
    );

    router.post('/api/notifications/read', async (c) => {
      const body = await c.json();
      return scheduler.markRead(body && body.ids);
    });
  },
};

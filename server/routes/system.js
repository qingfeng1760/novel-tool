'use strict';
/**
 * routes/system.js —— 工具自身的运行状态接口。
 *
 * 包含两类：
 *   1. /api/health：给测试、油猴脚本（判断服务是否在线，模块 3 的 ping 也会复用同一份判断）
 *      和设置页"关于"区域用；
 *   2. /api/tasks/:id：PRD §4.0 规定的长任务进度轮询入口。
 */

const { Errors } = require('../lib/errors');

module.exports = {
  mount(router, ctx) {
    router.get('/api/health', () => ({
      ok: true,
      app: '小说工具',
      version: ctx.version,
      schemaVersion: ctx.schemaVersion,
      dataDir: ctx.dataDir,
      offline: true,
      startedAt: ctx.startedAt,
      uptimeMs: Date.now() - new Date(ctx.startedAt).getTime(),
      // 启动体检：哪个文件坏了、是否已回退到 .bak，设置页要照着提示
      health: ctx.health,
    }));

    router.get('/api/tasks', () => ctx.tasks.list());

    router.get('/api/tasks/:id', (c) => {
      const task = ctx.tasks.get(c.params.id);
      if (!task) {
        throw Errors.notFound(
          '没找到这个任务，它可能已经结束了。',
          '请回到上一页刷新一下进度。'
        );
      }
      return { ...task, timing: ctx.tasks.timing(c.params.id) };
    });
  },
};

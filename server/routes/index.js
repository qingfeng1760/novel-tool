'use strict';
/**
 * routes/index.js —— 路由装配清单。
 *
 * 每个模块一个文件，按 PRD §11 的开发阶段顺序追加到这里。
 * 之所以集中一处：任何新增接口都必须"注册过"才存在，
 * 不会出现某个路由文件写了但没人 require、接口 404 却查不出原因的情况。
 */

/**
 * 注意：这里的顺序就是**路由匹配顺序**，而不仅仅是开发阶段顺序。
 * 带具体路径的接口（如 /api/books/duplicates）必须排在带参数的接口
 * （/api/books/:book_id）前面，否则会被后者先吃掉。
 */
const MODULES = [
  './auth', // S0 预留：/api/auth/* 一律 501
  './system', // S0 起：健康检查、长任务轮询
  './importRoute', // S2 起：模块 7 导入与编码修复
  './search', // S6 起：模块 8 检索 / 筛选 / 重名合并（必须先于 books）
  './books', // S3 起：模块 1 书架 + 单本入口
  './reader', // S4 起：模块 5 阅读器
  './reading', // S4 起：模块 6 进度 / 书签 / 笔记 / 时长
  './chapters', // S5 起：模块 4 目录体检 / 更新对比 / 手工调章
  './fetch', // S7 起：模块 2 抓取控制台
  './userscript', // S8 起：模块 3 浏览器脚本接口
  './schedule', // S9 起：追更配置 / 检查 / 通知
  './settings', // S10 起：模块 9 设置 / 存储 / 备份 / 关于
];

function mountRoutes(router, ctx) {
  for (const modulePath of MODULES) {
    // eslint-disable-next-line global-require
    const mod = require(modulePath);
    if (!mod || typeof mod.mount !== 'function') {
      throw new Error(`路由模块 ${modulePath} 没有导出 mount()`);
    }
    mod.mount(router, ctx);
  }
  return router;
}

module.exports = { mountRoutes, MODULES };

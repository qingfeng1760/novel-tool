/**
 * views/index.js —— 视图注册表。
 *
 * 每个模块一个文件，完成之后就接在这里（顺序与 PRD §2.1 页面清单一致）。
 * 集中注册的好处：打开这个文件就能看到"现在有哪些页面可用"，
 * 不会出现某个页面入口还在、实现已经被删掉的情况。
 */

import * as shelf from './shelf.js';
import * as book from './book.js';
import * as importView from './import.js';
import * as search from './search.js';
import * as fetchView from './fetch.js';
import * as settingsView from './settings.js';

export function registerViews(router) {
  // 模块 1 · 书架首页（唯一入口和总控台）
  router.add('/', (params, query) => shelf.render(params, query));
  router.add('/shelf', (params, query) => shelf.render(params, query));

  // 模块 4 · 书籍详情与目录
  router.add('/book/:book_id', (params, query) => book.render(params, query));

  // 模块 7 · 导入与编码修复
  router.add('/import', (params, query) => importView.render(params, query));

  // 模块 2 · 抓取控制台
  router.add('/fetch', (params, query) => fetchView.render(params, query));

  // 模块 8 · 全文检索与筛选
  router.add('/search', (params, query) => search.render(params, query));

  // 模块 9 · 设置与数据管理
  router.add('/settings', (params, query) => settingsView.render(params, query));
  router.add('/settings/:section', (params, query) => settingsView.render(params, query));
}

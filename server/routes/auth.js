'use strict';
/**
 * routes/auth.js —— 鉴权路由占位。
 *
 * 为什么 v1 就要把路由占下来：
 * PRD §7 明确要求"/api/auth/* 占位，一律返回 501 Not Implemented"。
 * 提前占好位置，将来加登录时只是把 501 换成真实现，
 * 前端和调用方看到的路径不变，不用推翻重写。
 */

const { Errors } = require('../lib/errors');

function notImplemented() {
  throw Errors.notImplemented(
    '登录和账号功能在当前版本里没有开放。',
    '这一版是纯本机工具，不需要登录，直接返回书架就能用。'
  );
}

module.exports = {
  mount(router) {
    // 用通配把 /api/auth/ 下面所有路径与所有方法一次性占住
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      router[method]('/api/auth/*', notImplemented);
    }
    router.get('/api/auth', notImplemented);
    router.post('/api/auth', notImplemented);
  },
};

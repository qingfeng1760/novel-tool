'use strict';
/**
 * routes/userscript.js —— 模块 3「油猴脚本」的接口。
 *
 * 接口清单（PRD 模块 3）：
 *   GET  /api/userscript/ping      探测本地服务是否在线（离线时脚本转暂存模式）
 *   POST /api/userscript/resolve   按 URL / 标题 / 作者识别归属书
 *   POST /api/userscript/capture   提交单章内容入库（含 content_hash 去重）
 *   POST /api/userscript/batch     「抓整本」批量提交
 *   POST /api/userscript/flush     服务恢复后补交暂存内容
 *   GET  /api/userscript/script    下载脚本本体（方便用户在设置页一键安装）
 *
 * 为什么脚本走独立的 /api/userscript/*：
 * 这一组接口是给浏览器脚本用的，和界面用的接口分开，将来要给脚本加版本协商、
 * 限流或者鉴权时，不会牵连到界面那一套。
 */

const fs = require('fs');
const path = require('path');
const { resolveUserscriptDir } = require('../lib/paths');
const { ApiError } = require('../lib/errors');
const { sendFile } = require('../lib/http-utils');

/** 脚本文件名（中文名，用户在油猴里看到的也是这个） */
const SCRIPT_NAME = '小说工具.user.js';

module.exports = {
  mount(router, ctx) {
    const { userscript } = ctx;

    router.get('/api/userscript/ping', () => ({
      online: true,
      app: '小说工具',
      version: ctx.version,
      schemaVersion: ctx.schemaVersion,
      /** 脚本据此判断要不要切到暂存模式 */
      accept_capture: true,
      time: new Date().toISOString(),
    }));

    router.post('/api/userscript/resolve', async (c) => {
      const body = await c.json();
      if (!body || (!body.url && !body.title)) {
        throw new ApiError(
          'NO_IDENTITY',
          '没有拿到当前页面的地址或标题，认不出这是哪本书。',
          '请在小说页面上使用脚本，或者手动选择「存到已有书」。',
          400
        );
      }
      return userscript.resolve(body);
    });

    router.post('/api/userscript/capture', async (c) => {
      const body = await c.json();
      return userscript.capture(body);
    });

    router.post('/api/userscript/batch', async (c) => {
      const body = await c.json();
      return userscript.batch(body);
    });

    router.post('/api/userscript/flush', async (c) => {
      const body = await c.json();
      return userscript.flush(body);
    });

    router.get('/api/userscript/script', (c) => {
      const file = path.join(resolveUserscriptDir(), SCRIPT_NAME);
      if (!fs.existsSync(file)) {
        throw new ApiError(
          'SCRIPT_MISSING',
          '找不到油猴脚本文件。',
          '请检查 userscript 目录里有没有「小说工具.user.js」。',
          404
        );
      }
      sendFile(c.res, {
        filename: SCRIPT_NAME,
        contentType: 'text/javascript; charset=utf-8',
        buffer: fs.readFileSync(file),
      });
      return undefined;
    });
  },
};

module.exports.SCRIPT_NAME = SCRIPT_NAME;

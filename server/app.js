'use strict';
/**
 * app.js —— HTTP 服务装配：路由分发 + 统一响应体 + 静态资源。
 *
 * 处理顺序（重要）：
 *   1. /api/* 一律走 API 路由，绝不落到静态目录，避免用户数据被当静态资源暴露；
 *   2. 其余路径才去 web/ 找文件；
 *   3. 路由处理器抛出的任何异常都在这里被翻译成 `{ok:false,error:{code,message,hint}}`，
 *      保证界面上永远不会出现 `Error: undefined`（PRD §12）。
 */

const http = require('http');
const { Router } = require('./lib/router');
const { sendOk, sendError, readBody, parseJsonBody } = require('./lib/http-utils');
const { ApiError, Errors } = require('./lib/errors');
const { serveStatic } = require('./lib/static');
const { parseMultipart } = require('./lib/multipart');
const { mountRoutes } = require('./routes');

/** 给每个请求造一个上下文对象，处理器里只需要面对干净的东西 */
function createRequestContext({ req, res, ctx, params, url }) {
  let bodyBuffer = null;
  let bodyJson;
  let jsonParsed = false;

  const cache = {
    async buffer() {
      if (bodyBuffer === null) bodyBuffer = await readBody(req);
      return bodyBuffer;
    },
    async json() {
      if (!jsonParsed) {
        const buf = await cache.buffer();
        bodyJson = parseJsonBody(buf);
        jsonParsed = true;
      }
      return bodyJson;
    },
    async text() {
      const buf = await cache.buffer();
      return buf.toString('utf8');
    },
    async multipart() {
      const buf = await cache.buffer();
      return parseMultipart(buf, req.headers['content-type'] || '');
    },
  };

  const query = {};
  for (const [key, value] of url.searchParams.entries()) query[key] = value;

  return {
    req,
    res,
    ctx,
    params,
    query,
    method: req.method.toUpperCase(),
    pathname: url.pathname,
    headers: req.headers,
    /** 便捷：query 取值（缺失返回 undefined 而不是空串） */
    q(name) {
      const v = query[name];
      return v === undefined || v === '' ? undefined : v;
    },
    /** 便捷：query 里的数字（非数字返回 fallback） */
    qNum(name, fallback) {
      const v = Number(query[name]);
      return Number.isFinite(v) ? v : fallback;
    },
    ...cache,
  };
}

function createApp(ctx) {
  const router = new Router();
  mountRoutes(router, ctx);

  const server = http.createServer((req, res) => {
    handleRequest(req, res, ctx, router).catch((err) => {
      // 兜底：连分发逻辑都炸了的时候，也要给人话
      if (!res.writableEnded) sendError(res, err);
      else console.error('[未处理异常]', err);
    });
  });

  return { server, router, ctx };
}

async function handleRequest(req, res, ctx, router) {
  const url = new URL(req.url || '/', 'http://127.0.0.1');

  if (url.pathname.startsWith('/api/')) {
    const matched = router.match(req.method, url.pathname);
    if (!matched) {
      throw new ApiError(
        'NO_SUCH_API',
        '没有这个功能接口。',
        '可能是页面版本和工具版本不一致，刷新页面再试一次。',
        404
      );
    }
    if (matched.allowed) {
      throw new ApiError(
        'METHOD_NOT_ALLOWED',
        '这个操作的方式不对。',
        `请改用 ${matched.allowed.join(' / ')} 方式请求。`,
        405
      );
    }
    const c = createRequestContext({ req, res, ctx, params: matched.params, url });
    const result = await matched.handler(c);
    // 处理器自己写过响应（比如导出文件流）就不要再包一层
    if (!res.writableEnded && result !== undefined) sendOk(res, result);
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    throw new ApiError('METHOD_NOT_ALLOWED', '这个地址只能用来打开页面。', '请直接在浏览器里访问。', 405);
  }

  if (!serveStatic(ctx.webDir, url.pathname, res)) {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(
      '<!doctype html><meta charset="utf-8"><title>页面不存在</title>' +
        '<h1>没有找到这个页面</h1><p><a href="/">回到书架</a></p>'
    );
  }
}

/** 便捷：让处理器直接把 ctx 也带进去（多数只用到 c.ctx） */
function ok(data) {
  return data;
}

module.exports = { createApp, createRequestContext, handleRequest, ok, sendOk, sendError, Errors };
